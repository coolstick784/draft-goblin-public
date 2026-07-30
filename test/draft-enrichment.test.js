import test from"node:test";
import assert from"node:assert/strict";
import{enrichLiveDraftState,projectedAvailability}from"../extension/draft-enrichment.js";
import{buildCandidateBoard,recommend}from"../core/recommend.js";

test("availability uses the games forecast and records live injury status without an arbitrary multiplier",()=>{
  const player={id:"4217",name:"George Kittle",position:"TE"},ownedPlayer={season:2026,expectedGames:14.48,activeRoleGames:17,availabilityModelVersion:"owned-2026.12"};
  const historical=projectedAvailability({player,ownedPlayer,season:2026});
  assert.equal(historical.missedGameRate,.1482);
  assert.equal(historical.estimationLevel,"player-games-forecast");
  const current=projectedAvailability({player,ownedPlayer,injuryStatus:"Questionable",season:2026});
  assert.equal(current.missedGameRate,.1482);
  assert.equal(current.components.currentInjuryStatus,"Questionable");
});

test("availability enrichment does not alter the active-role performance range",()=>{
  const state={platform:"sleeper",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[{id:"te",name:"Risky TE",position:"TE",team:"SF",platformProjection:180,injuryStatus:"Questionable"}]},baseline={modelVersion:"test",players:[{id:"te",name:"Risky TE",position:"TE",team:"SF",meanPpr:180}]},owned={players:[{id:"te",name:"Risky TE",position:"TE",team:"SF",points:180,season:2026,expectedGames:13.6,activeRoleGames:17,availabilityModelVersion:"games-v1"}]};
  const healthy=enrichLiveDraftState({state:{...state,players:state.players.map(player=>({...player,injuryStatus:null}))},baseline,draftGoblinFeed:owned}).players[0],injured=enrichLiveDraftState({state,baseline,draftGoblinFeed:owned}).players[0];
  assert.equal(injured.floor,healthy.floor);
  assert.equal(injured.ceiling,healthy.ceiling);
  assert.equal(injured.availability.missedGameRate,healthy.availability.missedGameRate);
});

test("shared live enrichment preserves ESPN ids and supplies model projections",()=>{
  const state={platform:"espn",draftId:"practice-1",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[
    {id:"espn-101",name:"Bijan Robinson",position:"RB",team:"ATL",platformProjection:302,eligibleForRecommendation:true},
    {id:"espn-102",name:"Puka Nacua",position:"WR",team:"LAR",platformProjection:295,eligibleForRecommendation:true}
  ]};
  const baseline={modelVersion:"test-2026",dataQuality:"verified",players:[
    {id:"model-101",name:"Bijan Robinson",position:"RB",team:"ATL",meanPpr:300,adp:2,risk:.2,scarcity:.5},
    {id:"model-102",name:"Puka Nacua",position:"WR",team:"LAR",meanPpr:292,adp:3,risk:.25,scarcity:.4}
  ]};
  const enriched=enrichLiveDraftState({state,baseline,fantasyPros:{players:[]},sleeper:{players:[]}});
  assert.equal(enriched.modelVersion,"test-2026");
  assert.deepEqual(enriched.players.map(player=>player.id),["model-101","model-102"]);
  assert.deepEqual(enriched.players.map(player=>player.platformPlayerId),["espn-101","espn-102"]);
  assert.ok(enriched.players.every(player=>player.eligibleForRecommendation&&player.mean>0&&player.floor>0&&player.ceiling>player.mean));
});

test("shared live enrichment keeps the raw ESPN id on remapped picks",()=>{
  const state={platform:"espn",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[{pickNo:1,playerId:"espn-101",name:"Bijan Robinson",slot:1}],players:[{id:"espn-101",name:"Bijan Robinson",position:"RB",team:"ATL",platformProjection:302,eligibleForRecommendation:true}]};
  const baseline={modelVersion:"test-2026",players:[{id:"model-101",name:"Bijan Robinson",position:"RB",team:"ATL",meanPpr:300,adp:2,risk:.2,scarcity:.5}]};
  const enriched=enrichLiveDraftState({state,baseline});
  assert.equal(enriched.picks[0].playerId,"model-101");
  assert.equal(enriched.picks[0].platformPlayerId,"espn-101");
});

