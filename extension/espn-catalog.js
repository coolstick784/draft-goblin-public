import{buildPlayerIdentityIndex,matchPlayerIdentity}from"./player-identity.js";

const espnControlLabel=value=>/^(?:draft|queue|add|remove|watch|claim|move)$/i.test(String(value||"").trim());

export function expandEspnCatalog(state,baselinePlayers){
  if(String(state?.platform||"").toLowerCase()!=="espn")return state;
  const baselineIndex=buildPlayerIdentityIndex(baselinePlayers),liveById=new Map((state.players||[]).map(player=>[String(player.id),player])),liveIndex=buildPlayerIdentityIndex(state.players),idRemap=new Map();
  for(const player of state.players||[]){const baseline=matchPlayerIdentity(baselineIndex,player);if(baseline)idRemap.set(String(player.id),String(baseline.id))}
  const picks=(state.picks||[]).map(pick=>{const live=liveById.get(String(pick.playerId)),baseline=matchPlayerIdentity(baselineIndex,{...live,name:pick.name||live?.name}),playerId=idRemap.get(String(pick.playerId))||baseline?.id||pick.playerId;return{...pick,platformPlayerId:String(pick.playerId),playerId:String(playerId)}}),players=(baselinePlayers||[]).map(baseline=>{const live=matchPlayerIdentity(liveIndex,baseline),livePosition=String(live?.position||"").toUpperCase().replace("D/ST","DST");return live?{...baseline,...live,id:String(baseline.id),platformPlayerId:String(live.id),name:baseline.name,position:livePosition&&livePosition!=="NA"?livePosition:baseline.position,team:live.team||baseline.team,platformProjection:Number(live.platformProjection||0),eligibleForRecommendation:live.eligibleForRecommendation===true}:{...baseline,id:String(baseline.id),eligibleForRecommendation:false}}),known=new Set(players.map(player=>String(player.id)));
  for(const live of state.players||[]){if(espnControlLabel(live.name))continue;const remapped=idRemap.get(String(live.id))||String(live.id),position=String(live.position||"").toUpperCase().replace("D/ST","DST").replace("DEF","DST"),projectedSpecialist=["K","DST"].includes(position)&&live.eligibleForRecommendation===true&&Number(live.platformProjection)>0;if(!known.has(remapped)){players.push({...live,id:remapped,position,eligibleForRecommendation:projectedSpecialist});known.add(remapped)}}
  return{...state,picks,players};
}
