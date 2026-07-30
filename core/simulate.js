import { mulberry32, normal } from "./random.js";
import { lineupPlayers,lineupScore } from "./roster.js";
import { snakeSlot } from "../shared/domain.js";
import { marketPickSd } from "./availability.js";
import { isSpecialist, regressedSpecialistValue, specialistOpportunity, specialistWaiverBaseline } from "./lineup-value.js";
import { normalizeQuantileDistribution, sampleQuantileDistribution } from "./quantile-distribution.js";
import { validatePlayerDistribution } from "../shared/player-distribution.js";
import { embeddedMissedGameRate, pairedWeeklySeasonFinishOrder, playerMissedGameRate, WEEKLY_SIMULATION_MODEL } from "./weekly-simulation.js";

// 2021-2024 out-of-sample weekly RMSE from data/research/hvpkod-projection-accuracy.json.
const WEEKLY_PROJECTION_RMSE={QB:6.6749,RB:5.5159,WR:5.3808,TE:3.9348,K:5.0108,DST:5.5};
export const TITLE_PRIOR_STRENGTH=15000;
export const SIMULATION_MODEL_VERSION="title-v8-counterfactual-candidate-coupling-calibrated-quantiles-asymmetric-player-outcomes-player-depth-availability-no-lineup-oracle";
const lineupWeeklyError=settings=>Math.sqrt(["QB","RB","WR","TE","K","DST"].reduce((sum,position)=>{const weight=isSpecialist(position)?.20:1;return sum+(settings.slots[position]||0)*((WEEKLY_PROJECTION_RMSE[position]||5.5)*weight)**2},0)+(settings.slots.FLEX||0)*WEEKLY_PROJECTION_RMSE.WR**2);

// Projection ranges need not be symmetric around the projected mean. The old
// model reduced (floor, ceiling) to a single standard deviation, making an
// upside-skewed range indistinguishable from a downside-skewed range of equal
// width. Treat each side as 1.5 standard deviations (the same range convention
// the prior `(ceiling-floor)/3` formula implied), then center the two-piece
// normal shock so its expected value is exactly zero.
const HALF_NORMAL_FIRST_MOMENT=1/Math.sqrt(2*Math.PI);
export function asymmetricProjectionShock(z,mean,floor,ceiling){const downsideSigma=Math.max(1,Number(mean)-Number(floor))/1.5,upsideSigma=Math.max(1,Number(ceiling)-Number(mean))/1.5,raw=z>=0?z*upsideSigma:z*downsideSigma,meanCorrection=HALF_NORMAL_FIRST_MOMENT*(upsideSigma-downsideSigma);return raw-meanCorrection}

// Common-random-number scenarios address draws by meaning, not call order.
// Candidate ordering therefore cannot change the simulated worlds.
const partHashCache=new Map(),roundRobinCache=new Map(),weeklyErrorCache=new WeakMap(),scenarioDraftPoolCache=new WeakMap();
const normalizedPlayerDistributionCache=new WeakMap();
function hashPart(value){const text=String(value),cached=partHashCache.get(text);if(cached!==undefined)return cached;let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)}h>>>=0;partHashCache.set(text,h);return h}
function keyedUniform(seed,scenario,...parts){let h=(seed^Math.imul(scenario+1,0x9e3779b1))>>>0;for(const part of parts){h^=hashPart(part);h=Math.imul(h^(h>>>16),0x85ebca6b)>>>0}h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;h=Math.imul(h,0x846ca68b);h^=h>>>16;return((h>>>0)+.5)/4294967296}
function keyedNormal(seed,scenario,...parts){const u1=Math.max(1e-12,keyedUniform(seed,scenario,...parts,"u1")),u2=keyedUniform(seed,scenario,...parts,"u2");return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2)}
const U1_HASH=hashPart("u1"),U2_HASH=hashPart("u2");
function mixKeyedPart(h,part){h^=hashPart(part);return Math.imul(h^(h>>>16),0x85ebca6b)>>>0}
function keyedBase(seed,scenario,a,b,c,d,count){let h=(seed^Math.imul(scenario+1,0x9e3779b1))>>>0;if(count>0)h=mixKeyedPart(h,a);if(count>1)h=mixKeyedPart(h,b);if(count>2)h=mixKeyedPart(h,c);if(count>3)h=mixKeyedPart(h,d);return h}
function uniformFromMixedHash(h){h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;h=Math.imul(h,0x846ca68b);h^=h>>>16;return((h>>>0)+.5)/4294967296}
function fixedKeyedUniform(seed,scenario,a,b,c,d,count){return uniformFromMixedHash(keyedBase(seed,scenario,a,b,c,d,count))}
function fixedKeyedNormal(seed,scenario,a,b,c,d,count){const h=keyedBase(seed,scenario,a,b,c,d,count),u1=Math.max(1e-12,uniformFromMixedHash(Math.imul((h^U1_HASH)^((h^U1_HASH)>>>16),0x85ebca6b)>>>0)),u2=uniformFromMixedHash(Math.imul((h^U2_HASH)^((h^U2_HASH)>>>16),0x85ebca6b)>>>0);return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2)}
export function createPairedScenario(seed,scenario){return{seed,scenario,playerValueCache:new WeakMap(),clearCaches(){this.playerValueCache=new WeakMap()},uniform(a,b,c,d){const count=arguments.length;return count<=4?fixedKeyedUniform(seed,scenario,a,b,c,d,count):keyedUniform(seed,scenario,...arguments)},normal(a,b,c,d){const count=arguments.length;return count<=4?fixedKeyedNormal(seed,scenario,a,b,c,d,count):keyedNormal(seed,scenario,...arguments)}}}

