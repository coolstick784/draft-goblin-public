import fs from "node:fs";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { buildHoldoutArtifact, holdoutTasks } from "./cpu-holdout-gate-lib.js";

const arg=(name,fallback)=>{const index=process.argv.indexOf(`--${name}`);return index>=0?process.argv[index+1]:fallback};
const output="data/research/cpu-frozen-policy-holdout-v1.json",cpuCount=typeof os.availableParallelism==="function"?os.availableParallelism():os.cpus().length,concurrency=Math.max(1,Math.min(8,Number(arg("concurrency",Math.min(4,Math.max(1,cpuCount-1))))));
const outputUrl=new URL(`../${output}`,import.meta.url);
if(fs.existsSync(outputUrl))throw new Error(`Refusing to overwrite observed holdout ${output}. Create a new benchmark and policy version instead.`);
const tasks=holdoutTasks(),results=new Array(tasks.length);let cursor=0,active=0;
await new Promise(resolve=>{const launch=()=>{while(active<concurrency&&cursor<tasks.length){const index=cursor++,task=tasks[index],worker=new Worker(new URL("./parallel-cpu-holdout-worker.js",import.meta.url),{resourceLimits:{maxOldGenerationSizeMb:512}});active++;let settled=false;const finish=envelope=>{if(settled)return;settled=true;worker.terminate();active--;results[index]={taskId:task.taskId,...envelope};process.stdout.write(`holdout ${index+1}/${tasks.length}: ${envelope.workerError?"invalid":`title rank #${envelope.result.final.titleRank}`}\n`);launch()};worker.once("message",message=>finish(message.ok?{result:message.result}:{workerError:message.error}));worker.once("error",error=>finish({workerError:error.stack||error.message}));worker.postMessage(task)}if(cursor>=tasks.length&&active===0)resolve()};launch()});
const artifact=buildHoldoutArtifact({tasks,results});fs.mkdirSync(new URL("./",outputUrl),{recursive:true});fs.writeFileSync(outputUrl,JSON.stringify(artifact,null,2)+"\n");console.log(JSON.stringify({output,...artifact.summary},null,2));
