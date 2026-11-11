// Generator of the public vision corpus frozen in tests/fixtures/vision_corpus.
//
//   node tests/support/vision_corpus_build.mjs OUTPUT_DIR
//
// OUTPUT_DIR must be absent or empty: the committed corpus is never rewritten
// in place. Content is fixed (tests/support/vision_corpus_content.mjs): no
// randomness and no clock value reaches a page, an image or the manifest. PDF
// and PNG bytes still depend on the Chromium build and the installed fonts,
// so the committed files and their manifest hashes are the authority, not a
// rerun of this script.
//
// How each kind of content is made (headless Chromium through Playwright):
// - native pages: page.pdf(); their text is a real text layer;
// - scanned pages: the page is rasterised to a JPEG and that image is the only
//   content of the PDF page, so the page has no text layer;
// - pixel-only facts on native pages and all images: SVG/HTML rasterised to
//   PNG and embedded as a picture, never as text;
// - /Rotate: an incremental PDF update that reissues the page object.
// Fonts embedded in PDFs are the OFL fonts already versioned with the bundled
// OpenCode snapshot: Inter (a variable font, which Chromium embeds as Type 3
// glyphs) and JetBrains Mono (embedded as TrueType; `font: 'mono'` items use
// it for the whole document). macOS system fonts are used only inside rasters
// (handwriting-style and stylised images).
//
// Turned text on a native page must be set in the mono font: Poppler 26.07
// returned CSS-rotated Inter (Type 3) text with its characters reversed, and
// returned the same sentence in JetBrains Mono correctly. A whole page turned
// through /Rotate reads correctly in either font.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { corpusItems, SYSTEM_FONTS } from './vision_corpus_content.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const fontFile = (rel) => fs.readFileSync(path.join(repo, 'src/harness/opencode/packages', rel)).toString('base64');
const FONT_CSS = `
@font-face{font-family:"Corpus Sans";src:url(data:font/ttf;base64,${fontFile('ui/src/assets/fonts/Inter.ttf')});font-weight:100 900}
@font-face{font-family:"Corpus Mono";font-weight:400;src:url(data:font/woff2;base64,${fontFile('console/mail/emails/templates/static/JetBrainsMono-Regular.woff2')})}
@font-face{font-family:"Corpus Mono";font-weight:500 700;src:url(data:font/woff2;base64,${fontFile('console/mail/emails/templates/static/JetBrainsMono-Medium.woff2')})}`;

// CSS pixels at 96 dpi.
const SIZES = { A4: { css: '210mm 297mm', w: 794, h: 1123, wu: '210mm', hu: '297mm' },
  Letter: { css: '8.5in 11in', w: 816, h: 1056, wu: '8.5in', hu: '11in' } };

const BASE_CSS = `${FONT_CSS}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:"Corpus Sans",sans-serif;font-size:11pt;line-height:1.45;color:#111;font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0}
.mono{font-family:"Corpus Mono",monospace;font-variant-ligatures:none}
h1{font-size:18pt;line-height:1.2;margin:0 0 4mm}
h2{font-size:13pt;margin:6mm 0 2mm}
p{margin:0 0 3mm}
table{border-collapse:collapse;width:100%;margin:3mm 0}
th,td{border:.6pt solid #444;padding:1.6mm 2.4mm;text-align:left;vertical-align:middle}
th{background:#e8e8e8;font-weight:600}
.n{text-align:right}
.org{font-size:9.5pt;color:#444;margin-bottom:6mm;border-bottom:.6pt solid #888;padding-bottom:2mm}
.foot{position:absolute;left:20mm;right:20mm;bottom:11mm;font-size:9pt;color:#333;text-align:center}
figure{margin:5mm 0}
figure img{display:block;width:100%}
figcaption{font-size:9pt;color:#333;margin-top:1.5mm}
svg text{font-family:"Corpus Sans",sans-serif}`;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// File names say nothing about the content: an item id such as
// "p24-scan-upside-down" is for maintainers, its file is pdf/p24.pdf.
const fileStem = (item) => item.id.split('-')[0];

