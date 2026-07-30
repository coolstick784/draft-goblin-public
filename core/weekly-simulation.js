import { lineupScore } from "./roster.js";
import { isSpecialist, regressedSpecialistValue, specialistWaiverBaseline } from "./lineup-value.js";

// This model is intentionally opt-in. It makes weekly roster availability and
// replacement value explicit, but still relies on conservative position priors
// until player-level availability data passes the promotion gates.
export const WEEKLY_SIMULATION_MODEL="weekly-v3-player-availability-shadow";
export const WEEKLY_SIMULATION_WEEKS=17;
export const WEEKLY_AVAILABILITY_PRIOR=Object.freeze({QB:.08,RB:.16,WR:.13,TE:.12,K:0,DST:0});

// Availability is intentionally adjacent to, not embedded in, the active-role
// scoring distribution. A calibrated player forecast wins; malformed or absent
// forecasts fail closed to the position prior.
export function playerMissedGameRate(player){
  const rawMissed=player?.availability?.missedGameRate,missed=typeof rawMissed==="number"?rawMissed:NaN;
  if(Number.isFinite(missed)&&missed>=0&&missed<=.99)return missed;
  const rawActive=player?.availability?.activeProbability,active=typeof rawActive==="number"?rawActive:NaN;
  if(Number.isFinite(active)&&active>=.01&&active<=1)return 1-active;
  return Number(WEEKLY_AVAILABILITY_PRIOR[player?.position]||0);
}
export function embeddedMissedGameRate(player){
  const raw=player?.availability?.embeddedMissedGameRate,value=typeof raw==="number"?raw:0;
  return Number.isFinite(value)&&value>=0&&value<=playerMissedGameRate(player)?value:0;
}
export const weeklyActiveRate=player=>Math.max(.01,1-playerMissedGameRate(player));
export const expectedAvailableSeasonPoints=(player,seasonPoints=Number(player?.mean||0))=>Number(seasonPoints||0)*weeklyActiveRate(player)/(1-embeddedMissedGameRate(player));

function weeklyPlayoffWinner(seeds,scoreWeek){
  if(seeds.length===6){
    const play=(a,b,week)=>scoreWeek(a,week)>=scoreWeek(b,week)?a:b;
    const wild=[play(seeds[2],seeds[5],14),play(seeds[3],seeds[4],14)];
    const remaining=[seeds[1],...wild].sort((a,b)=>seeds.indexOf(a)-seeds.indexOf(b));
    return play(play(seeds[0],remaining.at(-1),15),play(remaining[0],remaining[1],15),16);
  }
  let field=[...seeds],week=14;
  while(field.length>1){
    const next=[];
    for(let i=0;i<Math.floor(field.length/2);i++)next.push(scoreWeek(field[i],week)>=scoreWeek(field[field.length-1-i],week)?field[i]:field[field.length-1-i]);
    if(field.length%2)next.unshift(field[Math.floor(field.length/2)]);
    field=next;week++;
  }
  return field[0];
}

// Player season draws and team-week errors use the same semantic CRN keys as
// the legacy model where possible. Availability gets its own keyed draw, so
// roster or candidate iteration order cannot alter a simulated world.
export function pairedWeeklySeasonFinishOrder(rosters,settings,scenario,{simulatePlayerSeasonTotal,roundRobinPairs,weeklyError}){
  const pool=rosters.flat(),specialistBaselines=Object.fromEntries(["K","DST"].map(position=>[position,specialistWaiverBaseline(position,pool,settings)]));
  const seasonValues=new Map(),seasonValue=player=>{let value=seasonValues.get(player);if(value!==undefined)return value;const outcomeKey=player.simulationOutcomeKey||player.id;value=simulatePlayerSeasonTotal(player,scenario.normal("player-projection",outcomeKey),scenario.normal("player-error",outcomeKey),{specialistBaseline:specialistBaselines[player.position]});seasonValues.set(player,value);return value};
  const projectedSeasonValue=player=>isSpecialist(player.position)?regressedSpecialistValue(player,specialistBaselines[player.position]):Number(player.mean||0);
  const weekCache=Array.from({length:WEEKLY_SIMULATION_WEEKS},()=>new Map());
  const playerActive=(player,week)=>scenario.uniform("player-availability",week,player.simulationOutcomeKey||player.id)<weeklyActiveRate(player);
  // Some season means already contain a separately forecast availability
  // discount. Restore only that embedded portion on active weeks; any larger
  // live injury rate remains a real incremental loss.
  const scoreWeek=(team,week)=>{const cached=weekCache[week].get(team);if(cached!==undefined)return cached;const available=rosters[team].filter(player=>playerActive(player,week)),value=player=>seasonValue(player)/(WEEKLY_SIMULATION_WEEKS*(1-embeddedMissedGameRate(player))),selectionValue=player=>projectedSeasonValue(player)/(WEEKLY_SIMULATION_WEEKS*(1-embeddedMissedGameRate(player))),score=lineupScore(available,settings.slots,value,selectionValue)+scenario.normal("regular",week,team)*weeklyError;weekCache[week].set(team,score);return score};
  const wins=rosters.map(()=>0),points=rosters.map(()=>0);
  for(let week=0;week<14;week++)for(const[a,b]of roundRobinPairs(rosters.length,week)){const sa=scoreWeek(a,week),sb=scoreWeek(b,week);points[a]+=sa;points[b]+=sb;wins[sa>=sb?a:b]++}
  const regular=rosters.map((_,team)=>team).sort((a,b)=>wins[b]-wins[a]||points[b]-points[a]||a-b),seeds=regular.slice(0,settings.playoffTeams),champion=weeklyPlayoffWinner(seeds,scoreWeek);
  return[champion,...regular.filter(team=>team!==champion)];
}
