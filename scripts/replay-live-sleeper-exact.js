import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { Worker as NodeWorker } from "node:worker_threads";
import { enrichLiveDraftState } from "../extension/draft-enrichment.js";
import { normalizeSettings } from "../shared/domain.js";

const draftId = String(process.argv[2] || "1386006717732524032");
const userSlot = Number(process.argv[3] || 1);
const maxCases = Math.max(1, Number(process.argv[4]) || Infinity);
const strategies = process.argv[4] ? [String(process.argv[4])] : ["titleOnly", "balanced", "upside", "safe", "projection"];
const sourceProfiles = process.argv[5] ? [String(process.argv[5])] : ["projectionLed", "ownedModel", "marketLed"];

class BrowserWorkerAdapter {
  static active = 0;
  constructor() {
    BrowserWorkerAdapter.active++;
    this.worker = new NodeWorker(new URL("./extension-engine-node-worker.js", import.meta.url));
    this.worker.on("message", data => this.onmessage?.({ data }));
    this.worker.on("error", error => this.onerror?.({ message: error.message, error }));
    this.worker.once("exit", () => BrowserWorkerAdapter.active--);
  }
  postMessage(value) { this.worker.postMessage(value); }
  terminate() { return this.worker.terminate(); }
}

globalThis.Worker = BrowserWorkerAdapter;
globalThis.chrome = { runtime: { getURL: value => value } };
const { localApi, shutdownLocalEngineWorkers, warmLocalEngineWorkers } = await import("../extension/local-engine-client.js");

const getJson = async url => {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
};
const slot = (settings, key) => Math.max(0, Number(settings?.[key]) || 0);
const settingsFor = draft => {
  const source = draft.settings || {};
  const slots = {
    QB: slot(source, "slots_qb"), RB: slot(source, "slots_rb"), WR: slot(source, "slots_wr"),
    TE: slot(source, "slots_te"), FLEX: slot(source, "slots_flex"), K: slot(source, "slots_k"),
    DST: slot(source, "slots_def"),
  };
  const starters = Object.values(slots).reduce((sum, value) => sum + value, 0);
  slots.BENCH = Number.isFinite(Number(source.slots_bn)) ? Number(source.slots_bn) : Math.max(0, Number(source.rounds) - starters);
  const defaults = {
    QB: slots.QB + 1,
    RB: slots.RB + slots.FLEX + Math.max(1, Math.ceil(slots.BENCH * .35)),
    WR: slots.WR + slots.FLEX + Math.max(1, Math.ceil(slots.BENCH * .35)),
    TE: slots.TE + 1,
    K: slots.K,
    DST: slots.DST,
  };
  const keys = { QB: "max_qb", RB: "max_rb", WR: "max_wr", TE: "max_te", K: "max_k", DST: "max_def" };
  const positionLimits = Object.fromEntries(Object.entries(defaults).map(([position, fallback]) => {
    const key = keys[position];
    return [position, Object.hasOwn(source, key) ? Math.min(fallback, Math.max(0, Number(source[key]) || 0)) : fallback];
  }));
  return normalizeSettings({
    teams: Number(source.teams), rounds: Number(source.rounds), playoffTeams: Math.min(6, Number(source.teams)),
    scoring: { reception: draft.metadata?.scoring_type === "ppr" ? 1 : draft.metadata?.scoring_type === "half_ppr" ? .5 : 0 },
    slots, positionLimits,
  });
};

