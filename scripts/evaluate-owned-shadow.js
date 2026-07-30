import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectionConsensus } from "../extension/projection-consensus.js";
import { OWNED_OVERLAY_POSITION_WEIGHTS } from "./owned-model/overlay-policy.js";

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const read = file => { const bytes = fs.readFileSync(file); return { bytes, value: JSON.parse(bytes) }; };
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
export const normalizedPosition = position => ({ DEF: "DST", PK: "K" }[String(position || "").toUpperCase()] || String(position || "").toUpperCase());
const normalizedTeam = team => ({ JAC: "JAX", LA: "LAR" }[String(team || "").toUpperCase()] || String(team || "").toUpperCase());
const identity = (name, position, team = "") => {
  const normalized = normalizedPosition(position), canonicalTeam = normalizedTeam(team);
  if (normalized === "DST" && canonicalTeam) return `team:${canonicalTeam}|DST`;
  const canonicalName = String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/[^a-z0-9]/g, "");
  return `${canonicalName}|${normalized}`;
};
export const ownedMarketIdentity = identity;
const quantile = (values, p) => { const x = [...values].sort((a, b) => a - b), i = (x.length - 1) * p, l = Math.floor(i), u = Math.ceil(i); return l === u ? x[l] : x[l] * (u - i) + x[u] * (i - l); };
const ranks = values => { const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value), result = []; for (let i = 0; i < order.length;) { let j = i + 1; while (j < order.length && order[j].value === order[i].value) j++; for (let k = i; k < j; k++) result[order[k].index] = (i + j + 1) / 2; i = j; } return result; };
const correlation = (a, b) => { const x = ranks(a), y = ranks(b), mx = mean(x), my = mean(y), n = x.reduce((sum, value, i) => sum + (value - mx) * (y[i] - my), 0), dx = Math.sqrt(x.reduce((sum, value) => sum + (value - mx) ** 2, 0)), dy = Math.sqrt(y.reduce((sum, value) => sum + (value - my) ** 2, 0)); return dx && dy ? n / (dx * dy) : null; };
const aggregate = rows => ({
  players: rows.length,
  spearman: rows.length > 1 ? correlation(rows.map(row => row.owned), rows.map(row => row.consensus)) : null,
  meanAbsoluteDifference: rows.length ? mean(rows.map(row => Math.abs(row.owned - row.consensus))) : null,
  meanDifference: rows.length ? mean(rows.map(row => row.owned - row.consensus)) : null,
});
const standardizedCloseness = (rows, candidateKey = "candidate") => {
  const deviations = [];
  for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const selected = rows.filter(row => row.position === position), average = selected.length ? mean(selected.map(row => row.consensus)) : 0;
    const scale = selected.length ? Math.sqrt(mean(selected.map(row => (row.consensus - average) ** 2))) || 1 : 1;
    deviations.push(...selected.map(row => Math.abs(row[candidateKey] - row.consensus) / scale));
  }
  return {
    players: rows.length,
    spearman: rows.length > 1 ? correlation(rows.map(row => row[candidateKey]), rows.map(row => row.consensus)) : null,
    meanAbsoluteDifference: rows.length ? mean(rows.map(row => Math.abs(row[candidateKey] - row.consensus))) : null,
    meanDifference: rows.length ? mean(rows.map(row => row[candidateKey] - row.consensus)) : null,
    medianStandardizedDistance: deviations.length ? quantile(deviations, .5) : null,
    p90StandardizedDistance: deviations.length ? quantile(deviations, .9) : null,
  };
};

const providerRelativeBenchmark = rows => {
  const providers = Object.fromEntries(["espn", "sleeper", "fantasyPros"].map(source => {
    const peerRows = rows.map(row => {
      const peers = Object.keys(row.providerPoints).filter(key => key !== source);
      const totalWeight = peers.reduce((sum, key) => sum + row.providerEffectiveWeights[key], 0);
      const peerConsensus = peers.reduce((sum, key) => sum + row.providerPoints[key] * row.providerEffectiveWeights[key], 0) / totalWeight;
      return { ...row, consensus: Number(peerConsensus.toFixed(2)), provider: row.providerPoints[source] };
    });
    return [source, standardizedCloseness(peerRows, "provider")];
  }));
  const finite = Object.values(providers).filter(value => value.players && Number.isFinite(value.spearman));
  const worstProviderThreshold = finite.length ? {
    minimumSpearman: Math.min(...finite.map(value => value.spearman)),
    maximumMeanAbsoluteDifference: Math.max(...finite.map(value => value.meanAbsoluteDifference)),
    maximumMedianStandardizedDistance: Math.max(...finite.map(value => value.medianStandardizedDistance)),
    maximumP90StandardizedDistance: Math.max(...finite.map(value => value.p90StandardizedDistance)),
  } : null;
  return { providers, worstProviderThreshold };
};

