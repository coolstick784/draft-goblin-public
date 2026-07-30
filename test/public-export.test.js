import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportPublicRepository, PUBLIC_DATA_FILES } from "../scripts/export-public-repository.js";

test("public export is an allowlisted snapshot without provider or private data", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "draft-goblin-public-export-"));
  const output = path.join(temporary, "snapshot");
  try {
    const result = exportPublicRepository(output, { sourceCommit: "test-commit" });
    assert.ok(result.files > 100);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, "PUBLIC_EXPORT.json"), "utf8")).sourceCommit, "test-commit");
    for (const file of PUBLIC_DATA_FILES) assert.ok(fs.existsSync(path.join(output, file)), file);
    for (const excluded of [
      ".git",
      ".github",
      "data/private",
      "data/historical",
      "data/snapshots",
      "data/vendor",
      "data/generated/sleeper-current-projections.json"
    ]) assert.equal(fs.existsSync(path.join(output, excluded)), false, excluded);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
