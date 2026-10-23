// Executes production catalog/capability functions. No browser or inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {extractFunction, artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const source = fs.readFileSync('web/index.html', 'utf8');
const run = artifactRunDir('ds41-model-ui');
const report = {scope: 'Production UI functions with simulated state; no browser/model', cases: []};
const settings = {modelGguf: 'gguf/DeepSeek-V4.1-Flash-Q2.gguf', model: 'deepseek-v4.1-flash',
  chatBackend: 'local', enginePower: 100, ctxSize: 32768, ssdStreaming: 'on', dspark: false};
const context = vm.createContext({console, Store: {getSettings: () => settings}, isLanClientMode: () => false});
const helpers = source.slice(source.indexOf('    const isGlm53Gguf ='), source.indexOf('    function relativeTime('));
const downloads = source.slice(source.indexOf('    const DEFAULT_FLASH_GGUF ='), source.indexOf('    function availableModelDownloads('));
const functions = ['parseGgufName', 'modelIdForEngineStatus', 'ggufIsDsparkSupport', 'ggufIsGlmVisionEncoder',
  'ggufIsDeepseekVisionEncoder', 'ggufIsEngineComponent', 'ggufIsModifiedWeights', 'ggufIsUsableModel', 'availableModelDownloads',
  'availableNativeVisionDownloads', 'availableDsparkDownloads', 'preferredDefaultGguf', 'launchBase'].map(name => extractFunction(source, name)).join('\n');