test("an injury is penalized without changing the performance-outcome range",()=>{
  const state={platform:"espn",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[{id:"espn-pierce",name:"Alec Pierce",position:"WR",team:"IND",platformProjection:202.8,injuryStatus:"Questionable",eligibleForRecommendation:true}]};
  const baseline={modelVersion:"test-2026",players:[{id:"model-pierce",name:"Alec Pierce",position:"WR",team:"IND",meanPpr:172.86,adp:67,risk:.309,scarcity:.55}]};
  const [pierce]=enrichLiveDraftState({state,baseline}).players;
  assert.equal(pierce.risk,.8);
  assert.equal(pierce.performanceRisk,.4);
  assert.equal(pierce.performanceRiskSource,"empirical-position-season-residual-p05-p95");
  assert.equal(pierce.historicalProjectionRisk,.309);
  assert.equal(pierce.floor,pierce.mean-33.3);
  assert.equal(pierce.ceiling,pierce.mean+48.59);
});

test("unpromoted historical uncertainty cannot reverse a same-position projection sweep",()=>{
  const state={platform:"espn",draftId:"hampton-jeanty",projectionSeason:2026,settings:{teams:12,rounds:16,scoring:{reception:1}},picks:[],players:[
    {id:"espn-hampton",name:"Omarion Hampton",position:"RB",team:"LAC",platformProjection:279.3,eligibleForRecommendation:true},
    {id:"espn-jeanty",name:"Ashton Jeanty",position:"RB",team:"LV",platformProjection:281.5,eligibleForRecommendation:true}
  ]};
  const baseline={modelVersion:"research-only",players:[
    {id:"hampton",name:"Omarion Hampton",position:"RB",team:"LAC",meanPpr:187.09,adp:12,risk:.485,scarcity:.8},
    {id:"jeanty",name:"Ashton Jeanty",position:"RB",team:"LV",meanPpr:196.06,adp:12,risk:.25,scarcity:.8}
  ]};
  const sleeper={players:[
    {id:"12507",name:"Omarion Hampton",position:"RB",team:"LAC",points:241.9,adp:18.8,season:2026},
    {id:"12527",name:"Ashton Jeanty",position:"RB",team:"LV",points:259.5,adp:15.4,season:2026}
  ]};
  const fantasyPros={players:[
    {id:"12507",name:"Omarion Hampton",position:"RB",team:"LAC",points:263.534},
    {id:"12527",name:"Ashton Jeanty",position:"RB",team:"LV",points:276.835}
  ]};
  const players=enrichLiveDraftState({state,baseline,fantasyPros,sleeper}).players,hampton=players.find(player=>player.name==="Omarion Hampton"),jeanty=players.find(player=>player.name==="Ashton Jeanty");
  assert.deepEqual([hampton.performanceRisk,jeanty.performanceRisk],[.4,.4]);
  assert.deepEqual([hampton.historicalProjectionRisk,jeanty.historicalProjectionRisk],[.485,.25]);
  for(const key of ["mean","floor","ceiling"])assert.ok(jeanty[key]>hampton[key],`${key}: Jeanty ${jeanty[key]} should exceed Hampton ${hampton[key]}`);
});

test("enrichment rejects unranked-player ADP sentinels",()=>{
  const state={platform:"espn",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[{id:"espn-unranked",name:"Unranked Receiver",position:"WR",team:"BUF",platformProjection:160,adp:9999999,eligibleForRecommendation:true}]};
  const baseline={modelVersion:"test",players:[{id:"baseline-unranked",name:"Unranked Receiver",position:"WR",team:"BUF",meanPpr:160,adp:999,risk:.3,scarcity:.4}]};
  const [player]=enrichLiveDraftState({state,baseline}).players;
  assert.equal(player.adp,null);
  assert.equal(player.adpSource,"unavailable");
});

test("Sleeper does not reuse a bundled ADP when the open draft has no visible market rank",()=>{
  const state={platform:"sleeper",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[{id:"josh",name:"Josh Allen",position:"QB",team:"BUF",platformProjection:317.3,adp:null,adpSource:"unavailable",eligibleForRecommendation:true}]};
  const baseline={modelVersion:"test",players:[{id:"josh",name:"Josh Allen",position:"QB",team:"BUF",meanPpr:317.3,adp:1,risk:.3,scarcity:.4}]};
  const [player]=enrichLiveDraftState({state,baseline}).players;
  assert.equal(player.adp,null);
  assert.equal(player.adpSource,"unavailable");
});