const [draft, picksRaw, sleeperCatalog, sleeperProjections] = await Promise.all([
  getJson(`https://api.sleeper.app/v1/draft/${draftId}`),
  getJson(`https://api.sleeper.app/v1/draft/${draftId}/picks`),
  getJson("https://api.sleeper.app/v1/players/nfl"),
  getJson(`https://api.sleeper.com/projections/nfl/2026?season_type=regular`),
]);
const settings = settingsFor(draft);
const pointsKey = settings.scoring.reception >= .75 ? "pts_ppr" : settings.scoring.reception >= .25 ? "pts_half_ppr" : "pts_std";
const adpKey = settings.scoring.reception >= .75 ? "adp_ppr" : settings.scoring.reception >= .25 ? "adp_half_ppr" : "adp_std";
const signalById = new Map(sleeperProjections.map(row => [String(row.player_id), row.stats || {}]));
const players = Object.values(sleeperCatalog).filter(player => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(player.position)).map(player => {
  const signal = signalById.get(String(player.player_id)) || {}, projection = Number(signal[pointsKey]), adp = Number(signal[adpKey]);
  return {
    id: String(player.player_id),
    name: player.full_name || `${player.first_name || ""} ${player.last_name || ""}`.trim(),
    position: player.position === "DEF" ? "DST" : player.position,
    team: player.team,
    active: player.active !== false && !["Inactive", "Retired"].includes(String(player.status || "")),
    injuryStatus: player.injury_status || null,
    risk: player.injury_status ? .8 : .25,
    scarcity: ["RB", "TE"].includes(player.position) ? .65 : .4,
    platformProjection: Number.isFinite(projection) && projection > 0 ? projection : 0,
    projectionSeason: Number(draft.season),
    adp: Number.isFinite(adp) && adp > 0 && adp < 999 ? adp : null,
    adpSd: null,
    adpSdSource: "format-curve",
    adpSeason: Number(draft.season),
    adpScoring: settings.scoring.reception >= .75 ? "ppr" : settings.scoring.reception >= .25 ? "half-ppr" : "standard",
    adpTeams: Number(settings.teams),
    adpProvider: "sleeper",
  };
});
const rawState = {
  platform: "sleeper", draftId, draftRunId: `${draftId}:${Number(draft.created) || 0}`,
  draftStatus: String(draft.status || ""), projectionSeason: Number(draft.season), userSlot,
  settings,
  picks: picksRaw.map(row => ({ pickNo: Number(row.pick_no), playerId: String(row.player_id), slot: Number(row.draft_slot) })),
  players, updatedAt: Date.now(),
};
const baseline = JSON.parse(fs.readFileSync(new URL("../extension/engine-data/catalog.json", import.meta.url)));
const fallback = JSON.parse(fs.readFileSync(new URL("../extension/engine-data/draft-goblin-fallback.json", import.meta.url)));
const scoring = settings.scoring.reception >= .75 ? "PPR" : settings.scoring.reception >= .25 ? "HALF" : "STD";
const draftGoblinFeed = fallback.feeds.draftGoblin[scoring];
const state = enrichLiveDraftState({ state: rawState, baseline, draftGoblinFeed, projectionDriver: "draftGoblin" });
const pickedForUser = state.picks.filter(pick => pick.slot === userSlot).map(pick => state.players.find(player => String(player.id) === String(pick.playerId))?.name || pick.playerId);
console.error(JSON.stringify({ draftId, status: draft.status, picks: state.picks.length, currentPick: state.picks.length + 1, userSlot, pickedForUser, rawPlayers: rawState.players.length, enrichedPlayers: state.players.length, eligiblePlayers: state.players.filter(player => player.eligibleForRecommendation !== false).length, scoring }, null, 2));

const rows = [];
try {
  const warmStarted = performance.now();
  await warmLocalEngineWorkers();
  console.error(`workers warmed in ${(performance.now() - warmStarted).toFixed(1)} ms`);
  let seed = 9600;
  caseLoop: for (const strategy of strategies) {
    for (const sourceProfile of sourceProfiles) {
      if (rows.length >= maxCases) break caseLoop;
      seed++;
      const progress = [];
      const payload = { state, userSlot, strategy, sourceProfile, iterations: 32, refineIterations: 10_000, limit: 8, seed };
      const quick = await localApi("/v1/quick-evaluate", { body: JSON.stringify(payload) });
      const started = performance.now();
      try {
        const result = await localApi("/v1/evaluate", {
          body: JSON.stringify(payload),
          precomputedRecommendations: quick.recommendations,
          contextKey: `${draftId}:${strategy}:${sourceProfile}`,
          onProgress: update => progress.push(update),
        });
        const elapsedMs = performance.now() - started;
        const exact = result.status === "complete" && result.simulationStatus === "refined" && result.iterations === 10_000 && result.recommendations?.length === 8 && result.recommendations.every(item => item.simulation?.iterations === 10_000 && item.teamSimulation?.iterations === 10_000);
        rows.push({ strategy, sourceProfile, elapsedMs: Number(elapsedMs.toFixed(1)), responseMs: result.responseMs, workerCount: result.workerCount, sourcePlayerCount: progress.at(-1)?.sourcePlayerCount, simulationPlayerCount: progress.at(-1)?.simulationPlayerCount, completed: Math.max(0, ...progress.map(update => Number(update.completed) || 0)), retries: Math.max(0, ...progress.map(update => Number(update.retryCount) || 0)), exact, lean: result.recommendations?.[0]?.player?.name });
      } catch (error) {
        rows.push({ strategy, sourceProfile, elapsedMs: Number((performance.now() - started).toFixed(1)), completed: Math.max(0, ...progress.map(update => Number(update.completed) || 0)), exact: false, error: `${error.code || error.name || "Error"}: ${error.message}` });
      }
      console.error(JSON.stringify(rows.at(-1)));
    }
  }
  console.log(JSON.stringify({ draft: { draftId, pickCount: state.picks.length, userSlot, pickedForUser }, rows, allExact: rows.every(row => row.exact), allUnder22s: rows.every(row => row.elapsedMs < 22_000) }, null, 2));
  if (rows.some(row => !row.exact || row.elapsedMs >= 22_000)) process.exitCode = 1;
} finally {
  shutdownLocalEngineWorkers();
}
