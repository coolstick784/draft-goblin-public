import test from"node:test";
import assert from"node:assert/strict";
import{Worker as NodeWorker}from"node:worker_threads";
import{fixtureState}from"./fixture.js";
import{snakeSlot}from"../shared/domain.js";
import{runEngineRequest}from"../extension/engine-runtime.js";

class BrowserWorkerAdapter{
  static active=0;
  constructor(){BrowserWorkerAdapter.active++;this.worker=new NodeWorker(new URL("../scripts/extension-engine-node-worker.js",import.meta.url));this.worker.on("message",data=>this.onmessage?.({data}));this.worker.on("error",error=>this.onerror?.({message:error.message,error}));this.worker.once("exit",()=>BrowserWorkerAdapter.active--)}
  postMessage(value){this.worker.postMessage(value)}
  terminate(){return this.worker.terminate()}
}

class OneFailureWorkerAdapter extends BrowserWorkerAdapter{
  static failed=false;
  postMessage(value){if(value?.type==="evaluate-chunk"&&!OneFailureWorkerAdapter.failed){OneFailureWorkerAdapter.failed=true;queueMicrotask(()=>{this.onerror?.({message:"simulated worker eviction"});this.worker.terminate()});return}super.postMessage(value)}
}
class BurstFailureWorkerAdapter extends BrowserWorkerAdapter{
  static remaining=0;
  postMessage(value){if(value?.type==="evaluate-chunk"&&BurstFailureWorkerAdapter.remaining>0){BurstFailureWorkerAdapter.remaining--;queueMicrotask(()=>{this.onerror?.({message:"simulated burst eviction"});this.worker.terminate()});return}super.postMessage(value)}
}
class SilentShardWorkerAdapter extends BrowserWorkerAdapter{
  static stalled=false;static attempts=new Map();
  postMessage(value){if(value?.type==="evaluate-chunk"){const shard=Number(value.payload?.shardId);SilentShardWorkerAdapter.attempts.set(shard,(SilentShardWorkerAdapter.attempts.get(shard)||0)+1);if(shard===1&&!SilentShardWorkerAdapter.stalled){SilentShardWorkerAdapter.stalled=true;return}}super.postMessage(value)}
}
class PartiallyStalledShardWorkerAdapter extends BrowserWorkerAdapter{
  static stalled=false;static attempts=new Map();
  postMessage(value){if(value?.type==="evaluate-chunk"){const shard=Number(value.payload?.shardId);PartiallyStalledShardWorkerAdapter.attempts.set(shard,(PartiallyStalledShardWorkerAdapter.attempts.get(shard)||0)+1);if(shard===1&&!PartiallyStalledShardWorkerAdapter.stalled){PartiallyStalledShardWorkerAdapter.stalled=true;queueMicrotask(()=>this.onmessage?.({data:{id:value.id,kind:"progress",shardId:shard,completed:Math.min(8,Number(value.payload?.iterations)||0),total:Number(value.payload?.iterations)||0}}));return}}super.postMessage(value)}
}
class PermanentlySilentShardWorkerAdapter extends BrowserWorkerAdapter{
  static attempts=new Map();
  postMessage(value){if(value?.type==="evaluate-chunk"){const shard=Number(value.payload?.shardId);PermanentlySilentShardWorkerAdapter.attempts.set(shard,(PermanentlySilentShardWorkerAdapter.attempts.get(shard)||0)+1);if(shard===1)return}super.postMessage(value)}
}
class WarmupTrackingWorkerAdapter extends BrowserWorkerAdapter{
  static activeHealth=0;static maxActiveHealth=0;
  postMessage(value){if(value?.type==="health"){WarmupTrackingWorkerAdapter.activeHealth++;WarmupTrackingWorkerAdapter.maxActiveHealth=Math.max(WarmupTrackingWorkerAdapter.maxActiveHealth,WarmupTrackingWorkerAdapter.activeHealth);const listener=this.onmessage;this.onmessage=event=>{WarmupTrackingWorkerAdapter.activeHealth--;listener?.(event)}}super.postMessage(value)}
}
class SilentWarmupWorkerAdapter extends BrowserWorkerAdapter{
  postMessage(value){if(value?.type==="health")return;super.postMessage(value)}
}
const waitForWorkerCleanup=async(timeoutMs=5000)=>{const deadline=Date.now()+timeoutMs;while(BrowserWorkerAdapter.active&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));return BrowserWorkerAdapter.active};

