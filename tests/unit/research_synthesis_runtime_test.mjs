import assert from 'node:assert/strict';
import fs from 'node:fs';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

// Production synthesis/transport lifecycle with simulated model messages and a
// deterministic clock. These are runtime regressions, not model-quality scores.
const runtime = fs.readFileSync(process.env.DSTUDIO_TEST_RESEARCH_RUNTIME || 'extension/search/runtime.js', 'utf8');
const run = artifactRunDir('research-synthesis-runtime');
const receipt = { scope: 'Production research synthesis; simulated model and deterministic clock', cases: [] };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function harness(api) {
  let now = 0, id = 0;
  const timers = new Map();
  const tools = new Function('Api', 'performance', 'setTimeout', 'clearTimeout', `
    const WEB_RESEARCH_TOTAL_TIMEOUT_MS = Infinity;
    ${runtime}
    return { completeWebPipelineText, synthesizeResearchReport, researchReportForDelivery,
      researchReportWantsTechnical, researchReportQuality };
  `)(api, { now: () => now }, (callback, duration) => {
    const timer = ++id; timers.set(timer, { callback, at: now + duration }); return timer;
  }, timer => timers.delete(timer));
  return { tools, async advance(ms) {
    now += ms;
    for (const [timer, entry] of [...timers]) if (entry.at <= now) { timers.delete(timer); entry.callback(); }
    // Drain promise continuations after a deterministic timer barrier.
    for (let i = 0; i < 12; i++) await Promise.resolve();
  } };
}
const sources = [
  { sourceId: 'S1', title: 'Research account', url: 'https://evidence.test/account', read: true },
  { sourceId: 'S2', title: 'Independent account', url: 'https://evidence.test/independent', read: true },
];
const facts = [
  { factId: 'F1', sourceId: 'S1', sourceUrl: sources[0].url, fact: 'An AI model assisted the researchers.' },
  { factId: 'F2', sourceId: 'S2', sourceUrl: sources[1].url, fact: 'The researchers disputed the attribution of their work.' },
];
const state = { facts, byUrl: new Map(sources.map(s => [s.url, s])), judge: { decision: 'enough', gaps: [] } };
const query = 'Spiega la scoperta e la controversia sui ricercatori.';
const first = 'Il modello ha aiutato i ricercatori [F1]. ';
const answer = first + `L’attribuzione del lavoro è contestata [F2].\n\nFonti: ${sources.map(s => s.url).join(' ')}`;
const clean = JSON.stringify({ claimsSupported: true, requestedPartsCovered: true,
  conflictsHandled: true, instructionsFollowed: true, issues: [] });
