// Design mode: brief → Agent-style conversation → Open IDE with a code |
// design split, in a real browser against the REAL host file and
// /api/design/preview handlers (tests/support/agent_workspace_host.c in
// "design" mode) on a task-owned project folder. The Design runtime stream is
// SIMULATED with the events ds4-design now emits (tool_call_begin /
// tool_call_param / tool_body_delta, then tool_call / tool_result; see
// tests/integration/design_tool_stream_test.mjs for the runtime itself), and the
// test performs the write's file effect. No model or inference runs. The
// page is the one the native host serves, with its actual security headers,
// so the preview frames run under the production policy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { uiMockServer, jsonReply, requestBody, seedUi } from '../support/ui_mock_server.mjs';
import { NATIVE_TITLEBAR_PX, simulateNativeTitlebar, windowStripReport } from '../support/native_titlebar.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const hostBinary = path.resolve(process.argv[2] || 'tests/.build/agent_workspace_host');
fs.mkdirSync('tests/.artifacts/ui-design-ide', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/ui-design-ide/${browserName}-`);
const project = path.resolve(dir, 'project');
fs.mkdirSync(project, { recursive: true });
// Design may start in a folder that already holds the user's files.
fs.writeFileSync(path.join(project, 'brief.md'), '# bigorec live\n');
const receipt = { scope: 'Real browser, real host file + preview handlers; Design stream and file effects simulated; no inference',
  browserName, cases: [] };

const host = spawn(hostBinary, [project, 'design'], { stdio: ['pipe', 'pipe', 'pipe'] });
let hostOut = '', hostLog = '';
const hostLines = [];
host.stdout.on('data', (d) => {
  hostOut += d;
  const lines = hostOut.split('\n'); hostOut = lines.pop();
  for (const l of lines) { hostLines.push(l); hostLog += l + '\n'; }
});
host.stderr.on('data', (d) => { hostLog += d; });
const waitLine = async (pred, what) => {
  const deadline = Date.now() + 10000;
  for (;;) {
    const i = hostLines.findIndex(pred);
    if (i >= 0) return hostLines.splice(i, 1)[0];
    if (Date.now() > deadline || host.exitCode != null) throw Error(`host did not report ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const hostPort = Number((await waitLine((l) => l.startsWith('PORT '), 'its port')).slice(5));
async function hostWorking(on) {
  host.stdin.write(`working ${on ? 1 : 0}\n`);
  await waitLine((l) => l === 'ok', 'the working acknowledgement');
}

// The bundled page and its policy, exactly as the native host serves them.
const served = await fetch(`http://127.0.0.1:${hostPort}/`);
assert.ok(served.ok, 'the native host serves the page');
const servedPage = { body: await served.text(), headers: Object.fromEntries(
  ['content-type', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'cache-control']
    .map((name) => [name, served.headers.get(name)]).filter(([, value]) => value !== null)) };
assert.ok(servedPage.headers['content-security-policy'], 'the served page carries a policy');

const ev = (o) => '\x1e' + JSON.stringify(o) + '\n';
let raw = '', working = false, mode = 'server';
const requests = [];
const server = await uiMockServer(async (req, res, url) => {
  // Real host handlers: workspace files and the project preview route.
  if (url.pathname.startsWith('/api/agent/fs/') || (req.method === 'GET' &&
      (url.pathname.startsWith('/api/design/preview/') || url.pathname === '/api/design/live-frame'))) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
    if (req.headers['x-requested-with']) headers['X-Requested-With'] = req.headers['x-requested-with'];
    const r = await fetch(`http://127.0.0.1:${hostPort}${url.pathname}${url.search}`, {
      method: req.method, headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) });
    const body = Buffer.from(await r.arrayBuffer());
    requests.push({ path: url.pathname, status: r.status });
    // Keep the host's own policy headers: the frames must run under them.
    res.writeHead(r.status, Object.fromEntries(['content-type', 'content-security-policy', 'x-content-type-options', 'cache-control']
      .map((name) => [name, r.headers.get(name)]).filter(([, value]) => value !== null)));
    res.end(body);
    return true;
  }
  if (url.pathname === '/api/status') {
    jsonReply(res, { mode, running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)',
      agentWorking: working, agentSessionWorking: false, nativeVisionActive: true, workdir: project,
      ds4dirOk: true, webdirOk: true, lan: false, modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf',
      config: { ctx: 65536, power: 100 }, variant: 'flash', variants: { flash: true } });
    return true;
  }
  if (url.pathname === '/api/start') { const b = await requestBody(req); mode = b.mode || 'server'; jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/fs/list') { const b = await requestBody(req); jsonReply(res, { ok: true, path: b.path || project, entries: fs.readdirSync(project).length, dirs: [] }); return true; }
  if (url.pathname === '/api/user-skills') { jsonReply(res, { ok: true, skills: [] }); return true; }
  if (url.pathname === '/api/design-systems') { jsonReply(res, { ok: true, designSystems: [], catalogIds: [] }); return true; }
  if (url.pathname === '/api/design/state') { jsonReply(res, { ok: true, state: { seq: 1, phase: 'idle' } }); return true; }
  if (url.pathname === '/api/design/events') { jsonReply(res, { ok: true, events: [] }); return true; }
  if (url.pathname === '/api/design/artifacts') { jsonReply(res, { ok: true, artifacts: [] }); return true; }
  if (url.pathname === '/api/design/session') { await requestBody(req); jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/design/files') {
    const files = fs.readdirSync(project).filter((n) => /\.html$/.test(n))
      .map((name) => ({ name, size: fs.statSync(path.join(project, name)).size, mtime: Math.floor(fs.statSync(path.join(project, name)).mtimeMs / 1000) }));
    jsonReply(res, { ok: true, workdir: project, running: true, files });
    return true;
  }
  if (url.pathname === '/api/updates/check') { jsonReply(res, { ok: true, sections: [] }); return true; }
  if (url.pathname === '/api/agent/poll') {
    const bytes = Buffer.from(raw), since = Number(url.searchParams.get('since')) || 0;
    jsonReply(res, { base: 0, len: bytes.length, text: bytes.subarray(since).toString('utf8'), working,
      sessionWorking: false, ready: true, loadPct: 100 });
    return true;
  }
  if (url.pathname === '/api/agent/interrupt') { working = false; jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/agent/send') {
    const b = await requestBody(req);
    raw += `\x01USER\x02${b.displayPrompt}\x01ENDUSER\x02\n`;
    working = true;
    jsonReply(res, { ok: true, from: 0, at: Buffer.byteLength(raw) });
    return true;
  }
  return false;
}, { document: servedPage });