// Chromium stamps the PDF with the clock; a fixed value of the same length
// leaves every offset intact.
function fixDates(pdf) {
  return Buffer.from(pdf.toString('latin1').replace(/\(D:\d{14}([+\-Z])[^)]*\)/g, (whole) => {
    const fixed = "(D:20260101000000+00'00')";
    if (whole.length !== fixed.length) throw new Error(`unexpected PDF date ${whole}`);
    return fixed;
  }), 'latin1');
}

// /Rotate through an incremental update: a newer copy of each page object is
// appended with its own cross-reference section. `rotations` maps a physical
// page (1-based) to 90, 180 or 270.
function rotatePages(pdf, rotations) {
  const text = pdf.toString('latin1');
  const kids = text.match(/\/Type \/Pages\s*\/Count (\d+)\s*\/Kids \[([^\]]*)\]/);
  const size = text.match(/trailer\s*<<\/Size (\d+)/);
  const root = text.match(/\/Root (\d+ 0 R)/), info = text.match(/\/Info (\d+ 0 R)/);
  const prev = text.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  if (!kids || !size || !root || !info || !prev) throw new Error('unexpected PDF structure from Chromium; /Rotate was not applied');
  const ids = [...kids[2].matchAll(/(\d+) 0 R/g)].map((m) => +m[1]);
  if (ids.length !== +kids[1]) throw new Error('nested page tree; /Rotate was not applied');
  let add = '';
  const entries = [];
  for (const [index, angle] of Object.entries(rotations)) {
    const id = ids[index - 1];
    const object = text.match(new RegExp(`\\n${id} 0 obj\\n(<<\\/Type \\/Page\\n[\\s\\S]*?>>)\\nendobj`));
    if (!object || !/\/Parent /.test(object[1]) || /\/Rotate/.test(object[1])) throw new Error(`page ${index}: unexpected page object`);
    entries.push([id, pdf.length + Buffer.byteLength(add, 'latin1')]);
    add += `${id} 0 obj\n${object[1].replace(/\/Parent /, `/Rotate ${angle}\n/Parent `)}\nendobj\n`;
  }
  const xref = pdf.length + Buffer.byteLength(add, 'latin1');
  add += `xref\n${entries.sort((a, b) => a[0] - b[0]).map(([id, at]) => `${id} 1\n${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  add += `trailer\n<</Size ${size[1]}\n/Root ${root[1]}\n/Info ${info[1]}\n/Prev ${prev[1]}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from(add, 'latin1')]);
}

// Keep the picture, drop every ancillary chunk (no text, time or colour tags).
function plainPng(png) {
  const keep = [png.subarray(0, 8)];
  let width = 0, height = 0;
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IHDR') { width = png.readUInt32BE(at + 8); height = png.readUInt32BE(at + 12); }
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) keep.push(png.subarray(at, at + 12 + length));
    at += 12 + length;
  }
  return { bytes: Buffer.concat(keep), width, height };
}

const out = process.argv[2] && path.resolve(process.argv[2]);
if (!out) { console.error('usage: node tests/support/vision_corpus_build.mjs OUTPUT_DIR'); process.exit(2); }
if (fs.existsSync(out) && fs.readdirSync(out).length) { console.error(`${out} is not empty; the generator never rewrites a corpus in place`); process.exit(2); }
fs.mkdirSync(path.join(out, 'pdf'), { recursive: true });
fs.mkdirSync(path.join(out, 'images'), { recursive: true });

const browser = await chromium.launch();
const pages = new Map();
async function pageAt(scale) {
  if (!pages.has(scale)) pages.set(scale, await (await browser.newContext({ deviceScaleFactor: scale })).newPage());
  return pages.get(scale);
}
async function settle(page) {
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((face) => face.load()));
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode()));
  });
}
// HTML -> picture. `background` is the canvas colour around the content.
async function raster(html, { width, height, scale = 1, type = 'png', quality, background = '#fff' }) {
  const page = await pageAt(scale);
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${BASE_CSS}html,body{width:${width}px;height:${height}px;overflow:hidden;background:${background}}</style>${html}`, { waitUntil: 'load' });
  await settle(page);
  return await page.screenshot({ type, ...(type === 'jpeg' ? { quality } : {}), clip: { x: 0, y: 0, width, height } });
}

