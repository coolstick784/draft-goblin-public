import crypto from "node:crypto";

export const ADAPTIVE_ALLOCATOR_HOLDOUT_ID = "adaptive-allocator-synthetic-holdout-v1";
export const ADAPTIVE_ALLOCATOR_TASKS = Object.freeze([
  ["aa-001",3,327103,927103],["aa-002",5,327105,927105],["aa-003",8,327108,927108],["aa-004",10,327110,927110],
  ["aa-005",3,337103,937103],["aa-006",5,337105,937105],["aa-007",8,337108,937108],["aa-008",10,337110,937110],
  ["aa-009",3,347103,947103],["aa-010",5,347105,947105],["aa-011",8,347108,947108],["aa-012",10,347110,947110]
].map(([taskId,userSlot,scenarioSeed,outcomeSeed])=>Object.freeze({benchmarkId:ADAPTIVE_ALLOCATOR_HOLDOUT_ID,taskId,userSlot,scenarioSeed,outcomeSeed})));

const stable=value=>Array.isArray(value)?`[${value.map(stable).join(",")}]`:value&&typeof value==="object"?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`:JSON.stringify(value);
export const adaptiveAllocatorTaskHash=()=>crypto.createHash("sha256").update(stable(ADAPTIVE_ALLOCATOR_TASKS)).digest("hex");
export const ADAPTIVE_ALLOCATOR_TASK_HASH="8660018efa17fa60427593f0a1c213abb85af449fa4637269e5b13e5d8caa1ed";

export const ADAPTIVE_ALLOCATOR_THRESHOLDS=Object.freeze({requiredTasks:12,minimumFirstPlaceRate:.75,maximumFirstPlaceRegression:1/12,maximumMeanTitleRank:1.75,maximumMeanRankRegression:.25,maximumP95DecisionMs:5000,maximumRelativeP95Regression:.10,maximumAbsoluteP95RegressionMs:150});

export function validateAllocatorResult(result,task,arm){
  const reasons=[];
  if(!result||typeof result!=="object")return["missing_result"];
  if(result.benchmarkId!==ADAPTIVE_ALLOCATOR_HOLDOUT_ID||result.taskId!==task.taskId||result.userSlot!==task.userSlot||result.scenarioSeed!==task.scenarioSeed||result.outcomeSeed!==task.outcomeSeed)reasons.push("task_identity_mismatch");
  if(result.arm!==arm)reasons.push("arm_identity_mismatch");
  if(result.complete!==true||Number(result.totalPicks)!==192||Number(result.userPickCount)!==16)reasons.push("incomplete_draft");
  if(Number(result.terminalPaths)!==1||Number(result.pathRetries||0)!==0||result.seedOverride===true)reasons.push("noncausal_or_retried_path");
  if(Number(result.timeoutCount||0)!==0||Number(result.mismatchCount||0)!==0)reasons.push("execution_failure");
  if(!Number.isInteger(result.titleRank)||result.titleRank<1||result.titleRank>12)reasons.push("invalid_title_rank");
  if(!Array.isArray(result.decisionMs)||result.decisionMs.length!==16||result.decisionMs.some(value=>!Number.isFinite(Number(value))||Number(value)<0))reasons.push("invalid_decision_latency");
  return reasons;
}

const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b),offset=(sorted.length-1)*p,lower=Math.floor(offset),upper=Math.ceil(offset),weight=offset-lower;return sorted[lower]*(1-weight)+sorted[upper]*weight};
const metrics=rows=>{const times=rows.flatMap(row=>row.decisionMs.map(Number)),firsts=rows.filter(row=>row.titleRank===1).length;return{drafts:rows.length,firsts,firstPlaceRate:firsts/rows.length,meanTitleRank:rows.reduce((sum,row)=>sum+row.titleRank,0)/rows.length,p95DecisionMs:percentile(times,.95),maximumDecisionMs:Math.max(...times)}};

export function scoreAdaptiveAllocatorHoldout({baselineResults,candidateResults,candidateId,candidateHash,generatedAt=new Date().toISOString()}){
  if(adaptiveAllocatorTaskHash()!==ADAPTIVE_ALLOCATOR_TASK_HASH)throw new Error("Adaptive allocator holdout tasks changed after preregistration; create v2 instead.");
  const inspect=(results,arm)=>ADAPTIVE_ALLOCATOR_TASKS.map(task=>{const result=(results||[]).find(row=>row.taskId===task.taskId),invalidReasons=validateAllocatorResult(result,task,arm);return{task,...(invalidReasons.length?{valid:false,invalidReasons}:{valid:true,result})}}),baseline=inspect(baselineResults,"baseline"),candidate=inspect(candidateResults,"candidate"),baselineValid=baseline.filter(row=>row.valid).map(row=>row.result),candidateValid=candidate.filter(row=>row.valid).map(row=>row.result),complete=baselineValid.length===12&&candidateValid.length===12,b=complete?metrics(baselineValid):null,c=complete?metrics(candidateValid):null;
  const gates={completion:complete,firstPlaceAbsolute:complete&&c.firstPlaceRate>=ADAPTIVE_ALLOCATOR_THRESHOLDS.minimumFirstPlaceRate,firstPlaceNonRegression:complete&&c.firstPlaceRate>=b.firstPlaceRate-ADAPTIVE_ALLOCATOR_THRESHOLDS.maximumFirstPlaceRegression,rankAbsolute:complete&&c.meanTitleRank<=ADAPTIVE_ALLOCATOR_THRESHOLDS.maximumMeanTitleRank,rankNonRegression:complete&&c.meanTitleRank<=b.meanTitleRank+ADAPTIVE_ALLOCATOR_THRESHOLDS.maximumMeanRankRegression,latencyAbsolute:complete&&c.p95DecisionMs<=ADAPTIVE_ALLOCATOR_THRESHOLDS.maximumP95DecisionMs,latencyNonRegression:complete&&c.p95DecisionMs<=Math.max(b.p95DecisionMs*(1+ADAPTIVE_ALLOCATOR_THRESHOLDS.maximumRelativeP95Regression),b.p95DecisionMs+ADAPTIVE_ALLOCATOR_THRESHOLDS.maximumAbsoluteP95RegressionMs)};
  return{schemaVersion:1,artifactType:"adaptive_allocator_synthetic_holdout",researchOnly:true,eligibleToPromoteLive:false,benchmarkId:ADAPTIVE_ALLOCATOR_HOLDOUT_ID,taskHash:ADAPTIVE_ALLOCATOR_TASK_HASH,candidateId,candidateHash,generatedAt,thresholds:ADAPTIVE_ALLOCATOR_THRESHOLDS,baselineMetrics:b,candidateMetrics:c,gates,passed:Object.values(gates).every(Boolean),baseline,candidate,interpretation:"Passing establishes synthetic non-regression only. It does not validate forecast calibration or authorize live promotion."};
}
