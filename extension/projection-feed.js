export const PROJECTION_FEED_ORIGIN="https://coolstick784.github.io";
export const PROJECTION_FEED_PATH="/draft-goblin-projections/projections/";
export const PROJECTION_FEED_MANIFEST_URL=`${PROJECTION_FEED_ORIGIN}${PROJECTION_FEED_PATH}manifest.json`;
export const PROJECTION_FEED_SCHEMA="draft-goblin-projection-feed-v2";
export const PROJECTION_FEED_MANIFEST_SCHEMA="draft-goblin-projection-feed-manifest-v2";
export const PROJECTION_FEED_STORAGE_KEY="projectionFeedCacheV2";
export const PROJECTION_FEED_CHECK_KEY="projectionFeedLastCheckV2";
export const PROJECTION_FEED_REFRESH_MS=5*60*1000;
export const PROJECTION_FEED_MAX_AGE_MS=24*60*60*1000;
export const PROJECTION_FEED_MAX_BYTES=4*1024*1024;
const PROJECTION_FEED_MAX_MANIFEST_BYTES=32*1024,CORE_POSITION_MINIMUMS={QB:10,RB:25,WR:35,TE:12};

const SCORING=new Set(["STD","HALF","PPR"]),POSITIONS=new Set(["QB","RB","WR","TE","K","DST"]);
let refreshInFlight;
const cleanString=(value,max=160)=>String(value??"").replace(/[\u0000-\u001f\u007f-\u009f]/g,"").trim().slice(0,max);
const bytesToHex=bytes=>[...bytes].map(value=>value.toString(16).padStart(2,"0")).join("");

export async function sha256Hex(value,cryptoImpl=globalThis.crypto){
  const bytes=value instanceof Uint8Array?value:new TextEncoder().encode(String(value));
  return bytesToHex(new Uint8Array(await cryptoImpl.subtle.digest("SHA-256",bytes)));
}

export function allowedProjectionFeedUrl(value){
  try{const url=new URL(String(value));return url.protocol==="https:"&&!url.username&&!url.password&&url.origin===PROJECTION_FEED_ORIGIN&&url.pathname.startsWith(PROJECTION_FEED_PATH)}catch{return false}
}

function normalizedPlayer(player,season,scoring){
  const id=cleanString(player?.id,80),name=cleanString(player?.name),position=cleanString(player?.position,8).toUpperCase(),team=cleanString(player?.team,8).toUpperCase(),points=Number(player?.points),projectionSeason=Number(player?.projectionSeason??player?.season??season),projectionScoring=cleanString(player?.projectionScoring??player?.scoring??scoring,8).toUpperCase();
  if(!id||!name||!POSITIONS.has(position)||!Number.isFinite(points)||points<=0||points>=1000||projectionSeason!==season||projectionScoring!==scoring)return null;
  const expectedGames=Number(player?.expectedGames),activeRoleGames=Number(player?.activeRoleGames),gamesValid=Number.isFinite(expectedGames)&&Number.isFinite(activeRoleGames)&&activeRoleGames>=12&&activeRoleGames<=18&&expectedGames>=0&&expectedGames<=activeRoleGames;
  return{id,name,position,team,points,...(Number.isFinite(Number(player?.adp))&&Number(player.adp)>0?{adp:Number(player.adp)}:{}),...(cleanString(player?.injuryStatus,32)?{injuryStatus:cleanString(player.injuryStatus,32)}:{}),...(gamesValid?{expectedGames,activeRoleGames,availabilityModelVersion:cleanString(player?.availabilityModelVersion,80)||"owned-games-forecast"}:{}),season,scoring};
}

