const PROBABILITIES=[.01,.05,.10,.20,.30,.40,.50,.60,.70,.80,.90,.95,.99];
const close=(a,b)=>Math.abs(Number(a)-Number(b))<1e-9;
export const UNPROMOTED_PERFORMANCE_RISK=.4;
export const UNPROMOTED_POSITION_RANGES=Object.freeze({
  // Frozen empirical 5th/95th-percentile season residuals from the
  // 2021-2024 position calibration (50,000 season draws). DST has no
  // accepted cohort and uses the simulator's RMSE fallback as disclosed.
  QB:Object.freeze({lowerResidual:-51.79,upperResidual:52.94,ceiling:450,rows:3558,evidence:"fantasy-nfl:QB"}),
  RB:Object.freeze({lowerResidual:-34.42,upperResidual:48.50,ceiling:500,rows:6574,evidence:"fantasy-nfl:RB"}),
  WR:Object.freeze({lowerResidual:-33.30,upperResidual:48.59,ceiling:450,rows:9984,evidence:"fantasy-nfl:WR"}),
  TE:Object.freeze({lowerResidual:-22.48,upperResidual:33.89,ceiling:350,rows:5655,evidence:"fantasy-nfl:TE"}),
  K:Object.freeze({lowerResidual:-39.48,upperResidual:40.99,ceiling:200,rows:1953,evidence:"fantasy-nfl:K"}),
  DST:Object.freeze({lowerResidual:-37.31,upperResidual:37.31,ceiling:250,rows:0,evidence:"rmse-fallback:DST"}),
});

export function unpromotedPerformanceRange(mean,position){
  const value=Math.max(0,Number(mean)||0),normalized=String(position||"").toUpperCase().replace("D/ST","DST").replace("DEF","DST"),limits=UNPROMOTED_POSITION_RANGES[normalized]||{lowerResidual:-45,upperResidual:45,ceiling:Infinity,rows:0,evidence:"rmse-fallback:unknown"};
  const floor=Math.max(0,value+limits.lowerResidual),uncappedCeiling=value+limits.upperResidual,ceiling=Math.max(value,Math.min(uncappedCeiling,limits.ceiling));
  return{floor,ceiling,performanceRisk:UNPROMOTED_PERFORMANCE_RISK,source:"empirical-position-season-residual-p05-p95",calibrationId:"multi-source-projection-calibration:2021-2024",calibrationRows:limits.rows,evidence:limits.evidence,ceilingLimited:ceiling<uncappedCeiling,positionLimit:Number.isFinite(limits.ceiling)?limits.ceiling:null,includesHistoricalProjectionError:true};
}

export function playerSpecificPerformanceRange(mean,position,profile){
  const fallback=unpromotedPerformanceRange(mean,position),scale=Number(profile?.scale),rows=Number(profile?.weeklyRows);
  const rookiePrior=profile?.rookiePrior===true;
  if(!Number.isFinite(scale)||scale<.65||scale>1.5||(!rookiePrior&&(!Number.isFinite(rows)||rows<8)))return fallback;
  const value=Math.max(0,Number(mean)||0),floor=Math.max(0,value-(value-fallback.floor)*scale),uncappedCeiling=value+(fallback.ceiling-value)*scale,ceiling=Math.max(value,Math.min(uncappedCeiling,fallback.positionLimit??Infinity));
  const classification=String(profile.classification||"typical"),stabilityLabel=classification==="stable"?"historically-narrow":classification==="boom-bust"?"historically-wide":classification;
  return{...fallback,floor:Number(floor.toFixed(4)),ceiling:Number(ceiling.toFixed(4)),performanceRisk:distributionPerformanceRisk({floor,ceiling},value),source:rookiePrior?"empirical-rookie-uncertainty-prior":"empirical-player-shrunk-season-range",playerScale:scale,playerHistoryRows:rookiePrior?0:rows,stabilityLabel,playerProfileArtifactId:String(profile.artifactId||"player-performance-range-scale:2021-2024"),ceilingLimited:ceiling<uncappedCeiling};
}

export function distributionPerformanceRisk(range,mean){
  const value=Number(mean),width=Number(range?.ceiling)-Number(range?.floor);
  return Number.isFinite(value)&&value>0&&Number.isFinite(width)
    ?Math.max(.05,Math.min(.95,width/(2*value)))
    :UNPROMOTED_PERFORMANCE_RISK;
}