const now = Date.now();
const seed = { theme: 'dark', settings: { workdirs: { design: project } },
  chats: [{ id: 'design-ide', mode: 'design', title: 'New design', createdAt: now, updatedAt: now, messages: [], transcript: '', workdir: project }] };
const browser = await ({ chromium, webkit })[browserName].launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
page.setDefaultTimeout(8000);
// As in DStudio.app: a 28px native title-bar strip holds the window controls.
await simulateNativeTitlebar(page);
const evidence = await seedUi(page, server.origin, seed);
let shot = 0;
const capture = (name) => page.screenshot({ path: path.join(dir, `${String(shot++).padStart(2, '0')}-${name}.png`) });
const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 });
async function step(name, fn) {
  const row = { name };
  try { await fn(row); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = error.stack; process.exitCode = 1; await capture(`fail-${name.replace(/\W+/g, '-')}`).catch(() => {}); }
  receipt.cases.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
  if (row.status === 'FAIL') throw Error(`stopped after: ${name}`);
}

const HEAD = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>bigorec live</title>\n<style>\n'
  + 'body { margin: 0; background: #0e0f13; color: #f2f2f5; font-family: system-ui, sans-serif; }\n'
  + '.rec { width: 96px; height: 96px; border-radius: 50%; background: #ff3b47; }\n';
