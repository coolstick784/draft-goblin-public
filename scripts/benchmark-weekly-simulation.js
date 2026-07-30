import { performance } from "node:perf_hooks";
import { createSimulationSession, simulateCandidate, WEEKLY_SIMULATION_MODEL } from "../core/simulate.js";
import { fixtureState } from "../test/fixture.js";

const iterations=Math.max(100,Number(process.argv[2]||500)),state=fixtureState({teams:12,rounds:12,picked:36}),userSlot=6,seed=20260714,candidates=state.players.filter(player=>!state.picks.some(pick=>pick.playerId===player.id)).slice(0,8);
const run=({simulationModel="legacy",shared=false,quantiles=false})=>{
  const working=structuredClone(state);
  if(quantiles)for(const player of working.players){const mean=Number(player.mean),spread=Math.max(15,Number(player.ceiling)-Number(player.floor));player.distribution={version:1,probabilities:[.01,.1,.5,.9,.99],values:[Math.max(0,mean-spread),Math.max(0,mean-spread*.55),mean,mean+spread*.55,mean+spread]}}
  const selected=candidates.map(candidate=>working.players.find(player=>player.id===candidate.id)),session=shared?createSimulationSession({state:working,userSlot,iterations,seed,simulationModel}):null,started=performance.now(),results=selected.map(candidate=>simulateCandidate({state:working,candidate,userSlot,iterations,seed,simulationModel,...(session?{session}:{})}));
  return{milliseconds:performance.now()-started,results};
};

run({}); // JIT warm-up
const legacy=run({}),legacyShared=run({shared:true}),quantileShared=run({shared:true,quantiles:true}),weeklyShared=run({shared:true,quantiles:true,simulationModel:WEEKLY_SIMULATION_MODEL});
const summarize=result=>({milliseconds:Number(result.milliseconds.toFixed(1)),millisecondsPerCandidate:Number((result.milliseconds/candidates.length).toFixed(1)),finite:result.results.every(row=>Number.isFinite(row.championshipProbability))});
console.log(JSON.stringify({iterations,candidates:candidates.length,legacy:summarize(legacy),legacyShared:summarize(legacyShared),quantileShared:summarize(quantileShared),weeklyQuantileShadow:summarize(weeklyShared),sharedLegacyExact:legacy.results.every((row,index)=>JSON.stringify(row)===JSON.stringify(legacyShared.results[index]))},null,2));
