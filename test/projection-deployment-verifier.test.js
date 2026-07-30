import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {waitForProjectionDeployment} from "../scripts/verify-projection-deployment.js";

const snapshot={sourceFetchedAt:"2026-07-26T11:39:31.107Z",feeds:{draftGoblin:Object.fromEntries(["STD","HALF","PPR"].map(scoring=>[scoring,{projectionVariant:"market-adjusted-shadow-v2",players:[{id:"1",name:"Player"}]}]))}};
const snapshotBytes=Buffer.from(JSON.stringify(snapshot));
const digest=crypto.createHash("sha256").update(snapshotBytes).digest("hex");
const expectedManifest={bundle:{snapshotId:"pf_new",url:"https://example.test/snapshots/pf_new.json",sha256:digest,bytes:snapshotBytes.length}};
const response=(body,status=200)=>new Response(body instanceof Buffer?body:JSON.stringify(body),{status,headers:{"content-type":"application/json"}});

test("deployment verifier waits through a successful stale Pages response",async()=>{
  let manifestRequests=0,waits=0;
  const oldManifest={bundle:{snapshotId:"pf_old",url:"https://example.test/snapshots/pf_old.json",sha256:"0".repeat(64),bytes:1}};
  const fetchImpl=async url=>{
    if(String(url).includes("manifest.json")){manifestRequests+=1;return response(manifestRequests===1?oldManifest:expectedManifest);}
    return response(snapshotBytes);
  };
  const result=await waitForProjectionDeployment({expectedManifest,manifestUrl:"https://example.test/manifest.json",fetchImpl,attempts:3,delayMs:0,wait:async()=>{waits+=1;},now:()=>Date.parse("2026-07-26T12:00:00.000Z"),log:()=>{}});
  assert.equal(result.sourceFetchedAt,snapshot.sourceFetchedAt);
  assert.equal(manifestRequests,2);
  assert.equal(waits,1);
});

test("deployment verifier retries a snapshot 404 after the new manifest appears",async()=>{
  let snapshotRequests=0;
  const fetchImpl=async url=>{
    if(String(url).includes("manifest.json"))return response(expectedManifest);
    snapshotRequests+=1;
    return snapshotRequests===1?response({error:"not ready"},404):response(snapshotBytes);
  };
  await waitForProjectionDeployment({expectedManifest,manifestUrl:"https://example.test/manifest.json",fetchImpl,attempts:3,delayMs:0,wait:async()=>{},now:()=>Date.parse("2026-07-26T12:00:00.000Z"),log:()=>{}});
  assert.equal(snapshotRequests,2);
});

test("deployment verifier fails after its bounded retry window",async()=>{
  const fetchImpl=async()=>response({bundle:{snapshotId:"pf_old"}});
  await assert.rejects(()=>waitForProjectionDeployment({expectedManifest,manifestUrl:"https://example.test/manifest.json",fetchImpl,attempts:2,delayMs:0,wait:async()=>{},log:()=>{}}),/not verified after 2 attempts/);
});
