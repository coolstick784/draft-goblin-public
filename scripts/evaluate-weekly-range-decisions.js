import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { fitWeeklyRangeModel, predictWeeklyRange } from "./backtest-weekly-player-ranges.js";
import { usableHistoricalRows } from "./backtest-player-performance-ranges.js";
import { loadWeeklyRangeDataset } from "./load-weekly-range-dataset.js";

const WEIGHT_GRID=[0,.1,.25,.5,.75,1,1.5,2,3];
const round=(value,digits=6)=>Number(Number(value).toFixed(digits));
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;
const quantile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);if(!sorted.length)return null;const at=(sorted.length-1)*p,lo=Math.floor(at),hi=Math.ceil(at),w=at-lo;return sorted[lo]*(1-w)+sorted[hi]*w};
const random=seed=>()=>{let t=seed+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296};

function buildChoices(rows,model,maxProjectionGap){
  const groups=new Map();
  for(const row of rows){const key=`${row.year}:${row.week}:${row.position}`,group=groups.get(key)||[];group.push(row);groups.set(key,group)}
  const choices=[];
  for(const [cluster,group] of groups){
    const ordered=[...group].sort((a,b)=>b.projected-a.projected||String(a.name).localeCompare(String(b.name)));
    for(let index=0;index+1<ordered.length;index+=2){
      const pair=ordered.slice(index,index+2);if(Math.abs(pair[0].projected-pair[1].projected)>maxProjectionGap)continue;
      choices.push({cluster,players:pair.map(row=>{const [p10,p50,p90]=predictWeeklyRange(row,model);return{row,p10,p50,p90}})});
    }
  }
  return choices;
}

function policyScore(player,context,weight){
  if(context==="stable")return player.p50-weight*(player.p50-player.p10);
  if(context==="upside")return player.p50+weight*(player.p90-player.p50);
  return player.p50;
}

function realizedUtility(actual,target,context){
  if(context==="stable")return actual-Math.max(0,target-actual);
  if(context==="upside")return actual+Math.max(0,actual-target);
  return actual;
}

function decisionsFor(choices,context,weight){return choices.map(choice=>{
  const baseline=[...choice.players].sort((a,b)=>b.row.projected-a.row.projected||String(a.row.name).localeCompare(String(b.row.name)))[0];
  const candidate=[...choice.players].sort((a,b)=>policyScore(b,context,weight)-policyScore(a,context,weight)||b.row.projected-a.row.projected||String(a.row.name).localeCompare(String(b.row.name)))[0];
  const target=mean(choice.players.map(player=>player.row.projected));
  return{cluster:choice.cluster,changed:candidate!==baseline,baselineActual:baseline.row.actual,candidateActual:candidate.row.actual,actualDelta:candidate.row.actual-baseline.row.actual,baselineUtility:realizedUtility(baseline.row.actual,target,context),candidateUtility:realizedUtility(candidate.row.actual,target,context),utilityDelta:realizedUtility(candidate.row.actual,target,context)-realizedUtility(baseline.row.actual,target,context),baselineBelowTarget:baseline.row.actual<target?1:0,candidateBelowTarget:candidate.row.actual<target?1:0,baselineAboveTarget:baseline.row.actual>target?1:0,candidateAboveTarget:candidate.row.actual>target?1:0};
})}

function summarize(decisions){
  const changed=decisions.filter(row=>row.changed),source=changed.length?changed:decisions;
  return{eligibleDecisions:decisions.length,changedDecisions:changed.length,changeRate:round(changed.length/Math.max(1,decisions.length)),baselineMeanActual:round(mean(decisions.map(row=>row.baselineActual))),candidateMeanActual:round(mean(decisions.map(row=>row.candidateActual))),meanActualDelta:round(mean(decisions.map(row=>row.actualDelta))),meanUtilityDelta:round(mean(decisions.map(row=>row.utilityDelta))),changedMeanActualDelta:round(mean(source.map(row=>row.actualDelta))),changedMeanUtilityDelta:round(mean(source.map(row=>row.utilityDelta))),baselineBelowTargetRate:round(mean(decisions.map(row=>row.baselineBelowTarget))),candidateBelowTargetRate:round(mean(decisions.map(row=>row.candidateBelowTarget))),baselineAboveTargetRate:round(mean(decisions.map(row=>row.baselineAboveTarget))),candidateAboveTargetRate:round(mean(decisions.map(row=>row.candidateAboveTarget)))};
}

function bootstrap(decisions,{draws,seed}){
  const groups=new Map();for(const row of decisions){const values=groups.get(row.cluster)||[];values.push(row);groups.set(row.cluster,values)}const clusters=[...groups.values()],rng=random(seed),actual=[],utility=[];
  for(let draw=0;draw<draws&&clusters.length;draw++){let actualSum=0,utilitySum=0,count=0;for(let index=0;index<clusters.length;index++){const sample=clusters[Math.floor(rng()*clusters.length)];for(const row of sample){actualSum+=row.actualDelta;utilitySum+=row.utilityDelta;count++}}actual.push(actualSum/count);utility.push(utilitySum/count)}
  const result=values=>({interval95:[round(quantile(values,.025)),round(quantile(values,.975))],probabilityPositive:round(values.filter(value=>value>0).length/Math.max(1,values.length))});
  return{clusters:clusters.length,draws,actualPoints:result(actual),contextUtility:result(utility)};
}

