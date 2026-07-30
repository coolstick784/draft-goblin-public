import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ownedMarketIdentity } from "../scripts/evaluate-owned-shadow.js";
import { smoothToProviderRange } from "../scripts/evaluate-owned-drafted-shadow.js";

const report = JSON.parse(fs.readFileSync(new URL("../data/research/owned-model-broad-drafted-shadow.json", import.meta.url)));

test("broad drafted-player shadow covers essentially the entire current market", () => {
  assert.equal(report.coverage.draftedPlayers, 217);
  assert.equal(report.coverage.candidatePlayers, 215);
  assert.ok(report.coverage.candidateRate >= .99);
  assert.equal(report.coverage.anyProviderPlayers, report.coverage.candidatePlayers);
  assert.ok(report.coverage.twoOrMoreProviderPlayers / report.coverage.candidatePlayers >= .9);
  assert.deepEqual(report.coverage.excludedPlayers.map(player => player.name), ["Brandon Aiyuk", "Travis Hunter"]);
});

test("broad candidate dominates major providers and stays evaluation-only", () => {
  assert.equal(report.baseCandidateProviderProjectionInputsUsed, false);
  assert.equal(report.providerProjectionInputsUsedForCandidate, true);
  assert.equal(report.policySelectedUsingCurrentProviderBenchmark, true);
  assert.equal(report.eligibleForLivePromotion, false);
  assert.ok(report.providersBeaten.includes("espn"));
  assert.ok(report.providersBeaten.includes("sleeper"));
  assert.ok(Object.values(report.marketRankByPosition).every(position => position.clearsWorstProvider));
  assert.ok(Object.values(report.gates).every(Boolean));
  assert.equal(report.passes, true);
});

test("provider range smoothing continuously compresses every outside projection", () => {
  const high = smoothToProviderRange(400, { espn: 300, sleeper: 320, fantasyPros: 310 });
  const modestHigh = smoothToProviderRange(325, { espn: 300, sleeper: 320 });
  const low = smoothToProviderRange(275, { espn: 300, sleeper: 320 });
  assert.ok(high.value > 339.9 && high.value < 340);
  assert.ok(modestHigh.value > 324 && modestHigh.value < 325);
  assert.ok(low.value > 283 && low.value < 284);
  assert.deepEqual(smoothToProviderRange(315, { espn: 300, sleeper: 320 }), { value: 315, adjusted: false, adjustment: 0, lowerBound: 280, upperBound: 340 });
  assert.deepEqual(smoothToProviderRange(315, {}), { value: 315, adjusted: false, adjustment: 0, lowerBound: null, upperBound: null });
  assert.throws(() => smoothToProviderRange(400, { espn: 300 }, 0), /positive/);
  assert.equal(report.rangeGuard.transform, "nearest provider-range boundary plus tanh-compressed excess");
  assert.equal(report.rangeGuard.smoothingPoints, 20);
  assert.equal(report.rangeGuard.maximumViolationPoints, 0);
  assert.equal(report.rangeGuard.everyPlayerWithinSmoothingEnvelope, true);
  assert.equal(report.gates.everyPlayerWithinProviderSmoothingEnvelope, true);
});

test("market identity reconciles accented kickers and defenses by team", () => {
  assert.equal(ownedMarketIdentity("Eddy Piñeiro", "PK", "SF"), ownedMarketIdentity("Eddy Pineiro", "K", "SF"));
  assert.equal(ownedMarketIdentity("LA Rams Defense", "DEF", "LAR"), ownedMarketIdentity("Los Angeles Rams", "DST", "LA"));
});
