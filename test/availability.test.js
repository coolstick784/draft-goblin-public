import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { availabilityCalibration, availabilityProbability, marketPickCenter, marketPickSd } from "../core/availability.js";

const artifact=JSON.parse(fs.readFileSync(new URL("../data/research/availability-calibration-2026.json",import.meta.url),"utf8"));
test("production availability artifact contains only explicit 2026 cells",()=>{
  assert.equal(artifact.season,2026);assert.equal(Object.keys(artifact.cells).length,12);
  for(const cell of Object.values(artifact.cells)){assert.equal(cell.season,2026);assert.match(cell.startDate,/^2026-/);assert.match(cell.endDate,/^2026-/);assert.ok(cell.totalDrafts>0&&cell.players>0)}
});
test("calibration selects scoring and team context without crossing seasons",()=>{
  const standard=availabilityCalibration({season:2026,settings:{teams:10,scoring:{reception:0}}}),ppr=availabilityCalibration({season:2026,settings:{teams:10,scoring:{reception:1}}});
  assert.equal(standard.teams,10);assert.equal(standard.scoring,"standard");assert.equal(ppr.scoring,"ppr");assert.notDeepEqual(standard.curve,ppr.curve);assert.equal(availabilityCalibration({season:2025,settings:{teams:10,scoring:{reception:0}}}),null);
});
test("mismatched or missing observed spread provenance cannot override 2026 curve",()=>{
  const context={season:2026,settings:{teams:10,scoring:{reception:0}}},base={adp:8},wrong={...base,adpSd:18,adpSdSource:"provider-observed",adpSeason:2025,adpTeams:10,adpScoring:"standard"};
  assert.equal(marketPickSd(wrong,context),marketPickSd(base,context));
});
test("2026 elite availability is monotone and Cook-like tails stay below one percent",()=>{
  const context={season:2026,settings:{teams:10,scoring:{reception:0}}},player={adp:7.7};
  const at10=availabilityProbability(player,10,8,context),at15=availabilityProbability(player,15,8,context);
  assert.ok(at10>=at15);assert.ok(at15<.01);assert.ok(at15>=0&&at15<=1);
});

test("unranked-player ADP sentinels do not produce market availability",()=>{
  const context={season:2026,settings:{teams:10,scoring:{reception:1}}};
  assert.equal(availabilityProbability({name:"Unranked",position:"WR",adp:999},40,30,context),.5);
  assert.equal(availabilityProbability({name:"Unranked",position:"WR",adp:9999999},40,30,context),.5);
});
test("a visible ESPN rank of 41 has a plausible chance to survive from pick 34 to 39",()=>{
  const context={season:2026,settings:{teams:12,scoring:{reception:1}}};
  const chance=availabilityProbability({name:"Josh Allen",position:"QB",adp:41,adpSource:"espn-rank"},39,34,context);
  assert.ok(chance>.7&&chance<.8,`expected roughly 74%, received ${chance}`);
});

test("tight-end ADP is excluded from market timing while other positions stay calibrated",()=>{
  const context={season:2026,settings:{teams:12,scoring:{reception:1}}},te={name:"Travis Kelce",position:"TE",adp:104},wr={name:"Wide receiver",position:"WR",adp:104};
  assert.equal(marketPickCenter(te,context),null);
  assert.equal(marketPickSd(te,context),null);
  assert.equal(marketPickCenter(wr,context),104);
  const teChance=availabilityProbability(te,91,79,context),wrChance=availabilityProbability(wr,91,79,context);
  assert.equal(teChance,1);
  assert.ok(wrChance>.85,`non-TE market behavior should be unchanged, received ${wrChance}`);
});

test("changing a tight end's ADP cannot change its decision availability",()=>{
  const context={season:2026,settings:{teams:12,scoring:{reception:1}}};
  for(const adp of [24,60,108,180]){
    assert.equal(marketPickCenter({position:"TE",adp},context),null);
    assert.equal(availabilityProbability({position:"TE",adp},91,79,context),1);
  }
});
