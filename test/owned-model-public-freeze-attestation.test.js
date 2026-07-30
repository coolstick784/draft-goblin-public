import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  checksumSubjects,
  verifyPublicFreezeReceipt,
} from "../scripts/owned-model/verify-public-freeze-receipt.js";

const formats = ["HALF", "PPR", "STD"];
const positions = ["QB", "RB", "WR", "TE", "K", "DST"];
const slices = formats.flatMap(scoring => positions.map(position => `${scoring}:${position}`));
const receipt = {
  schemaVersion: 1,
  artifactType: "owned-prospective-freeze-receipt",
  projectionSeason: 2026,
  modelVersion: "draft-goblin-owned-2026.12",
  frozenAt: "2026-09-08T20:00:00Z",
  cutoffAt: "2026-09-09T00:00:00Z",
  evaluationOnly: true,
  eligibleForLivePromotion: false,
  candidateMethod: "position-aware-consensus-anchored-owned-overlay",
  ownedForecastMethod: "pure-independent-owned",
  formats,
  players: 180,
  positionOwnedWeights: { QB: .5, RB: .5, WR: .5, TE: .5, K: .5, DST: 0 },
  ledgerSha256: "a".repeat(64),
  inputDigests: {
    owned: "b".repeat(64),
    finalRefreshManifest: "c".repeat(64),
  },
  candidateCloseness: {
    evaluable: true,
    passed: true,
    spearman: .974,
    medianStandardizedDistance: .108,
    p90StandardizedDistance: .389,
    limits: {
      minimumSpearman: .95,
      maximumMedianStandardizedDistance: .2,
      maximumP90StandardizedDistance: .5,
    },
    coveredSlices: slices,
    sliceRows: Object.fromEntries(slices.map(slice => [slice, 10])),
  },
  pureOwnedEvidence: { complete: true, privateRows: 180, eligibleForLivePromotion: false },
  sourceAvailability: {},
  sourceEvidenceCoverage: {},
};
const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);

test("public receipt validator emits attestable digests without private rows", () => {
  const result = verifyPublicFreezeReceipt({
    receiptBytes: bytes,
    expectedSeason: 2026,
    expectedCutoffAt: "2026-09-09T00:00:00Z",
    expectedModelVersion: "draft-goblin-owned-2026.12",
    now: new Date("2026-09-08T21:00:00Z"),
  });
  const subjects = checksumSubjects(result, "owned-prospective-freeze-2026.json");
  assert.match(subjects, /^b{64} \*owned-projections-2026\.private\.json/m);
  assert.match(subjects, /^a{64} \*owned-prospective-ledger-2026\.private\.json/m);
  assert.match(subjects, /owned-prospective-freeze-2026\.json/);
  assert.equal(subjects.includes("sourceProjections"), false);
});

test("public receipt validator rejects private fields, incomplete coverage, and late runs", () => {
  assert.throws(() => verifyPublicFreezeReceipt({
    receiptBytes: Buffer.from(JSON.stringify({ ...receipt, rows: [] })),
    expectedSeason: 2026,
    expectedCutoffAt: receipt.cutoffAt,
    expectedModelVersion: receipt.modelVersion,
    now: new Date("2026-09-08T21:00:00Z"),
  }), /private field/);
  assert.throws(() => verifyPublicFreezeReceipt({
    receiptBytes: Buffer.from(JSON.stringify({
      ...receipt,
      candidateCloseness: { ...receipt.candidateCloseness, coveredSlices: slices.slice(1) },
    })),
    expectedSeason: 2026,
    expectedCutoffAt: receipt.cutoffAt,
    expectedModelVersion: receipt.modelVersion,
    now: new Date("2026-09-08T21:00:00Z"),
  }), /18-slice/);
  assert.throws(() => verifyPublicFreezeReceipt({
    receiptBytes: Buffer.from(JSON.stringify({
      ...receipt,
      candidateCloseness: { ...receipt.candidateCloseness, passed: false },
    })),
    expectedSeason: 2026,
    expectedCutoffAt: receipt.cutoffAt,
    expectedModelVersion: receipt.modelVersion,
    now: new Date("2026-09-08T21:00:00Z"),
  }), /18-slice/);
  assert.throws(() => verifyPublicFreezeReceipt({
    receiptBytes: Buffer.from(JSON.stringify({
      ...receipt,
      candidateCloseness: {
        ...receipt.candidateCloseness,
        limits: { ...receipt.candidateCloseness.limits, minimumSpearman: .8 },
      },
    })),
    expectedSeason: 2026,
    expectedCutoffAt: receipt.cutoffAt,
    expectedModelVersion: receipt.modelVersion,
    now: new Date("2026-09-08T21:00:00Z"),
  }), /18-slice/);
  assert.throws(() => verifyPublicFreezeReceipt({
    receiptBytes: bytes,
    expectedSeason: 2026,
    expectedCutoffAt: receipt.cutoffAt,
    expectedModelVersion: receipt.modelVersion,
    now: new Date("2026-09-09T00:00:01Z"),
  }), /before its preregistered cutoff/);
});

test("attestation workflow has no artifact upload or private-ledger path", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/attest-owned-prospective-freeze.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /uses: actions\/attest@v4/);
  assert.match(workflow, /subject-checksums:/);
  assert.match(workflow, /visibility != 'public'/);
  assert.doesNotMatch(workflow, /upload-artifact|prospective-2026\.json|model\.joblib/);
});
