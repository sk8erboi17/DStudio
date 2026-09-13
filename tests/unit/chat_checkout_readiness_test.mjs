// Run the production checkout resolver, launch preparation, shared readiness
// and HTTP client together. Engine replies are simulated, not model quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {extractFunction, artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {chatSettingsHarness} from '../support/chat_settings_harness.mjs';

const source = fs.readFileSync('web/index.html', 'utf8');
const functions = ['localSsdStreaming', 'launchBase', 'selectSavedModelCheckout', 'startServer',
  'localChatBackend', 'withAbort', 'ensureChatReady', 'createSSEParser'];
const policy = source.slice(source.indexOf('    const localQwen35Selected ='), source.indexOf('    function chatSelectionKey'));
const api = source.slice(source.indexOf('    const Api = (() => {'), source.indexOf('    /* ==================== UI: messages'));
const qwen = {model: 'qwen3.8-flash-next', modelGguf: 'gguf/Qwen3.8-Flash-Next.gguf',
  modelEngineDir: '/old location/ds4-qwen38', modelVariant: 'flash', baseUrl: '',
  chatBackend: 'local', ctxSize: 65536, thinkLevel: 'high', temperature: .35};
const moved = '/new location/ds4-qwen38';
const defer = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const run = artifactRunDir('chat-checkout-readiness');
const receipt = {started: new Date().toISOString(), scope: 'Production resolver/readiness/API, simulated engine; no inference', cases: []};

function harness({catalog, beforeLaunch, checkout = moved} = {}) {
  let live = {mode: 'none', running: false, ds4dir: checkout}, activeCheckout = checkout;
  const launches = [], checkouts = [], requests = [], errors = [];
  const context = vm.createContext({Promise, DOMException, JSON, Number, String, Math, Date,
    AbortController, AbortSignal, TextDecoder, setTimeout: fn => setTimeout(fn, 0), clearTimeout,
    chatReadyFlight: null, switching: false, launchTarget: '', mode: 'server', chatUiTarget: 'server',
    DS4_TRUE_MAX_CONTEXT: 393216, isLanClientMode: () => false, initialSettings: {...qwen},
    ctxSize: () => 65536, toast: message => errors.push(message),
    Engine: {
      status: async () => structuredClone(live),
      ggufs: async () => catalog ? catalog() : {ggufs: [{path: qwen.modelGguf, engineDir: moved}]},
      setEngineCheckout: async dir => {checkouts.push(dir); activeCheckout = dir; return {ok: true};},
    },
    runSwitch: async (_mode, launch) => {
      launches.push(structuredClone(launch));
      if (beforeLaunch) await beforeLaunch();
      live = {mode: 'server', running: true, ready: true, modelFile: launch.gguf,
        ds4dir: activeCheckout, config: {ctx: launch.ctx}};
      return {ok: true, ctx: launch.ctx};
    },
    fetch: async (url, options = {}) => {
      if (url === '/api/embed/stop') return new Response('{}');
      assert.equal(url, '/v1/chat/completions');
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({choices: [{message: {content: 'Answered'}}]}));
    },
  });
  vm.runInContext(`${chatSettingsHarness(source)}\n${policy}\n${functions.map(name => extractFunction(source, name)).join('\n')}\n${api}\nglobalThis.client = Api;`, context);
  return {launches, checkouts, requests, errors,
    snapshot: () => context.settingsStore.getSettings(), select: s => context.settingsStore.setSettings(s),
    finished: () => context.chatReadyFlight?.promise.catch(() => {}),
    ready: (s, signal) => context.ensureChatReady(s, signal),
    answer: (result, original, text) => context.client.completeText({
      model: original.model, settings: result?.requestSettings || original,
      temperature: original.temperature, thinkLevel: original.thinkLevel,
      messages: [{role: 'user', content: text}],
    }),
  };
}
async function check(name, test) {
  const row = {name}; receipt.cases.push(row);
  try {await test(); row.status = 'PASS';}
  catch (error) {row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1;}
  writeArtifact(run, 'results.json', receipt); console.log(`${row.status}: ${name}`);
}

