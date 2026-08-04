import{playerIdentityKeys}from"./player-identity.js";

const snakeSlot=(pickNo,teams)=>{const round=Math.floor((pickNo-1)/teams)+1,within=(pickNo-1)%teams+1;return round%2?within:teams+1-within};

export function detectedCurrentPick(state){
  const historyPick=Number(state?.picks?.length||0)+1,clockPick=Number(state?.currentPickNo);
  const platform=String(state?.platform||"").toLowerCase(),clockAuthoritative=platform==="espn"||platform==="yahoo";
  return clockAuthoritative&&Number.isInteger(clockPick)&&clockPick>=historyPick?clockPick:historyPick;
}

export function pickHistoryIsCurrent(state){
  const platform=String(state?.platform||"").toLowerCase();
  return !["espn","yahoo"].includes(platform)||detectedCurrentPick(state)<=Number(state?.picks?.length||0)+1;
}

export function draftCompletionState(state){
  const teams=Number(state?.settings?.teams),rounds=Number(state?.settings?.rounds),userSlot=Number(state?.userSlot),picks=Array.isArray(state?.picks)?state.picks:[],expectedPicks=teams*rounds;
  const settingsReady=Number.isInteger(teams)&&teams>=2&&Number.isInteger(rounds)&&rounds>=1;
  const userPicks=Number.isInteger(userSlot)&&userSlot>=1?picks.filter(pick=>Number(pick.slot)===userSlot).length:0;
  return{expectedPicks:settingsReady?expectedPicks:0,userPicks,draftComplete:settingsReady&&picks.length>=expectedPicks,userRosterComplete:settingsReady&&Number.isInteger(userSlot)&&userSlot>=1&&userPicks>=rounds};
}

export function completedDraftProjectionCoverage(state,{minimum=.9}={}){
  if(String(state?.platform||"").toLowerCase()!=="espn")return{ready:true,projected:0,eligible:0,ratio:1};
  const byId=new Map((state?.players||[]).map(player=>[String(player.id),player])),core=(state?.picks||[]).map(pick=>byId.get(String(pick.playerId))).filter(player=>player&&["QB","RB","WR","TE"].includes(String(player.position))),projected=core.filter(player=>Number(player.mean)>0).length,ratio=core.length?projected/core.length:0;
  return{ready:core.length>0&&ratio>=Number(minimum),projected,eligible:core.length,ratio};
}

export function selectionPhaseKey(state){
  const teams=Number(state?.settings?.teams),rounds=Number(state?.settings?.rounds),userSlot=Number(state?.userSlot),currentPick=detectedCurrentPick(state);
  if(!Number.isInteger(teams)||teams<2||!Number.isInteger(rounds)||rounds<1||!Number.isInteger(userSlot)||userSlot<1||currentPick>teams*rounds)return"unknown";
  let targetPick=currentPick;while(targetPick<=teams*rounds&&snakeSlot(targetPick,teams)!==userSlot)targetPick++;
  if(targetPick>teams*rounds)return"complete";
  const phase=targetPick===currentPick?"on-clock":"preparing";
  return`pick-window:${targetPick}:${phase}`;
}

export function recommendationWindowKey(state){
  const userSlot=Number(state?.userSlot),allPicks=(state?.picks||[]).map(pick=>[Number(pick.pickNo),String(pick.playerId),Number(pick.slot)]);
  const targetWindow=selectionPhaseKey(state).replace(/:(?:preparing|on-clock)$/i,"");
  return JSON.stringify([String(state?.platform||""),String(state?.draftId||""),String(state?.draftRunId||""),userSlot,state?.settings||null,String(state?.modelVersion||""),Number(state?.projectionSeason||0),targetWindow,allPicks]);
}

export function espnEligibleCatalogKey(state){
  if(String(state?.platform||"").toLowerCase()!=="espn")return"";
  return(state?.players||[]).filter(player=>player.eligibleForRecommendation!==false).map(player=>String(player.id)).sort().join("|");
}

export function espnCandidateEligible({player,baseline,draftGoblin,fantasyPros,sleeper,season}){
  const adp=Number(baseline?.adp),team=String(baseline?.team||"").toUpperCase(),position=String(baseline?.position||player?.position||"").toUpperCase().replace("D/ST","DST").replace("DEF","DST"),activeSpecialist=["K","DST"].includes(position)&&Boolean(team)&&team!=="FA",activeBaseline=Boolean(baseline)&&(Number.isFinite(adp)&&adp>0&&adp<500||activeSpecialist)&&Boolean(team)&&team!=="FA",externalSeason=Number(fantasyPros?.season||season),hasExternal=Number(fantasyPros?.points||0)>0&&externalSeason===Number(season),hasLiveProjection=Number(player?.platformProjection||0)>0;
  const sleeperSeason=Number(sleeper?.season||season),hasSleeper=Number(sleeper?.points||0)>0&&sleeperSeason===Number(season),draftGoblinSeason=Number(draftGoblin?.season||season),hasDraftGoblin=Number(draftGoblin?.points||0)>0&&draftGoblinSeason===Number(season),hasTrustedCurrentProjection=hasSleeper||hasExternal||hasDraftGoblin;
  return player?.eligibleForRecommendation!==false?(hasLiveProjection||hasTrustedCurrentProjection||activeBaseline):(activeBaseline&&hasTrustedCurrentProjection);
}

export function removeUnavailableRecommendations(data,state){
  return{...data,recommendations:(data?.recommendations||[]).filter(rec=>!recommendationIsDrafted(rec,state))};
}

export function recommendationIsDrafted(rec,state){
  const player=rec?.player||rec;if(!player)return false;
  const playerId=String(player.id||""),platformPlayerId=String(player.platformPlayerId||""),playerKeys=new Set(playerIdentityKeys(player));
  for(const pick of state?.picks||[]){
    const pickedId=String(pick.playerId||"");
    if(pickedId&&(pickedId===playerId||pickedId===platformPlayerId))return true;
    const catalogPlayer=(state?.players||[]).find(candidate=>String(candidate.id||"")===pickedId||String(candidate.platformPlayerId||"")===pickedId),pickedPlayer={...catalogPlayer,...pick,name:pick.name||catalogPlayer?.name,position:pick.position||catalogPlayer?.position,team:pick.team||catalogPlayer?.team};
    if(playerIdentityKeys(pickedPlayer).some(key=>playerKeys.has(key)))return true;
  }
  return false;
}

export function removeDraftedBoardCandidates(candidates,state){
  return(candidates||[]).filter(candidate=>!recommendationIsDrafted(candidate?.player||candidate,state));
}

export function filterRecommendationsByPositions(data,positions){
  const selected=new Set((positions||[]).map(position=>String(position)));
  if(!selected.size)return data;
  return{...data,recommendations:(data?.recommendations||[]).filter(rec=>selected.has(String(rec.player?.position)))};
}

export function recommendationByPlayerId(data){
  return new Map((data?.recommendations||[]).map(rec=>[String(rec.player?.id),rec]));
}
