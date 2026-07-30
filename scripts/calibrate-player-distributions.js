import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadHvpkod } from "./evaluate-hvpkod-history.js";
import { QUANTILE_V1_PROBABILITIES } from "../shared/player-distribution.js";

export const ARTIFACT_VERSION = "quantile-v1";
// Kept identical to shared/player-distribution.js so an aggregated template can
// be mapped without resampling probabilities or silently changing its schema.
export const PROBABILITIES = [...QUANTILE_V1_PROBABILITIES];
const POSITIONS = ["QB", "RB", "WR", "TE", "K"];
const BUCKET_NAMES = ["low", "middle", "high"];
const round = (value, digits = 6) => Number(Number(value).toFixed(digits));
const quantileKey = probability => `p${String(Math.round(probability * 100)).padStart(2, "0")}`;

function empiricalQuantile(sorted, probability) {
  if (!sorted.length) return 0;
  const offset = (sorted.length - 1) * probability;
  const lower = Math.floor(offset), upper = Math.ceil(offset), weight = offset - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return PROBABILITIES.map(probability => empiricalQuantile(sorted, probability));
}

function interpolate(grid, probability) {
  if (probability <= PROBABILITIES[0]) return grid[0];
  if (probability >= PROBABILITIES.at(-1)) return grid.at(-1);
  const upper = PROBABILITIES.findIndex(value => value >= probability), lower = upper - 1;
  const weight = (probability - PROBABILITIES[lower]) / (PROBABILITIES[upper] - PROBABILITIES[lower]);
  return grid[lower] * (1 - weight) + grid[upper] * weight;
}

function weightedGrid(localValues, ancestors, shrinkage) {
  const local = quantiles(localValues), localWeight = localValues.length / (localValues.length + shrinkage);
  let grid = local.map((value, index) => localWeight * value + (1 - localWeight) * ancestors[0][index]);
  // Blending quantile functions preserves monotonicity. Each successive prior only
  // receives the uncertainty left after the more-specific level was estimated.
  for (let index = 1; index < ancestors.length; index++) {
    const ancestorWeight = shrinkage / (shrinkage + localValues.length + index * shrinkage);
    grid = grid.map((value, q) => (1 - ancestorWeight) * value + ancestorWeight * ancestors[index][q]);
  }
  return { grid, localWeight };
}

function blendRate(rows, ancestors, shrinkage) {
  const localRate = rows.length ? rows.filter(row => row.actual <= 0).length / rows.length : ancestors[0];
  const localWeight = rows.length / (rows.length + shrinkage);
  let rate = localWeight * localRate + (1 - localWeight) * ancestors[0];
  for (let index = 1; index < ancestors.length; index++) {
    const ancestorWeight = shrinkage / (shrinkage + rows.length + index * shrinkage);
    rate = (1 - ancestorWeight) * rate + ancestorWeight * ancestors[index];
  }
  return { rate, localRate, localWeight };
}

function boundaries(rows, position) {
  const projected = rows.filter(row => row.position === position).map(row => row.projected).sort((a, b) => a - b);
  return [empiricalQuantile(projected, 1 / 3), empiricalQuantile(projected, 2 / 3)];
}

function bucketFor(projected, [lower, upper]) {
  return projected <= lower ? "low" : projected <= upper ? "middle" : "high";
}

function positiveResiduals(rows) {
  return rows.filter(row => row.actual > 0).map(row => row.actual - row.projected);
}

function rate(rows) {
  return rows.length ? rows.filter(row => row.actual <= 0).length / rows.length : 0;
}

function objectGrid(grid) {
  return Object.fromEntries(PROBABILITIES.map((probability, index) => [quantileKey(probability), round(grid[index], 4)]));
}

