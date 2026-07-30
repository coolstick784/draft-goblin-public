import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { server } from "../server/index.js";
import { fixtureState } from "./fixture.js";

const post = (base, state) => fetch(`${base}/v1/evaluate`, { method: "POST", headers: { "content-type": "application/json", "x-installation-id": `shadow-${state.draftId}` }, body: JSON.stringify({ state, userSlot: 1, iterations: 20, refineIterations: 20, seed: 819 }) }).then(response => response.json());

test("server shadow telemetry is absent by default and collected only when explicitly enabled", async () => {
  const previous = process.env.DRAFT_CHAMPION_DISTRIBUTION_SHADOW; delete process.env.DRAFT_CHAMPION_DISTRIBUTION_SHADOW;
  server.listen(0); await once(server, "listening"); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const off = await post(base, { ...fixtureState(), draftId: "shadow-off" }), offHealth = await fetch(`${base}/health`).then(response => response.json());
    assert.equal(offHealth.distributionShadow.entries, 0);
    process.env.DRAFT_CHAMPION_DISTRIBUTION_SHADOW = "1";
    const on = await post(base, { ...fixtureState(), draftId: "shadow-on" });
    const deadline = Date.now() + 3000; let health;
    do { await new Promise(resolve => setTimeout(resolve, 20)); health = await fetch(`${base}/health`).then(response => response.json()); } while (!health.distributionShadow.entries && Date.now() < deadline);
    assert.equal(health.distributionShadow.enabled, true); assert.equal(health.distributionShadow.entries, 1); assert.equal(health.distributionShadow.recent[0].liveOrderingChanged, false);
    assert.deepEqual(on.recommendations.map(item => item.player.id), off.recommendations.map(item => item.player.id));
  } finally { previous === undefined ? delete process.env.DRAFT_CHAMPION_DISTRIBUTION_SHADOW : process.env.DRAFT_CHAMPION_DISTRIBUTION_SHADOW = previous; server.close(); await once(server, "close"); }
});
