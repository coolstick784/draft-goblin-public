import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalRefreshCommands, runFinalRefresh, verifyFinalRefresh } from "../scripts/owned-model/refresh-final.js";

const owned = {
  modelVersion: "draft-goblin-owned-2026.12",
  projectionSeason: 2026,
  generatedAt: "2026-09-07T00:00:00Z",
  runtimeStatus: "shadow",
  eligibleAsLiveProjection: false,
  players: [
    { id: "rb", position: "RB", meanStd: 90, meanPpr: 110, baseMeanStd: 90, baseMeanHalf: 100, baseMeanPpr: 110 },
    { id: "wr", position: "WR", meanStd: 80, meanPpr: 105, baseMeanStd: 70, baseMeanHalf: 80, baseMeanPpr: 90 },
  ],
};
const report = {
  modelVersion: "draft-goblin-owned-2026.12",
  eligibility: { eligibleForLivePromotion: false },
};
const policy = {
  models: [{
    id: "draft-goblin-owned-2026.12",
    status: "shadow",
    eligibleForRuntime: false,
    promotionCandidateKind: "pure-independent-owned",
    promotionGateVersion: 2,
    requireIndependentOwnedSuperiority: true,
    prospectiveOverlay: {
      candidateMethod: "position-aware-consensus-anchored-owned-overlay",
      scoringFormats: ["STD", "HALF", "PPR"],
      positionOwnedWeights: { QB: .5, RB: .5, WR: .5, TE: .5, K: .5, DST: 0 },
      closenessLimits: {
        minimumSpearman: .95,
        maximumMedianStandardizedDistance: .2,
        maximumP90StandardizedDistance: .5,
      },
      minimumRowsPerFormatPositionSlice: 10,
      immutableAfterCutoff: true,
    },
  }],
};

test("final refresh verification requires a fresh shadow-only pinned candidate", () => {
  const result = verifyFinalRefresh({
    owned, reproduced: { ...owned, generatedAt: "2026-09-07T00:01:00Z" },
    report, policy, cutoffAt: "2026-09-09T00:00:00Z",
  });
  assert.equal(result.verified, true);
  assert.equal(result.ownedCandidateFreshness.passed, true);
  assert.equal(result.diagnosticBaseCoverage.passed, true);
  assert.equal(result.prospectiveOverlayVerified, true);
});

test("final refresh verification rejects stale or promoted candidates", () => {
  const stale = verifyFinalRefresh({
    owned: { ...owned, generatedAt: "2026-09-01T00:00:00Z" },
    reproduced: { ...owned, generatedAt: "2026-09-07T00:01:00Z" },
    report, policy, cutoffAt: "2026-09-09T00:00:00Z",
  });
  assert.equal(stale.verified, false);
  assert.match(stale.reasons.join(" "), /within 72 hours/);
  const promoted = verifyFinalRefresh({
    owned: { ...owned, runtimeStatus: "promoted", eligibleAsLiveProjection: true },
    reproduced: { ...owned, runtimeStatus: "promoted", eligibleAsLiveProjection: true, generatedAt: "2026-09-07T00:01:00Z" },
    report,
    policy: { models: [{ ...policy.models[0], status: "promoted", eligibleForRuntime: true }] },
    cutoffAt: "2026-09-09T00:00:00Z",
  });
  assert.equal(promoted.verified, false);
  assert.match(promoted.reasons.join(" "), /shadow-only/);
  const drifted = verifyFinalRefresh({
    owned, reproduced: { ...owned, generatedAt: "2026-09-07T00:01:00Z" }, report,
    policy: {
      models: [{
        ...policy.models[0],
        prospectiveOverlay: {
          ...policy.models[0].prospectiveOverlay,
          positionOwnedWeights: {
            ...policy.models[0].prospectiveOverlay.positionOwnedWeights,
            DST: .5,
          },
        },
      }],
    },
    cutoffAt: "2026-09-09T00:00:00Z",
  });
  assert.equal(drifted.verified, false);
  assert.match(drifted.reasons.join(" "), /position-aware overlay/);
  const loosened = verifyFinalRefresh({
    owned, reproduced: { ...owned, generatedAt: "2026-09-07T00:01:00Z" }, report,
    policy: {
      models: [{
        ...policy.models[0],
        prospectiveOverlay: {
          ...policy.models[0].prospectiveOverlay,
          closenessLimits: {
            ...policy.models[0].prospectiveOverlay.closenessLimits,
            minimumSpearman: .8,
          },
        },
      }],
    },
    cutoffAt: "2026-09-09T00:00:00Z",
  });
  assert.equal(loosened.verified, false);
  assert.match(loosened.reasons.join(" "), /position-aware overlay/);
});

test("final refresh command is cross-platform and fetches 2026 depth before training", () => {
  const commands = finalRefreshCommands({ python: "test-python", stageDirectory: "stage" });
  assert.equal(commands.python, "test-python");
  assert.deepEqual(commands.fetch, [
    "scripts/fetch-owned-model-data.py", "--end-season", "2025",
    "--depth-end-season", "2026", "--output", path.join("stage", "raw"),
  ]);
  assert.equal(commands.train.includes(path.join("stage", "owned-projections-2026.json")), true);
  assert.equal(commands.predict.includes(path.join("stage", "model.joblib")), true);
  assert.equal(commands.verify.includes(path.join("stage", "reproduced-owned-projections-2026.json")), true);
});

