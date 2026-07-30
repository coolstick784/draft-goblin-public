import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{projectionResponseFromFeed,validateProjectionFeed}from"../extension/projection-feed.js";

const fallback=JSON.parse(fs.readFileSync(new URL("../extension/engine-data/draft-goblin-fallback.json",import.meta.url),"utf8"));

test("the bundled Draft Goblin fallback is a current policy-approved complete projection feed",()=>{
  const assessment=validateProjectionFeed(fallback,{now:Date.parse(fallback.generatedAt),maximumAgeMs:7*24*60*60*1000});
  assert.equal(assessment.valid,true,assessment.errors.join(", "));
  assert.deepEqual(Object.keys(fallback.feeds),["draftGoblin"]);
  for(const scoring of["STD","HALF","PPR"]){
    const feed=fallback.feeds.draftGoblin[scoring];
    assert.equal(feed.available,true);
    assert.equal(feed.projectionVariant,"market-adjusted-shadow-v2");
    assert.match(feed.modelVersion,/market-shadow-v2/);
    assert.ok(feed.players.length>=1000);
    assert.equal(new Set(feed.players.map(player=>`${player.id}:${player.position}`)).size,feed.players.length);
    assert.ok(feed.players.every(player=>Number(player.points)>0&&Number(player.season)===2026&&player.scoring===scoring));
  }
});

test("the extension projection client uses the bundled feed only when the downloaded feed is unavailable",()=>{
  const client=fs.readFileSync(new URL("../extension/local-engine-client.js",import.meta.url),"utf8");
  assert.match(client,/const remote=.*cachedProjectionFeed[\s\S]*if\(remote\)return remote/);
  assert.match(client,/engine-data\/draft-goblin-fallback\.json/);
  assert.match(client,/bundled-policy-approved-fallback/);
  const response=projectionResponseFromFeed({bundle:fallback},"/v1/projections/draftgoblin?season=2026&scoring=STD");
  assert.equal(response.players.find(player=>player.name==="James Cook")?.points,201.12);
});