export function finishDraft(state, forcedPlayer, userSlot, random) {
  const teams=state.settings.teams,drafted=state._draftPoolBase?null:new Set(state._draftedBase||state.picks.map(p=>p.playerId)),rosters=state._rostersScratch||state._baseRosters?.map(()=>[])||Array.from({length:teams},()=>[]);if(state._baseRosters)for(let slot=0;slot<teams;slot++){rosters[slot].length=0;rosters[slot].push(...state._baseRosters[slot])}
  if(!state._baseRosters)for(const pick of state.picks){const p=state._playerById?.get(pick.playerId)||state.players.find(x=>x.id===pick.playerId);if(p)rosters[pick.slot-1].push(p)}
  // Unfilled K/DST slots are replaceable from waivers. Keep their simulated
  // value stable as the draft board is depleted; averaging only the remaining
  // specialists created an artificial late-round title-odds cliff for teams
  // that correctly waited on these positions.
  const specialistBaselines=state._specialistBaselines||Object.fromEntries(["K","DST"].map(position=>[position,replacementSpecialistProjection(state.players,position,state.settings)]));
  let positionCounts;
  const backfillMissingSpecialists=()=>{for(let slot=0;slot<rosters.length;slot++)for(const position of ["K","DST"]){const required=Number(state.settings.slots[position]||0),present=positionCounts?Number(positionCounts[slot][position]||0):rosters[slot].filter(player=>player.position===position).length,baseline=specialistBaselines[position];for(let index=present;baseline&&index<required;index++)rosters[slot].push({...baseline,id:`sim-replacement:${position}:${slot+1}:${index+1}`,simulatedAverage:true,simulatedReplacement:true,simulatedWaiverBackfill:true})}return rosters};
  let pickNo=state.picks.length+1,forcedUsed=false;if(pickNo>teams*state.settings.rounds)return backfillMissingSpecialists();
  // Candidate simulations measure player quality independently of market
  // availability. Reserve the candidate for the user's target pick in every
  // scenario; the separately calibrated availability model supplies the
  // survival percentage shown in the UI.
  const poolBase=state._draftPoolBase||state.players.filter(p=>!drafted.has(p.id)&&p.eligibleForRecommendation!==false),shareBoards=state._shareDraftBoards===true,cachedPool=shareBoards&&random&&typeof random==="object"?scenarioDraftPoolCache.get(random):null;
  let scoredPlayers=cachedPool?.poolBase===poolBase?cachedPool.scoredPlayers:null,scoredOrder=cachedPool?.poolBase===poolBase?cachedPool.scoredOrder:null,draftScores=cachedPool?.poolBase===poolBase?cachedPool.draftScores:null;
  if(!scoredPlayers){
    const sourcePlayers=state._draftPoolBase?poolBase:poolBase.filter(p=>!drafted.has(p.id)&&p.eligibleForRecommendation!==false),sourceScores=state._draftScoreScratch?.length===sourcePlayers.length?state._draftScoreScratch:new Float64Array(sourcePlayers.length),order=state._draftOrderScratch?.length===sourcePlayers.length?state._draftOrderScratch:Array.from({length:sourcePlayers.length},(_,index)=>index);
    for(let index=0;index<sourcePlayers.length;index++){const p=sourcePlayers[index],tightEndCenter=p.position==="TE"?state._tightEndDraftCenterById?.get(String(p.id)):null,draftCenter=Number.isFinite(tightEndCenter)?tightEndCenter:Number(p.adp||9999);order[index]=index;sourceScores[index]=draftCenter+(random.normal?random.normal("draft",p.id):normal(random))*Math.max(.5,(state._draftSdById?.get(p.id)??marketPickSd(p,{season:state.projectionSeason,settings:state.settings}))||8)}
    order.sort((a,b)=>sourceScores[a]-sourceScores[b]||String(sourcePlayers[a].id).localeCompare(String(sourcePlayers[b].id)));
    scoredPlayers=sourcePlayers;scoredOrder=Uint16Array.from(order);draftScores=Float64Array.from(order,index=>sourceScores[index]);
    if(shareBoards&&random&&typeof random==="object")scenarioDraftPoolCache.set(random,{poolBase,scoredPlayers,scoredOrder,draftScores});
  }
  const nextPoolIndex=state._nextPoolIndexScratch?.length===scoredOrder.length?state._nextPoolIndexScratch:new Int16Array(scoredOrder.length);let poolHead=-1,poolTail=-1,poolSize=0;for(let index=0;index<scoredOrder.length;index++){if(forcedPlayer&&scoredPlayers[scoredOrder[index]].id===forcedPlayer.id)continue;if(poolTail>=0)nextPoolIndex[poolTail]=index;else poolHead=index;poolTail=index;poolSize++}if(poolTail>=0)nextPoolIndex[poolTail]=-1;
  if(state._positionCountsScratch){positionCounts=state._positionCountsScratch;for(let slot=0;slot<teams;slot++){const target=positionCounts[slot],source=state._basePositionCounts[slot];for(const position of ["QB","RB","WR","TE","K","DST"])target[position]=Number(source[position]||0)}}else positionCounts=state._basePositionCounts?state._basePositionCounts.map(counts=>({...counts})):rosters.map(roster=>roster.reduce((out,p)=>((out[p.position]=(out[p.position]||0)+1),out),{}));const positionCaps=state._positionCaps||Object.fromEntries(["QB","RB","WR","TE","K","DST"].map(position=>{const fallback=position==="QB"?2:position==="K"||position==="DST"?1:position==="TE"?2:6,explicit=Number(state.settings.positionLimits?.[position]);return[position,Number.isFinite(explicit)&&explicit>=0?Math.min(fallback,explicit):fallback]})),requiredSlots=state._requiredSlots||Object.fromEntries(["QB","RB","WR","TE","K","DST","FLEX"].map(position=>[position,Number(state.settings.slots[position]||0)])),pickSlots=state._pickSlots,picksLeftByPick=state._picksLeftByPick;
  for(;pickNo<=teams*state.settings.rounds&&poolSize;pickNo++){
    const slot=pickSlots?pickSlots[pickNo]:snakeSlot(pickNo,teams),roster=rosters[slot-1],counts=positionCounts[slot-1];
    if(forcedPlayer&&slot===userSlot&&!forcedUsed){forcedUsed=true;roster.push({...forcedPlayer,simulationOutcomeKey:`forced-candidate:${userSlot}:${pickNo}`});counts[forcedPlayer.position]=(counts[forcedPlayer.position]||0)+1;continue}
    let bestIndex=-1,bestValue=-Infinity;
    const picksLeftForSlot=picksLeftByPick?picksLeftByPick[pickNo]:Number(state.settings.rounds)-Math.ceil(pickNo/teams)+1,flexFilled=Math.max(0,(counts.RB||0)-requiredSlots.RB)+Math.max(0,(counts.WR||0)-requiredSlots.WR)+Math.max(0,(counts.TE||0)-requiredSlots.TE),flexOpen=flexFilled<requiredSlots.FLEX,missingCore=Math.max(0,requiredSlots.QB-(counts.QB||0))+Math.max(0,requiredSlots.RB-(counts.RB||0))+Math.max(0,requiredSlots.WR-(counts.WR||0))+Math.max(0,requiredSlots.TE-(counts.TE||0))+Math.max(0,requiredSlots.K-(counts.K||0))+Math.max(0,requiredSlots.DST-(counts.DST||0)),missingRequired=missingCore+Math.max(0,requiredSlots.FLEX-flexFilled),completionRequired=missingRequired>0&&missingRequired>=picksLeftForSlot,searchLimit=completionRequired?poolSize:Math.min(32,poolSize);let opportunityPool,bestPrevious=-1,previous=-1,poolIndex=poolHead;
    for(let examined=0;examined<searchLimit;examined++){const p=scoredPlayers[scoredOrder[poolIndex]],draftScore=draftScores[poolIndex],required=Number(state.settings.slots[p.position]||0),count=Number(counts[p.position]||0),cap=positionCaps[p.position]??6;if(count<cap){let specialistEligible=true;if(isSpecialist(p.position)){if(count>=required)specialistEligible=false;else if(!completionRequired){if(!opportunityPool){opportunityPool=[];let opportunityIndex=poolHead;for(let opportunity=0;opportunity<searchLimit;opportunity++){opportunityPool.push(scoredPlayers[scoredOrder[opportunityIndex]]);opportunityIndex=nextPoolIndex[opportunityIndex]}}specialistEligible=specialistOpportunity({player:p,pool:opportunityPool,roster,settings:state.settings,eligibilityOnly:true}).eligible}}if(specialistEligible&&!(p.position==="QB"&&count>=required+1)){const starterNeed=count<required,flexEligible=p.position==="RB"||p.position==="WR"||p.position==="TE",flexNeed=flexOpen&&flexEligible&&count>=required;if(!completionRequired||starterNeed||flexNeed){const depthUseful=flexEligible&&count<cap,value=-draftScore+(starterNeed?14:flexNeed?6:depthUseful?1:0);if(value>bestValue){bestValue=value;bestIndex=poolIndex;bestPrevious=previous}}}}previous=poolIndex;poolIndex=nextPoolIndex[poolIndex]}
    if(bestIndex<0){bestIndex=poolHead;bestPrevious=-1}if(bestPrevious<0)poolHead=nextPoolIndex[bestIndex];else nextPoolIndex[bestPrevious]=nextPoolIndex[bestIndex];poolSize--;const selected=scoredPlayers[scoredOrder[bestIndex]],baseline=specialistBaselines[selected.position],rosterPlayer=baseline?{...baseline,id:`sim-replacement:${selected.position}:${slot}`,simulatedAverage:true,simulatedReplacement:true}:selected;roster.push(rosterPlayer);counts[selected.position]=(counts[selected.position]||0)+1;
  }
  // Some platform catalogs expose fewer draftable specialists than the league
  // requires. Treat an unfilled K/DST slot as the replacement-level waiver
  // option it is, never as a zero-point starter in the title simulation.
  return backfillMissingSpecialists();
}
export function roundRobinPairs(teamCount,week){const key=`${teamCount}:${week}`,cached=roundRobinCache.get(key);if(cached)return cached;const teams=Array.from({length:teamCount},(_,i)=>i);if(teamCount%2)teams.push(null);for(let round=0;round<week%(teams.length-1);round++)teams.splice(1,0,teams.pop());const pairs=[];for(let i=0;i<teams.length/2;i++){const a=teams[i],b=teams[teams.length-1-i];if(a!==null&&b!==null)pairs.push([a,b])}roundRobinCache.set(key,pairs);return pairs}
const cachedLineupWeeklyError=settings=>{let value=weeklyErrorCache.get(settings);if(value===undefined){value=lineupWeeklyError(settings);weeklyErrorCache.set(settings,value)}return value};
export function availabilityAdjustedLineupScore(roster,slots,value=p=>Number(p.mean||0),selectionValue=value){const starters=lineupPlayers(roster,slots,selectionValue),base=starters.reduce((sum,player)=>sum+value(player),0);return starters.reduce((expected,starter)=>{const rate=playerMissedGameRate(starter);if(!rate)return expected;const starterValue=value(starter),embedded=embeddedMissedGameRate(starter),activeRoleValue=starterValue/(1-embedded),incrementalLoss=Math.max(0,rate-embedded)*activeRoleValue,replacement=lineupScore(roster.filter(player=>player!==starter),slots,value,selectionValue),replacementContribution=Math.max(0,replacement-(base-starterValue));return expected-incrementalLoss+rate*replacementContribution},base)}

