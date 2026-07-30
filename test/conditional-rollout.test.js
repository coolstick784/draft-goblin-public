import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings, snakeSlot } from "../shared/domain.js";
import { availabilityProbability } from "../core/availability.js";
import { conditionalMultiPickRollouts } from "../core/conditional-rollout.js";
import { conditionalRolloutCandidateFrontier, conditionalRolloutCoverageBonus, recommend } from "../core/recommend.js";

function rolloutState(){
  const settings=normalizeSettings({teams:12,rounds:16,slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:0,DST:0,BENCH:9},scoring:{reception:1}});
  const player=(id,position,mean,ceiling,adp)=>({id,name:id,position,team:"TEST",mean,floor:mean*.7,ceiling,adp,risk:.4,scarcity:position==="RB"?.7:.5,eligibleForRecommendation:true});
  const rb1=player("RB1","RB",290,390,10),rbNow=player("RB now","RB",270,365,15),wrNow=player("scarce WR","WR",265,405,16),rbFallback=player("RB fallback","RB",240,350,35),wrCliff=player("WR cliff","WR",175,230,27),te=player("TE value","TE",225,325,36),qb=player("QB value","QB",260,330,38);
  const depth=Array.from({length:32},(_,index)=>player(`depth-${index}`,["RB","WR","TE","QB"][index%4],120-index,170-index,50+index));
  const players=[rb1,rbNow,wrNow,rbFallback,wrCliff,te,qb,...depth],picks=Array.from({length:14},(_,index)=>({pickNo:index+1,playerId:index===9?rb1.id:`taken-${index}`,slot:snakeSlot(index+1,12)}));
  return{state:{platform:"fixture",draftId:"conditional-rollout",projectionSeason:2026,settings,players,picks},roster:[rb1],draftable:players.filter(candidate=>candidate.id!==rb1.id),rbNow,wrNow};
}

const serialized=result=>({active:result.active,futurePicks:result.futurePicks,scenarios:result.scenarios,results:[...result.results]});

test("conditional rollout is deterministic and values the scarce starter before a survivable fallback",()=>{
  const {state,roster,draftable,rbNow,wrNow}=rolloutState(),input={candidates:[rbNow,wrNow],roster,draftable,state,userSlot:10,selectionPick:15,depth:2,scenarios:24,beamWidth:5,choiceWidth:5},first=conditionalMultiPickRollouts(input),second=conditionalMultiPickRollouts(input);
  assert.deepEqual(serialized(first),serialized(second));
  assert.deepEqual(first.futurePicks,[34,39]);
  assert.equal(first.scenarios,24);
  assert.ok(first.results.get(wrNow.id).score>first.results.get(rbNow.id).score);
  assert.deepEqual(first.results.get(wrNow.id).path.map(player=>player.position),["RB","QB"]);
  assert.ok(first.results.get(wrNow.id).pathShare>0);
});

test("recommendation integration disables wait-path rollouts while the starting TE slot is open",()=>{
  const {state,rbNow,wrNow}=rolloutState(),rows=recommend({state,userSlot:10,strategy:"titleOnly",limit:8}),rb=rows.find(item=>item.player.id===rbNow.id),wr=rows.find(item=>item.player.id===wrNow.id);
  assert.ok(rb&&wr,`shortlist was ${rows.map(item=>item.player.name).join(", ")}`);
  assert.deepEqual(wr.conditionalRolloutPicks,[]);
  assert.equal(wr.conditionalRolloutScenarios,0);
  assert.equal(wr.conditionalRolloutPath.length,0);
  assert.equal(wr.conditionalRolloutBonus,0);
  assert.equal(rb.conditionalRolloutBonus,0);
});

test("an incomplete dominant rollout path cannot earn a bonus when the horizon can fill every core starter",()=>{
  assert.equal(conditionalRolloutCoverageBonus({bonus:.28,coreDebtAfter:1,futurePickCount:2,covered:false}),0);
  assert.equal(conditionalRolloutCoverageBonus({bonus:.28,coreDebtAfter:1,futurePickCount:2,covered:true}),.28);
  assert.equal(conditionalRolloutCoverageBonus({bonus:.28,coreDebtAfter:1,futurePickCount:2,coverageProbability:.5}),.14);
  assert.equal(conditionalRolloutCoverageBonus({bonus:.28,coreDebtAfter:3,futurePickCount:2,covered:false}),.28);
});

