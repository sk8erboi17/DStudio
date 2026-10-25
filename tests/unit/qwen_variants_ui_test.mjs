// Executes the production UI catalog functions on the document the host
// serves (scripts/qwen-variants.json, byte for byte; see qwen_variants_unit.c)
// with simulated folder listings. No browser, host or model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {extractFunction, artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const source = fs.readFileSync('web/index.html', 'utf8');
const run = artifactRunDir('qwen-variants-ui');
const report = {scope: 'Production UI functions on the shipped catalog document; simulated listings; no browser/model', cases: []};
const served = JSON.parse(fs.readFileSync('scripts/qwen-variants.json', 'utf8'));
const helpers = source.slice(source.indexOf('    const isGlm53Gguf ='), source.indexOf('    function relativeTime('));
const downloads = source.slice(source.indexOf('    const DEFAULT_FLASH_GGUF ='), source.indexOf('    function availableModelDownloads('));
const functions = ['parseGgufName', 'modelIdForEngineStatus', 'ggufIsDsparkSupport', 'ggufIsGlmVisionEncoder',
  'ggufIsDeepseekVisionEncoder', 'ggufIsEngineComponent', 'ggufIsModifiedWeights', 'ggufIsUsableModel',
  'availableModelDownloads', 'modelDownloadChoice', 'modelDownloadOptionLabel'].map(name => extractFunction(source, name)).join('\n');
function load(platform, document = served) {
  const context = vm.createContext({console, Store: {getSettings: () => ({})}, isLanClientMode: () => false,
    ...(platform ? {navigator: {platform}} : {})});
  vm.runInContext(`${helpers}\n${downloads}\n${functions}`, context);
  if (document) assert.equal(context.applyQwenCatalog(document), true);
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));
const gguf = (file, engineDir = '/fixture/ds4') => ({file, path: `gguf/${file}`, size: 1, engineDir});
const folder = (name, engineDir = '/fixture/ds4') => ({file: name, path: `mlx/${name}`, size: 1, format: 'mlx', engineDir});
const qwenOffers = (c, listing = []) => plain(c.availableModelDownloads(listing)).filter(d => d.qwen);
function check(name, fn) {
  const row = {name}; report.cases.push(row);
  try {fn(row); row.status = 'PASS';} catch (error) {row.status = 'FAIL'; row.error = String(error.stack); process.exitCode = 1;}
  writeArtifact(run, 'results.json', report); console.log(`${row.status}: ${name}`);
}

