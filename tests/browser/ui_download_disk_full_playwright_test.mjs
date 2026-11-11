// A model download runs out of disk space: it must stop with a message that
// names the cause, keep a resumable partial, and continue from that partial
// once space is freed.
//
// Real: the production page (Settings -> Models), the host binary over HTTP
// and its download child, the production scripts/download-qwen-variant.py with
// real curl, and a real "No space left on device" on a small task-owned HFS+
// volume (hdiutil) holding the model store. SIMULATED: the Hugging Face server
// is a loopback fixture serving deterministic bytes (the downloader accepts a
// loopback --base-url only for tests; a two-line wrapper in the fixture support
// tree passes it), and the llama.cpp installer is a stub that builds nothing.
// No network, no weights, no model is loaded.
//   node tests/browser/ui_download_disk_full_playwright_test.mjs tests/.build/dstudio-server-test
//   DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_download_disk_full_playwright_test.mjs ...
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {artifactRunDir, freePort, sleep, csrfHeaders} from '../support/real_harness.mjs';
import {scratchVolume} from '../support/scratch_volume.mjs';

if (process.platform !== 'darwin') {
  console.log('ui_download_disk_full_playwright_test: NOT RUN (needs macOS hdiutil)');
  process.exit(2);
}
const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const playwright = await import('playwright');
const repo = path.resolve(import.meta.dirname, '../..');
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const run = artifactRunDir('download-disk-full');
const receipt = {started: new Date().toISOString(), browser: browserName, passed: false, cases: [], requests: [],
  scope: 'Production page, real host, production Qwen downloader and curl, real ENOSPC on a task-owned HFS+ volume; SIMULATED loopback Hugging Face server and llama.cpp installer stub; no network or model',
  hostSHA256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex')};
const MiB = 1 << 20;
const pin = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/qwen-variants.json'), 'utf8')).variants.find(v => v.id === 'qwen36-q6');
const target = pin.files[0];
// Deterministic payload: byte i of the file is pattern[i % pattern.length].
const pattern = Buffer.from(Array.from({length: 65521}, (_, i) => (i * 131 + 17) & 0xff));
const expectedBytes = (from, length) => {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = pattern[(from + i) % pattern.length];
  return out;
};
let volume, host, exit, browser, page, hub;
// Phase 'fill': stream until the client stops reading. Phase 'resume': send
// `cap` bytes, then hold the connection open until the download is stopped.
const hubState = {cap: Infinity, held: []};
const file = (name, data, mode) => {fs.mkdirSync(path.dirname(name), {recursive: true}); fs.writeFileSync(name, data); if (mode) fs.chmodSync(name, mode);};
async function check(name, fn) {
  const row = {name}; receipt.cases.push(row);
  try {await fn(row); row.status = 'PASS'; console.log(`PASS ${name}`);}
  catch (error) {row.status = 'FAIL'; row.error = error.stack; console.log(`FAIL ${name}\n  ${error.message}`); throw error;}
  finally {fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));}
}
try {
  hub = http.createServer((req, res) => {
    const wanted = `/${pin.repository}/resolve/${pin.revision}/${target.remote}`;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const from = range ? Number(range[1]) : 0;
    const row = {path: req.url, range: req.headers.range || null, served: 0};
    receipt.requests.push(row);
    if (req.url !== wanted || from >= target.bytes) {res.writeHead(404); res.end(); return;}
    res.writeHead(range ? 206 : 200, {'Content-Length': String(target.bytes - from), 'Accept-Ranges': 'bytes',
      ...(range ? {'Content-Range': `bytes ${from}-${target.bytes - 1}/${target.bytes}`} : {})});
    const cap = hubState.cap;
    let offset = from, closed = false;
    res.on('close', () => {closed = true;});
    const pump = () => {
      while (!closed && row.served < cap) {
        const n = Math.min(256 * 1024, cap - row.served);
        const chunk = expectedBytes(offset, n);
        offset += n; row.served += n;
        if (!res.write(chunk)) {res.once('drain', pump); return;}
      }
      if (!closed) hubState.held.push(res);
    };
    pump();
  });
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  const hubUrl = `http://127.0.0.1:${hub.address().port}`;

  volume = scratchVolume(run, 40, 'DStudioDiskFull');
  const installRoot = path.join(volume.mount, 'install'), engine = path.join(installRoot, 'ds4');
  const assets = path.join(run, 'support');
  file(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
  fs.mkdirSync(path.join(engine, 'gguf'), {recursive: true});
  file(path.join(assets, 'src/harness/design/build-design.sh'), '#!/bin/sh\nexit 0\n', 0o755);
  file(path.join(assets, 'scripts/apply-ds4-visible-downloads.sh'), '#!/bin/sh\nexit 0\n', 0o755);
  fs.copyFileSync(path.join(repo, 'scripts/qwen-variants.json'), path.join(assets, 'scripts/qwen-variants.json'));
  file(path.join(assets, 'scripts/install-llama.py'), `import sys
from pathlib import Path
root = Path(sys.argv[sys.argv.index('--root') + 1])
(root / 'llama.cpp' / 'bin').mkdir(parents=True, exist_ok=True)
(root / 'llama.cpp' / 'bin' / 'llama-server').write_text('installer stub, no native build')
`);
  // The production downloader, unchanged, pointed at the loopback fixture.
  file(path.join(assets, 'scripts/download-qwen-variant.py'), `import runpy, sys
sys.argv[1:1] = ['--base-url', ${JSON.stringify(hubUrl)}]
runpy.run_path(${JSON.stringify(path.join(repo, 'scripts/download-qwen-variant.py'))}, run_name='__main__')
`);
  const filler = volume.fill(6 * MiB);
  const freeAtStart = volume.free();

  const port = await freePort(), enginePort = await freePort(), base = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(run, 'host.log'), 'wx');
  host = spawn(binary, [String(port), engine], {detached: true, stdio: ['ignore', log, log],
    env: {...process.env, DS4UI_DATA_DIR: path.join(run, 'profile'), DS4UI_NO_WINDOW: '1', DS4UI_TEST_MODE: '1',
      DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1', DS4UI_ENGINE_PORT: String(enginePort)}});
  fs.closeSync(log);
  exit = new Promise(resolve => {host.once('exit', resolve); host.once('error', resolve);});
  const request = async (route, body) => {
    const response = await fetch(base + route, {method: body === undefined ? 'GET' : 'POST', headers: csrfHeaders,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000)});
    return {status: response.status, body: await response.json()};
  };
  const state = async () => (await request('/api/status')).body;
  const until = async (fn, message, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {const value = await fn(); if (value) return value; await sleep(25);}
    throw new Error(message);
  };
  await until(async () => {try {return (await request('/api/status')).status === 200;} catch {return false;}}, 'host not ready');
  assert.equal((await request('/api/webdir', {path: assets})).status, 200);
  const original = await state();
  const part = path.join(engine, 'gguf/.dstudio-qwen-downloads', target.file, 'data.part');

  browser = await playwright[browserName].launch();
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}});
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error.stack || error)));
  // The System check that the page raises when no chat model runs (this
  // profile has none) is closed as a user would, whenever it covers a step.
  receipt.systemChecksClosed = 0;
  await page.addLocatorHandler(page.locator('#doctor-dialog[open]'), async () => {
    await page.locator('#doctor-close').click(); receipt.systemChecksClosed++;
  });
  await page.goto(base);
  await page.getByRole('button', {name: 'Settings', exact: true}).first().click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await settings.getByRole('button', {name: 'Models', exact: true}).click();

  await check('the download stops on the full disk with a message naming the cause', async row => {
    const downloads = settings.getByRole('combobox', {name: 'Model / quantization to download'});
    await downloads.waitFor({state: 'visible', timeout: 10000});
    await downloads.selectOption(pin.id);
    await downloads.locator('..').getByRole('button', {name: 'Download', exact: true}).click();
    const confirm = page.locator('#confirm-dialog');
    await confirm.waitFor({state: 'visible'});
    await confirm.getByRole('button', {name: 'Download', exact: true}).click();
    const toast = page.getByText(/Download or verification failed: .*No space left on device.*Partial files are kept for Resume\./);
    await toast.waitFor({timeout: 30000});
    row.toast = await toast.innerText();
    row.status = await state();
    assert.equal(row.status.downloadPhase, 'failed');
    assert.match(row.status.downloadError, /No space left on device/);
    assert.equal(row.status.modelFile, original.modelFile, 'a failed download never changes the selected model');
    assert.equal(fs.existsSync(path.join(engine, 'gguf', target.file)), false, 'nothing was published');
    await page.screenshot({path: path.join(run, `${browserName}-disk-full.png`), fullPage: true});
  });

  let kept = 0;
  await check('the bytes already written are kept as a resumable partial, shown as Paused with Resume', async row => {
    kept = fs.statSync(part).size;
    row.partBytes = kept; row.freeAtStart = freeAtStart; row.freeNow = volume.free();
    assert.ok(kept > 2 * MiB && kept <= freeAtStart, `partial of ${kept} bytes`);
    // The downloader writes 1 MiB at a time: the next write did not fit.
    assert.ok(row.freeNow < MiB, `the volume is full (${row.freeNow} bytes free)`);
    assert.ok(expectedBytes(0, kept).equals(fs.readFileSync(part)), 'every kept byte is the served byte at its offset');
    const s = await state();
    assert.deepEqual([s.pausedDownload, s.pausedDownloadVariant, s.pausedDownloadBytes], [true, pin.id, kept]);
    await settings.getByText(new RegExp(`Paused: ${pin.id}`)).waitFor({timeout: 8000});
    row.shown = await settings.getByText(new RegExp(`Paused: ${pin.id}`)).innerText();
    assert.ok(await settings.getByRole('button', {name: 'Resume', exact: true}).isEnabled());
  });

  await check('after space is freed, Resume continues from the partial (HTTP range) instead of starting over', async row => {
    fs.rmSync(filler);
    // A little more than 4 MiB: curl's own output buffer may hold the tail
    // of a stalled stream, and the downloader writes whole 1 MiB reads.
    hubState.cap = 4 * MiB + 256 * 1024;
    const before = receipt.requests.length;
    await settings.getByRole('button', {name: 'Resume', exact: true}).click();
    const resumed = await until(() => receipt.requests.slice(before).find(r => r.served >= hubState.cap), 'the resumed transfer did not run');
    row.request = resumed;
    assert.equal(resumed.range, `bytes=${kept}-`, 'the downloader asked only for the missing bytes');
    await until(() => fs.statSync(part).size >= kept + 4 * MiB, 'the partial did not grow by the resumed bytes');
    await settings.getByRole('button', {name: 'Stop', exact: true}).click();
    await settings.getByText(new RegExp(`Paused: ${pin.id}`)).waitFor({timeout: 10000});
    const size = fs.statSync(part).size;
    row.partBytes = size;
    assert.ok(size >= kept + 4 * MiB && size <= kept + hubState.cap);
    assert.ok(expectedBytes(0, size).equals(fs.readFileSync(part)), 'the resumed bytes continue the partial at the right offset');
    const s = await state();
    row.paused = {phase: s.downloadPhase, bytes: s.pausedDownloadBytes, error: s.downloadError};
    assert.equal(s.downloadPhase, 'stopped');
    assert.equal(s.downloadError, '', 'a stopped download reports no failure');
    assert.equal(s.pausedDownloadBytes, size);
  });
  assert.deepEqual(errors, []);
  receipt.passed = true;
} catch (error) {
  receipt.error = error.stack; process.exitCode = 1;
  if (page) await page.screenshot({path: path.join(run, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (host && host.exitCode === null && host.signalCode === null) {
    await fetch(`http://127.0.0.1:${host.spawnargs[1]}/api/model/download/stop`, {method: 'POST', headers: csrfHeaders}).catch(() => {});
    try {process.kill(-host.pid, 'SIGTERM');} catch {}
    await Promise.race([exit, sleep(4000)]);
    if (host.exitCode === null && host.signalCode === null) {try {process.kill(-host.pid, 'SIGKILL');} catch {} await exit;}
  }
  for (const res of hubState.held) res.destroy();
  if (hub) {hub.closeAllConnections(); hub.close();}
  await sleep(300);
  if (volume) volume.detach();
  receipt.finished = new Date().toISOString();
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`ui_download_disk_full_playwright_test (${browserName}): ${receipt.cases.filter(c => c.status === 'PASS').length}/3 passed; receipts: ${run}`);
  if (receipt.error) console.error(receipt.error);
}
