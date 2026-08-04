import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source=fs.readFileSync(new URL("../extension/draft-launcher.js",import.meta.url),"utf8");
const manifest=JSON.parse(fs.readFileSync(new URL("../extension/manifest.json",import.meta.url)));

function harness(href){
  const messages=[],listeners={};
  const button={dataset:{},textContent:"",addEventListener(type,handler){listeners[`button:${type}`]=handler},getAttribute(){return null}};
  const dismiss={dataset:{},textContent:"",addEventListener(type,handler){listeners[`dismiss:${type}`]=handler},getAttribute(){return null}};
  const status={dataset:{},textContent:""};
  const shadow={innerHTML:"",querySelector(selector){return selector===".open"?button:selector===".dismiss"?dismiss:status}};
  const body={append(host){host.isConnected=true}};
  const document={documentElement:{},body,createElement(){return{id:"",isConnected:false,setAttribute(){},attachShadow(){return shadow},remove(){this.isConnected=false}}},addEventListener(type,handler){listeners[type]=handler}};
  class MutationObserver{constructor(handler){this.handler=handler}observe(){}}
  const context=vm.createContext({URL,location:new URL(href),document,MutationObserver,chrome:{runtime:{async sendMessage(message){if(message.type==="GET_DRAFT_SIDE_PANEL_VISIBILITY")return{open:false};messages.push(message);return{ok:true}},onMessage:{addListener(handler){listeners.runtimeMessage=handler}}}},addEventListener(type,handler){listeners[type]=handler},setInterval(){return 1},setTimeout(){return 1},clearTimeout(){}});
  vm.runInContext(source,context,{filename:"draft-launcher.js"});
  return{context,document,listeners,messages,button,dismiss,status,click(target){listeners.click({target})}};
}

test("launcher is registered before each platform adapter",()=>{
  assert.ok(Number(manifest.minimum_chrome_version)>=116,"sidePanel.open requires Chrome 116 or newer");
  const sleeper=manifest.content_scripts.find(script=>script.matches.includes("https://sleeper.com/*")),espn=manifest.content_scripts.find(script=>script.matches.includes("https://fantasy.espn.com/*")),yahoo=manifest.content_scripts.find(script=>script.matches.includes("https://football.fantasysports.yahoo.com/*"));
  assert.deepEqual(sleeper.js,["draft-launcher.js","adapters/sleeper.js"]);
  assert.deepEqual(espn.js,["draft-launcher.js"]);
  assert.deepEqual(yahoo.js,["draft-launcher.js","adapters/yahoo.js"]);
});

test("direct ESPN and Sleeper draft links receive a persistent one-click fallback launcher",()=>{
  for(const href of ["https://fantasy.espn.com/football/draft/?leagueId=12345","https://sleeper.com/draft/nfl/123456789012345678","https://football.fantasysports.yahoo.com/draftclient/f1/8103584/3"]){
    const h=harness(href);assert.equal(h.context.__draftGoblinLauncher.host.isConnected,true);h.listeners["button:click"]();const message=h.messages.find(item=>item.type==="OPEN_DRAFT_SIDE_PANEL");assert.equal(message.source,"draft-page-launcher");
  }
});

test("launcher is absent while Draft Goblin is open and returns after it closes",()=>{
  const h=harness("https://sleeper.com/draft/nfl/123456789012345678");
  h.listeners.runtimeMessage({type:"DRAFT_SIDE_PANEL_VISIBILITY",open:true});assert.equal(h.context.__draftGoblinLauncher.host,null);
  h.listeners.runtimeMessage({type:"DRAFT_SIDE_PANEL_VISIBILITY",open:false});assert.equal(h.context.__draftGoblinLauncher.host.isConnected,true);
});

test("lobby pages and their draft-entry controls never offer or open Draft Goblin",()=>{
  const lobby=harness("https://sleeper.com/mock-drafts");
  assert.equal(lobby.context.__draftGoblinLauncher.host,null);assert.equal(lobby.listeners.click,undefined);assert.equal(lobby.messages.length,0);
});

test("ESPN lobby pages never offer or open Draft Goblin",()=>{
  const h=harness("https://fantasy.espn.com/football/mockdraftlobby");assert.equal(h.context.__draftGoblinLauncher.host,null);assert.equal(h.listeners.click,undefined);assert.equal(h.messages.length,0);
});

test("direct-link launcher can be dismissed without immediately remounting",()=>{
  const h=harness("https://sleeper.com/draft/nfl/123456789012345678");h.listeners["dismiss:click"]();assert.equal(h.context.__draftGoblinLauncher.host,null);assert.equal(h.context.__draftGoblinLauncher.dismissedUrl,h.context.location.href);
});

test("non-draft pages stay launcher-free even when they link to a draft",()=>{
  for(const href of ["https://sleeper.com/leagues","https://sleeper.com/drafts","https://fantasy.espn.com/football/mockdraftlobby","https://football.fantasysports.yahoo.com/f1/mock_lobby","https://example.com/"]){const h=harness(href);assert.equal(h.context.__draftGoblinLauncher.host,null);assert.equal(h.messages.length,0)}
});
