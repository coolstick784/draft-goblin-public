import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const extension=path.join(root,"extension"),engine=path.join(extension,"engine"),dataOut=path.join(extension,"engine-data");
const coreFiles=["availability.js","availability-calibration-2026.js","conditional-rollout.js","evaluate.js","lineup-value.js","post-draft-report.js","quantile-distribution.js","random.js","recommend.js","roster.js","simulate.js","weekly-simulation.js"];
const sharedFiles=["domain.js","player-distribution.js"];
const copy=(source,destination)=>{fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(source,destination)};

for(const file of coreFiles)copy(path.join(root,"core",file),path.join(engine,"core",file));
for(const file of sharedFiles)copy(path.join(root,"shared",file),path.join(engine,"shared",file));

fs.mkdirSync(dataOut,{recursive:true});
const baseline=JSON.parse(fs.readFileSync(path.join(root,"data","generated","current-baseline.json"),"utf8"));
const ownedAvailabilityPath=path.join(root,"data","generated","owned-projections-2026.json");
if(fs.existsSync(ownedAvailabilityPath)){
  const artifact=JSON.parse(fs.readFileSync(ownedAvailabilityPath,"utf8")),season=Number(artifact.projectionSeason),byId=new Map((artifact.players||[]).map(player=>[String(player.id),player]));let attached=0;
  for(const player of baseline.players||[]){const source=byId.get(String(player.id)),expectedGames=Number(source?.expectedGames),activeRoleGames=Number(source?.activeRoleGames);if(Number.isFinite(expectedGames)&&Number.isFinite(activeRoleGames)&&activeRoleGames>=12&&activeRoleGames<=18&&expectedGames>=0&&expectedGames<=activeRoleGames){const missedGameRate=Number((1-expectedGames/activeRoleGames).toFixed(4));player.availability={schemaVersion:"availability-v1",season,missedGameRate,activeProbability:Number((1-missedGameRate).toFixed(4)),embeddedMissedGameRate:missedGameRate,estimationLevel:"player-games-forecast",modelVersion:String(artifact.modelVersion||"owned-games-forecast"),conditionedOn:"active-role-opportunity",components:{gamesForecast:missedGameRate,expectedGames,activeRoleGames}};attached++}}
  baseline.availabilityModel={schemaVersion:"availability-v1",modelVersion:String(artifact.modelVersion||"owned-games-forecast"),runtimeStatus:String(artifact.runtimeStatus||"shadow"),season,trainedThroughSeason:Number(artifact.trainingCutoffSeason),attachedPlayers:attached,calibrationArtifact:"owned-model-walk-forward.json"};
}
const playerRangePath=path.join(root,"data","research","player-performance-ranges.json");
if(fs.existsSync(playerRangePath)){
  const artifact=JSON.parse(fs.readFileSync(playerRangePath,"utf8")),key=value=>String(value||"").normalize("NFKD").replace(/[^\x00-\x7F]/g,"").replace(/[^a-z0-9]/gi,"").toLowerCase();
  if(artifact.status==="promoted"&&artifact.dataQuality?.promotionGatePassed){const sleeperCatalog=JSON.parse(fs.readFileSync(path.join(root,"data","generated","sleeper-current-catalog.json"),"utf8"));for(const player of baseline.players||[]){const profile=artifact.profiles?.[`${key(player.name)}:${player.position}`],catalogPlayer=sleeperCatalog[player.id];if(profile)player.performanceRangeProfile={...profile,artifactId:artifact.artifactId};if(Number.isFinite(Number(catalogPlayer?.years_exp)))player.yearsExperience=Number(catalogPlayer.years_exp)}baseline.performanceRangeModel={artifactId:artifact.artifactId,status:artifact.status,holdout:artifact.holdout,rookiePrior:artifact.rookiePrior,classificationThresholds:artifact.classificationThresholds}}
}
const distributionCalibrationPath=path.join(root,"data","research","player-weekly-distributions-quantile-v1.json");
if(fs.existsSync(distributionCalibrationPath))baseline.distributionCalibration=JSON.parse(fs.readFileSync(distributionCalibrationPath,"utf8"));
const productionDistributionPath=path.join(root,"data","research","player-season-distribution-runtime.json");
if(fs.existsSync(productionDistributionPath)){const distributionModel=JSON.parse(fs.readFileSync(productionDistributionPath,"utf8"));if(distributionModel.runtimeStatus==="promoted"&&distributionModel.dataQuality?.promotionGatePassed)baseline.distributionModel=distributionModel}
fs.writeFileSync(path.join(dataOut,"catalog.json"),JSON.stringify(baseline));