const clearsThreshold = (metrics, threshold) => Boolean(threshold
  && metrics.spearman >= threshold.minimumSpearman
  && metrics.meanAbsoluteDifference <= threshold.maximumMeanAbsoluteDifference
  && metrics.medianStandardizedDistance <= threshold.maximumMedianStandardizedDistance
  && metrics.p90StandardizedDistance <= threshold.maximumP90StandardizedDistance);
const aggregateByPosition = rows => Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DST"].map(position => [
  position,
  standardizedCloseness(rows.filter(row => row.position === position)),
]));

export const PURE_MARKET_POLICY = Object.freeze({
  skillPositionCurveWeight: 1,
  kickerMarketWeight: 1,
  quarterbackMarketWeight: 1,
  dstCurveWeight: .2,
});

export const buildPureMarketCandidate = (ownedPlayers, market, historicalCurves, policy = PURE_MARKET_POLICY) => {
  if (!market || !historicalCurves) return new Map();
  const owned = (ownedPlayers || []).filter(player => Number(player.meanPpr) > 0).map(player => ({
    identityKey: identity(player.name, player.position, player.team),
    position: normalizedPosition(player.position),
    owned: Number(player.meanPpr),
    activeRoleOwned: Number(player.activeRoleMeanPpr || player.meanPpr),
  }));
  const ownedByIdentity = new Map(owned.map(row => [row.identityKey, row]));
  const output = new Map(owned.map(row => [row.identityKey, row.activeRoleOwned]));
  for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const ordered = (market.players || [])
      .filter(player => normalizedPosition(player.position) === position && Number(player.adp) > 0)
      .sort((a, b) => Number(a.adp) - Number(b.adp))
      .map((player, marketRank) => ({ marketRank, row: ownedByIdentity.get(identity(player.name, player.position, player.team)) }))
      .filter(item => item.row);
    const ownedTemplate = ordered.map(item => item.row.owned).sort((a, b) => b - a);
    const activeRoleTemplate = ordered.map(item => item.row.activeRoleOwned).sort((a, b) => b - a);
    ordered.forEach((item, matchedRank) => {
      const curve = historicalCurves.curves?.[position]?.pointsByPositionRank?.[item.marketRank];
      const base = Number.isFinite(curve)
        ? item.row.activeRoleOwned * (1 - policy.skillPositionCurveWeight) + curve * policy.skillPositionCurveWeight
        : item.row.activeRoleOwned;
      if (position === "K") output.set(item.row.identityKey, ownedTemplate[matchedRank]);
      else if (position === "QB") output.set(item.row.identityKey,
        base * (1 - policy.quarterbackMarketWeight) + activeRoleTemplate[matchedRank] * policy.quarterbackMarketWeight);
      else if (position === "DST" && Number.isFinite(curve)) output.set(item.row.identityKey,
        item.row.activeRoleOwned * (1 - policy.dstCurveWeight) + curve * policy.dstCurveWeight);
      else output.set(item.row.identityKey, base);
    });
  }
  return output;
};

