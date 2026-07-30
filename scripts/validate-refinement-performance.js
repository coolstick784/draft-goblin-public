import os from "node:os";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessRankingReadiness, evaluateDraft } from "../core/evaluate.js";
import { fixtureState } from "../test/fixture.js";
import { state as savedSleeperState } from "./audit-live-sleeper.js";

const DEFAULT_READY=Number(process.env.DC_READY_ITERATIONS||1000);
const DEFAULT_FULL=Number(process.env.DC_FULL_ITERATIONS||10000);
const DEFAULT_LIMIT=Number(process.env.DC_CANDIDATE_LIMIT||8);

function elapsed(start){return Number((performance.now()-start).toFixed(1))}
function topIds(items,count=8){return items.slice(0,count).map(item=>String(item.player.id))}
function sameSetFraction(a,b){const right=new Set(b);return a.filter(id=>right.has(id)).length/Math.max(1,a.length)}
function displayTenths(item){return Number(item.simulation?.displayTitleTenths??Math.round(Number(item.simulation?.displayChampionshipProbability||item.simulation?.championshipProbability||0)*1000))}
export function equivalentTopCandidates(ready,full){
  if(!ready.length||!full.length)return false;
  if(String(ready[0].player.id)===String(full[0].player.id))return true;
  const fullTopAtReady=ready.find(item=>String(item.player.id)===String(full[0].player.id)),readyTopAtFull=full.find(item=>String(item.player.id)===String(ready[0].player.id));
  return Boolean(fullTopAtReady&&readyTopAtFull&&displayTenths(ready[0])===displayTenths(fullTopAtReady)&&displayTenths(full[0])===displayTenths(readyTopAtFull));
}
export function supportedInversions(ready,full){
  const fullIndex=new Map(full.map((item,index)=>[String(item.player.id),index])),violations=[];
  for(let i=0;i<ready.length;i++)for(let j=i+1;j<ready.length;j++){
    const a=ready[i],b=ready[j],ai=fullIndex.get(String(a.player.id)),bi=fullIndex.get(String(b.player.id));
    if(ai===undefined||bi===undefined||ai<=bi)continue;
    // A distinct displayed percentage is a claim; a deterministic football
    // tiebreak inside the same percentage group is not a probability claim.
    const readyA=displayTenths(a),readyB=displayTenths(b),fullA=displayTenths(full[ai]),fullB=displayTenths(full[bi]);
    // Only reject a reversal when both stages make distinct, contradictory
    // displayed-probability claims. Full-run ties are contractually equivalent.
    if(readyA>readyB&&fullA<fullB)violations.push({readyHigher:a.player.name,fullHigher:b.player.name,ready:[readyA,readyB],full:[fullA,fullB]});
  }
  return violations;
}
function freshInput(input){return{...input,state:{...input.state,updatedAt:Date.now()}}}
function deterministic(input,iterations){
  const first=evaluateDraft({...freshInput(input),iterations}),second=evaluateDraft({...freshInput(input),iterations});
  return JSON.stringify(first.map(x=>[x.player.id,displayTenths(x),x.simulation?.rawProbability]))===JSON.stringify(second.map(x=>[x.player.id,displayTenths(x),x.simulation?.rawProbability]));
}
function caseState({teams,picked,rounds=15}){const state=fixtureState({teams,rounds,picked});state.draftId=`performance-${teams}-${picked}`;return state}

