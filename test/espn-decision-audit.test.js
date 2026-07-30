import test from "node:test";
import assert from "node:assert/strict";
import { buildEspnState } from "../scripts/recommend-live-espn.js";

test("historical ESPN replay enriches future players without drafting them",()=>{
  const state=buildEspnState({
    teams:12,rounds:16,picks:[],
    projectionRows:[{pickNo:60,name:"Rome Odunze",position:"WR",team:"CHI",platformPoints:212.6,rank:58}]
  }),odunze=state.players.find(player=>player.name==="Rome Odunze");
  assert.equal(state.picks.length,0);
  assert.equal(odunze.platformProjection,212.6);
  assert.equal(odunze.adp,58);
  assert.ok(odunze.mean>168.4);
});