const evaluateMarketAdpShadow = (rows, market, historicalCurves = null, quarterbackMarket = null, ownedPlayers = []) => {
  if (!market || Number(market.season) !== 2026 || Number(market.teams) !== 12 || market.scoring !== "ppr") return null;
  const marketMap = new Map((market.players || []).filter(player => Number(player.adp) > 0).map(player => [identity(player.name, player.position, player.team), Number(player.adp)]));
  const quarterbackMarketMap = new Map((quarterbackMarket?.players || []).filter(player => player.position === "QB" && Number(player.adp) > 0).map(player => [identity(player.name, player.position, player.team), Number(player.adp)]));
  const fullMarketPositionRank = new Map();
  for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    (market.players || []).filter(player => normalizedPosition(player.position) === position && Number(player.adp) > 0)
      .sort((a, b) => Number(a.adp) - Number(b.adp))
      .forEach((player, index) => fullMarketPositionRank.set(identity(player.name, player.position, player.team), index));
  }
  const matched = rows.filter(row => marketMap.has(row.identityKey)).map(row => ({ ...row, marketAdp: marketMap.get(row.identityKey) }));
  const candidateRows = [];
  for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const selected = matched.filter(row => row.position === position);
    const pointTemplate = selected.map(row => row.owned).sort((a, b) => b - a);
    const activeRolePointTemplate = selected.map(row => row.activeRoleOwned).sort((a, b) => b - a);
    const ownedOrder = [...selected].sort((a, b) => b.owned - a.owned);
    const marketOrder = [...selected].sort((a, b) => a.marketAdp - b.marketAdp);
    const ownedRank = new Map(ownedOrder.map((row, index) => [row.identityKey, index]));
    const marketRank = new Map(marketOrder.map((row, index) => [row.identityKey, index]));
    const average = selected.length ? mean(selected.map(row => row.owned)) : 0;
    const scale = selected.length ? Math.sqrt(mean(selected.map(row => (row.owned - average) ** 2))) : 0;
    const rankStep = scale / Math.max(1, selected.length - 1);
    marketOrder.forEach((row, index) => candidateRows.push({
      ...row,
      marketMapped: pointTemplate[index],
      activeRoleMarketMapped: activeRolePointTemplate[index],
      historicalRankCurve: historicalCurves?.curves?.[position]?.pointsByPositionRank?.[fullMarketPositionRank.get(row.identityKey)] ?? null,
      marketRankNudge: (ownedRank.get(row.identityKey) - marketRank.get(row.identityKey)) * rankStep,
    }));
  }
  const peerBenchmark = providerRelativeBenchmark(candidateRows);
  const fullPeerBenchmark = providerRelativeBenchmark(rows);
  const weights = [0, .25, .5, .75, 1].map(marketWeight => {
    const evaluated = candidateRows.map(row => ({ ...row, candidate: row.owned * (1 - marketWeight) + row.marketMapped * marketWeight }));
    const metrics = standardizedCloseness(evaluated);
    return { marketWeight, ...metrics, clearsWorstProviderCloseness: clearsThreshold(metrics, peerBenchmark.worstProviderThreshold) };
  });
  const rankNudges = [.5, 1, 1.5, 2, 3].map(rankNudgeStrength => {
    const evaluated = candidateRows.map(row => ({ ...row, candidate: row.owned + rankNudgeStrength * row.marketRankNudge }));
    const metrics = standardizedCloseness(evaluated);
    return { rankNudgeStrength, ...metrics, clearsWorstProviderCloseness: clearsThreshold(metrics, peerBenchmark.worstProviderThreshold) };
  });
  const historicalRankCurve = historicalCurves ? (() => {
    const evaluated = candidateRows.filter(row => Number.isFinite(row.historicalRankCurve)).map(row => ({ ...row, candidate: row.historicalRankCurve }));
    const metrics = standardizedCloseness(evaluated);
    return { ...metrics, clearsWorstProviderCloseness: clearsThreshold(metrics, peerBenchmark.worstProviderThreshold) };
  })() : null;
  const activeRoleMetrics = standardizedCloseness(rows.map(row => ({ ...row, candidate: row.activeRoleOwned })));
  const candidateByIdentity = new Map(candidateRows.map(row => [row.identityKey, row]));
  const pureCandidate = buildPureMarketCandidate(ownedPlayers, market, historicalCurves);
  const fixedPureRows = rows.map(row => ({ ...row, candidate: pureCandidate.get(row.identityKey) ?? row.activeRoleOwned }));
  const fixedPureMetrics = standardizedCloseness(fixedPureRows);
  const activeRoleCurveWeights = historicalCurves ? [0, .25, .5, .6, .65, .7, .75, .8, .85, .9, .95, 1].map(curveWeight => {
    const evaluated = rows.map(row => ({
      ...row,
      candidate: Number.isFinite(candidateByIdentity.get(row.identityKey)?.historicalRankCurve)
        ? row.activeRoleOwned * (1 - curveWeight) + candidateByIdentity.get(row.identityKey).historicalRankCurve * curveWeight
        : row.activeRoleOwned,
    }));
    const metrics = standardizedCloseness(evaluated);
    return { curveWeight, activeRoleWeight: 1 - curveWeight, ...metrics, byPosition: aggregateByPosition(evaluated), clearsWorstProviderCloseness: clearsThreshold(metrics, fullPeerBenchmark.worstProviderThreshold) };
  }) : [];
  const kickerCurveWeights = historicalCurves ? [0, .1, .2, .25, .3, .4, .5, .6, .75, 1].map(kickerCurveWeight => {
    const evaluated = rows.map(row => {
      const curve = candidateByIdentity.get(row.identityKey)?.historicalRankCurve;
      const curveWeight = row.position === "K" ? kickerCurveWeight : .75;
      return {
        ...row,
        candidate: Number.isFinite(curve)
          ? row.activeRoleOwned * (1 - curveWeight) + curve * curveWeight
          : row.activeRoleOwned,
      };
    });
    const metrics = standardizedCloseness(evaluated);
    return { offensiveCurveWeight: .75, kickerCurveWeight, ...metrics, byPosition: aggregateByPosition(evaluated), clearsWorstProviderCloseness: clearsThreshold(metrics, fullPeerBenchmark.worstProviderThreshold) };
  }) : [];
  const kickerMarketReorderWeights = historicalCurves ? [0, .25, .5, .75, 1].map(kickerMarketWeight => {
    const evaluated = rows.map(row => {
      const marketCandidate = candidateByIdentity.get(row.identityKey);
      if (row.position === "K" && Number.isFinite(marketCandidate?.marketMapped)) {
        return { ...row, candidate: row.activeRoleOwned * (1 - kickerMarketWeight) + marketCandidate.marketMapped * kickerMarketWeight };
      }
      const curve = marketCandidate?.historicalRankCurve;
      return { ...row, candidate: Number.isFinite(curve) ? row.activeRoleOwned * .25 + curve * .75 : row.activeRoleOwned };
    });
    const metrics = standardizedCloseness(evaluated);
    return { offensiveCurveWeight: .75, kickerMarketWeight, ...metrics, byPosition: aggregateByPosition(evaluated), clearsWorstProviderCloseness: clearsThreshold(metrics, fullPeerBenchmark.worstProviderThreshold) };
  }) : [];
  const quarterbackMarketReorderWeights = historicalCurves ? [0, .25, .5, .75, 1].map(quarterbackMarketWeight => {
    const evaluated = rows.map(row => {
      const marketCandidate = candidateByIdentity.get(row.identityKey);
      if (row.position === "K" && Number.isFinite(marketCandidate?.marketMapped)) {
        return { ...row, candidate: marketCandidate.marketMapped };
      }
      const curve = marketCandidate?.historicalRankCurve;
      const base = Number.isFinite(curve) ? row.activeRoleOwned * .25 + curve * .75 : row.activeRoleOwned;
      if (row.position === "QB" && Number.isFinite(marketCandidate?.activeRoleMarketMapped)) {
        return { ...row, candidate: base * (1 - quarterbackMarketWeight) + marketCandidate.activeRoleMarketMapped * quarterbackMarketWeight };
      }
      return { ...row, candidate: base };
    });
    const metrics = standardizedCloseness(evaluated);
    return { skillPositionCurveWeight: .75, kickerMarketWeight: 1, quarterbackMarketWeight, ...metrics, byPosition: aggregateByPosition(evaluated), clearsWorstProviderCloseness: clearsThreshold(metrics, fullPeerBenchmark.worstProviderThreshold) };
  }) : [];
  const combinedRankSignals = historicalCurves && quarterbackMarketMap.size ? [0, .25, .5, .75, 1].map(pprMarketWeight => {
    const evaluated = [];
    for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) {
      const selected = candidateRows.filter(row => row.position === position && (position !== "QB" || quarterbackMarketMap.has(row.identityKey)));
      const byMarket = [...selected].sort((a, b) => a.marketAdp - b.marketAdp);
      const byQuarterbackMarket = position === "QB" ? [...selected].sort((a, b) => quarterbackMarketMap.get(a.identityKey) - quarterbackMarketMap.get(b.identityKey)) : byMarket;
      const marketRanks = new Map(byMarket.map((row, index) => [row.identityKey, index]));
      const quarterbackRanks = new Map(byQuarterbackMarket.map((row, index) => [row.identityKey, index]));
      const combined = [...selected].sort((a, b) => (
        pprMarketWeight * marketRanks.get(a.identityKey) + (1 - pprMarketWeight) * quarterbackRanks.get(a.identityKey)
      ) - (
        pprMarketWeight * marketRanks.get(b.identityKey) + (1 - pprMarketWeight) * quarterbackRanks.get(b.identityKey)
      ));
      combined.forEach((row, index) => evaluated.push({ ...row, candidate: historicalCurves.curves[position].pointsByPositionRank[index] }));
    }
    const metrics = standardizedCloseness(evaluated);
    return { pprMarketWeight, twoQbMarketWeight: 1 - pprMarketWeight, ...metrics, clearsWorstProviderCloseness: clearsThreshold(metrics, peerBenchmark.worstProviderThreshold) };
  }) : [];
  const candidates = [...weights, ...rankNudges, ...(historicalRankCurve ? [historicalRankCurve] : []), ...activeRoleCurveWeights, ...kickerCurveWeights, ...kickerMarketReorderWeights, ...quarterbackMarketReorderWeights, ...combinedRankSignals];
  const selected = candidates.find(value => value.clearsWorstProviderCloseness) || [...candidates].sort((a, b) => b.spearman - a.spearman || a.meanAbsoluteDifference - b.meanAbsoluteDifference)[0];
  return {
    method: "Adaptive current-season screen. Within each position, lawful 2026 Fantasy Football Calculator ADP reorders the owned model's existing point distribution; fixed blend weights are compared only on the matched all-three-source cohort.",
    warning: "This screen is tuned against the current consensus and has no realized outcomes. It is shadow-only and cannot authorize production or establish independent accuracy.",
    matchedPlayers: candidateRows.length,
    ownedPlayersOnProviderCohort: rows.length,
    coverage: rows.length ? candidateRows.length / rows.length : 0,
    providerPeerBenchmark: peerBenchmark,
    fixedPurePositionMarketPolicy: {
      method: "The fixed position policy is built over the complete owned-plus-FFC player universe before provider matching: RB/WR/TE use a 0.75 active-role/historical-rank-curve blend, K uses FFC ordering over the owned kicker distribution, and QB blends that curve result 50/50 with FFC ordering over the owned active-role QB distribution.",
      policy: PURE_MARKET_POLICY,
      providerInputsUsedForCandidate: false,
      playerUniverseDependsOnProviderCoverage: false,
      ...fixedPureMetrics,
      byPosition: aggregateByPosition(fixedPureRows),
      clearsWorstProviderCloseness: clearsThreshold(fixedPureMetrics, fullPeerBenchmark.worstProviderThreshold),
    },
    weights,
    rankNudges,
    historicalPositionRankCurve: historicalRankCurve ? {
      method: "Current lawful market ADP supplies within-position order; the point scale is the median realized score at that position rank over completed 2021-2025 seasons.",
      historicalSeasons: historicalCurves.seasons,
      providerInputsUsedForCandidate: false,
      ...historicalRankCurve,
    } : null,
    activeRoleConditional: {
      method: "Current depth-chart starters are expressed on a 17-game active-role basis; non-starters retain the owned expected-games total. This is a convention diagnostic, not a replacement expected-value forecast.",
      providerInputsUsedForCandidate: false,
      ...activeRoleMetrics,
      clearsWorstProviderCloseness: clearsThreshold(activeRoleMetrics, fullPeerBenchmark.worstProviderThreshold),
    },
    activeRoleHistoricalCurveBlends: activeRoleCurveWeights.length ? {
      method: "Active-role owned totals blend with completed-2021-2025 position-rank curves indexed by lawful current FFC PPR market rank. Provider values are used only after prediction for aggregate evaluation.",
      warning: "Weights are adaptively screened against current consensus and remain shadow-only.",
      candidates: activeRoleCurveWeights,
      bestByRank: [...activeRoleCurveWeights].sort((a, b) => b.spearman - a.spearman || a.meanAbsoluteDifference - b.meanAbsoluteDifference)[0],
    } : null,
    positionSpecificKickerCurveBlends: kickerCurveWeights.length ? {
      method: "Offensive positions use the 0.75 active-role/historical-curve blend while kicker curve weight is screened separately because kicker scoring and market ranks use a distinct position scale.",
      warning: "Weights are adaptively screened against current consensus and remain shadow-only.",
      candidates: kickerCurveWeights,
      bestByRank: [...kickerCurveWeights].sort((a, b) => b.spearman - a.spearman || a.meanAbsoluteDifference - b.meanAbsoluteDifference)[0],
    } : null,
    positionSpecificKickerMarketReorder: kickerMarketReorderWeights.length ? {
      method: "Offensive positions use the 0.75 active-role/historical-curve blend; lawful FFC order reassigns the existing owned kicker point distribution without changing its scale.",
      warning: "Weights are adaptively screened against current consensus and remain shadow-only.",
      candidates: kickerMarketReorderWeights,
      bestByRank: [...kickerMarketReorderWeights].sort((a, b) => b.spearman - a.spearman || a.meanAbsoluteDifference - b.meanAbsoluteDifference)[0],
    } : null,
    positionSpecificQuarterbackMarketReorder: quarterbackMarketReorderWeights.length ? {
      method: "RB/WR/TE use the 0.75 active-role/historical-curve blend, lawful FFC order reassigns the owned kicker distribution, and quarterback FFC order is blended with the owned active-role QB distribution.",
      warning: "Weights are adaptively screened against current consensus and remain shadow-only.",
      candidates: quarterbackMarketReorderWeights,
      bestByRank: [...quarterbackMarketReorderWeights].sort((a, b) => b.spearman - a.spearman || a.meanAbsoluteDifference - b.meanAbsoluteDifference)[0],
    } : null,
    combinedCurrentRankSignals: combinedRankSignals.length ? {
      method: "Within-position ordering compares FFC PPR and two-QB ADP; completed-season position curves supply the point scale.",
      warning: "This adaptive current-consensus screen is shadow-only and provides no realized-outcome or promotion evidence.",
      candidates: combinedRankSignals,
    } : null,
    selected,
    eligibleForLivePromotion: false,
  };
};

