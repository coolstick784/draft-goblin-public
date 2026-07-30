import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadHvpkod } from "./evaluate-hvpkod-history.js";
import { loadWeeklyRangeDataset } from "./load-weekly-range-dataset.js";
import { usableHistoricalRows } from "./backtest-player-performance-ranges.js";

const POSITIONS = ["QB", "RB", "WR", "TE", "K"];
const LABELS = ["stable", "typical", "boom-bust", "uncertain"];
const round = (value, digits = 6) => Number(Number(value).toFixed(digits));
const playerKey = row => `${String(row.name || "").normalize("NFKD").replace(/[^\x00-\x7F]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase()}:${row.position}`;
const quantile = (values, probability) => {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * probability;
  const lower = Math.floor(at), upper = Math.ceil(at), weight = at - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const projectionTier = (projected, bounds) => projected <= bounds[0] ? "low" : projected <= bounds[1] ? "middle" : "high";

function fitTailReference(rows) {
  const tierBounds = {}, positionTails = new Map(), cellTails = new Map();
  for (const position of POSITIONS) {
    const local = rows.filter(row => row.position === position);
    if (!local.length) continue;
    const projections = local.map(row => row.projected);
    tierBounds[position] = [quantile(projections, 1 / 3), quantile(projections, 2 / 3)];
    const residuals = local.map(row => row.actual - row.projected);
    positionTails.set(position, [quantile(residuals, .2), quantile(residuals, .8)]);
    for (const tier of ["low", "middle", "high"]) {
      const cell = local.filter(row => projectionTier(row.projected, tierBounds[position]) === tier);
      const cellResiduals = cell.map(row => row.actual - row.projected);
      const weight = cell.length / (cell.length + 64);
      const parent = positionTails.get(position);
      cellTails.set(`${position}:${tier}`, [0, 1].map(index => weight * quantile(cellResiduals, [.2, .8][index]) + (1 - weight) * parent[index]));
    }
  }
  return { tierBounds, positionTails, cellTails };
}

function tailThresholds(row, reference) {
  const bounds = reference.tierBounds[row.position];
  if (!bounds) return reference.positionTails.get(row.position) || [0, 0];
  return reference.cellTails.get(`${row.position}:${projectionTier(row.projected, bounds)}`) || reference.positionTails.get(row.position);
}

function tailEvent(row, reference) {
  const [lower, upper] = tailThresholds(row, reference), residual = row.actual - row.projected;
  return { lower: residual < lower ? 1 : 0, upper: residual > upper ? 1 : 0, absoluteResidual: Math.abs(residual) };
}

export function buildStabilityLabels(trainingRows, { minimumWeeklyRows = 20, minimumPriorSeasons = 2, priorStrength = 24 } = {}) {
  const reference = fitTailReference(trainingRows), groups = new Map();
  for (const row of trainingRows) {
    const key = playerKey(row), group = groups.get(key) || { key, position: row.position, rows: [], seasons: new Set() };
    group.rows.push(row); group.seasons.add(row.year); groups.set(key, group);
  }
  const profiles = new Map();
  for (const group of groups.values()) {
    const events = group.rows.map(row => tailEvent(row, reference));
    const lowerObserved = mean(events.map(event => event.lower)), upperObserved = mean(events.map(event => event.upper));
    const weight = events.length / (events.length + priorStrength);
    const lowerRate = (1 - weight) * .2 + weight * lowerObserved;
    const upperRate = (1 - weight) * .2 + weight * upperObserved;
    profiles.set(group.key, {
      playerKey: group.key, position: group.position, weeklyRows: events.length, priorSeasons: group.seasons.size,
      reliabilityWeight: weight, lowerTailRate: lowerRate, upperTailRate: upperRate,
      twoTailScore: Math.min(lowerRate, upperRate), stabilityScore: Math.max(lowerRate, upperRate), label: "uncertain"
    });
  }
  const reliable = [...profiles.values()].filter(profile => profile.weeklyRows >= minimumWeeklyRows && profile.priorSeasons >= minimumPriorSeasons);
  const stableThreshold = Math.min(.2, quantile(reliable.map(profile => profile.stabilityScore), .25));
  const boomBustThreshold = Math.max(.2, quantile(reliable.map(profile => profile.twoTailScore), .75));
  for (const profile of reliable) profile.label = profile.twoTailScore >= boomBustThreshold ? "boom-bust" : profile.stabilityScore <= stableThreshold ? "stable" : "typical";
  return { reference, profiles, thresholds: { stableAtOrBelow: stableThreshold, boomBustAtOrAbove: boomBustThreshold }, reliablePlayers: reliable.length };
}

function summarize(rows) {
  const lowerTailRate = mean(rows.map(row => row.lower)), upperTailRate = mean(rows.map(row => row.upper));
  return {
    rows: rows.length, players: new Set(rows.map(row => row.playerKey)).size,
    playerSeasonClusters: new Set(rows.map(row => `${row.year}:${row.playerKey}`)).size,
    lowerTailRate: round(lowerTailRate ?? 0), upperTailRate: round(upperTailRate ?? 0),
    twoTailRate: round(Math.min(lowerTailRate ?? 0, upperTailRate ?? 0)),
    meanAbsoluteResidual: round(mean(rows.map(row => row.absoluteResidual)) ?? 0)
  };
}

function mulberry32(seed) { return () => { let value = seed += 0x6D2B79F5; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; }; }
function percentileInterval(values) { return [round(quantile(values, .025)), round(quantile(values, .975))]; }

function clusterBootstrap(rows, { draws = 2000, seed = 20260722 } = {}) {
  const byLabel = new Map(LABELS.map(label => [label, new Map()]));
  for (const row of rows) {
    const clusters = byLabel.get(row.label), key = `${row.year}:${row.playerKey}`, cluster = clusters.get(key) || [];
    cluster.push(row); clusters.set(key, cluster);
  }
  const random = mulberry32(seed), samples = { lowerTailContrast: [], upperTailContrast: [], twoTailContrast: [], uncertainAbsoluteResidualContrast: [] };
  const drawLabel = label => {
    const clusters = [...byLabel.get(label).values()], sample = [];
    for (let index = 0; index < clusters.length; index++) sample.push(...clusters[Math.floor(random() * clusters.length)]);
    return summarize(sample);
  };
  if (!["stable", "boom-bust"].every(label => byLabel.get(label).size)) return null;
  for (let draw = 0; draw < draws; draw++) {
    const stable = drawLabel("stable"), boomBust = drawLabel("boom-bust");
    const typical = byLabel.get("typical").size ? drawLabel("typical") : null;
    const uncertain = byLabel.get("uncertain").size ? drawLabel("uncertain") : null;
    samples.lowerTailContrast.push(boomBust.lowerTailRate - stable.lowerTailRate);
    samples.upperTailContrast.push(boomBust.upperTailRate - stable.upperTailRate);
    samples.twoTailContrast.push(boomBust.twoTailRate - stable.twoTailRate);
    if (uncertain) {
      const components = [stable, typical, boomBust].filter(Boolean);
      const totalRows = components.reduce((sum, item) => sum + item.rows, 0);
      const reliableAbsoluteResidual = components.reduce((sum, item) => sum + item.rows * item.meanAbsoluteResidual, 0) / totalRows;
      samples.uncertainAbsoluteResidualContrast.push(uncertain.meanAbsoluteResidual - reliableAbsoluteResidual);
    }
  }
  return {
    draws,
    resamplingUnit: "player-season, stratified by assigned label",
    clustersByLabel: Object.fromEntries(LABELS.map(label => [label, byLabel.get(label).size])),
    contrasts: Object.fromEntries(Object.entries(samples).filter(([, values]) => values.length).map(([key, values]) => [key, { mean: round(mean(values)), interval95: percentileInterval(values), probabilityPositive: round(values.filter(value => value > 0).length / values.length) }]))
  };
}

export function evaluateStabilityLabels(trainingRows, testRows, options = {}) {
  const model = buildStabilityLabels(trainingRows, options), observations = [];
  for (const row of testRows) {
    const profile = model.profiles.get(playerKey(row)), event = tailEvent(row, model.reference);
    observations.push({ ...event, year: row.year, playerKey: playerKey(row), label: profile?.label || "uncertain" });
  }
  const byLabel = Object.fromEntries(LABELS.map(label => [label, summarize(observations.filter(row => row.label === label))]));
  const contrasts = {
    lowerTailBoomBustMinusStable: round(byLabel["boom-bust"].lowerTailRate - byLabel.stable.lowerTailRate),
    upperTailBoomBustMinusStable: round(byLabel["boom-bust"].upperTailRate - byLabel.stable.upperTailRate),
    twoTailBoomBustMinusStable: round(byLabel["boom-bust"].twoTailRate - byLabel.stable.twoTailRate)
  };
  return { rows: observations.length, trainingThroughYear: Math.max(...trainingRows.map(row => row.year)), thresholds: { stableAtOrBelow: round(model.thresholds.stableAtOrBelow), boomBustAtOrAbove: round(model.thresholds.boomBustAtOrAbove) }, reliablePlayers: model.reliablePlayers, byLabel, contrasts, observations };
}

export function backtestPlayerStabilityLabels(inputRows, { generatedAt = new Date().toISOString(), bootstrapDraws = 2000, minimumWeeklyRows = 20, minimumPriorSeasons = 2, priorStrength = 24, minimumEvaluationClusters = 25 } = {}) {
  const prepared = usableHistoricalRows(inputRows), activityAware = prepared.rows.some(row => row.activityStatus), rows = activityAware ? prepared.rows.filter(row => row.activityStatus === "active-observed") : prepared.rows, evaluationOptions = { minimumWeeklyRows, minimumPriorSeasons, priorStrength };
  const rolling = [2023, 2024].map(year => {
    const result = evaluateStabilityLabels(rows.filter(row => row.year < year), rows.filter(row => row.year === year), evaluationOptions);
    const { observations, ...metrics } = result;
    return { year, ...metrics };
  });
  const pooledObservations = rolling.flatMap(({ year }) => {
    const result = evaluateStabilityLabels(rows.filter(row => row.year < year), rows.filter(row => row.year === year), evaluationOptions);
    return result.observations;
  });
  const pooled = { byLabel: Object.fromEntries(LABELS.map(label => [label, summarize(pooledObservations.filter(row => row.label === label))])) };
  pooled.contrasts = {
    lowerTailBoomBustMinusStable: round(pooled.byLabel["boom-bust"].lowerTailRate - pooled.byLabel.stable.lowerTailRate),
    upperTailBoomBustMinusStable: round(pooled.byLabel["boom-bust"].upperTailRate - pooled.byLabel.stable.upperTailRate),
    twoTailBoomBustMinusStable: round(pooled.byLabel["boom-bust"].twoTailRate - pooled.byLabel.stable.twoTailRate)
  };
  pooled.clusterBootstrap = clusterBootstrap(pooledObservations, { draws: bootstrapDraws });
  const enoughClusters = ["stable", "boom-bust"].every(label => pooled.byLabel[label].playerSeasonClusters >= minimumEvaluationClusters);
  const rollingDirection = rolling.every(result => result.contrasts.lowerTailBoomBustMinusStable > 0 && result.contrasts.upperTailBoomBustMinusStable > 0);
  const bootstrapSupported = Boolean(pooled.clusterBootstrap?.contrasts.lowerTailContrast.interval95[0] > 0 && pooled.clusterBootstrap?.contrasts.upperTailContrast.interval95[0] > 0);
  const gate = enoughClusters && rollingDirection && bootstrapSupported;
  return {
    schemaVersion: 1, artifactId: "player-stability-label-validation:rolling-2023-2024", generatedAt,
    status: gate ? "accepted-research-signal" : "research-only",
    target: "Future weekly lower- and upper-tail projection residual events, evaluated separately.",
    labelSemantics: {
      stable: "Reliable prior history with low rates in both tails; the larger tail rate determines stability.",
      typical: "Reliable prior history between the stable and boom/bust two-tail thresholds.",
      "boom-bust": "Reliable prior history with an elevated rate in both tails; the weaker tail determines the score.",
      uncertain: "Insufficient prior evidence, including unseen players. This is predictive uncertainty, not an assertion of observed volatility."
    },
    method: "Position and projection-tier 20th/80th residual tails are estimated from prior seasons only. Player tail rates use a Beta-style 20% prior. The larger tail rate determines stability and the weaker tail rate determines boom/bust, keeping one-sided players in the typical group.",
    leakageBoundary: "For each rolling test year, every reference threshold and player label uses only earlier seasons; 2023 uses 2021-2022 and 2024 uses 2021-2023.",
    reliability: { minimumWeeklyRows, minimumPriorSeasons, priorStrength, minimumEvaluationClusters },
    uncertainty: "Confidence intervals resample complete player-season clusters within labels, preserving repeated weekly observations.",
    runtimeBoundary: "Research only. Labels are not promoted unless both future tails separate reliably in every rolling fold and in clustered uncertainty intervals.",
    dataQuality: { excludedMissingOutcomeWeeks: prepared.excludedWeeks, activityAware, performanceRows: rows.length, promotionGatePassed: gate, runtimePromotionGatePassed: false },
    promotionGate: { enoughClusters, rollingDirectionInBothTails: rollingDirection, pooledBothTailBootstrapIntervalsAboveZero: bootstrapSupported },
    rolling, pooled
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const privateInput = "data/private/owned-model/weekly-range-rows.jsonl";
  const input = process.argv[2] || (fs.existsSync(privateInput) ? privateInput : "data/vendor/NFL-Data-main/NFL-data-Players");
  const output = process.argv[3] || "data/research/player-stability-label-validation.json";
  const artifact = backtestPlayerStabilityLabels(input.endsWith(".jsonl") ? loadWeeklyRangeDataset(input) : loadHvpkod(input));
  fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ output, status: artifact.status, promotionGate: artifact.promotionGate, rolling: artifact.rolling, pooled: artifact.pooled }, null, 2));
}
