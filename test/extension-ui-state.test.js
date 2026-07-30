import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// This is deliberately dependency-free. It executes the real sidepanel module against a
// small DOM/Chrome/fetch implementation so async ordering is covered, rather than merely
// checking the source text for guards which may still compose incorrectly at runtime.

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no});return{promise,resolve,reject}};

class FakeElement{
  constructor(id="",record=()=>{}){this.id=id;this._text="";this._html="";this.hidden=false;this.value="";this.checked=false;this.dataset={};this.attributes=new Map();this.listeners=new Map();this.observers=[];this.record=record;this._children=[];this.className="";this.classList={add:()=>{},remove:()=>{},toggle:()=>{}}}
  set textContent(value){this._text=String(value);this._html="";this.changed()}
  get textContent(){return this._text}
  set innerHTML(value){this._html=String(value);this._text="";this._children=[];this._cardNodes=null;if(this.id==="weights")for(const match of this._html.matchAll(/data-weight="([^"]+)"[^>]*value="([^"]+)"/g)){const input=new FakeElement("",this.record),output=new FakeElement("",this.record);input.dataset.weight=match[1];input.value=match[2];input.nextElementSibling=output;this._children.push(input)}this.changed()}
  get innerHTML(){return this._html}
  changed(){this.record();for(const observer of this.observers)queueMicrotask(()=>observer.callback())}
  setAttribute(name,value){this.attributes.set(name,String(value));this.record()}
  removeAttribute(name){this.attributes.delete(name);this.record()}
  hasAttribute(name){return this.attributes.has(name)}
  removeAttributeNode(name){this.removeAttribute(name)}
  addEventListener(type,fn){this.listeners.set(type,fn)}
  removeAttribute(name){this.attributes.delete(name);this.record()}
  append(child){this._html+=`<div class="${child.className||""}">${child.textContent}</div>`;this.changed()}
  getClientRects(){return this.hidden?[]:[{}]}
  focus(){}
  scrollIntoView(){}
  matches(selector){return selector==="[data-weight]"&&Boolean(this.dataset.weight)}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null}
  querySelectorAll(selector){
    if(selector==="[data-weight]")return this._children;
    if(this.id==="positionFilter"||this.id==="boardPosition"){
      if(!this._positions){this._positions=["ALL","QB","RB","WR","TE","K","DST"].map(value=>{const input=new FakeElement("",this.record);input.value=value;input.checked=value==="ALL";return input})}
      if(selector==='[value="ALL"]')return this._positions.filter(input=>input.value==="ALL");
      if(selector==='input:not([value="ALL"]):checked')return this._positions.filter(input=>input.value!=="ALL"&&input.checked);
      if(selector==='input:not([value="ALL"])')return this._positions.filter(input=>input.value!=="ALL");
    }
    if(this.id==="recommendations"){
      const skeletons=[...this._html.matchAll(/<article class="card skeleton"/g)].map(()=>({className:"card skeleton"}));
      const cards=this._cardNodes??=[...this._html.matchAll(/<article class="card" data-player-id="([^"]+)"/g)].map(match=>{const card=new FakeElement("",this.record);card.className="card";card.dataset.playerId=match[1];return card});
      if(selector===".skeleton")return skeletons;
      if(selector===".card:not(.skeleton)")return cards;
    }
    return[];
  }
}

class FakeMutationObserver{constructor(callback){this.callback=callback}observe(target){target.observers.push(this)}}

function makeResponse(body,{status=200}={}){return{status,ok:status>=200&&status<300,json:async()=>body}}
function refined(id="p1"){const simulation={championshipProbability:.14,conditionalChampionshipProbability:.15,iterations:10000};return{status:"complete",simulationStatus:"refined",refinementOutcome:"complete",iterations:10000,targetIterations:10000,refinementMs:1800,recommendations:[{player:{id,name:`Player ${id}`,position:"RB",team:"BUF",mean:200,floor:150,ceiling:250,risk:.3,projectionConsensus:{sources:[]}},simulation,teamSimulation:simulation,waitingForUserPick:false,availabilityTargetPick:3,nextPickAvailability:.25,availabilityConfidence:"high",drivers:[{key:"projection"}],factors:{need:.7}}]}}
function preliminary(id="p1"){return{...refined(id),status:"refining",simulationStatus:"refining",refinementOutcome:undefined,iterations:300,targetIterations:10000,refinementMs:undefined}}
function recommendationBelowBaseline(){const data=refined("lower");data.recommendations[0].simulation={championshipProbability:.092,conditionalChampionshipProbability:.092,iterations:10000};data.recommendations[0].teamSimulation={championshipProbability:.10,conditionalChampionshipProbability:.10,iterations:10000};return data}
const pending=status=>({simulationStatus:status,iterations:status==="calculating"?0:300,targetIterations:10000,recommendations:[]});

