import crypto from "node:crypto";
import { OWNED_OVERLAY_CLOSENESS_LIMITS } from "./overlay-policy.js";

const FORMATS = ["STD", "HALF", "PPR"];
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
const SOURCES = ["espn", "sleeper", "fantasyPros"];
const ADAPTIVE_DEVELOPMENT_SEASONS = new Set([2023, 2024, 2025]);
const FIRST_PROSPECTIVE_SEASON = 2026;
const finite = value => Number.isFinite(Number(value));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index), upper = Math.ceil(index), fraction = index - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
};
const ranks = values => {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i + 1;
    while (j < order.length && order[j].value === order[i].value) j += 1;
    const rank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k += 1) result[order[k].index] = rank;
    i = j;
  }
  return result;
};
const correlation = (a, b) => {
  if (a.length < 2) return null;
  const ma = mean(a), mb = mean(b);
  const numerator = a.reduce((sum, value, index) => sum + (value - ma) * (b[index] - mb), 0);
  const da = Math.sqrt(a.reduce((sum, value) => sum + (value - ma) ** 2, 0));
  const db = Math.sqrt(b.reduce((sum, value) => sum + (value - mb) ** 2, 0));
  return da && db ? numerator / (da * db) : null;
};
const spearman = (a, b) => correlation(ranks(a), ranks(b));
const standardDeviation = values => {
  if (values.length < 2) return 1;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)) || 1;
};
function rng(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function metrics(rows, key) {
  const errors = rows.map(row => Number(row[key]) - Number(row.actual));
  return {
    rows: rows.length,
    mae: mean(errors.map(Math.abs)),
    rmse: Math.sqrt(mean(errors.map(value => value ** 2))),
    bias: mean(errors),
    spearman: spearman(rows.map(row => Number(row[key])), rows.map(row => Number(row.actual))),
  };
}
function clusteredInterval(rows, iterations = 10000, seed = 20260715, challengerKey = "candidate", baselineKey = "consensus", claimAlpha = .0125, clusterMode = "player") {
  const clusters = new Map();
  for (const row of rows) {
    const key = clusterMode === "team"
      ? row.teamClusterId || `${row.season}:${row.team || row.playerId}`
      : row.playerClusterId || `${row.season}:${row.playerId}`;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(row);
  }
  const groups = [...clusters.values()], random = rng(seed), deltas = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = Array.from({ length: groups.length }, () => groups[Math.floor(random() * groups.length)]).flat();
    deltas.push(mean(sample.map(row =>
      Math.abs(Number(row[challengerKey]) - Number(row.actual))
      - Math.abs(Number(row[baselineKey]) - Number(row.actual))
    )));
  }
  return {
    iterations,
    lower: quantile(deltas, claimAlpha / 2),
    upper: quantile(deltas, 1 - claimAlpha / 2),
    probabilityBetter: deltas.filter(value => value < 0).length / deltas.length,
    simultaneousInference: {
      familywiseAlpha: .05,
      claims: 4,
      perClaimAlpha: claimAlpha,
      correction: "Bonferroni",
    },
    clusterMode,
  };
}
function conservativeDualClusterInterval(rows, iterations, seed, challengerKey, baselineKey = "consensus") {
  const player = clusteredInterval(rows, iterations, seed, challengerKey, baselineKey, .0125, "player");
  const team = clusteredInterval(rows, iterations, seed + 1000, challengerKey, baselineKey, .0125, "team");
  return {
    iterations,
    lower: Math.min(player.lower, team.lower),
    upper: Math.max(player.upper, team.upper),
    probabilityBetter: Math.min(player.probabilityBetter, team.probabilityBetter),
    clustering: "conservative-dual-player-and-team-season",
    player,
    team,
    simultaneousInference: player.simultaneousInference,
  };
}
function validateRows(rows) {
  const seen = new Set();
  if (!Array.isArray(rows) || !rows.length) throw new Error("Promotion evidence contains no projection rows.");
  for (const row of rows) {
    if (!row || !row.playerId || !finite(row.candidate) || !finite(row.ownedProjection)
        || !finite(row.consensus) || !finite(row.actual)) {
      throw new Error("Promotion evidence contains an invalid projection row.");
    }
    if (!FORMATS.includes(row.scoring) || !POSITIONS.includes(row.position)
        || !Number.isInteger(Number(row.season))) {
      throw new Error("Promotion evidence contains an invalid season, scoring format, or position.");
    }
    for (const [source, value] of Object.entries(row.sourceProjections || {})) {
      if (!SOURCES.includes(source) || !finite(value)) {
        throw new Error("Promotion evidence contains an invalid private source projection.");
      }
    }
    const key = `${row.season}:${row.scoring}:${row.playerId}`;
    if (seen.has(key)) throw new Error(`Duplicate promotion row: ${key}`);
    seen.add(key);
    if (row.featureMaxObservedAt && row.cutoffAt
        && Date.parse(row.featureMaxObservedAt) > Date.parse(row.cutoffAt)) {
      throw new Error(`Temporal leakage detected for ${key}.`);
    }
  }
}

