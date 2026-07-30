import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { evaluateDraft } from "../core/evaluate.js";
import { buildPlayerIdentityIndex, matchPlayerIdentity } from "../extension/player-identity.js";
import { projectionConsensus } from "../extension/projection-consensus.js";
import { unpromotedPerformanceRange } from "../extension/player-distribution-enrichment.js";
import { normalizeSettings } from "../shared/domain.js";

const espn=JSON.parse(fs.readFileSync(new URL("../data/snapshots/espn-2026-PPR-2026-07-13.json",import.meta.url)));
const sleeperRows=JSON.parse(fs.readFileSync(new URL("../data/generated/sleeper-current-projections.json",import.meta.url)));
const fantasyPros=JSON.parse(fs.readFileSync(new URL("../data/snapshots/fantasypros-2026-PPR-2026-07-13T16-24-54-766Z.json",import.meta.url)));
const baseline=JSON.parse(fs.readFileSync(new URL("../data/generated/current-baseline.json",import.meta.url)));

const sleeper=sleeperRows
  .filter(row=>row.player?.position&&row.player?.team)
  .map(row=>({
    id:String(row.player_id),
    name:`${row.player.first_name||""} ${row.player.last_name||""}`.trim(),
    position:row.player.position==="DEF"?"DST":row.player.position,
    team:row.player.team,
    points:Number(row.stats?.pts_ppr||0),
    injuryStatus:row.player.injury_status
  }));
const sleeperIndex=buildPlayerIdentityIndex(sleeper);
const fantasyProsPlayers=fantasyPros.players||[];
const fantasyProsIndex=buildPlayerIdentityIndex(fantasyProsPlayers);
const baselinePlayers=baseline.players||[];
const baselineIndex=buildPlayerIdentityIndex(baselinePlayers);

export function buildEspnState(input){
  // Historical decision replays need the completed board's projection rows for
  // enrichment without marking future selections as already drafted.
  const projectionRows=input.projectionRows||input.picks||[],liveRows=[...espn.players,...projectionRows.filter(row=>Number(row.platformPoints)>0).map(row=>({id:`board-${row.pickNo}`,name:row.name,position:row.position,team:row.team,points:row.platformPoints,rank:row.rank}))],liveIndex=buildPlayerIdentityIndex(liveRows);
  const players=baselinePlayers.filter(row=>["QB","RB","WR","TE","K","DST"].includes(String(row.position).replace("D/ST","DST"))).map((base,index)=>{
    const source={...base,id:String(base.id),name:base.name,position:String(base.position).replace("D/ST","DST"),team:base.team},live=matchPlayerIdentity(liveIndex,source),sp=matchPlayerIdentity(sleeperIndex,source),fp=matchPlayerIdentity(fantasyProsIndex,source);
    const consensus=projectionConsensus({
      season:2026,
      platform:"espn",
      platformProjection:Number(live?.points||0),
      sources:{
        ...(sp?.points>0?{sleeper:{points:sp.points,season:2026,kind:"cross-platform-draft-site"}}:{}),
        ...(Number(fp?.points)>0?{fantasyPros:{points:Number(fp.points),season:2026,kind:"public-html"}}:{})
      }
    });
    const mean=Number(consensus.points||live?.points||sp?.points||base.mean||0),range=unpromotedPerformanceRange(mean,base.position),performanceRisk=range.performanceRisk,risk=Math.max(performanceRisk,sp?.injuryStatus?.8:0);
    return{
      ...source,mean,floor:range.floor,ceiling:range.ceiling,risk,performanceRisk,performanceRiskSource:range.source,historicalProjectionRisk:Number(base.risk??0),
      scarcity:Number(base.scarcity??(["RB","TE"].includes(source.position)?.6:.35)),
      adp:Number(live?.rank||base.adp||index+1),adpSd:Number(base.adpSd)||null,adpSdSource:live?.rank?"rank-calibrated":base.adpSdSource,adpSeason:2026,
      adpTeams:Number(input.teams||12),adpScoring:"ppr",adpProvider:"espn",
      projectionSeason:2026,projectionConsensus:consensus,platformProjection:Number(live?.points||0),eligibleForRecommendation:mean>0
    };
  });
  const playerIndex=buildPlayerIdentityIndex(players);
  const picks=(input.picks||[]).map(pick=>{
    const player=matchPlayerIdentity(playerIndex,pick);
    if(player)return{pickNo:Number(pick.pickNo),playerId:player.id,slot:Number(pick.slot),name:player.name};
    const id=`unmapped-${pick.pickNo}`;
    const mean=Number(pick.platformPoints||0),risk=mean>0?.5:1;
    players.push({id,name:pick.name,position:String(pick.position||"NA").replace("D/ST","DST"),team:pick.team||"",mean,floor:mean*(1-risk*.55),ceiling:mean*(1.25+risk*.35),risk,scarcity:0,adp:Number(pick.rank)||null,platformProjection:mean,projectionSeason:2026,eligibleForRecommendation:false});
    return{pickNo:Number(pick.pickNo),playerId:id,slot:Number(pick.slot),name:pick.name};
  });
  const settings=normalizeSettings({teams:Number(input.teams||12),rounds:Number(input.rounds||16),playoffTeams:Number(input.playoffTeams||6),slots:input.slots||{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:7},positionLimits:input.positionLimits||{},scoring:input.scoring||{reception:1}});
  return{platform:"espn",draftId:String(input.draftId||"live"),projectionSeason:2026,settings,picks,players,updatedAt:Date.now()};
}

export function recommendLiveEspn(input){
  const state=buildEspnState(input),recommendations=evaluateDraft({state,userSlot:Number(input.userSlot),strategy:input.strategy||"titleOnly",sourceProfile:"projectionLed",iterations:Number(input.iterations||300),seed:2026}).slice(0,8);
  return{pickNo:state.picks.length+1,userSlot:Number(input.userSlot),recommendations:recommendations.map((item,index)=>({rank:index+1,id:item.player.id,name:item.player.name,position:item.player.position,team:item.player.team,projectedPoints:Number(item.player.mean.toFixed(1)),titleChance:item.simulation.championshipProbability,planScore:item.planScore,nextPickAvailability:item.nextPickAvailability}))};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const inputPath=process.argv[2]||"data/generated/live-espn-input.json",input=JSON.parse(fs.readFileSync(inputPath,"utf8"));
  console.log(JSON.stringify(recommendLiveEspn(input),null,2));
}
