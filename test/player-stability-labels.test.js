import test from "node:test";
import assert from "node:assert/strict";
import { backtestPlayerStabilityLabels, buildStabilityLabels, evaluateStabilityLabels } from "../scripts/backtest-player-stability-labels.js";

function fixture() {
  const rows = [];
  for (const year of [2021, 2022, 2023, 2024]) for (let player = 0; player < 48; player++) for (let week = 1; week <= 12; week++) {
    const label = player < 16 ? "stable" : player < 32 ? "typical" : "boom";
    const projected = 10 + player % 3;
    let residual;
    if (label === "stable") residual = (week + player) % 2 ? -.4 : .4;
    else if (label === "typical") residual = [-3, -.5, .5, 3][(week + player) % 4];
    else residual = (week + player) % 2 ? -7 : 7;
    rows.push({ sourceId: "test", year, week, name: `Player ${player}`, position: "WR", projected, actual: Math.max(0, projected + residual) });
  }
  for (const year of [2023, 2024]) for (let player = 0; player < 8; player++) for (let week = 1; week <= 12; week++) rows.push({ sourceId: "test", year, week, name: `New ${year} ${player}`, position: "WR", projected: 10, actual: week % 2 ? 1 : 19 });
  return rows;
}

test("labels require prior reliability and reserve boom/bust for two-tail histories", () => {
  const rows = fixture(), model = buildStabilityLabels(rows.filter(row => row.year <= 2022), { minimumWeeklyRows: 20, minimumPriorSeasons: 2, priorStrength: 4 });
  assert.equal(model.profiles.get("player0:WR").label, "stable");
  assert.equal(model.profiles.get("player40:WR").label, "boom-bust");
  const oneSided = [];
  for (const year of [2021, 2022]) for (let week = 1; week <= 12; week++) oneSided.push({ year, week, name: "Downside Only", position: "WR", projected: 10, actual: week % 2 ? 1 : 10 });
  const augmented = buildStabilityLabels([...rows.filter(row => row.year <= 2022), ...oneSided], { minimumWeeklyRows: 20, minimumPriorSeasons: 2, priorStrength: 4 });
  assert.notEqual(augmented.profiles.get("downsideonly:WR").label, "boom-bust");
});

test("rolling evaluation never uses a test season to assign its labels", () => {
  const rows = fixture(), training = rows.filter(row => row.year <= 2022), testRows = rows.filter(row => row.year === 2023);
  const first = evaluateStabilityLabels(training, testRows, { priorStrength: 4 });
  const mutated = evaluateStabilityLabels(training, testRows.map(row => ({ ...row, actual: row.actual * 10 })), { priorStrength: 4 });
  assert.deepEqual(first.thresholds, mutated.thresholds);
  assert.equal(first.byLabel.uncertain.players, 8);
  const artifact = backtestPlayerStabilityLabels(rows, { generatedAt: "2026-01-01T00:00:00.000Z", bootstrapDraws: 200, priorStrength: 4, minimumEvaluationClusters: 5 });
  assert.deepEqual(artifact.rolling.map(result => [result.year, result.trainingThroughYear]), [[2023, 2022], [2024, 2023]]);
  assert.match(artifact.labelSemantics.uncertain, /not an assertion of observed volatility/);
  assert.equal(artifact.pooled.clusterBootstrap.resamplingUnit, "player-season, stratified by assigned label");
  assert.ok(artifact.pooled.clusterBootstrap.contrasts.twoTailContrast.interval95[0] > 0);
  assert.equal(artifact.dataQuality.promotionGatePassed, true);
});
