import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {PersistentReportStore} from "../server/report-store.js";

test("draft reports survive an in-memory store reset",()=>{
  const directory=pathToFileURL(`${fs.mkdtempSync(path.join(os.tmpdir(),"draft-champion-reports-"))}${path.sep}`);
  try{
    const store=new PersistentReportStore({directory,memoryLimit:1});
    const report={draftId:"sanitized-draft",grade:{score:91}};
    store.set("report-1",report);
    store.memory.clear();
    assert.deepEqual(store.get("report-1").report,report);
  }finally{
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test("stored draft reports repair legacy model-optimal identity mismatches on read",()=>{
  const directory=pathToFileURL(`${fs.mkdtempSync(path.join(os.tmpdir(),"draft-champion-reports-"))}${path.sep}`);
  try{
    const store=new PersistentReportStore({directory,memoryLimit:1}),report={decisionAudit:{contemporaneous:{exactMatches:0,totalCaptured:1,history:[{actual:{id:"model-1",name:"Puka Nacua",position:"WR"},optimal:{playerId:"espn-1",name:"Puka Nacua",position:"WR"},selectedRank:null,candidates:[{rank:1,playerId:"espn-1",name:"Puka Nacua",position:"WR",titleChance:.2}]}]}}};
    store.set("legacy-report",report);store.memory.clear();const audit=store.get("legacy-report").report.decisionAudit.contemporaneous;
    assert.equal(audit.exactMatches,1);assert.equal(audit.totalCaptured,1);assert.equal(audit.history[0].selectedRank,1);assert.equal(audit.history[0].isExactMatch,true);
  }finally{fs.rmSync(directory,{recursive:true,force:true})}
});

test("draft report ids cannot escape the report directory",()=>{
  const store=new PersistentReportStore();
  assert.equal(store.get("../private"),null);
  assert.throws(()=>store.set("../private",{}),/invalid draft report id/);
});
