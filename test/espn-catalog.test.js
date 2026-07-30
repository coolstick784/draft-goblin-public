import test from"node:test";
import assert from"node:assert/strict";
import{expandEspnCatalog}from"../extension/espn-catalog.js";
import{removeUnavailableRecommendations}from"../extension/sidepanel-state.js";

test("ESPN picks are reconciled while unseen baseline players remain ineligible",()=>{
  const state={platform:"espn",picks:[{pickNo:1,playerId:"Puka Nacua",name:"Puka Nacua",slot:1}],players:[{id:"Puka Nacua",name:"Puka Nacua",position:"WR",platformProjection:356.5,eligibleForRecommendation:true}]},baseline=[{id:"s1",name:"Puka Nacua",position:"WR",mean:300,eligibleForRecommendation:true},{id:"s2",name:"Bijan Robinson",position:"RB",mean:290,eligibleForRecommendation:true}],expanded=expandEspnCatalog(state,baseline);
  assert.equal(expanded.picks[0].playerId,"s1");assert.equal(expanded.players.length,2);assert.equal(expanded.players.find(player=>player.id==="s1").platformProjection,356.5);assert.equal(expanded.players.find(player=>player.id==="s1").eligibleForRecommendation,true);assert.equal(expanded.players.find(player=>player.id==="s2").eligibleForRecommendation,false);
});

test("non-ESPN catalogs are unchanged",()=>{const state={platform:"sleeper",players:[],picks:[]};assert.equal(expandEspnCatalog(state,[]),state)});

test("ESPN suffix aliases reconcile to the drafted baseline player",()=>{const state={platform:"espn",picks:[{pickNo:1,playerId:"James Cook III",name:"James Cook III",slot:1},{pickNo:2,playerId:"Travis Etienne Jr.",name:"Travis Etienne Jr.",slot:2}],players:[{id:"James Cook III",name:"James Cook III"},{id:"Travis Etienne Jr.",name:"Travis Etienne Jr."}]},baseline=[{id:"cook",name:"James Cook",position:"RB"},{id:"etienne",name:"Travis Etienne",position:"RB"}],expanded=expandEspnCatalog(state,baseline);assert.deepEqual(expanded.picks.map(pick=>pick.playerId),["cook","etienne"]);assert.equal(expanded.players.length,2)});

test("ESPN API and visible suffix aliases collapse into one player-board row",()=>{const state={platform:"espn",picks:[],players:[{id:"api-8151",name:"Kenneth Walker III",position:"RB",team:"KC",platformProjection:191,eligibleForRecommendation:true},{id:"Kenneth Walker",name:"Kenneth Walker",position:"RB",team:"KC",platformProjection:193.3,eligibleForRecommendation:true}]},baseline=[{id:"8151",name:"Kenneth Walker",position:"RB",team:"KC",mean:180,adp:7}],expanded=expandEspnCatalog(state,baseline),kenneth=expanded.players.find(player=>player.id==="8151");assert.equal(expanded.players.length,1);assert.equal(kenneth.name,"Kenneth Walker");assert.equal(kenneth.platformPlayerId,"Kenneth Walker");assert.equal(kenneth.platformProjection,193.3);assert.equal(kenneth.eligibleForRecommendation,true)});

test("an ESPN player must be explicitly live-eligible even when the baseline is eligible",()=>{const state={platform:"espn",picks:[],players:[{id:"live",name:"James Conner",position:"RB",eligibleForRecommendation:false}]},baseline=[{id:"baseline",name:"James Conner",position:"RB",eligibleForRecommendation:true}],expanded=expandEspnCatalog(state,baseline);assert.equal(expanded.players[0].eligibleForRecommendation,false)});

test("an unmatched live-projected ESPN specialist stays eligible",()=>{const state={platform:"espn",picks:[],players:[{id:"new-k",name:"New Kicker",position:"K",team:"BUF",platformProjection:137.5,eligibleForRecommendation:true},{id:"new-dst",name:"Expansion D/ST",position:"D/ST",team:"EXP",platformProjection:91.2,eligibleForRecommendation:true},{id:"unknown-wr",name:"Unknown Receiver",position:"WR",team:"BUF",platformProjection:200,eligibleForRecommendation:true}]},expanded=expandEspnCatalog(state,[]),byId=new Map(expanded.players.map(player=>[player.id,player]));assert.equal(byId.get("new-k").eligibleForRecommendation,true);assert.equal(byId.get("new-dst").eligibleForRecommendation,true);assert.equal(byId.get("new-dst").position,"DST");assert.equal(byId.get("unknown-wr").eligibleForRecommendation,false)});

