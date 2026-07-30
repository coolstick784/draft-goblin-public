import test from "node:test";
import assert from "node:assert/strict";
import {refreshSleeperProjections,sleeperProjectionRows} from "../server/sleeper-projections.js";

test("Sleeper fallback projections select the requested scoring and current active players",()=>{
  const rows=[
    {season:"2026",player_id:"1",stats:{pts_std:100,pts_half_ppr:110,pts_ppr:120,adp_std:20,adp_half_ppr:21,adp_ppr:22},player:{first_name:"Active",last_name:"Runner",position:"RB",team:"BUF",injury_status:"Questionable"}},
    {season:"2025",player_id:"2",stats:{pts_ppr:300,adp_ppr:1},player:{first_name:"Old",last_name:"Player",position:"WR",team:"KC"}},
    {season:"2026",player_id:"3",stats:{pts_ppr:50,adp_ppr:999},player:{first_name:"Free",last_name:"Agent",position:"WR",team:null}},
    {season:"2026",player_id:"DAL",stats:{pts_ppr:90,adp_ppr:150},player:{first_name:"Dallas",last_name:"Cowboys",position:"DEF",team:"DAL"}},
  ];
  const players=sleeperProjectionRows(rows,{season:2026,scoring:"PPR"});
  assert.equal(players.length,2);
  assert.deepEqual(players[0],{id:"1",name:"Active Runner",position:"RB",team:"BUF",points:120,adp:22,injuryStatus:"Questionable",season:2026,scoring:"PPR"});
  assert.equal(players[1].position,"DST");
});

test("Sleeper runtime refreshes projections from the live endpoint",async()=>{
  const rows=[{season:"2091",player_id:"live",stats:{pts_ppr:201,adp_ppr:12},player:{first_name:"Live",last_name:"Player",position:"WR",team:"BUF"}}];
  let request;
  const result=await refreshSleeperProjections({season:2091,scoring:"PPR",fetchImpl:async(url,options)=>{request={url:String(url),options};return{ok:true,status:200,json:async()=>rows}}});
  assert.equal(result.access,"live-api");
  assert.equal(result.players[0].points,201);
  assert.match(request.url,/projections\/nfl\/2091/);
  assert.equal(request.options.cache,"no-store");
});
