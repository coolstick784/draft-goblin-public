import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPureMarketCandidate, ownedMarketIdentity, PURE_MARKET_POLICY } from "./evaluate-owned-shadow.js";

const read = file => fs.readFileSync(file);
const parse = file => JSON.parse(read(file));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

export function buildOwnedMarketShadow({ owned, market, historicalCurves, inputDigests = {}, generatedAt = new Date().toISOString() }) {
  const candidate = buildPureMarketCandidate(owned.players, market, historicalCurves);
  const adjustedFormats = player => {
    const basePpr = Number(player.meanPpr);
    const meanPpr = Number((candidate.get(ownedMarketIdentity(player.name, player.position, player.team)) ?? Number(player.activeRoleMeanPpr || basePpr)).toFixed(2));
    const preserveScoringDelta = key => {
      const base = Number(player[key]);
      return Number.isFinite(base) ? Number(Math.max(.01, meanPpr - (basePpr - base)).toFixed(2)) : null;
    };
    return { meanStd: preserveScoringDelta("meanStd"), meanHalf: preserveScoringDelta("meanHalf"), meanPpr };
  };
  return {
    schemaVersion: 1,
    artifactType: "draft-goblin-owned-market-shadow-candidate",
    projectionSeason: owned.projectionSeason,
    sourceModelVersion: owned.modelVersion,
    modelVersion: `${owned.modelVersion}-pure-market-shadow-v2`,
    generatedAt,
    runtimeStatus: "shadow",
    eligibleAsLiveProjection: false,
    projectionVariant: "market-adjusted-shadow-v2",
    scoringFormats: ["STD", "HALF", "PPR"],
    scoringDerivation: "The PPR market-adjusted shadow preserves its evaluated value. HALF and STD preserve each owned player's base scoring-format delta from PPR so every simulation format uses the same market adjustment.",
    policy: PURE_MARKET_POLICY,
    providerProjectionInputsUsed: false,
    playerUniverseDependsOnProviderCoverage: false,
    inputDigests,
    attribution: [
      "Historical statistics, depth charts, and realized rank curves: nflverse, CC-BY-4.0",
      "Current market ordering: Fantasy Football Calculator ADP API; attribution requested",
    ],
    players: (owned.players || []).filter(player => Number(player.meanPpr) > 0).map(player => {
      const formats = adjustedFormats(player);
      return {
        id: player.id,
        name: player.name,
        position: player.position,
        team: player.team,
        ...formats,
        baseOwnedMeanStd: Number(player.meanStd),
        baseOwnedMeanHalf: Number(player.meanHalf),
        baseOwnedMeanPpr: Number(player.meanPpr),
        ...(Number.isFinite(Number(player.expectedGames)) ? { expectedGames: Number(player.expectedGames) } : {}),
        ...(Number.isFinite(Number(player.activeRoleGames)) ? { activeRoleGames: Number(player.activeRoleGames) } : {}),
        source: `${owned.modelVersion}-pure-market-shadow-v2`,
        eligibleForRecommendation: false,
      };
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [ownedFile, marketFile, curvesFile, outputFile = "data/generated/owned-market-shadow-2026.json"] = process.argv.slice(2);
  if (!ownedFile || !marketFile || !curvesFile) throw new Error("Usage: build-owned-market-shadow.js <owned> <market> <curves> [output]");
  const inputs = { owned: read(ownedFile), market: read(marketFile), historicalCurves: read(curvesFile) };
  const artifact = buildOwnedMarketShadow({
    owned: JSON.parse(inputs.owned), market: JSON.parse(inputs.market), historicalCurves: JSON.parse(inputs.historicalCurves),
    inputDigests: Object.fromEntries(Object.entries(inputs).map(([key, bytes]) => [key, digest(bytes)])),
  });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(artifact) + "\n");
  console.log(JSON.stringify({ output: outputFile, players: artifact.players.length, eligibleAsLiveProjection: artifact.eligibleAsLiveProjection }, null, 2));
}
