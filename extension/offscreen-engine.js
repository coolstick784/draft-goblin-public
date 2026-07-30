import{localApi,scheduleLocalEngineWorkerShutdown,warmLocalEngineWorkers}from"./local-engine-client.js";

const jobs=new Map(),sharedJobs=new Map();
let engineWarmPromise;
if(globalThis.__draftGoblinOffscreenTestMode)globalThis.__draftGoblinOffscreenTest={activeJobs:()=>jobs.size,activeSharedJobs:()=>sharedJobs.size};

function sharedEvaluationKey(body){
  try{const payload=JSON.parse(body);if(payload?.state&&typeof payload.state==="object")delete payload.state.updatedAt;return JSON.stringify(payload)}catch{return body}
}

function warmEngine(){
  if(engineWarmPromise)return engineWarmPromise;
  const pending=Promise.resolve().then(()=>warmLocalEngineWorkers()).then(value=>{scheduleLocalEngineWorkerShutdown();return value});
  const tracked=pending.finally(()=>{if(engineWarmPromise===tracked)engineWarmPromise=null});
  engineWarmPromise=tracked;
  return engineWarmPromise
}

async function runEvaluation(body,requestId){
  if(jobs.has(requestId))return jobs.get(requestId).request;
  const key=sharedEvaluationKey(body);let entry=sharedJobs.get(key);
  if(!entry){
    const controller=new AbortController();
    entry={body,key,controller,request:null,requestIds:new Set()};
    const publishProgress=progress=>{for(const subscriberId of entry.requestIds)chrome.runtime.sendMessage({type:"OFFSCREEN_EVALUATION_PROGRESS",requestId:subscriberId,progress}).catch(()=>{})};
    const request=warmEngine().then(()=>localApi("/v1/evaluate",{method:"POST",body,signal:controller.signal,onProgress:publishProgress,contextKey:requestId})).finally(()=>{
      if(sharedJobs.get(key)===entry)sharedJobs.delete(key);
      for(const subscriberId of entry.requestIds)if(jobs.get(subscriberId)===entry)jobs.delete(subscriberId)
    });
    entry.request=request;
    sharedJobs.set(key,entry)
  }
  entry.requestIds.add(requestId);
  jobs.set(requestId,entry);
  return entry.request
}

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message.type==="OFFSCREEN_ENGINE_PING"){sendResponse({ok:true,engine:"draft-goblin-offscreen"});return}
  if(message.type==="OFFSCREEN_WARM_ENGINE"){
    warmEngine().then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:error.message||"The persistent simulation engine could not be warmed."}));
    return true
  }
  if(message.type==="OFFSCREEN_CANCEL_EVALUATION"){
    const requestId=String(message.requestId||""),entry=jobs.get(requestId);if(entry){jobs.delete(requestId);entry.requestIds.delete(requestId);if(!entry.requestIds.size){if(sharedJobs.get(entry.key)===entry)sharedJobs.delete(entry.key);entry.controller.abort()}}sendResponse({ok:true,cancelled:Boolean(entry)});return
  }
  if(message.type==="OFFSCREEN_RUN_EVALUATION"){
    const requestId=String(message.requestId||"");if(!requestId){sendResponse({ok:false,error:"A simulation request identity is required."});return}
    runEvaluation(String(message.body||"{}"),requestId).then(data=>sendResponse({ok:true,data})).catch(error=>sendResponse({ok:false,error:error.message||"The background simulation failed."}));
    return true
  }
});

warmEngine().catch(()=>{});