test("the bounded exact-simulation pool warms concurrently inside the cold-start budget",async()=>{
  globalThis.Worker=WarmupTrackingWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};const{warmLocalEngineWorkers,shutdownLocalEngineWorkers}=await import("../extension/local-engine-client.js");shutdownLocalEngineWorkers();await waitForWorkerCleanup();WarmupTrackingWorkerAdapter.activeHealth=0;WarmupTrackingWorkerAdapter.maxActiveHealth=0;await warmLocalEngineWorkers();const expectedWorkers=Math.min(6,15,Math.max(1,(Number(globalThis.navigator?.hardwareConcurrency)||4)-1));assert.equal(WarmupTrackingWorkerAdapter.maxActiveHealth,expectedWorkers);shutdownLocalEngineWorkers();await waitForWorkerCleanup()
});

test("low-core devices only warm workers the exact simulation can use",async()=>{
  globalThis.Worker=BrowserWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};const{localApi,warmLocalEngineWorkers,shutdownLocalEngineWorkers}=await import("../extension/local-engine-client.js"),hadOwn=Object.hasOwn(globalThis.navigator,"hardwareConcurrency"),prior=globalThis.navigator.hardwareConcurrency;shutdownLocalEngineWorkers();await waitForWorkerCleanup();try{Object.defineProperty(globalThis.navigator,"hardwareConcurrency",{value:4,configurable:true});await warmLocalEngineWorkers();assert.equal(BrowserWorkerAdapter.active,3);const state=fixtureState({teams:12,rounds:16,picked:84}),result=await localApi("/v1/evaluate",{body:JSON.stringify({state,userSlot:snakeSlot(85,12),strategy:"titleOnly",iterations:31,refineIterations:31,limit:3,seed:7001})});assert.equal(result.workerCount,3);assert.equal(result.iterations,31);assert.ok(result.recommendations.every(item=>item.simulation.iterations===31))}finally{shutdownLocalEngineWorkers();await waitForWorkerCleanup();if(hadOwn)Object.defineProperty(globalThis.navigator,"hardwareConcurrency",{value:prior,configurable:true});else delete globalThis.navigator.hardwareConcurrency}
});

test("an idle persistent pool releases every simulation worker between drafts",async()=>{
  globalThis.Worker=BrowserWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};const{scheduleLocalEngineWorkerShutdown,shutdownLocalEngineWorkers,warmLocalEngineWorkers}=await import("../extension/local-engine-client.js");shutdownLocalEngineWorkers();await waitForWorkerCleanup();await warmLocalEngineWorkers();const expected=Math.min(15,Math.max(1,(Number(globalThis.navigator?.hardwareConcurrency)||4)-1));assert.equal(BrowserWorkerAdapter.active,expected);scheduleLocalEngineWorkerShutdown(10);await new Promise(resolve=>setTimeout(resolve,30));await waitForWorkerCleanup();assert.equal(BrowserWorkerAdapter.active,0)
});

test("isolated parallel extension workers are bit-exact with the in-process engine",async()=>{
  globalThis.Worker=BrowserWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};
  const{localApi,shutdownLocalEngineWorkers}=await import("../extension/local-engine-client.js");
  const picked=84,seed=7102,state=fixtureState({teams:12,rounds:16,picked});state.draftId=`extension-dedicated-exact-${picked}`;state.updatedAt=Date.now();const payload={state,userSlot:snakeSlot(picked+1,12),strategy:"titleOnly",sourceProfile:"projectionLed",iterations:61,refineIterations:61,limit:5,seed},single=await runEngineRequest("evaluate",payload),dedicated=await localApi("/v1/evaluate",{body:JSON.stringify(payload)});
  const expectedWorkers=Math.min(15,Math.max(1,Number(globalThis.navigator?.hardwareConcurrency)||4)-1,61);assert.equal(dedicated.workerCount,expectedWorkers);assert.equal(dedicated.iterations,61);assert.deepEqual(dedicated.recommendations,single.recommendations);shutdownLocalEngineWorkers();await waitForWorkerCleanup()
});

