import { pathToFileURL } from "node:url";
import { runMockDraftTournament } from "./mock-draft-tournament-lib.js";

export function conciseTournamentReport(report){return{pass:report.pass,kind:report.kind,warning:report.warning,settings:report.settings,rows:report.drafts.map(draft=>{const winner=[...draft.report.teamReports].sort((a,b)=>b.finishProbabilities[0]-a.finishProbabilities[0]||a.slot-b.slot)[0],userTitle=Number(draft.report.userTeam.finishProbabilities[0]),winnerTitle=Number(winner.finishProbabilities[0]);return{slot:draft.userSlot,titleRank:draft.report.userTeam.titleRank,titleChance:Number(userTitle.toFixed(4)),weeklyRank:draft.report.userTeam.weeklyRank,grade:draft.report.grade?.letter,titleMarginToFirst:Number((userTitle-winnerTitle).toFixed(4)),winningSlot:winner.slot,winningTitleChance:Number(winnerTitle.toFixed(4)),checks:draft.checks,timing:draft.metrics,roster:draft.roster.map(player=>`${player.position} ${player.name}`),...(winner.slot!==draft.userSlot?{winningRoster:winner.draft.map(player=>`${player.position} ${player.name}`)}:{})}})} }

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const report=runMockDraftTournament();
  console.log(JSON.stringify(conciseTournamentReport(report),null,2));
  if(!report.pass)process.exitCode=1;
}
