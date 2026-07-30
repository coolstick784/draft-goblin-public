import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadHvpkod } from "./evaluate-hvpkod-history.js";

const POSITIONS=["QB","RB","WR","TE","K"],SHRINKAGE_GRID=[8,16,32,64,128],ROOKIE_SCALE_GRID=[1,1.1,1.2,1.3,1.4];
const round=(value,digits=6)=>Number(Number(value).toFixed(digits));
const playerKey=row=>`${String(row.name||"").normalize("NFKD").replace(/[^\x00-\x7F]/g,"").replace(/[^a-z0-9]/gi,"").toLowerCase()}:${row.position}`;
const quantile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);if(!sorted.length)return 0;const at=(sorted.length-1)*p,lo=Math.floor(at),hi=Math.ceil(at),w=at-lo;return sorted[lo]*(1-w)+sorted[hi]*w};
const median=values=>quantile(values,.5);

export function usableHistoricalRows(rows,{maximumWeeklyZeroRate=.65,throughYear=2024}={}){
  const candidates=rows.filter(row=>row.year<=throughYear&&Number(row.projected)>0&&Number.isFinite(Number(row.actual))&&POSITIONS.includes(row.position));
  const weeks=new Map();for(const row of candidates){const key=`${row.year}:${row.week}`;if(!weeks.has(key))weeks.set(key,[]);weeks.get(key).push(row)}
  const excludedWeeks=[...weeks.entries()].filter(([,group])=>group.filter(row=>row.actual<=0).length/group.length>maximumWeeklyZeroRate).map(([key])=>key);
  const excluded=new Set(excludedWeeks);
  return{rows:candidates.filter(row=>!excluded.has(`${row.year}:${row.week}`)),excludedWeeks};
}

function aggregateSeasons(rows){
  const groups=new Map();for(const row of rows){const key=`${row.year}:${playerKey(row)}`,item=groups.get(key)||{year:row.year,name:row.name,position:row.position,playerKey:playerKey(row),projected:0,actual:0,weeks:0};item.projected+=row.projected;item.actual+=row.actual;item.weeks++;groups.set(key,item)}
  return[...groups.values()].filter(row=>row.weeks>=4);
}

function baseRanges(trainingSeasons){return Object.fromEntries(POSITIONS.map(position=>{const residuals=trainingSeasons.filter(row=>row.position===position).map(row=>row.actual-row.projected);return[position,{lower:quantile(residuals,.05),upper:quantile(residuals,.95),rows:residuals.length}]}))}

function playerScales(trainingRows,shrinkage){
  const bounds=Object.fromEntries(POSITIONS.map(position=>{const values=trainingRows.filter(row=>row.position===position).map(row=>row.projected);return[position,[quantile(values,1/3),quantile(values,2/3)]]})),bucket=row=>row.projected<=bounds[row.position][0]?"low":row.projected<=bounds[row.position][1]?"middle":"high";
  const expected=new Map();for(const position of POSITIONS)for(const name of["low","middle","high"]){const values=trainingRows.filter(row=>row.position===position&&bucket(row)===name).map(row=>Math.abs(row.actual-row.projected));expected.set(`${position}:${name}`,Math.max(.25,median(values)))}
  const grouped=new Map();for(const row of trainingRows){const key=playerKey(row);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(Math.abs(row.actual-row.projected)/expected.get(`${row.position}:${bucket(row)}`))}
  return new Map([...grouped].map(([key,values])=>{const raw=Math.max(.35,Math.min(2.5,median(values))),weight=values.length/(values.length+shrinkage),scale=Math.max(.65,Math.min(1.5,1+weight*(raw-1)));return[key,{scale,rows:values.length,localEvidenceWeight:weight,rawRelativeMedianAbsoluteError:raw}]}));
}

function intervalScore(actual,lower,upper,alpha=.1){return upper-lower+(actual<lower?2/alpha*(lower-actual):0)+(actual>upper?2/alpha*(actual-upper):0)}
function rank(values){const order=values.map((value,index)=>({value,index})).sort((a,b)=>a.value-b.value),ranks=Array(values.length);for(let i=0;i<order.length;){let j=i+1;while(j<order.length&&order[j].value===order[i].value)j++;const value=(i+j-1)/2+1;for(let k=i;k<j;k++)ranks[order[k].index]=value;i=j}return ranks}
function correlation(left,right){if(left.length<3)return null;const a=rank(left),b=rank(right),am=a.reduce((x,y)=>x+y,0)/a.length,bm=b.reduce((x,y)=>x+y,0)/b.length;let numerator=0,ad=0,bd=0;for(let i=0;i<a.length;i++){numerator+=(a[i]-am)*(b[i]-bm);ad+=(a[i]-am)**2;bd+=(b[i]-bm)**2}return ad&&bd?numerator/Math.sqrt(ad*bd):0}