{ // No silent fallback: a stylised image drawn in a default font is a different image.
  const page = await pageAt(1);
  await page.setContent('<!doctype html><p>fonts</p>');
  const missing = await page.evaluate((names) => {
    const c = document.createElement('canvas').getContext('2d');
    const width = (family) => { c.font = `40px ${family}`; return c.measureText('mmmmmmmmlli 0123456789 WQgy').width; };
    return names.filter((name) => width(`"${name}", monospace`) === width('monospace') && width(`"${name}", serif`) === width('serif'));
  }, SYSTEM_FONTS);
  if (missing.length) { await browser.close(); console.error(`missing system fonts: ${missing.join(', ')}`); process.exit(1); }
}

// A turned box: content laid out for `w` x `h`, shown rotated clockwise.
function turned(html, turn, size, padding) {
  const { w, h } = size;
  const box = turn === 90 || turn === 270 ? { w: h, h: w } : { w, h };
  const move = { 0: 'none', 90: `translateX(${w}px) rotate(90deg)`, 180: `translate(${w}px,${h}px) rotate(180deg)`, 270: `translateY(${h}px) rotate(-90deg)` }[turn];
  return `<div style="position:absolute;left:0;top:0;width:${box.w}px;height:${box.h}px;padding:${padding};transform-origin:top left;transform:${move}">${html}</div>`;
}

const helpers = {
  // A picture for a native page: the returned <img> holds pixels only.
  async figure(html, width, height, { scale = 2, style = 'width:100%', background = '#fff' } = {}) {
    const { bytes } = plainPng(await raster(html, { width, height, scale, background }));
    return `<img alt="" src="data:image/png;base64,${bytes.toString('base64')}" style="display:block;${style}">`;
  },
};

