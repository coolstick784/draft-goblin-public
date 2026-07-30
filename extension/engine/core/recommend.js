import { SOURCE_PROFILES, STRATEGIES, nextPickForSlot, snakeSlot } from "../shared/domain.js";
import { rosterNeeds } from "./roster.js";
import { availabilityAfterSelection, availabilityProbability } from "./availability.js";
import { candidateLineupMetrics, isSpecialist, specialistOpportunity } from "./lineup-value.js";
import { conditionalMultiPickRollouts } from "./conditional-rollout.js";
const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const scale = (n, min, max) => max === min ? .5 : clamp((Number(n || 0) - min) / (max - min));
const TUNED_POLICY={early:{RB:-.0088,WR:-.0081,QB:-.0236,TE:.0053},mid:{RB:-.0164,WR:.0766,QB:-.0549,TE:-.0330},late:{RB:.0320,WR:.0228,QB:.0027,TE:.0045}};
function historyFactor(player,roster,currentPick,teams){const round=Math.ceil(currentPick/teams),phase=round<=3?"early":round<=8?"mid":"late",counts=roster.reduce((out,p)=>((out[p.position]=(out[p.position]||0)+1),out),{}),before=Math.abs((counts.RB||0)-(counts.WR||0)),after=Math.abs((counts.RB||0)+(player.position==="RB")-((counts.WR||0)+(player.position==="WR"))),balance=(before-after)*.0217,raw=(TUNED_POLICY[phase][player.position]||0)+balance;return clamp((raw+.10)/.20)}
export { availabilityProbability } from "./availability.js";
const FLEX_ELIGIBLE=new Set(["RB","WR","TE"]);
const ROLLOUT_POSITIONS=new Set(["QB","RB","WR","TE"]);
const hasDecisionMarket=player=>String(player?.position||"").toUpperCase()!=="TE"&&Number.isFinite(Number(player?.adp))&&Number(player.adp)>0&&Number(player.adp)<500;
export function projectedTightEndPriorityTier(players,{maxSize=3,maxLeaderDrop=.08}={}){const tightEnds=(players||[]).filter(player=>player.position==="TE").sort((a,b)=>Number(b.mean||0)-Number(a.mean||0)||Number(b.ceiling||0)-Number(a.ceiling||0)),leaderMean=Number(tightEnds[0]?.mean||0),drop=Math.max(8,leaderMean*Number(maxLeaderDrop||0));return tightEnds.filter((player,index)=>index===0||leaderMean-Number(player.mean||0)<=drop).slice(0,Math.max(1,Number(maxSize)||3))}
const playerIdentityIndex=players=>{const index=new Map();for(const player of players||[]){index.set(String(player.id),player);const platformId=player.platformPlayerId;if(platformId!==undefined&&platformId!==null&&String(platformId)!==""&&!index.has(String(platformId)))index.set(String(platformId),player)}return index};
export function conditionalRolloutCandidateFrontier(ranked,{limit=18}={}){
  const selected=[],seen=new Set(),add=item=>{const id=String(item?.player?.id??"");if(!id||seen.has(id)||selected.length>=limit)return;seen.add(id);selected.push(item)};
  for(const position of ROLLOUT_POSITIONS)add(ranked.find(item=>item.player.position===position));
  for(const item of ranked.slice(0,8))add(item);
  for(const position of ROLLOUT_POSITIONS){
    const atPosition=ranked.filter(item=>item.player.position===position);
    for(const item of atPosition.slice(0,2))add(item);
    add([...atPosition].sort((a,b)=>b.rawProjectionScore-a.rawProjectionScore||b.planScore-a.planScore)[0]);
    add([...atPosition].sort((a,b)=>b.titleAsymmetryScore-a.titleAsymmetryScore||b.planScore-a.planScore)[0]);
  }
  for(const item of [...ranked].sort((a,b)=>b.futureStarterAccess-a.futureStarterAccess||b.planScore-a.planScore))add(item);
  for(const item of ranked)add(item);
  return selected;
}
export function conditionalRolloutCoverageBonus({bonus,coreDebtAfter,futurePickCount,coverageProbability,covered}){
  const value=Math.max(0,Number(bonus)||0),debt=Math.max(0,Number(coreDebtAfter)||0),horizon=Math.max(0,Number(futurePickCount)||0);
  if(!(debt>0&&debt<=horizon))return value;
  const coverage=Number.isFinite(Number(coverageProbability))?Math.max(0,Math.min(1,Number(coverageProbability))):covered?1:0;
  return value*coverage;
}
export function replacementDemand(position,settings){const teams=Number(settings.teams||10),slots=settings.slots||{},flex=Number(slots.FLEX||0),superflex=Number(slots.SUPER_FLEX||slots.OP||0);const flexShare=position==="RB"?.45:position==="WR"?.45:position==="TE"?.10:0,superflexShare=position==="QB"?.75:(["RB","WR","TE"].includes(position)?.25/3:0);return Math.max(1,Math.round(teams*(Number(slots[position]||0)+flex*flexShare+superflex*superflexShare)))}
export function valueOverReplacement(player,pool,settings,key="mean",remainingDemand=replacementDemand(player.position,settings)){const same=pool.filter(p=>p.position===player.position).sort((a,b)=>Number(b[key]||0)-Number(a[key]||0)),index=Math.min(Math.max(0,Number(remainingDemand)||0),Math.max(0,same.length-1)),replacement=Number(same[index]?.[key]||0);return { value:Number(player[key]||0)-replacement,replacement }}
export function remainingReplacementDemand(position,state){const byId=playerIdentityIndex(state.players),draftedAtPosition=(state.picks||[]).reduce((count,pick)=>count+(byId.get(String(pick.playerId))?.position===position?1:0),0);return Math.max(0,replacementDemand(position,state.settings)-draftedAtPosition)}
export function sensiblePositionCap(position,slots){const required=Number(slots[position]||0),bench=Number(slots.BENCH||0),flex=Number(slots.FLEX||0);if(position==="QB")return required+1;if(["K","DST"].includes(position))return required;if(position==="TE")return required+1;if(["RB","WR"].includes(position))return required+flex+Math.max(1,Math.ceil(bench*.35));return required}
export function recommendationPositionCap(position,settings){const sensible=sensiblePositionCap(position,settings.slots||{}),explicit=Number(settings.positionLimits?.[position]);return Number.isFinite(explicit)&&explicit>=0?Math.min(sensible,explicit):sensible}
export function lateTightEndValueException({player,draftable,counts,settings,completion,selectionRound}){
  if(player.position!=="TE"||Number(counts.TE||0)<sensiblePositionCap("TE",settings.slots))return false;
  const lateRound=Math.max(10,Number(settings.rounds||0)-4);
  if(selectionRound<lateRound||completion.remainingPicks<=completion.missingRequiredSlots)return false;
  const alternatives=draftable.filter(candidate=>["RB","WR"].includes(candidate.position));
  if(!alternatives.length)return false;
  const bestMean=Math.max(...alternatives.map(candidate=>Number(candidate.mean||0))),bestCeiling=Math.max(...alternatives.map(candidate=>Number(candidate.ceiling||candidate.mean||0)));
  const materialMeanEdge=Math.max(3,bestMean*.03),materialCeilingEdge=Math.max(5,bestCeiling*.03);
  return Number(player.mean||0)>=bestMean+materialMeanEdge||Number(player.ceiling||player.mean||0)>=bestCeiling+materialCeilingEdge;
}
export function positionNeedScore(position,counts,slots,needs){const count=Number(counts[position]||0),required=Number(slots[position]||0);if(count<required)return 1;if(FLEX_ELIGIBLE.has(position)&&Number(needs.FLEX||0)>0)return position==="TE"?.22:.72;if(position==="QB")return count===required?.22:0;if(["K","DST"].includes(position))return 0;if(position==="TE"){const rbWrDepthReady=["RB","WR"].every(pos=>Number(counts[pos]||0)>=Number(slots[pos]||0)+2);return count===required?(rbWrDepthReady?.48:.24):0}if(["RB","WR"].includes(position)){const depthTarget=required+Number(slots.FLEX||0)+Math.max(1,Math.ceil(Number(slots.BENCH||0)*.35));return count<depthTarget?.42:.12}return 0}
export function positionOverdraftPenalty(position,counts,slots,needs,round){const count=Number(counts[position]||0),required=Number(slots[position]||0),flexOpen=Number(needs.FLEX||0)>0;if(position==="QB"&&count>=required+1)return 1.25;if(position==="QB"&&count>=required)return flexOpen?.78:.48;if(["K","DST"].includes(position)&&count>=required)return 1.25;if(position==="TE"&&count>=required){const rbThin=Number(counts.RB||0)<Number(slots.RB||0)+1,wrThin=Number(counts.WR||0)<Number(slots.WR||0)+1;if(rbThin||wrThin)return rbThin&&wrThin?.34:.20;if(count>=required+(flexOpen?1:0))return Math.min(.55,.20+(count-required)*.14)}if(["RB","WR"].includes(position)&&count>=sensiblePositionCap(position,slots))return Math.min(.5,.16+(count-sensiblePositionCap(position,slots))*.10);return 0}
export function rosterCompletionConstraint({needs,remainingPicks}){const missingRequiredSlots=["QB","RB","WR","TE","K","DST","FLEX"].reduce((sum,position)=>sum+Number(needs[position]||0),0),picksLeft=Math.max(0,Number(remainingPicks||0)),requiredPositions=new Set(["QB","RB","WR","TE","K","DST"].filter(position=>Number(needs[position]||0)>0));if(Number(needs.FLEX||0)>0)for(const position of FLEX_ELIGIBLE)requiredPositions.add(position);return{missingRequiredSlots,remainingPicks:picksLeft,completionRequired:missingRequiredSlots>0&&picksLeft>0&&missingRequiredSlots>=picksLeft,requiredPositions}}
// A pick has option value beyond its own projection: it changes which starter
// holes must be solved later. Estimate the quality likely to remain for every
// open core slot at the user's following turn. This rewards filling a tier that
// is about to disappear only when the alternative position really has a better
// fallback; it is deliberately generic and board-dependent.
export function futureStarterChoices({draftable,state,targetPick,selectionPick}){
  return new Map(["QB","RB","WR","TE"].map(position=>{
    const pool=draftable.filter(candidate=>candidate.position===position),demand=remainingReplacementDemand(position,state),meanSorted=[...pool].sort((a,b)=>Number(b.mean||0)-Number(a.mean||0)),ceilingSorted=[...pool].sort((a,b)=>Number(b.ceiling||0)-Number(a.ceiling||0)),meanReplacement=Number(meanSorted[Math.min(demand,Math.max(0,meanSorted.length-1))]?.mean||0),ceilingReplacement=Number(ceilingSorted[Math.min(demand,Math.max(0,ceilingSorted.length-1))]?.ceiling||0);
    const rows=pool.map(candidate=>{const survival=availabilityAfterSelection(candidate,targetPick,selectionPick,{season:state.projectionSeason,settings:state.settings}),value=Math.max(0,(Number(candidate.mean||0)-meanReplacement)*.65+(Number(candidate.ceiling||0)-ceilingReplacement)*.35)*survival;return{candidate,value}}).sort((a,b)=>b.value-a.value),prefix=[0],rankById=new Map();for(let index=0;index<rows.length;index++){prefix.push(prefix[index]+rows[index].value);rankById.set(rows[index].candidate.id,index)}return[position,{rows,prefix,rankById}];
  }));
}
export function futureStarterAccess({player,roster,draftable,state,targetPick,selectionPick,choicesByPosition,needs}){
  if(!targetPick||targetPick<=selectionPick)return 0;
  const currentNeeds=needs||rosterNeeds(roster,state.settings.slots),choices=choicesByPosition||futureStarterChoices({draftable,state,targetPick,selectionPick}),corePositions=["QB","RB","WR","TE"];
  let total=0;
  for(const position of corePositions){
    const missing=Math.max(0,Number(currentNeeds[position]||0)-(player.position===position?1:0));if(!missing)continue;
    const choice=choices.get(position);if(!choice)continue;const rank=choice.rankById.get(player.id),take=Math.min(missing,choice.rows.length-(rank===undefined?0:1));if(take<=0)continue;total+=choice.prefix[take];if(rank!==undefined&&rank<take)total+=Number(choice.rows[take]?.value||0)-choice.rows[rank].value;
  }
  return total;
}
function rankedRecommendationCandidates({ state, userSlot, strategy = "balanced", sourceProfile="projectionLed", customWeights, positions, limit = 8, includeAllEligible = false }) {
  const byIdentity=playerIdentityIndex(state.players),drafted = new Set(state.picks.map(pick=>byIdentity.get(String(pick.playerId))?.id??pick.playerId));
  const userPicks=state.picks.filter(p=>Number(p.slot)===Number(userSlot)),roster=[...new Map(userPicks.map(pick=>byIdentity.get(String(pick.playerId))).filter(Boolean).map(player=>[String(player.id),player])).values()];
  const positionSet=Array.isArray(positions)&&positions.length?new Set(positions):null;
  const draftable = state.players.filter(p => !drafted.has(p.id) && p.eligibleForRecommendation!==false && p.position !== "NA" && Number(state.settings.slots[p.position]||0)>0);
  const needs = rosterNeeds(roster, state.settings.slots), currentPick = state.picks.length + 1;
  const completion=rosterCompletionConstraint({needs,remainingPicks:Number(state.settings.rounds||0)-userPicks.length});
  const filteredCandidates=draftable.filter(p=>!positionSet||positionSet.has(p.position)),filteredRequired=completion.completionRequired?filteredCandidates.filter(player=>completion.requiredPositions.has(player.position)):[],forcedSpecialistFallback=completion.completionRequired&&Boolean(positionSet)&&filteredRequired.length===0&&completion.remainingPicks<=2&&[...completion.requiredPositions].every(position=>["K","DST"].includes(position)),candidates=completion.completionRequired&&(!positionSet||forcedSpecialistFallback)?(forcedSpecialistFallback?draftable.filter(player=>completion.requiredPositions.has(player.position)):filteredRequired):filteredCandidates;
  const round = Math.ceil(currentPick / state.settings.teams), counts = roster.reduce((out,p)=>((out[p.position]=(out[p.position]||0)+1),out),{}),explicitSinglePosition=positionSet?.size===1;
  const userNextPick = nextPickForSlot(currentPick-1, userSlot, state.settings.teams, state.settings.rounds), waitingForUserPick=snakeSlot(currentPick,state.settings.teams)!==userSlot, selectionPick=waitingForUserPick?userNextPick:currentPick,selectionRound=Math.ceil(Number(selectionPick||currentPick)/Number(state.settings.teams||1));
  const selectionRoundsRemaining=Math.max(0,Number(state.settings.rounds||0)-selectionRound+1),specialistOpportunities=new Map(candidates.filter(player=>isSpecialist(player.position)).map(player=>[player.id,specialistOpportunity({player,pool:draftable,roster,settings:state.settings,completionRequired:completion.completionRequired&&completion.requiredPositions.has(player.position)})]));
  const capEligible=candidates.filter(player=>{const specialist=isSpecialist(player.position),configuredLimit=Number(state.settings.positionLimits?.[player.position]),hasConfiguredLimit=Number.isFinite(configuredLimit)&&configuredLimit>=0,belowCap=(counts[player.position]||0)<recommendationPositionCap(player.position,state.settings),lateTeException=!hasConfiguredLimit&&lateTightEndValueException({player,draftable,counts,settings:state.settings,completion,selectionRound}),earlyBackupQb=player.position==="QB"&&(counts.QB||0)>=Number(state.settings.slots.QB||0)&&selectionRound<Math.max(9,state.settings.rounds-5);if(earlyBackupQb&&!explicitSinglePosition&&!completion.completionRequired)return false;if(specialist&&!positionSet&&selectionRoundsRemaining>2&&!completion.completionRequired)return false;if(player.position==="TE")return belowCap||lateTeException;return belowCap||(explicitSinglePosition&&!specialist&&!hasConfiguredLimit)});
  if (!capEligible.length) return [];
  const availabilityTargetPick=waitingForUserPick?userNextPick:(selectionPick?nextPickForSlot(selectionPick,userSlot,state.settings.teams,state.settings.rounds):null),optionalityTargetPick=selectionPick?nextPickForSlot(selectionPick,userSlot,state.settings.teams,state.settings.rounds):null,marketWindow=Number(selectionPick||currentPick)+Number(state.settings.teams)*1.5,teProjectionPool=capEligible.filter(player=>player.position==="TE").sort((a,b)=>Number(b.mean||0)-Number(a.mean||0)),marketPlausible=capEligible.filter(player=>hasDecisionMarket(player)&&Number(player.adp)<=marketWindow),outsideMarket=capEligible.filter(player=>player.position!=="TE"&&!marketPlausible.includes(player)),marketSupplement=outsideMarket.sort((a,b)=>Number(a.adp||9999)-Number(b.adp||9999)||Number(b.mean||0)-Number(a.mean||0)).slice(0,Math.max(0,limit-marketPlausible.length)),projectionOutliers=["mean","floor","ceiling"].flatMap(key=>{const bestMarket=Math.max(...marketPlausible.map(player=>Number(player[key]||0))),materialEdge=Math.max(3,Math.abs(bestMarket)*.05);return outsideMarket.filter(player=>!Number.isFinite(bestMarket)||Number(player[key]||0)-bestMarket>=materialEdge).sort((a,b)=>Number(b[key]||0)-Number(a[key]||0)).slice(0,2)});let available=includeAllEligible||completion.completionRequired?capEligible:!positionSet&&selectionRound<=8?[...new Map([...teProjectionPool,...marketPlausible,...marketSupplement,...projectionOutliers].map(player=>[player.id,player])).values()]:capEligible;
  // Title-only evaluation must not inherit the early-round ADP window. That
  // window is useful for a conventional draft board, but it can hide exactly
  // the low-ADP/high-ceiling bets whose asymmetric payoff matters in a title
  // simulation. Position caps and roster-completion constraints have already
  // been applied above, so evaluating the full eligible pool is still safe.
  if(strategy==="titleOnly"&&!positionSet)available=capEligible;
  const tightEndPriorityIds=new Set(projectedTightEndPriorityTier(capEligible).map(player=>String(player.id))),positionRanks=new Map();for(const position of new Set(available.map(player=>player.position)))[...available].filter(player=>player.position===position).sort((a,b)=>Number(b.mean||0)-Number(a.mean||0)).forEach((player,index)=>positionRanks.set(player.id,index+1));
  const remainingDemand=new Map([...new Set(available.map(player=>player.position))].map(position=>[position,remainingReplacementDemand(position,state)])),valued=available.map(player=>{const demand=remainingDemand.get(player.position),mean=valueOverReplacement(player,draftable,state.settings,"mean",demand),ceiling=valueOverReplacement(player,draftable,state.settings,"ceiling",demand),floor=valueOverReplacement(player,draftable,state.settings,"floor",demand);return {player,projectionValue:mean.value,ceilingValue:ceiling.value,floorValue:floor.value,replacementPoints:mean.replacement}});
  const ranges = Object.fromEntries([["projection","projectionValue"],["ceiling","ceilingValue"],["floor","floorValue"],["risk","risk"],["upsideRisk","performanceRisk"],["scarcity","scarcity"]].map(([key,field]) => { const v = valued.map(row => Number(row[field]??row.player[field]??(key==="upsideRisk"?row.player.risk:0)??0)); return [key, [Math.min(...v), Math.max(...v)]]; }));
  const rawProjectionRanges=Object.fromEntries(["mean","floor","ceiling"].map(key=>{const values=available.map(player=>Number(player[key]||0));return[key,[Math.min(...values),Math.max(...values)]]}));
  const strategyWeights=STRATEGIES[strategy]||STRATEGIES.balanced,emphasisWeights=SOURCE_PROFILES[sourceProfile]||SOURCE_PROFILES.projectionLed;
  const weights=customWeights||(strategy==="custom"?emphasisWeights:Object.fromEntries(Object.keys(strategyWeights).map(key=>[key,Number(strategyWeights[key]||0)*.65+Number(emphasisWeights[key]||0)*.35])));
  const lineupMetrics=new Map(available.map(player=>[player.id,candidateLineupMetrics(player,roster,state.settings,draftable)])),lineupValues=[...lineupMetrics.values()].map(metric=>metric.starterContribution),lineupRange=[Math.min(...lineupValues),Math.max(...lineupValues)];
  const openCorePositions=["QB","RB","WR","TE"].filter(position=>Number(needs[position]||0)>0),optionalityActive=selectionRound<=8&&openCorePositions.length>=2&&Boolean(optionalityTargetPick),optionalityChoices=optionalityActive?futureStarterChoices({draftable,state,targetPick:optionalityTargetPick,selectionPick:Number(selectionPick||currentPick)}):null,futureAccess=new Map(available.map(player=>[player.id,optionalityActive?futureStarterAccess({player,roster,draftable,state,targetPick:optionalityTargetPick,selectionPick:Number(selectionPick||currentPick),choicesByPosition:optionalityChoices,needs}):0])),futureAccessValues=[...futureAccess.values()],futureAccessRange=[Math.min(...futureAccessValues),Math.max(...futureAccessValues)];
  const baseRanked=valued.map(row => {let {projectionValue,ceilingValue,floorValue}=row;const {player,replacementPoints}=row;
    const nextAvailability = availabilityTargetPick ? (waitingForUserPick?availabilityProbability:availabilityAfterSelection)(player,availabilityTargetPick,currentPick,{season:state.projectionSeason,settings:state.settings}) : 1;
    const basePositionalNeed=positionNeedScore(player.position,counts,state.settings.slots,needs),tightEndPriority=player.position!=="TE"||Number(needs.TE||0)<=0||tightEndPriorityIds.has(String(player.id)),positionalNeed=strategy==="custom"||tightEndPriority?basePositionalNeed:Math.min(basePositionalNeed,.22);
    const metrics=lineupMetrics.get(player.id),lineupImpact=scale(metrics.starterContribution,...lineupRange),specialist=specialistOpportunities.get(player.id);
    if(isSpecialist(player.position)&&specialist){projectionValue=specialist.adjustedMeanDelta;ceilingValue=Math.min(12,Math.max(0,ceilingValue)*.20);floorValue=specialist.adjustedFloorDelta}
    // While preparing for a future turn, availability is displayed separately
    // and must not change who is best if available at that pick. On the clock,
    // availability at the following turn still represents the cost of waiting.
    const riskRange=Number(weights.risk)>0?ranges.upsideRisk:ranges.risk,riskValue=Number(weights.risk)>0?Number(player.performanceRisk??player.risk):Number(player.risk);
    // A custom slider is a direct statement about the displayed player metric.
    // Cross-position value-over-replacement is useful inside the curated presets,
    // but it makes a projection-only custom lens contradict the label "Expected
    // season points" (for example, a lower-projected RB could outrank a higher-
    // projected WR). Keep the presets replacement-aware while making custom
    // projection/floor/ceiling weights operate on the raw displayed values.
    const customLens=strategy==="custom",projectionFactor=customLens?scale(player.mean,...rawProjectionRanges.mean):scale(projectionValue,...ranges.projection),ceilingFactor=customLens?scale(player.ceiling,...rawProjectionRanges.ceiling):scale(ceilingValue,...ranges.ceiling),floorFactor=customLens?scale(player.floor,...rawProjectionRanges.floor):scale(floorValue,...ranges.floor);
    const factors = { projection: projectionFactor, ceiling: ceilingFactor, floor: floorFactor, scarcity: scale(player.scarcity, ...ranges.scarcity), need: positionalNeed, availability: waitingForUserPick?0:1-nextAvailability, history:historyFactor(player,roster,currentPick,state.settings.teams), risk: scale(riskValue, ...riskRange), lineup:lineupImpact };
    const starterFilled=(counts[player.position]||0)>=(state.settings.slots[player.position]||0),missingCoreStarterSlots=["QB","RB","WR","TE"].reduce((sum,position)=>sum+Number(needs[position]||0),0),starterFlexibilityPenalty=starterFilled&&missingCoreStarterSlots>0?Math.min(.90,.45+missingCoreStarterSlots*.15):0,rosterCompletionPenalty=starterFlexibilityPenalty;
    const flexStillOpen=(needs.FLEX||0)>0;
    const duplicateStarterPenalty=positionOverdraftPenalty(player.position,counts,state.settings.slots,needs,selectionRound);
    const specialistTimingPenalty=isSpecialist(player.position)&&!specialist?.eligible ? .70 : 0;
    const positionRank=positionRanks.get(player.id)||1,rankFree=["RB","WR"].includes(player.position)?12:3,positionalTierPenalty=Math.min(.32,Math.max(0,positionRank-rankFree)*.045);
    const marketReachPenalty=0,surplus=Math.max(0,(counts[player.position]||0)-(state.settings.slots[player.position]||0)),benchCongestionPenalty=["RB","WR","TE"].includes(player.position)?Math.min(.20,surplus*.06):0;
    const lookAheadBonus=.18*lineupImpact,futureStarterAccessScore=futureAccess.get(player.id)||0,optionalityFactor=optionalityActive?scale(futureStarterAccessScore,...futureAccessRange):0,optionalityBonus=.08*optionalityFactor;
    // Presets include automatic football-policy guardrails. Custom means the
    // eight visible sliders exactly: eligibility/caps still keep the draft legal,
    // but hidden bonuses and penalties must not override the chosen weights.
    const policyAdjustment=customLens?0:lookAheadBonus+optionalityBonus-duplicateStarterPenalty-specialistTimingPenalty-benchCongestionPenalty-positionalTierPenalty-marketReachPenalty-rosterCompletionPenalty;
    const score = Object.entries(weights).reduce((sum, [key, weight]) => sum + (factors[key] || 0) * Number(weight), 0) + policyAdjustment;
    const drivers = [...Object.entries(weights).map(([key, weight]) => ({ key, impact: (factors[key] || 0) * Number(weight) })),...(!customLens&&starterFlexibilityPenalty>0?[{key:"starterFlexibility",impact:-starterFlexibilityPenalty}]:[])].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)).slice(0, 3);
    const rosterPriorityMultiplier=customLens?1:player.position==="QB"&&starterFilled?(counts.QB>=(state.settings.slots.QB||0)+1?.08:(flexStillOpen?.28:.48)):(["K","DST"].includes(player.position)&&starterFilled?.05:1);
    const planScore=score*rosterPriorityMultiplier;
    const upsideSpread=Math.max(0,ceilingValue-projectionValue),titleAsymmetryScore=ceilingValue+upsideSpread*.50,rawProjectionScore=["mean","floor","ceiling"].reduce((sum,key)=>sum+scale(player[key],...rawProjectionRanges[key]),0)/3;
    return { player, score, planScore, valueOverReplacement:projectionValue, ceilingValueOverReplacement:ceilingValue, floorValueOverReplacement:floorValue, upsideSpread, titleAsymmetryScore, rawProjectionScore, replacementPoints, replacementDelta:specialist?.replacementDelta??projectionValue, expectedWeeklyPoints:metrics.expectedWeeklyPoints, expectedWeeklyDelta:metrics.expectedWeeklyDelta, starterContribution:metrics.starterContribution, lookAheadBonus, futureStarterAccess:futureStarterAccessScore, optionalityFactor, optionalityBonus, optionalityTargetPick, nextPickAvailability: nextAvailability, availabilityConfidence:hasDecisionMarket(player)?"market":"low", nextUserPick:userNextPick, availabilityTargetPick, waitingForUserPick, factors, drivers, duplicateStarterPenalty, starterFlexibilityPenalty, rosterCompletionPenalty, requiredStarterSlotsBefore:Number(needs[player.position]||0), missingCoreStarterSlots, tightEndPriority, specialistTimingPenalty, benchCongestionPenalty, positionalTierPenalty, marketReachPenalty, positionRank, rosterPriorityMultiplier,remainingPicks:completion.remainingPicks,missingRequiredSlots:completion.missingRequiredSlots,rosterCompletionRequired:completion.completionRequired };
  }).sort((a, b) => b.planScore - a.planScore);
  // With an open starting TE slot, never reward another position because a TE
  // might survive a future turn. The current choice rests on TE value, tier,
  // scarcity, and roster completion instead of an ADP-derived wait path.
  const rolloutEligible=strategy!=="custom"&&selectionRound<=10&&selectionRoundsRemaining>1&&!completion.completionRequired&&Number(needs.TE||0)===0,rolloutFrontier=rolloutEligible?conditionalRolloutCandidateFrontier(baseRanked,{limit:Math.max(16,Math.min(24,Number(limit||8)*3))}):[],rollout=rolloutEligible?conditionalMultiPickRollouts({candidates:rolloutFrontier.map(item=>item.player),roster,draftable,state,userSlot,selectionPick:Number(selectionPick||currentPick),depth:2,scenarios:24,beamWidth:5,choiceWidth:5}):{active:false,futurePicks:[],scenarios:0,results:new Map()},rolloutScores=[...rollout.results.values()].map(result=>Number(result.score)).filter(Number.isFinite),rolloutRange=rolloutScores.length?[Math.min(...rolloutScores),Math.max(...rolloutScores)]:[0,0],rolloutWeight=strategy==="titleOnly"?.28:.14;
  const ranked=baseRanked.map(item=>{
    const result=rollout.results.get(String(item.player.id)),conditionalRolloutFactor=result?scale(result.score,...rolloutRange):0,coreNeedsAfter=Object.fromEntries(["QB","RB","WR","TE"].map(position=>[position,Math.max(0,Number(needs[position]||0)-(item.player.position===position?1:0))])),coreDebtAfter=Object.values(coreNeedsAfter).reduce((sum,value)=>sum+value,0),conditionalRolloutCoreCoverage=Boolean(result&&coreDebtAfter>0&&coreDebtAfter<=rollout.futurePicks.length&&Number(result.coreCoverageProbability)>=.5),conditionalRolloutBonus=conditionalRolloutCoverageBonus({bonus:result?rolloutWeight*conditionalRolloutFactor:0,coreDebtAfter,futurePickCount:rollout.futurePicks.length,coverageProbability:result?.coreCoverageProbability,covered:conditionalRolloutCoreCoverage}),score=item.score+conditionalRolloutBonus,planScore=score*item.rosterPriorityMultiplier,drivers=[...item.drivers,...(conditionalRolloutBonus>0?[{key:"conditionalRollout",impact:conditionalRolloutBonus}]:[])].sort((a,b)=>Math.abs(b.impact)-Math.abs(a.impact)).slice(0,3);
    return{...item,score,planScore,drivers,conditionalRolloutScore:result?.score??null,conditionalRolloutFactor,conditionalRolloutBonus,conditionalRolloutPicks:(result?.path||[]).map((player,index)=>Number(player.pickNo)||rollout.futurePicks[index]),conditionalRolloutPath:result?.path||[],conditionalRolloutPathShare:result?.pathShare??0,conditionalRolloutCoreCoverageProbability:result?.coreCoverageProbability??0,conditionalRolloutScenarios:result?rollout.scenarios:0,conditionalRolloutCoreCoverage};
  }).sort((a,b)=>b.planScore-a.planScore);
  if(completion.completionRequired&&completion.requiredPositions.size>1){const required=ranked.map((item,index)=>({item,index})).filter(({item})=>completion.requiredPositions.has(item.player.position)),selected=new Map();for(const position of completion.requiredPositions){const match=required.find(({item})=>item.player.position===position);if(match)selected.set(String(match.item.player.id),match)}for(const row of ranked.map((item,index)=>({item,index})))if(selected.size<Math.max(1,Number(limit)||8)&&!selected.has(String(row.item.player.id)))selected.set(String(row.item.player.id),row);return[...selected.values()].sort((a,b)=>a.index-b.index).map(row=>row.item)}
  return ranked;
}

