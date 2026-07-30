import test from "node:test";
import assert from "node:assert/strict";
import {FullRefinementScheduler} from "../server/full-refinement-scheduler.js";

const deferred=()=>{let resolve;return{promise:new Promise(done=>{resolve=done}),resolve}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test("admits only one distinct full refinement and prioritizes on-clock queued work",async()=>{
  const scheduler=new FullRefinementScheduler(),first=deferred(),second=deferred(),third=deferred(),started=[],running=new Set();let maximum=0;
  const run=(name,gate)=>async()=>{started.push(name);running.add(name);maximum=Math.max(maximum,running.size);await gate.promise;running.delete(name);return name};
  const a=scheduler.schedule("a",run("a",first),{priority:30,metadata:{pickCount:1}}),b=scheduler.schedule("b",run("b",second),{priority:10}),c=scheduler.schedule("c",run("c",third),{priority:20});
  await Promise.resolve();assert.deepEqual(started,["a"]);assert.equal(scheduler.stats().activeCount,1);assert.equal(scheduler.stats().queuedCount,2);
  first.resolve();assert.equal(await a.promise,"a");await tick();assert.deepEqual(started,["a","c"]);
  third.resolve();assert.equal(await c.promise,"c");await tick();assert.deepEqual(started,["a","c","b"]);
  second.resolve();assert.equal(await b.promise,"b");assert.equal(maximum,1)
});

test("cancelled queued work never starts and records no competing operation",async()=>{
  const scheduler=new FullRefinementScheduler(),active=deferred(),started=[];
  const first=scheduler.schedule("active",async()=>{started.push("active");await active.promise});
  const queued=scheduler.schedule("obsolete",async()=>started.push("obsolete"));
  queued.cancel();await assert.rejects(queued.promise,error=>error.code==="REFINEMENT_CANCELLED");
  assert.equal(scheduler.stats().queuedCount,0);active.resolve();await first.promise;await Promise.resolve();assert.deepEqual(started,["active"])
});

test("higher-priority arrivals never cancel an already-running GUI refinement",async()=>{
  const scheduler=new FullRefinementScheduler(),active=deferred(),started=[];let activeCancelled=false;
  const gui=scheduler.schedule("gui",async()=>{started.push("gui");await active.promise;return"gui"},{priority:20,onCancel:()=>{activeCancelled=true}});
  await tick();
  const priority=scheduler.schedule("priority",async()=>{started.push("priority");return"priority"},{priority:30});
  await tick();assert.deepEqual(started,["gui"]);assert.equal(activeCancelled,false);
  active.resolve();assert.equal(await gui.promise,"gui");assert.equal(await priority.promise,"priority");assert.deepEqual(started,["gui","priority"])
});

test("urgent on-clock work can preempt lower-priority background refinement",async()=>{
  const scheduler=new FullRefinementScheduler(),started=[];let cancelled=false,rejectActive;
  const active=scheduler.schedule("gui",()=>new Promise((_resolve,reject)=>{started.push("gui");rejectActive=reject}),{priority:10,onCancel:()=>{cancelled=true;rejectActive(new Error("preempted"))}});
  await tick();const urgent=scheduler.schedule("priority",async()=>{started.push("priority");return"ready"},{priority:30,preemptLowerPriority:true});
  await assert.rejects(active.promise,/preempted/);assert.equal(await urgent.promise,"ready");assert.equal(cancelled,true);assert.deepEqual(started,["gui","priority"])
});
