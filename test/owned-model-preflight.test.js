import test from "node:test";
import assert from "node:assert/strict";
import { preflightLatest } from "../scripts/owned-model/preflight-latest.js";

const modelProvenance = {
  modelRecipeSha256: "f".repeat(64),
  trainingProjectionSourcePolicy: {
    projectionFeatureSources: ["nflverse"],
    identityOnlySources: ["sleeper-player-catalog"],
    prohibitedProjectionFeatureSources: ["espn", "sleeper-projections", "fantasypros"],
  },
  trainingProjectionSourcePolicySha256: "8ef96ed7c7fdc852a2b28b0bad260fd2d1285b14c27b9663f9b78d65df95c3d2",
};

test("freeze preflight is read-only and reports complete closeness diagnostics", () => {
  const positions = ["QB", "RB", "WR", "TE", "K", "DST"];
  const players = Array.from({ length: 120 }, (_, index) => {
    const position = positions[index % positions.length], standard = 220 - index;
    return {
      id: `p${index}`, name: `Player ${index}`, position, team: `T${index % 32}`,
      meanStd: standard + (index % 3 - 1) * 2,
      meanHalf: standard + 5 + (index % 3 - 1) * 2,
      meanPpr: standard + 10 + (index % 3 - 1) * 2,
      baseMeanStd: standard,
      baseMeanHalf: standard + 5,
      baseMeanPpr: standard + 10,
    };
  });
  const owned = {
    ...modelProvenance,
    modelVersion: "owned-test", projectionSeason: 2026,
    generatedAt: "2026-09-07T00:00:00Z", runtimeStatus: "shadow",
    eligibleAsLiveProjection: false, players,
  };
  const entries = [];
  for (const source of ["espn", "sleeper", "fantasyPros"]) for (const scoring of ["STD", "PPR"]) {
    entries.push({
      file: `${source}-${scoring}.json`, sha256: `${source}-${scoring}`,
      value: {
        source, platform: source, season: 2026, scoring,
        capturedAt: "2026-09-07T00:00:00Z",
        players: players.map((player, index) => ({
          id: player.id, name: player.name, position: player.position, team: player.team,
          points: 220 - index + (scoring === "PPR" ? 10 : 0), projectionSeason: 2026,
        })),
      },
    });
  }
  const result = preflightLatest({
    owned, ownedBytes: Buffer.from(JSON.stringify(owned)), entries,
    cutoffAt: "2026-09-09T00:00:00Z", frozenAt: "2026-09-07T01:00:00Z",
  });
  assert.equal(result.writesFrozenEvidence, false);
  assert.equal(result.candidateCloseness.passed, true);
  assert.equal(result.candidateCloseness.coveredSlices.length, 18);
  assert.equal(result.ownedForecastMethod, "pure-independent-owned");
  assert.equal(result.privateClusteringMethod, "stable-private-player-v1");
  assert.equal(result.pureOwnedEvidence.complete, true);
  assert.equal(result.pureOwnedEvidence.privateRows, 360);
  assert.equal(result.rows, 360);
  assert.equal(result.diagnosticVariants.noWrRookieSpecialistBase.rows, 60);
  assert.equal(result.ownedCandidateFreshness.passed, true);
  assert.equal(result.readyToFreeze, true);

  const withoutDst = entries.map(entry => ({
    ...entry,
    value: {
      ...entry.value,
      players: entry.value.players.filter(player => player.position !== "DST"),
    },
  }));
  assert.throws(() => preflightLatest({
    owned, ownedBytes: Buffer.from(JSON.stringify(owned)), entries: withoutDst,
    cutoffAt: "2026-09-09T00:00:00Z", frozenAt: "2026-09-07T01:00:00Z",
  }), /lacks enough joined format\/position coverage/);
});

test("freeze preflight fails readiness for a stale owned candidate", () => {
  const positions = ["QB", "RB", "WR", "TE", "K", "DST"];
  const players = Array.from({ length: 120 }, (_, index) => ({
    id: `p${index}`, name: `Player ${index}`, position: positions[index % positions.length],
    team: `T${index % 32}`, meanStd: 200 - index, meanHalf: 205 - index, meanPpr: 210 - index,
  }));
  const owned = {
    ...modelProvenance,
    modelVersion: "owned-test", projectionSeason: 2026,
    generatedAt: "2026-09-01T00:00:00Z", runtimeStatus: "shadow",
    eligibleAsLiveProjection: false, players,
  };
  const entries = [];
  for (const source of ["espn", "sleeper", "fantasyPros"]) for (const scoring of ["STD", "PPR"]) {
    entries.push({
      file: `${source}-${scoring}.json`, sha256: `${source}-${scoring}`,
      value: {
        source, platform: source, season: 2026, scoring,
        capturedAt: "2026-09-07T00:00:00Z",
        players: players.map((player, index) => ({
          id: player.id, name: player.name, position: player.position, team: player.team,
          points: 200 - index + (scoring === "PPR" ? 10 : 0), projectionSeason: 2026,
        })),
      },
    });
  }
  const result = preflightLatest({
    owned, ownedBytes: Buffer.from(JSON.stringify(owned)), entries,
    cutoffAt: "2026-09-09T00:00:00Z", frozenAt: "2026-09-07T01:00:00Z",
  });
  assert.equal(result.ownedCandidateFreshness.passed, false);
  assert.equal(result.readyToFreeze, false);
});
