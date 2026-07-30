import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {buildDraftReport} from "../core/post-draft-report.js";
import {snakeSlot} from "../shared/domain.js";

const panel=fs.readFileSync(new URL("../extension/sidepanel.js",import.meta.url),"utf8");
const background=fs.readFileSync(new URL("../extension/background.js",import.meta.url),"utf8");
const html=fs.readFileSync(new URL("../extension/sidepanel.html",import.meta.url),"utf8");
const reportRenderer=fs.readFileSync(new URL("../extension/report.js",import.meta.url),"utf8");

test("completed report cache fingerprints semantic state and evicts rejected requests",()=>{
  assert.match(panel,/completedDraftFingerprint/);
  assert.match(panel,/state\.picks\.map\(pick=>\[pick\.pickNo,pick\.playerId,pick\.slot\]\)/);
  assert.match(panel,/state\.settings,state\.modelVersion,state\.projectionSeason/);
  assert.match(panel,/reportPromise===cached/);
  assert.match(panel,/reportKey="";reportPromise=null/);
});

test("completed report surfaces use only the calibrated report user team",()=>{
  const completed=panel.slice(panel.indexOf("const report=result.report;"),panel.indexOf('$("status").textContent="Draft complete"'));
  assert.match(completed,/report\.userTeam\.finishProbabilities\[0\]/);
  assert.match(completed,/report\.userTeam\.titleRank/);
  assert.doesNotMatch(completed,/lastEvaluationData|stableRefinedResult|championshipProbability/);
  assert.match(reportRenderer,/const user=report\.userTeam/);
  assert.match(reportRenderer,/pct\(user\.finishProbabilities\[0\]\)/);
  assert.match(reportRenderer,/user\.titleRank/);
  assert.match(panel,/completedPct=n=>`\$\{\(n\*100\)\.toFixed\(3\)\}%`/);
  assert.match(reportRenderer,/toFixed\(3\)/);
});

test("opening a report keeps it reopenable until the user explicitly dismisses it",()=>{
  assert.match(html,/id="dismissReport"/);
  assert.match(panel,/reportLink"\)\.addEventListener\("click"[^\n]+Reopen draft report/);
  assert.match(panel,/dismissReport"\)\.addEventListener\("click"[^\n]+markCompletedDraftOpened/);
});

test("side panel filters draft changes through the active tab",()=>{
  assert.match(panel,/chrome\.storage\.session\.get\("activeDraftTab"\)/);
  assert.match(panel,/changes\[`draft:\$\{activeDraftTab\}`\]/);
  assert.doesNotMatch(panel,/draftChanges\.find\(\(\[,change\]\)=>change\.newValue\)/);
});

test("draft tab activation updates ownership and clears a prior tab error",()=>{
  assert.match(background,/chrome\.tabs\.onActivated\?\.addListener/);
  assert.match(background,/async function activateDraftTab/);
  assert.match(background,/session\.remove\("draftError"\)/);
  assert.match(background,/session\.set\(\{activeDraftTab:tabId\}\)/);
});

test("packaging is versioned, sorted, deterministic, and byte-verified",()=>{
  const script=fs.readFileSync(new URL("../scripts/package-extension.ps1",import.meta.url),"utf8");
  const pkg=JSON.parse(fs.readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  assert.match(pkg.scripts["package:extension"],/package-extension\.ps1/);
  assert.match(script,/manifest\.version/);
  assert.match(script,/Sort-Object/);
  assert.match(script,/1980, 1, 1/);
  assert.match(script,/Compare-Object/);
  assert.match(script,/Get-FileHash/);
  assert.doesNotMatch(script,/projection-snapshots|fantasyPros|sleeper\s*=/i);
});

test("report engine supports a complete 12-team 16-round ESPN state",()=>{
  const teams=12,rounds=16,players=Array.from({length:teams*rounds},(_,index)=>({id:`espn-${index+1}`,name:`Player ${index+1}`,position:["QB","RB","WR","TE","K","DST"][index%6],team:`T${index%32}`,mean:250-index/10,risk:.35}));
  const picks=players.map((player,index)=>({pickNo:index+1,playerId:player.id,slot:snakeSlot(index+1,teams)}));
  const state={platform:"espn",draftId:"twelve-by-sixteen",updatedAt:Date.now(),settings:{teams,rounds,playoffTeams:6,slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:7}},players,picks};
  const report=buildDraftReport({state,userSlot:12,iterations:25,seed:91});
  assert.equal(picks.length,192);
  assert.equal(report.teamReports.length,12);
  assert.ok(report.teamReports.every(team=>team.rosterSize===16&&team.draft.length===16));
  assert.equal(report.userTeam.draft.at(-1).round,16);
});
