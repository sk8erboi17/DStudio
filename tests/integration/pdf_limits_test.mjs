// Real native host + Poppler on PDFs generated at run time: a password-protected
// PDF and a 2,500-page PDF. The browser part drives the production page served
// by that host (DSTUDIO_TEST_BROWSER=webkit|chromium); its only SIMULATED
// boundaries are the launcher status and the model replies (planner and
// answer), authored here. No model, inference or network.
//   node tests/integration/pdf_limits_test.mjs [tests/.build/dstudio-server-test]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { freePort, sleep, csrfHeaders } from '../support/real_harness.mjs';
import { pdfFixture, encryptedPdfFixture, compactPages } from '../support/pdf_read_fixture.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'webkit';
assert.ok(['webkit', 'chromium'].includes(browserName));
const browserType = (await import('playwright'))[browserName];
const tool = (name) => ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file));
assert.ok(tool('pdftotext') && tool('pdfinfo'), 'Poppler is required; a missing dependency is not a pass');
fs.mkdirSync('tests/.artifacts', { recursive: true });
const run = fs.mkdtempSync(path.resolve(`tests/.artifacts/pdf-limits-${browserName}-`));
for (const d of ['data', 'cache', 'home', 'ds4/gguf']) fs.mkdirSync(path.join(run, d), { recursive: true });
const report = { scope: 'Real PDF reader (host + Poppler) on generated encrypted and 2,500-page PDFs; SIMULATED launcher and model replies in the browser part', browserName, checks: [] };
const save = () => fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
async function check(name, fn) {
  const row = { name }; report.checks.push(row); const start = performance.now();
  try { Object.assign(row, await fn() || {}); row.status = 'pass'; }
  catch (error) { row.status = 'fail'; row.error = String(error.stack || error); process.exitCode = 1; }
  finally { row.ms = Math.round(performance.now() - start); save(); console.log(`${row.status}: ${name}${row.error ? `\n${row.error}` : ''}`); }
}

const base = `http://127.0.0.1:${await freePort()}`;
const log = fs.openSync(path.join(run, 'server.log'), 'wx');
const server = spawn(path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test'), [new URL(base).port, path.join(run, 'ds4')], {
  env: { ...process.env, HOME: path.join(run, 'home'), DS4UI_TEST_MODE: '1', DS4UI_NO_WINDOW: '1', DS4UI_DEFER_ENGINE_START: '1',
    DS4UI_DATA_DIR: path.join(run, 'data'), DSTUDIO_PDF_CACHE_DIR: path.join(run, 'cache'), DS4UI_HOST: '127.0.0.1',
    DSTUDIO_OCR_HELPER: path.join(run, 'ocr-helper-disabled') },
  stdio: ['ignore', log, log], detached: true });