test("overlapping board evaluations are serialized per worker without callback loss",async()=>{
  globalThis.Worker=BrowserWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};const{localApi,shutdownLocalEngineWorkers}=await import("../extension/local-engine-client.js");shutdownLocalEngineWorkers();await waitForWorkerCleanup();const firstState=fixtureState({teams:12,rounds:16,picked:84}),secondState=fixtureState({teams:12,rounds:16,picked:85}),first={state:firstState,userSlot:snakeSlot(85,12),strategy:"titleOnly",iterations:61,refineIterations:61,limit:5,seed:7201},second={state:secondState,userSlot:snakeSlot(86,12),strategy:"titleOnly",iterations:61,refineIterations:61,limit:5,seed:7202},[expectedFirst,expectedSecond]=await Promise.all([runEngineRequest("evaluate",first),runEngineRequest("evaluate",second)]),[actualFirst,actualSecond]=await Promise.all([localApi("/v1/evaluate",{body:JSON.stringify(first)}),localApi("/v1/evaluate",{body:JSON.stringify(second)})]);assert.deepEqual(actualFirst.recommendations,expectedFirst.recommendations);assert.deepEqual(actualSecond.recommendations,expectedSecond.recommendations);shutdownLocalEngineWorkers();await waitForWorkerCleanup()
});

test("aborting an isolated parallel exact evaluation terminates every worker",async()=>{
  globalThis.Worker=BrowserWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};const{localApi,shutdownLocalEngineWorkers,warmLocalEngineWorkers}=await import("../extension/local-engine-client.js"),state=fixtureState({teams:12,rounds:16,picked:12});state.draftId="extension-dedicated-abort";state.updatedAt=Date.now();const controller=new AbortController(),pending=localApi("/v1/evaluate",{signal:controller.signal,body:JSON.stringify({state,userSlot:12,strategy:"titleOnly",refineIterations:10_000,limit:5,seed:7199})});setTimeout(()=>controller.abort(),10);await assert.rejects(pending,error=>error?.name==="AbortError");const deadline=Date.now()+2000;while(BrowserWorkerAdapter.active&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(BrowserWorkerAdapter.active,0);await warmLocalEngineWorkers();const replacement=await localApi("/v1/evaluate",{body:JSON.stringify({state,userSlot:12,strategy:"titleOnly",refineIterations:61,limit:5,seed:7200})});assert.equal(replacement.status,"complete");assert.equal(replacement.iterations,61);shutdownLocalEngineWorkers();await waitForWorkerCleanup();assert.equal(BrowserWorkerAdapter.active,0)
});

test("a silent warmup worker cannot leave the persistent exact engine pending",async()=>{
  globalThis.Worker=SilentWarmupWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};const{warmLocalEngineWorkers,shutdownLocalEngineWorkers}=await import("../extension/local-engine-client.js");shutdownLocalEngineWorkers();await waitForWorkerCleanup();const started=Date.now();await assert.rejects(warmLocalEngineWorkers({inactivityMs:20}),/stopped reporting progress/);assert.ok(Date.now()-started<500);shutdownLocalEngineWorkers();await waitForWorkerCleanup();assert.equal(BrowserWorkerAdapter.active,0)
});

