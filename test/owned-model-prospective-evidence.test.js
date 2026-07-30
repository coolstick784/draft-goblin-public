import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPromotionRows, captureProspectiveEvidence, publicReceiptFromLedger, recoverProspectiveReceipt, scoreProspectiveEvidence, writeProspectiveEvidence } from "../scripts/owned-model/prospective-evidence.js";
import { evaluateProspectivePromotion } from "../scripts/owned-model/evaluate-prospective-promotion.js";
import { evaluateOwnedPromotion } from "../scripts/owned-model/promotion-gate.js";

const modelProvenance = {
  modelRecipeSha256: "f".repeat(64),
  trainingProjectionSourcePolicy: {
    projectionFeatureSources: ["nflverse"],
    identityOnlySources: ["sleeper-player-catalog"],
    prohibitedProjectionFeatureSources: ["espn", "sleeper-projections", "fantasypros"],
  },
  trainingProjectionSourcePolicySha256: "8ef96ed7c7fdc852a2b28b0bad260fd2d1285b14c27b9663f9b78d65df95c3d2",
};
const snapshot = (scoring, points) => ({
  season: 2026, scoring, capturedAt: "2026-08-20T00:00:00.000Z",
  players: Object.entries(points).map(([id, value]) => ({ id, points: value, projectionSeason: 2026 })),
});
const owned = {
  ...modelProvenance,
  modelVersion: "owned-test", projectionSeason: 2026, generatedAt: "2026-08-19T00:00:00.000Z",
  runtimeStatus: "shadow", eligibleAsLiveProjection: false,
  players: [
    { id: "s1", gsisId: "00-0000001", ownedPlayerId: "00-0000001", espnId: 101, name: "Player One", position: "RB", meanStd: 90, meanHalf: 100, meanPpr: 110, baseMeanStd: 90, baseMeanHalf: 100, baseMeanPpr: 110 },
    { id: "s2", gsisId: null, nflverseId: "PROV2", ownedPlayerId: "ESPN:202", espnId: 202, name: "Player Two", position: "WR", meanStd: 80, meanHalf: 90, meanPpr: 100, baseMeanStd: 76, baseMeanHalf: 86, baseMeanPpr: 96 },
  ],
};
const completeFrozenEvidence = () => {
  const positions = ["QB", "RB", "WR", "TE", "K", "DST"];
  const players = Array.from({ length: 120 }, (_, index) => {
    const position = positions[index % positions.length];
    const meanStd = 220 - index;
    return {
      id: `full-${index}`,
      name: `Full Player ${index}`,
      position,
      meanStd,
      meanHalf: meanStd + 5,
      meanPpr: meanStd + 10,
      baseMeanStd: position === "WR" ? meanStd - 1 : meanStd,
      baseMeanHalf: position === "WR" ? meanStd + 4 : meanStd + 5,
      baseMeanPpr: position === "WR" ? meanStd + 9 : meanStd + 10,
    };
  });
  const fullOwned = {
    ...modelProvenance,
    modelVersion: "owned-test",
    projectionSeason: 2026,
    generatedAt: "2026-08-19T00:00:00.000Z",
    runtimeStatus: "shadow",
    eligibleAsLiveProjection: false,
    players,
  };
  const snapshotsByFormat = {};
  for (const scoring of ["STD", "HALF", "PPR"]) {
    const offset = scoring === "STD" ? 0 : scoring === "HALF" ? 5 : 10;
    const points = Object.fromEntries(players.map((player, index) => [player.id, 220 - index + offset]));
    snapshotsByFormat[scoring] = {
      espn: snapshot(scoring, points),
      sleeper: snapshot(scoring, points),
      fantasyPros: snapshot(scoring, points),
    };
  }
  return captureProspectiveEvidence({
    owned: fullOwned,
    cutoffAt: "2026-08-21T00:00:00.000Z",
    frozenAt: "2026-08-20T01:00:00.000Z",
    salt: "complete-fixed-test-salt",
    inputDigests: {
      owned: "a".repeat(64),
      finalRefreshManifest: "b".repeat(64),
    },
    snapshotsByFormat,
    requireClosenessGate: true,
  });
};

