// Real native PDF reader + the real dstudio-ocr helper (macOS Vision) on
// generated scans: pages that are only pictures of text, with no text layer.
// No model or network. Each check reads the actual HTTP result.
//   node tests/integration/pdf_ocr_test.mjs tests/.build/dstudio-server-test build/dstudio-ocr
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { freePort, sleep, csrfHeaders } from '../support/real_harness.mjs';
import { pdfFixture, scannedPage } from '../support/pdf_read_fixture.mjs';

const server = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const helper = path.resolve(process.argv[3] || 'build/dstudio-ocr');
fs.mkdirSync('tests/.artifacts', { recursive: true });
const run = fs.mkdtempSync(path.resolve('tests/.artifacts/pdf-ocr-'));
const report = { scope: 'Real PDF reader and Vision OCR on generated scans; no model', helper, checks: [] };
const save = () => fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
const children = [];
if (process.platform !== 'darwin') {
  report.status = 'NOT RUN: dstudio-ocr uses macOS Vision';
  save();
  console.log(`pdf_ocr_test: ${report.status}`);
  process.exit(1);
}

// Every helper run that reads pages is logged; --version calls are not.
const log = path.join(run, 'helper-runs.log');
const wrapper = path.join(run, 'dstudio-ocr');
fs.writeFileSync(wrapper, `#!/bin/sh\n[ "$1" = --version ] || echo "$2" >> "${log}"\nexec "${helper}" "$@"\n`, { mode: 0o755 });
const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

async function startServer(name, env) {
  const dir = path.join(run, name);
  for (const d of ['data', 'cache', 'ds4/gguf']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ds4/Makefile'), 'all:\n\t@true\n');
  const base = `http://127.0.0.1:${await freePort()}`;
  const out = fs.openSync(path.join(dir, 'server.log'), 'wx');
  const child = spawn(server, [new URL(base).port, path.join(dir, 'ds4')], {
    env: { ...process.env, DS4UI_TEST_MODE: '1', DS4UI_DATA_DIR: path.join(dir, 'data'), DS4UI_HOST: '127.0.0.1',
      DSTUDIO_PDF_CACHE_DIR: path.join(dir, 'cache'), ...env },
    stdio: ['ignore', out, out], detached: true,
  });
  fs.closeSync(out);
  children.push(child);
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(`${base}/api/status`)).ok) return base; } catch { /* starting */ }
    await sleep(50);
  }
  throw new Error(`${name} server did not start`);
}
async function read(base, body) {
  const res = await fetch(`${base}/api/pdf/describe`, { method: 'POST', headers: csrfHeaders, body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000) });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return body.format === 'text' ? text : JSON.parse(text);
}
async function check(name, fn) {
  const r = { name };
  report.checks.push(r);
  try { await fn(); r.status = 'PASS'; } catch (e) { r.status = 'FAIL'; r.error = String(e.stack || e); process.exitCode = 1; }
  save();
  console.log(`${r.status}: ${name}${r.error ? `\n${r.error}` : ''}`);
}

