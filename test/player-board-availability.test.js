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
