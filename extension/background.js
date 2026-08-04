import{sanitizeSleeperState}from"./player-hygiene.js";
import{refreshProjectionFeed}from"./projection-feed.js";

const stateWrites=new Map();
const sleeperFetches=new Map();
const espnFetches=new Map();
const adapterSessions=new Map();
const adapterHealth=new Map();
const injectionPromises=new Map();
const pendingReductions=new Map();
const staleStateTimers=new Map();
const sidePanelWindows=new Map();
let offscreenCreationPromise;
const OFFSCREEN_READY_DELAYS_MS=[0,25,50,100,200,400];
const STALE_STATE_GRACE_MS=3000;
const ADAPTER_HEARTBEAT_STALE_MS=3000;
const ATTACHMENT_GRACE_MS=2000;
const INITIAL_STATE_GRACE_MS=30000;
const RETRY_DELAYS_MS=[0,1000,2000,4000,5000];
const PROJECTION_REFRESH_ALARM="draft-goblin-projection-refresh";
const ensureProjectionRefreshAlarm=()=>chrome.alarms?.create(PROJECTION_REFRESH_ALARM,{delayInMinutes:1,periodInMinutes:240});
const refreshRemoteProjections=()=>refreshProjectionFeed().catch(()=>null);

const healthKey=tabId=>`draftHealth:${tabId}`;
const sidePanelOpenInWindow=windowId=>[...sidePanelWindows.values()].some(value=>value===windowId);
function publishSidePanelVisibility(windowId){
  if(!Number.isInteger(windowId))return;const open=sidePanelOpenInWindow(windowId);
  chrome.tabs.query({windowId}).then(tabs=>Promise.all(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,{type:"DRAFT_SIDE_PANEL_VISIBILITY",open}).catch(()=>null)))).catch(()=>null);
}
const publicHealth=health=>health?{ok:health.phase!=="unsupported",tabId:health.tabId,platform:health.platform,draftId:health.draftId,phase:health.phase,attempt:Number(health.attempt||0),error:health.error||undefined,lastHeartbeatAt:Number(health.lastHeartbeatAt||0),lastStateAt:Number(health.lastStateAt||0)}:null;
function clearStaleStateTimer(tabId){const pending=staleStateTimers.get(tabId);if(pending)clearTimeout(pending.timer);staleStateTimers.delete(tabId)}
function draftInfoForUrl(value){
  const raw=String(value||"");let url;try{url=new URL(raw)}catch{return null}
  if(/^(?:www\.)?(?:sleeper\.com|sleeper\.app)$/i.test(url.hostname)){
    const queryId=url.searchParams.get("draft_id"),pathIds=[...url.pathname.matchAll(/(?:^|\/)([0-9]{10,})(?=\/|$)/g)].map(match=>match[1]),draftId=/^\d{10,}$/.test(String(queryId||""))?String(queryId):pathIds.at(-1);
    if(draftId)return{file:"adapters/sleeper.js",platform:"sleeper",draftId};
  }
  if(url.hostname.toLowerCase()==="fantasy.espn.com"&&/^\/football\/draft\/?$/i.test(url.pathname)&&/^\d+$/.test(String(url.searchParams.get("leagueId")||"")))return{file:"adapters/espn.js",platform:"espn",draftId:String(url.searchParams.get("leagueId"))};
  if(url.hostname.toLowerCase()==="football.fantasysports.yahoo.com"){
    const match=url.pathname.match(/^\/draftclient\/f1\/(\d+)\/(\d+)(?:\/|$)/i);
    if(match)return{file:"adapters/yahoo.js",platform:"yahoo",draftId:match[1]};
  }
  return null;
}
function draftAdapterFileForUrl(value){return draftInfoForUrl(value)?.file||null}
async function setDraftPanelAvailability(tabId,url){
  if(!Number.isInteger(tabId)||!chrome.sidePanel.setOptions)return;
  const enabled=Boolean(draftInfoForUrl(url));
  await chrome.sidePanel.setOptions(enabled?{tabId,path:"sidepanel.html",enabled:true}:{tabId,enabled:false}).catch(()=>null);
}
async function initializeDraftPanels(){
  await chrome.sidePanel.setOptions({enabled:false}).catch(()=>null);
  const tabs=await chrome.tabs.query({});
  await Promise.all(tabs.map(tab=>setDraftPanelAvailability(tab.id,tab.url)))
}
async function ensureOffscreenEngine(){
  if(!chrome.offscreen?.createDocument)throw new Error("Persistent background simulations are unavailable.");
  const url=chrome.runtime.getURL("offscreen.html");
  let exists=false;
  if(chrome.runtime.getContexts){
    const contexts=await chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"],documentUrls:[url]});
    exists=contexts.length>0;
  }
  if(!exists){
    if(!offscreenCreationPromise)offscreenCreationPromise=chrome.offscreen.createDocument({url:"offscreen.html",reasons:["WORKERS"],justification:"Keep an active draft simulation running while its side panel is hidden."}).finally(()=>{offscreenCreationPromise=null});
    await offscreenCreationPromise;
  }
  for(const delay of OFFSCREEN_READY_DELAYS_MS){
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    const response=await chrome.runtime.sendMessage({type:"OFFSCREEN_ENGINE_PING"}).catch(()=>null);
    if(response?.ok&&response.engine==="draft-goblin-offscreen")return
  }
  throw new Error("The persistent simulation engine did not finish starting.")
}
async function runPersistentEvaluation(body,requestId){
  await ensureOffscreenEngine();
  const response=await chrome.runtime.sendMessage({type:"OFFSCREEN_RUN_EVALUATION",body,requestId});
  if(response?.ok!==true)throw new Error(response?.error||"The background simulation failed.");
  return response.data;
}
async function warmPersistentEvaluationEngine(){
  await ensureOffscreenEngine();
  const response=await chrome.runtime.sendMessage({type:"OFFSCREEN_WARM_ENGINE"});
  if(response?.ok!==true)throw new Error(response?.error||"The persistent simulation engine could not be warmed.");
  return true
}
async function cancelPersistentEvaluation(requestId){
  if(!requestId)return false;
  const response=await chrome.runtime.sendMessage({type:"OFFSCREEN_CANCEL_EVALUATION",requestId}).catch(()=>null);
  return response?.ok===true
}
async function writeHealth(tabId,patch){
  const previous=adapterHealth.get(tabId)||{},health={...previous,...patch,tabId,updatedAt:Date.now()};adapterHealth.set(tabId,health);await chrome.storage.session.set({[healthKey(tabId)]:health});return health;
}
async function clearHealth(tabId){adapterHealth.delete(tabId);injectionPromises.delete(tabId);await chrome.storage.session.remove(healthKey(tabId))}
function retryDelay(attempt){return RETRY_DELAYS_MS[Math.min(Math.max(0,Number(attempt)||0),RETRY_DELAYS_MS.length-1)]}
async function activateDraftTab(tab,{force=false}={}){
  const tabId=tab?.id,info=draftInfoForUrl(tab?.url);if(!tabId||!info)return false;
  const active=await chrome.storage.session.get("activeDraftTab"),ownershipChanged=active.activeDraftTab!==tabId;
  if(ownershipChanged)await chrome.storage.session.remove("draftError");
  await chrome.storage.session.set({activeDraftTab:tabId});
  if(injectionPromises.has(tabId))return injectionPromises.get(tabId);
  const now=Date.now(),health=adapterHealth.get(tabId),sameDraft=health?.platform===info.platform&&String(health?.draftId)===info.draftId,registered=sameDraft&&adapterSessions.get(tabId)&&adapterSessions.get(tabId)===health?.adapterSessionId,waitingForFirstState=health?.phase==="connecting"&&!Number(health?.lastStateAt||0),withinInitialStateGrace=!waitingForFirstState||!Number(health?.attachStartedAt||0)||now-Number(health.attachStartedAt)<INITIAL_STATE_GRACE_MS,heartbeatFresh=registered&&health?.phase!=="error"&&withinInitialStateGrace&&now-Number(health.lastHeartbeatAt||0)<ADAPTER_HEARTBEAT_STALE_MS;
  if(!force&&heartbeatFresh)return publicHealth(health);
  if(!force&&sameDraft&&health?.phase==="attaching"&&now-Number(health.attachStartedAt||0)<ATTACHMENT_GRACE_MS)return publicHealth(health);
  if(!force&&sameDraft&&Number(health?.nextRetryAt||0)>now)return publicHealth(health);
  const attempt=sameDraft?Number(health?.attempt||0)+1:1;
  const request=(async()=>{
    await chrome.storage.session.remove("draftError");
    adapterSessions.delete(tabId);
    const attachStartedAt=Date.now(),attaching=await writeHealth(tabId,{platform:info.platform,draftId:info.draftId,phase:attempt>1?"retrying":"attaching",attempt,attachStartedAt,lastHeartbeatAt:0,lastStateAt:sameDraft?Number(health?.lastStateAt||0):0,nextRetryAt:attachStartedAt+ATTACHMENT_GRACE_MS+retryDelay(attempt-1),error:"",adapterSessionId:""});
    try{await chrome.scripting.executeScript({target:{tabId},files:[info.file]});return publicHealth(attaching)}
    catch(error){const message=error?.message||"Draft adapter could not be started.",nextRetryAt=Date.now()+retryDelay(attempt);const failed=await writeHealth(tabId,{phase:"retrying",error:message,nextRetryAt});return{...publicHealth(failed),ok:false}}
  })().finally(()=>{if(injectionPromises.get(tabId)===request)injectionPromises.delete(tabId)});
  injectionPromises.set(tabId,request);return request;
}
async function handleDraftNavigation(tabId,url){
  const info=draftInfoForUrl(url),key=`draft:${tabId}`;await setDraftPanelAvailability(tabId,url);if(info){await activateDraftTab({id:tabId,url});return}
  adapterSessions.delete(tabId);pendingReductions.delete(key);clearStaleStateTimer(tabId);await clearHealth(tabId);await(stateWrites.get(key)||Promise.resolve()).catch(()=>null);if(adapterSessions.has(tabId))return;const stored=await chrome.storage.session.get("activeDraftTab");if(stored.activeDraftTab===tabId&&!adapterSessions.has(tabId))await chrome.storage.session.remove([key,"draftError"]);
}
function samePick(left,right){return Number(left?.pickNo)===Number(right?.pickNo)&&String(left?.playerId)===String(right?.playerId)&&Number(left?.slot)===Number(right?.slot)}
function stablePicks(key,oldPicks,newPicks,preserveReduction=false){if(preserveReduction&&newPicks.length<oldPicks.length)return oldPicks;if(newPicks.length>=oldPicks.length){pendingReductions.delete(key);return newPicks}const unchangedPrefix=newPicks.every((pick,index)=>samePick(pick,oldPicks[index]));if(!unchangedPrefix){pendingReductions.delete(key);return newPicks}const signature=JSON.stringify(newPicks.map(pick=>[pick.pickNo,pick.playerId,pick.slot]));if(pendingReductions.get(key)===signature){pendingReductions.delete(key);return newPicks}pendingReductions.set(key,signature);return oldPicks}
function storeStableDraftState(key,incoming,tabId,adapterSessionId,isActiveTab=false){
  const previous=stateWrites.get(key)||Promise.resolve();const next=previous.then(async()=>{if(adapterSessions.get(tabId)!==adapterSessionId)return;const stored=await chrome.storage.session.get([key,"activeDraftTab"]);if(adapterSessions.get(tabId)!==adapterSessionId)return;const old=stored[key],sameDraft=old&&old.platform===incoming.platform&&old.draftId===incoming.draftId,oldRunId=String(old?.draftRunId||""),newRunId=String(incoming.draftRunId||""),sameRun=sameDraft&&oldRunId===newRunId,oldPicks=Array.isArray(old?.picks)?old.picks:[],newPicks=Array.isArray(incoming.picks)?incoming.picks:[],expectedOldPicks=Number(old?.settings?.teams)*Number(old?.settings?.rounds),incomingStatus=String(incoming.draftStatus||"").toLowerCase(),restartedCompletedDraft=sameRun&&["drafting","predraft","waiting"].includes(incomingStatus)&&expectedOldPicks>0&&oldPicks.length>=expectedOldPicks&&newPicks.length<oldPicks.length,yahooPanelUnmounted=sameRun&&incoming.platform==="yahoo"&&newPicks.length<oldPicks.length,state=sameRun?{...incoming,userSlot:Number.isInteger(Number(incoming.userSlot))&&Number(incoming.userSlot)>=1?incoming.userSlot:old.userSlot,picks:restartedCompletedDraft?newPicks:stablePicks(key,oldPicks,newPicks,yahooPanelUnmounted)}:incoming;if(!sameRun)pendingReductions.delete(key);if(adapterSessions.get(tabId)!==adapterSessionId)return;await chrome.storage.session.set({[key]:state,...(isActiveTab?{activeDraftTab:tabId,draftError:null}:stored.activeDraftTab===tabId?{draftError:null}:{})});await writeHealth(tabId,{platform:incoming.platform,draftId:String(incoming.draftId),adapterSessionId,phase:"live",lastHeartbeatAt:Date.now(),lastStateAt:Date.now(),attempt:0,error:"",nextRetryAt:0});clearStaleStateTimer(tabId)}).finally(()=>{if(stateWrites.get(key)===next)stateWrites.delete(key)});stateWrites.set(key,next);return next;
}
function refreshDraftState(key,tabId,adapterSessionId,message,isActiveTab=false){const previous=stateWrites.get(key)||Promise.resolve();const next=previous.then(async()=>{if(adapterSessions.get(tabId)!==adapterSessionId)return false;const stored=await chrome.storage.session.get([key,"activeDraftTab"]),state=stored[key];if(!state||state.platform!==message.platform||String(state.draftId)!==String(message.draftId)||adapterSessions.get(tabId)!==adapterSessionId)return false;await chrome.storage.session.set({[key]:{...state,updatedAt:Math.max(Number(state.updatedAt)||0,Number(message.updatedAt)||Date.now())},...(isActiveTab?{activeDraftTab:tabId,draftError:null}:stored.activeDraftTab===tabId?{draftError:null}:{})});await writeHealth(tabId,{phase:"live",lastHeartbeatAt:Date.now(),lastStateAt:Date.now(),error:"",nextRetryAt:0});clearStaleStateTimer(tabId);return true}).finally(()=>{if(stateWrites.get(key)===next)stateWrites.delete(key)});stateWrites.set(key,next);return next}
function storeDraftPickUpdate(key,tabId,adapterSessionId,message){const previous=stateWrites.get(key)||Promise.resolve();const next=previous.then(async()=>{if(adapterSessions.get(tabId)!==adapterSessionId)return false;const stored=await chrome.storage.session.get(key),state=stored[key];if(!state||state.platform!==message.platform||String(state.draftId)!==String(message.draftId)||adapterSessions.get(tabId)!==adapterSessionId)return false;const incoming=Array.isArray(message.picks)?message.picks:[],picks=stablePicks(key,Array.isArray(state.picks)?state.picks:[],incoming),reportedPick=Number(message.currentPickNo),currentPickNo=Number.isInteger(reportedPick)&&reportedPick>0?reportedPick:picks.length+1,picksUnchanged=picks.length===(state.picks||[]).length&&picks.every((pick,index)=>samePick(pick,state.picks[index]));if(picksUnchanged&&Number(currentPickNo)===Number(state.currentPickNo))return true;await chrome.storage.session.set({[key]:{...state,picks,currentPickNo,updatedAt:Date.now()}});return true}).finally(()=>{if(stateWrites.get(key)===next)stateWrites.delete(key)});stateWrites.set(key,next);return next}
async function publishDraftFailure(key,tabId,adapterSessionId,error){if(adapterSessions.get(tabId)!==adapterSessionId)return false;const health=adapterHealth.get(tabId)||{},attempt=Math.max(1,Number(health.attempt||1));await writeHealth(tabId,{phase:"error",lastHeartbeatAt:Date.now(),error:error||"Draft state could not be verified.",nextRetryAt:Date.now()+retryDelay(attempt)});await(stateWrites.get(key)||Promise.resolve()).catch(()=>null);if(adapterSessions.get(tabId)!==adapterSessionId)return false;const stored=await chrome.storage.session.get([key,"activeDraftTab"]),state=stored[key];if(stored.activeDraftTab!==tabId)return false;const publish=async expectedUpdatedAt=>{await(stateWrites.get(key)||Promise.resolve()).catch(()=>null);if(adapterSessions.get(tabId)!==adapterSessionId)return false;const latest=await chrome.storage.session.get([key,"activeDraftTab"]),latestState=latest[key];if(latest.activeDraftTab!==tabId)return false;if(latestState&&Number(latestState.updatedAt||0)>expectedUpdatedAt)return false;await chrome.storage.session.set({draftError:error||"Draft state could not be verified."});return true};if(!state)return publish(0);const observedUpdatedAt=Number(state.updatedAt)||0,delay=Math.max(0,observedUpdatedAt+STALE_STATE_GRACE_MS-Date.now());clearStaleStateTimer(tabId);if(delay===0)return publish(observedUpdatedAt);const pending={timer:null};pending.timer=setTimeout(()=>{if(staleStateTimers.get(tabId)!==pending)return;staleStateTimers.delete(tabId);publish(observedUpdatedAt).catch(()=>null)},delay);staleStateTimers.set(tabId,pending);return false}
function fetchSleeperJson(url){const existing=sleeperFetches.get(url);if(existing)return existing;const request=fetch(url,{cache:"no-store"}).then(async response=>{if(!response.ok)throw new Error(`Sleeper request failed (${response.status}).`);return response.json()}).finally(()=>{if(sleeperFetches.get(url)===request)sleeperFetches.delete(url)});sleeperFetches.set(url,request);return request}
function espnDraftInitRequest(seasonId,leagueId){
  const season=Number(seasonId),league=String(leagueId||"");
  if(!Number.isInteger(season)||season<2020||season>2100||!/^\d+$/.test(league))throw new Error("Invalid ESPN draft identity.");
  const filter=encodeURIComponent(JSON.stringify({players:{filterStatsForContainerIds:{value:[`00${season-1}`,`10${season}`]}}}));
  const url=`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league}?filter=${filter}&view=draftInit&view=mSettings`;
  return{key:`${season}:${league}`,url};
}
function espnSettingsRequest(seasonId,leagueId){
  const season=Number(seasonId),league=String(leagueId||"");
  if(!Number.isInteger(season)||season<2020||season>2100||!/^\d+$/.test(league))throw new Error("Invalid ESPN draft identity.");
  return{key:`settings:${season}:${league}`,url:`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league}?view=mSettings`};
}
function fetchEspnSettings(tabId,seasonId,leagueId){
  let requestInfo;try{requestInfo=espnSettingsRequest(seasonId,leagueId)}catch(error){return Promise.reject(error)}
  const{key,url}=requestInfo,existing=espnFetches.get(key);if(existing)return existing;
  const request=(async()=>{
    const backgroundFetch=fetch(url,{cache:"no-store",credentials:"include",signal:AbortSignal.timeout(4000)}).then(async response=>{if(!response.ok)throw new Error(`ESPN settings failed (${response.status}).`);return response.json()});
    const pageFetch=Number.isInteger(Number(tabId))?chrome.scripting.executeScript({target:{tabId:Number(tabId)},world:"MAIN",args:[url],func:async settingsUrl=>{const response=await fetch(settingsUrl,{cache:"no-store",credentials:"include",signal:AbortSignal.timeout(4000)});if(!response.ok)throw new Error(`ESPN settings failed (${response.status}).`);return response.json()}}).then(([execution])=>{if(!execution||execution.result==null)throw new Error("ESPN settings did not return data.");return execution.result}):Promise.reject(new Error("ESPN draft tab is unavailable."));
    try{return await Promise.any([backgroundFetch,pageFetch])}catch{throw new Error("ESPN league settings could not be loaded.")}
  })().finally(()=>{if(espnFetches.get(key)===request)espnFetches.delete(key)});espnFetches.set(key,request);return request;
}
function fetchEspnDraftInit(tabId,seasonId,leagueId){
  let requestInfo;try{requestInfo=espnDraftInitRequest(seasonId,leagueId)}catch(error){return Promise.reject(error)}
  const{key,url}=requestInfo,existing=espnFetches.get(key);if(existing)return existing;
  const request=(async()=>{
    try{const response=await fetch(url,{cache:"no-store",credentials:"include"});if(!response.ok)throw new Error(`ESPN player feed failed (${response.status}).`);return await response.json()}
    catch(backgroundError){
      if(!Number.isInteger(Number(tabId)))throw backgroundError;
      const[execution]=await chrome.scripting.executeScript({target:{tabId:Number(tabId)},world:"MAIN",args:[url],func:async feedUrl=>{const response=await fetch(feedUrl,{cache:"no-store",credentials:"include"});if(!response.ok)throw new Error(`ESPN player feed failed (${response.status}).`);return response.json()}});
      if(!execution||execution.result==null)throw backgroundError;
      return execution.result;
    }
  })().finally(()=>{if(espnFetches.get(key)===request)espnFetches.delete(key)});espnFetches.set(key,request);return request;
}