function normalizedPlayerDistribution(player,mean){
  const source=player?.distribution;
  if(!source||typeof source!=="object"||isSpecialist(player.position))return null;
  const scoringText=String(player?.projectionScoring||player?.adpScoring||"").toLowerCase(),scoringFormat=scoringText==="std"||scoringText==="standard"?"standard":scoringText==="half"||scoringText==="half-ppr"||scoringText==="halfppr"?"half-ppr":scoringText==="ppr"?"ppr":scoringText==="custom"?"custom":undefined,season=Number(player?.projectionSeason);
  const expected={...(Number.isInteger(season)?{season}:{}),...(scoringFormat?{scoringFormat}:{})};
  const contextKey=`${Number.isInteger(season)?season:""}:${scoringFormat||""}`,cached=normalizedPlayerDistributionCache.get(source);
  if(cached&&cached.mean===mean&&cached.contextKey===contextKey)return cached.distribution;
  if(source.schemaVersion&& !validatePlayerDistribution(source,expected).valid){normalizedPlayerDistributionCache.set(source,{mean,contextKey,distribution:null});return null}
  try{const distribution=normalizeQuantileDistribution(source,{lowerBound:0,targetMean:mean});normalizedPlayerDistributionCache.set(source,{mean,contextKey,distribution});return distribution}catch{return null}
}

