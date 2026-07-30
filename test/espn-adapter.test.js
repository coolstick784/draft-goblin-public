import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source=fs.readFileSync(new URL("../extension/adapters/espn.js",import.meta.url),"utf8");
const context={__draftChampionEspnTestMode:true};
context.globalThis=context;
vm.runInNewContext(source,context,{filename:"extension/adapters/espn.js"});
const {contiguousTeamOrder,teamOrderFromSelects,slotForTeam,receptionValue,currentPickFromTexts,userSlotFromClockTexts,visibleOverallRank,pickNumberFromRow,normalizePicks,completedPicksBeforeClock,mergePickHistory,mergePlayer,espnFeedPlayers,nflTeamFromText,usablePlayerName,mountedProjectionCoverage,deriveLeagueSettings,deriveLeagueSettingsFromApi}=context.__draftChampionEspnHelpers;

const row=({pickAttr="",firstCell=""}={})=>({
  getAttribute:name=>name==="data-pick"?pickAttr:"",
  querySelector:selector=>selector==="td,[role=gridcell]"?{textContent:firstCell}:null,
});

test("ESPN reads only the active on-the-clock banner as the authoritative current pick",()=>{
  assert.equal(currentPickFromTexts(["PICK 28","On the Clock: Pick 27","PICK 29"]),27);
  assert.equal(currentPickFromTexts(["ON THE CLOCK: PICK 43"]),43);
  assert.equal(currentPickFromTexts(["ON THE CLOCK: PICK 41we go's Wild Team"]),41);
  assert.equal(currentPickFromTexts(["You're on the clock in: 1 Pick","PICK 44"]),null);
  assert.match(source,/document\.body\?\.textContent/);
});

test("ESPN personal clock countdown corrects a misleading team dropdown slot",()=>{
  assert.equal(userSlotFromClockTexts(["You're on the clock in: 1 Pick"],86,10),7);
  assert.equal(userSlotFromClockTexts(["You’re on the clock in: 3 Picks"],84,10),7);
  assert.equal(userSlotFromClockTexts(["ON THE CLOCK: PICK 86"],86,10),null);
  assert.equal(userSlotFromClockTexts(["You're on the clock in: 1 Pick"],null,10),null);
  assert.match(source,/verifiedUserSlot\|\|selectUserSlot/);
});

test("ESPN reads the visible overall rank when its detached header cannot be resolved",()=>{
  assert.equal(visibleOverallRank("41", "Josh Allen BUF QB 369.3"),41);
  assert.equal(visibleOverallRank("41 Josh Allen BUF QB 369.3"),41);
  assert.equal(visibleOverallRank("Josh Allen BUF QB 369.3"),0);
});

test("ESPN reads pick numbers from native League Manager table cells",()=>{
  assert.equal(pickNumberFromRow(row({firstCell:"14"})),14);
  assert.equal(pickNumberFromRow(row({pickAttr:"15",firstCell:"14"})),15);
  assert.equal(pickNumberFromRow(row({firstCell:"PICK"})),0);
  assert.match(source,/\.pick-history \[role="row"\], table tr/);
});

test("ESPN recognizes shuffled contiguous team IDs while preserving draft order",()=>{
  const liveOrder=[8,3,12,9,7,10,1,5,4,11,2,6];
  const order=[...contiguousTeamOrder(liveOrder)];
  assert.deepEqual(order,liveOrder);
  assert.equal(slotForTeam(order,8),1);
  assert.equal(slotForTeam(order,6),12);
  assert.equal(slotForTeam(order,99),null);
  for(const [slot,teamId] of order.entries())assert.equal(slotForTeam(order,teamId),slot+1);
});

test("ESPN fails closed when teamId is not present in a verified draft order",()=>{
  assert.equal(slotForTeam([],1),null);
  assert.equal(slotForTeam([3,1,4,2],5),null);
  assert.equal(slotForTeam([3,1,4,2],1),2);
  assert.doesNotMatch(source,/teamId>=1&&teamId<=teamCount\?teamId/);
});

