import test from"node:test";
import assert from"node:assert/strict";
import{calibratePlayerProjectionRows,playerProviderConsensus}from"../extension/projection-range-guard.js";

const mean=values=>values.reduce((sum,value)=>sum+value,0)/values.length;

test("provider target is calculated for each player with the established source weights",()=>{
  assert.equal(playerProviderConsensus({espn:300,sleeper:280,fantasyPros:290}),290);
  assert.equal(playerProviderConsensus({espn:300,fantasyPros:290}),294.6512);
  assert.equal(playerProviderConsensus({}),null);
});

test("player-level calibration removes position-tail bias while retaining bounded individual signal",()=>{
  const rows=[];
  for(const position of["QB","RB","WR","TE","K","DST"]){
    for(let rank=0;rank<30;rank++){
      const target=350-rank*7-(position==="QB"?0:40),tailBias=rank<10?-60:rank>=20?45:0,individual=(rank%3-1)*8;
      rows.push({position,rawCandidate:target+tailBias+individual,providerPoints:{espn:target+5,sleeper:target-5,fantasyPros:target}});
    }
  }
  const calibrated=calibratePlayerProjectionRows(rows),joined=rows.map((row,index)=>({...row,...calibrated[index]}));
  for(const row of joined)assert.ok(Math.abs(row.value-row.providerConsensus)<20,"every player must remain inside the smooth consensus band");
  for(const position of["QB","RB","WR","TE","K","DST"]){
    const group=joined.filter(row=>row.position===position).sort((a,b)=>b.providerConsensus-a.providerConsensus),top=group.slice(0,10),bottom=group.slice(-10);
    assert.ok(Math.abs(mean(top.map(row=>row.value-row.providerConsensus)))<2,`${position} top-tier bias should be removed`);
    assert.ok(Math.abs(mean(bottom.map(row=>row.value-row.providerConsensus)))<2,`${position} bottom-tier bias should be removed`);
  }
  assert.ok(joined.some(row=>Math.abs(row.value-row.providerConsensus)>.5),"the owned player-specific signal should not be erased");
});

test("calibration degrades safely when a player or provider target is unavailable",()=>{
  const [noOwned,noProviders]=calibratePlayerProjectionRows([{position:"RB",rawCandidate:null,providerPoints:{espn:200}},{position:"RB",rawCandidate:175,providerPoints:{}}]);
  assert.equal(noOwned.value,null);
  assert.equal(noOwned.providerConsensus,200);
  assert.equal(noProviders.value,175);
  assert.equal(noProviders.providerConsensus,null);
});
