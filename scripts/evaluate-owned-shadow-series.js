import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateOwnedShadow, PURE_MARKET_POLICY } from "./evaluate-owned-shadow.js";

const read = file => fs.readFileSync(file);
const json = file => JSON.parse(read(file));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

export function evaluateShadowSeries({ owned, market, historicalCurves, quarterbackMarket, snapshots, generatedAt = new Date().toISOString() }) {
  const groups = new Map();
  for (const file of snapshots) {
    const match = path.basename(file).match(/^(espn|sleeper|fantasypros)-2026-PPR-(.+)-ps_[^.]+\.json$/i);
    if (!match) continue;
    const source = match[1].toLowerCase() === "fantasypros" ? "fantasyPros" : match[1].toLowerCase();
    if (!groups.has(match[2])) groups.set(match[2], {});
    groups.get(match[2])[source] = file;
  }
  const evaluations = [];
  for (const [snapshotGroup, files] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (!files.espn || !files.sleeper || !files.fantasyPros) continue;
    const report = evaluateOwnedShadow({
      owned, market, historicalCurves, quarterbackMarket,
      espn: json(files.espn), sleeper: json(files.sleeper), fantasyPros: json(files.fantasyPros),
      generatedAt,
    });
    const candidate = report.lawfulMarketAdpShadow.fixedPurePositionMarketPolicy;
    evaluations.push({
      snapshotGroup,
      sourceDigests: Object.fromEntries(Object.entries(files).map(([source, file]) => [source, hash(read(file))])),
      players: candidate.players,
      worstProviderThreshold: report.providerRelativeConsensusBenchmark.worstProviderThreshold,
      candidate: {
        spearman: candidate.spearman,
        meanAbsoluteDifference: candidate.meanAbsoluteDifference,
        meanDifference: candidate.meanDifference,
        medianStandardizedDistance: candidate.medianStandardizedDistance,
        p90StandardizedDistance: candidate.p90StandardizedDistance,
      },
      clearsWorstProviderCloseness: candidate.clearsWorstProviderCloseness,
    });
  }
  return {
    schemaVersion: 1,
    artifactType: "pure-owned-market-shadow-series",
    generatedAt,
    projectionSeason: owned.projectionSeason,
    modelVersion: owned.modelVersion,
    policy: PURE_MARKET_POLICY,
    providerInputsUsedForCandidate: false,
    playerUniverseDependsOnProviderCoverage: false,
    evaluationOnly: true,
    eligibleForLivePromotion: false,
    marketCapturedAt: market.capturedAt,
    timingCaveat: "The retained FFC window ends after these provider snapshots, so repeated passes establish snapshot-revision robustness but are not prospective or chronological superiority evidence.",
    evaluations,
    completeSnapshotGroups: evaluations.length,
    allCompleteGroupsPass: evaluations.length > 0 && evaluations.every(row => row.clearsWorstProviderCloseness),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [ownedFile, snapshotDirectory, marketFile, curvesFile, quarterbackMarketFile, outputFile = "data/research/owned-model-pure-market-shadow-series.json"] = process.argv.slice(2);
  if (!ownedFile || !snapshotDirectory || !marketFile || !curvesFile) throw new Error("Usage: evaluate-owned-shadow-series.js <owned> <snapshot-dir> <market> <curves> [qb-market] [output]");
  const report = evaluateShadowSeries({
    owned: json(ownedFile), market: json(marketFile), historicalCurves: json(curvesFile),
    quarterbackMarket: quarterbackMarketFile ? json(quarterbackMarketFile) : null,
    snapshots: fs.readdirSync(snapshotDirectory).map(file => path.join(snapshotDirectory, file)),
  });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output: outputFile, groups: report.completeSnapshotGroups, allPass: report.allCompleteGroupsPass }, null, 2));
}
