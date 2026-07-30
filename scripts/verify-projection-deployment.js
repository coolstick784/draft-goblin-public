import crypto from "node:crypto";
import fs from "node:fs";
import {pathToFileURL} from "node:url";

const DEFAULT_ATTEMPTS=60;
const DEFAULT_DELAY_MS=10_000;
const REQUIRED_SCORING=["STD","HALF","PPR"];

const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const sha256=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const cacheBustedUrl=(url,runId,attempt)=>{
  const value=new URL(url);
  value.searchParams.set("run",runId||"manual");
  value.searchParams.set("attempt",String(attempt));
  return value;
};

export const validateProjectionDeployment=({expectedManifest,deployedManifest,snapshotBytes,now=Date.now()})=>{
  const expected=expectedManifest?.bundle,deployed=deployedManifest?.bundle;
  if(!expected?.snapshotId||!expected?.sha256)throw new Error("Expected manifest did not identify a snapshot.");
  if(deployed?.snapshotId!==expected.snapshotId||deployed?.sha256!==expected.sha256)throw new Error(`GitHub Pages is still serving snapshot ${deployed?.snapshotId||"unknown"}; waiting for ${expected.snapshotId}.`);
  if(snapshotBytes.length!==Number(expected.bytes)||sha256(snapshotBytes)!==expected.sha256)throw new Error("Deployed bytes did not match the expected manifest.");
  const snapshot=JSON.parse(snapshotBytes.toString("utf8")),keys=Object.keys(snapshot.feeds||{}).sort();
  if(JSON.stringify(keys)!==JSON.stringify(["draftGoblin"]))throw new Error("Deployed snapshot did not contain exactly the Draft Goblin feed.");
  for(const scoring of REQUIRED_SCORING){
    const feed=snapshot.feeds.draftGoblin?.[scoring];
    if(!feed?.players?.length)throw new Error(`draftGoblin ${scoring} was missing.`);
    if(feed.projectionVariant!=="market-adjusted-shadow-v2")throw new Error(`draftGoblin ${scoring} was not market-adjusted.`);
  }
  const sourceFetchedAt=Date.parse(snapshot.sourceFetchedAt);
  if(!Number.isFinite(sourceFetchedAt)||sourceFetchedAt>now+5*60*1000||now-sourceFetchedAt>24*60*60*1000)throw new Error("Deployed projection inputs were stale or had an invalid timestamp.");
  if(JSON.stringify(snapshot).match(/FantasyPros|Sleeper current-season projections|ESPN projections/))throw new Error("Public snapshot contained a provider label.");
  return snapshot;
};

export const waitForProjectionDeployment=async({expectedManifest,manifestUrl,fetchImpl=fetch,runId="",attempts=DEFAULT_ATTEMPTS,delayMs=DEFAULT_DELAY_MS,wait=sleep,now=()=>Date.now(),log=console.log})=>{
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt+=1){
    try{
      const manifestResponse=await fetchImpl(cacheBustedUrl(manifestUrl,runId,attempt),{cache:"no-store",headers:{"cache-control":"no-cache"}});
      if(!manifestResponse.ok)throw new Error(`Manifest request returned HTTP ${manifestResponse.status}.`);
      const deployedManifest=await manifestResponse.json();
      const expected=expectedManifest.bundle,deployed=deployedManifest?.bundle;
      if(deployed?.snapshotId!==expected.snapshotId||deployed?.sha256!==expected.sha256)throw new Error(`GitHub Pages is still serving snapshot ${deployed?.snapshotId||"unknown"}; waiting for ${expected.snapshotId}.`);
      const snapshotResponse=await fetchImpl(cacheBustedUrl(deployed.url,runId,attempt),{cache:"no-store",headers:{"cache-control":"no-cache"}});
      if(!snapshotResponse.ok)throw new Error(`Snapshot request returned HTTP ${snapshotResponse.status}.`);
      const snapshotBytes=Buffer.from(await snapshotResponse.arrayBuffer());
      const snapshot=validateProjectionDeployment({expectedManifest,deployedManifest,snapshotBytes,now:now()});
      log(`Verified deployed projection snapshot ${expected.snapshotId} on attempt ${attempt}.`);
      return snapshot;
    }catch(error){
      lastError=error;
      if(attempt===attempts)break;
      log(`Deployment not ready (attempt ${attempt}/${attempts}): ${error.message}`);
      await wait(delayMs);
    }
  }
  throw new Error(`Projection deployment was not verified after ${attempts} attempts: ${lastError?.message||"unknown error"}`);
};

const main=async()=>{
  const [expectedManifestPath,manifestUrl]=process.argv.slice(2);
  if(!expectedManifestPath||!manifestUrl)throw new Error("Usage: node scripts/verify-projection-deployment.js <expected-manifest.json> <public-manifest-url>");
  const expectedManifest=JSON.parse(fs.readFileSync(expectedManifestPath,"utf8"));
  await waitForProjectionDeployment({
    expectedManifest,
    manifestUrl,
    runId:process.env.GITHUB_RUN_ID||"manual",
    attempts:Number(process.env.DEPLOY_VERIFY_ATTEMPTS||DEFAULT_ATTEMPTS),
    delayMs:Number(process.env.DEPLOY_VERIFY_DELAY_MS||DEFAULT_DELAY_MS)
  });
};

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
