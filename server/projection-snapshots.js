import fs from "node:fs";
import crypto from "node:crypto";

const SCORING = new Set(["STD", "HALF", "PPR"]);
const POSITION = new Set(["QB", "RB", "WR", "TE", "K", "DST"]);
const written = new Set(), lastWrittenAt = new Map();
const MAX_IN_MEMORY_SNAPSHOT_IDS = 2048;
const rememberWritten = key => { written.add(key); while (written.size > MAX_IN_MEMORY_SNAPSHOT_IDS) written.delete(written.values().next().value); };
const scoringName = state => Number(state.settings?.scoring?.reception || 0) >= .75 ? "PPR" : Number(state.settings?.scoring?.reception || 0) >= .25 ? "HALF" : "STD";
const safePart = value => String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "unknown";
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export function projectionSnapshotFromState(state, { capturedAt = new Date().toISOString() } = {}) {
  const season = Number(state?.projectionSeason || new Date(capturedAt).getUTCFullYear()), scoring = scoringName(state || {});
  const players = (state?.players || []).filter(player => Number.isFinite(Number(player.platformProjection))).map(player => ({
    id: String(player.id || ""), name: String(player.name || "").trim(), position: String(player.position || "").toUpperCase(),
    team: String(player.team || "").toUpperCase(), points: Number(player.platformProjection), projectionSeason: Number(player.projectionSeason || season), projectionScoring: scoring
  }));
  const payload = { schemaVersion: "projection-snapshot-v2", source: `${String(state?.platform || "unknown")} current-season`, platform: String(state?.platform || "unknown"), season, scoring, capturedAt, fetchedAt: capturedAt, snapshotBoundary: "captured prospectively; outcomes are not stored in this artifact", players };
  return { ...payload, snapshotId: `ps_${digest(payload).slice(0, 24)}` };
}

export function projectionSnapshotsFromState(state, options = {}) {
  const primary = projectionSnapshotFromState(state, options), snapshots = [primary], sources = new Map();
  for (const player of state?.players || []) for (const source of player.projectionConsensus?.sources || []) {
    if (!source?.available || !Number.isFinite(Number(source.points)) || Number(source.points) <= 0 || String(source.key) === String(state.platform)) continue;
    const rows = sources.get(source.key) || []; rows.push({ id: String(player.id || ""), name: String(player.name || "").trim(), position: String(player.position || "").toUpperCase(), team: String(player.team || "").toUpperCase(), points: Number(source.points), projectionSeason: primary.season, projectionScoring: primary.scoring }); sources.set(source.key, rows);
  }
  for (const [key, players] of sources) { const payload = { ...primary, source: `${key} current-season`, platform: key, players }; delete payload.snapshotId; snapshots.push({ ...payload, snapshotId: `ps_${digest(payload).slice(0, 24)}` }); }
  return snapshots;
}

export function assessProjectionSnapshot(snapshot, { now = Date.now(), forecastDeadlineAt, expectedSeason, expectedScoring, minimumPlayers = 20, maximumZeroRate = .98 } = {}) {
  const errors = [], warnings = [], capturedAt = Date.parse(snapshot?.capturedAt || snapshot?.fetchedAt || ""), players = Array.isArray(snapshot?.players) ? snapshot.players : [];
  if (!Number.isFinite(capturedAt)) errors.push("invalid-captured-at");
  else {
    if (capturedAt > Number(now) + 5 * 60_000) errors.push("captured-at-in-future");
    if (forecastDeadlineAt !== undefined && capturedAt >= Date.parse(forecastDeadlineAt)) errors.push("projection-leakage-after-forecast-deadline");
  }
  if (!Number.isInteger(Number(snapshot?.season)) || Number(snapshot.season) < 2000 || Number(snapshot.season) > 2100) errors.push("invalid-season");
  if (expectedSeason !== undefined && Number(snapshot?.season) !== Number(expectedSeason)) errors.push("season-mismatch");
  if (!SCORING.has(String(snapshot?.scoring || "").toUpperCase())) errors.push("invalid-scoring-format");
  if (expectedScoring !== undefined && String(snapshot?.scoring).toUpperCase() !== String(expectedScoring).toUpperCase()) errors.push("scoring-format-mismatch");
  if (players.length < minimumPlayers) errors.push("insufficient-player-coverage");
  const identities = new Set(); let zeros = 0, usable = 0;
  for (const player of players) {
    const id = String(player?.id || "").trim(), name = String(player?.name || "").trim(), position = String(player?.position || "").toUpperCase(), points = Number(player?.points);
    if (!id || !name || !POSITION.has(position)) { errors.push("invalid-player-identity"); continue; }
    const identity = `${id}:${position}`;
    if (identities.has(identity)) errors.push("duplicate-player-identity");
    identities.add(identity);
    if (!Number.isFinite(points) || points < 0) errors.push("invalid-projection-value");
    else { usable++; if (points === 0) zeros++; }
    if (player.projectionSeason !== undefined && Number(player.projectionSeason) !== Number(snapshot.season)) errors.push("player-season-mismatch");
    if (player.projectionScoring !== undefined && String(player.projectionScoring).toUpperCase() !== String(snapshot.scoring).toUpperCase()) errors.push("player-scoring-mismatch");
  }
  const zeroRate = usable ? zeros / usable : 1;
  if (zeroRate >= maximumZeroRate) errors.push("all-or-nearly-all-zero-projections");
  else if (zeroRate > .5) warnings.push("high-zero-projection-rate");
  const uniqueErrors = [...new Set(errors)], uniqueWarnings = [...new Set(warnings)];
  const valid = uniqueErrors.length === 0, deadlineChecked = forecastDeadlineAt !== undefined;
  return { valid, collectionAccepted: valid, deadlineChecked, promotableInput: valid && deadlineChecked, integrityScope: deadlineChecked ? "collection-and-explicit-forecast-deadline" : "collection-only-not-leakage-certified", errors: uniqueErrors, warnings: uniqueWarnings, metrics: { players: players.length, usable, zeroRate, uniqueIdentities: identities.size }, checkedAt: new Date(Number(now)).toISOString() };
}

