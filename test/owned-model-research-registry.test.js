import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOwnedResearchRegistry } from "../scripts/verify-owned-research-registry.js";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const registryPath = path.join(rootDir, "data/research/owned-model-research-registry.json");
const policyPath = path.join(rootDir, "data/projection-model-policy.json");
const load = file => JSON.parse(fs.readFileSync(file, "utf8"));
const inputs = () => ({ rootDir, registry: load(registryPath), policy: load(policyPath) });

test("owned research registry verifies accepted, rejected, and superseded evidence", () => {
  const result = verifyOwnedResearchRegistry(inputs());
  assert.deepEqual(result, {
    entries: 30,
    accepted: 1,
    rejected: 29,
    modelVersion: "draft-goblin-owned-2026.12",
  });
});

test("registry hashes are stable across LF and CRLF checkouts", () => {
  for (const newline of ["\n", "\r\n"]) {
    const values = inputs();
    values.readBytes = file => Buffer.from(
      fs.readFileSync(file, "utf8").replace(/\r\n|\r|\n/g, newline),
      "utf8",
    );
    assert.equal(verifyOwnedResearchRegistry(values).entries, 30);
  }
});

test("registry rejects an accepted policy absent from projection policy", () => {
  const values = inputs();
  values.policy = structuredClone(values.policy);
  values.policy.models[0].acceptedResearchPolicies = [];
  assert.throws(() => verifyOwnedResearchRegistry(values), /absent from projection-model-policy/);
});

test("registry rejects rejected evidence that claims a production change", () => {
  const values = inputs();
  const defaultRead = file => load(file);
  values.readJson = file => {
    const report = defaultRead(file);
    return file.endsWith("kicker-calibration-audit.json")
      ? { ...report, productionChanged: true }
      : report;
  };
  assert.throws(() => verifyOwnedResearchRegistry(values), /rejected evidence claims a production change/);
});

test("registry rejects hash drift and a missing adaptive-development caveat", () => {
  const drift = inputs();
  drift.registry = structuredClone(drift.registry);
  drift.registry.entries[0].reportSha256 = "0".repeat(64);
  assert.throws(() => verifyOwnedResearchRegistry(drift), /report hash drift/);

  const caveat = inputs();
  caveat.registry = structuredClone(caveat.registry);
  caveat.registry.adaptiveDevelopmentCaveat = "";
  assert.throws(() => verifyOwnedResearchRegistry(caveat), /adaptive-development caveat/);
});
