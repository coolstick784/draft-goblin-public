import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assessOwnedCandidateFreshness } from "./freeze-latest.js";
import {
  hasExactOwnedOverlayClosenessLimits,
  hasExactOwnedOverlayWeights,
  MINIMUM_FROZEN_ROWS_PER_SLICE,
  OWNED_OVERLAY_FORMATS,
  OWNED_OVERLAY_METHOD,
} from "./overlay-policy.js";
import { preflightLatest } from "./preflight-latest.js";

export const FINAL_MODEL_VERSION = "draft-goblin-owned-2026.12";
export const FINAL_POLICY_FILE = "data/projection-model-policy.json";
export const FINAL_INSTALL_DIRECTORY = "data/private/owned-model/final-refresh-2026";
export const FINAL_PROJECTION_BASENAME = "owned-projections-2026.json";
export const FINAL_REPORT_BASENAME = "owned-model-walk-forward.json";
export const FINAL_REPRODUCED_BASENAME = "reproduced-owned-projections-2026.json";
export const FINAL_VERIFIER_RECEIPT_BASENAME = "shadow-build-manifest.json";
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const inferencePayload = value => {
  const normalized = structuredClone(value);
  delete normalized.generatedAt;
  return normalized;
};

export function verifyFinalRefresh({ owned, reproduced, report, policy, cutoffAt }) {
  const reasons = [];
  if (owned?.modelVersion !== FINAL_MODEL_VERSION) reasons.push("Owned candidate model version is not the pinned final shadow version.");
  if (Number(owned?.projectionSeason) !== 2026) reasons.push("Owned candidate projection season is not 2026.");
  if (owned?.runtimeStatus !== "shadow" || owned?.eligibleAsLiveProjection !== false) reasons.push("Owned candidate is not shadow-only.");
  if (report?.modelVersion !== FINAL_MODEL_VERSION) reasons.push("Walk-forward report model version does not match the final candidate.");
  if (report?.eligibility?.eligibleForLivePromotion !== false) reasons.push("Walk-forward report does not retain the non-promoted boundary.");
  const savedModelReproductionPassed = Boolean(reproduced)
    && JSON.stringify(inferencePayload(reproduced)) === JSON.stringify(inferencePayload(owned));
  if (!savedModelReproductionPassed) reasons.push("Saved-model inference did not exactly reproduce the final candidate.");
  const policyRecord = policy?.models?.find(model => model.id === FINAL_MODEL_VERSION);
  if (!policyRecord) reasons.push("Pinned candidate is absent from projection-model policy.");
  else {
    if (policyRecord.status !== "shadow" || policyRecord.eligibleForRuntime !== false) reasons.push("Projection-model policy does not keep the candidate shadow-only.");
    const overlay = policyRecord.prospectiveOverlay;
    if (overlay?.candidateMethod !== OWNED_OVERLAY_METHOD
        || JSON.stringify(overlay?.scoringFormats) !== JSON.stringify(OWNED_OVERLAY_FORMATS)
        || !hasExactOwnedOverlayWeights(overlay?.positionOwnedWeights)
        || !hasExactOwnedOverlayClosenessLimits(overlay?.closenessLimits)
        || Number(overlay?.minimumRowsPerFormatPositionSlice) !== MINIMUM_FROZEN_ROWS_PER_SLICE
        || overlay?.immutableAfterCutoff !== true
        || policyRecord.promotionCandidateKind !== "pure-independent-owned"
        || Number(policyRecord.promotionGateVersion) !== 2
        || policyRecord.requireIndependentOwnedSuperiority !== true) {
      reasons.push("Projection-model policy does not match the preregistered position-aware overlay.");
    }
  }
  const ownedCandidateFreshness = assessOwnedCandidateFreshness(owned, cutoffAt);
  if (!ownedCandidateFreshness.passed) reasons.push("Refreshed owned candidate is not within 72 hours of the final cutoff.");
  const diagnosticPlayers = Array.isArray(owned?.players) ? owned.players : [];
  const diagnosticComplete = diagnosticPlayers.filter(player =>
    ["baseMeanStd", "baseMeanHalf", "baseMeanPpr"].every(key =>
      Number.isFinite(Number(player?.[key])) && Number(player[key]) >= 0
    )
  ).length;
  const diagnosticChanged = diagnosticPlayers.filter(player =>
    Number(player?.baseMeanStd) !== Number(player?.meanStd)
    || Number(player?.baseMeanPpr) !== Number(player?.meanPpr)
  );
  if (!diagnosticPlayers.length || diagnosticComplete !== diagnosticPlayers.length) reasons.push("Owned candidate does not contain complete no-specialist base diagnostics.");
  if (!diagnosticChanged.length || diagnosticChanged.some(player => player?.position !== "WR")) reasons.push("Owned candidate has an invalid WR-specialist/base diagnostic boundary.");
  return {
    verified: reasons.length === 0,
    modelVersion: owned?.modelVersion || null,
    runtimeStatus: owned?.runtimeStatus || null,
    eligibleAsLiveProjection: owned?.eligibleAsLiveProjection,
    policyStatus: policyRecord?.status || null,
    policyEligibleForRuntime: policyRecord?.eligibleForRuntime,
    prospectiveOverlayVerified: Boolean(policyRecord
      && policyRecord.prospectiveOverlay?.candidateMethod === OWNED_OVERLAY_METHOD
      && JSON.stringify(policyRecord.prospectiveOverlay?.scoringFormats) === JSON.stringify(OWNED_OVERLAY_FORMATS)
      && hasExactOwnedOverlayWeights(policyRecord.prospectiveOverlay?.positionOwnedWeights)
      && hasExactOwnedOverlayClosenessLimits(policyRecord.prospectiveOverlay?.closenessLimits)
      && Number(policyRecord.prospectiveOverlay?.minimumRowsPerFormatPositionSlice) === MINIMUM_FROZEN_ROWS_PER_SLICE
      && policyRecord.prospectiveOverlay?.immutableAfterCutoff === true
      && policyRecord.promotionCandidateKind === "pure-independent-owned"
      && Number(policyRecord.promotionGateVersion) === 2
      && policyRecord.requireIndependentOwnedSuperiority === true),
    savedModelReproductionPassed,
    ownedCandidateFreshness,
    diagnosticBaseCoverage: {
      players: diagnosticPlayers.length,
      complete: diagnosticComplete,
      changed: diagnosticChanged.length,
      passed: diagnosticPlayers.length > 0
        && diagnosticComplete === diagnosticPlayers.length
        && diagnosticChanged.length > 0
        && diagnosticChanged.every(player => player?.position === "WR"),
    },
    reasons,
  };
}

