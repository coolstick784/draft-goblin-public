import{parentPort,workerData}from"node:worker_threads";
import{simulateCandidateBatch}from"../core/simulate.js";

function run(base,task){
  const{state,candidates,userSlot,seed=2026}=base,{iterations,scenarioOffset=0,taskId=null}=task;
  try{
    const rows=simulateCandidateBatch({state,candidates,userSlot,iterations,seed,scenarioOffset,onProgress:(completed,total)=>parentPort.postMessage({kind:"progress",taskId,scenarioOffset,completed,total})});
    const transfer=rows.flatMap(row=>[row.scenarioWins.buffer,row.planScenarioWins.buffer,row.scenarioSelected.buffer]);
    parentPort.postMessage({ok:true,taskId,scenarioOffset,rows},transfer)
  }catch(error){parentPort.postMessage({ok:false,taskId,scenarioOffset,error:error.stack||error.message})}
}

if(workerData?.pooled){
  const base={state:workerData.state,candidates:workerData.candidates,userSlot:workerData.userSlot,seed:workerData.seed};
  parentPort.on("message",task=>{if(task?.type==="run")run(base,task)})
}else run(workerData,workerData);