const BODY = '</style>\n<link rel="stylesheet" href="extra.css">\n</head>\n<body>\n<h1 id="title">bigorec live</h1>\n'
  + '<script>document.body.dataset.scripted = "yes";</script>\n<button class="rec" aria-label="Stop recording"></button>\n'
  + '<img src="missing.png" alt="" onerror="document.body.dataset.handler = \'ran\'">\n';
const TAIL = '<p id="tail">REC</p>\n</body>\n</html>\n';
// Tall enough to scroll in every layout; MORE arrives while the reader scrolls.
const TALL = '<section id="s1" style="height:1400px;background:#1b1d24">one</section>\n'
  + '<section id="s2" style="height:1400px;background:#23262f">two</section>\n';
const MORE = [1, 2, 3, 4, 5].map((i) => `<p id="more-${i}">more ${i}</p>\n`);

const liveFrame = () => {
  const frame = page.frames().find((f) => new URL(f.url(), 'http://x').pathname === '/api/design/live-frame');
  assert.ok(frame, 'the live design frame is loaded');
  return frame;
};
async function wheelPreview(dy) {
  const box = await page.locator('#ide-pv-frame').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, dy);
}
// New bytes keep arriving (each one a separate update of the frame); the
// reader's position and the document itself must survive every update.
async function keepsScroll(live, ids) {
  await page.waitForTimeout(250); // let the wheel scroll settle
  const before = await live.evaluate(() => scrollY);
  for (const i of ids) {
    raw += ev({ type: 'tool_body_delta', text: MORE[i - 1] });
    await page.frameLocator('#ide-pv-frame').locator(`#more-${i}`).waitFor();
  }
  const after = await live.evaluate(() => ({ y: scrollY, same: window.sameDocument }));
  assert.equal(after.same, 'yes', 'the frame was patched in place, not reloaded');
  assert.ok(Math.abs(after.y - before) < 2, `the scroll position survived ${ids.length} updates: ${before} -> ${after.y}`);
}

