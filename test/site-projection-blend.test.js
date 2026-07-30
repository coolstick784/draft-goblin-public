import test from"node:test";
import assert from"node:assert/strict";
import{DEFAULT_PROJECTION_DRIVER,projectionDriverSelection,PROJECTION_DRIVERS}from"../extension/site-projection-blend.js";

test("Draft Goblin is the default projection driver for every position",()=>{
  assert.equal(DEFAULT_PROJECTION_DRIVER,"draftGoblin");
  for(const position of["QB","RB","WR","TE","K","DST"]){
    const result=projectionDriverSelection({season:2026,position,platform:"espn",siteProjection:300,draftGoblinProjection:200,fantasyProsProjection:250,sleeperProjection:275});
    assert.equal(result.points,200);
    assert.equal(result.selectedDriver,"draftGoblin");
    assert.equal(result.sources.find(source=>source.label==="Draft Goblin").weight,1);
  }
});

test("the user can explicitly drive rankings and simulations with the current draft site",()=>{
  const common={season:2026,platform:"espn",siteProjection:300,draftGoblinProjection:200,fantasyProsProjection:250,sleeperProjection:275};
  assert.deepEqual(PROJECTION_DRIVERS,["draftGoblin","platform"]);
  const result=projectionDriverSelection({...common,driver:"platform"});
  assert.equal(result.points,300);
  assert.equal(result.selectedDriver,"platform");
  assert.equal(result.sources.filter(source=>source.weight===1).length,1);
});

test("a legacy off-site provider selection resolves to Draft Goblin",()=>{
  const result=projectionDriverSelection({season:2026,platform:"espn",driver:"fantasyPros",siteProjection:300,draftGoblinProjection:210});
  assert.equal(result.points,210);
  assert.equal(result.selectedDriver,"draftGoblin");
  assert.equal(result.requestedDriver,"draftGoblin");
  assert.equal(result.fallbackReason,null);
  assert.equal(result.sources.some(source=>source.label==="FantasyPros"||source.label==="Sleeper"),false);
});

test("a provider can safely carry a player when Draft Goblin is unavailable",()=>{
  const result=projectionDriverSelection({season:2026,platform:"sleeper",siteProjection:190});
  assert.equal(result.points,190);
  assert.equal(result.selectedDriver,"platform");
  assert.equal(result.fallbackReason,"draftGoblin-unavailable");
});

test("all missing projections fail closed",()=>{
  const result=projectionDriverSelection({season:2026,platform:"espn"});
  assert.equal(result.points,0);
  assert.equal(result.selectedDriver,null);
  assert.equal(result.fallbackReason,"no-current-projection");
  assert.deepEqual(result.sources,[]);
});
