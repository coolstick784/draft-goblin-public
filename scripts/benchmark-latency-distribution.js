import os from "node:os";
import fs from "node:fs";
import {performance} from "node:perf_hooks";
import {server} from "../server/index.js";
import {fixtureState} from "../test/fixture.js";

const SAMPLE_COUNT=Math.max(1,Number(process.env.DC_LATENCY_SAMPLES)||20),START_INDEX=Math.max(0,Number(process.env.DC_LATENCY_START)||0),QUICK_ITERATIONS=32,TARGET_ITERATIONS=10000,RECOMMENDATION_LIMIT=Math.max(1,Number(process.env.DC_LATENCY_LIMIT)||3),GUI_POLL_INTERVAL_MS=500,P100_TARGET_MS=30000;
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]};
const ids=result=>(result?.recommendations||[]).slice(0,8).map(item=>String(item.player.id));

function benchmarkCases(){
  const teamsCycle=[8,10,12,10,8,12],progressCycle=[.08,.2,.35,.5,.65,.72,.78];
  return Array.from({length:SAMPLE_COUNT},(_,offset)=>{const index=START_INDEX+offset,teams=teamsCycle[index%teamsCycle.length],rounds=15,picked=Math.min(teams*rounds-2,Math.floor(teams*rounds*progressCycle[index%progressCycle.length])),state=fixtureState({teams,rounds,picked});state.draftId=`latency-${Date.now()}-${index}-${teams}-${picked}`;return{name:`${teams}-team pick ${picked+1}`,state,userSlot:index%teams+1,index}});
}

server.listen(0,async()=>{
  const base=`http://127.0.0.1:${server.address().port}`,samples=[];
  for(const [sampleIndex,entry] of benchmarkCases().entries()){
    entry.state.updatedAt=Date.now();
    const body=JSON.stringify({state:entry.state,userSlot:entry.userSlot,strategy:"balanced",iterations:QUICK_ITERATIONS,refineIterations:TARGET_ITERATIONS,limit:RECOMMENDATION_LIMIT,seed:7719+entry.index,consumer:"gui",clientBuildId:"eval-jobs-v6-strict10k-20260714"}),start=()=>fetch(`${base}/v1/evaluate`,{method:"POST",headers:{"content-type":"application/json","x-installation-id":`latency-${entry.index}`},body}).then(async response=>({...await response.json(),httpStatus:response.status})),poll=evaluationId=>fetch(`${base}/v1/evaluate/${encodeURIComponent(evaluationId)}`,{headers:{"x-installation-id":`latency-${entry.index}`}}).then(async response=>({...await response.json(),httpStatus:response.status})),started=performance.now();
    let result=await start(),evidence=null;const quickOddsMilliseconds=Math.round(performance.now()-started),evaluationId=result.evaluationId;
    while(result.httpStatus<400&&result.status==="refining"&&evaluationId&&performance.now()-started<P100_TARGET_MS){await new Promise(resolve=>setTimeout(resolve,GUI_POLL_INTERVAL_MS));result=await poll(evaluationId);if(!evidence&&result.simulationStatus==="evidence_ready")evidence=result}
    const milliseconds=Math.round(performance.now()-started),evidenceIds=ids(evidence),finalIds=ids(result),finalSet=new Set(finalIds),overlap=evidenceIds.length?evidenceIds.filter(id=>finalSet.has(id)).length/evidenceIds.length:1,evidenceTop=evidence?.recommendations?.[0],topGroup=(evidence?.recommendations||[]).filter(item=>item.statisticalTie&&item.simulation?.displayTitleTenths===evidenceTop?.simulation?.displayTitleTenths).map(item=>String(item.player.id)),topDefensible=!evidenceIds.length||evidenceIds[0]===finalIds[0]||topGroup.includes(finalIds[0]),qualityPass=result.simulationStatus==="refined"&&Number(result.iterations)>=TARGET_ITERATIONS&&finalIds.length>0&&topDefensible&&overlap>=.875;
    samples.push({name:entry.name,quickOddsMilliseconds,milliseconds,httpStatus:result.httpStatus,terminalStatus:result.simulationStatus||"error",error:result.error||null,iterations:result.iterations,workerCount:result.workerCount,evidenceMilliseconds:evidence?.refinementMs??null,topDefensible,topSetOverlap:Number(overlap.toFixed(3)),qualityPass});
    console.log(`sample ${sampleIndex+1}/${SAMPLE_COUNT}: ${entry.name} · ${(milliseconds/1000).toFixed(1)}s · ${result.iterations||0} sims · ${qualityPass?"pass":`FAIL (${result.httpStatus}: ${result.error||result.simulationStatus||"unknown"})`}`);
  }
  const times=samples.map(sample=>sample.milliseconds),quickTimes=samples.map(sample=>sample.quickOddsMilliseconds),p50=percentile(times,.5),p95=percentile(times,.95),p100=Math.max(...times),quickP100=Math.max(...quickTimes),acceptance={p100TargetMs:P100_TARGET_MS,quickOddsVisibleUnder30Seconds:quickP100<=P100_TARGET_MS,refinedOddsRenderedUnder30Seconds:p100<=P100_TARGET_MS,predictionsPass:samples.every(sample=>sample.qualityPass)};
  const report={generatedAt:new Date().toISOString(),configuration:{quickIterations:QUICK_ITERATIONS,targetIterations:TARGET_ITERATIONS,recommendationLimit:RECOMMENDATION_LIMIT,guiPollIntervalMs:GUI_POLL_INTERVAL_MS},hardware:{logicalCpus:os.availableParallelism?.()||os.cpus().length,totalMemoryGb:Number((os.totalmem()/1073741824).toFixed(1))},sampleCount:samples.length,quickOddsP100Ms:quickP100,p50Ms:p50,p95Ms:p95,p100Ms:p100,minMs:Math.min(...times),maxMs:p100,acceptance,pass:Object.values(acceptance).filter(value=>typeof value==="boolean").every(Boolean),samples},serialized=JSON.stringify(report,null,2);if(process.env.DC_REPORT_PATH)fs.writeFileSync(process.env.DC_REPORT_PATH,serialized);console.log(serialized);
  server.close(()=>{if(!acceptance.quickOddsVisibleUnder30Seconds||!acceptance.refinedOddsRenderedUnder30Seconds||!acceptance.predictionsPass)process.exitCode=1});
});
