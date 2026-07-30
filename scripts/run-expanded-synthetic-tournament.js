import { pathToFileURL } from "node:url";
import { runMockDraftTournament } from "./mock-draft-tournament-lib.js";

export const EXPANDED_SLOTS=Object.freeze([1,2,4,6,7,9,11,12]);
export const EXPANDED_SEEDS=Object.freeze([14101,14102,14104,14106,14107,14109,14111,14112]);

const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b),offset=(sorted.length-1)*p,lower=Math.floor(offset),upper=Math.ceil(offset),weight=offset-lower;return sorted[lower]*(1-weight)+sorted[upper]*weight};

export function summarizeExpandedTournament(report){
  const drafts=report.drafts,firsts=drafts.filter(draft=>draft.report.userTeam.titleRank===1).length,ranks=drafts.map(draft=>draft.report.userTeam.titleRank),decisionTimes=drafts.flatMap(draft=>draft.userPicks.map(pick=>pick.decisionMs)),rows=drafts.map(draft=>{const winner=[...draft.report.teamReports].sort((a,b)=>b.finishProbabilities[0]-a.finishProbabilities[0]||a.slot-b.slot)[0],chance=Number(draft.report.userTeam.finishProbabilities[0]);return{slot:draft.userSlot,seed:draft.seed,titleRank:draft.report.userTeam.titleRank,titleChance:Number(chance.toFixed(5)),marginToFirst:Number((chance-winner.finishProbabilities[0]).toFixed(5)),weeklyRank:draft.report.userTeam.weeklyRank,grade:draft.report.grade.letter,maxDecisionMs:draft.metrics.maxDecisionMs,totalMs:draft.metrics.totalMs,complete:draft.checks.complete}}),metrics={drafts:drafts.length,firsts,firstPlaceRate:firsts/drafts.length,meanTitleRank:ranks.reduce((sum,value)=>sum+value,0)/ranks.length,p95DecisionMs:percentile(decisionTimes,.95),maximumDecisionMs:Math.max(...decisionTimes)};
  const gates={firstPlaceRate:metrics.firstPlaceRate>=.75,meanTitleRank:metrics.meanTitleRank<=1.75,complete:rows.every(row=>row.complete),p95DecisionTime:metrics.p95DecisionMs<5000};
  return{schemaVersion:1,preregistered:true,slots:EXPANDED_SLOTS,seeds:EXPANDED_SEEDS,metrics,gates,pass:Object.values(gates).every(Boolean),rows};
}

export function runExpandedTournament(){return summarizeExpandedTournament(runMockDraftTournament({slots:EXPANDED_SLOTS,seeds:EXPANDED_SEEDS,pickIterations:180,reportIterations:10000}))}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const result=runExpandedTournament();console.log(JSON.stringify(result,null,2));if(!result.pass)process.exitCode=1}