test("exact worker progress is monotonic and reaches the complete scenario count",async()=>{
  globalThis.Worker=BrowserWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};const{localApi,shutdownLocalEngineWorkers}=await import("../extension/local-engine-client.js");shutdownLocalEngineWorkers();await waitForWorkerCleanup();const state=fixtureState({teams:12,rounds:16,picked:84}),updates=[],payload={state,userSlot:snakeSlot(85,12),strategy:"titleOnly",iterations:257,refineIterations:257,limit:5,seed:7301};const result=await localApi("/v1/evaluate",{body:JSON.stringify(payload),contextKey:"progress-context",onProgress:update=>updates.push(update)});assert.ok(updates.length>4);assert.ok(updates.every((update,index)=>update.contextKey==="progress-context"&&update.total===257&&(index===0||update.completed>=updates[index-1].completed)));assert.equal(updates.at(-1).completed,257);assert.equal(updates.at(-1).completedShards.length,result.workerCount);shutdownLocalEngineWorkers();await waitForWorkerCleanup()
});

test("one silent exact shard is retried without recalculating completed shards",async()=>{
  globalThis.Worker=SilentShardWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};SilentShardWorkerAdapter.stalled=false;SilentShardWorkerAdapter.attempts=new Map();const{localApi,shutdownLocalEngineWorkers}=await import("../extension/local-engine-client.js");shutdownLocalEngineWorkers();await waitForWorkerCleanup();const state=fixtureState({teams:12,rounds:16,picked:84}),payload={state,userSlot:snakeSlot(85,12),strategy:"titleOnly",iterations:61,refineIterations:61,limit:5,seed:7302},single=await runEngineRequest("evaluate",payload),actual=await localApi("/v1/evaluate",{body:JSON.stringify(payload),inactivityMs:750}),stalledAttempts=SilentShardWorkerAdapter.attempts.get(1);assert.deepEqual(actual.recommendations,single.recommendations);assert.ok(stalledAttempts>=2&&stalledAttempts<=3);for(const[index,count]of SilentShardWorkerAdapter.attempts)if(index!==1)assert.equal(count,1);shutdownLocalEngineWorkers();await waitForWorkerCleanup()
});

test("a partially progressed tail shard is retried early enough to finish inside the engine budget",async()=>{
  globalThis.Worker=PartiallyStalledShardWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};PartiallyStalledShardWorkerAdapter.stalled=false;PartiallyStalledShardWorkerAdapter.attempts=new Map();const{localApi,shutdownLocalEngineWorkers}=await import("../extension/local-engine-client.js");shutdownLocalEngineWorkers();await waitForWorkerCleanup();const state=fixtureState({teams:12,rounds:16,picked:5}),payload={state,userSlot:6,strategy:"titleOnly",iterations:61,refineIterations:61,limit:8,seed:7305},single=await runEngineRequest("evaluate",payload),started=Date.now(),actual=await localApi("/v1/evaluate",{body:JSON.stringify(payload),deadlineMs:3500});assert.deepEqual(actual.recommendations,single.recommendations);assert.equal(PartiallyStalledShardWorkerAdapter.attempts.get(1),2);assert.ok(Date.now()-started<3500);for(const[index,count]of PartiallyStalledShardWorkerAdapter.attempts)if(index!==1)assert.equal(count,1);shutdownLocalEngineWorkers();await waitForWorkerCleanup()
});

test("a permanently silent exact shard fails after bounded retries",async()=>{
  globalThis.Worker=PermanentlySilentShardWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};PermanentlySilentShardWorkerAdapter.attempts=new Map();const{localApi,shutdownLocalEngineWorkers}=await import("../extension/local-engine-client.js");shutdownLocalEngineWorkers();await waitForWorkerCleanup();const state=fixtureState({teams:12,rounds:16,picked:84}),payload={state,userSlot:snakeSlot(85,12),strategy:"titleOnly",iterations:61,refineIterations:61,limit:5,seed:7303};await assert.rejects(localApi("/v1/evaluate",{body:JSON.stringify(payload),inactivityMs:750}),error=>error?.code==="EXACT_ODDS_FAILED");assert.equal(PermanentlySilentShardWorkerAdapter.attempts.get(1),3);for(const[index,count]of PermanentlySilentShardWorkerAdapter.attempts)if(index!==1)assert.equal(count,1);shutdownLocalEngineWorkers();await waitForWorkerCleanup()
});