test("ESPN accepts verified positive team IDs with gaps but rejects duplicates and invalid IDs",()=>{
  assert.deepEqual([...contiguousTeamOrder([1,2,4,3,3])],[]);
  assert.deepEqual([...contiguousTeamOrder([8,2,14,5])],[8,2,14,5]);
  assert.deepEqual([...contiguousTeamOrder([1,2,3,"team-four"])],[]);
  assert.deepEqual([...contiguousTeamOrder([-1,1,2,3,4])],[]);
});

test("ESPN practice drafts ignore the pick-clock dropdown when detecting team order",()=>{
  const teamOrder=[7,6,5,3,9,1,4,10,8,2,11,12];
  const selects=[
    {selectedValue:1,options:teamOrder.map(value=>({value,text:value===1?"we go's Wild Team":`Team ${value}`}))},
    {testId:"pickTimeDropdown",options:[15000,25000,30000,45000,60000,90000,120000,240000,300000,600000,1800000,3600000,10800000,18000000,36000000,86400000].map(value=>({value,text:`${value} milliseconds`}))},
  ];
  assert.deepEqual([...teamOrderFromSelects(selects,1)],teamOrder);
  assert.equal(slotForTeam(teamOrderFromSelects(selects,1),1),6);
  assert.deepEqual([...teamOrderFromSelects([{options:[15,25,30,45].map(value=>({value,text:`${value} seconds`}))}])],[]);
});

test("ESPN derives exact zero-slot settings and fails closed when roster or scoring evidence is incomplete",()=>{
  const rows=["QB Empty","RB Empty","RB Empty","WR Empty","WR Empty","TE Empty","BE Empty","BE Empty"];
  const settings=deriveLeagueSettings({teamCount:10,rosterRows:rows,limitText:"0/8 Players",scoringText:"10-Team Half PPR"});
  assert.equal(settings.rounds,8);
  assert.equal(JSON.stringify(settings.slots),JSON.stringify({QB:1,RB:2,WR:2,TE:1,FLEX:0,K:0,DST:0,BENCH:2}));
  assert.equal(settings.scoring.reception,.5);
  assert.equal(deriveLeagueSettings({teamCount:10,rosterRows:rows.slice(0,4),limitText:"0/8 Players",scoringText:"PPR"}),null);
  assert.equal(deriveLeagueSettings({teamCount:10,rosterRows:rows,limitText:"0/8 Players",scoringText:"Draft room"}),null);
});

test("ESPN derives league settings from mSettings without changing the visible draft tab",()=>{
  const settings=deriveLeagueSettingsFromApi({settings:{rosterSettings:{lineupSlotCounts:{0:1,2:2,4:2,6:1,16:1,17:1,20:7,23:1}},scoringSettings:{scoringItems:[{statId:53,points:1}]},scheduleSettings:{playoffTeamCount:6}}},12);
  assert.deepEqual(JSON.parse(JSON.stringify(settings)),{teams:12,rounds:16,slots:{QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:7},positionLimits:{},scoring:{reception:1},playoffTeams:6});
  assert.equal(deriveLeagueSettingsFromApi({settings:{rosterSettings:{lineupSlotCounts:{0:1,2:2,4:2,6:1,20:7}},scoringSettings:{scoringItems:[]}}},10).scoring.reception,0);
  assert.equal(deriveLeagueSettingsFromApi({settings:{rosterSettings:{lineupSlotCounts:{0:1}},scoringSettings:{scoringItems:[]}}},12),null);
});

