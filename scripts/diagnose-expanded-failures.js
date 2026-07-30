import { pathToFileURL } from "node:url";
import { runMockDraft } from "./mock-draft-tournament-lib.js";

const CASES=[{userSlot:6,seed:14106},{userSlot:11,seed:14111},{userSlot:12,seed:14112}];

export function diagnoseExpandedFailures(){return CASES.map(testCase=>{const draft=runMockDraft({...testCase,pickIterations:180,reportIterations:10000}),winner=[...draft.report.teamReports].sort((a,b)=>b.finishProbabilities[0]-a.finishProbabilities[0]||a.slot-b.slot)[0];return{...testCase,titleRank:draft.report.userTeam.titleRank,titleChance:draft.report.userTeam.finishProbabilities[0],weeklyRank:draft.report.userTeam.weeklyRank,winner:{slot:winner.slot,titleChance:winner.finishProbabilities[0],weeklyRank:winner.weeklyRank,roster:winner.draft.map(player=>({round:player.round,name:player.name,position:player.position}))},userRoster:draft.roster.map(player=>({round:player.round,name:player.name,position:player.position})),userDecisions:draft.userPicks.map(pick=>({pickNo:pick.pickNo,name:pick.name,position:pick.position,titleChanceAtDecision:pick.titleChanceAtDecision,decisionMs:pick.decisionMs}))}})}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(diagnoseExpandedFailures(),null,2));
