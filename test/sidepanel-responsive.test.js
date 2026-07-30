import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html=fs.readFileSync(new URL("../extension/sidepanel.html",import.meta.url),"utf8");
const js=fs.readFileSync(new URL("../extension/sidepanel.js",import.meta.url),"utf8");
const css=fs.readFileSync(new URL("../extension/sidepanel.css",import.meta.url),"utf8");

test("side panel can shrink without document-level horizontal overflow",()=>{
  assert.doesNotMatch(css,/body\{min-width:320px/);
  assert.match(css,/html\{max-width:100%;overflow-x:hidden;scrollbar-gutter:stable\}/);
  assert.match(css,/body\{min-width:0;max-width:100%;overflow-x:hidden\}/);
  assert.match(html,/width=device-width,initial-scale=1/);
});

test("compact layout stacks dense controls and the player board",()=>{
  const compact=css.slice(css.indexOf("@media(max-width:380px)"),css.indexOf("@media(max-width:300px)"));
  assert.match(compact,/\.controls,\.weights,\.projection-sources,\.decision-grid\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(compact,/\.board-tools\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(compact,/\.player-board,\.player-board tbody,\.player-board tr,\.player-board td\{display:block/);
  assert.match(compact,/\.player-board thead\{position:absolute/);
  assert.match(compact,/content:"Draft context"/);
});

test("wide player board keeps horizontal scrolling within the viewport",()=>{
  assert.match(html,/id="boardHorizontalScroll" class="board-horizontal-scroll" role="region" aria-label="Scroll player board columns horizontally" tabindex="0"/);
  assert.match(css,/\.board-horizontal-scroll\{height:14px;[^}]*overflow-x:auto/);
  assert.match(css,/\.board-table-wrap\{height:calc\(100dvh - 250px\);min-height:220px;max-height:640px;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable/);
  const compact=css.slice(css.indexOf("@media(max-width:380px)"),css.indexOf("@media(max-width:300px)"));
  assert.match(compact,/\.board-horizontal-scroll\{display:none\}/);
  assert.match(compact,/\.board-table-wrap\{height:auto;min-height:0;max-height:none;overflow:visible;scrollbar-gutter:auto/);
  assert.match(js,/target\.scrollLeft=sourceRange\?source\.scrollLeft\/sourceRange\*targetRange:0/);
  assert.match(js,/spacer\.style\.width=`\$\{Math\.ceil\(boardHorizontalScroll\.clientWidth\*tableRatio\)\}px`/);
  assert.match(js,/requestAnimationFrame\(syncBoardScrollMetrics\)/);
});

test("all extension scrollbars share the accent theme",()=>{
  assert.match(css,/\*\{box-sizing:border-box;scrollbar-color:var\(--accent\) #15231d\}/);
  assert.match(css,/\*::-webkit-scrollbar-thumb\{border:2px solid #15231d;border-radius:999px;background:var\(--accent\)\}/);
  assert.match(css,/\*::-webkit-scrollbar-track\{background:#15231d\}/);
  assert.match(css,/\*::-webkit-scrollbar-corner\{background:#15231d\}/);
});

test("compact panel explains resizing and keeps full status text in a tooltip",()=>{
  assert.match(html,/Drag Chrome’s divider toward Draft Goblin/);
  assert.match(html,/id="status" class="status" title="Restoring draft…"/);
  assert.match(js,/statusNode\.textContent=value;statusNode\.title=String\(value\)/);
  assert.match(css,/\.resize-tip\{display:block/);
});
