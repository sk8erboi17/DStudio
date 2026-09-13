// Execute the production scroll controller with deterministic animation frames.
// Simulated geometry is paired with the full Chromium/WebKit Tutor interaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {extractFunction, artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const source = fs.readFileSync('web/index.html', 'utf8');
const run = artifactRunDir('follow-scroll');
const report = {scope: 'Production scroll controller; deterministic DOM/frame simulation', cases: []};
function harness() {
  const frames = [];
  let selected = false, top = 0;
  const scroller = {isConnected: true, clientHeight: 400, scrollHeight: 1000,
    get scrollTop() {return top;}, set scrollTop(value) {top = Math.min(Math.max(value, 0), this.scrollHeight - this.clientHeight);}};
  const context = vm.createContext({performance: {now: () => 100}, Math, Number,
    SCROLL_KEYS: ['ArrowUp', 'PageUp'], selectionInside: () => selected,
    isNearBottom: (node, margin = 120) => node.scrollHeight - node.scrollTop - node.clientHeight <= margin,
    requestAnimationFrame: callback => {frames.push(callback); return frames.length;}});
  vm.runInContext(extractFunction(source, 'createFollowScroll'), context);
  return {scroll: scroller, follow: context.createFollowScroll(() => scroller),
    frame: () => {const pending = frames.splice(0); for (const callback of pending) callback();},
    one: () => frames.shift()?.(), select: () => {selected = true;}};
}
async function check(name, test) {
  const row = {name}; report.cases.push(row);
  try {await test(); row.status = 'PASS';}
  catch (error) {row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1;}
  writeArtifact(run, 'results.json', report); console.log(`${row.status}: ${name}`);
}
await check('an older repaint cannot restore its reading position over a newer repaint', () => {
  const h = harness(); h.follow.settle(false, 150, {rebuilt: true}); h.frame();
  h.follow.settle(false, 300, {rebuilt: true});
  h.one(); // Post-paint restore belonging to the first, superseded repaint.
  assert.equal(h.scroll.scrollTop, 300);
});
await check('wheel input in the same clock tick cancels prior bottom convergence', () => {
  const h = harness(); h.follow.settle(true, 0);
  h.follow.onWheel({deltaY: -320}); h.scroll.scrollTop = 110; h.follow.onScroll();
  h.scroll.scrollTop = 0; // A subsequent streaming DOM rebuild clamps scroll.
  h.follow.settle(false, 110, {rebuilt: true});
  h.one(); assert.equal(h.scroll.scrollTop, 110);
});
await check('a DOM text selection prevents a deferred jump without a pointer event', () => {
  const h = harness(); h.follow.settle(true, 0); h.select(); h.scroll.scrollHeight += 200;
  h.frame(); assert.equal(h.scroll.scrollTop, 600);
});
await check('without user input bottom convergence still follows post-layout growth', () => {
  const h = harness(); h.follow.settle(true, 0); h.scroll.scrollHeight += 200;
  h.frame(); assert.equal(h.scroll.scrollTop, 800);
});
await check('a rebuilt conversation restores the requested reading position', () => {
  const h = harness(); h.follow.settle(false, 140, {rebuilt: true});
  h.frame(); h.frame(); assert.equal(h.scroll.scrollTop, 140);
});
console.log(`Evidence: ${run}`);
