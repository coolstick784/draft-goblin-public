import test from "node:test";
import assert from "node:assert/strict";

const session = Object.create(null);
let onMessage;
let onUpdated;
let onConnect;
const executedScripts = [];
const sentTabMessages = [];
const openedPanels = [];
const sidePanelOptions = [];
const offscreenDocuments = [];
const offscreenMessages = [];
let offscreenReadyAfterPings = 0;
let offscreenPingAttempts = 0;

function selected(keys) {
  if (keys == null) return { ...session };
  const names = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(names.filter(key => key in session).map(key => [key, session[key]]));
}

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onConnect: { addListener(listener) { onConnect = listener; } },
    onMessage: { addListener(listener) { onMessage = listener; } },
    getURL(path){return`chrome-extension://draft-goblin/${path}`},
    async getContexts(){return offscreenDocuments.length?[{contextType:"OFFSCREEN_DOCUMENT"}]:[]},
    async sendMessage(message){offscreenMessages.push(message);if(message.type==="OFFSCREEN_ENGINE_PING"){offscreenPingAttempts++;return offscreenPingAttempts>offscreenReadyAfterPings?{ok:true,engine:"draft-goblin-offscreen"}:undefined}if(message.type==="OFFSCREEN_WARM_ENGINE")return{ok:true};if(message.type==="OFFSCREEN_RUN_EVALUATION")return{ok:true,data:{status:"complete",body:message.body}};if(message.type==="OFFSCREEN_CANCEL_EVALUATION")return{ok:true,cancelled:true};return{ok:true}},
  },
  offscreen:{async createDocument(options){offscreenDocuments.push(options)}},
  sidePanel: { async setPanelBehavior() {},async setOptions(options){sidePanelOptions.push(options)},async open(options){openedPanels.push(options)} },
  tabs: {
    async query() { return [{ id: 41, url: "https://sleeper.com/draft/nfl/1234567890" }]; },
    onUpdated:{addListener(listener){onUpdated=listener;}},
    async sendMessage(tabId,message){sentTabMessages.push({tabId,message});return{ok:true}},
  },
  scripting: { async executeScript(input) { executedScripts.push(input); } },
  storage: {
    local: { async get() { return {}; }, async set() {} },
    session: {
      async get(keys) { return selected(keys); },
      async set(values) { Object.assign(session, values); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key]; },
    },
  },
};

await import(`../extension/background.js?behavior-test=${Date.now()}`);

const sender = { tab: { id: 41 } };
const key = "draft:41";
const pick = (pickNo, playerId = `p${pickNo}`, slot = pickNo) => ({ pickNo, playerId, slot });
const draft = ({ id = "draft-a", picks = [], status = "drafting", updatedAt = Date.now(), draftRunId } = {}) => ({
  platform: "sleeper",
  draftId: id,
  ...(draftRunId?{draftRunId}:{}),
  draftStatus: status,
  userSlot: 2,
  settings: { teams: 2, rounds: 2 },
  players: [],
  picks,
  updatedAt,
});

async function send(message, from = sender) {
  let response;
  const pending = onMessage(message, from, value => { response = value; });
  if (pending === true) {
    for (let attempt = 0; attempt < 50 && response === undefined; attempt++) await new Promise(resolve => setTimeout(resolve, 0));
  } else {
    // DRAFT_STATE writes are intentionally queued and do not use sendResponse.
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (message.type !== "DRAFT_STATE" || session[key]?.updatedAt === message.state.updatedAt) break;
    }
  }
  return response;
}

const activate = (adapterSessionId,from=sender) => send({ type: "ADAPTER_ACTIVATED", platform: "sleeper", draftId: "draft-a", adapterSessionId },from);
const stateMessage = (state, adapterSessionId) => ({ type: "DRAFT_STATE", adapterSessionId, state });
async function navigate(url){onUpdated(41,{url});for(let attempt=0;attempt<50;attempt++)await new Promise(resolve=>setTimeout(resolve,0))}
async function announcePanel(message){let listener;const port={name:"DRAFT_GOBLIN_SIDE_PANEL",onMessage:{addListener(value){listener=value}},onDisconnect:{addListener(){}}};onConnect(port);listener(message);for(let attempt=0;attempt<50&&session.activeDraftTab!==Number(message.tabId);attempt++)await new Promise(resolve=>setTimeout(resolve,0))}