// A calibrated distribution already contains projection miss and asymmetric
// player-outcome uncertainty. Adding the legacy RMSE shock on top would count
// the same forecast error twice. Availability is deliberately not sampled here;
// availabilityAdjustedLineupScore composes that separate process with depth.
export function simulatedPlayerSeasonTotal(player,projectionNormal,errorNormal,{specialistBaseline=null}={}){
  const specialistWeight=isSpecialist(player.position)?.20:1,mean=isSpecialist(player.position)?regressedSpecialistValue(player,specialistBaseline):Number(player.mean||0),distribution=normalizedPlayerDistribution(player,mean);
  if(distribution)return sampleQuantileDistribution(distribution,{normal:projectionNormal});
  const historicalSeasonError=player.performanceRangeIncludesHistoricalError?0:(WEEKLY_PROJECTION_RMSE[player.position]||5.5)*Math.sqrt(17)*specialistWeight,projectionShock=asymmetricProjectionShock(projectionNormal,mean,Number(player.floor??mean),Number(player.ceiling??mean))*specialistWeight;
  return mean+projectionShock+errorNormal*historicalSeasonError
}

export function playoffWinner(seeds,strengths,random){const play=(a,b)=>strengths[a]+normal(random)*18>=strengths[b]+normal(random)*18?a:b;if(seeds.length===6){const wild=[play(seeds[2],seeds[5]),play(seeds[3],seeds[4])],remaining=[seeds[1],...wild].sort((a,b)=>seeds.indexOf(a)-seeds.indexOf(b)),semiA=play(seeds[0],remaining.at(-1)),semiB=play(remaining[0],remaining[1]);return play(semiA,semiB)}let field=[...seeds];while(field.length>1){const next=[];for(let i=0;i<Math.floor(field.length/2);i++)next.push(play(field[i],field[field.length-1-i]));if(field.length%2)next.unshift(field[Math.floor(field.length/2)]);field=next}return field[0]}

