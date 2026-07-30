import test from "node:test";
import assert from "node:assert/strict";
import { buildAuthorizedOwnedRuntimeBundle } from "../scripts/owned-model/build-runtime-bundle.js";
import { evaluateOwnedPromotion, sha256 } from "../scripts/owned-model/promotion-gate.js";

const candidate = {
  schemaVersion: 1,
  artifactType: "draft-goblin-owned-candidate",
  modelVersion: "owned-v1",
  projectionSeason: 2028,
  runtimeStatus: "shadow",
  eligibleAsLiveProjection: false,
  players: [{
    id: "p1",
    name: "Player One",
    team: "T",
    position: "RB",
    meanStd: 100,
    meanHalf: 110,
    meanPpr: 120,
  }],
};
const candidateBytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
const promotionRows = [];
for (const season of [2026, 2027, 2028]) for (const scoring of ["STD", "HALF", "PPR"]) {
  for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) for (let index = 0; index < 30; index += 1) {
    const actual = 100 + index, direction = index % 2 ? 1 : -1;
    promotionRows.push({
      season, scoring, position, playerId: `${position}-${index}`,
      playerClusterId: `stable-${position}-${index}`, team: `T${index % 10}`,
      actual, consensus: actual + direction * 8,
      candidate: actual + direction * 5, ownedProjection: actual + direction * 5,
      sourceProjections: {
        espn: actual + direction * 10,
        sleeper: actual + direction * 11,
        fantasyPros: actual + direction * 12,
      },
      cutoffAt: `${season}-09-01T00:00:00Z`,
      featureMaxObservedAt: `${season - 1}-12-31T00:00:00Z`,
    });
  }
}
const gate = evaluateOwnedPromotion({
  rows: promotionRows,
  prospectiveShadowSeasons: [2026, 2027, 2028],
  iterations: 200,
});
const evidence = {
  ...gate,
  artifactType: "owned-prospective-promotion-evaluation",
  modelVersion: "owned-v1",
  modelRecipeSha256: "f".repeat(64),
  trainingProjectionSourcePolicySha256: "8ef96ed7c7fdc852a2b28b0bad260fd2d1285b14c27b9663f9b78d65df95c3d2",
  season: 2028,
  sourceEvidence: [2026, 2027, 2028].map(season => ({
    season,
    ledgerSha256: "a".repeat(64),
    receiptSha256: "b".repeat(64),
    outcomesSha256: "c".repeat(64),
    ownedCandidateSha256: season === 2028 ? sha256(candidateBytes) : "d".repeat(64),
    finalRefreshManifestSha256: "e".repeat(64),
    modelRecipeSha256: "f".repeat(64),
    trainingProjectionSourcePolicySha256: "8ef96ed7c7fdc852a2b28b0bad260fd2d1285b14c27b9663f9b78d65df95c3d2",
  })),
};
const evidenceBytes = Buffer.from(`${JSON.stringify(evidence)}\n`);
const promotedRecord = {
  id: "owned-v1",
  status: "promoted",
  eligibleForRuntime: true,
  season: 2028,
  candidateSha256: sha256(candidateBytes),
  evidenceSha256: sha256(evidenceBytes),
  promotionCandidateKind: "pure-independent-owned",
  promotionGateVersion: 2,
  requireIndependentOwnedSuperiority: true,
};

test("runtime bundle cannot be built while the owned model remains shadow-only", () => {
  assert.throws(() => buildAuthorizedOwnedRuntimeBundle({
    candidateBytes,
    evidenceBytes,
    policy: { models: [{ ...promotedRecord, status: "shadow", eligibleForRuntime: false }] },
  }), /authorization failed/);
});

test("runtime bundle contains only pure owned projections after exact reviewed authorization", () => {
  const bundle = buildAuthorizedOwnedRuntimeBundle({
    candidateBytes,
    evidenceBytes,
    policy: { models: [promotedRecord] },
    generatedAt: "2027-02-01T00:00:00Z",
  });
  assert.equal(bundle.projectionKind, "pure-independent-owned");
  assert.equal(bundle.players[0].points.PPR, 120);
  assert.equal(bundle.authorization.candidateSha256, sha256(candidateBytes));
  assert.equal("consensus" in bundle.players[0], false);
});

test("hash-correct overlay-only evidence cannot authorize a runtime bundle", () => {
  const overlayBytes = Buffer.from(`${JSON.stringify({
    ...evidence,
    evaluationTarget: "consensus-anchored-overlay",
  })}\n`);
  assert.throws(() => buildAuthorizedOwnedRuntimeBundle({
    candidateBytes,
    evidenceBytes: overlayBytes,
    policy: {
      models: [{
        ...promotedRecord,
        evidenceSha256: sha256(overlayBytes),
      }],
    },
  }), /does not prove independent-owned/);
});

test("aggregate flags cannot authorize incomplete promotion evidence", () => {
  const incompleteBytes = Buffer.from(`${JSON.stringify({
    ...evidence,
    independentOwned: {
      ...evidence.independentOwned,
      slices: [],
      seasonSlices: [],
    },
  })}\n`);
  assert.throws(() => buildAuthorizedOwnedRuntimeBundle({
    candidateBytes,
    evidenceBytes: incompleteBytes,
    policy: {
      models: [{
        ...promotedRecord,
        evidenceSha256: sha256(incompleteBytes),
      }],
    },
  }), /does not prove independent-owned/);
});
