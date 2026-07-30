import test from "node:test";
import assert from "node:assert/strict";
import {reportPage} from "../server/report-page.js";

test("report page template is ASCII-only and its embedded script compiles",()=>{
  const html=reportPage("test-report"),script=html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotMatch(html,/[^\x00-\x7f]/);
  assert.doesNotMatch(html,/row\.responseMs|Final-aligned odds|row\.finalAlignedTitleChance/);
  assert.match(html,/Championship odds ranking/);
  assert.doesNotThrow(()=>new Function(script));
});

test("completed title odds render to three decimal places",async()=>{
  const html=reportPage("precision-report"),script=html.match(/<script>([\s\S]*)<\/script>/)?.[1],app={innerHTML:""},report={teams:2,userSlot:1,iterations:10000,method:"test",simulationModelVersion:"test",grade:{letter:"A",score:90},userTeam:{slot:1,titleRank:1,weeklyRank:1,pointsExact:120,finishProbabilities:[.09144],draft:[]},teamReports:[{slot:1,titleRank:1,points:120,pointsExact:120,finishProbabilities:[.09144]},{slot:2,titleRank:2,points:110,pointsExact:110,finishProbabilities:[.08]}],decisionAudit:{contemporaneous:{available:false,history:[]},hindsight:{objective:"championship-probability",alternatives:[]}}};
  new Function("fetch","document",script)(async()=>({json:async()=>report}),{getElementById:()=>app});
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(app.innerHTML,/9\.144% title chance/);
  assert.match(app.innerHTML,/<strong>9\.144%<\/strong>/);
});