function reset() {
  for (const name of Object.keys(session)) delete session[name];
  executedScripts.length = 0;
  sentTabMessages.length = 0;
  openedPanels.length = 0;
  sidePanelOptions.length = 0;
  offscreenDocuments.length = 0;
  offscreenMessages.length = 0;
  offscreenReadyAfterPings = 0;
  offscreenPingAttempts = 0;
}

test("ESPN's lobby cannot open Draft Goblin before a draft exists",async()=>{
  reset();const response=await send({type:"ESPN_OPEN_SIDE_PANEL"},{tab:{id:41,windowId:9,url:"https://fantasy.espn.com/football/mockdraftlobby"}});assert.equal(response.ok,false);assert.deepEqual(openedPanels,[]);
});

test("an actual Sleeper draft can open Draft Goblin in its tab",async()=>{
  reset();const response=await send({type:"OPEN_DRAFT_SIDE_PANEL",platform:"sleeper"},{tab:{id:41,windowId:10,url:"https://sleeper.com/draft/nfl/1234567890"}});assert.deepEqual(response,{ok:true});assert.deepEqual(openedPanels,[{tabId:41}]);
});

test("side-panel launch messages fail closed on every non-draft page",async()=>{
  for(const url of ["https://sleeper.com/drafts","https://fantasy.espn.com/football/mockdraftlobby","https://example.com/"]){reset();const response=await send({type:"OPEN_DRAFT_SIDE_PANEL"},{tab:{id:41,windowId:10,url}});assert.equal(response.ok,false);assert.equal(openedPanels.length,0)}
});

test("side-panel availability follows draft navigation",async()=>{
  reset();await navigate("https://sleeper.com/drafts");assert.deepEqual(sidePanelOptions.at(-1),{tabId:41,enabled:false});
  await navigate("https://sleeper.com/draft/nfl/1234567890");assert.deepEqual(sidePanelOptions.at(-1),{tabId:41,path:"sidepanel.html",enabled:true});
  await navigate("https://example.com/");assert.deepEqual(sidePanelOptions.at(-1),{tabId:41,enabled:false});
});

test("a Yahoo side panel claims its exact tab instead of rendering stale ESPN state",async()=>{
  reset();session.activeDraftTab=40;session["draft:40"]={...draft({id:"old-espn"}),platform:"espn"};
  await announcePanel({type:"DRAFT_SIDE_PANEL_OPEN",windowId:9,tabId:44,url:"https://football.fantasysports.yahoo.com/draftclient/f1/8103584/3?auth="});
  assert.equal(session.activeDraftTab,44);
  assert.equal(executedScripts.at(-1)?.target?.tabId,44);
  assert.deepEqual(executedScripts.at(-1)?.files,["adapters/yahoo.js"]);
});

test("simulation requests are brokered through one persistent offscreen worker document",async()=>{
  reset();const body=JSON.stringify({draftId:"draft-a",refineIterations:10000}),first=await send({type:"RUN_PERSISTENT_EVALUATION",body,requestId:"request-a"}),second=await send({type:"RUN_PERSISTENT_EVALUATION",body,requestId:"request-b"});
  assert.deepEqual(first,{ok:true,data:{status:"complete",body}});
  assert.deepEqual(second,first);
  assert.deepEqual(offscreenDocuments,[{url:"offscreen.html",reasons:["WORKERS"],justification:"Keep an active draft simulation running while its side panel is hidden."}]);
  assert.deepEqual(offscreenMessages.filter(message=>message.type==="OFFSCREEN_RUN_EVALUATION").map(message=>message.requestId),["request-a","request-b"]);
});

