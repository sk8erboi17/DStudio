// Execute the production readiness path with deterministic engine replies.
// This is a UI lifecycle regression, not real inference or model quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {extractFunction, artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {chatSettingsHarness} from '../support/chat_settings_harness.mjs';

const source = fs.readFileSync('web/index.html', 'utf8');
const code = ['localChatBackend', 'withAbort', 'ensureChatReady']
  .map(name => extractFunction(source, name)).join('\n');
const run = artifactRunDir('chat-model-readiness');
const receipt = {scope: 'Production UI readiness, simulated engine; no inference', cases: []};
const qwen = {model: 'qwen3.8-flash-next', modelGguf: 'gguf/Qwen3.8-Flash-Next.gguf',
  modelEngineDir: '/fixture/ds4-qwen38', modelVariant: 'flash', ctxSize: 65536, chatBackend: 'local'};
const defer = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
function harness(initial, settings = qwen, launch = null, beforeStatus = null) {
  let live = structuredClone(initial), starts = [], polls = 0;
  const context = vm.createContext({Promise, DOMException, JSON, Number, String, Math, Date,
    setTimeout: fn => setTimeout(fn, 0), clearTimeout,
    chatReadyFlight: null, chatReadyContext: null, chatReadyKey: null,
    switching: false, launchTarget: '', isLanClientMode: () => false,
    initialSettings: structuredClone(settings),
    ctxSize: () => context.settingsStore.getSettings().ctxSize, Api: {invalidateHealth: () => {}},
    Engine: {status: async () => { polls++; if (beforeStatus) await beforeStatus(); return structuredClone(live); }},
    startServer: async (_mode, requested) => {
      starts.push(structuredClone(requested));
      if (launch) return await launch(requested);
      live = ready(requested); return {ok: true, ctx: requested.ctxSize};
    },
  });
  vm.runInContext(`${chatSettingsHarness(source)}\n${code}`, context);
  const original = context.settingsStore.getSettings();
  return {call: (s = original, signal) => context.ensureChatReady(s, signal),
    snapshot: () => context.settingsStore.getSettings(),
    finished: () => context.chatReadyFlight?.promise.catch(() => {}),
    starts, get polls() {return polls;}, select: s => context.settingsStore.setSettings(s),
    status: s => {live = structuredClone(s);}};
}
function ready(s = qwen) {
  return {mode: 'server', running: true, ready: true, modelFile: s.modelGguf,
    ds4dir: s.modelEngineDir, variant: s.modelVariant, model: s.model,
    config: {ctx: s.ctxSize}};
}
async function check(name, test) {
  const row = {name}; receipt.cases.push(row);
  try {await test(); row.status = 'PASS';}
  catch (error) {row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1;}
  writeArtifact(run, 'results.json', receipt);
  console.log(`${row.status}: ${name}`);
}
await check('another model at the same context is not ready for Qwen', async () => {
  const h = harness({...ready(), modelFile: 'gguf/DeepSeek-V4-Flash.gguf', ds4dir: '/fixture/ds4'});
  const result = await h.call();
  assert.equal(h.starts.length, 1);
  assert.equal(result.modelFile, qwen.modelGguf);
  assert.equal(result.ds4dir, qwen.modelEngineDir);
});
await check('same model file in another engine must not be reused', async () => {
  const h = harness({...ready(), ds4dir: '/fixture/other-qwen-engine'});
  const result = await h.call();
  assert.equal(h.starts.length, 1); assert.equal(result.ds4dir, qwen.modelEngineDir);
});
await check('the matching running model is reused without restart', async () => {
  const h = harness(ready());
  assert.equal((await h.call()).modelFile, qwen.modelGguf); assert.equal(h.starts.length, 0);
});
await check('a context mismatch still requires exactly one restart', async () => {
  const h = harness({...ready(), config: {ctx: 32768}});
  assert.equal((await h.call()).config.ctx, 65536); assert.equal(h.starts.length, 1);
});
await check('an already cancelled request cannot launch a model', async () => {
  const h = harness({mode: 'none', running: false}), controller = new AbortController();
  controller.abort();
  await assert.rejects(h.call(qwen, controller.signal), {name: 'AbortError'});
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.starts.length, 0); assert.equal(h.polls, 0);
});
await check('a stale selected model is rejected before launch', async () => {
  const h = harness({mode: 'none', running: false});
  h.select({...qwen, modelGguf: 'gguf/Qwen3.6-35B-A3B.gguf', modelEngineDir: '/fixture/ds4-qwen35'});
  await assert.rejects(h.call(), /model selection changed/i);
  assert.equal(h.starts.length, 0);
});
await check('cancellation while status is pending cannot start an unwanted engine', async () => {
  const entered = defer(), release = defer(), controller = new AbortController();
  const h = harness({mode: 'none', running: false}, qwen, null, () => {entered.resolve(); return release.promise;});
  const pending = h.call(h.snapshot(), controller.signal);
  await entered.promise; controller.abort();
  await assert.rejects(pending, {name: 'AbortError'}); release.resolve();
  await h.finished();
  assert.equal(h.starts.length, 0);
});
await check('one cancelled waiter cannot cancel another request for the same model', async () => {
  const entered = defer(), release = defer(), first = new AbortController(), second = new AbortController();
  const h = harness({mode: 'none', running: false}, qwen, null, () => {entered.resolve(); return release.promise;});
  const cancelled = h.call(h.snapshot(), first.signal), remaining = h.call(h.snapshot(), second.signal);
  await entered.promise; first.abort(); await assert.rejects(cancelled, {name: 'AbortError'}); release.resolve();
  assert.equal((await remaining).modelFile, qwen.modelGguf); assert.equal(h.starts.length, 1);
});
await check('all cancelled waiters release their shared launch interest', async () => {
  const entered = defer(), release = defer(), first = new AbortController(), second = new AbortController();
  const h = harness({mode: 'none', running: false}, qwen, null, () => {entered.resolve(); return release.promise;});
  const a = h.call(h.snapshot(), first.signal), b = h.call(h.snapshot(), second.signal);
  const results = Promise.allSettled([a, b]);
  await entered.promise; first.abort(); second.abort(); release.resolve();
  assert.ok((await results).every(item => item.status === 'rejected' && item.reason.name === 'AbortError'));
  await h.finished(); assert.equal(h.starts.length, 0);
});
await check('an A-B-A model selection invalidates pending readiness', async () => {
  const entered = defer(), release = defer();
  const h = harness({mode: 'none', running: false}, qwen, null, () => {entered.resolve(); return release.promise;});
  const pending = h.call();
  await entered.promise;
  h.select({...qwen, modelGguf: 'gguf/Qwen3.6-35B-A3B.gguf'}); h.select(qwen); release.resolve();
  await assert.rejects(pending, /model selection changed/i); assert.equal(h.starts.length, 0);
});
await check('launch cannot silently lower requested context', async () => {
  let h;
  h = harness({mode: 'none', running: false}, qwen, async () => {
    h.status({...ready(), config: {ctx: 32768}}); return {ok: true, ctx: 32768};
  });
  await assert.rejects(h.call(), /context/i); assert.equal(h.starts.length, 1);
});
await check('one preparation admits at most 32 observers and cancellation releases their interest', async () => {
  const entered = defer(), release = defer();
  const h = harness({mode: 'none', running: false}, qwen, null, () => {entered.resolve(); return release.promise;});
  const controllers = Array.from({length: 32}, () => new AbortController());
  const pending = controllers.map(controller => h.call(h.snapshot(), controller.signal));
  const results = Promise.allSettled(pending);
  await entered.promise;
  await assert.rejects(h.call(h.snapshot()), /Too many requests/);
  controllers.forEach(controller => controller.abort()); release.resolve();
  assert.ok((await results).every(r => r.status === 'rejected' && r.reason.name === 'AbortError'));
  await h.finished(); assert.equal(h.starts.length, 0);
  assert.equal((await h.call(h.snapshot())).modelFile, qwen.modelGguf);
  assert.equal(h.starts.length, 1, 'Cancelled observers must not prevent a new valid preparation');
});
console.log(`Evidence: ${run}`);