ensureProjectionRefreshAlarm();
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>null);
initializeDraftPanels().catch(()=>null);
chrome.runtime.onStartup?.addListener(()=>{ensureProjectionRefreshAlarm();refreshRemoteProjections();chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>null);initializeDraftPanels().catch(()=>null)});
chrome.alarms?.onAlarm.addListener(alarm=>{if(alarm.name===PROJECTION_REFRESH_ALARM)refreshRemoteProjections()});
chrome.runtime.onInstalled.addListener(async()=>{ensureProjectionRefreshAlarm();refreshRemoteProjections();await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});await initializeDraftPanels();const stored=await chrome.storage.local.get("installationId");if(!stored.installationId)await chrome.storage.local.set({installationId:crypto.randomUUID()})});
chrome.runtime.onConnect?.addListener(port=>{
  if(port.name!=="DRAFT_GOBLIN_SIDE_PANEL")return;refreshRemoteProjections();
  port.onMessage.addListener(message=>{if(message.type!=="DRAFT_SIDE_PANEL_OPEN")return;const windowId=Number(message.windowId),tabId=Number(message.tabId),url=String(message.url||"");if(Number.isInteger(tabId)){setDraftPanelAvailability(tabId,url).catch(()=>null);if(draftInfoForUrl(url))activateDraftTab({id:tabId,url}).catch(()=>null)}if(!Number.isInteger(windowId))return;const previous=sidePanelWindows.get(port);sidePanelWindows.set(port,windowId);if(Number.isInteger(previous)&&previous!==windowId)publishSidePanelVisibility(previous);publishSidePanelVisibility(windowId)});
  port.onDisconnect.addListener(()=>{const windowId=sidePanelWindows.get(port);sidePanelWindows.delete(port);publishSidePanelVisibility(windowId)});
});
chrome.tabs.onActivated?.addListener(({tabId})=>{chrome.tabs.get(tabId).then(tab=>draftInfoForUrl(tab?.url)?activateDraftTab(tab):handleDraftNavigation(tabId,tab?.url)).catch(()=>null)});
chrome.tabs.onUpdated?.addListener((tabId,changeInfo)=>{if(changeInfo.url)handleDraftNavigation(tabId,changeInfo.url).catch(()=>null)});
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message.type==="WARM_PERSISTENT_EVALUATION_ENGINE"){
    warmPersistentEvaluationEngine().then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:error.message||"The persistent simulation engine could not be warmed."}));return true;
  }
  if(message.type==="RUN_PERSISTENT_EVALUATION"){
    runPersistentEvaluation(String(message.body||"{}"),String(message.requestId||"")).then(data=>sendResponse({ok:true,data})).catch(error=>sendResponse({ok:false,error:error.message||"The background simulation failed."}));return true;
  }
  if(message.type==="CANCEL_PERSISTENT_EVALUATION"){
    cancelPersistentEvaluation(String(message.requestId||"")).then(cancelled=>sendResponse({ok:true,cancelled}));return true;
  }
  if(message.type==="GET_DRAFT_SIDE_PANEL_VISIBILITY"){sendResponse({open:sidePanelOpenInWindow(sender.tab?.windowId)});return}
  if(message.type==="OPEN_DRAFT_SIDE_PANEL"||message.type==="ESPN_OPEN_SIDE_PANEL"){
    const tabId=sender.tab?.id;if(!Number.isInteger(tabId)||!draftInfoForUrl(sender.tab?.url)){sendResponse({ok:false,error:"Open an ESPN, Sleeper, or Yahoo draft first."});return}
    chrome.sidePanel.open({tabId}).then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:error.message}));return true;
  }
  if(message.type==="START_NEW_DRAFT"){
    chrome.tabs.query({active:true,lastFocusedWindow:true}).then(async tabs=>{const tab=tabs[0],tabId=tab?.id;if(!tabId)throw new Error("No active draft tab found.");const info=draftInfoForUrl(tab.url);if(!info)throw new Error("Open an ESPN, Sleeper, or Yahoo draft tab.");adapterSessions.delete(tabId);pendingReductions.delete(`draft:${tabId}`);clearStaleStateTimer(tabId);await clearHealth(tabId);await(stateWrites.get(`draft:${tabId}`)||Promise.resolve()).catch(()=>null);await chrome.storage.session.remove([`draft:${tabId}`,"draftError"]);await chrome.storage.session.set({activeDraftTab:tabId});await chrome.scripting.executeScript({target:{tabId},func:()=>{globalThis.__draftChampionSleeperAdapter?.stop?.();globalThis.__draftChampionEspnAdapter?.stop?.();globalThis.__draftChampionYahooAdapter?.stop?.();globalThis.__draftChampionSleeperAdapter=null;globalThis.__draftChampionEspnAdapter=null;globalThis.__draftChampionYahooAdapter=null}});sendResponse(await activateDraftTab(tab,{force:true}))}).catch(error=>sendResponse({ok:false,error:error.message}));return true;
  }
  if(message.type==="ENSURE_ACTIVE_DRAFT"){
    chrome.tabs.query({active:true,lastFocusedWindow:true}).then(async tabs=>{const tab=tabs[0];if(!tab?.id)throw new Error("No active browser tab found.");const health=await activateDraftTab(tab);if(!health){await handleDraftNavigation(tab.id,tab.url);sendResponse({ok:false,phase:"unsupported",error:"Open an ESPN, Sleeper, or Yahoo draft tab."});return}sendResponse(health)}).catch(error=>sendResponse({ok:false,phase:"retrying",error:error.message||"Draft adapter could not be started."}));return true;
  }
  if(message.type==="SLEEPER_FETCH"){
    const url=String(message.url||""),draftApi=url.startsWith("https://api.sleeper.app/v1/"),privateProjectionPool=/^https:\/\/api\.sleeper\.com\/projections\/nfl\/\d{4}\?season_type=regular(?:&_draftChampion=\d+)?$/.test(url);if(!draftApi&&!privateProjectionPool){sendResponse({ok:false,error:"Blocked unexpected Sleeper API URL."});return}fetchSleeperJson(url).then(data=>{if(!privateProjectionPool){sendResponse({ok:true,data});return}const compact=(Array.isArray(data)?data:[]).map(row=>({season:row?.season,player_id:row?.player_id,stats:Object.fromEntries(["pts_std","pts_half_ppr","pts_ppr","adp_std","adp_half_ppr","adp_ppr"].map(key=>[key,row?.stats?.[key]]))}));sendResponse({ok:true,data:compact})}).catch(fetchError=>sendResponse({ok:false,error:fetchError.message||"Sleeper request failed."}));return true;
  }
  if(message.type==="ESPN_FETCH_DRAFT_INIT"){
    fetchEspnDraftInit(sender.tab?.id,message.seasonId,message.leagueId).then(data=>sendResponse({ok:true,data})).catch(fetchError=>sendResponse({ok:false,error:fetchError.message||"ESPN player feed failed."}));return true;
  }
  if(message.type==="ESPN_FETCH_SETTINGS"){
    fetchEspnSettings(sender.tab?.id,message.seasonId,message.leagueId).then(data=>sendResponse({ok:true,data})).catch(fetchError=>sendResponse({ok:false,error:fetchError.message||"ESPN league settings failed."}));return true;
  }
  if(!sender.tab?.id)return;const tabId=sender.tab.id,key=`draft:${tabId}`;
  if(message.type==="ESPN_LOCATION_CHANGED"){handleDraftNavigation(tabId,String(message.url||"")).then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:error.message}));return true}
  if(message.type==="ADAPTER_BOOT_ERROR"){const health=adapterHealth.get(tabId)||{},attempt=Math.max(1,Number(health.attempt||1)),error=message.error||"Draft adapter failed during startup.";adapterSessions.delete(tabId);writeHealth(tabId,{platform:message.platform||health.platform,draftId:String(message.draftId||health.draftId||""),phase:"retrying",error,nextRetryAt:Date.now()+retryDelay(attempt),lastHeartbeatAt:0,adapterSessionId:""}).then(value=>sendResponse({...publicHealth(value),ok:false}));return true}
  if(message.type==="ADAPTER_ACTIVATED"){const adapterSessionId=String(message.adapterSessionId||"");if(!adapterSessionId){sendResponse({ok:false,error:"Adapter session identity is required."});return}adapterSessions.set(tabId,adapterSessionId);pendingReductions.delete(key);clearStaleStateTimer(tabId);const old=adapterHealth.get(tabId)||{};writeHealth(tabId,{platform:message.platform,draftId:String(message.draftId),adapterSessionId,phase:"connecting",lastHeartbeatAt:Date.now(),error:"",nextRetryAt:0,attempt:Number(old.attempt||1)}).then(health=>sendResponse(publicHealth(health)));return true}
  if(message.type==="ADAPTER_HEARTBEAT"){const adapterSessionId=String(message.adapterSessionId||"");if(!adapterSessionId||adapterSessions.get(tabId)!==adapterSessionId){sendResponse({ok:false,stale:true});return}const old=adapterHealth.get(tabId)||{},phase=message.phase==="error"?"error":old.phase==="live"?"live":"connecting";writeHealth(tabId,{platform:message.platform||old.platform,draftId:String(message.draftId||old.draftId||""),adapterSessionId,phase,lastHeartbeatAt:Date.now(),error:message.error||(phase==="error"?old.error:"")}).then(health=>sendResponse(publicHealth(health)));return true}
  if(message.type==="DRAFT_NAVIGATED"){const adapterSessionId=String(message.adapterSessionId);if(adapterSessions.get(tabId)!==adapterSessionId){sendResponse({ok:false,stale:true});return}adapterSessions.delete(tabId);pendingReductions.delete(key);clearStaleStateTimer(tabId);clearHealth(tabId).catch(()=>null);const previous=stateWrites.get(key)||Promise.resolve(),clear=previous.then(async()=>{if(adapterSessions.has(tabId))return;const stored=await chrome.storage.session.get("activeDraftTab");if(adapterSessions.has(tabId))return;if(stored.activeDraftTab===tabId)await chrome.storage.session.remove([key,"draftError"])}).finally(()=>{if(stateWrites.get(key)===clear)stateWrites.delete(key)});stateWrites.set(key,clear);clear.then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:error.message}));return true}
  if(message.type==="DRAFT_STATE"){const state=sanitizeSleeperState(message.state),adapterSessionId=String(message.adapterSessionId||"");if(!adapterSessionId||adapterSessions.get(tabId)!==adapterSessionId)return;storeStableDraftState(key,state,tabId,adapterSessionId,sender.tab.active===true)}
  if(message.type==="DRAFT_PICK_UPDATE"){const adapterSessionId=String(message.adapterSessionId||"");if(!adapterSessionId||adapterSessions.get(tabId)!==adapterSessionId){sendResponse({ok:false,stale:true});return}storeDraftPickUpdate(key,tabId,adapterSessionId,message).then(ok=>sendResponse({ok})).catch(error=>sendResponse({ok:false,error:error.message}));return true}
  if(message.type==="DRAFT_HEARTBEAT"){const adapterSessionId=String(message.adapterSessionId||"");if(!adapterSessionId||adapterSessions.get(tabId)!==adapterSessionId){sendResponse({ok:false,stale:true});return}refreshDraftState(key,tabId,adapterSessionId,message,sender.tab.active===true).then(ok=>sendResponse({ok})).catch(error=>sendResponse({ok:false,error:error.message}));return true}
  if(message.type==="DRAFT_ERROR"){const adapterSessionId=String(message.adapterSessionId||"");if(adapterSessions.get(tabId)!==adapterSessionId){sendResponse({ok:false,stale:true});return}publishDraftFailure(key,tabId,adapterSessionId,message.error).then(published=>sendResponse({ok:true,published})).catch(error=>sendResponse({ok:false,error:error.message}));return true}
});
