import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { Worker as NodeWorker } from "node:worker_threads";
import { normalizeSettings } from "../shared/domain.js";

const TERMINAL_BUDGET_MS = 25_000;
const ITERATIONS = 10_000;
const LIMIT = 8;
const USER_SLOT = 6;
const STRATEGIES = ["titleOnly", "balanced", "upside", "safe", "projection"];
const SOURCE_PROFILES = ["projectionLed", "ownedModel", "marketLed"];
const PROJECTION_DRIVERS = ["draftGoblin", "platform"];
const STAGES = [
  { name: "early", picked: 5 },
  { name: "middle", picked: 90 },
  { name: "late", picked: 162 },
];
const CUSTOM_CASES = [
  { name: "projection-max", weights: { projection: 1, ceiling: 0, floor: 0, scarcity: 0, need: 0, availability: 0, history: 0, risk: 0 } },
  { name: "ceiling-risk", weights: { projection: 0, ceiling: 1, floor: 0, scarcity: 0, need: 0, availability: 0, history: 0, risk: 1 } },
  { name: "floor-safety", weights: { projection: 0, ceiling: 0, floor: 1, scarcity: 0, need: 0, availability: 0, history: 0, risk: -1 } },
  { name: "scarcity-need", weights: { projection: 0, ceiling: 0, floor: 0, scarcity: 1, need: 1, availability: 0, history: 0, risk: 0 } },
  { name: "availability-max", weights: { projection: 0, ceiling: 0, floor: 0, scarcity: 0, need: 0, availability: 1, history: 0, risk: 0 } },
  { name: "all-positive", weights: { projection: 1, ceiling: 1, floor: 1, scarcity: 1, need: 1, availability: 1, history: 1, risk: 1 } },
];

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

const catalog = JSON.parse(fs.readFileSync(new URL("../extension/engine-data/catalog.json", import.meta.url)));
const eligiblePositions = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);
const basePlayers = catalog.players
  .filter(player => eligiblePositions.has(player.position) && Number(player.meanPpr ?? player.mean) > 0)
  .map((player, index) => ({
    ...player,
    id: String(player.id),
    mean: Number(player.meanPpr ?? player.mean),
    floor: Number(player.floor),
    ceiling: Number(player.ceiling),
    eligibleForRecommendation: true,
    _catalogIndex: index,
  }))
  .sort((a, b) => Number(a.adp ?? 9999) - Number(b.adp ?? 9999) || b.mean - a.mean || a.id.localeCompare(b.id));

const settings = normalizeSettings({
  teams: 12,
  rounds: 16,
  playoffTeams: 6,
  slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 7 },
  scoring: { reception: 1 },
});

function driverPlayers(driver) {
  if (driver === "draftGoblin") return basePlayers.map(({ _catalogIndex, ...player }) => ({ ...player, projectionDriver: driver }));
  return basePlayers.map(({ _catalogIndex, ...player }) => {
    // A stable platform-style disagreement exercises a genuinely different
    // shortlist and simulation input without relying on a live network feed.
    const positionBias = { QB: .96, RB: 1.035, WR: .985, TE: 1.045, K: .93, DST: .92 }[player.position] ?? 1;
    const playerBias = .94 + ((_catalogIndex * 37) % 13) / 100;
    const multiplier = positionBias * playerBias;
    return {
      ...player,
      mean: player.mean * multiplier,
      floor: player.floor * multiplier,
      ceiling: player.ceiling * multiplier,
      platformProjection: player.mean * multiplier,
      projectionDriver: driver,
    };
  });
}

function stateFor({ picked, driver, runId }) {
  const players = driverPlayers(driver);
  return {
    platform: "sleeper",
    draftId: `sleeper-timing-${runId}`,
    draftRunId: `fresh-${runId}`,
    dataQuality: "calibrated",
    modelVersion: catalog.modelVersion,
    projectionSeason: Number(catalog.projectionSeason) || 2026,
    settings,
    picks: players.slice(0, picked).map((player, index) => ({ pickNo: index + 1, playerId: player.id, slot: ((Math.floor(index / 12) % 2 ? 11 - (index % 12) : index % 12) + 1) })),
    players,
    userSlot: USER_SLOT,
    currentPickNo: picked + 1,
    updatedAt: Date.now(),
  };
}

