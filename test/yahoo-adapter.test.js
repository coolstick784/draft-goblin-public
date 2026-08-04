import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source=fs.readFileSync(new URL("../extension/adapters/yahoo.js",import.meta.url),"utf8");
function helpers(){
  const context=vm.createContext({URL,globalThis:{__draftChampionYahooTestMode:true}});
  vm.runInContext(source,context,{filename:"yahoo.js"});
  return context.globalThis.__draftChampionYahooHelpers;
}

test("Yahoo draft links parse only live football draft rooms",()=>{
  const h=helpers();
  assert.equal(JSON.stringify(h.yahooDraftInfo("https://football.fantasysports.yahoo.com/draftclient/f1/8103584/3?auth=")),JSON.stringify({draftId:"8103584",userSlot:3}));
  assert.equal(h.yahooDraftInfo("https://football.fantasysports.yahoo.com/mock_lobby"),null);
  assert.equal(h.yahooDraftInfo("https://sports.yahoo.com/football"),null);
});

test("Yahoo roster labels preserve FLEX W/R/T slots and scoring",()=>{
  const h=helpers();
  const settings=h.settingsFromRoster({teams:14,rounds:15,labels:["QB","WR","WR","RB","RB","TE","FLEX","K","DEF","BN","BN","BN","BN","BN","BN"],scoringText:"Half PPR"});
  assert.equal(JSON.stringify(settings.slots),JSON.stringify({QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:6}));
  assert.equal(settings.scoring.reception,.5);
  assert.equal(settings.teams,14);
});

test("Yahoo official settings fix league rounds and scoring independently of mounted roster rows",()=>{
  const h=helpers(),settings=h.settingsFromYahooService({num_teams:14,settings:{roster_positions:[{position:"QB",count:1},{position:"WR",count:2},{position:"RB",count:2},{position:"TE",count:1},{position:"W/R/T",count:1},{position:"K",count:1},{position:"DEF",count:1},{position:"BN",count:6}],stat_categories:[{stat_id:5,stat_modifier:4},{stat_id:10,stat_modifier:6},{stat_id:11,stat_modifier:.5},{stat_id:13,stat_modifier:6}]}});
  assert.equal(settings.teams,14);
  assert.equal(settings.rounds,15);
  assert.deepEqual(JSON.parse(JSON.stringify(settings.slots)),{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:6});
  assert.equal(settings.scoring.reception,.5);
});

test("Yahoo player rows normalize visible projection and ADP fields",()=>{
  const h=helpers();
  const [player]=h.normalizePlayers([{id:"40059",name:"J. Gibbs",position:"Running Back",team:"Det",adp:"1.8",platformProjection:"306.97",injuryStatus:"Questionable"}],2026);
  assert.equal(player.position,"RB");
  assert.equal(player.platformProjection,306.97);
  assert.equal(player.adp,1.8);
  assert.equal(player.projectionSeason,2026);
});

test("Yahoo official catalog supplies identity and projections for drafted feed ids",()=>{
  const h=helpers(),rows=h.catalogRowsFromService({player_list:[{id:40059,fname:"Jahmyr",lname:"Gibbs",team_abbr:"Det",display_pos:"RB","average-pick":"1.8",projected:{points:"306.97"}}]});
  const [player]=h.normalizePlayers(rows,2026);
  assert.equal(player.id,"40059");
  assert.equal(player.name,"Jahmyr Gibbs");
  assert.equal(player.position,"RB");
  assert.equal(player.platformProjection,306.97);
  assert.equal(player.projectionSource,"Yahoo official draft projection");
});

test("Yahoo simulations receive the full projected catalog, with visible overrides and drafted players disabled",()=>{
  const h=helpers(),catalog=h.normalizePlayers([
    {id:"1",name:"Official One",position:"RB",team:"DET",platformProjection:200,adp:20,projectionSource:"Yahoo official draft projection"},
    {id:"2",name:"Official Two",position:"WR",team:"GB",platformProjection:180,adp:30,projectionSource:"Yahoo official draft projection"},
    {id:"3",name:"No Projection",position:"TE",team:"BAL",platformProjection:0,adp:40}
  ],2026),visible=h.normalizePlayers([{id:"2",name:"Visible Two",position:"WR",team:"GB",platformProjection:190,adp:25}],2026);
  const pool=h.mergePlayerPool(catalog,visible,[{pickNo:1,playerId:"1"}]),byId=new Map(pool.map(player=>[player.id,player]));
  assert.equal(byId.get("1").eligibleForRecommendation,false);
  assert.equal(byId.get("2").name,"Visible Two");
  assert.equal(byId.get("2").platformProjection,190);
  assert.equal(byId.get("2").eligibleForRecommendation,true);
  assert.equal(byId.has("3"),false);
});

