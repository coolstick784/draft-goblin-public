import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { recommend } from "../core/recommend.js";
import { createSimulationSession, pairedDifference, simulateCandidate, WEEKLY_SIMULATION_MODEL } from "../core/simulate.js";
import { rankEvaluatedRecommendations } from "../core/evaluate.js";
import { snakeSlot } from "../shared/domain.js";
import { defaultMockSettings, loadMockDraftPlayers, realisticAdpBotPick } from "./mock-draft-tournament-lib.js";

export function evaluatePolicyAtState({ state, userSlot, simulationModel = "legacy", iterations = 120, seed = 20260714, limit = 8 }) {
  const items = recommend({ state, userSlot, strategy: "titleOnly", sourceProfile: "projectionLed", limit }), session = createSimulationSession({ state, userSlot, iterations, seed, simulationModel }), baseline = simulateCandidate({ state, candidate: null, userSlot, iterations, seed, session });
  const evaluated = items.map(item => { const simulation = simulateCandidate({ state, candidate: item.player, userSlot, iterations, seed, session }), paired = pairedDifference(simulation, baseline); if (paired) Object.assign(simulation, { pairedDifference: paired.rawDifference, pairedStandardError: paired.standardError, pairedInterval: paired.interval, pairedScenarioBankId: paired.scenarioBankId }); return { ...item, waitingForUserPick: false, teamSimulation: baseline, simulation }; });
  return rankEvaluatedRecommendations(evaluated, { strategy: "titleOnly" });
}

const stateAt = ({ players, settings, picks, draftId }) => ({ platform: "fixture", draftId, projectionSeason: 2026, dataQuality: "synthetic-runtime-validation", modelVersion: "synthetic-quantiles-research-only", settings, players, picks, updatedAt: 0 });

export function diagnoseWeeklyPolicy({ iterations = 120, stateCount = 3, userSlot = 6, seed = 20260714 } = {}) {
  iterations = Math.max(10, Math.min(500, Number(iterations) || 120)); stateCount = Math.max(1, Math.min(5, Number(stateCount) || 3)); userSlot = Math.max(1, Math.min(12, Number(userSlot) || 6));
  const players = loadMockDraftPlayers(), settings = defaultMockSettings(), picks = [], states = [];
  while (picks.length < settings.teams * settings.rounds && states.length < stateCount) {
    const pickNo = picks.length + 1, slot = snakeSlot(pickNo, settings.teams), state = stateAt({ players, settings, picks: [...picks], draftId: `weekly-policy-diagnostic-${pickNo}` });
    if (slot === userSlot && [1, 5, 9, 13, 16].includes(Math.ceil(pickNo / settings.teams))) states.push(state);
    const player = realisticAdpBotPick({ state, slot, seed }); if (!player) break; picks.push({ pickNo, playerId: player.id, slot });
  }
  const rows = states.map((state, index) => {
    const pickNo = state.picks.length + 1, run = simulationModel => { const started = performance.now(), ranked = evaluatePolicyAtState({ state, userSlot, simulationModel, iterations, seed: seed + index, limit: 8 }); return { milliseconds: performance.now() - started, ranked }; }, legacy = run("legacy"), weekly = run(WEEKLY_SIMULATION_MODEL), legacyRanks = new Map(legacy.ranked.map((item, rank) => [item.player.id, rank + 1])), weeklyRanks = new Map(weekly.ranked.map((item, rank) => [item.player.id, rank + 1]));
    const rawOrder = result => [...result.ranked].sort((a, b) => Number(b.simulation.rankingRawProbability) - Number(a.simulation.rankingRawProbability) || String(a.player.id).localeCompare(String(b.player.id))), legacyRaw = rawOrder(legacy), weeklyRaw = rawOrder(weekly), legacyRawRanks = new Map(legacyRaw.map((item, rank) => [item.player.id, rank + 1])), weeklyRawRanks = new Map(weeklyRaw.map((item, rank) => [item.player.id, rank + 1]));
    return { pickNo, round: Math.ceil(pickNo / settings.teams), legacyTop: legacy.ranked[0]?.player.name, weeklyTop: weekly.ranked[0]?.player.name, topPickDisagreed: legacy.ranked[0]?.player.id !== weekly.ranked[0]?.player.id, maximumRankDelta: Math.max(0, ...[...legacyRanks].map(([id, rank]) => Math.abs(rank - (weeklyRanks.get(id) || 9)))), legacyRawTop: legacyRaw[0]?.player.name, weeklyRawTop: weeklyRaw[0]?.player.name, rawTopDisagreed: legacyRaw[0]?.player.id !== weeklyRaw[0]?.player.id, maximumRawRankDelta: Math.max(0, ...[...legacyRawRanks].map(([id, rank]) => Math.abs(rank - (weeklyRawRanks.get(id) || 9)))), legacyMs: Number(legacy.milliseconds.toFixed(1)), weeklyMs: Number(weekly.milliseconds.toFixed(1)), legacyScenarioBankId: legacy.ranked[0]?.simulation.scenarioBankId, weeklyScenarioBankId: weekly.ranked[0]?.simulation.scenarioBankId, crossModelPairedDifference: pairedDifference(legacy.ranked[0]?.simulation, weekly.ranked[0]?.simulation) };
  });
  return { schemaVersion: "weekly-policy-diagnostic-v1", researchOnly: true, iterations, stateCount: rows.length, userSlot, rows, summary: { topPickDisagreements: rows.filter(row => row.topPickDisagreed).length, legacyMs: Number(rows.reduce((sum, row) => sum + row.legacyMs, 0).toFixed(1)), weeklyMs: Number(rows.reduce((sum, row) => sum + row.weeklyMs, 0).toFixed(1)) }, evidenceRule: "Paired CRN evidence is used only among candidates evaluated inside the same model. Cross-model pairedDifference must be null. A full policy A/B must use independent draft paths and unpaired draft-level uncertainty, then cross-evaluate each completed roster under both models.", calibrationWarning: "Synthetic quantiles validate mechanics only. weekly-v2 uses position-level availability priors and is not calibrated enough for live promotion or real-world superiority claims." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(diagnoseWeeklyPolicy({ iterations: process.argv[2], stateCount: process.argv[3], userSlot: process.argv[4] }), null, 2));