try {
  const pdf = pdfFixture([
    { lines: ['Quarterly field report with an ordinary text layer on its first page.'] },
    scannedPage(['Scanned invoice 4471', 'Total due: 1.250,00 EUR', 'Owner: Zoe Martin']),
    scannedPage(['Delivery note 9902', 'Pallets received: 14', 'Signed by the warehouse']),
  ]);
  const source = { data_uri: `data:application/pdf;base64,${pdf.toString('base64')}` };
  const base = await startServer('ocr', { DSTUDIO_OCR_HELPER: wrapper });

  await check('scanned pages are read with OCR and labelled as OCR; the text page stays text', async () => {
    const text = await read(base, { ...source, format: 'text' });
    assert.match(text, /--- Pagina 1 \(testo\) ---\nQuarterly field report/);
    assert.match(text, /--- Pagina 2 \(OCR: testo riconosciuto dall'immagine, può contenere errori\) ---\nScanned invoice 4471\nTotal due: 1\.250,00 EUR\nOwner: Zoe Martin/);
    assert.match(text, /--- Pagina 3 \(OCR[^\n]*\n[^]*Pallets received: 14/);
    assert.match(text, /2 pagine senza livello testuale lette con OCR locale/);
    assert.doesNotMatch(text, /scansionate o solo-immagine omesse/);
    assert.deepEqual(runs(), ['2,3'], 'one helper run for the two scanned pages');
  });
  await check('the JSON result reports OCR pages and the engine', async () => {
    const r = await read(base, source);
    assert.equal(r.ocrPages, 2);
    assert.equal(r.scannedPages, 0);
    assert.equal(r.ocrAvailable, true);
    assert.match(r.ocrEngine, /^dstudio-ocr 1 \(Apple Vision/);
  });
  await check('another read of the same document reuses the OCR cache', async () => {
    const before = runs().length;
    const r = await read(base, { ...source, pages: '3' });
    assert.equal(r.ocrPages, 1);
    assert.equal(r.ocrNewPages, 0);
    assert.match(r.text, /Delivery note 9902/);
    assert.equal(runs().length, before, 'no new OCR run');
  });

  await check('a citation on a scanned page is located in its OCR lines, never as an exact text-layer match', async () => {
    const r = await read(base, { ...source, evidence: true });
    assert.match(r.documentId || '', /^[a-f0-9]{64}$/);
    const proof = async (page, quote) => {
      const res = await fetch(`${base}/api/pdf/evidence`, { method: 'POST', headers: csrfHeaders,
        body: JSON.stringify({ documentId: r.documentId, page, quote, render: true }), signal: AbortSignal.timeout(120_000) });
      const out = await res.json();
      assert.equal(res.status, 200, JSON.stringify(out));
      return out;
    };
    const scanned = await proof(2, 'Total due: 1.250,00 EUR');
    assert.equal(scanned.status, 'ocr_matched');
    assert.equal(scanned.boxes.length, 1, 'one recognized line');
    const [box] = scanned.boxes;
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1 && box.y + box.height <= 1 && box.y < 0.15, JSON.stringify(box));
    assert.ok(Math.abs(scanned.width / scanned.height - 612 / 792) < 0.01, 'page size as viewed');
    fs.writeFileSync(path.join(run, 'ocr-evidence.jpg'), Buffer.from(scanned.image.split(',')[1], 'base64'));
    assert.equal((await proof(2, 'Total due: 9.999,00 EUR')).status, 'not_found');
    assert.equal((await proof(1, 'Quarterly field report')).status, 'matched', 'text-layer pages are unchanged');
  });

  const capped = await startServer('capped', { DSTUDIO_OCR_HELPER: wrapper, DSTUDIO_OCR_PAGES_PER_READ: '1' });
  await check('OCR work per read is bounded; the rest is pending and the next read continues', async () => {
    const first = await read(capped, source);
    assert.equal(first.ocrNewPages, 1);
    assert.equal(first.ocrPendingPages, 1);
    assert.equal(first.scannedPages, 1);
    assert.match(first.text, /1 pagine scansionate non ancora lette con OCR \(massimo 1 nuove pagine per lettura\): rileggere o chiedere le pagine 3-3/);
    const second = await read(capped, source);
    assert.notEqual(second.cached, true, 'a read with pending OCR is not served from the result cache');
    assert.equal(second.ocrNewPages, 1);
    assert.equal(second.ocrPages, 2);
    assert.equal(second.ocrPendingPages, 0);
  });

  const missing = await startServer('missing', { DSTUDIO_OCR_HELPER: path.join(run, 'no-such-helper') });
  await check('without the helper, scanned pages are reported as unread, not invented', async () => {
    const r = await read(missing, source);
    assert.equal(r.ocrAvailable, false);
    assert.equal(r.ocrPages, 0);
    assert.equal(r.scannedPages, 2);
    assert.match(r.text, /OCR non disponibile/);
    assert.doesNotMatch(r.text, /Scanned invoice/);
  });

  await check('the helper stops when the process that started it exits', async () => {
    const book = path.join(run, 'book.pdf');
    fs.writeFileSync(book, pdfFixture(Array.from({ length: 30 }, (_, i) => scannedPage([`Page ${i + 1} of a long scanned book`]))));
    const pid = Number(execFileSync('/bin/sh', ['-c', `"${helper}" "${book}" 1-30 >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).trim());
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) {
      await sleep(100);
      try { process.kill(pid, 0); } catch { alive = false; }
    }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, 'an orphaned helper kept reading pages');
  });

  await check('a helper whose parent exited before it started does not run', async () => {
    // The subshell outlives the shell that started it, then becomes the
    // helper: its parent is already launchd when it starts (the race that
    // left a helper reading a whole book under load).
    const book = path.join(run, 'book.pdf');
    const out = path.join(run, 'orphan.jsonl');
    const pid = Number(execFileSync('/bin/sh', ['-c', `(sleep 0.3; exec "${helper}" "${book}" 1-30 >"${out}" 2>&1) & echo $!`], { encoding: 'utf8' }).trim());
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) {
      await sleep(100);
      try { process.kill(pid, 0); } catch { alive = false; }
    }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.equal(alive, false, 'an orphaned helper kept reading pages');
    assert.equal(fs.readFileSync(out, 'utf8'), '', 'no page was read for an owner that was already gone');
  });
} catch (error) {
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
  save();
  const passed = report.checks.filter((c) => c.status === 'PASS').length;
  if (report.error) console.log(report.error);
  console.log(`pdf_ocr_test: ${passed}/${report.checks.length} passed (real reader, real Vision OCR, generated scans; no model); ${run}`);
}
