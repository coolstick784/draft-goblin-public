import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { analyzeEspnDraftPaste, parseEspnDraftPaste } from "../scripts/analyze-espn-draft-paste.js";
import { snakeSlot } from "../shared/domain.js";

function incompletePicksExport(){
  const teams=2,rounds=16,userSlot=1,owner=pickNo=>snakeSlot(pickNo,teams)===userSlot?"we go's Wild Team":"Team 2",board=[];
  for(let round=1;round<=rounds;round++){
    board.push(`Round ${round}`,"Pick","Player","Team","2025 PTS","PROJ PTS");
    for(let roundPick=1;roundPick<=teams;roundPick++){
      const pickNo=(round-1)*teams+roundPick,position=pickNo%2?"RB":"WR";
      board.push(String(pickNo),`Player ${pickNo}`,pickNo%2?"BUF":"DAL",position,owner(pickNo),String(100+pickNo),String(120+pickNo));
    }
  }
  const picks=[];
  for(let pickNo=4;pickNo<=teams*rounds;pickNo++){
    const round=Math.ceil(pickNo/teams),roundPick=(pickNo-1)%teams+1,position=pickNo%2?"RB":"WR";
    picks.push(`Player ${pickNo} / ${pickNo%2?"BUF":"DAL"} ${position}`,`R${round}, P${roundPick} - ${owner(pickNo)}`,"");
  }
  return["ESPN Fantasy Football Draft","All Rounds",...board,"Picks",...picks].join("\n");
}

test("ESPN paste parser fills a truncated Picks prefix from the complete Board",()=>{
  const parsed=parseEspnDraftPaste(incompletePicksExport(),{teams:2});
  assert.equal(parsed.picks.length,32);
  assert.equal(parsed.userSlot,1);
  assert.equal(parsed.picks[0].rank,undefined);
  assert.deepEqual(parsed.picks.slice(0,4).map(pick=>({pickNo:pick.pickNo,name:pick.name,slot:pick.slot})),[
    {pickNo:1,name:"Player 1",slot:1},
    {pickNo:2,name:"Player 2",slot:2},
    {pickNo:3,name:"Player 3",slot:2},
    {pickNo:4,name:"Player 4",slot:1}
  ]);
});

test("latest 12-team ESPN board preserves Chargers at pick 183 and exact final title odds",()=>{
  const text=fs.readFileSync(new URL("./fixtures/espn-slot10-chargers-pick183.txt",import.meta.url),"utf8"),parsed=parseEspnDraftPaste(text,{teams:12});
  assert.equal(parsed.picks.length,192);
  assert.equal(new Set(parsed.picks.map(pick=>pick.pickNo)).size,192);
  assert.equal(parsed.userSlot,10);
  assert.deepEqual(parsed.picks.find(pick=>pick.pickNo===183),{pickNo:183,slot:10,name:"Chargers D/ST",team:"LAC",position:"DST",owner:"we go's Wild Team",platformPoints:94,rank:181});
  const result=analyzeEspnDraftPaste(text,{iterations:10000,teams:12}),defense=result.roster.find(pick=>pick.pickNo===183);
  assert.equal(result.roster.length,16);
  assert.deepEqual({playerId:defense.playerId,name:defense.name,position:defense.position,team:defense.team},{playerId:"LAC",name:"Los Angeles Chargers",position:"DST",team:"LAC"});
  assert.equal(result.report.iterations,10000);
  assert.equal(result.report.titleRank,3);
  assert.equal(result.report.titleChance,.09356);
});
