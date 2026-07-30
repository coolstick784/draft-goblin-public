import { snakeSlot, validateDraftState } from "../shared/domain.js";
import { recommend } from "./recommend.js";
import { createSimulationSession, pairedDifference, simulateCandidate } from "./simulate.js";
import { playerDistributionFingerprintMaterial } from "../shared/player-distribution.js";
const simulationCache=new Map(),CACHE_TTL=120000,MAX_CACHE=1500;
function stateKey(state,userSlot,iterations,seed){const picks=state.picks.map(p=>`${p.pickNo}:${p.playerId}:${p.slot}`).join(","),projections=state.players.map(p=>`${p.id}:${p.position||""}:${p.team||""}:${p.eligibleForRecommendation!==false}:${Number(p.mean||0).toFixed(2)}:${Number(p.floor||0).toFixed(2)}:${Number(p.ceiling||0).toFixed(2)}:${Number(p.risk||0).toFixed(3)}:${Number(p.scarcity||0).toFixed(3)}:${Number(p.adp||0).toFixed(2)}:${Number(p.adpSd||0).toFixed(2)}:${p.adpSeason||""}:${p.adpTeams||""}:${p.adpScoring||""}:${p.adpProvider||""}:${p.adpFetchedAt||""}:${Boolean(p.performanceRangeIncludesHistoricalError)}:${playerDistributionFingerprintMaterial(p)}`).join("|");return `${state.platform}:${state.draftId}:${state.projectionSeason}:${userSlot}:${iterations}:${seed}:${JSON.stringify(state.settings)}:${picks}:${projections}`}
function cachedSimulation(state,candidate,userSlot,iterations,seed,baseKey,session){const key=`${baseKey}:${candidate?.id||"__baseline__"}`,cached=simulationCache.get(key),now=Date.now();if(cached&&now-cached.at<CACHE_TTL)return cached.value;const value=simulateCandidate({state,candidate,userSlot,iterations,seed,session});simulationCache.set(key,{at:now,value});if(simulationCache.size>MAX_CACHE)simulationCache.delete(simulationCache.keys().next().value);return value}
const metric=(item,key)=>Number(item.player?.[key]||0);
const FLEX_POSITIONS=new Set(["RB","WR","TE"]);
const materiallyHigherProjection=(a,b)=>metric(a,"mean")-metric(b,"mean")>=Math.max(3,Math.abs(metric(b,"mean"))*.05);
const materiallyHigherFloor=(a,b)=>metric(a,"floor")-metric(b,"floor")>=Math.max(3,Math.abs(metric(b,"floor"))*.05);
const floorIsClose=(a,b)=>metric(a,"floor")>=metric(b,"floor")-Math.max(3,Math.abs(metric(b,"floor"))*.08);
const ceilingIsClose=(a,b)=>metric(a,"ceiling")>=metric(b,"ceiling")-Math.max(3,Math.abs(metric(b,"ceiling"))*.08);
const sweepsProjectionRange=(a,b)=>['mean','floor','ceiling'].every(key=>metric(a,key)>=metric(b,key)-.01)&&['mean','floor','ceiling'].some(key=>metric(a,key)>metric(b,key)+.5);
function flexDepthUpgrade(a,b,{sameFlexibleRole,waitingForUserPick}){const aNeed=Number(a.factors?.need||0),bNeed=Number(b.factors?.need||0);return sameFlexibleRole&&!waitingForUserPick&&(aNeed>=bNeed+.10&&(sweepsProjectionRange(a,b)||materiallyHigherProjection(a,b)&&materiallyHigherFloor(a,b)&&ceilingIsClose(a,b))||aNeed>=bNeed&&materiallyHigherProjection(a,b)&&materiallyHigherFloor(a,b)&&metric(a,'ceiling')>=metric(b,'ceiling')-.01)}
const requiredStarterSlots=item=>Number(item.requiredStarterSlotsBefore??(Number(item.factors?.need||0)>=.9?1:0));
function requiredStarterUpgrade(a,b,{sameFlexibleRole}){const meanTolerance=Math.max(3,Math.abs(metric(b,"mean"))*.05);return sameFlexibleRole&&requiredStarterSlots(a)>0&&requiredStarterSlots(b)===0&&metric(a,"mean")>=metric(b,"mean")-meanTolerance&&floorIsClose(a,b)&&ceilingIsClose(a,b)}
export function recommendationDominates(a,b){const aPosition=a.player?.position,bPosition=b.player?.position,samePosition=aPosition===bPosition,sameFlexibleRole=FLEX_POSITIONS.has(aPosition)&&FLEX_POSITIONS.has(bPosition);if(!samePosition&&!sameFlexibleRole)return false;const waitingForUserPick=Boolean(a.waitingForUserPick||b.waitingForUserPick),depthUpgrade=flexDepthUpgrade(a,b,{sameFlexibleRole,waitingForUserPick}),starterUpgrade=requiredStarterUpgrade(a,b,{sameFlexibleRole});if(Number(a.factors?.need||0)<Number(b.factors?.need||0))return false;if(starterUpgrade||depthUpgrade||samePosition&&materiallyHigherProjection(a,b)&&floorIsClose(a,b)&&ceilingIsClose(a,b))return true;const keys=["mean","floor","ceiling"],noWorse=keys.every(key=>metric(a,key)>=metric(b,key)-.01),strictlyBetter=keys.some(key=>metric(a,key)>metric(b,key)+.5);return noWorse&&strictlyBetter&&(samePosition||materiallyHigherProjection(a,b))}
export const FAMILYWISE_Z=2.734;
const SEQUENTIAL_FAMILYWISE_Z=2.75;
export const EVIDENCE_STAGES=Object.freeze([1000,2500,5000,10000]);
export const titleTenths=probability=>Math.round(Number(probability||0)*1000);
const projectedFinalProbability=(rawProbability,source)=>{const targetIterations=10000,priorStrength=Number(source?.priorStrength),priorProbability=Number(source?.priorProbability),raw=Number(rawProbability);return Number.isFinite(raw)&&Number.isFinite(priorStrength)&&Number.isFinite(priorProbability)?Math.max(0,Math.min(1,(raw*targetIterations+priorStrength*priorProbability)/(targetIterations+priorStrength))):Number(source?.championshipProbability||0)};
function simulationWithEvidence(source,overrides={}){const simulation={...source,...overrides};if(source?.scenarioWins)Object.defineProperties(simulation,{scenarioWins:{value:source.scenarioWins,enumerable:false},planScenarioWins:{value:source.planScenarioWins,enumerable:false},scenarioSelected:{value:source.scenarioSelected,enumerable:false}});return simulation}
// FLEX/depth may beat an empty starter, but only with a practically meaningful
// title edge in addition to statistical significance. A .75 flexibility debt
// therefore requires at least a .75 percentage-point raw title advantage.
export function flexibilityOverrideMargin(higher,lower){const penalty=Math.max(0,Number(higher.starterFlexibilityPenalty??higher.rosterCompletionPenalty??0)),usesFlexOrDepth=penalty>0&&requiredStarterSlots(higher)===0,fillsCoreStarter=requiredStarterSlots(lower)>0;if(!usesFlexOrDepth||!fillsCoreStarter)return 0;return higher.conditionalRolloutCoreCoverage===true?.0025:Math.min(.01,Math.max(.0025,penalty*.01))}
function directionSupported(higher,lower,z=FAMILYWISE_Z){const a=higher.simulation,b=lower.simulation,margin=flexibilityOverrideMargin(higher,lower),paired=pairedDifference(a,b,{z}),pairedSupported=paired?paired.rawDifference>margin+z*Math.max(1e-12,paired.standardError):null,pairedCoverageOverride=margin>0&&higher.conditionalRolloutCoreCoverage===true,pa=Number(a.rawProbability),pb=Number(b.rawProbability),na=Number(a.effectiveCandidateIterations||a.iterations),nb=Number(b.effectiveCandidateIterations||b.iterations);if(pairedCoverageOverride&&pairedSupported!==null)return pairedSupported;if(Number.isFinite(pa)&&Number.isFinite(pb)&&na>0&&nb>0){const se=Math.sqrt(Math.max(1e-12,pa*(1-pa)/na+pb*(1-pb)/nb)),independentSupported=pa-pb>margin+z*se;return pairedSupported===null?independentSupported:pairedSupported&&independentSupported}if(pairedSupported!==null)return pairedSupported;return Number(a.interval?.[0]||0)>Number(b.interval?.[1]||0)+margin}
function dominanceOrder(items,fallback){const remaining=[...items],result=[];while(remaining.length){const frontier=remaining.filter(item=>!remaining.some(other=>other!==item&&recommendationDominates(other,item))),choices=frontier.length?frontier:remaining,selected=[...choices].sort(fallback)[0];result.push(selected);remaining.splice(remaining.indexOf(selected),1)}return result}
const groupAverage=(group,key="championshipProbability")=>group.reduce((sum,item)=>sum+Number(item.simulation?.[key]||0),0)/Math.max(1,group.length);
function normalizeDisplayGroups(groups,fallback){
  const result=groups.map(group=>[...group]);
  for(let index=0;index<result.length-1;){
    const upper=result.slice(0,index+1).flat(),lower=result.slice(index+1).flat(),reverseDominance=lower.some(lowerItem=>upper.some(upperItem=>recommendationDominates(lowerItem,upperItem))),increasingOdds=titleTenths(groupAverage(result[index]))<titleTenths(groupAverage(result[index+1]));
    if(!reverseDominance&&!increasingOdds){index++;continue}
    result.splice(index,2,[...result[index],...result[index+1]]);
    result[index]=dominanceOrder(result[index],fallback);
    if(index>0)index--;
  }
  return result;
}
function evidenceBoundary(upper,lower){
  const candidates=[];
  for(const higher of upper)for(const lowerItem of lower){
    if(!directionSupported(higher,lowerItem))continue;
    // A supported Monte Carlo boundary is still inadmissible when it reverses
    // the football-value partial order. Collapse the groups instead and expose
    // an order-restricted tie rather than a contradictory title percentage.
    if(recommendationDominates(lowerItem,higher))continue;
    // A supported witness must be adjacent to the displayed boundary. If the
    // witness dominates a card in its own title group, that card can safely move
    // to the lower display group (it still remains after its dominator). Likewise,
    // ancestors of the lower witness move up so projection dominance is retained.
    const demoted=upper.filter(item=>item!==higher&&recommendationDominates(higher,item));
    const promoted=lower.filter(item=>item!==lowerItem&&recommendationDominates(item,lowerItem));
    const nextUpper=upper.filter(item=>!demoted.includes(item)).concat(promoted);
    const nextLower=lower.filter(item=>!promoted.includes(item)).concat(demoted);
    if(nextLower.some(lowerCandidate=>nextUpper.some(upperCandidate=>recommendationDominates(lowerCandidate,upperCandidate))))continue;
    if(nextUpper.some(item=>item!==higher&&recommendationDominates(higher,item)))continue;
    if(nextLower.some(item=>item!==lowerItem&&recommendationDominates(item,lowerItem)))continue;
    candidates.push({higher,lowerItem,nextUpper,nextLower,moves:demoted.length+promoted.length});
  }
  if(!candidates.length)return null;
  candidates.sort((a,b)=>a.moves-b.moves||Number(b.higher.planScore||0)-Number(a.higher.planScore||0)||Number(b.lowerItem.planScore||0)-Number(a.lowerItem.planScore||0));
  const selected=candidates[0],fallback=(a,b)=>Number(b.planScore||0)-Number(a.planScore||0)||String(a.player?.id||"").localeCompare(String(b.player?.id||""));
  return{
    upper:[...dominanceOrder(selected.nextUpper.filter(item=>item!==selected.higher),fallback),selected.higher],
    lower:[selected.lowerItem,...dominanceOrder(selected.nextLower.filter(item=>item!==selected.lowerItem),fallback)]
  };
}
function evidenceDisplayGroups(groups){
  const fallback=(a,b)=>Number(b.planScore||0)-Number(a.planScore||0)||String(a.player?.id||"").localeCompare(String(b.player?.id||""));
  const result=groups.map(group=>dominanceOrder(group,fallback));
  for(let index=0;index<result.length-1;){
    const boundary=evidenceBoundary(result[index],result[index+1]);
    if(boundary){result[index]=boundary.upper;result[index+1]=boundary.lower;index++;continue}
    // If no dominance-safe adjacent witness exists, exposing a different number
    // would overstate the Monte Carlo evidence. Collapse the display groups.
    result.splice(index,2,[...result[index],...result[index+1]]);
    if(index>0)index--;
  }
  return normalizeDisplayGroups(result,fallback);
}