export function validateRefinementPerformance({readyIterations=DEFAULT_READY,fullIterations=DEFAULT_FULL,limit=DEFAULT_LIMIT,cases}={}){
  const logicalCores=os.availableParallelism?.()||os.cpus().length||1,maxLightweightWorkers=Math.max(1,Math.min(4,logicalCores-1||1));
  const inputs=cases||[
    {name:"8-team early",state:caseState({teams:8,picked:8}),userSlot:3},
    {name:"10-team mid",state:caseState({teams:10,picked:70}),userSlot:7},
    {name:"12-team late",state:caseState({teams:12,picked:144}),userSlot:5},
    {name:"saved Sleeper mid-draft",state:{...savedSleeperState,draftId:`${savedSleeperState.draftId}-performance`,picks:savedSleeperState.picks.slice(0,90)},userSlot:savedSleeperState.userSlot||10},
  ];
  const rssBefore=process.memoryUsage().rss,cpuBefore=process.cpuUsage(),started=performance.now(),results=[];
  for(const entry of inputs){
    const base={state:entry.state,userSlot:entry.userSlot,strategy:"balanced",limit,seed:7719};
    const readyStarted=performance.now(),ready=evaluateDraft({...freshInput(base),iterations:readyIterations}),readyMs=elapsed(readyStarted);
    const fullStarted=performance.now(),full=evaluateDraft({...freshInput(base),iterations:fullIterations}),fullMs=elapsed(fullStarted);
    const readiness=assessRankingReadiness(ready,{iterations:readyIterations,targetIterations:fullIterations}),readyIds=topIds(ready,limit),fullIds=topIds(full,limit),overlap=sameSetFraction(readyIds,fullIds),inversions=supportedInversions(ready,full);
    results.push({name:entry.name,teams:entry.state.settings.teams,picks:entry.state.picks.length,readyMs,fullMs,readyTop:readyIds[0],fullTop:fullIds[0],topCandidateMatch:readyIds[0]===fullIds[0],topCandidateEquivalent:equivalentTopCandidates(ready,full),topSetOverlap:Number(overlap.toFixed(3)),unsupportedProbabilityInversions:inversions,deterministic:deterministic(base,Math.min(readyIterations,500)),readiness:{displayReady:readiness.displayReady,rankingReady:readiness.rankingReady,orderingDurable:readiness.orderingDurable,precisionReady:readiness.precisionReady,continueInBackground:readiness.continueInBackground,leadingGroup:readiness.leadingGroup,eliminated:readiness.eliminated,unresolved:readiness.unresolved,evidenceZ:readiness.evidenceZ}});
  }
  const wallMs=elapsed(started),cpu=process.cpuUsage(cpuBefore),rssGrowthMb=Number(((process.memoryUsage().rss-rssBefore)/1048576).toFixed(1)),qualityPass=results.every(x=>x.topCandidateEquivalent&&x.topSetOverlap>=.875&&!x.unsupportedProbabilityInversions.length&&x.deterministic),resourcePass=rssGrowthMb<=512;
  return{generatedAt:new Date().toISOString(),configuration:{readyIterations,fullIterations,limit,logicalCores,maxLightweightWorkers},hardware:{platform:process.platform,arch:process.arch,logicalCores,totalMemoryGb:Number((os.totalmem()/1073741824).toFixed(1))},performance:{wallMs,cpuMs:Number(((cpu.user+cpu.system)/1000).toFixed(1)),rssGrowthMb,fullScenarioCandidateRate:Number((inputs.length*limit*fullIterations/(wallMs/1000)).toFixed(0))},acceptance:{qualityPass,resourcePass,pass:qualityPass&&resourcePass,requirements:{topCandidateEquivalent:true,statisticalTieDefinition:"Both stages display the two candidates at the same title probability",topSetOverlap:0.875,maxRssGrowthMb:512,maxWorkers:maxLightweightWorkers,note:"The production latency gate is measured end-to-end by the server benchmark; this direct harness prevents hardware speed from being confused with prediction quality."}},cases:results};
}

if(process.argv[1]&&path.resolve(fileURLToPath(import.meta.url))===path.resolve(process.argv[1])){
  const report=validateRefinementPerformance(),serialized=JSON.stringify(report,null,2);if(process.env.DC_REPORT_PATH)fs.writeFileSync(process.env.DC_REPORT_PATH,serialized);console.log(serialized);if(!report.acceptance.pass)process.exitCode=1;
}
