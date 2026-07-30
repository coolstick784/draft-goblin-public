import fs from"node:fs";
import path from"node:path";
import{fileURLToPath}from"node:url";
import{buildPlayerIdentityIndex,matchPlayerIdentity,playerIdentityKeys}from"../extension/player-identity.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),"utf8"));
const active=player=>{const adp=Number(player?.adp),team=String(player?.team||"").toUpperCase();return Number.isFinite(adp)&&adp>0&&adp<500&&Boolean(team)&&team!=="FA"};
const identity=player=>playerIdentityKeys(player)[0]||`id:${String(player?.id||"")}`;
const unique=rows=>[...new Map(rows.map(player=>[identity(player),player])).values()];
const names=rows=>rows.map(player=>player.name).sort((a,b)=>a.localeCompare(b));

export function identityCoverageReport({baselinePlayers,espnPlayers,sleeperPlayers,fantasyProsPlayers,files={}}){
  const baseline=baselinePlayers||[],draftable=baseline.filter(active),baselineIndex=buildPlayerIdentityIndex(baseline),sources={espn:unique(espnPlayers||[]),sleeper:unique(sleeperPlayers||[]),fantasyPros:unique(fantasyProsPlayers||[])};
  const indexes=Object.fromEntries(Object.entries(sources).map(([key,players])=>[key,buildPlayerIdentityIndex(players)]));
  const sourceCoverage=Object.fromEntries(Object.entries(sources).map(([key,players])=>{const matchedDraftable=draftable.filter(player=>matchPlayerIdentity(indexes[key],player)),identityMisses=players.filter(player=>!matchPlayerIdentity(baselineIndex,player));return[key,{capturedRows:(key==="espn"?espnPlayers:key==="sleeper"?sleeperPlayers:fantasyProsPlayers)?.length||0,uniqueCapturedPlayers:players.length,matchedDraftablePlayers:matchedDraftable.length,capturedIdentityMissCount:identityMisses.length,capturedIdentityMisses:names(identityMisses)}]}));
  const has=(source,player)=>Boolean(matchPlayerIdentity(indexes[source],player)),allThree=draftable.filter(player=>has("espn",player)&&has("sleeper",player)&&has("fantasyPros",player)),sleeperAndFantasyPros=draftable.filter(player=>has("sleeper",player)&&has("fantasyPros",player)),anySource=draftable.filter(player=>has("espn",player)||has("sleeper",player)||has("fantasyPros",player)),noSource=draftable.filter(player=>!has("espn",player)&&!has("sleeper",player)&&!has("fantasyPros",player));
  return{contract:"Identity-only audit. An ESPN baseline omission means the player was not present in any captured virtualized DOM snapshot; it is not counted as an identity failure.",files,draftableBaselinePlayers:draftable.length,sources:sourceCoverage,overlap:{allThree:allThree.length,sleeperAndFantasyPros:sleeperAndFantasyPros.length,anyCapturedSource:anySource.length,noCapturedSource:noSource.length,noCapturedSourcePlayers:names(noSource)},espn:{capturedIdentityOmissions:sourceCoverage.espn.capturedIdentityMissCount,unavailableInCapturedDom:draftable.length-sourceCoverage.espn.matchedDraftablePlayers}};
}

export function currentIdentityCoverageReport(){
  const files={baseline:"data/generated/current-baseline.json",espn:["data/snapshots/espn-2026-PPR-2026-07-13.json","data/snapshots/espn-2026-STD-2026-07-13.json"],sleeper:"data/snapshots/sleeper-2026-STD-2026-07-13.json",fantasyPros:"data/snapshots/fantasypros-2026-PPR-2026-07-13T16-24-54-766Z.json"};
  return identityCoverageReport({baselinePlayers:read(files.baseline).players,espnPlayers:files.espn.flatMap(file=>read(file).players),sleeperPlayers:read(files.sleeper).players,fantasyProsPlayers:read(files.fantasyPros).players,files});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.stdout.write(`${JSON.stringify(currentIdentityCoverageReport(),null,2)}\n`);