function evaluateForecast({ rows, key, label, iterations, seed }) {
  const reasons = [];
  const forecast = metrics(rows, key);
  const consensus = metrics(rows, "consensus");
  const relativeImprovement = (consensus.mae - forecast.mae) / consensus.mae;
  const pairedInterval = conservativeDualClusterInterval(rows, iterations, seed, key);
  if (relativeImprovement < .02) reasons.push(`${label} does not improve consensus MAE by at least 2%.`);
  if (pairedInterval.upper >= 0) reasons.push(`${label} paired clustered 95% interval does not establish improvement.`);
  if (forecast.rmse > consensus.rmse) reasons.push(`${label} RMSE is worse than consensus.`);
  if (Math.abs(forecast.bias) > Math.max(2, Math.abs(consensus.bias))) reasons.push(`${label} bias exceeds the allowed bound.`);
  if (forecast.spearman < consensus.spearman - .01) reasons.push(`${label} outcome rank correlation regresses by more than 0.01.`);

  const individualSources = {};
  for (const [source, sourceIndex] of SOURCES.map((source, index) => [source, index])) {
    const selected = rows.filter(row => finite(row.sourceProjections?.[source]));
    if (selected.length < 50) {
      reasons.push(`Insufficient private ${source} evidence to establish ${label.toLowerCase()} individual-source superiority.`);
      individualSources[source] = { rows: selected.length, evaluable: false };
      continue;
    }
    const sourceRows = selected.map(row => ({ ...row, sourceProjection: Number(row.sourceProjections[source]) }));
    const forecastMetrics = metrics(sourceRows, key);
    const sourceMetrics = metrics(sourceRows, "sourceProjection");
    const sourceImprovement = (sourceMetrics.mae - forecastMetrics.mae) / sourceMetrics.mae;
    const sourceInterval = conservativeDualClusterInterval(sourceRows, iterations, seed + sourceIndex + 1, key, "sourceProjection");
    if (sourceImprovement < .01) reasons.push(`${label} does not improve ${source} MAE by at least 1%.`);
    if (sourceInterval.upper >= 0) reasons.push(`${label} interval does not establish improvement over ${source}.`);
    if (forecastMetrics.rmse > sourceMetrics.rmse) reasons.push(`${label} RMSE is worse than ${source}.`);
    if (forecastMetrics.spearman < sourceMetrics.spearman - .01) reasons.push(`${label} rank correlation regresses by more than 0.01 versus ${source}.`);
    const formatCoverage = Object.fromEntries(FORMATS.map(scoring => [
      scoring,
      sourceRows.filter(row => row.scoring === scoring).length,
    ]));
    for (const scoring of FORMATS) {
      if (formatCoverage[scoring] < 10) {
        reasons.push(`Insufficient ${source} ${scoring} evidence for ${label.toLowerCase()} superiority.`);
      }
    }
    const sourceSlices = [];
    for (const scoring of FORMATS) for (const position of POSITIONS) {
      const slice = sourceRows.filter(row => row.scoring === scoring && row.position === position);
      if (slice.length < 10) continue;
      const sliceForecast = metrics(slice, key), sliceSource = metrics(slice, "sourceProjection");
      const regression = (sliceForecast.mae - sliceSource.mae) / sliceSource.mae;
      sourceSlices.push({ scoring, position, candidate: sliceForecast, source: sliceSource, regression });
      if (regression > .03) {
        reasons.push(`${label} ${source} ${scoring} ${position} MAE regresses by more than 3%.`);
      }
    }
    individualSources[source] = {
      rows: selected.length,
      evaluable: true,
      candidate: forecastMetrics,
      source: sourceMetrics,
      relativeImprovement: sourceImprovement,
      pairedInterval: sourceInterval,
      formatCoverage,
      slices: sourceSlices,
    };
  }

  const slices = [];
  for (const scoring of FORMATS) for (const position of POSITIONS) {
    const selected = rows.filter(row => row.scoring === scoring && row.position === position);
    if (selected.length < 25) continue;
    const candidate = metrics(selected, key), baseline = metrics(selected, "consensus");
    const regression = (candidate.mae - baseline.mae) / baseline.mae;
    slices.push({ scoring, position, candidate, consensus: baseline, regression });
    if (regression > .03) reasons.push(`${label} ${scoring} ${position} MAE regresses by more than 3%.`);
  }
  const seasons = [...new Set(rows.map(row => Number(row.season)))].sort();
  const seasonSlices = [];
  for (const season of seasons) for (const scoring of FORMATS) for (const position of POSITIONS) {
    const selected = rows.filter(row =>
      Number(row.season) === season && row.scoring === scoring && row.position === position
    );
    if (selected.length < 10) continue;
    const candidate = metrics(selected, key), baseline = metrics(selected, "consensus");
    const regression = (candidate.mae - baseline.mae) / baseline.mae;
    seasonSlices.push({ season, scoring, position, candidate, consensus: baseline, regression });
    if (regression > .03) reasons.push(`${label} ${season} ${scoring} ${position} MAE regresses by more than 3%.`);
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    forecast,
    consensus,
    relativeImprovement,
    pairedInterval,
    individualSources,
    slices,
    seasonSlices,
  };
}

