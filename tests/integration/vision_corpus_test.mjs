// The frozen vision corpus (tests/fixtures/vision_corpus) and its validator.
// Real checks only: file hashes, DStudio's own PDF reader on every PDF (the
// model-free test host, OCR disabled) and the same Poppler tools it calls.
// No model, no network, no browser. It qualifies no model: nothing here has
// been shown to one.
//   node tests/unit/vision_corpus_test.mjs [tests/.build/dstudio-server-test]
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CORPUS, MINIMUMS, startPdfReader, validateCorpus } from '../support/vision_corpus.mjs';
import { pdfFixture } from '../support/pdf_read_fixture.mjs';

const corpus = path.resolve(DEFAULT_CORPUS);
fs.mkdirSync('tests/.artifacts/vision-corpus', { recursive: true });
const run = fs.mkdtempSync(path.resolve('tests/.artifacts/vision-corpus/run-'));
const report = { scope: 'Frozen vision corpus: recorded bytes, page counts and pixel-only proof through the PDF reader; no model', checks: [] };
const save = () => fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
let reader;

async function check(name, fn) {
  const row = { name };
  report.checks.push(row);
  try { Object.assign(row, await fn()); row.status = 'PASS'; }
  catch (e) { row.status = 'FAIL'; row.error = String(e.stack || e); process.exitCode = 1; }
  save();
  console.log(`${row.status}: ${name}${row.error ? `\n${row.error}` : ''}`);
}