export function pairedPlayoffWinner(seeds,strengths,scenario){
  const noise=scenario.playoffNoiseCache||(scenario.playoffNoiseCache=new Map()),shock=(round,team)=>{const key=round*64+team,cached=noise.get(key);if(cached!==undefined)return cached;const value=scenario.normal("playoff",round,team);noise.set(key,value);return value},play=(a,b,round)=>strengths[a]+shock(round,a)*18>=strengths[b]+shock(round,b)*18?a:b;
  if(seeds.length===6){
    // Standard six-team bracket: seeds 1 and 2 receive first-round byes.
    const wild=[play(seeds[2],seeds[5],0),play(seeds[3],seeds[4],0)];
    const remaining=[seeds[1],...wild].sort((a,b)=>seeds.indexOf(a)-seeds.indexOf(b));
    const semiA=play(seeds[0],remaining.at(-1),1),semiB=play(remaining[0],remaining[1],1);
    return play(semiA,semiB,2);
  }
  let round=0,field=[...seeds];
  while(field.length>1){const next=[];for(let i=0;i<Math.floor(field.length/2);i++)next.push(play(field[i],field[field.length-1-i],round));if(field.length%2)next.unshift(field[Math.floor(field.length/2)]);field=next;round++}
  return field[0]
}

export function calibrateTitleProbability({wins,iterations,teams}){const priorStrength=TITLE_PRIOR_STRENGTH,priorProbability=1/teams,p=(wins+priorStrength*priorProbability)/(iterations+priorStrength),effectiveIterations=iterations,se=Math.sqrt(Math.max(.000001,p*(1-p)/effectiveIterations));return{championshipProbability:p,priorProbability,priorStrength,interval:[Math.max(0,p-1.96*se),Math.min(1,p+1.96*se)]}}

export function seasonFinishOrder(rosters, settings, random) {
  const pool=rosters.flat();
  const specialistBaselines=Object.fromEntries(["K","DST"].map(position=>[position,specialistWaiverBaseline(position,pool,settings)]));
  const projectedLineupValue=p=>(isSpecialist(p.position)?regressedSpecialistValue(p,specialistBaselines[p.position]):Number(p.mean||0))/17,playerValues=new Map(),playerValue=p=>{let value=playerValues.get(p);if(value!==undefined)return value;value=simulatedPlayerSeasonTotal(p,normal(random),normal(random),{specialistBaseline:specialistBaselines[p.position]})/17;playerValues.set(p,value);return value},strengths=rosters.map(r=>availabilityAdjustedLineupScore(r,settings.slots,playerValue,projectedLineupValue));
  const wins = strengths.map(() => 0);
  const weeklyError=cachedLineupWeeklyError(settings);for(let week=0;week<14;week++)for(const[a,b]of roundRobinPairs(strengths.length,week)){const sa=strengths[a]+normal(random)*weeklyError,sb=strengths[b]+normal(random)*weeklyError;wins[sa>=sb?a:b]++}
  const regular=strengths.map((s,i)=>i).sort((a,b)=>wins[b]-wins[a]||strengths[b]-strengths[a]),seeds=regular.slice(0,settings.playoffTeams),champion=playoffWinner(seeds,strengths,random);
  return[champion,...regular.filter(team=>team!==champion)];
}
const seasonOutcome=(rosters,settings,random)=>seasonFinishOrder(rosters,settings,random)[0];

export function pairedSeasonFinishOrder(rosters,settings,scenario){
  const pool=rosters.flat(),specialistBaselines=Object.fromEntries(["K","DST"].map(position=>[position,specialistWaiverBaseline(position,pool,settings)])),projectedLineupValue=p=>(isSpecialist(p.position)?regressedSpecialistValue(p,specialistBaselines[p.position]):Number(p.mean||0))/17,playerValues=new Map(),sharedPlayerValues=scenario.playerValueCache,playerValue=p=>{let value=playerValues.get(p);if(value!==undefined)return value;const outcomeKey=p.simulationOutcomeKey||p.id,specialist=isSpecialist(p.position);if(!specialist){value=sharedPlayerValues.get(p);if(value!==undefined){playerValues.set(p,value);return value}}value=simulatedPlayerSeasonTotal(p,scenario.normal("player-projection",outcomeKey),scenario.normal("player-error",outcomeKey),{specialistBaseline:specialistBaselines[p.position]})/17;playerValues.set(p,value);if(!specialist)sharedPlayerValues.set(p,value);return value},strengths=rosters.map(r=>availabilityAdjustedLineupScore(r,settings.slots,playerValue,projectedLineupValue)),wins=strengths.map(()=>0),weeklyError=cachedLineupWeeklyError(settings);
  const teamCount=strengths.length,noiseKey=`regular:${teamCount}`,cachedNoise=scenario.regularNoiseCache,regularNoise=cachedNoise?.key===noiseKey?cachedNoise.values:new Float64Array(14*teamCount);if(cachedNoise?.key!==noiseKey){for(let week=0;week<14;week++)for(let team=0;team<teamCount;team++)regularNoise[week*teamCount+team]=scenario.normal("regular",week,team);scenario.regularNoiseCache={key:noiseKey,values:regularNoise}}for(let week=0;week<14;week++)for(const[a,b]of roundRobinPairs(teamCount,week)){const sa=strengths[a]+regularNoise[week*teamCount+a]*weeklyError,sb=strengths[b]+regularNoise[week*teamCount+b]*weeklyError;wins[sa>=sb?a:b]++}
  const regular=strengths.map((s,i)=>i).sort((a,b)=>wins[b]-wins[a]||strengths[b]-strengths[a]||a-b),seeds=regular.slice(0,settings.playoffTeams),champion=pairedPlayoffWinner(seeds,strengths,scenario);return[champion,...regular.filter(team=>team!==champion)]
}

