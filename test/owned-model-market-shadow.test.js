import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const artifact = JSON.parse(fs.readFileSync(new URL("../data/generated/owned-market-shadow-2026.json", import.meta.url)));

test("pure market projection artifact remains provider-free and shadow-only", () => {
  assert.equal(artifact.artifactType, "draft-goblin-owned-market-shadow-candidate");
  assert.equal(artifact.runtimeStatus, "shadow");
  assert.equal(artifact.eligibleAsLiveProjection, false);
  assert.equal(artifact.providerProjectionInputsUsed, false);
  assert.equal(artifact.playerUniverseDependsOnProviderCoverage, false);
  assert.equal(artifact.projectionVariant, "market-adjusted-shadow-v2");
  assert.deepEqual(artifact.scoringFormats, ["STD", "HALF", "PPR"]);
  assert.ok(artifact.players.length > 1000);
  assert.ok(Object.values(artifact.inputDigests).every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.ok(artifact.players.every(player => player.eligibleForRecommendation === false && [player.meanStd, player.meanHalf, player.meanPpr].every(Number.isFinite)));
  assert.doesNotMatch(JSON.stringify(artifact), /"(?:consensus|espn|sleeper|fantasyPros)"/i);
});

test("Fantasy Football Calculator market use is explicitly licensed in source policy", () => {
  const policy = JSON.parse(fs.readFileSync(new URL("../data/source-policy.json", import.meta.url)));
  const source = policy.sources.find(row => row.id === "fantasy-football-calculator-adp");
  assert.equal(source.status, "allowed-with-attribution");
  assert.match(source.license, /free for personal and commercial use/i);
});
