import fs from "node:fs";
import { parentPort } from "node:worker_threads";
import { evaluateDraft } from "../core/evaluate.js";
import { buildDraftReport } from "../core/post-draft-report.js";
import { rosterNeeds } from "../core/roster.js";
import { sensiblePositionCap } from "../core/recommend.js";
import { normalizeSettings, snakeSlot } from "../shared/domain.js";

const rows=JSON.parse(fs.readFileSync(new URL("../data/generated/sleeper-current-projections.json",import.meta.url)));
const supported=new Set(["QB","RB","WR","TE","K","DEF"]);
const players=rows.filter(row=>supported.has(row.player?.position)&&row.player?.team).map(row=>{
  const stats=row.stats||{},mean=Number(stats.pts_ppr||0),position=row.player.position==="DEF"?"DST":row.player.position,rawAdp=Number(stats.adp_ppr),risk=row.player.injury_status?.toLowerCase()==="out"?.95:row.player.injury_status?.8:.4;
  return{id:String(row.player_id),name:`${row.player.first_name||""} ${row.player.last_name||""}`.trim(),position,team:row.player.team,mean,floor:mean*(1-risk*.55),ceiling:mean*(1.25+risk*.35),risk,scarcity:["RB","TE"].includes(position)?.6:.35,adp:Number.isFinite(rawAdp)&&rawAdp>0&&rawAdp<900?rawAdp:null,adpSd:12,adpSeason:2026,adpTeams:12,adpScoring:"ppr",adpProvider:"sleeper",eligibleForRecommendation:mean>0};
}).filter(player=>player.eligibleForRecommendation).sort((a,b)=>Number(a.adp||9999)-Number(b.adp||9999)||b.mean-a.mean||String(a.id).localeCompare(String(b.id)));
const byId=new Map(players.map(player=>[player.id,player]));
const settings=normalizeSettings({teams:12,rounds:16,playoffTeams:6,slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:7}});

function cpuPick(state,slot,round){
  const drafted=new Set(state.picks.map(pick=>pick.playerId)),roster=state.picks.filter(pick=>pick.slot===slot).map(pick=>byId.get(pick.playerId)).filter(Boolean),counts=roster.reduce((out,player)=>((out[player.position]=(out[player.position]||0)+1),out),{}),needs=rosterNeeds(roster,settings.slots),remaining=settings.rounds-roster.length,required=["QB","RB","WR","TE","K","DST"].filter(position=>Number(needs[position]||0)>0),completionRequired=required.reduce((sum,position)=>sum+Number(needs[position]||0),0)+(Number(needs.FLEX||0)>0?1:0)>=remaining;
  const candidates=players.filter(player=>!drafted.has(player.id)&&(counts[player.position]||0)<sensiblePositionCap(player.position,settings.slots)&&(!completionRequired||required.includes(player.position)||Number(needs.FLEX||0)>0&&["RB","WR","TE"].includes(player.position))&&(!(["K","DST"].includes(player.position))||round>=15||completionRequired));
  return candidates[0]||players.find(player=>!drafted.has(player.id));
}

const cloneNode=node=>({picks:node.picks.map(pick=>({...pick})),userPicks:node.userPicks.map(pick=>({...pick})),score:Number(node.score||0)});
const stateFor=(task,node)=>({platform:"fixture",draftId:task.taskId,projectionSeason:2026,settings,picks:node.picks,players,updatedAt:Date.now()});
const signature=node=>node.picks.map(pick=>`${pick.pickNo}:${pick.slot}:${pick.playerId}`).join("|");

function advanceCpu(task,node){
  while(node.picks.length<settings.teams*settings.rounds){const pickNo=node.picks.length+1,slot=snakeSlot(pickNo,settings.teams);if(slot===task.userSlot)break;const selected=cpuPick(stateFor(task,node),slot,Math.ceil(pickNo/settings.teams));if(!selected)throw new Error(`No CPU player at ${pickNo}`);node.picks.push({pickNo,playerId:selected.id,slot,actor:"cpu"})}
  return node;
}

