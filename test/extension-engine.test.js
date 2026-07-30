import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runEngineRequest,CLIENT_BUILD_ID } from "../extension/engine-runtime.js";
import { fixtureState } from "./fixture.js";

test("bundled ranking and simulation sources match the server engine",()=>{
  for(const file of ["conditional-rollout.js","evaluate.js","recommend.js","simulate.js","weekly-simulation.js"]){
    const normalize=value=>value.replace(/\r\n/g,"\n"),server=normalize(fs.readFileSync(new URL(`../core/${file}`,import.meta.url),"utf8")),bundled=normalize(fs.readFileSync(new URL(`../extension/engine/core/${file}`,import.meta.url),"utf8"));
    assert.equal(bundled,server,`${file} is stale in the bundled extension engine`);
  }
});

test("bundled extension engine returns a complete 10,000-simulation recommendation",async()=>{
  const state=fixtureState({teams:4,rounds:6,picked:7}),started=performance.now();
  const result=await runEngineRequest("evaluate",{state,userSlot:4,strategy:"titleOnly",iterations:32,refineIterations:10000,limit:5});
  assert.equal(result.clientBuildId,CLIENT_BUILD_ID);
  assert.equal(result.status,"complete");
  assert.equal(result.simulationStatus,"refined");
  assert.equal(result.iterations,10000);
  assert.ok(result.recommendations.length>0);
  assert.ok(result.recommendations.every(item=>item.simulation.iterations===10000&&item.teamSimulation.iterations===10000));
  assert.ok(performance.now()-started<60000,"bundled calculation must finish within the extension worker watchdog budget");
});

test("exact workers report an early heartbeat before Chrome's shard watchdog",async()=>{
  const state=fixtureState({teams:4,rounds:6,picked:7}),progress=[];
  await runEngineRequest("evaluate-chunk",{state,candidates:[null,state.players[0]],userSlot:4,iterations:17,seed:2026,scenarioOffset:0,shardId:0},{onProgress:(completed,total)=>progress.push([completed,total])});
  assert.deepEqual(progress,[[8,17],[16,17],[17,17]]);
});

test("bundled catalog is populated and provider projection rows are absent",()=>{
  const catalog=JSON.parse(fs.readFileSync(new URL("../extension/engine-data/catalog.json",import.meta.url),"utf8"));
  assert.ok(catalog.players.length>500);
  const kittle=catalog.players.find(player=>player.name==="George Kittle");
  assert.equal(kittle.availability.schemaVersion,"availability-v1");
  assert.ok(kittle.availability.missedGameRate>.12);
  assert.equal(kittle.availability.embeddedMissedGameRate,kittle.availability.missedGameRate);
  assert.equal(fs.existsSync(new URL("../extension/engine-data/projection-snapshots.json",import.meta.url)),false);
});
