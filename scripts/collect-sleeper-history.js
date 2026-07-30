const API="https://api.sleeper.app/v1";
const seedUsers=["857362098878025728","737419307285426176","565652524871479296","461915696733876224","586370605301932032","1008903776321736704"];
async function get(path){const response=await fetch(`${API}${path}`,{signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error(`${response.status} ${path}`);return response.json()}
const championFrom=bracket=>bracket.find(game=>game.p===1)?.w??[...bracket].sort((a,b)=>b.r-a.r)[0]?.w;

export async function collect({maxLeagues=60,seasons=[2018,2019,2020,2021,2022,2023,2024,2025],maxUsers=Math.max(200,Math.ceil(maxLeagues*4))}={}){
  const userQueue=[...seedUsers],seenUsers=new Set(),seenLeagues=new Set(),records=[],errors=[];
  const rejected={missingDraft:0,missingChampion:0,missingSlot:0,shortPicks:0,dynasty:0};
  while(userQueue.length&&records.length<maxLeagues&&seenUsers.size<maxUsers){
    const userId=userQueue.shift();if(seenUsers.has(userId))continue;seenUsers.add(userId);
    for(const season of seasons){
      let leagues;try{leagues=await get(`/user/${userId}/leagues/nfl/${season}`)}catch(error){errors.push(error.message);continue}
      for(const league of leagues||[]){
        if(records.length>=maxLeagues)break;if(seenLeagues.has(league.league_id)||league.status!=="complete")continue;seenLeagues.add(league.league_id);
        try{
          const[drafts,bracket,users,rosters]=await Promise.all([get(`/league/${league.league_id}/drafts`),get(`/league/${league.league_id}/winners_bracket`),get(`/league/${league.league_id}/users`),get(`/league/${league.league_id}/rosters`)]);
          for(const user of users||[])if(!seenUsers.has(user.user_id)&&userQueue.length<500)userQueue.push(user.user_id);
          const championRosterId=Array.isArray(bracket)?championFrom(bracket):null;
          const draft=Array.isArray(drafts)?drafts.find(item=>item.type==="snake"&&item.status==="complete"&&String(item.season)===String(season)):null;
          if(!draft){rejected.missingDraft++;continue}if(!championRosterId){rejected.missingChampion++;continue}
          const scoringType=draft.metadata?.scoring_type||"unknown";if(String(scoringType).includes("dynasty")){rejected.dynasty++;continue}
          const picks=await get(`/draft/${draft.draft_id}/picks`);if(!Array.isArray(picks)||picks.length<Number(draft.settings?.teams||0)*5){rejected.shortPicks++;continue}
          const slotEntry=Object.entries(draft.slot_to_roster_id||{}).find(([,roster])=>Number(roster)===Number(championRosterId));
          const championSlot=Number(slotEntry?.[0]||picks.find(pick=>Number(pick.roster_id)===Number(championRosterId))?.draft_slot);if(!championSlot){rejected.missingSlot++;continue}
          const rosterToSlot=new Map(Object.entries(draft.slot_to_roster_id||{}).map(([slot,roster])=>[Number(roster),Number(slot)]));for(const pick of picks)if(pick.roster_id&&pick.draft_slot&&!rosterToSlot.has(Number(pick.roster_id)))rosterToSlot.set(Number(pick.roster_id),Number(pick.draft_slot));
          const standings=(rosters||[]).map(roster=>({slot:rosterToSlot.get(Number(roster.roster_id)),wins:Number(roster.settings?.wins||0),losses:Number(roster.settings?.losses||0),ties:Number(roster.settings?.ties||0),points:Number(roster.settings?.fpts||0)+Number(roster.settings?.fpts_decimal||0)/100})).filter(row=>row.slot).sort((a,b)=>b.wins-a.wins||b.ties-a.ties||b.points-a.points||a.slot-b.slot);
          const pointsOrder=[...standings].sort((a,b)=>b.points-a.points||b.wins-a.wins||a.slot-b.slot),actualRankBySlot=Array(Number(draft.settings.teams)).fill(null),pointsRankBySlot=Array(Number(draft.settings.teams)).fill(null);
          standings.forEach((row,index)=>actualRankBySlot[row.slot-1]=index+1);pointsOrder.forEach((row,index)=>pointsRankBySlot[row.slot-1]=index+1);
          records.push({season:Number(season),teams:Number(draft.settings.teams),rounds:Number(draft.settings.rounds),scoringType,championSlot,actualRankBySlot,pointsRankBySlot,settings:{slots_qb:Number(draft.settings.slots_qb||0),slots_rb:Number(draft.settings.slots_rb||0),slots_wr:Number(draft.settings.slots_wr||0),slots_te:Number(draft.settings.slots_te||0),slots_flex:Number(draft.settings.slots_flex||0),slots_super_flex:Number(draft.settings.slots_super_flex||0),slots_def:Number(draft.settings.slots_def||0),slots_k:Number(draft.settings.slots_k||0),slots_bn:Number(draft.settings.slots_bn||0)},picks:picks.sort((a,b)=>a.pick_no-b.pick_no).map(pick=>({pickNo:Number(pick.pick_no),slot:Number(pick.draft_slot),playerId:String(pick.player_id),position:pick.metadata?.position==="DEF"?"DST":pick.metadata?.position||"NA"}))})
        }catch(error){errors.push(error.message)}
      }
    }
  }
  return{schemaVersion:2,collectedAt:new Date().toISOString(),source:"Sleeper official read-only API",privacy:"League, user, roster, and draft identifiers removed; only settings, pick sequence, player IDs, positions, champion slot, and anonymized finishing ranks by draft slot retained.",records,diagnostics:{usersVisited:seenUsers.size,leaguesVisited:seenLeagues.size,rejected,errors:errors.slice(0,30)}}
}