const bucketTemplate=(positionModel,mean)=>{
  const buckets=Array.isArray(positionModel?.buckets)?positionModel.buckets:[];
  return buckets.find(bucket=>bucket.maxMean==null||mean<=Number(bucket.maxMean))||buckets.at(-1)||positionModel;
};

// Runtime enrichment accepts only a separately promoted season-residual model.
// The current weekly research artifact intentionally cannot pass this boundary.
export function promotedPlayerDistribution({model,player,mean,season,scoringFormat}){
  if(!model||model.runtimeStatus!=="promoted"||model.schemaVersion!=="quantile-v1"||!["season-residual-fantasy-points","season-performance-ratio"].includes(model.unit)||Number(model.season)!==Number(season)||!Number.isFinite(mean)||mean<=0)return null;
  const format=String(scoringFormat||"").toLowerCase(),formatModel=model.scoringFormats?.[format];
  if(!formatModel)return null;
  const position=String(player.position||"").toUpperCase(),positionModel=formatModel.positions?.[position],template=bucketTemplate(positionModel,mean),residuals=template?.residualQuantiles,ratios=template?.ratioQuantiles,isRatio=model.unit==="season-performance-ratio";
  if(isRatio?(!Array.isArray(ratios)||ratios.length!==3||ratios.some(value=>!Number.isFinite(Number(value)))):(!Array.isArray(residuals)||residuals.length!==PROBABILITIES.length||residuals.some(value=>!Number.isFinite(Number(value)))))return null;
  let values;
  if(isRatio){const normalize=value=>String(value||"").normalize("NFKD").replace(/[^\x00-\x7F]/g,"").replace(/[^a-z0-9]/gi,"").toLowerCase(),profile=formatModel.players?.[`${normalize(player.name)}:${position}`],priorMean=Number(template.meanRatio),priorEquivalent=Number(formatModel.playerShrinkage)*Math.max(1,mean/17),factor=positionModel?.personalized&&profile&&priorMean>0?Math.max(.65,Math.min(1.45,(Number(profile.observedActual)+priorEquivalent*priorMean)/(Number(profile.observedProjected)+priorEquivalent)/priorMean)):1,three=ratios.map(value=>Math.max(0,mean*Number(value)*factor));values=PROBABILITIES.map(probability=>probability<=.1?three[0]:probability>=.9?three[2]:probability===.5?three[1]:probability<.5?three[0]+(three[1]-three[0])*(probability-.1)/.4:three[1]+(three[2]-three[1])*(probability-.5)/.4)}else values=residuals.map(value=>Math.max(0,mean+Number(value)));
  if(values.some((value,index)=>index&&value<values[index-1]))return null;
  const generatedAt=String(model.generatedAt||""),forecastAsOf=String(model.forecastAsOf||generatedAt),trainedThrough=String(model.trainedThrough||"");
  if(!Number.isFinite(Date.parse(generatedAt))||!Number.isFinite(Date.parse(forecastAsOf))||!Number.isFinite(Date.parse(trainedThrough))||Date.parse(trainedThrough)>=Date.parse(forecastAsOf))return null;
  const sourceSnapshotIds=Array.isArray(model.sourceSnapshotIds)?model.sourceSnapshotIds.filter(value=>typeof value==="string"&&value):[];
  if(!sourceSnapshotIds.length)return null;
  const distribution={schemaVersion:"quantile-v1",unit:"season-fantasy-points",conditionedOn:"active-role",season:Number(season),scoringFormat:format,mean,quantiles:PROBABILITIES.map((p,index)=>({p,value:Number(values[index].toFixed(4))})),provenance:{modelId:String(model.modelId||"hierarchical-player-quantiles"),modelVersion:String(model.modelVersion||""),generatedAt,forecastAsOf,trainedThrough,calibrationId:String(model.calibrationId||""),sourceSnapshotIds,estimationLevel:String(template?.estimationLevel||positionModel?.estimationLevel||"position"),fallbackReason:String(template?.fallbackReason||positionModel?.fallbackReason||"Shrunk season residual template for the player's projection tier.")}};
  if(!distribution.provenance.modelVersion||!distribution.provenance.calibrationId)return null;
  if(player.team&&player.team!=="FA")distribution.correlationRefs=[{kind:"offense",key:`offense:${season}:${player.team}`}];
  return distribution;
}

export function distributionRange(distribution){
  if(!distribution)return null;
  const point=probability=>distribution.quantiles.find(item=>close(item.p,probability))?.value;
  const floor=point(.10),ceiling=point(.90);
  return Number.isFinite(floor)&&Number.isFinite(ceiling)?{floor,ceiling}:null;
}
