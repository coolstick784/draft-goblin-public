import test from "node:test";
import assert from "node:assert/strict";
import { validateRankingEngine } from "../scripts/validate-ranking-engine.js";

test("ranking engine passes construction, continuity, probability, tail, and evidence gates",()=>{
  const report=validateRankingEngine({iterations:500});
  assert.deepEqual(report.failed,[],JSON.stringify(report.failed,null,2));
  assert.equal(report.pass,true);
});
