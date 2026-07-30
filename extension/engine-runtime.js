import{assessRankingReadiness,evaluateDraft}from"./engine/core/evaluate.js";
import{buildDraftReport}from"./engine/core/post-draft-report.js";
import{buildCandidateBoard}from"./engine/core/recommend.js";
import{simulateCandidateBatch}from"./engine/core/simulate.js";

export const CLIENT_BUILD_ID="extension-engine-v11-te-adp-free-20260730";

export async function runEngineRequest(type,payload={},hooks={}){
  if(type==="health")return{ok:true,version:"0.5.0",clientBuildId:CLIENT_BUILD_ID,engine:"extension"};
  if(type==="evaluate"){
    const started=performance.now(),iterations=Math.min(20000,Math.max(1,Number(payload.refineIterations||payload.iterations)||10000));
    const recommendations=evaluateDraft({...payload,includeSimulation:true,iterations});
    return{generatedAt:Date.now(),calibrated:payload.state?.dataQuality==="calibrated",consumer:payload.consumer||"gui",status:"complete",simulationStatus:"refined",refinementOutcome:"complete",iterations,targetIterations:iterations,startedAt:Date.now()-Math.round(performance.now()-started),deadlineAt:null,refinementDeadlineEnabled:false,responseMs:Math.round(performance.now()-started),refinementMs:Math.round(performance.now()-started),workerCount:1,readiness:assessRankingReadiness(recommendations,{iterations,targetIterations:iterations,stageIterations:iterations}),recommendations,clientBuildId:CLIENT_BUILD_ID}
  }
  if(type==="player-board")return{generatedAt:Date.now(),candidates:buildCandidateBoard(payload),clientBuildId:CLIENT_BUILD_ID};
  if(type==="evaluate-chunk"){
    const{state,candidates,userSlot,iterations,seed=2026,scenarioOffset=0,shardId=null}=payload;
    return{shardId,scenarioOffset,rows:simulateCandidateBatch({state,candidates,userSlot,iterations,seed,scenarioOffset,onProgress:hooks.onProgress})}
  }
  if(type==="draft-report"){
    const iterations=Math.min(20000,Math.max(1000,Number(payload.iterations)||10000));
    return{report:buildDraftReport({state:payload.state,userSlot:Number(payload.userSlot),iterations})}
  }
  throw new Error(`Unknown extension engine request: ${type}`)
}
