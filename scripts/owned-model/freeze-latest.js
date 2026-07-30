import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureProspectiveEvidence, writeProspectiveEvidence } from "./prospective-evidence.js";

const SOURCES = ["espn", "sleeper", "fantasyPros"];
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sourceKey = snapshot => {
  const value = `${snapshot.platform || ""} ${snapshot.source || ""}`.toLowerCase();
  if (value.includes("fantasypros")) return "fantasyPros";
  if (value.includes("sleeper")) return "sleeper";
  if (value.includes("espn")) return "espn";
  return null;
};
const capturedAt = snapshot => snapshot.capturedAt || snapshot.fetchedAt;
export const MAX_FINAL_SNAPSHOT_AGE_MS = 72 * 60 * 60 * 1000;
export const MAX_OWNED_CANDIDATE_AGE_MS = MAX_FINAL_SNAPSHOT_AGE_MS;
const normalizedName = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const normalizedPosition = value => String(value || "").toUpperCase() === "DEF" ? "DST" : String(value || "").toUpperCase();

function normalizeSnapshotIdentity(snapshot, owned) {
  if (!owned?.players?.length) return snapshot;
  const byId = new Map(), byName = new Map(), ambiguousNames = new Set(), byTeamPosition = new Map();
  for (const player of owned.players) {
    for (const value of [player.id, player.gsisId, player.nflverseId, player.ownedPlayerId, player.espnId]) {
      if (value !== undefined && value !== null && String(value).trim()) byId.set(String(value).trim(), String(player.id));
    }
    const nameKey = `${normalizedName(player.name)}:${normalizedPosition(player.position)}`;
    if (byName.has(nameKey) && byName.get(nameKey) !== String(player.id)) ambiguousNames.add(nameKey);
    else byName.set(nameKey, String(player.id));
    const teamKey = `${String(player.team || "").toUpperCase()}:${normalizedPosition(player.position)}`;
    if (player.team && normalizedPosition(player.position) === "DST") byTeamPosition.set(teamKey, String(player.id));
  }
  for (const key of ambiguousNames) byName.delete(key);
  const seen = new Set(), players = [];
  for (const row of snapshot.players || []) {
    const position = normalizedPosition(row.position);
    const mapped = byId.get(String(row.id || "").trim())
      || byName.get(`${normalizedName(row.name)}:${position}`)
      || byTeamPosition.get(`${String(row.team || "").toUpperCase()}:${position}`);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    players.push({
      ...row, id: mapped, position,
      projectionSeason: Number(snapshot.season),
      projectionScoring: String(snapshot.scoring || "").toUpperCase(),
    });
  }
  return { ...snapshot, players };
}

