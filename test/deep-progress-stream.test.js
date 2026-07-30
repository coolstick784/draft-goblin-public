import test from"node:test";
import assert from"node:assert/strict";
import{once}from"node:events";
import{server}from"../server/index.js";
import{fixtureState}from"./fixture.js";

test("deep exact evaluation streams real scenario progress before its result",async()=>{
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    const{port}=server.address(),state=fixtureState({teams:12,rounds:16,picked:12}),response=await fetch(`http://127.0.0.1:${port}/v1/evaluate/deep`,{method:"POST",headers:{"content-type":"application/json",accept:"application/x-ndjson"},body:JSON.stringify({state,userSlot:12,strategy:"titleOnly",limit:8,iterations:10000})});
    assert.equal(response.status,200);assert.match(response.headers.get("content-type"),/application\/x-ndjson/);
    const events=(await response.text()).trim().split("\n").map(line=>JSON.parse(line)),progress=events.filter(event=>event.type==="progress"),result=events.find(event=>event.type==="result")?.data;
    assert.ok(progress.length>0);assert.ok(progress.some(event=>event.completed>0));assert.ok(progress.every((event,index)=>index===0||event.completed>=progress[index-1].completed));assert.equal(progress.at(-1).completed,10000);assert.equal(progress.at(-1).total,10000);assert.ok(progress.at(-1).shardCount>progress.at(-1).workerCount);assert.equal(result.iterations,10000);assert.equal(result.recommendations.length,8)
  }finally{await new Promise(resolve=>server.close(resolve))}
});
