import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(new URL("../.github/workflows/capture-model-signals.yml", import.meta.url), "utf8");

test("prospective signal capture is scheduled, private, and immutable", () => {
  assert.match(workflow, /cron: "47 10 \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /node scripts\/verify-model-signal-policy\.js/);
  assert.match(workflow, /test_capture_prospective_model_signals\.py/);
  assert.match(workflow, /capture-prospective-model-signals\.py/);
  assert.match(workflow, /tar -czf "dist\/model-evidence\/model-evidence-/);
  assert.match(workflow, /gh release upload "\$TAG"/);
  assert.doesNotMatch(workflow, /draft-goblin-projections|pages: write|api\.sleeper\.com\/projections|fantasypros/i);
});

test("prospective evidence cannot affect the extension or public feed workflow", () => {
  const publisher = fs.readFileSync(new URL("../.github/workflows/publish-projections.yml", import.meta.url), "utf8");
  const manifest = fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8");
  assert.doesNotMatch(publisher, /prospective-model-signals|model-evidence/);
  assert.doesNotMatch(manifest, /prospective-model-signals|model-evidence/);
});
