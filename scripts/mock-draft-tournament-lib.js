import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { evaluateDraft } from "../core/evaluate.js";
import { buildDraftReport } from "../core/post-draft-report.js";
import { rosterNeeds } from "../core/roster.js";
import { recommendationPositionCap } from "../core/recommend.js";
import { normalizeSettings, snakeSlot } from "../shared/domain.js";
import { promotedPlayerDistribution } from "../extension/player-distribution-enrichment.js";

const POSITIONS=new Set(["QB","RB","WR","TE","K","DST"]);
const FLEX=new Set(["RB","WR","TE"]);
const QUANTILES=[.01,.05,.10,.20,.30,.40,.50,.60,.70,.80,.90,.95,.99];
const SHAPE=[-2.35,-1.68,-1.28,-.82,-.51,-.25,0,.25,.51,.82,1.28,1.68,2.35];
const POSITION_SPREAD={QB:43,RB:38,WR:39,TE:31};

const hash=value=>{let out=2166136261;for(const character of String(value)){out^=character.charCodeAt(0);out=Math.imul(out,16777619)}return out>>>0};
const random01=value=>{let n=hash(value)+0x6D2B79F5;n=Math.imul(n^n>>>15,n|1);n^=n+Math.imul(n^n>>>7,n|61);return((n^n>>>14)>>>0)/4294967296};
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b),index=Math.min(sorted.length-1,Math.floor((sorted.length-1)*p));return sorted[index]??0};

export function syntheticPromotedDistributionModel({season=2026}={}){
  const positions={};
  for(const [position,spread] of Object.entries(POSITION_SPREAD))positions[position]={estimationLevel:"position",residualQuantiles:SHAPE.map(value=>Number((value*spread).toFixed(4)))};
  return{schemaVersion:"quantile-v1",runtimeStatus:"promoted",unit:"season-residual-fantasy-points",season,modelId:"mock-draft-tournament-quantiles",modelVersion:"synthetic-validation-v1",calibrationId:"synthetic-runtime-exercise-only",generatedAt:"2026-07-14T12:00:00.000Z",forecastAsOf:"2026-07-14T11:55:00.000Z",trainedThrough:"2025-12-31T00:00:00.000Z",sourceSnapshotIds:["sleeper:2026:all-formats:local-snapshot"],scoringFormats:{standard:{positions},"half-ppr":{positions},ppr:{positions}}};
}

export function loadMockDraftPlayers({sourceUrl=new URL("../data/generated/sleeper-current-projections.json",import.meta.url),season=2026,scoringFormat="ppr"}={}){
  const rows=JSON.parse(fs.readFileSync(sourceUrl,"utf8")),model=syntheticPromotedDistributionModel({season});
  return rows.map(row=>{
    const pointsKey=scoringFormat==="standard"?"pts_std":scoringFormat==="half-ppr"?"pts_half_ppr":"pts_ppr",adpKey=scoringFormat==="standard"?"adp_std":scoringFormat==="half-ppr"?"adp_half_ppr":"adp_ppr",rawPosition=String(row.player?.position||"").toUpperCase(),position=rawPosition==="DEF"?"DST":rawPosition,mean=Number(row.stats?.[pointsKey]),rawAdp=Number(row.stats?.[adpKey]),team=String(row.player?.team||"").toUpperCase();
    if(!POSITIONS.has(position)||!team||team==="FA"||!(mean>0))return null;
    const risk=String(row.player?.injury_status||"").toLowerCase()==="out"?.95:row.player?.injury_status?.length?.78:.38,player={id:String(row.player_id),name:`${row.player.first_name||""} ${row.player.last_name||""}`.trim(),position,team,mean,risk,performanceRisk:risk,scarcity:["RB","TE"].includes(position)?.62:.38,adp:Number.isFinite(rawAdp)&&rawAdp>0&&rawAdp<900?rawAdp:null,adpSd:12,adpSeason:season,adpTeams:12,adpScoring:scoringFormat,adpProvider:"sleeper",eligibleForRecommendation:true},distribution=promotedPlayerDistribution({model,player,mean,season,scoringFormat}),p10=distribution?.quantiles.find(item=>item.p===.10)?.value,p90=distribution?.quantiles.find(item=>item.p===.90)?.value;
    return{...player,floor:Number.isFinite(p10)?p10:mean*(1-risk*.55),ceiling:Number.isFinite(p90)?p90:mean*(1.25+risk*.35),...(distribution?{distribution}:{})};
  }).filter(Boolean).sort((a,b)=>Number(a.adp??9999)-Number(b.adp??9999)||b.mean-a.mean||a.id.localeCompare(b.id));
}