try {
  await page.goto(server.origin);

  await step('the brief has no IDE; sending turns Design into the Agent-style conversation', async () => {
    await page.locator('#tab-design').click();
    const dialog = page.locator('#workdir-dialog'); await dialog.waitFor();
    assert.equal(await page.locator('#workdir-go').isEnabled(), true, 'a non-empty project folder can start Design');
    assert.equal(await page.locator('#wd-warn').isVisible(), false);
    await dialog.getByRole('button', { name: /^(Start|Launch)/ }).click();
    await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: /What should we design\?/ }).waitFor();
    assert.equal(await page.locator('#btn-agent-ide').isVisible(), false, 'the brief does not offer the IDE');
    assert.equal(await page.locator('#pipe-head-mode').isVisible(), false, 'Design shows its folder, not a mode pill');
    assert.equal((await page.locator('#pipe-head-path .pipe-head-folder').textContent()), 'project');
    await page.locator('#composer-input').fill('Create a recorder called bigorec live');
    await page.locator('#btn-send').click();
    await hostWorking(true);
    await page.locator('#agent-view .agent-response-name', { hasText: /^Design$/ }).first().waitFor();
    await page.locator('#btn-agent-ide').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#agent-view .gen, #agent-view .design-brief').count(), 0);
  });

  await step('"Open in IDE to see it live" opens the code | design split and an empty artboard', async () => {
    const shortcut = page.locator('#agent-view .agent-working__ide');
    await shortcut.waitFor({ state: 'visible' });
    assert.equal((await shortcut.textContent()).trim(), 'Open in IDE to see it live');
    await capture('open-in-ide-shortcut');
    await shortcut.click();
    await page.locator('#agent-ide').waitFor({ state: 'visible' });
    // The panes are laid out on the IDE's next animation frame.
    await page.locator('#ide-pv').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#btn-agent-ide').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#ide-layout [data-ide-layout="split"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#ide-code').isVisible(), true);
    assert.equal(await page.locator('#ide-canvas').isVisible(), true);
    assert.equal(await page.locator('#ide-task-graph').isVisible(), false);
    await page.locator('#ide-board').waitFor({ state: 'visible' });
    await until(() => /has not started an HTML file yet/.test(document.querySelector('#ide-board-line').textContent));
    raw += ev({ type: 'reasoning_start' }) + 'Serve un header, un timer e il pulsante REC. ';
    await until(() => /still working out the layout/.test(document.querySelector('#ide-board-line').textContent));
    assert.equal(await page.locator('#ide-thought').isVisible(), true, 'the thought bubble works in Design too');
    raw += ev({ type: 'reasoning_end' });
  });

  await step('declared styles fill the artboard before any <body>', async () => {
    // An earlier round already saved the page's stylesheet.
    fs.writeFileSync(path.join(project, 'extra.css'), '#title { letter-spacing: 3px; }\n');
    raw += ev({ type: 'tool_call_begin', name: 'write' })
      + ev({ type: 'tool_call_param', param: 'path', path: '' })
      + ev({ type: 'tool_call_param', param: 'content', path: 'index.html' })
      + ev({ type: 'tool_body_delta', text: HEAD });
    await until(() => [...document.querySelectorAll('#ide-board-kit .ide-board-sw')].map((n) => n.textContent).join(',') === '#0e0f13,#f2f2f5,#ff3b47');
    assert.deepEqual(await page.locator('#ide-board-kit .ide-board-classes span').allTextContents(), ['.rec']);
    assert.match(await page.locator('#ide-board-line').textContent(), /Declaring styles: 3 colors, 1 class so far\./);
    assert.equal(await page.locator('#ide-board-wrap').evaluate((n) => n.classList.contains('sel')), true, 'the artboard is selected while DeepSeek writes');
    assert.equal(await page.locator('#ide-board-who').textContent(), 'DeepSeek');
    await capture('artboard-styles');
  });

  await step('the design builds live from the streamed body, with scripts off', async () => {
    raw += ev({ type: 'tool_body_delta', text: BODY });
    await page.locator('#ide-board').waitFor({ state: 'hidden' });
    const frame = page.frameLocator('#ide-pv-frame');
    await frame.locator('#title').waitFor();
    assert.equal(await frame.locator('#title').textContent(), 'bigorec live');
    const el = page.locator('#ide-pv-frame');
    assert.equal(new URL(await el.getAttribute('src'), server.origin).pathname, '/api/design/live-frame');
    assert.equal(await el.getAttribute('sandbox'), 'allow-scripts', 'opaque origin: no allow-same-origin');
    assert.equal(await frame.locator('body').getAttribute('data-scripted'), null, 'the page\'s own <script> stays off');
    assert.equal(await frame.locator('body').getAttribute('data-handler'), null, 'inline handlers stay off');
    assert.match(await page.locator('#ide-pv-st').textContent(), /building live · scripts off/);
    // Relative assets resolve against the project preview route, under the
    // production policy.
    await liveFrame().waitForFunction(() => getComputedStyle(document.querySelector('#title')).letterSpacing === '3px');
    await capture('live-body');
  });

  await step('the reader scrolls the design while it is still being written (split)', async () => {
    raw += ev({ type: 'tool_body_delta', text: TALL });
    await page.frameLocator('#ide-pv-frame').locator('#s2').waitFor();
    const live = liveFrame();
    await live.evaluate(() => { window.sameDocument = 'yes'; });
    await wheelPreview(700);
    await live.waitForFunction(() => scrollY > 300);
    await keepsScroll(live, [1, 2, 3]);
    await capture('scrolled-split');
  });

  await step('the reader scrolls the design while it is still being written (Design layout)', async () => {
    await page.locator('[data-ide-layout="design"]').click();
    await until(() => document.querySelector('#ide-code').hidden && !document.querySelector('#ide-pv').hidden);
    const live = liveFrame();
    const from = await live.evaluate(() => scrollY);
    await wheelPreview(500);
    await live.waitForFunction((y) => scrollY > y + 200, from);
    await keepsScroll(live, [4, 5]);
    await capture('scrolled-design');
    await page.locator('[data-ide-layout="split"]').click();
    await until(() => !document.querySelector('#ide-code').hidden);
  });

  await step('after tool_result the saved bytes stay in the same frame until the turn ends', async () => {
    const live = liveFrame();
    const before = await live.evaluate(() => scrollY);
    const full = HEAD + BODY + TALL + MORE.join('') + TAIL;
    raw += ev({ type: 'tool_body_delta', text: TAIL })
      + ev({ type: 'tool_call', name: 'write', input: { path: 'index.html', content: full.slice(0, 300) } });
    fs.writeFileSync(path.join(project, 'index.html'), full);
    raw += ev({ type: 'tool_result', name: 'write', output: 'Wrote index.html' });
    await until(() => /✓ saved · scripts run when DeepSeek finishes/.test(document.querySelector('#ide-pv-st').textContent));
    await page.frameLocator('#ide-pv-frame').locator('#tail').waitFor();
    const after = await live.evaluate(() => ({ y: scrollY, same: window.sameDocument,
      scripted: document.body.dataset.scripted || null }));
    assert.deepEqual(after, { y: before, same: 'yes', scripted: null });
    // Differential check: after every partial version was patched in, the
    // document equals a fresh parse of the same bytes (the injected <base>
    // aside).
    const parity = await live.evaluate((src) => {
      const strip = (root) => { root.querySelectorAll('base').forEach((b) => b.remove()); return root.outerHTML; };
      const want = strip(new DOMParser().parseFromString(src, 'text/html').documentElement);
      const got = strip(document.documentElement.cloneNode(true));
      return { equal: got === want, got: got.length, want: want.length };
    }, full);
    assert.deepEqual(parity, { equal: true, got: parity.want, want: parity.want });
  });

  await step('layouts and the divider persist', async () => {
    await page.locator('[data-ide-layout="design"]').click();
    await until(() => document.querySelector('#ide-code').hidden && !document.querySelector('#ide-pv').hidden);
    await until(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).ideLayout === 'design');
    await page.locator('[data-ide-layout="code"]').click();
    await until(() => !document.querySelector('#ide-code').hidden && document.querySelector('#ide-pv').hidden);
    await page.locator('[data-ide-layout="split"]').click();
    await until(() => !document.querySelector('#ide-code').hidden && !document.querySelector('#ide-pv').hidden);
    await page.locator('#ide-divider').focus();
    await page.keyboard.press('ArrowLeft');
    await until(() => JSON.parse(localStorage.getItem('ds4web.settings.v2')).ideSplit === 45);
    const widths = await page.evaluate(() => ({ code: document.querySelector('#ide-code').getBoundingClientRect().width,
      split: document.querySelector('#ide-split').getBoundingClientRect().width }));
    assert.ok(Math.abs(widths.code / widths.split - 0.45) < 0.02, `code pane takes 45%: ${JSON.stringify(widths)}`);
  });

  await step('the canvas with every screen stays one click away', async () => {
    await page.locator('#ide-canvas').click();
    await page.locator('#ws-canvas').waitFor({ state: 'visible' });
    await page.locator('.cv-board[data-name="index.html"]').waitFor();
    await page.locator('#cv-back').click();
    await page.locator('#ws-canvas').waitFor({ state: 'hidden' });
  });

  await step('the canvas and the fullscreen artboard keep the window controls on a top bar', async () => {
    await page.locator('#ide-canvas').click();
    await page.locator('#ws-canvas').waitFor({ state: 'visible' });
    const strip = { inset: NATIVE_TITLEBAR_PX, controlsInStrip: [], barTop: 0, barCoversStrip: true };
    assert.deepEqual(await windowStripReport(page, '#ws-canvas', '#ws-canvas .cv-top'), strip);
    await capture('canvas-titlebar');
    // The board's actions appear once it is selected.
    await page.locator('.cv-board[data-name="index.html"] .cv-label, .cv-board[data-name="index.html"]').first().click({ position: { x: 20, y: 8 } });
    await page.locator('.cv-board[data-name="index.html"] .ft-btn', { hasText: 'Fullscreen' }).click();
    await page.locator('#ws-fs').waitFor({ state: 'visible' });
    await page.locator('#ws-fs [data-fs="close"]').waitFor();
    assert.deepEqual(await windowStripReport(page, '#ws-fs', '#ws-fs .fs-bar'), strip);
    await capture('fullscreen-titlebar');
    await page.locator('#ws-fs [data-fs="close"]').click();
    await page.locator('#ws-fs').waitFor({ state: 'hidden' });
    await page.locator('#cv-back').click();
    await page.locator('#ws-canvas').waitFor({ state: 'hidden' });
  });

  await step('when the turn ends the saved file is previewed from the host, scripts on', async () => {
    raw += 'Fatto.\n';
    working = false;
    await hostWorking(false);
    await until(() => /^\/api\/design\/preview\/index\.html\?t=/.test(new URL(document.querySelector('#ide-pv-frame').src || 'about:blank', location.href).pathname + new URL(document.querySelector('#ide-pv-frame').src || 'about:blank', location.href).search));
    assert.equal(await page.locator('#ide-pv-frame').getAttribute('sandbox'), 'allow-scripts');
    assert.match(await page.locator('#ide-pv-st').textContent(), /saved file/);
    const frame = page.frameLocator('#ide-pv-frame');
    await frame.locator('#tail').waitFor();
    await until(() => true);
    assert.equal(await frame.locator('body').getAttribute('data-scripted'), 'yes', 'the saved page runs like the canvas preview');
    assert.ok(requests.some((r) => r.path === '/api/design/preview/index.html' && r.status === 200));
  });

  await step('after the turn the user edits with a live preview and saves exact bytes', async () => {
    await until(() => document.querySelector('#ide-chip').textContent === 'Editable' && !document.querySelector('#ide-input').readOnly);
    await page.locator('#ide-tabs [data-ide-tab="index.html"]').click();
    await page.locator('#ide-input').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await page.keyboard.type('<!-- edited -->\n<p id="mine">Caffè 🧪</p>\n');
    await until(() => /your unsaved edit/.test(document.querySelector('#ide-pv-st').textContent));
    await page.frameLocator('#ide-pv-frame').locator('#mine').waitFor();
    assert.equal(new URL(await page.locator('#ide-pv-frame').getAttribute('src'), server.origin).pathname, '/api/design/live-frame');
    assert.equal(await page.frameLocator('#ide-pv-frame').locator('body').getAttribute('data-scripted'), null);
    const typed = await page.locator('#ide-input').inputValue();
    await page.locator('#ide-save').click();
    await until(() => document.querySelector('#ide-save').hidden);
    assert.equal(fs.readFileSync(path.join(project, 'index.html'), 'utf8'), typed);
    await until(() => /saved file/.test(document.querySelector('#ide-pv-st').textContent));
    await capture('saved-edit');
  });

  assert.deepEqual(evidence.errors, [], 'no page errors');
  assert.deepEqual(evidence.external, [], 'no external requests');
} finally {
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ ...receipt, requests: requests.slice(-60), hostLog: hostLog.slice(-4000) }, null, 2));
  await browser.close();
  server.close();
  host.stdin.end();
}
const passed = receipt.cases.filter((c) => c.status === 'PASS').length;
console.log(`ui_design_ide (${browserName}, simulated Design stream): ${passed}/${receipt.cases.length}; receipts: ${dir}`);
