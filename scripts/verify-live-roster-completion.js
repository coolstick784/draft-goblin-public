import { fixtureState } from "../test/fixture.js";

const state=fixtureState({teams:10,rounds:9,picked:0}),used=new Set();
state.draftId=`live-roster-completion-${Date.now()}`;
state.settings.slots={...state.settings.slots,QB:1,RB:1,WR:1,TE:1,FLEX:0,K:1,DST:1,BENCH:2};
state.picks=["QB","RB","WR","RB","WR","RB"].map((position,index)=>{const player=state.players.find(candidate=>candidate.position===position&&!used.has(candidate.id));used.add(player.id);return{pickNo:index+1,playerId:player.id,slot:1}});
state.updatedAt=Date.now();
const body=JSON.stringify({state,userSlot:1,iterations:120,refineIterations:1000}),request=()=>fetch("http://localhost:8787/v1/evaluate",{method:"POST",headers:{"content-type":"application/json","x-installation-id":"live-roster-completion-proof"},body}).then(async response=>{if(!response.ok)throw new Error(`HTTP ${response.status}: ${await response.text()}`);return response.json()});
let result=await request(),deadline=Date.now()+20000;
while(result.simulationStatus!=="refined"&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));result=await request()}
const recommendations=result.recommendations.map(item=>({position:item.player.position,required:item.rosterCompletionRequired,picksLeft:item.remainingPicks,missing:item.missingRequiredSlots})),valid=result.simulationStatus==="refined"&&recommendations.length>0&&recommendations.every(item=>item.required&&item.picksLeft===3&&item.missing===3&&["TE","K","DST"].includes(item.position))&&["TE","K","DST"].every(position=>recommendations.some(item=>item.position===position));
console.log(JSON.stringify({status:result.simulationStatus,recommendations,valid},null,2));
if(!valid)process.exitCode=1;