export function evaluateOwnedPromotion({ rows, prospectiveShadowSeasons = [], iterations = 10000, seed = 20260715 }) {
  validateRows(rows);
  const structuralReasons = [];
  const seasons = [...new Set(rows.map(row => Number(row.season)))].sort();
  const prospective = [...new Set(prospectiveShadowSeasons.map(Number))];
  const formats = [...new Set(rows.map(row => row.scoring))];
  const positions = [...new Set(rows.map(row => row.position))];
  if (seasons.length < 3) structuralReasons.push("At least three completed timestamped preseason seasons are required.");
  if (prospective.length < 3) structuralReasons.push("At least three completed prospective shadow seasons are required.");
  for (const season of seasons) {
    if (ADAPTIVE_DEVELOPMENT_SEASONS.has(season)) {
      structuralReasons.push(`Adaptive development season ${season} cannot count as promotion evidence.`);
    }
  }
  for (const season of prospective) {
    if (!seasons.includes(season)) structuralReasons.push(`Prospective shadow season ${season} has no paired evidence rows.`);
    if (season < FIRST_PROSPECTIVE_SEASON) {
      structuralReasons.push(`Prospective shadow season ${season} predates the 2026 prospective evidence boundary.`);
    }
    if (ADAPTIVE_DEVELOPMENT_SEASONS.has(season)) {
      structuralReasons.push(`Adaptive development season ${season} cannot be declared prospective.`);
    }
  }
  for (const format of FORMATS) if (!formats.includes(format)) structuralReasons.push(`Missing ${format} evidence.`);
  for (const position of POSITIONS) if (!positions.includes(position)) structuralReasons.push(`Missing ${position} evidence.`);

  const overlay = evaluateForecast({
    rows,
    key: "candidate",
    label: "Candidate",
    iterations,
    seed,
  });
  const independentOwned = evaluateForecast({
    rows,
    key: "ownedProjection",
    label: "Independent owned forecast",
    iterations,
    seed: seed + 100,
  });

  const deviations = [];
  for (const scoring of FORMATS) for (const position of POSITIONS) {
    const selected = rows.filter(row => row.scoring === scoring && row.position === position);
    const scale = standardDeviation(selected.map(row => Number(row.consensus)));
    for (const row of selected) deviations.push(Math.abs(Number(row.candidate) - Number(row.consensus)) / scale);
  }
  const closeness = {
    spearman: spearman(rows.map(row => Number(row.candidate)), rows.map(row => Number(row.consensus))),
    medianStandardizedDistance: quantile(deviations, .5),
    p90StandardizedDistance: quantile(deviations, .9),
  };
  const closenessReasons = [];
  if (closeness.spearman < OWNED_OVERLAY_CLOSENESS_LIMITS.minimumSpearman) closenessReasons.push("Candidate rank correlation with consensus is below 0.95.");
  if (closeness.medianStandardizedDistance > OWNED_OVERLAY_CLOSENESS_LIMITS.maximumMedianStandardizedDistance) closenessReasons.push("Median standardized consensus distance exceeds 0.20.");
  if (closeness.p90StandardizedDistance > OWNED_OVERLAY_CLOSENESS_LIMITS.maximumP90StandardizedDistance) closenessReasons.push("90th-percentile standardized consensus distance exceeds 0.50.");

  const reasons = [...structuralReasons, ...independentOwned.reasons];
  const overlayEligible = structuralReasons.length === 0
    && overlay.reasons.length === 0
    && closenessReasons.length === 0;
  const independentOwnedEligible = structuralReasons.length === 0
    && independentOwned.reasons.length === 0;
  return {
    schemaVersion: 2,
    gateVersion: 2,
    evaluationTarget: "pure-independent-owned",
    evaluationOnly: true,
    autoPromoted: false,
    eligible: independentOwnedEligible,
    replacementEligible: independentOwnedEligible,
    overlayEligible,
    independentOwnedEligible,
    reasons,
    seasons,
    prospectiveShadowSeasons: prospective,
    candidate: overlay.forecast,
    consensus: overlay.consensus,
    relativeImprovement: overlay.relativeImprovement,
    pairedInterval: overlay.pairedInterval,
    individualSources: overlay.individualSources,
    closeness,
    slices: overlay.slices,
    seasonSlices: overlay.seasonSlices,
    independentOwned: {
      eligible: independentOwnedEligible,
      reasons: [...structuralReasons, ...independentOwned.reasons],
      forecast: independentOwned.forecast,
      consensus: independentOwned.consensus,
      relativeImprovement: independentOwned.relativeImprovement,
      pairedInterval: independentOwned.pairedInterval,
      individualSources: independentOwned.individualSources,
      slices: independentOwned.slices,
      seasonSlices: independentOwned.seasonSlices,
    },
    overlayDiagnostic: {
      eligible: overlayEligible,
      nonAuthorizing: true,
      reasons: [...structuralReasons, ...overlay.reasons, ...closenessReasons],
      candidate: overlay.forecast,
      consensus: overlay.consensus,
      relativeImprovement: overlay.relativeImprovement,
      pairedInterval: overlay.pairedInterval,
      individualSources: overlay.individualSources,
      closeness,
      slices: overlay.slices,
      seasonSlices: overlay.seasonSlices,
    },
  };
}

