import fs from "node:fs";
import {pathToFileURL} from "node:url";
import {fitSeasonRatioModel} from "./backtest-weekly-to-season-distributions.js";
import {loadWeeklyRangeDataset} from "./load-weekly-range-dataset.js";
import {usableHistoricalRows} from "./backtest-player-performance-ranges.js";

const probabilities=[.1,.5,.9],round=(value,digits=6)=>Number(Number(value).toFixed(digits));
const weightedQuantile=(items,p)=>{const sorted=[...items].sort((a,b)=>a.value-b.value),total=sorted.reduce((sum,item)=>sum+item.weight,0),target=p*total;let cumulative=0;for(const item of sorted){cumulative+=item.weight;if(cumulative>=target)return item.value}return sorted.at(-1)?.value??1};
const scoringRows=(rows,format)=>format==="half-ppr"?rows:rows.filter(row=>Number(row.projectedStandard)>0&&Number.isFinite(Number(row.nflverseStandardActual))).map(row=>({...row,projected:Number(row.projectedStandard),actual:Number(row.nflverseStandardActual)}));

export function buildPlayerSeasonDistributionRuntime(rows,research,{generatedAt=new Date().toISOString(),season=2026}={}){
  const prepared=usableHistoricalRows(rows).rows.filter(row=>row.activityStatus==="active-observed"),formats={"half-ppr":{selection:research.selection,gate:research.status==="accepted-research-signal"},standard:{selection:research.scoringFormats?.standard?.selection,gate:research.scoringFormats?.standard?.promotionGatePassed===true}},scoringFormats={};
  for(const[format,entry]of Object.entries(formats)){
    if(!entry.gate||!entry.selection)continue;
    const selection=entry.selection,local=scoringRows(prepared,format),playerShrinkage=Number(selection.selectedPlayerShrinkage??selection.playerShrinkage),recencyDecay=Number(selection.selectedRecencyDecay??selection.recencyDecay),personalizedPositions=selection.personalizedPositions||[],model=fitSeasonRatioModel(local,{playerShrinkage,recencyDecay}),positions={};
    for(const[position,bounds]of Object.entries(model.bounds)){
      const names=["low","middle","high"],maximums=[bounds[0],bounds[1],null],buckets=names.map((name,index)=>{const pool=model.cells.get(`${position}:${name}`)||model.positionPools.get(position)||[],items=pool.map(row=>({value:row.ratio,weight:row.weight??1})),weight=items.reduce((sum,item)=>sum+item.weight,0),meanRatio=pool.reduce((sum,row)=>sum+row.ratio*(row.weight??1),0)/Math.max(1,weight);return{maxMean:maximums[index],ratioQuantiles:probabilities.map(probability=>round(weightedQuantile(items,probability))),meanRatio:round(meanRatio),rows:pool.length,estimationLevel:"position-volume-tier"}});positions[position]={estimationLevel:"position-volume-tier",personalized:personalizedPositions.includes(position),buckets};
    }
    const players=Object.fromEntries([...model.players].filter(([key])=>personalizedPositions.some(position=>key.endsWith(`:${position}`))).map(([key,history])=>[key,{observedProjected:round(history.reduce((sum,row)=>sum+row.projected*(row.weight??1),0)),observedActual:round(history.reduce((sum,row)=>sum+row.actual*(row.weight??1),0)),seasons:history.length}]));
    scoringFormats[format]={playerShrinkage,recencyDecay,personalizedPositions,positions,players};
  }
  const promoted=Object.keys(scoringFormats).length>0;
  return{schemaVersion:"quantile-v1",runtimeStatus:promoted?"promoted":"research-only",unit:"season-performance-ratio",season,modelId:"player-season-ratio-empirical-bayes",modelVersion:"2021-2024-rolling-v1",calibrationId:research.artifactId,generatedAt,forecastAsOf:generatedAt,trainedThrough:"2024-12-31T23:59:59.000Z",sourceSnapshotIds:["hvpkod:weekly-projections:2021-2024","nflverse:weekly-rosters-and-stats:2021-2024"],conditionedOn:"active-role",availabilityModel:"availability-calibration-2026",dataQuality:{promotionGatePassed:promoted,supportedScoringFormats:Object.keys(scoringFormats),unsupportedScoringFormats:["standard","half-ppr","ppr"].filter(format=>!scoringFormats[format]),rookiePolicy:"No unvalidated rookie multiplier is applied; rookies use the promoted position-volume baseline."},scoringFormats};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const input=process.argv[2]||"data/private/owned-model/weekly-range-rows.jsonl",researchPath=process.argv[3]||"data/research/weekly-to-season-distribution-backtest.json",output=process.argv[4]||"data/research/player-season-distribution-runtime.json",artifact=buildPlayerSeasonDistributionRuntime(loadWeeklyRangeDataset(input),JSON.parse(fs.readFileSync(researchPath,"utf8")));fs.writeFileSync(output,`${JSON.stringify(artifact,null,2)}\n`);console.log(JSON.stringify({output,runtimeStatus:artifact.runtimeStatus,dataQuality:artifact.dataQuality,formats:Object.fromEntries(Object.entries(artifact.scoringFormats).map(([format,value])=>[format,{personalizedPositions:value.personalizedPositions,players:Object.keys(value.players).length}]))},null,2))}