function selectPolicy(choices,context){
  const sweep=WEIGHT_GRID.map(weight=>{const decisions=decisionsFor(choices,context,weight),summary=summarize(decisions);return{weight,...summary}});
  // Utility is the tuning objective. Prefer more actual points, then less aggressive weights on exact ties.
  const selected=[...sweep].sort((a,b)=>b.meanUtilityDelta-a.meanUtilityDelta||b.meanActualDelta-a.meanActualDelta||a.weight-b.weight)[0];
  return{selectedWeight:selected.weight,sweep};
}

export function evaluateWeeklyRangeDecisions(inputRows,{generatedAt=new Date().toISOString(),validationYear=2023,holdoutYear=2024,maxProjectionGap=1.5,bootstrapDraws=2000,shrinkage=32,shrinkageByPosition=null}={}){
  const prepared=usableHistoricalRows(inputRows),activityAware=prepared.rows.some(row=>row.activityStatus),rows=activityAware?prepared.rows.filter(row=>row.activityStatus==="active-observed"):prepared.rows;
  const validationTraining=rows.filter(row=>row.year<validationYear),validation=rows.filter(row=>row.year===validationYear),validationModel=fitWeeklyRangeModel(validationTraining,{shrinkage,shrinkageByPosition}),validationChoices=buildChoices(validation,validationModel,maxProjectionGap);
  const holdoutTraining=rows.filter(row=>row.year<holdoutYear),holdout=rows.filter(row=>row.year===holdoutYear),holdoutModel=fitWeeklyRangeModel(holdoutTraining,{shrinkage,shrinkageByPosition}),holdoutChoices=buildChoices(holdout,holdoutModel,maxProjectionGap);
  const policies={};
  for(const [index,context] of ["stable","upside"].entries()){
    const selection=selectPolicy(validationChoices,context),validationDecisions=decisionsFor(validationChoices,context,selection.selectedWeight),holdoutDecisions=decisionsFor(holdoutChoices,context,selection.selectedWeight),validationSummary=summarize(validationDecisions),holdoutSummary=summarize(holdoutDecisions),uncertainty=bootstrap(holdoutDecisions,{draws:bootstrapDraws,seed:20260722+index});
    const gate=selection.selectedWeight>0&&validationSummary.meanUtilityDelta>0&&holdoutSummary.changedDecisions>=100&&uncertainty.contextUtility.interval95[0]>0&&uncertainty.actualPoints.interval95[0]>=-.05;
    policies[context]={objective:context==="stable"?"Maximize realized points with an equal penalty for points below the pair's pre-week projection midpoint.":"Maximize realized points with an equal bonus for points above the pair's pre-week projection midpoint.",selection:{year:validationYear,selectedWeight:selection.selectedWeight,sweep:selection.sweep,metrics:validationSummary},holdout:{year:holdoutYear,...holdoutSummary,clusterBootstrap:uncertainty},promotionGate:{nonzeroRiskWeight:selection.selectedWeight>0,validationUtilityImproved:validationSummary.meanUtilityDelta>0,minimumChangedDecisions:holdoutSummary.changedDecisions>=100,holdoutUtilityBootstrapAboveZero:uncertainty.contextUtility.interval95[0]>0,noMaterialMeanPointsHarm:uncertainty.actualPoints.interval95[0]>=-.05,passed:gate}};
  }
  const gate=Object.values(policies).every(policy=>policy.promotionGate.passed);
  return{schemaVersion:2,artifactId:`weekly-range-decision-policy:${validationYear}-${holdoutYear}`,generatedAt,status:gate?"accepted-research-signal":"research-only",decision:"Tune downside-averse and upside-seeking utilities on validation-year choices, then compare their frozen policies with the higher-projection baseline on an untouched holdout year.",warning:"This is an observational weekly start/sit shadow test. It does not model roster construction, replacement availability, opponent correlation, or season-long draft value.",leakageBoundary:`${validationYear} policies use ranges fit through ${validationYear-1}. Selected weights are frozen; ${holdoutYear} ranges are refit only on years before ${holdoutYear}, and ${holdoutYear} outcomes are used once for final evaluation.`,dataQuality:{activityAware,trainingRowsThroughValidation:validationTraining.length,validationRows:validation.length,trainingRowsThroughHoldout:holdoutTraining.length,holdoutRows:holdout.length,validationEligibleDecisions:validationChoices.length,holdoutEligibleDecisions:holdoutChoices.length,runtimePromotionGatePassed:false},configuration:{validationYear,holdoutYear,maxProjectionGap,weightGrid:WEIGHT_GRID,shrinkage,shrinkageByPosition},baseline:"Select the player with the higher pre-week point projection.",policies,promotionGate:{allContextsPass:Object.values(policies).every(policy=>policy.promotionGate.passed),passed:gate}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const input=process.argv[2]||"data/private/owned-model/weekly-range-rows.jsonl",weeklyPath=process.argv[3]||"data/research/weekly-player-range-backtest.json",output=process.argv[4]||"data/research/weekly-range-decision-shadow.json",weekly=JSON.parse(fs.readFileSync(weeklyPath,"utf8")),artifact=evaluateWeeklyRangeDecisions(loadWeeklyRangeDataset(input),{shrinkage:weekly.selection.selectedGlobalShrinkage,shrinkageByPosition:weekly.selection.selectedShrinkageByPosition});fs.writeFileSync(output,`${JSON.stringify(artifact,null,2)}\n`);console.log(JSON.stringify({input,output,status:artifact.status,dataQuality:artifact.dataQuality,policies:artifact.policies,promotionGate:artifact.promotionGate},null,2))}
