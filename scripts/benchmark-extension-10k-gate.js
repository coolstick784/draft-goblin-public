import{spawn}from"node:child_process";
import os from"node:os";
import{performance}from"node:perf_hooks";
import{Worker as NodeWorker}from"node:worker_threads";
import{fileURLToPath,pathToFileURL}from"node:url";
import{fixtureState}from"../test/fixture.js";
import{snakeSlot}from"../shared/domain.js";

// Reserve three seconds for draft detection and enrichment outside the engine.
const E2E_TARGET_MS=25_000,BROWSER_BUDGET_MS=3_000,TARGET_MS=E2E_TARGET_MS-BROWSER_BUDGET_MS,CANDIDATES=8,REPEATS_PER_CASE=2,MEMORY_GROWTH_BUDGET_MB=600,CASES=Object.freeze([{name:"12-team live-catalog early",picked:12,catalogPlayers:520},{name:"12-team observed pick 60",picked:59},{name:"12-team middle",picked:84},{name:"12-team late",picked:156}]);
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]};
const mb=bytes=>Number((bytes/1048576).toFixed(1));

class BrowserWorkerAdapter{
  static active=0;
  constructor(){BrowserWorkerAdapter.active++;this.worker=new NodeWorker(new URL("./extension-engine-node-worker.js",import.meta.url));this.worker.on("message",data=>this.onmessage?.({data}));this.worker.on("error",error=>this.onerror?.({message:error.message,error}));this.worker.once("exit",()=>BrowserWorkerAdapter.active--)}
  postMessage(value){this.worker.postMessage(value)}
  terminate(){return this.worker.terminate()}
}

const waitForWorkerCleanup=async(timeoutMs=5000)=>{const deadline=performance.now()+timeoutMs;while(BrowserWorkerAdapter.active&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));return BrowserWorkerAdapter.active};

export async function runColdExtensionCase(testIndex){
  const testCase=CASES[testIndex];if(!testCase)throw new Error(`Unknown extension benchmark case ${testIndex}`);
  const baselineRss=process.memoryUsage().rss;let peakRss=baselineRss;
  const memoryMonitor=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss)},25);
  globalThis.Worker=BrowserWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};
  const{localApi,shutdownLocalEngineWorkers}=await import("../extension/local-engine-client.js");
  const state=fixtureState({teams:12,rounds:16,picked:testCase.picked});
  for(let index=state.players.length;index<Number(testCase.catalogPlayers||state.players.length);index++){const position=["RB","WR","QB","TE","K","DST"][index%6],mean=Math.max(60,210-index*.2);state.players.push({id:`live-catalog-${index}`,name:`Live catalog ${index}`,position,team:`L${index%32}`,mean,floor:mean*.7,ceiling:mean*1.3,risk:.4,scarcity:.4,adp:index+1,adpSd:12,eligibleForRecommendation:true})}
  state.draftId=`extension-cold-10k-${Date.now()}-${testIndex}`;state.draftRunId=`cold-${Date.now()}-${testIndex}`;state.updatedAt=Date.now();
  let result,elapsedMs;
  try{const started=performance.now();result=await localApi("/v1/evaluate",{body:JSON.stringify({state,userSlot:snakeSlot(testCase.picked+1,12),strategy:"titleOnly",sourceProfile:"projectionLed",iterations:120,refineIterations:10_000,limit:CANDIDATES,seed:68001+testIndex})});elapsedMs=performance.now()-started}
  finally{clearInterval(memoryMonitor);shutdownLocalEngineWorkers();await waitForWorkerCleanup()}
  peakRss=Math.max(peakRss,process.memoryUsage().rss);
  const legalShortlist=Array.isArray(result?.recommendations)&&result.recommendations.length>0&&result.recommendations.length<=CANDIDATES,exact=result?.status==="complete"&&result.simulationStatus==="refined"&&result.iterations===10_000&&legalShortlist&&result.recommendations.every(item=>item.simulation.iterations===10_000&&item.teamSimulation.iterations===10_000),memoryGrowthMb=mb(peakRss-baselineRss),cleanupPass=BrowserWorkerAdapter.active===0;
  return{name:testCase.name,picked:testCase.picked,engineElapsedMs:Number(elapsedMs.toFixed(1)),workerCount:result?.workerCount,candidates:result?.recommendations?.length||0,exact,memory:{baselineRssMb:mb(baselineRss),peakRssMb:mb(peakRss),growthMb:memoryGrowthMb,pass:memoryGrowthMb<=MEMORY_GROWTH_BUDGET_MB},cleanup:{activeWorkers:BrowserWorkerAdapter.active,pass:cleanupPass}};
}