test("an ESPN draft button cannot become a phantom kicker after that team's kicker was drafted",()=>{
  const baseline=[{id:"loop",name:"Tyler Loop",position:"K",team:"BAL",mean:145.8,eligibleForRecommendation:true},{id:"smack",name:"Trey Smack",position:"K",team:"GB",mean:144.4,eligibleForRecommendation:true}],state={platform:"espn",picks:[{pickNo:179,playerId:"espn-loop",name:"Tyler Loop",slot:11}],players:[{id:"espn-loop",name:"Tyler Loop",position:"K",team:"BAL",platformProjection:145.8,eligibleForRecommendation:true},{id:"draft-control",name:"Draft",position:"K",team:"BAL",platformProjection:145.8,eligibleForRecommendation:true},{id:"espn-smack",name:"Trey Smack",position:"K",team:"GB",platformProjection:144.4,eligibleForRecommendation:true}]},expanded=expandEspnCatalog(state,baseline);
  assert.equal(expanded.players.some(player=>player.name==="Draft"),false);
  const filtered=removeUnavailableRecommendations({recommendations:[{player:baseline[0]},{player:baseline[1]}]},expanded);
  assert.deepEqual(filtered.recommendations.map(item=>item.player.name),["Trey Smack"]);
});

test("ESPN pick 79 cannot survive catalog enrichment into the pick 80 recommendation cards",()=>{
  const baseline=[{id:"baseline-warren",name:"Jaylen Warren",position:"RB",team:"PIT",eligibleForRecommendation:true},{id:"baseline-sutton",name:"Courtland Sutton",position:"WR",team:"DEN",eligibleForRecommendation:true}],state={platform:"espn",currentPickNo:80,userSlot:8,picks:[{pickNo:79,playerId:"espn-raw-31366",name:"Jaylen Warren",slot:7}],players:[{id:"espn-raw-31366",name:"Jaylen Warren",position:"RB",team:"PIT",eligibleForRecommendation:true}]},expanded=expandEspnCatalog(state,baseline),stable={simulationStatus:"refined",recommendations:baseline.map(player=>({player}))},filtered=removeUnavailableRecommendations(stable,expanded);
  assert.equal(expanded.picks[0].playerId,"baseline-warren");
  assert.deepEqual(filtered.recommendations.map(item=>item.player.name),["Courtland Sutton"]);
});

test("ESPN completed defense picks reconcile when the virtualized row has no position or platform id",()=>{
  const baseline=[
    {id:"KC",name:"Kansas City Chiefs",position:"DST",team:"KC",mean:100,eligibleForRecommendation:true},
    {id:"LAC",name:"Los Angeles Chargers",position:"DST",team:"LAC",mean:98,eligibleForRecommendation:true},
  ],state={
    platform:"espn",
    picks:[
      {pickNo:183,playerId:"Chiefs D/ST",name:"Chiefs D/ST",slot:1},
      {pickNo:184,playerId:"Chargers D/ST",name:"Chargers D/ST",slot:2},
    ],
    players:[
      {id:"Chiefs D/ST",name:"Chiefs D/ST",position:"NA",team:"",eligibleForRecommendation:false},
      {id:"Chargers D/ST",name:"Chargers D/ST",position:"NA",team:"",eligibleForRecommendation:false},
    ],
  },expanded=expandEspnCatalog(state,baseline),pick=expanded.picks[0],chargersPick=expanded.picks[1],chiefs=expanded.players.find(player=>player.id==="KC"),chargers=expanded.players.find(player=>player.id==="LAC");
  assert.equal(pick.playerId,"KC");
  assert.equal(pick.platformPlayerId,"Chiefs D/ST");
  assert.equal(chiefs.name,"Kansas City Chiefs");
  assert.equal(chiefs.position,"DST");
  assert.equal(chiefs.platformPlayerId,"Chiefs D/ST");
  assert.equal(chargersPick.playerId,"LAC");
  assert.equal(chargersPick.platformPlayerId,"Chargers D/ST");
  assert.equal(chargers.name,"Los Angeles Chargers");
  assert.equal(chargers.position,"DST");
  assert.equal(chargers.platformPlayerId,"Chargers D/ST");
  assert.equal(expanded.players.some(player=>player.id==="Chiefs D/ST"),false);
  assert.equal(expanded.players.some(player=>player.id==="Chargers D/ST"),false);
});