function exactCoverage(result, progress) {
  return result?.status === "complete"
    && result?.simulationStatus === "refined"
    && result?.refinementOutcome === "complete"
    && result?.iterations === ITERATIONS
    && result?.targetIterations === ITERATIONS
    && result?.recommendations?.length === LIMIT
    && result.recommendations.every(item => item.simulation?.iterations === ITERATIONS && item.teamSimulation?.iterations === ITERATIONS)
    && progress.some(event => Number(event.completed) === ITERATIONS && Number(event.total) === ITERATIONS);
}

let sequence = 0;
async function runFresh(testCase) {
  const runId = `${Date.now()}-${++sequence}`;
  const state = stateFor({ ...testCase, runId });
  const progress = [];
  const payload = {
    state,
    userSlot: USER_SLOT,
    strategy: testCase.strategy,
    sourceProfile: testCase.sourceProfile,
    ...(testCase.customWeights ? { customWeights: testCase.customWeights } : {}),
    iterations: 32,
    refineIterations: ITERATIONS,
    limit: LIMIT,
    seed: 26_000 + sequence,
    consumer: "gui",
  };
  const started = performance.now();
  try {
    const result = await localApi("/v1/evaluate", {
      body: JSON.stringify(payload),
      contextKey: runId,
      onProgress: event => progress.push({ completed: event.completed, total: event.total, retryCount: event.retryCount }),
    });
    const elapsedMs = performance.now() - started;
    const exact = exactCoverage(result, progress);
    return {
      type: "fresh",
      stage: testCase.stage,
      picked: testCase.picked,
      projectionDriver: testCase.driver,
      strategy: testCase.strategy,
      sourceProfile: testCase.sourceProfile,
      customCase: testCase.customName ?? null,
      elapsedMs: Number(elapsedMs.toFixed(1)),
      responseMs: result?.responseMs,
      workerCount: result?.workerCount,
      completedIterations: Math.max(0, ...progress.map(event => Number(event.completed) || 0)),
      retryCount: Math.max(0, ...progress.map(event => Number(event.retryCount) || 0)),
      exact,
      terminalUnder25s: elapsedMs < TERMINAL_BUDGET_MS,
      pass: exact && elapsedMs < TERMINAL_BUDGET_MS,
    };
  } catch (error) {
    return {
      type: "fresh",
      stage: testCase.stage,
      picked: testCase.picked,
      projectionDriver: testCase.driver,
      strategy: testCase.strategy,
      sourceProfile: testCase.sourceProfile,
      customCase: testCase.customName ?? null,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      completedIterations: Math.max(0, ...progress.map(event => Number(event.completed) || 0)),
      exact: false,
      terminalUnder25s: performance.now() - started < TERMINAL_BUDGET_MS,
      pass: false,
      error: `${error?.code ? `${error.code}: ` : ""}${error?.message || error}`,
    };
  }
}

