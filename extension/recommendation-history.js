const number=value=>Number.isFinite(Number(value))?Number(value):0;

export function exactTitleSimulation(data,targetIterations=10000){
  const target=number(data?.targetIterations),iterations=number(data?.iterations),recommendations=Array.isArray(data?.recommendations)?data.recommendations:[];
  if(data?.status!=="complete"||data?.simulationStatus!=="refined"||target!==targetIterations||iterations!==targetIterations||!recommendations.length)return false;
  return recommendations.every(item=>number(item?.simulation?.iterations)===targetIterations&&number(item?.teamSimulation?.iterations)===targetIterations)
}

export function snapshotStrength(snapshot,targetIterations=10000){
  const iterations=number(snapshot?.iterations),target=number(snapshot?.targetIterations),complete=snapshot?.simulationStatus==="refined"&&iterations===targetIterations&&(target===targetIterations||target===0)&&(!snapshot?.status||snapshot.status==="complete");
  return[complete?1:0,iterations,snapshot?.simulationStatus==="refined"?1:0,number(snapshot?.capturedAt)]
}

export function strongerRecommendationSnapshot(left,right,targetIterations=10000){
  if(!left)return right;
  if(!right)return left;
  const a=snapshotStrength(left,targetIterations),b=snapshotStrength(right,targetIterations);
  for(let index=0;index<a.length;index++)if(a[index]!==b[index])return a[index]>b[index]?left:right;
  return right
}

export function mergeRecommendationHistories(...histories){
  const byPick=new Map();
  for(const history of histories)for(const row of Array.isArray(history)?history:[]){
    const pickNo=Number(row?.pickNo);if(!Number.isInteger(pickNo)||pickNo<1)continue;
    byPick.set(pickNo,strongerRecommendationSnapshot(byPick.get(pickNo),row))
  }
  return[...byPick.values()].sort((a,b)=>Number(a.pickNo)-Number(b.pickNo))
}