// Validates a private copy of the corpus after `damage(dir, manifest)` changed
// it; the manifest is rewritten only when `damage` returns true.
async function validateCopy(damage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-vision-corpus-copy-'));
  try {
    fs.cpSync(corpus, dir, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (damage(dir, manifest)) fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return (await validateCorpus(dir, { reader })).errors;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
async function refused(name, damage, expected) {
  await check(name, async () => {
    const errors = await validateCopy(damage);
    const codes = errors.map((e) => `${e.code} ${e.where}`);
    for (const [code, where] of expected) {
      assert.ok(errors.some((e) => e.code === code && e.where === where), `expected ${code} at ${where}; got: ${codes.join(' | ') || 'no refusal'}`);
    }
    return { refusals: codes };
  });
}
const item = (manifest, id) => manifest.items.find((entry) => entry.id.startsWith(`${id}-`));
function replaceFile(dir, entry, bytes) {
  fs.writeFileSync(path.join(dir, entry.files[0].path), bytes);
  entry.files[0].bytes = bytes.length;
  entry.files[0].sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
}
function flipByte(dir, file) {
  const target = path.join(dir, file), bytes = fs.readFileSync(target);
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  fs.writeFileSync(target, bytes);
}

try {
  reader = await startPdfReader(process.argv[2] || 'tests/.build/dstudio-server-test', path.join(run, 'reader'));

  await check('the committed corpus is valid', async () => {
    const { errors, summary } = await validateCorpus(corpus, { reader });
    assert.deepEqual(errors, [], errors.map((e) => `${e.code} ${e.where}: ${e.message}`).join('\n'));
    assert.ok(summary.pdfs >= MINIMUMS.pdfs && summary.images >= MINIMUMS.images && summary.imageFiles >= MINIMUMS.images);
    assert.ok(summary.pixelOnlyPdfs >= MINIMUMS.pixelOnlyPdfs && summary.questionTypes.unanswerable >= MINIMUMS.unanswerable);
    assert.ok(summary.bytes < 20 * 1024 * 1024, `${summary.bytes} bytes of PDFs and images`);
    console.log(`  ${summary.pdfs} PDFs (${summary.pdfPages} pages, ${summary.scannedPages} image-only), ${summary.images} image items (${summary.imageFiles} files, ${summary.imageSets} ordered sets), ${summary.questions} questions, ${summary.bytes} bytes`);
    console.log(`  pixel-only facts proven absent from extracted text: ${summary.pixelOnlyFacts.pdf} in ${summary.pixelOnlyPdfs} PDFs (${summary.pixelOnlyFacts.pdfOnTextPages} on pages that have a text layer, in ${summary.pixelOnlyPdfsOnTextPages} PDFs); text facts found on their page: ${summary.textFacts}`);
    return { summary };
  });

  await check('an untouched copy is accepted (control for the refusals below)', async () => {
    assert.deepEqual(await validateCopy(() => false), []);
  });

  await refused('a changed byte in a PDF is refused', (dir) => { flipByte(dir, 'pdf/p09.pdf'); return false; }, [['sha256', 'p09-annual-report']]);
  await refused('a changed byte in an image is refused', (dir) => { flipByte(dir, 'images/i05.png'); return false; }, [['sha256', 'i05-chart-bars']]);
  await refused('a missing file is refused', (dir) => { fs.rmSync(path.join(dir, 'images/s01-b.png')); return false; }, [['missing-file', 's01-three-doors']]);
  await refused('a file that the manifest does not list is refused', (dir) => { fs.copyFileSync(path.join(dir, 'images/i01.png'), path.join(dir, 'images/i99.png')); return false; }, [['unlisted-file', 'images/i99.png']]);

  // The same facts as selectable text: the recorded hash is updated, so only
  // the reader's extraction can tell.
  await refused('a pixel-only fact that a scanned page now carries as text is refused', (dir, manifest) => {
    replaceFile(dir, item(manifest, 'p20'), pdfFixture([{ size: 12, lines: ['Harbourlight Bakery Collective, 14 Kiln Lane', 'We confirm your order of 36 trays of seeded rolls for the harvest fair.', 'Order number HB-3068.'] }]));
    return true;
  }, [['pixel-only-fact-in-text', 'p20-scan-letter/p20-scan-letter-q1'], ['pixel-only-fact-in-text', 'p20-scan-letter/p20-scan-letter-q2'], ['scanned-page-has-text', 'p20-scan-letter']]);
  await refused('a chart value that the page now carries as text is refused', (dir, manifest) => {
    replaceFile(dir, item(manifest, 'p10'), pdfFixture([{ size: 12, lines: ['Harbourlight Bakery Collective - Weekly bread output', 'Figures were recorded by the shift lead, Corwin Ashdale.', 'Cedar oven: 256 loaves.'] }]));
    return true;
  }, [['pixel-only-fact-in-text', 'p10-chart-bar/p10-chart-bar-q1']]);
  await refused('a text fact recorded as pixel-only is refused', (dir, manifest) => {
    item(manifest, 'p01').questions[0].evidence.pixelOnly = true;
    return true;
  }, [['pixel-only-fact-in-text', 'p01-marina-notice/p01-marina-notice-q1']]);
  await refused('a text fact recorded on the wrong physical page is refused', (dir, manifest) => {
    item(manifest, 'p08').questions[2].evidence.page = 2;
    return true;
  }, [['text-fact-missing', 'p08-handbook-47/p08-handbook-47-q3']]);
  await refused('a pixel-only fact recorded as text is refused', (dir, manifest) => {
    item(manifest, 'p14').questions[0].evidence.pixelOnly = false;
    return true;
  }, [['text-fact-missing', 'p14-diagram-flow/p14-diagram-flow-q1']]);
  await refused('a text page recorded as scanned is refused', (dir, manifest) => {
    item(manifest, 'p28').scannedPages = [2, 3];
    return true;
  }, [['scanned-page-has-text', 'p28-mixed-agreement']]);
  await refused('an image-only page recorded as a text page is refused', (dir, manifest) => {
    delete item(manifest, 'p24').scannedPages;
    return true;
  }, [['text-page-missing', 'p24-scan-upside-down']]);

  await refused('a manifest with fewer than 30 PDFs is refused', (dir, manifest) => {
    for (const id of ['p01', 'p02', 'p03']) fs.rmSync(path.join(dir, item(manifest, id).files[0].path));
    manifest.items = manifest.items.filter((entry) => !/^p0[123]-/.test(entry.id));
    assert.equal(manifest.items.filter((entry) => entry.kind === 'pdf').length, 29);
    return true;
  }, [['too-few-pdfs', 'manifest.json']]);
  await refused('a manifest with fewer than 20 images is refused', (dir, manifest) => {
    const drop = manifest.items.filter((entry) => entry.kind === 'image').slice(0, 9);
    for (const entry of drop) fs.rmSync(path.join(dir, entry.files[0].path));
    manifest.items = manifest.items.filter((entry) => !drop.includes(entry));
    return true;
  }, [['too-few-images', 'manifest.json']]);
  await refused('a wrong page count is refused', (dir, manifest) => { item(manifest, 'p02').pages = 3; return true; }, [['page-count', 'p02-verbale-orti']]);
  await refused('a wrong /Rotate record is refused', (dir, manifest) => { item(manifest, 'p30').pageRotations = [0, 0, 180]; return true; }, [['page-rotation', 'p30-mixed-rotate-attr']]);
  await refused('a duplicated id is refused', (dir, manifest) => { item(manifest, 'i02').id = item(manifest, 'i01').id; return true; }, [['duplicate-id', 'i01-ui-tickets']]);
  await refused('an item with a single question is refused', (dir, manifest) => { item(manifest, 'i10').questions.length = 1; return true; }, [['too-few-questions', 'i10-handwritten-note']]);
  await refused('a missing category is refused', (dir, manifest) => {
    for (const entry of manifest.items) if (entry.kind === 'pdf') entry.categories = entry.categories.filter((c) => c !== 'small-text');
    return true;
  }, [['category-coverage', 'manifest.json']]);
  await refused('fewer than 15 unanswerable questions are refused', (dir, manifest) => {
    let kept = 0;
    for (const entry of manifest.items) {
      entry.questions = entry.questions.filter((q) => q.expected.type !== 'unanswerable' || kept++ < 14);
      if (!entry.questions.some((q) => q.expected.type === 'unanswerable')) entry.categories = entry.categories.filter((c) => c !== 'unanswerable');
    }
    return true;
  }, [['too-few-unanswerable', 'manifest.json']]);
} catch (error) {
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (reader) await reader.stop();
  save();
  const passed = report.checks.filter((row) => row.status === 'PASS').length;
  if (report.error) console.log(report.error);
  console.log(`vision_corpus_test: ${passed}/${report.checks.length} passed (frozen files, DStudio PDF reader without OCR, Poppler; no model); ${run}`);
}
