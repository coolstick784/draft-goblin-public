import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const report = JSON.parse(fs.readFileSync(new URL("../data/research/owned-model-pure-market-shadow-series.json", import.meta.url)));

test("fixed pure market policy clears every retained provider snapshot group", () => {
  assert.equal(report.artifactType, "pure-owned-market-shadow-series");
  assert.equal(report.providerInputsUsedForCandidate, false);
  assert.equal(report.playerUniverseDependsOnProviderCoverage, false);
  assert.equal(report.eligibleForLivePromotion, false);
  assert.equal(report.completeSnapshotGroups, 3);
  assert.equal(report.allCompleteGroupsPass, true);
  assert.deepEqual(report.policy, { skillPositionCurveWeight: 1, kickerMarketWeight: 1, quarterbackMarketWeight: 1, dstCurveWeight: .2 });
  assert.ok(report.evaluations.every(row => row.clearsWorstProviderCloseness));
  assert.ok(report.evaluations.every(row => Object.values(row.sourceDigests).every(value => /^[a-f0-9]{64}$/.test(value))));
  assert.match(report.timingCaveat, /not prospective or chronological superiority evidence/i);
});
