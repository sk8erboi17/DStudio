// Production catalog/settings/request functions. No browser or model quality claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {extractFunction, artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {q36VisionPNG} from '../support/q36_vision_fixtures.mjs';

const source = fs.readFileSync('web/index.html', 'utf8');
const helpers = source.slice(source.indexOf('    const isGlm53Gguf ='), source.indexOf('    function relativeTime('));
const functions = ['parseGgufName', 'parseGguf', 'modelIdForEngineStatus', 'ggufIsDsparkSupport',
  'ggufIsGlmVisionEncoder', 'ggufIsDeepseekVisionEncoder', 'ggufIsEngineComponent', 'ggufIsUsableModel',
  'buildBody', 'launchBase', 'confirmTrueThinkingMax', 'restoreContextAfterThinkingMax',
  'setSettings', 'setSettingsNow', 'applySettingsPatch', 'availableModelDownloads', 'modelDownloadStateFromStatus'].map(name =>
    extractFunction(name === 'parseGguf' ? source.slice(source.indexOf('      function parseGguf(')) : source, name)).join('\n');
const run = artifactRunDir('qwen27-model-ui');
const receipt = {scope: 'Production UI functions with simulated state/engine; no model or browser', cases: []};
const file = 'Qwen3.8-27B-UD-Q6_K_XL.gguf', projector = 'Qwen3.8-27B-mmproj-F16.gguf';
const q27 = {model: 'qwen3.8-27b', modelGguf: `gguf/${file}`, modelEngineDir: '/fixture/q36',
  chatBackend: 'local', ctxSize: 65536, thinkLevel: 'high', enginePower: 90,
  ssdStreaming: 'on', dspark: true, metalHotlistSeed: true};
