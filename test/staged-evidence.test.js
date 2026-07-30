import test from "node:test";
import assert from "node:assert/strict";
import { assessRankingReadiness, EVIDENCE_STAGES, evaluateDraft, FAMILYWISE_Z, rankEvaluatedRecommendations, stagedEvidenceZ } from "../core/evaluate.js";
import { pairedDifference } from "../core/simulate.js";
import { fixtureState } from "./fixture.js";

const simulation=(wins,seed=2026)=>({
  scenarioWins:Uint8Array.from(wins),
  scenarioSelected:new Uint8Array(wins.length).fill(1),
  iterations:wins.length,
  effectiveCandidateIterations:wins.length,
  rawProbability:wins.reduce((sum,value)=>sum+value,0)/wins.length,
  championshipProbability:wins.reduce((sum,value)=>sum+value,0)/wins.length,
  seed
});
const item=(id,wins,planScore=0)=>({player:{id},planScore,simulation:simulation(wins)});

test("staged evidence uses deterministic nested prefixes and a conservative 10k gate",()=>{
  assert.deepEqual(EVIDENCE_STAGES,[1000,2500,5000,10000]);
  assert.ok(stagedEvidenceZ(1000)>stagedEvidenceZ(5000));
  assert.ok(stagedEvidenceZ(10000)>FAMILYWISE_Z);
  const long=simulation(Array.from({length:2500},(_,i)=>i%3===0)),short=simulation(Array.from({length:1000},(_,i)=>i%3===0));
  assert.deepEqual(pairedDifference(long,short,{prefixIterations:1000}),pairedDifference(short,long,{prefixIterations:1000}));
});

test("clear paired losers are eliminated at an early stage without relaxing evidence",()=>{
  const leader=[...new Array(600).fill(1),...new Array(400).fill(0)],loser=[...new Array(400).fill(1),...new Array(600).fill(0)],result=assessRankingReadiness([item("leader",leader),item("loser",loser)],{iterations:1000,targetIterations:10000});
  assert.equal(result.rankingReady,true);
  assert.equal(result.displayReady,true);
  assert.equal(result.orderingDurable,true);
  assert.equal(result.precisionReady,true);
  assert.deepEqual(result.eliminated,["loser"]);
  assert.deepEqual(result.displayGroups,[["leader"],["loser"]]);
  assert.equal(result.continueInBackground,false);
});

test("difficult ties stay in one displayed group and continue quietly",()=>{
  const a=Array.from({length:1000},(_,i)=>i%5===0?1:0),b=[...a],result=assessRankingReadiness([item("stable",a,1),item("tie",b,0)],{iterations:1000,targetIterations:10000});
  assert.equal(result.displayReady,true);
  assert.equal(result.rankingReady,false);
  assert.equal(result.orderingDurable,false);
  assert.equal(result.precisionReady,false);
  assert.deepEqual(result.leadingGroup,["stable","tie"]);
  assert.deepEqual(result.displayGroups,[["stable","tie"]]);
  assert.equal(result.continueInBackground,true);
});

test("display groups cannot chain across a supported leader-to-tail difference",()=>{
  const make=(id,p,interval)=>({player:{id},planScore:0,simulation:{championshipProbability:p,interval}}),result=assessRankingReadiness([make("leader",.13,[.115,.145]),make("bridge",.12,[.105,.135]),make("supported-loser",.10,[.085,.114])],{iterations:1000,targetIterations:10000});
  assert.deepEqual(result.displayGroups,[["leader","bridge"],["supported-loser"]]);
});

test("every ranking strategy preserves production-shaped paired evidence without serializing scenario arrays",()=>{
  const make=(id,wins,planScore)=>{const simulation={iterations:wins.length,effectiveCandidateIterations:wins.length,seed:44,scenarioBankId:`crn-v1:44:${wins.length}`,rawProbability:wins.reduce((a,b)=>a+b,0)/wins.length,championshipProbability:.1,interval:[.05,.15]},scenarioWins=Uint8Array.from(wins),planScenarioWins=Uint8Array.from(wins),scenarioSelected=new Uint8Array(wins.length).fill(1);Object.defineProperties(simulation,{scenarioWins:{value:scenarioWins,enumerable:false},planScenarioWins:{value:planScenarioWins,enumerable:false},scenarioSelected:{value:scenarioSelected,enumerable:false}});return{player:{id,name:id,position:"WR",mean:200,floor:150,ceiling:260},factors:{need:.5},planScore,simulation}};
  const a=make("a",[1,1,1,0,0,0],.8),b=make("b",[1,0,0,0,0,0],.7);
  for(const strategy of["titleOnly","balanced","upside"]){const ranked=rankEvaluatedRecommendations([a,b],{strategy});assert.ok(ranked[0].simulation.scenarioWins);assert.equal(Object.prototype.propertyIsEnumerable.call(ranked[0].simulation,"scenarioWins"),false);assert.ok(pairedDifference(ranked[0].simulation,ranked[1].simulation));assert.equal(JSON.stringify(ranked).includes("scenarioWins"),false)}
});

test("real quick evaluation retains paired prefixes for readiness while JSON stays bounded",()=>{
  const ranked=evaluateDraft({state:fixtureState({teams:4,rounds:6,picked:4}),userSlot:1,iterations:120,seed:812,limit:5}),readiness=assessRankingReadiness(ranked,{iterations:120,targetIterations:10000});
  assert.ok(ranked.every(item=>item.simulation.scenarioWins?.length===120));
  assert.ok(readiness.comparisons.every(row=>row.pairedIterations===120&&row.rawDifference!==null&&row.standardError!==null));
  assert.equal(JSON.stringify(ranked).includes("scenarioWins"),false);
});
