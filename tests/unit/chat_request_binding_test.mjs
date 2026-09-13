// Production API client, actual JSON/SSE consumption and deterministic fetch
// barriers. Simulated server replies; this does not claim inference quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {extractFunction, artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {chatSettingsHarness} from '../support/chat_settings_harness.mjs';

const html = fs.readFileSync('web/index.html', 'utf8');
const api = html.slice(html.indexOf('    const Api = (() => {'),
  html.indexOf('    /* ==================== UI: messages'));
const policy = html.slice(html.indexOf('    const localQwen35Selected ='),
  html.indexOf('    function chatSelectionKey'));
const helpers = ['createSSEParser'].map(name => extractFunction(html, name)).join('\n');
const qwen = {model: 'qwen3.8-flash-next', modelGguf: 'gguf/Qwen3.8-Flash-Next.gguf',
  modelEngineDir: '/fixture/qwen38', baseUrl: '', chatBackend: 'local', ctxSize: 65536};
const other = {...qwen, model: 'qwen3.6-35b-a3b', modelGguf: 'gguf/Qwen3.6-35B-A3B.gguf', modelEngineDir: '/fixture/qwen35'};
const request = {model: qwen.model, messages: [{role: 'user', content: 'Test question'}], thinkLevel: 'max', temperature: .35};
const defer = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
const run = artifactRunDir('chat-request-binding');
const report = {scope: 'Production HTTP client with simulated responses', cases: []};

function harness({auxiliary, completion, initial = qwen} = {}) {
  const calls = [];
  const context = vm.createContext({Promise, DOMException, JSON, Number, String, Math, Date,
    AbortController, AbortSignal, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    DS4_TRUE_MAX_CONTEXT: 393216, isLanClientMode: () => false,
    initialSettings: {...initial},
    fetch: async (url, options = {}) => {
      calls.push({url, options});
      if (url === '/api/embed/stop') { if (auxiliary) await auxiliary(); return new Response('{}'); }
      assert(url.endsWith('/v1/chat/completions'), `Unexpected request: ${url}`);
      return completion ? completion(url, options)
        : new Response(JSON.stringify({choices: [{message: {content: 'Answer'}}]}));
    },
  });
  vm.runInContext(`${chatSettingsHarness(html)}\n${policy}\n${helpers}\n${api}\nglobalThis.client = Api;`, context);
  return {client: context.client, calls, snapshot: () => context.settingsStore.getSettings(),
    select: value => context.settingsStore.setSettings(value)};
}
async function check(name, test) {
  const row = {name}; report.cases.push(row);
  try {await test(); row.status = 'PASS';}
  catch (error) {row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1;}
  writeArtifact(run, 'results.json', report); console.log(`${row.status}: ${name}`);
}

