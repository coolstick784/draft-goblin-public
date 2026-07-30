export function sanitizeSleeperState(state, currentYear=new Date().getFullYear()) {
  if(state?.platform!=="sleeper"||!Array.isArray(state.players))return state;
  const pickedIds=new Set();
  for(const pick of state.picks||[])pickedIds.add(String(pick.playerId));
  const season=Number(state.projectionSeason||currentYear);
  const players=[];
  for(const player of state.players){
    const projectionAvailable=Number(player.platformProjection)>0;
    const eligibleForRecommendation=player.active!==false&&Boolean(player.team)&&player.team!=="FA";
    if(!pickedIds.has(String(player.id))&&!eligibleForRecommendation)continue;
    players.push({...player,projectionAvailable,projectionSeason:season,projectionSource:projectionAvailable?"Sleeper visible draft projection":"Draft Goblin fallback",eligibleForRecommendation});
  }
  return{...state,players,projectionSeason:season,projectionSource:"Sleeper visible draft projections plus Draft Goblin fallback"};
}
