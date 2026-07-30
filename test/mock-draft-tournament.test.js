import test from "node:test";
import assert from "node:assert/strict";
import { defaultMockSettings, loadMockDraftPlayers, realisticAdpBotPick, syntheticPromotedDistributionModel } from "../scripts/mock-draft-tournament-lib.js";

test("mock tournament catalog exercises a promoted monotone quantile distribution",()=>{
  const model=syntheticPromotedDistributionModel(),players=loadMockDraftPlayers(),skillPlayer=players.find(player=>player.position==="WR"&&player.distribution);
  assert.equal(model.runtimeStatus,"promoted");
  assert.ok(skillPlayer);
  assert.deepEqual(skillPlayer.distribution.quantiles.map(row=>row.p),[.01,.05,.10,.20,.30,.40,.50,.60,.70,.80,.90,.95,.99]);
  assert.ok(skillPlayer.distribution.quantiles.every((row,index,rows)=>index===0||row.value>=rows[index-1].value));
  assert.equal(skillPlayer.distribution.provenance.calibrationId,"synthetic-runtime-exercise-only");
});

test("realistic ADP bot respects roster caps and defers specialists",()=>{
  const players=loadMockDraftPlayers(),settings=defaultMockSettings(),state={platform:"fixture",draftId:"bot-contract",projectionSeason:2026,settings,players,picks:[],updatedAt:Date.now()};
  const first=realisticAdpBotPick({state,slot:1,seed:44});
  assert.ok(first);
  assert.ok(!["K","DST"].includes(first.position));
  assert.ok(Number(first.adp)<60,`expected an early-market player, got ADP ${first.adp}`);
});

test("mock catalog and distributions honor standard, half-PPR, and PPR scoring",()=>{
  const standard=loadMockDraftPlayers({scoringFormat:"standard"}),half=loadMockDraftPlayers({scoringFormat:"half-ppr"}),ppr=loadMockDraftPlayers({scoringFormat:"ppr"}),id=ppr.find(player=>player.position==="WR"&&standard.some(row=>row.id===player.id)&&half.some(row=>row.id===player.id))?.id;
  assert.ok(id);
  const byId=rows=>rows.find(player=>player.id===id),stdPlayer=byId(standard),halfPlayer=byId(half),pprPlayer=byId(ppr);
  assert.ok(stdPlayer.mean<=halfPlayer.mean&&halfPlayer.mean<=pprPlayer.mean);
  assert.equal(stdPlayer.distribution.scoringFormat,"standard");
  assert.equal(halfPlayer.distribution.scoringFormat,"half-ppr");
  assert.equal(pprPlayer.distribution.scoringFormat,"ppr");
  assert.equal(defaultMockSettings({scoringFormat:"standard"}).scoring.reception,0);
  assert.equal(defaultMockSettings({scoringFormat:"half-ppr"}).scoring.reception,.5);
});
