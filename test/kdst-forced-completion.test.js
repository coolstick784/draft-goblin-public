import test from "node:test";
import assert from "node:assert/strict";
import { fixtureState } from "./fixture.js";
import { snakeSlot } from "../shared/domain.js";
import { recommend } from "../core/recommend.js";
import { buildCompactAccelerationRequest } from "../extension/local-engine-client.js";
import { runEngineRequest } from "../extension/engine-runtime.js";
import { once } from "node:events";
import { server } from "../server/index.js";

function finalTwoSpecialistState(){
  const state=fixtureState({teams:12,rounds:16,picked:178});
  state.draftId="final-two-specialists";
  state.settings.slots={QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:7};
  state.settings.positionLimits={QB:2,RB:5,WR:6,TE:2,K:1,DST:1};
  const userSlot=snakeSlot(179,12),userIndexes=state.picks.map((pick,index)=>pick.slot===userSlot?index:-1).filter(index=>index>=0),desired=state.players.slice(0,178).filter(player=>!["K","DST"].includes(player.position)).slice(0,userIndexes.length);
  for(let index=0;index<userIndexes.length;index++){
    const target=userIndexes[index],source=state.picks.findIndex(pick=>pick.playerId===desired[index].id),swap=state.picks[target].playerId;
    state.picks[target].playerId=state.picks[source].playerId;
    state.picks[source].playerId=swap;
  }
  return{state,userSlot};
}

test("final two K/DST picks survive quick evaluation and accelerator compaction",async()=>{
  const{state,userSlot}=finalTwoSpecialistState(),payload={state,userSlot,strategy:"titleOnly",sourceProfile:"projectionLed",iterations:32,refineIterations:64,limit:8,seed:7711},quick=await runEngineRequest("evaluate",{...payload,refineIterations:32}),items=recommend(payload);
  assert.ok(items.length>=2);
  assert.deepEqual(new Set(items.map(item=>item.player.position)),new Set(["K","DST"]));
  assert.ok(items.every(item=>item.rosterCompletionRequired&&item.remainingPicks===2&&item.missingRequiredSlots===2));
  assert.equal(quick.recommendations.length,items.length);
  assert.deepEqual(new Set(quick.recommendations.map(item=>item.player.position)),new Set(["K","DST"]));
  const request=buildCompactAccelerationRequest(payload,{precomputedRecommendations:quick.recommendations}),decoded=JSON.parse(request.body);
  assert.equal(decoded.precomputedRecommendations.length,items.length);
  assert.deepEqual(new Set(decoded.precomputedRecommendations.map(item=>item.player.position)),new Set(["K","DST"]));
  assert.ok(decoded.precomputedRecommendations.every(item=>item.simulation===undefined&&item.teamSimulation===undefined));
  assert.ok(decoded.precomputedRecommendations.every(item=>decoded.state.players.some(player=>player.id===item.player.id)));
});

test("accelerator completes an exact final-two K/DST evaluation",async()=>{
  const{state,userSlot}=finalTwoSpecialistState(),payload={state,userSlot,strategy:"titleOnly",sourceProfile:"projectionLed",iterations:32,refineIterations:10_000,limit:8,seed:7712},quick=await runEngineRequest("evaluate",{...payload,refineIterations:32}),request=buildCompactAccelerationRequest(payload,{precomputedRecommendations:quick.recommendations});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/evaluate/deep`,{method:"POST",headers:{"content-type":"application/json",accept:"application/x-ndjson"},body:request.body}),events=(await response.text()).trim().split("\n").map(line=>JSON.parse(line)),failure=events.find(event=>event.type==="error"),result=events.find(event=>event.type==="result")?.data;
    assert.equal(response.status,200);
    assert.equal(failure,undefined);
    assert.equal(result?.iterations,10_000);
    assert.equal(result?.recommendations.length,quick.recommendations.length);
    assert.deepEqual(new Set(result?.recommendations.map(item=>item.player.position)),new Set(["K","DST"]));
  }finally{await new Promise(resolve=>server.close(resolve))}
});