const runIsolatedCase=testIndex=>new Promise((resolve,reject)=>{const started=performance.now(),child=spawn(process.execPath,[fileURLToPath(import.meta.url),"--cold-case",String(testIndex)],{stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",value=>stdout+=value);child.stderr.on("data",value=>stderr+=value);child.on("error",reject);child.on("exit",code=>{const coldStartMs=performance.now()-started;if(code!==0)return reject(new Error(`Cold extension case ${testIndex} failed (${code}): ${stderr||stdout}`));try{resolve({...JSON.parse(stdout),coldStartMs:Number(coldStartMs.toFixed(1))})}catch(error){reject(new Error(`Cold extension case ${testIndex} emitted invalid JSON: ${error.message}\n${stdout}\n${stderr}`))}})});

export async function runExtensionGate(){
  const rows=[];for(let testIndex=0;testIndex<CASES.length;testIndex++)for(let repetition=1;repetition<=REPEATS_PER_CASE;repetition++){const row=await runIsolatedCase(testIndex),pass=row.exact&&row.coldStartMs<=TARGET_MS&&row.memory.pass&&row.cleanup.pass;rows.push({...row,repetition,estimatedE2eMs:Number((row.coldStartMs+BROWSER_BUDGET_MS).toFixed(1)),pass})}
  const times=rows.map(row=>row.coldStartMs),memoryGrowthMb=Math.max(...rows.map(row=>row.memory.growthMb));
  const p50Ms=percentile(times,.5),p95Ms=percentile(times,.95),p100Ms=Math.max(...times);
  return{configuration:{engineTargetMs:TARGET_MS,endToEndTargetMs:E2E_TARGET_MS,browserBudgetMs:BROWSER_BUDGET_MS,iterations:10_000,candidates:CANDIDATES,states:CASES.length,repeatsPerState:REPEATS_PER_CASE,cases:rows.length,coldStartIsolation:"fresh Node process and fresh extension worker pool per case",measuredBoundary:"process launch through exact response and worker cleanup, plus the reserved browser budget for end-to-end reporting",memoryGrowthBudgetMb:MEMORY_GROWTH_BUDGET_MB},hardware:{logicalCpus:os.availableParallelism?.()||os.cpus().length},p50Ms,p95Ms,p100Ms,endToEnd:{p50Ms:Number((p50Ms+BROWSER_BUDGET_MS).toFixed(1)),p95Ms:Number((p95Ms+BROWSER_BUDGET_MS).toFixed(1)),p100Ms:Number((p100Ms+BROWSER_BUDGET_MS).toFixed(1)),targetMs:E2E_TARGET_MS,pass:p100Ms+BROWSER_BUDGET_MS<=E2E_TARGET_MS},memory:{maxCaseGrowthMb:memoryGrowthMb,pass:rows.every(row=>row.memory.pass)},cleanup:{allCasesPassed:rows.every(row=>row.cleanup.pass),pass:rows.every(row=>row.cleanup.pass)},rows,pass:rows.every(row=>row.pass)&&p100Ms+BROWSER_BUDGET_MS<=E2E_TARGET_MS};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(process.argv[2]==="--cold-case"){const row=await runColdExtensionCase(Number(process.argv[3]));process.stdout.write(JSON.stringify(row));if(!row.exact||!row.memory.pass||!row.cleanup.pass)process.exitCode=1}else{const report=await runExtensionGate();console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1}}
