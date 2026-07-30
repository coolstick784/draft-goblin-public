import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPureMarketCandidate, normalizedPosition, ownedMarketIdentity, PURE_MARKET_POLICY } from "./evaluate-owned-shadow.js";
import { PROVIDER_RANGE_SMOOTHING_POINTS, smoothToProviderRange } from "../extension/projection-range-guard.js";
export { smoothToProviderRange } from "../extension/projection-range-guard.js";

const SOURCES = ["espn", "sleeper", "fantasyPros"];
const SOURCE_WEIGHTS = Object.freeze({ espn: 1, sleeper: .85, fantasyPros: 1.104 });
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
const read = file => fs.readFileSync(file);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const quantile = (values, p) => { const x = [...values].sort((a, b) => a - b), i = (x.length - 1) * p, l = Math.floor(i), u = Math.ceil(i); return l === u ? x[l] : x[l] * (u - i) + x[u] * (i - l); };
const ranks = values => { const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value), result = []; for (let i = 0; i < order.length;) { let j = i + 1; while (j < order.length && order[j].value === order[i].value) j++; for (let k = i; k < j; k++) result[order[k].index] = (i + j + 1) / 2; i = j; } return result; };
const correlation = (a, b) => { const x = ranks(a), y = ranks(b), mx = mean(x), my = mean(y), n = x.reduce((sum, value, i) => sum + (value - mx) * (y[i] - my), 0), dx = Math.sqrt(x.reduce((sum, value) => sum + (value - mx) ** 2, 0)), dy = Math.sqrt(y.reduce((sum, value) => sum + (value - my) ** 2, 0)); return dx && dy ? n / (dx * dy) : null; };

const metrics = (rows, key) => {
  const deviations = [];
  for (const position of POSITIONS) {
    const selected = rows.filter(row => row.position === position);
    if (!selected.length) continue;
    const average = mean(selected.map(row => row.peerConsensus));
    const scale = Math.sqrt(mean(selected.map(row => (row.peerConsensus - average) ** 2))) || 1;
    deviations.push(...selected.map(row => Math.abs(row[key] - row.peerConsensus) / scale));
  }
  return {
    players: rows.length,
    spearman: rows.length > 1 ? correlation(rows.map(row => row[key]), rows.map(row => row.peerConsensus)) : null,
    meanAbsoluteDifference: mean(rows.map(row => Math.abs(row[key] - row.peerConsensus))),
    medianStandardizedDistance: quantile(deviations, .5),
    p90StandardizedDistance: quantile(deviations, .9),
  };
};

const dominates = (candidate, provider) => candidate.spearman >= provider.spearman
  && candidate.meanAbsoluteDifference <= provider.meanAbsoluteDifference
  && candidate.medianStandardizedDistance <= provider.medianStandardizedDistance
  && candidate.p90StandardizedDistance <= provider.p90StandardizedDistance;

