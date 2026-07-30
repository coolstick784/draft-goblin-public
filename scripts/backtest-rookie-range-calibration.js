import fs from "node:fs";
import {pathToFileURL} from "node:url";
import {loadWeeklyRangeDataset} from "./load-weekly-range-dataset.js";
import {usableHistoricalRows} from "./backtest-player-performance-ranges.js";

const POSITIONS=["QB","RB","WR","TE","K"];
const MULTIPLIERS=Array.from({length:29},(_,index)=>Number((.6+index*.05).toFixed(2)));
const ASYMMETRIC_MULTIPLIERS=Array.from({length:13},(_,index)=>Number((.8+index*.05).toFixed(2)));
const POSITION_PSEUDO_CLUSTERS=24;
const round=(value,digits=6)=>value==null?null:Number(Number(value).toFixed(digits));
const quantile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);if(!sorted.length)return 0;const at=(sorted.length-1)*p,lo=Math.floor(at),hi=Math.ceil(at);return sorted[lo]+(sorted[hi]-sorted[lo])*(at-lo)};
const playerKey=row=>String(row.playerId||`${row.name}:${row.position}`);
const tier=(projected,bounds)=>projected<=bounds[0]?"low":projected<=bounds[1]?"middle":"high";

function fitBaseline(rows){
  const bounds={},quantiles={};
  for(const position of POSITIONS){
    const positionRows=rows.filter(row=>row.position===position);
    if(!positionRows.length)continue;
    bounds[position]=[quantile(positionRows.map(row=>row.projected),1/3),quantile(positionRows.map(row=>row.projected),2/3)];
    const positionResiduals=positionRows.map(row=>row.actual-row.projected),positionQ=[quantile(positionResiduals,.1),quantile(positionResiduals,.5),quantile(positionResiduals,.9)];
    for(const bucket of["low","middle","high"]){
      const local=positionRows.filter(row=>tier(row.projected,bounds[position])===bucket),weight=local.length/(local.length+64),residuals=local.map(row=>row.actual-row.projected);
      const localQ=residuals.length?[quantile(residuals,.1),quantile(residuals,.5),quantile(residuals,.9)]:positionQ;
      quantiles[`${position}:${bucket}`]=localQ.map((value,index)=>weight*value+(1-weight)*positionQ[index]);
    }
  }
  return{bounds,quantiles};
}

function predict(row,model,lowerMultiplier,upperMultiplier=lowerMultiplier){
  const bounds=model.bounds[row.position],residuals=model.quantiles[`${row.position}:${bounds?tier(row.projected,bounds):"middle"}`]||[0,0,0];
  return[Math.max(0,row.projected+residuals[0]*lowerMultiplier),Math.max(0,row.projected+residuals[1]),Math.max(0,row.projected+residuals[2]*upperMultiplier)];
}
function intervalScore(actual,lower,upper){return upper-lower+(actual<lower?10*(lower-actual):0)+(actual>upper?10*(actual-upper):0)}
function score(row,prediction){const[lower,median,upper]=prediction;return{wis:(.5*Math.abs(row.actual-median)+.1*intervalScore(row.actual,lower,upper))/.6,covered:row.actual>=lower&&row.actual<=upper,width:upper-lower,lowerMiss:row.actual<lower,upperMiss:row.actual>upper}}
function policyMultiplier(policy,row){return policy.byPosition?.[row.position]??policy.multiplier??1}
function tailMultipliers(policy,row){const shared=policyMultiplier(policy,row);return[policy.lowerMultiplier??shared,policy.upperMultiplier??shared]}