check('a Mac offers every pinned variant once, with its engine, quantization and size', row => {
  const offers = qwenOffers(load('MacIntel'));
  row.count = offers.length;
  assert.equal(offers.length, served.variants.length);
  assert.equal(new Set(offers.map(d => d.id)).size, offers.length);
  const label = id => offers.find(d => d.id === id).label;
  assert.equal(label('qwen36-q4_k_m'), 'Qwen3.6-35B-A3B · Q4_K_M — 22.1 GB · llama.cpp · text only');
  const status = ' · Experimental, quality checks incomplete'; // the 27B family's existing status
  assert.equal(label('qwen27-iq2_xxs'), 'Qwen3.8-27B · IQ2_XXS + F16 projector — 8.2 GB · llama.cpp · text and images' + status);
  assert.equal(label('qwen36-bf16'), 'Qwen3.6-35B-A3B · BF16 (2 files) — 69.4 GB · llama.cpp · text only');
  assert.equal(label('qwen27-mlx-4bit'), 'Qwen3.8-27B · MLX 4-bit — 16.1 GB · MLX, Apple Silicon · text only' + status);
  assert.equal(label('qwen36-mlx-nvfp4'), 'Qwen3.6-35B-A3B · MLX NVFP4 — 20.4 GB · MLX, Apple Silicon · text only');
  // No per-variant verification label: within a family every entry carries the same status.
  assert.doesNotMatch(offers.map(d => d.label).join('\n'), /unverified/i);
  for (const family of ['Qwen3.6-35B-A3B', 'Qwen3.8-27B'])
    assert.equal(new Set(offers.filter(d => d.label.startsWith(family)).map(d => /Experimental/.test(d.label))).size, 1, family);
  // The original ids, bodies and sizes are unchanged.
  assert.deepEqual(offers.find(d => d.id === 'qwen36-q6').body, {target: 'qwen36-q6', engine: 'main', llama: true});
  assert.deepEqual(offers.find(d => d.id === 'qwen27-q6').body, {target: 'qwen27-q6', engine: 'main', llama: true});
  assert.deepEqual(offers.find(d => d.id === 'qwen36-mlx').body, {target: 'qwen36-mlx', engine: 'main', mlx: true});
  assert.match(label('qwen36-q6'), /31\.8 GB/); assert.match(label('qwen27-q6'), /26\.2 GB/); assert.match(label('qwen36-mlx'), /36\.7 GB/);
  assert.deepEqual([...new Set(offers.map(d => d.group))],
    ['Qwen3.6-35B-A3B · llama.cpp', 'Qwen3.6-35B-A3B · MLX', 'Qwen3.8-27B · llama.cpp', 'Qwen3.8-27B · MLX']);
});
for (const platform of ['Linux x86_64', 'Win32', undefined]) check(`${platform || 'an unknown platform'} offers the GGUF variants only`, () => {
  const offers = qwenOffers(load(platform));
  assert.equal(offers.length, served.variants.filter(v => v.engine === 'llama').length);
  assert(offers.every(d => d.body.llama && !d.body.mlx));
});
check('an offer disappears once one engine folder holds every file of the variant', () => {
  const c = load('MacIntel');
  const offered = listing => qwenOffers(c, listing).map(d => d.id);
  assert(!offered([gguf('Qwen3.6-35B-A3B-UD-Q4_K_M.gguf')]).includes('qwen36-q4_k_m'));
  assert(offered([gguf('Qwen3.8-27B-UD-Q4_K_M.gguf')]).includes('qwen27-q4_k_m'), '27B without its projector is incomplete');
  assert(!offered([gguf('Qwen3.8-27B-UD-Q4_K_M.gguf'), gguf('Qwen3.8-27B-mmproj-F16.gguf')]).includes('qwen27-q4_k_m'));
  assert(offered([gguf('Qwen3.8-27B-UD-Q4_K_M.gguf'), gguf('Qwen3.8-27B-mmproj-F16.gguf', '/other')]).includes('qwen27-q4_k_m'));
  assert(offered([gguf('Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf')]).includes('qwen36-bf16'));
  assert(!offered([gguf('Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf'), gguf('Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf')]).includes('qwen36-bf16'));
  assert(!offered([folder('Qwen3.8-27B-4bit')]).includes('qwen27-mlx-4bit'));
  assert(offered([gguf('Qwen3.6-35B-A3B-UD-Q4_K_M.gguf')]).includes('qwen36-mlx-4bit'), 'another engine is another download');
  // The projector a 27B variant needs never makes another 27B quantization installed.
  assert.equal(offered([gguf('Qwen3.8-27B-mmproj-F16.gguf')]).filter(id => id.startsWith('qwen27-') && !id.includes('mlx')).length, 25);
});
check('installed pinned variants are selectable models with their quantization', () => {
  const c = load('MacIntel');
  const listing = [gguf('Qwen3.6-35B-A3B-MXFP4_MOE.gguf'), gguf('Qwen3.6-35B-A3B-UD-IQ4_XS.gguf'), folder('Qwen3.6-35B-A3B-nvfp4'),
    folder('Qwen3.8-27B-4bit'), gguf('Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf')];
  const usable = listing.filter(g => c.ggufIsUsableModel(g, listing));
  assert.deepEqual(usable.map(g => g.file), ['Qwen3.6-35B-A3B-MXFP4_MOE.gguf', 'Qwen3.6-35B-A3B-UD-IQ4_XS.gguf',
    'Qwen3.6-35B-A3B-nvfp4', 'Qwen3.8-27B-4bit']);
  assert.deepEqual(usable.map(g => c.parseGgufName(g.file).quant), ['MXFP4_MOE', 'IQ4_XS', 'NVFP4', '4-bit']);
  assert.deepEqual(usable.map(g => c.parseGgufName(g.file).kind), ['text', 'text', 'text · MLX', 'text · MLX']);
  assert.equal(c.modelIdForEngineStatus({modelFile: 'mlx/Qwen3.8-27B-4bit'}), 'qwen3.8-27b');
  assert.equal(c.modelIdForEngineStatus({modelFile: 'gguf/Qwen3.6-35B-A3B-MXFP4_MOE.gguf'}), 'qwen3.6-35b-a3b');
});
check('a download in progress or paused finds its catalog entry', () => {
  const c = load('MacIntel');
  assert.equal(c.modelDownloadChoice('qwen27-mlx-nvfp4')?.body.target, 'qwen27-mlx-nvfp4');
  assert.equal(c.modelDownloadChoice('qwen36-q6')?.qwen.engine, 'llama');
  assert.equal(c.modelDownloadChoice('ds41f-q4')?.body.target, 'ds41f-q4');
  assert.equal(c.modelDownloadChoice('qwen36-q2_k'), null);
  assert.match(c.modelDownloadOptionLabel(c.modelDownloadChoice('qwen36-mxfp4_moe')), /^Not installed · Qwen3\.6-35B-A3B · MXFP4_MOE/);
});
check('without a catalog no Qwen download is offered and the host listing stays the authority', () => {
  const c = load('MacIntel', null);
  assert.equal(qwenOffers(c).length, 0);
  const first = gguf('Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf'), second = gguf('Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf');
  assert.equal(c.ggufIsUsableModel(first, [first]), false, 'split parts are still required by name');
  assert.equal(c.ggufIsUsableModel(first, [first, second]), true);
  assert.equal(c.ggufIsEngineComponent(second), true);
  assert.equal(c.applyQwenCatalog({schema: 'other', version: 1, variants: []}), false);
  assert.equal(c.applyQwenCatalog({...served, version: 2}), false);
  assert.equal(qwenOffers(c).length, 0, 'a rejected document leaves no catalog');
});
console.log(`Evidence: ${run}`);
