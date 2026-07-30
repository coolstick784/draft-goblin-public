import test from "node:test";
import assert from "node:assert/strict";
import { simulateHistoricalModels } from "../scripts/simulate-historical-models.js";

const record = (season, championSlot) => ({ season, teams: 2, rounds: 8, scoringType: "ppr", championSlot, settings: {}, picks: Array.from({ length: 16 }, (_, i) => ({ pickNo: i + 1, slot: i % 4 < 2 ? 1 : 2, position: ["RB", "WR", "QB", "TE"][i % 4] })) });
test("historical simulation keeps its model search before the untouched holdout", () => {
  const output = simulateHistoricalModels({ records: [...Array.from({ length: 3 }, () => record(2023, 1)), ...Array.from({ length: 3 }, () => record(2024, 2)), ...Array.from({ length: 3 }, () => record(2025, 1))] });
  assert.equal(output.records.test2025, 3);
  assert.equal(output.families.length, 6);
  assert.match(output.method, /2023.*2024.*2025/);
  assert.ok(output.selected.holdout.drafts === 3);
});