test("prospective capture keeps provider values private and publishes only aggregates", () => {
  const { ledger, receipt } = captureProspectiveEvidence({
    owned, cutoffAt: "2026-08-21T00:00:00.000Z", frozenAt: "2026-08-20T01:00:00.000Z", salt: "fixed-test-salt",
    snapshotsByFormat: { PPR: { espn: snapshot("PPR", { s1: 111, s2: 101 }), sleeper: snapshot("PPR", { s1: 112, s2: 102 }), fantasyPros: snapshot("PPR", { s1: 113, s2: 103 }) } },
  });
  assert.equal(ledger.rows.length, 2);
  assert.equal(receipt.players, 2);
  assert.equal(receipt.eligibleForLivePromotion, false);
  assert.equal(receipt.ownedWeight, 0.5);
  assert.equal(receipt.candidateCloseness.evaluable, false);
  assert.equal(receipt.pureOwnedEvidence.complete, true);
  assert.ok(Math.abs(ledger.rows[0].candidate - (110 + ledger.rows[0].consensus) / 2) < 1e-9);
  assert.equal("baseCandidate" in ledger.rows[0], false);
  assert.ok(Math.abs(ledger.rows[1].baseCandidate - (96 + ledger.rows[1].consensus) / 2) < 1e-9);
  assert.equal(receipt.diagnosticVariants.noWrRookieSpecialistBase.rows, 1);
  assert.deepEqual(ledger.rows[0].sourceProjections, { espn: 111, sleeper: 112, fantasyPros: 113 });
  assert.equal(receipt.sourceEvidenceCoverage.PPR.espn, 2);
  assert.equal(ledger.rows[0].identityHashes.every(value => /^[a-f0-9]{64}$/.test(value)), true);
  const publicBytes = JSON.stringify(receipt), privateRows = JSON.stringify(ledger.rows);
  assert.equal(publicBytes.includes("Player One"), false);
  assert.equal(publicBytes.includes("s1"), false);
  assert.equal(publicBytes.includes('"sourceProjections"'), false);
  assert.equal(publicBytes.includes('"ownedProjection"'), false);
  assert.equal(publicBytes.includes("111"), false);
  assert.equal(privateRows.includes("espn"), true);
  assert.equal(privateRows.includes("sleeper"), true);
  assert.equal(privateRows.includes("fantasyPros"), true);
});

test("DST remains consensus-only because the owned DST learner failed its safety selector", () => {
  const dstOwned = {
    ...modelProvenance,
    modelVersion: "owned-test", projectionSeason: 2026,
    generatedAt: "2026-08-19T00:00:00.000Z",
    runtimeStatus: "shadow", eligibleAsLiveProjection: false,
    players: [{ id: "ARI", name: "ARI DST", position: "DST", meanStd: 102, meanHalf: 102, meanPpr: 102, baseMeanStd: 102, baseMeanHalf: 102, baseMeanPpr: 102 }],
  };
  const frozen = captureProspectiveEvidence({
    owned: dstOwned, cutoffAt: "2026-08-21T00:00:00.000Z",
    snapshotsByFormat: { PPR: {
      espn: snapshot("PPR", { ARI: 120 }),
      sleeper: snapshot("PPR", { ARI: 120 }),
      fantasyPros: snapshot("PPR", { ARI: 120 }),
    } },
  });
  assert.equal(frozen.ledger.rows[0].candidate, 120);
  assert.equal(frozen.ledger.rows[0].ownedWeight, 0);
  assert.equal(frozen.receipt.positionOwnedWeights.DST, 0);
  assert.equal(frozen.receipt.positionOwnedWeights.RB, 0.5);
});

test("capture rejects any non-preregistered position weight map", () => {
  assert.throws(() => captureProspectiveEvidence({
    owned, cutoffAt: "2026-08-21T00:00:00.000Z",
    positionOwnedWeights: { DST: 0 },
    snapshotsByFormat: { PPR: { espn: snapshot("PPR", { s1: 111 }) } },
  }), /preregistered overlay/);
  assert.throws(() => captureProspectiveEvidence({
    owned, cutoffAt: "2026-08-21T00:00:00.000Z",
    positionOwnedWeights: { QB: .5, RB: .5, WR: .5, TE: .5, K: .5, DST: .5 },
    snapshotsByFormat: { PPR: { espn: snapshot("PPR", { s1: 111 }) } },
  }), /preregistered overlay/);
});