export function fitDistribution(rows, { shrinkage = 150 } = {}) {
  if (!rows.length) throw new Error("At least one training row is required");
  const leaguePositive = positiveResiduals(rows), leagueGrid = quantiles(leaguePositive), leagueRate = rate(rows);
  const bucketBoundaries = Object.fromEntries(POSITIONS.filter(position => rows.some(row => row.position === position)).map(position => [position, boundaries(rows, position)]));
  const positionPriors = {}, positionBucketPriors = {};
  for (const position of Object.keys(bucketBoundaries)) {
    const positionRows = rows.filter(row => row.position === position), positionValues = positiveResiduals(positionRows);
    positionPriors[position] = {
      rows: positionRows.length,
      zeroOutcomeProbability: rate(positionRows),
      grid: weightedGrid(positionValues, [leagueGrid], shrinkage).grid
    };
    for (const bucket of BUCKET_NAMES) {
      const bucketRows = positionRows.filter(row => bucketFor(row.projected, bucketBoundaries[position]) === bucket);
      positionBucketPriors[`${position}:${bucket}`] = {
        rows: bucketRows.length,
        zeroOutcomeProbability: blendRate(bucketRows, [positionPriors[position].zeroOutcomeProbability, leagueRate], shrinkage).rate,
        grid: weightedGrid(positiveResiduals(bucketRows), [positionPriors[position].grid, leagueGrid], shrinkage).grid
      };
    }
  }

  const cells = {};
  for (const source of [...new Set(rows.map(row => row.sourceId))].sort()) {
    for (const position of Object.keys(bucketBoundaries)) {
      for (const bucket of BUCKET_NAMES) {
        const cellRows = rows.filter(row => row.sourceId === source && row.position === position && bucketFor(row.projected, bucketBoundaries[position]) === bucket);
        if (!cellRows.length) continue;
        const bucketPrior = positionBucketPriors[`${position}:${bucket}`], positionPrior = positionPriors[position];
        const residual = weightedGrid(positiveResiduals(cellRows), [bucketPrior.grid, positionPrior.grid, leagueGrid], shrinkage);
        const zero = blendRate(cellRows, [bucketPrior.zeroOutcomeProbability, positionPrior.zeroOutcomeProbability, leagueRate], shrinkage);
        const key = `${source}:${position}:${bucket}`;
        cells[key] = {
          source, position, projectionBucket: bucket,
          projectionBounds: bucket === "low" ? [null, round(bucketBoundaries[position][0], 4)] : bucket === "middle" ? [round(bucketBoundaries[position][0], 4), round(bucketBoundaries[position][1], 4)] : [round(bucketBoundaries[position][1], 4), null],
          rows: cellRows.length,
          positiveOutcomeRows: cellRows.filter(row => row.actual > 0).length,
          empiricalZeroOutcomeRate: round(zero.localRate),
          zeroOutcomeProbability: round(zero.rate),
          localEvidenceWeight: round(Math.min(residual.localWeight, zero.localWeight)),
          conditionalPositiveResidualQuantiles: objectGrid(residual.grid)
        };
      }
    }
  }
  return {
    cells,
    priors: {
      league: { rows: rows.length, zeroOutcomeProbability: round(leagueRate), conditionalPositiveResidualQuantiles: objectGrid(leagueGrid) },
      position: Object.fromEntries(Object.entries(positionPriors).map(([position, prior]) => [position, { rows: prior.rows, zeroOutcomeProbability: round(prior.zeroOutcomeProbability), conditionalPositiveResidualQuantiles: objectGrid(prior.grid) }])),
      positionBucket: Object.fromEntries(Object.entries(positionBucketPriors).map(([key, prior]) => [key, { rows: prior.rows, zeroOutcomeProbability: round(prior.zeroOutcomeProbability), conditionalPositiveResidualQuantiles: objectGrid(prior.grid) }]))
    },
    bucketBoundaries
  };
}

function cellFor(row, model) {
  const limits = model.bucketBoundaries[row.position];
  return limits && model.cells[`${row.sourceId}:${row.position}:${bucketFor(row.projected, limits)}`];
}

function gridFromObject(value) {
  return PROBABILITIES.map(probability => value[quantileKey(probability)]);
}

export function predictedQuantile(row, cell, probability) {
  const zero = cell.zeroOutcomeProbability;
  if (probability <= zero) return 0;
  const conditionalProbability = (probability - zero) / (1 - zero);
  return Math.max(0, row.projected + interpolate(gridFromObject(cell.conditionalPositiveResidualQuantiles), conditionalProbability));
}

function pinball(actual, predicted, probability) {
  const error = actual - predicted;
  return error >= 0 ? probability * error : (probability - 1) * error;
}

function intervalScore(actual, lower, upper, alpha) {
  return upper - lower + (actual < lower ? (2 / alpha) * (lower - actual) : 0) + (actual > upper ? (2 / alpha) * (actual - upper) : 0);
}

