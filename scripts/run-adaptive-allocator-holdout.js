import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { ADAPTIVE_ALLOCATOR_HOLDOUT_ID, ADAPTIVE_ALLOCATOR_TASKS, scoreAdaptiveAllocatorHoldout } from "./adaptive-allocator-holdout-lib.js";

const index=process.argv.indexOf("--candidate"),candidatePath=index>=0?process.argv[index+1]:null;
if(!candidatePath)throw new Error("Holdout is preregistered but locked: provide --candidate only after the allocator implementation and training are complete.");
const absolute=path.resolve(candidatePath),module=await import(pathToFileURL(absolute));
if(typeof module.runAdaptiveAllocatorHoldoutTask!=="function"||!module.candidateId)throw new Error("Candidate module must export candidateId and runAdaptiveAllocatorHoldoutTask(task,{arm}).");
const candidateHash=crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
const output=new URL(`../data/research/${ADAPTIVE_ALLOCATOR_HOLDOUT_ID}-${String(module.candidateId).replace(/[^a-z0-9_-]/gi,"-")}.json`,import.meta.url);
if(fs.existsSync(output))throw new Error("Refusing to overwrite an observed adaptive allocator holdout. Register a new candidate and benchmark version.");
const baselineResults=[],candidateResults=[];
for(const task of ADAPTIVE_ALLOCATOR_TASKS){baselineResults.push(await module.runAdaptiveAllocatorHoldoutTask(task,{arm:"baseline"}));candidateResults.push(await module.runAdaptiveAllocatorHoldoutTask(task,{arm:"candidate"}));}
const artifact=scoreAdaptiveAllocatorHoldout({baselineResults,candidateResults,candidateId:module.candidateId,candidateHash});fs.writeFileSync(output,`${JSON.stringify(artifact,null,2)}\n`,{flag:"wx"});console.log(JSON.stringify({output:String(output),passed:artifact.passed,baseline:artifact.baselineMetrics,candidate:artifact.candidateMetrics,gates:artifact.gates},null,2));if(!artifact.passed)process.exitCode=1;