export function selectSimulationShortlist(board,{limit=8}={}){
  return (board||[]).filter(item=>item?.simulationEligible!==false&&Number.isFinite(Number(item?.planScore))).sort((a,b)=>Number(b.planScore)-Number(a.planScore)||String(a.player?.id||"").localeCompare(String(b.player?.id||""))).slice(0,Math.max(1,Number(limit)||8));
}

const sourceProjectionValues=(player,platform)=>{
  const values={sleeper:null,espn:null,fantasyPros:null,owned:null},freshness={};
  for(const source of player?.projectionConsensus?.sources||[]){
    if(!source?.available||!Number.isFinite(Number(source.points))||Number(source.points)<=0)continue;
    const key=String(source.key||"");
    if(key in values)values[key]=Number(source.points);
    if(/owned|draftChampion|draftGoblin/i.test(key))values.owned=Number(source.points);
    if(source.fetchedAt)freshness[key]=String(source.fetchedAt)
  }
  const platformKey=String(platform||"").toLowerCase(),platformProjection=Number(player?.platformProjection);
  if(platformKey in values&&values[platformKey]===null&&Number.isFinite(platformProjection)&&platformProjection>0)values[platformKey]=platformProjection;
  const owned=Number(player?.draftGoblinProjection??player?.ownedProjection??player?.modelProjection);
  if(values.owned===null&&Number.isFinite(owned)&&owned>0)values.owned=owned;
  return{values,freshness}
};
// A floor/ceiling range cannot make a player simulation-eligible by itself.
// Live providers occasionally leave stale catalog rows with a zero mean while
// the range fallback still supplies a positive ceiling.
const hasUsableProjection=player=>Number.isFinite(Number(player?.mean))&&Number(player.mean)>0||Number(player?.projectionConsensus?.points)>0;