await check('a repaired checkout can answer the pending question without changing its captured settings', async () => {
  const h = harness(), original = Object.freeze({...h.snapshot()});
  const result = await h.ready(original);
  assert.equal(await h.answer(result, original, 'Original question'), 'Answered');
  assert.equal(h.snapshot().modelEngineDir, moved);
  assert.equal(original.modelEngineDir, qwen.modelEngineDir);
  assert.equal(h.launches.length, 1);
  assert.equal(h.requests[0].messages[0].content, 'Original question');
  assert.equal(h.requests[0].model, qwen.model);
  assert.equal(h.requests[0].temperature, .35);
  assert.equal('requestSettings' in h.requests[0], false);
  assert.equal('settings' in h.requests[0], false);
});
await check('coalesced callers receive their own prompt, sampling and reasoning after the same repair', async () => {
  const entered = defer(), release = defer();
  const h = harness({catalog: async () => {entered.resolve(); await release.promise; return {ggufs: [{path: qwen.modelGguf, engineDir: moved}]};}});
  const first = Object.freeze({...h.snapshot(), temperature: .15, thinkLevel: 'low'});
  const second = Object.freeze({...h.snapshot(), temperature: .8, thinkLevel: 'max'});
  const a = h.ready(first), b = h.ready(second);
  await entered.promise; release.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  await h.answer(ra, first, 'Question A'); await h.answer(rb, second, 'Question B');
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.requests.map(r => [r.messages[0].content, r.temperature, r.reasoning_effort]),
    [['Question A', .15, 'low'], ['Question B', .8, 'xhigh']]);
  assert.equal(ra.requestSettings.temperature, .15); assert.equal(rb.requestSettings.temperature, .8);
  assert.notEqual(ra.requestSettings, rb.requestSettings);
  assert.equal(first.modelEngineDir, qwen.modelEngineDir); assert.equal(second.modelEngineDir, qwen.modelEngineDir);
});
await check('one cancelled caller cannot lose another caller during checkout repair', async () => {
  const entered = defer(), release = defer(), controller = new AbortController();
  const h = harness({catalog: async () => {entered.resolve(); await release.promise; return {ggufs: [{path: qwen.modelGguf, engineDir: moved}]};}});
  const first = h.snapshot(), second = {...first, temperature: .8};
  const a = h.ready(first, controller.signal), b = h.ready(second);
  await entered.promise; controller.abort(); await assert.rejects(a, {name: 'AbortError'}); release.resolve();
  assert.equal(await h.answer(await b, second, 'Remaining question'), 'Answered');
  assert.equal(h.launches.length, 1); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].temperature, .8);
});
await check('a queued request with a different context retains its own settings after checkout repair', async () => {
  const entered = defer(), release = defer();
  const h = harness({catalog: async () => {entered.resolve(); await release.promise; return {ggufs: [{path: qwen.modelGguf, engineDir: moved}]};}});
  const first = h.snapshot(), second = {...first, ctxSize: 32768, temperature: .8};
  const a = h.ready(first), b = h.ready(second);
  const results = Promise.all([a, b]);
  await entered.promise; release.resolve();
  const [ra, rb] = await results;
  assert.equal(ra.config.ctx, 65536); assert.equal(rb.config.ctx, 32768);
  assert.equal(rb.requestSettings.ctxSize, 32768); assert.equal(rb.requestSettings.temperature, .8);
  assert.deepEqual(h.launches.map(r => r.ctx), [65536, 32768]);
  assert.equal(await h.answer(rb, second, 'Queued question'), 'Answered');
});
for (const interrupt of ['cancel', 'selection']) await check(`${interrupt} while reading the catalog cannot publish a repair or launch`, async () => {
  const entered = defer(), release = defer(), controller = new AbortController();
  const h = harness({catalog: async () => {entered.resolve(); await release.promise; return {ggufs: [{path: qwen.modelGguf, engineDir: moved}]};}});
  const original = h.snapshot(), pending = h.ready(original, controller.signal);
  const rejected = assert.rejects(pending, {name: interrupt === 'cancel' ? 'AbortError' : 'InvalidStateError'});
  await entered.promise;
  if (interrupt === 'cancel') controller.abort();
  else {h.select({modelGguf: 'gguf/Another.gguf'}); h.select(qwen);}
  release.resolve(); await rejected;
  // Drain the actual shared preparation too: no hidden checkout/launch may
  // follow the cancelled observer after its public promise has rejected.
  await h.finished();
  assert.equal(h.snapshot().modelEngineDir, qwen.modelEngineDir);
  assert.equal(h.checkouts.length, 0); assert.equal(h.launches.length, 0);
});
await check('a repaired request cannot survive a later A-B-A selection', async () => {
  const h = harness(), original = h.snapshot(), result = await h.ready(original);
  h.select({modelGguf: 'gguf/Another.gguf'}); h.select({...qwen, modelEngineDir: moved});
  await assert.rejects(h.answer(result, original, 'Stale question'), {name: 'InvalidStateError'});
  assert.equal(h.requests.length, 0);
});
await check('a queued context cannot adopt a repair after an intervening model selection', async () => {
  const entered = defer(), release = defer();
  const h = harness({beforeLaunch: () => {entered.resolve(); return release.promise;}});
  const original = h.snapshot();
  const a = h.ready(original), b = h.ready({...original, ctxSize: 32768});
  const results = Promise.allSettled([a, b]);
  await entered.promise;
  h.select({modelGguf: 'gguf/Another.gguf'}); h.select({...qwen, modelEngineDir: moved});
  release.resolve();
  assert.ok((await results).every(r => r.status === 'rejected' && r.reason.name === 'InvalidStateError'));
  assert.equal(h.launches.length, 1, 'The obsolete queued context must never be launched');
  assert.equal(h.requests.length, 0);
});
await check('an ambiguous catalog does not choose a different engine for the same file', async () => {
  const h = harness({checkout: qwen.modelEngineDir, catalog: async () => ({ggufs: [
    {path: qwen.modelGguf, engineDir: moved}, {path: qwen.modelGguf, engineDir: '/another/engine'},
  ]})});
  const original = h.snapshot();
  assert.equal(await h.answer(await h.ready(original), original, 'Same engine'), 'Answered');
  assert.equal(h.snapshot().modelEngineDir, qwen.modelEngineDir); assert.equal(h.checkouts.length, 0);
});
receipt.finished = new Date().toISOString();
receipt.passed = receipt.cases.every(row => row.status === 'PASS');
writeArtifact(run, 'results.json', receipt);
console.log(`Evidence: ${run}`);
