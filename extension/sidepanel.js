import{projectionSourceSummary}from"./projection-consensus.js";
import{completedDraftProjectionCoverage,detectedCurrentPick,filterRecommendationsByPositions,pickHistoryIsCurrent,recommendationByPlayerId,recommendationWindowKey,removeDraftedBoardCandidates,removeUnavailableRecommendations as removeUnavailableRecommendationsBase}from"./sidepanel-state.js";
import{enrichLiveDraftState}from"./draft-enrichment.js";
import{exactTitleSimulation}from"./recommendation-history.js";
import{localApi,persistentLocalApi,warmPersistentLocalEngineWorkers}from"./local-engine-client.js";
import{buildPlayerIdentityIndex,matchPlayerIdentity}from"./player-identity.js";
import{DEFAULT_PROJECTION_DRIVER,PROJECTION_DRIVERS}from"./site-projection-blend.js";
const evaluationApi=persistentLocalApi;
function connectSidePanelPresence(){
  if(typeof chrome.runtime.connect!=="function")return;
  const port=chrome.runtime.connect({name:"DRAFT_GOBLIN_SIDE_PANEL"});let heartbeatTimer;
  const publish=()=>chrome.tabs.query({active:true,currentWindow:true}).then(([tab])=>port.postMessage({type:"DRAFT_SIDE_PANEL_OPEN",windowId:tab?.windowId,tabId:tab?.id,url:tab?.url})).catch(()=>{});
  publish();heartbeatTimer=setInterval(publish,1000);
  port.onDisconnect.addListener(()=>{clearInterval(heartbeatTimer);setTimeout(connectSidePanelPresence,250)});
}
connectSidePanelPresence();
const statusNode=document.getElementById("status"),statusBinding={id:"status",get textContent(){return statusNode.textContent},set textContent(value){statusNode.textContent=value;statusNode.title=String(value)},get title(){return statusNode.title},set title(value){statusNode.title=value}},$=id=>id==="status"?statusBinding:document.getElementById(id),strategy=$("strategy"),projectionDriver=$("projectionDriver"),sourceProfile=$("sourceProfile"),refinementMode=$("refinementMode"),slot=$("slot"),cards=$("recommendations"),error=$("error"),weightRoot=$("weights"),positionRoot=$("positionFilter"),boardRows=$("boardRows"),CLIENT_BUILD_ID="extension-engine-v11-te-adp-free-20260730";
const labels={projection:"projection",ceiling:"ceiling",floor:"floor",scarcity:"scarcity",need:"roster need",availability:"won't reach next pick",history:"historical winner pattern",risk:"risk",starterFlexibility:"preserve open starters/FLEX",conditionalRollout:"future-pick plan"},defaults={projection:.34,ceiling:.15,floor:.11,scarcity:.15,need:.12,availability:.08,history:0,risk:-.04};
const strategyWeights={balanced:{projection:.52,ceiling:.10,floor:.08,scarcity:.09,need:.15,availability:.04,history:0,risk:-.03},titleOnly:{projection:.32,ceiling:.32,floor:0,scarcity:.08,need:.14,availability:.02,history:0,risk:.12},upside:{projection:.38,ceiling:.28,floor:.02,scarcity:.08,need:.12,availability:.06,history:0,risk:.05},safe:{projection:.28,ceiling:.06,floor:.29,scarcity:.15,need:.15,availability:.06,history:0,risk:-.08},projection:{projection:.59,ceiling:.10,floor:.10,scarcity:.08,need:.08,availability:.04,history:0,risk:-.02}};
const sourceWeights={projectionLed:{projection:.55,ceiling:.10,floor:.08,scarcity:.08,need:.14,availability:.04,history:0,risk:-.03},ownedModel:{projection:.62,ceiling:.09,floor:.08,scarcity:.07,need:.11,availability:.02,history:0,risk:-.02},marketLed:{projection:.43,ceiling:.07,floor:.06,scarcity:.07,need:.10,availability:.24,history:0,risk:-.02}};
const STABLE_REFINED_STORAGE_KEY="stableRefinedEvaluation",SOURCE_CACHE_TTL=5*60*1000,DEFAULT_STRATEGY="titleOnly",RECOMMENDATION_LIMIT=8;
const strategyHelp={titleOnly:"Ranks the simulated shortlist only by championship probability.",balanced:"Balances points, upside, roster needs, and who may be gone later.",upside:"Favors boom-or-bust players who could produce league-winning seasons.",safe:"Favors reliable weekly points and lowers the chance of a bad pick.",projection:"Mostly takes the player expected to score the most fantasy points.",custom:"Uses the advanced sliders exactly as you set them."};
const projectionHelp={projectionLed:"Recommended: balances projected points with ADP (average draft position).",ownedModel:"Trusts projected points more than ADP, so it may recommend players earlier than most drafts.",marketLed:"Follows ADP more closely, helping you avoid reaches and wait on players likely to remain available."};
const refinementHelp={bounded:"Runs the complete 10,000 simulations for the visible shortlist.",refined:"Runs the complete 10,000 simulations for the visible shortlist."};
const weightHelp={projection:"Expected season points.",ceiling:"How great the player could be if things go well.",floor:"How useful the player should be if things go poorly.",scarcity:"How quickly good players at this position run out.",need:"How badly your roster needs this position.",availability:"Chance the player is taken before your next turn.",history:"Patterns associated with winning historical drafts.",risk:"Positive weights reward only validated performance spread; negative weights also penalize injury risk."};
let quickEvaluationAbortController;
let baselinePromise,draftGoblinPromises=new Map(),fantasyProsPromises=new Map(),sleeperProjectionPromises=new Map(),client={installationId:"anonymous"},lastEvaluationKey="",lastEvaluationData,renderedEvaluationData,renderedTitleEvidenceData,evaluationInFlightKey="",evaluationInFlight,evaluationAbortController,evaluationPollTimer,evaluationTerminalTimer,evaluationTerminalIdentity="",exactEvaluationContextKey="",exactEvaluationPromise,exactEvaluationAbortRequestedFor=null,exactEvaluationProgress=null,exactFailureContextKey="",exactFailureMessage="",lastEvaluationAt=0,desiredEvaluationKey="",refreshSequence=0,controlTimer,reportPromise,reportKey,reportAbortController,refinementAnchor,stableRefinedResult,stableStorageReset=Promise.resolve(),connectionEnsureInFlight,consecutiveEvaluationFailures=0,refreshActive=false,refreshQueued=false,queuedShowLoading=false,refreshPromise,renderedPresentationKey="",renderedContextKey="",recommendationHistoryWrites=new Map(),currentSlotScope="",currentLiveState=null,currentPlayerBoard=[],playerBoardContextKey="",playerBoardInFlightKey="",projectionDisplayIndexes={platform:new Map(),draftGoblin:new Map(),sleeper:new Map(),fantasyPros:new Map()},projectionDisplayReady=false,tutorialActive=false,tutorialIndex=0,tutorialCompleted=false,tutorialReturnFocus=null;
const TUTORIAL_VERSION="sidepanel-onboarding-v2-decision-board",TUTORIAL_STORAGE_KEY="completedSidepanelTutorial",manualSlotKey=state=>`manualDraftSlot:${state.platform}:${state.draftId}:${state.draftRunId||"default"}`;
const setConnectionStage=stage=>{const order=["checkDraft","checkSettings","checkSlot","checkRecommendations"],limit={idle:0,draft:1,settings:2,slot:3,ready:4}[stage]??0;order.forEach((id,index)=>{$(id).classList.toggle("complete",index<limit);$(id).classList.toggle("active",index===limit&&limit<order.length)})};
const showSetupCoach=(visible=true)=>{$("setupCoach").hidden=!visible;document.body.classList.toggle("setup-mode",visible)};
const tutorialSteps=()=>[
  {target:$("setupCoach"),title:"Open your draft",text:"Choose ESPN or Sleeper, then enter a snake draft. Draft Goblin will connect automatically."},
  {target:$("draftPrep"),title:"Your live draft status",text:"This confirms whether you are on the clock or shows which pick Draft Goblin is preparing for."},
  {target:document.querySelector(".hero"),title:"Start with the decision brief",text:"The current lean is a qualified starting point. The evidence label tells you whether the choice is close."},
  {target:cards.querySelector(".card:first-child"),title:"Compare the tradeoffs",text:"Each of the eight simulated options explains what you gain, whether you can wait, and who the pick best fits."},
  {target:$("boardTab"),title:"Explore the full player board",text:"Every undrafted player with usable data remains searchable, even when only eight receive title-odds simulations."}
].filter(step=>step.target&&!step.target.hidden&&step.target.getClientRects().length);
function closeTutorial({complete=true}={}){document.querySelector(".coach-target")?.classList.remove("coach-target");$("tutorialCoachmark").hidden=true;tutorialActive=false;if(complete){tutorialCompleted=true;chrome.storage.local.set({[TUTORIAL_STORAGE_KEY]:TUTORIAL_VERSION}).catch(()=>{})}tutorialReturnFocus?.focus?.();tutorialReturnFocus=null}
function positionTutorialPointer(){const target=document.querySelector(".coach-target"),coachmark=$("tutorialCoachmark");if(!tutorialActive||!target||coachmark.hidden)return;const targetRect=target.getBoundingClientRect(),coachmarkRect=coachmark.getBoundingClientRect(),pointerX=Math.max(22,Math.min(coachmarkRect.width-22,targetRect.left+targetRect.width/2-coachmarkRect.left));coachmark.style.setProperty("--tutorial-pointer-x",`${pointerX}px`)}
function showTutorialStep(index=0){const steps=tutorialSteps();if(!steps.length){closeTutorial({complete:false});return}tutorialActive=true;tutorialIndex=Math.min(index,steps.length-1);document.querySelector(".coach-target")?.classList.remove("coach-target");const step=steps[tutorialIndex];step.target.classList.add("coach-target");step.target.scrollIntoView?.({block:"center",behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});$("tutorialProgress").textContent=`Quick tour · ${tutorialIndex+1} of ${steps.length}`;$("tutorialTitle").textContent=step.title;$("tutorialText").textContent=step.text;$("nextTutorial").textContent=tutorialIndex===steps.length-1?"Done":"Next";$("tutorialCoachmark").hidden=false;positionTutorialPointer();requestAnimationFrame(positionTutorialPointer);$("nextTutorial").focus()}
const beginTutorial=({replay=false}={})=>{if(tutorialCompleted&&!replay)return;tutorialReturnFocus=document.activeElement;showTutorialStep(0)};
async function resolveUserSlot(state){const teams=Number(state.settings?.teams),detected=Number(state.userSlot),key=manualSlotKey(state);slot.max=String(teams);if(Number.isInteger(detected)&&detected>=1&&detected<=teams){slot.readOnly=true;slot.classList.remove("slot-manual");$("slotHelp").classList.remove("slot-error");currentSlotScope="";await chrome.storage.local.remove(key).catch(()=>{});return state}const stored=await chrome.storage.local.get(key),manual=Number(stored[key]);if(Number.isInteger(manual)&&manual>=1&&manual<=teams){currentSlotScope=key;currentLiveState=state;slot.readOnly=false;slot.classList.remove("slot-manual");$("slotHelp").classList.remove("slot-error");return{...state,userSlot:manual,manualUserSlot:true}}currentSlotScope=key;currentLiveState=state;slot.readOnly=false;slot.min="1";slot.value="";slot.classList.add("slot-manual");$("slotHelp").classList.add("slot-error");$("slotHelp").textContent=`Choose your draft position (1–${teams}) to continue.`;$("advancedControls").open=true;showSetupCoach(false);setConnectionStage("settings");cards.removeAttribute("aria-busy");cards.innerHTML='<div class="empty">Choose your draft position under Customize recommendations. Automatic detection will take over if it becomes available.</div>';$("status").textContent="Draft slot needed";return null}
weightRoot.innerHTML=Object.keys(defaults).map(key=>`<label>${labels[key]||key}<small class="weight-help">${weightHelp[key]}</small><input data-weight="${key}" type="range" min="-50" max="60" value="${Math.round(defaults[key]*100)}"><output>${defaults[key].toFixed(2)}</output></label>`).join("");
const customWeights=()=>Object.fromEntries([...weightRoot.querySelectorAll("[data-weight]")].map(input=>[input.dataset.weight,Number(input.value)/100])),pct=n=>`${(n*100).toFixed(1)}%`,completedPct=n=>`${(n*100).toFixed(3)}%`;
const escapeHtml=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
function setDecisionBrief({lean="Reviewing your options",evidence="Waiting for draft context"}={}){setTextIfChanged($("decisionLean"),lean);setTextIfChanged($("decisionEvidence"),evidence)}
const withEqualOddsBaseline=(text,teams)=>Number.isInteger(Number(teams))&&Number(teams)>=2?`${text} · ${Number(teams)}-team equal-odds baseline: ${pct(1/Number(teams))}`:text;
const hasFullTitleOdds=data=>exactTitleSimulation(data);
const titleOddsReady=data=>hasFullTitleOdds(data);
const simulationTiming=data=>{const ms=Number(data?.refinementMs);if(!Number.isFinite(ms))return null;const duration=ms<1000?`${Math.round(ms)} ms`:`${(ms/1000).toFixed(ms<10000?1:0)} s`;return{duration,tooltip:`${Number(data.iterations||10000).toLocaleString()} simulations and recommendation results generated in ${duration}.`}};
const evaluationProjectionSignature=state=>(state?.players||[]).map(player=>[player.id,player.position,player.team,Number(player.mean||0).toFixed(2),Number(player.floor||0).toFixed(2),Number(player.ceiling||0).toFixed(2),Number(player.risk||0).toFixed(3),Number(player.scarcity||0).toFixed(3),Number(player.adp||0).toFixed(2),Number(player.adpSd||0).toFixed(2),player.eligibleForRecommendation!==false,Boolean(player.performanceRangeIncludesHistoricalError),player.distribution?.schemaVersion||"",player.distribution?.provenance?.modelVersion||"",player.distribution?.quantiles?.map(point=>[point.p,point.value])||null,player.availability||null]);
const userPickContext=(state)=>JSON.stringify([recommendationWindowKey(state),evaluationProjectionSignature(state),strategy.value,projectionDriver.value,sourceProfile.value,refinementMode.value,strategy.value==="custom"?customWeights():null,selectedPositions()||["ALL"]]);
const anchoredEvaluationState=state=>refinementAnchor?.state&&recommendationWindowKey(refinementAnchor.state)===recommendationWindowKey(state)?refinementAnchor.state:state;
const activeUserPickContext=state=>userPickContext(anchoredEvaluationState(state));
const exactContextStillCurrent=contextKey=>Boolean(currentLiveState&&activeUserPickContext(currentLiveState)===contextKey);
const hideExactOddsFailure=()=>{$("exactOddsError").hidden=true;$("exactOddsErrorText").textContent=""};
function setExactProgressBar(completed=0,total=10000,{visible=false,state="running"}={}){const wrap=$("exactProgressWrap"),bar=$("exactProgress"),label=$("exactProgressLabel"),safeTotal=Math.max(1,Number(total)||10000),safeCompleted=Math.max(0,Math.min(safeTotal,Number(completed)||0)),totalLabel=safeTotal===10000?"10k":safeTotal.toLocaleString();wrap.hidden=!visible;$("freshness").hidden=visible;wrap.dataset.state=state;bar.max=safeTotal;bar.value=safeCompleted;bar.setAttribute("aria-label",`${safeCompleted.toLocaleString()} of ${safeTotal.toLocaleString()} exact simulations complete`);bar.setAttribute("aria-valuemin","0");bar.setAttribute("aria-valuemax",String(safeTotal));bar.setAttribute("aria-valuenow",String(safeCompleted));label.textContent=`${safeCompleted.toLocaleString()} / ${totalLabel} sims`}
function showExactProgress(progress,contextKey){if(exactEvaluationContextKey!==contextKey||!exactContextStillCurrent(contextKey))return;exactEvaluationProgress={...progress,contextKey};hideExactOddsFailure();const completed=Math.max(0,Math.min(Number(progress.total)||10000,Number(progress.completed)||0)),total=Math.max(1,Number(progress.total)||10000),retry=Number(progress.retryCount)||0,diagnostic=progress.workerCount?` · ${progress.workerCount}w · ${progress.sourcePlayerCount}/${progress.simulationPlayerCount}p`:"";setExactProgressBar(completed,total,{visible:true});setTextIfChanged($("freshness"),`${completed.toLocaleString()} / ${total.toLocaleString()} exact simulations${retry?` · retry ${retry}`:""}${diagnostic}`);$("freshness").title=`${progress.completedShards?.length||0} of ${progress.shards?.length||4} exact-simulation shards complete.`}
function suppressStoppedExactOdds(contextKey){
  if(renderedContextKey!==contextKey)return;
  $("chance").textContent="—";
  $("range").textContent="Exact title odds are unavailable. Projection and floor–ceiling evidence remain visible.";
  const recs=renderedEvaluationData?.recommendations||[],first=recs[0],team=first?.teamSimulation||first?.simulation,state=currentLiveState;
  if(recs.length&&team&&state){
    const currentPick=detectedCurrentPick(state),preparing=snakeSlot(currentPick,Number(state.settings.teams))!==Number(state.userSlot);
    cards.removeAttribute("aria-busy");
    cards.innerHTML=recommendationCardsHtml(recs,preparing,team,false,false);
    setDecisionBrief({lean:`Projection lean: ${first.player.name}`,evidence:"Exact simulations stopped"});
  }
  renderedTitleEvidenceData=undefined;
  renderPlayerBoard();
}
function showExactOddsFailure(cause,contextKey){const stoppedProgress=exactEvaluationProgress;exactFailureContextKey=contextKey;exactFailureMessage=String(cause?.message||cause||"One or more exact-simulation workers stopped responding.");exactEvaluationProgress=null;suppressStoppedExactOdds(contextKey);if(stoppedProgress)setExactProgressBar(stoppedProgress.completed,stoppedProgress.total,{visible:true,state:"stopped"});else setExactProgressBar(0,10000);$("exactOddsErrorText").textContent=exactFailureMessage;$("exactOddsError").hidden=false;setTextIfChanged($("status"),"Live · exact odds unavailable");setTextIfChanged($("freshness"),"Exact simulations stopped");$("freshness").title="Use Retry exact odds to start a new context-bound calculation."}
const resetStableEvaluation=()=>{refinementAnchor=null;stableRefinedResult=null;stableStorageReset=chrome.storage.session.remove(STABLE_REFINED_STORAGE_KEY).catch(()=>{})};
async function restoreStableEvaluation(contextKey){
  if(stableRefinedResult?.contextKey===contextKey)return;
  await stableStorageReset;
  const stored=await chrome.storage.session.get(STABLE_REFINED_STORAGE_KEY),candidate=stored[STABLE_REFINED_STORAGE_KEY];
  if(candidate?.contextKey===contextKey&&hasFullTitleOdds(candidate.data)&&Array.isArray(candidate.data.recommendations))stableRefinedResult={...candidate,restoredFromSession:true}
}
const persistStableEvaluation=()=>chrome.storage.session.set({[STABLE_REFINED_STORAGE_KEY]:stableRefinedResult}).catch(()=>{});
const clearEvaluationTimers=()=>{clearTimeout(evaluationPollTimer);evaluationPollTimer=null;clearTimeout(evaluationTerminalTimer);evaluationTerminalTimer=null;evaluationTerminalIdentity=""};
const cancelQuickEvaluation=()=>{quickEvaluationAbortController?.abort();quickEvaluationAbortController=null};
const resetPositionEvaluation=()=>{refreshSequence++;cancelQuickEvaluation();evaluationAbortController?.abort();evaluationAbortController=null;clearEvaluationTimers();resetStableEvaluation();lastEvaluationKey="";lastEvaluationData=undefined;renderedEvaluationData=undefined;renderedTitleEvidenceData=undefined;evaluationInFlightKey="";evaluationInFlight=null;exactEvaluationContextKey="";exactEvaluationPromise=null;exactEvaluationAbortRequestedFor=null;exactEvaluationProgress=null;exactFailureContextKey="";exactFailureMessage="";hideExactOddsFailure();desiredEvaluationKey="";consecutiveEvaluationFailures=0;renderedPresentationKey="";renderedContextKey="";setLoading()};
const resetDraftPresentation=({preservePlayerBoard=false}={})=>{refreshSequence++;cancelQuickEvaluation();evaluationAbortController?.abort();evaluationAbortController=null;clearEvaluationTimers();resetStableEvaluation();clearDraftReport();lastEvaluationKey="";lastEvaluationData=undefined;renderedEvaluationData=undefined;renderedTitleEvidenceData=undefined;evaluationInFlightKey="";evaluationInFlight=null;exactEvaluationContextKey="";exactEvaluationPromise=null;exactEvaluationAbortRequestedFor=null;exactEvaluationProgress=null;exactFailureContextKey="";exactFailureMessage="";hideExactOddsFailure();desiredEvaluationKey="";consecutiveEvaluationFailures=0;renderedPresentationKey="";renderedContextKey="";if(!preservePlayerBoard)currentPlayerBoard=[];playerBoardContextKey="";playerBoardInFlightKey="";if(boardRows&&!preservePlayerBoard)boardRows.innerHTML='<tr><td colspan="4">Refreshing the player board.</td></tr>';setDecisionBrief()};
function showSimulationFreshness(data){if(exactFailureContextKey&&exactFailureContextKey===renderedContextKey){showExactOddsFailure(exactFailureMessage,exactFailureContextKey);return}if(exactEvaluationProgress&&exactEvaluationProgress.contextKey===exactEvaluationContextKey){showExactProgress(exactEvaluationProgress,exactEvaluationContextKey);return}setExactProgressBar(0,10000);const timing=simulationTiming(data),freshness=$("freshness"),deadlineFallback=data?.refinementOutcome==="deadline_fallback",waiting=!titleOddsReady(data),restored=Boolean(stableRefinedResult?.restoredFromSession&&stableRefinedResult.data===data);freshness.textContent=deadlineFallback?`${Number(data?.iterations||0).toLocaleString()} of 10,000 sims · unavailable`:waiting?"0 / 10,000 exact simulations":restored?`${Number(data?.iterations||0).toLocaleString()} sims · restored${timing?` · original run ${timing.duration}`:""}`:`${Number(data?.iterations||0).toLocaleString()} sims · ready${timing?` in ${timing.duration}`:""}`;freshness.title=deadlineFallback?"The complete 10,000-simulation result was unavailable, so no recommendation is shown.":waiting?"Title odds appear only after all 10,000 simulations finish.":restored?`Restored the exact result for this unchanged draft and control context.${timing?` The original ${timing.tooltip.toLowerCase()}`:""}`:timing?.tooltip||""}
const projectionFormat=()=>{const reception=Number(currentLiveState?.settings?.scoring?.reception||0);return reception>=.75?"PPR":reception>=.25?"HALF":"STD"};
const directDraftGoblinPoints=player=>{const daily=Number(player?.draftGoblinProjection);if(Number.isFinite(daily)&&daily>0)return daily;const format=projectionFormat(),value=Number(format==="PPR"?player?.meanPpr:format==="HALF"?player?.meanHalf:player?.meanStd);return Number.isFinite(value)&&value>0?value:null};
const draftGoblinPoints=player=>directDraftGoblinPoints(player)??directDraftGoblinPoints(matchPlayerIdentity(projectionDisplayIndexes.draftGoblin,player));
const providerProjectionRows=player=>{
  if(!projectionDisplayReady)return[];
  const values=new Map(),add=(key,label,value)=>{const points=Number(value);if(Number.isFinite(points)&&points>0&&!values.has(key))values.set(key,{key,label,points})},platform=matchPlayerIdentity(projectionDisplayIndexes.platform,player),sleeper=matchPlayerIdentity(projectionDisplayIndexes.sleeper,player),fantasyPros=matchPlayerIdentity(projectionDisplayIndexes.fantasyPros,player),platformNameKey=String(currentLiveState?.platform||"").toLowerCase();
  add(platformNameKey,platformNameKey==="espn"?"ESPN":"Sleeper",platform?.platformProjection);
  add("sleeper","Sleeper",sleeper?.points);
  add("fantasyPros","FantasyPros",fantasyPros?.points);
  return[...values.values()]
};
const projectionComparison=player=>{const selected=Number(player?.projectionConsensus?.points||player?.mean),owned=draftGoblinPoints(player);return{selected,owned,providers:providerProjectionRows(player)}};
const sourcePointSummary=player=>{const comparison=projectionComparison(player),label=player?.projectionConsensus?.sources?.find(source=>source.weight===1)?.label||"Selected source";return Number.isFinite(comparison.selected)&&comparison.selected>0?`${label} simulation projection: ${comparison.selected.toFixed(1)}`:projectionSourceSummary(player.projectionConsensus,player.mean)};
const projectionSourcesHtml=player=>{const comparison=projectionComparison(player),rows=[{label:"Used by simulations",points:comparison.selected},...(comparison.owned?[{label:"Draft Goblin",points:comparison.owned}]:[]),...comparison.providers];return`<div class="projection-sources">${rows.filter(row=>Number(row.points)>0).map(row=>`<div class="source-row"><strong>${escapeHtml(row.label)}</strong><span>${Number(row.points).toFixed(1)}</span></div>`).join("")}</div>`};
const explainControls=()=>{$("strategyHelp").textContent=strategyHelp[strategy.value];$("projectionHelp").textContent=projectionHelp[sourceProfile.value];$("refinementHelp").textContent=refinementHelp[refinementMode.value]};
const activePresetWeights=()=>{const strategyPreset=strategyWeights[strategy.value]||strategyWeights.balanced,profilePreset=sourceWeights[sourceProfile.value]||sourceWeights.projectionLed;return Object.fromEntries(Object.keys(defaults).map(key=>[key,Number(strategyPreset[key]||0)*.65+Number(profilePreset[key]||0)*.35]))};
const syncProfileWeightDisplay=()=>{if(strategy.value==="custom")return;const weights=activePresetWeights();for(const input of weightRoot.querySelectorAll("[data-weight]")){input.value=Math.round(Number(weights[input.dataset.weight]??defaults[input.dataset.weight])*100);input.nextElementSibling.value=(Number(weights[input.dataset.weight]??defaults[input.dataset.weight])).toFixed(2)}};
const selectedPositions=()=>positionRoot.querySelector('[value="ALL"]').checked?undefined:[...positionRoot.querySelectorAll('input:not([value="ALL"]):checked')].map(input=>input.value);
const resetPositionFilter=()=>{const all=positionRoot.querySelector('[value="ALL"]');all.checked=true;for(const input of positionRoot.querySelectorAll('input:not([value="ALL"])'))input.checked=false};
const removeUnavailableRecommendations=(data,state)=>filterRecommendationsByPositions(removeUnavailableRecommendationsBase(data,state),selectedPositions());
const skeletonCards=()=>Array.from({length:8},()=>'<article class="card skeleton"><div class="skeleton-line short"></div><div class="skeleton-line medium"></div><div class="skeleton-line"></div><div class="skeleton-line medium"></div></article>').join("");
const setTextIfChanged=(node,value)=>{const next=String(value);if(node.textContent!==next)node.textContent=next;if(node.id==="status"&&node.title!==next)node.title=next};
const setHtmlIfChanged=(node,value)=>{if(node.innerHTML!==value)node.innerHTML=value};
const setRecommendationStatus=(state,waitingForOdds)=>exactFailureContextKey===renderedContextKey?setTextIfChanged($("status"),"Live · exact odds unavailable"):setTextIfChanged($("status"),(waitingForOdds?"Calculating · ":"Live · ")+platformName(state.platform));
const setLoading=({preserveExisting=false}={})=>{if(exactFailureContextKey&&exactContextStillCurrent(exactFailureContextKey)){cards.removeAttribute("aria-busy");error.hidden=true;error.textContent="";showExactOddsFailure(exactFailureMessage,exactFailureContextKey);return}const retained=preserveExisting&&Boolean(cards.querySelector(".card:not(.skeleton)"));cards.setAttribute("aria-busy","true");error.hidden=true;error.textContent="";hideExactOddsFailure();setExactProgressBar(0,10000);if(retained){$("status").textContent="Updating decision context";$("freshness").textContent="Updating exact simulations…";$("freshness").title="The last verified result remains visible until its replacement is complete.";setDecisionBrief({lean:$("decisionLean").textContent,evidence:"Updating with the new controls"});return}if(!cards.querySelector(".skeleton"))cards.innerHTML=skeletonCards();$("chance").textContent="—";$("range").textContent="Title odds are supporting evidence and will appear after the exact simulation.";$("status").textContent="Calculating decision context";$("freshness").textContent="Loading draft data…";$("freshness").title="";setDecisionBrief({lean:"Comparing your options",evidence:"10,000 simulations pending"})};
const retryableSimulationError=cause=>/extension worker failed|calculation cancelled|worker eviction|background simulation failed|persistent simulation engine|persistent background simulations|receiving end does not exist|message port closed|could not establish connection|offscreen/i.test(String(cause?.message||cause));
const transientEvaluationError=cause=>retryableSimulationError(cause)||/rate limit|unavailable|fetch failed|networkerror|aborted|request failed/i.test(String(cause?.message||cause));
const waitingForEspnDraftStart=state=>{const currentPick=Number(state?.currentPickNo);return String(state?.platform||"").toLowerCase()==="espn"&&String(state?.draftStatus||"").toLowerCase()==="predraft"&&!(state?.picks||[]).length&&!(Number.isInteger(currentPick)&&currentPick>0)};
function showRefinementLoading(data){renderedPresentationKey="";renderedContextKey="";error.hidden=true;error.textContent="";$("draftPrep").hidden=true;$("chance").textContent="—";const deadlineFallback=data?.status==="deadline_fallback"||data?.refinementOutcome==="deadline_fallback";if(deadlineFallback){cards.removeAttribute("aria-busy");cards.innerHTML='<div class="empty">The full 10,000-simulation result was not ready in time. No provisional lean will be shown; the player board remains available.</div>';$("range").textContent="A partial simulation is not title-odds evidence.";$("status").textContent="Full simulation unavailable";document.querySelector(".section-title h2").textContent="Decision brief unavailable";$("freshness").textContent=`${Number(data?.iterations||0).toLocaleString()} of 10,000 simulations · provisional` ;$("freshness").title="Draft Goblin requires the complete 10,000-simulation result before showing or recording a lean.";return}cards.setAttribute("aria-busy","true");if(!cards.querySelector(".skeleton"))cards.innerHTML=skeletonCards();$("range").textContent="The player board is available while exact title evidence finishes.";$("status").textContent="Calculating decision context";document.querySelector(".section-title h2").textContent="Comparing your options";$("freshness").textContent="Loading · completing 10,000 simulations";$("freshness").title="The decision brief and title odds appear together when the complete calculation finishes."}
function showEvaluationFailure(cause){const message=String(cause?.message||cause||"Recommendations could not be updated."),retryingSimulation=retryableSimulationError(cause),transient=transientEvaluationError(cause),hasUsableCards=Boolean(renderedEvaluationData&&cards.querySelector(".card:not(.skeleton)"));consecutiveEvaluationFailures++;if(hasUsableCards){cards.removeAttribute("aria-busy");error.hidden=true;error.textContent="";return}if(retryingSimulation){showRefinementLoading(lastEvaluationData);$("freshness").textContent="Retrying · complete 10,000 simulations";$("freshness").title="The prior exact simulation was interrupted. Draft Goblin restarted it automatically.";return}if(transient&&consecutiveEvaluationFailures<3){showRefinementLoading(lastEvaluationData);return}renderedPresentationKey="";cards.removeAttribute("aria-busy");setHtmlIfChanged(cards,'<div class="empty">Recommendations will retry automatically.</div>');$("chance").textContent="—";setTextIfChanged($("range"),"Recommendations are not ready.");setTextIfChanged($("status"),"Recommendations unavailable");setTextIfChanged($("freshness"),"Unable to finish simulations");$("freshness").title="";error.hidden=false;setTextIfChanged(error,message)}
const snakeSlot=(pickNo,teams)=>{const round=Math.floor((pickNo-1)/teams)+1,within=(pickNo-1)%teams+1;return round%2?within:teams+1-within};
const nextPickForSlot=(afterPick,userSlot,teams,rounds)=>{for(let pickNo=afterPick+1;pickNo<=teams*rounds;pickNo++)if(snakeSlot(pickNo,teams)===userSlot)return pickNo;return null};
function showLiveDraftPosition(state){$("newDraftReady").hidden=true;setTextIfChanged($("decisionAuthority"),"You make the pick");const teams=Number(state.settings?.teams),rounds=Number(state.settings?.rounds),userSlot=Number(state.userSlot),currentPick=detectedCurrentPick(state),contextKey=userPickContext(state);if(!Number.isInteger(teams)||teams<2||!Number.isInteger(rounds)||rounds<1||!Number.isInteger(userSlot)||userSlot<1||currentPick>teams*rounds)return;const prep=$("draftPrep"),samePresentation=renderedContextKey===contextKey&&Boolean(cards.querySelector(".card:not(.skeleton)")),resultVisible=samePresentation&&titleOddsReady(renderedTitleEvidenceData),onClock=snakeSlot(currentPick,teams)===userSlot,nextUserPick=nextPickForSlot(currentPick-1,userSlot,teams,rounds);prep.hidden=false;$("prepTitle").textContent=onClock?`You are on the clock · Pick ${currentPick}`:`Preparing for your pick ${nextUserPick}`;if(!resultVisible){$("prepHelp").textContent=onClock?"Calculating your decision brief.":`Calculating options for pick ${nextUserPick}.`;if(!samePresentation)document.querySelector(".section-title h2").textContent="Comparing your options";if(exactFailureContextKey===contextKey)showExactOddsFailure(exactFailureMessage,contextKey);else setTextIfChanged($("status"),"Calculating decision context");return}$("prepHelp").textContent=onClock?"Your decision brief is ready.":`Your options for pick ${nextUserPick} are ready.`;document.querySelector(".section-title h2").textContent=onClock?"Your options at this pick":"Options for your next pick"}
function livePresentationState(latest){
  const enriched=currentLiveState,sameDraft=enriched&&String(enriched.platform||"")===String(latest?.platform||"")&&String(enriched.draftId||"")===String(latest?.draftId||"")&&String(enriched.draftRunId||"")===String(latest?.draftRunId||"")&&Number(enriched.userSlot)===Number(latest?.userSlot);
  if(!sameDraft)return latest;
  return{...enriched,...latest,players:enriched.players,modelVersion:enriched.modelVersion,projectionSeason:enriched.projectionSeason,dataQuality:enriched.dataQuality}
}
function showEspnPickSync(state){resetStableEvaluation();showLiveDraftPosition(state);setTextIfChanged($("status"),"Syncing \u00b7 ESPN");const currentPick=detectedCurrentPick(state);$("prepHelp").textContent=`ESPN has moved to pick ${currentPick}. Syncing the latest completed pick before calculating recommendations…`;$("chance").textContent="—";$("range").textContent="Waiting for ESPN pick history to catch up.";$("freshness").textContent="Syncing ESPN…";cards.removeAttribute("aria-busy");cards.innerHTML='<div class="empty">The ESPN clock is ahead of its pick history. Recommendations will resume automatically as soon as the missing pick appears.</div>'}
function showEspnDraftCountdown(){evaluationAbortController?.abort();evaluationAbortController=null;clearEvaluationTimers();desiredEvaluationKey="";evaluationInFlightKey="";evaluationInFlight=null;renderedPresentationKey="";renderedContextKey="";error.hidden=true;error.textContent="";$("newDraftReady").hidden=true;$("reportReady").hidden=true;$("draftPrep").hidden=false;$("prepTitle").textContent="ESPN draft starts soon";$("prepHelp").textContent="The simulation engine is warm. Recommendations will start automatically when pick 1 goes on the clock.";document.querySelector(".section-title h2").textContent="Waiting for the draft";$("chance").textContent="—";$("range").textContent="No pick has started yet.";$("status").textContent="Waiting for ESPN draft";$("freshness").textContent="Engine ready · starts automatically";$("freshness").title="Draft Goblin prewarmed its workers during the countdown without starting a stale simulation.";cards.removeAttribute("aria-busy");cards.innerHTML='<div class="empty">Ready for pick 1. The exact 10,000-simulation recommendation will begin as soon as ESPN starts the draft.</div>'}
const playerReason=r=>{const p=r.player,f=r.factors||{},mean=Number(p.mean||0),floor=Number(p.floor||mean),ceiling=Number(p.ceiling||mean),spread=Math.max(0,ceiling-floor),need=Number(f.need||0),openStarterSlots=Number(r.requiredStarterSlotsBefore||0),performanceRisk=Number(p.performanceRisk??f.risk??0),stability=String(p.performanceStability||""),flexibilityPenalty=Number(r.starterFlexibilityPenalty??r.rosterCompletionPenalty??0),missingCore=Number(r.missingCoreStarterSlots||0),rolloutPath=Array.isArray(r.conditionalRolloutPath)?r.conditionalRolloutPath:[],rolloutPicks=Array.isArray(r.conditionalRolloutPicks)?r.conditionalRolloutPicks:[],pieces=[];if(openStarterSlots>0)pieces.push(openStarterSlots===1?`Fills your open ${p.position} starter slot`:`Fills one of ${openStarterSlots} open ${p.position} starter slots`);else if(need>=.65)pieces.push(`Fills a strong ${p.position} roster need`);else if(need<=.2)pieces.push(`Depth pick at ${p.position}; your starters reduce its priority`);else pieces.push(`Adds useful ${p.position} depth`);if(flexibilityPenalty>0)pieces.push(`uses FLEX/depth while ${missingCore} core starter slot${missingCore===1?"":"s"} remain open`);if(rolloutPath.length)pieces.push(`best simulated follow-up is ${rolloutPath.map((player,index)=>`${player.name}${rolloutPicks[index]?` at pick ${rolloutPicks[index]}`:""}`).join(" then ")}`);if(stability==="rookie-uncertain")pieces.push(`wider rookie-uncertainty range of ${floor.toFixed(0)}–${ceiling.toFixed(0)} points`);else if(stability==="historically-wide")pieces.push(`historically wider range of ${floor.toFixed(0)}–${ceiling.toFixed(0)} points`);else if(stability==="historically-narrow")pieces.push(`historically narrower range of ${floor.toFixed(0)}–${ceiling.toFixed(0)} points`);else if(spread>mean*.65||performanceRisk>.72)pieces.push(`wide projected range of ${floor.toFixed(0)}–${ceiling.toFixed(0)} points`);else if(spread<mean*.35||performanceRisk<.38)pieces.push(`narrow projected range of ${floor.toFixed(0)}–${ceiling.toFixed(0)} points`);else pieces.push(`projected range of ${floor.toFixed(0)}–${ceiling.toFixed(0)} points`);if(r.availabilityTargetPick&&r.availabilityConfidence!=="low"&&r.nextPickAvailability<.4)pieces.push("unlikely to last until your next turn");else if(r.availabilityTargetPick&&r.availabilityConfidence!=="low"&&r.nextPickAvailability>.75)pieces.push("likely available later");return pieces.join("; ")+"."};
const availabilityCopy=(r,preparing=false)=>{const target=Number(r.availabilityTargetPick),selection=Number(r.nextUserPick);if(!Number.isInteger(target)||target<1)return"This is your final pick; there is no later turn to wait for.";if(preparing)return r.availabilityConfidence==="low"?`Availability at pick ${target} is uncertain (market rank unavailable).`:`${pct(r.nextPickAvailability)} chance this player is available at your pick ${target}.`;if(!r.waitingForUserPick&&Number.isInteger(selection)&&target===selection+1)return`No opponent picks in between — this player will still be there at pick ${target} if you pass.`;if(r.availabilityConfidence==="low")return`Availability uncertain for your next pick ${target} (market rank unavailable)`;return`If you pass on this player: ${pct(r.nextPickAvailability)} chance of reaching your next pick ${target}`};
const floorCeilingCopy=player=>{const mean=Number(player?.mean||0),floor=Number(player?.floor||mean),ceiling=Number(player?.ceiling||mean);return`${floor.toFixed(0)}-point floor · ${ceiling.toFixed(0)}-point ceiling`};
const scoreContribution=value=>{const score=Number(value||0);return`${score>=0?"+":""}${score.toFixed(2)}`};
const driverPills=r=>(r.drivers||[]).map(d=>{const contribution=scoreContribution(d.impact);return`<span class="pill" title="Weighted recommendation-score contribution: ${contribution}">${labels[d.key]||d.key} ${contribution}</span>`}).join("");
const tieCopy=(r,index,recs)=>{if(!r.statisticalTie)return"";const display=Number(r.simulation?.displayTitleTenths),peers=recs.map((candidate,candidateIndex)=>({candidate,candidateIndex})).filter(row=>row.candidate.statisticalTie&&Number(row.candidate.simulation?.displayTitleTenths)===display),rank=peers.findIndex(row=>row.candidateIndex===index)+1,open=Number(r.requiredStarterSlotsBefore||0);if(rank===1&&open>0)return`<span class="pill">required-starter priority · ${open} open ${r.player.position} slot${open===1?"":"s"}</span>`;return rank===1?`<span class="pill">preferred within title-odds tie · tiebreak #1</span>`:`<span class="pill">title-odds difference unmeasurable · tiebreak #${rank}</span>`};
function decisionPoints(r,strongestCeiling,preparing=false){
  const p=r.player,mean=Number(p.mean||0),floor=Number(p.floor||mean),ceiling=Number(p.ceiling||mean),need=Number(r.factors?.need||0),risk=Number(p.performanceRisk??p.risk??0),gain=need>=.8?`Fills an open ${p.position} starter need.`:ceiling===strongestCeiling?`Offers the strongest ceiling in this comparison at ${ceiling.toFixed(0)} points.`:`Adds ${p.position} value with a ${mean.toFixed(0)}-point simulation projection.`,best=need>=.8?`You want to solve ${p.position} now.`:risk>.65?`You want ${p.position} upside and can absorb a ${floor.toFixed(0)}–${ceiling.toFixed(0)}-point range.`:`You value a steadier ${floor.toFixed(0)}–${ceiling.toFixed(0)}-point range and roster flexibility.`;
  return{gain,wait:availabilityCopy(r,preparing),best}
}
function recommendationCardsHtml(recs,preparing,team,showOdds=true,deadlineFallback=false){const strongestCeiling=Math.max(...recs.map(r=>Number(r.player?.ceiling||r.player?.mean||0))),availabilityLabel=preparing?"At your pick":"If you wait";return recs.map((r,i)=>{const titleChance=Number(r.simulation?.championshipProbability||0),delta=team&&r.simulation?titleChance-team.championshipProbability:0,oddsLabel=deadlineFallback?"model estimate at time limit":preparing?"model title estimate":"model title estimate if selected",odds=showOdds?`<div class="odds"><strong>${pct(titleChance)}</strong><span class="odds-label">${oddsLabel}</span>${r.statisticalTie?'<span class="odds-tier">same statistical tier</span>':""}</div>`:"",reason=showOdds?`${playerReason(r)} ${delta>=0?"+":""}${(delta*100).toFixed(1)} points versus the baseline simulated completion path.`:playerReason(r),points=decisionPoints(r,strongestCeiling,preparing);return`<article class="card" data-player-id="${encodeURIComponent(String(r.player.id))}"><span class="option-role">${i===0?"Current lean":"Alternative"}</span><div class="card-top"><div class="player-heading"><span class="pos">${escapeHtml(r.player.position)} · ${escapeHtml(r.player.team||"FA")}</span><div class="name">${escapeHtml(r.player.name)}</div></div>${odds}</div><div class="meta projection-summary">${escapeHtml(sourcePointSummary(r.player))}</div>${projectionSourcesHtml(r.player)}<div class="decision-grid"><div class="decision-point"><strong>What you gain</strong><span>${escapeHtml(points.gain)}</span></div><div class="decision-point"><strong>Floor / ceiling</strong><span>${escapeHtml(floorCeilingCopy(r.player))}</span></div><div class="decision-point"><strong>${availabilityLabel}</strong><span>${escapeHtml(points.wait)}</span></div><div class="decision-point"><strong>Best fit if</strong><span>${escapeHtml(points.best)}</span></div></div><div class="reason">${escapeHtml(reason)}</div><details class="evaluation-details"><summary>How this was evaluated</summary><div class="drivers">${driverPills(r)}${tieCopy(r,i,recs)}</div></details></article>`}).join("")}
const boardNumber=value=>Number.isFinite(Number(value))&&Number(value)>=0?Number(value).toFixed(1):"—";
const boardProjection=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value).toFixed(1):"Unavailable";
const boardMarketRank=value=>{const rank=Number(value);return Number.isFinite(rank)&&rank>0&&rank<500?rank.toFixed(1):"—"};
const boardRange=player=>{const mean=Number(player?.mean),floor=Number(player?.floor),ceiling=Number(player?.ceiling);return Number.isFinite(mean)&&mean>0&&Number.isFinite(floor)&&floor>=0&&Number.isFinite(ceiling)&&ceiling>=floor?`${floor.toFixed(1)}–${ceiling.toFixed(1)}`:"Range unavailable"};
function boardSortValue(row,key){
  if(key==="decisionRank")return row.decisionRank==null?Number.NaN:Number(row.decisionRank);
  if(key==="platform"){const value=Number(row.sourceProjections?.[String(currentLiveState?.platform||"").toLowerCase()]);return Number.isFinite(value)&&value>0?value:Number(row.player?.mean??Number.NEGATIVE_INFINITY)}
  if(["fantasyPros","espn","sleeper","owned"].includes(key))return Number(row.sourceProjections?.[key]??Number.NEGATIVE_INFINITY);
  if(key==="availability"){const raw=row.nextPickAvailability,value=Number(raw),confident=row.availabilityConfidence!=="low";return confident&&raw!=null&&Number.isFinite(value)&&value>=0&&value<=1?value:Number.NaN}
  if(key==="adp"){const value=Number(row.player?.adp);return Number.isFinite(value)&&value>0&&value<500?value:Number.NaN}
  return Number(row.player?.[key]??Number.NEGATIVE_INFINITY)
}
const boardSortAscending=key=>["decisionRank","adp","availability"].includes(key);
function compareBoardRows(a,b,key){
  const aValue=boardSortValue(a,key),bValue=boardSortValue(b,key),aMissing=!Number.isFinite(aValue),bMissing=!Number.isFinite(bValue);
  if(aMissing!==bMissing)return aMissing?1:-1;
  if(key==="decisionRank"&&aMissing&&bMissing){const aProjection=Number(a.player?.mean),bProjection=Number(b.player?.mean),aProjectionMissing=!Number.isFinite(aProjection),bProjectionMissing=!Number.isFinite(bProjection);if(aProjectionMissing!==bProjectionMissing)return aProjectionMissing?1:-1;if(!aProjectionMissing&&aProjection!==bProjection)return bProjection-aProjection}
  if(!aMissing&&aValue!==bValue)return boardSortAscending(key)?aValue-bValue:bValue-aValue;
  return String(a.player?.name||"").localeCompare(String(b.player?.name||""))||String(a.player?.id||"").localeCompare(String(b.player?.id||""))
}
function selectedBoardPositions(){const root=$("boardPosition"),specific=[...(root?.querySelectorAll('input:not([value="ALL"]):checked')||[])];return root?.querySelector('[value="ALL"]')?.checked||!specific.length?undefined:new Set(specific.map(input=>input.value))}
function renderPlayerBoard(){
  if(!boardRows)return;
  const platformKey=String(currentLiveState?.platform||"espn").toLowerCase(),platformLabel=platformKey==="sleeper"?"Sleeper":"ESPN",platformSort=$("boardPlatformSort");
  if(platformSort)platformSort.textContent=`${platformLabel} (model fallback)`;
  const query=String($("boardSearch")?.value||"").trim().toLowerCase(),positions=selectedBoardPositions(),sortKey=$("boardSort")?.value||"decisionRank",evaluationMatchesBoardContext=Boolean(currentLiveState&&renderedContextKey===userPickContext(currentLiveState)),simulated=new Map((evaluationMatchesBoardContext?(renderedEvaluationData?.recommendations||[]):[]).map(item=>[String(item.player.id),item]));
  const rows=currentPlayerBoard.filter(row=>(!positions||positions.has(row.player?.position))&&(!query||`${row.player?.name||""} ${row.player?.team||""}`.toLowerCase().includes(query))).sort((a,b)=>compareBoardRows(a,b,sortKey));
  $("boardCount").textContent=`${rows.length} player${rows.length===1?"":"s"}`;
  requestAnimationFrame(syncBoardScrollMetrics);
  if(!rows.length){boardRows.innerHTML='<tr><td colspan="4">No undrafted players match these filters.</td></tr>';return}
  boardRows.innerHTML=rows.map(row=>{const p=row.player||{},rec=simulated.get(String(p.id)),sources=row.sourceProjections||{},sourceLines=[["Draft Goblin",sources.owned],[platformLabel,sources[platformKey]],["FantasyPros",sources.fantasyPros],...(platformKey!=="sleeper"?[["Sleeper",sources.sleeper]]:[])].filter(([,value])=>Number(value)>0).map(([label,value])=>`<span>${label}: ${boardNumber(value)}</span>`).join(""),exactStopped=exactFailureContextKey&&exactFailureContextKey===renderedContextKey,title=rec?(exactStopped?"Title odds: unavailable":titleOddsReady(renderedTitleEvidenceData)?`Title odds: ${pct(rec.simulation.championshipProbability)}`:"Title odds: calculating"):"Title odds: N/A",availability=Number.isInteger(Number(row.availabilityTargetPick))&&row.availabilityConfidence!=="low"?`${pct(Number(row.nextPickAvailability||0))} to pick ${Number(row.availabilityTargetPick)}`:"Availability uncertain",rangeLabel=p.performanceStability==="rookie-uncertain"?"Rookie-uncertainty range":p.performanceStability==="historically-wide"?"Historically wider floor–ceiling":p.performanceStability==="historically-narrow"?"Historically narrower floor–ceiling":"Floor–ceiling";return`<tr class="${rec?"simulated":""}" data-player-id="${encodeURIComponent(String(p.id))}"><td><div class="board-player"><strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.position)} · ${escapeHtml(p.team||"FA")}</span>${rec?'<span class="board-badge">Simulated eight</span>':""}${row.exclusionReason?`<span class="board-warning">${escapeHtml(row.exclusionReason)}</span>`:""}</div></td><td><div class="board-metric">Simulation: ${boardProjection(p.mean)}</div><div class="board-sources">${sourceLines}</div></td><td><div class="board-metric">${boardRange(p)}</div><span class="board-secondary">${rangeLabel}</span></td><td><div class="board-metric">ADP: ${boardMarketRank(p.adp)}</div><div class="board-secondary">${escapeHtml(availability)}</div><div class="board-secondary">${escapeHtml(title)}</div></td></tr>`}).join("")
}
function syncPlayerBoardWithDraftState(state){
  currentLiveState={...(currentLiveState||{}),...state};
  currentPlayerBoard=removeDraftedBoardCandidates(currentPlayerBoard,state);
  renderPlayerBoard();
}
function requestPlayerBoard(state,sequence){
  const contextKey=userPickContext(state);playerBoardContextKey=contextKey;
  if(playerBoardInFlightKey===contextKey||currentPlayerBoard.length&&renderedContextKey===contextKey)return;
  playerBoardInFlightKey=contextKey;
  const payload={state,userSlot:Number(state.userSlot),strategy:strategy.value,sourceProfile:sourceProfile.value,customWeights:strategy.value==="custom"?customWeights():undefined};
  api("/v1/player-board",{method:"POST",body:JSON.stringify(payload)}).then(data=>{if(sequence!==refreshSequence||playerBoardContextKey!==contextKey)return;currentPlayerBoard=Array.isArray(data?.candidates)?data.candidates:[];renderPlayerBoard()}).catch(()=>{if(sequence===refreshSequence&&playerBoardContextKey===contextKey&&boardRows)boardRows.innerHTML='<tr><td colspan="4">The player board will retry automatically.</td></tr>'}).finally(()=>{if(playerBoardInFlightKey===contextKey)playerBoardInFlightKey=""})
}
const terminalEvaluation=data=>["complete","deadline_fallback","worker_fallback","cancelled"].includes(String(data?.status||""))||data?.simulationStatus==="refined";
const pendingEvaluation=data=>Boolean(data&&!terminalEvaluation(data)&&Number(data.targetIterations||0)>Number(data.iterations||0));
function commitEvaluationUpdate(data,evaluationKey){
  const current=lastEvaluationKey===evaluationKey?lastEvaluationData:null,next=data;
  if(current){
    const currentExact=hasFullTitleOdds(current),nextExact=hasFullTitleOdds(next),currentTerminal=terminalEvaluation(current),nextTerminal=terminalEvaluation(next),sameEvaluation=!current.evaluationId||!next?.evaluationId||String(current.evaluationId)===String(next.evaluationId);
    if(sameEvaluation&&(currentExact&&!nextExact||currentTerminal&&!nextTerminal||!nextExact&&Number(next?.iterations||0)<Number(current.iterations||0)))return current
  }
  lastEvaluationKey=evaluationKey;lastEvaluationData=next;lastEvaluationAt=Date.now();return next
}
function scheduleEvaluationTerminal(data,evaluationKey){clearTimeout(evaluationTerminalTimer);evaluationTerminalTimer=null;evaluationTerminalIdentity="";if(terminalEvaluation(data)&&evaluationKey===desiredEvaluationKey)clearEvaluationTimers()}
function scheduleEvaluationPoll(data,evaluationKey){clearTimeout(evaluationPollTimer);evaluationPollTimer=null;if(!pendingEvaluation(data)||!data.evaluationId||evaluationKey!==desiredEvaluationKey){if(terminalEvaluation(data))clearEvaluationTimers();return}scheduleEvaluationTerminal(data,evaluationKey);const evaluationId=String(data.evaluationId);evaluationPollTimer=setTimeout(async()=>{if(evaluationKey!==desiredEvaluationKey||String(lastEvaluationData?.evaluationId||"")!==evaluationId||terminalEvaluation(lastEvaluationData))return;try{const polled=await api(`/v1/evaluate/${encodeURIComponent(evaluationId)}`,{method:"GET"});if(evaluationKey!==desiredEvaluationKey||String(lastEvaluationData?.evaluationId||"")!==evaluationId||String(polled.evaluationId||"")!==evaluationId||terminalEvaluation(lastEvaluationData))return;lastEvaluationKey=evaluationKey;lastEvaluationData=polled;lastEvaluationAt=Date.now();scheduleEvaluationPoll(polled,evaluationKey);await uiRefresh(false)}catch(cause){if(evaluationKey===desiredEvaluationKey&&String(lastEvaluationData?.evaluationId||"")===evaluationId&&!terminalEvaluation(lastEvaluationData)){scheduleEvaluationPoll(lastEvaluationData,evaluationKey);showEvaluationFailure(cause)}}},500)}
async function api(path,options={}){
  let evaluationKey,payload;
  if(path==="/v1/evaluate"&&options.body){payload={...JSON.parse(options.body),consumer:"gui",clientBuildId:CLIENT_BUILD_ID};options={...options,body:JSON.stringify(payload)};const projectionSignature=evaluationProjectionSignature(payload.state);evaluationKey=JSON.stringify([payload.state?.platform,payload.state?.draftId,payload.state?.draftRunId||"",payload.state?.picks?.map(p=>[p.pickNo,p.playerId,p.slot]),payload.state?.settings,payload.state?.modelVersion,payload.state?.projectionSeason,projectionSignature,payload.userSlot,payload.strategy,payload.sourceProfile,payload.customWeights,payload.positions,payload.iterations,payload.refineIterations,payload.limit,payload.seed,payload.refinementDeadline!==false,payload.consumer,payload.state?.dataQuality]);if(desiredEvaluationKey&&desiredEvaluationKey!==evaluationKey)clearEvaluationTimers();desiredEvaluationKey=evaluationKey;if(evaluationKey===evaluationInFlightKey&&evaluationInFlight)return evaluationInFlight;if(evaluationKey===lastEvaluationKey&&lastEvaluationData){if(terminalEvaluation(lastEvaluationData)||Date.now()-lastEvaluationAt<450)return lastEvaluationData;if(lastEvaluationData.evaluationId){path=`/v1/evaluate/${encodeURIComponent(lastEvaluationData.evaluationId)}`;options={method:"GET"}}}}
  const request=(async()=>{const externalSignal=options.signal,controller=new AbortController(),longRunning=path==="/v1/evaluate"||path==="/v1/draft-report",forwardAbort=()=>controller.abort(),timeout=longRunning?null:setTimeout(()=>controller.abort(),25_000);if(externalSignal?.aborted)controller.abort();else externalSignal?.addEventListener("abort",forwardAbort,{once:true});if(evaluationKey)evaluationAbortController=controller;try{const requestApi=path==="/v1/evaluate"?evaluationApi:localApi,data=await requestApi(path,{...options,signal:controller.signal});if(evaluationKey&&evaluationKey===desiredEvaluationKey){const committed=commitEvaluationUpdate(data,evaluationKey);scheduleEvaluationPoll(committed,evaluationKey);return committed}return data}catch(cause){if(cause?.name==="AbortError"){if(externalSignal?.aborted||longRunning)throw new Error("The request was cancelled because the draft context changed.");throw new Error("The request exceeded its 25-second limit.")}if(/fetch failed|networkerror/i.test(String(cause?.message||cause)))throw new Error("Draft Goblin could not load its bundled engine. Reload the extension, then press refresh.");throw cause}finally{clearTimeout(timeout);externalSignal?.removeEventListener("abort",forwardAbort);if(evaluationAbortController===controller)evaluationAbortController=null}})();if(evaluationKey){evaluationInFlightKey=evaluationKey;evaluationInFlight=request.finally(()=>{if(evaluationInFlightKey===evaluationKey){evaluationInFlightKey="";evaluationInFlight=null}});return evaluationInFlight}return request
}
function startExactEvaluation(contextKey,payload,precomputedRecommendations){
  if(pendingEvaluation(lastEvaluationData)&&lastEvaluationData?.evaluationId&&lastEvaluationKey===desiredEvaluationKey)return null;
  if(exactEvaluationPromise){
    const settling=exactEvaluationPromise;
    if(exactEvaluationContextKey===contextKey&&exactEvaluationAbortRequestedFor!==settling)return settling;
    if(exactEvaluationAbortRequestedFor!==settling){exactEvaluationAbortRequestedFor=settling;evaluationAbortController?.abort()}
    return Promise.resolve(settling).catch(()=>{}).then(()=>{
      if(!exactContextStillCurrent(contextKey))return;
      if(exactEvaluationPromise&&exactEvaluationPromise!==settling)return exactEvaluationContextKey===contextKey?exactEvaluationPromise:startExactEvaluation(contextKey,payload,precomputedRecommendations);
      if(exactEvaluationPromise===settling){exactEvaluationPromise=null;exactEvaluationContextKey="";exactEvaluationAbortRequestedFor=null}
      return startExactEvaluation(contextKey,payload,precomputedRecommendations)
    })
  }
  exactFailureContextKey="";exactFailureMessage="";hideExactOddsFailure();exactEvaluationProgress={contextKey,completed:0,total:10000,activeShards:[],completedShards:[],retryCount:0,startedAt:Date.now(),lastProgressAt:Date.now(),shards:[]};setExactProgressBar(0,10000,{visible:true});let outcome;const request=api("/v1/evaluate",{method:"POST",body:JSON.stringify(payload),precomputedRecommendations,contextKey,onProgress:progress=>showExactProgress(progress,contextKey)});
  exactEvaluationContextKey=contextKey;
  exactEvaluationPromise=request.then(async data=>{outcome=data;if(exactEvaluationContextKey!==contextKey||!exactContextStillCurrent(contextKey))return;if(!hasFullTitleOdds(data)){if(terminalEvaluation(data))showExactOddsFailure("The complete 10,000-simulation result was unavailable. Retry exact odds to start a new calculation.",contextKey);return}exactEvaluationProgress=null;stableRefinedResult={contextKey,data};await persistStableEvaluation()}).catch(cause=>{if(exactEvaluationContextKey===contextKey&&exactContextStillCurrent(contextKey))showExactOddsFailure(cause,contextKey)}).finally(()=>{if(exactEvaluationContextKey!==contextKey)return;exactEvaluationContextKey="";exactEvaluationPromise=null;exactEvaluationAbortRequestedFor=null;if(exactContextStillCurrent(contextKey)&&exactFailureContextKey!==contextKey&&hasFullTitleOdds(outcome))uiRefresh(false)});
  return exactEvaluationPromise
}
function retryExactOdds(){
  const contextKey=exactFailureContextKey;if(!contextKey||!exactContextStillCurrent(contextKey))return Promise.resolve();
  const settling=exactEvaluationPromise;
  exactFailureContextKey="";exactFailureMessage="";exactEvaluationProgress=null;hideExactOddsFailure();setTextIfChanged($("freshness"),"Retrying exact simulations…");
  const restart=()=>{if(!exactContextStillCurrent(contextKey))return;if(exactEvaluationPromise&&exactEvaluationPromise!==settling)return exactEvaluationPromise;if(exactEvaluationPromise===settling){exactEvaluationPromise=null;exactEvaluationContextKey=""}lastEvaluationKey="";lastEvaluationData=undefined;desiredEvaluationKey="";setTextIfChanged($("freshness"),"0 / 10,000 exact simulations");return uiRefresh(false)};
  return settling?Promise.resolve(settling).catch(()=>{}).then(restart):restart()
}
function warmDefaultEngineInputs(){
  warmPersistentLocalEngineWorkers().catch(()=>{});
  baselinePromise??=api("/v1/catalog");
  const season=new Date().getFullYear(),fpKey=`${season}:PPR`;
  if(!draftGoblinPromises.has(fpKey))draftGoblinPromises.set(fpKey,{at:Date.now(),promise:api(`/v1/projections/draftgoblin?season=${season}&scoring=PPR`).catch(()=>({available:false,players:[]}))});
  if(!fantasyProsPromises.has(fpKey))fantasyProsPromises.set(fpKey,{at:Date.now(),promise:api(`/v1/projections/fantasypros?season=${season}&scoring=PPR`).catch(()=>({available:false,players:[]}))});
  if(!sleeperProjectionPromises.has(fpKey))sleeperProjectionPromises.set(fpKey,api(`/v1/projections/sleeper?season=${season}&scoring=PPR`).catch(()=>({available:false,players:[]})));
}
warmDefaultEngineInputs();
const clearDraftReport=()=>{reportAbortController?.abort();reportAbortController=null;$("reportReady").hidden=true;$("reportLink").removeAttribute("href");reportPromise=null;reportKey=""};
const completedDraftKey=state=>`${state.platform}:${state.draftId}:${state.draftRunId||"default"}`;
async function completedDraftWasOpened(state){const key=completedDraftKey(state),stored=await chrome.storage.local.get("openedDraftReports");return Array.isArray(stored.openedDraftReports)&&stored.openedDraftReports.includes(key)}
async function markCompletedDraftOpened(state){const key=completedDraftKey(state),stored=await chrome.storage.local.get("openedDraftReports"),opened=Array.isArray(stored.openedDraftReports)?stored.openedDraftReports:[];if(!opened.includes(key))await chrome.storage.local.set({openedDraftReports:[...opened.slice(-49),key]})}
function showDraftHandled(){clearDraftReport();$("newDraftReady").hidden=false;$("draftPrep").hidden=true;$("status").textContent="Waiting for a draft";$("chance").textContent="—";$("range").textContent="Open an ESPN or Sleeper snake draft.";$("freshness").textContent="";cards.innerHTML='<div class="empty">Draft complete. Start a new draft when you are ready.</div>'}
async function startNewDraft(){resetDraftPresentation();draftGoblinPromises.clear();fantasyProsPromises.clear();sleeperProjectionPromises.clear();await chrome.runtime.sendMessage({type:"START_NEW_DRAFT"}).catch(()=>null);$("newDraftReady").hidden=true;$("draftPrep").hidden=true;$("status").textContent="Waiting for a new draft";$("chance").textContent="—";$("range").textContent="Open a new ESPN or Sleeper snake draft.";$("freshness").textContent="";cards.innerHTML='<div class="empty">Waiting for a new draftboard.</div>'}
const platformName=value=>String(value||"").toLowerCase()==="espn"?"ESPN":String(value||"").toLowerCase()==="sleeper"?"Sleeper":"draft";
function showConnectionHealth(health){const platform=platformName(health?.platform),retrying=health?.phase==="retrying",failed=Boolean(health?.error);showSetupCoach(false);setConnectionStage("draft");clearDraftReport();$("newDraftReady").hidden=true;$("draftPrep").hidden=true;setTextIfChanged($("chance"),"—");setTextIfChanged($("status"),retrying?`Reconnecting to ${platform}…`:`Connecting to ${platform}…`);setTextIfChanged($("range"),failed?health.error:`Attaching to the open ${platform} draft automatically.`);setTextIfChanged($("freshness"),retrying?`Retry attempt ${Math.max(1,Number(health.attempt||1))}`:"Verifying live draft data…");setHtmlIfChanged(cards,`<div class="empty">${failed?"Draft Goblin will keep retrying automatically.":"Recommendations will appear as soon as the draft is verified."}</div>`)}
async function superviseDraftConnection(){if(connectionEnsureInFlight)return connectionEnsureInFlight;connectionEnsureInFlight=chrome.runtime.sendMessage({type:"ENSURE_ACTIVE_DRAFT"}).catch(cause=>({ok:false,phase:"retrying",error:cause?.message||"Draft adapter could not be started."})).finally(()=>{connectionEnsureInFlight=null});return connectionEnsureInFlight}
async function findState(sequence=refreshSequence){
  const stored=await chrome.storage.session.get(null);
  if(sequence!==refreshSequence)return null;
  const state=stored["draft:"+stored.activeDraftTab],health=stored["draftHealth:"+stored.activeDraftTab];
  if(stored.draftError&&(!health||health.phase==="error")){
    clearDraftReport();
    if(renderedEvaluationData&&cards.querySelector(".card:not(.skeleton)")){
      error.hidden=true;
      error.textContent="";
      $("status").textContent="Live · reconnecting";
      $("freshness").textContent="Last verified result · reconnecting";
      $("freshness").title="The displayed recommendations are retained while live draft data reconnects.";
      return null
    }
    cards.removeAttribute("aria-busy");
    setHtmlIfChanged(cards,'<div class="empty">Waiting for verified live draft data.</div>');
    $("chance").textContent="—";
    setTextIfChanged($("range"),"Recommendations are not ready.");
    setTextIfChanged($("status"),"Recommendations unavailable");
    setTextIfChanged($("freshness"),"Waiting for live draft data");
    $("freshness").title="";
    error.hidden=false;
    setTextIfChanged(error,stored.draftError);
    return null
  }
  if(health?.phase==="retrying"){
    error.hidden=true;
    error.textContent="";
    if(renderedEvaluationData&&cards.querySelector(".card:not(.skeleton)")){
      $("status").textContent="Live · reconnecting";
      $("freshness").textContent="Last verified result · reconnecting";
      $("freshness").title="The displayed recommendations are retained while live draft data reconnects.";
      return null
    }
    showConnectionHealth(health);
    return null
  }
  if(state){
    const expected=Number(state.settings?.teams)*Number(state.settings?.rounds),complete=expected>0&&state.picks?.length>=expected;
    if(complete&&await completedDraftWasOpened(state)){
      if(sequence!==refreshSequence)return null;
      if($("newDraftReady").hidden)showDraftHandled();
      return null
    }
  }
  if(!state){
    if(health&&["attaching","connecting","retrying","error"].includes(health.phase)){error.hidden=true;error.textContent="";showConnectionHealth(health);return null}
    clearDraftReport();
    showSetupCoach(true);
    setConnectionStage("idle");
    $("status").textContent="Waiting for a draft";
    $("chance").textContent="—";
    $("range").textContent="Open an ESPN or Sleeper snake draft.";
    $("freshness").textContent="";
    $("freshness").title="";
    $("draftPrep").hidden=true;
    cards.removeAttribute("aria-busy");
    cards.innerHTML='<div class="empty">Recommendations appear after the draft state is verified.</div>'
  }
  return state
}
async function enrichState(state){
  baselinePromise??=api("/v1/catalog");
  const season=Number(state.projectionSeason||new Date().getFullYear()),reception=Number(state.settings?.scoring?.reception||0),scoring=reception>=.75?"PPR":reception>=.25?"HALF":"STD",fpKey=`${season}:${scoring}`;
  const cachedDraftGoblin=draftGoblinPromises.get(fpKey);if(!cachedDraftGoblin||Date.now()-cachedDraftGoblin.at>=SOURCE_CACHE_TTL)draftGoblinPromises.set(fpKey,{at:Date.now(),promise:api(`/v1/projections/draftgoblin?season=${season}&scoring=${scoring}`).catch(()=>({available:false,players:[]}))});
  const cachedFantasyPros=fantasyProsPromises.get(fpKey);if(!cachedFantasyPros||Date.now()-cachedFantasyPros.at>=SOURCE_CACHE_TTL)fantasyProsPromises.set(fpKey,{at:Date.now(),promise:api(`/v1/projections/fantasypros?season=${season}&scoring=${scoring}`).catch(()=>({available:false,players:[]}))});
  if(state.platform==="espn"&&!sleeperProjectionPromises.has(fpKey))sleeperProjectionPromises.set(fpKey,api(`/v1/projections/sleeper?season=${season}&scoring=${scoring}`).catch(()=>({available:false,players:[]})));
  const[baseline,draftGoblinFeed,fantasyPros,sleeper]=await Promise.all([baselinePromise,draftGoblinPromises.get(fpKey).promise,fantasyProsPromises.get(fpKey).promise,state.platform==="espn"?sleeperProjectionPromises.get(fpKey):Promise.resolve({available:false,players:[]})]);
  const enrichedState=enrichLiveDraftState({state,baseline,draftGoblinFeed,fantasyPros,sleeper,projectionDriver:projectionDriver.value});
  projectionDisplayIndexes={platform:buildPlayerIdentityIndex(state.players||[]),draftGoblin:buildPlayerIdentityIndex(enrichedState.players||[]),sleeper:buildPlayerIdentityIndex(sleeper.players||[]),fantasyPros:buildPlayerIdentityIndex(fantasyPros.players||[])};projectionDisplayReady=true;
  const platformName=state.platform==="espn"?"ESPN":"Sleeper",platformOption=$("projectionPlatformOption");if(platformOption)platformOption.textContent=`Current draft site (${platformName})`;
  return enrichedState;
}
function completedDraftFingerprint(state){return JSON.stringify([CLIENT_BUILD_ID,state.platform,state.draftId,state.draftRunId||"default",Number(state.userSlot),state.settings,state.modelVersion,state.projectionSeason,state.picks.map(pick=>[pick.pickNo,pick.playerId,pick.slot]),state.players.map(player=>[player.id,Number(player.mean||0).toFixed(3),Number(player.risk||0).toFixed(3),Number(player.platformProjection||0).toFixed(3),player.eligibleForRecommendation!==false,player.distribution?.provenance?.modelVersion||"",player.distribution?.quantiles?.map(point=>point.value)||null,player.availability||null]),(state.recommendationHistory||[]).map(row=>[row.pickNo,row.simulationStatus,row.iterations,row.capturedAt])])}
const recommendationHistoryKey=state=>`recommendationHistory:${state.platform}:${state.draftId}:${state.draftRunId||"default"}`;
async function loadRecommendationHistory(state){const key=recommendationHistoryKey(state),stored=await chrome.storage.local.get(key);if(Array.isArray(stored[key]))return stored[key];const legacy=await chrome.storage.session.get(key);if(!Array.isArray(legacy[key]))return[];await chrome.storage.local.set({[key]:legacy[key]});return legacy[key]}
function serializeRecommendationHistory(state,operation){const key=recommendationHistoryKey(state),prior=recommendationHistoryWrites.get(key)||Promise.resolve(),next=prior.catch(()=>{}).then(operation).finally(()=>{if(recommendationHistoryWrites.get(key)===next)recommendationHistoryWrites.delete(key)});recommendationHistoryWrites.set(key,next);return next}
const flushRecommendationHistory=state=>recommendationHistoryWrites.get(recommendationHistoryKey(state))||Promise.resolve();
async function recordRecommendationSnapshot(state,data,recs,currentPick,preparing){if(preparing||!recs.length||!hasFullTitleOdds(data))return;return serializeRecommendationHistory(state,async()=>{const key=recommendationHistoryKey(state),history=await loadRecommendationHistory(state),sourceValues=player=>Object.fromEntries((player.projectionConsensus?.sources||[]).filter(source=>source.available&&Number(source.points)>0).map(source=>[source.key,Number(source.points)])),snapshot={pickNo:Number(currentPick),capturedAt:Date.now(),status:data.status,simulationStatus:data.simulationStatus,refinementOutcome:data.refinementOutcome||"complete",iterations:Number(data.iterations||0),targetIterations:Number(data.targetIterations||0),responseMs:Number(data.responseMs||0),refinementMs:Number(data.refinementMs||0),decisionLens:strategy.value,leanPlayerId:String(recs[0].player.platformPlayerId||recs[0].player.id),evidenceStatus:recs[0].statisticalTie?"close-call":recs[0].simulation?.evidenceStatus||"simulation-separated",candidates:recs.map((rec,index)=>({rank:index+1,playerId:String(rec.player.platformPlayerId||rec.player.id),modelPlayerId:String(rec.player.id),name:rec.player.name,position:rec.player.position,team:rec.player.team||"FA",projectedPoints:Number(rec.player.mean||0),floor:Number(rec.player.floor||0),ceiling:Number(rec.player.ceiling||0),sourceProjections:sourceValues(rec.player),titleChance:Number(rec.simulation?.championshipProbability||0),planScore:Number(rec.planScore||0),expectedWeeklyDelta:Number(rec.expectedWeeklyDelta||0),nextPickAvailability:Number(rec.nextPickAvailability||0)}))},existing=history.findIndex(row=>Number(row.pickNo)===Number(currentPick));if(existing>=0)history[existing]=snapshot;else history.push(snapshot);history.sort((a,b)=>a.pickNo-b.pickNo);await chrome.storage.local.set({[key]:history})})}
async function completedDraftReport(state){
  await flushRecommendationHistory(state);
  state={...state,recommendationHistory:await loadRecommendationHistory(state)};
  const key=completedDraftFingerprint(state);
  if(reportKey!==key){
    reportAbortController?.abort();
    reportKey=key;
    const controller=new AbortController();reportAbortController=controller;
    const request=api("/v1/draft-report",{method:"POST",body:JSON.stringify({state,userSlot:Number(state.userSlot),iterations:10000}),signal:controller.signal});
    const cached=request.catch(cause=>{if(reportKey===key&&reportPromise===cached){reportKey="";reportPromise=null}throw cause}).finally(()=>{if(reportAbortController===controller)reportAbortController=null});
    reportPromise=cached
  }
  return reportPromise
}
async function refresh(sequence=refreshSequence){
  let stateFromStorage=await findState(sequence);
  if(sequence!==refreshSequence||!stateFromStorage)return;
  try{
    stateFromStorage=await resolveUserSlot(stateFromStorage);
    if(sequence!==refreshSequence||!stateFromStorage)return;
    showSetupCoach(false);
    setConnectionStage("slot");
    const state=await enrichState(stateFromStorage);
    if(sequence!==refreshSequence)return;
    currentLiveState=state;
    requestPlayerBoard(state,sequence);
    showSetupCoach(false);
    setConnectionStage("slot");
    slot.value=state.userSlot;
    $("slotHelp").textContent=state.manualUserSlot?"Manual fallback for this draft · automatic detection remains preferred":"Detected from "+platformName(state.platform);
    error.hidden=true;
    error.textContent="";
    if(waitingForEspnDraftStart(state)){showEspnDraftCountdown();return}
    if(!pickHistoryIsCurrent(state)){showEspnPickSync(state);return}
    const expectedPicks=Number(state.settings.teams)*Number(state.settings.rounds);
    const draftComplete=expectedPicks>0&&state.picks.length>=expectedPicks;
    const platformMarkedComplete=String(state.draftStatus||"").toLowerCase()==="complete";
    if(platformMarkedComplete&&!draftComplete){
      setTextIfChanged($("decisionAuthority"),"Final roster report");
      resetStableEvaluation();
      $("reportReady").hidden=true;
      $("draftPrep").hidden=false;
      $("prepTitle").textContent="Syncing final draft picks";
      $("prepHelp").textContent=`Sleeper has marked the draft complete. Waiting for ${expectedPicks-state.picks.length} final pick${expectedPicks-state.picks.length===1?"":"s"} before building your report.`;
      document.querySelector(".section-title h2").textContent="Draft finishing";
      $("chance").textContent="\u2014";
      $("range").textContent="No live recommendation will run after the platform marks the draft complete.";
      $("status").textContent="Draft finishing";
      $("freshness").textContent=`Synced ${state.picks.length} of ${expectedPicks} picks`;
      $("freshness").title="The final Sleeper pick history is still propagating.";
      cards.removeAttribute("aria-busy");
      cards.innerHTML='<div class="empty">Final picks are syncing. The completed-draft report will start automatically when the full board arrives.</div>';
      return
    }
    if(draftComplete){
      setTextIfChanged($("decisionAuthority"),"Final roster report");
      const projectionCoverage=completedDraftProjectionCoverage(state);
      if(!projectionCoverage.ready){resetStableEvaluation();$("draftPrep").hidden=false;$("prepTitle").textContent="Verifying player projections";$("prepHelp").textContent=`Draft report paused until projections are available (${projectionCoverage.projected} of ${projectionCoverage.eligible} drafted QB/RB/WR/TE players).`;$("chance").textContent="—";$("range").textContent="No title rank will be shown from an incomplete projection catalog.";$("status").textContent="Projection sync";$("freshness").textContent="Checking projections";setTimeout(()=>uiRefresh(true),1000);return}
      resetStableEvaluation();
      const result=await completedDraftReport(state);
      if(sequence!==refreshSequence)return;
      const report=result.report;
      $("draftPrep").hidden=true;
      $("reportReady").hidden=false;
      $("reportLink").href=result.url;
      $("chance").textContent=completedPct(report.userTeam.finishProbabilities[0]);
      $("range").textContent=withEqualOddsBaseline("Final roster title chance · #"+report.userTeam.titleRank+" of "+report.teams+" by title odds · "+report.userTeam.points.toFixed(1)+" projected points/week",report.teams);
      $("status").textContent="Draft complete";
      $("freshness").textContent=report.iterations.toLocaleString()+" simulations";
      $("freshness").title="";
      setExactProgressBar(0,10000);
      setTextIfChanged($("decisionAuthority"),"Final roster report");
      setDecisionBrief({lean:"Draft complete",evidence:`${report.iterations.toLocaleString()} simulations complete`});
      document.querySelector(".section-title h2").textContent="Draft report ready";
      cards.removeAttribute("aria-busy");
      cards.innerHTML="<div class=\"empty\">Full finish probabilities and every team’s projected weekly scoring are in your draft report.</div>";
      return
    }
    $("reportReady").hidden=true;
    const userRosterComplete=state.picks.filter(pick=>Number(pick.slot)===Number(state.userSlot)).length>=Number(state.settings.rounds);
    if(userRosterComplete){
      setTextIfChanged($("decisionAuthority"),"Final roster report");
      resetStableEvaluation();
      const prep=$("draftPrep");
      prep.hidden=false;
      $("prepTitle").textContent="Your roster is complete";
      $("prepHelp").textContent="Waiting for the final league picks, then your draft report will be ready.";
      document.querySelector(".section-title h2").textContent="Draft finishing";
      $("chance").textContent="—";
      $("range").textContent="Final title chance will be calculated after every team finishes.";
      $("status").textContent="Draft finishing";
      $("freshness").textContent="Waiting for final league picks";
      $("freshness").title="";
      cards.removeAttribute("aria-busy");
      cards.innerHTML="<div class=\"empty\">Your picks are complete. The report will appear automatically when the draft ends.</div>";
      return
    }
    showLiveDraftPosition(state);
    const contextKey=activeUserPickContext(state);
    await restoreStableEvaluation(contextKey);
    if(sequence!==refreshSequence)return;
    let data;
    const stableAvailable=stableRefinedResult?.contextKey===contextKey?removeUnavailableRecommendationsBase(stableRefinedResult.data,state):null;
    const lastRefinedRecommendation=stableRefinedResult?.contextKey===contextKey?stableRefinedResult.data.recommendations?.[0]:null;
    const lastRefinedProjection=lastRefinedRecommendation?.simulation||lastRefinedRecommendation?.teamSimulation||null;
    const stableData=stableAvailable?filterRecommendationsByPositions(stableAvailable,selectedPositions()):null;
    const stableMinimum=stableAvailable?Math.min(3,stableRefinedResult.data.recommendations?.length||0):0;
    if(stableData&&(stableAvailable.recommendations||[]).length>=stableMinimum){
      data=stableData
    }else{
      if(stableData)stableRefinedResult=null;
      if(refinementAnchor?.contextKey!==contextKey)refinementAnchor={contextKey,state};
      const evaluationPayload={state:refinementAnchor.state,userSlot:Number(state.userSlot),strategy:strategy.value,sourceProfile:sourceProfile.value,refinementDeadline:false,customWeights:strategy.value==="custom"?customWeights():undefined,positions:selectedPositions(),iterations:32,refineIterations:10000,limit:RECOMMENDATION_LIMIT};
      const reusablePreliminary=exactEvaluationContextKey===contextKey&&renderedContextKey===contextKey&&!hasFullTitleOdds(renderedTitleEvidenceData)?renderedEvaluationData:null;
      if(reusablePreliminary)data=filterRecommendationsByPositions(removeUnavailableRecommendationsBase(reusablePreliminary,state),selectedPositions());
      else{const controller=new AbortController();quickEvaluationAbortController=controller;try{data=await localApi("/v1/quick-evaluate",{method:"POST",body:JSON.stringify(evaluationPayload),signal:controller.signal})}finally{if(quickEvaluationAbortController===controller)quickEvaluationAbortController=null}}
      if(sequence!==refreshSequence)return;
      consecutiveEvaluationFailures=0;
      if(hasFullTitleOdds(data)){stableRefinedResult={contextKey,data};await persistStableEvaluation();if(sequence!==refreshSequence)return}else if(exactFailureContextKey!==contextKey)startExactEvaluation(contextKey,evaluationPayload,data.recommendations);
    }
    const titleEvidenceData=stableRefinedResult?.contextKey===contextKey?stableRefinedResult.data:data;
    data=removeUnavailableRecommendations(data,state);
    if(sequence!==refreshSequence)return;
    const recs=data.recommendations||[];
    const sourceRecs=stableRefinedResult?.data?.recommendations||recs;
    const first=recs[0]||sourceRecs[0];
    const team=first?.teamSimulation||first?.simulation;
    if(!team)throw new Error("Title simulation did not return a result.");
    renderedEvaluationData=data;
    renderedTitleEvidenceData=titleEvidenceData;
    const currentPick=detectedCurrentPick(state);
    const preparing=snakeSlot(currentPick,Number(state.settings.teams))!==Number(state.userSlot);
    const target=recs[0]?.availabilityTargetPick,nextLiveUserPick=nextPickForSlot(currentPick-1,Number(state.userSlot),Number(state.settings.teams),Number(state.settings.rounds)),finalUserPick=!preparing&&(!Number.isInteger(Number(target))||Number(target)<1);
    const personalDraftComplete=preparing&&(recs[0]?.nextUserPick==null||!Number.isFinite(Number(recs[0]?.nextUserPick)));
    const deadlineFallback=titleEvidenceData.status==="deadline_fallback"||titleEvidenceData.refinementOutcome==="deadline_fallback",oddsReady=titleOddsReady(titleEvidenceData),waitingForOdds=!oddsReady;
    const displayProjection=oddsReady?(first?.simulation||team):lastRefinedProjection;
    const presentationKey=JSON.stringify([contextKey,preparing,waitingForOdds,deadlineFallback,recs.map(rec=>String(rec.player.id)),selectedPositions()||["ALL"]]);
    if(presentationKey===renderedPresentationKey&&cards.querySelector(".card:not(.skeleton)")){
      $("draftPrep").hidden=false;
      setRecommendationStatus(state,waitingForOdds);
      showSimulationFreshness(titleEvidenceData);
      return
    }
    const prep=$("draftPrep");
    prep.hidden=false;
    $("prepTitle").textContent=personalDraftComplete?"Your roster is complete":preparing?"Preparing for your pick "+(nextLiveUserPick||recs[0]?.nextUserPick||target):`You are on the clock · Pick ${currentPick}`;
    $("prepHelp").textContent=personalDraftComplete?"Waiting for the final league picks, then your draft report will be ready.":deadlineFallback?"The complete simulation was unavailable, so no provisional lean is shown.":waitingForOdds?"Title odds will appear when all 10,000 simulations finish.":preparing?"These options are evaluated as if they remain available at your pick; waiting odds are shown separately.":finalUserPick?"This is your final pick. Compare the remaining tradeoffs now.":"Compare the current lean with seven alternatives and decide which tradeoff fits your draft.";
    document.querySelector(".section-title h2").textContent=preparing?"Options for your next pick":"Your options at this pick";
    $("chance").textContent=displayProjection?pct(displayProjection.championshipProbability):"—";
    const requiredSpecialists=["K","DST"].filter(position=>Number(state.settings.slots?.[position]||0)>0),specialistCompletion=requiredSpecialists.length?"; empty "+requiredSpecialists.join("/")+" slots use waiver-replacement value":"";
    $("range").textContent=oddsReady?withEqualOddsBaseline("Projected title chance with the top displayed pick after simulated draft completion"+specialistCompletion+" · "+Number(data.iterations).toLocaleString()+" simulations",state.settings.teams):"Title chance will appear after all 10,000 simulations finish.";
    cards.removeAttribute("aria-busy");
    if(recs.length)cards.innerHTML=recommendationCardsHtml(recs,preparing,team,oddsReady,deadlineFallback);
    else cards.innerHTML="<div class=\"empty\">No refined recommendations match the selected position filters.</div>";
    if(first){const filteredPositions=selectedPositions(),filteredLabel=filteredPositions?.length?`${filteredPositions.join("/")}-only lean`:`${oddsReady?"Current":"Projection"} lean`,evidence=oddsReady?(first.statisticalTie?"Close call":String(first.simulation?.evidenceStatus||"").includes("strategy")?"Lens-preferred":"Simulation-separated"):"Projection-ranked · 10,000 simulations running";setDecisionBrief({lean:`${filteredLabel}: ${first.player.name}`,evidence:filteredPositions?.length?`Position-filtered · ${evidence}`:evidence})}
    renderedPresentationKey=presentationKey;
    renderedContextKey=contextKey;
    renderPlayerBoard();
    setRecommendationStatus(state,waitingForOdds);
    showSimulationFreshness(titleEvidenceData);
    if(recs.length){setConnectionStage("ready");if(!tutorialCompleted&&!tutorialActive)beginTutorial()}
    consecutiveEvaluationFailures=0;
    recordRecommendationSnapshot(state,data,recs,currentPick,preparing).catch(()=>{})
  }catch(cause){
    if(sequence!==refreshSequence)return;
    showEvaluationFailure(cause)
  }
}
function uiRefresh(showLoading=false,{invalidate=false}={}){
  if(invalidate)refreshSequence++;
  refreshQueued=true;
  queuedShowLoading=queuedShowLoading||showLoading;
  if(refreshActive)return refreshPromise
  refreshActive=true;
  refreshPromise=(async()=>{
    while(refreshQueued){
      refreshQueued=false;
      const loading=queuedShowLoading;
      queuedShowLoading=false;
      const sequence=refreshSequence;
      if(loading)setLoading();
      await refresh(sequence);
      if(sequence!==refreshSequence)continue;
      if(cards.querySelector(".skeleton"))continue;
      cards.removeAttribute("aria-busy");
      const renderedCards=cards.querySelectorAll(".card:not(.skeleton)");
      if(!renderedCards.length)continue;
      const recByPlayerId=recommendationByPlayerId(renderedEvaluationData);
      const team=renderedEvaluationData?.recommendations?.[0]?.teamSimulation;
      if(!team)continue;
      renderedCards.forEach(card=>{
        if(card.querySelector?.(".reason"))return;
        const rec=recByPlayerId.get(decodeURIComponent(card.dataset.playerId||""));
        if(!rec)return;
        const delta=rec.simulation?rec.simulation.championshipProbability-team.championshipProbability:0;
        const reason=document.createElement("div");
        reason.className="reason";
        reason.textContent=playerReason(rec)+" "+(delta>=0?"+":"")+(delta*100).toFixed(1)+" points versus completing the draft without targeting this player.";
        card.append(reason)
      })
    }
  })().finally(()=>{refreshActive=false;refreshPromise=null;if(refreshQueued)uiRefresh(false)});
  return refreshPromise
}
const scheduleRefresh=()=>{refreshSequence++;clearTimeout(controlTimer);setLoading({preserveExisting:true});controlTimer=setTimeout(()=>uiRefresh(false),60)};
function applyStoredControls(v={}){client={installationId:v.installationId||"anonymous"};tutorialCompleted=v[TUTORIAL_STORAGE_KEY]===TUTORIAL_VERSION;strategy.value=v.strategy||DEFAULT_STRATEGY;projectionDriver.value=PROJECTION_DRIVERS.includes(v.projectionDriver)?v.projectionDriver:DEFAULT_PROJECTION_DRIVER;if(v.refinementMode==="refined")refinementMode.value="refined";if(v.sourceProfile)sourceProfile.value=v.sourceProfile;const weights=strategy.value==="custom"&&v.customWeights?{...defaults,...v.customWeights}:activePresetWeights();for(const input of weightRoot.querySelectorAll("[data-weight]")){input.value=Math.round(Number(weights[input.dataset.weight]??defaults[input.dataset.weight])*100);input.nextElementSibling.value=(Number(weights[input.dataset.weight]??defaults[input.dataset.weight])).toFixed(2)}resetPositionFilter();explainControls()}
strategy.addEventListener("change",()=>{syncProfileWeightDisplay();explainControls();chrome.storage.local.set({strategy:strategy.value,...(strategy.value==="custom"?{customWeights:customWeights()}:{})});scheduleRefresh()});
weightRoot.addEventListener("input",event=>{if(event.target.matches("[data-weight]")){event.target.nextElementSibling.value=(Number(event.target.value)/100).toFixed(2);strategy.value="custom";chrome.storage.local.set({strategy:"custom",customWeights:customWeights()});explainControls();scheduleRefresh()}});
sourceProfile.addEventListener("change",()=>{syncProfileWeightDisplay();explainControls();chrome.storage.local.set({sourceProfile:sourceProfile.value});scheduleRefresh()});
projectionDriver.addEventListener("change",()=>{chrome.storage.local.set({projectionDriver:projectionDriver.value});resetDraftPresentation();scheduleRefresh()});
refinementMode.addEventListener("change",()=>{explainControls();chrome.storage.local.set({refinementMode:refinementMode.value});scheduleRefresh()});
positionRoot.addEventListener("change",event=>{const all=positionRoot.querySelector('[value="ALL"]'),specific=[...positionRoot.querySelectorAll('input:not([value="ALL"])')];if(event.target===all&&all.checked)specific.forEach(input=>input.checked=false);if(event.target!==all&&event.target.checked)all.checked=false;if(!all.checked&&!specific.some(input=>input.checked))all.checked=true;resetPositionEvaluation();clearTimeout(controlTimer);controlTimer=setTimeout(()=>uiRefresh(false),0)});
chrome.storage.local.remove(["sleeperCatalog","sleeperCatalogAt","positionFilter"]);
chrome.storage.local.get(["strategy","projectionDriver","sourceProfile","refinementMode","installationId","customWeights",TUTORIAL_STORAGE_KEY]).then(async v=>{applyStoredControls(v);await superviseDraftConnection();uiRefresh(true)});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==="local"&&changes.projectionFeedCacheV1){draftGoblinPromises.clear();fantasyProsPromises.clear();sleeperProjectionPromises.clear();resetDraftPresentation();scheduleRefresh();return}
  if(area!=="session")return;
  if(changes.activeDraftTab){resetDraftPresentation();resetPositionFilter();uiRefresh(true);return}
  if(changes.draftError){uiRefresh(!stableRefinedResult,{invalidate:true});return}
  chrome.storage.session.get("activeDraftTab").then(({activeDraftTab})=>{
    const change=changes[`draft:${activeDraftTab}`];if(!change)return;
    const oldState=change.oldValue||{},latest=change.newValue||{},newDraft=oldState.platform!==latest.platform||String(oldState.draftId||"")!==String(latest.draftId||"")||String(oldState.draftRunId||"")!==String(latest.draftRunId||""),picksChanged=JSON.stringify(oldState.picks||[])!==JSON.stringify(latest.picks||[]),draftPhaseChanged=String(oldState.draftStatus||"")!==String(latest.draftStatus||""),windowChanged=newDraft||recommendationWindowKey(oldState)!==recommendationWindowKey(latest);
    const pickOrClockChanged=picksChanged||Number(oldState.currentPickNo)!==Number(latest.currentPickNo);
    if(newDraft||picksChanged||draftPhaseChanged){
      if(newDraft)resetPositionFilter();
      resetDraftPresentation({preservePlayerBoard:!newDraft&&picksChanged});
      if(!newDraft&&picksChanged)syncPlayerBoardWithDraftState(latest);
    }
    if(pickOrClockChanged&&!pickHistoryIsCurrent(latest)){if(!newDraft&&!picksChanged)resetDraftPresentation();showEspnPickSync(latest);return}
    // Session draft snapshots contain platform players, while rendered decision contexts
    // use their enriched projections. Reusing a raw clock-only snapshot here makes a
    // completed exact result look context-stale and changes ready copy back to calculating.
    if(pickOrClockChanged)showLiveDraftPosition(livePresentationState(latest));
    if(windowChanged||picksChanged||draftPhaseChanged){if(!newDraft&&!picksChanged&&!draftPhaseChanged)refreshSequence++;setLoading();uiRefresh(false)}
  })
});
const superviseAndRefresh=()=>{superviseDraftConnection();if(!stableRefinedResult&&!exactEvaluationPromise&&!pendingEvaluation(lastEvaluationData))uiRefresh(false)};
setInterval(superviseAndRefresh,500);document.addEventListener("visibilitychange",superviseAndRefresh);
async function activeCompletedDraft(){const stored=await chrome.storage.session.get(null),state=stored[`draft:${stored.activeDraftTab}`];if(!state)return null;const expected=Number(state.settings?.teams)*Number(state.settings?.rounds);return expected>0&&state.picks?.length>=expected?state:null}
async function suppressOpenedDraftReport(){const state=await activeCompletedDraft();if(state&&await completedDraftWasOpened(state))showDraftHandled()}
$("reportLink").addEventListener("click",()=>{$("reportLink").textContent="Reopen draft report"});
$("dismissReport").addEventListener("click",async()=>{const state=await activeCompletedDraft();if(!state)return;await markCompletedDraftOpened(state);showDraftHandled()});
$("refreshDraft").addEventListener("click",startNewDraft);
$("retryExactOdds").addEventListener("click",retryExactOdds);
$("openEspn").addEventListener("click",()=>chrome.tabs.create({url:"https://fantasy.espn.com/football/mockdraftlobby"}));
$("openSleeper").addEventListener("click",()=>chrome.tabs.create({url:"https://sleeper.com/drafts"}));
function activateWorkspaceTab(name){
  const board=name==="board";$("decisionTab").classList.toggle("active",!board);$("boardTab").classList.toggle("active",board);$("decisionTab").setAttribute("aria-selected",String(!board));$("boardTab").setAttribute("aria-selected",String(board));$("decisionPanel").hidden=board;$("boardPanel").hidden=!board;if(board)renderPlayerBoard()
}
$("decisionTab").addEventListener("click",()=>activateWorkspaceTab("decision"));
$("boardTab").addEventListener("click",()=>activateWorkspaceTab("board"));
for(const tab of [$("decisionTab"),$("boardTab")])tab.addEventListener("keydown",event=>{if(!["ArrowLeft","ArrowRight"].includes(event.key))return;event.preventDefault();const next=tab===$("decisionTab")?$("boardTab"):$("decisionTab");activateWorkspaceTab(next===$("boardTab")?"board":"decision");next.focus()});
$("boardSearch").addEventListener("input",renderPlayerBoard);
$("boardPosition").addEventListener("change",event=>{const root=$("boardPosition"),all=root.querySelector('[value="ALL"]'),specific=[...root.querySelectorAll('input:not([value="ALL"])')];if(event.target===all&&all.checked)specific.forEach(input=>input.checked=false);if(event.target!==all&&event.target.checked)all.checked=false;if(!all.checked&&!specific.some(input=>input.checked))all.checked=true;renderPlayerBoard()});
$("boardSort").addEventListener("change",renderPlayerBoard);
const boardHorizontalScroll=$("boardHorizontalScroll"),boardTableScroll=document.querySelector(".board-table-wrap");
let syncingBoardScroll=false;
const boardScrollRange=node=>Math.max(0,node.scrollWidth-node.clientWidth);
function mirrorBoardScroll(source,target){if(syncingBoardScroll)return;const sourceRange=boardScrollRange(source),targetRange=boardScrollRange(target);syncingBoardScroll=true;target.scrollLeft=sourceRange?source.scrollLeft/sourceRange*targetRange:0;syncingBoardScroll=false}
function syncBoardScrollMetrics(){if(!boardHorizontalScroll.clientWidth||!boardTableScroll.clientWidth)return;const tableRatio=boardTableScroll.scrollWidth/boardTableScroll.clientWidth,spacer=boardHorizontalScroll.firstElementChild,progress=boardScrollRange(boardTableScroll)?boardTableScroll.scrollLeft/boardScrollRange(boardTableScroll):0;spacer.style.width=`${Math.ceil(boardHorizontalScroll.clientWidth*tableRatio)}px`;boardHorizontalScroll.scrollLeft=progress*boardScrollRange(boardHorizontalScroll)}
boardHorizontalScroll.addEventListener("scroll",()=>mirrorBoardScroll(boardHorizontalScroll,boardTableScroll));
boardTableScroll.addEventListener("scroll",()=>mirrorBoardScroll(boardTableScroll,boardHorizontalScroll));
window.addEventListener("resize",syncBoardScrollMetrics);
slot.addEventListener("change",async()=>{if(!currentSlotScope||slot.readOnly)return;const value=Number(slot.value),teams=Number(slot.max);if(!Number.isInteger(value)||value<1||value>teams){slot.classList.add("slot-manual");$("slotHelp").classList.add("slot-error");$("slotHelp").textContent=`Enter a whole number from 1 to ${teams}.`;return}await chrome.storage.local.set({[currentSlotScope]:value});slot.classList.remove("slot-manual");$("slotHelp").classList.remove("slot-error");$("slotHelp").textContent="Manual fallback saved for this draft.";uiRefresh(true,{invalidate:true})});
$("replayTutorial").addEventListener("click",()=>beginTutorial({replay:true}));
$("skipTutorial").addEventListener("click",()=>closeTutorial());
$("nextTutorial").addEventListener("click",()=>{const count=tutorialSteps().length;if(tutorialIndex>=count-1)closeTutorial();else showTutorialStep(tutorialIndex+1)});
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&tutorialActive){event.preventDefault();closeTutorial()}});
window.addEventListener("resize",positionTutorialPointer);
suppressOpenedDraftReport();
