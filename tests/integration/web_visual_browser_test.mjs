// Real compiled DStudio browser code + isolated headless Chrome. No model and
// no simulated screenshot responses. Fixtures are public, generated artifacts
// and original failure receipts stay in a fresh ignored directory on every run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const root = process.cwd();
const patcher = path.resolve(process.argv[2] || 'tests/.build/web_visual_patch_unit');
fs.mkdirSync('tests/.artifacts', { recursive: true });
const work = fs.mkdtempSync(path.join(root, 'tests/.artifacts/web-visual-'));
const receipt = { kind: 'real-browser-no-model', status: 'running', branches: [], checks: [] };
// CDP lists browser UI/background workers too. Those can start/stop while a
// request runs and are not owned page tabs. Two retained failed receipts exposed
// this grader error; require the exact original page set, not a total-target count.
const pageIds = targets => targets.filter(target => target.type === 'page').map(target => target.id).sort();
assert.deepEqual(pageIds([{ id: 'keep', type: 'page' }, { id: 'new-worker', type: 'service_worker' }]), ['keep']);
assert.notDeepEqual(pageIds([{ id: 'keep', type: 'page' }, { id: 'leaked', type: 'page' }]), ['keep']);
const run = (file, args, options = {}) => {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${file}: ${result.error || ''}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
const runAsync = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 60000);
  child.stdout.on('data', chunk => { out += chunk; if (out.length > 2 * 1024 * 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { err = (err + chunk).slice(-4000); });
  child.once('error', reject);
  child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve(out) : reject(new Error(`helper exit ${code}: ${err}`)); });
});
const freePort = async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
};
const fixture = fs.readFileSync('tests/fixtures/web_visual_page.html');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(req.url === '/plain' ? '<!doctype html><title>Plain text</title><p>Orchid retry interval is 47 seconds.</p>'
    : req.url === '/below' ? fixture.toString().replace('<svg ', '<div style="height:1600px"></div><svg ') : fixture);
});
let chrome;
let chromeLog;
try {
  const binaries = [];
  for (const engine of ['ds4', 'ds4-laguna-s21', 'ds4-qwen38', 'ds4-qwen35']) {
    const sourcePath = path.join(root, engine, 'ds4_web.c');
    const original = fs.readFileSync(sourcePath);
    const directory = path.join(work, engine); fs.mkdirSync(directory);
    const patched = path.join(directory, 'ds4_web_ds4ui.c');
    run(patcher, [sourcePath, patched]);
    const first = fs.readFileSync(patched);
    run(patcher, [sourcePath, patched]);
    assert.deepEqual(fs.readFileSync(patched), first, 'repeat preparation must be identical');
    assert.deepEqual(fs.readFileSync(sourcePath), original, 'upstream source must remain unchanged');
    fs.copyFileSync(path.join(engine, 'ds4_web.h'), path.join(directory, 'ds4_web.h'));
    const binary = path.join(directory, 'read-page');
    run(process.env.CC || 'cc', ['-std=c11', '-D_GNU_SOURCE', '-O1', '-Wall', '-Wextra', '-I', directory,
      'tests/fixtures/web_visual_driver.c', patched, '-o', binary]);
    binaries.push({ engine, binary });
    const frameTest = path.join(directory, 'frame-limit');
    run(process.env.CC || 'cc', ['-std=c11', '-O1', '-I', directory, 'tests/fixtures/web_ws_limit_driver.c', '-o', frameTest]);
    run(frameTest, []);
    receipt.branches.push({ engine, sourceSha256: createHash('sha256').update(original).digest('hex'), compiled: true });

    // A partial input must fail without overwriting the previous valid output.
    const partial = path.join(directory, 'partial.c');
    fs.writeFileSync(partial, first);
    assert.notEqual(spawnSync(patcher, [partial, patched]).status, 0);
    assert.deepEqual(fs.readFileSync(patched), first);
    const drift = path.join(directory, 'drift.c');
    fs.writeFileSync(drift, original.toString().replace('static char *web_run_page_js(', 'static char *changed_by_upstream('));
    assert.notEqual(spawnSync(patcher, [drift, patched]).status, 0);
    assert.deepEqual(fs.readFileSync(patched), first);
  }
  receipt.checks.push('four actual sources compile; repeated preparation, partial/drift rejection, source preservation');
  const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.ok(fs.existsSync(chromePath), 'Chrome missing; this test is not a pass without an actual browser');
  const port = await freePort();
  chromeLog = fs.openSync(path.join(work, 'chrome.log'), 'w');
  chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(work, 'chrome-profile')}`, 'about:blank'],
  { stdio: ['ignore', chromeLog, chromeLog] });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    assert.equal(chrome.exitCode, null, 'isolated Chrome exited');
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, 'isolated Chrome did not become ready');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/chart`;
  const initialTabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  receipt.initialTargets = initialTabs.map(({ id, type, url }) => ({ id, type, url }));
  for (const { engine, binary } of binaries) {
    const start = performance.now();
    const output = await runAsync(binary, [work, String(port), url, 'visual']);
    fs.writeFileSync(path.join(work, engine, 'capture.json'), output);
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.match(result.markdown, /Orchid retry interval is 47 seconds/);
    assert.match(result.markdown, /OFFSCREEN NOTE/);
    assert.equal(result.imageUrl, url, 'pixels need the same source identity');
    assert.equal(result.imageWidth, 1024); assert.equal(result.imageHeight, 768);
    assert.match(result.imageScope, /other page regions not inspected/);
    assert.ok(result.imageDataUrl.length <= 768 * 1024 + 23);
    const image = path.join(work, engine, 'capture.jpg');
    fs.writeFileSync(image, Buffer.from(result.imageDataUrl.split(',')[1], 'base64'));
    run(process.env.PYTHON || 'python3', ['-c',
      'from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGB"); assert im.size==(1024,768); a=im.getpixel((100,100)); b=im.getpixel((300,100)); assert a[0]>240 and a[1]<15 and a[2]>240,(a,b); assert b[0]<15 and b[1]>240 and b[2]<15,(a,b)', image]);
    const text = await runAsync(binary, [work, String(port), url, 'text']);
    assert.match(text, /Orchid retry interval is 47 seconds/);
    assert.ok(!text.includes('data:image/'), 'text path must not capture/return pixels');
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    receipt.lastTargets = tabs.map(({ id, type, url }) => ({ id, type, url }));
    assert.deepEqual(pageIds(tabs), pageIds(initialTabs), 'helper leaked or closed an unrelated page target');
    receipt.checks.push({ engine, actualPixels: 'magenta left / green right', textPreserved: true,
      textOnlyUnchanged: true, tabsReleased: true, elapsedMs: performance.now() - start });
  }
  const binary = binaries[0].binary;
  const plain = JSON.parse(await runAsync(binary, [work, String(port), url.replace('/chart', '/plain'), 'visual']));
  assert.match(plain.markdown, /47 seconds/);
  assert.equal(plain.imageStatus, 'not_needed');
  assert.equal(plain.imageDataUrl, undefined, 'text-only pages must not pay an image inference cost');
  const below = JSON.parse(await runAsync(binary, [work, String(port), url.replace('/chart', '/below'), 'visual']));
  assert.ok(below.imageOffsetY >= 1500, 'must scroll to the substantive graphic, not capture an empty page header');
  const belowImage = path.join(work, 'below.jpg');
  fs.writeFileSync(belowImage, Buffer.from(below.imageDataUrl.split(',')[1], 'base64'));
  run(process.env.PYTHON || 'python3', ['-c',
    'from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGB"); a=im.getpixel((100,100)); b=im.getpixel((300,100)); assert a[0]>240 and a[1]<15 and a[2]>240,(a,b); assert b[0]<15 and b[1]>240 and b[2]<15,(a,b)', belowImage]);
  const finalTabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert.deepEqual(pageIds(finalTabs), pageIds(initialTabs));
  receipt.checks.push('no image for plain text; actual pixels of a below-the-fold graphic; final tab cleanup');
  receipt.status = 'pass';
  console.log(`web_visual_browser: four compiled engine sources, real JPEG colors, text, bounds and tab cleanup passed. Receipts: ${path.relative(root, work)}`);
} catch (error) {
  receipt.status = 'fail'; receipt.error = error.stack; throw error;
} finally {
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(receipt, null, 2));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    const timeout = setTimeout(() => chrome.kill('SIGKILL'), 5000);
    await once(chrome, 'close'); clearTimeout(timeout);
  }
  if (chromeLog !== undefined) fs.closeSync(chromeLog);
}
