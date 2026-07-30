import test from "node:test";
import assert from "node:assert/strict";
import { createPairedScenario, createSimulationSession, pairedDifference, pairedWeeklyFinishOrder, simulateCandidate, WEEKLY_SIMULATION_MODEL } from "../core/simulate.js";
import { expectedAvailableSeasonPoints, playerMissedGameRate, weeklyActiveRate } from "../core/weekly-simulation.js";
import { fixtureState } from "./fixture.js";

test("weekly simulation is opt-in and legacy remains the default",()=>{
  const state=fixtureState({teams:4,picked:2}),options={state,candidate:state.players[4],userSlot:1,iterations:120,seed:19};
  const implicit=simulateCandidate(options),explicit=simulateCandidate({...options,simulationModel:"legacy"}),weekly=simulateCandidate({...options,simulationModel:WEEKLY_SIMULATION_MODEL});
  assert.deepEqual(implicit,explicit);
  assert.equal(implicit.simulationModel,"legacy");
  assert.equal(weekly.simulationModel,WEEKLY_SIMULATION_MODEL);
  assert.notEqual(implicit.scenarioBankId,weekly.scenarioBankId);
});

test("weekly semantic worlds are deterministic and roster-order independent",()=>{
  const player=(id,position,mean)=>({id,position,mean,floor:mean*.7,ceiling:mean*1.3}),settings={teams:2,playoffTeams:2,slots:{QB:1,RB:1,WR:1,TE:0,FLEX:0,K:0,DST:0}},a=player("a","QB",300),b=player("b","RB",220),c=player("c","WR",210),d=player("d","QB",290),e=player("e","RB",215),f=player("f","WR",205);
  const first=pairedWeeklyFinishOrder([[a,b,c],[d,e,f]],settings,createPairedScenario(88,7));
  const reordered=pairedWeeklyFinishOrder([[c,a,b],[f,d,e]],settings,createPairedScenario(88,7));
  assert.deepEqual(first,reordered);
});

test("a shared session is exactly equivalent to standalone candidate simulations",()=>{
  const state=fixtureState({teams:4,picked:3}),options={state,userSlot:2,iterations:180,seed:31},session=createSimulationSession({...options,simulationModel:WEEKLY_SIMULATION_MODEL});
  for(const candidate of state.players.slice(5,8))assert.deepEqual(simulateCandidate({...options,candidate,simulationModel:WEEKLY_SIMULATION_MODEL}),simulateCandidate({...options,candidate,session}));
});

test("simulation sessions reject mismatched requests and unknown models",()=>{
  const state=fixtureState({teams:4,picked:0}),session=createSimulationSession({state,userSlot:1,iterations:10,seed:4});
  assert.throws(()=>simulateCandidate({state,candidate:null,userSlot:2,iterations:10,seed:4,session}),/does not match/);
  assert.throws(()=>createSimulationSession({state,userSlot:1,simulationModel:"future-v99"}),/Unknown simulation model/);
});

test("shared draft-board preparation does not change results",()=>{
  const state=fixtureState({teams:6,rounds:8,picked:5}),iterations=220,seed=53,userSlot=3,candidates=state.players.slice(8,12),run=session=>{const started=performance.now(),results=candidates.map(candidate=>simulateCandidate({state,candidate,userSlot,iterations,seed,...(session?{session}:{simulationModel:"legacy"})}));return{elapsed:performance.now()-started,results}};
  // Warm the JIT. Wall-clock performance is enforced by the dedicated 10k
  // benchmark gate; timing assertions here are noisy under parallel test load.
  run(null);
  const standalone=run(null),session=createSimulationSession({state,userSlot,iterations,seed}),shared=run(session);
  assert.deepEqual(shared.results,standalone.results);
});

test("paired evidence refuses to compare different simulator worlds",()=>{
  const state=fixtureState({teams:4,picked:1}),options={state,candidate:state.players[5],userSlot:1,iterations:40,seed:9},legacy=simulateCandidate(options),weekly=simulateCandidate({...options,simulationModel:WEEKLY_SIMULATION_MODEL});
  assert.equal(pairedDifference(legacy,weekly),null);
});

test("weekly availability gives useful bench depth title value",()=>{
  const player=(id,mean)=>({id,position:"RB",mean,floor:mean*.75,ceiling:mean*1.25}),starter=player("starter",240),backup=player("backup",190),opponents=[[player("o1",220)],[player("o2",220)],[player("o3",220)]],settings={teams:4,playoffTeams:2,slots:{QB:0,RB:1,WR:0,TE:0,FLEX:0,K:0,DST:0}},iterations=1200;let withoutDepth=0,withDepth=0;
  for(let iteration=0;iteration<iterations;iteration++){withoutDepth+=pairedWeeklyFinishOrder([[starter],...opponents],settings,createPairedScenario(71,iteration))[0]===0;withDepth+=pairedWeeklyFinishOrder([[starter,backup],...opponents],settings,createPairedScenario(71,iteration))[0]===0}
  assert.ok(withDepth>withoutDepth,`depth titles ${withDepth}; no-depth titles ${withoutDepth}`);
});

test("missed-game probability lowers active-role season expectation instead of being canceled",()=>{
  const rb={id:"rb","position":"RB",mean:200},k={id:"k",position:"K",mean:200};
  assert.equal(expectedAvailableSeasonPoints(rb),168);
  assert.equal(expectedAvailableSeasonPoints(k),200);
  let active=0;const trials=10000;
  for(let iteration=0;iteration<trials;iteration++)if(createPairedScenario(912,iteration).uniform("player-availability",0,rb.id)<weeklyActiveRate(rb))active++;
  const empirical=200*active/trials;
  assert.ok(Math.abs(empirical-expectedAvailableSeasonPoints(rb))<2,`empirical ${empirical}`);
  assert.ok(expectedAvailableSeasonPoints(rb)<rb.mean);
});

test("player availability overrides the position prior and invalid values fail closed",()=>{
  const kittleLike={id:"te-risk",position:"TE",mean:200,availability:{missedGameRate:.3}};
  assert.equal(playerMissedGameRate(kittleLike),.3);
  assert.equal(weeklyActiveRate(kittleLike),.7);
  assert.equal(expectedAvailableSeasonPoints(kittleLike),140);
  assert.equal(weeklyActiveRate({position:"TE"}),.88);
  assert.equal(weeklyActiveRate({position:"TE",availability:{missedGameRate:2}}),.88);
  assert.equal(weeklyActiveRate({position:"TE",availability:{activeProbability:.76}}),.76);
  const embedded={position:"TE",mean:170,availability:{missedGameRate:.15,embeddedMissedGameRate:.15}};
  assert.equal(expectedAvailableSeasonPoints(embedded),170);
});