test("the engine-wide exact deadline preempts shard retry budgets",async()=>{
  globalThis.Worker=PermanentlySilentShardWorkerAdapter;globalThis.chrome={runtime:{getURL:value=>value}};PermanentlySilentShardWorkerAdapter.attempts=new Map();const{localApi,shutdownLocalEngineWorkers}=await import("../extension/local-engine-client.js");shutdownLocalEngineWorkers();await waitForWorkerCleanup();const state=fixtureState({teams:12,rounds:16,picked:84}),payload={state,userSlot:snakeSlot(85,12),strategy:"titleOnly",iterations:61,refineIterations:61,limit:5,seed:7304},started=Date.now();await assert.rejects(localApi("/v1/evaluate",{body:JSON.stringify(payload),inactivityMs:1000,deadlineMs:40}),error=>error?.code==="EXACT_ODDS_DEADLINE");assert.ok(Date.now()-started<500);shutdownLocalEngineWorkers();await waitForWorkerCleanup();assert.equal(BrowserWorkerAdapter.active,0)
});

test("aborting a persistent evaluation forwards the same request identity to the offscreen broker",async()=>{
  const messages=[];let finishRun;
  globalThis.chrome={runtime:{getURL:value=>value,sendMessage(message){messages.push(message);if(message.type==="RUN_PERSISTENT_EVALUATION")return new Promise(resolve=>{finishRun=resolve});return Promise.resolve({ok:true,cancelled:true})}}};
  const{persistentLocalApi}=await import("../extension/local-engine-client.js"),controller=new AbortController(),pending=persistentLocalApi("/v1/evaluate",{signal:controller.signal,body:"{}"});
  await new Promise(resolve=>setImmediate(resolve));controller.abort();
  await assert.rejects(pending,error=>error?.name==="AbortError");
  const run=messages.find(message=>message.type==="RUN_PERSISTENT_EVALUATION"),cancel=messages.find(message=>message.type==="CANCEL_PERSISTENT_EVALUATION");
  assert.ok(run?.requestId);
  assert.equal(cancel?.requestId,run.requestId);
  finishRun({ok:false,error:"cancelled"});
});

test("the persistent broker makes a stalled exact request terminal before its budget",async()=>{
  const messages=[];let finishRun;globalThis.chrome={runtime:{getURL:value=>value,sendMessage(message){messages.push(message);if(message.type==="RUN_PERSISTENT_EVALUATION")return new Promise(resolve=>{finishRun=resolve});return Promise.resolve({ok:true,cancelled:true})}}};const{persistentLocalApi}=await import("../extension/local-engine-client.js"),started=Date.now(),pending=persistentLocalApi("/v1/evaluate",{body:"{}",deadlineMs:25});await assert.rejects(pending,error=>error?.code==="EXACT_ODDS_DEADLINE");assert.ok(Date.now()-started<500);const run=messages.find(message=>message.type==="RUN_PERSISTENT_EVALUATION"),cancel=messages.find(message=>message.type==="CANCEL_PERSISTENT_EVALUATION");assert.equal(cancel.requestId,run.requestId);finishRun({ok:false,error:"cancelled"})
});

test("the persistent broker has no default wall-clock deadline",async()=>{
  const messages=[];let finishRun;globalThis.chrome={runtime:{getURL:value=>value,sendMessage(message){messages.push(message);if(message.type==="RUN_PERSISTENT_EVALUATION")return new Promise(resolve=>{finishRun=resolve});return Promise.resolve({ok:true,cancelled:true})}}};
  const{persistentLocalApi}=await import("../extension/local-engine-client.js"),controller=new AbortController(),pending=persistentLocalApi("/v1/evaluate",{body:"{}",signal:controller.signal});
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(messages.some(message=>message.type==="CANCEL_PERSISTENT_EVALUATION"),false);
  controller.abort();
  await assert.rejects(pending,error=>error?.name==="AbortError");
  const run=messages.find(message=>message.type==="RUN_PERSISTENT_EVALUATION"),cancel=messages.find(message=>message.type==="CANCEL_PERSISTENT_EVALUATION");assert.equal(cancel.requestId,run.requestId);finishRun({ok:false,error:"cancelled"})
});

