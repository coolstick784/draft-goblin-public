import test from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_VERSION, PROBABILITIES, calibratePlayerDistributions, fitDistribution, predictedQuantile } from "../scripts/calibrate-player-distributions.js";
import { QUANTILE_V1_PROBABILITIES } from "../shared/player-distribution.js";

function syntheticRows() {
  const rows = [];
  for (const year of [2021, 2022, 2023, 2024, 2025]) {
    for (const position of ["QB", "WR"]) {
      for (let index = 0; index < 60; index++) {
        const projected = 5 + (index % 20), zero = index % (position === "WR" ? 7 : 13) === 0;
        rows.push({ sourceId: "test-source", year, week: 1 + index % 17, position, projected, actual: zero ? 0 : projected + (index % 5) - 2 + (year - 2023) * 0.1 });
      }
    }
  }
  return rows;
}

test("quantile-v1 artifact has a leakage-safe chronological split and explicit weekly semantics", () => {
  const artifact = calibratePlayerDistributions(syntheticRows(), { generatedAt: "2026-01-01T00:00:00.000Z", shrinkage: 20 });
  assert.equal(artifact.schemaVersion, ARTIFACT_VERSION);
  assert.equal(artifact.artifactKind, "weekly-residual-calibration");
  assert.deepEqual(PROBABILITIES, QUANTILE_V1_PROBABILITIES);
  assert.match(artifact.artifactId, /quantile-v1/);
  assert.deepEqual(artifact.chronologicalSplit.trainingYears, [2021, 2022, 2023]);
  assert.equal(artifact.chronologicalSplit.validationYear, 2024);
  assert.equal(artifact.chronologicalSplit.holdoutYear, 2025);
  assert.match(artifact.distribution.warning, /weekly.*Do not add.*season/i);
  assert.match(artifact.distribution.mixture, /point-mass-at-zero/);
  assert.equal(artifact.status, "research-not-runtime-wired");
  assert.equal(artifact.dataQuality.promotionGatePassed, true);
  for (const metrics of [artifact.validationMetrics, artifact.holdoutMetrics]) {
    assert.ok(metrics.rows > 0);
    assert.ok(Number.isFinite(metrics.weightedIntervalScore));
    assert.ok(Number.isFinite(metrics.crpsApproximation));
    assert.ok(Object.values(metrics.empiricalCoverage).every(value => value >= 0 && value <= 1));
  }
});

test("league-wide zero payloads are rejected as missing outcomes", () => {
  const rows = syntheticRows();
  for (const row of rows) if (row.year === 2025 && row.week === 1) row.actual = 0;
  const artifact = calibratePlayerDistributions(rows, { generatedAt: "2026-01-01T00:00:00.000Z", shrinkage: 20 });
  assert.ok(artifact.dataQuality.excludedMissingOutcomeWeeks.some(item => item.year === 2025 && item.week === 1));
  assert.ok(artifact.chronologicalSplit.rows.holdout < rows.filter(row => row.year === 2025).length);
});

test("all fitted residual and predictive quantiles are monotone", () => {
  const model = fitDistribution(syntheticRows().filter(row => row.year <= 2024), { shrinkage: 20 });
  for (const cell of Object.values(model.cells)) {
    const residuals = Object.values(cell.conditionalPositiveResidualQuantiles);
    assert.deepEqual(residuals, [...residuals].sort((a, b) => a - b));
    const predictions = PROBABILITIES.map(probability => predictedQuantile({ projected: 12 }, cell, probability));
    assert.deepEqual(predictions, [...predictions].sort((a, b) => a - b));
    assert.ok(cell.zeroOutcomeProbability >= 0 && cell.zeroOutcomeProbability <= 1);
  }
});

test("a sparse extreme source cell shrinks toward position and league priors", () => {
  const rows = syntheticRows().filter(row => row.year <= 2024);
  rows.push({ sourceId: "sparse-source", year: 2024, week: 1, position: "WR", projected: 24, actual: 124 });
  const model = fitDistribution(rows, { shrinkage: 100 });
  const cell = model.cells["sparse-source:WR:high"];
  assert.equal(cell.rows, 1);
  assert.ok(cell.localEvidenceWeight < 0.02);
  assert.ok(cell.conditionalPositiveResidualQuantiles.p50 < 10, "one +100 residual must not dictate the median");
  assert.ok(cell.zeroOutcomeProbability > 0, "zero-outcome prior must survive a single positive row");
});

test("projection strength creates distinct heteroskedastic cells", () => {
  const model = fitDistribution(syntheticRows().filter(row => row.year <= 2024), { shrinkage: 20 });
  const cells = ["low", "middle", "high"].map(bucket => model.cells[`test-source:WR:${bucket}`]);
  assert.ok(cells.every(Boolean));
  assert.ok(cells[0].projectionBounds[1] <= cells[1].projectionBounds[1]);
  assert.equal(cells[2].projectionBounds[1], null);
  assert.ok(model.priors.positionBucket["WR:high"]);
});