export function scoreDistribution(rows, model) {
  const eligible = rows.map(row => ({ row, cell: cellFor(row, model) })).filter(item => item.cell);
  if (!eligible.length) return { rows: 0 };
  const perProbability = Object.fromEntries(PROBABILITIES.map(probability => {
    const loss = eligible.reduce((sum, { row, cell }) => sum + pinball(row.actual, predictedQuantile(row, cell, probability), probability), 0) / eligible.length;
    return [quantileKey(probability), round(loss)];
  }));
  const intervals = [[0.1, 0.05, 0.95], [0.2, 0.1, 0.9], [0.5, 0.25, 0.75]];
  const coverage = {}, intervalScores = {};
  for (const [nominalAlpha, lowP, highP] of intervals) {
    let covered = 0, totalScore = 0;
    for (const { row, cell } of eligible) {
      const lower = predictedQuantile(row, cell, lowP), upper = predictedQuantile(row, cell, highP);
      if (row.actual >= lower && row.actual <= upper) covered++;
      totalScore += intervalScore(row.actual, lower, upper, nominalAlpha);
    }
    coverage[`${Math.round((1 - nominalAlpha) * 100)}pct`] = round(covered / eligible.length);
    intervalScores[`${Math.round((1 - nominalAlpha) * 100)}pct`] = totalScore / eligible.length;
  }
  const medianLoss = perProbability.p50;
  const wis = (0.5 * medianLoss * 2 + intervals.reduce((sum, [alpha], index) => sum + (alpha / 2) * Object.values(intervalScores)[index], 0)) / (intervals.length + 0.5);
  // CRPS = 2 * integral of quantile loss. Trapezoidal integration over the
  // exported grid is deterministic and directly comparable across versions.
  let crps = 0;
  for (let index = 1; index < PROBABILITIES.length; index++) {
    const width = PROBABILITIES[index] - PROBABILITIES[index - 1];
    crps += width * (perProbability[quantileKey(PROBABILITIES[index - 1])] + perProbability[quantileKey(PROBABILITIES[index])]);
  }
  return { rows: eligible.length, pinballLoss: perProbability, weightedIntervalScore: round(wis), crpsApproximation: round(crps), empiricalCoverage: coverage, actualZeroOutcomeRate: round(rate(eligible.map(item => item.row))) };
}

