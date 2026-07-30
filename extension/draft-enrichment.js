import{expandEspnCatalog}from"./espn-catalog.js";
import{espnCandidateEligible}from"./sidepanel-state.js";
import{buildPlayerIdentityIndex,matchPlayerIdentity}from"./player-identity.js";
import{distributionPerformanceRisk,distributionRange,playerSpecificPerformanceRange,promotedPlayerDistribution}from"./player-distribution-enrichment.js";
import{calibratePlayerProjectionRows,PLAYER_CONSENSUS_NEIGHBORHOOD_SIZE,PLAYER_CONSENSUS_OWNED_SIGNAL_WEIGHT,PROVIDER_RANGE_SMOOTHING_POINTS}from"./projection-range-guard.js";
import{DEFAULT_PROJECTION_DRIVER,projectionDriverSelection}from"./site-projection-blend.js";

let cachedBaseline,cachedBaselineIndexes;
const identityCache=new WeakMap();
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const usableMarketRank=value=>{const rank=Number(value);return Number.isFinite(rank)&&rank>0&&rank<500?rank:null};
export function projectedAvailability({player,baselinePlayer,ownedPlayer,injuryStatus,season}){
  const inherited=baselinePlayer?.availability??player?.availability??null,expectedGames=Number(ownedPlayer?.expectedGames),activeRoleGames=Number(ownedPlayer?.activeRoleGames),hasGames=Number(ownedPlayer?.season)===Number(season)&&Number.isFinite(expectedGames)&&Number.isFinite(activeRoleGames)&&activeRoleGames>=12&&activeRoleGames<=18&&expectedGames>=0&&expectedGames<=activeRoleGames,forecastRate=hasGames?1-expectedGames/activeRoleGames:null,rawInherited=inherited?.missedGameRate,inheritedRate=typeof rawInherited==="number"?rawInherited:NaN,baseRate=Number.isFinite(forecastRate)?forecastRate:Number.isFinite(inheritedRate)?inheritedRate:null;
  if(baseRate==null)return inherited;
  // The current designation remains metadata unless a timestamped projection
  // model quantifies it. Hard-coded Questionable/Out multipliers double-count
  // provider mean adjustments and failed the historical injury-feature gate.
  const missedGameRate=clamp(baseRate,0,.99),components={...(Number.isFinite(forecastRate)?{gamesForecast:Number(forecastRate.toFixed(4)),expectedGames,activeRoleGames}:{}),...(injuryStatus?{currentInjuryStatus:String(injuryStatus)}:{})};
  return{schemaVersion:"availability-v1",season:Number(season),missedGameRate:Number(missedGameRate.toFixed(4)),activeProbability:Number((1-missedGameRate).toFixed(4)),embeddedMissedGameRate:Number.isFinite(forecastRate)?Number(forecastRate.toFixed(4)):Number(inherited?.embeddedMissedGameRate||0),estimationLevel:Number.isFinite(forecastRate)?"player-games-forecast":String(inherited?.estimationLevel||"inherited-player-availability"),modelVersion:Number.isFinite(forecastRate)?String(ownedPlayer.availabilityModelVersion||"owned-games-forecast"):String(inherited?.modelVersion||"availability-v1"),conditionedOn:"active-role-opportunity",components};
}
const identityIndex=players=>{
  if(!Array.isArray(players))return buildPlayerIdentityIndex([]);
  let index=identityCache.get(players);
  if(!index){
    index=buildPlayerIdentityIndex(players);
    identityCache.set(players,index);
  }
  return index;
};

