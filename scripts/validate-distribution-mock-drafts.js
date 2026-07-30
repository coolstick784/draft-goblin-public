import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { evaluateDraft } from "../core/evaluate.js";
import { fixtureState, shaheedPick128OnClockState, shaheedPick128State } from "../test/fixture.js";
import { QUANTILE_V1_PROBABILITIES } from "../shared/player-distribution.js";

const residualShape=[-2.4,-1.75,-1.35,-.9,-.58,-.3,-.08,.2,.52,.9,1.38,1.8,2.5];
const spread={QB:38,RB:31,WR:32,TE:25,K:12,DST:12};
const attachDistributions=state=>{
  const clone=structuredClone(state),season=Number(clone.projectionSeason||2026);
  clone.projectionSeason=season;
  clone.modelVersion="mock-promoted-quantile-v1";
  clone.players=clone.players.map(player=>{
    if(!["QB","RB","WR","TE"].includes(player.position)||Number(player.mean)<=0)return player;
    const scale=(spread[player.position]||30)*(0.8+Number(player.risk||.3)*.5),values=residualShape.map(value=>Math.max(0,Number(player.mean)+value*scale));
    return{...player,distribution:{schemaVersion:"quantile-v1",unit:"season-fantasy-points",conditionedOn:"active-role",season,scoringFormat:"ppr",mean:Number(player.mean),quantiles:QUANTILE_V1_PROBABILITIES.map((p,index)=>({p,value:Number(values[index].toFixed(4))})),provenance:{modelId:"mock-validation",modelVersion:"mock-v1",calibrationId:"synthetic-invariant-only",generatedAt:"2026-07-14T12:00:00.000Z",forecastAsOf:"2026-07-14T11:55:00.000Z",trainedThrough:"2025-12-31T00:00:00.000Z",sourceSnapshotIds:["mock:deterministic"],estimationLevel:"position",fallbackReason:"Synthetic curve used only to exercise the promoted runtime."}}};
  });
  return clone;
};

const cases=[
  {name:"opening-round",state:fixtureState({teams:12,rounds:16,picked:0}),userSlot:7},
  {name:"middle-round",state:fixtureState({teams:12,rounds:16,picked:65}),userSlot:7},
  {name:"pick-128-preparation",state:shaheedPick128State(),userSlot:8},
  {name:"pick-128-on-clock",state:shaheedPick128OnClockState(),userSlot:8}
];

const rows=[];
for(const item of cases){
  const state=attachDistributions(item.state),input={state,userSlot:item.userSlot,iterations:300,limit:8,seed:2026},start=performance.now(),first=evaluateDraft(input),firstMs=performance.now()-start,replayStart=performance.now(),second=evaluateDraft(input),replayMs=performance.now()-replayStart;
  const signature=list=>list.map(row=>[row.player.id,row.simulation.rawProbability,row.simulation.championshipProbability]);
  const finite=first.length>0&&first.every(row=>Number.isFinite(row.simulation.championshipProbability)&&row.simulation.championshipProbability>=0&&row.simulation.championshipProbability<=1&&Number.isFinite(row.player.mean));
  rows.push({name:item.name,pickNo:state.picks.length+1,firstMs:Number(firstMs.toFixed(1)),cachedReplayMs:Number(replayMs.toFixed(1)),cards:first.length,top:first[0]?.player.name,deterministic:JSON.stringify(signature(first))===JSON.stringify(signature(second)),finite,withinQuickBudget:firstMs<5000&&replayMs<500});
}

const calibration=JSON.parse(fs.readFileSync(new URL("../data/research/player-weekly-distributions-quantile-v1.json",import.meta.url),"utf8"));
const researchGateCorrect=calibration.dataQuality?.promotionGatePassed===false&&calibration.status==="research-not-runtime-wired";
const shaheed=rows.find(row=>row.name==="pick-128-on-clock")?.top==="Rashid Shaheed";
const report={pass:rows.every(row=>row.deterministic&&row.finite&&row.withinQuickBudget)&&researchGateCorrect&&shaheed,researchGateCorrect,knownPick128WinnerPreserved:shaheed,rows};
console.log(JSON.stringify(report,null,2));
if(!report.pass)process.exitCode=1;
