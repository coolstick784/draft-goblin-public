import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {webcrypto} from "node:crypto";

const source=fs.readFileSync(new URL("../extension/adapters/sleeper.js",import.meta.url),"utf8");
const capturedDraft=JSON.parse(fs.readFileSync(new URL("../data/generated/live-draft.json",import.meta.url),"utf8"));
const draftId="123456789012345678";
const userId="1375861210234261504";

async function runAdapter(inputDraft){
  const draft=structuredClone(inputDraft);
  draft.draft_id=draftId;
  draft.draft_order={[userId]:Math.min(Number(draft.settings.teams),2)};
  const catalog={
    real:{player_id:"real",full_name:"Real Rank",position:"WR",team:"BUF",injury_status:null},
    sentinel:{player_id:"sentinel",full_name:"Missing Rank",position:"RB",team:"NYJ",injury_status:null},
    offscreen:{player_id:"offscreen",full_name:"Offscreen Runner",position:"RB",team:"MIN",injury_status:null}
  };
  let settle;
  const result=new Promise(resolve=>{settle=resolve});
  const messages=[];
  const chrome={runtime:{async sendMessage(message){messages.push(message);if(message.type==="ADAPTER_ACTIVATED")return{ok:true};if(message.type==="DRAFT_STATE"){settle({state:message.state,messages});return{ok:true}}if(message.type==="DRAFT_ERROR"){settle({error:message.error,messages});return{ok:true}}if(message.type==="SLEEPER_FETCH"){const url=message.url;if(url.includes(`/draft/${draftId}/picks`))return{ok:true,data:[]};if(url.includes(`/draft/${draftId}`))return{ok:true,data:draft};if(url.includes("/players/nfl"))return{ok:true,data:catalog};if(url.includes("api.sleeper.com/projections"))return{ok:true,data:[{season:"2026",player_id:"real",stats:{pts_std:188,adp_std:31.4}},{season:"2026",player_id:"sentinel",stats:{pts_std:175,adp_std:999}},{season:"2026",player_id:"offscreen",stats:{pts_std:164,adp_std:85.2}}]};throw new Error(`Unexpected URL ${url}`)}}}};
  const localStorage={length:1,key:index=>index===0?"user":null,getItem:key=>key==="user"?userId:null};
  const cell=(label,value)=>({className:label,textContent:String(value),children:[],getAttribute(name){return name==="data-stat"?label:null}}),row=(id,projection,adp,rowText="")=>({hidden:false,children:[],innerText:rowText,textContent:rowText,getClientRects:()=>[{}],getAttribute(name){return name==="data-player-id"?id:null},querySelector(){return null},querySelectorAll(selector){if(selector==="span,div")return[];return[cell("projected",projection),...(adp?[cell("adp",adp)]:[])]}}),visibleRows=[row("real",190,null),row("real",0,null,"31 Real Rank WR BUF 30.6 7"),row("sentinel",180,null)];
  const document={hidden:false,addEventListener(){},querySelectorAll(selector){return selector.includes("[data-player-id]")?visibleRows:[]}};
  const context=vm.createContext({URL,location:{href:`https://sleeper.com/draft/nfl/${draftId}`,origin:"https://sleeper.com"},chrome,crypto:webcrypto,localStorage,document,globalThis:null,setInterval(){return 1},clearInterval(){},setTimeout});
  context.globalThis=context;
  new vm.Script(source,{filename:"sleeper.js"}).runInContext(context);
  return Promise.race([result,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Sleeper adapter timed out")),1000))]);
}

test("captured Sleeper settings derive bench and cap playoff teams",async()=>{
  const {state,error}=await runAdapter(capturedDraft);
  assert.equal(error,undefined);
  assert.equal(state.settings.teams,10);
  assert.equal(state.settings.rounds,15);
  assert.equal(state.settings.slots.BENCH,5);
  assert.equal(Object.entries(state.settings.slots).filter(([key])=>key!=="BENCH").reduce((sum,[,count])=>sum+count,0)+state.settings.slots.BENCH,15);
  assert.deepEqual(JSON.parse(JSON.stringify(state.settings.positionLimits)),{QB:2,RB:6,WR:6,TE:2,K:1,DST:1});
  assert.equal(state.settings.playoffTeams,6);
});

test("Sleeper settings preserve zero slots and small leagues cap playoffs",async()=>{
  const draft=structuredClone(capturedDraft);
  draft.settings.teams=4;
  draft.settings.slots_flex=0;
  const {state}=await runAdapter(draft);
  assert.equal(state.settings.slots.FLEX,0);
  assert.equal(state.settings.slots.BENCH,7);
  assert.equal(state.settings.playoffTeams,4);
});

test("Sleeper carries configured position maximums into recommendation settings",async()=>{
  const draft=structuredClone(capturedDraft);
  draft.settings.max_qb=1;
  draft.settings.max_rb=4;
  draft.settings.max_def=1;
  const {state}=await runAdapter(draft);
  assert.equal(state.settings.positionLimits.QB,1);
  assert.equal(state.settings.positionLimits.RB,4);
  assert.equal(state.settings.positionLimits.DST,1);
});

test("Sleeper sentinel ADP is unavailable while real scoring ADP is retained",async()=>{
  const {state,messages}=await runAdapter(capturedDraft);
  const real=state.players.find(player=>player.id==="real"),sentinel=state.players.find(player=>player.id==="sentinel"),offscreen=state.players.find(player=>player.id==="offscreen");
  assert.equal(real.adp,30.6);
  assert.equal(real.adpSource,"sleeper-visible-draft-rank");
  assert.equal(real.platformProjection,190);
  assert.equal(sentinel.adp,null);
  assert.equal(sentinel.adpSource,"unavailable");
  assert.equal(offscreen.adp,85.2);
  assert.equal(offscreen.adpSource,"sleeper-private-draft-pool");
  assert.equal(offscreen.platformProjection,164);
  assert.equal(messages.filter(message=>String(message.url||"").includes("api.sleeper.com/projections")).length,1);
});

test("Sleeper scrapes projections and ADP from its virtualized player rows",async()=>{
  const draft=structuredClone(capturedDraft),catalog={live:{player_id:"live",full_name:"Jahmyr Gibbs",position:"RB",team:"DET",injury_status:null}};
  draft.draft_id=draftId;draft.draft_order={[userId]:2};
  let settle;const result=new Promise(resolve=>{settle=resolve});
  const chrome={runtime:{async sendMessage(message){if(message.type==="ADAPTER_ACTIVATED")return{ok:true};if(message.type==="DRAFT_STATE"){settle(message.state);return{ok:true}}if(message.type==="SLEEPER_FETCH"){if(message.url.includes(`/draft/${draftId}/picks`))return{ok:true,data:[]};if(message.url.includes(`/draft/${draftId}`))return{ok:true,data:draft};if(message.url.includes("/players/nfl"))return{ok:true,data:catalog}}return{ok:true}}}};
  const nameRoot={childNodes:[{nodeType:3,textContent:"Jahmyr Gibbs"},{nodeType:1,textContent:"RB DET"}]},cell=(className,value)=>({className,textContent:String(value),children:[],getAttribute(){return null}}),row={className:"player-rank-item2 RB",hidden:false,children:[],getClientRects:()=>[{}],getAttribute(){return null},querySelector(selector){return selector.includes("name-wrapper")?nameRoot:null},querySelectorAll(selector){return selector==="span,div"?[]:[cell("proj-wrapper","5 Jahmyr Gibbs RB DET 247.9"),cell("adp col-sml stat-cell",2.7),cell("proj-pts col-sml stat-cell",247.9)]}};
  const document={hidden:false,addEventListener(){},querySelectorAll(selector){return selector.includes(".player-rank-item2")?[row]:[]}};
  const localStorage={length:1,key:index=>index===0?"user":null,getItem:key=>key==="user"?userId:null};
  const context=vm.createContext({URL,location:{href:`https://sleeper.com/draft/nfl/${draftId}`,origin:"https://sleeper.com"},chrome,crypto:webcrypto,localStorage,document,globalThis:null,setInterval(){return 1},clearInterval(){},setTimeout});context.globalThis=context;
  new vm.Script(source,{filename:"sleeper.js"}).runInContext(context);
  const state=await Promise.race([result,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Sleeper adapter timed out")),1000))]),player=state.players.find(candidate=>candidate.id==="live");
  assert.equal(player.platformProjection,247.9);
  assert.equal(player.projectionSource,"Sleeper visible draft projection");
  assert.equal(player.adp,2.7);
  assert.equal(player.adpSource,"sleeper-visible-draft-rank");
});

test("Sleeper runtime projection capture follows the draft season without a yearly extension release",async()=>{
  const draft=structuredClone(capturedDraft);
  draft.season="2027";
  const {state,error}=await runAdapter(draft);
  assert.equal(error,undefined);
  assert.equal(state.projectionSeason,2027);
  assert.ok(state.players.every(player=>player.projectionSeason===2027));
  assert.ok(state.players.every(player=>player.adpSeason===2027));
});

test("Sleeper publishes user pick 106 and immediate autopick 107 even without a named board root",async()=>{
  const draft=structuredClone(capturedDraft),catalog={live:{player_id:"live",full_name:"Fast Pick",position:"RB",team:"DET",injury_status:null}};
  draft.draft_id=draftId;draft.draft_order={[userId]:2};
  let picks=[],observerCallback,resolveSecond;const states=[],secondState=new Promise(resolve=>{resolveSecond=resolve});let draftFetches=0,pickFetches=0;
  const chrome={runtime:{async sendMessage(message){if(message.type==="ADAPTER_ACTIVATED")return{ok:true};if(message.type==="DRAFT_STATE"){states.push(message.state);if(states.length===2)resolveSecond(message.state);return{ok:true}}if(message.type==="SLEEPER_FETCH"){if(message.url.includes(`/draft/${draftId}/picks`)){pickFetches++;return{ok:true,data:picks}}if(message.url.includes(`/draft/${draftId}`)){draftFetches++;return{ok:true,data:draft}}if(message.url.includes("/players/nfl"))return{ok:true,data:catalog}}return{ok:true}}}};
  const board={className:"current-sleeper-layout",getAttribute(){return null}},document={hidden:false,body:board,addEventListener(){},querySelectorAll(selector){return selector==='[class],[data-testid]'?[board]:[]}},localStorage={length:1,key:index=>index===0?"user":null,getItem:key=>key==="user"?userId:null};
  class MutationObserver{constructor(callback){observerCallback=callback}observe(){}disconnect(){}}
  const context=vm.createContext({URL,location:{href:`https://sleeper.com/draft/nfl/${draftId}`,origin:"https://sleeper.com"},chrome,crypto:webcrypto,localStorage,document,MutationObserver,globalThis:null,setInterval(){return 1},clearInterval(){},setTimeout,clearTimeout});context.globalThis=context;
  new vm.Script(source,{filename:"sleeper.js"}).runInContext(context);
  for(let attempt=0;attempt<20&&!observerCallback;attempt++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(states.length,1);assert.equal(typeof observerCallback,"function");
  picks=Array.from({length:107},(_,index)=>({pick_no:index+1,player_id:index===105?"user-pick-106":index===106?"autopick-107":`picked-${index+1}`,draft_slot:index%10+1}));const started=Date.now();observerCallback([{type:"childList",addedNodes:[{}],removedNodes:[]}]);
  const state=await Promise.race([secondState,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Sleeper mutation refresh timed out")),500))]);
  assert.equal(state.picks.length,107);assert.equal(state.picks[105].playerId,"user-pick-106");assert.equal(state.picks[106].playerId,"autopick-107");assert.ok(Date.now()-started<300);assert.equal(draftFetches,1);assert.equal(pickFetches,2);
});

test("Sleeper adapter can be reinjected in the same tab after a stalled connection",()=>{
  const messages=[];
  const chrome={runtime:{async sendMessage(message){messages.push(message);return message.type==="ADAPTER_ACTIVATED"?{ok:true}:{ok:false,error:"fixture stopped before network access"}}}};
  const context=vm.createContext({URL,location:{href:`https://sleeper.com/draft/nfl/${draftId}`,origin:"https://sleeper.com"},chrome,crypto:webcrypto,localStorage:{length:0,key(){return null},getItem(){return null}},document:{hidden:false,addEventListener(){},querySelectorAll(){return[]}},globalThis:null,setInterval(){return 1},clearInterval(){},setTimeout});
  context.globalThis=context;
  const script=new vm.Script(source,{filename:"sleeper.js"});
  assert.doesNotThrow(()=>script.runInContext(context));
  assert.doesNotThrow(()=>script.runInContext(context));
});

test("Sleeper adapter fails closed for unsupported draft formats",async t=>{
  for(const [name,mutate,pattern] of [
    ["auction",draft=>{draft.type="auction"},/snake drafts only/],
    ["linear",draft=>{draft.type="linear"},/snake drafts only/],
    ["third-round reversal",draft=>{draft.settings.reversal_round=3},/third-round-reversal/],
    ["superflex",draft=>{draft.settings.slots_super_flex=1},/superflex/]
  ])await t.test(name,async()=>{const draft=structuredClone(capturedDraft);mutate(draft);const {state,error}=await runAdapter(draft);assert.equal(state,undefined);assert.match(error,pattern)});
});