test("ESPN maps platform position limits into recommendation settings",()=>{
  const settings=deriveLeagueSettingsFromApi({settings:{rosterSettings:{lineupSlotCounts:{0:1,2:2,4:2,6:1,20:6,23:1},positionLimits:{1:2,2:5,3:6,4:2,5:1,16:1}},scoringSettings:{scoringItems:[]}}},10);
  assert.deepEqual(JSON.parse(JSON.stringify(settings.positionLimits)),{QB:2,RB:5,WR:6,TE:2,K:1,DST:1});
});

test("ESPN accepts live roster cells whose text is concatenated across table columns",()=>{
  const rows=["QBEmpty-","RBEmpty-","RBEmpty-","WREmpty-","WREmpty-","TEEmpty-","FLEXEmpty-","D/STEmpty-","KEmpty-",...Array(7).fill("BEEmpty-")];
  const settings=deriveLeagueSettings({teamCount:10,rosterRows:rows,limitText:"0/16 Players",scoringText:"Head to Head Points, Point Per Reception"});
  assert.equal(settings.rounds,16);
  assert.equal(JSON.stringify(settings.slots),JSON.stringify({QB:1,RB:2,WR:2,TE:1,FLEX:1,K:1,DST:1,BENCH:7}));
  assert.equal(settings.scoring.reception,1);
});

test("ESPN scoring distinguishes standard, half PPR, and full PPR",()=>{
  assert.equal(receptionValue("Standard scoring"),0);
  assert.equal(receptionValue("Half PPR"),.5);
  assert.equal(receptionValue("Half-point PPR"),.5);
  assert.equal(receptionValue("0.5 PPR"),.5);
  assert.equal(receptionValue("PPR scoring"),1);
  assert.equal(receptionValue("Head to Head Points, Half Point Per Reception"),.5);
  assert.equal(receptionValue("Head to Head Points, Point Per Reception"),1);
  assert.equal(receptionValue("Head to Head Points"),0);
});

test("ESPN verifies settings without changing the visible draft tab",()=>{
  assert.doesNotMatch(source,/startSettingsProbe|restoreAfterSettingsProbe/);
  assert.match(source,/Scoring Type/);
  assert.match(source,/espnSettings:/);
  assert.match(source,/deriveLeagueSettingsFromApi/);
  assert.match(source,/cachedLeagueSettings/);
  assert.match(source,/leagueSettings\|\|adapterSession\.cachedLeagueSettings/);
  assert.match(source,/without changing the draft view/);
});

test("ESPN sorts and deduplicates overlapping pick-history rows",()=>{
  const result=normalizePicks([
    {pickNo:2,playerId:"p2",slot:3,name:"Two"},
    {pickNo:1,playerId:"p1",slot:1,name:"One"},
    {pickNo:2,playerId:"p2",slot:3,name:"Two"},
    {pickNo:3,playerId:"p3",slot:3,name:"Three"},
  ],4);
  assert.equal(result.error,"");
  assert.equal(JSON.stringify(result.picks.map(p=>[p.pickNo,p.playerId,p.slot])),JSON.stringify([[1,"p1",1],[2,"p2",3],[3,"p3",3]]));
});

test("ESPN fails closed for conflicting or noncontiguous pick history",()=>{
  const conflict=normalizePicks([{pickNo:1,playerId:"p1",slot:1},{pickNo:1,playerId:"other",slot:1}],12);
  assert.match(conflict.error,/conflicting players/);
  assert.deepEqual([...conflict.picks],[]);
  const gap=normalizePicks([{pickNo:1,playerId:"p1",slot:1},{pickNo:3,playerId:"p3",slot:3}],12);
  assert.match(gap.error,/not contiguous/);
  assert.deepEqual([...gap.picks],[]);
});