export function validateProjectionFeed(bundle,{now=Date.now(),maximumAgeMs=PROJECTION_FEED_MAX_AGE_MS,minimumPlayers=100}={}){
  const errors=[];
  if(bundle?.schemaVersion!==PROJECTION_FEED_SCHEMA)errors.push("unsupported-feed-schema");
  const generatedAt=Date.parse(bundle?.generatedAt||""),sourceFetchedAt=Date.parse(bundle?.sourceFetchedAt||"");
  if(!Number.isFinite(generatedAt)||generatedAt>now+5*60*1000)errors.push("invalid-generated-at");
  if(!Number.isFinite(sourceFetchedAt)||sourceFetchedAt>now+5*60*1000)errors.push("invalid-source-fetched-at");
  else if(now-sourceFetchedAt>maximumAgeMs)errors.push("stale-source-data");
  const feeds=bundle?.feeds&&typeof bundle.feeds==="object"?bundle.feeds:{},normalized={};let feedCount=0;
  const feedKeys=Object.keys(feeds);
  if(!feedKeys.includes("draftGoblin")||feedKeys.some(key=>!["consensus","draftGoblin"].includes(key)))errors.push("draft-goblin-required-and-no-raw-providers");
  for(const[sourceKey,formats]of Object.entries(feeds)){
    const safeSource=cleanString(sourceKey,40);if(!safeSource||safeSource!==sourceKey||["__proto__","constructor","prototype"].includes(safeSource)||!formats||typeof formats!=="object")continue;
    for(const[scoringKey,value]of Object.entries(formats)){
      const scoring=String(scoringKey).toUpperCase(),season=Number(value?.season);if(!SCORING.has(scoring)||!Number.isInteger(season))continue;
      const projectionVariant=cleanString(value?.projectionVariant,80),modelVersion=cleanString(value?.modelVersion,120);
      if(safeSource==="draftGoblin"&&projectionVariant!=="market-adjusted-shadow-v2"){errors.push(`${safeSource}:${scoring}:market-adjusted-shadow-required`);continue}
      const fetchedAt=Date.parse(value?.fetchedAt||bundle?.sourceFetchedAt||"");if(!Number.isFinite(fetchedAt)||now-fetchedAt>maximumAgeMs||fetchedAt>now+5*60*1000){errors.push(`${safeSource}:${scoring}:invalid-fetched-at`);continue}
      const players=[],identities=new Set();for(const raw of Array.isArray(value?.players)?value.players:[]){const player=normalizedPlayer(raw,season,scoring);if(!player){errors.push(`${safeSource}:${scoring}:invalid-player`);continue}const identity=`${player.id}:${player.position}`;if(identities.has(identity)){errors.push(`${safeSource}:${scoring}:duplicate-player`);continue}identities.add(identity);players.push(player)}
      const positionCounts=Object.fromEntries([...POSITIONS].map(position=>[position,players.filter(player=>player.position===position).length]));
      if(players.length<minimumPlayers||Object.entries(CORE_POSITION_MINIMUMS).some(([position,count])=>positionCounts[position]<count)){errors.push(`${safeSource}:${scoring}:insufficient-coverage`);continue}
      normalized[safeSource]??={};normalized[safeSource][scoring]={available:true,source:cleanString(value.source)||safeSource,...(projectionVariant?{projectionVariant}:{}),...(modelVersion?{modelVersion}:{}),access:"remote-snapshot",season,scoring,fetchedAt:new Date(fetchedAt).toISOString(),snapshotId:cleanString(value.snapshotId,96),players};feedCount++;
    }
  }
  for(const scoring of SCORING)if(!normalized.draftGoblin?.[scoring])errors.push(`draftGoblin:${scoring}:missing-feed`);
  if(feedKeys.includes("consensus"))for(const scoring of SCORING)if(!normalized.consensus?.[scoring])errors.push(`consensus:${scoring}:missing-feed`);
  for(const scoring of SCORING){const seasons=["consensus","draftGoblin"].map(source=>normalized[source]?.[scoring]?.season).filter(Number.isInteger);if(seasons.length===2&&new Set(seasons).size!==1)errors.push(`${scoring}:season-mismatch`)}
  if(!feedCount)errors.push("no-valid-feeds");
  return{valid:errors.length===0,errors:[...new Set(errors)],bundle:errors.length?null:{schemaVersion:PROJECTION_FEED_SCHEMA,generatedAt:new Date(generatedAt).toISOString(),sourceFetchedAt:new Date(sourceFetchedAt).toISOString(),feeds:normalized}};
}

function validateManifest(manifest,now){
  const errors=[],generatedAt=Date.parse(manifest?.generatedAt||""),expiresAt=Date.parse(manifest?.expiresAt||""),bundle=manifest?.bundle;
  if(manifest?.schemaVersion!==PROJECTION_FEED_MANIFEST_SCHEMA)errors.push("unsupported-manifest-schema");
  if(!Number.isFinite(generatedAt)||generatedAt>now+5*60*1000)errors.push("invalid-manifest-generated-at");
  if(!Number.isFinite(expiresAt)||expiresAt<=now)errors.push("expired-manifest");
  if(!bundle||!allowedProjectionFeedUrl(bundle.url))errors.push("untrusted-bundle-url");
  if(!/^[a-f0-9]{64}$/i.test(String(bundle?.sha256||"")))errors.push("invalid-bundle-digest");
  if(!Number.isInteger(Number(bundle?.bytes))||Number(bundle.bytes)<=0||Number(bundle.bytes)>PROJECTION_FEED_MAX_BYTES)errors.push("invalid-bundle-size");
  if(!/^[a-z0-9_-]{3,96}$/i.test(String(bundle?.snapshotId||"")))errors.push("invalid-snapshot-id");
  return{valid:errors.length===0,errors};
}

