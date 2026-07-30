import test from "node:test";
import assert from "node:assert/strict";
import { simulatedPlayerSeasonTotal } from "../core/simulate.js";
import { QUANTILE_V1_PROBABILITIES } from "../shared/player-distribution.js";

const envelope = values => ({
  schemaVersion: "quantile-v1",
  unit: "season-fantasy-points",
  conditionedOn: "active-role",
  season: 2026,
  scoringFormat: "ppr",
  mean: 200,
  quantiles: QUANTILE_V1_PROBABILITIES.map((p, index) => ({ p, value: values[index] })),
  provenance: {
    modelId: "test",
    modelVersion: "test-v1",
    generatedAt: "2026-07-14T00:00:00.000Z",
    forecastAsOf: "2026-07-13T23:59:00.000Z",
    trainedThrough: "2025-12-31T00:00:00.000Z",
    calibrationId: "test-calibration",
    sourceSnapshotIds: ["test:snapshot"],
    estimationLevel: "position",
    fallbackReason: "test fixture"
  }
});

test("calibrated quantiles replace both legacy range and RMSE shocks", () => {
  const values=[100,120,135,155,170,185,195,205,220,240,265,285,320];
  const player={id:"wr",position:"WR",mean:200,floor:0,ceiling:1000,distribution:envelope(values)};
  const a=simulatedPlayerSeasonTotal(player,0,1000);
  const b=simulatedPlayerSeasonTotal({...player,floor:190,ceiling:210},0,-1000);
  assert.ok(Math.abs(a-b)<1e-9);
  assert.ok(a>190&&a<210);
});

test("quantile sampling preserves calibrated asymmetric tails", () => {
  const player={id:"rb",position:"RB",mean:200,floor:150,ceiling:250,distribution:envelope([80,110,130,150,170,185,195,205,220,245,285,325,390])};
  const low=simulatedPlayerSeasonTotal(player,-1.6448536269,0);
  const middle=simulatedPlayerSeasonTotal(player,0,0);
  const high=simulatedPlayerSeasonTotal(player,1.6448536269,0);
  assert.ok(high-middle>middle-low);
});

test("players without a valid distribution retain the legacy fallback", () => {
  const player={id:"qb",position:"QB",mean:300,floor:250,ceiling:360};
  assert.notEqual(simulatedPlayerSeasonTotal(player,0,1),simulatedPlayerSeasonTotal(player,0,-1));
});

test("an empirical range does not add the same historical projection error twice",()=>{
  const player={id:"qb-empirical",position:"QB",mean:370,floor:318.21,ceiling:422.94,performanceRangeIncludesHistoricalError:true};
  assert.equal(simulatedPlayerSeasonTotal(player,0,1),simulatedPlayerSeasonTotal(player,0,-1));
});

test("direct simulation rejects distributions from a different season or scoring format",()=>{
  const values=[100,120,135,155,170,185,195,205,220,240,265,285,320],distribution=envelope(values),base={id:"wr-context",position:"WR",mean:200,floor:160,ceiling:250,distribution};
  const matching={...base,projectionSeason:2026,projectionScoring:"PPR"};
  assert.equal(simulatedPlayerSeasonTotal(matching,0,1000),simulatedPlayerSeasonTotal(matching,0,-1000));
  for(const player of [{...base,projectionSeason:2025,projectionScoring:"PPR"},{...base,projectionSeason:2026,projectionScoring:"standard"}])assert.notEqual(simulatedPlayerSeasonTotal(player,0,1),simulatedPlayerSeasonTotal(player,0,-1));
});
