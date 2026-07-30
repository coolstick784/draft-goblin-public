export const PROJECTION_SOURCES=Object.freeze([
  {key:"sleeper",label:"Sleeper",baseWeight:1,sourceFamily:"draft-site",calibrationStatus:"provisional"},
  {key:"espn",label:"ESPN",baseWeight:1,sourceFamily:"draft-site",calibrationStatus:"provisional"},
  {key:"fantasyPros",label:"FantasyPros",baseWeight:1.15,sourceFamily:"expert-consensus",calibrationStatus:"provisional"},
]);

const valid=(entry,season)=>Number(entry?.points)>0&&Number(entry?.season)===Number(season);
const qualityMultiplier=(source,entry,platform)=>{
  if(source.key==="fantasyPros")return entry?.kind==="official-api"?1:entry?.kind==="public-html"?0.96:0.9;
  if(source.key===platform)return 1;
  if(entry?.kind==="cross-platform-draft-site")return .85;
  return .9;
};

export function projectionConsensus({season,platform,platformProjection,modelProjection,sources={}}){
  const values={...sources};
  if(["sleeper","espn"].includes(platform))values[platform]={points:Number(platformProjection||0),season:Number(season),kind:"draft-site"};
  const registered=PROJECTION_SOURCES.map(source=>{
    const entry=values[source.key],available=valid(entry,season);
    const quality=available?qualityMultiplier(source,entry,platform):0;
    return{...source,available,points:available?Number(entry.points):null,season:available?Number(entry.season):null,kind:entry?.kind||"external",fetchedAt:available&&entry?.fetchedAt?String(entry.fetchedAt):null,qualityMultiplier:quality,effectiveWeight:available?source.baseWeight*quality:0,unavailableReason:available?null:entry?.points?"season mismatch":"not connected"};
  });
  const total=registered.reduce((sum,source)=>sum+source.effectiveWeight,0);
  const sourceList=registered.map(source=>({...source,weight:source.available&&total?source.effectiveWeight/total:0}));
  const points=sourceList.reduce((sum,source)=>sum+(source.points||0)*source.weight,0);
  const site=sourceList.find(source=>source.key===platform);
  return{season:Number(season),points:Number(points.toFixed(2)),method:"quality-weighted current-season consensus",weightEvidence:"2022 PPR common-player source accuracy; conservative provisional weights pending 2026 snapshot validation",draftSiteProjection:site?.available?site.points:null,draftSiteSource:site?.label||String(platform||"Draft site"),sources:sourceList};
}

export function projectionSourceSummary(consensus,fallbackPoints=0){
  const available=(consensus?.sources||[]).filter(source=>source.available&&Number(source.points)>0);
  const details=available.map(source=>`${source.label.replace(" current-season","").replace(" model","")}: ${Number(source.points).toFixed(1)}`).join(" · ");
  const points=Number(consensus?.points||fallbackPoints||0).toFixed(1);
  return details?`Consensus: ${points} · ${details}`:`Projection: ${points}`;
}
