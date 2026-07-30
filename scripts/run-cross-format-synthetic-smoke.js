import { pathToFileURL } from "node:url";
import { defaultMockSettings, loadMockDraftPlayers, runMockDraft } from "./mock-draft-tournament-lib.js";

export const CROSS_FORMAT_CASES=Object.freeze([
  Object.freeze({scoringFormat:"standard",teams:8,userSlot:1,seed:15101}),
  Object.freeze({scoringFormat:"half-ppr",teams:10,userSlot:5,seed:15505}),
  Object.freeze({scoringFormat:"ppr",teams:12,userSlot:12,seed:15112})
]);

export function runCrossFormatSmoke(){
  const rows=CROSS_FORMAT_CASES.map(testCase=>{const settings=defaultMockSettings({teams:testCase.teams,rounds:16,scoringFormat:testCase.scoringFormat}),players=loadMockDraftPlayers({scoringFormat:testCase.scoringFormat}),draft=runMockDraft({...testCase,settings,players,pickIterations:60,reportIterations:2000,pickBudgetMs:5000,draftBudgetMs:90000});return{...testCase,titleRank:draft.report.userTeam.titleRank,titleChance:draft.report.userTeam.finishProbabilities[0],weeklyRank:draft.report.userTeam.weeklyRank,complete:draft.checks.complete,quantileCoverage:draft.checks.quantileCoverage,maxDecisionMs:draft.metrics.maxDecisionMs,totalMs:draft.metrics.totalMs,finite:draft.report.teamReports.every(team=>team.finishProbabilities.every(value=>Number.isFinite(value)&&value>=0&&value<=1))}}),pass=rows.every(row=>row.complete&&row.quantileCoverage>=14&&row.finite&&row.maxDecisionMs<5000&&row.totalMs<90000);
  return{schemaVersion:1,kind:"cross-format synthetic smoke",cases:CROSS_FORMAT_CASES,rows,pass};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const result=runCrossFormatSmoke();console.log(JSON.stringify(result,null,2));if(!result.pass)process.exitCode=1}
