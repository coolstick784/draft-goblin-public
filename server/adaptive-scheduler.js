import os from "node:os";

const asPositiveInteger=value=>{
  const parsed=Number.parseInt(String(value??""),10);
  return Number.isInteger(parsed)&&parsed>0?parsed:null;
};

export function chooseWorkerConcurrency({
  logicalCpus=typeof os.availableParallelism==="function"?os.availableParallelism():os.cpus().length,
  override=process.env.DRAFT_CHAMPION_WORKERS
}={}){
  const cpus=Math.max(1,asPositiveInteger(logicalCpus)||1);
  const safeMaximum=Math.max(1,Math.min(15,cpus>1?cpus-1:1));
  const requested=asPositiveInteger(override);
  if(requested)return Math.min(requested,safeMaximum);
  if(cpus<=2)return 1;
  if(cpus<=4)return 2;
  if(cpus<=8)return 3;
  // Scenario-parallel refinement gives every worker the complete candidate
  // set and partitions only the deterministic scenario bank. On machines with
  // enough logical CPUs, using all fifteen bounded slots keeps the worst-case
  // early-draft 10k refinement inside the live 25-second decision budget while
  // still reserving at least one logical CPU for the server and browser.
  return Math.min(15,safeMaximum);
}

export async function mapBounded(values,mapper,{concurrency=chooseWorkerConcurrency(),controller}={}){
  const items=Array.from(values),results=new Array(items.length);
  let cursor=0,firstError=null;
  const run=async()=>{
    while(!firstError&&!controller?.cancelled){
      const index=cursor++;
      if(index>=items.length)return;
      try{results[index]=await mapper(items[index],index)}catch(error){firstError=error}
    }
  };
  await Promise.all(Array.from({length:Math.min(Math.max(1,concurrency),items.length||1)},run));
  if(firstError)throw firstError;
  if(controller?.cancelled)throw Object.assign(new Error("refinement cancelled"),{code:"REFINEMENT_CANCELLED"});
  return results;
}