fs.closeSync(log);
const uri = (bytes) => `data:application/pdf;base64,${bytes.toString('base64')}`;
async function post(endpoint, body) {
  const res = await fetch(base + endpoint, { method: 'POST', headers: csrfHeaders, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, bytes: Buffer.byteLength(text), json: (() => { try { return JSON.parse(text); } catch { return { text }; } })() };
}
const write = (name, bytes) => { const file = path.join(run, name); fs.writeFileSync(file, bytes); return { file, bytes }; };

// Password-protected: opening needs a user password. Owner-only: permissions
// are restricted but the document opens without a password.
const locked = write('locked.pdf', encryptedPdfFixture(compactPages, { userPassword: 'open-sesame' }));
const ownerOnly = write('owner-only.pdf', encryptedPdfFixture(compactPages, { userPassword: '' }));
// 2,500 physical pages, each with a unique code; more than the reader's
// 2,000-page bookkeeping ceiling.
const PAGES = 2500;
const longPdf = write('long.pdf', pdfFixture(Array.from({ length: PAGES }, (_, i) => ({ lines: [
  `Section ${i + 1} of the field almanac.`, `Unique page code: PAGE-${String(i + 1).padStart(4, '0')}-QX.`,
  'Tide tables, weather notes and observation logs recorded by the station crew this season.',
] }))));

let browser;
try {
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) { try { ready = (await fetch(`${base}/api/status`)).ok; } catch { /* starting */ } if (!ready) await sleep(50); }
  assert.ok(ready, 'the reader host failed to start');

  await check('the generated fixtures are what they claim (independent Poppler check)', async () => {
    assert.throws(() => execFileSync(tool('pdftotext'), [locked.file, '-'], { stdio: 'pipe' }), /Incorrect password/);
    assert.match(execFileSync(tool('pdftotext'), ['-upw', 'open-sesame', locked.file, '-'], { encoding: 'utf8' }), /ZEBRA-7319/,
      'with its password the document holds the real text');
    assert.match(execFileSync(tool('pdfinfo'), [ownerOnly.file], { encoding: 'utf8' }), /Encrypted:\s+yes/);
    assert.match(execFileSync(tool('pdfinfo'), [longPdf.file], { encoding: 'utf8' }), new RegExp(`Pages:\\s+${PAGES}\\b`));
  });

  await check('a password-protected PDF is reported as unreadable, for every read and the preview (password-protected-pdf)', async () => {
    for (const body of [{ profile: 'complete', max_chars: 8192, evidence: true }, { profile: 'interactive' }, { pages: '1' }, {}]) {
      const r = await post('/api/pdf/describe', { data_uri: uri(locked.bytes), ...body });
      assert.equal(r.status, 422, JSON.stringify(r.json));
      assert.equal(r.json.ok, false); assert.equal(r.json.encrypted, true);
      assert.match(r.json.error, /password-protected/);
      assert.equal(r.json.text, undefined, 'no text is invented for a document that cannot be opened');
    }
    const text = await fetch(base + '/api/pdf/describe', { method: 'POST', headers: csrfHeaders, body: JSON.stringify({ data_uri: uri(locked.bytes), format: 'text' }) });
    assert.equal(text.status, 422); assert.match(await text.text(), /^read_pdf error: This PDF is password-protected/);
    const thumb = await post('/api/pdf/thumb', { data_uri: uri(locked.bytes) });
    assert.equal(thumb.status, 422); assert.equal(thumb.json.encrypted, true);
  });

  await check('an encrypted PDF that opens without a password is read normally', async () => {
    const r = await post('/api/pdf/describe', { data_uri: uri(ownerOnly.bytes), profile: 'complete', max_chars: 8192 });
    assert.equal(r.status, 200); assert.equal(r.json.completeText, true); assert.match(r.json.text, /ZEBRA-7319/);
    const thumb = await post('/api/pdf/thumb', { data_uri: uri(ownerOnly.bytes) });
    assert.equal(thumb.status, 200); assert.match(thumb.json.thumb, /^data:image\/jpeg;base64,/);
  });

  await check('a 2,500-page PDF is never sent whole and every read stays bounded (very-long-pdf)', async () => {
    const started = performance.now();
    const complete = await post('/api/pdf/describe', { data_uri: uri(longPdf.bytes), profile: 'complete', max_chars: 20480 });
    const completeMs = Math.round(performance.now() - started);
    assert.equal(complete.status, 200); assert.equal(complete.json.readPlanRequired, true);
    assert.equal(complete.json.total, PAGES); assert.equal(complete.json.text, undefined);
    const overview = await post('/api/pdf/describe', { data_uri: uri(longPdf.bytes), profile: 'interactive', max_chars: 20480 });
    assert.equal(overview.status, 200); assert.equal(overview.json.total, PAGES);
    assert.equal(overview.json.sampled, true, 'a bounded overview says it is a sample');
    assert.ok(Buffer.byteLength(overview.json.text) <= 20480, `overview text ${Buffer.byteLength(overview.json.text)} bytes`);
    assert.ok(overview.json.selectedPages <= 48 && overview.json.selectedPages > 1);
    assert.ok(overview.bytes < 256 * 1024, `the whole reply stays small: ${overview.bytes} bytes`);
    const late = await post('/api/pdf/describe', { data_uri: uri(longPdf.bytes), profile: 'interactive', pages: '1999', max_chars: 8192 });
    assert.equal(late.status, 200); assert.match(late.json.text, /PAGE-1999-QX/);
    assert.doesNotMatch(late.json.text, /PAGE-1998-QX|PAGE-2000-QX/, 'exactly the requested physical page');
    // Past the reader's 2,000-page bookkeeping ceiling the request is refused
    // with the document size, not answered with another page.
    const beyond = await post('/api/pdf/describe', { data_uri: uri(longPdf.bytes), profile: 'interactive', pages: '2400' });
    assert.equal(beyond.status, 400);
    assert.match(beyond.json.error, /only the first 2000 pages of this 2500-page document are readable/);
    const past = await post('/api/pdf/describe', { data_uri: uri(longPdf.bytes), pages: '2600' });
    assert.equal(past.status, 400); assert.match(past.json.error, /document has 2500 pages/);
    return { completeProbeMs: completeMs, overviewBytes: overview.bytes, selectedPages: overview.json.selectedPages };
  });

  await check('a PDF read in progress does not hold up status or another PDF read (very-long-pdf)', async () => {
    // Deterministic barrier: the reader blocks opening a FIFO until this test
    // opens its writing end, so one describe is certainly still in flight.
    const fifo = path.join(run, 'held.pdf');
    execFileSync('mkfifo', [fifo]);
    let settled = false;
    const held = post('/api/pdf/describe', { path: fifo, job: 'held-read' }).finally(() => { settled = true; });
    await sleep(200);
    assert.equal(settled, false, 'the held read is still in flight');
    const status = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(5000) });
    assert.equal(status.status, 200, 'status answers during the held read');
    const progress = await (await fetch(`${base}/api/pdf/progress?job=held-read`, { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(progress.done, false);
    const other = await post('/api/pdf/describe', { data_uri: uri(longPdf.bytes), profile: 'interactive', pages: '7', max_chars: 8192 });
    assert.equal(other.status, 200); assert.match(other.json.text, /PAGE-0007-QX/);
    assert.equal(settled, false, 'the long PDF was read while the other read was still held');
    const writer = await fs.promises.open(fifo, 'w');   // release: the reader sees an unseekable, empty input
    await writer.close();
    const released = await held;
    assert.equal(released.status, 400, 'the held input is refused, not read');
  });

  browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript((origin) => {
    if (window !== window.top || location.origin !== origin) return;
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({ v: 2, onboarded: true, model: 'deepseek-v4-flash', modelGguf: 'gguf/test.gguf',
      ctxSize: 65536, enginePower: 100, ssdStreaming: 'off', thinkLevel: 'off', maxTokens: 256, temperature: 0, webMode: 'off', qualityDefaultsVersion: 2 }));
  }, base);
  const fulfill = (route, value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  await context.route('**/api/status', (r) => fulfill(r, { mode: 'server', running: true, ready: true, stage: 'Ready', loadPct: 100, ds4dirOk: true, webdirOk: true,
    lan: false, variants: { flash: true }, variant: 'flash', modelFile: 'gguf/test.gguf', config: { ctx: 65536, power: 100, think: 'off', ssdStreaming: 'off' } }));
  await context.route('**/api/doctor', (r) => fulfill(r, { ok: true, issues: [], checks: [] }));
  await context.route('**/v1/models', (r) => fulfill(r, { data: [{ id: 'deepseek-v4-flash', context_length: 65536 }] }));
  const forbidden = [], completions = [], errors = [];
  await context.route('**/api/start', async (r) => { forbidden.push(r.request().postData()); await r.abort(); });
  await context.route('**/api/embed/setup', async (r) => { forbidden.push('embedding setup'); await r.abort(); });
  await context.route('**/v1/chat/completions', async (route) => {
    const req = route.request().postDataJSON(); completions.push(req);
    if (!req.stream) return fulfill(route, { choices: [{ message: { content: '{"mode":"overview"}' } }] });   // the read planner
    await route.fulfill({ contentType: 'text/event-stream', body:
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'The almanac covers tide tables and observation logs.' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#composer-input').waitFor({ state: 'visible' });

  await check('attaching a password-protected PDF says it cannot be read and blocks Send until removed (password-protected-pdf)', async () => {
    await page.locator('#chat-file-input').setInputFiles(locked.file);
    const tile = page.locator('#composer-files .composer__file').filter({ hasText: 'locked.pdf' });
    await tile.waitFor({ state: 'visible' });
    await page.locator('#composer-files .composer__file--failed').waitFor({ state: 'visible' });
    assert.match(await tile.textContent(), /not read/);
    assert.match(await tile.getAttribute('title'), /password-protected/);
    await page.locator('.toast').filter({ hasText: 'locked.pdf' }).filter({ hasText: 'password-protected' }).waitFor({ state: 'visible' });
    await page.locator('#composer-input').fill('Summarise the attached document.');
    assert.equal(await page.locator('#btn-send').isDisabled(), true, 'Send is blocked while the unreadable file is attached');
    await page.locator('#composer-input').press('Enter');
    await sleep(300);
    assert.equal(completions.length, 0, 'no planner or answer request for a document nobody can open');
    await page.screenshot({ path: path.join(run, 'password-protected.png') });
    await page.getByRole('button', { name: 'Remove locked.pdf', exact: true }).click();
    assert.equal(await page.locator('#btn-send').isDisabled(), false, 'removing it restores Send');
    await page.locator('#composer-input').fill('');
  });

  await check('a 2,500-page PDF reaches the model as a bounded, labelled excerpt (very-long-pdf, simulated planner and answer)', async () => {
    await page.locator('#chat-file-input').setInputFiles(longPdf.file);
    await page.locator('#composer-files').getByText('long.pdf', { exact: true }).waitFor({ state: 'visible' });
    await page.locator('#composer-input').fill('What does the almanac cover?');
    await page.locator('#btn-send').click();
    await page.locator('.msg--assistant:not(.msg--streaming)').filter({ hasText: 'tide tables' }).waitFor({ state: 'visible', timeout: 60_000 });
    const answer = completions.filter((request) => request.stream).at(-1);
    assert.ok(answer, 'the answer request was sent');
    const prompt = JSON.stringify(answer.messages);
    assert.match(prompt, new RegExp(`/${PAGES} representative pages selected for the prompt`));
    const attached = answer.messages.filter((message) => message.role === 'user').map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('');
    assert.ok(Buffer.byteLength(attached) < 64 * 1024, `the request carries a bounded excerpt, not 2,500 pages: ${Buffer.byteLength(attached)} bytes`);
    assert.ok((attached.match(/PAGE-\d{4}-QX/g) || []).length <= 48);
    assert.equal(completions.filter((request) => !request.stream).length, 1, 'one read planner request');
    assert.deepEqual(forbidden, []); assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(run, 'long-pdf-answer.png') });
    return { requestBytes: Buffer.byteLength(attached) };
  });
  report.status = process.exitCode ? 'fail' : 'pass';
} catch (error) {
  report.status = 'fail'; report.error = String(error.stack || error); process.exitCode = 1; console.error(error);
} finally {
  await browser?.close().catch(() => {});
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(300);
  if (server.exitCode === null && server.signalCode === null) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } }
  save(); console.log(`pdf_limits_test (${browserName}): ${report.status}; evidence ${run}`);
}