test("calibrated Draft Goblin drives the board and simulations by default",()=>{
  const state={platform:"espn",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[{id:"espn-101",name:"Bijan Robinson",position:"RB",team:"ATL",platformProjection:302,eligibleForRecommendation:true}]};
  const baseline={modelVersion:"test-2026",players:[{id:"model-101",name:"Bijan Robinson",position:"RB",team:"ATL",meanPpr:300,adp:2,risk:.2,scarcity:.5}]};
  const draftGoblinFeed={players:[{id:"owned:name-position:bijanrobinson:RB",name:"Bijan Robinson",position:"RB",team:"ATL",points:305.75,season:2026}]};
  const [player]=enrichLiveDraftState({state,baseline,draftGoblinFeed}).players;
  assert.equal(player.mean,302.75);
  assert.equal(player.source,"draftGoblin-projection-driver");
  assert.deepEqual(player.projectionConsensus.sources.map(source=>[source.label,source.weight]),[["Draft Goblin",1],["ESPN",0]]);
  assert.equal(player.projectionConsensus.fallbackReason,null);
  assert.ok(player.draftGoblinProjection>302.7&&player.draftGoblinProjection<302.8);
});

test("market-adjusted shadow is consensus-calibrated before it becomes the simulation mean",()=>{
  const state={platform:"espn",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[{id:"espn-101",name:"Bijan Robinson",position:"RB",team:"ATL",platformProjection:302,eligibleForRecommendation:true}]};
  const baseline={modelVersion:"test-2026",players:[{id:"model-101",name:"Bijan Robinson",position:"RB",team:"ATL",meanPpr:300,adp:2,risk:.2,scarcity:.5}]};
  const draftGoblinFeed={projectionVariant:"market-adjusted-shadow-v2",modelVersion:"market-shadow-test",players:[{id:"owned:name-position:bijanrobinson:RB",name:"Bijan Robinson",position:"RB",team:"ATL",points:373.1,season:2026}]};
  const [player]=enrichLiveDraftState({state,baseline,draftGoblinFeed,fantasyPros:{players:[{name:"Bijan Robinson",position:"RB",team:"ATL",points:310,season:2026}]}}).players;
  assert.equal(player.draftGoblinProjectionRaw,373.1);
  assert.equal(player.mean,Number(player.draftGoblinProjection.toFixed(2)));
  assert.ok(player.mean>317&&player.mean<318);
  assert.equal(player.projectionVariant,"market-adjusted-shadow-v2");
  assert.equal(player.projectionModelVersion,"market-shadow-test");
  assert.equal(player.draftGoblinProjectionCalibration.method,"player-consensus-local-tier-tanh");
  assert.equal(player.draftGoblinProjectionCalibration.inputVariant,"market-adjusted-shadow-v2");
  assert.ok(player.draftGoblinProjectionCalibration.adjustment<-51);
});

test("held-out player history narrows stable ranges and widens boom-bust ranges",()=>{
  const state={platform:"espn",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[{id:"stable-site",name:"Stable Receiver",position:"WR",team:"BUF",platformProjection:200,eligibleForRecommendation:true},{id:"boom-site",name:"Boom Receiver",position:"WR",team:"CIN",platformProjection:200,eligibleForRecommendation:true},{id:"unknown-site",name:"Unknown Veteran",position:"WR",team:"NYJ",platformProjection:200,eligibleForRecommendation:true},{id:"rookie-site",name:"True Rookie",position:"WR",team:"DAL",platformProjection:200,eligibleForRecommendation:true}]};
  const profile=(scale,classification)=>({scale,weeklyRows:40,localEvidenceWeight:.5,classification,artifactId:"player-performance-range-scale:2021-2024"}),baseline={modelVersion:"test",performanceRangeModel:{artifactId:"player-performance-range-scale:2021-2024",rookiePrior:{scale:1.2,classification:"rookie-uncertain"}},players:[{id:"stable",name:"Stable Receiver",position:"WR",team:"BUF",yearsExperience:4,performanceRangeProfile:profile(.8,"stable")},{id:"boom",name:"Boom Receiver",position:"WR",team:"CIN",yearsExperience:5,performanceRangeProfile:profile(1.25,"boom-bust")},{id:"unknown",name:"Unknown Veteran",position:"WR",team:"NYJ",yearsExperience:3},{id:"rookie",name:"True Rookie",position:"WR",team:"DAL",yearsExperience:0}]};
  const players=enrichLiveDraftState({state,baseline}).players,stable=players.find(player=>player.name==="Stable Receiver"),boom=players.find(player=>player.name==="Boom Receiver"),unknown=players.find(player=>player.name==="Unknown Veteran"),rookie=players.find(player=>player.name==="True Rookie");
  assert.equal(stable.performanceStability,"historically-narrow");assert.equal(boom.performanceStability,"historically-wide");assert.equal(unknown.performanceStability,"position-fallback");assert.equal(rookie.performanceStability,"rookie-uncertain");assert.ok(stable.ceiling-stable.floor<unknown.ceiling-unknown.floor);assert.ok(boom.ceiling-boom.floor>unknown.ceiling-unknown.floor);assert.ok(rookie.ceiling-rookie.floor>unknown.ceiling-unknown.floor);assert.equal(rookie.performanceRangePlayerScale,1.2);assert.equal(rookie.performanceRiskSource,"empirical-rookie-uncertainty-prior");assert.equal(stable.performanceRiskSource,"empirical-player-shrunk-season-range");assert.equal(stable.performanceRangePlayerRows,40);
});

