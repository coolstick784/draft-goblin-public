import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertProspectiveOverlayLedger, buildPromotionRows, scoreProspectiveEvidence } from "./prospective-evidence.js";
import { evaluateOwnedPromotion } from "./promotion-gate.js";
import { hasExactOwnedOverlayClosenessLimits } from "./overlay-policy.js";

const digest = value => crypto.createHash("sha256").update(`${JSON.stringify(value)}\n`).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));

export function evaluateProspectivePromotion({ evidenceSets, prospectiveShadowSeasons, iterations = 10000 }) {
  const rows = [], evidenceDigests = [];
  let frozenDesign = null;
  for (const { ledger } of evidenceSets) {
    assertProspectiveOverlayLedger(ledger);
    const design = JSON.stringify({
      modelVersion: ledger.modelVersion,
      modelRecipeSha256: ledger.modelRecipeSha256,
      trainingProjectionSourcePolicySha256: ledger.trainingProjectionSourcePolicySha256,
      candidateMethod: ledger.candidateMethod,
      ownedForecastMethod: ledger.ownedForecastMethod,
      privateClusteringMethod: ledger.privateClusteringMethod,
      ownedWeight: ledger.ownedWeight,
      consensusWeight: ledger.consensusWeight,
      positionOwnedWeights: ledger.positionOwnedWeights,
    });
    if (frozenDesign === null) frozenDesign = design;
    else if (design !== frozenDesign) {
      throw new Error("Promotion evidence sets do not share one frozen model and overlay design.");
    }
  }
  for (const evidence of evidenceSets) {
    const { ledger, receipt, actuals } = evidence;
    const closeness = receipt?.candidateCloseness;
    if (closeness?.evaluable !== true
        || closeness?.passed !== true
        || !hasExactOwnedOverlayClosenessLimits(closeness?.limits)
        || !Array.isArray(closeness.coveredSlices)
        || closeness.coveredSlices.length !== 18
        || Object.keys(closeness.sliceRows || {}).length !== 18
        || Object.values(closeness.sliceRows || {}).some(rows => Number(rows) < 10)) {
      throw new Error("Promotion evidence lacks complete evaluable 18-slice freeze coverage.");
    }
    if (receipt?.pureOwnedEvidence?.complete !== true
        || Number(receipt?.pureOwnedEvidence?.privateRows) !== Number(receipt?.players)) {
      throw new Error("Promotion evidence lacks complete independent-owned projections.");
    }
    if (!/^[a-f0-9]{64}$/.test(String(ledger.inputDigests?.owned || ""))
        || !/^[a-f0-9]{64}$/.test(String(ledger.inputDigests?.finalRefreshManifest || ""))) {
      throw new Error("Promotion evidence is not bound to a verified final-refresh candidate.");
    }
    scoreProspectiveEvidence({ ledger, receipt, actuals });
    rows.push(...buildPromotionRows({ ledger, actuals }));
    evidenceDigests.push({
      season: ledger.projectionSeason,
      ledgerSha256: receipt.ledgerSha256,
      receiptSha256: digest(receipt),
      outcomesSha256: digest(actuals),
      ownedCandidateSha256: ledger.inputDigests.owned,
      finalRefreshManifestSha256: ledger.inputDigests.finalRefreshManifest,
      modelRecipeSha256: ledger.modelRecipeSha256,
      trainingProjectionSourcePolicySha256: ledger.trainingProjectionSourcePolicySha256,
    });
  }
  const gate = evaluateOwnedPromotion({ rows, prospectiveShadowSeasons, iterations });
  return {
    ...gate,
    artifactType: "owned-prospective-promotion-evaluation",
    modelVersion: evidenceSets[0]?.ledger?.modelVersion || null,
    modelRecipeSha256: evidenceSets[0]?.ledger?.modelRecipeSha256 || null,
    trainingProjectionSourcePolicySha256:
      evidenceSets[0]?.ledger?.trainingProjectionSourcePolicySha256 || null,
    season: Math.max(...evidenceSets.map(evidence => Number(evidence.ledger.projectionSeason))),
    sourceEvidence: evidenceDigests,
    eligibleForRuntime: false,
    promotionStatus: "unchanged-shadow",
    method: "Promotion rows are reconstructed from private salted ledgers and completed outcomes in memory; this aggregate report emits no player identities or provider rows.",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [manifestFile, outputFile = "data/research/owned-prospective-promotion-evaluation.json"] = process.argv.slice(2);
  if (!manifestFile) throw new Error("Usage: evaluate-prospective-promotion.js <private-manifest.json> [aggregate-report.json]");
  if (fs.existsSync(outputFile)) throw new Error("Refusing to overwrite an observed promotion evaluation.");
  const manifest = read(manifestFile);
  const evidenceSets = (manifest.evidence || []).map(value => ({
    ledger: read(value.ledger), receipt: read(value.receipt), actuals: read(value.actuals),
  }));
  if (!evidenceSets.length) throw new Error("Promotion manifest contains no evidence sets.");
  const report = evaluateProspectivePromotion({
    evidenceSets,
    prospectiveShadowSeasons: manifest.prospectiveShadowSeasons || [],
    iterations: Number(manifest.iterations) || 10000,
  });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ output: outputFile, eligible: report.eligible, reasons: report.reasons }, null, 2));
}