test("ESPN retains players and projections across disjoint virtualized viewports",()=>{
  const catalog=new Map();
  const mergeViewport=players=>{for(const player of players)catalog.set(player.id,mergePlayer(catalog.get(player.id)||{},player))};
  mergeViewport([{id:"p1",name:"One",position:"RB",team:"NYJ",platformProjection:210,eligibleForRecommendation:true},{id:"p2",name:"Two",position:"WR",team:"BUF",platformProjection:190,eligibleForRecommendation:true}]);
  mergeViewport([{id:"p3",name:"Three",position:"TE",team:"KC",platformProjection:170,eligibleForRecommendation:true},{id:"p1",name:"One",position:"NA",team:"",platformProjection:0,eligibleForRecommendation:false}]);
  assert.deepEqual([...catalog.keys()], ["p1","p2","p3"]);
  assert.equal(catalog.get("p1").position,"RB");
  assert.equal(catalog.get("p1").platformProjection,210);
  assert.equal(catalog.get("p1").eligibleForRecommendation,true);
});

test("ESPN parses the authenticated draftInit player pool into full-season projections",()=>{
  const players=espnFeedPlayers({players:[
    {id:"1",draftRanksByRankType:{PPR:{rank:12}},player:{id:"1",fullName:"Complete Player",defaultPositionId:2,stats:[{seasonId:2026,statSourceId:0,statSplitTypeId:0,appliedTotal:99},{seasonId:2026,statSourceId:1,statSplitTypeId:0,appliedTotal:244.5}]}},
    {id:"2",player:{id:"2",fullName:"No Projection",defaultPositionId:3,stats:[]}},
    {id:"3",player:{id:"3",fullName:"Unsupported",defaultPositionId:17,stats:[{seasonId:2026,statSourceId:1,appliedTotal:100}]}},
  ]},2026);
  assert.equal(players.length,2);
  assert.equal(players[0].name,"Complete Player");
  assert.equal(players[0].position,"RB");
  assert.equal(players[0].platformProjection,244.5);
  assert.equal(players[0].adp,12);
  assert.equal(players[0].eligibleForRecommendation,true);
  assert.equal(players[1].eligibleForRecommendation,false);
});

test("ESPN never treats draft action controls as player names",()=>{
  assert.equal(usablePlayerName("Draft"),"");
  assert.equal(usablePlayerName(" Queue "),"");
  assert.equal(usablePlayerName("Tyler Loop"),"Tyler Loop");
  const merged=mergePlayer({id:"k1",name:"Tyler Loop",position:"K",team:"BAL",platformProjection:145.8},{id:"k1",name:"Draft",position:"K",team:"BAL"});
  assert.equal(merged.name,"Tyler Loop");
});

test("ESPN authenticated ranks follow the league scoring format before falling back",()=>{
  const payload={players:[{id:"1",draftRanksByRankType:{PPR:{rank:11},HALF:{rank:22},STANDARD:{rank:33}},player:{id:"1",fullName:"Scoring Rank",defaultPositionId:2,stats:[{seasonId:2026,statSourceId:1,statSplitTypeId:0,appliedTotal:200}]}}]};
  assert.equal(espnFeedPlayers(payload,2026,1)[0].adp,11);
  assert.equal(espnFeedPlayers(payload,2026,.5)[0].adp,22);
  assert.equal(espnFeedPlayers(payload,2026,0)[0].adp,33);
});

test("ESPN team fallback never mistakes a fantasy position for an NFL team",()=>{
  assert.equal(nflTeamFromText("Example Player RB BUF 201.4"),"BUF");
  assert.equal(nflTeamFromText("Example Player WR"),"");
  assert.equal(nflTeamFromText("Saints D/ST NO"),"NO");
});

