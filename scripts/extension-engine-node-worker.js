import{parentPort}from"node:worker_threads";
import{runEngineRequest}from"../extension/engine-runtime.js";

parentPort.on("message",async message=>{const{id,type,payload}=message||{},onProgress=type==="evaluate-chunk"?(completed,total)=>parentPort.postMessage({id,kind:"progress",shardId:payload.shardId,completed,total}):null;try{const value=await runEngineRequest(type,payload,{onProgress}),transfer=type==="evaluate-chunk"?value.rows.flatMap(row=>[row.scenarioWins.buffer,row.planScenarioWins.buffer,row.scenarioSelected.buffer]):[];parentPort.postMessage({id,ok:true,value},transfer)}catch(error){parentPort.postMessage({id,ok:false,error:String(error?.stack||error?.message||error)})}});
