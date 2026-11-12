// Deleting the partial files of a stopped model download, from Settings ->
// Models, to free disk space. The production page and the real host binary
// over HTTP; the model store lives on a small task-owned HFS+ volume (hdiutil)
// so the freed bytes are measured on the file system itself.
// SIMULATED: the ds4 download_model.sh in the fixture checkout writes a partial
// and waits (no network, no weights); the Laguna Hugging Face cache partials
// are fixture files. No model is loaded and nothing is inferred.
//   node tests/browser/ui_partial_download_delete_playwright_test.mjs tests/.build/dstudio-server-test
//   DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_partial_download_delete_playwright_test.mjs ...
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {artifactRunDir, freePort, sleep, csrfHeaders} from '../support/real_harness.mjs';
import {scratchVolume} from '../support/scratch_volume.mjs';

if (process.platform !== 'darwin') {
  console.log('ui_partial_download_delete_playwright_test: NOT RUN (needs macOS hdiutil)');
  process.exit(2);
}
const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const playwright = await import('playwright');
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const run = artifactRunDir('partial-download-delete');
const receipt = {started: new Date().toISOString(), browser: browserName, passed: false, cases: [],
  scope: 'Production page and real host HTTP on a task-owned HFS+ volume; SIMULATED download_model.sh and Laguna cache partials, no network, no model',
  hostSHA256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex')};
const MiB = 1 << 20;
const GLM_PART = 'gguf/GLM-5.3-Flash-Q2.gguf.part';
const LAGUNA = 'ds4-laguna-s21/gguf';
let volume, host, exit, browser, page;
const file = (name, data, mode) => {fs.mkdirSync(path.dirname(name), {recursive: true}); fs.writeFileSync(name, data); if (mode) fs.chmodSync(name, mode);};
async function check(name, fn) {
  const row = {name}; receipt.cases.push(row);
  try {await fn(row); row.status = 'PASS'; console.log(`PASS ${name}`);}
  catch (error) {row.status = 'FAIL'; row.error = error.stack; console.log(`FAIL ${name}\n  ${error.message}`); throw error;}
  finally {fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));}
}
try {
  volume = scratchVolume(run, 48, 'DStudioPartials');
  const assets = path.join(volume.mount, 'support'), engine = path.join(volume.mount, 'install', 'ds4');
  file(path.join(assets, 'src/harness/design/build-design.sh'), '#!/bin/sh\nexit 0\n', 0o755);
  file(path.join(assets, 'scripts/apply-ds4-visible-downloads.sh'), '#!/bin/sh\nexit 0\n', 0o755);
  file(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
  // A completed model the cleanup must never touch.
  file(path.join(engine, 'gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf'), Buffer.alloc(MiB, 0x31));
  // SIMULATED transfer: a resumable .part beside the final file, then wait for Stop.
  file(path.join(engine, 'download_model.sh'), `#!/bin/sh
[ "$1" = glm53-q2 ] || exit 64
head -c ${8 * MiB} /dev/zero > "${GLM_PART}" || exit 23
echo "$$" > download-entered
trap 'exit 143' TERM
while :; do sleep 0.05; done
`);
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
  const until = async (fn, message, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {const value = await fn(); if (value) return value; await sleep(25);}
    throw new Error(message);
  };
  await until(async () => {try {return (await request('/api/status')).status === 200;} catch {return false;}}, 'host not ready');
  assert.equal((await request('/api/webdir', {path: assets})).status, 200);
  const glmPart = path.join(engine, GLM_PART);

  await check('a running download keeps its partial: deletion is refused until it is stopped', async row => {
    row.start = await request('/api/model/download', {target: 'glm53-q2'});
    assert.equal(row.start.status, 200, JSON.stringify(row.start.body));
    await until(() => fs.existsSync(path.join(engine, 'download-entered')) && fs.statSync(glmPart).size === 8 * MiB, 'the simulated transfer did not start');
    row.refused = await request('/api/model/partials/delete', {target: 'glm53-q2', confirm: true});
    assert.equal(row.refused.status, 409);
    assert.match(row.refused.body.error, /stop the active model download/);
    assert.equal(fs.statSync(glmPart).size, 8 * MiB);
    assert.equal((await request('/api/model/download/stop', {})).status, 200);
    row.paused = await until(async () => {const s = await state(); return s.downloadPhase === 'stopped' && s.pausedDownload ? s : false;}, 'Stop did not pause the download');
    assert.deepEqual([row.paused.pausedDownloadVariant, row.paused.pausedDownloadBytes], ['glm53-q2', 8 * MiB]);
    assert.equal((await request('/api/model/partials/delete', {target: 'glm53-q2'})).status, 400, 'an unconfirmed deletion is refused');
    assert.equal(fs.statSync(glmPart).size, 8 * MiB);
  });

  // Laguna's older Hugging Face cache layout: an .incomplete temporary and its lock.
  const cache = path.join(assets, LAGUNA, '.cache/huggingface/download');
  file(path.join(cache, 'abc123.0123456789abcdef.incomplete'), Buffer.alloc(6 * MiB, 0x4c));
  file(path.join(cache, 'abc123.0123456789abcdef.lock'), '');
  file(path.join(cache, 'laguna-s-2.1-Q4_K_M.gguf.metadata'), 'kept: not a partial\n');
  const completed = path.join(engine, 'gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf');
  const completedHash = crypto.createHash('sha256').update(fs.readFileSync(completed)).digest('hex');

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

  async function deleteFromSettings(row, label, toast) {
    await settings.getByText(new RegExp(`Paused: ${label}`)).waitFor({timeout: 10000});
    row.shown = await settings.getByText(new RegExp(`Paused: ${label}`)).innerText();
    const before = volume.free();
    await settings.getByRole('button', {name: 'Delete partial', exact: true}).click();
    const confirm = page.locator('#confirm-dialog');
    await confirm.waitFor({state: 'visible'});
    row.confirm = await confirm.innerText();
    assert.match(row.confirm, /Delete the partial download\?/);
    assert.match(row.confirm, /The completed model, if present, is never touched/);
    await confirm.getByRole('button', {name: 'Delete partial', exact: true}).click();
    // The toast names the bytes the host reports as removed.
    await page.getByText(toast).waitFor({timeout: 8000});
    row.toast = await page.getByText(toast).innerText();
    row.freedBytes = volume.free() - before;
    return row;
  }

  await check('Delete partial in Settings removes the stopped download\'s bytes from the disk', async row => {
    const sizeBefore = fs.statSync(glmPart).size;
    await deleteFromSettings(row, 'glm53-q2', '8 MB of partial data deleted');
    assert.equal(fs.existsSync(glmPart), false, 'the .part file is gone');
    assert.ok(row.freedBytes >= sizeBefore, `the volume regained ${row.freedBytes} of ${sizeBefore} bytes`);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(completed)).digest('hex'), completedHash, 'the completed model is untouched');
    const s = await state();
    assert.notEqual(s.pausedDownloadVariant, 'glm53-q2', 'the deleted download is no longer offered for Resume');
  });

  await check('the next stopped download (Laguna\'s cache partials) is shown and deleted the same way', async row => {
    await deleteFromSettings(row, 'laguna-q4', '6 MB of partial data deleted');
    assert.deepEqual(fs.readdirSync(cache).sort(), ['laguna-s-2.1-Q4_K_M.gguf.metadata'], 'the .incomplete and .lock files are gone, the rest is kept');
    assert.ok(row.freedBytes >= 6 * MiB, `the volume regained ${row.freedBytes} bytes`);
    const s = await state();
    assert.equal(s.pausedDownload, false, 'nothing is left to resume');
    await settings.getByRole('combobox', {name: 'Model / quantization to download'}).waitFor({timeout: 8000});
    assert.equal(await settings.getByRole('button', {name: 'Delete partial', exact: true}).count(), 0);
    await page.screenshot({path: path.join(run, `${browserName}-after.png`), fullPage: true});
  });
  assert.deepEqual(errors, []);
  receipt.passed = true;
} catch (error) {
  receipt.error = error.stack; process.exitCode = 1;
  if (page) await page.screenshot({path: path.join(run, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (host && host.exitCode === null && host.signalCode === null) {
    try {process.kill(-host.pid, 'SIGTERM');} catch {}
    await Promise.race([exit, sleep(4000)]);
    if (host.exitCode === null && host.signalCode === null) {try {process.kill(-host.pid, 'SIGKILL');} catch {} await exit;}
  }
  if (volume) volume.detach();
  receipt.finished = new Date().toISOString();
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(receipt, null, 2));
  console.log(`ui_partial_download_delete_playwright_test (${browserName}): ${receipt.cases.filter(c => c.status === 'PASS').length}/3 passed; receipts: ${run}`);
  if (receipt.error) console.error(receipt.error);
}
