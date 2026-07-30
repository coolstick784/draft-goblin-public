import os from "node:os";
import {performance} from "node:perf_hooks";
import {pathToFileURL} from "node:url";
import {server} from "../server/index.js";
import {fixtureState} from "../test/fixture.js";
import {snakeSlot} from "../shared/domain.js";

export const REFINEMENT_GATE_MS=25_000;
export const REFINEMENT_CASES=Object.freeze([
  {name:"12-team early",picked:12},
  {name:"12-team middle",picked:84},
  {name:"12-team late",picked:156}
]);

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]};

export async function runRefinementGate({targetMs=REFINEMENT_GATE_MS,pollMs=50}={}){
  if(server.listening)throw new Error("refinement gate requires an unused server instance");
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${server.address().port}`,rows=[];
  try{
    for(const [index,testCase] of REFINEMENT_CASES.entries()){
      const state=fixtureState({teams:12,rounds:16,picked:testCase.picked});
      state.draftId=`refinement-gate-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
      state.draftRunId=`fresh-${Date.now()}-${index}`;
      state.updatedAt=Date.now();
      const userSlot=snakeSlot(testCase.picked+1,12),body=JSON.stringify({state,userSlot,strategy:"titleOnly",sourceProfile:"projectionLed",iterations:120,refineIterations:10_000,limit:5,seed:64001+index,clockPriority:true,refinementDeadline:false,clientBuildId:"eval-jobs-v6-strict10k-20260714"}),started=performance.now(),request=()=>fetch(`${base}/v1/evaluate`,{method:"POST",headers:{"content-type":"application/json","x-installation-id":`refinement-gate-${index}`},body}).then(async response=>({...await response.json(),httpStatus:response.status}));
      let result=await request(),evaluationId=result.evaluationId,quickMs=performance.now()-started;
      while(result.httpStatus<400&&result.status==="refining"&&performance.now()-started<targetMs+5_000){await wait(pollMs);result=await fetch(`${base}/v1/evaluate/${encodeURIComponent(evaluationId)}`,{headers:{"x-installation-id":`refinement-gate-${index}`}}).then(async response=>({...await response.json(),httpStatus:response.status}))}
      const elapsedMs=performance.now()-started,recommendations=result.recommendations||[],exact=result.status==="complete"&&result.simulationStatus==="refined"&&Number(result.iterations)===10_000&&recommendations.length===5&&recommendations.every(item=>Number(item.simulation?.iterations)===10_000&&Number(item.teamSimulation?.iterations)===10_000),pass=exact&&elapsedMs<=targetMs;
      rows.push({name:testCase.name,picked:testCase.picked,userSlot,quickMs:Number(quickMs.toFixed(1)),elapsedMs:Number(elapsedMs.toFixed(1)),iterations:Number(result.iterations)||0,candidates:recommendations.length,status:result.status,error:result.error||result.refinementError||null,exact,pass});
    }
  }finally{await new Promise(resolve=>server.close(resolve))}
  const elapsed=rows.map(row=>row.elapsedMs),report={configuration:{targetMs,iterations:10_000,candidates:5,cases:REFINEMENT_CASES.length,pollMs},hardware:{logicalCpus:os.availableParallelism?.()||os.cpus().length,workerOverride:process.env.DRAFT_CHAMPION_WORKERS||null},p50Ms:percentile(elapsed,.5),p95Ms:percentile(elapsed,.95),p100Ms:Math.max(...elapsed),rows,pass:rows.every(row=>row.pass)};
  return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const report=await runRefinementGate();console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1}