async function boundedJson(response,maxBytes){
  const declared=Number(response?.headers?.get?.("content-length"));if(Number.isFinite(declared)&&declared>maxBytes)throw new Error("Projection metadata exceeded its size limit.");
  if(typeof response?.arrayBuffer!=="function")return response.json();const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength>maxBytes)throw new Error("Projection metadata exceeded its size limit.");try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new Error("Projection metadata was not valid JSON.")}
}

const storedVersions=async storage=>{try{const result=await storage.get(PROJECTION_FEED_STORAGE_KEY),versions=result?.[PROJECTION_FEED_STORAGE_KEY];return Array.isArray(versions)?versions:[]}catch{return[]}};
export async function cachedProjectionFeed({storage=chrome.storage.local,now=Date.now()}={}){
  for(const entry of await storedVersions(storage)){const checked=validateProjectionFeed(entry?.bundle,{now});if(checked.valid)return{...entry,bundle:checked.bundle,cacheStatus:"downloaded"}}
  return null;
}

export async function refreshProjectionFeed({fetchImpl=fetch,storage=chrome.storage.local,now=Date.now(),force=false}={}){
  if(refreshInFlight&&!force)return refreshInFlight;
  const run=(async()=>{
    const checks=await storage.get(PROJECTION_FEED_CHECK_KEY).catch(()=>({})),lastCheck=Number(checks?.[PROJECTION_FEED_CHECK_KEY]||0),cached=await cachedProjectionFeed({storage,now});
    if(!force&&cached&&now-lastCheck<PROJECTION_FEED_REFRESH_MS)return cached;
    await storage.set({[PROJECTION_FEED_CHECK_KEY]:now}).catch(()=>{});
    const manifestResponse=await fetchImpl(`${PROJECTION_FEED_MANIFEST_URL}?at=${Math.floor(now/PROJECTION_FEED_REFRESH_MS)}`,{cache:"no-store",credentials:"omit",redirect:"error",signal:AbortSignal.timeout(15_000)});
    if(!manifestResponse?.ok)throw new Error(`Projection manifest request failed (${manifestResponse?.status||"network"}).`);
    if(manifestResponse.url&&!allowedProjectionFeedUrl(manifestResponse.url))throw new Error("Projection manifest redirected outside the approved host.");
    const manifest=await boundedJson(manifestResponse,PROJECTION_FEED_MAX_MANIFEST_BYTES),manifestAssessment=validateManifest(manifest,now);if(!manifestAssessment.valid)throw new Error(`Projection manifest rejected: ${manifestAssessment.errors.join(", ")}`);
    if(cached?.snapshotId===manifest.bundle.snapshotId)return cached;
    if(cached&&Date.parse(manifest.generatedAt)<=Date.parse(cached.bundle.generatedAt))throw new Error("Projection manifest did not advance beyond the cached snapshot.");
    const response=await fetchImpl(manifest.bundle.url,{cache:"no-store",credentials:"omit",redirect:"error",signal:AbortSignal.timeout(15_000)});if(!response?.ok)throw new Error(`Projection snapshot request failed (${response?.status||"network"}).`);if(response.url&&!allowedProjectionFeedUrl(response.url))throw new Error("Projection snapshot redirected outside the approved host.");
    const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength!==Number(manifest.bundle.bytes)||bytes.byteLength>PROJECTION_FEED_MAX_BYTES)throw new Error("Projection snapshot size did not match its manifest.");
    const digest=await sha256Hex(bytes);if(digest!==String(manifest.bundle.sha256).toLowerCase())throw new Error("Projection snapshot checksum failed.");
    let parsed;try{parsed=JSON.parse(new TextDecoder().decode(bytes))}catch{throw new Error("Projection snapshot was not valid JSON.")}
    const assessment=validateProjectionFeed(parsed,{now});if(!assessment.valid)throw new Error(`Projection snapshot rejected: ${assessment.errors.join(", ")}`);
    const entry={snapshotId:String(manifest.bundle.snapshotId),downloadedAt:now,bundle:assessment.bundle},prior=(await storedVersions(storage)).filter(value=>value?.snapshotId!==entry.snapshotId).slice(0,1);await storage.set({[PROJECTION_FEED_STORAGE_KEY]:[entry,...prior]});return{...entry,cacheStatus:"downloaded"};
  })();refreshInFlight=run;try{return await run}finally{if(refreshInFlight===run)refreshInFlight=null}
}

export function projectionResponseFromFeed(feed,path){
  const scoring=String(new URL(path,"https://extension.invalid").searchParams.get("scoring")||"PPR").toUpperCase(),source=path.includes("consensus")?"consensus":path.includes("draftgoblin")?"draftGoblin":path.includes("fantasypros")?"fantasyPros":path.includes("sleeper")?"sleeper":"";
  return feed?.bundle?.feeds?.[source]?.[scoring]||null;
}