test("ESPN excludes an autopick candidate at or beyond the live clock pick",()=>{
  const history=new Map(Array.from({length:183},(_,index)=>[index+1,{pickNo:index+1,playerId:index===182?"chargers":`player-${index+1}`,slot:index%12+1}])),conflicts=new Map([[183,{signature:"chargers:10"}]]),observed=[...history.values(),{pickNo:184,playerId:"future-player",slot:4}];
  const completed=completedPicksBeforeClock(observed,181,history,conflicts);
  assert.equal(completed.length,180);
  assert.equal(completed.at(-1).pickNo,180);
  assert.equal(history.size,180);
  assert.equal(history.has(183),false);
  assert.equal(conflicts.has(183),false);
});
test("ESPN accepts an instant autopick result before its clock label repaints",()=>{
  const history=new Map(Array.from({length:105},(_,index)=>[index+1,{pickNo:index+1,playerId:`player-${index+1}`,slot:index%10+1}])),conflicts=new Map(),observed=[...history.values(),{pickNo:106,playerId:"user-pick",slot:5},{pickNo:107,playerId:"following-autopick",slot:4}];
  const firstCompleted=completedPicksBeforeClock(observed,106,history,conflicts);
  assert.equal(firstCompleted.at(-1).pickNo,106);
  assert.equal(firstCompleted.some(pick=>pick.pickNo===107),false);
  const firstMerged=mergePickHistory(history,firstCompleted,10,conflicts);
  assert.equal(firstMerged.error,"");
  assert.equal(firstMerged.picks.length,106);
  assert.equal(firstMerged.picks.at(-1).playerId,"user-pick");
  const secondCompleted=completedPicksBeforeClock(observed,106,history,conflicts),secondMerged=mergePickHistory(history,secondCompleted,10,conflicts);
  assert.equal(secondCompleted.at(-1).pickNo,107);
  assert.equal(secondMerged.error,"");
  assert.equal(secondMerged.picks.length,107);
  assert.equal(secondMerged.picks.at(-1).playerId,"following-autopick");
});
test("ESPN projection parsing uses the current external season id and entry-level stats",()=>{
  const players=espnFeedPlayers({players:[
    {id:"1",player:{id:"1",fullName:"External Projection",defaultPositionId:2,stats:[{externalId:"2025",statSourceId:1,statSplitTypeId:0,appliedTotal:99},{externalId:"2026",statSourceId:1,statSplitTypeId:0,appliedTotal:201.5}]}},
    {id:"2",stats:[{externalId:"2026",statSourceId:1,statSplitTypeId:0,appliedTotalAdjusted:188.25}],player:{id:"2",fullName:"Entry Projection",defaultPositionId:3,stats:[]}},
  ]},2026);
  assert.equal(players[0].platformProjection,201.5);
  assert.equal(players[1].platformProjection,188.25);
});

test("ESPN waits for a useful stable mounted projection set before publishing",()=>{
  const picks=[{pickNo:1,playerId:"drafted"}],players=[
    {id:"drafted",position:"RB",platformProjection:300,adp:1},
    ...Array.from({length:5},(_,index)=>({id:`live-${index}`,position:index%2?"WR":"RB",platformProjection:200-index,adp:10+index})),
    {id:"history",position:"NA",platformProjection:0},
  ],ready=mountedProjectionCoverage(players,picks),partial=mountedProjectionCoverage(players.slice(0,5),picks);
  assert.equal(ready.count,5);
  assert.equal(ready.ready,true);
  assert.equal(partial.ready,false);
  assert.doesNotMatch(ready.signature,/drafted/);
  assert.notEqual(ready.signature,mountedProjectionCoverage(players.map(player=>player.id==="live-0"?{...player,platformProjection:225}:player),picks).signature);
});