export function calibratePlayerDistributions(rows, options = {}) {
  const minimumYear = options.minimumYear ?? 2021;
  const candidates = rows.filter(row => row.year >= minimumYear && Number.isFinite(row.projected) && row.projected > 0 && Number.isFinite(row.actual) && row.sourceId && row.position);
  // The vendor history contains a few nominal weeks whose outcome column is
  // entirely (or almost entirely) zero. They are missing-outcome payloads, not
  // real league-wide shutouts, and must not teach the point-mass component.
  const maximumWeeklyZeroRate = options.maximumWeeklyZeroRate ?? 0.65;
  const weekGroups = new Map();
  for (const row of candidates) {
    const key = `${row.year}:${row.week}`;
    if (!weekGroups.has(key)) weekGroups.set(key, []);
    weekGroups.get(key).push(row);
  }
  const excludedWeeks = [...weekGroups.entries()].map(([key, group]) => ({ key, rows: group.length, zeroOutcomeRate: rate(group) })).filter(group => group.zeroOutcomeRate > maximumWeeklyZeroRate).sort((left, right) => {
    const [leftYear, leftWeek] = left.key.split(":").map(Number), [rightYear, rightWeek] = right.key.split(":").map(Number);
    return leftYear - rightYear || leftWeek - rightWeek;
  });
  const excludedKeys = new Set(excludedWeeks.map(group => group.key));
  const usable = candidates.filter(row => !excludedKeys.has(`${row.year}:${row.week}`));
  const years = [...new Set(usable.map(row => row.year))].sort((a, b) => a - b);
  if (years.length < 3) throw new Error("Three chronological seasons are required for train, validation, and holdout");
  const validationYear = options.validationYear ?? years.at(-2), holdoutYear = options.holdoutYear ?? years.at(-1);
  const trainRows = usable.filter(row => row.year < validationYear), validationRows = usable.filter(row => row.year === validationYear), holdoutRows = usable.filter(row => row.year === holdoutYear);
  if (!trainRows.length || !validationRows.length || !holdoutRows.length) throw new Error("Chronological split produced an empty partition");
  const shrinkage = options.shrinkage ?? 150;
  const validationModel = fitDistribution(trainRows, { shrinkage });
  const finalRows = [...trainRows, ...validationRows], finalModel = fitDistribution(finalRows, { shrinkage });
  const observedWeeks = year => new Set(usable.filter(row => row.year === year).map(row => row.week)).size;
  const candidateWeeks = year => new Set(candidates.filter(row => row.year === year).map(row => row.week)).size;
  const holdoutWeekFraction = observedWeeks(holdoutYear) / candidateWeeks(holdoutYear);
  return {
    schemaVersion: ARTIFACT_VERSION,
    artifactKind: "weekly-residual-calibration",
    artifactId: `player-weekly-residual-calibration:${ARTIFACT_VERSION}:${minimumYear}-${validationYear}`,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    status: "research-not-runtime-wired",
    distribution: {
      unit: "weekly-ppr-fantasy-points",
      mixture: "point-mass-at-zero plus conditional-positive empirical residual quantile function",
      residualDefinition: "actual weekly points minus pre-week projected points, conditional on actual points > 0",
      warning: "These are weekly conditional residuals. Do not add them directly to season projections or confuse them with aggregated season residual quantiles.",
      probabilities: PROBABILITIES,
      zeroOutcomeMeaning: "Observed zero fantasy points; it is not asserted to be an inactive-game probability."
    },
    playerSchemaMapping: {
      targetSchemaVersion: "quantile-v1",
      fixedProbabilityGrid: PROBABILITIES,
      instructions: [
        "Select the source/position/projection-strength cell using its frozen bounds.",
        "Keep zeroOutcomeProbability as calibration metadata; do not copy it into a player distribution or treat it as injury/availability probability.",
        "Combine conditional weekly draws across the player's season only after adding a separately calibrated role/availability process and any approved correlations.",
        "Take season-total quantiles at the fixed grid and emit them as [{p,value}] with unit season-fantasy-points and conditionedOn active-role.",
        "Set provenance.calibrationId to this artifactId and retain source snapshot identifiers."
      ]
    },
    methodology: {
      leakageBoundary: "Only rows strictly before a scored season fit that season's model. Outcomes never enter their own forecasts.",
      hierarchy: "source + position + projection-strength bucket -> position bucket -> position -> league",
      shrinkagePseudoRows: shrinkage,
      projectionBuckets: "Position-specific training tertiles, frozen before validation/holdout scoring.",
      scoring: "Pinball loss, weighted interval score, empirical central-interval coverage, and trapezoidal quantile-loss CRPS approximation."
    },
    dataQuality: {
      maximumAcceptedWeeklyZeroOutcomeRate: maximumWeeklyZeroRate,
      excludedMissingOutcomeWeeks: excludedWeeks.map(group => ({ year: Number(group.key.split(":")[0]), week: Number(group.key.split(":")[1]), rows: group.rows, zeroOutcomeRate: round(group.zeroOutcomeRate) })),
      holdoutWeeksRetained: observedWeeks(holdoutYear),
      holdoutWeeksPresent: candidateWeeks(holdoutYear),
      holdoutWeekFraction: round(holdoutWeekFraction),
      promotionGatePassed: holdoutWeekFraction >= 0.75,
      warning: holdoutWeekFraction >= 0.75 ? null : "Too few holdout weeks have credible outcomes for production promotion; metrics are research evidence only."
    },
    chronologicalSplit: {
      availableYears: years,
      trainingYears: years.filter(year => year < validationYear),
      validationYear,
      holdoutYear,
      rows: { training: trainRows.length, validation: validationRows.length, finalFit: finalRows.length, holdout: holdoutRows.length },
      finalFitIncludes: `training seasons plus validation season ${validationYear}`,
      finalFitExcludes: `untouched holdout season ${holdoutYear}`
    },
    validationMetrics: scoreDistribution(validationRows, validationModel),
    holdoutMetrics: scoreDistribution(holdoutRows, finalModel),
    model: finalModel
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2] || "data/vendor/NFL-Data-main/NFL-data-Players";
  const output = process.argv[3] || "data/research/player-weekly-distributions-quantile-v1.json";
  const artifact = calibratePlayerDistributions(loadHvpkod(input));
  fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ output, schemaVersion: artifact.schemaVersion, split: artifact.chronologicalSplit, cells: Object.keys(artifact.model.cells).length, validationMetrics: artifact.validationMetrics, holdoutMetrics: artifact.holdoutMetrics }, null, 2));
}
