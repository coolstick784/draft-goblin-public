import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {webcrypto} from "node:crypto";

const source=fs.readFileSync(new URL("../extension/adapters/sleeper.js",import.meta.url),"utf8");
const draftId="923456789012345678",userId="1375861210234261504";
const baseDraft=()=>({created:123456789,draft_id:draftId,draft_order:{[userId]:6},metadata:{scoring_type:"std"},season:"2026",settings:{teams:12,rounds:15,slots_qb:1,slots_rb:2,slots_wr:2,slots_te:1,slots_flex:2,slots_k:1,slots_def:1,slots_bn:5},status:"drafting",type:"snake"});
const catalog={
  alpha:{player_id:"alpha",full_name:"Alpha Runner",position:"RB",team:"BUF",active:true},
  bravo:{player_id:"bravo",full_name:"Bravo Receiver",position:"WR",team:"DET",active:true},
  defense:{player_id:"defense",full_name:"Buffalo Bills",position:"DEF",team:"BUF",active:true}
};
const projectionRows=()=>Object.keys(catalog).map((player_id,index)=>({season:"2026",player_id,stats:{pts_std:100+index,pts_half_ppr:150+index,pts_ppr:200+index,adp_std:10+index,adp_half_ppr:20+index,adp_ppr:30+index}}));