await check('a queued local request never switches to a newly selected cloud provider', async () => {
  const entered = defer(), release = defer();
  const h = harness({auxiliary: () => {entered.resolve(); return release.promise;}});
  const pending = h.client.completeText({...request, settings: qwen});
  await entered.promise;
  h.select({...qwen, chatBackend: 'deepseek', deepseekModel: 'deepseek-v4-flash', deepseekApiKey: 'fixture-only'});
  release.resolve();
  await assert.rejects(pending, /model selection changed/i);
  assert.equal(h.calls.length, 1, 'No model request may follow the stale preparation');
});
await check('a stale audit fails before releasing auxiliaries or sending a request', async () => {
  const h = harness(); h.select(other);
  await assert.rejects(h.client.completeText({...request, settings: qwen}), /model selection changed/i);
  assert.equal(h.calls.length, 0);
});
await check('a saved request cannot survive selecting Qwen, another model, then Qwen again', async () => {
  const h = harness(), settings = h.snapshot();
  h.select(other); h.select(qwen);
  await assert.rejects(h.client.completeText({...request, settings}), /model selection changed/i);
  assert.equal(h.calls.length, 0, 'An old selection must not acquire authority by matching again');
});
await check('an in-flight response is stale after an A-B-A model selection', async () => {
  const entered = defer(), release = defer();
  const h = harness({completion: () => ({ok: true, json: async () => {entered.resolve(); await release.promise;
    return {choices: [{message: {content: 'Obsolete answer'}}]};}})});
  const pending = h.client.completeText({...request, settings: h.snapshot()});
  await entered.promise; h.select(other); h.select(qwen); release.resolve();
  await assert.rejects(pending, /model selection changed/i);
});
await check('settings publication does not mutate an existing request snapshot', async () => {
  const h = harness(), settings = h.snapshot();
  h.select(other);
  assert.equal(settings.modelGguf, qwen.modelGguf);
  assert.equal(h.snapshot().modelGguf, other.modelGguf);
  await assert.rejects(h.client.completeText({...request, settings}), /model selection changed/i);
  assert.equal(h.calls.length, 0);
});
await check('prompt and sampling are frozen before waiting for auxiliary release', async () => {
  const entered = defer(), release = defer();
  const h = harness({auxiliary: () => {entered.resolve(); return release.promise;}});
  const input = {...request, messages: [{role: 'user', content: 'Original request'}]};
  const pending = h.client.completeText(input);
  await entered.promise; input.messages[0].content = 'A later request'; input.temperature = .99; release.resolve();
  await pending;
  const body = JSON.parse(h.calls.at(-1).options.body);
  assert.equal(body.messages[0].content, 'Original request'); assert.equal(body.temperature, .35);
});
await check('sampling settings cannot change during auxiliary release', async () => {
  const entered = defer(), release = defer();
  const h = harness({auxiliary: () => {entered.resolve(); return release.promise;}});
  const pending = h.client.completeText(request);
  await entered.promise; h.select({...qwen, dspark: true}); release.resolve();
  assert.equal(await pending, 'Answer');
  const body = JSON.parse(h.calls.at(-1).options.body);
  assert.equal(body.temperature, .35); assert.equal(body.model, qwen.model);
  assert.equal(body.reasoning_effort, 'xhigh');
  assert.equal('settings' in body, false, 'Client settings must never enter the wire payload');
});
await check('a late nonstreaming response is rejected after model selection changes', async () => {
  const entered = defer(), release = defer();
  const h = harness({completion: () => ({ok: true, json: async () => {entered.resolve(); await release.promise;
    return {choices: [{message: {content: 'Stale answer'}}]};}})});
  const pending = h.client.completeText({...request, settings: qwen});
  await entered.promise; h.select(other); release.resolve();
  await assert.rejects(pending, /model selection changed/i);
});
await check('a pre-cancelled stream does not perform auxiliary or inference work', async () => {
  const h = harness(), controller = new AbortController(); controller.abort();
  const events = [];
  for await (const event of h.client.streamChat(request, controller.signal)) events.push(event);
  assert.equal(events.length, 1); assert.equal(events[0].type, 'abort'); assert.equal(h.calls.length, 0);
});
for (const mode of ['stream', 'complete']) for (const interrupt of ['selection', 'cancel'])
await check(`${mode} releases a response received after ${interrupt} before consuming its body`, async () => {
  const entered = defer(), release = defer();
  let cancelled = false, bodyRead = false;
  const response = new Response(new ReadableStream({cancel() {cancelled = true;}}));
  response.json = async () => {bodyRead = true; return {choices: [{message: {content: 'Obsolete'}}]};};
  const h = harness({completion: async () => {entered.resolve(); await release.promise; return response;}});
  const controller = new AbortController(), input = {...request, settings: h.snapshot()};
  const events = [];
  const pending = mode === 'complete' ? h.client.completeText(input, controller.signal)
    : (async () => {for await (const event of h.client.streamChat(input, controller.signal)) events.push(event);})();
  await entered.promise;
  if (interrupt === 'selection') h.select(other); else controller.abort();
  release.resolve();
  try {
    if (mode === 'complete') await assert.rejects(pending,
      {name: interrupt === 'selection' ? 'InvalidStateError' : 'AbortError'});
    else {
      await pending;
      assert.equal(events.length, 1);
      assert.equal(events[0].type, interrupt === 'selection' ? 'error' : 'abort');
      if (interrupt === 'selection') assert.equal(events[0].errType, 'model_selection');
    }
    assert.equal(bodyRead, false, 'An obsolete reply must not start JSON consumption');
    assert.equal(cancelled, true, 'Discarding headers must also release the response stream');
  } finally {
    await response.body.cancel();
  }
});
for (const interrupt of ['selection', 'cancel']) await check(`buffered stream events stop immediately on ${interrupt}`, async () => {
  let cancelled = false;
  const frame = text => `data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\n`;
  const h = harness({completion: () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(new TextEncoder().encode(frame('First') + frame('Obsolete')));},
    cancel() {cancelled = true;},
  }))});
  const abort = new AbortController(), stream = h.client.streamChat({...request, settings: h.snapshot()}, abort.signal);
  assert.equal((await stream.next()).value.text, 'First');
  if (interrupt === 'selection') {h.select(other); h.select(qwen);} else abort.abort();
  const event = (await stream.next()).value;
  assert.equal(event.type, interrupt === 'selection' ? 'error' : 'abort');
  if (interrupt === 'selection') assert.equal(event.errType, 'model_selection');
  assert.equal((await stream.next()).done, true); assert.equal(cancelled, true);
});
await check('Qwen3.6 sends native on/off, not an invented reasoning effort', async () => {
  const h = harness({initial: other});
  await h.client.completeText({...request, model: other.model, settings: other});
  const body = JSON.parse(h.calls.at(-1).options.body);
  assert.equal(body.think, true); assert.equal(body.reasoning_effort, undefined); assert.equal(body.model, other.model);
});
console.log(`Evidence: ${run}`);