test("the current draft-site projection remains an explicit simulation option",()=>{
  const state={platform:"espn",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[{id:"espn-101",name:"Bijan Robinson",position:"RB",team:"ATL",platformProjection:302,eligibleForRecommendation:true}]};
  const baseline={modelVersion:"test-2026",players:[{id:"model-101",name:"Bijan Robinson",position:"RB",team:"ATL",meanPpr:300,adp:2,risk:.2,scarcity:.5}]};
  const draftGoblinFeed={players:[{name:"Bijan Robinson",position:"RB",team:"ATL",points:250,season:2026}]};
  const [player]=enrichLiveDraftState({state,baseline,draftGoblinFeed,projectionDriver:"platform"}).players;
  assert.equal(player.mean,302);
  assert.equal(player.projectionConsensus.selectedDriver,"platform");
  assert.equal(player.projectionConsensus.sources.find(source=>source.label==="ESPN").weight,1);
});

test("bundled feeds restore an unseen ESPN first-round candidate",()=>{
  const baseline={modelVersion:"test",players:[{id:"achane",name:"De'Von Achane",position:"RB",team:"MIA",adp:10,meanPpr:290,risk:.3,scarcity:.8},{id:"nico",name:"Nico Collins",position:"WR",team:"HOU",adp:21,meanPpr:240,risk:.3,scarcity:.55}]};
  const state={platform:"espn",projectionSeason:2026,userSlot:12,settings:{teams:12,rounds:16,scoring:{reception:1},slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,DST:1,K:1,BENCH:7}},picks:[],players:[{id:"espn-nico",name:"Nico Collins",position:"WR",team:"HOU",platformProjection:249.4,eligibleForRecommendation:true}]};
  const draftGoblinFeed={players:[{id:"achane",name:"De'Von Achane",position:"RB",team:"MIA",points:300,season:2026},{id:"nico",name:"Nico Collins",position:"WR",team:"HOU",points:235.4,season:2026}]};
  const enriched=enrichLiveDraftState({state,baseline,draftGoblinFeed});
  const achane=enriched.players.find(player=>player.name==="De'Von Achane");
  assert.equal(achane.mean,300);
  assert.equal(achane.eligibleForRecommendation,true);
  assert.equal(recommend({state:enriched,userSlot:12,limit:8})[0].player.name,"De'Von Achane");
});

test("duplicate ESPN suffix aliases keep Kenneth Walker on the full player board",()=>{
  const baseline={modelVersion:"test",players:[{id:"8151",name:"Kenneth Walker",position:"RB",team:"KC",adp:7.2,meanStd:193.3,risk:.4,scarcity:.8}]};
  const state={platform:"espn",projectionSeason:2026,userSlot:1,settings:{teams:10,rounds:16,scoring:{reception:0},slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,DST:1,K:1,BENCH:7}},picks:[],players:[{id:"api-8151",name:"Kenneth Walker III",position:"RB",team:"KC",platformProjection:191,eligibleForRecommendation:true},{id:"Kenneth Walker",name:"Kenneth Walker",position:"RB",team:"KC",platformProjection:193.3,eligibleForRecommendation:true}]};
  const draftGoblinFeed={players:[{id:"owned-8151",name:"Kenneth Walker III",position:"RB",team:"KC",points:175,season:2026}]},enriched=enrichLiveDraftState({state,baseline,draftGoblinFeed}),board=buildCandidateBoard({state:enriched,userSlot:1});
  assert.equal(enriched.players.filter(player=>player.name==="Kenneth Walker").length,1);
  assert.ok(board.some(row=>row.player.name==="Kenneth Walker"));
});