export class ProjectionSnapshotStore {
  constructor({ directory = new URL("../data/snapshots/", import.meta.url), maxFiles = 512, maxBytes = 64 * 1024 * 1024, maxPerSeries = 64 } = {}) { this.directory = directory; this.maxFiles = maxFiles; this.maxBytes = maxBytes; this.maxPerSeries = maxPerSeries; }
  files() { try { return fs.readdirSync(this.directory).filter(file => file.endsWith(".json")).map(file => { const path = new URL(file, this.directory), stat = fs.statSync(path); return { file, path, size: stat.size, mtimeMs: stat.mtimeMs }; }); } catch { return []; } }
  prune() {
    let files = this.files().sort((a, b) => b.mtimeMs - a.mtimeMs), bytes = files.reduce((sum, file) => sum + file.size, 0); const perSeries = new Map(), remove = [];
    for (const file of files) { const series = file.file.replace(/-\d{4}-\d{2}-\d{2}t.*|-ps_[a-f0-9]+\.json$/i, ""), count = perSeries.get(series) || 0; perSeries.set(series, count + 1); if (count >= this.maxPerSeries) remove.push(file); }
    const removed = new Set(remove.map(file => file.file)); files = files.filter(file => !removed.has(file.file)); bytes = files.reduce((sum, file) => sum + file.size, 0);
    for (let index = files.length - 1; (files.length - remove.length > this.maxFiles || bytes > this.maxBytes) && index >= 0; index--) { const file = files[index]; if (removed.has(file.file)) continue; remove.push(file); removed.add(file.file); bytes -= file.size; }
    for (const file of remove) try { fs.unlinkSync(file.path); } catch {}
    return { removed: remove.length, retained: this.files().length };
  }
  write(snapshot, assessment = assessProjectionSnapshot(snapshot)) {
    if (!assessment.valid) return { written: false, reason: "integrity-rejected", assessment };
    fs.mkdirSync(this.directory, { recursive: true });
    const stamp = new Date(snapshot.capturedAt || snapshot.fetchedAt).toISOString().replace(/[:.]/g, "-").toLowerCase(), filename = `${safePart(snapshot.platform)}-${snapshot.season}-${snapshot.scoring}-${stamp}-${snapshot.snapshotId}.json`, path = new URL(filename, this.directory);
    try { fs.writeFileSync(path, `${JSON.stringify({ ...snapshot, collectionIntegrity: assessment }, null, 2)}\n`, { flag: "wx" }); } catch (error) { if (error.code === "EEXIST") return { written: false, reason: "duplicate", snapshotId: snapshot.snapshotId, assessment }; throw error; }
    this.prune(); return { written: true, snapshotId: snapshot.snapshotId, filename, assessment };
  }
  diagnostics() { const files = this.files(); return { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), limits: { maxFiles: this.maxFiles, maxBytes: this.maxBytes, maxPerSeries: this.maxPerSeries } }; }
}

const defaultStore = new ProjectionSnapshotStore();
export function capturePlatformSnapshot(state, options = {}) {
  const results = [], intervalMs = Number(options.captureIntervalMs ?? 6 * 60 * 60_000), now = Date.now();
  for (const snapshot of projectionSnapshotsFromState(state, options)) {
    const series = `${snapshot.platform}:${snapshot.season}:${snapshot.scoring}`, key = snapshot.snapshotId;
    if (written.has(key) || now - Number(lastWrittenAt.get(series) || 0) < intervalMs) { results.push({ written: false, reason: "capture-interval", snapshotId: key }); continue; }
    try { const result = (options.store || defaultStore).write(snapshot, assessProjectionSnapshot(snapshot, options)); if (result.written) { rememberWritten(key); lastWrittenAt.set(series, now); } results.push(result); } catch (error) { results.push({ written: false, reason: "write-failed", error: String(error?.message || error), snapshotId: key }); }
  }
  return { written: results.some(result => result.written), results };
}
export const projectionSnapshotDiagnostics = () => defaultStore.diagnostics();
