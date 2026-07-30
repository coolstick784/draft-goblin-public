import test from"node:test";
import assert from"node:assert/strict";
import{sanitizeReportForStorage}from"../extension/local-engine-client.js";

test("durable draft reports strip raw and source-specific projection values recursively",()=>{
  const report={
    platform:"espn",
    normalizedDraftState:{
      players:[{
        id:"p1",
        mean:250,
        platformProjection:300,
        draftGoblinProjection:200,
        projectionConsensus:{points:250,sources:[{key:"espn",points:300}]},
      }],
    },
    decisionAudit:{
      contemporaneous:{
        history:[{
          candidates:[{
            playerId:"p1",
            projectedPoints:250,
            sourceProjections:{espn:300,draftGoblin:200},
            nested:{draftSiteProjection:300,ownedAggregateProjection:210},
          }],
        }],
      },
    },
  };
  const stored=sanitizeReportForStorage(report),text=JSON.stringify(stored);
  assert.equal(stored.normalizedDraftState.players[0].mean,250);
  assert.equal(stored.decisionAudit.contemporaneous.history[0].candidates[0].projectedPoints,250);
  for(const forbidden of["platformProjection","draftSiteProjection","draftGoblinProjection","ownedAggregateProjection","projectionConsensus","sourceProjections"])assert.equal(text.includes(forbidden),false);
});
