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
const downloads = source.slice(source.indexOf('    const MODEL_DOWNLOADS ='), source.indexOf('    function availableModelDownloads('));
const functions = ['parseGgufName', 'modelIdForEngineStatus', 'ggufIsDsparkSupport', 'ggufIsGlmVisionEncoder',
  'ggufIsDeepseekVisionEncoder', 'ggufIsEngineComponent', 'ggufIsUsableModel', 'availableModelDownloads',
  'availableNativeVisionDownloads', 'launchBase'].map(name => extractFunction(source, name)).join('\n');
vm.runInContext(`${helpers}\n${downloads}\n${functions}`, context);
const plain = value => JSON.parse(JSON.stringify(value));
const item = file => ({file, path: `gguf/${file}`, engineDir: '/fixture/main'});
function check(name, fn) {
  const row = {name}; report.cases.push(row);
  try {fn(); row.status = 'PASS';} catch (error) {row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1;}
  writeArtifact(run, 'results.json', report); console.log(`${row.status}: ${name}`);
}
for (const quant of ['Q2', 'Q4']) check(`${quant} has the V4.1 name, API identity and main-engine download`, () => {
  const model = item(`DeepSeek-V4.1-Flash-${quant}.gguf`);
  assert.deepEqual(plain(context.parseGgufName(model.file)), {model: 'DeepSeek V4.1 Flash', kind: 'standard', quant});
  assert.equal(context.modelIdForEngineStatus({modelFile: model.path, variant: 'flash'}), 'deepseek-v4.1-flash');
  assert(context.ggufIsUsableModel(model, [model]));
  const id = `ds41f-${quant.toLowerCase()}`;
  const before = plain(context.availableModelDownloads([])).find(x => x.id === id);
  assert.deepEqual(before.body, {target: id, engine: 'main'});
  assert(!plain(context.availableModelDownloads([model])).some(x => x.id === id));
});
check('V4.1 encoder is an auxiliary download, never a language model', () => {
  const encoder = item('DeepSeek-V4.1-Flash-Vision.gguf');
  assert(context.ggufIsEngineComponent(encoder)); assert(!context.ggufIsUsableModel(encoder, [encoder]));
  assert(!plain(context.availableModelDownloads([])).some(x => x.id === 'ds41f-vision'));
  const before = plain(context.availableNativeVisionDownloads([])).find(x => x.id === 'ds41f-vision');
  assert.deepEqual(before.body, {target: 'ds41f-vision', engine: 'main'});
  assert(!plain(context.availableNativeVisionDownloads([encoder])).some(x => x.id === 'ds41f-vision'));
});
check('old V4 encoder does not satisfy the V4.1 download', () => {
  const available = plain(context.availableNativeVisionDownloads([item('DeepSeek-V4-Flash-Vision-Encoder.gguf')]));
  assert(available.some(x => x.id === 'ds41f-vision'));
  assert.equal(context.localNativeVisionInfo(settings).kind, 'deepseek41');
  assert.match(context.nativeVisionEncoderError(settings), /matching V4\.1/);
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
