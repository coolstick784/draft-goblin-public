import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const catalog=JSON.parse(fs.readFileSync(new URL("../extension/engine-data/catalog.json",import.meta.url),"utf8"));
const supportedPositions=new Set(["QB","RB","WR","TE","K","DST"]);

test("every bundled player-board player has complete, internally consistent projection data",()=>{
  assert.ok(catalog.players.length>500,"the packaged board must contain the full modeled catalog");
  assert.equal(new Set(catalog.players.map(player=>String(player.id))).size,catalog.players.length,"player ids must be unique");
  assert.equal(new Set(catalog.players.map(player=>`${player.name}|${player.position}`)).size,catalog.players.length,"canonical player/position rows must not be duplicated");
  for(const player of catalog.players){
    const label=`${player.name||player.id}`;
    assert.ok(String(player.id||"").trim(),`${label} needs an id`);
    assert.ok(String(player.name||"").trim(),`${label} needs a name`);
    assert.ok(supportedPositions.has(player.position),`${label} has unsupported position ${player.position}`);
    assert.ok(String(player.team||"").trim(),`${label} needs a team or FA designation`);
    for(const key of ["mean","meanPpr","meanHalf","meanStd","floor","ceiling","risk","scarcity"]){
      assert.ok(Number.isFinite(Number(player[key]))&&Number(player[key])>=0,`${label} needs a finite nonnegative ${key}`);
    }
    assert.ok(Number(player.floor)<=Number(player.mean),`${label} floor cannot exceed its simulation projection`);
    assert.ok(Number(player.ceiling)>=Number(player.mean),`${label} ceiling cannot trail its simulation projection`);
    assert.ok(player.adp==null||Number.isFinite(Number(player.adp))&&Number(player.adp)>0,`${label} ADP must be positive or explicitly unavailable`);
  }
});
