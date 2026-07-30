import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasExactOwnedOverlayClosenessLimits,
  OWNED_OVERLAY_CLOSENESS_LIMITS,
} from "./overlay-policy.js";

const FORMATS = ["STD", "HALF", "PPR"];
const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];
const POSITION_WEIGHTS = { QB: .5, RB: .5, WR: .5, TE: .5, K: .5, DST: 0 };
const FORBIDDEN_PRIVATE_KEYS = new Set([
  "rows", "row", "salt", "identityHashes", "playerClusterId", "teamClusterId",
  "playerId", "sourceProjections", "ownedProjection", "baseCandidate",
]);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const validDigest = value => /^[a-f0-9]{64}$/.test(String(value || ""));

function assertNoPrivateFields(value, location = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateFields(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PRIVATE_KEYS.has(key)) {
      throw new Error(`Public freeze receipt contains private field ${location}.${key}.`);
    }
    assertNoPrivateFields(child, `${location}.${key}`);
  }
}

export function verifyPublicFreezeReceipt({
  receiptBytes,
  expectedSeason,
  expectedCutoffAt,
  expectedModelVersion,
  now = new Date(),
}) {
  let receipt;
  try {
    receipt = JSON.parse(Buffer.from(receiptBytes).toString("utf8"));
  } catch {
    throw new Error("Public freeze receipt is not valid JSON.");
  }
  assertNoPrivateFields(receipt);
  const season = Number(expectedSeason);
  if (receipt.schemaVersion !== 1
      || receipt.artifactType !== "owned-prospective-freeze-receipt"
      || Number(receipt.projectionSeason) !== season
      || receipt.modelVersion !== expectedModelVersion
      || receipt.evaluationOnly !== true
      || receipt.eligibleForLivePromotion !== false) {
    throw new Error("Public freeze receipt failed its shadow/model boundary.");
  }
  if (receipt.cutoffAt !== expectedCutoffAt
      || !Number.isFinite(Date.parse(receipt.frozenAt))
      || Date.parse(receipt.frozenAt) > Date.parse(expectedCutoffAt)
      || now.getTime() > Date.parse(expectedCutoffAt)) {
    throw new Error("Public freeze receipt was not verified before its preregistered cutoff.");
  }
  if (JSON.stringify(receipt.formats) !== JSON.stringify(FORMATS.slice().sort())
      || JSON.stringify(receipt.positionOwnedWeights) !== JSON.stringify(POSITION_WEIGHTS)
      || receipt.ownedForecastMethod !== "pure-independent-owned") {
    throw new Error("Public freeze receipt does not match the preregistered design.");
  }
  const closeness = receipt.candidateCloseness;
  const expectedSlices = FORMATS.flatMap(scoring =>
    POSITIONS.map(position => `${scoring}:${position}`)
  );
  if (closeness?.evaluable !== true
      || closeness?.passed !== true
      || !hasExactOwnedOverlayClosenessLimits(closeness?.limits)
      || Number(closeness?.spearman) < OWNED_OVERLAY_CLOSENESS_LIMITS.minimumSpearman
      || Number(closeness?.medianStandardizedDistance) > OWNED_OVERLAY_CLOSENESS_LIMITS.maximumMedianStandardizedDistance
      || Number(closeness?.p90StandardizedDistance) > OWNED_OVERLAY_CLOSENESS_LIMITS.maximumP90StandardizedDistance
      || !Array.isArray(closeness.coveredSlices)
      || closeness.coveredSlices.length !== expectedSlices.length
      || expectedSlices.some(slice => !closeness.coveredSlices.includes(slice))
      || expectedSlices.some(slice => Number(closeness.sliceRows?.[slice]) < 10)) {
    throw new Error("Public freeze receipt lacks complete evaluable 18-slice coverage.");
  }
  if (!Number.isInteger(Number(receipt.players)) || Number(receipt.players) <= 0
      || receipt.pureOwnedEvidence?.complete !== true
      || Number(receipt.pureOwnedEvidence.privateRows) !== Number(receipt.players)) {
    throw new Error("Public freeze receipt lacks complete pure-owned evidence.");
  }
  const candidateSha256 = receipt.inputDigests?.owned;
  const finalRefreshManifestSha256 = receipt.inputDigests?.finalRefreshManifest;
  if (!validDigest(receipt.ledgerSha256)
      || !validDigest(candidateSha256)
      || !validDigest(finalRefreshManifestSha256)) {
    throw new Error("Public freeze receipt lacks final-refresh or ledger digest provenance.");
  }
  return {
    season,
    receiptSha256: digest(receiptBytes),
    candidateSha256,
    ledgerSha256: receipt.ledgerSha256,
    finalRefreshManifestSha256,
  };
}

export function checksumSubjects(result, receiptName) {
  return [
    `${result.candidateSha256} *owned-projections-${result.season}.private.json`,
    `${result.ledgerSha256} *owned-prospective-ledger-${result.season}.private.json`,
    `${result.receiptSha256} *${receiptName}`,
  ].join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [receiptFile, outputFile, seasonRaw = "2026",
    cutoffAt = "2026-09-09T00:00:00Z",
    modelVersion = "draft-goblin-owned-2026.12"] = process.argv.slice(2);
  if (!receiptFile || !outputFile) {
    throw new Error("Usage: verify-public-freeze-receipt.js <receipt.json> <checksums.txt> [season] [cutoff] [model-version]");
  }
  const bytes = fs.readFileSync(receiptFile);
  const result = verifyPublicFreezeReceipt({
    receiptBytes: bytes,
    expectedSeason: Number(seasonRaw),
    expectedCutoffAt: cutoffAt,
    expectedModelVersion: modelVersion,
  });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, checksumSubjects(result, path.basename(receiptFile)), { flag: "wx" });
  console.log(JSON.stringify({ verified: true, receipt: receiptFile, ...result }, null, 2));
}
