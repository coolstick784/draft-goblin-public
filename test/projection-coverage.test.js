import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{buildPlayerIdentityIndex,matchPlayerIdentity}from"../extension/player-identity.js";
import{latestFantasyProsSnapshot}from"../server/fantasypros.js";
import{currentSleeperProjections}from"../server/sleeper-projections.js";

const baseline=JSON.parse(fs.readFileSync(new URL("../data/generated/current-baseline.json",import.meta.url),"utf8")).players;
const positions=new Set(["QB","RB","WR","TE","K","DST"]);
const draftable=maxAdp=>baseline.filter(player=>positions.has(player.position)&&player.team&&player.team!=="FA"&&Number(player.adp)>0&&Number(player.adp)<maxAdp);
const fantasyPros=latestFantasyProsSnapshot({season:2026,scoring:"PPR",now:Date.parse("2026-07-13T18:00:00Z")}).players;
const sleeper=currentSleeperProjections({season:2026,scoring:"PPR"}).players;
const fpIndex=buildPlayerIdentityIndex(fantasyPros),sleeperIndex=buildPlayerIdentityIndex(sleeper);
const coverage=(players,index)=>players.filter(player=>matchPlayerIdentity(index,player)).length/players.length;
const unionCoverage=players=>players.filter(player=>matchPlayerIdentity(fpIndex,player)||matchPlayerIdentity(sleeperIndex,player)).length/players.length;

test("current FantasyPros and Sleeper artifacts cover nearly every priority draft player",()=>{
  const priority=draftable(200);
  assert.ok(fantasyPros.length>=400,`FantasyPros merged coverage fell to ${fantasyPros.length} players`);
  assert.ok(sleeper.length>=500,`Sleeper coverage fell to ${sleeper.length} players`);
  assert.ok(coverage(priority,fpIndex)>=.85,"FantasyPros should cover at least 85% of priority draft players");
  assert.ok(coverage(priority,sleeperIndex)>=.99,"Sleeper should cover at least 99% of priority draft players");
  assert.ok(unionCoverage(priority)>=.99,"the current-source union should cover at least 99% of priority draft players");
});

test("current-source union remains broad through late-round draftable depth",()=>{
  assert.ok(unionCoverage(draftable(300))>=.98,"FantasyPros plus Sleeper should cover at least 98% of players inside ADP 300");
});