export function selectLatestSnapshots({ entries, season, cutoffAt, owned = null }) {
  const cutoff = Date.parse(cutoffAt), selected = {};
  if (!Number.isFinite(cutoff)) throw new Error("A valid prospective cutoff is required.");
  for (const entry of entries) {
    const snapshot = entry.value, source = sourceKey(snapshot), scoring = String(snapshot.scoring || "").toUpperCase();
    const observed = Date.parse(capturedAt(snapshot));
    if (!source || !["STD", "PPR"].includes(scoring) || Number(snapshot.season) !== Number(season)) continue;
    if (!Number.isFinite(observed) || observed > cutoff || !Array.isArray(snapshot.players)) continue;
    const key = `${scoring}:${source}`;
    if (!selected[key] || observed > Date.parse(capturedAt(selected[key].value))) selected[key] = entry;
  }
  for (const scoring of ["STD", "PPR"]) for (const source of SOURCES) {
    if (!selected[`${scoring}:${source}`]) throw new Error(`Missing ${scoring} ${source} snapshot on or before the cutoff.`);
  }
  const snapshotsByFormat = { STD: {}, PPR: {}, HALF: {} }, inputDigests = {}, selectedInputs = [];
  for (const scoring of ["STD", "PPR"]) for (const source of SOURCES) {
    const entry = selected[`${scoring}:${source}`];
    snapshotsByFormat[scoring][source] = normalizeSnapshotIdentity(entry.value, owned);
    inputDigests[`${scoring}:${source}`] = entry.sha256;
    selectedInputs.push({ scoring, source, file: entry.file, capturedAt: capturedAt(entry.value) });
  }
  for (const source of SOURCES) {
    const standard = snapshotsByFormat.STD[source], ppr = snapshotsByFormat.PPR[source];
    const pprById = new Map(ppr.players.map(row => [String(row.id), row]));
    const players = standard.players.flatMap(row => {
      const other = pprById.get(String(row.id)), a = Number(row.points), b = Number(other?.points);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
      return [{ ...row, points: Number(((a + b) / 2).toFixed(4)), projectionSeason: Number(season), projectionScoring: "HALF" }];
    });
    const derived = {
      schemaVersion: 1, source: standard.source, platform: standard.platform,
      season: Number(season), scoring: "HALF",
      capturedAt: new Date(Math.max(Date.parse(capturedAt(standard)), Date.parse(capturedAt(ppr)))).toISOString(),
      snapshotBoundary: "Derived before outcomes as the arithmetic midpoint of matched STD and PPR source projections.",
      players,
    };
    snapshotsByFormat.HALF[source] = derived;
    inputDigests[`HALF:${source}`] = sha256(Buffer.from(`${JSON.stringify(derived)}\n`));
  }
  return { snapshotsByFormat, inputDigests, selectedInputs };
}

export function assessSnapshotFreshness(selectedInputs, cutoffAt, maximumAgeMs = MAX_FINAL_SNAPSHOT_AGE_MS) {
  const cutoff = Date.parse(cutoffAt), ages = selectedInputs.map(input => cutoff - Date.parse(input.capturedAt));
  const valid = Number.isFinite(cutoff) && ages.length === 6 && ages.every(age => Number.isFinite(age) && age >= 0);
  const oldestAgeMs = valid ? Math.max(...ages) : null;
  return {
    requiredInputs: 6, observedInputs: selectedInputs.length, maximumAgeMs,
    oldestAgeMs, passed: valid && oldestAgeMs <= maximumAgeMs,
    selectedInputs,
  };
}

export function assessOwnedCandidateFreshness(owned, cutoffAt, maximumAgeMs = MAX_OWNED_CANDIDATE_AGE_MS) {
  const cutoff = Date.parse(cutoffAt), generated = Date.parse(owned?.generatedAt);
  const ageMs = cutoff - generated;
  const valid = Number.isFinite(cutoff) && Number.isFinite(generated) && ageMs >= 0;
  return {
    generatedAt: owned?.generatedAt || null,
    cutoffAt,
    maximumAgeMs,
    ageMs: valid ? ageMs : null,
    passed: valid && ageMs <= maximumAgeMs,
  };
}

