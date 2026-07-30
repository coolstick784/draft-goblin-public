import test from "node:test";
import assert from "node:assert/strict";
import {fetchWithRetry} from "../server/fetch-retry.js";

test("projection fetch retries transient responses and preserves request options",async()=>{
  const calls=[];
  const response=await fetchWithRetry("https://example.test/projections",{headers:{accept:"application/json"}},{delays:[0,0],fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return calls.length===1?{ok:false,status:503}:{ok:true,status:200}}});
  assert.equal(response.status,200);
  assert.equal(calls.length,2);
  assert.equal(calls[1].options.headers.accept,"application/json");
  assert.equal(calls[1].options.cache,"no-store");
});

test("projection fetch does not retry permanent client failures",async()=>{
  let calls=0;
  const response=await fetchWithRetry("https://example.test/projections",{},{delays:[0,0,0],fetchImpl:async()=>{calls++;return{ok:false,status:404}}});
  assert.equal(response.status,404);
  assert.equal(calls,1);
});
