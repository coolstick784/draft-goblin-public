import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html=fs.readFileSync(new URL("../extension/sidepanel.html",import.meta.url),"utf8");
const js=fs.readFileSync(new URL("../extension/sidepanel.js",import.meta.url),"utf8");
const css=fs.readFileSync(new URL("../extension/sidepanel.css",import.meta.url),"utf8");

test("first paint restores draft state without flashing onboarding",()=>{
  assert.match(html,/id="setupCoach" class="setup-coach" hidden/);
  assert.match(html,/id="status" class="status" title="Restoring draft…">Restoring draft…/);
  assert.match(html,/id="range">Restoring live draft state\./);
});

test("idle panel offers direct platform launch and a connection checklist",()=>{
  for(const id of ["setupCoach","openEspn","openSleeper","checkDraft","checkSettings","checkSlot","checkRecommendations"])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/fantasy\.espn\.com\/football\/mockdraftlobby/);
  assert.match(js,/sleeper\.com\/drafts/);
});

test("decision and player-board tabs expose searchable sortable draft data",()=>{
  for(const id of ["decisionTab","boardTab","decisionPanel","boardPanel","boardSearch","boardPosition","boardSort","boardRows"])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/role="tablist"/);
  assert.match(html,/<table class="player-board">/);
  assert.match(html,/id="boardPosition"[\s\S]*type="checkbox" value="QB"[\s\S]*type="checkbox" value="WR"/);
  assert.match(js,/positions\.has\(row\.player\?\.position\)/);
  assert.match(js,/requestPlayerBoard\(state,sequence\)/);
  assert.match(js,/Title odds will appear when all 10,000 simulations finish/)
});

test("tutorial is versioned, persisted, replayable, and keyboard-dismissible",()=>{
  assert.match(js,/TUTORIAL_VERSION="sidepanel-onboarding-v2-decision-board"/);
  assert.match(js,/completedSidepanelTutorial/);
  assert.match(html,/id="replayTutorial"/);
  assert.match(js,/event\.key==="Escape"/);
  assert.match(js,/prefers-reduced-motion: reduce/);
});

test("tutorial pointer follows the highlighted target",()=>{
  assert.match(js,/function positionTutorialPointer\(\)/);
  assert.match(js,/targetRect\.left\+targetRect\.width\/2-coachmarkRect\.left/);
  assert.match(js,/window\.addEventListener\("resize",positionTutorialPointer\)/);
  assert.match(css,/left:var\(--tutorial-pointer-x\)/);
});

test("advanced controls are hidden by default",()=>{
  assert.match(html,/<details id="advancedControls"/);
});

test("manual slot fallback is validated and isolated to one draft run",()=>{
  assert.match(js,/manualDraftSlot:\$\{state\.platform\}:\$\{state\.draftId\}:\$\{state\.draftRunId\|\|"default"\}/);
  assert.match(js,/!Number\.isInteger\(value\)\|\|value<1\|\|value>teams/);
  assert.match(js,/automatic detection remains preferred/);
});
