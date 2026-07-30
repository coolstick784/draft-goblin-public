import test from"node:test";
import assert from"node:assert/strict";
import{UNPROMOTED_POSITION_RANGES,promotedPlayerDistribution,unpromotedPerformanceRange}from"../extension/player-distribution-enrichment.js";

test("Josh Allen-like QB projection uses the empirical QB season residual interval",()=>{
  const range=unpromotedPerformanceRange(370,"QB");
  assert.equal(range.floor,318.21);
  assert.equal(range.ceiling,422.94);
  assert.equal(range.positionLimit,450);
  assert.equal(range.calibrationRows,3558);
  assert.equal(range.includesHistoricalProjectionError,true);
});

test("every supported position uses frozen residual quantiles and a safety ceiling",()=>{
  const examples={QB:430,RB:460,WR:420,TE:330,K:180,DST:225};
  for(const[position,mean]of Object.entries(examples)){
    const limits=UNPROMOTED_POSITION_RANGES[position],range=unpromotedPerformanceRange(mean,position);
    assert.equal(range.floor,Math.max(0,mean+limits.lowerResidual));
    assert.equal(range.ceiling,Math.max(mean,Math.min(mean+limits.upperResidual,limits.ceiling)));
    assert.ok(range.ceiling<=Math.max(mean,limits.ceiling));
  }
});

test("defense aliases share the D/ST range contract",()=>{
  assert.deepEqual(unpromotedPerformanceRange(170,"D/ST"),unpromotedPerformanceRange(170,"DST"));
  assert.deepEqual(unpromotedPerformanceRange(170,"DEF"),unpromotedPerformanceRange(170,"DST"));
});

test("promoted season-ratio model applies only validated player factors",()=>{const model={runtimeStatus:"promoted",schemaVersion:"quantile-v1",unit:"season-performance-ratio",season:2026,modelId:"ratio",modelVersion:"v1",calibrationId:"holdout",generatedAt:"2026-07-22T00:00:00.000Z",forecastAsOf:"2026-07-22T00:00:00.000Z",trainedThrough:"2024-12-31T00:00:00.000Z",sourceSnapshotIds:["test"],scoringFormats:{"half-ppr":{playerShrinkage:100,positions:{QB:{personalized:true,buckets:[{maxMean:null,ratioQuantiles:[.7,1,1.3],meanRatio:1}]}},players:{"exampleqb:QB":{observedProjected:200,observedActual:240}}}}},distribution=promotedPlayerDistribution({model,player:{name:"Example QB",position:"QB",team:"BUF"},mean:300,season:2026,scoringFormat:"half-ppr"});assert.ok(distribution);assert.equal(distribution.quantiles.find(row=>row.p===.5).value>300,true);assert.equal(promotedPlayerDistribution({model,player:{name:"Example QB",position:"QB"},mean:300,season:2026,scoringFormat:"ppr"}),null)});