test("side-panel warmup targets the persistent offscreen engine instead of creating a second worker pool",async()=>{
  reset();const response=await send({type:"WARM_PERSISTENT_EVALUATION_ENGINE"});
  assert.deepEqual(response,{ok:true});
  assert.deepEqual(offscreenDocuments,[{url:"offscreen.html",reasons:["WORKERS"],justification:"Keep an active draft simulation running while its side panel is hidden."}]);
  assert.equal(offscreenMessages.filter(message=>message.type==="OFFSCREEN_WARM_ENGINE").length,1);
});

test("the background waits for the offscreen listener and forwards obsolete-job cancellation",async()=>{
  reset();offscreenReadyAfterPings=2;const body=JSON.stringify({draftId:"cold-start",refineIterations:10000}),result=await send({type:"RUN_PERSISTENT_EVALUATION",body,requestId:"cold-request"});
  assert.equal(result.ok,true);
  assert.equal(offscreenPingAttempts,3);
  const cancelled=await send({type:"CANCEL_PERSISTENT_EVALUATION",requestId:"cold-request"});
  assert.deepEqual(cancelled,{ok:true,cancelled:true});
  assert.deepEqual(offscreenMessages.at(-1),{type:"OFFSCREEN_CANCEL_EVALUATION",requestId:"cold-request"});
});