test("immutable writer rejects incomplete or noncanonical evidence", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-freeze-writer-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const incomplete = captureProspectiveEvidence({
    owned,
    cutoffAt: "2026-08-21T00:00:00.000Z",
    snapshotsByFormat: { PPR: { espn: snapshot("PPR", { s1: 111, s2: 101 }) } },
  });
  assert.throws(() => writeProspectiveEvidence({
    ...incomplete,
    ledgerFile: path.join(root, "incomplete.json"),
    receiptFile: path.join(root, "incomplete-receipt.json"),
  }), /18-slice coverage/);
  const wrong = completeFrozenEvidence();
  wrong.ledger.positionOwnedWeights.DST = .5;
  wrong.receipt = publicReceiptFromLedger(wrong.ledger);
  assert.throws(() => writeProspectiveEvidence({
    ...wrong,
    ledgerFile: path.join(root, "wrong.json"),
    receiptFile: path.join(root, "wrong-receipt.json"),
  }), /preregistered overlay/);
});

test("outcome scoring is aggregate-only and leaves promotion unchanged", () => {
  const frozen = captureProspectiveEvidence({
    owned, cutoffAt: "2026-08-21T00:00:00.000Z", salt: "fixed-test-salt",
    snapshotsByFormat: { PPR: { espn: snapshot("PPR", { s1: 111, s2: 101 }), sleeper: snapshot("PPR", { s1: 112, s2: 102 }), fantasyPros: snapshot("PPR", { s1: 113, s2: 103 }) } },
  });
  const report = scoreProspectiveEvidence({
    ...frozen, generatedAt: "2027-01-20T00:00:00.000Z",
    actuals: { season: 2026, complete: true, players: [
      { gsisId: "00-0000001", name: "Player One", position: "RB", pointsPpr: 115 },
      { espnId: 202, name: "Player Two", position: "WR", pointsPpr: 95 },
    ] },
  });
  assert.equal(report.matchedRows, 2);
  assert.equal(report.prospectiveShadowSeasonCompleted, true);
  assert.equal(report.eligibleForLivePromotion, false);
  assert.equal(report.promotionStatus, "unchanged-shadow");
  assert.equal(report.allThreeSources.candidate.players, 2);
  assert.equal(report.bySourceAvailability["3"].consensus.players, 2);
  assert.equal(report.individualSources.espn.rows, 2);
  assert.equal(report.individualSources.espn.source.players, 2);
  assert.equal(report.independentOwnedReplacement.overall.owned.players, 2);
  assert.equal(report.independentOwnedReplacement.individualSources.espn.owned.players, 2);
  assert.equal(report.diagnosticVariants.noWrRookieSpecialistBase.matchedRows, 1);
  assert.equal(report.diagnosticVariants.noWrRookieSpecialistBase.overall.candidate.players, 1);
  assert.equal(report.diagnosticVariants.noWrRookieSpecialistBase.eligibleForLivePromotion, false);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("Player One"), false);
  assert.equal(serialized.includes("identityHashes"), false);
  assert.equal(serialized.includes('"rows":['), false);
  assert.equal(serialized.includes('"sourceProjections"'), false);
  const promotionRows = buildPromotionRows({ ledger: frozen.ledger, actuals: { season: 2026, complete: true, players: [
    { gsisId: "00-0000001", name: "Player One", position: "RB", pointsPpr: 115 },
    { espnId: 202, name: "Player Two", position: "WR", pointsPpr: 95 },
  ] } });
  assert.equal(promotionRows.length, 2);
  assert.equal(promotionRows[0].featureMaxObservedAt, frozen.ledger.featureMaxObservedAt);
  assert.equal("baseCandidate" in promotionRows[0], false);
  assert.equal(Number.isFinite(promotionRows[1].baseCandidate), true);
  assert.equal(promotionRows[0].ownedProjection, 110);
  assert.match(promotionRows[0].playerClusterId, /^[a-f0-9]{64}$/);
  assert.deepEqual(promotionRows[0].sourceProjections, { espn: 111, sleeper: 112, fantasyPros: 113 });
  assert.match(promotionRows[0].playerId, /^[a-f0-9]{64}$/);
});

