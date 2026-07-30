const clone = value => structuredClone(value);
const PROBABILITIES = [.01, .05, .10, .20, .30, .40, .50, .60, .70, .80, .90, .95, .99];
const lerp = (a, b, t) => a + (b - a) * t;

export function legacyEnvelopeShadowDistribution(player, state) {
  const mean = Number(player?.mean), floor = Number(player?.floor), ceiling = Number(player?.ceiling), season = Number(state?.projectionSeason || new Date().getFullYear());
  if (![mean, floor, ceiling].every(Number.isFinite) || mean <= 0 || floor < 0 || floor > mean || ceiling < mean || !Number.isInteger(season)) return null;
  const lowerWidth = Math.max(1, mean - floor), upperWidth = Math.max(1, ceiling - mean);
  const values = PROBABILITIES.map(p => p <= .1 ? Math.max(0, floor - lowerWidth * (.1 - p) / .09) : p < .5 ? lerp(floor, mean, (p - .1) / .4) : p <= .9 ? lerp(mean, ceiling, (p - .5) / .4) : ceiling + upperWidth * (p - .9) / .09);
  return { schemaVersion: "quantile-v1", unit: "season-fantasy-points", conditionedOn: "active-role", season, scoringFormat: "custom", mean, quantiles: PROBABILITIES.map((p, index) => ({ p, value: Number(values[index].toFixed(4)) })), provenance: { modelId: "shadow-legacy-envelope", modelVersion: "shadow-v1", generatedAt: "2026-07-14T00:00:00.000Z", forecastAsOf: "2026-07-14T00:00:00.000Z", trainedThrough: "2026-01-01T00:00:00.000Z", calibrationId: "runtime-comparison-only-not-calibrated", sourceSnapshotIds: ["live-state-legacy-envelope"], estimationLevel: "legacy-three-point", fallbackReason: "Shadow-only interpolation of the existing live mean, floor, and ceiling; not eligible for promotion." } };
}

export function attachLegacyEnvelopeShadows(state) {
  const next = clone(state); next.players = (next.players || []).map(player => ({ ...player, ...(!player.shadowDistribution && legacyEnvelopeShadowDistribution(player, next) ? { shadowDistribution: legacyEnvelopeShadowDistribution(player, next) } : {}) })); return next;
}

export function compareRecommendationSets(legacy = [], quantile = [], metadata = {}) {
  const legacyRanks = new Map(legacy.map((item, index) => [String(item.player?.id), index + 1])), quantileRanks = new Map(quantile.map((item, index) => [String(item.player?.id), index + 1]));
  const ids = [...new Set([...legacyRanks.keys(), ...quantileRanks.keys()])];
  const changes = ids.map(playerId => {
    const legacyItem = legacy.find(item => String(item.player?.id) === playerId), quantileItem = quantile.find(item => String(item.player?.id) === playerId), legacyRank = legacyRanks.get(playerId) || null, quantileRank = quantileRanks.get(playerId) || null;
    return { playerId, legacyRank, quantileRank, rankDelta: legacyRank && quantileRank ? legacyRank - quantileRank : null, legacyTitleChance: Number(legacyItem?.simulation?.championshipProbability || 0), quantileTitleChance: Number(quantileItem?.simulation?.championshipProbability || 0) };
  });
  return { schemaVersion: "distribution-shadow-v1", capturedAt: new Date().toISOString(), ...metadata, liveOrderingChanged: false, legacyTopPlayerId: String(legacy[0]?.player?.id || "") || null, quantileTopPlayerId: String(quantile[0]?.player?.id || "") || null, topPickDisagreed: legacy[0]?.player?.id !== quantile[0]?.player?.id, comparedPlayers: ids.length, maximumAbsoluteRankDelta: Math.max(0, ...changes.map(change => Math.abs(change.rankDelta || 0))), changes };
}

export class DistributionShadowTelemetry {
  constructor(maxEntries = 256) { this.maxEntries = maxEntries; this.entries = []; this.failures = 0; }
  record(entry) { this.entries.push(clone(entry)); if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries); return entry; }
  fail() { this.failures++; }
  diagnostics() { const disagreements = this.entries.filter(entry => entry.topPickDisagreed).length; return { enabled: process.env.DRAFT_CHAMPION_DISTRIBUTION_SHADOW === "1", entries: this.entries.length, failures: this.failures, topPickDisagreements: disagreements, topPickDisagreementRate: this.entries.length ? disagreements / this.entries.length : 0, recent: this.entries.slice(-10).reverse() }; }
}

export function shadowStates(state) {
  state = attachLegacyEnvelopeShadows(state);
  const hasShadow = (state?.players || []).some(player => player.shadowDistribution);
  if (!hasShadow) return null;
  const legacy = clone(state), quantile = clone(state);
  legacy.players = legacy.players.map(({ distribution, shadowDistribution, ...player }) => player);
  quantile.players = quantile.players.map(({ shadowDistribution, ...player }) => ({ ...player, ...(shadowDistribution ? { distribution: shadowDistribution } : {}) }));
  return { legacy, quantile };
}

export function scheduleDistributionShadow({ state, evaluate, options = {}, telemetry, metadata = {}, enabled = process.env.DRAFT_CHAMPION_DISTRIBUTION_SHADOW === "1" }) {
  if (!enabled) return false;
  const states = shadowStates(state); if (!states) return false;
  setImmediate(() => { try { const legacy = evaluate({ ...options, state: states.legacy }), quantile = evaluate({ ...options, state: states.quantile }); telemetry.record(compareRecommendationSets(legacy, quantile, metadata)); } catch { telemetry.fail(); } });
  return true;
}
