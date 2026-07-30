import test from"node:test";
import assert from"node:assert/strict";
import{exactTitleSimulation,mergeRecommendationHistories,strongerRecommendationSnapshot}from"../extension/recommendation-history.js";

const result=({status="complete",simulationStatus="refined",iterations=10000,targetIterations=10000,candidateIterations=10000,teamIterations=10000}={})=>({status,simulationStatus,iterations,targetIterations,recommendations:[{simulation:{iterations:candidateIterations},teamSimulation:{iterations:teamIterations}}]});

test("title evidence requires an exact complete 10,000-simulation result",()=>{
  assert.equal(exactTitleSimulation(result()),true);
  assert.equal(exactTitleSimulation(result({status:"deadline_fallback",iterations:32,candidateIterations:32,teamIterations:32})),false);
  assert.equal(exactTitleSimulation(result({status:"worker_fallback"})),false);
  assert.equal(exactTitleSimulation(result({iterations:9999,candidateIterations:9999,teamIterations:9999})),false);
  assert.equal(exactTitleSimulation(result({candidateIterations:120})),false);
  assert.equal(exactTitleSimulation(result({teamIterations:120})),false)
});

test("strongest completed snapshot wins across histories",()=>{
  const partial={pickNo:17,capturedAt:200,simulationStatus:"refined",iterations:120,targetIterations:10000,source:"secondary"},complete={pickNo:17,capturedAt:100,status:"complete",simulationStatus:"refined",iterations:10000,targetIterations:10000,source:"gui"};
  assert.equal(strongerRecommendationSnapshot(complete,partial),complete);
  assert.equal(strongerRecommendationSnapshot(partial,complete),complete);
  assert.deepEqual(mergeRecommendationHistories([complete],[partial]),[complete])
});

test("history merge uses iterations then recency when neither snapshot is complete",()=>{
  const low={pickNo:8,capturedAt:300,simulationStatus:"quick",iterations:32,targetIterations:10000},highOld={pickNo:8,capturedAt:100,simulationStatus:"quick",iterations:120,targetIterations:10000},highNew={...highOld,capturedAt:200,source:"secondary"};
  assert.deepEqual(mergeRecommendationHistories([low,highOld],[highNew]),[highNew])
});
