import test from"node:test";
import assert from"node:assert/strict";
import{buildPlayerIdentityIndex,matchPlayerIdentity,playerIdentityKey}from"../extension/player-identity.js";

test("player identity normalizes punctuation, accents, and suffixes",()=>{
  assert.equal(playerIdentityKey("D.J. Moore"),playerIdentityKey("DJ Moore"));
  assert.equal(playerIdentityKey("Amon-Ra St. Brown"),playerIdentityKey("Amon Ra St Brown"));
  assert.equal(playerIdentityKey("Marvin Harrison Jr."),playerIdentityKey("Marvin Harrison"));
  assert.equal(playerIdentityKey("José Borregales"),playerIdentityKey("Jose Borregales"));
});

test("known display-name variants join deterministically",()=>{
  const players=[
    {id:"gabe",name:"Gabriel Davis",position:"WR",team:"BUF"},
    {id:"chig",name:"Chigoziem Okonkwo",position:"TE",team:"TEN"},
    {id:"tank",name:"Nathaniel Dell",position:"WR",team:"HOU"},
    {id:"hollywood",name:"Marquise Brown",position:"WR",team:"KC"},
  ],index=buildPlayerIdentityIndex(players);
  assert.equal(matchPlayerIdentity(index,{name:"Gabe Davis",position:"WR",team:"JAX"}).id,"gabe");
  assert.equal(matchPlayerIdentity(index,{name:"Chig Okonkwo",position:"TE"}).id,"chig");
  assert.equal(matchPlayerIdentity(index,{name:"Tank Dell",position:"WR"}).id,"tank");
  assert.equal(matchPlayerIdentity(index,{name:"Hollywood Brown",position:"WR"}).id,"hollywood");
});

test("defenses join by franchise across site naming conventions",()=>{
  const index=buildPlayerIdentityIndex([
    {id:"HOU",name:"Houston Texans",position:"DST",team:"HOU"},
    {id:"LV",name:"Las Vegas Raiders",position:"DST",team:"LV"},
  ]);
  assert.equal(matchPlayerIdentity(index,{name:"Texans D/ST",position:"D/ST",team:"HOU"}).id,"HOU");
  assert.equal(matchPlayerIdentity(index,{name:"Raiders Defense",position:"DEF"}).id,"LV");
  assert.equal(matchPlayerIdentity(index,{name:"Oakland Raiders",position:"DST"}).id,"LV");
});

test("defenses join when ESPN completed-pick rows omit position metadata",()=>{
  const index=buildPlayerIdentityIndex([
    {id:"KC",name:"Kansas City Chiefs",position:"DST",team:"KC"},
    {id:"LAC",name:"Los Angeles Chargers",position:"DST",team:"LAC"},
  ]);
  assert.equal(matchPlayerIdentity(index,{name:"Chiefs D/ST",position:"NA"}).id,"KC");
  assert.equal(matchPlayerIdentity(index,{name:"Kansas City Chiefs"}).id,"KC");
  assert.equal(matchPlayerIdentity(index,{name:"Chargers D/ST",position:"NA"}).id,"LAC");
  assert.equal(matchPlayerIdentity(index,{name:"Chargers Defense",position:"NA"}).id,"LAC");
  assert.equal(matchPlayerIdentity(index,{name:"Kansas City Chiefs",position:"WR"}),null);
});

test("ambiguous normalized names fail closed instead of joining the wrong player",()=>{
  const index=buildPlayerIdentityIndex([
    {id:"one",name:"Chris Smith Jr.",position:"WR",team:"A"},
    {id:"two",name:"Chris Smith",position:"WR",team:"B"},
  ]);
  assert.equal(matchPlayerIdentity(index,{name:"Chris Smith",position:"WR"}),null);
  assert.equal(matchPlayerIdentity(index,{name:"Chris Smith",position:"WR",team:"B"}).id,"two");
});

test("team changes do not prevent a unique player-name join",()=>{
  const index=buildPlayerIdentityIndex([{id:"p",name:"D.J. Moore",position:"WR",team:"CHI"}]);
  assert.equal(matchPlayerIdentity(index,{name:"DJ Moore",position:"WR",team:"CAR"}).id,"p");
});

test("Yahoo initial-and-surname labels join full Draft Goblin identities",()=>{
  const index=buildPlayerIdentityIndex([{id:"achane",name:"De'Von Achane",position:"RB",team:"MIA"},{id:"brown",name:"A.J. Brown",position:"WR",team:"PHI"}]);
  assert.equal(matchPlayerIdentity(index,{name:"D. Achane",position:"RB",team:"Mia"}).id,"achane");
  assert.equal(matchPlayerIdentity(index,{name:"A. Brown",position:"WR",team:"Phi"}).id,"brown");
});

test("ambiguous abbreviated names still fail closed",()=>{
  const index=buildPlayerIdentityIndex([{id:"one",name:"Alex Smith",position:"QB",team:"SF"},{id:"two",name:"Aaron Smith",position:"QB",team:"GB"}]);
  assert.equal(matchPlayerIdentity(index,{name:"A. Smith",position:"QB"}),null);
  assert.equal(matchPlayerIdentity(index,{name:"A. Smith",position:"QB",team:"GB"}).id,"two");
});

test("duplicate API and visible aliases reconcile for every supported name variant",()=>{
  const cases=[
    {canonical:"Kenneth Walker",api:"Kenneth Walker III",visible:"Kenneth Walker",position:"RB",team:"KC"},
    {canonical:"Marvin Harrison",api:"Marvin Harrison Jr.",visible:"Marvin Harrison",position:"WR",team:"ARI"},
    {canonical:"Gabriel Davis",api:"Gabriel Davis",visible:"Gabe Davis",position:"WR",team:"BUF"},
    {canonical:"Marquise Brown",api:"Marquise Brown",visible:"Hollywood Brown",position:"WR",team:"KC"},
    {canonical:"DJ Moore",api:"D.J. Moore",visible:"DJ Moore",position:"WR",team:"CHI"},
  ];
  for(const row of cases){const index=buildPlayerIdentityIndex([{id:"api",name:row.api,position:row.position,team:row.team,platformProjection:190,eligibleForRecommendation:true},{id:"visible",name:row.visible,position:row.position,team:row.team,platformProjection:200,eligibleForRecommendation:true}]),match=matchPlayerIdentity(index,{name:row.canonical,position:row.position,team:row.team});assert.ok(match,`missing ${row.canonical}`);assert.equal(playerIdentityKey(match),playerIdentityKey(row.canonical))}
});

test("duplicate aliases with no exact spelling prefer the most complete same-team row",()=>{
  const index=buildPlayerIdentityIndex([{id:"api",name:"Kenneth Walker III",position:"RB",team:"KC",platformProjection:190,eligibleForRecommendation:true},{id:"visible",name:"Kenneth Walker",position:"RB",team:"KC",platformProjection:0,eligibleForRecommendation:false}]);
  assert.equal(matchPlayerIdentity(index,{name:"Ken Walker",position:"RB",team:"KC"}).id,"api");
});
