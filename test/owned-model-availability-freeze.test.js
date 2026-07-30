import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AVAILABILITY_ASSETS,
  FREEZE_FRESHNESS_HOURS,
  freezeAvailability,
  preflightAvailability,
  recoverAvailabilityReceipt,
  validateAvailabilityBoundary,
  validateAvailabilityCsv,
} from "../scripts/owned-model/availability-freeze.js";

const rosterCsv = "season,team,position,status,gsis_id,week,full_name\n2026,SEA,QB,Active,00-0000001,0,Example Quarterback\n";
const injuryCsv = "season,team,week,gsis_id,report_status,practice_status,date_modified,full_name\n2026,SEA,1,00-0000001,Questionable,Limited,2026-09-08T12:00:00Z,Example Quarterback\n";
const response = (body, status = 200, headers = {}) => new Response(body, {
  status,
  headers: status === 200 ? { etag: '"fixture"', "content-type": "text/csv", ...headers } : headers,
});
const successfulFetch = async url => response(url.includes("weekly_rosters") ? rosterCsv : injuryCsv);

test("availability boundary is pinned before the first 2026 kickoff", () => {
  const boundary = validateAvailabilityBoundary({
    capturedAt: "2026-09-08T00:00:00Z",
  });
  assert.equal(boundary.season, 2026);
  assert.equal(FREEZE_FRESHNESS_HOURS, 72);
  assert.equal(boundary.freezeWindowOpensAt, "2026-09-06T00:00:00.000Z");
  assert.equal(boundary.withinFreezeWindow, true);
  assert.throws(() => validateAvailabilityBoundary({
    cutoffAt: "2026-09-10T00:20:00Z",
    capturedAt: "2026-09-08T00:00:00Z",
  }), /strictly before/);
  assert.throws(() => validateAvailabilityBoundary({
    capturedAt: "2026-09-09T00:00:01Z",
  }), /after the immutable/);
});

test("early preflight remains read-only but cannot authorize a stale freeze", async () => {
  const result = await preflightAvailability({
    capturedAt: "2026-07-17T00:00:00Z",
    fetchImpl: successfulFetch,
  });
  assert.equal(result.assets.every(asset => asset.status === "available"), true);
  assert.equal(result.withinFreezeWindow, false);
  assert.equal(result.readyToFreeze, false);
  assert.match(result.reason, /final 72 hours/);
});

test("freeze refuses otherwise-valid evidence before the freshness window", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-availability-early-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(() => freezeAvailability({
    privateDirectory: path.join(root, "private", "2026"),
    publicReceiptFile: path.join(root, "public.json"),
    capturedAt: "2026-07-17T00:00:00Z",
    fetchImpl: successfulFetch,
  }), /not ready/);
});

test("availability CSV validation enforces schema, season, and week", () => {
  const valid = validateAvailabilityCsv(Buffer.from(rosterCsv), AVAILABILITY_ASSETS[0]);
  assert.equal(valid.rowCount, 1);
  assert.equal(valid.minimumWeek, 0);
  assert.match(valid.schemaSha256, /^[a-f0-9]{64}$/);
  assert.throws(() => validateAvailabilityCsv(
    Buffer.from(rosterCsv.replace("2026,SEA", "2025,SEA")),
    AVAILABILITY_ASSETS[0],
  ), /non-2026/);
  assert.throws(() => validateAvailabilityCsv(
    Buffer.from("season,team,week\n2026,SEA,0\n"),
    AVAILABILITY_ASSETS[0],
  ), /missing required columns/);
});

test("preflight validates both assets without exposing raw or player rows", async () => {
  const result = await preflightAvailability({
    capturedAt: "2026-09-08T00:00:00Z",
    fetchImpl: successfulFetch,
  });
  assert.equal(result.readyToFreeze, true);
  assert.equal(result.writesFrozenEvidence, false);
  assert.equal(result.assets.length, 2);
  assert.equal(result.assets[0].rowCount, 1);
  assert.equal("rawBytes" in result.assets[0], false);
  assert.equal("schemaColumns" in result.assets[0], false);
  assert.match(result.assets[0].sha256, /^[a-f0-9]{64}$/);
});

test("preflight handles an unpublished asset without writing or guessing", async () => {
  const result = await preflightAvailability({
    capturedAt: "2026-09-08T00:00:00Z",
    fetchImpl: async url => url.includes("injuries") ? response("", 404) : response(rosterCsv),
  });
  assert.equal(result.readyToFreeze, true);
  assert.equal(result.assets.find(asset => asset.key === "injuries").status, "not-published");
  assert.equal(result.assets.find(asset => asset.key === "injuries").required, false);
});

test("preflight rejects when download completion crosses the cutoff", async () => {
  const times = [
    new Date("2026-09-08T23:59:59Z"),
    new Date("2026-09-09T00:00:01Z"),
  ];
  await assert.rejects(() => preflightAvailability({
    clock: () => times.shift(),
    fetchImpl: successfulFetch,
  }), /after the immutable/);
});

