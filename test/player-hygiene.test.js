import test from"node:test";
import assert from"node:assert/strict";
import{sanitizeSleeperState}from"../extension/player-hygiene.js";

test("live Sleeper pool retains active projectionless players for Draft Goblin fallback",()=>{
  const state=sanitizeSleeperState({platform:"sleeper",picks:[],players:[
    {id:"active",name:"Current Player",team:"NYJ",active:true,platformProjection:180},
    {id:"retired",name:"Dan Bailey",team:"FA",active:false,platformProjection:100},
    {id:"missing",name:"No Projection",team:"BUF",active:true,platformProjection:0}
  ]},2026);
  assert.deepEqual(state.players.map(player=>player.id),["active","missing"]);
  assert.equal(state.players[0].projectionSeason,2026);
  assert.equal(state.players[0].eligibleForRecommendation,true);
  assert.equal(state.players[1].projectionSource,"Draft Goblin fallback");
});

test("picked players remain for roster construction but are not recommendation eligible",()=>{
  const state=sanitizeSleeperState({platform:"sleeper",picks:[{playerId:"picked"}],players:[{id:"picked",team:null,platformProjection:0}]},2026);
  assert.equal(state.players.length,1);
  assert.equal(state.players[0].eligibleForRecommendation,false);
});
