import test from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {server,refinementStats,setRefinementDeadlineForTests} from "../server/index.js";
import {fixtureState} from "./fixture.js";

const terminal=new Set(["complete","deadline_fallback","worker_fallback","cancelled"]);
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

function lateState(draftId,picked=160){
  const state=fixtureState({teams:12,rounds:16,picked});
  state.platform="espn";state.draftId=draftId;state.draftRunId=`${draftId}-run`;state.updatedAt=Date.now();
  return state;
}

async function withServer(run){
  server.listen(0);await once(server,"listening");
  try{return await run(`http://127.0.0.1:${server.address().port}`)}finally{server.close();await once(server,"close")}
}

function post(base,state,{consumer="gui",installationId="terminal-invariants",seed=2026,clockPriority=false}={}){
  return fetch(`${base}/v1/evaluate`,{method:"POST",headers:{"content-type":"application/json","x-installation-id":installationId},body:JSON.stringify({state,userSlot:8,iterations:120,refineIterations:10000,limit:3,seed,consumer,clockPriority,clientBuildId:"eval-jobs-v6-strict10k-20260714"})}).then(async response=>{assert.equal(response.status,200);return response.json()});
}

async function exactTerminal(base,initial,limitMs=2000){
  const id=initial.evaluationId,started=Date.now();let result=initial;
  assert.match(id,/^[a-f0-9]{24}$/);
  while(!terminal.has(result.status)&&Date.now()-started<limitMs){await delay(10);result=await fetch(`${base}/v1/evaluate/${id}`).then(response=>response.json());assert.equal(result.evaluationId,id)}
  assert.ok(terminal.has(result.status),`evaluation ${id} remained ${result.status}`);
  assert.ok(Date.now()-started<limitMs,"terminal status exceeded the invariant window");
  if(result.status==="complete"){
    assert.equal(result.iterations,10000);
    assert.ok(result.recommendations.every(item=>item.simulation?.iterations===10000));
  }else{
    assert.equal(result.refinementOutcome,result.status,"fallback must carry an explicit outcome label");
    assert.notEqual(result.status,"refining");
  }
  return result;
}

test("late-round pick 161 is terminal and cannot imply partial odds are full odds",async()=>{
  setRefinementDeadlineForTests(80);
  try{await withServer(async base=>{const result=await exactTerminal(base,await post(base,lateState(`late-161-${Date.now()}`)));assert.equal(result.status,"deadline_fallback");assert.equal(result.targetIterations,10000);assert.equal(result.iterations,120)})}finally{setRefinementDeadlineForTests(null)}
});

test("rapid pick churn makes every exact evaluation ID terminal",async()=>{
  setRefinementDeadlineForTests(3000);
  try{await withServer(async base=>{const draftId=`churn-${Date.now()}`,installationId=`${draftId}-install`,initial=[];for(const picked of [159,160,161])initial.push(await post(base,lateState(draftId,picked),{installationId,seed:3000+picked}));const results=await Promise.all(initial.map(item=>exactTerminal(base,item,5000)));assert.deepEqual(results.slice(0,-1).map(item=>item.status),["cancelled","cancelled"]);assert.ok(["complete","deadline_fallback","worker_fallback"].includes(results.at(-1).status));const cleanupDeadline=Date.now()+500;while(refinementStats().jobs&&Date.now()<cleanupDeadline)await delay(10);assert.equal(refinementStats().jobs,0)})}finally{setRefinementDeadlineForTests(null)}
});

test("exact evaluation polling has enough dedicated capacity for repeated picks",async()=>{
  setRefinementDeadlineForTests(3000);
  try{await withServer(async base=>{const installationId=`poll-capacity-${Date.now()}`,initial=await post(base,lateState(`poll-capacity-${Date.now()}`),{installationId}),responses=await Promise.all(Array.from({length:180},()=>fetch(`${base}/v1/evaluate/${initial.evaluationId}`,{headers:{"x-installation-id":installationId}})));assert.ok(responses.every(response=>response.status===200),`exact status polling was throttled: ${responses.map(response=>response.status).filter(status=>status!==200).join(",")}`);await exactTerminal(base,initial,5000)})}finally{setRefinementDeadlineForTests(null)}
});
