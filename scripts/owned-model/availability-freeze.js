import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AVAILABILITY_SEASON = 2026;
// NFL Week 1 schedule: Patriots at Seahawks, 2026-09-09 8:20 p.m. ET.
// https://www.nfl.com/news/2026-nfl-schedule-release-complete-slate-of-week-1-games
export const FIRST_KICKOFF_AT = "2026-09-10T00:20:00.000Z";
export const DEFAULT_CUTOFF_AT = "2026-09-09T00:00:00.000Z";
export const FREEZE_FRESHNESS_HOURS = 72;
export const AVAILABILITY_ASSETS = Object.freeze([
  {
    key: "weeklyRosters",
    required: true,
    file: "roster_weekly_2026.csv",
    url: "https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_2026.csv",
    requiredColumns: ["season", "team", "position", "status", "gsis_id", "week"],
  },
  {
    key: "injuries",
    required: false,
    file: "injuries_2026.csv",
    url: "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2026.csv",
    requiredColumns: ["season", "team", "week", "gsis_id", "report_status", "practice_status", "date_modified"],
  },
]);

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const iso = value => new Date(value).toISOString();

export function validateAvailabilityBoundary({
  season = AVAILABILITY_SEASON,
  cutoffAt = DEFAULT_CUTOFF_AT,
  firstKickoffAt = FIRST_KICKOFF_AT,
  capturedAt = new Date().toISOString(),
} = {}) {
  const cutoff = Date.parse(cutoffAt);
  const kickoff = Date.parse(firstKickoffAt);
  const captured = Date.parse(capturedAt);
  if (Number(season) !== AVAILABILITY_SEASON) throw new Error("Availability evidence is pinned to the 2026 season.");
  if (![cutoff, kickoff, captured].every(Number.isFinite)) throw new Error("Availability cutoff, kickoff, and capture timestamps must be valid ISO-8601 values.");
  if (cutoff >= kickoff) throw new Error("Availability cutoff must be strictly before the first 2026 regular-season kickoff.");
  if (captured > cutoff) throw new Error("Refusing availability collection after the immutable preseason cutoff.");
  const freezeWindowOpens = cutoff - FREEZE_FRESHNESS_HOURS * 60 * 60 * 1000;
  return {
    season: AVAILABILITY_SEASON,
    cutoffAt: iso(cutoff),
    firstKickoffAt: iso(kickoff),
    capturedAt: iso(captured),
    freezeWindowOpensAt: iso(freezeWindowOpens),
    withinFreezeWindow: captured >= freezeWindowOpens,
  };
}