test("background draft lifecycle merges only genuinely continuous adapter states", async t => {
  await t.test("a new draft id replaces every pick from the prior draft", async () => {
    reset();
    await activate("new-id-session");
    await send(stateMessage(draft({ id: "old", picks: [pick(1), pick(2), pick(3)] }),"new-id-session"));
    await send(stateMessage(draft({ id: "new", picks: [pick(1, "new-player", 1)] }),"new-id-session"));
    assert.equal(session[key].draftId, "new");
    assert.deepEqual(session[key].picks, [pick(1, "new-player", 1)]);
  });

  await t.test("a shorter matching prefix is treated as a transient API truncation", async () => {
    reset();
    await activate("prefix-session");
    const complete = [pick(1), pick(2), pick(3)];
    await send(stateMessage(draft({ picks: complete }),"prefix-session"));
    await send(stateMessage(draft({ picks: complete.slice(0, 2) }),"prefix-session"));
    assert.deepEqual(session[key].picks, complete);
    await send(stateMessage(draft({ picks: complete.slice(0, 2) }),"prefix-session"));
    assert.deepEqual(session[key].picks, complete.slice(0, 2));
  });

  await t.test("a same-id rewind with a changed pick resets to the new sequence", async () => {
    reset();
    await activate("rewind-session");
    await send(stateMessage(draft({ picks: [pick(1), pick(2), pick(3)] }),"rewind-session"));
    const restarted = [pick(1, "replacement", 1)];
    await send(stateMessage(draft({ picks: restarted }),"rewind-session"));
    assert.deepEqual(session[key].picks, restarted);
  });

  await t.test("a completed same-id board rewound to drafting resets even with a matching prefix", async () => {
    reset();
    await activate("status-session");
    const completed = [pick(1), pick(2), pick(3), pick(4)];
    await send(stateMessage(draft({ status: "complete", picks: completed }),"status-session"));
    await send(stateMessage(draft({ status: "drafting", picks: completed.slice(0, 1) }),"status-session"));
    assert.deepEqual(session[key].picks, completed.slice(0, 1));
  });

  await t.test("a changed ESPN run identity resets a reused league id immediately", async () => {
    reset();
    await send({type:"ADAPTER_ACTIVATED",platform:"espn",draftId:"same-league",adapterSessionId:"espn-run-session"});
    const espnState=value=>({...value,platform:"espn"});
    await send(stateMessage(espnState(draft({id:"same-league",status:"complete",draftRunId:"run-a",picks:[pick(1),pick(2),pick(3),pick(4)]})),"espn-run-session"));
    await send(stateMessage(espnState(draft({id:"same-league",status:"drafting",draftRunId:"run-b",picks:[pick(1,"replacement",1)]})),"espn-run-session"));
    assert.equal(session[key].draftRunId,"run-b");
    assert.deepEqual(session[key].picks,[pick(1,"replacement",1)]);
  });

  await t.test("a completed same-run board also accepts a predraft rewind", async () => {
    reset();
    await activate("predraft-rewind-session");
    const completed=[pick(1),pick(2),pick(3),pick(4)];
    await send(stateMessage(draft({status:"complete",draftRunId:"run-a",picks:completed}),"predraft-rewind-session"));
    await send(stateMessage(draft({status:"predraft",draftRunId:"run-a",picks:[]}),"predraft-rewind-session"));
    assert.deepEqual(session[key].picks,[]);
  });

  await t.test("an older adapter session cannot overwrite a newer verified snapshot", async () => {
    reset();
    await activate("old-session");
    await send(stateMessage(draft({ picks: [pick(1)], updatedAt: 100 }),"old-session"));
    await activate("new-session");
    await send(stateMessage(draft({ picks: [pick(1),pick(2)], updatedAt: 200 }),"new-session"));
    await send(stateMessage(draft({ picks: [], updatedAt: 300 }),"old-session"));
    assert.equal(session[key].updatedAt, 200);
    assert.deepEqual(session[key].picks, [pick(1),pick(2)]);
  });

  await t.test("an older ESPN adapter session cannot overwrite a newer verified snapshot", async () => {
    reset();
    const espnState=(updatedAt,picks)=>({...draft({id:"espn-draft",picks,updatedAt}),platform:"espn"});
    await send({type:"ADAPTER_ACTIVATED",platform:"espn",draftId:"espn-draft",adapterSessionId:"espn-old"});
    await send(stateMessage(espnState(100,[pick(1)]),"espn-old"));
    await send({type:"ADAPTER_ACTIVATED",platform:"espn",draftId:"espn-draft",adapterSessionId:"espn-new"});
    await send(stateMessage(espnState(200,[pick(1),pick(2)]),"espn-new"));
    await send(stateMessage(espnState(300,[]),"espn-old"));
    assert.equal(session[key].updatedAt,200);
    assert.deepEqual(session[key].picks,[pick(1),pick(2)]);
  });

  await t.test("a current heartbeat refreshes state age without changing semantic draft data",async()=>{
    reset();
    await activate("heartbeat-session");
    await send(stateMessage(draft({picks:[pick(1)],updatedAt:100}),"heartbeat-session"));
    const before=structuredClone(session[key]);
    assert.deepEqual(await send({type:"DRAFT_HEARTBEAT",platform:"sleeper",draftId:"draft-a",adapterSessionId:"heartbeat-session",updatedAt:900}),{ok:true});
    assert.equal(session[key].updatedAt,900);
    assert.deepEqual({...session[key],updatedAt:before.updatedAt},before);
    assert.deepEqual(await send({type:"DRAFT_HEARTBEAT",platform:"sleeper",draftId:"draft-a",adapterSessionId:"stale-session",updatedAt:1000}),{ok:false,stale:true});
    assert.equal(session[key].updatedAt,900);
  });

  await t.test("an ESPN pick-only update immediately reduces the user's open RB starters",async()=>{
    reset();
    const adapterSessionId="espn-rb-needs-session",rb={id:"rb-1",name:"Drafted RB",position:"RB"};
    await send({type:"ADAPTER_ACTIVATED",platform:"espn",draftId:"espn-rb-needs",adapterSessionId});
    await send(stateMessage({...draft({id:"espn-rb-needs",picks:[],updatedAt:100}),platform:"espn",userSlot:1,currentPickNo:1,settings:{teams:2,rounds:4,slots:{QB:1,RB:2,WR:1,TE:0,FLEX:0,K:0,DST:0,BENCH:0}},players:[rb]},adapterSessionId));
    const response=await send({type:"DRAFT_PICK_UPDATE",platform:"espn",draftId:"espn-rb-needs",adapterSessionId,currentPickNo:2,picks:[pick(1,rb.id,1)]});
    const userRbs=session[key].picks.filter(row=>Number(row.slot)===1).map(row=>session[key].players.find(player=>player.id===row.playerId)).filter(player=>player?.position==="RB").length;
    assert.deepEqual(response,{ok:true});
    assert.equal(session[key].settings.slots.RB-userRbs,1);
    assert.equal(session[key].currentPickNo,2);
  });

  await t.test("a current parser error pauses an existing state once its last heartbeat is stale",async()=>{
    reset();
    session.activeDraftTab=41;
    await activate("stale-error-session");
    await send(stateMessage(draft({picks:[pick(1)],updatedAt:1}),"stale-error-session"));
    const response=await send({type:"DRAFT_ERROR",platform:"sleeper",adapterSessionId:"stale-error-session",error:"Live parser stopped."});
    assert.deepEqual(response,{ok:true,published:true});
    assert.equal(session.draftError,"Live parser stopped.");
    await send({type:"DRAFT_HEARTBEAT",platform:"sleeper",draftId:"draft-a",adapterSessionId:"stale-error-session",updatedAt:Date.now()});
    assert.equal(session.draftError,null);
  });

  await t.test("a fresh heartbeat cancels a transient parser-error grace timer",async()=>{
    reset();
    session.activeDraftTab=41;
    await activate("transient-error-session");
    const updatedAt=Date.now();
    await send(stateMessage(draft({picks:[pick(1)],updatedAt}),"transient-error-session"));
    const response=await send({type:"DRAFT_ERROR",platform:"sleeper",adapterSessionId:"transient-error-session",error:"Transient parser error."});
    assert.deepEqual(response,{ok:true,published:false});
    assert.equal(session.draftError,null);
    await send({type:"DRAFT_HEARTBEAT",platform:"sleeper",draftId:"draft-a",adapterSessionId:"transient-error-session",updatedAt:updatedAt+1});
    assert.equal(session.draftError,null);
  });

  await t.test("manual refresh clears saved state and the next current adapter snapshot reconnects", async () => {
    reset();
    await activate("before-refresh");
    await send(stateMessage(draft({ picks: [pick(1), pick(2)], updatedAt: 300 }),"before-refresh"));
    const response = await send({ type: "START_NEW_DRAFT" }, { tab: undefined });
    assert.equal(response.ok,true);
    assert.equal(response.tabId,41);
    assert.equal(response.phase,"attaching");
    assert.equal(session[key], undefined);
    await activate("after-refresh");
    await send(stateMessage(draft({ picks: [pick(1)], updatedAt: 400 }),"after-refresh"));
    assert.equal(session[key].draftId, "draft-a");
    assert.deepEqual(session[key].picks, [pick(1)]);
  });

  await t.test("the connection supervisor deduplicates attachment and trusts only live heartbeats",async()=>{
    reset();
    await activate("dead-supervisor-session");
    await send({type:"ADAPTER_BOOT_ERROR",platform:"sleeper",draftId:"1234567890",error:"Bootstrap failed."});
    const retryWait=Math.max(0,Number(session["draftHealth:41"].nextRetryAt)-Date.now())+50;
    await new Promise(resolve=>setTimeout(resolve,retryWait));
    const first=await send({type:"ENSURE_ACTIVE_DRAFT"},{tab:undefined}),afterFirst=executedScripts.length;
    const second=await send({type:"ENSURE_ACTIVE_DRAFT"},{tab:undefined});
    assert.equal(first.phase,"retrying");
    assert.equal(second.phase,"retrying");
    assert.equal(executedScripts.length,afterFirst);
    await send({type:"ADAPTER_ACTIVATED",platform:"sleeper",draftId:"1234567890",adapterSessionId:"healthy-supervisor-session"});
    const heartbeat=await send({type:"ADAPTER_HEARTBEAT",platform:"sleeper",draftId:"1234567890",adapterSessionId:"healthy-supervisor-session",phase:"connecting"});
    session.draftError="A verified parser failure must not blink away during a health poll.";
    const healthy=await send({type:"ENSURE_ACTIVE_DRAFT"},{tab:undefined});
    assert.equal(heartbeat.phase,"connecting");
    assert.equal(healthy.phase,"connecting");
    assert.equal(executedScripts.length,afterFirst);
    assert.equal(session["draftHealth:41"].adapterSessionId,"healthy-supervisor-session");
    assert.equal(session.draftError,"A verified parser failure must not blink away during a health poll.");
  });

  await t.test("a fresh error heartbeat retries automatically after its bounded delay",async()=>{
    reset();
    await send({type:"ENSURE_ACTIVE_DRAFT"},{tab:undefined});
    await send({type:"ADAPTER_ACTIVATED",platform:"sleeper",draftId:"1234567890",adapterSessionId:"error-retry-session"});
    await send({type:"DRAFT_ERROR",platform:"sleeper",adapterSessionId:"error-retry-session",error:"Parser could not verify the mounted board."});
    const before=executedScripts.length;
    const waiting=await send({type:"ENSURE_ACTIVE_DRAFT"},{tab:undefined});
    assert.equal(waiting.phase,"error");
    assert.equal(executedScripts.length,before);
    const retryWait=Math.max(0,Number(session["draftHealth:41"].nextRetryAt)-Date.now())+50;
    await new Promise(resolve=>setTimeout(resolve,retryWait));
    const retried=await send({type:"ENSURE_ACTIVE_DRAFT"},{tab:undefined});
    assert.equal(retried.phase,"retrying");
    assert.equal(executedScripts.length,before+1);
    assert.equal(session.draftError,undefined);
  });

  await t.test("a connecting adapter that never publishes its first state is silently reinjected",async()=>{
    reset();
    await send({type:"ENSURE_ACTIVE_DRAFT"},{tab:undefined});
    await send({type:"ADAPTER_ACTIVATED",platform:"sleeper",draftId:"1234567890",adapterSessionId:"first-state-stall"});
    await send({type:"ADAPTER_HEARTBEAT",platform:"sleeper",draftId:"1234567890",adapterSessionId:"first-state-stall",phase:"connecting"});
    const before=executedScripts.length;
    const withinGrace=await send({type:"ENSURE_ACTIVE_DRAFT"},{tab:undefined});
    assert.equal(withinGrace.phase,"connecting");
    assert.equal(executedScripts.length,before);
    const attachStartedAt=Number(session["draftHealth:41"].attachStartedAt);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,attachStartedAt+3050-Date.now())));
    let retried=await send({type:"ENSURE_ACTIVE_DRAFT"},{tab:undefined});
    const retryDeadline=Date.now()+1500;
    while(retried.phase!=="retrying"&&Date.now()<retryDeadline){await new Promise(resolve=>setTimeout(resolve,50));retried=await send({type:"ENSURE_ACTIVE_DRAFT"},{tab:undefined})}
    assert.equal(retried.phase,"retrying");
    assert.equal(executedScripts.length,before+1);
    assert.equal(session.draftError,undefined);
  });

  await t.test("a background draft tab cannot steal panel ownership", async () => {
    reset();
    session.activeDraftTab=41;
    session.draftError="active draft error";
    const backgroundSender={tab:{id:42}};
    await activate("background-session",backgroundSender);
    await send(stateMessage(draft({id:"background",picks:[pick(1)]}),"background-session"),backgroundSender);
    assert.equal(session.activeDraftTab,41);
    assert.equal(session.draftError,"active draft error");
  });

  await t.test("an active draft snapshot takes ownership from an older completed tab", async () => {
    reset();
    const completedSender={tab:{id:42,active:false}};
    const liveSender={tab:{id:43,active:true}};
    session.activeDraftTab=42;
    await activate("completed-tab-session",completedSender);
    await send(stateMessage(draft({id:"completed",status:"complete",picks:[pick(1),pick(2),pick(3),pick(4)]}),"completed-tab-session"),completedSender);
    await activate("live-tab-session",liveSender);
    await send(stateMessage(draft({id:"live",status:"drafting",picks:[pick(1)]}),"live-tab-session"),liveSender);
    for(let attempt=0;attempt<20&&session.activeDraftTab!==43;attempt++)await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(session.activeDraftTab,43);
    assert.equal(session["draft:43"].draftId,"live");
    await send({type:"DRAFT_HEARTBEAT",platform:"sleeper",draftId:"completed",adapterSessionId:"completed-tab-session",updatedAt:Date.now()},completedSender);
    assert.equal(session.activeDraftTab,43);
  });

  await t.test("a stale adapter cannot restart itself after a newer session activates", async () => {
    reset();
    await activate("old-navigation-session");
    await activate("new-navigation-session");
    session.activeDraftTab=41;
    await send(stateMessage(draft({picks:[pick(1)],updatedAt:500}),"new-navigation-session"));
    const before=executedScripts.length;
    const response=await send({type:"DRAFT_NAVIGATED",adapterSessionId:"old-navigation-session"});
    assert.deepEqual(response,{ok:false,stale:true});
    assert.equal(executedScripts.length,before);
    assert.equal(session[key].updatedAt,500);
  });

  await t.test("confirmed navigation away clears the active tab's stale draft", async () => {
    reset();
    session.activeDraftTab=41;
    await activate("navigation-session");
    await send(stateMessage(draft({picks:[pick(1),pick(2)],updatedAt:600}),"navigation-session"));
    session.draftError="old error";
    const response=await send({type:"DRAFT_NAVIGATED",adapterSessionId:"navigation-session"});
    assert.deepEqual(response,{ok:true});
    assert.equal(session[key],undefined);
    assert.equal(session.draftError,undefined);
    assert.equal(executedScripts.length,0);
  });

  await t.test("a newly activated session wins a navigation cleanup race", async () => {
    reset();
    session.activeDraftTab=41;
    await activate("departing-session");
    await send(stateMessage(draft({picks:[pick(1)],updatedAt:700}),"departing-session"));
    const navigation=send({type:"DRAFT_NAVIGATED",adapterSessionId:"departing-session"});
    await activate("replacement-session");
    await send(stateMessage(draft({id:"replacement",picks:[pick(1),pick(2)],updatedAt:800}),"replacement-session"));
    assert.deepEqual(await navigation,{ok:true});
    assert.equal(session[key].draftId,"replacement");
    assert.equal(session[key].updatedAt,800);
  });

  await t.test("same-tab ESPN lobby and draft navigation cleans up and bootstraps deterministically",async()=>{
    reset();
    session.activeDraftTab=41;
    await send({type:"ADAPTER_ACTIVATED",platform:"espn",draftId:"123",adapterSessionId:"espn-navigation"});
    await send(stateMessage({...draft({id:"123",picks:[pick(1)],updatedAt:1000}),platform:"espn"},"espn-navigation"));
    await navigate("https://fantasy.espn.com/football/mockdraftlobby");
    assert.equal(session[key],undefined);
    assert.equal(executedScripts.length,0);
    await navigate("https://fantasy.espn.com/football/draft?leagueId=123&seasonId=2026&teamId=1");
    assert.equal(session.activeDraftTab,41);
    assert.equal(executedScripts.at(-1).files[0],"adapters/espn.js");
  });

  await t.test("the ESPN in-page route watcher bootstraps a same-tab draft",async()=>{
    reset();
    const response=await send({type:"ESPN_LOCATION_CHANGED",url:"https://fantasy.espn.com/football/draft?leagueId=456&seasonId=2026&teamId=1"});
    assert.deepEqual(response,{ok:true});
    assert.equal(session.activeDraftTab,41);
    assert.equal(executedScripts.at(-1).files[0],"adapters/espn.js");
  });
});
