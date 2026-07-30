import test from "node:test";
import assert from "node:assert/strict";
import { asymmetricProjectionShock, availabilityAdjustedLineupScore, createPairedScenario, pairedSeasonFinishOrder, SIMULATION_MODEL_VERSION } from "../core/simulate.js";
import { lineupPlayers, lineupScore } from "../core/roster.js";

const referenceLineupPlayers=(players,slots,selectionValue)=>{
  const flex=new Set(["RB","WR","TE"]),remaining=[...players],selected=[];
  for(const position of ["QB","RB","WR","TE","K","DST"]){
    const eligible=remaining.filter(player=>player.position===position).sort((a,b)=>selectionValue(b)-selectionValue(a)||String(a.id).localeCompare(String(b.id)));
    for(const chosen of eligible.slice(0,slots[position]||0)){selected.push(chosen);remaining.splice(remaining.indexOf(chosen),1)}
  }
  selected.push(...remaining.filter(player=>flex.has(player.position)).sort((a,b)=>selectionValue(b)-selectionValue(a)||String(a.id).localeCompare(String(b.id))).slice(0,slots.FLEX||0));
  return selected
};

test("optimized lineup selection is exactly equivalent to the prior selector",()=>{
  const positions=["QB","RB","WR","TE","K","DST"],players=Array.from({length:42},(_,index)=>({id:`player-${String(index).padStart(2,"0")}`,position:positions[index%positions.length],mean:100+(index*37)%113,selection:70+(index*53)%149}));
  for(let sample=0;sample<120;sample++){
    const ordered=[...players].sort((a,b)=>((Number(a.id.slice(-2))*17+sample*31)%127)-((Number(b.id.slice(-2))*17+sample*31)%127)),slots={QB:sample%3,RB:1+sample%3,WR:1+(sample+1)%3,TE:sample%2,K:(sample>>1)%2,DST:(sample>>2)%2,FLEX:sample%4},selectionValue=player=>player.selection;
    assert.deepEqual(lineupPlayers(ordered,slots,selectionValue),referenceLineupPlayers(ordered,slots,selectionValue))
  }
});

test("asymmetric projection ranges preserve upside and downside shape",()=>{
  const upside={mean:100,floor:80,ceiling:160},downside={mean:100,floor:40,ceiling:120};
  assert.ok(asymmetricProjectionShock(1,...Object.values(upside))>asymmetricProjectionShock(1,...Object.values(downside)));
  assert.ok(asymmetricProjectionShock(-1,...Object.values(upside))>asymmetricProjectionShock(-1,...Object.values(downside)));
  assert.match(SIMULATION_MODEL_VERSION,/asymmetric-player-outcomes/);
});

test("asymmetric projection shock remains centered on the projected mean",()=>{
  let sum=0;
  const samples=100000;
  for(let index=0;index<samples;index++)sum+=asymmetricProjectionShock(createPairedScenario(2026,index).normal("centering"),100,55,180);
  assert.ok(Math.abs(sum/samples)<.35);
});

test("symmetric projection ranges retain symmetric shocks",()=>{
  const positive=asymmetricProjectionShock(1.25,100,70,130),negative=asymmetricProjectionShock(-1.25,100,70,130);
  assert.ok(Math.abs(positive+negative)<1e-12);
});

test("lineup selection cannot see realized boom-or-bust outcomes",()=>{
  const incumbent={id:"incumbent",position:"WR",mean:200},bench={id:"bench",position:"WR",mean:180},realized=new Map([[incumbent,100],[bench,400]]),slots={WR:1};
  assert.equal(lineupScore([incumbent,bench],slots,player=>realized.get(player),player=>player.mean),100);
  assert.equal(lineupScore([incumbent,bench],slots,player=>realized.get(player)),400);
});

test("projected bench depth has nonzero title value without outcome-oracle lineup selection",()=>{
  const starter={id:"starter",position:"WR",mean:200},weak={id:"weak",position:"WR",mean:100},strong={id:"strong",position:"WR",mean:180},slots={WR:1};
  const weakScore=availabilityAdjustedLineupScore([starter,weak],slots,player=>player.mean,player=>player.mean),strongScore=availabilityAdjustedLineupScore([starter,strong],slots,player=>player.mean,player=>player.mean);
  assert.ok(strongScore>weakScore);assert.ok(strongScore<starter.mean);assert.match(SIMULATION_MODEL_VERSION,/depth-availability/)
});

test("equal projections value the more durable player and useful depth only offsets the loss",()=>{
  const slots={QB:0,RB:0,WR:0,TE:1,FLEX:0,K:0,DST:0},durable={id:"durable",position:"TE",mean:200,availability:{missedGameRate:.08}},fragile={id:"fragile",position:"TE",mean:200,availability:{missedGameRate:.3}},backup={id:"backup",position:"TE",mean:120};
  const score=roster=>availabilityAdjustedLineupScore(roster,slots,player=>player.mean,player=>player.mean);
  assert.ok(score([durable])>score([fragile]));
  assert.ok(score([fragile,backup])>score([fragile]));
  assert.ok(score([fragile,backup])<score([durable,backup]));
});

test("paired season outcomes do not depend on player order inside a roster",()=>{
  const player=(id,mean,floor,ceiling)=>({id,name:id,position:"WR",team:id,mean,floor,ceiling,risk:.5});
  const a=player("a",180,100,300),b=player("b",175,130,230),c=player("c",170,120,240),d=player("d",165,125,215);
  const settings={teams:2,playoffTeams:2,slots:{QB:0,RB:0,WR:2,TE:0,FLEX:0,K:0,DST:0}};
  const first=pairedSeasonFinishOrder([[a,b],[c,d]],settings,createPairedScenario(77,9));
  const reordered=pairedSeasonFinishOrder([[b,a],[d,c]],settings,createPairedScenario(77,9));
  assert.deepEqual(reordered,first);
});

test("an equal-mean boom-or-bust roster reaches both tails more often",()=>{
  const settings={teams:4,playoffTeams:2,slots:{QB:0,RB:0,WR:1,TE:0,FLEX:0,K:0,DST:0}},player=(id,mean,floor,ceiling)=>({id,position:"WR",mean,floor,ceiling,risk:.5}),opponents=[1,2,3].map(index=>[player(`opponent-${index}`,200,170,230)]),balanced=player("candidate",200,170,230),boomBust=player("candidate",200,80,320),counts={balancedTitles:0,balancedLasts:0,boomTitles:0,boomLasts:0};
  for(let iteration=0;iteration<4000;iteration++){const balancedOrder=pairedSeasonFinishOrder([[balanced],...opponents],settings,createPairedScenario(5,iteration)),boomOrder=pairedSeasonFinishOrder([[boomBust],...opponents],settings,createPairedScenario(5,iteration));counts.balancedTitles+=balancedOrder[0]===0;counts.balancedLasts+=balancedOrder.at(-1)===0;counts.boomTitles+=boomOrder[0]===0;counts.boomLasts+=boomOrder.at(-1)===0}
  assert.ok(counts.boomTitles>counts.balancedTitles);
  assert.ok(counts.boomLasts>counts.balancedLasts);
});
