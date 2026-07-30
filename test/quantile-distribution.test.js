import test from "node:test";
import assert from "node:assert/strict";
import {
  distributionFromSummary,
  meanOfQuantileDistribution,
  normalizeQuantileDistribution,
  quantileAt,
  sampleQuantileDistribution
} from "../core/quantile-distribution.js";

const grid = (probabilities, values, extra = {}) => ({ version: 1, probabilities, values, ...extra });

test("repairs crossing quantiles without mutating input", () => {
  const input = grid([0.1, 0.3, 0.5, 0.7, 0.9], [5, 12, 9, 20, 18]);
  const original = structuredClone(input);
  const result = normalizeQuantileDistribution(input);
  assert.deepEqual(input, original);
  assert.equal(result.probabilities[0], 0);
  assert.equal(result.probabilities.at(-1), 1);
  result.values.slice(1).forEach((value, index) => assert.ok(value >= result.values[index]));
  assert.equal(result.values[2], result.values[3]);
  assert.equal(result.values[4], result.values[5]);
});

test("recenters a bounded skewed grid to its target mean", () => {
  const result = normalizeQuantileDistribution(grid(
    [0.05, 0.25, 0.5, 0.75, 0.95],
    [2, 8, 13, 24, 55],
    { mean: 20 }
  ), { lowerBound: 0 });
  assert.ok(Math.abs(result.mean - 20) < 1e-10);
  assert.ok(Math.abs(meanOfQuantileDistribution(result) - 20) < 1e-10);
  assert.ok(result.values.every((value) => value >= 0));
});

test("inverse CDF interpolation retains asymmetric upside", () => {
  const result = normalizeQuantileDistribution(grid([0.1, 0.5, 0.9], [5, 10, 30]));
  assert.equal(quantileAt(result, 0.5), 10);
  assert.equal(quantileAt(result, 0.3), 7.5);
  assert.equal(quantileAt(result, 0.7), 20);
  assert.ok(quantileAt(result, 0.9) - quantileAt(result, 0.5) > quantileAt(result, 0.5) - quantileAt(result, 0.1));
});

test("adds finite monotone tails and bounds extrapolation", () => {
  const result = normalizeQuantileDistribution(grid([0.05, 0.5, 0.95], [4, 12, 30]), { lowerBound: 0 });
  assert.equal(result.probabilities[0], 0);
  assert.equal(result.probabilities.at(-1), 1);
  assert.ok(result.values[0] >= 0 && result.values[0] <= 4);
  assert.ok(result.values.at(-1) >= 30 && result.values.at(-1) < 50);
  assert.equal(quantileAt(result, 0), result.values[0]);
  assert.equal(quantileAt(result, 1), result.values.at(-1));
});

test("summary fallback creates a mean-preserving distribution", () => {
  const result = distributionFromSummary({ mean: 18, floor: 8, ceiling: 35 });
  assert.ok(Math.abs(result.mean - 18) < 1e-10);
  assert.ok(quantileAt(result, 0.1) < quantileAt(result, 0.5));
  assert.ok(quantileAt(result, 0.5) < quantileAt(result, 0.9));
  assert.ok(result.values.every((value) => value >= 0));
});

test("consumes the shared quantile-v1 player envelope directly", () => {
  const probabilities = [.01, .05, .10, .20, .30, .40, .50, .60, .70, .80, .90, .95, .99];
  const distribution = {
    schemaVersion: "quantile-v1",
    unit: "season-fantasy-points",
    conditionedOn: "active-role",
    season: 2026,
    scoringFormat: "ppr",
    mean: 18,
    quantiles: probabilities.map((p, index) => ({ p, value: 4 + index * 2.25 })),
    provenance: {}
  };
  const result = normalizeQuantileDistribution(distribution, { lowerBound: 0 });
  assert.equal(result.version, 1);
  assert.equal(result.probabilities[0], 0);
  assert.equal(result.probabilities.at(-1), 1);
  assert.ok(Math.abs(result.mean - distribution.mean) < 1e-10);
  assert.equal(sampleQuantileDistribution(result, { uniform: 0.5 }), result.values[7]);
});

test("sampling is deterministic for supplied uniform and normal draws", () => {
  const result = normalizeQuantileDistribution(grid([0, 0.5, 1], [0, 10, 30]));
  assert.equal(sampleQuantileDistribution(result, 0.25), 5);
  assert.equal(sampleQuantileDistribution(result, { uniform: 0.25 }), 5);
  assert.equal(sampleQuantileDistribution(result, { normal: 0 }), 10);
  assert.equal(sampleQuantileDistribution(result, { normal: 0.75 }), sampleQuantileDistribution(result, { normal: 0.75 }));
  assert.equal(sampleQuantileDistribution(result, { normal: -8 }), 0);
  assert.equal(sampleQuantileDistribution(result, { normal: 8 }), 30);
});

test("rejects malformed and unsupported inputs", () => {
  assert.throws(() => normalizeQuantileDistribution(null), /must be an object/);
  assert.throws(() => normalizeQuantileDistribution(grid([0.1], [1])), /at least two/);
  assert.throws(() => normalizeQuantileDistribution(grid([0.2, 0.2], [1, 2])), /strictly increasing/);
  assert.throws(() => normalizeQuantileDistribution(grid([-0.1, 0.9], [1, 2])), /between 0 and 1/);
  assert.throws(() => normalizeQuantileDistribution({ version: 2, probabilities: [0, 1], values: [1, 2] }), /unsupported/);
  assert.throws(() => normalizeQuantileDistribution(grid([0, 1], [1, NaN])), /finite number/);
  assert.throws(() => distributionFromSummary({ mean: 10, floor: 12, ceiling: 20 }), /floor <= mean <= ceiling/);
  assert.throws(() => sampleQuantileDistribution(grid([0, 1], [0, 1]), { uniform: 0.5, normal: 0 }), /exactly one/);
  assert.throws(() => quantileAt(grid([0, 1], [0, 1]), 1.1), /between 0 and 1/);
});