export function buildCandidateBoard(input){
  const{state}=input,byIdentity=playerIdentityIndex(state.players),drafted=new Set((state.picks||[]).map(pick=>String(byIdentity.get(String(pick.playerId))?.id??pick.playerId))),ranked=rankedRecommendationCandidates({...input,positions:undefined,limit:Number.MAX_SAFE_INTEGER,includeAllEligible:true}),rankedById=new Map(ranked.map((item,index)=>[String(item.player.id),{...item,decisionRank:index+1,simulationEligible:true,exclusionReason:null}])),rows=[];
  const currentPick=(state.picks||[]).length+1,userSlot=Number(input.userSlot),teams=Number(state.settings?.teams),rounds=Number(state.settings?.rounds),userNextPick=nextPickForSlot(currentPick-1,userSlot,teams,rounds),waitingForUserPick=snakeSlot(currentPick,teams)!==userSlot,selectionPick=waitingForUserPick?userNextPick:currentPick,availabilityTargetPick=waitingForUserPick?userNextPick:nextPickForSlot(selectionPick,userSlot,teams,rounds);
  for(const player of state.players||[]){
    if(drafted.has(String(player.id))||String(player.position||"")==="NA")continue;
    const scored=rankedById.get(String(player.id)),leadingTeEligible=input.strategy==="custom"||scored?.tightEndPriority!==false,sources=sourceProjectionValues(player,state.platform),configuredLimit=Number(state.settings.positionLimits?.[player.position]),positionUnsupported=Number(state.settings.slots?.[player.position]||0)<=0,projectionIneligible=player.eligibleForRecommendation===false,projectionUnavailable=!hasUsableProjection(player);
    let exclusionReason=null;
    if(scored&&!leadingTeEligible)exclusionReason="Outside the leading projected TE tier for the general simulated eight.";
    else if(!scored){
      if(positionUnsupported)exclusionReason="This league does not use this position.";
      else if(Number.isFinite(configuredLimit)&&configuredLimit<=0)exclusionReason="This position is disabled by league settings.";
      else if(projectionUnavailable)exclusionReason="Projection data is not available for this player yet.";
      else if(projectionIneligible)exclusionReason="Not eligible for the simulated shortlist with the current projection data.";
      else exclusionReason="Outside the legal shortlist for the current roster or draft timing."
    }
    const marketAvailable=availabilityTargetPick?(waitingForUserPick?availabilityProbability:availabilityAfterSelection)(player,availabilityTargetPick,currentPick,{season:state.projectionSeason,settings:state.settings}):1,marketFields={nextPickAvailability:marketAvailable,availabilityConfidence:hasDecisionMarket(player)?"market":"low",nextUserPick:userNextPick,availabilityTargetPick,waitingForUserPick};
    rows.push({...marketFields,...scored,player,sourceProjections:sources.values,sourceFreshness:sources.freshness,decisionRank:scored?.decisionRank??null,simulationEligible:Boolean(scored)&&leadingTeEligible,exclusionReason})
  }
  rows.sort((a,b)=>(a.decisionRank??Number.MAX_SAFE_INTEGER)-(b.decisionRank??Number.MAX_SAFE_INTEGER)||Number(b.player.mean||0)-Number(a.player.mean||0)||String(a.player.name||"").localeCompare(String(b.player.name||""))||String(a.player.id||"").localeCompare(String(b.player.id||"")));
  return rows
}

export function recommend(input){
  const ranked=rankedRecommendationCandidates(input);
  const teOnly=Array.isArray(input.positions)&&input.positions.length===1&&input.positions[0]==="TE",enforceLeadingTeTier=input.strategy!=="custom"&&!teOnly;
  return selectSimulationShortlist(ranked.map(item=>({...item,simulationEligible:!enforceLeadingTeTier||item.tightEndPriority!==false})),{limit:input.limit||8});
}
