import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("side panel header uses an opaque stable paint surface",()=>{
  const css=fs.readFileSync(new URL("../extension/sidepanel.css",import.meta.url),"utf8");
  const header=css.match(/header\{([^}]*)\}/)?.[1]||"";
  assert.match(header,/background:#09110f/);
  assert.match(header,/isolation:isolate/);
  assert.doesNotMatch(header,/backdrop-filter/);
});

test("unchanged ESPN connection polls preserve their rendered DOM",()=>{
  const panel=fs.readFileSync(new URL("../extension/sidepanel.js",import.meta.url),"utf8");
  assert.match(panel,/const setTextIfChanged=/);
  assert.match(panel,/const setHtmlIfChanged=/);
  const health=panel.match(/function showConnectionHealth\(health\)\{[^\n]+/)?.[0]||"";
  assert.match(health,/setTextIfChanged\(\$\("status"\)/);
  assert.match(health,/setHtmlIfChanged\(cards/);
  assert.doesNotMatch(health,/cards\.innerHTML=/);
});

test("recommendation polls preserve the visible header status",()=>{
  const panel=fs.readFileSync(new URL("../extension/sidepanel.js",import.meta.url),"utf8");
  assert.match(panel,/const setRecommendationStatus=/);
  assert.match(panel,/contextKey=userPickContext\(state\);[^\n]+samePresentation=renderedContextKey===contextKey/);
  assert.match(panel,/resultVisible=samePresentation&&titleOddsReady\(renderedTitleEvidenceData\)/);
  assert.equal((panel.match(/setRecommendationStatus\(state,waitingForOdds\)/g)||[]).length,2);
});

test("live draft refreshes never reopen the setup coach while enriching data",()=>{
  const panel=fs.readFileSync(new URL("../extension/sidepanel.js",import.meta.url),"utf8");
  const refresh=panel.slice(panel.indexOf("async function refresh"),panel.indexOf("function uiRefresh"));
  assert.match(refresh,/showSetupCoach\(false\);\s*setConnectionStage\("slot"\);\s*const state=await enrichState/);
  assert.doesNotMatch(refresh,/showSetupCoach\(true\)/);
});

test("paused connection and evaluation polls preserve their rendered DOM",()=>{
  const panel=fs.readFileSync(new URL("../extension/sidepanel.js",import.meta.url),"utf8");
  const failure=panel.slice(panel.indexOf("function showEvaluationFailure"),panel.indexOf("const snakeSlot"));
  const connectionError=panel.slice(panel.indexOf("if(stored.draftError"),panel.indexOf("if(health?.phase"));
  for(const source of [failure,connectionError]){
    assert.match(source,/setTextIfChanged\(\$\("status"\),"Recommendations unavailable"\)/);
    assert.match(source,/setHtmlIfChanged\(cards,/);
    assert.doesNotMatch(source,/\$\("status"\)\.textContent="Recommendations unavailable"/);
  }
});
