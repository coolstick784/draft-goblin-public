import fs from "node:fs";
import {fetchWithRetry} from "./fetch-retry.js";

const sourcePath=new URL("../data/generated/sleeper-current-projections.json",import.meta.url),cache=new Map();
let sourceRows;
const scoringField=scoring=>String(scoring).toUpperCase()==="PPR"?"pts_ppr":String(scoring).toUpperCase()==="HALF"?"pts_half_ppr":"pts_std";
const adpField=scoring=>String(scoring).toUpperCase()==="PPR"?"adp_ppr":String(scoring).toUpperCase()==="HALF"?"adp_half_ppr":"adp_std";

export function sleeperProjectionRows(rows,{season,scoring="PPR"}){
  const pointsKey=scoringField(scoring),rankKey=adpField(scoring),positions=new Set(["QB","RB","WR","TE","K","DEF"]),byId=new Map();
  for(const row of rows||[]){const player=row?.player||{},position=String(player.position||""),team=String(player.team||row.team||"");if(Number(row.season)!==Number(season)||!positions.has(position)||!team)continue;const points=Number(row.stats?.[pointsKey]||0),rawAdp=Number(row.stats?.[rankKey]),adp=Number.isFinite(rawAdp)&&rawAdp>0&&rawAdp<999?rawAdp:null;if(points<=0)continue;byId.set(String(row.player_id),{id:String(row.player_id),name:`${player.first_name||""} ${player.last_name||""}`.trim(),position:position==="DEF"?"DST":position,team,points,adp,injuryStatus:player.injury_status||null,season:Number(season),scoring:String(scoring).toUpperCase()})}
  return[...byId.values()];
}

export function currentSleeperProjections({season,scoring="PPR"}){
  const key=`${season}:${String(scoring).toUpperCase()}`;if(cache.has(key))return{...cache.get(key),cached:true};
  sourceRows??=JSON.parse(fs.readFileSync(sourcePath,"utf8"));const players=sleeperProjectionRows(sourceRows,{season,scoring}),value={available:players.length>0,source:"Sleeper current-season projections",access:"local-snapshot",season:Number(season),scoring:String(scoring).toUpperCase(),players};cache.set(key,value);return value;
}

export async function refreshSleeperProjections({season,scoring="PPR",fetchImpl=fetch,now=Date.now()}){
  const key=`${season}:${String(scoring).toUpperCase()}`;
  try{const response=await fetchWithRetry(`https://api.sleeper.com/projections/nfl/${Number(season)}?season_type=regular`,{headers:{"user-agent":"DraftGoblin/0.4 local-runtime"}},{fetchImpl});if(!response.ok)throw new Error(`Sleeper projections failed (${response.status})`);const players=sleeperProjectionRows(await response.json(),{season,scoring});if(!players.length)throw new Error("Sleeper projections returned no active players.");const value={available:true,source:"Sleeper current-season projections",access:"live-api",season:Number(season),scoring:String(scoring).toUpperCase(),fetchedAt:new Date(now).toISOString(),players};cache.set(key,value);return value}
  catch(error){return{...currentSleeperProjections({season,scoring}),access:"local-snapshot-fallback",liveFetchError:String(error?.message||error)}}
}
