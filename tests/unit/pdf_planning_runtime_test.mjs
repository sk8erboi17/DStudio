// Execute production PDF planning/preparation with simulated inference/reads.
// Virtual elapsed time proves hardware speed does not change page selection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync('web/index.html', 'utf8');
const start = html.indexOf('      function pdfReadPlanFromModel(');
const end = html.indexOf('      function attachTileMeta(', start);
assert.ok(start >= 0 && end > start, 'harness extraction');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let now = 0, transport, answer;
const timers = new Map(); let timerId = 0;
const entries = new Map(), requests = [];
// Simulated transport observes AbortSignal as production fetch does. Full
// WebKit coverage separately executes the actual Api.completeText adapter.
const api = { completeText: (payload, signal) => {
  transport = signal;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => answer(payload, signal)).then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', abort));
  });
} };
const context = {
  console, DOMException, AbortController, AbortSignal, Map, Set,
  performance: { now: () => now },
  setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id; },
  clearTimeout(id) { timers.delete(id); }, setInterval: () => 0, clearInterval() {},
  Api: api, Store: { getSettings: () => ({ model: 'simulated' }), getActiveChat: () => ({ messages: [] }) },
  imageAttachData: entries, pendingAttachments: [], renderPendingAttachments() {},
  isLanClientMode: () => false, isAbortLikeError: e => e?.name === 'AbortError',
  ensureEmbeddingSetup: () => { throw Error('No setup allowed'); },
  fetch: async (_url, opts) => {
    requests.push(JSON.parse(opts.body));
    return { status: 200, ok: true, json: async () => ({ ok: true, readPlanRequired: true }) };
  },
};
const production = vm.runInNewContext(`${html.slice(start, end)}\n({routePdfReadPlan, preparePdfAttachments})`, context);
async function advance(ms) {
  now += ms;
  for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
let finish = deferred(); answer = async () => finish.promise;
let settled = false;
const slowOwner = new AbortController();
const slow = production.routePdfReadPlan('Leggi la pagina fisica 8', { model: 'simulated' }, slowOwner.signal).finally(() => { settled = true; });
await advance(4 * 60 * 60 * 1000);
assert.equal(settled, false); assert.equal(transport.aborted, false);
finish.resolve('{"mode":"pages","pages":"8"}');
assert.deepEqual(JSON.parse(JSON.stringify(await slow)), { mode: 'pages', pages: '8' });
for (const bad of ['broken JSON', '{"mode":"pages"}', '{"mode":"search","query":""}', '{"mode":"unknown"}']) {
  answer = async () => bad;
  await assert.rejects(production.routePdfReadPlan('Read physical page 8', { model: 'simulated' }), /PDF read planner/);
}
answer = async () => '```json\n{"mode":"pages","pages":"8"}\n```';
assert.deepEqual(JSON.parse(JSON.stringify(await production.routePdfReadPlan('Read page 8', { model: 'simulated' }))),
  { mode: 'pages', pages: '8' });

finish = deferred(); answer = async () => finish.promise; const stop = new AbortController();
const canceled = production.routePdfReadPlan('Find a passage', { model: 'simulated' }, stop.signal);
await advance(4 * 60 * 60 * 1000); stop.abort();
await assert.rejects(canceled, { name: 'AbortError' }); assert.equal(transport.aborted, true);
finish.resolve('{"mode":"overview"}');

answer = async () => { throw new Error('Actual engine failed'); };
await assert.rejects(production.routePdfReadPlan('Read pages 8–9', { model: 'simulated' }), /Actual engine failed/);
const attachment = { id: 'preserved-pdf', name: 'document.pdf', kind: 'pdf', content: '' };
entries.set(attachment.id, { pdfBytes: 'data:application/pdf;base64,cHJlc2VydmVk' });
await assert.rejects(production.preparePdfAttachments([attachment], 'Read page 8'), /Actual engine failed/);
assert.equal(requests.length, 1, 'A failed planner cannot send an overview read');
assert.ok(entries.get(attachment.id).pdfBytes, 'Planning failure preserves original bytes for retry');
assert.equal(attachment.content, '');

const originalBytes = entries.get(attachment.id).pdfBytes;
const readStarted = deferred(), readFinish = deferred();
context.fetch = async (_url, opts) => { readStarted.resolve(opts.signal); return readFinish.promise; };
const readStop = new AbortController();
const reading = production.preparePdfAttachments([attachment], 'Read page 8', { signal: readStop.signal });
assert.equal(await readStarted.promise, readStop.signal); readStop.abort();
readFinish.resolve({ status: 200, ok: true, json: async () => ({ ok: true, completeText: true,
  total: 1, textPages: 1, text: 'Late canceled document', sections: [] }) });
await assert.rejects(reading, { name: 'AbortError' });
assert.equal(attachment.content, '', 'Canceled late reads do not publish attachment content');
assert.equal(entries.get(attachment.id).pdfBytes, originalBytes);
assert.equal(timers.size, 0);
console.log('pdf_planning_runtime: PASS — four-hour planning, exact pages, Stop, honest failure, original bytes and canceled late reads');