async function check(name, test) {
  const row = { name }; receipt.cases.push(row);
  try { await test(); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1; }
  writeArtifact(run, 'results.json', receipt); console.log(`${row.status}: ${name}`);
}
await check('slow synthesis and review survive both the old four-minute and fifteen-minute cutoffs', async () => {
  const writerReady = deferred(), writerFinish = deferred(), reviewReady = deferred(), reviewFinish = deferred();
  let writerSignal, reviewerSignal, settled = false;
  const progress = [];
  const api = {
    async completeText(payload, signal) {
      if (payload.messages[0].content.includes('DStudio Deep Research writer')) {
        writerSignal = signal; writerReady.resolve(); await writerFinish.promise; return answer;
      }
      reviewerSignal = signal; reviewReady.resolve(); await reviewFinish.promise; return clean;
    },
    async *streamChat(_payload, signal) {
      writerSignal = signal; writerReady.resolve(); yield { type: 'content', text: first };
      await writerFinish.promise;
      yield { type: 'content', text: answer.slice(first.length) };
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const h = harness(api);
  const pending = h.tools.synthesizeResearchReport(query, state, {}, detail => progress.push(detail));
  pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await writerReady.promise;
    await h.advance(18 * 60 * 1000);
    assert.equal(settled, false, 'Elapsed time cannot replace an active writer with a scaffold');
    assert.equal(writerSignal.aborted, false);
    assert.ok(progress.some(detail => detail.includes('characters received')), 'Streamed writer progress must reach the view');
    writerFinish.resolve();
    await reviewReady.promise;
    await h.advance(30 * 60 * 1000);
    assert.equal(settled, false, 'Review has no application-imposed elapsed-time cutoff either');
    assert.equal(reviewerSignal.aborted, false);
    reviewFinish.resolve();
    const result = await pending;
    assert.equal(result.report, answer); assert.equal(result.quality.ok, true); assert.equal(result.fallback, false);
    assert.equal(h.tools.researchReportForDelivery({ mode: 'research', report: result.report, reportQuality: result.quality }, query).complete, true);
    assert.equal(state.facts, facts, 'Synthesis does not replace the source-evidence owner');
  } finally { writerFinish.resolve(); reviewFinish.resolve(); await pending; }
});
await check('news evidence mentioning a model cannot select technical report sections', async () => {
  const { tools } = harness({});
  assert.equal(tools.researchReportWantsTechnical(query, facts, sources), false);
  assert.equal(tools.researchReportQuality(answer, sources, facts, query).technicalRequired, false);
  const scaffold = answer + '\n\n## Source map\n\n## Stack / Technical Findings';
  assert.equal(tools.researchReportQuality(scaffold, sources, facts, query).forbiddenGeneralTechnical, true);
  assert.equal(tools.researchReportWantsTechnical('Explain the repository build and HTTP server architecture.', facts, sources), true);
});
for (const [name, events, expected, cause] of [
  ['transport failure retains actual Italian draft', [{ type: 'content', text: first }, { type: 'error', message: 'Connection interrupted during the response.' }], first, 'Connection interrupted'],
  ['failure before output publishes no internal scaffold', [{ type: 'error', message: 'Model request failed.' }], '', 'Model request failed'],
  ['model output limit retains a visibly incomplete draft', [{ type: 'content', text: first }, { type: 'finish', reason: 'length' }], first, 'output limit'],
  ['early EOF retains a visibly incomplete draft', [{ type: 'content', text: first }], first, 'before completion'],
]) await check(name, async () => {
  const { tools } = harness({
    async *streamChat() { yield* events; },
    completeText: async () => { throw new Error('Unexpected reviewer call'); },
  });
  const result = await tools.synthesizeResearchReport(query, state, {});
  assert.equal(result.report, expected); assert.equal(result.quality.ok, false);
  assert.equal(result.quality.audit, null); assert.equal(result.fallback, true);
  assert.ok(result.error.includes(cause)); assert.equal(result.attempts.length, 1);
  assert.ok(result.draft.length > 0, 'Internal evidence scaffold remains diagnostic data');
  const delivered = tools.researchReportForDelivery({ mode: 'research', report: result.report,
    reportQuality: result.quality, reportSynthesisError: result.error }, query);
  assert.equal(delivered.content, expected); assert.equal(delivered.complete, false);
  assert.ok(delivered.error.includes(cause), 'Display the actual failure beside the draft');
});
await check('Stop rejects an unlimited stream and cannot publish a late reply', async () => {
  const entered = deferred(), release = deferred();
  let transportSignal, progress = 0;
  const h = harness({ async *streamChat(_payload, signal) {
    transportSignal = signal; yield { type: 'content', text: first }; entered.resolve();
    await release.promise; yield { type: 'content', text: 'late discarded text' }; yield { type: 'finish', reason: 'stop' };
  } });
  const stop = new AbortController();
  const pending = h.tools.completeWebPipelineText({}, Infinity, 'Writer', stop.signal, { onProgress: () => { progress++; } });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise; stop.abort(); await rejected;
  assert.equal(transportSignal.aborted, true); const before = progress;
  release.resolve(); await h.advance(1000);
  assert.equal(progress, before, 'Late stream bytes cannot update a cancelled view');
});
await check('an explicit fault-injection deadline aborts the real stream and retains its bytes', async () => {
  const entered = deferred(), release = deferred(); let transportSignal;
  const h = harness({ async *streamChat(_payload, signal) {
    transportSignal = signal; yield { type: 'content', text: first }; entered.resolve();
    await release.promise; yield { type: 'finish', reason: 'stop' };
  } });
  const pending = h.tools.completeWebPipelineText({}, 5000, 'Writer', undefined, {});
  const rejected = assert.rejects(pending, error => error.name === 'TimeoutError' && error.partialText === first);
  await entered.promise; await h.advance(6000); await rejected;
  assert.equal(transportSignal.aborted, true); release.resolve(); await h.advance(0);
});
await check('an unlimited stream still has a bounded retained draft', async () => {
  const { tools } = harness({ async *streamChat() {
    for (let i = 0; i < 3; i++) yield { type: 'content', text: 'a'.repeat(30000) };
    yield { type: 'finish', reason: 'stop' };
  } });
  await assert.rejects(tools.completeWebPipelineText({}, Infinity, 'Writer', undefined, {}), error =>
    error.message.includes('retained draft size') && error.partialText.length === 60000);
});
receipt.status = process.exitCode ? 'FAIL' : 'PASS';
writeArtifact(run, 'results.json', receipt);
console.log(`Evidence: ${run}`);
