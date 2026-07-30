import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDraft } from "../core/evaluate.js";
import { createSimulationSession, simulateCandidate } from "../core/simulate.js";
import { workerEvaluation } from "../server/index.js";
import { fixtureState } from "./fixture.js";

const snapshot=item=>({
  playerId:item.player.id,
  planScore:item.planScore,
  displayRank:item.displayRank,
  statisticalTie:item.statisticalTie,
  simulation:{...item.simulation},
  teamSimulation:{...item.teamSimulation},
  scenarioWins:[...item.simulation.scenarioWins],
  planScenarioWins:[...item.simulation.planScenarioWins],
  scenarioSelected:[...item.simulation.scenarioSelected],
  teamScenarioWins:[...item.teamSimulation.scenarioWins],
  teamPlanScenarioWins:[...item.teamSimulation.planScenarioWins]
});

for(const fixture of[
  {name:"early three-card",state:fixtureState({teams:4,rounds:6,picked:0}),userSlot:1,limit:3,iterations:37,seed:8801},
  {name:"middle seven-card",state:fixtureState({teams:6,rounds:8,picked:20}),userSlot:3,limit:7,iterations:83,seed:8802},
  {name:"late five-card",state:fixtureState({teams:8,rounds:10,picked:68}),userSlot:5,limit:5,iterations:61,seed:8803}
])test(`batched workers are bit-exact with single-process evaluation: ${fixture.name}`,async()=>{
  fixture.state.draftId=`batch-equivalence-${fixture.name}`;
  const input={state:fixture.state,userSlot:fixture.userSlot,limit:fixture.limit,iterations:fixture.iterations,seed:fixture.seed,strategy:"balanced",consumer:"batch-equivalence"},controller={workers:new Set(),cancelled:false};
  const direct=evaluateDraft(input),batched=await workerEvaluation(input,fixture.iterations,controller);
  assert.deepEqual(batched.map(snapshot),direct.map(snapshot));
  assert.equal(controller.workers.size,0);
});

test("batch equivalence includes title-only ordering and a non-even chunk remainder",async()=>{
  const state=fixtureState({teams:4,rounds:6,picked:7});state.draftId="batch-equivalence-title-only";
  const input={state,userSlot:2,limit:8,iterations:73,seed:8810,strategy:"titleOnly",consumer:"batch-equivalence-title"},controller={workers:new Set(),cancelled:false},direct=evaluateDraft(input),batched=await workerEvaluation(input,input.iterations,controller);
  assert.deepEqual(batched.map(snapshot),direct.map(snapshot));
});

test("scenario offsets concatenate to the exact full semantic scenario bank",()=>{
  const state=fixtureState({teams:4,rounds:6,picked:5}),userSlot=2,seed=8820,iterations=91,candidate=state.players.find(player=>!state.picks.some(pick=>pick.playerId===player.id)),fullSession=createSimulationSession({state,userSlot,seed,iterations}),full=simulateCandidate({state,candidate,userSlot,seed,iterations,session:fullSession}),counts=[31,30,30],parts=[];let scenarioOffset=0;
  for(const count of counts){const session=createSimulationSession({state,userSlot,seed,iterations:count,scenarioOffset});parts.push(simulateCandidate({state,candidate,userSlot,seed,iterations:count,session}));scenarioOffset+=count}
  for(const key of["scenarioWins","planScenarioWins","scenarioSelected"]){const combined=parts.flatMap(part=>[...part[key]]);assert.deepEqual(combined,[...full[key]])}
});