test("scoring rejects tampered ledgers and incomplete outcomes", () => {
  const frozen = captureProspectiveEvidence({ owned, cutoffAt: "2026-08-21T00:00:00.000Z", salt: "fixed-test-salt", snapshotsByFormat: { PPR: { espn: snapshot("PPR", { s1: 111 }), sleeper: snapshot("PPR", {}), fantasyPros: snapshot("PPR", {}) } } });
  assert.throws(() => scoreProspectiveEvidence({ ledger: { ...frozen.ledger, modelVersion: "tampered" }, receipt: frozen.receipt, actuals: { season: 2026, complete: true, players: [] } }), /digest/i);
  const sourceTamper = structuredClone(frozen.ledger);
  sourceTamper.rows[0].sourceProjections.espn += 1;
  assert.throws(() => scoreProspectiveEvidence({ ledger: sourceTamper, receipt: frozen.receipt, actuals: { season: 2026, complete: true, players: [] } }), /digest/i);
  const receiptTamper = structuredClone(frozen.receipt);
  receiptTamper.sourceEvidenceCoverage.PPR.espn += 1;
  assert.throws(() => scoreProspectiveEvidence({ ledger: frozen.ledger, receipt: receiptTamper, actuals: { season: 2026, complete: true, players: [] } }), /receipt metadata/);
  assert.throws(() => scoreProspectiveEvidence({ ...frozen, actuals: { season: 2026, complete: false, players: [] } }), /completed/i);
});

test("partial receipt publication preserves private evidence and recovers exactly", t => {
  const frozen = completeFrozenEvidence();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-freeze-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerFile = path.join(root, "private", "ledger.json");
  const receiptFile = path.join(root, "public", "receipt.json");
  const failingFileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") return (source, destination) => {
        if (destination === receiptFile) throw new Error("simulated receipt publication failure");
        return target.renameSync(source, destination);
      };
      return target[property];
    },
  });
  assert.throws(() => writeProspectiveEvidence({
    ...frozen, ledgerFile, receiptFile, fileSystem: failingFileSystem,
  }), /Run recovery/);
  assert.equal(fs.existsSync(ledgerFile), true);
  assert.equal(fs.existsSync(`${ledgerFile}.sha256`), true);
  assert.equal(fs.existsSync(receiptFile), false);
  const recovered = recoverProspectiveReceipt({ ledgerFile, receiptFile });
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.receipt, frozen.receipt);
  assert.throws(() => recoverProspectiveReceipt({ ledgerFile, receiptFile }), /overwrite/);
});

test("receipt recovery rejects private ledger corruption", t => {
  const frozen = completeFrozenEvidence();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-freeze-tamper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerFile = path.join(root, "ledger.json");
  const receiptFile = path.join(root, "receipt.json");
  writeProspectiveEvidence({ ...frozen, ledgerFile, receiptFile });
  fs.rmSync(receiptFile);
  fs.appendFileSync(ledgerFile, " ");
  assert.throws(() => recoverProspectiveReceipt({ ledgerFile, receiptFile }), /digest-anchor/);
});

test("scoring rejects participant-only or attrited frozen outcomes", () => {
  const frozen = captureProspectiveEvidence({
    owned, cutoffAt: "2026-08-21T00:00:00.000Z",
    inputDigests: { owned: "candidate-digest" },
    snapshotsByFormat: { PPR: { espn: snapshot("PPR", { s1: 111, s2: 101 }) } },
  });
  const players = [
    { gsisId: "00-0000001", name: "Player One", position: "RB", pointsPpr: 115 },
    { espnId: 202, name: "Player Two", position: "WR", pointsPpr: 0 },
  ];
  assert.throws(() => scoreProspectiveEvidence({
    ...frozen, actuals: { season: 2026, complete: true, players },
  }), /exact frozen candidate population/);
  const bounded = {
    season: 2026, complete: true, players,
    populationBoundary: "frozen-owned-candidate", populationComplete: true,
    frozenCandidateSha256: "candidate-digest",
    population: { candidateRows: 2, unmatchedCandidateRows: 0, zeroRecordedProductionRows: 1 },
  };
  const scored = scoreProspectiveEvidence({ ...frozen, actuals: bounded });
  assert.equal(scored.matchedRows, 2);
  assert.equal(scored.outcomePopulation.zeroRecordedProductionRows, 1);
  assert.equal(scored.outcomePopulation.complete, true);
  assert.throws(() => scoreProspectiveEvidence({
    ...frozen,
    actuals: {
      ...bounded,
      players: players.slice(0, 1),
      population: { ...bounded.population, candidateRows: 1 },
    },
  }), /every frozen projection row/);
});

test("capture rejects a freeze after its preregistered cutoff", () => {
  assert.throws(() => captureProspectiveEvidence({
    owned, cutoffAt: "2026-08-21T00:00:00.000Z", frozenAt: "2026-08-21T00:00:00.001Z",
    snapshotsByFormat: { PPR: { espn: snapshot("PPR", { s1: 111 }) } },
  }), /on or before/i);
});

