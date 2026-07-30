import fs from"node:fs";
import{once}from"node:events";
import{performance}from"node:perf_hooks";
import{server}from"../server/index.js";

const reportPath=process.argv[2],pickNo=Number(process.argv[3]),userSlot=Number(process.argv[4]);
if(!reportPath||!Number.isInteger(pickNo)||!Number.isInteger(userSlot))throw new Error("Usage: node scripts/benchmark-saved-report-refinement.js <report.json> <pickNo> <userSlot>");
const report=JSON.parse(fs.readFileSync(reportPath,"utf8")).report,state=structuredClone(report.normalizedDraftState);
Object.assign(state,{draftId:state.draftId||report.draftId||"benchmark",draftRunId:`benchmark-${Date.now()}`,draftStatus:"drafting",currentPickNo:pickNo,updatedAt:Date.now()});state.picks=state.picks.slice(0,pickNo-1);
server.listen(0);await once(server,"listening");
const base=`http://127.0.0.1:${server.address().port}`,body=JSON.stringify({state,userSlot,strategy:"titleOnly",sourceProfile:"projectionLed",iterations:120,refineIterations:10000,limit:5,refinementDeadline:false,clockPriority:true,clientBuildId:"eval-jobs-v6-strict10k-20260714"}),started=performance.now();
let result=await fetch(`${base}/v1/evaluate`,{method:"POST",headers:{"content-type":"application/json","x-installation-id":"saved-report-benchmark"},body}).then(response=>response.json());
while(result.status==="refining"&&performance.now()-started<30000){await new Promise(resolve=>setTimeout(resolve,100));result=await fetch(`${base}/v1/evaluate/${result.evaluationId}`,{headers:{"x-installation-id":"saved-report-benchmark"}}).then(response=>response.json())}
console.log(JSON.stringify({elapsedMs:Math.round(performance.now()-started),error:result.error||result.refinementError,status:result.status,simulationStatus:result.simulationStatus,iterations:result.iterations,targetIterations:result.targetIterations,refinementOutcome:result.refinementOutcome,candidates:result.recommendations?.length,allCandidateIterations:result.recommendations?.every(item=>item.simulation?.iterations===10000&&item.teamSimulation?.iterations===10000)},null,2));
server.close();await once(server,"close");