test("ESPN retains overall market rank and its provenance across virtualized viewports",()=>{
  const ranked=mergePlayer({}, {id:"p1",name:"One",position:"RB",platformProjection:210,adp:17,adpSource:"espn-rank",adpSd:null,adpSdSource:"rank-calibrated"});
  const offscreen=mergePlayer(ranked,{id:"p1",name:"One",position:"NA",platformProjection:0,adp:null,adpSource:"unavailable"});
  assert.equal(offscreen.adp,17);
  assert.equal(offscreen.adpSource,"espn-rank");
  assert.equal(offscreen.adpSdSource,"rank-calibrated");
  assert.match(source,/\^\(RK\|RANK\|OVERALL/);
  assert.match(source,/adpProvider:"espn"/);
});

test("ESPN discards unranked-player ADP sentinels",()=>{
  const sentinel=mergePlayer({}, {id:"p1",name:"Unranked",position:"WR",platformProjection:110,adp:9999999,adpSource:"espn-rank"});
  assert.equal(sentinel.adp,null);
  assert.equal(sentinel.adpSource,"unavailable");
  const valid=mergePlayer({id:"p1",adp:44,adpSource:"espn-rank"}, {...sentinel,adp:999});
  assert.equal(valid.adp,44);
});

test("ESPN accumulates overlapping and disjoint virtualized pick-history rows",()=>{
  const history=new Map(),conflicts=new Map();
  let result=mergePickHistory(history,[{pickNo:1,playerId:"p1",slot:1},{pickNo:2,playerId:"p2",slot:2}],4,conflicts,1000);
  assert.equal(result.error,"");
  result=mergePickHistory(history,[{pickNo:2,playerId:"p2",slot:2},{pickNo:3,playerId:"p3",slot:3},{pickNo:4,playerId:"p4",slot:4}],4,conflicts,1200);
  assert.equal(result.error,"");
  assert.equal(JSON.stringify(result.picks.map(pick=>pick.playerId)),JSON.stringify(["p1","p2","p3","p4"]));
  result=mergePickHistory(history,[{pickNo:4,playerId:"p4",slot:4},{pickNo:4,playerId:"other",slot:4},{pickNo:5,playerId:"p5",slot:4}],4,conflicts,2000);
  assert.equal(result.error,"");
  assert.deepEqual(Array.from(result.picks,pick=>pick.playerId),["p1","p2","p3","p4","p5"]);
  for(let count=2;count<=8;count++)result=mergePickHistory(history,[{pickNo:4,playerId:"other",slot:4}],4,conflicts,2000+(count-1)*200);
  assert.equal(history.get(4).playerId,"p4");
  result=mergePickHistory(history,[{pickNo:4,playerId:"other",slot:4}],4,conflicts,4000);
  assert.equal(result.error,"");
  assert.deepEqual(Array.from(result.picks,pick=>pick.playerId),["p1","p2","p3","other"]);
});

test("ESPN ignores the exact transient duplicate that appeared at pick 83 in the live mock",()=>{
  const history=new Map(Array.from({length:83},(_,index)=>{
    const pickNo=index+1;
    return[pickNo,{pickNo,playerId:pickNo===83?"jaylen-warren":`player-${pickNo}`,slot:((pickNo-1)%12)+1,name:pickNo===83?"Jaylen Warren":`Player ${pickNo}`}]
  })),conflicts=new Map();
  const result=mergePickHistory(history,[
    {pickNo:83,playerId:"jaylen-warren",slot:11,name:"Jaylen Warren"},
    {pickNo:83,playerId:"parker-washington",slot:11,name:"Parker Washington"},
    {pickNo:84,playerId:"player-84",slot:12,name:"Player 84"},
  ],12,conflicts,5000);
  assert.equal(result.error,"");
  assert.equal(result.picks.length,84);
  assert.equal(result.picks[82].playerId,"jaylen-warren");
  assert.equal(result.picks[83].playerId,"player-84");
});

test("ESPN adapter uses a unique session handshake, heartbeat, and navigation shutdown",()=>{
  assert.match(source,/id:crypto\.randomUUID\(\)/);
  assert.match(source,/type:"ADAPTER_ACTIVATED"[\s\S]*adapterSessionId/);
  assert.match(source,/type:"DRAFT_HEARTBEAT"[\s\S]*adapterSessionId/);
  assert.match(source,/type:"DRAFT_NAVIGATED"[\s\S]*adapterSessionId/);
  assert.match(source,/espnDraftId\(\)!==leagueId/);
  assert.match(source,/draftStatus/);
  assert.match(source,/pendingRestartCount>=2/);
  assert.match(source,/semanticMutation/);
  assert.match(source,/if\(document\.hidden\)return/);
});
test("ESPN adapter shuts down invalidated extension contexts and reinjects cleanly",()=>{assert.match(source,/existingAdapter\.stop\?\.\(\)/);assert.match(source,/adapterSession\.stop=stopAdapter/);assert.match(source,/!chrome\.runtime\?\.id/);assert.doesNotMatch(source,/existingAdapter\?\.version===adapterVersion[\s\S]{0,300}return/)});
test("ESPN mounting delays remain a stable connecting state instead of publishing a failure",()=>{assert.match(source,/const reportLoading=.*phase="connecting"/);assert.match(source,/if\(teamCount<4\)return reportLoading\(\)/);assert.match(source,/if\(!leagueSettings\)return reportLoading\(\)/);assert.match(source,/if\(!Number\.isInteger\(userSlot\)\|\|userSlot<1\)return reportLoading\(\)/);assert.match(source,/if\(normalized\.error\)return reportLoading\(\)/)});
test("ESPN lets pick history and mounted projections settle before publishing",()=>{assert.match(source,/historyCaughtUp/);assert.match(source,/pendingReadyPickCount/);assert.match(source,/pendingProjectionSignature/);assert.match(source,/projectionCoverage\.ready/);assert.match(source,/projectionWaitExpired/);assert.match(source,/adapterVersion="2026-07-23b"/)});
test("ESPN reuses a fresh league catalog while draftInit refreshes in the background",()=>{assert.match(source,/catalogCacheKey=`espnCatalog:/);assert.match(source,/cachedCatalogFresh/);assert.match(source,/catalog:new Map\(\(cachedCatalogFresh\?cachedCatalog\.players:\[\]\)/);assert.match(source,/feedReady:cachedCatalogFresh/);assert.match(source,/if\(feedPlayers\.length>=8\)cacheCatalog\(\);scheduleUpdate\(\)/)});
test("ESPN distinguishes the countdown from an active pick 1 clock",()=>{assert.match(source,/const draftStatus=picks\.length>=expectedPicks\?"complete":detectedCurrentPick\|\|picks\.length\?"drafting":"predraft"/);assert.match(source,/detectedCurrentPick,draftStatus,leagueSettings/)});
test("ESPN hydrates its complete authenticated draftInit player pool and survives strict cookie settings",()=>{const background=fs.readFileSync(new URL("../extension/background.js",import.meta.url),"utf8"),manifest=JSON.parse(fs.readFileSync(new URL("../extension/manifest.json",import.meta.url)));assert.match(source,/ESPN_FETCH_DRAFT_INIT/);assert.match(source,/externalId\?\?stat\?\.seasonId/);assert.match(background,/fetchEspnDraftInit\(sender\.tab\?\.id/);assert.match(background,/filterStatsForContainerIds/);assert.match(background,/view=draftInit&view=mSettings/);assert.match(background,/credentials:"include"/);assert.match(background,/world:"MAIN"/);assert.match(background,/chrome\.scripting\.executeScript/);assert.ok(manifest.host_permissions.includes("https://lm-api-reads.fantasy.espn.com/*"));assert.ok(!manifest.permissions.includes("cookies"))});
test("ESPN verifies lightweight league settings independently of the large player pool",()=>{const background=fs.readFileSync(new URL("../extension/background.js",import.meta.url),"utf8");assert.match(source,/ESPN_FETCH_SETTINGS/);assert.match(background,/function fetchEspnSettings/);assert.match(background,/\?view=mSettings/);assert.match(background,/Promise\.any\(\[backgroundFetch,pageFetch\]\)/);assert.match(background,/AbortSignal\.timeout\(4000\)/)});