export { pairedWeeklySeasonFinishOrder, WEEKLY_SIMULATION_MODEL };
export function pairedWeeklyFinishOrder(rosters,settings,scenario){return pairedWeeklySeasonFinishOrder(rosters,settings,scenario,{simulatePlayerSeasonTotal:simulatedPlayerSeasonTotal,roundRobinPairs,weeklyError:cachedLineupWeeklyError(settings)})}

export function projectedTightEndDraftCenters(players,settings={}){
  const teams=Math.max(2,Number(settings.teams||10)),tightEnds=(players||[]).filter(player=>player.position==="TE"&&player.eligibleForRecommendation!==false).sort((a,b)=>(Number(b.mean||0)+Math.max(0,Number(b.ceiling||0)-Number(b.mean||0))*.15)-(Number(a.mean||0)+Math.max(0,Number(a.ceiling||0)-Number(a.mean||0))*.15)||String(a.id).localeCompare(String(b.id))),leader=tightEnds[0],replacement=tightEnds[Math.min(tightEnds.length-1,teams-1)],leaderValue=Number(leader?.mean||0)+Math.max(0,Number(leader?.ceiling||0)-Number(leader?.mean||0))*.15,replacementValue=Number(replacement?.mean||0)+Math.max(0,Number(replacement?.ceiling||0)-Number(replacement?.mean||0))*.15,range=Math.max(1,leaderValue-replacementValue),centers=new Map();
  tightEnds.forEach((player,index)=>{const value=Number(player.mean||0)+Math.max(0,Number(player.ceiling||0)-Number(player.mean||0))*.15,tierQuality=Math.max(0,Math.min(1,(value-replacementValue)/range)),starterTierRound=3+(1-tierQuality)*4,depthRounds=Math.max(0,index-teams+1)*.5;centers.set(String(player.id),teams*(starterTierRound+depthRounds))});
  return centers;
}

export function simulationDraftPool(state,drafted=new Set(state.picks.map(pick=>pick.playerId))){
  const available=state.players.filter(player=>!drafted.has(player.id)&&player.eligibleForRecommendation!==false).sort((a,b)=>a.position==="TE"&&b.position==="TE"?Number(b.mean||0)-Number(a.mean||0):a.position==="TE"?1:b.position==="TE"?-1:Number(a.adp||9999)-Number(b.adp||9999)||Number(b.mean||0)-Number(a.mean||0));
  // Retain every league draft slot plus a full five rounds of 12-team depth.
  // The prior ten-round reserve inflated early-draft exact work by 25% while
  // never being reachable in a completed roster simulation.
  const capped=available.slice(0,Math.max(240,state.settings.teams*state.settings.rounds+60)),retainedIds=new Set(capped.map(player=>player.id));
  // K/DST commonly have no market ADP and sort behind the capped core-player
  // pool. Retain them whenever the league requires them so simulated roster
  // completion cannot silently leave starter slots empty.
  for(const position of ["TE","K","DST"]){const required=Number(state.settings.slots[position]||0);if(required<=0)continue;const depth=position==="TE"?required+1:required,draftable=available.filter(player=>player.position===position).sort((a,b)=>Number(b.mean||0)-Number(a.mean||0)).slice(0,Number(state.settings.teams)*depth);for(const player of draftable)if(!retainedIds.has(player.id)){capped.push(player);retainedIds.add(player.id)}}
  return capped;
}

export function replacementSpecialistProjection(players,position,settings){
  const eligible=players.filter(player=>player.eligibleForRecommendation!==false),baseline=specialistWaiverBaseline(position,eligible,settings);
  if(!baseline)return null;
  return{...baseline,id:`sim-replacement:${position}`,name:`Replacement ${position}`,team:"FA",eligibleForRecommendation:false,simulatedAverage:true,simulatedReplacement:true};
}

