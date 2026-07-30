import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessOwnedCandidateFreshness, assessSnapshotFreshness, selectLatestSnapshots, verifyPinnedFinalCandidate } from "../scripts/owned-model/freeze-latest.js";

const entry = (source, scoring, at, points, suffix = "") => ({
  file: `${source}-${scoring}-${suffix}.json`, sha256: `${source}-${scoring}-${suffix}`,
  value: {
    source, platform: source === "fantasyPros" ? undefined : source,
    season: 2026, scoring, capturedAt: at,
    players: Object.entries(points).map(([id, value]) => ({ id, points: value, projectionSeason: 2026 })),
  },
});

test("freeze selector chooses latest pre-cutoff snapshots and derives half PPR", () => {
  const entries = [];
  for (const source of ["espn", "sleeper", "fantasyPros"]) {
    entries.push(entry(source, "STD", "2026-08-20T00:00:00Z", { a: 80, b: 60 }, "old"));
    entries.push(entry(source, "STD", "2026-08-21T00:00:00Z", { a: 90, b: 70 }, "new"));
    entries.push(entry(source, "PPR", "2026-08-21T00:00:00Z", { a: 110, b: 90 }, "new"));
    entries.push(entry(source, "PPR", "2026-09-10T00:00:00Z", { a: 999 }, "after-cutoff"));
  }
  const result = selectLatestSnapshots({ entries, season: 2026, cutoffAt: "2026-09-09T00:00:00Z" });
  assert.equal(result.snapshotsByFormat.STD.espn.players[0].points, 90);
  assert.deepEqual(result.snapshotsByFormat.HALF.espn.players.map(row => row.points), [100, 80]);
  assert.equal(result.snapshotsByFormat.HALF.fantasyPros.scoring, "HALF");
  assert.equal(Object.keys(result.inputDigests).length, 9);
});

test("freeze selector reconciles provider ids through unique name and ESPN identity", () => {
  const owned = { players: [
    { id: "sleeper-a", espnId: 101, name: "Player A", position: "RB", team: "A" },
    { id: "sleeper-b", espnId: 102, name: "Player B", position: "WR", team: "B" },
  ] };
  const entries = [];
  for (const scoring of ["STD", "PPR"]) {
    entries.push({ ...entry("espn", scoring, "2026-08-20T00:00:00Z", { 101: 80, 102: 60 }), value: {
      ...entry("espn", scoring, "2026-08-20T00:00:00Z", {}).value,
      players: [{ id: "101", name: "Player A", position: "RB", points: 80 }, { id: "102", name: "Player B", position: "WR", points: 60 }],
    } });
    entries.push({ ...entry("sleeper", scoring, "2026-08-20T00:00:00Z", {}), value: {
      ...entry("sleeper", scoring, "2026-08-20T00:00:00Z", {}).value,
      players: [{ id: "sleeper-a", name: "Player A", position: "RB", points: 80 }, { id: "sleeper-b", name: "Player B", position: "WR", points: 60 }],
    } });
    entries.push({ ...entry("fantasyPros", scoring, "2026-08-20T00:00:00Z", {}), value: {
      ...entry("fantasyPros", scoring, "2026-08-20T00:00:00Z", {}).value,
      players: [{ id: "fp-1", name: "Player A", position: "RB", points: 80 }, { id: "fp-2", name: "Player B", position: "WR", points: 60 }],
    } });
  }
  const result = selectLatestSnapshots({ entries, owned, season: 2026, cutoffAt: "2026-09-09T00:00:00Z" });
  assert.deepEqual(result.snapshotsByFormat.STD.fantasyPros.players.map(row => row.id), ["sleeper-a", "sleeper-b"]);
  assert.deepEqual(result.snapshotsByFormat.PPR.espn.players.map(row => row.id), ["sleeper-a", "sleeper-b"]);
  assert.equal(result.snapshotsByFormat.STD.fantasyPros.players[0].projectionSeason, 2026);
});

test("freeze selector fails closed when any required source is absent", () => {
  assert.throws(() => selectLatestSnapshots({
    entries: [entry("espn", "STD", "2026-08-20T00:00:00Z", { a: 1 })],
    season: 2026, cutoffAt: "2026-09-09T00:00:00Z",
  }), /Missing STD sleeper/);
});

test("final freeze freshness requires every raw input within 72 hours", () => {
  const inputs = ["STD", "PPR"].flatMap(scoring => ["espn", "sleeper", "fantasyPros"].map(source => ({
    scoring, source, file: `${source}-${scoring}.json`, capturedAt: "2026-09-07T00:00:00Z",
  })));
  assert.equal(assessSnapshotFreshness(inputs, "2026-09-09T00:00:00Z").passed, true);
  inputs[0].capturedAt = "2026-09-05T23:59:59Z";
  assert.equal(assessSnapshotFreshness(inputs, "2026-09-09T00:00:00Z").passed, false);
});

