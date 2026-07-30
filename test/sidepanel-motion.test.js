import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("side panel loading state avoids full-surface compositing flicker", () => {
  const css = fs.readFileSync(new URL("../extension/sidepanel.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /animation\s*:/);
  assert.doesNotMatch(css, /@keyframes/);
  assert.doesNotMatch(css, /backdrop-filter/);
});