// O'Brien-Fleming-style evidence spending: early looks must clear a much higher
// bar than the existing 10k familywise gate. The small 2.75 vs 2.734 increase at
// the target pays for repeated looks, so adaptive evaluation cannot lower quality.
export function stagedEvidenceZ(iterations,targetIterations=10000){const information=Math.min(1,Math.max(1,Number(iterations)||1)/Math.max(1,Number(targetIterations)||1));return SEQUENTIAL_FAMILYWISE_Z/Math.sqrt(information)}

export function assessRankingReadiness(items,{iterations,targetIterations=10000,stageIterations=iterations}={}){
  // `items` has already passed through the calibrated football ranking contract.
  // Preserve that order here; raw paired outcomes are evidence for or against an
  // ordering, never a replacement ranking objective.
  const count=Math.max(1,Number(stageIterations||iterations)||1),target=Math.max(count,Number(targetIterations)||10000),z=stagedEvidenceZ(count,target),ordered=[...items].filter(item=>item?.simulation);
  if(!ordered.length)return{displayReady:true,rankingReady:true,orderingDurable:true,precisionReady:true,stageIterations:count,targetIterations:target,evidenceZ:z,leadingGroup:[],displayGroups:[],eliminated:[],unresolved:[],comparisons:[],continueInBackground:false,method:"paired-common-random-numbers-obf"};
  const leader=ordered[0],comparisons=ordered.slice(1).map(item=>{const paired=pairedDifference(leader.simulation,item.simulation,{prefixIterations:count,z}),margin=flexibilityOverrideMargin(leader,item),supported=Boolean(paired&&paired.rawDifference>margin+z*Math.max(1e-12,paired.standardError));return{candidateId:item.player?.id,againstCandidateId:leader.player?.id,supported,rawDifference:paired?.rawDifference??null,standardError:paired?.standardError??null,lowerBound:paired?.interval?.[0]??null,upperBound:paired?.interval?.[1]??null,pairedIterations:paired?.iterations??0}}),eliminated=comparisons.filter(row=>row.supported).map(row=>row.candidateId),unresolved=comparisons.filter(row=>!row.supported).map(row=>row.candidateId),leadingGroup=[leader.player?.id,...unresolved],displayGroups=[];
  for(const item of ordered){const group=displayGroups.at(-1);if(!group||group.some(higher=>directionSupported(higher,item,z)))displayGroups.push([item]);else group.push(item)}
  const fallback=(a,b)=>Number(b.planScore||0)-Number(a.planScore||0)||String(a.player?.id||"").localeCompare(String(b.player?.id||"")),normalizedDisplayGroups=normalizeDisplayGroups(displayGroups,fallback),displayGroupIds=normalizedDisplayGroups.map(group=>group.map(item=>item.player?.id)),precisionReady=normalizedDisplayGroups.every(group=>group.length===1),displayReady=count>=EVIDENCE_STAGES[0];
  return{displayReady,rankingReady:precisionReady||count>=target,orderingDurable:precisionReady,precisionReady,stageIterations:count,targetIterations:target,evidenceZ:z,leadingGroup,displayGroups:displayGroupIds,eliminated,unresolved,comparisons,continueInBackground:count<target&&!precisionReady,method:"paired-common-random-numbers-obf"};
}
export function rankEvaluatedRecommendations(items,{strategy="balanced"}={}){
  const ranked=items.map(item=>{const source=item.simulation,conditionalChampionshipProbability=Number(source.conditionalChampionshipProbability??source.championshipProbability),conditionalRawProbability=Number(source.conditionalRawProbability??source.rawProbability),rankingChampionshipProbability=Number(source.championshipProbability),rankingRawProbability=Number(source.rawProbability),projectedFinalChampionshipProbability=titleTenths(projectedFinalProbability(rankingRawProbability,source))/1000,simulation=simulationWithEvidence(source,{conditionalChampionshipProbability,conditionalRawProbability,rankingChampionshipProbability,rankingRawProbability,projectedFinalChampionshipProbability,championshipProbability:rankingChampionshipProbability,rawChampionshipProbability:rankingRawProbability});return{...item,simulation}});
  const overlaps=(a,b)=>!(Number(a.simulation.interval?.[0]||0)>Number(b.simulation.interval?.[1]||0)||Number(b.simulation.interval?.[0]||0)>Number(a.simulation.interval?.[1]||0));
  if(strategy==="titleOnly"){
    const orderedByDominance=dominanceOrder(ranked,(a,b)=>b.simulation.championshipProbability-a.simulation.championshipProbability||Number(b.planScore||0)-Number(a.planScore||0)||String(a.player.id).localeCompare(String(b.player.id)));
    // Raw Monte Carlo order is not evidence of a real title-odds difference.
    // Within an indistinguishable title group, prefer the player who is plainly
    // better if available now; market survival remains display-only.
    const initialGroups=[];for(const item of orderedByDominance){const previous=initialGroups.at(-1);if(!previous||previous.some(higher=>directionSupported(higher,item)))initialGroups.push([item]);else previous.push(item)}
    const groups=evidenceDisplayGroups(initialGroups),result=[],tieFallback=(a,b)=>Number(b.planScore||0)-Number(a.planScore||0)||String(a.player?.id||"").localeCompare(String(b.player?.id||""));for(const group of groups){const displayed=group.reduce((sum,item)=>sum+Number(item.simulation.championshipProbability||0),0)/group.length,displayTitleTenths=titleTenths(displayed),ordered=group.length>1?dominanceOrder(group,tieFallback):group;for(const item of ordered)result.push({...item,statisticalTie:group.length>1,simulation:simulationWithEvidence(item.simulation,{championshipProbability:displayTitleTenths/1000,displayChampionshipProbability:displayTitleTenths/1000,displayTitleTenths,evidenceStatus:group.length>1?"indistinguishable":"title-supported"})})}return result;
  }
  if(strategy==="balanced"){
    const orderedByDominance=dominanceOrder(ranked,(a,b)=>b.simulation.championshipProbability-a.simulation.championshipProbability||Number(b.planScore||0)-Number(a.planScore||0)||String(a.player.id).localeCompare(String(b.player.id)));
    const initialGroups=[];for(const item of orderedByDominance){const previous=initialGroups.at(-1);if(!previous||previous.some(higher=>directionSupported(higher,item)))initialGroups.push([item]);else previous.push(item)}
    const groups=evidenceDisplayGroups(initialGroups),result=[];for(const group of groups){const displayed=group.reduce((sum,item)=>sum+Number(item.simulation.championshipProbability||0),0)/group.length,displayTitleTenths=titleTenths(displayed),projectedFinalTitleTenths=titleTenths(group.reduce((sum,item)=>sum+Number(item.simulation.projectedFinalChampionshipProbability||0),0)/group.length),ordered=group;for(const item of ordered)result.push({...item,statisticalTie:group.length>1,simulation:simulationWithEvidence(item.simulation,{projectedFinalChampionshipProbability:projectedFinalTitleTenths/1000,championshipProbability:displayTitleTenths/1000,displayChampionshipProbability:displayTitleTenths/1000,displayTitleTenths,evidenceStatus:group.length>1?"indistinguishable":"supported"})})}return result
  }
  const ordered=dominanceOrder(ranked,(a,b)=>Number(b.planScore||0)-Number(a.planScore||0)||b.simulation.championshipProbability-a.simulation.championshipProbability),leader=ordered[0];return ordered.map((item,index)=>({...item,statisticalTie:index>0&&overlaps(leader,item),simulation:simulationWithEvidence(item.simulation,{displayChampionshipProbability:item.simulation.championshipProbability,displayTitleTenths:titleTenths(item.simulation.championshipProbability),evidenceStatus:"strategy-ranked"})}));
}
function simulatedItems(input,items,iterations,seed){const baseKey=stateKey(input.state,input.userSlot,iterations,seed),session=createSimulationSession({state:input.state,userSlot:input.userSlot,iterations,seed}),teamSimulation=cachedSimulation(input.state,null,input.userSlot,iterations,seed,baseKey,session),currentSlot=snakeSlot(input.state.picks.length+1,input.state.settings.teams);return items.map(item=>{const simulation=cachedSimulation(input.state,item.player,input.userSlot,iterations,seed,baseKey,session),paired=pairedDifference(simulation,teamSimulation);if(paired)Object.assign(simulation,{pairedDifference:paired.rawDifference,pairedStandardError:paired.standardError,pairedInterval:paired.interval,pairedScenarioBankId:paired.scenarioBankId});return{...item,waitingForUserPick:currentSlot!==input.userSlot,teamSimulation,simulation}})}
export function evaluateDraft(input) {
  const validation = validateDraftState(input.state); if (!validation.valid) throw new Error(validation.errors.join("; "));
  const currentSlot = snakeSlot(input.state.picks.length + 1, input.state.settings.teams);
  const items=recommend(input);if(input.includeSimulation===false)return items.map(item=>({...item,waitingForUserPick:currentSlot!==input.userSlot,simulation:null,teamSimulation:null}));
  const iterations=Math.min(input.iterations||600,20000),seed=input.seed||2026;
  return rankEvaluatedRecommendations(simulatedItems(input,items,iterations,seed),{strategy:input.strategy||"balanced"});
}