function prepareSimulationState(state,{shareDraftBoards=false}={}){const playerById=new Map();for(const player of state.players){playerById.set(String(player.id),player);const platformId=player.platformPlayerId;if(platformId!==undefined&&platformId!==null&&String(platformId)!==""&&!playerById.has(String(platformId)))playerById.set(String(platformId),player)}const resolvedPicks=state.picks.map(pick=>({pick,player:playerById.get(String(pick.playerId))||playerById.get(String(pick.platformPlayerId??""))})),drafted=new Set(resolvedPicks.map(({pick,player})=>player?.id??pick.playerId)),draftPool=simulationDraftPool(state,drafted),tightEndDraftCenterById=projectedTightEndDraftCenters(draftPool,state.settings),specialistBaselines=Object.fromEntries(["K","DST"].map(position=>[position,replacementSpecialistProjection(state.players,position,state.settings)])),baseRosters=Array.from({length:state.settings.teams},()=>[]);for(const{pick,player}of resolvedPicks)if(player)baseRosters[pick.slot-1].push(player);const basePositionCounts=baseRosters.map(roster=>roster.reduce((out,p)=>((out[p.position]=(out[p.position]||0)+1),out),{})),draftSdById=new Map(draftPool.map(player=>[player.id,marketPickSd(player,{season:state.projectionSeason,settings:state.settings})])),positionCaps=Object.fromEntries(["QB","RB","WR","TE","K","DST"].map(position=>{const fallback=position==="QB"?2:position==="K"||position==="DST"?1:position==="TE"?2:6,explicit=Number(state.settings.positionLimits?.[position]);return[position,Number.isFinite(explicit)&&explicit>=0?Math.min(fallback,explicit):fallback]})),requiredSlots=Object.fromEntries(["QB","RB","WR","TE","K","DST","FLEX"].map(position=>[position,Number(state.settings.slots[position]||0)])),totalPicks=Number(state.settings.teams)*Number(state.settings.rounds),pickSlots=new Uint16Array(totalPicks+1),picksLeftByPick=new Uint16Array(totalPicks+1),draftScoreScratch=new Float64Array(draftPool.length),draftOrderScratch=Array.from({length:draftPool.length},(_,index)=>index),rostersScratch=shareDraftBoards?baseRosters.map(()=>[]):null,positionCountsScratch=shareDraftBoards?basePositionCounts.map(()=>({})):null,nextPoolIndexScratch=shareDraftBoards?new Int16Array(draftPool.length):null;for(let pickNo=1;pickNo<=totalPicks;pickNo++){pickSlots[pickNo]=snakeSlot(pickNo,Number(state.settings.teams));picksLeftByPick[pickNo]=Number(state.settings.rounds)-Math.ceil(pickNo/Number(state.settings.teams))+1}return{...state,_playerById:playerById,_draftPoolBase:draftPool,_tightEndDraftCenterById:tightEndDraftCenterById,_specialistBaselines:specialistBaselines,_draftedBase:drafted,_baseRosters:baseRosters,_basePositionCounts:basePositionCounts,_draftSdById:draftSdById,_positionCaps:positionCaps,_requiredSlots:requiredSlots,_pickSlots:pickSlots,_picksLeftByPick:picksLeftByPick,_draftScoreScratch:draftScoreScratch,_draftOrderScratch:draftOrderScratch,_rostersScratch:rostersScratch,_positionCountsScratch:positionCountsScratch,_nextPoolIndexScratch:nextPoolIndexScratch,_shareDraftBoards:shareDraftBoards}}
export function createSimulationSession({state,userSlot,iterations=800,seed=42,simulationModel="legacy",scenarioOffset=0}){if(simulationModel!=="legacy"&&simulationModel!==WEEKLY_SIMULATION_MODEL)throw new Error(`Unknown simulation model: ${simulationModel}`);const offset=Math.max(0,Number(scenarioOffset)||0);return{state,userSlot,iterations,seed,simulationModel,scenarioOffset:offset,prepared:prepareSimulationState(state,{shareDraftBoards:true}),scenarios:Array.from({length:iterations},(_,iteration)=>createPairedScenario(seed,offset+iteration))}}