function harness(settings = q27, confirm = async () => true) {
  const prompts = [];
  const context = vm.createContext({console, DOMException, initialSettings: {...settings},
    DS4_TRUE_MAX_CONTEXT: 393216, isLanClientMode: () => false,
    deepseekMode: s => s.chatBackend === 'deepseek',
    Engine: {diagnostics: async () => ({})},
    metalResidencyEstimate: () => null, fmtCtxK: n => `${n / 1024}k`,
    askConfirm: async prompt => {prompts.push(prompt); return confirm(prompt);}});
  const downloads = source.slice(source.indexOf('    const MODEL_DOWNLOADS ='), source.indexOf('    function availableModelDownloads('));
  vm.runInContext(`${helpers}\n${downloads}\n${functions}
    const state = {settings: {...initialSettings, [CHAT_SELECTION_REVISION]: Symbol()}};
    const persistSettings = Object.assign(() => {}, {cancel() {}}), writeKey = () => true, emit = () => {};
    const STORAGE_KEYS = {settings: 'fixture-settings'};
    const Store = {getSettings: () => state.settings, setSettings, setSettingsNow};
    globalThis.settingsStore = Store;
  `, context);
  return {context, prompts, settings: () => context.settingsStore.getSettings(),
    select: patch => context.settingsStore.setSettings(patch)};
}
async function check(name, fn) {
  const row = {name}; receipt.cases.push(row);
  try {await fn(); row.status = 'PASS';}
  catch (error) {row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1;}
  writeArtifact(run, 'results.json', receipt);
  console.log(`${row.status}: ${name}`);
}
const item = (file, engineDir = '/fixture/q36') => ({file, path: `gguf/${file}`, engineDir});
const plain = value => JSON.parse(JSON.stringify(value));
function attachmentHarness(settings = q27) {
  const h = harness(settings), notices = [], pdfRequests = [];
  h.context.imageUri = 'data:image/png;base64,' + q36VisionPNG(0).toString('base64');
  Object.assign(h.context, {toast: (...args) => notices.push(args), renderPendingAttachments() {},
    preparePdfAttachments: async (pdfs, question, options) => pdfRequests.push(plain({pdfs, question, options}))});
  h.context.settingsStore.getState = () => ({ui: {agentWorkdir: '/workspace'}});
  const runtime = ['preparePendingAttachments', 'prepareCoworkPendingAttachments',
    'coworkAttachmentHint', 'nativeModelImagesForHistory', 'msgContentForModel', 'attachmentContextForModel']
    .map(name => extractFunction(source, name)).join('\n');
  vm.runInContext(`const pendingAttachments = [{id: 'pixels', name: 'input.png', kind: 'image',
      content: '', coworkRel: '.attachments/input.png'}];
    const imageAttachData = new Map([['pixels', {dataUri: imageUri}]]);
    const takePendingAttachments = () => pendingAttachments.splice(0);
    const roadmapSafeUrl = value => value;
    ${runtime}`, h.context);
  return {...h, notices, pdfRequests};
}
await check('27B image capability names its own projector and correct download location', () => {
  const {context: c} = harness();
  assert.equal(c.localNativeVisionInfo(q27)?.kind, 'qwen27');
  assert.match(c.nativeVisionEncoderError(q27), /Qwen3\.8-27B/);
  assert.match(c.nativeVisionEncoderError(q27), /Settings.*Models/);
});
await check('27B Chat and Tutor attachment preparation preserves pixels in the produced message', async () => {
  const h = attachmentHarness(), c = h.context;
  const attachments = await c.preparePendingAttachments('Read this image', {consume: false});
  assert.equal(attachments?.length, 1); assert.deepEqual(h.notices, []);
  const images = c.nativeModelImagesForHistory({messages: [{role: 'user', attachments}]}, true);
  const message = c.msgContentForModel({role: 'user', content: 'Read this image', attachments}, images);
  assert.equal(message.filter(part => part.type === 'image_url').length, 1);
  assert.equal(message.find(part => part.type === 'image_url').image_url.url, c.imageUri);
  assert.equal(vm.runInContext('pendingAttachments.length', c), 1, 'Preparation is not consumption');
});
await check('27B Cowork preparation keeps the workspace path for its real image tool', async () => {
  const h = attachmentHarness(), c = h.context;
  const attachments = await c.prepareCoworkPendingAttachments('Read this image', {consume: false});
  assert.equal(attachments?.length, 1); assert.deepEqual(h.notices, []);
  assert.match(c.coworkAttachmentHint(attachments[0]), /view_image/);
  assert(c.coworkAttachmentHint(attachments[0]).includes('.attachments/input.png'));
  assert.equal(vm.runInContext('pendingAttachments.length', c), 1);
});
await check('27B PDF preparation requests native page pixels in Chat and Cowork', async () => {
  for (const cowork of [false, true]) {
    const h = attachmentHarness(), c = h.context;
    vm.runInContext(`pendingAttachments.splice(0, 1, {id: 'pdf', name: 'input.pdf', kind: 'pdf', content: ''});
      imageAttachData.set('pdf', {pdfBytes: 'fixture PDF bytes; renderer simulated'});`, c);
    if (cowork) await c.prepareCoworkPendingAttachments('Read the diagram', {consume: false});
    else await c.preparePendingAttachments('Read the diagram', {consume: false});
    assert.equal(h.pdfRequests.length, 1); assert.equal(h.pdfRequests[0].options.nativeVision, true);
    if (cowork) assert.equal(h.pdfRequests[0].options.coworkDir, '/workspace');
  }
});
await check('switching to a textual model keeps attachments but admits no image request', async () => {
  for (const modelGguf of ['gguf/Laguna-S-2.1-Q4_K_M.gguf', 'gguf/DeepSeek-V4-Flash.gguf',
    'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', 'gguf/Qwen3.8-Flash-Next.gguf']) {
    const h = attachmentHarness(), c = h.context;
    h.select({modelGguf});
    assert.equal(await c.preparePendingAttachments('Read this image', {consume: false}), null);
    assert.equal(await c.prepareCoworkPendingAttachments('Read this image', {consume: false}), null);
    assert.equal(vm.runInContext('pendingAttachments.length', c), 1);
    assert.deepEqual(h.pdfRequests, []); assert.equal(h.notices.length, 2);
    assert(!c.localNativeVisionInfo(h.settings()));
  }
});
await check('cloud and LAN do not inherit the locally installed 27B projector', () => {
  const {context: c} = harness();
  assert(!c.localNativeVisionInfo({...q27, chatBackend: 'deepseek', deepseekApiKey: 'test-only'}));
  c.isLanClientMode = () => true;
  assert(!c.localNativeVisionInfo(q27));
});
await check('download is offered until both exact 27B components share an engine', () => {
  const {context: c} = harness();
  const choices = files => plain(c.availableModelDownloads(files)).filter(x => x.id === 'qwen27-q6');
  assert.equal(choices([]).length, 1);
  assert.deepEqual(choices([])[0].body, {target: 'qwen27-q6', engine: 'q36'});
  assert.equal(choices([item(file)]).length, 1);
  assert.equal(choices([item(projector)]).length, 1);
  assert.equal(choices([item(file), item(projector, '/other')]).length, 1);
  assert.equal(choices([item(file), item(projector)]).length, 0);
});
await check('download phase distinguishes setup, hashing, completion and a resumable interruption', () => {
  const {context: c} = harness();
  const status = {download: true, downloadVariant: 'qwen27-q6', downloadPct: 99, downloadBytes: 26226669152};
  assert.equal(c.modelDownloadStateFromStatus({...status, downloadPhase: 'installing'}).stage, 'Installing engine for');
  assert.equal(c.modelDownloadStateFromStatus({...status, downloadPhase: 'verifying'}).stage, 'Verifying files for');
  assert.equal(c.modelDownloadStateFromStatus({...status, downloadPhase: 'installing'}).pct, null);
  assert.equal(c.modelDownloadStateFromStatus({...status, downloadPhase: 'verifying'}).pct, null);
  assert.equal(c.modelDownloadStateFromStatus({...status, downloadPct: 100, downloadPhase: 'complete'}), null);
  assert.equal(c.modelDownloadStateFromStatus({...status, downloadPct: -1, downloadPhase: 'failed',
    pausedDownload: true, pausedDownloadVariant: 'qwen27-q6'}).paused, true);
});
await check('27B download never invokes synchronous engine setup or rewrites selection', async () => {
  const h = harness(), posts = [], updates = [], notices = [];
  Object.assign(h.context, {ensureModelDownloadEngine: async () => {throw Error('unexpected setup/selection');},
    toast: (...value) => notices.push(value), fetch: async (url, init) => {posts.push([url, JSON.parse(init.body)]); return {json: async () => ({ok: true})};},
    setInterval: () => 1, clearInterval: () => {}, pollDownload: () => {}});
  h.context.settingsStore.setModelState = value => updates.push(plain(value));
  vm.runInContext(`let dlPoll = null; ${extractFunction(source, 'downloadModel')}`, h.context);
  const original = plain(h.settings());
  await h.context.downloadModel({target: 'qwen27-q6', engine: 'q36'});
  assert.deepEqual(posts, [['/api/model/download', {target: 'qwen27-q6'}]]);
  assert.deepEqual(plain(h.settings()), original);
  assert.equal(updates.at(-1).download.variant, 'qwen27-q6');
  assert.equal(notices.some(n => n[1] === 'error'), false);
});
await check('27B name, quantization and API identity are not Flash-Next', () => {
  const {context: c} = harness();
  assert.deepEqual(plain(c.parseGgufName(file)), {model: 'Qwen3.8-27B', kind: 'text + images', quant: 'Q6_K_XL'});
  assert.equal(c.parseGguf(file).model, 'Qwen3.8-27B');
  assert.equal(c.modelIdForEngineStatus({modelFile: `gguf/${file}`, variant: 'flash'}), 'qwen3.8-27b');
});
await check('only the exact 27B quantization with its own projector is selectable', () => {
  const {context: c} = harness();
  const model = item(file), part = item(projector);
  assert.equal(c.ggufIsUsableModel(model, [model]), false);
  assert.equal(c.ggufIsUsableModel(model, [model, item(projector, '/fixture/other')]), false);
  assert.equal(c.ggufIsUsableModel(model, [model, part]), true);
  assert.equal(c.ggufIsUsableModel(item('Qwen3.8-27B-Q4_K_M.gguf'), [part]), false);
  assert.equal(c.ggufIsUsableModel(item(file, ''), [item(projector, '')]), false);
  assert.equal(c.ggufIsUsableModel(part, [model, part]), false);
  assert.equal(c.ggufIsEngineComponent(part), true);
});
await check('27B projector and Flash-Next PLE cannot satisfy each other', () => {
  const {context: c} = harness();
  const flash = item('Qwen3.8-Flash-Next-Q4KImatrixExperts.gguf', '/fixture/qwen38');
  const ple = item('Qwen3.8-Flash-Next-PLE-Q4_1.gguf', flash.engineDir);
  assert.equal(c.ggufIsUsableModel(flash, [flash, item(projector, flash.engineDir)]), false);
  assert.equal(c.ggufIsUsableModel(flash, [flash, ple]), true);
  assert.equal(c.ggufIsUsableModel(item(file), [item(file), item(ple.file)]), false);
  assert.equal(c.modelIdForEngineStatus({modelFile: flash.path}), 'qwen3.8-flash-next');
});
await check('27B uses native full power and no SSD experts/DSpark/hotlist without rewriting preferences', () => {
  const h = harness(), launch = h.context.launchBase(false, h.settings());
  assert.deepEqual(plain(launch), {ctx: 65536, power: 100, ssdStreaming: 'off', metalHotlistSeed: false, dspark: false});
  assert.equal(h.settings().enginePower, 90); assert.equal(h.settings().ssdStreaming, 'on');
  assert.equal(h.settings().dspark, true); assert.equal(h.settings().metalHotlistSeed, true);
});
await check('27B request preserves sampling and uses its native off/high/max rather than xhigh', () => {
  const h = harness();
  for (const thinkLevel of ['off', 'high', 'max']) {
    const body = h.context.buildBody({model: q27.model, messages: [{role: 'user', content: 'Question'}],
      temperature: .6, maxTokens: 45, thinkLevel, settings: {...h.settings(), ctxSize: 131072}});
    assert.equal(body.model, q27.model); assert.equal(body.temperature, .6);
    assert.equal(body.think, thinkLevel !== 'off'); assert.equal(body.reasoning_effort, thinkLevel === 'off' ? undefined : thinkLevel);
  }
});
await check('27B maximum uses native 96k threshold, not DeepSeek 384k', () => {
  const h = harness();
  assert.equal(h.context.thinkingProfile(h.settings()).minimumContext, 98304);
  assert.equal(h.context.thinkingProfile(h.settings()).singleLevel, false);
  assert.equal(h.context.settingsForThinking(h.settings(), 'max').ctxSize, 98304);
  assert.equal(h.settings().ctxSize, 65536);
});
await check('a stale low-context Max preference cannot silently send a weaker request', () => {
  const h = harness();
  assert.throws(() => h.context.buildBody({model: q27.model, messages: [], thinkLevel: 'max', settings: h.settings()}), /needs at least 96k/);
});
await check('accepting 27B max confirms 96k then restores the original capacity', async () => {
  const h = harness();
  assert.equal(await h.context.confirmTrueThinkingMax(), true);
  assert.match(h.prompts[0].title, /96k/);
  assert.equal(h.settings().ctxSize, 98304);
  assert.equal(h.context.restoreContextAfterThinkingMax(), true);
  assert.equal(h.settings().ctxSize, 65536);
});
await check('declining 27B max preserves context and thinking', async () => {
  const h = harness(q27, async () => false);
  assert.equal(await h.context.confirmTrueThinkingMax(), false);
  assert.equal(h.settings().ctxSize, 65536); assert.equal(h.settings().thinkLevel, 'high');
});
await check('Max already fits at 128k and never lowers a larger chosen capacity', async () => {
  const h = harness({...q27, ctxSize: 131072});
  assert.equal(await h.context.confirmTrueThinkingMax(), true);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.context.settingsForThinking(h.settings(), 'max').ctxSize, 131072);
});
await check('a changed model cannot receive an old confirmation or restore another model context', async () => {
  let answer, entered;
  const pending = new Promise(resolve => {entered = resolve;});
  const h = harness(q27, () => {entered(); return new Promise(resolve => {answer = resolve;});});
  const change = h.context.confirmTrueThinkingMax(); await pending;
  h.select({modelGguf: 'gguf/DeepSeek-V4-Flash.gguf', model: 'deepseek-v4-flash', modelEngineDir: '/fixture/ds4'});
  answer(true);
  await assert.rejects(change, /selection changed/i);
  assert.equal(h.settings().ctxSize, 65536);
  const h2 = harness(); await h2.context.confirmTrueThinkingMax();
  h2.select({modelGguf: 'gguf/DeepSeek-V4-Flash.gguf', model: 'deepseek-v4-flash', modelEngineDir: '/fixture/ds4', ctxSize: 393216});
  assert.equal(h2.context.restoreContextAfterThinkingMax(), false);
  assert.equal(h2.settings().ctxSize, 393216);
});
await check('existing Qwen families and DeepSeek retain their native reasoning profiles', () => {
  const {context: c} = harness();
  for (const [file, minimum, maximum] of [['Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', 0, 'on'],
    ['Qwen3.8-Flash-Next.gguf', 0, 'xhigh'], ['DeepSeek-V4-Flash.gguf', 393216, 'max']]) {
    const s = {...q27, modelGguf: `gguf/${file}`};
    assert.equal(c.thinkingProfile(s).minimumContext, minimum);
    assert.equal(c.thinkingProfile(s).maximum, maximum);
  }
});
for (const change of ['context', 'A-B-A']) await check(`a pending Max confirmation is stale after ${change}`, async () => {
  let answer, entered;
  const waiting = new Promise(resolve => {entered = resolve;});
  const h = harness(q27, () => {entered(); return new Promise(resolve => {answer = resolve;});});
  const pending = h.context.confirmTrueThinkingMax(); await waiting;
  if (change === 'context') h.select({ctxSize: 131072});
  else {h.select({modelGguf: 'gguf/DeepSeek-V4-Flash.gguf'}); h.select({modelGguf: q27.modelGguf});}
  answer(true);
  await assert.rejects(pending, /setting changed|selection changed/i);
  assert.equal(h.settings().ctxSize, change === 'context' ? 131072 : 65536);
  assert.equal(h.settings().ctxBeforeThinkMax || 0, 0);
});
await check('an unknown Qwen family is never reported as the default DeepSeek model', () => {
  assert.equal(harness().context.modelIdForEngineStatus({modelFile: 'gguf/Qwen-unqualified.gguf', variant: 'flash'}), '');
});
console.log(`Evidence: ${run}`);
