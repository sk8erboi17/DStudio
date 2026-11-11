// Validator of the frozen public vision corpus (tests/fixtures/vision_corpus).
//
// The corpus is input for later real-model runs; this file qualifies no model.
// It proves what can be proven without one: the files are the recorded bytes,
// every PDF opens with the recorded pages, and every fact marked pixel-only is
// absent from the text DStudio's own PDF reader extracts, while every fact
// marked as text is present on its stated physical page.
//
// Extraction path: the model-free test host (tests/.build/dstudio-server-test)
// answers POST /api/pdf/describe exactly as the app does (pdftotext -layout via
// src/dstudio_pdf.c). The OCR helper is pointed at a missing file, so the
// result is the text layer only: with OCR available the reader would add
// recognized text for image-only pages, which is a different, labelled source.
// The same Poppler tools the reader calls are also run directly, to count the
// characters of pages the reader reports as scanned and to read /Rotate.
//
//   node tests/support/vision_corpus.mjs [CORPUS_DIR] [TEST_HOST]   prints the summary
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { freePort, sleep, csrfHeaders } from './real_harness.mjs';

export const SCHEMA = 'dstudio.vision-corpus.v1';
export const DEFAULT_CORPUS = 'tests/fixtures/vision_corpus';
export const PDF_CATEGORIES = ['native-text', 'scanned', 'mixed', 'multipage', 'chart', 'table', 'diagram',
  'small-text', 'rotated', 'page-labels', 'pixel-only', 'unanswerable'];
export const IMAGE_CATEGORIES = ['ui', 'chart', 'table', 'handwriting', 'stylised-font', 'small-text', 'rotated',
  'low-contrast', 'diagram', 'visual-attributes', 'image-order', 'pixel-only', 'unanswerable'];
export const QUESTION_TAGS = ['physical-page', 'two-pages', 'printed-label', 'image-order', 'count', 'colour', 'shape', 'position'];
export const EXPECTED_TYPES = ['exact', 'number', 'one-of', 'all-of', 'unanswerable'];

// The floor the frozen corpus must keep (PLAN.MD P4 item 3). `pdfCategories`
// and `imageCategories` count items; `questionTags` counts questions.
export const MINIMUMS = {
  pdfs: 30,
  images: 20,
  imageSets: 3,
  questionsPerItem: 2,
  unanswerable: 15,
  pixelOnlyPdfs: 12,
  // Pixel-only facts on a page that also has a text layer: the reader never
  // runs OCR on such a page, so only a pixel path can reach them.
  pixelOnlyPdfsOnTextPages: 8,
  languageItems: 5,
  pdfCategories: { 'native-text': 8, scanned: 5, mixed: 3, multipage: 5, chart: 4, table: 5, diagram: 3,
    'small-text': 3, rotated: 4, 'page-labels': 3, 'pixel-only': 12, unanswerable: 10 },
  imageCategories: { ui: 3, chart: 3, table: 2, handwriting: 2, 'stylised-font': 2, 'small-text': 2, rotated: 2,
    'low-contrast': 2, diagram: 3, 'visual-attributes': 2, 'image-order': 3, 'pixel-only': 20, unanswerable: 5 },
  questionTags: { 'physical-page': 5, 'two-pages': 5, 'printed-label': 3, 'image-order': 6, count: 3, colour: 2, shape: 1, position: 2 },
};

// Case and whitespace do not distinguish a fact from its extraction; NFKC
// also folds ligatures and non-breaking spaces a text layer may contain.
export function normalise(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
const squeeze = (text) => normalise(text).replace(/ /g, '');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const visible = (text) => text.replace(/\s+/g, '').length;

// Same lookup order as pdf_find_tool in src/dstudio_pdf.c.
function popplerTool(name) {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next */ }
  }
  throw new Error(`Poppler ${name} is required (the PDF reader uses it); a missing dependency is not a pass`);
}