test("final freeze freshness requires the owned candidate within 72 hours", () => {
  const cutoffAt = "2026-09-09T00:00:00Z";
  assert.equal(assessOwnedCandidateFreshness({
    generatedAt: "2026-09-07T00:00:00Z",
  }, cutoffAt).passed, true);
  const stale = assessOwnedCandidateFreshness({
    generatedAt: "2026-09-05T23:59:59Z",
  }, cutoffAt);
  assert.equal(stale.passed, false);
  assert.equal(stale.ageMs > stale.maximumAgeMs, true);
  assert.equal(assessOwnedCandidateFreshness({
    generatedAt: "2026-09-09T00:00:01Z",
  }, cutoffAt).passed, false);
});

test("final freeze accepts only the intact manifest-bound candidate and policy", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-final-pin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const finalDirectory = path.join(root, "final");
  fs.mkdirSync(path.join(finalDirectory, "raw"), { recursive: true });
  const records = {
    candidate: { file: "owned-projections-2026.json", content: Buffer.from('{"modelVersion":"draft-goblin-owned-2026.12"}') },
    report: { file: "owned-model-walk-forward.json", content: Buffer.from("{}") },
    model: { file: "model.joblib", content: Buffer.from("model") },
    fetchManifest: { file: "raw/fetch-manifest.json", content: Buffer.from("{}") },
    reproducedCandidate: { file: "reproduced-owned-projections-2026.json", content: Buffer.from('{"modelVersion":"draft-goblin-owned-2026.12"}') },
    verifierReceipt: { file: "shadow-build-manifest.json", content: Buffer.from("{}") },
  };
  const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  const files = {};
  for (const [name, record] of Object.entries(records)) {
    fs.writeFileSync(path.join(finalDirectory, record.file), record.content);
    files[name] = { file: record.file, bytes: record.content.length, sha256: hash(record.content) };
  }
  const policyFile = path.join(root, "projection-model-policy.json");
  const policyBytes = Buffer.from('{"policyVersion":1}');
  fs.writeFileSync(policyFile, policyBytes);
  const cutoffAt = "2026-09-09T00:00:00Z";
  const manifest = {
    schemaVersion: 1,
    artifactType: "owned-final-refresh-private-manifest",
    immutable: true,
    evaluationOnly: true,
    connectedToRuntime: false,
    cutoffAt,
    modelVersion: "draft-goblin-owned-2026.12",
    verification: {
      verified: true,
      savedModelReproductionPassed: true,
      prospectiveOverlayVerified: true,
    },
    preflightReadyToFreeze: true,
    files: {
      ...files,
      policyAtVerification: {
        file: "data/projection-model-policy.json",
        bytes: policyBytes.length,
        sha256: hash(policyBytes),
      },
    },
  };
  fs.writeFileSync(path.join(finalDirectory, "final-refresh-manifest.json"), JSON.stringify(manifest));
  const ownedFile = path.join(finalDirectory, files.candidate.file);
  const ownedBytes = fs.readFileSync(ownedFile);
  const verified = verifyPinnedFinalCandidate({ ownedFile, ownedBytes, cutoffAt, policyFile });
  assert.match(verified.manifestSha256, /^[a-f0-9]{64}$/);

  fs.appendFileSync(path.join(finalDirectory, files.report.file), "tamper");
  assert.throws(() => verifyPinnedFinalCandidate({
    ownedFile, ownedBytes, cutoffAt, policyFile,
  }), /digest verification/);
  fs.writeFileSync(path.join(finalDirectory, files.report.file), records.report.content);
  fs.writeFileSync(policyFile, '{"policyVersion":2}');
  assert.throws(() => verifyPinnedFinalCandidate({
    ownedFile, ownedBytes, cutoffAt, policyFile,
  }), /policy changed/);
  fs.writeFileSync(policyFile, policyBytes);
  manifest.files.report.file = "../escaped-report.json";
  fs.writeFileSync(path.join(finalDirectory, "final-refresh-manifest.json"), JSON.stringify(manifest));
  assert.throws(() => verifyPinnedFinalCandidate({
    ownedFile, ownedBytes, cutoffAt, policyFile,
  }), /escapes its install directory/);
  assert.throws(() => verifyPinnedFinalCandidate({
    ownedFile: path.join(root, "other.json"),
    ownedBytes,
    cutoffAt,
    policyFile,
  }), /final-refresh manifest/);
});