export function enrichLiveDraftState({state,baseline,draftGoblinFeed={players:[]},fantasyPros={players:[]},sleeper={players:[]},projectionDriver=DEFAULT_PROJECTION_DRIVER}){
  const season=Number(state.projectionSeason||new Date().getFullYear()),reception=Number(state.settings?.scoring?.reception||0),scoring=reception>=.75?"PPR":reception>=.25?"HALF":"STD";
  if(cachedBaseline!==baseline){cachedBaseline=baseline;cachedBaselineIndexes={byId:new Map((baseline.players||[]).map(player=>[String(player.id),player])),identity:buildPlayerIdentityIndex(baseline.players||[])}}
  const{byId,identity}=cachedBaselineIndexes,draftGoblinIndex=identityIndex(draftGoblinFeed.players||[]),fpIndex=identityIndex(fantasyPros.players||[]),sleeperIndex=identityIndex(sleeper.players||[]),baselineFor=player=>byId.get(String(player.id))||matchPlayerIdentity(identity,player),draftGoblinFor=player=>matchPlayerIdentity(draftGoblinIndex,player),fantasyProsFor=player=>matchPlayerIdentity(fpIndex,player),sleeperFor=player=>matchPlayerIdentity(sleeperIndex,player);
  state=expandEspnCatalog(state,baseline.players||[]);
  if(state.platform==="espn"){
    const pickedIds=new Set(state.picks.map(pick=>String(pick.playerId)));
    state={...state,players:state.players.filter(player=>pickedIds.has(String(player.id))||espnCandidateEligible({player,baseline:baselineFor(player),draftGoblin:draftGoblinFor(player),fantasyPros:fantasyProsFor(player),sleeper:sleeperFor(player),season}))};
  }
  const scoringFormat=scoring==="STD"?"standard":scoring==="HALF"?"half-ppr":"ppr",distributionModel=baseline.distributionModel,distributionVersion=distributionModel?.runtimeStatus==="promoted"?distributionModel.modelVersion:null;
  const contexts=state.players.map(player=>{
    const found=baselineFor(player),ownedDaily=draftGoblinFor(player),fp=fantasyProsFor(player),sp=sleeperFor(player),sameSeason=!player.projectionSeason||Number(player.projectionSeason)===season,platformProjection=sameSeason?Number(player.platformProjection||0):0,rawDraftGoblinProjection=Number(ownedDaily?.points)>0&&Number(ownedDaily?.season)===season?Number(ownedDaily.points):null,sleeperFallback=state.platform==="espn"&&Number(sp?.points||0)>0&&Number(sp?.season)===season?sp:null;
    const providerPoints={...(platformProjection>0?{[state.platform]:platformProjection}:{}),...(sleeperFallback?{sleeper:Number(sleeperFallback.points)}:{}),...(Number(fp?.season)===season&&Number(fp?.points)>0?{fantasyPros:Number(fp.points)}:{})};
    return{player,found,ownedDaily,fp,sp,platformProjection,rawDraftGoblinProjection,sleeperFallback,providerPoints};
  });
  const marketAdjustedShadow=draftGoblinFeed.projectionVariant==="market-adjusted-shadow-v2";
  const calibrations=calibratePlayerProjectionRows(contexts.map(context=>({position:context.player.position,rawCandidate:context.rawDraftGoblinProjection,providerPoints:context.providerPoints})));
  const players=contexts.map((context,index)=>{
    const{player,found,ownedDaily,fp,sp,platformProjection,rawDraftGoblinProjection,sleeperFallback}=context,draftGoblinCalibration=calibrations[index],draftGoblinProjection=draftGoblinCalibration.value;
    const consensus=projectionDriverSelection({season,platform:state.platform,driver:projectionDriver,siteProjection:platformProjection,siteSeason:player.projectionSeason||season,draftGoblinProjection}),mean=consensus.points;
    const externalEligible=state.platform==="espn"&&player.eligibleForRecommendation===false&&espnCandidateEligible({player,baseline:found,draftGoblin:ownedDaily,fantasyPros:fp,sleeper:sp,season}),externalRank=usableMarketRank(sleeperFallback?.adp),baselineMarketRank=state.platform==="sleeper"?null:usableMarketRank(found?.adp),marketRank=externalEligible&&externalRank!==null?externalRank:usableMarketRank(player.adp)??baselineMarketRank,hasMarketRank=marketRank!==null;
    const injuryStatus=sleeperFallback?.injuryStatus||player.injuryStatus||null,availability=projectedAvailability({player,baselinePlayer:found,ownedPlayer:ownedDaily,injuryStatus,season}),experience=Number(found?.yearsExperience??player.yearsExperience??player.yearsExp),rookieProfile=experience===0&&baseline.performanceRangeModel?.rookiePrior?{...baseline.performanceRangeModel.rookiePrior,rookiePrior:true,weeklyRows:0,artifactId:baseline.performanceRangeModel.artifactId}:null,distribution=promotedPlayerDistribution({model:distributionModel,player,mean,season,scoringFormat}),range=distributionRange(distribution),legacyProfile=distributionModel?.runtimeStatus==="promoted"?null:found?.performanceRangeProfile||rookieProfile,neutralRange=playerSpecificPerformanceRange(mean,player.position,legacyProfile),performanceRisk=distribution?distributionPerformanceRisk(range,mean):neutralRange.performanceRisk,risk=Math.max(performanceRisk,injuryStatus?0.8:0);
    const calibration={method:"player-consensus-local-tier-tanh",inputVariant:marketAdjustedShadow?"market-adjusted-shadow-v2":"independent-owned",smoothingPoints:PROVIDER_RANGE_SMOOTHING_POINTS,ownedSignalWeight:PLAYER_CONSENSUS_OWNED_SIGNAL_WEIGHT,configuredNeighborhoodSize:PLAYER_CONSENSUS_NEIGHBORHOOD_SIZE,...draftGoblinCalibration};
    const projection={...(found||{}),mean,floor:range?.floor??neutralRange.floor,ceiling:range?.ceiling??neutralRange.ceiling,...(distribution?{distribution}:{}),...(availability?{availability}:{}),risk,performanceRisk,performanceRiskSource:distribution?"promoted-player-distribution":neutralRange.source,performanceStability:distribution?"distribution-calibrated":neutralRange.stabilityLabel||"position-fallback",...(!distribution?{performanceRangeCalibrationId:neutralRange.calibrationId,performanceRangeEvidence:neutralRange.evidence,performanceRangeRows:neutralRange.calibrationRows,performanceRangeIncludesHistoricalError:neutralRange.includesHistoricalProjectionError,...(neutralRange.playerScale?{performanceRangePlayerScale:neutralRange.playerScale,performanceRangePlayerRows:neutralRange.playerHistoryRows,performanceRangeProfileArtifactId:neutralRange.playerProfileArtifactId}:{} )}:{}),historicalProjectionRisk:Number(found?.risk??player.risk??0),injuryStatus,scarcity:Number(found?.scarcity??player.scarcity??.3),adp:marketRank,adpSd:hasMarketRank&&externalEligible?null:hasMarketRank?player.adpSd??null:externalEligible?null:found?.adpSd??null,adpSdSource:hasMarketRank&&externalEligible?"2026-format-curve":hasMarketRank?player.adpSdSource||"rank-calibrated":externalEligible?"unavailable":found?.adpSdSource||"rank-calibrated",adpSource:hasMarketRank&&externalEligible?"sleeper-scoring-adp":hasMarketRank?player.adpSource||"platform-market":externalEligible?"unavailable":found?.adpSource||"unavailable",adpSeason:hasMarketRank&&externalEligible?season:player.adpSeason||found?.adpSeason,adpTeams:hasMarketRank&&externalEligible?Number(state.settings.teams):player.adpTeams||found?.adpTeams,adpScoring:hasMarketRank&&externalEligible?(scoring==="STD"?"standard":scoring==="HALF"?"half-ppr":"ppr"):player.adpScoring||found?.adpScoring,adpProvider:hasMarketRank&&externalEligible?"sleeper":player.adpProvider||found?.adpProvider,source:consensus.method,projectionSeason:season,projectionVariant:draftGoblinFeed.projectionVariant||null,projectionModelVersion:draftGoblinFeed.modelVersion||null,projectionConsensus:consensus,draftGoblinProjectionRaw:rawDraftGoblinProjection,draftGoblinProjection,draftGoblinProjectionCalibration:calibration,draftGoblinProjectionRangeGuard:calibration,eligibleForRecommendation:(player.eligibleForRecommendation!==false||externalEligible)&&mean>0};
    return{...player,...projection,id:player.id,name:player.name||found?.name};
  });
  return{...state,dataQuality:baseline.dataQuality||"experimental",modelVersion:[baseline.modelVersion,distributionVersion].filter(Boolean).join("+"),distributionCalibration:baseline.distributionCalibration?{artifactId:baseline.distributionCalibration.artifactId,runtimeStatus:baseline.distributionCalibration.status,promotionGatePassed:Boolean(baseline.distributionCalibration.dataQuality?.promotionGatePassed)}:undefined,players};
}
