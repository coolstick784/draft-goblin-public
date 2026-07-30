import test from "node:test";
import assert from "node:assert/strict";
import {
  QUANTILE_V1_PROBABILITIES,
  playerDistributionFingerprintMaterial,
  validatePlayerDistribution
} from "../shared/player-distribution.js";

const validDistribution = () => ({
  schemaVersion: "quantile-v1",
  unit: "season-fantasy-points",
  season: 2026,
  scoringFormat: "ppr",
  conditionedOn: "active-role",
  mean: 200,
  quantiles: QUANTILE_V1_PROBABILITIES.map((p, index) => ({ p, value: 90 + index * 18 })),
  provenance: {
    modelId: "hierarchical-player-quantiles",
    modelVersion: "2026.1",
    calibrationId: "walk-forward-2025",
    generatedAt: "2026-07-14T12:00:00.000Z",
    forecastAsOf: "2026-07-14T11:55:00.000Z",
    trainedThrough: "2026-02-10T00:00:00.000Z",
    sourceSnapshotIds: ["espn:2026:ppr:2026-07-14"],
    estimationLevel: "player"
  },
  correlationRefs: [
    { kind: "offense", key: "offense:2026:CHI" },
    { kind: "pass-game", key: "pass-game:2026:CHI" }
  ]
});

test("quantile-v1 accepts the fixed monotone grid with complete provenance", () => {
  const result = validatePlayerDistribution(validDistribution(), { season: 2026, scoringFormat: "ppr" });
  assert.deepEqual(result, { valid: true, errors: [], warnings: [] });
});

test("quantile-v1 rejects crossed quantiles and injury state embedded in performance", () => {
  const distribution = validDistribution();
  distribution.quantiles[7].value = distribution.quantiles[6].value - 1;
  distribution.injuryRisk = .4;
  const result = validatePlayerDistribution(distribution);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("quantile values must be non-decreasing"));
  assert.ok(result.errors.some(error => error.includes("injuryRisk is forbidden")));
});

test("fallback distributions identify their shrinkage reason", () => {
  const distribution = validDistribution();
  distribution.provenance.estimationLevel = "archetype";
  let result = validatePlayerDistribution(distribution);
  assert.equal(result.valid, false);
  distribution.provenance.fallbackReason = "Only one professional season was available";
  result = validatePlayerDistribution(distribution);
  assert.equal(result.valid, true);
});

test("provenance rejects a model trained through or after its forecast boundary", () => {
  const distribution = validDistribution();
  distribution.provenance.trainedThrough = distribution.provenance.forecastAsOf;
  const result = validatePlayerDistribution(distribution);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("provenance.trainedThrough must precede provenance.forecastAsOf"));
});

test("fingerprint material is key-order stable and changes with outcome inputs", () => {
  const distribution = validDistribution(), player = { id: "wr-1", distribution, availability: { schemaVersion: "availability-v1", modelVersion: "a", activeProbability: .9 } };
  const reordered = { availability: { activeProbability: .9, modelVersion: "a", schemaVersion: "availability-v1" }, distribution: { ...distribution, provenance: { ...distribution.provenance } }, id: "wr-1" };
  assert.equal(playerDistributionFingerprintMaterial(player), playerDistributionFingerprintMaterial(reordered));

  const changedQuantile = structuredClone(player);
  changedQuantile.distribution.quantiles[0].value -= 1;
  assert.notEqual(playerDistributionFingerprintMaterial(player), playerDistributionFingerprintMaterial(changedQuantile));

  const changedAvailability = structuredClone(player);
  changedAvailability.availability.activeProbability = .8;
  assert.notEqual(playerDistributionFingerprintMaterial(player), playerDistributionFingerprintMaterial(changedAvailability));
});
