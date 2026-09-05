/* Real Poppler + native HTTP + browser, but deliberately NO inference.
 * Uses an isolated fake engine checkout and DS4UI_TEST_MODE=1. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { freePort } from '../support/real_harness.mjs';

const html = fs.readFileSync('web/index.html', 'utf8');
const moduleSource = html.slice(html.indexOf('    const PdfEvidence = (() => {'), html.indexOf('    const AttachmentPreview = (() => {'));
const core = vm.runInNewContext(`${moduleSource}\nPdfEvidence`, { TextEncoder });
const id = 'a'.repeat(64);
const citation = { id: 'P1', documentId: id, page: 1, quote: 'Annual sales 100.10 EUR' };
const protocol = (value) => `Sales increased [P1].\n\n\`\`\`dstudio-pdf-evidence\n${JSON.stringify(value)}\n\`\`\``;
assert.equal(core.extract(protocol({ citations: [citation] })).evidence.citations[0].id, 'P1');
assert.equal(core.extract(protocol({ citations: [citation, citation] })).evidence, null);
assert.equal(core.extract(protocol({ citations: [{ ...citation, page: 1.5 }] })).evidence, null);
assert.equal(core.extract(protocol({ citations: [{ ...citation, id: undefined }] })).evidence, null);
assert.equal(core.extract(protocol({ citations: [{ ...citation, documentId: '../bad' }] })).evidence, null);
assert.ok(core.extract('```dstudio-pdf-evidence\ninvalid\n```').content.includes('invalid'));
assert.doesNotMatch(core.preview(protocol({ citations: [citation] })), /documentId|dstudio-pdf-evidence/);
assert.equal(core.documents({ messages: [{ id: 'before', role: 'user', attachments: [{ kind: 'pdf', documentId: id }] }, { id: 'answer' }, { id: 'future', role: 'user', attachments: [{ kind: 'pdf', documentId: 'b'.repeat(64) }] }] }, { id: 'answer' }).size, 1);
const verified = new Map([
  ['P1', { status: 'matched', quote: 'Annual sales 100.10 EUR' }],
  ['P2', { status: 'matched', quote: 'Current sales 120.20 EUR' }],
]);
const calc = { operation: 'difference', operands: [{ citation: 'P2', literal: '120.20', decimal: '.' }, { citation: 'P1', literal: '100.10', decimal: '.' }], claimed: '20.10', precision: 2 };
assert.equal(core.calculate(calc, verified).agrees, true);
assert.equal(core.calculate({ ...calc, claimed: '20.11' }, verified).agrees, false);
assert.throws(() => core.calculate(calc, new Map()), /source passage/);
assert.equal(core.literalInQuote('Revenue 12345', '123'), false);
assert.equal(core.literalInQuote('Revenue -123', '123'), false);
assert.equal(core.literalInQuote('Revenue 1 234', '234'), false);
assert.equal(core.literalInQuote('100 and 100', '100'), false);
assert.equal(core.literalInQuote('Amount (123)', '123'), false);
assert.equal(core.literalInQuote('Amount \u2212123', '123'), false);
assert.equal(core.literalInQuote('Date 2025-01-01', '2025'), false);
assert.equal(core.literalInQuote('Amount 123\uff11', '123'), false);
assert.equal(core.decimal('1.234,50', ',').n, 123450n);
assert.equal(core.decimal('1,234.50', '.').n, 123450n);
assert.throws(() => core.decimal('12,34.50', '.'), /grouping/);
const simple = (operation, a, b, claimed, precision = 2) => {
  const proofs = new Map([['A', { status: 'matched', quote: `Amount ${a} EUR` }], ['B', { status: 'matched', quote: `Amount ${b} EUR` }]]);
  return core.calculate({ operation, operands: [{ citation: 'A', literal: a, decimal: '.' }, { citation: 'B', literal: b, decimal: '.' }], claimed, precision }, proofs);
};
assert.equal(simple('sum', '0.1', '0.2', '0.30').value, '0.30');
assert.equal(simple('product', '1.25', '4', '5.00').agrees, true);
assert.equal(simple('ratio', '1', '3', '0.33').agrees, true);
assert.equal(simple('ratio', '-1', '8', '-0.13').agrees, true);
assert.equal(simple('percentage', '20', '80', '25.00').agrees, true);
assert.throws(() => simple('ratio', '1', '0', '0'), /zero/);
console.log('pdf_evidence: protocol, provenance and exact arithmetic passed');

// Small deterministic PDF fixtures with real text placement, no PDF library.
// These are test inputs, not authored document deliverables.
function makePdf(variant = '') {
  const pages = [
    { lines: ['Chapter 1 Revenue', `Annual sales 100.10 EUR${variant}`, 'Current sales 120.20 EUR', 'Revenue 12345 units', 'Repeated phrase', 'Repeated phrase', 'Caf\u00e9 & co <ok>', 'Table row: North 100.10 South 120.20', 'See Section 2 for the cost breakdown.', 'See Chapter 9 for an ambiguous target.'] },
    { lines: ['Section 2 Costs', 'A quotation starts here', 'and continues on another line.', 'Section 2.1 Detail', 'Chapter 9 Repeated header', 'Chapter 9 Repeated header'] },
    { rotate: 90, lines: ['Chapter 3 Rotation', 'Rotated evidence works reliably.'] },
    { crop: true, lines: ['Chapter 4 Crop', 'Cropped page retains the original text.'] },
    { origin: true, lines: ['Chapter 5 Origin', 'Offset origin keeps coordinates honest.'] },
    { image: true, lines: [] },
    { table: true, lines: ['Section 6 Tables'] },
  ];
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const kids = [];
  for (const page of pages) {
    const num = objects.length + 1; kids.push(`${num} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox ${page.origin ? '[10 20 410 620]' : '[0 0 400 600]'} ${page.rotate ? '/Rotate 90' : ''} ${page.crop ? '/CropBox [20 30 380 570]' : ''} /Resources << /Font << /F1 3 0 R >> >> /Contents ${num + 1} 0 R >>`);
    let stream = page.lines.map((line, i) => `BT /F1 12 Tf 40 ${540 - i * 32} Td (${line.replace(/([\\()])/g, '\\$1')}) Tj ET`).join('\n');
    if (page.image) stream += '\nq 80 0 0 80 40 500 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID ff0000> EI Q';
    if (page.table) stream += '\nBT /F1 12 Tf 40 490 Td (North) Tj ET\nBT /F1 12 Tf 230 490 Td (98.75) Tj ET\nBT /F1 12 Tf 40 450 Td (South) Tj ET\nBT /F1 12 Tf 230 450 Td (87.65) Tj ET\n40 480 m 340 480 l S';
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let doc = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(doc, 'latin1')); doc += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(doc, 'latin1');
  doc += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(doc, 'latin1');
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-pdf-evidence-test-'));
const artifacts = path.resolve('tests/.artifacts/pdf-evidence'); fs.mkdirSync(artifacts, { recursive: true });
for (const dir of ['home', 'data', 'ds4/gguf', 'cache']) fs.mkdirSync(path.join(temp, dir), { recursive: true });
fs.writeFileSync(path.join(temp, 'ds4/Makefile'), 'all:\n\t@true\n');
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const server = spawn(path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test'), [String(port), path.join(temp, 'ds4')], {
  env: { ...process.env, HOME: path.join(temp, 'home'), DS4UI_DATA_DIR: path.join(temp, 'data'), DSTUDIO_PDF_CACHE_DIR: path.join(temp, 'cache'), DS4UI_HOST: '127.0.0.1', DS4UI_TEST_MODE: '1', DS4UI_PAGE_FROM_DISK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; server.stdout.on('data', (s) => { logs += s; }); server.stderr.on('data', (s) => { logs += s; });
const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'ds4web' };
async function post(endpoint, body, status = 200) {
  const res = await fetch(base + endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data)); return data;
}
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/status')).ok) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(ready, logs);
  const pdf = makePdf(); fs.writeFileSync(path.join(artifacts, 'fixture.pdf'), pdf);
  const describeBody = { data_uri: `data:application/pdf;base64,${pdf.toString('base64')}`, profile: 'interactive', evidence: true };
  const described = await post('/api/pdf/describe', describeBody);
  assert.match(described.documentId, /^[a-f0-9]{64}$/);
  assert.equal(described.total, 7); assert.ok(described.sections.some((s) => s.page === 2 && s.title === 'Section 2 Costs'));
  assert.ok(described.sections.some((s) => s.title === 'Section 2.1 Detail' && s.parentPage === 2 && s.level === 2));
  assert.equal(described.sectionLinks.length, 1);
  assert.equal(described.sectionLinks[0].targetPage, 2);
  assert.equal(described.hybrid, false);
  const doc = described.documentId;
  const evidence = (page, quote, extra = {}) => post('/api/pdf/evidence', { documentId: doc, page, quote, ...extra });
  const match = await evidence(1, 'Annual sales 100.10 EUR', { render: true });
  assert.equal(match.status, 'matched'); assert.equal(match.matches, 1); assert.equal(match.boxes.length, 4);
  assert.match(match.image, /^data:image\/jpeg;base64,/);
  for (const b of match.boxes) { assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= 1 && b.y + b.height <= 1); }
  fs.writeFileSync(path.join(artifacts, 'page.jpg'), Buffer.from(match.image.split(',')[1], 'base64'));
  const repeated = await evidence(1, 'Repeated phrase'); assert.equal(repeated.status, 'ambiguous'); assert.equal(repeated.matches, 2); assert.equal(repeated.boxes.length, 0);
  assert.equal((await evidence(1, 'Annual sales 100.11 EUR')).status, 'not_found');
  assert.equal((await evidence(1, '123')).status, 'not_found');
  assert.equal((await evidence(1, 'Caf\u00e9 & co <ok>')).status, 'matched');
  assert.equal((await evidence(1, 'Annual\n sales\u00a0100.10  EUR')).status, 'matched');
  assert.equal((await evidence(2, 'A quotation starts here and continues on another line.')).status, 'matched');
  assert.equal((await evidence(6, 'Some imaginary scanned text')).status, 'no_text_layer');
  const cell = await evidence(7, '98.75', { render: true });
  assert.equal(cell.status, 'matched'); assert.equal(cell.boxes.length, 1); assert.ok(cell.boxes[0].x > 0.5);
  assert.equal((await evidence(1, '')).status, 'page_only');
  for (const [page, quote] of [[3, 'Rotated evidence works reliably.'], [4, 'Cropped page retains the original text.'], [5, 'Offset origin keeps coordinates honest.']]) {
    const r = await evidence(page, quote, { render: true });
    assert.equal(r.status, 'matched');
    if (page === 3) { assert.equal(r.width, 600); assert.equal(r.height, 400); }
    fs.writeFileSync(path.join(artifacts, `geometry-${page}.json`), JSON.stringify({ ...r, image: undefined }, null, 2));
    fs.writeFileSync(path.join(artifacts, `geometry-${page}.jpg`), Buffer.from(r.image.split(',')[1], 'base64'));
    console.log(`pdf_evidence: geometry page ${page}: ${r.status} (${r.width} × ${r.height})`);
  }
  await post('/api/pdf/evidence', { documentId: doc, page: 8, quote: 'missing' }, 422);
  await post('/api/pdf/evidence', { documentId: '../bad', page: 1, quote: 'bad' }, 400);
  await post('/api/pdf/evidence', { documentId: doc, page: 1.5, quote: 'bad' }, 400);
  await post('/api/pdf/evidence', { documentId: doc, page: 1, quote: 'a'.repeat(2001) }, 400);
  await post('/api/pdf/evidence', { documentId: doc, page: 1, quote: 'Annual sales 100.10 EUR\u0000 fabricated tail' }, 400);
  await post('/api/pdf/evidence', { documentId: doc, page: 1, quote: 'Annual sales', render: 'true' }, 400);
  for (const raw of [`{"documentId":"${doc}","page":1,"page":2,"quote":"x"}`, `{"documentId":"${doc}" "page":1,"quote":"x"}`, `{"documentId":"${doc}","page":1,"quote":"x"} trailing`]) {
    const response = await fetch(base + '/api/pdf/evidence', { method: 'POST', headers, body: raw }); assert.equal(response.status, 400);
  }
  const noCsrf = await fetch(base + '/api/pdf/evidence', { method: 'POST', body: '{}' }); assert.equal(noCsrf.status, 403);
  const changed = await post('/api/pdf/describe', { ...describeBody, data_uri: `data:application/pdf;base64,${makePdf(' changed').toString('base64')}` });
  assert.notEqual(changed.documentId, doc);
  const cached = await post('/api/pdf/describe', describeBody); assert.equal(cached.documentId, doc); assert.equal(cached.cached, true);
  fs.unlinkSync(path.join(temp, 'cache', `${doc}.source.pdf`));
  await post('/api/pdf/evidence', { documentId: doc, page: 1, quote: 'Annual sales 100.10 EUR' }, 410);
  assert.equal((await post('/api/pdf/describe', describeBody)).documentId, doc);
  assert.equal((await evidence(1, 'Annual sales 100.10 EUR')).status, 'matched');
  for (let i = 0; i < 34; i++) fs.writeFileSync(path.join(temp, 'cache', `${i.toString(16).padStart(64, '0')}.source.pdf`), 'cache fixture');
  await post('/api/pdf/describe', describeBody);
  assert.ok(fs.readdirSync(path.join(temp, 'cache')).filter((s) => s.endsWith('.source.pdf')).length <= 32);
  const sparse = path.join(temp, 'cache', `${'f'.repeat(64)}.source.pdf`);
  fs.writeFileSync(sparse, ''); fs.truncateSync(sparse, 2 * 1024 ** 3 + 1);
  await post('/api/pdf/describe', describeBody);
  const cacheBytes = fs.readdirSync(path.join(temp, 'cache')).filter((s) => s.endsWith('.source.pdf')).reduce((n, s) => n + fs.statSync(path.join(temp, 'cache', s)).size, 0);
  assert.ok(cacheBytes <= 2 * 1024 ** 3);
  fs.writeFileSync(path.join(temp, 'cache', `${doc}.source.pdf`), makePdf(' tampered'));
  await post('/api/pdf/evidence', { documentId: doc, page: 1, quote: 'Annual sales 100.10 EUR' }, 410);
  await post('/api/pdf/describe', describeBody);
  assert.equal((await evidence(1, 'Annual sales 100.10 EUR')).status, 'matched');
  console.log('pdf_evidence: real PDF extraction, HTTP, cache restoration and error cases passed');

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  // Minimal isolated UI: the application's boot code cannot start a model.
  await page.route(`${base}/pdf-evidence-test`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto(`${base}/pdf-evidence-test`);
  const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: `const el = (tag, props = {}, children = []) => { const n = document.createElement(tag); for (const [k,v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k,v); } n.append(...children); return n; }; const on = (n,t,f) => n.addEventListener(t,f); ${moduleSource} window.pdfEvidence = PdfEvidence;` });
  const file = { kind: 'pdf', name: 'Quarterly results.pdf', documentId: doc, pdfSections: described.sections, pdfSectionLinks: described.sectionLinks };
  const p1 = { ...citation, documentId: doc }, p2 = { ...p1, id: 'P2', quote: 'Current sales 120.20 EUR' };
  await page.evaluate(({ file, answer }) => {
    const content = document.createElement('div'); content.textContent = 'Sales increased [P1] [P2].';
    const m = { id: 'answer', role: 'assistant', content: answer };
    const chat = { messages: [{ id: 'user', role: 'user', attachments: [file] }, m] };
    document.body.append(content, window.pdfEvidence.build(m, chat, content));
  }, { file, answer: protocol({ citations: [p1, p2], calculations: [calc] }) });
  assert.equal(await page.locator('.pdf-evidence-inline').count(), 2);
  await page.getByRole('button', { name: 'Check passages and calculations' }).click();
  await page.getByText(/Arithmetic agrees with the answer/).waitFor();
  await page.locator('.pdf-evidence-inline').first().click();
  await page.locator('.pdf-evidence-highlight').first().waitFor();
  assert.equal(await page.locator('.pdf-evidence-highlight').count(), 4);
  await page.screenshot({ path: path.join(artifacts, 'evidence-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(artifacts, 'evidence-mobile.png') });
  assert.ok(await page.locator('.pdf-evidence-dialog').evaluate((n) => n.getBoundingClientRect().right <= innerWidth));
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  assert.equal(await page.locator('.pdf-evidence-page').evaluate((n) => n.style.width), '200%');
  assert.equal(await page.locator('.pdf-evidence-highlight').count(), 4);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.pdf-evidence-dialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('dialog').count(), 0);
  await page.setViewportSize({ width: 1100, height: 1000 });
  for (const [number, quote] of [[3, 'Rotated evidence works reliably.'], [4, 'Cropped page retains the original text.'], [5, 'Offset origin keeps coordinates honest.'], [7, '98.75']]) {
    await page.evaluate(({ citation, file }) => window.pdfEvidence.open(citation, file), { citation: { documentId: doc, page: number, quote }, file });
    await page.locator('.pdf-evidence-highlight').first().waitFor();
    await page.screenshot({ path: path.join(artifacts, `viewer-page-${number}.png`) });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('.pdf-evidence-dialog').waitFor({ state: 'detached' });
  }
  await page.evaluate(({ citation, file }) => window.pdfEvidence.open(citation, file), { citation: { documentId: doc, page: 1, quote: 'Repeated phrase' }, file });
  await page.getByText(/Passage appears more than once/).waitFor();
  assert.equal(await page.locator('.pdf-evidence-highlight').count(), 0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('pdf_evidence: browser citation buttons, verified calculation and responsive viewer passed');
  assert.doesNotMatch(logs, /starting.*(?:ds4-server|model)|loading.*gguf/i);
  assert.doesNotMatch(logs, /AddressSanitizer|runtime error:/);
} finally {
  if (browser) await browser.close();
  fs.writeFileSync(path.join(artifacts, 'server.log'), logs);
  server.kill('SIGTERM'); if (server.exitCode === null) await once(server, 'exit');
  fs.rmSync(temp, { recursive: true, force: true });
}
