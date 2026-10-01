// Real startup page and browser clocks; simulated launcher, no model inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'webkit';
assert.ok(['webkit', 'chromium'].includes(browserName));
const browser = await (await import('playwright'))[browserName].launch();
const html = fs.readFileSync('web/loading.html');
const root = 'tests/.artifacts/loading-startup';
fs.mkdirSync(root, { recursive: true });
const run = fs.mkdtempSync(`${root}/${browserName}-`);
const report = { scope: `Production loading page in ${browserName}; simulated HTTP launcher, no inference`, cases: [] };
let state, startBody, startResponse, entered, resolveEntered, statusReads, interrupted;
function json(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
function reset(overrides = {}) {
  state = { running: false, ready: false, ds4dirOk: true, ds4dir: '/fixture/engine',
    modelFile: 'gguf/DeepSeek-V4-Flash-fixture.gguf', models: { standard: true },
    stage: '', loadPct: null, launchTaskId: 0, ...overrides };
  startBody = startResponse = null;
  statusReads = 0;
  interrupted = false;
  entered = new Promise(resolve => { resolveEntered = resolve; });
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/loading.html') {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return;
  }
  if (req.url === '/api/status') {
    if (startBody) statusReads++;
    json(res, 200, state); return;
  }
  if (req.url === '/api/start') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(startBody, null, 'one start request per attempt');
    startBody = JSON.parse(Buffer.concat(chunks));
    startResponse = res;
    res.on('close', () => { if (!res.writableEnded) interrupted = true; });
    state = { ...state, launchTaskId: 23, launchPhase: 'preparing',
      launchRequestId: startBody.launchRequestId };
    resolveEntered(); return;
  }
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>DStudio workspace</title>'); return;
  }
  res.writeHead(204); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function check(name, fn) {
  const page = await browser.newPage({ viewport: { width: 1020, height: 684 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(origin => {
    if (window !== window.top || location.origin !== origin) return;
    localStorage.setItem('ds4web.settings.v2',
      JSON.stringify({ onboarded: true, ctxSize: 131072, ssdStreaming: 'on' }));
  }, origin);
  const row = { name };
  try { await fn(page); assert.deepEqual(errors, []); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = error.stack; }
  finally {
    await page.screenshot({ path: `${run}/${name}.png`, fullPage: true }).catch(() => {});
    if (startResponse && !startResponse.writableEnded) json(startResponse, 409, { error: 'Fixture cleanup' });
    await page.close(); report.cases.push(row);
    console.log(`${name}: ${row.status}${row.error ? ': ' + row.error : ''}`);
  }
}
try {
  await check('activity-without-invented-progress', async page => {
    reset({ running: true, ready: false, stage: 'Loading the model', loadPct: 41 });
    await page.goto(`${origin}/loading.html`);
    await page.waitForFunction(() => document.querySelector('#loading-pct').textContent === '41%');
    const before = await page.locator('#loading-progress').boundingBox();
    const colors = await page.locator('.aperture-track.active').evaluate(el => {
      const animation = el.getAnimations().find(a => a.playState === 'running');
      if (!animation) return [];
      animation.pause();
      const duration = animation.effect.getTiming().duration;
      animation.currentTime = 0;
      const first = getComputedStyle(el).stroke;
      animation.currentTime = Number(duration) / 2;
      const second = getComputedStyle(el).stroke;
      animation.play();
      return [first, second];
    });
    assert.equal(colors.length, 2, 'busy indicator must have a running animation');
    assert.notEqual(colors[0], colors[1], 'activity must visibly change the active arc');
    assert.deepEqual(await page.locator('#loading-progress').boundingBox(), before,
      'activity must not move or resize the progress indicator');
    assert.equal(await page.locator('#loading-pct').textContent(), '41%');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.aperture-track.active').evaluate(el =>
      el.getAnimations().some(a => a.playState === 'running')), false);
    assert.equal(await page.locator('#loading-pct').textContent(), '41%');
  });
  await check('slow-preparation-remains-observable', async page => {
    // Old engine readiness/error must not be presented as this new attempt's outcome.
    reset({ engineError: 'Previous attempt failed' });
    await page.clock.install();
    await page.goto(`${origin}/loading.html`);
    await entered;
    state = { ...state, running: true, ready: true, loadPct: 100,
      stage: 'Old engine ready', engineLine: 'ds4: memory: = 42 GiB planned' };
    await page.clock.fastForward('01:00:00');
    await page.clock.runFor(100);
    assert.equal(interrupted, false, 'valid preparation must not lose its start request after elapsed time');
    assert.ok(statusReads > 0, 'the launcher must be polled while the start response is pending');
    await page.waitForFunction(() => document.querySelector('.boot-step.active .boot-step__detail').textContent === 'preparing');
    assert.ok(page.url().endsWith('/loading.html'), 'old readiness cannot finish a pending launch');
    assert.equal(await page.locator('#loading-progress').getAttribute('aria-valuenow'), null,
      'preparation cannot inherit the previous engine percentage');
    assert.equal(await page.locator('#boot-memory').textContent(), '—', 'old engine metrics cannot describe a pending attempt');
    assert.equal(startBody.force, false);
    assert.equal(startBody.ctx, 131072);
    assert.equal(startBody.ssdStreaming, 'on');
    state = { ...state, launchTaskId: 0, launchPhase: '', ready: true, stage: 'Ready', engineError: '' };
    json(startResponse, 200, { ok: true, taskId: 23 });
    await page.clock.runFor(1200);
    await page.waitForURL(`${origin}/`);
  });
  await check('start-error-remains-readable', async page => {
    reset();
    await page.clock.install();
    await page.goto(`${origin}/loading.html`);
    await entered;
    const error = 'Runtime preparation failed: fixture compiler error. See launcher task #23 for the complete build log.';
    json(startResponse, 409, { ok: false, code: 'launch_prepare_failed', taskId: 23, error });
    await page.waitForFunction(text => document.querySelector('#loading-detail')?.textContent === text, error);
    await page.clock.fastForward('00:30');
    await page.clock.runFor(1000);
    assert.ok(page.url().endsWith('/loading.html'), 'a startup failure must stay visible until the user chooses recovery');
    assert.equal(await page.locator('#loading-detail').textContent(), error);
    assert.equal(await page.locator('.aperture-track.active').evaluate(el =>
      el.getAnimations().some(a => a.playState === 'running')), false, 'a terminal error must stop activity');
    await page.getByRole('button', { name: 'Open DStudio', exact: true }).click();
    await page.waitForURL(`${origin}/`);
  });
} finally {
  fs.writeFileSync(`${run}/receipt.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(`Receipt: ${run}/receipt.json`);
  await browser.close(); server.close();
}
assert.ok(report.cases.every(row => row.status === 'PASS'), 'startup behavior regressions failed');