function runPython(python, args, cwd) {
  const result = spawnSync(python, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${python} ${args.join(" ")} failed with exit code ${result.status}.`);
}

function snapshotEntries(snapshotDirectory) {
  return fs.readdirSync(snapshotDirectory).filter(file => file.endsWith(".json")).flatMap(file => {
    try {
      const bytes = fs.readFileSync(path.join(snapshotDirectory, file));
      return [{ file, value: JSON.parse(bytes), sha256: sha256(bytes) }];
    } catch {
      return [];
    }
  });
}

export function finalRefreshCommands({
  python = process.env.OWNED_MODEL_PYTHON || process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
  stageDirectory = ".final-refresh-staging",
} = {}) {
  const raw = path.join(stageDirectory, "raw");
  return {
    python,
    fetch: [
      "scripts/fetch-owned-model-data.py", "--end-season", "2025",
      "--depth-end-season", "2026", "--output", raw,
    ],
    train: [
      "scripts/train-owned-model.py", "--season", "2026",
      "--data-dir", raw,
      "--players", path.join(raw, "players.csv"),
      "--draft-picks", path.join(raw, "draft_picks.csv"),
      "--model-out", path.join(stageDirectory, "model.joblib"),
      "--projection-out", path.join(stageDirectory, FINAL_PROJECTION_BASENAME),
      "--report-out", path.join(stageDirectory, FINAL_REPORT_BASENAME),
    ],
    predict: [
      "scripts/predict-owned-model.py", "--season", "2026",
      "--data-dir", raw,
      "--players", path.join(raw, "players.csv"),
      "--draft-picks", path.join(raw, "draft_picks.csv"),
      "--model", path.join(stageDirectory, "model.joblib"),
      "--output", path.join(stageDirectory, FINAL_REPRODUCED_BASENAME),
    ],
    verify: [
      "scripts/verify-owned-shadow-artifacts.py", "--season", "2026",
      "--candidate", path.join(stageDirectory, FINAL_PROJECTION_BASENAME),
      "--report", path.join(stageDirectory, FINAL_REPORT_BASENAME),
      "--policy", FINAL_POLICY_FILE,
      "--model", path.join(stageDirectory, "model.joblib"),
      "--fetch-manifest", path.join(raw, "fetch-manifest.json"),
      "--data-dir", raw,
      "--catalog", "data/generated/sleeper-current-catalog.json",
      "--reproduced-candidate", path.join(stageDirectory, FINAL_REPRODUCED_BASENAME),
      "--receipt", path.join(stageDirectory, FINAL_VERIFIER_RECEIPT_BASENAME),
    ],
  };
}

export function runFinalRefresh({
  snapshotDirectory = "data/snapshots",
  cutoffAt = "2026-09-09T00:00:00Z",
  finalDirectory = FINAL_INSTALL_DIRECTORY,
  cwd = process.cwd(),
  commandRunner = runPython,
  preflightRunner = preflightLatest,
  clock = () => new Date(),
} = {}) {
  const cutoff = Date.parse(cutoffAt), started = clock().getTime();
  if (!Number.isFinite(cutoff) || started > cutoff) throw new Error("Refusing final owned refresh after the prospective cutoff.");
  const installedDirectory = path.resolve(cwd, finalDirectory);
  if (fs.existsSync(installedDirectory)) throw new Error("Refusing to overwrite the pinned final owned refresh.");
  const parent = path.dirname(installedDirectory);
  const stageDirectory = path.join(parent, `.${path.basename(installedDirectory)}.staging-${crypto.randomUUID()}`);
  fs.mkdirSync(parent, { recursive: true });
  const commands = finalRefreshCommands({ stageDirectory });
  const policyFile = path.resolve(cwd, FINAL_POLICY_FILE);
  try {
    commandRunner(commands.python, commands.fetch, cwd);
    commandRunner(commands.python, commands.train, cwd);
    commandRunner(commands.python, commands.predict, cwd);
    commandRunner(commands.python, commands.verify, cwd);
    if (clock().getTime() > cutoff) throw new Error("Final owned refresh completed after the prospective cutoff.");
    const ownedFile = path.join(stageDirectory, FINAL_PROJECTION_BASENAME);
    const reportFile = path.join(stageDirectory, FINAL_REPORT_BASENAME);
    const reproducedFile = path.join(stageDirectory, FINAL_REPRODUCED_BASENAME);
    const verifierReceiptFile = path.join(stageDirectory, FINAL_VERIFIER_RECEIPT_BASENAME);
    const modelFile = path.join(stageDirectory, "model.joblib");
    const fetchManifestFile = path.join(stageDirectory, "raw", "fetch-manifest.json");
    const ownedBytes = fs.readFileSync(ownedFile);
    const reportBytes = fs.readFileSync(reportFile);
    const reproducedBytes = fs.readFileSync(reproducedFile);
    const verifierReceiptBytes = fs.readFileSync(verifierReceiptFile);
    const modelBytes = fs.readFileSync(modelFile);
    const fetchManifestBytes = fs.readFileSync(fetchManifestFile);
    const policyBytes = fs.readFileSync(policyFile);
    const owned = JSON.parse(ownedBytes);
    const report = JSON.parse(reportBytes);
    const reproduced = JSON.parse(reproducedBytes);
    const verifierReceipt = JSON.parse(verifierReceiptBytes);
    const policy = JSON.parse(policyBytes);
    const verification = verifyFinalRefresh({ owned, reproduced, report, policy, cutoffAt });
    if (verifierReceipt?.artifactType !== "owned-model-shadow-build-manifest"
        || verifierReceipt?.modelVersion !== FINAL_MODEL_VERSION
        || verifierReceipt?.runtimeStatus !== "shadow"
        || verifierReceipt?.eligibleAsLiveProjection !== false
        || verifierReceipt?.files?.candidate?.sha256 !== sha256(ownedBytes)
        || verifierReceipt?.reproducedCandidateSha256 !== sha256(reproducedBytes)) {
      verification.reasons.push("Python artifact-verifier receipt does not bind the staged final artifacts.");
      verification.verified = false;
    }
    if (!verification.verified) throw new Error(`Final owned refresh failed the shadow/freshness boundary: ${JSON.stringify(verification)}`);
    const preflight = preflightRunner({
      owned,
      ownedBytes,
      entries: snapshotEntries(path.resolve(cwd, snapshotDirectory)),
      cutoffAt,
    });
    if (preflight?.readyToFreeze !== true) {
      throw new Error(`Final owned refresh failed the complete freeze preflight: ${JSON.stringify(preflight)}`);
    }
    const installedAt = clock();
    if (installedAt.getTime() > cutoff) throw new Error("Final owned refresh preflight completed after the prospective cutoff.");
    const installManifest = {
      schemaVersion: 1,
      artifactType: "owned-final-refresh-private-manifest",
      immutable: true,
      evaluationOnly: true,
      connectedToRuntime: false,
      cutoffAt,
      installedAt: installedAt.toISOString(),
      modelVersion: owned.modelVersion,
      generatedAt: owned.generatedAt,
      files: {
        candidate: { file: FINAL_PROJECTION_BASENAME, bytes: ownedBytes.length, sha256: sha256(ownedBytes) },
        report: { file: FINAL_REPORT_BASENAME, bytes: reportBytes.length, sha256: sha256(reportBytes) },
        model: { file: "model.joblib", bytes: modelBytes.length, sha256: sha256(modelBytes) },
        reproducedCandidate: { file: FINAL_REPRODUCED_BASENAME, bytes: reproducedBytes.length, sha256: sha256(reproducedBytes) },
        verifierReceipt: { file: FINAL_VERIFIER_RECEIPT_BASENAME, bytes: verifierReceiptBytes.length, sha256: sha256(verifierReceiptBytes) },
        fetchManifest: { file: "raw/fetch-manifest.json", bytes: fetchManifestBytes.length, sha256: sha256(fetchManifestBytes) },
        policyAtVerification: { file: FINAL_POLICY_FILE, bytes: policyBytes.length, sha256: sha256(policyBytes) },
      },
      verification,
      preflightReadyToFreeze: preflight.readyToFreeze,
    };
    fs.writeFileSync(path.join(stageDirectory, "final-refresh-manifest.json"), `${JSON.stringify(installManifest, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(stageDirectory, installedDirectory);
    return {
      schemaVersion: 1,
      artifactType: "owned-final-refresh-verification",
      evaluationOnly: true,
      writesFrozenEvidence: false,
      installedDirectory,
      candidateFile: path.join(installedDirectory, FINAL_PROJECTION_BASENAME),
      verification,
      preflight,
    };
  } catch (error) {
    if (fs.existsSync(stageDirectory)) fs.rmSync(stageDirectory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [snapshotDirectory = "data/snapshots", cutoffAt = "2026-09-09T00:00:00Z"] = process.argv.slice(2);
  console.log(JSON.stringify(runFinalRefresh({ snapshotDirectory, cutoffAt }), null, 2));
}
