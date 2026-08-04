import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { equivalentTopCandidates, supportedInversions, validateRefinementPerformance } from "../scripts/validate-refinement-performance.js";
import { fixtureState } from "./fixture.js";

test("evidence-ready recommendations preserve the full-run top choice and candidate set",()=>{
  const staleState=fixtureState({teams:4,rounds:6,picked:8});staleState.updatedAt=1;
  const cases=[{name:"smoke",state:staleState,userSlot:2}];
  const report=validateRefinementPerformance({readyIterations:40,fullIterations:40,limit:8,cases});
  assert.equal(report.acceptance.qualityPass,true,JSON.stringify(report.cases,null,2));
  assert.equal(report.cases.every(item=>item.deterministic),true);
  assert.equal(report.acceptance.resourcePass,true);
});

test("performance harness enforces a lightweight portable worker and memory budget",()=>{
  const source=fs.readFileSync(new URL("../scripts/validate-refinement-performance.js",import.meta.url),"utf8");
  const benchmark=fs.readFileSync(new URL("../scripts/benchmark-parallel-refinement.js",import.meta.url),"utf8");
  const server=fs.readFileSync(new URL("../server/index.js",import.meta.url),"utf8");
  assert.match(source,/Math\.min\(4,logicalCores-1/);
  assert.match(source,/rssGrowthMb<=512/);
  assert.match(source,/topSetOverlap>=\.875/);
  assert.match(source,/unsupportedProbabilityInversions/);
  assert.match(benchmark,/MEMORY_GROWTH_BUDGET_MB=512/);
  assert.match(benchmark,/peakRssMb/);
  assert.match(server,/MAX_SIMULATION_CACHE=512/);
  assert.match(server,/MAX_EVALUATION_CACHE=256/);
  assert.doesNotMatch(server,/candidateSimulationCache\.size>5000|evaluationCache\.size>1000/);
});

test("extension 10k gate isolates every case behind a true cold-start boundary",()=>{
  const benchmark=fs.readFileSync(new URL("../scripts/benchmark-extension-10k-gate.js",import.meta.url),"utf8");
  const client=fs.readFileSync(new URL("../extension/local-engine-client.js",import.meta.url),"utf8");
  const sidepanel=fs.readFileSync(new URL("../extension/sidepanel.js",import.meta.url),"utf8");
  assert.match(benchmark,/spawn\(process\.execPath/);
  assert.match(benchmark,/--cold-case/);
  assert.match(benchmark,/fresh Node process and fresh extension worker pool per case/);
  assert.match(benchmark,/coldStartMs<=TARGET_MS/);
  assert.match(benchmark,/E2E_TARGET_MS=25_000,BROWSER_BUDGET_MS=3_000,TARGET_MS=E2E_TARGET_MS-BROWSER_BUDGET_MS,CANDIDATES=8,REPEATS_PER_CASE=2/);
  assert.match(benchmark,/for\(let repetition=1;repetition<=REPEATS_PER_CASE;repetition\+\+\)/);
  assert.match(benchmark,/p100Ms\+BROWSER_BUDGET_MS<=E2E_TARGET_MS/);
  assert.match(benchmark,/refineIterations:10_000/);
  assert.match(client,/const MAX_PARALLEL_WORKERS=8/);
  assert.doesNotMatch(sidepanel,/EXACT_PREDICTION_BUDGET_SECONDS/);
  assert.match(sidepanel,/longRunning=path==="\/v1\/evaluate"\|\|path==="\/v1\/draft-report"/);
  assert.match(sidepanel,/timeout=longRunning\?null:setTimeout/);
});

test("full-run displayed ties are equivalent instead of unsupported inversions",()=>{
  const item=(id,name,tenths)=>({player:{id,name},simulation:{displayTitleTenths:tenths}});
  const ready=[item("a","Ready leader",120),item("b","Ready runner-up",110)];
  const tiedFull=[item("b","Ready runner-up",111),item("a","Ready leader",111)];
  const contradictoryFull=[item("b","Ready runner-up",112),item("a","Ready leader",110)];
  assert.deepEqual(supportedInversions(ready,tiedFull),[]);
  assert.equal(supportedInversions(ready,contradictoryFull).length,1);
});

test("top candidates are equivalent only when both stages display a tie",()=>{
  const item=(id,tenths)=>({player:{id},simulation:{displayTitleTenths:tenths}});
  assert.equal(equivalentTopCandidates([item("a",100),item("b",100)],[item("b",90),item("a",90)]),true);
  assert.equal(equivalentTopCandidates([item("a",101),item("b",100)],[item("b",90),item("a",90)]),false);
});
