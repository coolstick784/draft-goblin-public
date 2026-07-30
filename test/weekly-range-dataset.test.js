import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{loadWeeklyRangeDataset}from"../scripts/load-weekly-range-dataset.js";

test("weekly range dataset builder preserves activity and rookie semantics",()=>{const source=fs.readFileSync(new URL("../scripts/build-weekly-range-dataset.py",import.meta.url),"utf8");assert.match(source,/rookie_year/);assert.match(source,/active-observed/);assert.match(source,/inactive-or-unavailable/);assert.match(source,/unknown-activity/);assert.match(source,/private-cache-only/);assert.match(source,/sourceActual remains the scoring-compatible target/)});

test("private JSONL loader retains activity and true-rookie fields",()=>{const path=new URL("./weekly-range-row-fixture.jsonl",import.meta.url);fs.writeFileSync(path,JSON.stringify({sourceId:"test",season:2024,week:1,playerId:"p",name:"Player",position:"WR",projected:10,sourceActual:12,outcomeStatus:"active-observed",rookie:true,rookieSeason:2024})+"\n");try{const[row]=loadWeeklyRangeDataset(path);assert.equal(row.year,2024);assert.equal(row.actual,12);assert.equal(row.activityStatus,"active-observed");assert.equal(row.rookie,true)}finally{fs.unlinkSync(path)}});