test("lower-level capture rejects a stale owned candidate", () => {
  assert.throws(() => captureProspectiveEvidence({
    owned: { ...owned, generatedAt: "2026-08-01T00:00:00.000Z" },
    cutoffAt: "2026-08-21T00:00:00.000Z",
    frozenAt: "2026-08-20T00:00:00.000Z",
    snapshotsByFormat: {},
  }), /within 72 hours/);
});

test("private promotion evaluation rejects incomplete frozen coverage and mixed designs", () => {
  const frozen = captureProspectiveEvidence({
    owned, cutoffAt: "2026-08-21T00:00:00.000Z", salt: "fixed-test-salt",
    snapshotsByFormat: { PPR: { espn: snapshot("PPR", { s1: 111, s2: 101 }) } },
  });
  const actuals = { season: 2026, complete: true, players: [
    { gsisId: "00-0000001", name: "Player One", position: "RB", pointsPpr: 115 },
    { espnId: 202, name: "Player Two", position: "WR", pointsPpr: 95 },
  ] };
  assert.throws(() => evaluateProspectivePromotion({
    evidenceSets: [{ ...frozen, actuals }], prospectiveShadowSeasons: [2026], iterations: 100,
  }), /18-slice freeze coverage/);
  const otherModel = structuredClone(frozen);
  otherModel.ledger.modelVersion = "different-owned-model";
  otherModel.receipt = publicReceiptFromLedger(otherModel.ledger);
  assert.throws(() => evaluateProspectivePromotion({
    evidenceSets: [{ ...frozen, actuals }, { ...otherModel, actuals }],
    prospectiveShadowSeasons: [2026], iterations: 100,
  }), /one frozen model/);
});

test("private promotion evaluation binds complete pure-owned evidence to final-refresh provenance", () => {
  const frozen = completeFrozenEvidence();
  const positions = ["QB", "RB", "WR", "TE", "K", "DST"];
  const players = Array.from({ length: 120 }, (_, index) => ({
    name: `Full Player ${index}`,
    position: positions[index % positions.length],
    pointsStd: 220 - index,
    pointsHalf: 225 - index,
    pointsPpr: 230 - index,
  }));
  const actuals = {
    season: 2026,
    complete: true,
    populationBoundary: "frozen-owned-candidate",
    populationComplete: true,
    frozenCandidateSha256: "a".repeat(64),
    population: {
      candidateRows: players.length,
      zeroRecordedProductionRows: 0,
      unmatchedCandidateRows: 0,
    },
    players,
  };
  const report = evaluateProspectivePromotion({
    evidenceSets: [{ ...frozen, actuals }],
    prospectiveShadowSeasons: [2026],
    iterations: 100,
  });
  assert.equal(report.evaluationTarget, "pure-independent-owned");
  assert.equal(report.gateVersion, 2);
  assert.equal(report.modelVersion, "owned-test");
  assert.equal(report.sourceEvidence[0].ownedCandidateSha256, "a".repeat(64));
  assert.equal(report.sourceEvidence[0].finalRefreshManifestSha256, "b".repeat(64));
  assert.equal(report.eligibleForRuntime, false);
});

test("diagnostic base values cannot influence the promotion gate", () => {
  const frozen = captureProspectiveEvidence({
    owned, cutoffAt: "2026-08-21T00:00:00.000Z",
    salt: "fixed-test-salt",
    snapshotsByFormat: {
      PPR: {
        espn: snapshot("PPR", { s1: 111, s2: 101 }),
        sleeper: snapshot("PPR", { s1: 112, s2: 102 }),
        fantasyPros: snapshot("PPR", { s1: 113, s2: 103 }),
      },
    },
  });
  const actuals = { season: 2026, complete: true, players: [
    { gsisId: "00-0000001", name: "Player One", position: "RB", pointsPpr: 115 },
    { espnId: 202, name: "Player Two", position: "WR", pointsPpr: 95 },
  ] };
  const withDiagnostic = buildPromotionRows({ ledger: frozen.ledger, actuals });
  const withoutDiagnostic = withDiagnostic.map(({ baseCandidate: _ignored, ...row }) => row);
  const first = evaluateOwnedPromotion({
    rows: withDiagnostic, prospectiveShadowSeasons: [2026], iterations: 100,
  });
  const second = evaluateOwnedPromotion({
    rows: withoutDiagnostic, prospectiveShadowSeasons: [2026], iterations: 100,
  });
  assert.deepEqual(first, second);
});