export function evaluatePlayerRanges(trainingRows,testRows,{shrinkage=32,rookieScale=1,debutYears=new Map()}={}){
  const trainingSeasons=aggregateSeasons(trainingRows),testSeasons=aggregateSeasons(testRows),ranges=baseRanges(trainingSeasons),profiles=playerScales(trainingRows,shrinkage);let baseScore=0,candidateScore=0,baseCovered=0,candidateCovered=0,baseWidth=0,candidateWidth=0,rookies=0;const predicted=[],observed=[];
  for(const row of testSeasons){const range=ranges[row.position];if(!range)continue;const profile=profiles.get(row.playerKey),rookie=!profile&&debutYears.get(row.playerKey)===row.year,scale=profile?.scale||(rookie?rookieScale:1);if(rookie)rookies++;const baseLower=Math.max(0,row.projected+range.lower),baseUpper=Math.max(row.projected,row.projected+range.upper),candidateLower=Math.max(0,row.projected+range.lower*scale),candidateUpper=Math.max(row.projected,row.projected+range.upper*scale);baseScore+=intervalScore(row.actual,baseLower,baseUpper);candidateScore+=intervalScore(row.actual,candidateLower,candidateUpper);baseCovered+=row.actual>=baseLower&&row.actual<=baseUpper;candidateCovered+=row.actual>=candidateLower&&row.actual<=candidateUpper;baseWidth+=baseUpper-baseLower;candidateWidth+=candidateUpper-candidateLower;if(profile){predicted.push(scale);observed.push(Math.abs(row.actual-row.projected)/Math.max(1,(Math.abs(range.lower)+Math.abs(range.upper))/2))}}
  const n=testSeasons.length;return{rows:n,playersWithPrior:predicted.length,rookies,baseline:{meanIntervalScore:round(baseScore/n),coverage:round(baseCovered/n),meanWidth:round(baseWidth/n)},candidate:{meanIntervalScore:round(candidateScore/n),coverage:round(candidateCovered/n),meanWidth:round(candidateWidth/n)},intervalScoreImprovement:round((baseScore-candidateScore)/baseScore),widthChange:round((candidateWidth-baseWidth)/baseWidth),volatilityRankCorrelation:round(correlation(predicted,observed)||0)};
}

export function backtestPlayerPerformanceRanges(inputRows,{generatedAt=new Date().toISOString()}={}){
  const prepared=usableHistoricalRows(inputRows),rows=prepared.rows,debutYears=new Map();for(const row of rows){const key=playerKey(row);debutYears.set(key,Math.min(debutYears.get(key)??Infinity,row.year))}const validationTrain=rows.filter(row=>row.year<=2022),validation=rows.filter(row=>row.year===2023),sweep=SHRINKAGE_GRID.flatMap(shrinkage=>ROOKIE_SCALE_GRID.map(rookieScale=>({shrinkage,rookieScale,metrics:evaluatePlayerRanges(validationTrain,validation,{shrinkage,rookieScale,debutYears})}))).sort((a,b)=>b.metrics.intervalScoreImprovement-a.metrics.intervalScoreImprovement),selected=sweep[0].shrinkage,rookieScale=sweep[0].rookieScale,holdoutTrain=rows.filter(row=>row.year<=2023),holdout=rows.filter(row=>row.year===2024),holdoutMetrics=evaluatePlayerRanges(holdoutTrain,holdout,{shrinkage:selected,rookieScale,debutYears}),finalProfiles=playerScales(rows,selected),gate=holdoutMetrics.intervalScoreImprovement>0&&holdoutMetrics.candidate.coverage>=holdoutMetrics.baseline.coverage-.02&&holdoutMetrics.volatilityRankCorrelation>0;
  const eligibleScales=[...finalProfiles.values()].filter(value=>value.rows>=8).map(value=>value.scale),stableThreshold=quantile(eligibleScales,.25),boomBustThreshold=quantile(eligibleScales,.75);
  const profiles=Object.fromEntries([...finalProfiles].map(([key,value])=>[key,{scale:round(value.scale,4),weeklyRows:value.rows,localEvidenceWeight:round(value.localEvidenceWeight,4),classification:value.rows<8?"limited-history":value.scale>=boomBustThreshold?"boom-bust":value.scale<=stableThreshold?"stable":"typical"}]));
  return{schemaVersion:1,artifactId:"player-performance-range-scale:2021-2024",generatedAt,status:gate?"promoted":"research-only",method:"Player weekly absolute projection error relative to the same-position and projection-tier median, empirically shrunk toward 1.0. Confirmed rookies use a separately selected uncertainty multiplier. Width changes do not move the mean or change injury availability.",leakageBoundary:"Player shrinkage and the rookie multiplier were selected on 2023 using 2021-2022 only; 2024 is the untouched holdout. Final profiles use 2021-2024 only after the gate decision.",dataQuality:{excludedMissingOutcomeWeeks:prepared.excludedWeeks,promotionGatePassed:gate},selection:{validationYear:2023,parameterSweep:sweep,selectedShrinkage:selected,selectedRookieScale:rookieScale},holdout:{year:2024,...holdoutMetrics},scaleLimits:[.65,1.5],rookiePrior:{scale:rookieScale,classification:"rookie-uncertain",evidence:"First appearance in the validation or holdout data is used as the historical rookie proxy; live use requires years of experience equal to zero."},classificationThresholds:{minimumWeeklyRows:8,stableAtOrBelow:round(stableThreshold,4),boomBustAtOrAbove:round(boomBustThreshold,4),basis:"Bottom and top quartiles of out-of-time-selected, projection-tier-adjusted player scales."},profiles};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const input=process.argv[2]||"data/vendor/NFL-Data-main/NFL-data-Players",output=process.argv[3]||"data/research/player-performance-ranges.json",artifact=backtestPlayerPerformanceRanges(loadHvpkod(input));fs.writeFileSync(output,`${JSON.stringify(artifact,null,2)}\n`);console.log(JSON.stringify({output,status:artifact.status,selection:artifact.selection,holdout:artifact.holdout,profiles:Object.keys(artifact.profiles).length},null,2))}