export function defaultMockSettings({teams=12,rounds=16,scoringFormat="ppr"}={}){const reception=scoringFormat==="standard"?0:scoringFormat==="half-ppr"?.5:1;return normalizeSettings({teams,rounds,playoffTeams:Math.max(2,Math.floor(teams/2)),slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:Math.max(0,rounds-9)},scoring:{reception}})}

const teamRoster=(state,slot,byId)=>state.picks.filter(pick=>pick.slot===slot).map(pick=>byId.get(String(pick.playerId))).filter(Boolean);
const missingCount=needs=>["QB","RB","WR","TE","K","DST","FLEX"].reduce((sum,position)=>sum+Number(needs[position]||0),0);

export function realisticAdpBotPick({state,slot,seed=2026}){
  const drafted=new Set(state.picks.map(pick=>String(pick.playerId))),byId=new Map(state.players.map(player=>[String(player.id),player])),roster=teamRoster(state,slot,byId),counts=roster.reduce((out,player)=>((out[player.position]=(out[player.position]||0)+1),out),{}),needs=rosterNeeds(roster,state.settings.slots),round=Math.ceil((state.picks.length+1)/state.settings.teams),remaining=state.settings.rounds-roster.length,completionRequired=missingCount(needs)>=remaining;
  const candidates=state.players.filter(player=>!drafted.has(String(player.id))&&player.eligibleForRecommendation!==false&&(counts[player.position]||0)<recommendationPositionCap(player.position,state.settings)&&(!completionRequired||Number(needs[player.position]||0)>0||Number(needs.FLEX||0)>0&&FLEX.has(player.position))&&(!["K","DST"].includes(player.position)||round>=Math.max(13,state.settings.rounds-2)||completionRequired));
  if(!candidates.length)return state.players.find(player=>!drafted.has(String(player.id)))||null;
  const personality=(random01(`${seed}:personality:${slot}`)-.5)*.20;
  return candidates.map(player=>{
    const adp=Number(player.adp??999),noise=(random01(`${seed}:${state.picks.length+1}:${slot}:${player.id}`)-.5)*Math.min(20,6+round*.7),starterNeed=Number(needs[player.position]||0)>0,flexNeed=FLEX.has(player.position)&&Number(needs.FLEX||0)>0,needBonus=starterNeed?Math.min(18,7+round*.8):flexNeed?5:0,projectionRankPenalty=Math.max(-8,Math.min(8,(250-Number(player.mean||0))/30))*personality;
    return{player,boardScore:adp+noise-needBonus+projectionRankPenalty};
  }).sort((a,b)=>a.boardScore-b.boardScore||Number(b.player.mean)-Number(a.player.mean)||a.player.id.localeCompare(b.player.id))[0].player;
}

const stateFor=({draftId,settings,players,picks})=>({platform:"fixture",draftId,projectionSeason:2026,dataQuality:"synthetic-runtime-validation",modelVersion:"mock-promoted-quantile-v1",settings,players,picks,updatedAt:Date.now()});

