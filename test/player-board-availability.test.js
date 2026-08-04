import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidateBoard as buildServerBoard } from "../core/recommend.js";
import { buildCandidateBoard as buildExtensionBoard } from "../extension/engine/core/recommend.js";
import { fixtureState } from "./fixture.js";

test("player board reports availability for market-ranked players outside the recommendation shortlist",()=>{
  const state=fixtureState();
  state.projectionSeason=2026;
  for(const buildCandidateBoard of [buildServerBoard,buildExtensionBoard]){
    const row=buildCandidateBoard({state,userSlot:4}).find(candidate=>candidate.player.position==="K");
    assert.ok(row);
    assert.equal(row.simulationEligible,false);
    assert.ok(Number(row.player.adp)>0);
    assert.equal(row.availabilityConfidence,"market");
    assert.ok(Number.isInteger(row.availabilityTargetPick));
    assert.ok(Number.isFinite(row.nextPickAvailability));
    assert.ok(row.nextPickAvailability>=0&&row.nextPickAvailability<=1);
  }
});

test("server and extension boards display real TE market ranks and keep missing ranks unavailable",()=>{
  const state=fixtureState();
  state.projectionSeason=2026;
  const drafted=new Set(state.picks.map(pick=>String(pick.playerId))),missing=state.players.find(player=>player.position!=="TE"&&!drafted.has(String(player.id))),tightEnd=state.players.find(player=>player.position==="TE"&&!drafted.has(String(player.id)));
  missing.adp=null;
  for(const buildCandidateBoard of [buildServerBoard,buildExtensionBoard]){
    const board=buildCandidateBoard({state,userSlot:4});
    const missingRow=board.find(candidate=>candidate.player.id===missing.id),tightEndRow=board.find(candidate=>candidate.player.id===tightEnd.id);
    assert.ok(missingRow);assert.equal(missingRow.availabilityConfidence,"low");assert.equal(missingRow.nextPickAvailability,.5);
    assert.ok(tightEndRow);assert.equal(tightEndRow.availabilityConfidence,"market");assert.ok(tightEndRow.nextPickAvailability>=0&&tightEndRow.nextPickAvailability<=1);
  }
});
