import{performance}from"node:perf_hooks";
import{Worker as NodeWorker}from"node:worker_threads";
import{fixtureState}from"../test/fixture.js";
import{snakeSlot}from"../shared/domain.js";

const TERMINAL_BUDGET_MS=25_000,ENGINE_BUDGET_MS=24_000,CANDIDATES=8;

class BrowserWorkerAdapter{
  static active=0;
  constructor(){BrowserWorkerAdapter.active++;this.worker=new NodeWorker(new URL("./extension-engine-node-worker.js",import.meta.url));this.worker.on("message",data=>this.onmessage?.({data}));this.worker.on("error",error=>this.onerror?.({message:error.message,error}));this.worker.once("exit",()=>BrowserWorkerAdapter.active--)}
  postMessage(value){this.worker.postMessage(value)}
  terminate(){return this.worker.terminate()}
}

globalThis.Worker=BrowserWorkerAdapter;
globalThis.chrome={runtime:{getURL:value=>value}};
const{localApi,shutdownLocalEngineWorkers,warmLocalEngineWorkers}=await import("../extension/local-engine-client.js");

const exactPayload=(picked,seed)=>{const state=fixtureState({teams:12,rounds:16,picked});state.draftId=`terminal-stress-${picked}-${seed}`;state.draftRunId=`run-${seed}`;state.updatedAt=Date.now();return{state,userSlot:snakeSlot(picked+1,12),strategy:"titleOnly",sourceProfile:"projectionLed",iterations:120,refineIterations:10_000,limit:CANDIDATES,seed}};
const runExact=async(name,picked,seed)=>{const started=performance.now(),result=await localApi("/v1/evaluate",{body:JSON.stringify(exactPayload(picked,seed))}),elapsedMs=performance.now()-started,exact=result?.status==="complete"&&result?.simulationStatus==="refined"&&result?.iterations===10_000&&result?.recommendations?.length===CANDIDATES&&result.recommendations.every(item=>item.simulation?.iterations===10_000&&item.teamSimulation?.iterations===10_000);return{name,picked,elapsedMs:Number(elapsedMs.toFixed(1)),workerCount:result?.workerCount,exact,pass:exact&&elapsedMs<=ENGINE_BUDGET_MS}};

const rows=[];
try{
  const warmStarted=performance.now();await warmLocalEngineWorkers();const warmupMs=performance.now()-warmStarted;
  rows.push(await runExact("early",12,8101));
  rows.push(await runExact("middle",84,8102));
  rows.push(await runExact("late",156,8103));
  rows.push(await runExact("repeated middle",84,8104));
  const cancellations=[];
  for(const[picked,seed]of[[13,8201],[14,8202],[15,8203]]){const controller=new AbortController(),started=performance.now(),pending=localApi("/v1/evaluate",{body:JSON.stringify(exactPayload(picked,seed)),signal:controller.signal});setTimeout(()=>controller.abort(),25);let terminal="";try{await pending;terminal="unexpected-complete"}catch(error){terminal=error?.name||error?.code||"error"}cancellations.push({picked,terminal,elapsedMs:Number((performance.now()-started).toFixed(1)),pass:terminal==="AbortError"&&performance.now()-started<TERMINAL_BUDGET_MS})}
  rows.push(await runExact("post-churn replacement",16,8204));
  const report={budgets:{terminalMs:TERMINAL_BUDGET_MS,engineMs:ENGINE_BUDGET_MS},warmupMs:Number(warmupMs.toFixed(1)),rows,cancellations,pass:rows.every(row=>row.pass)&&cancellations.every(row=>row.pass)};
  console.log(JSON.stringify(report,null,2));
  if(!report.pass)process.exitCode=1
}finally{shutdownLocalEngineWorkers()}
