import crypto from"node:crypto";
import fs from"node:fs";
import path from"node:path";
import{fileURLToPath}from"node:url";
import{PROJECTION_FEED_SCHEMA,PROJECTION_FEED_MANIFEST_SCHEMA,validateProjectionFeed}from"../extension/projection-feed.js";
import{playerIdentityKeys}from"../extension/player-identity.js";

const DEFAULT_BASE_URL="https://coolstick784.github.io/draft-goblin-projections/projections/";
const SOURCE_WEIGHTS=Object.freeze({espn:1,sleeper:1,fantasyPros:1.15});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const policyById=policy=>new Map((policy?.sources||[]).map(source=>[String(source.id),source]));
const approved=source=>source?.status==="allowed-for-redistribution"&&Boolean(source?.license)&&source.license!=="not established";
const identityKey=player=>playerIdentityKeys(player).find(key=>key.startsWith("defense:"))||playerIdentityKeys(player).find(key=>key.startsWith("name-position:"))||"";
const uniqueFeedPlayers=players=>{
  const unique=new Map();
  for(const player of players){
    const identity=`${player.id}:${player.position}`,prior=unique.get(identity);
    if(!prior||player.points>prior.points||player.points===prior.points&&`${player.name}:${player.team}`.localeCompare(`${prior.name}:${prior.team}`)<0)unique.set(identity,player);
  }
  return[...unique.values()];
};

export function publishableFeeds(collected,policy){
  const rules=policyById(policy),feeds={};
  for(const[source,formats]of Object.entries(collected?.feeds||{})){const sourcePolicy=rules.get(String(collected?.provenance?.[source]?.policySourceId||""));if(!approved(sourcePolicy))continue;feeds[source]=formats}
  return feeds;
}

export function buildWeightedConsensusFeeds(sourceFeeds){
  const sources=Object.keys(sourceFeeds||{});
  if(sources.length<2)throw new Error("A public weighted consensus requires at least two policy-approved providers.");
  const formats=[...new Set(sources.flatMap(source=>Object.keys(sourceFeeds[source]||{})))].sort(),consensus={};
  for(const scoring of formats){
    const available=sources.filter(source=>Array.isArray(sourceFeeds[source]?.[scoring]?.players));
    if(available.length<2)continue;
    const seasonValues=new Set(available.map(source=>Number(sourceFeeds[source][scoring].season)));
    if(seasonValues.size!==1)throw new Error(`Consensus ${scoring} providers do not share one projection season.`);
    const season=[...seasonValues][0],groups=new Map(),fetchedTimes=[];
    for(const source of available){
      const feed=sourceFeeds[source][scoring],fetchedAt=Date.parse(feed.fetchedAt||"");
      if(!Number.isFinite(fetchedAt))throw new Error(`Consensus ${source} ${scoring} feed lacks a timestamp.`);
      fetchedTimes.push(fetchedAt);
      for(const player of feed.players){
        const key=identityKey(player),points=Number(player?.points);
        if(!key||!Number.isFinite(points)||points<=0)continue;
        const group=groups.get(key)||{player,values:new Map()};
        if(group.values.has(source))throw new Error(`Consensus ${source} ${scoring} contains a duplicate player identity.`);
        group.values.set(source,points);groups.set(key,group);
      }
    }
    const players=[];
    for(const[key,{player,values}]of groups){
      if(values.size<2)continue;
      let weighted=0,totalWeight=0;
      for(const[source,points]of values){const weight=Number(SOURCE_WEIGHTS[source]||1);weighted+=points*weight;totalWeight+=weight}
      players.push({
        id:`consensus:${key}`,name:String(player.name),position:String(player.position).replace("D/ST","DST").replace("DEF","DST"),
        team:String(player.team||""),points:Number((weighted/totalWeight).toFixed(3)),season,scoring,
      });
    }
    players.sort((a,b)=>a.position.localeCompare(b.position)||b.points-a.points||a.name.localeCompare(b.name));
    consensus[scoring]={
      available:true,source:"Draft Goblin weighted provider consensus",season,scoring,
      fetchedAt:new Date(Math.min(...fetchedTimes)).toISOString(),players,
    };
  }
  if(!Object.keys(consensus).length)throw new Error("No scoring format had at least two policy-approved providers.");
  return{consensus};
}