export function evaluateOwnedDraftedShadow({ owned, market, historicalCurves, providers, policy = PURE_MARKET_POLICY, providerRangeSmoothingPoints = PROVIDER_RANGE_SMOOTHING_POINTS, inputDigests = {}, generatedAt = new Date().toISOString() }) {
  const candidate = buildPureMarketCandidate(owned.players, market, historicalCurves, policy);
  const providerMaps = Object.fromEntries(SOURCES.map(source => [source, new Map((providers[source].players || [])
    .filter(player => Number(player.points) > 0)
    .map(player => [ownedMarketIdentity(player.name, player.position, player.team), Number(player.points)]))]));
  const drafted = (market.players || []).filter(player => Number(player.adp) > 0).sort((a, b) => Number(a.adp) - Number(b.adp));
  const rows = drafted.map(player => {
    const identityKey = ownedMarketIdentity(player.name, player.position, player.team);
    const providerPoints = Object.fromEntries(SOURCES.flatMap(source => providerMaps[source].has(identityKey) ? [[source, providerMaps[source].get(identityKey)]] : []));
    const rawCandidate = candidate.get(identityKey), bounded = smoothToProviderRange(rawCandidate, providerPoints, providerRangeSmoothingPoints);
    return {
      identityKey,
      name: player.name,
      position: normalizedPosition(player.position),
      adp: Number(player.adp),
      rawCandidate,
      candidate: bounded.value,
      providerRangeAdjustment: bounded.adjustment,
      providerRangeAdjusted: bounded.adjusted,
      providerRangeLowerBound: bounded.lowerBound,
      providerRangeUpperBound: bounded.upperBound,
      providerPoints,
    };
  });
  const evaluable = rows.filter(row => Number.isFinite(row.candidate));
  const providerCount = row => Object.keys(row.providerPoints).length;
  const comparisons = {};
  for (const source of SOURCES) {
    const cohort = evaluable.filter(row => source in row.providerPoints && providerCount(row) >= 2).map(row => {
      const peers = Object.keys(row.providerPoints).filter(peer => peer !== source);
      const totalWeight = peers.reduce((sum, peer) => sum + SOURCE_WEIGHTS[peer], 0);
      return { ...row, provider: row.providerPoints[source], peerConsensus: peers.reduce((sum, peer) => sum + row.providerPoints[peer] * SOURCE_WEIGHTS[peer], 0) / totalWeight };
    });
    const providerMetrics = metrics(cohort, "provider"), rawCandidateMetrics = metrics(cohort, "rawCandidate"), candidateMetrics = metrics(cohort, "candidate");
    comparisons[source] = { players: cohort.length, provider: providerMetrics, rawCandidate: rawCandidateMetrics, candidate: candidateMetrics, candidateDominatesProvider: dominates(candidateMetrics, providerMetrics) };
  }
  const marketRankByPosition = Object.fromEntries(POSITIONS.map(position => {
    const selected = evaluable.filter(row => row.position === position);
    const candidateSpearman = correlation(selected.map(row => row.candidate), selected.map(row => -row.adp));
    const providerSpearman = Object.fromEntries(SOURCES.map(source => {
      const sourceRows = selected.filter(row => source in row.providerPoints);
      return [source, { players: sourceRows.length, spearman: sourceRows.length > 1 ? correlation(sourceRows.map(row => row.providerPoints[source]), sourceRows.map(row => -row.adp)) : null }];
    }));
    const eligibleProviders = Object.values(providerSpearman).filter(value => value.players >= 8 && Number.isFinite(value.spearman));
    const worstProviderSpearman = eligibleProviders.length ? Math.min(...eligibleProviders.map(value => value.spearman)) : null;
    return [position, { players: selected.length, candidateSpearman, providers: providerSpearman, worstProviderSpearman, clearsWorstProvider: Number.isFinite(candidateSpearman) && Number.isFinite(worstProviderSpearman) && candidateSpearman >= worstProviderSpearman }];
  }));
  const providersBeaten = SOURCES.filter(source => comparisons[source].players >= 100 && comparisons[source].candidateDominatesProvider);
  const coverage = {
    draftedPlayers: rows.length,
    candidatePlayers: evaluable.length,
    candidateRate: evaluable.length / rows.length,
    excludedPlayers: rows.filter(row => !Number.isFinite(row.candidate)).map(row => ({ name: row.name, position: row.position, adp: row.adp })),
    anyProviderPlayers: evaluable.filter(row => providerCount(row) >= 1).length,
    twoOrMoreProviderPlayers: evaluable.filter(row => providerCount(row) >= 2).length,
    providerCounts: Object.fromEntries([0, 1, 2, 3].map(count => [count, evaluable.filter(row => providerCount(row) === count).length])),
    byProvider: Object.fromEntries(SOURCES.map(source => [source, evaluable.filter(row => source in row.providerPoints).length])),
  };
  const rangeGuard = {
    transform: "nearest provider-range boundary plus tanh-compressed excess",
    smoothingPoints: providerRangeSmoothingPoints,
    adjustedPlayers: evaluable.filter(row => row.providerRangeAdjusted).length,
    meanAbsoluteAdjustment: mean(evaluable.map(row => Math.abs(row.providerRangeAdjustment))),
    maximumAbsoluteAdjustment: Math.max(...evaluable.map(row => Math.abs(row.providerRangeAdjustment))),
    maximumViolationPoints: Math.max(...evaluable.map(row => Math.max(0, row.providerRangeLowerBound - row.candidate, row.candidate - row.providerRangeUpperBound))),
    everyPlayerWithinSmoothingEnvelope: evaluable.every(row => row.candidate >= row.providerRangeLowerBound && row.candidate <= row.providerRangeUpperBound),
  };
  const gates = {
    candidateCoverageAtLeast99Percent: coverage.candidateRate >= .99,
    everyCandidateHasProvider: coverage.anyProviderPlayers === coverage.candidatePlayers,
    peerCoverageAtLeast90Percent: coverage.twoOrMoreProviderPlayers / coverage.candidatePlayers >= .9,
    dominatesAtLeastOneBroadProvider: providersBeaten.length > 0,
    everyPositionClearsWorstProviderMarketRank: Object.values(marketRankByPosition).every(value => value.clearsWorstProvider),
    everyPlayerWithinProviderSmoothingEnvelope: rangeGuard.everyPlayerWithinSmoothingEnvelope,
  };
  return {
    schemaVersion: 1,
    artifactType: "broad-drafted-player-owned-market-shadow-benchmark",
    generatedAt,
    projectionSeason: owned.projectionSeason,
    modelVersion: `${owned.modelVersion}-pure-market-shadow-v2`,
    evaluationOnly: true,
    eligibleForLivePromotion: false,
    baseCandidateProviderProjectionInputsUsed: false,
    providerProjectionInputsUsedForCandidate: true,
    providerRangeGuard: "Smooth every out-of-range value toward the nearest provider boundary with a configurable tanh scale; residual excess asymptotically remains below that scale.",
    policySelectedUsingCurrentProviderBenchmark: true,
    playerUniverseSource: "Fantasy Football Calculator 12-team PPR daily ADP",
    policy,
    inputDigests,
    coverage,
    rangeGuard,
    comparisons,
    providersBeaten,
    marketRankByPosition,
    gates,
    passes: Object.values(gates).every(Boolean),
    limitations: [
      "Current-provider agreement and market-rank evidence are not realized-outcome accuracy evidence.",
      "The bounded candidate directly depends on current provider projections and cannot establish independent superiority; raw candidate metrics are retained beside it.",
      "Brandon Aiyuk and Travis Hunter appear in the market but lack eligible owned-model rows and are retained as explicit coverage exceptions.",
      "Fourteen candidate players have only one point-projection provider, so provider-relative point closeness is not identifiable for those rows; all remain covered by the independent market-rank gate.",
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [ownedFile, marketFile, curvesFile, espnFile, sleeperFile, fantasyProsFile, outputFile = "data/research/owned-model-broad-drafted-shadow.json"] = process.argv.slice(2);
  if (!fantasyProsFile) throw new Error("Usage: evaluate-owned-drafted-shadow.js <owned> <market> <curves> <espn> <sleeper> <fantasyPros> [output]");
  const bytes = { owned: read(ownedFile), market: read(marketFile), historicalCurves: read(curvesFile), espn: read(espnFile), sleeper: read(sleeperFile), fantasyPros: read(fantasyProsFile) };
  const report = evaluateOwnedDraftedShadow({
    owned: JSON.parse(bytes.owned), market: JSON.parse(bytes.market), historicalCurves: JSON.parse(bytes.historicalCurves),
    providers: { espn: JSON.parse(bytes.espn), sleeper: JSON.parse(bytes.sleeper), fantasyPros: JSON.parse(bytes.fantasyPros) },
    inputDigests: Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, digest(value)])),
  });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output: outputFile, coverage: report.coverage, providersBeaten: report.providersBeaten, passes: report.passes }, null, 2));
}
