// Real host HTTP, background children and files for non-default Qwen variants
// on llama.cpp and MLX. The engine installers and the generic downloader are
// bounded fixtures (tiny files, no network, no model); the real downloader's
// transfers are covered by tests/integration/qwen_variant_download_test.py.
// The catalog the host serves, and its fallback, are consumed by the
// production UI functions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {artifactRunDir, freePort, sleep, csrfHeaders, extractFunction} from '../support/real_harness.mjs';

const run = artifactRunDir('qwen-variant-download-host');
const binary = path.resolve(process.argv[2]);
const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
const root = path.join(run, 'install with spaces'), engine = path.join(root, 'ds4');
const assets = path.join(run, 'assets'), bare = path.join(run, 'assets without catalog');
const shipped = fs.readFileSync('scripts/qwen-variants.json');
const catalog = JSON.parse(shipped);
const variant = id => catalog.variants.find(v => v.id === id);
const receipt = {started: new Date().toISOString(), passed: false, plannedChecks: 6,
  scope: 'Real host HTTP/processes/files; simulated installers and tiny files, not downloads or inference',
  appleSilicon, hostSHA256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), cases: []};
function file(name, data) {fs.mkdirSync(path.dirname(name), {recursive: true}); fs.writeFileSync(name, data);}
file(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
fs.mkdirSync(path.join(engine, 'gguf'), {recursive: true});
for (const dir of [assets, bare]) {
  file(path.join(dir, 'src/harness/design/build-design.sh'), '#!/bin/sh\nexit 0\n');
  file(path.join(dir, 'src/engines/mlx/manifest.json'), '{"fixture": true}\n');
}
file(path.join(assets, 'scripts/qwen-variants.json'), shipped);
const opener = path.join(run, 'bin/open');
file(opener, '#!/bin/sh\nprintf "%s" "$1" > "$DSTUDIO_FIXTURE_OPENED"\n'); fs.chmodSync(opener, 0o755);
fs.copyFileSync(opener, path.join(run, 'bin/xdg-open')); fs.chmodSync(path.join(run, 'bin/xdg-open'), 0o755);
for (const [script, made] of [['install-llama.py', "(root / 'llama.cpp' / 'bin').mkdir(parents=True, exist_ok=True)\n(root / 'llama.cpp' / 'bin' / 'llama-server').write_text('fixture')"],
  ['install-mlx.py', "(root / 'mlx' / 'venv' / 'bin').mkdir(parents=True, exist_ok=True)\n(root / 'mlx' / 'venv' / 'bin' / 'python3').write_text('fixture')"]])
  file(path.join(assets, 'scripts', script), `import sys, json, time
from pathlib import Path
root = Path(sys.argv[sys.argv.index('--root') + 1])
(root / 'install-entered').write_text(json.dumps(['${script}'] + sys.argv[1:]))
while not (root / 'install-release').exists(): time.sleep(.02)
${made}
`);
// Records its argv, stages one partial, reports D then V, publishes on release.
file(path.join(assets, 'scripts/download-qwen-variant.py'), `import sys, os, json, time
from pathlib import Path
args = sys.argv[1:]
directory = Path(args[args.index('--directory') + 1]).resolve()
control = Path(${JSON.stringify(root)})
(control / 'download-entered').write_text(json.dumps(args))
progress = int(args[args.index('--progress-fd') + 1])
publish = json.loads((control / 'publish.json').read_text())
stage = directory / '.dstudio-qwen-downloads' / publish[0]
stage.mkdir(parents=True, exist_ok=True)
(stage / 'data.part').write_bytes(b'x' * 4096)
os.write(progress, b'D')
while not (control / 'download-release').exists(): time.sleep(.02)
os.write(progress, b'V')
while not (control / 'verify-release').exists(): time.sleep(.02)
if (control / 'verify-fail').exists(): sys.exit(7)
for name in publish: (directory / name).write_bytes(b'verified fixture')
(stage / 'data.part').unlink()
`);
const port = await freePort(), enginePort = await freePort(), base = `http://127.0.0.1:${port}`;
const log = fs.openSync(path.join(run, 'host.log'), 'wx');
const host = spawn(binary, [String(port), engine], {detached: true, stdio: ['ignore', log, log],
  env: {...process.env, DS4UI_DATA_DIR: path.join(run, 'profile'), DS4UI_NO_WINDOW: '1',
    DS4UI_TEST_MODE: '1', DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1', DS4UI_ENGINE_PORT: String(enginePort),
    PATH: path.dirname(opener) + path.delimiter + process.env.PATH, DSTUDIO_FIXTURE_OPENED: path.join(run, 'opened-folder')}});
fs.closeSync(log);
const exit = new Promise(resolve => {host.once('exit', resolve); host.once('error', resolve);});
async function request(route, body, raw = false) {
  const response = await fetch(base + route, {method: body === undefined ? 'GET' : 'POST',
    headers: csrfHeaders, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000)});
  return {status: response.status, body: raw ? Buffer.from(await response.arrayBuffer()) : await response.json()};
}
const state = async () => (await request('/api/status')).body;
async function until(fn, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {const value = await fn(); if (value) return value; await sleep(25);}
  throw Error(message);
}
const phase = expected => until(async () => {const s = await state(); return s.downloadPhase === expected ? s : false;}, `missing phase ${expected}`);
const release = name => file(path.join(root, name + '-release'), 'release');
function reset(publish) {
  for (const name of ['install', 'download', 'verify']) for (const suffix of ['release', 'entered', 'fail']) {
    const target = path.join(root, `${name}-${suffix}`); if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  file(path.join(root, 'publish.json'), JSON.stringify(publish));
}
const args = () => JSON.parse(fs.readFileSync(path.join(root, 'download-entered')));
const arg = (list, name) => list[list.indexOf(name) + 1];
async function check(name, fn) {
  const row = {name}; receipt.cases.push(row);
  try {await fn(row); row.passed = true;}
  catch (error) {row.passed = false; row.error = error.stack; throw error;}
  finally {fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));}
}
// The production UI catalog functions, run on what the host actually served.
function ui(platform) {
  const source = fs.readFileSync('web/index.html', 'utf8');
  const helpers = source.slice(source.indexOf('    const isGlm53Gguf ='), source.indexOf('    function relativeTime('));
  const downloads = source.slice(source.indexOf('    const DEFAULT_FLASH_GGUF ='), source.indexOf('    function availableModelDownloads('));
  const functions = ['ggufIsDsparkSupport', 'ggufIsGlmVisionEncoder', 'ggufIsDeepseekVisionEncoder', 'ggufIsEngineComponent',
    'ggufIsModifiedWeights', 'ggufIsUsableModel', 'availableModelDownloads'].map(name => extractFunction(source, name)).join('\n');
  const context = vm.createContext({console, Store: {getSettings: () => ({})}, navigator: {platform}});
  vm.runInContext(`${helpers}\n${downloads}\n${functions}`, context);
  return context;
}
try {
  await until(async () => {try {return (await request('/api/status')).status === 200;} catch {return false;}}, 'host not ready');
  await check('the support directory brings its catalog; the host serves it byte for byte', async row => {
    assert.equal((await request('/api/webdir', {path: assets})).status, 200);
    const served = await request('/api/model/qwen-variants', undefined, true);
    assert.equal(served.status, 200); assert.ok(served.body.equals(shipped));
    const c = ui('MacIntel');
    assert.equal(c.applyQwenCatalog(JSON.parse(served.body)), true);
    row.offers = JSON.parse(JSON.stringify(c.availableModelDownloads([]))).filter(d => d.qwen).length;
    assert.equal(row.offers, 63);
  });
  await check('a non-default GGUF installs llama.cpp and reaches the generic downloader with its store identity', async row => {
    reset(['Qwen3.6-35B-A3B-UD-Q4_K_M.gguf']);
    const original = await state();
    row.start = await request('/api/model/download', {target: 'qwen36-q4_k_m'});
    assert.equal(row.start.status, 200); await phase('installing');
    await until(() => fs.existsSync(path.join(root, 'install-entered')), 'installer not called');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'install-entered')))[0], 'install-llama.py');
    release('install'); row.phase = await phase('downloading');
    const argv = args();
    assert.equal(arg(argv, '--variant'), 'qwen36-q4_k_m');
    assert.equal(path.resolve(arg(argv, '--directory')), path.join(engine, 'gguf'));
    const store = fs.statSync(path.join(engine, 'gguf'), {bigint: true});
    assert.equal(arg(argv, '--directory-identity'), `${store.dev}:${store.ino}`);
    assert.equal(arg(argv, '--progress-fd'), '3');
    assert.equal(row.phase.downloadVariant, 'qwen36-q4_k_m');
    assert.equal(row.phase.downloadExpectedBytes, variant('qwen36-q4_k_m').bytes);
    assert.equal(row.phase.downloadBytes, 4096);
    assert.equal(row.phase.modelFile, original.modelFile, 'downloading never selects the model');
    assert.equal((await request('/api/model/folder/open', {engine: 'main', downloadTarget: 'qwen36-q4_k_m'})).status, 200);
    await until(() => fs.existsSync(path.join(run, 'opened-folder')), 'folder opener not called');
    assert.equal(fs.readFileSync(path.join(run, 'opened-folder'), 'utf8'), path.join(engine, 'gguf'));
    release('download'); row.verifying = await phase('verifying'); assert.ok(row.verifying.downloadPct < 100);
    release('verify'); row.complete = await phase('complete');
    assert.equal(row.complete.downloadPct, 100);
    assert.equal(fs.readFileSync(path.join(engine, 'gguf/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf'), 'utf8'), 'verified fixture');
  });
  await check('27B on MLX installs the MLX runtime and fills its own folder; a failure stays resumable', async row => {
    reset(['model-00001-of-00003.safetensors', 'config.json']);
    fs.rmSync(path.join(run, 'opened-folder'), {force: true});
    row.start = await request('/api/model/download', {target: 'qwen27-mlx-4bit'});
    if (!appleSilicon) {
      assert.equal(row.start.status, 400); assert.match(row.start.body.error, /Apple Silicon/);
      assert.ok(!fs.existsSync(path.join(root, 'install-entered'))); return;
    }
    assert.equal(row.start.status, 200); await phase('installing');
    await until(() => fs.existsSync(path.join(root, 'install-entered')), 'installer not called');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'install-entered')))[0], 'install-mlx.py');
    release('install'); row.phase = await phase('downloading');
    const folder = path.join(engine, 'mlx/Qwen3.8-27B-4bit');
    assert.equal(path.resolve(arg(args(), '--directory')), folder);
    assert.equal(arg(args(), '--variant'), 'qwen27-mlx-4bit');
    const store = fs.statSync(folder, {bigint: true});
    assert.equal(arg(args(), '--directory-identity'), `${store.dev}:${store.ino}`);
    assert.equal(row.phase.downloadExpectedBytes, variant('qwen27-mlx-4bit').bytes);
    assert.equal(row.phase.downloadBytes, 4096);
    assert.equal((await request('/api/model/folder/open', {engine: 'main', downloadTarget: 'qwen27-mlx-4bit'})).status, 200);
    await until(() => fs.existsSync(path.join(run, 'opened-folder')), 'folder opener not called');
    assert.equal(fs.readFileSync(path.join(run, 'opened-folder'), 'utf8'), folder);
    file(path.join(root, 'verify-fail'), 'fail'); release('download'); release('verify');
    row.failed = await phase('failed');
    assert.notEqual(row.failed.downloadPct, 100);
    assert.equal(row.failed.pausedDownloadVariant, 'qwen27-mlx-4bit');
    assert.equal(row.failed.pausedDownloadBytes, 4096);
    assert.equal((await request('/api/model/partials/delete', {target: 'qwen27-mlx-4bit', confirm: true})).status, 409);
    assert.equal(fs.statSync(path.join(folder, '.dstudio-qwen-downloads/model-00001-of-00003.safetensors/data.part')).size, 4096);
  });
  await check('an unpinned target is refused before any child starts', async row => {
    reset([]);
    row.response = await request('/api/model/download', {target: 'qwen36-q2_k'});
    assert.equal(row.response.status, 400);
    assert.ok(!fs.existsSync(path.join(root, 'install-entered')));
  });
  await check('without a catalog the host serves the original pins, which the UI offers', async row => {
    assert.equal((await request('/api/webdir', {path: bare})).status, 200);
    const served = await request('/api/model/qwen-variants');
    assert.equal(served.status, 200); assert.equal(served.body.fallback, true);
    assert.deepEqual(served.body.variants.map(v => v.id), ['qwen36-q6', 'qwen27-q6', 'qwen36-mlx']);
    assert.equal((await request('/api/model/download', {target: 'qwen36-q4_k_m'})).status, 400);
    for (const [platform, expected] of [['MacIntel', ['qwen36-q6', 'qwen27-q6', 'qwen36-mlx']], ['Linux x86_64', ['qwen36-q6', 'qwen27-q6']]]) {
      const c = ui(platform);
      assert.equal(c.applyQwenCatalog(served.body), true);
      const offers = JSON.parse(JSON.stringify(c.availableModelDownloads([]))).filter(d => d.qwen);
      assert.deepEqual(offers.map(d => d.id), expected);
      assert.match(offers.find(d => d.id === 'qwen27-q6').label, /26\.2 GB.*F16 projector|F16 projector.*26\.2 GB/);
    }
    row.error = served.body.error;
  });
  await check('restoring the support directory restores every pinned variant', async () => {
    assert.equal((await request('/api/webdir', {path: assets})).status, 200);
    assert.ok((await request('/api/model/qwen-variants', undefined, true)).body.equals(shipped));
  });
  receipt.passed = true;
} catch (error) {receipt.error = error.stack; process.exitCode = 1;}
finally {
  await request('/api/model/download/stop', {}).catch(() => {});
  for (const name of ['install', 'download', 'verify']) file(path.join(root, name + '-release'), 'release');
  await until(async () => {const s = await state(); return s.downloadPhase !== 'downloading' && s.downloadPhase !== 'installing' &&
    s.downloadPhase !== 'verifying';}, 'download cleanup', 6000).catch(() => {});
  host.kill('SIGTERM'); await Promise.race([exit, sleep(2000)]);
  if (host.exitCode === null && host.signalCode === null) {process.kill(-host.pid, 'SIGKILL'); await exit;}
  receipt.finished = new Date().toISOString(); receipt.hostExit = {code: host.exitCode, signal: host.signalCode};
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`${receipt.passed ? 'PASS' : 'FAIL'} ${receipt.cases.filter(c => c.passed).length}/${receipt.plannedChecks} ${run}`);
  if (receipt.error) console.error(receipt.error);
}