test("persistent bundled evaluations relay exact progress to the requesting panel",async()=>{
  const listeners=new Set(),updates=[];globalThis.chrome={runtime:{getURL:value=>value,onMessage:{addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener)},sendMessage(message){if(message.type==="RUN_PERSISTENT_EVALUATION"){queueMicrotask(()=>{for(const listener of listeners)listener({type:"OFFSCREEN_EVALUATION_PROGRESS",requestId:message.requestId,progress:{completed:625,total:1_000}})});return Promise.resolve({ok:true,data:{status:"complete"}})}return Promise.resolve({ok:true})}}};
  const{persistentLocalApi}=await import("../extension/local-engine-client.js"),result=await persistentLocalApi("/v1/evaluate",{body:"{}",contextKey:"draft-context",onProgress:update=>updates.push(update)});
  assert.equal(result.status,"complete");assert.deepEqual(updates,[{completed:625,total:1_000,contextKey:"draft-context",executionEngine:"bundled-extension-workers"}]);assert.equal(listeners.size,0)
});

test("the persistent broker forwards the already-rendered shortlist in a compact exact request",async()=>{
  const messages=[];globalThis.chrome={runtime:{getURL:value=>value,sendMessage(message){messages.push(message);return Promise.resolve(message.type==="RUN_PERSISTENT_EVALUATION"?{ok:true,data:{status:"complete"}}:{ok:true})}}};
  const{persistentLocalApi}=await import("../extension/local-engine-client.js"),state=fixtureState({teams:12,rounds:16,picked:9}),precomputedRecommendations=(await runEngineRequest("evaluate",{state,userSlot:10,strategy:"titleOnly",iterations:8,refineIterations:8,limit:3,seed:7410})).recommendations;
  for(const player of state.players)player.browserOnlyEnrichment="x".repeat(10_000);
  const rawBody=JSON.stringify({state,userSlot:10,strategy:"titleOnly",refineIterations:10_000,limit:3,seed:7410});
  await persistentLocalApi("/v1/evaluate",{body:rawBody,precomputedRecommendations});
  const run=messages.find(message=>message.type==="RUN_PERSISTENT_EVALUATION"),payload=JSON.parse(run.body);
  assert.equal(payload.precomputedRecommendations.length,3);
  assert.ok(payload.precomputedRecommendations.every(item=>item.simulation===undefined&&item.teamSimulation===undefined));
  assert.ok(payload.state.players.length<=state.players.length);
  assert.ok(payload.state.players.every(player=>player.browserOnlyEnrichment===undefined));
  assert.ok(run.body.length<rawBody.length*.2);
  assert.equal(payload.iterations,10_000)
});

test("the Node accelerator request stays below the 5 MB contract after enriched Chrome state is compacted",async()=>{
  globalThis.chrome={runtime:{getURL:value=>value}};const{buildCompactAccelerationRequest}=await import("../extension/local-engine-client.js"),state=fixtureState({teams:12,rounds:16,picked:84});for(const player of state.players)player.browserOnlyEnrichment="x".repeat(30_000);const payload={state,userSlot:snakeSlot(85,12),strategy:"titleOnly",refineIterations:10_000,limit:8,seed:7401},rawBytes=new TextEncoder().encode(JSON.stringify(payload)).byteLength,request=buildCompactAccelerationRequest(payload),decoded=JSON.parse(request.body);assert.ok(rawBytes>5_000_000);assert.ok(request.bytes<5_000_000);assert.ok(request.bytes<rawBytes*.20);assert.equal(decoded.iterations,10_000);assert.equal(decoded.precomputedRecommendations.length,8);assert.ok(decoded.state.players.length<=state.players.length);assert.ok(decoded.state.players.every(player=>player.browserOnlyEnrichment===undefined));assert.ok(decoded.precomputedRecommendations.every(item=>item.simulation===undefined&&item.teamSimulation===undefined))
});

