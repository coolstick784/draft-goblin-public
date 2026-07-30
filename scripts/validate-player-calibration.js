import fs from"node:fs";
import{calibratePlayerProjectionRows,playerProviderConsensus}from"../extension/projection-range-guard.js";
import{buildPlayerIdentityIndex,matchPlayerIdentity}from"../extension/player-identity.js";

const DEFAULT_FILES={
  espn:"data/snapshots/espn-2026-PPR-2026-07-15t16-46-53-528z-ps_98c2b10f0826bfcc47c131ab.json",
  sleeper:"data/snapshots/sleeper-2026-PPR-2026-07-15t16-46-53-528z-ps_bb77141ca41963555b556438.json",
  fantasyPros:"data/snapshots/fantasypros-2026-PPR-2026-07-15t16-46-53-528z-ps_a0f77925b6a59fa26bdbbe49.json",
};
const POSITIONS=["QB","RB","WR","TE","K","DST"];
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const round=value=>value===null?null:Number(value.toFixed(3));
const seededRandom=seed=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
const ranks=values=>{const sorted=values.map((value,index)=>({value,index})).sort((a,b)=>a.value-b.value),result=Array(values.length);for(let start=0;start<sorted.length;){let end=start;while(end+1<sorted.length&&sorted[end+1].value===sorted[start].value)end++;const rank=(start+end+2)/2;for(let index=start;index<=end;index++)result[sorted[index].index]=rank;start=end+1}return result};
const correlation=(left,right)=>{const leftMean=mean(left),rightMean=mean(right),numerator=left.reduce((sum,value,index)=>sum+(value-leftMean)*(right[index]-rightMean),0),leftScale=Math.sqrt(left.reduce((sum,value)=>sum+(value-leftMean)**2,0)),rightScale=Math.sqrt(right.reduce((sum,value)=>sum+(value-rightMean)**2,0));return leftScale&&rightScale?numerator/(leftScale*rightScale):null};
const metrics=(rows,key)=>{const values=rows.map(row=>row[key]),targets=rows.map(row=>row.target);return{count:rows.length,mae:round(mean(rows.map(row=>Math.abs(row[key]-row.target)))),bias:round(mean(rows.map(row=>row[key]-row.target))),maxAbsoluteError:round(Math.max(...rows.map(row=>Math.abs(row[key]-row.target)))),pearson:round(correlation(values,targets)),spearman:round(correlation(ranks(values),ranks(targets)))}};
const randomSample=(rows,count,random)=>{const shuffled=[...rows];for(let index=shuffled.length-1;index>0;index--){const swap=Math.floor(random()*(index+1));[shuffled[index],shuffled[swap]]=[shuffled[swap],shuffled[index]]}return shuffled.slice(0,Math.min(count,shuffled.length))};
const load=file=>JSON.parse(fs.readFileSync(file,"utf8"));
const liveDraftGoblin=async()=>{const manifest=await fetch("https://coolstick784.github.io/draft-goblin-projections/projections/manifest.json",{cache:"no-store"}).then(response=>response.json()),bundle=await fetch(manifest.bundle.url,{cache:"no-store"}).then(response=>response.json());return{manifest,feed:bundle.feeds.draftGoblin.PPR}};

const [espnFile=DEFAULT_FILES.espn,sleeperFile=DEFAULT_FILES.sleeper,fantasyProsFile=DEFAULT_FILES.fantasyPros]=process.argv.slice(2),providers={espn:load(espnFile),sleeper:load(sleeperFile),fantasyPros:load(fantasyProsFile)},indexes=Object.fromEntries(Object.entries(providers).map(([key,value])=>[key,buildPlayerIdentityIndex(value.players)])),{manifest,feed}=await liveDraftGoblin(),rows=[];
for(const player of feed.players){
  const providerPoints=Object.fromEntries(Object.entries(indexes).flatMap(([key,index])=>{const matched=matchPlayerIdentity(index,player),points=Number(matched?.points);return Number.isFinite(points)&&points>0?[[key,points]]:[]})),target=playerProviderConsensus(providerPoints);
  if(target===null)continue;
  rows.push({name:player.name,position:player.position,rawCandidate:Number(player.points),providerPoints,target});
}
const calibrated=calibratePlayerProjectionRows(rows),joined=rows.map((row,index)=>({...row,calibrated:calibrated[index].value,calibration:calibrated[index]})),random=seededRandom(20260721),byPosition={};
for(const position of POSITIONS){
  const group=joined.filter(row=>row.position===position).sort((a,b)=>b.target-a.target),tailSize=Math.max(1,Math.min(12,Math.floor(group.length/4))),top=group.slice(0,tailSize),bottom=group.slice(-tailSize),sample=randomSample(group,3,random);
  byPosition[position]={all:{raw:metrics(group,"rawCandidate"),calibrated:metrics(group,"calibrated")},top:{size:top.length,rawBias:round(mean(top.map(row=>row.rawCandidate-row.target))),calibratedBias:round(mean(top.map(row=>row.calibrated-row.target)))},bottom:{size:bottom.length,rawBias:round(mean(bottom.map(row=>row.rawCandidate-row.target))),calibratedBias:round(mean(bottom.map(row=>row.calibrated-row.target)))},randomSample:sample.map(row=>({name:row.name,providers:row.providerPoints,consensus:round(row.target),raw:round(row.rawCandidate),calibrated:round(row.calibrated),difference:round(row.calibrated-row.target)}))};
}
console.log(JSON.stringify({draftGoblinSnapshot:manifest.bundle.snapshotId,providerSnapshots:Object.fromEntries(Object.entries(providers).map(([key,value])=>[key,value.snapshotId])),overall:{raw:metrics(joined,"rawCandidate"),calibrated:metrics(joined,"calibrated")},byPosition},null,2));
