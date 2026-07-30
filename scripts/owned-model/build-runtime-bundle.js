import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOwnedPromotion } from "./promotion-gate.js";

export function buildAuthorizedOwnedRuntimeBundle({
  candidateBytes,
  evidenceBytes,
  policy,
  generatedAt = new Date().toISOString(),
}) {
  const candidate = JSON.parse(candidateBytes);
  if (candidate?.artifactType !== "draft-goblin-owned-candidate"
      || !candidate?.modelVersion
      || !Number.isInteger(Number(candidate?.projectionSeason))
      || !Array.isArray(candidate?.players)
      || !candidate.players.length) {
    throw new Error("Owned runtime candidate is malformed.");
  }
  const authorization = verifyOwnedPromotion({
    candidateBytes,
    evidenceBytes,
    modelId: candidate.modelVersion,
    season: candidate.projectionSeason,
    policy,
  });
  if (!authorization.authorized) {
    throw new Error(`Owned runtime authorization failed: ${authorization.reasons.join(" ")}`);
  }
  const players = candidate.players.map(player => {
    if (!player?.id || !["QB", "RB", "WR", "TE", "K", "DST"].includes(player.position)
        || ![player.meanStd, player.meanHalf, player.meanPpr].every(value =>
          Number.isFinite(Number(value)) && Number(value) >= 0
        )) {
      throw new Error("Owned runtime candidate contains an invalid player projection.");
    }
    return {
      id: String(player.id),
      name: player.name,
      team: player.team,
      position: player.position,
      points: {
        STD: Number(player.meanStd),
        HALF: Number(player.meanHalf),
        PPR: Number(player.meanPpr),
      },
    };
  });
  return {
    schemaVersion: 1,
    artifactType: "owned-runtime-projection-bundle",
    generatedAt,
    projectionSeason: Number(candidate.projectionSeason),
    modelVersion: candidate.modelVersion,
    projectionKind: "pure-independent-owned",
    authorization: {
      candidateSha256: authorization.candidateSha256,
      evidenceSha256: authorization.evidenceSha256,
      explicitlyReviewed: true,
    },
    players,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [candidateFile, evidenceFile, policyFile, outputFile] = process.argv.slice(2);
  if (!candidateFile || !evidenceFile || !policyFile || !outputFile) {
    throw new Error("Usage: build-runtime-bundle.js <candidate.json> <promotion-evidence.json> <policy.json> <output.json>");
  }
  if (fs.existsSync(outputFile)) throw new Error("Refusing to overwrite an owned runtime projection bundle.");
  const candidateBytes = fs.readFileSync(candidateFile);
  const evidenceBytes = fs.readFileSync(evidenceFile);
  const policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  const bundle = buildAuthorizedOwnedRuntimeBundle({ candidateBytes, evidenceBytes, policy });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({
    output: outputFile,
    modelVersion: bundle.modelVersion,
    season: bundle.projectionSeason,
    players: bundle.players.length,
  }, null, 2));
}