async function createHarness({persistedStableEvaluation,persistedLocal={}}={}){
  const snapshots=[],elements=new Map(),record=()=>{const status=elements.get("status"),freshness=elements.get("freshness"),cards=elements.get("recommendations");if(status&&freshness&&cards)snapshots.push({status:status.textContent,freshness:freshness.textContent,skeleton:Boolean(cards.querySelector(".skeleton")),cards:cards.querySelectorAll(".card:not(.skeleton)").length,busy:cards.hasAttribute("aria-busy"),prepHidden:elements.get("draftPrep")?.hidden,sectionHeading:elements.get("sectionHeading")?.textContent})};
  const get=id=>{if(!elements.has(id))elements.set(id,new FakeElement(id,record));return elements.get(id)};
  for(const id of ["strategy","projectionDriver","projectionPlatformOption","projectionDriverHelp","sourceProfile","slot","recommendations","error","weights","positionFilter","freshness","status","slotHelp","range","chance","decisionAuthority","decisionLean","decisionEvidence","newDraftReady","draftPrep","prepTitle","prepHelp","reportReady","reportLink"])get(id);
  get("strategy").value="titleOnly";get("projectionDriver").value="draftGoblin";get("sourceProfile").value="projectionLed";get("refinementMode").value="bounded";
  const heading=get("sectionHeading"),body=new FakeElement("body",record),document={hidden:false,body,activeElement:null,getElementById:get,querySelector:selector=>selector===".hero"?get("hero"):heading,createElement:()=>new FakeElement("",record),addEventListener(){}};
  let storedState={platform:"sleeper",draftId:"draft-a",draftRunId:"run-a",userSlot:1,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[],players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]};
  let draftError;const queues=new Map(),calls=[],requests=[];
  const enqueue=(path,item)=>{if(!queues.has(path))queues.set(path,[]);queues.get(path).push(item)};
  const abortError=()=>Object.assign(new Error("Aborted"),{name:"AbortError"});
  const awaitWithAbort=(value,signal)=>{
    if(!signal)return Promise.resolve(value);
    if(signal.aborted)return Promise.reject(abortError());
    return new Promise((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener("abort",abort);reject(abortError())};
      signal.addEventListener("abort",abort,{once:true});
      Promise.resolve(value).then(
        result=>{signal.removeEventListener("abort",abort);resolve(result)},
        cause=>{signal.removeEventListener("abort",abort);reject(cause)}
      )
    })
  };
  const fetch=async(url,options={})=>{const path=new URL(url).pathname,candidate=queues.get(path)?.shift();calls.push(path);requests.push({path,body:options.body?JSON.parse(options.body):undefined});if(candidate){const value=await awaitWithAbort(candidate.promise||candidate,options.signal);if(value instanceof Error)throw value;return makeResponse(value.body??value,{status:Number.isInteger(value.status)?value.status:200})}if(path==="/v1/quick-evaluate"){const body=JSON.parse(options.body||"{}"),taken=new Set((body.state?.picks||[]).map(pick=>String(pick.playerId))),player=(body.state?.players||[]).find(item=>!taken.has(String(item.id)))||body.state?.players?.[0];return makeResponse(preliminary(player?.id||"p1"))}if(path==="/v1/catalog")return makeResponse({modelVersion:"test",dataQuality:"calibrated",players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",meanPpr:200,mean:200,risk:.3,adp:10}]});if(path.includes("/v1/projections/"))return makeResponse({available:false,players:[]});throw new Error(`Unexpected request: ${path}`)};
  let stableRefinedEvaluation=persistedStableEvaluation;const localValues={openedDraftReports:[],...persistedLocal},localWrites=[];const chrome={storage:{session:{get:async key=>key==="stableRefinedEvaluation"?{stableRefinedEvaluation}:{activeDraftTab:7,"draft:7":storedState,...(draftError?{draftError}: {})},set:async values=>{if("stableRefinedEvaluation"in values)stableRefinedEvaluation=values.stableRefinedEvaluation},remove:async key=>{if(key==="stableRefinedEvaluation")stableRefinedEvaluation=undefined}},local:{get:async()=>({...localValues}),set:async values=>{Object.assign(localValues,values);localWrites.push(structuredClone(values))},remove:async keys=>{for(const key of(Array.isArray(keys)?keys:[keys]))delete localValues[key]}},onChanged:{addListener(){}}},runtime:{sendMessage:async()=>({ok:true})}};
  const injected=`const chrome=globalThis.chrome,document=globalThis.document,MutationObserver=globalThis.MutationObserver,Date=globalThis.Date,DEFAULT_PROJECTION_DRIVER="draftGoblin",PROJECTION_DRIVERS=["draftGoblin","platform"],harnessFetch=globalThis.fetch;const localApi=async(path,options={})=>{const response=await harnessFetch('https://extension.invalid'+path,options),data=response.status===204?{}:await response.json();if(!response.ok)throw new Error(data.error||'Request failed');return data},persistentLocalApi=localApi,acceleratedLocalApi=localApi;const projectionConsensus=({platformProjection,sources={}})=>({points:Number(platformProjection||0),sources:Object.entries(sources).map(([key,value])=>({key,label:key,available:true,points:value.points}))});const projectionSourceSummary=(consensus,mean)=>\`Projection: \${Number(mean||0).toFixed(1)}\`;const exactTitleSimulation=data=>data?.status==="complete"&&data?.simulationStatus==="refined"&&Number(data?.iterations)===10000&&Number(data?.targetIterations)===10000&&Array.isArray(data?.recommendations)&&data.recommendations.length>0&&data.recommendations.every(item=>Number(item?.simulation?.iterations)===10000&&Number(item?.teamSimulation?.iterations)===10000);const completedDraftProjectionCoverage=()=>({ready:true,projected:4,eligible:4});const mergeRecommendationHistories=(...histories)=>[...new Map(histories.flat().map(row=>[Number(row.pickNo),row])).values()];const enrichLiveDraftState=({state,baseline,draftGoblinFeed={players:[]},projectionDriver="draftGoblin"})=>({...state,modelVersion:baseline.modelVersion,dataQuality:baseline.dataQuality,players:state.players.map(player=>{const found=baseline.players.find(item=>String(item.id)===String(player.id))||{},owned=draftGoblinFeed.players?.find(item=>String(item.id)===String(player.id))||{},platform=Number(player.platformProjection||found.meanPpr||found.mean||0),ownedPoints=Number(owned.points||0),mean=projectionDriver==="platform"||!(ownedPoints>0)?platform:ownedPoints,risk=Number(found.risk||player.risk||.3),label=projectionDriver==="platform"?"Sleeper":"Draft Goblin";return{...found,...player,mean,floor:mean*(1-risk*.55),ceiling:mean*(1.25+risk*.35),risk,draftGoblinProjection:ownedPoints||null,projectionConsensus:{points:mean,selectedDriver:projectionDriver,sources:[{key:projectionDriver,label,available:true,points:mean,weight:1}]},eligibleForRecommendation:player.eligibleForRecommendation!==false&&mean>0}})});const expandEspnCatalog=(state)=>state;const detectedCurrentPick=(state)=>Number(state.currentPickNo||state.picks.length+1);const espnCandidateEligible=()=>true;const pickHistoryIsCurrent=()=>true;const recommendationWindowKey=(state)=>JSON.stringify([state.platform,state.draftId,state.draftRunId,state.userSlot,state.settings,state.picks.filter(p=>Number(p.slot)===Number(state.userSlot))]);const filterRecommendationsByPositions=(data,positions)=>!positions?data:({...data,recommendations:(data.recommendations||[]).filter(r=>positions.includes(r.player.position))});const recommendationByPlayerId=(data)=>new Map((data?.recommendations||[]).map(r=>[String(r.player.id),r]));const removeUnavailableRecommendationsBase=(data,state)=>({...data,recommendations:(data.recommendations||[]).filter(r=>!(state.picks||[]).some(p=>String(p.playerId)===String(r.player.id)))});const removeDraftedBoardCandidates=(candidates,state)=>(candidates||[]).filter(candidate=>!(state.picks||[]).some(pick=>[candidate.player?.id,candidate.player?.platformPlayerId].map(String).includes(String(pick.playerId))));const buildPlayerIdentityIndex=(players)=>players;const matchPlayerIdentity=(players,player)=>(players instanceof Map?[]:players||[]).find(p=>String(p.id)===String(player.id));const setPracticeAvailability=async()=>{};`;
  let source=fs.readFileSync(new URL("../extension/sidepanel.js",import.meta.url),"utf8").replace(/^import[^\n]+\n/gm,"");
  source=source.slice(0,source.indexOf('chrome.storage.local.remove(["sleeperCatalog"'));
  source=source.replace("function showEvaluationFailure(cause){","function showEvaluationFailure(cause){globalThis.__lastSidepanelError=cause;");
  const stateAwareInjected='const warmPersistentLocalEngineWorkers=async()=>{globalThis.__sidepanelWarmCalls=(globalThis.__sidepanelWarmCalls||0)+1},warmLocalEngineWorkers=warmPersistentLocalEngineWorkers;'+injected.replace('state.picks.filter(p=>Number(p.slot)===Number(state.userSlot))','state.picks.map(p=>[p.pickNo,p.playerId,p.slot])');
  source=`${stateAwareInjected}\n${source}\ntutorialCompleted=true;globalThis.__sidepanelTest={uiRefresh,setLoading,activePresetWeights,applyStoredControls,customWeights,selectedPositions,syncProfileWeightDisplay,resetDraftPresentation,startNewDraft,completedDraftReport,clearDraftReport,recommendationCardsHtml,renderPlayerBoard,syncPlayerBoardWithDraftState,sortBoardRows:(rows,key)=>[...rows].sort((a,b)=>compareBoardRows(a,b,key)),showLiveDraftPosition,livePresentationState,showEvaluationFailure,showExactOddsFailure,currentContext:()=>currentLiveState?userPickContext(currentLiveState):"",cancelControlRefresh:()=>clearTimeout(controlTimer),retryExactOdds,retryWhileSettlingForTest:settling=>{exactEvaluationPromise=settling;exactEvaluationContextKey=userPickContext(currentLiveState);showExactOddsFailure(new Error("Exact title odds exceeded the engine budget."),exactEvaluationContextKey);return retryExactOdds()},replaceExactWhileSettlingForTest:(settling,payload)=>{exactEvaluationPromise=settling;exactEvaluationContextKey="obsolete-control-context";evaluationAbortController=new AbortController();return startExactEvaluation(userPickContext(currentLiveState),payload)},seedExactForTest:(settling,contextKey)=>{exactEvaluationPromise=settling;exactEvaluationContextKey=contextKey;evaluationAbortController=new AbortController()},startExactForTest:(contextKey,payload)=>startExactEvaluation(contextKey,payload),warmCalls:()=>globalThis.__sidepanelWarmCalls||0,lastError:()=>globalThis.__lastSidepanelError,pollState:()=>({timer:Boolean(evaluationPollTimer),terminalTimer:Boolean(evaluationTerminalTimer),desiredEvaluationKey,lastEvaluationKey,lastEvaluationData}),lifecycleState:()=>({reportActive:Boolean(reportAbortController),reportPending:Boolean(reportPromise),reportKey})};`;
  let now=100000;class FakeDate extends Date{static now(){return now}}
  const prior={document:globalThis.document,chrome:globalThis.chrome,fetch:globalThis.fetch,MutationObserver:globalThis.MutationObserver,Date:globalThis.Date,requestAnimationFrame:globalThis.requestAnimationFrame,syncBoardScrollMetrics:globalThis.syncBoardScrollMetrics};
  Object.assign(globalThis,{document,chrome,fetch,MutationObserver:FakeMutationObserver,Date:FakeDate,requestAnimationFrame:()=>1,syncBoardScrollMetrics:()=>{}});
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Math.random()}`);
  const panel=globalThis.__sidepanelTest;
  const cleanup=()=>{panel?.cancelControlRefresh();panel?.resetDraftPresentation();for(const[key,value]of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value}delete globalThis.__sidepanelTest;delete globalThis.__sidepanelWarmCalls;delete globalThis.__lastSidepanelError};
  return{panel,elements,snapshots,calls,requests,enqueue,localValues,localWrites,stableEvaluation:()=>stableRefinedEvaluation,advance:ms=>{now+=ms},setHidden:value=>{document.hidden=value},setState:value=>{storedState=value},setDraftError:value=>{draftError=value},cleanup};
}

test("recommendation cards expose one authoritative title chance",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const data=refined().recommendations;
  const html=h.panel.recommendationCardsHtml(data,true,data[0].teamSimulation);
  assert.match(html,/14\.0%<\/strong><span class="odds-label">model title estimate/);
  assert.doesNotMatch(html,/15\.0%|If available and selected/);
  assert.equal((html.match(/model title estimate/g)||[]).length,1);
  assert.match(html,/At your pick<\/strong><span>25\.0% chance this player is available at your pick 3\./);
  assert.doesNotMatch(html,/If you wait|If you pass/);
  assert.match(html,/Floor \/ ceiling[\s\S]*150-point floor · 250-point ceiling/);
  assert.doesNotMatch(html,/Available at next pick/);
  assert.doesNotMatch(html,/What you give up|The lean is conditional on the selected decision lens/);
  assert.equal((html.match(/class="decision-point"/g)||[]).length,4);
});

test("live pick banner stays visible while its decision brief is calculating",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const prep=h.elements.get("draftPrep");prep.hidden=true;
  h.panel.showLiveDraftPosition({platform:"espn",draftId:"pick-one",draftRunId:"run-one",userSlot:1,currentPickNo:1,projectionSeason:2026,settings:{teams:12,rounds:16},picks:[]});
  assert.equal(prep.hidden,false);
  assert.equal(h.elements.get("prepTitle").textContent,"You are on the clock · Pick 1");
  assert.equal(h.elements.get("prepHelp").textContent,"Calculating your decision brief.");
});

test("a Sleeper-complete board with lagging final picks never starts a stale pick-174 simulation",async t=>{
  const h=await createHarness();t.after(h.cleanup);const teams=12,rounds=15;
  h.setState({platform:"sleeper",draftId:"1386011694605537280",draftRunId:"1386011694605537280:1784813448141",draftStatus:"complete",userSlot:6,projectionSeason:2026,settings:{teams,rounds,scoring:{reception:0}},picks:Array.from({length:173},(_,index)=>({pickNo:index+1,playerId:`taken-${index+1}`,slot:index%teams+1})),players:[{id:"WAS",name:"Washington Commanders",position:"DST",team:"WAS",platformProjection:100,projectionSeason:2026,adp:174,eligibleForRecommendation:true}]});
  await h.panel.uiRefresh(true);await tick();
  assert.equal(h.elements.get("prepTitle").textContent,"Syncing final draft picks");
  assert.equal(h.elements.get("status").textContent,"Draft finishing");
  assert.equal(h.elements.get("decisionAuthority").textContent,"Final roster report");
  assert.equal(h.elements.get("freshness").textContent,"Synced 173 of 180 picks");
  assert.match(h.elements.get("recommendations").innerHTML,/Final picks are syncing/);
  assert.doesNotMatch(h.elements.get("prepTitle").textContent,/on the clock|Pick 174/i);
  assert.notEqual(h.elements.get("decisionAuthority").textContent,"You make the pick");
  assert.equal(h.calls.filter(path=>["/v1/quick-evaluate","/v1/evaluate","/v1/draft-report"].includes(path)).length,0);
});

test("a completed draft replaces live-pick and pending-simulation hero copy",async t=>{
  const h=await createHarness();t.after(h.cleanup);const teams=4,rounds=1;
  const players=Array.from({length:teams},(_,index)=>({id:`p${index+1}`,name:`Player ${index+1}`,position:"RB",team:"BUF",platformProjection:200-index,projectionSeason:2026,adp:index+1,eligibleForRecommendation:true}));
  h.setState({platform:"sleeper",draftId:"complete-a",draftRunId:"run-complete-a",draftStatus:"complete",userSlot:1,currentPickNo:teams+1,projectionSeason:2026,settings:{teams,rounds,scoring:{reception:1}},picks:players.map((player,index)=>({pickNo:index+1,playerId:player.id,slot:index+1})),players});
  h.enqueue("/v1/draft-report",{url:"chrome-extension://test/report.html",report:{iterations:10000,teams,userTeam:{finishProbabilities:[.25],titleRank:1,points:123.4}}});
  await h.panel.uiRefresh(true);await tick();
  assert.equal(h.elements.get("status").textContent,"Draft complete",String(h.panel.lastError()?.stack||h.panel.lastError()||""));
  assert.equal(h.elements.get("decisionAuthority").textContent,"Final roster report");
  assert.equal(h.elements.get("decisionLean").textContent,"Draft complete");
  assert.equal(h.elements.get("decisionEvidence").textContent,"10,000 simulations complete");
  assert.equal(h.elements.get("sectionHeading").textContent,"Draft report ready");
  assert.equal(h.elements.get("freshness").textContent,"10,000 simulations");
  assert.doesNotMatch(h.elements.get("decisionEvidence").textContent,/pending/i);
});

test("only the option with the highest ceiling claims the strongest ceiling",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const lower=refined("lower").recommendations[0],higher=refined("higher").recommendations[0];
  Object.assign(lower.player,{mean:192.7,floor:155,ceiling:237});
  Object.assign(higher.player,{mean:190.8,floor:148,ceiling:241});
  const html=h.panel.recommendationCardsHtml([lower,higher],false,lower.teamSimulation);
  assert.equal((html.match(/strongest ceiling/g)||[]).length,1);
  assert.match(html,/strongest ceiling in this comparison at 241 points/);
  assert.match(html,/Adds RB value with a 193-point simulation projection/);
  assert.doesNotMatch(html,/strongest ceiling in this comparison at 237 points/);
  const bestFits=[...html.matchAll(/Best fit if<\/strong><span>(.*?)<\/span>/g)].map(match=>match[1]);
  assert.equal(bestFits.length,2);
  assert.equal(new Set(bestFits).size,2);
  assert.match(bestFits[0],/155–237-point range/);
  assert.match(bestFits[1],/148–241-point range/);
});

test("a final-pick card does not invent a later turn or 100% survival",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const rec=refined().recommendations[0];
  rec.availabilityTargetPick=null;
  rec.nextPickAvailability=1;
  const html=h.panel.recommendationCardsHtml([rec],false,rec.teamSimulation);
  assert.match(html,/This is your final pick; there is no later turn to wait for\./);
  assert.match(html,/Floor \/ ceiling[\s\S]*150-point floor · 250-point ceiling/);
  assert.doesNotMatch(html,/Available at next pick/);
  assert.doesNotMatch(html,/surviving to pick|pick —|likely available later|100\.0%/);
});

test("a back-to-back pick explains why waiting is certain",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const rec=refined().recommendations[0];
  Object.assign(rec,{nextUserPick:36,availabilityTargetPick:37,nextPickAvailability:1,waitingForUserPick:false});
  const html=h.panel.recommendationCardsHtml([rec],false,rec.teamSimulation);
  assert.match(html,/No opponent picks in between/);
  assert.match(html,/still be there at pick 37 if you pass/);
  assert.match(html,/Floor \/ ceiling[\s\S]*150-point floor · 250-point ceiling/);
  assert.doesNotMatch(html,/Available at next pick/);
  assert.doesNotMatch(html,/100\.0% chance/);
});

test("a low-confidence market estimate does not show a misleading percentage",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const rec=refined().recommendations[0];
  rec.availabilityConfidence="low";
  const html=h.panel.recommendationCardsHtml([rec],false,rec.teamSimulation);
  assert.match(html,/Floor \/ ceiling[\s\S]*150-point floor · 250-point ceiling/);
  assert.doesNotMatch(html,/Available at next pick/);
  assert.doesNotMatch(html,/25\.0% .* Pick 3/);
});

test("the final-pick callout does not render a null later pick",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const data=refined(),teams=4,rounds=4;
  data.recommendations[0].availabilityTargetPick=null;
  data.recommendations[0].nextUserPick=16;
  h.setState({platform:"espn",draftId:"draft-final",draftRunId:"run-final",userSlot:1,currentPickNo:16,projectionSeason:2026,settings:{teams,rounds,scoring:{reception:1}},picks:Array.from({length:15},(_,index)=>{const pickNo=index+1,round=Math.floor(index/teams)+1,within=index%teams+1;return{pickNo,playerId:`taken-${pickNo}`,slot:round%2?within:teams+1-within}}),players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]});
  h.enqueue("/v1/evaluate",data);await h.panel.uiRefresh(true);await tick();
  assert.equal(h.elements.get("prepTitle").textContent,"You are on the clock · Pick 16");
  assert.equal(h.elements.get("prepHelp").textContent,"This is your final pick. Compare the remaining tradeoffs now.");
  assert.doesNotMatch(h.elements.get("prepHelp").textContent,/null|undefined/);
});

test("ESPN pick 12 warms the persistent engine and reaches exact recommendations",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.setState({platform:"espn",draftId:"pick-12",draftRunId:"run-pick-12",draftStatus:"drafting",userSlot:12,currentPickNo:12,projectionSeason:2026,settings:{teams:12,rounds:16,scoring:{reception:1}},picks:Array.from({length:11},(_,index)=>({pickNo:index+1,playerId:`taken-${index+1}`,slot:index+1})),players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:12,eligibleForRecommendation:true}]});
  h.enqueue("/v1/evaluate",refined("p1"));
  await h.panel.uiRefresh(true);await tick();
  assert.ok(h.panel.warmCalls()<=2,"the exact completion refresh may reuse the already-warm engine once");
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1);
  assert.match(h.elements.get("freshness").textContent,/10,000 sims/);
  assert.doesNotMatch(h.elements.get("freshness").textContent,/Unable to finish simulations/);
  assert.equal(h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,1);
});

test("hero title chance matches the top displayed recommendation instead of a higher no-target baseline",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",recommendationBelowBaseline());
  await h.panel.uiRefresh(true);await tick();
  assert.equal(h.elements.get("chance").textContent,"9.2%");
  assert.match(h.elements.get("recommendations").innerHTML,/9\.2%<\/strong><span class="odds-label">model title estimate if selected/);
  assert.match(h.elements.get("range").textContent,/top displayed pick/);
});

test("real sidepanel transition stays useful while refining and upgrades to exact odds",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const exact=deferred();
  h.enqueue("/v1/evaluate",exact);
  await h.panel.uiRefresh(true);await tick();
  assert.deepEqual({status:h.elements.get("status").textContent,skeleton:Boolean(h.elements.get("recommendations").querySelector(".skeleton")),cards:h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,busy:h.elements.get("recommendations").hasAttribute("aria-busy")},{status:"Calculating · Sleeper",skeleton:false,cards:1,busy:false},String(h.panel.lastError()?.stack||h.panel.lastError()||""));
  assert.equal(h.elements.get("freshness").hidden,true,"the duplicate status pill must be hidden while the progress bar is active");
  assert.equal(h.elements.get("exactProgressWrap").hidden,false);
  assert.equal(h.snapshots.some(s=>s.cards&&/ready/i.test(s.freshness)),false,"non-final cards/status must never claim ready");
  exact.resolve(refined());
  await tick();await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1,"the context-bound exact job must not restart while it is running");
  assert.match(h.elements.get("freshness").textContent,/10,000 sims · ready/);
  assert.equal(h.elements.get("freshness").hidden,false);
  assert.equal(h.elements.get("exactProgressWrap").hidden,true,"the progress bar must leave the layout when the exact simulation completes");
  assert.equal(h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,1);
  assert.equal(h.elements.get("recommendations").hasAttribute("aria-busy"),false);
});

test("tracked evaluation polls its exact status while generic visibility is hidden",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",{...preliminary(),status:"refining",evaluationId:"eval-1",clientBuildId:"eval-jobs-v6-strict10k-20260714",startedAt:100000,deadlineAt:122000});
  h.enqueue("/v1/evaluate/eval-1",{...refined(),status:"complete",evaluationId:"eval-1",clientBuildId:"eval-jobs-v6-strict10k-20260714",startedAt:100000,deadlineAt:122000});
  await h.panel.uiRefresh(true);assert.equal(h.panel.pollState().timer,true,JSON.stringify(h.panel.pollState()));h.setHidden(true);await new Promise(resolve=>setTimeout(resolve,1100));await tick();
  assert.deepEqual(h.calls.filter(path=>path.startsWith("/v1/evaluate")),["/v1/evaluate","/v1/evaluate/eval-1"]);
  assert.match(h.elements.get("freshness").textContent,/10,000 sims · ready/)
});

test("a terminal exact poll renders through periodic 500ms refresh joins",async t=>{
  const h=await createHarness();t.after(h.cleanup);const stalePeriodic=deferred(),evaluationId="eval-periodic";
  h.enqueue("/v1/evaluate",{...preliminary(),status:"refining",evaluationId,clientBuildId:"eval-jobs-v6-strict10k-20260714",startedAt:100000,deadlineAt:122000});
  await h.panel.uiRefresh(true);h.advance(1001);
  h.enqueue(`/v1/evaluate/${evaluationId}`,stalePeriodic);
  h.enqueue(`/v1/evaluate/${evaluationId}`,{...refined("terminal"),evaluationId});
  const active=h.panel.uiRefresh(false),periodic=Array.from({length:8},()=>h.panel.uiRefresh(false));
  await new Promise(resolve=>setTimeout(resolve,1150));
  stalePeriodic.resolve({...preliminary("stale"),status:"refining",evaluationId,startedAt:100000,deadlineAt:122000});
  await new Promise(resolve=>setTimeout(resolve,600));
  await Promise.all([active,...periodic]);await tick();
  assert.match(h.elements.get("recommendations").innerHTML,/Player terminal/);
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/Player stale/);
  assert.match(h.elements.get("freshness").textContent,/10,000 sims/);
  assert.equal(h.panel.pollState().lastEvaluationData.status,"complete");
});

for(const [label,failure] of [["rate limits",{status:429,body:{error:"Rate limit exceeded"}}],["network failures",new Error("fetch failed")]])test(`tracked evaluation keeps running through ${label} past its former deadline`,async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",{...preliminary(),status:"refining",evaluationId:`eval-${label}`,clientBuildId:"eval-jobs-v6-strict10k-20260714",startedAt:75000,deadlineAt:97650});
  h.enqueue(`/v1/evaluate/eval-${label}`,failure);
  await h.panel.uiRefresh(true);
  assert.equal(h.panel.pollState().terminalTimer,false);
  h.setHidden(true);
  await new Promise(resolve=>setTimeout(resolve,900));await tick();
  const state=h.panel.pollState();
  assert.equal(state.lastEvaluationData.status,"refining");
  assert.notEqual(state.lastEvaluationData.refinementOutcome,"deadline_fallback");
  assert.equal(state.timer,true,"transient polling failures must not stop exact work");
  assert.equal(state.terminalTimer,false);
  assert.ok(h.calls.filter(path=>path.startsWith("/v1/evaluate")).length>=1);
  assert.notEqual(h.elements.get("freshness").textContent,"Exact simulations stopped");
  assert.equal(h.elements.get("exactOddsError").hidden,true);
  assert.equal(h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,1);
  assert.equal(h.elements.get("chance").textContent,"—");
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/full odds refining/)
});

test("an old running evaluation cannot overwrite a newer pick",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",{...preliminary("old"),status:"refining",evaluationId:"eval-old",clientBuildId:"eval-jobs-v6-strict10k-20260714",startedAt:75000,deadlineAt:97100});
  await h.panel.uiRefresh(true);
  const next={platform:"sleeper",draftId:"draft-a",draftRunId:"run-a",userSlot:1,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[{pickNo:1,playerId:"taken",slot:1}],players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]};
  h.setState(next);h.panel.resetDraftPresentation();h.enqueue("/v1/evaluate",{...refined("new"),status:"complete",evaluationId:"eval-new",clientBuildId:"eval-jobs-v6-strict10k-20260714"});
  await h.panel.uiRefresh(true);
  await new Promise(resolve=>setTimeout(resolve,250));await tick();
  assert.equal(h.panel.pollState().lastEvaluationData.evaluationId,"eval-new");
  assert.equal(h.panel.pollState().lastEvaluationData.status,"complete");
  assert.match(h.elements.get("recommendations").innerHTML,/Player new/);
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/deadline reached/)
});

test("preliminary recommendations render immediately and upgrade atomically to final odds",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",preliminary());
  await h.panel.uiRefresh(true);await tick();
  assert.equal(h.elements.get("status").textContent,"Calculating · Sleeper");
  assert.equal(h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,1);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
  assert.equal(h.elements.get("draftPrep").hidden,false);
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/14\.0%/);
  assert.equal(h.elements.get("chance").textContent,"—");
  assert.match(h.elements.get("range").textContent,/Title chance will appear after all 10,000 simulations finish/i);
  assert.match(h.elements.get("freshness").textContent,/10,000 exact simulations/);
  const preliminaryHtml=h.elements.get("recommendations").innerHTML;
  h.advance(1001);
  h.enqueue("/v1/evaluate",refined());
  await h.panel.uiRefresh(false);await tick();
  assert.notEqual(h.elements.get("recommendations").innerHTML,preliminaryHtml);
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/full odds refining/);
  assert.equal(h.elements.get("status").textContent,"Live · Sleeper");
  assert.equal(h.snapshots.some(snapshot=>snapshot.skeleton&&snapshot.cards),false,"cards and skeletons must never be mixed during refinement");
});

test("a raw platform clock update cannot turn a ready enriched decision brief back into calculating",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",refined("ready"));
  await h.panel.uiRefresh(true);await tick();await tick();
  assert.equal(h.elements.get("status").textContent,"Live · Sleeper");
  const rawClockState={platform:"sleeper",draftId:"draft-a",draftRunId:"run-a",userSlot:1,currentPickNo:1,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[],players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]};
  h.panel.showLiveDraftPosition(h.panel.livePresentationState(rawClockState));
  assert.equal(h.elements.get("status").textContent,"Live · Sleeper");
  assert.equal(h.elements.get("prepHelp").textContent,"Your decision brief is ready.");
  assert.doesNotMatch(h.elements.get("prepHelp").textContent,/calculating/i);
});

test("the full player board renders while exact title simulations are still pending",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/player-board",{candidates:[{player:{id:"p1",name:"Player p1",position:"RB",team:"BUF",mean:200,floor:150,ceiling:250,adp:10},sourceProjections:{fantasyPros:205,espn:198,sleeper:201,owned:203},decisionRank:1,simulationEligible:true,nextPickAvailability:.25,availabilityTargetPick:3,availabilityConfidence:"market"}]});
  h.enqueue("/v1/evaluate",preliminary());
  await h.panel.uiRefresh(true);await tick();await tick();
  assert.match(h.elements.get("boardRows").innerHTML,/Player p1/);
  assert.match(h.elements.get("boardRows").innerHTML,/Sleeper: 201\.0/);
  assert.match(h.elements.get("boardRows").innerHTML,/Draft Goblin: 203\.0/);
  assert.doesNotMatch(h.elements.get("boardRows").innerHTML,/FP:|ESPN:/);
  assert.match(h.elements.get("boardRows").innerHTML,/Title odds: calculating/);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
  assert.equal(h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,1);
  assert.equal(h.elements.get("chance").textContent,"—")
});

test("projectionless catalog rows are labeled unavailable instead of displaying a synthetic range",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/player-board",{candidates:[{player:{id:"stale",name:"Stale Catalog Player",position:"QB",team:"PIT",mean:0,floor:0,ceiling:52.94,adp:null},sourceProjections:{},decisionRank:null,simulationEligible:false,exclusionReason:"Projection data is not available for this player yet.",availabilityConfidence:"low"}]});
  h.enqueue("/v1/evaluate",preliminary());
  await h.panel.uiRefresh(true);await tick();await tick();
  const board=h.elements.get("boardRows").innerHTML;
  assert.match(board,/Simulation: Unavailable/);
  assert.match(board,/Range unavailable/);
  assert.match(board,/Projection data is not available for this player yet/);
  assert.doesNotMatch(board,/Simulation: 0\.0|0\.0–52\.9/)
});

test("draft-site sort falls back to the model when a visible site projection is unavailable",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const boardSort=new FakeElement("boardSort");boardSort.value="platform";h.elements.set("boardSort",boardSort);
  h.enqueue("/v1/player-board",{candidates:[
    {player:{id:"rb",name:"Running Back",position:"RB",team:"ATL",mean:250,floor:190,ceiling:310,adp:2},sourceProjections:{sleeper:250},decisionRank:1,simulationEligible:true},
    {player:{id:"qb-one",name:"Quarterback One",position:"QB",team:"NE",mean:312,floor:260,ceiling:370,adp:50},sourceProjections:{sleeper:312},decisionRank:2,simulationEligible:true},
    {player:{id:"qb-two",name:"Quarterback Two",position:"QB",team:"BUF",mean:275,floor:215,ceiling:330,adp:60},sourceProjections:{},decisionRank:3,simulationEligible:true}
  ]});
  h.enqueue("/v1/evaluate",preliminary());
  await h.panel.uiRefresh(true);await tick();await tick();
  const board=h.elements.get("boardRows").innerHTML;
  assert.ok(board.indexOf("Quarterback One")<board.indexOf("Quarterback Two"));
  assert.ok(board.indexOf("Quarterback Two")<board.indexOf("Running Back"));
});

test("Sleeper ADP and next-pick availability sorts run lowest to highest",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const boardSort=new FakeElement("boardSort");boardSort.value="adp";h.elements.set("boardSort",boardSort);
  h.enqueue("/v1/player-board",{candidates:[
    {player:{id:"late",name:"Late ADP",position:"WR",team:"BUF",mean:180,floor:130,ceiling:230,adp:42},nextPickAvailability:.8,availabilityTargetPick:9,availabilityConfidence:"market"},
    {player:{id:"early",name:"Early ADP",position:"RB",team:"ATL",mean:220,floor:170,ceiling:270,adp:3},nextPickAvailability:.2,availabilityTargetPick:9,availabilityConfidence:"market"},
    {player:{id:"middle",name:"Middle ADP",position:"TE",team:"KC",mean:190,floor:145,ceiling:235,adp:18},nextPickAvailability:.5,availabilityTargetPick:9,availabilityConfidence:"market"},
    // The engine deliberately uses a neutral .5 placeholder when no market rank
    // exists. The UI must use confidence, rather than sorting that placeholder
    // as if it were a real 50% availability estimate.
    {player:{id:"unknown",name:"Unknown Market",position:"QB",team:"NE",mean:200,floor:150,ceiling:250,adp:null},nextPickAvailability:.5,availabilityTargetPick:9,availabilityConfidence:"low"}
  ]});
  h.enqueue("/v1/evaluate",preliminary());
  await h.panel.uiRefresh(true);await tick();await tick();
  let board=h.elements.get("boardRows").innerHTML;
  assert.ok(board.indexOf("Early ADP")<board.indexOf("Middle ADP"));
  assert.ok(board.indexOf("Middle ADP")<board.indexOf("Late ADP"));
  assert.ok(board.indexOf("Late ADP")<board.indexOf("Unknown Market"));

  boardSort.value="availability";h.panel.renderPlayerBoard();
  board=h.elements.get("boardRows").innerHTML;
  assert.ok(board.indexOf("Early ADP")<board.indexOf("Middle ADP"));
  assert.ok(board.indexOf("Middle ADP")<board.indexOf("Late ADP"));
  assert.ok(board.indexOf("Late ADP")<board.indexOf("Unknown Market"));
});

test("every player-board sort has deterministic direction, fallback, missing-value, and tie behavior",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const row=(id,name,{decisionRank,mean,floor,ceiling,sleeper,owned,adp,availability,availabilityConfidence="market"}={})=>({player:{id,name,position:"RB",team:"BUF",mean,floor,ceiling,adp},sourceProjections:{sleeper,owned},decisionRank,nextPickAvailability:availability,availabilityConfidence});
  const rows=[
    row("alpha","Alpha",{decisionRank:2,mean:200,floor:150,ceiling:260,sleeper:210,owned:205,adp:20,availability:.6}),
    row("bravo","Bravo",{decisionRank:1,mean:180,floor:160,ceiling:240,sleeper:null,owned:190,adp:10,availability:.3}),
    row("charlie","Charlie",{decisionRank:3,mean:220,floor:140,ceiling:300,sleeper:200,owned:230,adp:30,availability:.9}),
    row("missing","Missing")
  ];
  h.enqueue("/v1/evaluate",preliminary());await h.panel.uiRefresh(true);await tick();
  const order=key=>h.panel.sortBoardRows(rows,key).map(item=>item.player.id);
  assert.deepEqual(order("decisionRank"),["bravo","alpha","charlie","missing"]);
  assert.deepEqual(order("mean"),["charlie","alpha","bravo","missing"]);
  assert.deepEqual(order("floor"),["bravo","alpha","charlie","missing"]);
  assert.deepEqual(order("ceiling"),["charlie","alpha","bravo","missing"]);
  assert.deepEqual(order("platform"),["alpha","charlie","bravo","missing"],"missing Sleeper projections use the simulation projection");
  assert.deepEqual(order("owned"),["charlie","alpha","bravo","missing"]);
  assert.deepEqual(order("adp"),["bravo","alpha","charlie","missing"]);
  assert.deepEqual(order("availability"),["bravo","alpha","charlie","missing"]);
  const unrankedSpecialists=[
    row("kessman","Alex Kessman",{mean:0}),
    row("szmyt","Andre Szmyt",{mean:83}),
    row("borregales","Andy Borregales",{mean:97.4}),
    row("potter","B.T. Potter",{mean:106.6}),
    row("sauls","Ben Sauls",{mean:47.3})
  ];
  assert.deepEqual(h.panel.sortBoardRows(unrankedSpecialists,"decisionRank").map(item=>item.player.id),["potter","borregales","szmyt","sauls","kessman"],"unranked specialists use simulation value instead of becoming alphabetical");
  const neutralUnknown=row("neutral","Neutral placeholder",{availability:.5,availabilityConfidence:"low"});
  assert.deepEqual(h.panel.sortBoardRows([rows[0],rows[1],rows[2],neutralUnknown],"availability").map(item=>item.player.id),["bravo","alpha","charlie","neutral"],"low-confidence neutral placeholders sort after every real availability estimate");
  const tied=[row("z","Same",{mean:200}),row("a","Same",{mean:200})];
  assert.deepEqual(h.panel.sortBoardRows(tied,"mean").map(item=>item.player.id),["a","z"],"equal display names use player id as the stable final tiebreak");
});

test("player-board position filtering and drafted-player removal repaint immediately",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const candidates=[
    {player:{id:"qb",name:"Quarterback",position:"QB",team:"BUF",mean:300,floor:240,ceiling:360,adp:20},decisionRank:1},
    {player:{id:"rb",platformPlayerId:"site-rb",name:"Running Back",position:"RB",team:"ATL",mean:220,floor:170,ceiling:280,adp:10},decisionRank:2},
    {player:{id:"wr",name:"Wide Receiver",position:"WR",team:"NYJ",mean:210,floor:155,ceiling:275,adp:15},decisionRank:3}
  ];
  h.enqueue("/v1/player-board",{candidates});h.enqueue("/v1/evaluate",preliminary());
  await h.panel.uiRefresh(true);await tick();await tick();
  const filter=h.elements.get("boardPosition"),all=filter.querySelector('[value="ALL"]'),rb=filter.querySelectorAll('input:not([value="ALL"])').find(input=>input.value==="RB");
  all.checked=false;rb.checked=true;h.panel.renderPlayerBoard();
  assert.match(h.elements.get("boardRows").innerHTML,/Running Back/);
  assert.doesNotMatch(h.elements.get("boardRows").innerHTML,/Quarterback|Wide Receiver/);
  assert.equal(h.elements.get("boardCount").textContent,"1 player");
  h.panel.syncPlayerBoardWithDraftState({platform:"sleeper",picks:[{pickNo:1,playerId:"site-rb",slot:2}],players:candidates.map(item=>item.player)});
  assert.doesNotMatch(h.elements.get("boardRows").innerHTML,/Running Back/);
  assert.match(h.elements.get("boardRows").innerHTML,/No undrafted players match these filters/);
  assert.equal(h.elements.get("boardCount").textContent,"0 players");
});

test("player-board search is trimmed, case-insensitive, team-aware, composable, and reversible",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const candidates=[
    {player:{id:"cook",name:"James Cook",position:"RB",team:"BUF",mean:229,floor:172,ceiling:300,adp:17},decisionRank:1},
    {player:{id:"coleman",name:"Keon Coleman",position:"WR",team:"BUF",mean:181,floor:122,ceiling:251,adp:77},decisionRank:2},
    {player:{id:"jeanty",name:"Ashton Jeanty",position:"RB",team:"LV",mean:210,floor:158,ceiling:274,adp:12},decisionRank:3}
  ];
  h.enqueue("/v1/player-board",{candidates});h.enqueue("/v1/evaluate",preliminary());
  await h.panel.uiRefresh(true);await tick();await tick();
  const search=h.elements.get("boardSearch"),filter=h.elements.get("boardPosition"),all=filter.querySelector('[value="ALL"]'),rb=filter.querySelectorAll('input:not([value="ALL"])').find(input=>input.value==="RB");

  search.value="  jAmEs CoOk  ";h.panel.renderPlayerBoard();
  assert.match(h.elements.get("boardRows").innerHTML,/James Cook/);
  assert.doesNotMatch(h.elements.get("boardRows").innerHTML,/Keon Coleman|Ashton Jeanty/);
  assert.equal(h.elements.get("boardCount").textContent,"1 player");

  search.value="buf";h.panel.renderPlayerBoard();
  assert.match(h.elements.get("boardRows").innerHTML,/James Cook/);
  assert.match(h.elements.get("boardRows").innerHTML,/Keon Coleman/);
  assert.doesNotMatch(h.elements.get("boardRows").innerHTML,/Ashton Jeanty/);
  assert.equal(h.elements.get("boardCount").textContent,"2 players");

  all.checked=false;rb.checked=true;h.panel.renderPlayerBoard();
  assert.match(h.elements.get("boardRows").innerHTML,/James Cook/);
  assert.doesNotMatch(h.elements.get("boardRows").innerHTML,/Keon Coleman/);
  search.value="not a player";h.panel.renderPlayerBoard();
  assert.match(h.elements.get("boardRows").innerHTML,/No undrafted players match these filters/);
  assert.equal(h.elements.get("boardCount").textContent,"0 players");

  search.value="";all.checked=true;rb.checked=false;h.panel.renderPlayerBoard();
  assert.match(h.elements.get("boardRows").innerHTML,/James Cook/);
  assert.match(h.elements.get("boardRows").innerHTML,/Keon Coleman/);
  assert.match(h.elements.get("boardRows").innerHTML,/Ashton Jeanty/);
  assert.equal(h.elements.get("boardCount").textContent,"3 players");
});

test("a changed decision context clears stale player-board simulation annotations without clearing rows",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/player-board",{candidates:[{player:{id:"p1",name:"Player p1",position:"RB",team:"BUF",mean:200,floor:150,ceiling:250,adp:10},decisionRank:1}]});
  h.enqueue("/v1/evaluate",refined());await h.panel.uiRefresh(true);await tick();await tick();
  assert.match(h.elements.get("boardRows").innerHTML,/Simulated eight/);
  assert.match(h.elements.get("boardRows").innerHTML,/Title odds: 14\.0%/);
  h.elements.get("strategy").value="safe";h.panel.renderPlayerBoard();
  assert.match(h.elements.get("boardRows").innerHTML,/Player p1/);
  assert.doesNotMatch(h.elements.get("boardRows").innerHTML,/Simulated eight|Title odds: 14\.0%|Title odds: calculating/);
  assert.match(h.elements.get("boardRows").innerHTML,/Title odds: N\/A/);
});

test("eligible players outside the simulated shortlist show title odds as N/A",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/player-board",{candidates:[{player:{id:"p2",name:"Player p2",position:"WR",team:"NYJ",mean:190,floor:140,ceiling:240,adp:20},sourceProjections:{sleeper:191,owned:192},decisionRank:9,simulationEligible:true,nextPickAvailability:.75,availabilityTargetPick:3,availabilityConfidence:"market"}]});
  h.enqueue("/v1/evaluate",preliminary());
  await h.panel.uiRefresh(true);await tick();await tick();
  assert.match(h.elements.get("boardRows").innerHTML,/Player p2/);
  assert.match(h.elements.get("boardRows").innerHTML,/Title odds: N\/A/);
  assert.doesNotMatch(h.elements.get("boardRows").innerHTML,/Title odds: calculating/)
});

test("permanent exact failure keeps the shortlist, withholds odds, and stops automatic retries",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",new Error("Exact title odds could not finish shard 2 after 3 attempts."));
  await h.panel.uiRefresh(true);await tick();await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1);
  assert.equal(h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,1);
  assert.equal(h.elements.get("chance").textContent,"—");
  assert.equal(h.elements.get("freshness").textContent,"Exact simulations stopped");
  assert.equal(h.elements.get("exactOddsError").hidden,false);
  assert.match(h.elements.get("exactOddsErrorText").textContent,/shard 2 after 3 attempts/);
  const refreshSnapshots=h.snapshots.length;
  await h.panel.uiRefresh(false);await tick();
  await h.panel.uiRefresh(true,{invalidate:true});await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1,"the panel must wait for an explicit retry");
  assert.equal(h.snapshots.slice(refreshSnapshots).some(snapshot=>snapshot.status==="Calculating decision context"),false,"background refreshes must not flicker a terminal exact-odds failure back to calculating");
  assert.equal(h.snapshots.slice(refreshSnapshots).some(snapshot=>snapshot.prepHidden),false,"background refreshes must keep the same-context live-pick presentation mounted");
  assert.equal(h.snapshots.slice(refreshSnapshots).some(snapshot=>snapshot.sectionHeading==="Comparing your options"),false,"background refreshes must not reset the mounted section heading");
});

test("a terminal exact failure immediately scrubs previously rendered title odds",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/player-board",{candidates:[{player:{id:"p1",name:"Player p1",position:"RB",team:"BUF",mean:200,floor:150,ceiling:250,adp:10},sourceProjections:{sleeper:200,owned:201},decisionRank:1,simulationEligible:true,nextPickAvailability:.25,availabilityTargetPick:3,availabilityConfidence:"market"}]});
  h.enqueue("/v1/evaluate",refined());
  await h.panel.uiRefresh(true);await tick();await tick();
  assert.equal(h.elements.get("chance").textContent,"14.0%");
  assert.match(h.elements.get("recommendations").innerHTML,/14\.0%/);
  assert.match(h.elements.get("boardRows").innerHTML,/Title odds: 14\.0%/);

  h.panel.showExactOddsFailure(new Error("The complete 10,000-simulation result exceeded the 25-second limit."),h.panel.currentContext());
  assert.equal(h.elements.get("chance").textContent,"—");
  assert.equal(h.elements.get("freshness").textContent,"Exact simulations stopped");
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/14\.0%|model title estimate|baseline simulated completion/);
  assert.match(h.elements.get("range").textContent,/Exact title odds are unavailable/);
  assert.match(h.elements.get("boardRows").innerHTML,/Title odds: unavailable/);
  assert.doesNotMatch(h.elements.get("boardRows").innerHTML,/Title odds: 14\.0%|Title odds: calculating/);
});

test("an exact failure does not flicker through the generic shortlist retry status",async t=>{
  const h=await createHarness();t.after(h.cleanup);const exact=deferred();
  h.enqueue("/v1/evaluate",exact);
  await h.panel.uiRefresh(true);await tick();
  assert.equal(h.elements.get("status").textContent,"Calculating · Sleeper");

  h.panel.showEvaluationFailure(new Error("The local recommendation service is unavailable."));
  assert.equal(h.elements.get("status").textContent,"Calculating · Sleeper");
  assert.notEqual(h.elements.get("freshness").textContent,"Last shortlist · retrying");

  exact.reject(new Error("Exact title odds could not finish shard 2 after 3 attempts."));
  await tick();await tick();
  assert.equal(h.elements.get("freshness").textContent,"Exact simulations stopped");
});

test("a bounded fallback becomes a stable exact-odds failure",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",{...preliminary(),simulationStatus:"refined",iterations:32,refinementOutcome:"deadline_fallback"});
  await h.panel.uiRefresh(true);await tick();
  assert.equal(h.elements.get("chance").textContent,"—");
  assert.equal(h.elements.get("freshness").textContent,"Exact simulations stopped");
  assert.equal(h.elements.get("exactOddsError").hidden,false);
});

test("a refreshed panel restores the last refined estimate for the same pick window",async t=>{
  const first=await createHarness();let h;t.after(()=>{first.cleanup();h?.cleanup()});
  first.enqueue("/v1/evaluate",refined());await first.panel.uiRefresh(true);await tick();await tick();
  const persistedStableEvaluation=first.stableEvaluation();
  assert.ok(persistedStableEvaluation?.contextKey,"the first exact run must persist its complete input context");
  first.cleanup();
  h=await createHarness({persistedStableEvaluation});
  await h.panel.uiRefresh(true);await tick();
  assert.equal(h.elements.get("chance").textContent,"14.0%");
  assert.match(h.elements.get("range").textContent,/10,000 simulations/);
  assert.equal(h.elements.get("freshness").textContent,"10,000 sims · restored · original run 1.8 s");
  assert.match(h.elements.get("freshness").title,/Restored the exact result for this unchanged draft and control context/);
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,0,"refresh must not replace refined odds with a quick estimate");
});

test("a fresh exact result reports its live runtime rather than restored provenance",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",refined());
  await h.panel.uiRefresh(true);await tick();await tick();
  assert.equal(h.elements.get("freshness").textContent,"10,000 sims · ready in 1.8 s");
  assert.doesNotMatch(h.elements.get("freshness").textContent,/restored|original run/);
});

test("ESPN projection settling after an exact result does not start a second 10k run in the same pick window",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const espnState={platform:"espn",draftId:"espn-settling",draftRunId:"run-espn-settling",draftStatus:"drafting",userSlot:1,currentPickNo:1,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[],players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]};
  h.setState(espnState);h.enqueue("/v1/evaluate",refined("frozen-espn"));
  await h.panel.uiRefresh(true);await tick();await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1);

  h.setState({...espnState,players:[{...espnState.players[0],platformProjection:215}]});
  await h.panel.uiRefresh(false);await tick();await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1,"the completed pick-window snapshot must remain authoritative until the draft advances");
  assert.match(h.elements.get("recommendations").innerHTML,/Player frozen-espn/);
  assert.match(h.elements.get("freshness").textContent,/10,000 sims/);
});

test("a same-pick projection change invalidates restored exact odds",async t=>{
  const first=await createHarness();let second;t.after(()=>{first.cleanup();second?.cleanup()});
  first.enqueue("/v1/evaluate",refined("old-projection"));await first.panel.uiRefresh(true);await tick();await tick();
  const persistedStableEvaluation=first.stableEvaluation();first.cleanup();
  second=await createHarness({persistedStableEvaluation});
  second.setState({platform:"sleeper",draftId:"draft-a",draftRunId:"run-a",userSlot:1,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[],players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:215,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]});
  second.enqueue("/v1/evaluate",refined("new-projection"));await second.panel.uiRefresh(true);await tick();await tick();
  assert.equal(second.calls.filter(path=>path==="/v1/evaluate").length,1);
  assert.match(second.elements.get("recommendations").innerHTML,/Player new-projection/);
  assert.doesNotMatch(second.elements.get("freshness").textContent,/restored/);
});

test("every strategy and ADP profile displays the same preset blend used by the engine",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const strategies={
    balanced:{projection:.52,ceiling:.10,floor:.08,scarcity:.09,need:.15,availability:.04,history:0,risk:-.03},
    titleOnly:{projection:.32,ceiling:.32,floor:0,scarcity:.08,need:.14,availability:.02,history:0,risk:.12},
    upside:{projection:.38,ceiling:.28,floor:.02,scarcity:.08,need:.12,availability:.06,history:0,risk:.05},
    safe:{projection:.28,ceiling:.06,floor:.29,scarcity:.15,need:.15,availability:.06,history:0,risk:-.08},
    projection:{projection:.59,ceiling:.10,floor:.10,scarcity:.08,need:.08,availability:.04,history:0,risk:-.02}
  },profiles={
    projectionLed:{projection:.55,ceiling:.10,floor:.08,scarcity:.08,need:.14,availability:.04,history:0,risk:-.03},
    ownedModel:{projection:.62,ceiling:.09,floor:.08,scarcity:.07,need:.11,availability:.02,history:0,risk:-.02},
    marketLed:{projection:.43,ceiling:.07,floor:.06,scarcity:.07,need:.10,availability:.24,history:0,risk:-.02}
  };
  for(const[strategyName,strategyWeights]of Object.entries(strategies))for(const[profileName,profileWeights]of Object.entries(profiles)){
    h.elements.get("strategy").value=strategyName;h.elements.get("sourceProfile").value=profileName;
    const actual=h.panel.activePresetWeights();
    for(const key of Object.keys(strategyWeights))assert.ok(Math.abs(actual[key]-(strategyWeights[key]*.65+profileWeights[key]*.35))<1e-12,`${strategyName}/${profileName}/${key}`);
  }
});

test("strategy, projection, ADP, and custom weights restore while position filters reset",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.panel.applyStoredControls({strategy:"custom",projectionDriver:"platform",sourceProfile:"marketLed",customWeights:{projection:.47,ceiling:.21,risk:-.17},positionFilter:["QB","TE"]});
  assert.equal(h.elements.get("strategy").value,"custom");
  assert.equal(h.elements.get("projectionDriver").value,"platform");
  assert.equal(h.elements.get("sourceProfile").value,"marketLed");
  assert.equal(h.panel.customWeights().projection,.47);
  assert.equal(h.panel.customWeights().ceiling,.21);
  assert.equal(h.panel.customWeights().risk,-.17);
  assert.equal(h.panel.selectedPositions(),undefined,"a stale position filter must not constrain a later decision brief");

  h.elements.get("strategy").value="custom";
  h.elements.get("strategy").listeners.get("change")();
  await tick();
  assert.equal(h.localValues.strategy,"custom");
  assert.deepEqual(h.localValues.customWeights,h.panel.customWeights(),"selecting Custom must persist the weights currently shown, not an older custom preset");
  h.panel.applyStoredControls(h.localValues);
  assert.deepEqual(h.panel.customWeights(),h.localValues.customWeights);
});

test("all strategy presets and custom weights reach the exact evaluation payload",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  for(const strategyName of["titleOnly","balanced","upside","safe","projection","custom"]){
    h.panel.resetDraftPresentation();
    h.elements.get("strategy").value=strategyName;
    if(strategyName==="custom")h.elements.get("weights").querySelector("[data-weight]").value="47";
    h.enqueue("/v1/evaluate",refined(strategyName));
    await h.panel.uiRefresh(true);await tick();await tick();
    const body=[...h.requests].reverse().find(request=>request.path==="/v1/evaluate")?.body;
    assert.equal(body?.strategy,strategyName);
    assert.equal(body?.sourceProfile,h.elements.get("sourceProfile").value);
    if(strategyName==="custom")assert.equal(body.customWeights.projection,.47);
    else assert.equal(body.customWeights,undefined);
  }
});

test("switching the simulation projection source changes the evaluated points and title estimate",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const feed={available:true,players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",points:260,season:2026}]};
  const ownedResult=refined("owned"),siteResult=refined("site");
  ownedResult.recommendations[0].simulation.championshipProbability=.18;ownedResult.recommendations[0].teamSimulation.championshipProbability=.18;
  siteResult.recommendations[0].simulation.championshipProbability=.11;siteResult.recommendations[0].teamSimulation.championshipProbability=.11;
  for(let index=0;index<4;index++)h.enqueue("/v1/projections/draftgoblin",feed);h.enqueue("/v1/evaluate",ownedResult);
  await h.panel.uiRefresh(true);for(let index=0;index<6;index++)await tick();await h.panel.uiRefresh(false);
  let request=h.requests.find(({path})=>path==="/v1/evaluate");
  assert.equal(request.body.state.players[0].mean,260);
  assert.equal(request.body.state.players[0].projectionConsensus.selectedDriver,"draftGoblin");
  assert.equal(h.elements.get("chance").textContent,"18.0%");

  for(let index=0;index<4;index++)h.enqueue("/v1/projections/draftgoblin",feed);h.enqueue("/v1/evaluate",siteResult);
  h.elements.get("projectionDriver").value="platform";h.elements.get("projectionDriver").listeners.get("change")();
  await new Promise(resolve=>setTimeout(resolve,80));for(let index=0;index<6;index++)await tick();await h.panel.uiRefresh(false);
  request=[...h.requests].reverse().find(({path})=>path==="/v1/evaluate");
  assert.equal(request.body.state.players[0].mean,200);
  assert.equal(request.body.state.players[0].projectionConsensus.selectedDriver,"platform");
  assert.equal(h.elements.get("chance").textContent,"11.0%");
  assert.match(h.elements.get("recommendations").innerHTML,/Player site/);
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/Player owned/);
});

test("a rapid control storm evaluates only the final settings and cannot repaint a stale result",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const stale=deferred(),latest=deferred();h.enqueue("/v1/evaluate",stale);
  await h.panel.uiRefresh(true);await tick();
  assert.match(h.elements.get("recommendations").innerHTML,/Player p1/);
  const before=h.snapshots.length,strategy=h.elements.get("strategy"),profile=h.elements.get("sourceProfile"),driver=h.elements.get("projectionDriver"),weight=h.elements.get("weights").querySelectorAll("[data-weight]").find(input=>input.dataset.weight==="projection");

  strategy.value="safe";strategy.listeners.get("change")();
  profile.value="marketLed";profile.listeners.get("change")();
  driver.value="platform";driver.listeners.get("change")();
  weight.value="47";h.elements.get("weights").listeners.get("input")({target:weight});
  profile.value="ownedModel";profile.listeners.get("change")();
  h.enqueue("/v1/evaluate",latest);
  await new Promise(resolve=>setTimeout(resolve,80));await tick();

  const finalRequest=[...h.requests].reverse().find(({path})=>path==="/v1/evaluate");
  assert.equal(finalRequest.body.strategy,"custom");
  assert.equal(finalRequest.body.sourceProfile,"ownedModel");
  assert.equal(finalRequest.body.customWeights.projection,.47);
  assert.equal(finalRequest.body.state.players[0].projectionConsensus.selectedDriver,"platform");
  assert.equal(h.localValues.strategy,"custom");
  assert.equal(h.localValues.sourceProfile,"ownedModel");
  assert.equal(h.localValues.projectionDriver,"platform");
  assert.equal(h.snapshots.slice(before).some(snapshot=>snapshot.skeleton&&snapshot.cards),false);

  latest.resolve(refined("latest-controls"));await tick();await tick();
  assert.match(h.elements.get("recommendations").innerHTML,/Player latest-controls/);
  stale.resolve(refined("stale-controls"));await tick();await tick();
  assert.match(h.elements.get("recommendations").innerHTML,/Player latest-controls/);
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/Player stale-controls/);
});

test("a replacement exact run waits for obsolete slider work to settle",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",refined("initial-controls"));
  await h.panel.uiRefresh(true);await tick();await tick();
  const payload=structuredClone(h.requests.find(request=>request.path==="/v1/evaluate").body),strategy=h.elements.get("strategy"),weight=h.elements.get("weights").querySelectorAll("[data-weight]").find(input=>input.dataset.weight==="projection");
  strategy.value="custom";weight.value="47";payload.strategy="custom";payload.customWeights={...h.panel.customWeights(),projection:.47};
  const settling=deferred();
  h.enqueue("/v1/evaluate",refined("settled-controls"));
  const replacement=h.panel.replaceExactWhileSettlingForTest(settling.promise,payload);
  await tick();await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1,"replacement must not overlap broker cancellation and worker teardown");
  settling.resolve();
  await replacement;await tick();await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,2);
  assert.match(h.elements.get("recommendations").innerHTML,/Player settled-controls/);
});

test("restoring slider context A never rejoins its already-aborted exact run",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",refined("initial-a"));
  await h.panel.uiRefresh(true);await tick();await tick();
  const payloadA=structuredClone(h.requests.find(request=>request.path==="/v1/evaluate").body),strategy=h.elements.get("strategy"),weight=h.elements.get("weights").querySelectorAll("[data-weight]").find(input=>input.dataset.weight==="projection"),contextA=h.panel.currentContext(),settlingA=deferred();
  h.panel.seedExactForTest(settlingA.promise,contextA);

  strategy.value="custom";weight.value="47";
  const contextB=h.panel.currentContext(),payloadB={...structuredClone(payloadA),strategy:"custom",customWeights:{...h.panel.customWeights(),projection:.47},seed:8001};
  const queuedB=h.panel.startExactForTest(contextB,payloadB);
  strategy.value="titleOnly";weight.value="34";
  assert.equal(h.panel.currentContext(),contextA);
  const restoredA=h.panel.startExactForTest(contextA,{...payloadA,seed:8002});
  await tick();await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1,"neither replacement may overlap the superseded A run");

  h.enqueue("/v1/evaluate",refined("restored-a"));
  settlingA.resolve();
  await Promise.all([queuedB,restoredA]);await tick();await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,2,"only the final restored A context should start");
  assert.match(h.elements.get("recommendations").innerHTML,/Player restored-a/);
});

test("strategy and ADP-profile refreshes retain useful cards without a skeleton flicker",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",refined("old"));await h.panel.uiRefresh(true);await tick();await tick();
  const before=h.snapshots.length,pendingExact=deferred();h.enqueue("/v1/evaluate",pendingExact);
  h.elements.get("sourceProfile").value="marketLed";
  h.elements.get("sourceProfile").listeners.get("change")();
  assert.match(h.elements.get("recommendations").innerHTML,/Player old/);
  assert.equal(h.elements.get("status").textContent,"Updating decision context");
  await new Promise(resolve=>setTimeout(resolve,80));await tick();
  assert.equal(h.snapshots.slice(before).some(snapshot=>snapshot.skeleton),false);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
  pendingExact.resolve(refined("updated"));await tick();await tick();
  assert.match(h.elements.get("recommendations").innerHTML,/Player updated/);
});

test("position filters constrain both quick and exact recommendation evaluations",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const root=h.elements.get("positionFilter"),positions=root.querySelectorAll('input:not([value="ALL"])');
  root.querySelector('[value="ALL"]').checked=false;
  for(const input of positions)input.checked=["QB","WR"].includes(input.value);
  const quick=preliminary("wr"),exact=refined("wr");quick.recommendations[0].player.position="WR";exact.recommendations[0].player.position="WR";
  h.enqueue("/v1/quick-evaluate",quick);h.enqueue("/v1/evaluate",exact);
  await h.panel.uiRefresh(true);await tick();await tick();
  for(const request of h.requests.filter(({path})=>["/v1/quick-evaluate","/v1/evaluate"].includes(path)))assert.deepEqual(request.body.positions,["QB","WR"]);
  assert.match(h.elements.get("recommendations").innerHTML,/Player wr/,String(h.panel.lastError()?.stack||h.panel.lastError()||""));
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/Player p1/);
  assert.match(h.elements.get("decisionLean").textContent,/^QB\/WR-only lean:/);
  assert.match(h.elements.get("decisionEvidence").textContent,/^Position-filtered/);
});

test("changing positions immediately drops the old cards and requests a fresh eight-player shortlist",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",refined("old-rb"));await h.panel.uiRefresh(true);await tick();await tick();
  assert.match(h.elements.get("recommendations").innerHTML,/Player old-rb/);

  const root=h.elements.get("positionFilter"),specific=root.querySelectorAll('input:not([value="ALL"])'),wr=specific.find(input=>input.value==="WR");
  root.querySelector('[value="ALL"]').checked=false;wr.checked=true;
  const fresh=refined("wr-1");fresh.recommendations=Array.from({length:8},(_,index)=>{const rec=structuredClone(fresh.recommendations[0]);rec.player.id=`wr-${index+1}`;rec.player.name=`Player wr-${index+1}`;rec.player.position="WR";return rec});
  h.enqueue("/v1/quick-evaluate",{...fresh,status:"refining",simulationStatus:"refining",iterations:300,targetIterations:10000});h.enqueue("/v1/evaluate",fresh);
  root.listeners.get("change")({target:wr});
  assert.equal(h.localValues.positionFilter,undefined,"position filters are temporary and must not leak into another draft");
  assert.ok(h.elements.get("recommendations").querySelector(".skeleton"));
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/Player old-rb/);
  await new Promise(resolve=>setTimeout(resolve,20));await tick();
  const filteredRequests=h.requests.filter(({path,body})=>["/v1/quick-evaluate","/v1/evaluate"].includes(path)&&body?.positions?.includes("WR"));
  assert.equal(filteredRequests.length,2);
  assert.ok(filteredRequests.every(({body})=>body.limit===8));
  assert.equal(h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,8);
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/old-rb|Â· RB/);
});

test("preliminary cards respect drafted-player and position filters",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const data=preliminary("taken"),other=refined("wr").recommendations[0];other.player.position="WR";data.recommendations.push(other);
  h.setState({platform:"sleeper",draftId:"draft-a",draftRunId:"run-a",userSlot:1,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[{pickNo:1,playerId:"taken",slot:2}],players:[{id:"taken",name:"Player taken",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true},{id:"wr",name:"Player wr",position:"WR",team:"BUF",platformProjection:190,projectionSeason:2026,adp:12,eligibleForRecommendation:true}]});
  const root=h.elements.get("positionFilter"),positions=root.querySelectorAll('input:not([value="ALL"])');root.querySelector('[value="ALL"]').checked=false;for(const input of positions)input.checked=input.value==="WR";
  h.enqueue("/v1/quick-evaluate",data);h.enqueue("/v1/evaluate",data);await h.panel.uiRefresh(true);await tick();
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/Player taken/);
  assert.match(h.elements.get("recommendations").innerHTML,/Player wr/,String(h.panel.lastError()?.stack||h.panel.lastError()||""));
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
});

test("the quick shortlist stays visible while exact odds are pending",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.setState({platform:"espn",draftId:"draft-live",draftRunId:"run-live",userSlot:1,currentPickNo:8,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:Array.from({length:7},(_,index)=>({pickNo:index+1,playerId:`taken-${index+1}`,slot:index%4+1})),players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]});
  h.enqueue("/v1/evaluate",pending("refining"));await h.panel.uiRefresh(true);await tick();
  assert.equal(h.elements.get("draftPrep").hidden,false);
  assert.match(h.elements.get("status").textContent,/^Calculating/);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
  assert.equal(h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,1);
});

test("a transient exact-evaluation failure preserves the quick shortlist",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",pending("refining"));await h.panel.uiRefresh(true);await tick();
  h.elements.get("sourceProfile").value="marketLed";
  h.enqueue("/v1/evaluate",new Error("The local recommendation service is unavailable."));await h.panel.uiRefresh(false);await tick();
  assert.match(h.elements.get("status").textContent,/exact odds unavailable$/);
  assert.equal(h.elements.get("error").hidden,true);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
  assert.equal(h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,1);
  assert.equal(h.elements.get("freshness").textContent,"Exact simulations stopped");
  assert.doesNotMatch(h.elements.get("freshness").textContent,/ready/i);
});

test("a transient failure after refinement preserves the complete cards without an intermediate retry paint",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",refined());await h.panel.uiRefresh(true);await tick();
  h.elements.get("sourceProfile").value="marketLed";
  h.enqueue("/v1/evaluate",new Error("The local recommendation service is unavailable."));await h.panel.uiRefresh(false);await tick();
  assert.match(h.elements.get("recommendations").innerHTML,/Player p1/);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
  assert.equal(h.elements.get("freshness").textContent,"Exact simulations stopped");
  assert.equal(h.elements.get("status").textContent,"Live · exact odds unavailable");
  assert.equal(h.snapshots.some(snapshot=>snapshot.freshness==="Last shortlist · retrying"),false);
  assert.equal(h.elements.get("error").hidden,true);
});

test("a transient failure preserves the preliminary shortlist",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",preliminary());await h.panel.uiRefresh(true);await tick();
  const shortlist=h.elements.get("recommendations").innerHTML;
  h.elements.get("sourceProfile").value="marketLed";
  h.enqueue("/v1/evaluate",new Error("The local recommendation service is unavailable."));await h.panel.uiRefresh(false);await tick();
  assert.equal(h.elements.get("recommendations").innerHTML,shortlist);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
  assert.equal(h.elements.get("freshness").textContent,"Exact simulations stopped");
  assert.equal(h.elements.get("error").hidden,true);
});

test("draft-error reconnect and recovery preserve the same refined card node",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",refined());await h.panel.uiRefresh(true);await tick();
  const cards=h.elements.get("recommendations"),before=cards.querySelector(".card:not(.skeleton)");
  assert.ok(before);assert.match(h.elements.get("freshness").textContent,/ready/);

  // The storage-change path deliberately passes false once a refined result exists.
  // Passing true here would replace the cards before findState can preserve them.
  h.setDraftError("Live draft data disconnected.");
  await h.panel.uiRefresh(false);await tick();
  assert.equal(cards.querySelector(".card:not(.skeleton)"),before);
  assert.equal(cards.hasAttribute("aria-busy"),false);
  assert.match(h.elements.get("status").textContent,/^Live · reconnecting$/);
  assert.match(h.elements.get("freshness").textContent,/^Last verified result · reconnecting$/);
  assert.doesNotMatch(h.elements.get("status").textContent+h.elements.get("freshness").textContent,/paused|loading|ready/i);
  assert.equal(h.elements.get("error").hidden,true);

  h.setDraftError(undefined);
  await h.panel.uiRefresh(false);await tick();
  assert.equal(cards.querySelector(".card:not(.skeleton)"),before);
  assert.equal(cards.hasAttribute("aria-busy"),false);
  assert.match(h.elements.get("status").textContent,/^Live/);
  assert.match(h.elements.get("freshness").textContent,/10,000 sims · ready/);
  assert.equal(h.elements.get("error").hidden,true);
});

test("a depleted stable shortlist is refilled after opponent picks",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const first=refined("p1");for(const id of ["p2","p3","p4"])first.recommendations.push(refined(id).recommendations[0]);
  h.enqueue("/v1/evaluate",first);await h.panel.uiRefresh(true);await tick();
  h.setState({platform:"sleeper",draftId:"draft-a",draftRunId:"run-a",userSlot:1,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[{pickNo:1,playerId:"p1",slot:2},{pickNo:2,playerId:"p2",slot:3}],players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]});
  h.enqueue("/v1/evaluate",refined("p5"));await h.panel.uiRefresh(false);await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,2);
  assert.match(h.elements.get("recommendations").innerHTML,/Player p5/);
});

test("a new pick immediately clears every prior recommendation before recalculation",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const first=refined("p1");first.recommendations.push(refined("p2").recommendations[0],refined("p3").recommendations[0],refined("p4").recommendations[0]);
  h.enqueue("/v1/evaluate",first);await h.panel.uiRefresh(true);await tick();
  assert.match(h.elements.get("recommendations").innerHTML,/Player p1/);
  h.panel.resetDraftPresentation();h.panel.setLoading();
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/Player p1/);
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/Player p2/);
  assert.ok(h.elements.get("recommendations").querySelector(".skeleton"));
  assert.equal(h.elements.get("status").textContent,"Calculating decision context");
  assert.equal(h.elements.get("range").textContent,"Title odds are supporting evidence and will appear after the exact simulation.");
  assert.equal(h.elements.get("chance").textContent,"—");
  assert.equal(h.panel.pollState().lastEvaluationData,undefined);
});

test("an unchanged refined poll preserves the rendered card node",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",refined());await h.panel.uiRefresh(true);await tick();
  const before=h.elements.get("recommendations").querySelector(".card:not(.skeleton)");
  assert.ok(before);
  await h.panel.uiRefresh(false);await tick();
  const after=h.elements.get("recommendations").querySelector(".card:not(.skeleton)");
  assert.equal(after,before,"an unchanged poll must not tear down and recreate stable cards");
});

test("a stale refining response cannot reopen loading after a newer refined result",async t=>{
  const h=await createHarness();t.after(h.cleanup);const old=deferred();
  h.enqueue("/v1/evaluate",old);const oldRefresh=h.panel.uiRefresh(true);
  await tick();const next={platform:"sleeper",draftId:"draft-b",draftRunId:"run-b",userSlot:1,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[],players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]};h.setState(next);h.panel.resetDraftPresentation();h.enqueue("/v1/evaluate",refined());const nextRefresh=h.panel.uiRefresh(true);
  old.resolve(pending("refining"));await Promise.all([oldRefresh,nextRefresh]);await tick();
  assert.match(h.elements.get("freshness").textContent,/10,000 sims · ready/);assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);assert.equal(h.elements.get("recommendations").hasAttribute("aria-busy"),false);
});

test("invalidating a draft context prevents an old response from rendering even transiently",async t=>{
  const h=await createHarness();t.after(h.cleanup);const old=deferred(),nextResult=deferred();
  h.enqueue("/v1/evaluate",old);const oldRefresh=h.panel.uiRefresh(true);await tick();
  const next={platform:"sleeper",draftId:"draft-new-context",draftRunId:"run-new",userSlot:1,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[],players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]};
  h.setState(next);h.panel.resetDraftPresentation();h.enqueue("/v1/evaluate",nextResult);const nextRefresh=h.panel.uiRefresh(true);
  old.resolve(refined("old-context"));await tick();await tick();
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/Player old-context/);
  nextResult.resolve(refined("new-context"));await Promise.all([oldRefresh,nextRefresh]);await tick();
  assert.match(h.elements.get("recommendations").innerHTML,/Player new-context/);
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/Player old-context/);
});

test("a stale failed request cannot pause a newer successful context",async t=>{
  const h=await createHarness();t.after(h.cleanup);const old=deferred();
  h.enqueue("/v1/evaluate",old);const oldRefresh=h.panel.uiRefresh(true);await tick();
  const next={platform:"sleeper",draftId:"draft-c",draftRunId:"run-c",userSlot:1,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[],players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]};
  h.setState(next);h.panel.resetDraftPresentation();h.enqueue("/v1/evaluate",refined());const nextRefresh=h.panel.uiRefresh(true);
  old.reject(new Error("The local recommendation service is unavailable."));await Promise.all([oldRefresh,nextRefresh]);await tick();
  assert.match(h.elements.get("status").textContent,/^Live/);
  assert.match(h.elements.get("freshness").textContent,/10,000 sims · ready/);
  assert.equal(h.elements.get("error").hidden,true);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
});

test("a terminal exact-engine failure stays stable until an explicit retry succeeds",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const failure=new Error("Exact title odds could not finish shard 2 after 3 attempts.");
  h.enqueue("/v1/evaluate",failure);await h.panel.uiRefresh(true);await tick();await h.panel.uiRefresh(false);await tick();
  assert.match(h.elements.get("status").textContent,/exact odds unavailable$/);
  assert.equal(h.elements.get("freshness").textContent,"Exact simulations stopped");
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
  assert.equal(h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,1);
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1);
  assert.equal(h.elements.get("error").hidden,true);
  assert.equal(h.elements.get("exactOddsError").hidden,false);

  h.enqueue("/v1/evaluate",refined("recovered"));
  await h.panel.retryExactOdds();await tick();
  assert.match(h.elements.get("recommendations").innerHTML,/Player recovered/);
  assert.match(h.elements.get("status").textContent,/^Live/);
  assert.equal(h.elements.get("error").hidden,true);
});

test("retry waits for the failed exact promise to settle before starting a replacement",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",new Error("Exact title odds exceeded the 22-second engine budget."));
  await h.panel.uiRefresh(true);await tick();await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1);
  const settling=deferred();h.enqueue("/v1/evaluate",refined("retry-after-settle"));
  const retry=h.panel.retryWhileSettlingForTest(settling.promise);
  await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1,"retry must not join the terminal request while its catch/finally chain is settling");
  assert.match(h.elements.get("freshness").textContent,/Retrying exact simulations/);
  settling.resolve();await retry;await tick();await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,2);
  assert.match(h.elements.get("recommendations").innerHTML,/Player retry-after-settle/);
  assert.match(h.elements.get("freshness").textContent,/10,000 sims/)
});

test("a terminal exact failure stays stable without a shortlist-retry flicker",async t=>{
  const h=await createHarness();t.after(h.cleanup);const failed=deferred();
  h.enqueue("/v1/evaluate",failed);
  await h.panel.uiRefresh(true);await tick();
  assert.ok(h.elements.get("recommendations").querySelector(".card:not(.skeleton)"));

  const beforeFailure=h.snapshots.length;
  failed.reject(new Error("The local recommendation service is unavailable."));await tick();await tick();
  assert.equal(h.elements.get("status").textContent,"Live · exact odds unavailable");
  assert.equal(h.elements.get("freshness").textContent,"Exact simulations stopped");
  assert.equal(h.snapshots.slice(beforeFailure).some(snapshot=>snapshot.freshness==="Last shortlist · retrying"),false);
  await h.panel.uiRefresh(false);await tick();
  assert.equal(h.elements.get("status").textContent,"Live · exact odds unavailable");
  assert.equal(h.elements.get("freshness").textContent,"Exact simulations stopped");
});

test("ESPN countdown waits, then opponent picks continuously simulate the user's next pick",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const state={platform:"espn",draftId:"countdown",draftRunId:"run-countdown",draftStatus:"predraft",userSlot:4,currentPickNo:null,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[],players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]};
  h.setState(state);await h.panel.uiRefresh(true);await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,0);
  assert.equal(h.elements.get("status").textContent,"Waiting for ESPN draft");
  assert.equal(h.elements.get("freshness").textContent,"Engine ready · starts automatically");
  assert.match(h.elements.get("recommendations").innerHTML,/Ready for pick 1/);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);

  const preview=refined("pick-four-preview");Object.assign(preview.recommendations[0],{waitingForUserPick:true,nextUserPick:4,availabilityTargetPick:4});
  h.setState({...state,draftStatus:"drafting",currentPickNo:1});h.panel.resetDraftPresentation();h.enqueue("/v1/evaluate",preview);
  await h.panel.uiRefresh(true);await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,1);
  assert.equal(h.elements.get("prepTitle").textContent,"Preparing for your pick 4");
  assert.match(h.elements.get("prepHelp").textContent,/evaluated as if they remain available at your pick/);
  assert.match(h.elements.get("recommendations").innerHTML,/Player pick-four-preview/);
  assert.match(h.elements.get("recommendations").innerHTML,/At your pick<\/strong><span>25\.0% chance this player is available at your pick 4\./);
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/If you wait|If you pass/);
  assert.match(h.elements.get("freshness").textContent,/10,000 sims/);

  h.setState({...state,draftStatus:"drafting",currentPickNo:4,picks:[{pickNo:1,playerId:"taken-1",slot:1},{pickNo:2,playerId:"taken-2",slot:2},{pickNo:3,playerId:"taken-3",slot:3}]});h.panel.resetDraftPresentation();h.enqueue("/v1/evaluate",refined("pick-four"));
  await h.panel.uiRefresh(true);await tick();
  assert.equal(h.calls.filter(path=>path==="/v1/evaluate").length,2);
  assert.match(h.elements.get("recommendations").innerHTML,/Player pick-four/);
  assert.match(h.elements.get("recommendations").innerHTML,/If you wait<\/strong>/);
});

test("starting draft B cancels draft A's report worker before loading new recommendations",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  const teams=4,rounds=4;
  const completed={platform:"espn",draftId:"draft-a",draftRunId:"run-a",userSlot:1,projectionSeason:2026,settings:{teams,rounds,scoring:{reception:1}},picks:Array.from({length:teams*rounds},(_,index)=>({pickNo:index+1,playerId:`taken-${index+1}`,slot:index%teams+1})),players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]};
  const oldReport=deferred();
  h.enqueue("/v1/draft-report",oldReport);
  const reportRequest=h.panel.completedDraftReport(completed).catch(cause=>cause);
  await tick();
  assert.deepEqual(h.panel.lifecycleState(),{reportActive:true,reportPending:true,reportKey:h.panel.lifecycleState().reportKey});

  await h.panel.startNewDraft();
  const cancellation=await reportRequest;
  assert.match(cancellation.message,/25-second limit|cancel/i);
  assert.deepEqual(h.panel.lifecycleState(),{reportActive:false,reportPending:false,reportKey:""});

  const next={...completed,draftId:"draft-b",draftRunId:"run-b",picks:[]};
  h.setState(next);
  h.enqueue("/v1/evaluate",refined("draft-b"));
  await h.panel.uiRefresh(true);await tick();
  assert.match(h.elements.get("recommendations").innerHTML,/Player draft-b/);
  assert.match(h.elements.get("status").textContent,/^Live/);
  assert.equal(h.elements.get("error").hidden,true);
});

test("loading a new context shows a fresh quick shortlist without old exact odds",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",refined());await h.panel.uiRefresh(true);await tick();
  assert.ok(h.elements.get("recommendations").innerHTML.includes("Player p1"));
  const next={platform:"sleeper",draftId:"draft-new",draftRunId:"run-new",userSlot:1,projectionSeason:2026,settings:{teams:4,rounds:4,scoring:{reception:1}},picks:[],players:[{id:"p1",name:"Player p1",position:"RB",team:"BUF",platformProjection:200,projectionSeason:2026,adp:10,eligibleForRecommendation:true}]};
  h.setState(next);h.panel.resetDraftPresentation();h.enqueue("/v1/evaluate",pending("refining"));await h.panel.uiRefresh(true);await tick();
  assert.match(h.elements.get("status").textContent,/^Calculating/);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
  assert.equal(h.elements.get("recommendations").querySelectorAll(".card:not(.skeleton)").length,1);
  assert.doesNotMatch(h.elements.get("recommendations").innerHTML,/14\.0%/);
  assert.equal(h.elements.get("chance").textContent,"—");
  assert.match(h.elements.get("range").textContent,/10,000 simulations finish/);
});

test("a persistent verified-draft error settles on paused without stale ready text",async t=>{
  const h=await createHarness();t.after(h.cleanup);h.setDraftError("Draft data could not be verified.");
  await h.panel.uiRefresh(true);await tick();
  assert.equal(h.elements.get("status").textContent,"Recommendations unavailable");
  assert.equal(h.elements.get("error").hidden,false);
  assert.equal(h.elements.get("error").textContent,"Draft data could not be verified.");
  assert.doesNotMatch(h.elements.get("freshness").textContent,/ready|loading draft data/i);
  assert.match(h.elements.get("freshness").textContent,/waiting|unable/i);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
});

test("repeated transient exact failures preserve one coherent unavailable state",async t=>{
  const h=await createHarness();t.after(h.cleanup);
  h.enqueue("/v1/evaluate",pending("refining"));await h.panel.uiRefresh(true);await tick();
  for(const profile of ["marketLed","ownedModel","custom-third"]){h.elements.get("sourceProfile").value=profile;h.enqueue("/v1/evaluate",new Error("The local recommendation service is unavailable."));await h.panel.uiRefresh(false);await tick()}
  assert.match(h.elements.get("status").textContent,/exact odds unavailable$/);
  assert.equal(h.elements.get("freshness").textContent,"Exact simulations stopped");
  assert.equal(h.elements.get("recommendations").hasAttribute("aria-busy"),false);
  assert.equal(h.elements.get("recommendations").querySelector(".skeleton"),null);
  assert.equal(h.elements.get("error").hidden,true);
  assert.equal(h.elements.get("exactOddsError").hidden,false);
  assert.doesNotMatch(h.elements.get("freshness").textContent,/ready/i);
});
