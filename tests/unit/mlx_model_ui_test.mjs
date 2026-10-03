// Executes the production catalog/download functions for the MLX Qwen3.6
// folder with simulated catalog entries. No browser, host or model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {extractFunction, artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const source = fs.readFileSync('web/index.html', 'utf8');
const run = artifactRunDir('mlx-model-ui');
const report = {scope: 'Production UI functions with simulated catalog entries; no browser/model', cases: []};
const helpers = source.slice(source.indexOf('    const isGlm53Gguf ='), source.indexOf('    function relativeTime('));
const downloads = source.slice(source.indexOf('    const MODEL_DOWNLOADS ='), source.indexOf('    function availableModelDownloads('));
const functions = ['parseGgufName', 'modelIdForEngineStatus', 'ggufIsDsparkSupport', 'ggufIsGlmVisionEncoder',
  'ggufIsDeepseekVisionEncoder', 'ggufIsEngineComponent', 'ggufIsUsableModel', 'availableModelDownloads']
  .map(name => extractFunction(source, name)).join('\n');
function load(platform) {
  const context = vm.createContext({console, Store: {getSettings: () => ({})}, isLanClientMode: () => false,
    ...(platform ? {navigator: {platform}} : {})});
  vm.runInContext(`${helpers}\n${downloads}\n${functions}`, context);
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));
// The shape the host catalog emits for <engine>/mlx/<folder> (format "mlx").
const mlx = {file: 'Qwen3.6-35B-A3B-mxfp8', path: 'mlx/Qwen3.6-35B-A3B-mxfp8', size: 36616000000,
  format: 'mlx', engineDir: '/fixture/ds4'};
function check(name, fn) {
  const row = {name}; report.cases.push(row);
  try {fn(); row.status = 'PASS';} catch (error) {row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1;}
  writeArtifact(run, 'results.json', report); console.log(`${row.status}: ${name}`);
}
check('the MLX folder is a usable Qwen3.6 model with its own name', () => {
  const c = load('MacIntel');
  assert.deepEqual(plain(c.parseGgufName(mlx.file)), {model: 'Qwen3.6-35B-A3B', kind: 'text · MLX', quant: 'MXFP8'});
  assert(c.ggufIsUsableModel(mlx, [mlx]));
  assert(!c.ggufIsEngineComponent(mlx));
  assert.equal(c.modelIdForEngineStatus({modelFile: mlx.path}), 'qwen3.6-35b-a3b');
});
check('a Mac offers the MLX download until its folder is in the catalog', () => {
  const c = load('MacIntel');
  const offer = plain(c.availableModelDownloads([])).find(d => d.id === 'qwen36-mlx');
  assert.deepEqual(offer.body, {target: 'qwen36-mlx', engine: 'main', mlx: true});
  assert.match(offer.label, /36\.7 GB/);
  assert(!plain(c.availableModelDownloads([mlx])).some(d => d.id === 'qwen36-mlx'));
  const gguf = {file: 'Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', path: 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', engineDir: '/fixture/ds4'};
  assert(plain(c.availableModelDownloads([gguf])).some(d => d.id === 'qwen36-mlx'), 'the GGUF is a different model file');
});
for (const platform of ['Linux x86_64', 'Win32', undefined]) check(`${platform || 'an unknown platform'} never offers the MLX download`, () => {
  assert(!plain(load(platform).availableModelDownloads([])).some(d => d.id === 'qwen36-mlx'));
});
console.log(`Evidence: ${run}`);