vm.runInContext(`${helpers}\n${downloads}\n${functions}`, context);
const plain = value => JSON.parse(JSON.stringify(value));
const item = file => ({file, path: `gguf/${file}`, engineDir: '/fixture/main'});
function check(name, fn) {
  const row = {name}; report.cases.push(row);
  try {fn(); row.status = 'PASS';} catch (error) {row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1;}
  writeArtifact(run, 'results.json', report); console.log(`${row.status}: ${name}`);
}
for (const quant of ['Q2', 'Q4']) check(`original ${quant} keeps the V4.1 name and API identity and stays selectable`, () => {
  const model = item(`DeepSeek-V4.1-Flash-${quant}.gguf`);
  assert.deepEqual(plain(context.parseGgufName(model.file)), {model: 'DeepSeek V4.1 Flash', kind: 'standard', quant});
  assert.equal(context.modelIdForEngineStatus({modelFile: model.path, variant: 'flash'}), 'deepseek-v4.1-flash');
  assert(context.ggufIsUsableModel(model, [model]));
});
check('Q4 download is the original checkpoint; ds41f-q2 is the 1017 file, as in upstream ds4 5379c1c', () => {
  const q4 = item('DeepSeek-V4.1-Flash-Q4.gguf'), oldQ2 = item('DeepSeek-V4.1-Flash-Q2.gguf');
  const official1017 = item('DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf');
  assert.deepEqual(plain(context.availableModelDownloads([])).find(x => x.id === 'ds41f-q4').body, {target: 'ds41f-q4', engine: 'main'});
  assert(!plain(context.availableModelDownloads([q4])).some(x => x.id === 'ds41f-q4'));
  const q2 = plain(context.availableModelDownloads([])).find(x => x.id === 'ds41f-q2');
  assert.deepEqual(q2.body, {target: 'ds41f-q2', engine: 'main'}); assert.match(q2.label, /1017/);
  // Only the 1017 file satisfies ds41f-q2; an original Q2 on disk does not hide it.
  assert(plain(context.availableModelDownloads([oldQ2])).some(x => x.id === 'ds41f-q2'));
  assert(!plain(context.availableModelDownloads([official1017])).some(x => x.id === 'ds41f-q2'));
});
check('V4.1 encoder is an auxiliary download, never a language model', () => {
  const encoder = item('DeepSeek-V4.1-Flash-Vision.gguf');
  assert(context.ggufIsEngineComponent(encoder)); assert(!context.ggufIsUsableModel(encoder, [encoder]));
  assert(!plain(context.availableModelDownloads([])).some(x => x.id === 'ds41f-vision'));
  const before = plain(context.availableNativeVisionDownloads([])).find(x => x.id === 'ds41f-vision');
  assert.deepEqual(before.body, {target: 'ds41f-vision', engine: 'main'});
  assert(!plain(context.availableNativeVisionDownloads([encoder])).some(x => x.id === 'ds41f-vision'));
});
check('only official weights are offered or selectable', () => {
  const official = item('DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf');
  const modified = item('DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf');
  const modifiedDraft = item('DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128-DSpark-support.gguf');
  assert(context.ggufIsUsableModel(official, [official]));
  for (const file of [modified.file, 'GLM-5.3-Flash-Uncensored-Q2.gguf', 'laguna-s-2.1-heretic-Q4_K_M.gguf'])
    assert(!context.ggufIsUsableModel(item(file), [item(file)]), file);
  const ids = [...plain(context.availableModelDownloads([])), ...plain(context.availableDsparkDownloads([]))].map(x => x.id);
  assert(ids.includes('ds4f-q2') && ids.includes('ds4f-dspark'));
  assert(!ids.some(id => /abliterat/.test(id)) && !ids.includes('flash-dspark'));
  // A leftover modified file is never chosen as the default, even when it is the only model left.
  assert.equal(context.preferredDefaultGguf([modified, official]).file, official.file);
  assert.equal(context.preferredDefaultGguf([modified, modifiedDraft]), null);
});
check('1017 pair: official antirez Q2 + community sidecar, its own names and encoder, disjoint from original V4.1', () => {
  const model = item('DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf'), encoder = item('DeepSeek-V4.1-Flash-1017-Vision.gguf');
  const stockEncoder = item('DeepSeek-V4.1-Flash-Vision.gguf');
  assert.deepEqual(plain(context.parseGgufName(model.file)), {model: 'DeepSeek V4.1 Flash 1017', kind: 'standard', quant: 'Q2'});
  assert.equal(context.modelIdForEngineStatus({modelFile: model.path, variant: 'flash'}), 'deepseek-v4.1-flash-1017');
  assert(context.ggufIsUsableModel(model, [model]));
  assert(context.ggufIsEngineComponent(encoder)); assert(!context.ggufIsUsableModel(encoder, [encoder]));
  const v = plain(context.availableNativeVisionDownloads([])).find(x => x.id === 'ds41f-1017-vision');
  assert.deepEqual(v.body, {target: 'ds41f-1017-vision', engine: 'main'}); assert.match(v.label, /community, nazeshinjite/);
  assert(!plain(context.availableModelDownloads([])).some(x => x.id === 'ds41f-1017-vision' || x.id === 'ds41f-1017-q2'));
  // Each encoder only satisfies its own download.
  assert(!plain(context.availableNativeVisionDownloads([encoder])).some(x => x.id === 'ds41f-1017-vision'));
  assert(plain(context.availableNativeVisionDownloads([encoder])).some(x => x.id === 'ds41f-vision'));
  assert(plain(context.availableNativeVisionDownloads([stockEncoder])).some(x => x.id === 'ds41f-1017-vision'));
  assert.equal(context.localNativeVisionInfo({...settings, modelGguf: model.path}).model, 'DeepSeek V4.1 Flash 1017');
  // The earlier community 1017 Q2 and any other 1017 name are not offered or selectable.
  for (const file of ['DeepSeek-V4.1-Flash-1017-Q2.gguf', 'DeepSeek-V4.1-Flash-1017-Q4.gguf',
                      'DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf.part'])
    assert(!context.ggufIsUsableModel(item(file), []), file);
});
check('old V4 encoder does not satisfy the V4.1 download', () => {
  const available = plain(context.availableNativeVisionDownloads([item('DeepSeek-V4-Flash-Vision-Encoder.gguf')]));
  assert(available.some(x => x.id === 'ds41f-vision'));
  assert.equal(context.localNativeVisionInfo(settings).kind, 'deepseek41');
  const failure = context.nativeVisionEncoderError(settings, { deepseekVisionInstalled: true });
  assert.equal(failure.code, 'native_vision_unavailable');
  assert.match(failure.message, /matching V4\.1/);
  assert.doesNotMatch(failure.message, /encoder is installed/, 'the V4 encoder cannot confirm the V4.1 encoder');
});
check('unrecognized quantization and partial assembly are not selectable', () => {
  for (const file of ['DeepSeek-V4.1-Flash-Q3.gguf', 'DeepSeek-V4.1-Flash-Q4.gguf.assembling', 'DeepSeek-V4.1-Flash-Q2.gguf.part'])
    assert(!context.ggufIsUsableModel(item(file), []));
});
check('SSD and context preferences survive launch construction without changing the selected model', () => {
  const before = JSON.stringify(settings);
  assert.deepEqual(plain(context.launchBase(false, settings)),
    {ctx: 32768, power: 100, ssdStreaming: 'on', metalHotlistSeed: false, dspark: false});
  assert.equal(context.launchBase(false, {...settings, ssdStreaming: 'off'}).ssdStreaming, 'off');
  assert.equal(JSON.stringify(settings), before);
});
check('remote models cannot inherit the local V4.1 vision encoder', () => {
  assert(!context.localNativeVisionInfo({...settings, chatBackend: 'deepseek', deepseekApiKey: 'fixture'}));
  context.isLanClientMode = () => true;
  assert(!context.localNativeVisionInfo(settings));
});
console.log(`Evidence: ${run}`);