export function runMockDraft({userSlot,players=loadMockDraftPlayers(),settings=defaultMockSettings(),seed=2026,pickIterations=180,reportIterations=1200,pickBudgetMs=5000,draftBudgetMs=90000,strategy="titleOnly",sourceProfile="projectionLed"}={}){
  const picks=[],userPicks=[],decisionTimes=[],draftId=`quantile-mock-${settings.teams}-${userSlot}-${seed}`,started=performance.now();
  while(picks.length<settings.teams*settings.rounds){
    const pickNo=picks.length+1,slot=snakeSlot(pickNo,settings.teams),state=stateFor({draftId,settings,players,picks});
    if(slot!==userSlot){const player=realisticAdpBotPick({state,slot,seed});if(!player)throw new Error(`ADP bot had no legal player at pick ${pickNo}`);picks.push({pickNo,playerId:player.id,slot,actor:"adp-bot"});continue}
    const decisionStarted=performance.now(),[choice]=evaluateDraft({state,userSlot,strategy,sourceProfile,limit:8,iterations:pickIterations,seed:hash(`${seed}:model:${pickNo}`)}),decisionMs=performance.now()-decisionStarted;
    if(!choice)throw new Error(`Model had no recommendation at pick ${pickNo}`);
    decisionTimes.push(decisionMs);userPicks.push({pickNo,playerId:choice.player.id,name:choice.player.name,position:choice.player.position,decisionMs:Number(decisionMs.toFixed(1)),titleChanceAtDecision:Number(choice.simulation.championshipProbability)});picks.push({pickNo,playerId:choice.player.id,slot,actor:"model"});
  }
  const completedState=stateFor({draftId,settings,players,picks}),reportStarted=performance.now(),report=buildDraftReport({state:completedState,userSlot,iterations:reportIterations,seed:hash(`${seed}:report`)}),reportMs=performance.now()-reportStarted,totalMs=performance.now()-started,maxDecisionMs=Math.max(...decisionTimes,0),p95DecisionMs=percentile(decisionTimes,.95),roster=report.userTeam.draft;
  return{userSlot,seed,strategy,sourceProfile,totalPicks:picks.length,userPicks,roster,report,metrics:{pickIterations,reportIterations,maxDecisionMs:Number(maxDecisionMs.toFixed(1)),p95DecisionMs:Number(p95DecisionMs.toFixed(1)),reportMs:Number(reportMs.toFixed(1)),totalMs:Number(totalMs.toFixed(1)),pickBudgetMs,draftBudgetMs},checks:{complete:picks.length===settings.teams*settings.rounds&&roster.length===settings.rounds,quantileCoverage:roster.filter(row=>players.find(player=>player.id===row.playerId)?.distribution).length,titleRankFirst:report.userTeam.titleRank===1,highestModeledTitleChance:report.userTeam.finishProbabilities[0]===Math.max(...report.teamReports.map(team=>team.finishProbabilities[0])),onTime:maxDecisionMs<pickBudgetMs&&totalMs<draftBudgetMs}};
}

export function runMockDraftTournament({slots=[1,6,12],seeds=[9101,9206,9312],players=loadMockDraftPlayers(),settings=defaultMockSettings(),pickIterations=180,reportIterations=1200}={}){
  const drafts=slots.map((userSlot,index)=>runMockDraft({userSlot,players,settings,seed:seeds[index]??seeds[0]+index,pickIterations,reportIterations})),pass=drafts.every(draft=>Object.values(draft.checks).every(value=>value===true||Number.isInteger(value)&&value>0));
  return{schemaVersion:1,kind:"causal deterministic mock-draft tournament",warning:"Synthetic promoted quantiles validate wiring and decision behavior; these results are not evidence of real-world forecast accuracy or a guarantee of winning a stochastic fantasy season.",settings:{teams:settings.teams,rounds:settings.rounds,slots:settings.slots},pickPolicy:"At every user turn, select the model's top title-only recommendation using only picks already visible. Opponents use seeded ADP boards with roster constraints, team preferences, and pick-level variation.",slots,seeds,drafts,pass};
}