function optimizePass(task){
  let beam=[advanceCpu(task,{picks:[],userPicks:[],score:0,userSlot:task.userSlot})],expanded=0;
  while(beam[0].picks.length<settings.teams*settings.rounds){
    const next=[];
    for(const node of beam){
      const state=stateFor(task,node),pickNo=state.picks.length+1,evaluated=evaluateDraft({state,userSlot:task.userSlot,strategy:"balanced",sourceProfile:"projectionLed",limit:task.branchFactor,iterations:task.pickIterations,seed:task.scenarioSeed});
      for(const item of evaluated.slice(0,task.branchFactor)){const child=cloneNode(node);child.userSlot=task.userSlot;child.picks.push({pickNo,playerId:item.player.id,slot:task.userSlot,actor:"model"});child.userPicks.push({pickNo,playerId:item.player.id,name:item.player.name,position:item.player.position,searchTitleChance:Number(item.simulation.championshipProbability),planScore:Number(item.planScore||0)});child.score=Number(item.simulation.championshipProbability)*1e6+Number(item.planScore||0);advanceCpu(task,child);next.push(child);expanded++}
    }
    const unique=new Map();for(const node of next){const key=signature(node);if(!unique.has(key)||unique.get(key).score<node.score)unique.set(key,node)}
    beam=[...unique.values()].sort((a,b)=>b.score-a.score||a.userPicks.map(p=>p.playerId).join("|").localeCompare(b.userPicks.map(p=>p.playerId).join("|"))).slice(0,task.beamWidth);
    if(!beam.length)throw new Error("Optimizer beam exhausted");
  }
  const finalists=beam.map(node=>{const report=buildDraftReport({state:stateFor(task,node),userSlot:task.userSlot,iterations:task.outcomeIterations,seed:task.scenarioSeed+100000});return{node,titleRank:report.userTeam.titleRank,titleChance:Number(report.userTeam.finishProbabilities[0]),rankHistogram:report.teamReports.map(team=>({slot:team.slot,titleRank:team.titleRank,titleChance:Number(team.finishProbabilities[0])}))}}).sort((a,b)=>a.titleRank-b.titleRank||b.titleChance-a.titleChance||a.node.userPicks.map(p=>p.playerId).join("|").localeCompare(b.node.userPicks.map(p=>p.playerId).join("|")));
  const best=finalists[0],leagueLeader=Math.max(...best.rankHistogram.map(team=>team.titleChance)),diagnosis=best.titleRank===1?{passed:true,issue:null,gapToFirst:0,nextAction:"No model change is justified by this synthetic draft."}:{passed:false,issue:"No evaluated roster path finished title-odds rank #1.",gapToFirst:leagueLeader-best.titleChance,nextAction:"Widen the deterministic beam and candidate branch, then rerun this fixed scenario seed before changing production weights."};return{schemaVersion:1,taskId:task.taskId,scenarioSeed:task.scenarioSeed,userSlot:task.userSlot,search:{beamWidth:task.beamWidth,branchFactor:task.branchFactor,pickIterations:task.pickIterations,outcomeIterations:task.outcomeIterations,expandedPaths:expanded,terminalPaths:finalists.length,claim:"Best title-odds result among evaluated deterministic beam paths; not a mathematical global optimum."},diagnosis,terminalAlternatives:finalists.slice(0,5).map(item=>({titleRank:item.titleRank,titleChance:item.titleChance,userPlayerIds:item.node.userPicks.map(pick=>pick.playerId)})),picks:best.node.picks,userPicks:best.node.userPicks,final:{titleRank:best.titleRank,titleChance:best.titleChance,rankHistogram:best.rankHistogram}};
}

function optimize(task){
  const passes=[];let passTask={...task};
  for(let attempt=0;attempt<=Number(task.adaptiveRetries||0);attempt++){const result=optimizePass(passTask);passes.push(result);if(result.final.titleRank===1)break;passTask={...passTask,beamWidth:Math.min(32,passTask.beamWidth*2),branchFactor:Math.min(8,passTask.branchFactor+2),pickIterations:Math.min(128,passTask.pickIterations*2)}}
  const best=[...passes].sort((a,b)=>a.final.titleRank-b.final.titleRank||b.final.titleChance-a.final.titleChance)[0];best.search.adaptivePasses=passes.map(pass=>({beamWidth:pass.search.beamWidth,branchFactor:pass.search.branchFactor,pickIterations:pass.search.pickIterations,titleRank:pass.final.titleRank,titleChance:pass.final.titleChance}));if(best.final.titleRank!==1)best.diagnosis.nextAction="The adaptive retry also missed title-odds rank #1; inspect the saved terminal alternatives before changing production weights.";return best
}

parentPort.on("message",task=>{try{parentPort.postMessage({ok:true,result:optimize(task)})}catch(error){parentPort.postMessage({ok:false,taskId:task.taskId,error:error.stack||error.message})}});