export function evaluateOwnedShadow({ owned, espn, sleeper, fantasyPros, market = null, historicalCurves = null, quarterbackMarket = null, inputDigests = {}, generatedAt = new Date().toISOString() }) {
  const maps = Object.fromEntries([["espn", espn], ["sleeper", sleeper], ["fantasyPros", fantasyPros]].map(([key, snapshot]) => [key, new Map(snapshot.players.filter(row => Number(row.points) > 0).map(row => [String(row.id), row]))]));
  const rows = [];
  for (const player of owned.players || []) {
    const id = String(player.id), e = maps.espn.get(id), s = maps.sleeper.get(id), f = maps.fantasyPros.get(id);
    const sourceCount = Number(Boolean(e)) + Number(Boolean(s)) + Number(Boolean(f));
    if (!sourceCount || !Number(player.meanPpr)) continue;
    const sources = {};
    if (s) sources.sleeper = { points: s.points, season: s.projectionSeason, kind: "cross-platform-draft-site" };
    if (f) sources.fantasyPros = { points: f.points, season: f.projectionSeason, kind: "public-html" };
    const consensus = projectionConsensus({ season: owned.projectionSeason, platform: "espn", platformProjection: e?.points, sources });
    if (!(consensus.points > 0)) continue;
    rows.push({
      position: player.position,
      identityKey: identity(player.name, player.position, player.team),
      owned: Number(player.meanPpr),
      activeRoleOwned: Number(player.activeRoleMeanPpr || player.meanPpr),
      consensus: consensus.points,
      sourceCount,
      providerPoints: {
        espn: e ? Number(e.points) : null,
        sleeper: s ? Number(s.points) : null,
        fantasyPros: f ? Number(f.points) : null,
      },
      providerEffectiveWeights: Object.fromEntries(consensus.sources.map(source => [source.key, source.effectiveWeight])),
    });
  }
  const byPosition = {};
  for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const selected = rows.filter(row => row.position === position), base = aggregate(selected);
    const consensusMean = selected.length ? mean(selected.map(row => row.consensus)) : 0;
    const scale = selected.length ? Math.sqrt(mean(selected.map(row => (row.consensus - consensusMean) ** 2))) || 1 : 1;
    const deviations = selected.map(row => Math.abs(row.owned - row.consensus) / scale);
    byPosition[position] = { ...base, medianStandardizedDistance: deviations.length ? quantile(deviations, .5) : null, p90StandardizedDistance: deviations.length ? quantile(deviations, .9) : null };
  }
  const allThree = rows.filter(row => row.sourceCount === 3);
  const { providers: providerCloseness, worstProviderThreshold } = providerRelativeBenchmark(allThree);
  const pureOwnedCloseness = standardizedCloseness(allThree, "owned");
  const meetsWorstProviderCloseness = clearsThreshold(pureOwnedCloseness, worstProviderThreshold);
  const positionOwnedWeights = { ...OWNED_OVERLAY_POSITION_WEIGHTS };
  const anchoredRows = rows.map(row => {
    const ownedWeight = positionOwnedWeights[row.position];
    return { ...row, ownedWeight, candidate: Number((ownedWeight * row.owned + (1 - ownedWeight) * row.consensus).toFixed(4)) };
  });
  return {
    schemaVersion: 2,
    artifactType: "owned-model-consensus-shadow",
    generatedAt,
    modelVersion: owned.modelVersion,
    projectionSeason: owned.projectionSeason,
    evaluationOnly: true,
    eligibleForLivePromotion: false,
    method: "Aggregate-only comparison with the exact live consensus over every player having at least one current source; the all-three subset is reported separately. Proprietary source rows are neither copied into this report nor used for model training.",
    inputDigests,
    commonPlayers: rows.length,
    ...aggregate(rows),
    sourceAvailability: {
      oneSource: rows.filter(row => row.sourceCount === 1).length,
      twoSources: rows.filter(row => row.sourceCount === 2).length,
      threeSources: allThree.length,
    },
    allThreeSources: aggregate(allThree),
    providerRelativeConsensusBenchmark: {
      method: "Current-season agreement on the identical all-three-source player cohort. Each provider is compared with the exact weighted peer consensus excluding itself; pure owned is compared with the full three-source consensus. This measures consensus closeness, not realized-outcome accuracy, and cannot authorize promotion.",
      providers: providerCloseness,
      worstProviderThreshold,
      pureOwned: pureOwnedCloseness,
      meetsWorstProviderCloseness,
      eligibleForLivePromotion: false,
    },
    lawfulMarketAdpShadow: evaluateMarketAdpShadow(allThree, market, historicalCurves, quarterbackMarket, owned.players),
    consensusAnchoredOwned50: {
      method: "0.50 owned / 0.50 final weighted consensus for QB/RB/WR/TE/K; consensus-only for DST because the owned DST safety selector rejected its learned ranking.",
      positionOwnedWeights,
      ...standardizedCloseness(anchoredRows),
      meanAbsoluteOwnedAdjustment: anchoredRows.length ? mean(anchoredRows.map(row => Math.abs(row.candidate - row.consensus))) : null,
    },
    byPosition,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [ownedFile, espnFile, sleeperFile, fantasyProsFile, outputFile = "data/research/owned-model-consensus-shadow.json", marketFile, historicalCurvesFile, quarterbackMarketFile] = process.argv.slice(2);
  const inputs = { owned: read(ownedFile), espn: read(espnFile), sleeper: read(sleeperFile), fantasyPros: read(fantasyProsFile) };
  if (marketFile) inputs.market = read(marketFile);
  if (historicalCurvesFile) inputs.historicalCurves = read(historicalCurvesFile);
  if (quarterbackMarketFile) inputs.quarterbackMarket = read(quarterbackMarketFile);
  const report = evaluateOwnedShadow({ owned: inputs.owned.value, espn: inputs.espn.value, sleeper: inputs.sleeper.value, fantasyPros: inputs.fantasyPros.value, market: inputs.market?.value, historicalCurves: inputs.historicalCurves?.value, quarterbackMarket: inputs.quarterbackMarket?.value, inputDigests: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, hash(value.bytes)])) });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output: outputFile, commonPlayers: report.commonPlayers, spearman: report.spearman, allThreePlayers: report.allThreeSources.players }, null, 2));
}