test("displayed Draft Goblin projection uses player-level consensus calibration",()=>{
  const state={platform:"espn",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[{id:"espn-101",name:"Range Runner",position:"RB",team:"ATL",platformProjection:300,eligibleForRecommendation:true}]};
  const baseline={modelVersion:"test-2026",players:[{id:"model-101",name:"Range Runner",position:"RB",team:"ATL",meanPpr:300,adp:2,risk:.2,scarcity:.5}]};
  const draftGoblinFeed={players:[{name:"Range Runner",position:"RB",team:"ATL",points:400,season:2026}]};
  const fantasyPros={players:[{name:"Range Runner",position:"RB",team:"ATL",points:310,season:2026}]};
  const sleeper={players:[{name:"Range Runner",position:"RB",team:"ATL",points:320,season:2026}]};
  const [player]=enrichLiveDraftState({state,baseline,draftGoblinFeed,fantasyPros,sleeper}).players;
  assert.equal(player.draftGoblinProjectionRaw,400);
  assert.ok(player.draftGoblinProjection>324&&player.draftGoblinProjection<325);
  assert.equal(player.draftGoblinProjectionCalibration.method,"player-consensus-local-tier-tanh");
  assert.equal(player.draftGoblinProjectionCalibration.smoothingPoints,20);
  assert.equal(player.draftGoblinProjectionCalibration.ownedSignalWeight,.2);
  assert.equal(player.draftGoblinProjectionCalibration.providerConsensus,310);
  assert.ok(player.draftGoblinProjectionCalibration.adjustment<-75);
});

test("historical baseline points cannot replace missing Draft Goblin and site projections",()=>{
  const state={platform:"espn",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[{id:"espn-101",name:"No Current Projection",position:"RB",team:"ATL",platformProjection:0,eligibleForRecommendation:true}]};
  const baseline={modelVersion:"test-2026",players:[{id:"model-101",name:"No Current Projection",position:"RB",team:"ATL",meanPpr:236.7,adp:20,risk:.2,scarcity:.5}]};
  const [player]=enrichLiveDraftState({state,baseline}).players;
  assert.equal(player.mean,0);
  assert.equal(player.eligibleForRecommendation,false);
  assert.deepEqual(player.projectionConsensus.sources,[]);
});

test("only a promoted season model attaches calibrated player quantiles",()=>{
  const state={platform:"espn",projectionSeason:2026,settings:{teams:10,rounds:16,scoring:{reception:1}},picks:[],players:[{id:"espn-wr",name:"Test Receiver",position:"WR",team:"CHI",platformProjection:200,eligibleForRecommendation:true}]};
  const base={modelVersion:"baseline",players:[{id:"model-wr",name:"Test Receiver",position:"WR",team:"CHI",meanPpr:200,adp:20,risk:.3,scarcity:.4}]};
  const research=enrichLiveDraftState({state,baseline:{...base,distributionCalibration:{artifactId:"weekly",status:"research-not-runtime-wired",dataQuality:{promotionGatePassed:false}}}});
  assert.equal(research.players[0].distribution,undefined);
  assert.equal(research.distributionCalibration.promotionGatePassed,false);
  const distributionModel={runtimeStatus:"promoted",schemaVersion:"quantile-v1",unit:"season-residual-fantasy-points",season:2026,modelId:"test-quantiles",modelVersion:"2026.1",calibrationId:"holdout-2025",generatedAt:"2026-07-14T12:00:00.000Z",forecastAsOf:"2026-07-14T11:55:00.000Z",trainedThrough:"2026-02-10T00:00:00.000Z",sourceSnapshotIds:["snapshot:test"],scoringFormats:{ppr:{positions:{WR:{estimationLevel:"position",fallbackReason:"position shrinkage",residualQuantiles:[-100,-80,-65,-45,-30,-15,-5,5,20,40,65,85,120]}}}}};
  const promoted=enrichLiveDraftState({state,baseline:{...base,distributionModel}}),player=promoted.players[0];
  assert.equal(promoted.modelVersion,"baseline+2026.1");
  assert.equal(player.distribution.schemaVersion,"quantile-v1");
  assert.equal(player.distribution.conditionedOn,"active-role");
  assert.equal(player.distribution.quantiles.length,13);
  assert.equal(player.floor,135);
  assert.equal(player.ceiling,265);
  assert.equal(player.performanceRiskSource,"promoted-player-distribution");
  assert.deepEqual(player.distribution.correlationRefs,[{kind:"offense",key:"offense:2026:CHI"}]);
});
