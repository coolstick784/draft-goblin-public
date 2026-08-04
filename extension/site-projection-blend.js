export const DEFAULT_PROJECTION_DRIVER="draftGoblin";
export const PROJECTION_DRIVER_METHOD="draft-goblin-primary-user-selectable-current-site";
export const PROJECTION_DRIVERS=Object.freeze(["draftGoblin","platform"]);

const positive=value=>{const number=Number(value);return Number.isFinite(number)&&number>0?number:null};
const platformLabel=value=>String(value||"").toLowerCase()==="espn"?"ESPN":String(value||"").toLowerCase()==="sleeper"?"Sleeper":String(value||"").toLowerCase()==="yahoo"?"Yahoo":"Current draft site";

export function projectionDriverSelection({
  season,
  platform,
  driver=DEFAULT_PROJECTION_DRIVER,
  siteProjection,
  siteSeason=season,
  draftGoblinProjection,
}){
  const targetSeason=Number(season),platformKey=String(platform||"site").toLowerCase(),requested=PROJECTION_DRIVERS.includes(driver)?driver:DEFAULT_PROJECTION_DRIVER,site=Number(siteSeason)===targetSeason?positive(siteProjection):null,available={
    draftGoblin:positive(draftGoblinProjection),
    platform:site,
  },selected=available[requested]?requested:available.draftGoblin?"draftGoblin":available.platform?"platform":null,points=selected?available[selected]:0,weights=selected?{[selected]:1}:{},sources=[
    {key:"draftGoblin",label:"Draft Goblin",available:Boolean(available.draftGoblin),points:available.draftGoblin,season:targetSeason,kind:"owned-model",weight:weights.draftGoblin||0},
    {key:platformKey,label:platformLabel(platform),available:Boolean(available.platform),points:available.platform,season:targetSeason,kind:"current-site-visible",weight:weights.platform||0},
  ].filter(source=>source.available),fallbackReason=!selected?"no-current-projection":selected!==requested?`${requested}-unavailable`:null;
  return{season:targetSeason,points:Number(points.toFixed(2)),method:selected?`${selected}-projection-driver`:"projection-driver-unavailable",weightEvidence:"Draft Goblin is the default driver; the user may instead select the current-site projection directly.",draftSiteProjection:site,draftSiteSource:platformLabel(platform),draftGoblinProjection:available.draftGoblin,requestedDriver:requested,selectedDriver:selected,fallbackReason,sources};
}