async function buildPdf(item) {
  const size = SIZES[item.size || 'A4'];
  const defs = await item.pages(helpers);
  const sheets = [];
  const rotations = {};
  for (const [index, def] of defs.entries()) {
    const turn = def.turn || 0;
    if (def.rotate) rotations[index + 1] = def.rotate;
    if (def.scan !== undefined) {
      // The scan look: tinted paper, a slight tilt, a shadow at the binding
      // edge and a few specks; then lossy compression, as a scanner would.
      const look = { tint: '#f4f1e8', tilt: 0.5, gray: false, quality: 80, scale: 2, padding: '20mm 19mm', ...def.look };
      const specks = [[4, 17, 2], [71, 6, 1.5], [88, 47, 2.5], [23, 81, 1.5], [55, 93, 2], [94, 88, 1.5]]
        .map(([x, y, r]) => `<i style="position:absolute;left:${x}%;top:${y}%;width:${r * 2}px;height:${r * 2}px;border-radius:50%;background:rgba(40,40,40,.35)"></i>`).join('');
      const paper = `<div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.13),rgba(0,0,0,0) 3.5%),${look.tint};${look.gray ? 'filter:grayscale(1) contrast(1.15);' : ''}">`
        + `<div style="position:absolute;inset:0;transform:rotate(${look.tilt}deg)">${turned(def.scan, turn, size, look.padding)}</div>${specks}</div>`;
      const jpeg = await raster(paper, { width: size.w, height: size.h, scale: look.scale, type: 'jpeg', quality: look.quality, background: look.tint });
      sheets.push(`<div class="page full"><img alt="" src="data:image/jpeg;base64,${jpeg.toString('base64')}"></div>`);
    } else {
      sheets.push(`<div class="page${item.font === 'mono' ? ' mono' : ''}">${turn ? turned(def.body, turn, size, '18mm 20mm') : def.body}</div>`);
    }
  }
  const page = await pageAt(1);
  await page.setViewportSize({ width: size.w, height: size.h });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${BASE_CSS}
@page{size:${size.css};margin:0}
.page{position:relative;overflow:hidden;width:${size.wu};height:${size.hu};padding:20mm 20mm 22mm;break-after:page}
.page:last-child{break-after:auto}
.page.full{padding:0}
.page.full img{display:block;width:100%;height:100%}</style>${sheets.join('\n')}`, { waitUntil: 'load' });
  await settle(page);
  let pdf = fixDates(await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: false, outline: false }));
  if (Object.keys(rotations).length) pdf = rotatePages(pdf, rotations);
  const entry = { id: item.id, kind: 'pdf', language: item.language, files: [{ path: `pdf/${fileStem(item)}.pdf`, bytes: pdf.length, sha256: sha256(pdf) }], pages: defs.length };
  fs.writeFileSync(path.join(out, entry.files[0].path), pdf);
  const scanned = defs.map((def, i) => (def.scan !== undefined ? i + 1 : 0)).filter(Boolean);
  if (scanned.length) entry.scannedPages = scanned;
  if (defs.some((def) => def.label !== undefined)) entry.pageLabels = defs.map((def) => (def.label === undefined ? null : def.label));
  if (defs.some((def) => def.rotate)) entry.pageRotations = defs.map((def) => def.rotate || 0);
  // As displayed by a viewer that honours /Rotate; `appears` covers a page
  // that is upright but carries turned text.
  const shown = defs.map((def) => (def.appears !== undefined ? def.appears : ((def.turn || 0) + (def.rotate || 0)) % 360));
  if (shown.some(Boolean)) entry.contentRotations = shown;
  if (item.smallestTextPt) entry.smallestTextPt = item.smallestTextPt;
  const base = scanned.length === defs.length ? 'scanned' : scanned.length ? 'mixed' : 'native-text';
  entry.categories = [base, ...(defs.length >= 5 ? ['multipage'] : []), ...item.categories];
  return entry;
}

async function buildImages(item) {
  const list = item.kind === 'image-set' ? item.images : [item];
  const files = [];
  for (const [index, image] of list.entries()) {
    const name = item.kind === 'image-set' ? `${fileStem(item)}-${'abcd'[index]}` : fileStem(item);
    const { bytes, width, height } = plainPng(await raster(image.html, { width: image.width, height: image.height, scale: image.scale || 1, background: image.background || '#fff' }));
    fs.writeFileSync(path.join(out, 'images', `${name}.png`), bytes);
    files.push({ path: `images/${name}.png`, bytes: bytes.length, sha256: sha256(bytes), width, height });
  }
  const entry = { id: item.id, kind: item.kind, language: item.language, files, categories: [...item.categories, ...(item.kind === 'image-set' ? ['image-order'] : [])] };
  if (item.rotation) entry.rotation = item.rotation;
  if (item.smallestTextPx) entry.smallestTextPx = item.smallestTextPx;
  return entry;
}

const manifest = {
  schema: 'dstudio.vision-corpus.v1',
  description: 'Synthetic, fictional PDFs and images with questions whose expected answers follow from the generator data. No model has produced or checked any of it.',
  generator: { script: 'tests/support/vision_corpus_build.mjs', browser: `Chromium ${browser.version()}` },
  items: [],
};
const ids = new Set();
for (const item of corpusItems()) {
  if (ids.has(item.id)) throw new Error(`duplicate item ${item.id}`);
  ids.add(item.id);
  const entry = item.kind === 'pdf' ? await buildPdf(item) : await buildImages(item);
  entry.questions = item.questions.map((question, index) => ({ id: `${item.id}-q${index + 1}`, ...question }));
  const facts = entry.questions.flatMap((q) => [q.evidence, ...(q.evidence.also || [])]);
  if (facts.some((fact) => fact.pixelOnly)) entry.categories.push('pixel-only');
  if (entry.questions.some((q) => q.expected.type === 'unanswerable')) entry.categories.push('unanswerable');
  manifest.items.push(entry);
  console.log(`${entry.id}: ${entry.files.map((file) => `${file.path} ${file.bytes} B`).join(', ')}`);
}
await browser.close();
fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const total = manifest.items.reduce((sum, item) => sum + item.files.reduce((s, file) => s + file.bytes, 0), 0);
console.log(`${manifest.items.length} items, ${total} bytes of PDFs and images, written to ${out}`);
