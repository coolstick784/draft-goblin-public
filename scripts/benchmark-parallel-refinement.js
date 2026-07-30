import { performance } from "node:perf_hooks";
import { server } from "../server/index.js";
import { fixtureState } from "../test/fixture.js";
import { state as savedSleeperState } from "./audit-live-sleeper.js";

const MEMORY_GROWTH_BUDGET_MB=512;
const mb=bytes=>Number((bytes/1048576).toFixed(1));

server.listen(0,async()=>{
  const base=`http://127.0.0.1:${server.address().port}`;
  const useSavedSleeper=process.env.DC_BENCH_SAVED_SLEEPER==="1",state=useSavedSleeper?{...savedSleeperState,draftId:`${savedSleeperState.draftId}-parallel-benchmark`,picks:savedSleeperState.picks.slice(0,90)}:fixtureState({teams:10,rounds:15,picked:60}),userSlot=useSavedSleeper?(savedSleeperState.userSlot||10):5,limit=Math.max(1,Number(process.env.DC_BENCH_LIMIT)||5),body=JSON.stringify({state,userSlot,iterations:120,refineIterations:10000,limit});
  const start=performance.now(),baselineRss=process.memoryUsage().rss;
  let peakRss=baselineRss;
  const sampler=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss)},25);
  const request=()=>fetch(`${base}/v1/evaluate`,{method:"POST",headers:{"content-type":"application/json","x-installation-id":"bench-10k"},body}).then(response=>response.json());
  let result=await request(),evidence=null,lastProgress=0;
  while(result.simulationStatus!=="refined"&&performance.now()-start<90000){
    await new Promise(resolve=>setTimeout(resolve,500));
    result=await request();
    if(!evidence&&result.simulationStatus==="evidence_ready")evidence=result;
    if(process.env.DC_BENCH_PROGRESS==="1"&&performance.now()-lastProgress>5000){lastProgress=performance.now();console.log(`benchmark progress: ${result.simulationStatus} · ${result.iterations} simulations`)}
  }
  const elapsed=performance.now()-start,cacheStart=performance.now();
  await request();
  clearInterval(sampler);
  peakRss=Math.max(peakRss,process.memoryUsage().rss);
  const evidenceRecs=(evidence?.recommendations||[]).slice(0,8),evidenceIds=evidenceRecs.map(item=>String(item.player.id)),finalIds=(result.recommendations||[]).slice(0,8).map(item=>String(item.player.id)),finalSet=new Set(finalIds),topSetOverlap=evidenceIds.length?evidenceIds.filter(id=>finalSet.has(id)).length/evidenceIds.length:1,topChoiceStable=!evidenceIds.length||evidenceIds[0]===finalIds[0],evidenceTop=evidenceRecs[0],evidenceTopGroup=evidenceRecs.filter(item=>item.statisticalTie&&item.simulation?.displayTitleTenths===evidenceTop?.simulation?.displayTitleTenths).map(item=>String(item.player.id)),topChoiceDefensible=topChoiceStable||evidenceTopGroup.includes(finalIds[0]),quality={evidenceCaptured:Boolean(evidence),evidenceMilliseconds:evidence?Math.round(Number(evidence.refinementMs||0)):null,topChoiceStable,topChoiceDefensible,evidenceTopGroup,topSetOverlap:Number(topSetOverlap.toFixed(3)),pass:topChoiceDefensible&&topSetOverlap>=.875},cacheMilliseconds=Number((performance.now()-cacheStart).toFixed(1)),memory={baselineRssMb:mb(baselineRss),peakRssMb:mb(peakRss),steadyRssMb:mb(process.memoryUsage().rss),growthMb:mb(peakRss-baselineRss),growthBudgetMb:MEMORY_GROWTH_BUDGET_MB,pass:mb(peakRss-baselineRss)<=MEMORY_GROWTH_BUDGET_MB},latencyPass=elapsed<=45000&&cacheMilliseconds<=100;
  console.log(JSON.stringify({status:result.simulationStatus,iterations:result.iterations,milliseconds:Math.round(elapsed),cacheMilliseconds,cards:result.recommendations?.length,workerCount:result.workerCount,latencyPass,quality,memory},null,2));
  server.close(()=>{if(result.simulationStatus!=="refined"||!latencyPass||!quality.pass||!memory.pass)process.exitCode=1});
});
