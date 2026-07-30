import test from"node:test";
import assert from"node:assert/strict";
import{applyRoute,buildSeedRouteBeam,preservePositionCoverage}from"../scripts/optimize-espn-draft-hindsight.js";

test("route beam preserves a lower-ranked source-pick action for a shared candidate",()=>{
  const actions=[
    {pickNo:10,candidateId:"london",singleDelta:.03},
    {pickNo:15,candidateId:"london",singleDelta:.02},
    {pickNo:82,candidateId:"parker",singleDelta:.015},
  ],legalRoute=route=>!(route.some(action=>action.pickNo===10)&&route.some(action=>action.candidateId==="parker")),routes=buildSeedRouteBeam(actions,{limit:20,legalRoute}),best=routes[0];
  assert.deepEqual(best.route.map(action=>[action.pickNo,action.candidateId]),[[15,"london"],[82,"parker"]]);
  assert.ok(routes.some(row=>row.route.some(action=>action.pickNo===10&&action.candidateId==="london")));
  assert.ok(routes.every(row=>new Set(row.route.map(action=>action.candidateId)).size===row.route.length));
});

test("single-swap screening preserves cross-position coverage",()=>{
  const branch=(id,position,screen)=>({candidatePosition:position,screen,route:[{pickNo:58,candidateId:id}]}),branches=[
    branch("rb-one","RB",100),branch("rb-two","RB",99),branch("rb-three","RB",98),
    branch("wr","WR",80),branch("te","TE",70),branch("qb","QB",60)
  ],selected=preservePositionCoverage(branches,{limit:7}),ids=new Set(selected.map(row=>row.route[0].candidateId));
  assert.ok(ids.has("wr"));
  assert.ok(ids.has("te"));
  assert.ok(ids.has("qb"));
});

test("legal cascade allocation can move displaced picks between candidate owners",()=>{
  const player=(id,position)=>({id,name:id,position}),swift=player("swift","RB"),evans=player("evans","WR"),kraft=player("kraft","TE"),odunze=player("odunze","WR"),laporta=player("laporta","TE"),thomas=player("thomas","WR"),players=[swift,evans,kraft,odunze,laporta,thomas],byId=new Map(players.map(row=>[row.id,row])),ownerById=new Map([["odunze",1],["laporta",2],["thomas",3]]),baseRosters=[[swift,evans,kraft],[odunze],[laporta],[thomas]],route=[
    {actualId:"swift",candidateId:"odunze",ownerActualId:"swift"},
    {actualId:"evans",candidateId:"laporta",ownerActualId:"kraft"},
    {actualId:"kraft",candidateId:"thomas",ownerActualId:"evans"}
  ],result=applyRoute(baseRosters,0,route,byId,ownerById);
  assert.deepEqual(result.map(roster=>roster.map(row=>row.id)),[["odunze","laporta","thomas"],["swift"],["kraft"],["evans"]]);
  assert.equal(new Set(result.flat().map(row=>row.id)).size,players.length);
});
