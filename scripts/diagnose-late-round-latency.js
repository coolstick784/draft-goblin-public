import {fixtureState} from "../test/fixture.js";

const BASE=process.env.DC_BASE_URL||"http://localhost:8787";
const SAMPLES=Math.max(1,Number(process.env.DC_DIAGNOSTIC_SAMPLES)||1);
const POLL_MS=Math.max(50,Number(process.env.DC_DIAGNOSTIC_POLL_MS)||500);
const TERMINAL_LIMIT_MS=Math.min(25000,Math.max(1000,Number(process.env.DC_DIAGNOSTIC_LIMIT_MS)||25000));
const CLIENT_BUILD_ID="eval-jobs-v6-strict10k-20260714";
const terminalStatuses=new Set(["complete","deadline_fallback","worker_fallback","cancelled"]);
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const percentile=(values,fraction)=>values.length?values[Math.min(values.length-1,Math.ceil(values.length*fraction)-1)]:null;

function lateRoundState({id,picked=160}){
  const state=fixtureState({teams:12,rounds:16,picked});
  state.platform="espn";
  state.draftId=id;
  state.draftRunId=`${id}-run`;
  state.updatedAt=Date.now();
  return state;
}

function requestBody(state,seed){
  return {state,userSlot:8,strategy:"balanced",iterations:120,refineIterations:10000,limit:3,seed,clientBuildId:CLIENT_BUILD_ID};
}

async function begin(body,installationId){
  const response=await fetch(`${BASE}/v1/evaluate`,{method:"POST",headers:{"content-type":"application/json","x-installation-id":installationId},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw new Error(`POST /v1/evaluate returned ${response.status}: ${result.error||JSON.stringify(result)}`);
  if(!result.evaluationId)throw new Error("evaluation did not return an evaluationId");
  return result;
}

async function pollExact(initial,started=Date.now(),installationId="diagnostic"){
  const evaluationId=initial.evaluationId;
  let result=initial,polls=0,rateLimitedResponses=0,lastStatus=String(result.status||"");
  const httpStatuses={200:1};
  const transitions=[{atMs:Date.now()-started,status:lastStatus,iterations:Number(result.iterations||0)}];
  while(!terminalStatuses.has(String(result.status||""))&&Date.now()-started<TERMINAL_LIMIT_MS){
    await wait(Math.min(POLL_MS,Math.max(1,TERMINAL_LIMIT_MS-(Date.now()-started))));
    const response=await fetch(`${BASE}/v1/evaluate/${encodeURIComponent(evaluationId)}`,{headers:{"x-installation-id":installationId}});
    const next=await response.json();polls++;httpStatuses[response.status]=(httpStatuses[response.status]||0)+1;
    if(response.status===429){rateLimitedResponses++;continue}
    result=next;
    if(!response.ok)throw new Error(`GET evaluation ${evaluationId} returned ${response.status}: ${result.error||JSON.stringify(result)}`);
    if(result.evaluationId!==evaluationId)throw new Error(`exact polling changed evaluation ID from ${evaluationId} to ${result.evaluationId}`);
    const status=String(result.status||"");
    if(status!==lastStatus){lastStatus=status;transitions.push({atMs:Date.now()-started,status,iterations:Number(result.iterations||0)})}
  }
  const totalMs=Date.now()-started,status=String(result.status||"");
  if(!terminalStatuses.has(status))throw new Error(`${evaluationId} remained ${status||"unknown"} after ${totalMs}ms`);
  if(totalMs>TERMINAL_LIMIT_MS+POLL_MS)throw new Error(`${evaluationId} became terminal too late (${totalMs}ms)`);
  if(status==="complete"){
    if(Number(result.iterations)!==10000)throw new Error(`${evaluationId} claimed complete with ${result.iterations} iterations`);
    if(!result.recommendations?.every(item=>Number(item.simulation?.iterations)===10000))throw new Error(`${evaluationId} contains a non-10,000-simulation card`);
  }else if(String(result.refinementOutcome||"")!==status){
    throw new Error(`${evaluationId} fallback ${status} is not explicitly labeled (outcome=${result.refinementOutcome})`);
  }
  return {evaluationId,status,refinementOutcome:String(result.refinementOutcome||""),iterations:Number(result.iterations||0),targetIterations:Number(result.targetIterations||0),totalMs,polls,rateLimitedResponses,httpStatuses,transitions,refinementMs:Number(result.refinementMs||0),workerCount:Number(result.workerCount||0),error:result.refinementError||null};
}

async function runLateRound(sample){
  const id=`late-pick-161-${Date.now()}-${sample}`,installationId=`${id}-install`,started=Date.now();
  return {scenario:"late_round_pick_161",sample,...await pollExact(await begin(requestBody(lateRoundState({id}),9100+sample),installationId),started,installationId)};
}

async function runRapidChurn(sample){
  const id=`rapid-churn-${Date.now()}-${sample}`,installationId=`${id}-install`,started=Date.now(),jobs=[];
  for(const picked of [159,160,161]){
    const result=await begin(requestBody(lateRoundState({id,picked}),9200+sample),installationId);
    jobs.push({initial:result,started:Date.now()});
  }
  return {scenario:"rapid_pick_churn",sample,totalStartMs:Date.now()-started,jobs:await Promise.all(jobs.map(job=>pollExact(job.initial,job.started,installationId)))};
}

async function runContention(sample){
  const id=`priority-contention-${Date.now()}-${sample}`,state=lateRoundState({id}),started=Date.now();
  const [standard,priority]=await Promise.all([
    begin(requestBody(state,9300+sample),`${id}-install`),
    begin({...requestBody(state,9400+sample),clockPriority:true},`${id}-install`)
  ]);
  if(standard.evaluationId===priority.evaluationId)throw new Error("Standard and priority requests reused one evaluation ID");
  const [standardResult,priorityResult]=await Promise.all([pollExact(standard,started,`${id}-install`),pollExact(priority,started,`${id}-install`)]);
  return {scenario:"priority_contention",sample,jobs:[standardResult,priorityResult]};
}

const results=[];
for(let sample=1;sample<=SAMPLES;sample++){
  results.push(await runLateRound(sample));
  results.push(await runRapidChurn(sample));
  results.push(await runContention(sample));
}
const jobs=results.flatMap(result=>result.jobs||[result]),latencies=jobs.map(result=>result.totalMs).sort((a,b)=>a-b),statuses=Object.fromEntries([...new Set(jobs.map(result=>result.status))].map(status=>[status,jobs.filter(result=>result.status===status).length]));
console.log(JSON.stringify({base:BASE,terminalLimitMs:TERMINAL_LIMIT_MS,pollMs:POLL_MS,samples:SAMPLES,summary:{jobs:jobs.length,statuses,p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95),observedP100Ms:percentile(latencies,1),rateLimitedResponses:jobs.reduce((sum,result)=>sum+result.rateLimitedResponses,0),allTerminal:jobs.every(result=>terminalStatuses.has(result.status)),allSuccessfulRunsExactly10000:jobs.filter(result=>result.status==="complete").every(result=>result.iterations===10000),allFallbacksExplicit:jobs.filter(result=>result.status!=="complete").every(result=>result.status===result.refinementOutcome)},results},null,2));