// Text layer and /Rotate straight from Poppler, with the reader's arguments.
function popplerRead(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-vision-pdf-'));
  try {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, bytes);
    return popplerReadFile(file);
  } catch (e) { return { error: String(e.message).slice(0, 300) }; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function popplerReadFile(file) {
  const text = execFileSync(popplerTool('pdftotext'), ['-layout', '-enc', 'UTF-8', file, '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const parts = text.split('\f');
  if (parts.length > 1 && parts[parts.length - 1].trim() === '') parts.pop();
  // Every page, so that each /Rotate is reported ("Page N rot:").
  const info = execFileSync(popplerTool('pdfinfo'), ['-f', '1', '-l', '2000', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const rotations = [];
  for (const m of info.matchAll(/^Page\s+(\d+) rot:\s+(\d+)/gm)) rotations[+m[1] - 1] = +m[2];
  const meta = {};
  for (const key of ['Title', 'Subject', 'Keywords', 'Author']) {
    const m = info.match(new RegExp(`^${key}:\\s+(.*)$`, 'm'));
    if (m) meta[key] = m[1];
  }
  return { pages: parts, rotations, meta, total: Number((info.match(/^Pages:\s+(\d+)/m) || [])[1] || 0) };
}

// Starts the model-free host and returns read(bytes): the reader's own result
// for a PDF, split into physical pages, with Poppler's direct reading of the
// same bytes under `poppler`. Results are kept per SHA-256 for the life of
// this object (one entry per distinct PDF it was given): equal bytes give an
// equal extraction. A request that could not be made is not kept.
export async function startPdfReader(serverBinary, workDir) {
  const binary = path.resolve(serverBinary);
  if (!fs.existsSync(binary)) throw new Error(`test host not built: ${binary} (make tests/.build/dstudio-server-test)`);
  const dir = workDir ? path.resolve(workDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-vision-corpus-'));
  for (const d of ['data', 'cache', 'ds4/gguf']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ds4/Makefile'), 'all:\n\t@true\n');
  const base = `http://127.0.0.1:${await freePort()}`;
  const log = fs.openSync(path.join(dir, 'server.log'), 'w');
  const child = spawn(binary, [new URL(base).port, path.join(dir, 'ds4')], {
    env: { ...process.env, DS4UI_TEST_MODE: '1', DS4UI_DATA_DIR: path.join(dir, 'data'), DS4UI_HOST: '127.0.0.1',
      DSTUDIO_PDF_CACHE_DIR: path.join(dir, 'cache'), DSTUDIO_OCR_HELPER: path.join(dir, 'ocr-helper-disabled') },
    stdio: ['ignore', log, log], detached: true,
  });
  fs.closeSync(log);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await Promise.race([exited, sleep(5000)]);
    if (!workDir) fs.rmSync(dir, { recursive: true, force: true });
  };
  let up = false;
  for (let i = 0; i < 200 && !up && child.exitCode === null; i++) {
    try { up = (await fetch(`${base}/api/status`)).ok; } catch { /* starting */ }
    if (!up) await sleep(50);
  }
  if (!up) { await stop(); throw new Error(`test host did not start: ${binary}`); }

  const seen = new Map();
  async function read(bytes) {
    const key = sha256(bytes);
    if (seen.has(key)) return seen.get(key);
    const res = await fetch(`${base}/api/pdf/describe`, { method: 'POST', headers: csrfHeaders,
      body: JSON.stringify({ data_uri: `data:application/pdf;base64,${bytes.toString('base64')}` }),
      signal: AbortSignal.timeout(300_000) });
    const body = await res.text();
    let result;
    if (res.status !== 200) result = { error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    else {
      const json = JSON.parse(body);
      // "\n--- Pagina N (testo) ---\n<page text>\n" per page with a usable text
      // layer; bracketed reader notes follow the last page.
      const text = String(json.text || '').replace(/\n\[(?:OCR non disponibile|\d+ pagine |Testo troncato|Contesto PDF|Intervallo letto|PDF troncato|Ricerca ibrida)[^\n]*\]\n/g, '\n');
      const marks = [...text.matchAll(/\n--- Pagina (\d+) \(([^)\n]*)\) ---\n/g)];
      const pages = new Map();
      marks.forEach((m, i) => pages.set(+m[1], { label: m[2], text: text.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : text.length) }));
      result = { total: json.total, textPages: json.textPages, scannedPages: json.scannedPages, ocrPages: json.ocrPages,
        ocrAvailable: json.ocrAvailable, pages };
    }
    result.poppler = popplerRead(bytes);
    seen.set(key, result);
    return result;
  }
  return { read, stop, base, dir };
}

function pngInfo(bytes) {
  if (bytes.length < 33 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  const chunks = [];
  let at = 8, width = 0, height = 0;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > bytes.length) return null;
    if (type === 'IHDR') { width = bytes.readUInt32BE(at + 8); height = bytes.readUInt32BE(at + 12); }
    chunks.push(type);
    at += 12 + length;
    if (type === 'IEND') break;
  }
  if (chunks[0] !== 'IHDR' || chunks[chunks.length - 1] !== 'IEND' || at !== bytes.length) return null;
  return { width, height, chunks };
}

function evidenceFacts(question) {
  const e = question.evidence || {};
  return [e, ...(Array.isArray(e.also) ? e.also : [])];
}

// Returns { errors: [{ code, where, message }], summary }. An empty `errors`
// is the only accepted corpus; nothing is repaired or skipped.
export async function validateCorpus(root, { reader }) {
  const errors = [];
  const fail = (code, where, message) => errors.push({ code, where, message });
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); }
  catch (e) { fail('manifest-unreadable', 'manifest.json', String(e.message)); return { errors, summary: null }; }
  if (manifest.schema !== SCHEMA) fail('schema', 'manifest.json', `schema is ${JSON.stringify(manifest.schema)}, expected ${SCHEMA}`);
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (!Array.isArray(manifest.items)) fail('schema', 'manifest.json', 'items is not an array');

  const summary = { items: items.length, pdfs: 0, images: 0, imageSets: 0, imageFiles: 0, bytes: 0, questions: 0,
    questionTypes: {}, questionTags: {}, pdfCategories: {}, imageCategories: {}, languages: { pdf: {}, image: {} },
    pdfPages: 0, scannedPages: 0, pixelOnlyFacts: { pdf: 0, pdfOnTextPages: 0, image: 0 }, textFacts: 0,
    pixelOnlyPdfs: 0, pixelOnlyPdfsOnTextPages: 0, multipagePdfs: 0, pdfRotations: {}, imageRotations: {} };
  const bump = (bag, key) => { bag[key] = (bag[key] || 0) + 1; };
  const itemIds = new Set(), questionIds = new Set(), listed = new Set();

  for (const item of items) {
    const where = String(item && item.id);
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(item.id)) { fail('item-id', where, 'id must be lower-case letters, digits and dashes'); continue; }
    if (itemIds.has(item.id)) fail('duplicate-id', where, 'item id is used twice');
    itemIds.add(item.id);
    const isPdf = item.kind === 'pdf', isSet = item.kind === 'image-set';
    if (!['pdf', 'image', 'image-set'].includes(item.kind)) { fail('item-kind', where, `unknown kind ${JSON.stringify(item.kind)}`); continue; }
    if (!['en', 'it'].includes(item.language)) fail('item-language', where, 'language must be "en" or "it"');
    else bump(summary.languages[isPdf ? 'pdf' : 'image'], item.language);
    if (isPdf) summary.pdfs++; else if (isSet) { summary.images++; summary.imageSets++; } else summary.images++;

    // Files: recorded bytes, nothing else.
    const files = Array.isArray(item.files) ? item.files : [];
    const wanted = isPdf ? [1, 1] : isSet ? [2, 4] : [1, 1];
    if (files.length < wanted[0] || files.length > wanted[1]) fail('item-files', where, `${item.kind} must list ${wanted[0]}${wanted[1] > wanted[0] ? `-${wanted[1]}` : ''} file(s), has ${files.length}`);
    const loaded = [];
    for (const file of files) {
      // Opaque names: a file name must not tell a model what the file shows.
      const shape = isPdf ? /^pdf\/p\d{2}\.pdf$/ : isSet ? /^images\/s\d{2}-[a-d]\.png$/ : /^images\/i\d{2}\.png$/;
      if (!file || typeof file.path !== 'string' || !shape.test(file.path)) { fail('file-path', where, `invalid path ${JSON.stringify(file && file.path)}`); continue; }
      if (listed.has(file.path)) fail('duplicate-file', where, `${file.path} is listed twice`);
      listed.add(file.path);
      let bytes;
      try { bytes = fs.readFileSync(path.join(root, file.path)); }
      catch { fail('missing-file', where, `${file.path} does not exist`); continue; }
      summary.bytes += bytes.length;
      if (bytes.length !== file.bytes) fail('file-size', where, `${file.path} has ${bytes.length} bytes, manifest records ${file.bytes}`);
      if (sha256(bytes) !== file.sha256) fail('sha256', where, `${file.path} does not match its recorded SHA-256`);
      if (!isPdf) {
        summary.imageFiles++;
        const png = pngInfo(bytes);
        if (!png) fail('png-invalid', where, `${file.path} is not a complete PNG`);
        else {
          if (png.width !== file.width || png.height !== file.height) fail('png-size', where, `${file.path} is ${png.width}x${png.height}, manifest records ${file.width}x${file.height}`);
          const text = png.chunks.filter((type) => ['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type));
          if (text.length) fail('png-text-chunk', where, `${file.path} carries metadata chunks (${text.join(', ')})`);
        }
      }
      loaded.push({ file, bytes });
    }

    // Categories and questions.
    const allowed = isPdf ? PDF_CATEGORIES : IMAGE_CATEGORIES;
    const categories = Array.isArray(item.categories) ? item.categories : [];
    if (!categories.length) fail('item-categories', where, 'no categories');
    for (const c of categories) {
      if (!allowed.includes(c)) fail('item-categories', where, `unknown category ${JSON.stringify(c)}`);
      else bump(isPdf ? summary.pdfCategories : summary.imageCategories, c);
    }
    const has = (c) => categories.includes(c);
    const questions = Array.isArray(item.questions) ? item.questions : [];
    if (questions.length < MINIMUMS.questionsPerItem) fail('too-few-questions', where, `${questions.length} question(s), at least ${MINIMUMS.questionsPerItem} required`);
    const pages = isPdf ? item.pages : 0;
    if (isPdf && !(Number.isInteger(pages) && pages >= 1)) fail('item-pages', where, 'pages must be a positive integer');
    const scanned = new Set(Array.isArray(item.scannedPages) ? item.scannedPages : []);
    for (const p of scanned) if (!(Number.isInteger(p) && p >= 1 && p <= pages)) fail('item-pages', where, `scannedPages lists ${p}`);
    let pixelQuestions = 0, pixelOnTextPages = 0, unanswerable = 0;
    const tagsHere = new Set();
    for (const q of questions) {
      const qw = `${where}/${q && q.id}`;
      if (!q || typeof q.id !== 'string' || !q.id.startsWith(`${item.id}-`)) { fail('question-id', qw, 'question id must start with its item id'); continue; }
      if (questionIds.has(q.id)) fail('duplicate-id', qw, 'question id is used twice');
      questionIds.add(q.id);
      summary.questions++;
      if (typeof q.prompt !== 'string' || q.prompt.trim().length < 8) fail('question-prompt', qw, 'prompt is missing');
      for (const tag of q.tags || []) {
        if (!QUESTION_TAGS.includes(tag)) fail('question-tags', qw, `unknown tag ${JSON.stringify(tag)}`);
        else { bump(summary.questionTags, tag); tagsHere.add(tag); }
      }
      const expected = q.expected || {}, evidence = q.evidence || {};
      if (!EXPECTED_TYPES.includes(expected.type)) { fail('expected', qw, `unknown expected.type ${JSON.stringify(expected.type)}`); continue; }
      bump(summary.questionTypes, expected.type);
      const strings = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim());
      if (expected.type === 'exact' && !(typeof expected.value === 'string' && expected.value.trim())) fail('expected', qw, 'exact needs a string value');
      if (expected.type === 'number' && !(Number.isFinite(expected.value) && (expected.tolerance === undefined || (Number.isFinite(expected.tolerance) && expected.tolerance >= 0)))) fail('expected', qw, 'number needs a finite value and a non-negative tolerance');
      if ((expected.type === 'one-of' || expected.type === 'all-of') && !strings(expected.value)) fail('expected', qw, `${expected.type} needs a list of strings`);
      if (expected.type === 'unanswerable') {
        unanswerable++;
        if ('value' in expected) fail('expected', qw, 'unanswerable carries no value');
        if (evidence.fact !== null || typeof evidence.missing !== 'string' || !evidence.missing.trim()) fail('evidence', qw, 'unanswerable needs fact: null and a "missing" statement');
        if (evidence.absentTerms !== undefined && !strings(evidence.absentTerms)) fail('evidence', qw, 'absentTerms must be a list of strings');
        continue;
      }
      const facts = evidenceFacts(q);
      const factPages = new Set();
      let pixel = false, pixelText = false;
      for (const fact of facts) {
        if (typeof fact.fact !== 'string' || !fact.fact.trim() || typeof fact.pixelOnly !== 'boolean') { fail('evidence', qw, 'each fact needs a literal "fact" and a boolean "pixelOnly"'); continue; }
        if (isPdf) {
          if (!(Number.isInteger(fact.page) && fact.page >= 1 && fact.page <= pages)) { fail('evidence', qw, `fact ${JSON.stringify(fact.fact)} needs a physical page between 1 and ${pages}`); continue; }
          factPages.add(fact.page);
          if (fact.pixelOnly) { pixel = true; summary.pixelOnlyFacts.pdf++; if (!scanned.has(fact.page)) { pixelText = true; summary.pixelOnlyFacts.pdfOnTextPages++; } }
          else { summary.textFacts++; if (scanned.has(fact.page)) fail('evidence', qw, `page ${fact.page} is recorded as scanned, so ${JSON.stringify(fact.fact)} cannot be a text fact`); }
        } else {
          if (!fact.pixelOnly) fail('evidence', qw, 'every fact of an image is pixel-only');
          else { pixel = true; summary.pixelOnlyFacts.image++; }
          if (isSet && !(Number.isInteger(fact.image) && fact.image >= 1 && fact.image <= files.length)) fail('evidence', qw, `fact ${JSON.stringify(fact.fact)} needs "image" between 1 and ${files.length}`);
        }
      }
      if (pixel) pixelQuestions++;
      if (pixelText) pixelOnTextPages++;
      const tagged = (tag) => (q.tags || []).includes(tag);
      if (tagged('two-pages') && factPages.size < 2) fail('question-tags', qw, 'two-pages needs facts on two different physical pages');
      if ((tagged('physical-page') || tagged('printed-label')) && !isPdf) fail('question-tags', qw, 'page tags belong to PDFs');
      if (tagged('image-order') && !isSet) fail('question-tags', qw, 'image-order belongs to an image set');
    }

    // The categories must describe the item, not decorate it.
    if (has('unanswerable') !== (unanswerable > 0)) fail('category-mismatch', where, 'category "unanswerable" must match the presence of an unanswerable question');
    if (has('pixel-only') !== (pixelQuestions > 0)) fail('category-mismatch', where, 'category "pixel-only" must match the presence of a pixel-only fact');
    if (!isPdf) {
      if (pixelQuestions === 0) fail('category-mismatch', where, 'an image needs at least one pixel-only fact');
      if (has('image-order') !== isSet) fail('category-mismatch', where, 'category "image-order" is for image sets');
      if (isSet && !tagsHere.has('image-order')) fail('category-mismatch', where, 'an image set needs a question tagged image-order');
      if (has('rotated')) {
        if (![90, 180, 270].includes(item.rotation)) fail('category-mismatch', where, 'a rotated image records rotation 90, 180 or 270');
        else bump(summary.imageRotations, item.rotation);
      }
      continue;
    }

    summary.pdfPages += Number.isInteger(pages) ? pages : 0;
    summary.scannedPages += scanned.size;
    if (pixelQuestions > 0) summary.pixelOnlyPdfs++;
    if (pixelOnTextPages > 0) summary.pixelOnlyPdfsOnTextPages++;
    if (has('scanned') && scanned.size !== pages) fail('category-mismatch', where, '"scanned" means every page is image-only');
    if (has('mixed') && !(scanned.size > 0 && scanned.size < pages)) fail('category-mismatch', where, '"mixed" means some pages are image-only and some are not');
    if (has('native-text') && scanned.size !== 0) fail('category-mismatch', where, '"native-text" means every page has a text layer');
    if (['scanned', 'mixed', 'native-text'].filter(has).length !== 1) fail('category-mismatch', where, 'exactly one of native-text, scanned, mixed');
    if (has('multipage')) {
      summary.multipagePdfs++;
      if (!(pages >= 5)) fail('category-mismatch', where, '"multipage" needs five or more pages');
      if (!tagsHere.has('physical-page') || !tagsHere.has('two-pages')) fail('category-mismatch', where, '"multipage" needs a physical-page question and a two-pages question');
    }
    const labels = item.pageLabels;
    if (labels !== undefined && !(Array.isArray(labels) && labels.length === pages && labels.every((l) => l === null || typeof l === 'string'))) fail('item-pages', where, 'pageLabels must give one printed label (or null) per physical page');
    if (has('page-labels')) {
      if (!Array.isArray(labels) || !labels.some((l, i) => l !== null && l !== String(i + 1))) fail('category-mismatch', where, '"page-labels" needs printed labels that differ from the physical index');
      if (!tagsHere.has('printed-label')) fail('category-mismatch', where, '"page-labels" needs a question tagged printed-label');
    }
    const rotations = Array.isArray(item.pageRotations) ? item.pageRotations : null;
    const turned = Array.isArray(item.contentRotations) ? item.contentRotations : null;
    for (const [name, list] of [['pageRotations', rotations], ['contentRotations', turned]]) {
      if (list && !(list.length === pages && list.every((r) => [0, 90, 180, 270].includes(r)))) fail('item-pages', where, `${name} must give 0, 90, 180 or 270 per physical page`);
      for (const r of list || []) if (r) bump(summary.pdfRotations, `${name}:${r}`);
    }
    if (has('rotated') && !((rotations || []).some(Boolean) || (turned || []).some(Boolean))) fail('category-mismatch', where, '"rotated" needs a rotated page or rotated content');

    // The reader's own extraction of these bytes.
    const pdf = loaded[0];
    if (!pdf) continue;
    let read;
    try { read = await reader.read(pdf.bytes); } catch (e) { read = { error: String(e.message) }; }
    if (read.error) { fail('pdf-unreadable', where, `DStudio's reader refused ${pdf.file.path}: ${read.error}`); continue; }
    if (read.total !== pages) fail('page-count', where, `the reader reports ${read.total} page(s), manifest records ${pages}`);
    if (read.ocrAvailable !== false || read.ocrPages !== 0) fail('ocr-active', where, 'the reader used OCR; the proof needs the text layer alone');
    const poppler = read.poppler;
    if (poppler.error) { fail('pdf-unreadable', where, `Poppler could not read ${pdf.file.path}: ${poppler.error}`); continue; }
    if (poppler.total !== pages) fail('page-count', where, `pdfinfo reports ${poppler.total} page(s), manifest records ${pages}`);
    for (let p = 1; p <= pages; p++) {
      const layer = poppler.pages[p - 1] || '';
      const page = read.pages.get(p);
      if (scanned.has(p)) {
        if (page) fail('scanned-page-has-text', where, `the reader returned text for page ${p}, recorded as scanned`);
        if (visible(layer) !== 0) fail('scanned-page-has-text', where, `page ${p} is recorded as scanned but its text layer has ${visible(layer)} visible character(s)`);
      } else if (!page) fail('text-page-missing', where, `the reader returned no text for page ${p}, recorded as a text page`);
      else if (normalise(page.text) !== normalise(layer)) fail('extraction-mismatch', where, `page ${p}: the reader's text differs from Poppler's text layer`);
      else if (page.label !== 'testo') fail('ocr-active', where, `page ${p} is labelled ${JSON.stringify(page.label)}`);
      if (rotations && (poppler.rotations[p - 1] || 0) !== rotations[p - 1]) fail('page-rotation', where, `page ${p} has /Rotate ${poppler.rotations[p - 1] || 0}, manifest records ${rotations[p - 1]}`);
      if (!rotations && (poppler.rotations[p - 1] || 0) !== 0) fail('page-rotation', where, `page ${p} has /Rotate ${poppler.rotations[p - 1]}, manifest records none`);
    }
    if (read.textPages !== pages - scanned.size || read.scannedPages !== scanned.size) fail('scanned-page-count', where, `the reader reports ${read.textPages} text and ${read.scannedPages} scanned page(s); manifest records ${pages - scanned.size} and ${scanned.size}`);

    // Pixel-only facts are in no page's text; text facts are on their page.
    const readerText = [...read.pages.values()].map((page) => page.text).join('\n');
    const everywhere = [readerText, poppler.pages.join('\n'), Object.values(poppler.meta).join('\n')];
    const occurs = (text, fact) => normalise(text).includes(normalise(fact)) || squeeze(text).includes(squeeze(fact));
    for (const q of questions) {
      const qw = `${where}/${q && q.id}`;
      if (!q || !q.expected) continue;
      if (q.expected.type === 'unanswerable') {
        for (const term of (q.evidence && q.evidence.absentTerms) || []) if (everywhere.some((text) => occurs(text, term))) fail('absent-term-in-text', qw, `${JSON.stringify(term)} occurs in the extracted text`);
        continue;
      }
      for (const fact of evidenceFacts(q)) {
        if (typeof fact.fact !== 'string' || typeof fact.pixelOnly !== 'boolean' || !Number.isInteger(fact.page)) continue;
        if (fact.pixelOnly) {
          if (everywhere.some((text) => occurs(text, fact.fact))) fail('pixel-only-fact-in-text', qw, `${JSON.stringify(fact.fact)} is recorded as pixel-only but occurs in the extracted text or the document metadata`);
        } else {
          const page = read.pages.get(fact.page);
          if (!page || !normalise(page.text).includes(normalise(fact.fact))) fail('text-fact-missing', qw, `${JSON.stringify(fact.fact)} is not in the extracted text of physical page ${fact.page}`);
        }
      }
    }
  }

  // Files nobody listed are not part of a frozen corpus.
  for (const dir of ['pdf', 'images']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)); } catch { /* reported as missing files */ }
    for (const name of names) if (!name.startsWith('.') && !listed.has(`${dir}/${name}`)) fail('unlisted-file', `${dir}/${name}`, 'file is not in the manifest');
  }

  // Coverage floor.
  const need = (code, have, min, what) => { if (have < min) fail(code, 'manifest.json', `${have} ${what}, at least ${min} required`); };
  need('too-few-pdfs', summary.pdfs, MINIMUMS.pdfs, 'PDF item(s)');
  need('too-few-images', summary.images, MINIMUMS.images, 'image item(s)');
  need('too-few-images', summary.imageFiles, MINIMUMS.images, 'image file(s)');
  need('too-few-image-sets', summary.imageSets, MINIMUMS.imageSets, 'ordered image set(s)');
  need('too-few-unanswerable', summary.questionTypes.unanswerable || 0, MINIMUMS.unanswerable, 'unanswerable question(s)');
  need('too-few-pixel-only', summary.pixelOnlyPdfs, MINIMUMS.pixelOnlyPdfs, 'PDF(s) with a pixel-only fact');
  need('too-few-pixel-only', summary.pixelOnlyPdfsOnTextPages, MINIMUMS.pixelOnlyPdfsOnTextPages, 'PDF(s) with a pixel-only fact on a page that has a text layer');
  for (const [c, min] of Object.entries(MINIMUMS.pdfCategories)) need('category-coverage', summary.pdfCategories[c] || 0, min, `PDF(s) in category ${c}`);
  for (const [c, min] of Object.entries(MINIMUMS.imageCategories)) need('category-coverage', summary.imageCategories[c] || 0, min, `image item(s) in category ${c}`);
  for (const [t, min] of Object.entries(MINIMUMS.questionTags)) need('tag-coverage', summary.questionTags[t] || 0, min, `question(s) tagged ${t}`);
  for (const kind of ['pdf', 'image']) for (const lang of ['en', 'it']) need('language-coverage', summary.languages[kind][lang] || 0, MINIMUMS.languageItems, `${kind} item(s) in "${lang}"`);
  const quarter = (bag, prefix) => Object.keys(bag).some((k) => /(?:^|:)(?:90|270)$/.test(k) && k.startsWith(prefix));
  const half = (bag, prefix) => Object.keys(bag).some((k) => /(?:^|:)180$/.test(k) && k.startsWith(prefix));
  if (!quarter(summary.pdfRotations, '') || !half(summary.pdfRotations, '')) fail('rotation-coverage', 'manifest.json', 'PDFs need both a quarter turn and a half turn');
  if (!quarter(summary.pdfRotations, 'pageRotations') || !quarter(summary.pdfRotations, 'contentRotations')) fail('rotation-coverage', 'manifest.json', 'PDFs need both a /Rotate page and visibly rotated content');
  if (!quarter(summary.imageRotations, '') || !half(summary.imageRotations, '')) fail('rotation-coverage', 'manifest.json', 'images need both a quarter turn and a half turn');
  return { errors, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const reader = await startPdfReader(process.argv[3] || 'tests/.build/dstudio-server-test');
  try {
    const { errors, summary } = await validateCorpus(path.resolve(process.argv[2] || DEFAULT_CORPUS), { reader });
    console.log(JSON.stringify(summary, null, 2));
    for (const e of errors) console.log(`REFUSED ${e.code} ${e.where}: ${e.message}`);
    console.log(errors.length ? `vision corpus: ${errors.length} problem(s)` : 'vision corpus: valid');
    process.exitCode = errors.length ? 1 : 0;
  } finally { await reader.stop(); }
}
