import {performance} from "node:perf_hooks";
import {server} from "../server/index.js";
import {fixtureState} from "../test/fixture.js";

const buildId="eval-jobs-v6-strict10k-20260714",pollMs=250;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function stateFor(label,picked=15){
  const state=fixtureState({teams:12,rounds:16,picked});
  state.draftId=`tail-${label}-${Date.now()}-${Math.random()}`;
  state.draftRunId=label;
  state.updatedAt=Date.now();
  return state;
}

async function evaluate(base,{label,consumer="gui",picked=15,limit=3,seed=2026}){
  const started=performance.now(),body={state:stateFor(label,picked),userSlot:4,strategy:"balanced",iterations:consumer==="gui"?32:120,refineIterations:10000,limit,seed,consumer,clientBuildId:buildId,refinementDeadline:true};
  let response=await fetch(`${base}/v1/evaluate`,{method:"POST",headers:{"content-type":"application/json","x-installation-id":`tail-${label}`},body:JSON.stringify(body)}),result=await response.json();
  while(result.status==="refining"){
    await delay(pollMs);
    response=await fetch(`${base}/v1/evaluate/${result.evaluationId}`,{headers:{"x-installation-id":`tail-${label}`}});
    result=await response.json();
  }
  return{label,consumer,limit,picked,status:result.status,iterations:result.iterations,elapsedMs:Math.round(performance.now()-started),serviceMs:result.refinementMs,workerCount:result.workerCount};
}

server.listen(0,async()=>{
  const base=`http://127.0.0.1:${server.address().port}`,results=[];
  results.push(await evaluate(base,{label:"isolated-early",picked:15}));
  results.push(...await Promise.all([
    evaluate(base,{label:"concurrent-gui",picked:15,consumer:"gui",limit:3,seed:3001}),
    evaluate(base,{label:"concurrent-priority",picked:15,clockPriority:true,limit:8,seed:3002})
  ]));
  results.push(await evaluate(base,{label:"isolated-late",picked:160}));
  const health=await fetch(`${base}/health`).then(response=>response.json());
  console.log(JSON.stringify({generatedAt:new Date().toISOString(),results,pressure:health.evaluationDiagnostics?.pressure,statusCounts:health.evaluationDiagnostics?.statusCounts},null,2));
  server.close();
});
