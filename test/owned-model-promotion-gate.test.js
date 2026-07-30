import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOwnedPromotion, sha256, verifyOwnedPromotion } from "../scripts/owned-model/promotion-gate.js";

function evidence({ candidateDelta = -3, consensusOffset = 8, seasons = [2026, 2027, 2028] } = {}) {
  const rows = [];
  for (const season of seasons) for (const scoring of ["STD", "HALF", "PPR"]) {
    for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) {
      for (let index = 0; index < 30; index += 1) {
        const actual = 40 + index * 4 + (position === "QB" ? 100 : 0);
        const direction = index % 2 ? 1 : -1;
        const consensus = actual + direction * consensusOffset;
        const candidate = consensus + direction * candidateDelta;
        rows.push({
          season,
          scoring,
          position,
          playerId: `${position}-${index}`,
          playerClusterId: `stable-${position}-${index}`,
          team: `T${index % 10}`,
          actual,
          consensus,
          candidate,
          ownedProjection: candidate,
          sourceProjections: {
            espn: actual + direction * (consensusOffset + 2),
            sleeper: actual + direction * (consensusOffset + 3),
            fantasyPros: actual + direction * (consensusOffset + 4),
          },
          cutoffAt: `${season}-09-01T00:00:00Z`,
          featureMaxObservedAt: `${season - 1}-12-31T00:00:00Z`,
        });
      }
    }
  }
  return rows;
}

test("owned promotion gate never promotes automatically and requires prospective evidence", () => {
  const result = evaluateOwnedPromotion({ rows: evidence(), prospectiveShadowSeasons: [], iterations: 500 });
  assert.equal(result.autoPromoted, false);
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /prospective shadow/i);
  assert.equal(result.evaluationTarget, "pure-independent-owned");
});

test("owned promotion gate rejects too few completed seasons and temporal leakage", () => {
  const rows = evidence({ seasons: [2028] });
  assert.equal(evaluateOwnedPromotion({ rows, prospectiveShadowSeasons: [2028], iterations: 200 }).eligible, false);
  rows[0].featureMaxObservedAt = "2028-09-02T00:00:00Z";
  assert.throws(() => evaluateOwnedPromotion({ rows, prospectiveShadowSeasons: [2028], iterations: 200 }), /leakage/i);
});

test("adaptive 2023-2025 development seasons cannot authorize replacement", () => {
  const rows = evidence({ seasons: [2023, 2024, 2025] });
  const result = evaluateOwnedPromotion({
    rows,
    prospectiveShadowSeasons: [2023, 2024, 2025],
    iterations: 200,
  });
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /Adaptive development season 2023 cannot count as promotion evidence/);
  assert.match(result.reasons.join(" "), /Adaptive development season 2025 cannot be declared prospective/);
});

test("pure owned DST regression cannot be hidden by a consensus-only overlay", () => {
  const rows = evidence();
  for (const row of rows) {
    if (row.season === 2028 && row.position === "DST") {
      row.candidate = row.consensus;
      row.ownedProjection = row.actual + 20;
    }
  }
  const result = evaluateOwnedPromotion({ rows, prospectiveShadowSeasons: [2026, 2027, 2028], iterations: 200 });
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /Independent owned forecast 2028 (PPR|STD) DST MAE regresses/);
});

test("prospective season declarations must have paired evidence", () => {
  const result = evaluateOwnedPromotion({ rows: evidence(), prospectiveShadowSeasons: [2026, 2027, 2029], iterations: 200 });
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /2029 has no paired evidence rows/);
});

test("seasons before 2026 cannot be declared prospective", () => {
  const rows = evidence({ seasons: [2020, 2021, 2022] });
  const result = evaluateOwnedPromotion({
    rows,
    prospectiveShadowSeasons: [2020, 2021, 2022],
    iterations: 200,
  });
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /predates the 2026 prospective evidence boundary/);
});

test("replacement requires pure owned superiority over every individual source", () => {
  const rows = evidence();
  for (const row of rows) row.sourceProjections.espn = row.ownedProjection;
  const result = evaluateOwnedPromotion({ rows, prospectiveShadowSeasons: [2026, 2027, 2028], iterations: 200 });
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(" "), /Independent owned forecast does not improve espn MAE|interval does not establish improvement over espn/);
  assert.equal(result.independentOwned.individualSources.espn.evaluable, true);
});

test("a strong overlay cannot mask a worse independent owned forecast", () => {
  const rows = evidence();
  for (const row of rows) {
    row.candidate = row.actual;
    row.ownedProjection = row.consensus + (row.consensus - row.actual);
  }
  const result = evaluateOwnedPromotion({ rows, prospectiveShadowSeasons: [2026, 2027, 2028], iterations: 200 });
  assert.equal(result.overlayDiagnostic.candidate.mae, 0);
  assert.equal(result.independentOwnedEligible, false);
  assert.equal(result.replacementEligible, false);
  assert.equal(result.eligible, false);
});

test("overlay failure does not block a genuinely superior pure owned replacement", () => {
  const rows = evidence();
  for (const row of rows) row.candidate = row.actual + (row.consensus > row.actual ? 20 : -20);
  const result = evaluateOwnedPromotion({ rows, prospectiveShadowSeasons: [2026, 2027, 2028], iterations: 200 });
  assert.equal(result.overlayDiagnostic.eligible, false);
  assert.equal(result.independentOwnedEligible, true);
  assert.equal(result.replacementEligible, true);
  assert.equal(result.eligible, true);
});

test("promotion rows require an exact independent owned projection", () => {
  const rows = evidence();
  delete rows[0].ownedProjection;
  assert.throws(() => evaluateOwnedPromotion({
    rows,
    prospectiveShadowSeasons: [2026, 2027, 2028],
    iterations: 100,
  }), /invalid projection row/);
});

test("promotion authorization parses and requires pure-owned passing evidence", () => {
  const candidateBytes = "candidate";
  const evaluated = evaluateOwnedPromotion({
    rows: evidence(),
    prospectiveShadowSeasons: [2026, 2027, 2028],
    iterations: 200,
  });
  const passingEvidence = {
    ...evaluated,
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
  const evidenceBytes = JSON.stringify(passingEvidence);
  const base = {
    id: "owned-v1",
    candidateSha256: sha256(candidateBytes),
    evidenceSha256: sha256(evidenceBytes),
    season: 2028,
    promotionCandidateKind: "pure-independent-owned",
    promotionGateVersion: 2,
    requireIndependentOwnedSuperiority: true,
  };
  assert.equal(verifyOwnedPromotion({
    candidateBytes,
    evidenceBytes,
    modelId: "owned-v1",
    season: 2028,
    policy: { models: [{ ...base, status: "shadow", eligibleForRuntime: false }] },
  }).authorized, false);
  assert.equal(verifyOwnedPromotion({
    candidateBytes,
    evidenceBytes,
    modelId: "owned-v1",
    season: 2028,
    policy: { models: [{ ...base, status: "promoted", eligibleForRuntime: true }] },
  }).authorized, true);
  const overlayOnly = JSON.stringify({
    ...passingEvidence,
    evaluationTarget: "consensus-anchored-overlay",
  });
  assert.equal(verifyOwnedPromotion({
    candidateBytes,
    evidenceBytes: overlayOnly,
    modelId: "owned-v1",
    season: 2028,
    policy: { models: [{
      ...base,
      evidenceSha256: sha256(overlayOnly),
      status: "promoted",
      eligibleForRuntime: true,
    }] },
  }).authorized, false);
});