export function simulateCandidate({ state, candidate, userSlot, iterations = 800, seed = 42, simulationModel="legacy", session=null }) {
  if(session){if(session.state!==state||session.userSlot!==userSlot||session.iterations!==iterations||session.seed!==seed)throw new Error("Simulation session does not match request");simulationModel=session.simulationModel}
  if(simulationModel!=="legacy"&&simulationModel!==WEEKLY_SIMULATION_MODEL)throw new Error(`Unknown simulation model: ${simulationModel}`);
  const wins=Array(state.settings.teams).fill(0),scenarioWins=new Uint8Array(iterations),planScenarioWins=new Uint8Array(iterations),scenarioSelected=new Uint8Array(iterations),prepared=session?.prepared||prepareSimulationState(state);let candidateSelections=0,candidateWins=0;
  for(let i=0;i<iterations;i++){const scenario=session?.scenarios[i]||createPairedScenario(seed,i),rosters=finishDraft(prepared,candidate,userSlot,scenario),selected=candidate?rosters[userSlot-1].some(player=>player.id===candidate.id):true,champion=(simulationModel===WEEKLY_SIMULATION_MODEL?pairedWeeklyFinishOrder:pairedSeasonFinishOrder)(rosters,state.settings,scenario)[0],userWon=champion===userSlot-1;scenarioSelected[i]=selected?1:0;candidateSelections+=selected;wins[champion]++;if(userWon)planScenarioWins[i]=1;if(selected&&userWon){candidateWins++;scenarioWins[i]=1}}
  const sampleIterations=candidate?candidateSelections:iterations,sampleWins=candidate?candidateWins:wins[userSlot-1],rawProbability=sampleIterations?sampleWins/sampleIterations:1/state.settings.teams,calibrated=calibrateTitleProbability({wins:sampleWins,iterations:Math.max(1,sampleIterations),teams:state.settings.teams}),planRawProbability=wins[userSlot-1]/iterations,planCalibrated=calibrateTitleProbability({wins:wins[userSlot-1],iterations,teams:state.settings.teams});
  const scenarioBankId=`crn-v1:${seed}:${iterations}${simulationModel==="legacy"?"":`:${simulationModel}`}`,result={...calibrated,rawProbability,conditionalRawProbability:rawProbability,conditionalChampionshipProbability:calibrated.championshipProbability,planRawProbability,planChampionshipProbability:planCalibrated.championshipProbability,conditional:Boolean(candidate),candidateSelectionProbability:candidate?candidateSelections/iterations:null,effectiveCandidateIterations:sampleIterations,iterations,seed,simulationModel,scenarioBankId};Object.defineProperties(result,{scenarioWins:{value:scenarioWins,enumerable:false},planScenarioWins:{value:planScenarioWins,enumerable:false},scenarioSelected:{value:scenarioSelected,enumerable:false}});return result;
}

export function simulateCandidateBatch({state,candidates,userSlot,iterations=800,seed=42,simulationModel="legacy",scenarioOffset=0,onProgress=null}){
  if(simulationModel!=="legacy"&&simulationModel!==WEEKLY_SIMULATION_MODEL)throw new Error(`Unknown simulation model: ${simulationModel}`);
  const offset=Math.max(0,Number(scenarioOffset)||0),prepared=prepareSimulationState(state,{shareDraftBoards:true}),finishOrder=simulationModel===WEEKLY_SIMULATION_MODEL?pairedWeeklyFinishOrder:pairedSeasonFinishOrder,rows=candidates.map(()=>({scenarioWins:new Uint8Array(iterations),planScenarioWins:new Uint8Array(iterations),scenarioSelected:new Uint8Array(iterations)}));
  for(let iteration=0;iteration<iterations;iteration++){
    const scenario=createPairedScenario(seed,offset+iteration);
    for(let candidateIndex=0;candidateIndex<candidates.length;candidateIndex++){
      const candidate=candidates[candidateIndex],row=rows[candidateIndex],rosters=finishDraft(prepared,candidate,userSlot,scenario),selected=candidate?rosters[userSlot-1].some(player=>player.id===candidate.id):true,champion=finishOrder(rosters,state.settings,scenario)[0],userWon=champion===userSlot-1;
      row.scenarioSelected[iteration]=selected?1:0;if(userWon)row.planScenarioWins[iteration]=1;if(selected&&userWon)row.scenarioWins[iteration]=1;
    }
    scenarioDraftPoolCache.delete(scenario);scenario.clearCaches();
    if(onProgress&&(iteration===iterations-1||(iteration+1)%8===0))onProgress(iteration+1,iterations);
  }
  return rows
}

export function pairedDifference(candidateSimulation,baselineSimulation,{prefixIterations=Infinity,z=1.96,conditional=false}={}){if(candidateSimulation?.scenarioBankId&&baselineSimulation?.scenarioBankId&&candidateSimulation.scenarioBankId!==baselineSimulation.scenarioBankId)return null;const usePlan=!conditional&&candidateSimulation?.planScenarioWins&&baselineSimulation?.planScenarioWins,a=usePlan?candidateSimulation.planScenarioWins:candidateSimulation?.scenarioWins,b=usePlan?baselineSimulation.planScenarioWins:baselineSimulation?.scenarioWins,selectedA=usePlan?null:candidateSimulation?.scenarioSelected,selectedB=usePlan?null:baselineSimulation?.scenarioSelected;if(!a||!b)return null;const prefix=Math.min(a.length,b.length,Math.max(0,Number(prefixIterations)||0));if(!prefix)return null;let sum=0,sumSquares=0,n=0;for(let i=0;i<prefix;i++){if((selectedA&&!selectedA[i])||(selectedB&&!selectedB[i]))continue;const d=a[i]-b[i];sum+=d;sumSquares+=d*d;n++}if(!n)return null;const mean=sum/n,variance=n>1?Math.max(0,(sumSquares-n*mean*mean)/(n-1)):0,standardError=Math.sqrt(variance/n),model=candidateSimulation.simulationModel||"legacy";return{rawDifference:mean,standardError,interval:[mean-z*standardError,mean+z*standardError],iterations:n,scenarioIterations:prefix,paired:true,conditional:!usePlan,scenarioBankId:`crn-v1:${candidateSimulation.seed}:${prefix}${model==="legacy"?"":`:${model}`}`}}
