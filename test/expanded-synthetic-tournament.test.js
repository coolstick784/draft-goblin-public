import test from "node:test";
import assert from "node:assert/strict";
import { EXPANDED_SEEDS, EXPANDED_SLOTS, summarizeExpandedTournament } from "../scripts/run-expanded-synthetic-tournament.js";

const draft=(slot,rank,decisionMs=1000)=>({userSlot:slot,seed:14000+slot,userPicks:[{decisionMs}],metrics:{maxDecisionMs:decisionMs,totalMs:20000},checks:{complete:true},report:{grade:{letter:"A"},userTeam:{titleRank:rank,weeklyRank:rank,finishProbabilities:[rank===1?.12:.09]},teamReports:[{slot,finishProbabilities:[rank===1?.12:.09]},{slot:99,finishProbabilities:[rank===1?.10:.11]}]}});

test("expanded synthetic matrix is frozen before policy evaluation",()=>{
  assert.deepEqual(EXPANDED_SLOTS,[1,2,4,6,7,9,11,12]);
  assert.deepEqual(EXPANDED_SEEDS,[14101,14102,14104,14106,14107,14109,14111,14112]);
});

test("promotion requires at least six of eight first-place finishes",()=>{
  const passing=summarizeExpandedTournament({drafts:EXPANDED_SLOTS.map((slot,index)=>draft(slot,index<6?1:2))});
  assert.equal(passing.metrics.firstPlaceRate,.75);
  assert.equal(passing.pass,true);
  const failing=summarizeExpandedTournament({drafts:EXPANDED_SLOTS.map((slot,index)=>draft(slot,index<5?1:2))});
  assert.equal(failing.metrics.firstPlaceRate,.625);
  assert.equal(failing.gates.firstPlaceRate,false);
  assert.equal(failing.pass,false);
});

test("tournament latency gate uses all user-pick decisions",()=>{
  const report=summarizeExpandedTournament({drafts:EXPANDED_SLOTS.map((slot,index)=>draft(slot,1,index===7?6000:1000))});
  assert.ok(report.metrics.maximumDecisionMs>5000);
  assert.ok(report.metrics.p95DecisionMs>4000);
  assert.equal(report.gates.p95DecisionTime,true,"one isolated slow pick must not redefine the tournament-wide p95 gate");
});