test("freeze writes immutable private bytes and an aggregate-only public receipt", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-availability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private", "2026");
  const publicReceiptFile = path.join(root, "public.json");
  const result = await freezeAvailability({
    privateDirectory,
    publicReceiptFile,
    capturedAt: "2026-09-08T00:00:00Z",
    fetchImpl: successfulFetch,
  });
  assert.deepEqual(fs.readFileSync(path.join(privateDirectory, "roster_weekly_2026.csv"), "utf8"), rosterCsv);
  assert.deepEqual(fs.readFileSync(path.join(privateDirectory, "injuries_2026.csv"), "utf8"), injuryCsv);
  const receipt = JSON.parse(fs.readFileSync(publicReceiptFile));
  assert.equal(receipt.connectedToRuntime, false);
  assert.equal(receipt.noPlayerRows, true);
  assert.equal(receipt.freezeFreshnessHours, 72);
  assert.equal(receipt.freezeWindowOpensAt, "2026-09-06T00:00:00.000Z");
  assert.equal(JSON.stringify(receipt).includes("Example Quarterback"), false);
  assert.match(receipt.privateManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.assets.every(asset => asset.etag === '"fixture"'), true);
  await assert.rejects(() => freezeAvailability({
    privateDirectory,
    publicReceiptFile,
    capturedAt: "2026-09-08T00:00:00Z",
    fetchImpl: successfulFetch,
  }), /Refusing to overwrite/);
});

test("freeze preserves required roster evidence when optional injury is unpublished", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-availability-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private", "2026");
  const publicReceiptFile = path.join(root, "public.json");
  const result = await freezeAvailability({
    privateDirectory,
    publicReceiptFile,
    capturedAt: "2026-09-08T00:00:00Z",
    fetchImpl: async url => url.includes("injuries") ? response("", 404) : response(rosterCsv),
  });
  assert.equal(fs.existsSync(path.join(privateDirectory, "roster_weekly_2026.csv")), true);
  assert.equal(fs.existsSync(path.join(privateDirectory, "injuries_2026.csv")), false);
  assert.equal(result.receipt.assets.find(asset => asset.key === "injuries").status, "not-published");
});

test("freeze refuses when the required weekly roster is unpublished", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-availability-roster-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private", "2026");
  const publicReceiptFile = path.join(root, "public.json");
  await assert.rejects(() => freezeAvailability({
    privateDirectory,
    publicReceiptFile,
    capturedAt: "2026-09-08T00:00:00Z",
    fetchImpl: async url => url.includes("weekly_rosters") ? response("", 404) : response(injuryCsv),
  }), /not ready/);
  assert.equal(fs.existsSync(privateDirectory), false);
});

test("failed public publication is recoverable from verified private evidence", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-availability-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private", "2026");
  const publicReceiptFile = path.join(root, "public.json");
  let failPublication = true;
  const failingFs = {
    ...fs,
    renameSync(source, target) {
      if (target === publicReceiptFile && failPublication) {
        failPublication = false;
        throw new Error("simulated receipt publication failure");
      }
      return fs.renameSync(source, target);
    },
  };
  await assert.rejects(() => freezeAvailability({
    privateDirectory,
    publicReceiptFile,
    capturedAt: "2026-09-08T00:00:00Z",
    fetchImpl: successfulFetch,
    fileSystem: failingFs,
  }), /Run recovery/);
  assert.equal(fs.existsSync(path.join(privateDirectory, "manifest.json")), true);
  assert.equal(fs.existsSync(publicReceiptFile), false);
  const recovered = recoverAvailabilityReceipt({ privateDirectory, publicReceiptFile });
  assert.equal(recovered.recovered, true);
  assert.equal(JSON.parse(fs.readFileSync(publicReceiptFile)).noPlayerRows, true);
});

test("receipt recovery rejects an early or freshness-policy-tampered manifest", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-availability-tamper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateDirectory = path.join(root, "private", "2026");
  const publicReceiptFile = path.join(root, "public.json");
  fs.mkdirSync(privateDirectory, { recursive: true });
  fs.writeFileSync(path.join(privateDirectory, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    artifactType: "owned-availability-private-manifest",
    noRuntimeEffect: true,
    season: 2026,
    capturedAt: "2026-07-17T00:00:00.000Z",
    cutoffAt: "2026-09-09T00:00:00.000Z",
    firstKickoffAt: "2026-09-10T00:20:00.000Z",
    freezeFreshnessHours: 72,
    freezeWindowOpensAt: "2026-09-06T00:00:00.000Z",
    assets: [],
  }));
  assert.throws(() => recoverAvailabilityReceipt({
    privateDirectory,
    publicReceiptFile,
  }), /before the final freshness window/);
  assert.equal(fs.existsSync(publicReceiptFile), false);
  fs.writeFileSync(path.join(privateDirectory, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    artifactType: "owned-availability-private-manifest",
    noRuntimeEffect: true,
    season: 2026,
    capturedAt: "2026-09-08T00:00:00.000Z",
    cutoffAt: "2026-09-09T00:00:00.000Z",
    firstKickoffAt: "2026-09-10T00:20:00.000Z",
    freezeFreshnessHours: 24,
    freezeWindowOpensAt: "2026-09-06T00:00:00.000Z",
    assets: [],
  }));
  assert.throws(() => recoverAvailabilityReceipt({
    privateDirectory,
    publicReceiptFile,
  }), /unexpected freshness policy/);
  assert.equal(fs.existsSync(publicReceiptFile), false);
});
