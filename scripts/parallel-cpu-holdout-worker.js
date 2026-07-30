import fs from "node:fs";
import { parentPort } from "node:worker_threads";
import { evaluateDraft } from "../core/evaluate.js";
import { buildDraftReport } from "../core/post-draft-report.js";
import { rosterNeeds } from "../core/roster.js";
import { sensiblePositionCap } from "../core/recommend.js";
import { normalizeSettings, snakeSlot } from "../shared/domain.js";
import { decisionSeed, modelImplementationHash } from "./cpu-holdout-gate-lib.js";

const rows=JSON.parse(fs.readFileSync(new URL("../data/generated/sleeper-current-projections.json",import.meta.url)));
const supported=new Set(["QB","RB","WR","TE","K","DEF"]);
const players=rows.filter(row=>supported.has(row.player?.position)&&row.player?.team).map(row=>{const stats=row.stats||{},mean=Number(stats.pts_ppr||0),position=row.player.position==="DEF"?"DST":row.player.position,rawAdp=Number(stats.adp_ppr),risk=row.player.injury_status?.toLowerCase()==="out"?.95:row.player.injury_status?.8:.4;return{id:String(row.player_id),name:`${row.player.first_name||""} ${row.player.last_name||""}`.trim(),position,team:row.player.team,mean,floor:mean*(1-risk*.55),ceiling:mean*(1.25+risk*.35),risk,scarcity:["RB","TE"].includes(position)?.6:.35,adp:Number.isFinite(rawAdp)&&rawAdp>0&&rawAdp<900?rawAdp:null,adpSd:12,adpSeason:2026,adpTeams:12,adpScoring:"ppr",adpProvider:"sleeper",eligibleForRecommendation:mean>0}}).filter(player=>player.eligibleForRecommendation).sort((a,b)=>Number(a.adp||9999)-Number(b.adp||9999)||b.mean-a.mean||String(a.id).localeCompare(String(b.id)));
const byId=new Map(players.map(player=>[player.id,player])),settings=normalizeSettings({teams:12,rounds:16,playoffTeams:6,slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:7}});
function stateFor(task,picks){return{platform:"fixture",draftId:task.taskId,projectionSeason:2026,settings,picks,players,updatedAt:Date.now()}}
function cpuPick(state,slot,round){const drafted=new Set(state.picks.map(p=>p.playerId)),roster=state.picks.filter(p=>p.slot===slot).map(p=>byId.get(p.playerId)).filter(Boolean),counts=roster.reduce((out,p)=>((out[p.position]=(out[p.position]||0)+1),out),{}),needs=rosterNeeds(roster,settings.slots),remaining=settings.rounds-roster.length,required=["QB","RB","WR","TE","K","DST"].filter(p=>Number(needs[p]||0)>0),completionRequired=required.reduce((sum,p)=>sum+Number(needs[p]||0),0)+(Number(needs.FLEX||0)>0?1:0)>=remaining,candidates=players.filter(p=>!drafted.has(p.id)&&(counts[p.position]||0)<sensiblePositionCap(p.position,settings.slots)&&(!completionRequired||required.includes(p.position)||Number(needs.FLEX||0)>0&&["RB","WR","TE"].includes(p.position))&&(!["K","DST"].includes(p.position)||round>=15||completionRequired));return candidates[0]||players.find(p=>!drafted.has(p.id))}
function run(task){
  if(task.modelHash!==modelImplementationHash())throw new Error("Frozen model implementation changed after holdout scheduling");
  const picks=[],userPicks=[],decisionAudit=[];
  while(picks.length<settings.teams*settings.rounds){
    const pickNo=picks.length+1,slot=snakeSlot(pickNo,settings.teams),round=Math.ceil(pickNo/settings.teams),state=stateFor(task,picks);
    if(slot!==task.userSlot){const selected=cpuPick(state,slot,round);if(!selected)throw new Error(`No CPU player at ${pickNo}`);picks.push({pickNo,playerId:selected.id,slot,actor:"cpu"});continue}
    // Causal boundary: only the state observable at this pick enters evaluation;
    // no future CPU picks, terminal outcomes, retries, or alternate paths are used.
    const seed=decisionSeed(task.scenarioSeed,pickNo),[recommendation]=evaluateDraft({state,userSlot:task.userSlot,strategy:task.policy.strategy,sourceProfile:task.policy.sourceProfile,limit:task.policy.recommendationLimit,iterations:task.policy.pickIterations,seed});
    if(!recommendation)throw new Error(`No model recommendation at ${pickNo}`);
    decisionAudit.push({pickNo,observedPickCount:state.picks.length,recommendationCount:1,seed});picks.push({pickNo,playerId:recommendation.player.id,slot,actor:"model"});userPicks.push({pickNo,playerId:recommendation.player.id,name:recommendation.player.name,position:recommendation.player.position,titleChanceAtDecision:Number(recommendation.simulation.championshipProbability)});
  }
  const report=buildDraftReport({state:stateFor(task,picks),userSlot:task.userSlot,iterations:task.policy.outcomeIterations,seed:task.outcomeSeed});
  return{schemaVersion:1,mode:"frozenHoldout",benchmarkId:task.benchmarkId,policyHash:task.policyHash,modelHash:task.modelHash,taskId:task.taskId,scenarioSeed:task.scenarioSeed,outcomeSeed:task.outcomeSeed,userSlot:task.userSlot,selectionMode:"causal_single_path",adaptiveRetries:0,pathsEvaluated:1,totalPicks:picks.length,userPickCount:userPicks.length,autopickCount:0,timeoutCount:0,mismatchCount:0,decisionAudit,userPicks,final:{titleRank:report.userTeam.titleRank,titleChance:Number(report.userTeam.finishProbabilities[0])}};
}
parentPort.on("message",task=>{try{parentPort.postMessage({ok:true,result:run(task)})}catch(error){parentPort.postMessage({ok:false,taskId:task.taskId,error:error.stack||error.message})}});
