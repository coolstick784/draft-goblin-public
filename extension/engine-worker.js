import{runEngineRequest}from"./engine-runtime.js";

self.onmessage=async event=>{const{id,type,payload}=event.data||{},onProgress=type==="evaluate-chunk"?(completed,total)=>self.postMessage({id,kind:"progress",shardId:payload.shardId,completed,total}):null;try{const value=await runEngineRequest(type,payload,{onProgress}),transfer=type==="evaluate-chunk"?value.rows.flatMap(row=>[row.scenarioWins.buffer,row.planScenarioWins.buffer,row.scenarioSelected.buffer]):[];self.postMessage({id,ok:true,value},transfer)}catch(error){self.postMessage({id,ok:false,error:String(error?.message||error)})}};
