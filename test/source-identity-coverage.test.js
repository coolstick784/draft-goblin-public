import test from"node:test";
import assert from"node:assert/strict";
import{currentIdentityCoverageReport,identityCoverageReport}from"../scripts/audit-source-identity-coverage.js";

test("identity coverage separates ESPN DOM omissions from captured identity failures",()=>{
  const baselinePlayers=[{id:"gabe",name:"Gabriel Davis",position:"WR",team:"JAX",adp:80},{id:"hou",name:"Houston Texans",position:"DST",team:"HOU",adp:200},{id:"missing",name:"Missing Player",position:"RB",team:"SEA",adp:100}],report=identityCoverageReport({baselinePlayers,espnPlayers:[{name:"Gabe Davis",position:"WR",team:"BUF"},{name:"Texans D/ST",position:"D/ST",team:"HOU"}],sleeperPlayers:[],fantasyProsPlayers:[]});
  assert.equal(report.sources.espn.capturedIdentityMissCount,0);
  assert.equal(report.sources.espn.matchedDraftablePlayers,2);
  assert.equal(report.espn.unavailableInCapturedDom,1);
});

test("current captured ESPN names have no identity omissions",()=>{
  const report=currentIdentityCoverageReport();
  assert.equal(report.sources.espn.capturedIdentityMissCount,0);
  assert.equal(report.espn.capturedIdentityOmissions,0);
  assert.ok(report.overlap.anyCapturedSource>=250);
  assert.ok(report.sources.espn.matchedDraftablePlayers>0);
});