test("terminal rollout debt fills an open core starter instead of taking a second tight end",()=>{
  const settings=normalizeSettings({teams:12,rounds:16,slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:0,DST:0,BENCH:9}}),player=(id,position,mean,ceiling,adp)=>({id,name:id,position,team:"TEST",mean,floor:mean*.7,ceiling,adp,adpSd:8,eligibleForRecommendation:true}),roster=[player("QB","QB",360,450,39),player("RB1","RB",260,370,15),player("WR1","WR",280,400,10),player("WR2","WR",250,350,34)],flex=player("upside WR","WR",210,340,58),te1=player("TE1","TE",210,330,63),te2=player("TE2","TE",205,325,76),rbFallback=player("RB fallback","RB",190,285,82),depth=Array.from({length:48},(_,index)=>player(`depth-${index}`,["RB","WR","TE","QB"][index%4],130-index,190-index,90+index)),players=[...roster,flex,te1,te2,rbFallback,...depth],state={projectionSeason:2026,settings,players,picks:[]};
  const result=conditionalMultiPickRollouts({candidates:[flex],roster,draftable:players.filter(candidate=>!roster.includes(candidate)),state,userSlot:10,selectionPick:58}),path=result.results.get(flex.id).path;
  assert.deepEqual(result.futurePicks,[63,82]);
  assert.deepEqual(path.map(player=>player.position),["TE","RB"]);
  assert.equal(path.some(player=>player.id===te2.id),false);
});

test("FLEX uses a common title scale instead of double-counting tight-end scarcity",()=>{
  const settings=normalizeSettings({teams:10,rounds:16,slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:0,DST:0,BENCH:9}}),player=(id,position,mean,ceiling,adp)=>({id,name:id,position,team:"TEST",mean,floor:mean*.7,ceiling,adp,adpSd:8,eligibleForRecommendation:true}),roster=[player("RB1","RB",350,450,5),player("WR1","WR",270,380,16)],mcBride=player("McBride","TE",250,350,28),dak=player("Dak","QB",300,400,106),loveland=player("Loveland","TE",190,285,45),rb2=player("RB2","RB",225,315,48),wr2=player("WR2","WR",220,310,50),depth=[];
  for(const position of ["QB","RB","WR","TE"])for(let index=0;index<35;index++)depth.push(player(`${position}-depth-${index}`,position,180-index*2+(position==="TE"?-60:0),240-index*2+(position==="TE"?-70:0),70+index));
  const players=[...roster,mcBride,dak,loveland,rb2,wr2,...depth],picks=Array.from({length:24},(_,index)=>({pickNo:index+1,playerId:`taken-${index}`,slot:snakeSlot(index+1,10)})),state={platform:"fixture",draftId:"flex-common-scale",projectionSeason:2026,settings,players,picks},result=conditionalMultiPickRollouts({candidates:[mcBride],roster,draftable:players.filter(candidate=>!roster.includes(candidate)),state,userSlot:5,selectionPick:25}),path=result.results.get(mcBride.id).path;
  assert.deepEqual(result.futurePicks,[36,45]);
  assert.equal(path.some(player=>player.id===loveland.id),false);
  assert.ok(path.some(player=>["RB","WR"].includes(player.position)),`path was ${path.map(player=>player.position).join(", ")}`);
});

test("rollout frontier remains bounded and always covers available core positions",()=>{
  const ranked=Array.from({length:32},(_,index)=>({player:{id:`p-${index}`,position:["RB","WR","QB","TE"][Math.floor(index/8)]},planScore:32-index,rawProjectionScore:index,titleAsymmetryScore:index,futureStarterAccess:index}));
  const frontier=conditionalRolloutCandidateFrontier(ranked,{limit:16}),positions=new Set(frontier.map(item=>item.player.position));
  assert.equal(frontier.length,16);
  assert.deepEqual(positions,new Set(["QB","RB","WR","TE"]));
});

test("representative follow-up plans exclude one-off survivors from the live mock",()=>{
  const settings=normalizeSettings({teams:12,rounds:16,slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:0,DST:0,BENCH:9},scoring:{reception:1}}),player=(id,position,mean,ceiling,adp)=>({id,name:id,position,team:"TEST",mean,floor:mean*.7,ceiling,adp,eligibleForRecommendation:true}),cmc=player("Christian McCaffrey","RB",300,430,5),henry=player("Derrick Henry","RB",290,420,18),mcBride=player("Trey McBride","TE",250,350,22),wr=player("WR fallback","WR",235,340,27),qb=player("QB fallback","QB",315,400,33),depth=Array.from({length:48},(_,index)=>player(`depth-${index}`,["RB","WR","TE","QB"][index%4],210-index,300-index,34+index)),players=[cmc,henry,mcBride,wr,qb,...depth],state={projectionSeason:2026,settings,players,picks:[]},result=conditionalMultiPickRollouts({candidates:[cmc],roster:[],draftable:players.filter(candidate=>candidate!==cmc),state,userSlot:6,selectionPick:6}),plan=result.results.get(cmc.id).path;
  assert.deepEqual(result.futurePicks,[19,30]);
  assert.equal(plan.some(item=>item.id===henry.id&&item.pickNo===30),false);
  for(const item of plan){
    const source=players.find(candidate=>candidate.id===item.id);
    assert.ok(availabilityProbability(source,item.pickNo,6,{season:2026,settings})>=.20,`${item.id} was only a one-off survivor at ${item.pickNo}`);
  }
});
