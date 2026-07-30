import fs from"node:fs";
import{once}from"node:events";
import{performance}from"node:perf_hooks";
import{server}from"../server/index.js";
import{recommend}from"../core/recommend.js";
import{fixtureState}from"../test/fixture.js";

const RUNS=Math.max(1,Number(process.env.DRAFT_GOBLIN_P100_RUNS)||10),TARGET_MS=22_000,defaultReplayPath=new URL("../data/generated/live-deep-replay.local.json",import.meta.url),replayPath=process.env.DRAFT_GOBLIN_REPLAY_PATH||defaultReplayPath,hasReplay=fs.existsSync(replayPath),captured=hasReplay?JSON.parse(fs.readFileSync(replayPath,"utf8")):null,percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];

function heavyLateDraft(run){
  const state=fixtureState({teams:12,rounds:16,picked:133}),source=[...state.players];
  for(let index=0;index<241;index++){
    const base=source[(133+index)%source.length],scale=.72-(index%11)*.004;
    state.players.push({...base,id:`p100-extra-${run}-${index}`,platformPlayerId:`p100-extra-${run}-${index}`,name:`P100 depth ${index}`,mean:Number(base.mean||0)*scale,floor:Number(base.floor||0)*scale,ceiling:Number(base.ceiling||0)*scale,adp:205+index,adpSd:Number(base.adpSd||10)})
  }
  state.draftId=`deep-p100-${Date.now()}-${run}`;state.draftRunId=`run-${run}`;return state
}

async function exactRequest(port,run){
  const started=performance.now(),syntheticState=hasReplay?null:heavyLateDraft(run),base=hasReplay?structuredClone(captured.input):{state:syntheticState,userSlot:2,strategy:"titleOnly",sourceProfile:"projectionLed",limit:8,iterations:10_000,seed:91000+run},input={...base,iterations:10_000,seed:(Number(base.seed)||91000)+run+1},precomputedRecommendations=hasReplay?base.precomputedRecommendations:recommend(input),body=JSON.stringify({...input,precomputedRecommendations}),response=await fetch(`http://127.0.0.1:${port}/v1/evaluate/deep`,{method:"POST",headers:{"content-type":"application/json",accept:"application/x-ndjson"},body});
  if(!response.ok)throw new Error(`deep evaluation returned ${response.status}`);
  const events=(await response.text()).trim().split("\n").map(line=>JSON.parse(line)),progress=events.filter(event=>event.type==="progress"),error=events.find(event=>event.type==="error"),result=events.find(event=>event.type==="result")?.data;
  if(error)throw new Error(error.error);if(!result||result.iterations!==10_000||progress.at(-1)?.completed!==10_000)throw new Error("deep evaluation did not complete all 10,000 scenarios");
  const elapsedMs=Number((performance.now()-started).toFixed(1)),serverElapsedMs=Number(result.serverElapsedMs)||null;
  return{run:run+1,elapsedMs,serverElapsedMs,clientOverheadMs:serverElapsedMs==null?null:Number((elapsedMs-serverElapsedMs).toFixed(1)),requestBytes:Buffer.byteLength(body),players:input.state.players.length,picks:input.state.picks.length,candidates:Array.isArray(precomputedRecommendations)?precomputedRecommendations.length:0,workerCount:result.workerCount,progressEvents:progress.length}
}

server.listen(0,"127.0.0.1");await once(server,"listening");
try{
  const port=server.address().port,rows=[];for(let run=0;run<RUNS;run++){const row=await exactRequest(port,run);rows.push(row);console.error(`run ${row.run}/${RUNS}: ${row.elapsedMs} ms`)}
  const values=rows.map(row=>row.elapsedMs),serverValues=rows.map(row=>row.serverElapsedMs).filter(Number.isFinite),report={fixture:hasReplay?"captured-chrome-request":"synthetic-heavy",capturePath:hasReplay?String(replayPath):null,capturedAt:captured?.capturedAt||null,runs:RUNS,targetMs:TARGET_MS,p50Ms:percentile(values,.5),p90Ms:percentile(values,.9),p100Ms:Math.max(...values),serverP100Ms:serverValues.length?Math.max(...serverValues):null,rows,pass:Math.max(...values)<TARGET_MS};console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1
}finally{await new Promise(resolve=>server.close(resolve))}
