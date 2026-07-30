import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { buildHoldoutArtifact, canUnlockRealDrafts, decisionSeed, FROZEN_POLICY, frozenPolicyHash, HOLDOUT_TASK_COUNT, HOLDOUT_VALID_DRAFTS_REQUIRED, holdoutTasks, oneSidedWilsonLower, validateHoldoutResult } from "../scripts/cpu-holdout-gate-lib.js";

function resultFor(task,titleRank=1,overrides={}){const decisionAudit=Array.from({length:16},(_,index)=>{const round=index+1,pickNo=12*(round-1)+(round%2?task.userSlot:13-task.userSlot);return{pickNo,observedPickCount:pickNo-1,recommendationCount:1,seed:decisionSeed(task.scenarioSeed,pickNo)}});return{mode:"frozenHoldout",benchmarkId:task.benchmarkId,policyHash:task.policyHash,modelHash:task.modelHash,taskId:task.taskId,scenarioSeed:task.scenarioSeed,outcomeSeed:task.outcomeSeed,selectionMode:"causal_single_path",adaptiveRetries:0,pathsEvaluated:1,totalPicks:192,userPickCount:16,autopickCount:0,timeoutCount:0,mismatchCount:0,decisionAudit,final:{titleRank,titleChance:titleRank===1?.2:.05},...overrides}}

test("holdout schedule is fixed, balanced, reproducible, and cannot accept a CLI seed",()=>{
  const first=holdoutTasks(),second=holdoutTasks();
  assert.equal(first.length,HOLDOUT_TASK_COUNT);
  assert.deepEqual(first,second);
  assert.equal(HOLDOUT_TASK_COUNT,60);
  assert.deepEqual(first.slice(0,12).map(task=>task.userSlot),[1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.equal(new Set(first.map(task=>task.scenarioSeed)).size,HOLDOUT_TASK_COUNT);
  assert.equal(new Set(first.map(task=>task.outcomeSeed)).size,HOLDOUT_TASK_COUNT);
  assert.ok(first.every(task=>task.policy===FROZEN_POLICY&&task.policyHash===frozenPolicyHash()));
});

test("one-sided 95% Wilson lower bound enforces the preregistered 50% gate",()=>{
  assert.ok(oneSidedWilsonLower(29,48)<.5);
  assert.ok(oneSidedWilsonLower(30,48)>=.5);
  assert.equal(oneSidedWilsonLower(0,48),0);
});

test("only at least 48 valid causal single-path drafts can unlock",()=>{
  const tasks=holdoutTasks();
  const tooFew=buildHoldoutArtifact({tasks,results:tasks.slice(0,47).map((task,index)=>({taskId:task.taskId,result:resultFor(task,index<47?1:2)}))});
  assert.equal(tooFew.summary.validDrafts,47);
  assert.equal(tooFew.summary.realDraftsUnlocked,false);
  const failResults=tasks.slice(0,48).map((task,index)=>({taskId:task.taskId,result:resultFor(task,index<29?1:2)}));
  const failed=buildHoldoutArtifact({tasks,results:failResults});
  assert.equal(failed.summary.realDraftsUnlocked,false);
  const passResults=tasks.slice(0,48).map((task,index)=>({taskId:task.taskId,result:resultFor(task,index<30?1:2)}));
  const passed=buildHoldoutArtifact({tasks,results:passResults});
  assert.equal(passed.summary.validDrafts,HOLDOUT_VALID_DRAFTS_REQUIRED);
  assert.equal(passed.summary.titleRankFirstWins,30);
  assert.equal(passed.summary.realDraftsUnlocked,true);
  assert.equal(passed.summary.passed,true);
  assert.equal(canUnlockRealDrafts(passed),true);
  assert.equal(canUnlockRealDrafts({...passed,artifactType:"cpu_optimizer_training"}),false);
  assert.equal(canUnlockRealDrafts({...passed,summary:{...passed.summary,titleRankFirstWins:31}}),false);
});

test("invalid drafts are excluded with explicit reasons, never treated as losses or wins",()=>{
  const [task]=holdoutTasks(),bad=resultFor(task,1,{adaptiveRetries:1,pathsEvaluated:2,totalPicks:191,userPickCount:15,autopickCount:1,timeoutCount:1,mismatchCount:1});
  assert.deepEqual(validateHoldoutResult(bad,task),["adaptive_retry_used","multiple_terminal_paths","incomplete_draft","incomplete_user_roster","autopick_detected","decision_timeout","pick_mismatch"]);
  const artifact=buildHoldoutArtifact({tasks:[task],results:[{taskId:task.taskId,result:bad}]});
  assert.equal(artifact.summary.validDrafts,0);
  assert.equal(artifact.summary.titleRankFirstWins,0);
  assert.deepEqual(artifact.drafts[0].invalidReasons,validateHoldoutResult(bad,task));
});

test("training optimizer artifacts explicitly cannot unlock real-person drafts",()=>{
  const source=fs.readFileSync(new URL("../scripts/parallel-cpu-optimizer.js",import.meta.url),"utf8");
  assert.match(source,/artifactType:"cpu_optimizer_training"/);
  assert.match(source,/eligibleToUnlockRealDrafts:false/);
  assert.match(source,/realDraftsUnlocked:false/);
});

test("holdout worker has no beam, retry, or terminal alternative selection",()=>{
  const source=fs.readFileSync(new URL("../scripts/parallel-cpu-holdout-worker.js",import.meta.url),"utf8");
  assert.match(source,/selectionMode:"causal_single_path"/);
  assert.match(source,/limit:task\.policy\.recommendationLimit/);
  assert.doesNotMatch(source,/beam|adaptivePass|terminalAlternatives|finalists/);
});

test("official holdout runner has no seed, draft-count, or output-set override",()=>{
  const source=fs.readFileSync(new URL("../scripts/parallel-cpu-holdout.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/arg\("seed"|arg\("drafts"|arg\("output"|allow-identical-rerun/);
  assert.match(source,/if\(fs\.existsSync\(outputUrl\)\)throw new Error/);
});

test("frozen causal worker reproduces the same complete single path",{timeout:120000},async()=>{
  const task=holdoutTasks()[0],run=()=>new Promise((resolve,reject)=>{const worker=new Worker(new URL("../scripts/parallel-cpu-holdout-worker.js",import.meta.url));worker.once("error",reject);worker.once("message",message=>{worker.terminate();message.ok?resolve(message.result):reject(new Error(message.error))});worker.postMessage(task)}),first=await run(),second=await run();
  assert.equal(validateHoldoutResult(first,task).length,0);
  assert.equal(first.totalPicks,192);
  assert.equal(first.userPickCount,16);
  assert.deepEqual(first.userPicks,second.userPicks);
  assert.deepEqual(first.decisionAudit,second.decisionAudit);
  assert.deepEqual(first.final,second.final);
});