export function verifyPinnedFinalCandidate({
  ownedFile,
  ownedBytes,
  cutoffAt,
  policyFile = "data/projection-model-policy.json",
  fileSystem = fs,
}) {
  const candidatePath = path.resolve(ownedFile);
  const finalDirectory = path.dirname(candidatePath);
  const manifestFile = path.join(finalDirectory, "final-refresh-manifest.json");
  if (!fileSystem.existsSync(manifestFile)) {
    throw new Error("Final freeze requires an atomically installed final-refresh manifest.");
  }
  const manifestBytes = fileSystem.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  const candidateRecord = manifest?.files?.candidate;
  const expectedCandidatePath = candidateRecord?.file
    ? path.resolve(finalDirectory, candidateRecord.file)
    : null;
  if (manifest?.artifactType !== "owned-final-refresh-private-manifest"
      || manifest?.immutable !== true
      || manifest?.evaluationOnly !== true
      || manifest?.connectedToRuntime !== false
      || manifest?.cutoffAt !== cutoffAt
      || manifest?.preflightReadyToFreeze !== true
      || manifest?.verification?.verified !== true
      || manifest?.verification?.savedModelReproductionPassed !== true
      || manifest?.verification?.prospectiveOverlayVerified !== true
      || expectedCandidatePath !== candidatePath
      || Number(candidateRecord?.bytes) !== ownedBytes.length
      || candidateRecord?.sha256 !== sha256(ownedBytes)) {
    throw new Error("Owned candidate does not match the verified final-refresh boundary.");
  }
  for (const [name, record] of Object.entries(manifest.files || {})) {
    if (name === "policyAtVerification") continue;
    const resolved = path.resolve(finalDirectory, record.file || "");
    const relative = path.relative(finalDirectory, resolved);
    if (!record.file || relative.startsWith("..") || path.isAbsolute(relative) || !fileSystem.existsSync(resolved)) {
      throw new Error(`Final-refresh artifact is missing or escapes its install directory: ${name}.`);
    }
    const bytes = fileSystem.readFileSync(resolved);
    if (Number(record.bytes) !== bytes.length || record.sha256 !== sha256(bytes)) {
      throw new Error(`Final-refresh artifact failed digest verification: ${name}.`);
    }
  }
  const policyRecord = manifest.files?.policyAtVerification;
  const resolvedPolicy = path.resolve(policyFile);
  if (!policyRecord || !fileSystem.existsSync(resolvedPolicy)) {
    throw new Error("The policy bound during final refresh is unavailable.");
  }
  const policyBytes = fileSystem.readFileSync(resolvedPolicy);
  if (Number(policyRecord.bytes) !== policyBytes.length || policyRecord.sha256 !== sha256(policyBytes)) {
    throw new Error("Projection-model policy changed after final-refresh verification.");
  }
  return {
    manifest,
    manifestFile,
    manifestSha256: sha256(manifestBytes),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [ownedFile, snapshotDirectory, ledgerFile, receiptFile, cutoffAt] = process.argv.slice(2);
  if (!ownedFile || !snapshotDirectory || !ledgerFile || !receiptFile || !cutoffAt) {
    throw new Error("Usage: freeze-latest.js <owned.json> <snapshot-directory> <private-ledger.json> <public-receipt.json> <cutoff-ISO-8601>");
  }
  const ownedBytes = fs.readFileSync(ownedFile), owned = JSON.parse(ownedBytes);
  const pinned = verifyPinnedFinalCandidate({ ownedFile, ownedBytes, cutoffAt });
  const ownedFreshness = assessOwnedCandidateFreshness(owned, cutoffAt);
  if (!ownedFreshness.passed) throw new Error(`Refusing to freeze a stale owned candidate: ${JSON.stringify(ownedFreshness)}`);
  const entries = fs.readdirSync(snapshotDirectory).filter(file => file.endsWith(".json")).flatMap(file => {
    try {
      const bytes = fs.readFileSync(path.join(snapshotDirectory, file));
      return [{ file, value: JSON.parse(bytes), sha256: sha256(bytes) }];
    } catch {
      return [];
    }
  });
  const selected = selectLatestSnapshots({ entries, season: owned.projectionSeason, cutoffAt, owned });
  const freshness = assessSnapshotFreshness(selected.selectedInputs, cutoffAt);
  if (!freshness.passed) throw new Error(`Refusing to freeze stale preseason snapshots: ${JSON.stringify(freshness)}`);
  const { ledger, receipt } = captureProspectiveEvidence({
    owned, snapshotsByFormat: selected.snapshotsByFormat, cutoffAt,
    inputDigests: {
      owned: sha256(ownedBytes),
      finalRefreshManifest: pinned.manifestSha256,
      ...selected.inputDigests,
    },
    requireClosenessGate: true,
  });
  writeProspectiveEvidence({ ledger, receipt, ledgerFile, receiptFile });
  console.log(JSON.stringify({ ledger: ledgerFile, receipt: receiptFile, players: receipt.players, formats: receipt.formats, ledgerSha256: receipt.ledgerSha256 }, null, 2));
}