test("Yahoo picks are contiguous, snake-slotted, and fail closed on gaps",()=>{
  const h=helpers();
  const good=h.normalizePicks([{pickNo:1,playerId:"40059",name:"J. Gibbs"},{pickNo:2,playerId:"40055",name:"B. Robinson"}],14);
  assert.equal(good.error,"");
  assert.equal(JSON.stringify(good.picks.map(pick=>pick.slot)),JSON.stringify([1,2]));
  const gap=h.normalizePicks([{pickNo:1,playerId:"40059"},{pickNo:3,playerId:"x"}],14);
  assert.match(gap.error,/not contiguous/);
  assert.equal(h.currentPickFromTexts(["Round 2, Pick 15"],14),29);
});

test("Yahoo pick history survives when the Picks panel is temporarily unmounted",()=>{
  const h=helpers(),prior=[{pickNo:1,playerId:"a"},{pickNo:2,playerId:"b"}],visible=[];
  const retained=h.mergePickRows(prior,visible,14);
  assert.equal(retained.error,"");
  assert.deepEqual(Array.from(retained.picks,pick=>pick.playerId),["a","b"]);
  const advanced=h.mergePickRows(retained.picks,[{pickNo:3,playerId:"c"}],14);
  assert.deepEqual(Array.from(advanced.picks,pick=>pick.playerId),["a","b","c"]);
});

test("Yahoo history comes from the read-only draft feed without changing Yahoo tabs",()=>{
  const h=helpers(),full=h.parseDraftFeedMessage("P|1=40059,1,0|2=40055,2,0",14),pick=h.parseDraftFeedMessage("0|3|33393|3|WR|0",14),clock=h.parseDraftFeedMessage("D|4|4|30",14);
  assert.equal(full.type,"picks");
  assert.deepEqual(Array.from(full.rows,row=>[row.pickNo,row.playerId,row.slot]),[[1,"40059",1],[2,"40055",2]]);
  assert.deepEqual(JSON.parse(JSON.stringify(pick.row)),{pickNo:3,playerId:"33393",slot:3,position:"WR"});
  assert.equal(clock.currentPickNo,4);
  assert.match(source,/wss:\/\//);
  assert.match(source,/\["9", info\.draftId, info\.userSlot/);
  assert.doesNotMatch(source,/\.click\(\)/);
  assert.doesNotMatch(source,/mainDraftControls|boardHydrating|restorePlayersAfterHydration/);
  assert.doesNotMatch(source,/querySelectorAll\("body \*"\)/);
  assert.doesNotMatch(source,/setTimeout\(check, 40\)/);
  assert.doesNotMatch(source,/characterData: true/);
  assert.equal(helpers().currentPickFromTexts(["Tay's Pick · Round 3, Pick 2\nPlayers\nQueue"],14),30);
});

test("Yahoo polling is single-flight and does not watch the entire draft DOM",()=>{
  assert.match(source,/publishInFlight = false, publishQueued = false/);
  assert.match(source,/if \(publishInFlight\) \{ publishQueued = true; return; \}/);
  assert.match(source,/setInterval\(requestPublish, 2000\)/);
  assert.doesNotMatch(source,/new MutationObserver/);
  assert.doesNotMatch(source,/document\.body\?\.innerText/);
});

test("Yahoo partial Picks renders append safely instead of becoming adapter errors",()=>{
  const h=helpers(),prior=[{pickNo:1,playerId:"a",slot:1},{pickNo:2,playerId:"b",slot:2}];
  assert.deepEqual(Array.from(h.appendContiguousPicks(prior,[{pickNo:4,playerId:"d"}],14),pick=>pick.playerId),["a","b"]);
  assert.deepEqual(Array.from(h.appendContiguousPicks(prior,[{pickNo:3,playerId:"c"},{pickNo:5,playerId:"e"},{pickNo:4,playerId:"d"}],14),pick=>pick.playerId),["a","b","c","d","e"]);
});