export function buildDraftGoblinFeeds(artifact){
  const season=Number(artifact?.projectionSeason),fetchedAt=String(artifact?.generatedAt||""),formats={STD:"meanStd",HALF:"meanHalf",PPR:"meanPpr"};
  if(!Number.isInteger(season)||!Number.isFinite(Date.parse(fetchedAt))||artifact?.runtimeStatus!=="shadow"||artifact?.eligibleAsLiveProjection!==false||artifact?.artifactType!=="draft-goblin-owned-market-shadow-candidate"||artifact?.projectionVariant!=="market-adjusted-shadow-v2"||!Array.isArray(artifact?.players))throw new Error("Daily Draft Goblin artifact must be the timestamped market-adjusted shadow candidate.");
  const draftGoblin={};
  for(const[scoring,key]of Object.entries(formats)){
    const players=uniqueFeedPlayers(artifact.players.flatMap(player=>{const points=Number(player?.[key]),expectedGames=Number(player?.expectedGames),activeRoleGames=Number(player?.activeRoleGames),gamesValid=Number.isFinite(expectedGames)&&Number.isFinite(activeRoleGames)&&activeRoleGames>=12&&activeRoleGames<=18&&expectedGames>=0&&expectedGames<=activeRoleGames;return Number.isFinite(points)&&points>0?[{id:String(player.id||player.ownedPlayerId||""),name:String(player.name||""),position:String(player.position||""),team:String(player.team||""),points:Number(points.toFixed(3)),...(gamesValid?{expectedGames:Number(expectedGames.toFixed(3)),activeRoleGames:Number(activeRoleGames.toFixed(3)),availabilityModelVersion:String(artifact.modelVersion||"owned-games-forecast")}:{}) ,season,scoring}]:[]}));
    draftGoblin[scoring]={available:true,source:`Draft Goblin market-adjusted shadow ${String(artifact.modelVersion||"daily")}`,projectionVariant:artifact.projectionVariant,modelVersion:String(artifact.modelVersion||"daily"),season,scoring,fetchedAt,players};
  }
  return{draftGoblin};
}

export function buildProjectionPublication({collected,policy,draftGoblinArtifact,aggregateMode=collected?"providers":"owned",now=Date.now(),baseUrl=DEFAULT_BASE_URL}){
  let aggregate={};
  if(aggregateMode!=="owned"){
    const approvedFeeds=publishableFeeds(collected,policy);if(!Object.keys(approvedFeeds).length)throw new Error("No current projection source is approved for public redistribution in data/source-policy.json.");
    aggregate=buildWeightedConsensusFeeds(approvedFeeds);
  }
  const feeds={...aggregate,...buildDraftGoblinFeeds(draftGoblinArtifact)},fetchedTimes=Object.values(feeds).flatMap(formats=>Object.values(formats).map(value=>Date.parse(value?.fetchedAt||""))).filter(Number.isFinite),sourceFetchedAt=new Date(Math.min(...fetchedTimes)).toISOString(),generatedAt=new Date(now).toISOString();
  const unsigned={schemaVersion:PROJECTION_FEED_SCHEMA,generatedAt,sourceFetchedAt,feeds:canonical(feeds)},assessment=validateProjectionFeed(unsigned,{now});if(!assessment.valid)throw new Error(`Projection publication rejected: ${assessment.errors.join(", ")}`);
  const bytes=Buffer.from(`${JSON.stringify(assessment.bundle)}\n`),sha256=crypto.createHash("sha256").update(bytes).digest("hex"),snapshotId=`pf_${sha256.slice(0,24)}`,filename=`snapshots/${snapshotId}.json`,root=new URL(String(baseUrl).endsWith("/")?baseUrl:`${baseUrl}/`),url=new URL(filename,root).toString();
  const manifest={schemaVersion:PROJECTION_FEED_MANIFEST_SCHEMA,generatedAt,expiresAt:new Date(now+26*60*60*1000).toISOString(),bundle:{snapshotId,url,sha256,bytes:bytes.length}};
  return{snapshotId,filename,bytes,manifest};
}

export function writeProjectionPublication(publication,outputDirectory){
  const snapshotPath=path.join(outputDirectory,publication.filename),manifestPath=path.join(outputDirectory,"manifest.json");fs.mkdirSync(path.dirname(snapshotPath),{recursive:true});fs.writeFileSync(snapshotPath,publication.bytes,{flag:"wx"});fs.writeFileSync(manifestPath,`${JSON.stringify(publication.manifest,null,2)}\n`);return{snapshotPath,manifestPath};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const root=path.resolve(fileURLToPath(new URL("..",import.meta.url))),ownedOnly=process.argv[2]==="--owned-only",input=ownedOnly?null:path.resolve(process.argv[2]||path.join(root,"data/private/projection-feed-collected.json")),output=path.resolve(process.argv[3]||path.join(root,"dist/projection-site/projections")),draftGoblinInput=path.resolve(process.argv[4]||path.join(root,"data/private/draft-goblin-daily.json")),policy=JSON.parse(fs.readFileSync(path.join(root,"data/source-policy.json"),"utf8")),collected=input?JSON.parse(fs.readFileSync(input,"utf8")):null,draftGoblinArtifact=JSON.parse(fs.readFileSync(draftGoblinInput,"utf8")),publication=buildProjectionPublication({collected,policy,draftGoblinArtifact,aggregateMode:ownedOnly?"owned":"providers",baseUrl:process.env.PROJECTION_FEED_BASE_URL||DEFAULT_BASE_URL});writeProjectionPublication(publication,output);console.log(JSON.stringify({snapshotId:publication.snapshotId,output,aggregateMode:ownedOnly?"owned":"providers"},null,2));
}