export const sha256 = value => {
  const payload = typeof value === "string"
    ? value
    : Buffer.isBuffer(value) || ArrayBuffer.isView(value)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : JSON.stringify(value);
  return crypto.createHash("sha256").update(payload).digest("hex");
};

export function verifyOwnedPromotion({ candidateBytes, evidenceBytes, modelId, season, policy }) {
  const record = policy?.models?.find(row => row.id === modelId);
  const candidateSha256 = sha256(candidateBytes), evidenceSha256 = sha256(evidenceBytes), reasons = [];
  let evidence = null;
  try {
    evidence = JSON.parse(Buffer.isBuffer(evidenceBytes) ? evidenceBytes.toString("utf8") : String(evidenceBytes));
  } catch {
    reasons.push("Promotion evidence is not valid JSON.");
  }
  if (!record) reasons.push("Model is absent from projection-model policy.");
  else {
    if (record.status !== "promoted" || record.eligibleForRuntime !== true) reasons.push("Model is not explicitly promoted for runtime.");
    if (record.candidateSha256 !== candidateSha256) reasons.push("Candidate digest does not match promotion policy.");
    if (record.evidenceSha256 !== evidenceSha256) reasons.push("Evidence digest does not match promotion policy.");
    if (record.season != null && Number(record.season) !== Number(season)) reasons.push("Promotion policy is for a different season.");
    if (record.requireIndependentOwnedSuperiority !== true
        || record.promotionCandidateKind !== "pure-independent-owned"
        || Number(record.promotionGateVersion) !== 2) {
      reasons.push("Promotion policy does not pin the independent-owned gate.");
    }
  }
  if (evidence) {
    const prospective = Array.isArray(evidence.prospectiveShadowSeasons)
      ? [...new Set(evidence.prospectiveShadowSeasons.map(Number))]
      : [];
    const sourceEvidence = Array.isArray(evidence.sourceEvidence) ? evidence.sourceEvidence : [];
    const sourceSeasons = [...new Set(sourceEvidence.map(source => Number(source.season)))];
    const validDigest = value => /^[a-f0-9]{64}$/.test(String(value || ""));
    const completeSourceEvidence = sourceEvidence.length >= 3
      && sourceEvidence.every(source =>
        Number.isInteger(Number(source.season))
        && Number(source.season) >= FIRST_PROSPECTIVE_SEASON
        && !ADAPTIVE_DEVELOPMENT_SEASONS.has(Number(source.season))
        && validDigest(source.ledgerSha256)
        && validDigest(source.receiptSha256)
        && validDigest(source.outcomesSha256)
        && validDigest(source.ownedCandidateSha256)
        && validDigest(source.finalRefreshManifestSha256)
        && source.modelRecipeSha256 === evidence.modelRecipeSha256
        && source.trainingProjectionSourcePolicySha256
          === evidence.trainingProjectionSourcePolicySha256
      );
    const independent = evidence.independentOwned;
    const providerResults = independent?.individualSources;
    const metricSet = value =>
      Number.isFinite(Number(value?.mae))
      && Number.isFinite(Number(value?.rmse))
      && Number.isFinite(Number(value?.bias))
      && Number.isFinite(Number(value?.spearman));
    const globalGuardsPass = metricSet(independent?.forecast)
      && metricSet(independent?.consensus)
      && Number(independent.forecast.rmse) <= Number(independent.consensus.rmse)
      && Math.abs(Number(independent.forecast.bias))
        <= Math.max(2, Math.abs(Number(independent.consensus.bias)))
      && Number(independent.forecast.spearman) >= Number(independent.consensus.spearman) - .01;
    const completeSlices = Array.isArray(independent?.slices)
      && independent.slices.length === FORMATS.length * POSITIONS.length
      && independent.slices.every(slice =>
        FORMATS.includes(slice.scoring)
        && POSITIONS.includes(slice.position)
        && metricSet(slice.candidate)
        && metricSet(slice.consensus)
        && Number(slice.regression) <= .03
      );
    const completeSeasonSlices = Array.isArray(independent?.seasonSlices)
      && prospective.every(prospectiveSeason =>
        FORMATS.every(scoring =>
          POSITIONS.every(position =>
            independent.seasonSlices.some(slice =>
              Number(slice.season) === prospectiveSeason
              && slice.scoring === scoring
              && slice.position === position
              && metricSet(slice.candidate)
              && metricSet(slice.consensus)
              && Number(slice.regression) <= .03
            )
          )
        )
      );
    const completeIndependentMetrics = independent?.eligible === true
      && Array.isArray(independent.reasons)
      && independent.reasons.length === 0
      && globalGuardsPass
      && Number(independent.relativeImprovement) >= .02
      && Number(independent.pairedInterval?.upper) < 0
      && completeSlices
      && completeSeasonSlices
      && SOURCES.every(source =>
        providerResults?.[source]?.evaluable === true
        && metricSet(providerResults[source].candidate)
        && metricSet(providerResults[source].source)
        && Number(providerResults[source].relativeImprovement) >= .01
        && Number(providerResults[source].pairedInterval?.upper) < 0
        && Number(providerResults[source].candidate.rmse) <= Number(providerResults[source].source.rmse)
        && Number(providerResults[source].candidate.spearman) >= Number(providerResults[source].source.spearman) - .01
        && FORMATS.every(scoring => Number(providerResults[source].formatCoverage?.[scoring]) >= 10)
        && Array.isArray(providerResults[source].slices)
        && providerResults[source].slices.every(slice =>
          metricSet(slice.candidate)
          && metricSet(slice.source)
          && Number(slice.regression) <= .03
        )
      );
    if (Number(evidence.schemaVersion) !== 2
        || evidence.artifactType !== "owned-prospective-promotion-evaluation"
        || evidence.evaluationTarget !== "pure-independent-owned"
        || Number(evidence.gateVersion) !== 2
        || evidence.modelVersion !== modelId
        || Number(evidence.season) !== Number(season)
        || evidence.eligible !== true
        || evidence.replacementEligible !== true
        || evidence.independentOwnedEligible !== true
        || !validDigest(evidence.modelRecipeSha256)
        || evidence.trainingProjectionSourcePolicySha256
          !== "8ef96ed7c7fdc852a2b28b0bad260fd2d1285b14c27b9663f9b78d65df95c3d2"
        || !Array.isArray(evidence.reasons)
        || evidence.reasons.length !== 0
        || prospective.length < 3
        || prospective.some(value => value < FIRST_PROSPECTIVE_SEASON || ADAPTIVE_DEVELOPMENT_SEASONS.has(value))
        || !completeSourceEvidence
        || sourceEvidence.length !== sourceSeasons.length
        || sourceSeasons.length < 3
        || prospective.some(value => !sourceSeasons.includes(value))
        || sourceSeasons.some(value => !prospective.includes(value))
        || !Array.isArray(evidence.seasons)
        || evidence.seasons.length !== prospective.length
        || prospective.some(value => !evidence.seasons.map(Number).includes(value))
        || !completeIndependentMetrics
        || !sourceEvidence.some(source =>
          Number(source.season) === Number(season)
          && source.ownedCandidateSha256 === candidateSha256
        )) {
      reasons.push("Promotion evidence does not prove independent-owned replacement eligibility.");
    }
  }
  return { authorized: reasons.length === 0, reasons, candidateSha256, evidenceSha256 };
}
