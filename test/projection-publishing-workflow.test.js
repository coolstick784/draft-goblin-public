import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";

test("daily publisher is manual-runnable, least-privilege, and verifies the public feed-only deployment",()=>{
  const workflow=fs.readFileSync(new URL("../.github/workflows/publish-projections.yml",import.meta.url),"utf8"),manifest=JSON.parse(fs.readFileSync(new URL("../extension/manifest.json",import.meta.url)));
  assert.match(workflow,/cron: "17 10 \* \* \*"/);assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/cache-dependency-path: requirements-owned-model\.txt/);assert.match(workflow,/permissions:\s+contents: read/);assert.doesNotMatch(workflow,/contents: write|pages: write|id-token: write/);assert.match(workflow,/repository: coolstick784\/draft-goblin-projections/);assert.match(workflow,/ssh-key: \$\{\{ secrets\.PROJECTION_FEED_DEPLOY_KEY \}\}/);assert.match(workflow,/git -C public-feed push origin main/);assert.match(workflow,/Verify public Draft Goblin snapshot/);assert.match(workflow,/verify-projection-deployment\.js dist\/projection-site\/projections\/manifest\.json/);assert.ok(manifest.permissions.includes("alarms"));assert.ok(manifest.host_permissions.includes("https:\/\/coolstick784.github.io\/\*"));
});

test("background refreshes remote data on install, startup, alarm, and side-panel activation",()=>{const source=fs.readFileSync(new URL("../extension/background.js",import.meta.url),"utf8");assert.match(source,/PROJECTION_REFRESH_ALARM/);assert.match(source,/periodInMinutes:240/);assert.match(source,/onStartup/);assert.match(source,/onAlarm/);assert.match(source,/refreshRemoteProjections/)});

test("public updater atomically publishes only daily Draft Goblin for live use",()=>{
  const workflow=fs.readFileSync(new URL("../.github/workflows/publish-projections.yml",import.meta.url),"utf8"),verifier=fs.readFileSync(new URL("../scripts/verify-projection-deployment.js",import.meta.url),"utf8"),publisher=fs.readFileSync(new URL("../scripts/publish-projection-feed.js",import.meta.url),"utf8"),feed=fs.readFileSync(new URL("../extension/projection-feed.js",import.meta.url),"utf8"),panel=fs.readFileSync(new URL("../extension/sidepanel.js",import.meta.url),"utf8");
  assert.match(workflow,/Build fresh Draft Goblin projections/);assert.match(workflow,/build-owned-market-shadow\.js/);assert.match(workflow,/owned-market-shadow-\$\{PROJECTION_SEASON/);assert.match(verifier,/market-adjusted-shadow-v2/);assert.match(workflow,/draft-goblin-projections/);assert.doesNotMatch(workflow,/FANTASYPROS_API_KEY|SLEEPER_WRITTEN_AUTHORIZATION_ID/);assert.doesNotMatch(publisher,/buildOwnedAggregateFeeds|conservative owned ensemble/);assert.match(publisher,/buildDraftGoblinFeeds/);assert.match(feed,/market-adjusted-shadow-required/);assert.doesNotMatch(panel,/\/v1\/projections\/consensus/);assert.match(panel,/\/v1\/projections\/draftgoblin/);
});
