export const PROVIDER_RANGE_SMOOTHING_POINTS = 20;
export const PLAYER_CONSENSUS_OWNED_SIGNAL_WEIGHT = .2;
export const PLAYER_CONSENSUS_NEIGHBORHOOD_SIZE = 9;

const PROVIDER_WEIGHTS=Object.freeze({espn:1,sleeper:1,fantasyPros:1.15});
const positive=value=>{const number=Number(value);return Number.isFinite(number)&&number>0?number:null};
const median=values=>{const ordered=[...values].sort((a,b)=>a-b),middle=Math.floor(ordered.length/2);return ordered.length%2?ordered[middle]:(ordered[middle-1]+ordered[middle])/2};
const position=value=>String(value||"NA").toUpperCase().replace("D/ST","DST").replace("DEF","DST");

export function playerProviderConsensus(providerPoints){
  const entries=Array.isArray(providerPoints)
    ?providerPoints.map((value,index)=>[String(index),positive(value),1])
    :Object.entries(providerPoints||{}).map(([key,value])=>[key,positive(value),Number(PROVIDER_WEIGHTS[key]||1)]);
  const available=entries.filter(([,value])=>value!==null);
  if(!available.length)return null;
  const totalWeight=available.reduce((sum,[,,weight])=>sum+weight,0);
  return Number((available.reduce((sum,[,value,weight])=>sum+value*weight,0)/totalWeight).toFixed(4));
}

export function calibratePlayerProjectionRows(rows,{smoothingPoints=PROVIDER_RANGE_SMOOTHING_POINTS,ownedSignalWeight=PLAYER_CONSENSUS_OWNED_SIGNAL_WEIGHT,neighborhoodSize=PLAYER_CONSENSUS_NEIGHBORHOOD_SIZE}={}){
  if(!(Number(smoothingPoints)>0))throw new Error("Player consensus smoothing must be positive.");
  if(!(Number(ownedSignalWeight)>=0&&Number(ownedSignalWeight)<=1))throw new Error("Owned signal weight must be between zero and one.");
  if(!(Number.isInteger(Number(neighborhoodSize))&&Number(neighborhoodSize)>0))throw new Error("Player consensus neighborhood size must be a positive integer.");
  const prepared=(rows||[]).map((row,index)=>{const raw=positive(row?.rawCandidate),target=playerProviderConsensus(row?.providerPoints);return{index,row,raw,target,position:position(row?.position),residual:raw!==null&&target!==null?raw-target:null}}),groups=new Map();
  for(const item of prepared)if(item.residual!==null){const group=groups.get(item.position)||[];group.push(item);groups.set(item.position,group)}
  const localBiases=new Map();
  for(const group of groups.values()){
    for(const item of group){
      const neighbors=group.filter(candidate=>candidate!==item).sort((a,b)=>Math.abs(a.target-item.target)-Math.abs(b.target-item.target)||b.target-a.target).slice(0,Number(neighborhoodSize));
      localBiases.set(item.index,neighbors.length?median(neighbors.map(candidate=>candidate.residual)):0);
    }
  }
  return prepared.map(item=>{
    if(item.raw===null||item.target===null)return{value:item.raw,adjusted:false,adjustment:0,providerConsensus:item.target,localTierBias:0,rawResidual:null,centeredResidual:null,retainedResidual:null,lowerBound:item.target===null?null:item.target-smoothingPoints,upperBound:item.target===null?null:item.target+smoothingPoints,neighborhoodSize:0};
    const localTierBias=Number(localBiases.get(item.index)||0),centeredResidual=item.residual-localTierBias,retainedResidual=smoothingPoints*Math.tanh((ownedSignalWeight*centeredResidual)/smoothingPoints),value=Math.max(0,item.target+retainedResidual),groupSize=groups.get(item.position)?.length||1;
    return{value,adjusted:value!==item.raw,adjustment:value-item.raw,providerConsensus:item.target,localTierBias,rawResidual:item.residual,centeredResidual,retainedResidual,lowerBound:item.target-smoothingPoints,upperBound:item.target+smoothingPoints,neighborhoodSize:Math.min(neighborhoodSize,Math.max(0,groupSize-1))};
  });
}

export function smoothToProviderRange(rawCandidate, providerPoints, smoothingPoints = PROVIDER_RANGE_SMOOTHING_POINTS) {
  const values = Object.values(providerPoints || {}).map(Number).filter(Number.isFinite);
  if (!Number.isFinite(rawCandidate) || !values.length) return { value: rawCandidate, adjusted: false, adjustment: 0, lowerBound: null, upperBound: null };
  if (!(Number(smoothingPoints) > 0)) throw new Error("Provider range smoothing must be positive.");
  const minimum = Math.min(...values), maximum = Math.max(...values);
  const lowerBound = minimum - smoothingPoints, upperBound = maximum + smoothingPoints;
  const raw = Number(rawCandidate), value = raw < minimum
    ? minimum - smoothingPoints * Math.tanh((minimum - raw) / smoothingPoints)
    : raw > maximum
      ? maximum + smoothingPoints * Math.tanh((raw - maximum) / smoothingPoints)
      : raw;
  return { value, adjusted: value !== Number(rawCandidate), adjustment: value - Number(rawCandidate), lowerBound, upperBound };
}
