// Real host HTTP, process groups and files: a vision-capable model download is
// followed by its own native vision encoder. The download scripts are bounded
// fixtures that write tiny files; no network, weights or inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {artifactRunDir, freePort, sleep, csrfHeaders} from '../support/real_harness.mjs';

const run = artifactRunDir('model-vision-companion-host');
const binary = path.resolve(process.argv[2]);
const root = path.join(run, 'install with spaces'), engine = path.join(root, 'ds4');
const assets = path.join(run, 'assets'), control = path.join(run, 'control');
const receipt = {started: new Date().toISOString(), passed: false,
  scope: 'Real host HTTP/processes/files; fixture download scripts and tiny files, not weights or inference',
  hostSHA256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), cases: []};
const files = {
  'ds41f-q2': 'DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf',
  'ds41f-1017-vision': 'DeepSeek-V4.1-Flash-1017-Vision.gguf',
  'ds41f-q4': 'DeepSeek-V4.1-Flash-Q4.gguf',
  'ds41f-vision': 'DeepSeek-V4.1-Flash-Vision.gguf',
  'glm53-q2': 'GLM-5.3-Flash-Q2.gguf',
  'glm53-vision': 'GLM-5.3-Flash-Vision-Encoder.gguf',
  'ds4f-vision-q2': 'DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf',
  'ds4f-vision-encoder': 'DeepSeek-V4-Flash-Vision-Encoder.gguf',
  'ds4f-vision-dspark': 'DeepSeek-V4-Flash-Vision-Exp-DSpark-support.gguf',
  'ds4f-q2': 'DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf',
};
function file(name, data, mode) {
  fs.mkdirSync(path.dirname(name), {recursive: true}); fs.writeFileSync(name, data);
  if (mode) fs.chmodSync(name, mode);
}
// One fixture serves both the vendored download_model.sh and DStudio's pinned
// V4.1 downloader: it records each target, waits for its release, then either
// fails or publishes the target's final file in the store.
const fixture = `#!/bin/sh
target=$1
printf '%s\\n' "$target" >> "$DSTUDIO_FIXTURE_CONTROL/calls.log"
case "$target" in
${Object.entries(files).map(([t, f]) => `  ${t}) file='${f}' ;;`).join('\n')}
  *) echo "unexpected target $target" >&2; exit 9 ;;
esac
while [ ! -e "$DSTUDIO_FIXTURE_CONTROL/$target-release" ]; do sleep 0.02; done
[ -e "$DSTUDIO_FIXTURE_CONTROL/$target-fail" ] && exit 3
printf 'fixture %s\\n' "$target" > "gguf/$file"
`;
file(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
file(path.join(engine, 'download_model.sh'), fixture, 0o755);
fs.mkdirSync(path.join(engine, 'gguf'), {recursive: true});
fs.mkdirSync(control, {recursive: true});
file(path.join(assets, 'src/harness/design/build-design.sh'), '#!/bin/sh\nexit 0\n', 0o755);
file(path.join(assets, 'scripts/apply-ds4-visible-downloads.sh'), '#!/bin/sh\nexit 0\n', 0o755);
file(path.join(assets, 'scripts/download-ds41-1017.sh'), fixture, 0o755);

const port = await freePort(), enginePort = await freePort(), base = `http://127.0.0.1:${port}`;
const log = fs.openSync(path.join(run, 'host.log'), 'wx');
const host = spawn(binary, [String(port), engine], {detached: true, stdio: ['ignore', log, log],
  env: {...process.env, DS4UI_DATA_DIR: path.join(run, 'profile'), DS4UI_NO_WINDOW: '1',
    DS4UI_TEST_MODE: '1', DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1',
    DS4UI_ENGINE_PORT: String(enginePort), DSTUDIO_FIXTURE_CONTROL: control}});
fs.closeSync(log);
const exited = new Promise(resolve => {host.once('exit', resolve); host.once('error', resolve);});
async function request(route, body) {
  const response = await fetch(base + route, {method: body === undefined ? 'GET' : 'POST',
    headers: csrfHeaders, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2000)});
  return {status: response.status, body: await response.json()};
}
const state = async () => (await request('/api/status')).body;
async function until(fn, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {const value = await fn(); if (value) return value; await sleep(25);}
  throw Error(message);
}
const calls = () => fs.existsSync(path.join(control, 'calls.log'))
  ? fs.readFileSync(path.join(control, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
const present = target => fs.existsSync(path.join(engine, 'gguf', files[target]));
const release = target => file(path.join(control, `${target}-release`), 'release');
const failNext = target => file(path.join(control, `${target}-fail`), 'fail');
function reset(...remove) {
  for (const name of fs.readdirSync(control)) fs.unlinkSync(path.join(control, name));
  for (const target of remove) fs.rmSync(path.join(engine, 'gguf', files[target]), {force: true});
}
async function phase(expected, variant) {
  return until(async () => {const s = await state();
    return s.downloadPhase === expected && (!variant || s.downloadVariant === variant) ? s : false;},
    `missing phase ${expected}${variant ? ' for ' + variant : ''}`);
}
async function start(target) {
  const reply = await request('/api/model/download', {target});
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  await until(() => calls().at(-1) === target, `${target} downloader not called`);
  return reply.body;
}
// After an exit, give the control loop several reap cycles to (wrongly) chain.
async function settled(expectedCalls, expectedPhase) {
  const s = await phase(expectedPhase);
  await sleep(400);
  assert.deepEqual(calls(), expectedCalls);
  return s;
}
async function check(name, fn) {
  const row = {name}; receipt.cases.push(row);
  try {await fn(row); row.passed = true; console.log('PASS: ' + name);}
  catch (error) {row.passed = false; row.error = error.stack; throw error;}
  finally {fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));}
}
try {
  await until(async () => {try {return (await request('/api/status')).status === 200;} catch {return false;}}, 'host not ready');
  assert.equal((await request('/api/webdir', {path: assets})).status, 200);

  await check('a GLM model download continues with its own vision encoder', async row => {
    reset();
    row.model = await start('glm53-q2');
    assert.equal((await state()).downloadCompanionOf ?? '', '', 'a user-started model is not a companion');
    release('glm53-q2');
    row.encoder = await until(async () => {const s = await state();
      return s.download && s.downloadVariant === 'glm53-vision' ? s : false;}, 'encoder not chained');
    assert.equal(row.encoder.downloadCompanionOf, 'glm53-q2');
    assert.ok(row.encoder.downloadPct >= 0 && row.encoder.downloadPct < 100);
    assert.ok(present('glm53-q2'));
    // One download at a time: the user cannot start another while the encoder runs.
    assert.equal((await request('/api/model/download', {target: 'ds4f-q2'})).status, 409);
    release('glm53-vision');
    row.done = await phase('complete', 'glm53-vision');
    assert.equal(row.done.downloadPct, 100); assert.equal(row.done.downloadCompanionOf, 'glm53-q2');
    assert.ok(present('glm53-vision'));
    assert.deepEqual(calls(), ['glm53-q2', 'glm53-vision']);
  });

  await check('each DeepSeek V4.1 checkpoint gets only its own sidecar', async row => {
    assert.equal(process.platform, 'darwin', 'DeepSeek V4.1 is a Metal-only family; run on macOS');
    reset();
    await start('ds41f-q2'); release('ds41f-q2');
    await until(async () => (await state()).downloadVariant === 'ds41f-1017-vision', '1017 sidecar not chained');
    release('ds41f-1017-vision'); await phase('complete', 'ds41f-1017-vision');
    assert.ok(present('ds41f-q2') && present('ds41f-1017-vision'));
    // The original Q4 needs the original sidecar, even with the 1017 one present.
    await start('ds41f-q4'); release('ds41f-q4');
    row.original = await until(async () => {const s = await state();
      return s.downloadVariant === 'ds41f-vision' ? s : false;}, 'original sidecar not chained');
    assert.equal(row.original.downloadCompanionOf, 'ds41f-q4');
    release('ds41f-vision'); await phase('complete', 'ds41f-vision');
    assert.ok(present('ds41f-vision'));
    assert.deepEqual(calls(), ['ds41f-q2', 'ds41f-1017-vision', 'ds41f-q4', 'ds41f-vision']);
  });

  await check('an encoder already in the store is not downloaded again', async row => {
    reset();
    file(path.join(engine, 'gguf', files['ds4f-vision-encoder']), 'existing encoder\n');
    await start('ds4f-vision-q2'); release('ds4f-vision-q2');
    row.done = await settled(['ds4f-vision-q2'], 'complete');
    assert.equal(row.done.downloadVariant, 'ds4f-vision-q2'); assert.equal(row.done.downloadCompanionOf, '');
    assert.equal(fs.readFileSync(path.join(engine, 'gguf', files['ds4f-vision-encoder']), 'utf8'), 'existing encoder\n');
  });

  await check('text-only models and support files start no encoder', async () => {
    reset('ds4f-vision-encoder');
    await start('ds4f-q2'); release('ds4f-q2');
    await settled(['ds4f-q2'], 'complete');
    reset();
    // DSpark support shares the Vision-Exp name but is not a model.
    await start('ds4f-vision-dspark'); release('ds4f-vision-dspark');
    await settled(['ds4f-vision-dspark'], 'complete');
    assert.ok(!present('ds4f-vision-encoder'));
  });

  await check('a failed model download starts no encoder', async row => {
    reset('glm53-q2', 'glm53-vision');
    failNext('glm53-q2');
    await start('glm53-q2'); release('glm53-q2');
    row.done = await settled(['glm53-q2'], 'failed');
    assert.equal(row.done.downloadVariant, 'glm53-q2');
    assert.ok(!present('glm53-q2') && !present('glm53-vision'));
  });

  await check('Stop during the model cancels its encoder too', async () => {
    reset('glm53-q2', 'glm53-vision');
    await start('glm53-q2');
    assert.equal((await request('/api/model/download/stop', {})).body.stopped, true);
    await settled(['glm53-q2'], 'stopped');
    assert.ok(!present('glm53-vision'));
  });

  await check('Stop during the encoder keeps the verified model', async () => {
    reset('glm53-q2', 'glm53-vision');
    await start('glm53-q2'); release('glm53-q2');
    await until(async () => (await state()).downloadVariant === 'glm53-vision', 'encoder not chained');
    await until(() => calls().at(-1) === 'glm53-vision', 'encoder downloader not called');
    assert.equal((await request('/api/model/download/stop', {})).body.stopped, true);
    await settled(['glm53-q2', 'glm53-vision'], 'stopped');
    assert.ok(present('glm53-q2') && !present('glm53-vision'));
  });

  receipt.passed = true;
} catch (error) {
  receipt.error = String(error.stack || error); process.exitCode = 1; console.error(receipt.error);
} finally {
  try {process.kill(-host.pid, 'SIGTERM');} catch {}
  await Promise.race([exited, sleep(3000)]);
  try {process.kill(-host.pid, 'SIGKILL');} catch {}
  receipt.finished = new Date().toISOString();
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`Evidence: ${run}`);
}