function parseCsvRecord(record) {
  const values = [];
  let value = "", quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (quoted) {
      if (character === '"' && record[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      values.push(value);
      value = "";
    } else value += character;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  values.push(value);
  return values;
}

function csvRecords(text) {
  const records = [];
  let start = 0, quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (character === "\n" || character === "\r")) {
      const record = text.slice(start, index);
      if (record.trim()) records.push(record);
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      start = index + 1;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted record.");
  const tail = text.slice(start);
  if (tail.trim()) records.push(tail);
  return records;
}

export function validateAvailabilityCsv(bytes, asset, season = AVAILABILITY_SEASON) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  const records = csvRecords(text);
  if (records.length < 2) throw new Error(`${asset.key} CSV has no data rows.`);
  const header = parseCsvRecord(records[0]).map(value => value.trim());
  const duplicate = header.filter((value, index) => header.indexOf(value) !== index);
  if (duplicate.length) throw new Error(`${asset.key} CSV contains duplicate columns: ${[...new Set(duplicate)].join(", ")}.`);
  const missing = asset.requiredColumns.filter(column => !header.includes(column));
  if (missing.length) throw new Error(`${asset.key} CSV is missing required columns: ${missing.join(", ")}.`);
  const seasonIndex = header.indexOf("season");
  const weekIndex = header.indexOf("week");
  let rowCount = 0, minimumWeek = Infinity, maximumWeek = -Infinity;
  for (const record of records.slice(1)) {
    const values = parseCsvRecord(record);
    if (values.length !== header.length) throw new Error(`${asset.key} CSV contains a row with ${values.length} fields; expected ${header.length}.`);
    const rowSeason = Number(values[seasonIndex]);
    if (!Number.isInteger(rowSeason) || rowSeason !== Number(season)) {
      throw new Error(`${asset.key} CSV contains a non-${season} season row.`);
    }
    const week = Number(values[weekIndex]);
    if (!Number.isInteger(week) || week < 0 || week > 25) throw new Error(`${asset.key} CSV contains an invalid week.`);
    minimumWeek = Math.min(minimumWeek, week);
    maximumWeek = Math.max(maximumWeek, week);
    rowCount += 1;
  }
  return {
    schemaColumns: header,
    schemaSha256: sha256(Buffer.from(`${header.join("\n")}\n`)),
    rowCount,
    minimumWeek,
    maximumWeek,
  };
}

async function fetchAsset(asset, fetchImpl, season) {
  let response;
  try {
    response = await fetchImpl(asset.url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "DraftGoblin-owned-model-evidence/1.0" },
    });
  } catch (error) {
    return { key: asset.key, required: asset.required, file: asset.file, sourceUrl: asset.url, status: "network-error", message: String(error?.message || error) };
  }
  if (response.status === 404) {
    return { key: asset.key, required: asset.required, file: asset.file, sourceUrl: asset.url, status: "not-published", httpStatus: 404 };
  }
  if (!response.ok) {
    return { key: asset.key, required: asset.required, file: asset.file, sourceUrl: asset.url, status: "http-error", httpStatus: response.status };
  }
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (!etag && !lastModified) {
    return { key: asset.key, required: asset.required, file: asset.file, sourceUrl: asset.url, status: "invalid-metadata", httpStatus: response.status, message: "Response has neither ETag nor Last-Modified." };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    const validation = validateAvailabilityCsv(bytes, asset, season);
    return {
      key: asset.key, required: asset.required, file: asset.file, sourceUrl: asset.url, status: "available",
      httpStatus: response.status, etag: etag || null, lastModified: lastModified || null,
      contentType: response.headers.get("content-type") || null,
      sha256: sha256(bytes), bytes: bytes.length, ...validation, rawBytes: bytes,
    };
  } catch (error) {
    return {
      key: asset.key, required: asset.required, file: asset.file, sourceUrl: asset.url, status: "invalid-content",
      httpStatus: response.status, etag: etag || null, lastModified: lastModified || null,
      message: String(error?.message || error),
    };
  }
}

const publicAsset = asset => {
  const { rawBytes, schemaColumns, ...receipt } = asset;
  return {
    ...receipt,
    schema: schemaColumns ? { columnCount: schemaColumns.length, sha256: asset.schemaSha256 } : null,
  };
};

