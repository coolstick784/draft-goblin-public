import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyModelSignalPolicy } from "../scripts/verify-model-signal-policy.js";
import { DEFAULT_PROJECTION_DRIVER, PROJECTION_DRIVER_METHOD, PROJECTION_DRIVERS } from "../extension/site-projection-blend.js";

const policy = JSON.parse(fs.readFileSync(new URL("../data/model-signal-policy.json", import.meta.url), "utf8"));
const sourcePolicy = JSON.parse(fs.readFileSync(new URL("../data/source-policy.json", import.meta.url), "utf8"));

test("model signal policy is internally valid and pins Draft Goblin as the default driver", () => {
  const result = verifyModelSignalPolicy(policy, sourcePolicy);
  assert.equal(result.valid, true);
  assert.equal(policy.runtimeProjection.method, PROJECTION_DRIVER_METHOD);
  assert.equal(policy.runtimeProjection.defaultDriver, DEFAULT_PROJECTION_DRIVER);
  assert.deepEqual(policy.runtimeProjection.allowedDrivers, PROJECTION_DRIVERS);
});

test("site projections never become a persisted or redistributed feed", () => {
  const site = policy.signals.find(signal => signal.id === "current-site-projection");
  assert.equal(site.status, "production-runtime-only");
  assert.equal(site.persistRaw, false);
  assert.equal(site.persistLocalSelectedProjection, true);
  assert.equal(site.redistributeRaw, false);
  assert.equal(site.redistributeDerivedProjection, false);
  assert.deepEqual(policy.runtimeProjection.siteDataBoundary, {
    rawValuesRuntimeOnly: true,
    rawValuesPersisted: false,
    rawValuesTransmitted: false,
    rawValuesRedistributed: false,
    localSelectedProjectionMayBePersisted: true
  });
});

test("source policy allows private runtime projection use but blocks redistribution", () => {
  assert.equal(sourcePolicy.rules.allowBrowserVisibleAlone, false);
  assert.equal(sourcePolicy.rules.allowBrowserVisibleRuntimeOnly, true);
  assert.equal(sourcePolicy.sources.find(source => source.id === "current-site-visible-projection").status, "runtime-only-user-session");
  assert.equal(sourcePolicy.sources.find(source => source.id === "sleeper-projections").status, "pending-redistribution-rights");
});

test("undocumented projections and unlicensed news scraping fail closed", () => {
  for (const id of ["sleeper-undocumented-projections", "unlicensed-publisher-news-scraping"]) {
    const signal = policy.signals.find(candidate => candidate.id === id);
    assert.equal(signal.status, "prohibited");
    assert.equal(signal.persistRaw, false);
    assert.equal(signal.redistributeDerivedProjection, false);
  }
});

test("commercial candidates stay disabled without an authorization record", () => {
  for (const signal of policy.signals.filter(candidate => candidate.category.startsWith("licensed-"))) {
    assert.equal(signal.status, "disabled-pending-commercial-agreement");
    assert.equal(signal.authorizationId, null);
  }
});

test("policy verifier rejects a hidden enablement of a prohibited source", () => {
  const changed = structuredClone(policy);
  changed.signals.find(signal => signal.id === "sleeper-undocumented-projections").status = "production";
  assert.throws(() => verifyModelSignalPolicy(changed), /licensed signal required|required prohibition/);
});