async function runCancellation(index) {
  const stage = STAGES[index % STAGES.length];
  const driver = PROJECTION_DRIVERS[index % PROJECTION_DRIVERS.length];
  const controller = new AbortController();
  const runId = `cancel-${Date.now()}-${index}`;
  const started = performance.now();
  const pending = localApi("/v1/evaluate", {
    body: JSON.stringify({
      state: stateFor({ ...stage, driver, runId }),
      userSlot: USER_SLOT,
      strategy: STRATEGIES[index % STRATEGIES.length],
      sourceProfile: SOURCE_PROFILES[index % SOURCE_PROFILES.length],
      iterations: 32,
      refineIterations: ITERATIONS,
      limit: LIMIT,
      seed: 29_000 + index,
    }),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20 + index * 15);
  try {
    await pending;
    return { index, terminal: "unexpected-complete", elapsedMs: Number((performance.now() - started).toFixed(1)), pass: false };
  } catch (error) {
    const elapsedMs = performance.now() - started;
    return { index, terminal: error?.name || error?.code || "error", elapsedMs: Number(elapsedMs.toFixed(1)), pass: error?.name === "AbortError" && elapsedMs < 1_000 };
  }
}

const cases = [];
for (const [strategyIndex, strategy] of STRATEGIES.entries()) {
  for (const [driverIndex, driver] of PROJECTION_DRIVERS.entries()) {
    for (const [profileIndex, sourceProfile] of SOURCE_PROFILES.entries()) {
      const stage = STAGES[(strategyIndex + driverIndex + profileIndex) % STAGES.length];
      cases.push({ ...stage, stage: stage.name, driver, strategy, sourceProfile });
    }
  }
}
for (const [customIndex, custom] of CUSTOM_CASES.entries()) {
  for (const [driverIndex, driver] of PROJECTION_DRIVERS.entries()) {
    const stage = STAGES[(customIndex + driverIndex) % STAGES.length];
    cases.push({ ...stage, stage: stage.name, driver, strategy: "custom", sourceProfile: SOURCE_PROFILES[customIndex % SOURCE_PROFILES.length], customName: custom.name, customWeights: custom.weights });
  }
}

const rows = [];
try {
  const warmStarted = performance.now();
  await warmLocalEngineWorkers();
  const warmupMs = performance.now() - warmStarted;
  for (const [index, testCase] of cases.entries()) {
    const row = await runFresh(testCase);
    rows.push(row);
    console.error(`[${index + 1}/${cases.length}] ${row.pass ? "PASS" : "FAIL"} ${row.strategy}/${row.sourceProfile}/${row.projectionDriver}/${row.stage}: ${row.elapsedMs} ms, ${row.completedIterations} sims`);
  }
  const cancellations = [];
  for (let index = 0; index < 6; index++) cancellations.push(await runCancellation(index));
  const replacement = await runFresh({ ...STAGES[1], stage: "post-churn-middle", driver: "platform", strategy: "titleOnly", sourceProfile: "marketLed" });
  rows.push(replacement);
  const ordered = [...rows].sort((a, b) => b.elapsedMs - a.elapsedMs);
  const report = {
    budgetMs: TERMINAL_BUDGET_MS,
    iterationsPerFreshRun: ITERATIONS,
    recommendationCandidates: LIMIT,
    cachePolicy: "Every row uses a unique draftId, draftRunId, seed, and direct local engine request; no restored/cache path is used.",
    playerPool: { source: "bundled Sleeper catalog", total: basePlayers.length },
    warmupMs: Number(warmupMs.toFixed(1)),
    coverage: {
      freshRuns: rows.length,
      strategies: [...new Set(rows.map(row => row.strategy))],
      projectionDrivers: [...new Set(rows.map(row => row.projectionDriver))],
      sourceProfiles: [...new Set(rows.map(row => row.sourceProfile))],
      stages: [...new Set(rows.map(row => row.stage))],
      customCases: [...new Set(rows.map(row => row.customCase).filter(Boolean))],
    },
    summary: {
      passed: rows.filter(row => row.pass).length,
      failed: rows.filter(row => !row.pass).length,
      minMs: ordered.at(-1)?.elapsedMs,
      medianMs: [...rows].sort((a, b) => a.elapsedMs - b.elapsedMs)[Math.floor(rows.length / 2)]?.elapsedMs,
      p95Ms: [...rows].sort((a, b) => a.elapsedMs - b.elapsedMs)[Math.ceil(rows.length * .95) - 1]?.elapsedMs,
      worst: ordered[0],
    },
    rows,
    cancellations,
    pass: rows.every(row => row.pass) && cancellations.every(row => row.pass),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally {
  shutdownLocalEngineWorkers();
}