export function evaluateRookiePolicy(trainingRows,testRows,policy){
  const model=fitBaseline(trainingRows),items=testRows.filter(row=>row.rookie===true&&row.activityStatus==="active-observed").map(row=>{const[lower,upper]=tailMultipliers(policy,row);return{row,score:score(row,predict(row,model,lower,upper))}});
  const summarize=subset=>{const n=subset.length,total=key=>subset.reduce((sum,item)=>sum+Number(item.score[key]),0);return{rows:n,players:new Set(subset.map(item=>playerKey(item.row))).size,meanWis:n?round(total("wis")/n):null,coverage:n?round(total("covered")/n):null,meanWidth:n?round(total("width")/n):null,lowerMissRate:n?round(total("lowerMiss")/n):null,upperMissRate:n?round(total("upperMiss")/n):null}};
  return{...summarize(items),byPosition:Object.fromEntries(POSITIONS.filter(position=>items.some(item=>item.row.position===position)).map(position=>[position,summarize(items.filter(item=>item.row.position===position))])),_items:items};
}

function tune(trainingRows,validationRows){
  const globalSweep=MULTIPLIERS.map(multiplier=>({multiplier,metrics:evaluateRookiePolicy(trainingRows,validationRows,{multiplier})})).sort((a,b)=>a.metrics.meanWis-b.metrics.meanWis),global=globalSweep[0].multiplier,byPosition={},positionEvidence={};
  for(const position of POSITIONS){
    const candidates=globalSweep.filter(item=>item.metrics.byPosition[position]?.rows);
    if(!candidates.length)continue;
    const raw=[...candidates].sort((a,b)=>a.metrics.byPosition[position].meanWis-b.metrics.byPosition[position].meanWis)[0].multiplier,rows=validationRows.filter(row=>row.rookie===true&&row.activityStatus==="active-observed"&&row.position===position),clusters=new Set(rows.map(row=>`${row.year}:${playerKey(row)}`)).size,weight=clusters/(clusters+POSITION_PSEUDO_CLUSTERS),selected=Math.exp((1-weight)*Math.log(global)+weight*Math.log(raw));
    byPosition[position]=round(selected,3);positionEvidence[position]={rawBest:raw,rookiePlayerSeasonClusters:clusters,evidenceWeight:round(weight),partiallyPooled:byPosition[position]};
  }
  const asymmetricSweep=ASYMMETRIC_MULTIPLIERS.flatMap(lowerMultiplier=>ASYMMETRIC_MULTIPLIERS.map(upperMultiplier=>{const policy={name:"selected-asymmetric",lowerMultiplier,upperMultiplier};return{policy,metrics:evaluateRookiePolicy(trainingRows,validationRows,policy)}})).sort((a,b)=>a.metrics.meanWis-b.metrics.meanWis),asymmetric=asymmetricSweep[0].policy;
  const policies=[{name:"no-rookie-adjustment",multiplier:1},{name:"fixed-1.20",multiplier:1.2},{name:"selected-global",multiplier:global},asymmetric,{name:"partially-pooled-position",byPosition}],evaluated=policies.map(policy=>({policy,metrics:evaluateRookiePolicy(trainingRows,validationRows,policy)})).sort((a,b)=>a.metrics.meanWis-b.metrics.meanWis);
  return{selected:evaluated[0].policy,global,asymmetric,byPosition,positionEvidence,policyComparison:evaluated.map(({policy,metrics})=>({policy,metrics:clean(metrics)})),globalSweep:globalSweep.map(({multiplier,metrics})=>({multiplier,meanWis:metrics.meanWis,coverage:metrics.coverage,meanWidth:metrics.meanWidth}))};
}
function clean(metrics){const{_items,...value}=metrics;return value}
function deltaSummary(base,candidate){return{meanWisImprovement:round((base.meanWis-candidate.meanWis)/base.meanWis),coverageChange:round(candidate.coverage-base.coverage),widthChange:round((candidate.meanWidth-base.meanWidth)/base.meanWidth)}}
function mulberry32(seed){return()=>{let t=seed+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}
function bootstrap(base,candidate,{draws=4000,seed=20260722}={}){const groups=new Map();base._items.forEach((item,index)=>{const key=`${item.row.year}:${playerKey(item.row)}`,values=groups.get(key)||[];values.push(item.score.wis-candidate._items[index].score.wis);groups.set(key,values)});const clusters=[...groups.values()],random=mulberry32(seed),samples=[];for(let draw=0;draw<draws;draw++){let sum=0,n=0;for(let i=0;i<clusters.length;i++){const sampled=clusters[Math.floor(random()*clusters.length)];sum+=sampled.reduce((a,b)=>a+b,0);n+=sampled.length}samples.push(sum/n)}return{clusters:clusters.length,draws,meanWisReduction:round(samples.reduce((a,b)=>a+b,0)/samples.length),interval95:[round(quantile(samples,.025)),round(quantile(samples,.975))],probabilityBetter:round(samples.filter(value=>value>0).length/draws)}}

function fold(rows,tuningYear,testYear,bootstrapDraws){
  const tuningTraining=rows.filter(row=>row.year<tuningYear),tuning=rows.filter(row=>row.year===tuningYear),selection=tune(tuningTraining,tuning),testTraining=rows.filter(row=>row.year<testYear),test=rows.filter(row=>row.year===testYear),baseline=evaluateRookiePolicy(testTraining,test,{multiplier:1}),fixed=evaluateRookiePolicy(testTraining,test,{multiplier:1.2}),selectedGlobal=evaluateRookiePolicy(testTraining,test,{multiplier:selection.global}),candidate=evaluateRookiePolicy(testTraining,test,selection.selected);
  return{tuningYear,testYear,selection,baseline:clean(baseline),fixed120:clean(fixed),selectedGlobal:clean(selectedGlobal),candidate:clean(candidate),fixed120VsBaseline:deltaSummary(baseline,fixed),candidateVsBaseline:deltaSummary(baseline,candidate),candidateVsFixed120:deltaSummary(fixed,candidate),candidateVsSelectedGlobal:deltaSummary(selectedGlobal,candidate),clusterBootstrapFixed120VsBaseline:bootstrap(baseline,fixed,{draws:bootstrapDraws,seed:20260222+testYear}),clusterBootstrapVsBaseline:bootstrap(baseline,candidate,{draws:bootstrapDraws,seed:20260722+testYear}),clusterBootstrapVsFixed120:bootstrap(fixed,candidate,{draws:bootstrapDraws,seed:20261722+testYear}),clusterBootstrapVsSelectedGlobal:bootstrap(selectedGlobal,candidate,{draws:bootstrapDraws,seed:20262722+testYear})};
}

export function backtestRookieRangeCalibration(inputRows,{generatedAt=new Date().toISOString(),bootstrapDraws=4000}={}){
  const prepared=usableHistoricalRows(inputRows),rows=prepared.rows.filter(row=>row.activityStatus==="active-observed"&&typeof row.rookie==="boolean"),folds=[fold(rows,2022,2023,bootstrapDraws),fold(rows,2023,2024,bootstrapDraws)],holdout=folds[1],fixedSupported=holdout.fixed120VsBaseline.meanWisImprovement>0&&holdout.clusterBootstrapFixed120VsBaseline.interval95[0]>0,candidateSupported=holdout.candidateVsBaseline.meanWisImprovement>0&&holdout.clusterBootstrapVsBaseline.interval95[0]>0,complexitySupported=holdout.candidateVsSelectedGlobal.meanWisImprovement>0&&holdout.clusterBootstrapVsSelectedGlobal.interval95[0]>0;
  const positionConsistency=Object.fromEntries(POSITIONS.map(position=>[position,{selectedByFold:folds.map(item=>item.selection.byPosition[position]??null),testRows:folds.map(item=>item.candidate.byPosition[position]?.rows??0),testWisImprovement:folds.map(item=>{const base=item.baseline.byPosition[position],candidate=item.candidate.byPosition[position];return base&&candidate?round((base.meanWis-candidate.meanWis)/base.meanWis):null})}]));
  return{schemaVersion:1,artifactId:"rookie-range-calibration:2021-2024",generatedAt,status:candidateSupported?"holdout-supported":"research-only",target:"Weekly P10/P50/P90 scoring uncertainty for true rookies conditional on an active-observed roster/stat record and a positive pre-week projection.",method:"Nested rolling-origin multiplier calibration. Each test season uses a policy selected on the immediately prior season from a baseline fitted only on still-earlier seasons. The test baseline is then refit on every earlier season. Candidates include a shared multiplier, separate downside/upside multipliers, and position optima geometrically shrunk toward the global optimum using rookie player-season counts. P50 is unchanged.",leakageBoundary:"2022 selects the 2023 policy using a 2021 baseline; 2023 selects the untouched 2024 policy using a 2021-2022 baseline. No test-season outcome selects its own multiplier. Player-season cluster bootstrap preserves repeated weekly observations.",runtimeBoundary:"This calibrates active-role weekly scoring ranges only. It must be combined with a separate availability probability and a validated weekly-to-season dependence model before use as a season distribution.",dataQuality:{inputRows:inputRows.length,usableActiveRows:rows.length,trueRookieRows:rows.filter(row=>row.rookie).length,excludedUnknownRookieOrActivity:prepared.rows.length-rows.length,incompleteYearsExcluded:[2025]},candidatePolicy:{...holdout.selection.selected,selectedGlobal:holdout.selection.global,selectedAsymmetric:holdout.selection.asymmetric,positionAlternatives:holdout.selection.byPosition,positionPseudoClusters:POSITION_PSEUDO_CLUSTERS},recommendedWeeklyPolicy:complexitySupported?holdout.selection.selected:{name:"selected-global",multiplier:holdout.selection.global,reason:"The more complex selected policy did not beat the global multiplier with a positive player-season bootstrap lower bound."},fixed120Assessment:{holdoutVsNoAdjustment:holdout.fixed120VsBaseline,clusterBootstrapVsNoAdjustment:holdout.clusterBootstrapFixed120VsBaseline,supportedOnHoldout:fixedSupported,warning:"A positive point estimate alone is not sufficient evidence that exactly 1.20 is optimal."},promotionGate:{candidateBeatsNoAdjustmentWithPositiveBootstrapLowerBound:candidateSupported,candidateBeatsFixed120WithPositiveBootstrapLowerBound:holdout.candidateVsFixed120.meanWisImprovement>0&&holdout.clusterBootstrapVsFixed120.interval95[0]>0,complexityBeatsSelectedGlobalWithPositiveBootstrapLowerBound:complexitySupported,allRollingFoldsBeatNoAdjustment:folds.every(item=>item.candidateVsBaseline.meanWisImprovement>0),productionReady:false,reason:"Weekly active-role calibration is necessary but insufficient for a production season range; availability and cross-week aggregation remain separate gates."},positionConsistency,rollingOrigin:{folds},holdout};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const input=process.argv[2]||"data/private/owned-model/weekly-range-rows.jsonl",output=process.argv[3]||"data/research/rookie-range-calibration.json",rows=loadWeeklyRangeDataset(input),artifact=backtestRookieRangeCalibration(rows);fs.writeFileSync(output,`${JSON.stringify(artifact,null,2)}\n`);console.log(JSON.stringify({output,status:artifact.status,dataQuality:artifact.dataQuality,candidatePolicy:artifact.candidatePolicy,recommendedWeeklyPolicy:artifact.recommendedWeeklyPolicy,fixed120Assessment:artifact.fixed120Assessment,promotionGate:artifact.promotionGate,positionConsistency:artifact.positionConsistency,holdout:{baseline:artifact.holdout.baseline,fixed120:artifact.holdout.fixed120,selectedGlobal:artifact.holdout.selectedGlobal,candidate:artifact.holdout.candidate,candidateVsBaseline:artifact.holdout.candidateVsBaseline,candidateVsFixed120:artifact.holdout.candidateVsFixed120,candidateVsSelectedGlobal:artifact.holdout.candidateVsSelectedGlobal,clusterBootstrapVsBaseline:artifact.holdout.clusterBootstrapVsBaseline,clusterBootstrapVsFixed120:artifact.holdout.clusterBootstrapVsFixed120,clusterBootstrapVsSelectedGlobal:artifact.holdout.clusterBootstrapVsSelectedGlobal}},null,2))}