test("ESPN 49ers D/ST merges into the San Francisco baseline defense instead of creating a 33rd row",()=>{
  const baseline=[{id:"SF",name:"San Francisco 49ers",position:"DST",team:"SF",mean:100,adp:9999,eligibleForRecommendation:true}],state={platform:"espn",picks:[],players:[{id:"49ers D/ST",name:"49ers D/ST",position:"DST",team:"",platformProjection:82.2,adp:424,eligibleForRecommendation:true}]},expanded=expandEspnCatalog(state,baseline),defense=expanded.players[0];
  assert.equal(expanded.players.length,1);
  assert.equal(defense.id,"SF");
  assert.equal(defense.platformPlayerId,"49ers D/ST");
  assert.equal(defense.name,"San Francisco 49ers");
  assert.equal(defense.team,"SF");
  assert.equal(defense.position,"DST");
  assert.equal(defense.platformProjection,82.2);
  assert.equal(defense.adp,424);
  assert.equal(defense.eligibleForRecommendation,true);
});

test("all 32 ESPN nickname defenses collapse one-to-one into the baseline catalog",()=>{
  const teams=[
    ["ARI","Arizona Cardinals","Cardinals"],["ATL","Atlanta Falcons","Falcons"],["BAL","Baltimore Ravens","Ravens"],["BUF","Buffalo Bills","Bills"],
    ["CAR","Carolina Panthers","Panthers"],["CHI","Chicago Bears","Bears"],["CIN","Cincinnati Bengals","Bengals"],["CLE","Cleveland Browns","Browns"],
    ["DAL","Dallas Cowboys","Cowboys"],["DEN","Denver Broncos","Broncos"],["DET","Detroit Lions","Lions"],["GB","Green Bay Packers","Packers"],
    ["HOU","Houston Texans","Texans"],["IND","Indianapolis Colts","Colts"],["JAX","Jacksonville Jaguars","Jaguars"],["KC","Kansas City Chiefs","Chiefs"],
    ["LV","Las Vegas Raiders","Raiders"],["LAC","Los Angeles Chargers","Chargers"],["LAR","Los Angeles Rams","Rams"],["MIA","Miami Dolphins","Dolphins"],
    ["MIN","Minnesota Vikings","Vikings"],["NE","New England Patriots","Patriots"],["NO","New Orleans Saints","Saints"],["NYG","New York Giants","Giants"],
    ["NYJ","New York Jets","Jets"],["PHI","Philadelphia Eagles","Eagles"],["PIT","Pittsburgh Steelers","Steelers"],["SEA","Seattle Seahawks","Seahawks"],
    ["SF","San Francisco 49ers","49ers"],["TB","Tampa Bay Buccaneers","Buccaneers"],["TEN","Tennessee Titans","Titans"],["WAS","Washington Commanders","Commanders"],
  ],baseline=teams.map(([id,name,team])=>({id,name,position:"DST",team:id,mean:100,eligibleForRecommendation:true})),players=teams.map(([id,,alias],index)=>({id:`${alias} D/ST`,name:`${alias} D/ST`,position:"D/ST",team:"",platformProjection:70+index,adp:400+index,eligibleForRecommendation:true})),expanded=expandEspnCatalog({platform:"espn",picks:[],players},baseline),defenses=expanded.players.filter(player=>player.position==="DST");
  assert.equal(defenses.length,32);
  assert.equal(new Set(defenses.map(player=>player.id)).size,32);
  assert.ok(defenses.every(player=>player.team===player.id));
  assert.ok(defenses.every(player=>player.platformProjection>0&&player.eligibleForRecommendation===true));
  assert.equal(defenses.some(player=>player.id.endsWith("D/ST")),false);
});