async function sleeperHarness(options={}){
  let currentDraft=structuredClone(options.draft||baseDraft()),currentPicks=structuredClone(options.picks||[]),currentRows=projectionRows(),projectionFailures=Number(options.projectionFailures||0),hidden=false,navigated=false;
  const states=[],errors=[],messages=[],intervals=[],clearedIntervals=[],listeners=new Map();let observerCallback,observerDisconnected=false;
  const location={href:options.url||`https://sleeper.com/draft/nfl/${draftId}`,origin:"https://sleeper.com"};
  const chrome={runtime:{async sendMessage(message){messages.push(message);if(message.type==="ADAPTER_ACTIVATED")return{ok:true};if(message.type==="ADAPTER_HEARTBEAT"){if(options.invalidHeartbeat)throw new Error("Extension context invalidated.");return{ok:true}}if(message.type==="DRAFT_STATE"){states.push(structuredClone(message.state));return{ok:true}}if(message.type==="DRAFT_ERROR"){errors.push(message.error);return{ok:true}}if(message.type==="DRAFT_NAVIGATED"){navigated=true;return{ok:true}}if(message.type==="SLEEPER_FETCH"){
    const url=message.url;if(url.includes(`/draft/${draftId}/picks`))return{ok:true,data:structuredClone(currentPicks)};if(url.includes(`/draft/${draftId}`))return{ok:true,data:structuredClone(currentDraft)};if(url.includes("/players/nfl"))return{ok:true,data:catalog};if(url.includes("api.sleeper.com/projections")){if(projectionFailures-->0)return{ok:false,error:"temporary projection outage"};return{ok:true,data:structuredClone(currentRows)}}if(url.includes(`/user/${userId}`))return{ok:true,data:{user_id:userId,username:"test-owner"}};throw new Error(`Unexpected Sleeper request ${url}`)
  }return{ok:true}}}};
  const leaves=()=>[{children:[],textContent:"test-owner"}],board={className:"draft-board",getAttribute(){return null}},document={get hidden(){return hidden},body:board,addEventListener(type,listener){listeners.set(type,listener)},querySelectorAll(selector){if(selector==="body *")return leaves();if(selector==='[class],[data-testid]')return[board];return[]}};
  class MutationObserver{constructor(callback){observerCallback=callback}observe(){}disconnect(){observerDisconnected=true}}
  const localStorage=options.localStorage||{length:0,key(){return null},getItem(){return null}};
  const context=vm.createContext({URL,location,chrome,crypto:webcrypto,localStorage,document,MutationObserver,globalThis:null,setInterval(callback){intervals.push(callback);return intervals.length},clearInterval(id){clearedIntervals.push(id)},setTimeout,clearTimeout});context.globalThis=context;
  new vm.Script(source,{filename:"sleeper.js"}).runInContext(context);
  const waitFor=async predicate=>{for(let attempt=0;attempt<100&&!predicate();attempt++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(predicate(),"Sleeper harness condition timed out")};
  if(options.startupMayStop)await waitFor(()=>context.__draftChampionSleeperAdapter===null);else{await waitFor(()=>states.length+errors.length>0);await waitFor(()=>intervals.length>=2)}
  const cycle=async()=>{const before=states.length+errors.length;for(const callback of [...intervals])await callback();await waitFor(()=>states.length+errors.length>before)};
  return{states,errors,messages,intervals,clearedIntervals,context,location,get draft(){return currentDraft},set draft(value){currentDraft=value},get picks(){return currentPicks},set picks(value){currentPicks=value},set rows(value){currentRows=value},set hidden(value){hidden=value},get navigated(){return navigated},get observerCallback(){return observerCallback},get observerDisconnected(){return observerDisconnected},cycle,waitFor,listeners};
}

test("Sleeper slot detection recovers from an empty pre-draft order and follows a changed snake slot",async()=>{
  const draft=baseDraft();draft.draft_order={};const h=await sleeperHarness({draft});assert.equal(h.states[0].userSlot,null);
  h.draft={...h.draft,draft_order:{[userId]:12}};await h.cycle();assert.equal(h.states.at(-1).userSlot,12);
  h.draft={...h.draft,draft_order:{[userId]:1}};await h.cycle();assert.equal(h.states.at(-1).userSlot,1);
});

test("Sleeper projection selection changes with standard, half-PPR, and PPR metadata in one live draft",async()=>{
  const h=await sleeperHarness();assert.equal(h.states.at(-1).players.find(player=>player.id==="alpha").platformProjection,100);assert.equal(h.states.at(-1).players[0].adpScoring,"standard");
  h.draft={...h.draft,metadata:{scoring_type:"half_ppr"}};await h.cycle();assert.equal(h.states.at(-1).players.find(player=>player.id==="alpha").platformProjection,150);assert.equal(h.states.at(-1).players[0].adpScoring,"half-ppr");
  h.draft={...h.draft,metadata:{scoring_type:"ppr"}};await h.cycle();assert.equal(h.states.at(-1).players.find(player=>player.id==="alpha").platformProjection,200);assert.equal(h.states.at(-1).players[0].adpScoring,"ppr");
});

test("a transient Sleeper projection outage retries before publishing incomplete market data",async()=>{
  const h=await sleeperHarness({projectionFailures:1});assert.equal(h.states.at(-1).players.find(player=>player.id==="alpha").platformProjection,100);
  assert.equal(h.messages.filter(message=>String(message.url||"").includes("api.sleeper.com/projections")).length,2);
});

test("rapid out-of-order picks are sorted and keep exact player identities, including DST",async()=>{
  const h=await sleeperHarness({picks:[{pick_no:3,player_id:"defense",draft_slot:3},{pick_no:1,player_id:"alpha",draft_slot:1},{pick_no:2,player_id:"bravo",draft_slot:2}]});
  assert.deepEqual(h.states.at(-1).picks.map(pick=>[pick.pickNo,pick.playerId,pick.slot]),[[1,"alpha",1],[2,"bravo",2],[3,"defense",3]]);
  assert.equal(h.states.at(-1).players.find(player=>player.id==="defense").position,"DST");
  assert.ok(h.states.at(-1).picks.every(pick=>h.states.at(-1).players.some(player=>player.id===pick.playerId)));
});

test("malformed and duplicate Sleeper pick snapshots fail closed instead of corrupting availability",async()=>{
  const h=await sleeperHarness({picks:[{pick_no:1,player_id:"alpha",draft_slot:1}]});const verified=structuredClone(h.states.at(-1));
  h.picks=[{pick_no:1,player_id:"alpha",draft_slot:1},{pick_no:1,player_id:"bravo",draft_slot:2}];await h.cycle();assert.match(h.errors.at(-1),/duplicate pick numbers/);assert.deepEqual(h.states.at(-1),verified);
  h.picks=null;await h.cycle();assert.match(h.errors.at(-1),/invalid snapshot/);assert.deepEqual(h.states.at(-1),verified);
  h.picks=[{pick_no:1,player_id:"alpha",draft_slot:1},{pick_no:3,player_id:"bravo",draft_slot:3}];await h.cycle();assert.match(h.errors.at(-1),/truncated sequence/);assert.deepEqual(h.states.at(-1),verified);
  h.picks=[{pick_no:1,player_id:"alpha",draft_slot:1},{pick_no:2,player_id:"alpha",draft_slot:2}];await h.cycle();assert.match(h.errors.at(-1),/player more than once/);assert.deepEqual(h.states.at(-1),verified);
});

test("hidden Sleeper tabs do not churn state, then catch up immediately when visible",async()=>{
  const h=await sleeperHarness();const count=h.states.length;h.hidden=true;h.picks=[{pick_no:1,player_id:"alpha",draft_slot:1}];for(const callback of [...h.intervals])await callback();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(h.states.length,count);
  h.hidden=false;h.listeners.get("visibilitychange")();await h.waitFor(()=>h.states.length>count);assert.equal(h.states.at(-1).picks[0].playerId,"alpha");
});

test("navigation to another Sleeper draft stops the old adapter even while the tab is hidden",async()=>{
  const h=await sleeperHarness();h.hidden=true;h.location.href="https://sleeper.com/draft/nfl/823456789012345678";for(const callback of [...h.intervals])await callback();await h.waitFor(()=>h.navigated);assert.equal(h.context.__draftChampionSleeperAdapter,null);assert.equal(h.observerDisconnected,true);
});

test("extension invalidation during startup cannot recreate a poll timer or observer",async()=>{
  const h=await sleeperHarness({invalidHeartbeat:true,startupMayStop:true});assert.equal(h.context.__draftChampionSleeperAdapter,null);assert.equal(h.intervals.length,1);assert.ok(h.clearedIntervals.includes(1));assert.equal(h.observerCallback,undefined);
});

test("completed and rewound snapshots retain a stable Sleeper run identity",async()=>{
  const h=await sleeperHarness({picks:[{pick_no:1,player_id:"alpha",draft_slot:1}]});const run=h.states.at(-1).draftRunId;assert.equal(run,`${draftId}:123456789`);
  h.draft={...h.draft,status:"complete"};await h.cycle();assert.equal(h.states.at(-1).draftRunId,run);assert.equal(h.states.at(-1).draftStatus,"complete");
  h.draft={...h.draft,status:"predraft"};h.picks=[];await h.cycle();assert.equal(h.states.at(-1).draftRunId,run);assert.equal(h.states.at(-1).draftStatus,"predraft");assert.deepEqual(h.states.at(-1).picks,[]);
});

test("a full Sleeper pick feed is terminal even before the draft metadata catches up",async()=>{
  const picks=Array.from({length:180},(_,index)=>({pick_no:index+1,player_id:`player-${index+1}`,draft_slot:index%12+1}));
  const h=await sleeperHarness({picks});
  assert.equal(h.draft.status,"drafting");
  assert.equal(h.states.at(-1).picks.length,180);
  assert.equal(h.states.at(-1).draftStatus,"complete");
});

test("a query draft id wins over unrelated numeric path segments",async()=>{
  const h=await sleeperHarness({url:`https://sleeper.com/draft/nfl/823456789012345678?draft_id=${draftId}`});assert.equal(h.states.at(-1).draftId,draftId);assert.ok(h.messages.some(message=>String(message.url||"").includes(`/draft/${draftId}`)));
});
