import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessOwnedCandidateFreshness, assessSnapshotFreshness, selectLatestSnapshots } from "./freeze-latest.js";
import { captureProspectiveEvidence } from "./prospective-evidence.js";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

export function preflightLatest({ owned, ownedBytes, entries, cutoffAt, frozenAt = new Date().toISOString() }) {
  const selected = selectLatestSnapshots({ entries, season: owned.projectionSeason, cutoffAt, owned });
  const snapshotFreshness = assessSnapshotFreshness(selected.selectedInputs, cutoffAt);
  const ownedCandidateFreshness = assessOwnedCandidateFreshness(owned, cutoffAt);
  const { receipt } = captureProspectiveEvidence({
    owned, snapshotsByFormat: selected.snapshotsByFormat, cutoffAt, frozenAt,
    inputDigests: { owned: sha256(ownedBytes), ...selected.inputDigests },
    requireClosenessGate: true,
    requireFreshOwnedCandidate: false,
  });
  return {
    schemaVersion: 1, artifactType: "owned-prospective-freeze-preflight",
    evaluationOnly: true, writesFrozenEvidence: false, projectionSeason: receipt.projectionSeason,
    modelVersion: receipt.modelVersion, cutoffAt: receipt.cutoffAt,
    candidateMethod: receipt.candidateMethod, ownedWeight: receipt.ownedWeight,
    consensusWeight: receipt.consensusWeight, positionOwnedWeights: receipt.positionOwnedWeights,
    ownedForecastMethod: receipt.ownedForecastMethod,
    privateClusteringMethod: receipt.privateClusteringMethod,
    pureOwnedEvidence: receipt.pureOwnedEvidence,
    formats: receipt.formats,
    rows: receipt.players, byPosition: receipt.byPosition,
    sourceAvailability: receipt.sourceAvailability,
    sourceEvidenceCoverage: receipt.sourceEvidenceCoverage,
    diagnosticVariants: receipt.diagnosticVariants,
    candidateCloseness: receipt.candidateCloseness, snapshotFreshness,
    ownedCandidateFreshness,
    readyToFreeze: receipt.candidateCloseness.evaluable
      && receipt.candidateCloseness.coveredSlices.length === 18
      && snapshotFreshness.passed
      && ownedCandidateFreshness.passed,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [ownedFile, snapshotDirectory, cutoffAt] = process.argv.slice(2);
  if (!ownedFile || !snapshotDirectory || !cutoffAt) throw new Error("Usage: preflight-latest.js <owned.json> <snapshot-directory> <cutoff-ISO-8601>");
  const ownedBytes = fs.readFileSync(ownedFile), owned = JSON.parse(ownedBytes);
  const entries = fs.readdirSync(snapshotDirectory).filter(file => file.endsWith(".json")).flatMap(file => {
    try {
      const bytes = fs.readFileSync(path.join(snapshotDirectory, file));
      return [{ file, value: JSON.parse(bytes), sha256: sha256(bytes) }];
    } catch {
      return [];
    }
  });
  console.log(JSON.stringify(preflightLatest({ owned, ownedBytes, entries, cutoffAt }), null, 2));
}
