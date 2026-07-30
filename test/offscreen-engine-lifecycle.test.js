import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import vm from"node:vm";

const source=fs.readFileSync(new URL("../extension/offscreen-engine.js",import.meta.url),"utf8").replace(/^import[^\n]+\n/,"");
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test("offscreen evaluation jobs cancel immediately and are removed before the next draft context",async()=>{
  let listener,calls=0;
  const localApi=(path,{signal})=>{
    calls++;
    if(calls>1)return Promise.resolve({run:calls});
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(Object.assign(new Error("Extension calculation cancelled."),{name:"AbortError"}));
      if(signal.aborted)abort();else signal.addEventListener("abort",abort,{once:true})
    })
  };
  const context={AbortController,localApi,scheduleLocalEngineWorkerShutdown:()=>{},warmLocalEngineWorkers:async()=>{},__draftGoblinOffscreenTestMode:true,chrome:{runtime:{onMessage:{addListener(value){listener=value}}}}};
  context.globalThis=context;vm.runInNewContext(source,context,{filename:"extension/offscreen-engine.js"});
  const send=message=>new Promise(resolve=>{const keepAlive=listener(message,{},resolve);if(keepAlive!==true&&message.type!=="OFFSCREEN_RUN_EVALUATION")queueMicrotask(()=>resolve(undefined))});

  const ping=await send({type:"OFFSCREEN_ENGINE_PING"});assert.equal(ping.ok,true);assert.equal(ping.engine,"draft-goblin-offscreen");
  const warmed=await send({type:"OFFSCREEN_WARM_ENGINE"});assert.equal(warmed.ok,true);
  const first=send({type:"OFFSCREEN_RUN_EVALUATION",requestId:"old-draft",body:"{}"});
  await tick();
  const cancellation=await send({type:"OFFSCREEN_CANCEL_EVALUATION",requestId:"old-draft"});assert.equal(cancellation.ok,true);assert.equal(cancellation.cancelled,true);
  const cancelled=await first;
  assert.equal(cancelled.ok,false);
  assert.match(cancelled.error,/cancelled/i);
  const replacement=await send({type:"OFFSCREEN_RUN_EVALUATION",requestId:"new-draft",body:"{}"});
  assert.equal(replacement.ok,true);assert.equal(replacement.data.run,2);
  assert.equal(calls,2);
  assert.equal(context.__draftGoblinOffscreenTest.activeJobs(),0);
});

test("offscreen jobs are bounded to in-flight work instead of retaining completed draft results",()=>{
  assert.match(source,/if\(sharedJobs\.get\(key\)===entry\)sharedJobs\.delete\(key\)/);
  assert.match(source,/activeJobs:\(\)=>jobs\.size,activeSharedJobs:\(\)=>sharedJobs\.size/);
  assert.doesNotMatch(source,/evaluationKey|crypto\.subtle|jobs\.set\(key,request\)/);
});

test("identical panel requests share one exact job and one subscriber can cancel without aborting the other",async()=>{
  let listener,calls=0,abortCount=0,finish;
  const localApi=(path,{signal,onProgress})=>{
    calls++;
    signal.addEventListener("abort",()=>abortCount++,{once:true});
    return new Promise(resolve=>{finish=()=>{onProgress({completed:10_000,total:10_000});resolve({status:"complete",iterations:10_000})}})
  };
  const published=[],context={AbortController,localApi,scheduleLocalEngineWorkerShutdown:()=>{},warmLocalEngineWorkers:async()=>{},__draftGoblinOffscreenTestMode:true,chrome:{runtime:{sendMessage:message=>{published.push(message);return Promise.resolve()},onMessage:{addListener(value){listener=value}}}}};
  context.globalThis=context;vm.runInNewContext(source,context,{filename:"extension/offscreen-engine.js"});
  const send=message=>new Promise(resolve=>{const keepAlive=listener(message,{},resolve);if(keepAlive!==true)queueMicrotask(()=>resolve(undefined))});
  const first=send({type:"OFFSCREEN_RUN_EVALUATION",requestId:"panel-a",body:'{"state":{"draftId":"draft-a","updatedAt":100},"strategy":"titleOnly"}'}),second=send({type:"OFFSCREEN_RUN_EVALUATION",requestId:"panel-b",body:'{"state":{"draftId":"draft-a","updatedAt":200},"strategy":"titleOnly"}'});
  await tick();
  assert.equal(calls,1);
  assert.equal(context.__draftGoblinOffscreenTest.activeJobs(),2);
  assert.equal(context.__draftGoblinOffscreenTest.activeSharedJobs(),1);
  const cancellation=await send({type:"OFFSCREEN_CANCEL_EVALUATION",requestId:"panel-a"});
  assert.equal(cancellation.ok,true);
  assert.equal(cancellation.cancelled,true);
  assert.equal(abortCount,0,"the remaining panel still owns the shared calculation");
  assert.equal(context.__draftGoblinOffscreenTest.activeJobs(),1);
  finish();
  const[firstResponse,secondResponse]=await Promise.all([first,second]);
  assert.equal(firstResponse.ok,true);
  assert.equal(secondResponse.ok,true);
  assert.equal(published.length,1);
  assert.equal(published[0].requestId,"panel-b");
  assert.equal(context.__draftGoblinOffscreenTest.activeJobs(),0);
  assert.equal(context.__draftGoblinOffscreenTest.activeSharedJobs(),0)
});

test("every explicit warm request reaches the idle-managed worker pool",async()=>{
  let listener,warmCalls=0,shutdownSchedules=0;
  const context={AbortController,localApi:async()=>({}),scheduleLocalEngineWorkerShutdown:()=>{shutdownSchedules++},warmLocalEngineWorkers:async()=>{warmCalls++},chrome:{runtime:{onMessage:{addListener(value){listener=value}}}}};
  context.globalThis=context;vm.runInNewContext(source,context,{filename:"extension/offscreen-engine.js"});
  const send=message=>new Promise(resolve=>{const keepAlive=listener(message,{},resolve);if(keepAlive!==true)queueMicrotask(()=>resolve(undefined))});
  await tick();
  await send({type:"OFFSCREEN_WARM_ENGINE"});
  await send({type:"OFFSCREEN_WARM_ENGINE"});
  assert.equal(warmCalls,3);
  assert.equal(shutdownSchedules,3);
});

test("offscreen workers publish exact progress with the persistent request identity",async()=>{
  let listener;const published=[],localApi=async(path,{onProgress})=>{onProgress({completed:400,total:1_000});return{status:"complete"}},context={AbortController,localApi,scheduleLocalEngineWorkerShutdown:()=>{},warmLocalEngineWorkers:async()=>{},chrome:{runtime:{sendMessage:message=>{published.push(message);return Promise.resolve()},onMessage:{addListener(value){listener=value}}}}};
  context.globalThis=context;vm.runInNewContext(source,context,{filename:"extension/offscreen-engine.js"});
  const response=await new Promise(resolve=>listener({type:"OFFSCREEN_RUN_EVALUATION",requestId:"progress-job",body:"{}"},{},resolve));
  assert.equal(response.ok,true);assert.equal(published.length,1);assert.equal(published[0].type,"OFFSCREEN_EVALUATION_PROGRESS");assert.equal(published[0].requestId,"progress-job");assert.equal(published[0].progress.completed,400)
});
