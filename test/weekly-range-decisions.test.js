import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWeeklyRangeDecisions } from "../scripts/evaluate-weekly-range-decisions.js";

test("decision policies are tuned before the holdout and report both contexts",()=>{
  const rows=[];
  for(const year of[2021,2022,2023,2024])for(let week=1;week<=24;week++)for(let player=0;player<2;player++){
    const projected=11-player*.5,stable=player===1,actual=stable?10.5:(week%3===0?20:3);
    rows.push({year,week,name:`P${player}`,position:"WR",projected,actual,activityStatus:"active-observed"});
  }
  const artifact=evaluateWeeklyRangeDecisions(rows,{bootstrapDraws:100,shrinkage:2});
  assert.equal(artifact.schemaVersion,2);
  assert.equal(artifact.configuration.validationYear,2023);
  assert.equal(artifact.configuration.holdoutYear,2024);
  assert.equal(artifact.dataQuality.activityAware,true);
  assert.ok(artifact.dataQuality.holdoutEligibleDecisions>0);
  assert.ok(artifact.policies.stable.selection.sweep.length>1);
  assert.ok(artifact.policies.upside.selection.sweep.length>1);
  assert.equal(artifact.dataQuality.runtimePromotionGatePassed,false);
});

test("holdout outcomes cannot affect selected policy weights",()=>{
  const rows=[];for(const year of[2021,2022,2023,2024])for(let week=1;week<=20;week++)for(let player=0;player<2;player++)rows.push({year,week,name:`P${player}`,position:"RB",projected:10-player*.25,actual:player?(year===2024?100:9):(year===2024?0:(week%2?18:2)),activityStatus:"active-observed"});
  const first=evaluateWeeklyRangeDecisions(rows,{bootstrapDraws:20,shrinkage:1});
  const changed=rows.map(row=>row.year===2024?{...row,actual:200-row.actual}:row);
  const second=evaluateWeeklyRangeDecisions(changed,{bootstrapDraws:20,shrinkage:1});
  assert.equal(first.policies.stable.selection.selectedWeight,second.policies.stable.selection.selectedWeight);
  assert.equal(first.policies.upside.selection.selectedWeight,second.policies.upside.selection.selectedWeight);
});