function fixtureRunner({ invalidVersion = false } = {}) {
  return (_python, args) => {
    const value = flag => args[args.indexOf(flag) + 1];
    if (args[0].endsWith("fetch-owned-model-data.py")) {
      const raw = value("--output");
      fs.mkdirSync(raw, { recursive: true });
      fs.writeFileSync(path.join(raw, "fetch-manifest.json"), "{}\n");
      return;
    }
    if (args[0].endsWith("train-owned-model.py")) {
      const projection = value("--projection-out");
      const reportFile = value("--report-out");
      const modelFile = value("--model-out");
      fs.mkdirSync(path.dirname(projection), { recursive: true });
      fs.writeFileSync(projection, JSON.stringify({
        ...owned,
        modelVersion: invalidVersion ? "wrong-version" : owned.modelVersion,
      }));
      fs.writeFileSync(reportFile, JSON.stringify(report));
      fs.writeFileSync(modelFile, "model");
      return;
    }
    if (args[0].endsWith("predict-owned-model.py")) {
      const output = value("--output");
      fs.writeFileSync(output, JSON.stringify({
        ...owned,
        generatedAt: "2026-09-07T00:01:00Z",
        modelVersion: invalidVersion ? "wrong-version" : owned.modelVersion,
      }));
      return;
    }
    if (args[0].endsWith("verify-owned-shadow-artifacts.py")) {
      const candidate = value("--candidate");
      const reproduced = value("--reproduced-candidate");
      const receipt = value("--receipt");
      const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      fs.writeFileSync(receipt, JSON.stringify({
        schemaVersion: 1,
        artifactType: "owned-model-shadow-build-manifest",
        modelVersion: invalidVersion ? "wrong-version" : owned.modelVersion,
        runtimeStatus: "shadow",
        eligibleAsLiveProjection: false,
        files: { candidate: { sha256: hash(candidate) } },
        reproducedCandidateSha256: hash(reproduced),
      }));
    }
  };
}

test("final refresh stages and atomically installs a pinned private candidate", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-final-refresh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "data", "projection-model-policy.json", ".."), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "projection-model-policy.json"), JSON.stringify(policy));
  fs.mkdirSync(path.join(root, "snapshots"));
  const result = runFinalRefresh({
    cwd: root,
    snapshotDirectory: "snapshots",
    finalDirectory: "private/final",
    commandRunner: fixtureRunner(),
    preflightRunner: () => ({ readyToFreeze: true }),
    clock: () => new Date("2026-09-08T00:00:00Z"),
  });
  assert.equal(fs.existsSync(result.candidateFile), true);
  assert.equal(fs.existsSync(path.join(root, "private", "final", "raw", "fetch-manifest.json")), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "private", "final", "final-refresh-manifest.json")));
  assert.equal(manifest.connectedToRuntime, false);
  assert.match(manifest.files.candidate.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => runFinalRefresh({
    cwd: root, snapshotDirectory: "snapshots", finalDirectory: "private/final",
    commandRunner: fixtureRunner(), preflightRunner: () => ({ readyToFreeze: true }),
    clock: () => new Date("2026-09-08T00:00:00Z"),
  }), /Refusing to overwrite/);
});

test("failed staged verification cannot leave a fresh final candidate", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-final-refresh-fail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "projection-model-policy.json"), JSON.stringify(policy));
  fs.mkdirSync(path.join(root, "snapshots"));
  assert.throws(() => runFinalRefresh({
    cwd: root,
    snapshotDirectory: "snapshots",
    finalDirectory: "private/final",
    commandRunner: fixtureRunner({ invalidVersion: true }),
    preflightRunner: () => ({ readyToFreeze: true }),
    clock: () => new Date("2026-09-08T00:00:00Z"),
  }), /failed the shadow\/freshness boundary/);
  assert.equal(fs.existsSync(path.join(root, "private", "final")), false);
  const parent = path.join(root, "private");
  assert.deepEqual(fs.existsSync(parent) ? fs.readdirSync(parent) : [], []);
});

test("failed complete preflight cannot install a final candidate", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-final-refresh-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "projection-model-policy.json"), JSON.stringify(policy));
  fs.mkdirSync(path.join(root, "snapshots"));
  assert.throws(() => runFinalRefresh({
    cwd: root,
    snapshotDirectory: "snapshots",
    finalDirectory: "private/final",
    commandRunner: fixtureRunner(),
    preflightRunner: () => ({ readyToFreeze: false, candidateCloseness: { passed: true } }),
    clock: () => new Date("2026-09-08T00:00:00Z"),
  }), /complete freeze preflight/);
  assert.equal(fs.existsSync(path.join(root, "private", "final")), false);
});

test("preflight crossing the cutoff prevents final candidate installation", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-final-refresh-cutoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "projection-model-policy.json"), JSON.stringify(policy));
  fs.mkdirSync(path.join(root, "snapshots"));
  const times = [
    new Date("2026-09-08T23:59:57Z"),
    new Date("2026-09-08T23:59:58Z"),
    new Date("2026-09-09T00:00:01Z"),
  ];
  assert.throws(() => runFinalRefresh({
    cwd: root,
    snapshotDirectory: "snapshots",
    finalDirectory: "private/final",
    commandRunner: fixtureRunner(),
    preflightRunner: () => ({ readyToFreeze: true }),
    clock: () => times.shift(),
  }), /preflight completed after/);
  assert.equal(fs.existsSync(path.join(root, "private", "final")), false);
});