test("a missing Node accelerator automatically completes exact odds with bundled workers",async()=>{
  const originalFetch=globalThis.fetch,messages=[];globalThis.chrome={runtime:{getURL:value=>value,sendMessage(message){messages.push(message);if(message.type==="RUN_PERSISTENT_EVALUATION")return runEngineRequest("evaluate",JSON.parse(message.body)).then(data=>({ok:true,data}));return Promise.resolve({ok:true})}}};globalThis.fetch=async()=>{throw new TypeError("Failed to fetch")};const{acceleratedLocalApi}=await import("../extension/local-engine-client.js"),state=fixtureState({teams:4,rounds:6,picked:8});state.updatedAt=Date.now();const payload={state,userSlot:2,strategy:"titleOnly",refineIterations:1_000,limit:3,seed:7402};try{const result=await acceleratedLocalApi("/v1/evaluate",{body:JSON.stringify(payload)});assert.equal(result.status,"complete");assert.equal(result.iterations,1_000);assert.equal(result.executionEngine,"bundled-extension-workers");assert.equal(result.acceleratorFallbackReason,"Failed to fetch");assert.ok(result.recommendations.length>0);assert.equal(messages.filter(message=>message.type==="RUN_PERSISTENT_EVALUATION").length,1)}finally{globalThis.fetch=originalFetch}
});

test("a stalled accelerator startup yields promptly to bundled exact workers",async()=>{
  const originalFetch=globalThis.fetch,messages=[];globalThis.chrome={runtime:{getURL:value=>value,sendMessage(message){messages.push(message);if(message.type==="RUN_PERSISTENT_EVALUATION")return runEngineRequest("evaluate",JSON.parse(message.body)).then(data=>({ok:true,data}));return Promise.resolve({ok:true})}}};globalThis.fetch=(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(new Error("accelerator startup timed out"),{name:"AbortError"})),{once:true}));const{acceleratedLocalApi}=await import("../extension/local-engine-client.js"),state=fixtureState({teams:4,rounds:6,picked:8}),payload={state,userSlot:2,strategy:"titleOnly",refineIterations:64,limit:3,seed:7403};try{const started=Date.now(),result=await acceleratedLocalApi("/v1/evaluate",{body:JSON.stringify(payload),acceleratorTimeoutMs:20});assert.equal(result.status,"complete");assert.equal(result.iterations,64);assert.equal(result.executionEngine,"bundled-extension-workers");assert.match(result.acceleratorFallbackReason,/startup timed out/);assert.equal(messages.filter(message=>message.type==="RUN_PERSISTENT_EVALUATION").length,1);assert.ok(Date.now()-started<2000)}finally{globalThis.fetch=originalFetch}
});

test("an externally cancelled accelerator request never starts bundled fallback work",async()=>{
  const originalFetch=globalThis.fetch,messages=[];globalThis.chrome={runtime:{getURL:value=>value,sendMessage(message){messages.push(message);return Promise.resolve({ok:true})}}};globalThis.fetch=(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(new Error("cancelled"),{name:"AbortError"})),{once:true}));const{acceleratedLocalApi}=await import("../extension/local-engine-client.js"),state=fixtureState({teams:4,rounds:6,picked:8}),payload={state,userSlot:2,strategy:"titleOnly",refineIterations:64,limit:3,seed:7404},controller=new AbortController();try{const pending=acceleratedLocalApi("/v1/evaluate",{body:JSON.stringify(payload),signal:controller.signal,acceleratorTimeoutMs:1000});controller.abort();await assert.rejects(pending,error=>error?.name==="AbortError");assert.equal(messages.filter(message=>message.type==="RUN_PERSISTENT_EVALUATION").length,0)}finally{globalThis.fetch=originalFetch}
});
