import{parentPort,workerData}from"node:worker_threads";
import{evaluateDraft}from"../core/evaluate.js";
try{const recommendations=evaluateDraft({...workerData.input,includeSimulation:true,iterations:workerData.iterations});parentPort.postMessage({ok:true,recommendations,iterations:workerData.iterations})}catch(error){parentPort.postMessage({ok:false,error:error.message})}