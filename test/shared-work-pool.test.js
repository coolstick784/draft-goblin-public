import test from "node:test";
import assert from "node:assert/strict";
import {SharedWorkPool}from"../server/shared-work-pool.js";

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}};

test("identical consumers share work while retaining independent cancellation",async()=>{
  const pool=new SharedWorkPool(),work=deferred();
  let starts=0,cancels=0;
  const factory=()=>{starts++;return{promise:work.promise,cancel:()=>{cancels++}}};
  const gui=pool.acquire("same-state",factory),priority=pool.acquire("same-state",factory);
  assert.equal(starts,1);
  assert.deepEqual(pool.stats(),{activeWorkCount:1,subscriberCount:2});
  gui.release();
  assert.equal(cancels,0);
  assert.deepEqual(pool.stats(),{activeWorkCount:1,subscriberCount:1});
  work.resolve("complete");
  assert.equal(await priority.promise,"complete");
  priority.release();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(pool.stats(),{activeWorkCount:0,subscriberCount:0});
});

test("shared work is cancelled only after its final subscriber releases",()=>{
  const pool=new SharedWorkPool(),work=deferred();
  let cancels=0;
  const first=pool.acquire("same-state",()=>({promise:work.promise,cancel:()=>{cancels++}})),second=pool.acquire("same-state",()=>assert.fail("factory must not run twice"));
  first.release();
  assert.equal(cancels,0);
  second.release();
  assert.equal(cancels,1);
  assert.deepEqual(pool.stats(),{activeWorkCount:0,subscriberCount:0});
});
