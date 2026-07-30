import crypto from "node:crypto";
import fs from "node:fs";

export const HOLDOUT_SCHEMA_VERSION=1;
export const HOLDOUT_BENCHMARK_ID="cpu-title-rank-holdout-v1";
export const HOLDOUT_VALID_DRAFTS_REQUIRED=48;
export const HOLDOUT_TASK_COUNT=60;
export const HOLDOUT_Z_ONE_SIDED_95=1.6448536269514722;
export const FROZEN_POLICY_HASH_V1="2e9b892616d5a96b68517cbe46f2dd77cf0e33237596386024c6aa9408e976a0";

// This is deliberately data, not a parameter sweep. Any model change requires a
// new policy id and a fresh benchmark version; this v1 policy must not be edited
// after its holdout is observed.
export const FROZEN_POLICY=Object.freeze({
  policyId:"causal-title-policy-v1",
  strategy:"balanced",
  sourceProfile:"projectionLed",
  recommendationLimit:1,
  pickIterations:32,
  outcomeIterations:2000
});

export function stableJson(value){
  if(Array.isArray(value))return`[${value.map(stableJson).join(",")}]`;
  if(value&&typeof value==="object")return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function frozenPolicyHash(policy=FROZEN_POLICY){
  return crypto.createHash("sha256").update(stableJson(policy)).digest("hex");
}

export function modelImplementationHash(){
  const hash=crypto.createHash("sha256"),roots=[["core",new URL("../core/",import.meta.url)],["shared",new URL("../shared/",import.meta.url)]];
  for(const [label,root] of roots)for(const name of fs.readdirSync(root).filter(name=>name.endsWith(".js")).sort()){hash.update(`${label}/${name}\0`);hash.update(fs.readFileSync(new URL(name,root)))}
  for(const [label,url] of [["scripts/cpu-holdout-gate-lib.js",new URL("./cpu-holdout-gate-lib.js",import.meta.url)],["scripts/parallel-cpu-holdout-worker.js",new URL("./parallel-cpu-holdout-worker.js",import.meta.url)],["data/generated/sleeper-current-projections.json",new URL("../data/generated/sleeper-current-projections.json",import.meta.url)]]){hash.update(`${label}\0`);hash.update(fs.readFileSync(url))}
  return hash.digest("hex");
}

function uint32Digest(text){return crypto.createHash("sha256").update(text).digest().readUInt32BE(0)}

export function holdoutTasks(){
  const policyHash=frozenPolicyHash(),modelHash=modelImplementationHash();
  if(policyHash!==FROZEN_POLICY_HASH_V1)throw new Error("Frozen v1 policy changed. Register a new benchmark id and untouched holdout instead of editing an observed policy.");
  return Array.from({length:HOLDOUT_TASK_COUNT},(_,index)=>{
    // Seeds are preregistered to the benchmark, not derived from model choices.
    // Consequently a policy cannot obtain a fresh outcome set merely by changing
    // a weight or identifier and retrying until it passes.
    const ordinal=index+1,seedRoot=`${HOLDOUT_BENCHMARK_ID}:${ordinal}`;
    return{mode:"frozenHoldout",benchmarkId:HOLDOUT_BENCHMARK_ID,policy:FROZEN_POLICY,policyHash,modelHash,taskId:`${HOLDOUT_BENCHMARK_ID}:${String(ordinal).padStart(3,"0")}`,scenarioSeed:uint32Digest(`${seedRoot}:scenario`),outcomeSeed:uint32Digest(`${seedRoot}:outcome`),userSlot:index%12+1};
  });
}

export const decisionSeed=(scenarioSeed,pickNo)=>(Number(scenarioSeed)+Number(pickNo))>>>0;

export function oneSidedWilsonLower(successes,total,z=HOLDOUT_Z_ONE_SIDED_95){
  if(!Number.isInteger(successes)||!Number.isInteger(total)||successes<0||total<1||successes>total)return 0;
  const p=successes/total,z2=z*z,denominator=1+z2/total;
  return Math.max(0,(p+z2/(2*total)-z*Math.sqrt((p*(1-p)+z2/(4*total))/total))/denominator);
}

export function validateHoldoutResult(result,task){
  const reasons=[];
  if(!result||typeof result!=="object")return["missing_result"];
  if(result.mode!=="frozenHoldout")reasons.push("not_frozen_holdout");
  if(result.benchmarkId!==task.benchmarkId)reasons.push("benchmark_identity_mismatch");
  if(result.policyHash!==task.policyHash)reasons.push("policy_identity_mismatch");
  if(result.modelHash!==task.modelHash)reasons.push("model_identity_mismatch");
  if(result.taskId!==task.taskId||result.scenarioSeed!==task.scenarioSeed||result.outcomeSeed!==task.outcomeSeed)reasons.push("task_identity_mismatch");
  if(result.selectionMode!=="causal_single_path")reasons.push("noncausal_selection_mode");
  if(Number(result.adaptiveRetries||0)!==0)reasons.push("adaptive_retry_used");
  if(Number(result.pathsEvaluated)!==1)reasons.push("multiple_terminal_paths");
  if(Number(result.totalPicks)!==192)reasons.push("incomplete_draft");
  if(Number(result.userPickCount)!==16)reasons.push("incomplete_user_roster");
  const expectedPickNos=Array.from({length:16},(_,index)=>{const round=index+1;return 12*(round-1)+(round%2?task.userSlot:13-task.userSlot)});
  if(!Array.isArray(result.decisionAudit)||result.decisionAudit.length!==16||result.decisionAudit.some((item,index)=>item.pickNo!==expectedPickNos[index]||item.observedPickCount!==item.pickNo-1||item.recommendationCount!==1||item.seed!==decisionSeed(task.scenarioSeed,item.pickNo)))reasons.push("invalid_causal_decision_audit");
  if(Number(result.autopickCount||0)!==0)reasons.push("autopick_detected");
  if(Number(result.timeoutCount||0)!==0)reasons.push("decision_timeout");
  if(Number(result.mismatchCount||0)!==0)reasons.push("pick_mismatch");
  if(!Number.isInteger(result.final?.titleRank)||result.final.titleRank<1||result.final.titleRank>12)reasons.push("invalid_title_rank");
  return reasons;
}

export function buildHoldoutArtifact({tasks,results,generatedAt=new Date().toISOString()}){
  const byTask=new Map((results||[]).map(item=>[item.taskId,item]));
  const drafts=tasks.map(task=>{
    const envelope=byTask.get(task.taskId),workerError=envelope?.workerError;
    const reasons=workerError?["worker_error"]:validateHoldoutResult(envelope?.result,task);
    return{taskId:task.taskId,userSlot:task.userSlot,scenarioSeed:task.scenarioSeed,outcomeSeed:task.outcomeSeed,valid:reasons.length===0,invalidReasons:reasons,workerError:workerError||null,result:reasons.length===0?envelope.result:null};
  });
  const valid=drafts.filter(draft=>draft.valid),wins=valid.filter(draft=>draft.result.final.titleRank===1).length,lower=oneSidedWilsonLower(wins,valid.length),enoughValid=valid.length>=HOLDOUT_VALID_DRAFTS_REQUIRED,passed=enoughValid&&lower>=.5;
  return{schemaVersion:HOLDOUT_SCHEMA_VERSION,artifactType:"cpu_frozen_policy_holdout",eligibleToUnlockRealDrafts:true,generatedAt,benchmark:{benchmarkId:HOLDOUT_BENCHMARK_ID,taskCount:tasks.length,validDraftsRequired:HOLDOUT_VALID_DRAFTS_REQUIRED,successMetric:"final_title_odds_rank_equals_1",confidenceRule:"one-sided 95% Wilson lower bound >= 0.50",policy:FROZEN_POLICY,policyHash:frozenPolicyHash(),modelHash:tasks[0]?.modelHash||modelImplementationHash(),modelHashScope:"All core/shared JavaScript, the causal worker, and its projection input",seedRule:"SHA-256-derived fixed seeds; no CLI seed override",selectionRule:"One causal recommendation per observed pick state; exactly one completed path; no retries or terminal-path selection."},summary:{scheduledDrafts:tasks.length,validDrafts:valid.length,invalidDrafts:drafts.length-valid.length,titleRankFirstWins:wins,titleRankFirstRate:valid.length?wins/valid.length:0,wilsonOneSided95Lower:lower,passed,realDraftsUnlocked:passed,reason:!enoughValid?`Need at least ${HOLDOUT_VALID_DRAFTS_REQUIRED} valid drafts.`:passed?"Frozen policy passed the preregistered title-rank gate.":"Wilson lower bound is below 0.50."},drafts};
}

export function canUnlockRealDrafts(artifact){
  if(artifact?.artifactType!=="cpu_frozen_policy_holdout"||artifact?.benchmark?.benchmarkId!==HOLDOUT_BENCHMARK_ID||artifact?.benchmark?.policyHash!==FROZEN_POLICY_HASH_V1||artifact?.benchmark?.modelHash!==modelImplementationHash()||artifact?.benchmark?.taskCount!==HOLDOUT_TASK_COUNT||!Array.isArray(artifact.drafts)||artifact.drafts.length!==HOLDOUT_TASK_COUNT)return false;
  const tasks=holdoutTasks(),byId=new Map(artifact.drafts.map(draft=>[draft.taskId,draft])),valid=[];
  for(const task of tasks){const draft=byId.get(task.taskId);if(!draft||draft.scenarioSeed!==task.scenarioSeed||draft.outcomeSeed!==task.outcomeSeed)return false;if(draft.valid){if(validateHoldoutResult(draft.result,task).length)return false;valid.push(draft)}}
  const wins=valid.filter(draft=>draft.result.final.titleRank===1).length,lower=oneSidedWilsonLower(wins,valid.length),passed=valid.length>=HOLDOUT_VALID_DRAFTS_REQUIRED&&lower>=.5;
  return Boolean(passed&&artifact.summary?.scheduledDrafts===HOLDOUT_TASK_COUNT&&artifact.summary?.validDrafts===valid.length&&artifact.summary?.titleRankFirstWins===wins&&Math.abs(Number(artifact.summary?.wilsonOneSided95Lower)-lower)<1e-12&&artifact.summary?.passed===true&&artifact.summary?.realDraftsUnlocked===true);
}