export async function preflightAvailability({
  season = AVAILABILITY_SEASON,
  cutoffAt = DEFAULT_CUTOFF_AT,
  firstKickoffAt = FIRST_KICKOFF_AT,
  capturedAt,
  clock = () => new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const startedAt = capturedAt || clock().toISOString();
  validateAvailabilityBoundary({ season, cutoffAt, firstKickoffAt, capturedAt: startedAt });
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  const assets = await Promise.all(AVAILABILITY_ASSETS.map(asset => fetchAsset(asset, fetchImpl, season)));
  const completedAt = capturedAt || clock().toISOString();
  const boundary = validateAvailabilityBoundary({ season, cutoffAt, firstKickoffAt, capturedAt: completedAt });
  const assetsReady = assets.every(asset => (
    asset.status === "available" || (!asset.required && asset.status === "not-published")
  ));
  const readyToFreeze = assetsReady && boundary.withinFreezeWindow;
  const reason = !assetsReady
    ? "The required weekly-roster asset or a published asset is unavailable or invalid; no evidence was written."
    : !boundary.withinFreezeWindow
      ? `Availability evidence may freeze only during the final ${FREEZE_FRESHNESS_HOURS} hours before the cutoff; no evidence was written.`
      : null;
  return {
    schemaVersion: 1,
    artifactType: "owned-availability-preflight",
    evaluationOnly: true,
    writesFrozenEvidence: false,
    noPlayerRows: true,
    ...boundary,
    assets: assets.map(publicAsset),
    readyToFreeze,
    reason,
    _privateAssets: assets,
  };
}

function publicReceiptFromManifest(privateManifest, manifestBytes) {
  return {
    schemaVersion: 1,
    artifactType: "owned-availability-freeze-receipt",
    evidenceCollectionOnly: true,
    connectedToRuntime: false,
    noPlayerRows: true,
    season: privateManifest.season,
    capturedAt: privateManifest.capturedAt,
    cutoffAt: privateManifest.cutoffAt,
    firstKickoffAt: privateManifest.firstKickoffAt,
    freezeFreshnessHours: privateManifest.freezeFreshnessHours,
    freezeWindowOpensAt: privateManifest.freezeWindowOpensAt,
    assets: privateManifest.assets.map(asset => {
      const { schemaColumns, ...publicValue } = asset;
      return publicValue;
    }),
    privateManifestSha256: sha256(manifestBytes),
  };
}

function validatePrivateManifestBoundary(privateManifest) {
  const boundary = validateAvailabilityBoundary({
    season: privateManifest.season,
    capturedAt: privateManifest.capturedAt,
    cutoffAt: privateManifest.cutoffAt,
    firstKickoffAt: privateManifest.firstKickoffAt,
  });
  if (!boundary.withinFreezeWindow) {
    throw new Error("Private availability manifest was captured before the final freshness window.");
  }
  if (Number(privateManifest.freezeFreshnessHours) !== FREEZE_FRESHNESS_HOURS) {
    throw new Error("Private availability manifest has an unexpected freshness policy.");
  }
  if (privateManifest.freezeWindowOpensAt !== boundary.freezeWindowOpensAt) {
    throw new Error("Private availability manifest has an inconsistent freshness boundary.");
  }
  return boundary;
}

export function recoverAvailabilityReceipt({
  privateDirectory = "data/private/owned-model/availability/2026",
  publicReceiptFile = "data/research/owned-availability-freeze-2026.json",
  fileSystem = fs,
} = {}) {
  if (fileSystem.existsSync(publicReceiptFile)) throw new Error("Refusing to overwrite an existing availability receipt.");
  const manifestFile = path.join(privateDirectory, "manifest.json");
  if (!fileSystem.existsSync(manifestFile)) throw new Error("Private availability manifest is unavailable for recovery.");
  const manifestBytes = fileSystem.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  validatePrivateManifestBoundary(manifest);
  for (const asset of manifest.assets.filter(value => value.status === "available")) {
    const rawFile = path.join(privateDirectory, asset.file);
    if (!fileSystem.existsSync(rawFile)) throw new Error(`Private availability bytes are missing: ${asset.file}.`);
    const rawBytes = fileSystem.readFileSync(rawFile);
    if (rawBytes.length !== asset.bytes || sha256(rawBytes) !== asset.sha256) {
      throw new Error(`Private availability bytes failed digest validation: ${asset.file}.`);
    }
  }
  const receipt = publicReceiptFromManifest(manifest, manifestBytes);
  fileSystem.mkdirSync(path.dirname(publicReceiptFile), { recursive: true });
  fileSystem.writeFileSync(publicReceiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return { publicReceiptFile, receipt, recovered: true };
}

export async function freezeAvailability({
  privateDirectory = "data/private/owned-model/availability/2026",
  publicReceiptFile = "data/research/owned-availability-freeze-2026.json",
  fileSystem = fs,
  ...options
} = {}) {
  if (fileSystem.existsSync(privateDirectory) || fileSystem.existsSync(publicReceiptFile)) {
    throw new Error("Refusing to overwrite immutable availability evidence.");
  }
  const preflight = await preflightAvailability(options);
  if (!preflight.readyToFreeze) {
    throw new Error(`Required availability assets are not ready: ${JSON.stringify(preflight.assets)}`);
  }
  const assets = preflight._privateAssets;
  const privateManifest = {
    schemaVersion: 1,
    artifactType: "owned-availability-private-manifest",
    noRuntimeEffect: true,
    season: preflight.season,
    capturedAt: preflight.capturedAt,
    cutoffAt: preflight.cutoffAt,
    firstKickoffAt: preflight.firstKickoffAt,
    freezeFreshnessHours: FREEZE_FRESHNESS_HOURS,
    freezeWindowOpensAt: preflight.freezeWindowOpensAt,
    assets: assets.map(asset => ({
      ...publicAsset(asset),
      schemaColumns: asset.schemaColumns,
    })),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(privateManifest, null, 2)}\n`);
  const publicReceipt = publicReceiptFromManifest(privateManifest, manifestBytes);
  const privateParent = path.dirname(privateDirectory);
  const stageDirectory = path.join(privateParent, `.${path.basename(privateDirectory)}.staging-${crypto.randomUUID()}`);
  const publicStageFile = path.join(path.dirname(publicReceiptFile), `.${path.basename(publicReceiptFile)}.staging-${crypto.randomUUID()}`);
  fileSystem.mkdirSync(privateParent, { recursive: true });
  fileSystem.mkdirSync(path.dirname(publicReceiptFile), { recursive: true });
  try {
    fileSystem.mkdirSync(stageDirectory);
    for (const asset of assets.filter(value => value.status === "available")) {
      fileSystem.writeFileSync(path.join(stageDirectory, asset.file), asset.rawBytes, { flag: "wx" });
    }
    fileSystem.writeFileSync(path.join(stageDirectory, "manifest.json"), manifestBytes, { flag: "wx" });
    fileSystem.writeFileSync(publicStageFile, `${JSON.stringify(publicReceipt, null, 2)}\n`, { flag: "wx" });
    fileSystem.renameSync(stageDirectory, privateDirectory);
    fileSystem.renameSync(publicStageFile, publicReceiptFile);
  } catch (error) {
    if (fileSystem.existsSync(stageDirectory)) fileSystem.rmSync(stageDirectory, { recursive: true, force: true });
    if (fileSystem.existsSync(publicStageFile)) fileSystem.rmSync(publicStageFile, { force: true });
    if (fileSystem.existsSync(privateDirectory) && !fileSystem.existsSync(publicReceiptFile)) {
      throw new Error(`Private evidence froze successfully but public receipt publication failed. Run recovery; private bytes were preserved. Cause: ${error?.message || error}`);
    }
    throw error;
  }
  return { privateDirectory, publicReceiptFile, receipt: publicReceipt };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [mode = "preflight", cutoffAt = DEFAULT_CUTOFF_AT, privateDirectory, publicReceiptFile] = process.argv.slice(2);
  if (!["preflight", "freeze", "recover"].includes(mode)) {
    throw new Error("Usage: availability-freeze.js <preflight|freeze|recover> [cutoff-ISO-8601] [private-directory] [public-receipt.json]");
  }
  if (mode === "preflight") {
    const result = await preflightAvailability({ cutoffAt });
    const { _privateAssets, ...output } = result;
    console.log(JSON.stringify(output, null, 2));
  } else if (mode === "freeze") {
    const result = await freezeAvailability({
      cutoffAt,
      ...(privateDirectory ? { privateDirectory } : {}),
      ...(publicReceiptFile ? { publicReceiptFile } : {}),
    });
    console.log(JSON.stringify({
      privateDirectory: result.privateDirectory,
      publicReceiptFile: result.publicReceiptFile,
      assets: result.receipt.assets.map(asset => ({ key: asset.key, sha256: asset.sha256, bytes: asset.bytes })),
    }, null, 2));
  } else {
    const result = recoverAvailabilityReceipt({
      ...(privateDirectory ? { privateDirectory } : {}),
      ...(publicReceiptFile ? { publicReceiptFile } : {}),
    });
    console.log(JSON.stringify({
      publicReceiptFile: result.publicReceiptFile,
      recovered: true,
      privateManifestSha256: result.receipt.privateManifestSha256,
    }, null, 2));
  }
}
