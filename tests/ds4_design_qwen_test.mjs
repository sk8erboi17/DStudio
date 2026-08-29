import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const designBin = path.join(root, 'ds4', 'ds4-design');
assert.equal(fs.existsSync(designBin), true, 'ds4-design must be built before this test');
const designSource = fs.readFileSync(path.join(root, 'extension/design/ds4_design.c'), 'utf8');
assert.match(designSource, /Do not score standalone aesthetic quality/,
  'see_image must be scoped to request correspondence, not isolated aesthetic grading');
assert.match(designSource, /successful see_image decode is an informational, non-blocking correspondence observation[\s\S]*do not create a pre-layout generate\/inspect retry loop/i,
  'a correspondence mismatch must not restart heavyweight media before composition');
assert.match(designSource, /Pipeline policy:[\s\S]*Do not[\s\S]*call generate_image again solely because of this report[\s\S]*composed page/i,
  'successful see_image results must carry the non-blocking pipeline policy back to DS4');
assert.match(designSource, /judge imagery, crop, hierarchy[\s\S]*rendered desktop\/mobile layout/,
  'the aesthetic gate must run on the composed page');
assert.match(designSource, /do not extract or inspect MiniMax H3[\s\S]*user explicitly requests/,
  'generated H3 frames must not trigger an unsolicited Qwen gate');
assert.match(designSource, /Place the MP4 in the composed page[\s\S]*judge its integration through see_page/,
  'generated video quality belongs to the composed layout gate');
assert.match(designSource, /Section count follows the content[\s\S]*never pad a design to a fixed count/,
  'the core must not force every site into the same section count');
assert.match(designSource, /three above the fold are the default coherence budget, not an absolute cap[\s\S]*Never flatten distinct requested typographic roles merely to satisfy a count/,
  'the core typography budget must yield to explicit creative direction');
assert.match(designSource, /A synchronous local form instead needs empty\/initial[\s\S]*Never invent a[\s\S]*setTimeout, spinner, skeleton or aria-busy interval/,
  'the core must not induce fake loading latency in local synchronous forms');
assert.doesNotMatch(designSource, /reject\/regenerate visible defects before placing it/,
  'the old isolated-image rejection loop must not return');
assert.match(designSource, /#define DESIGN_DEFAULT_THINK_TOKENS 0/,
  'Design must default to unlimited reasoning');
assert.match(designSource, /design_special_token_id\(a->engine, "<\/think>"\)[\s\S]*force_think_close/,
  'the reasoning cap must close thinking and preserve room for the tool call');
assert.match(designSource, /emit_reasoning_cap_event/,
  'forced reasoning closure must be observable in the run transcript');
assert.match(designSource, /--password-store=basic[\s\S]*--use-mock-keychain/,
  'headless Chrome renders must not prompt for the macOS login keychain');
assert.match(designSource, /selector contact sheets[\s\S]*independent page sections/i,
  'below-fold screenshots must be selector-driven independent panels');
assert.match(designSource, /CREATIVE RANGE[\s\S]*change the font families/i,
  'DS4 must explicitly permit typographic and structural creative range');
assert.match(designSource, /font family explicitly chosen by the user is a hard design constraint[\s\S]*Design-system typography is always subordinate/i,
  'an explicit user font choice must override generated or design-system typography');
assert.match(designSource, /DECISION DISCIPLINE[\s\S]*Once the next action is supported, execute it[\s\S]*direct inspection tool/i,
  'DS4 reasoning guidance must remain evidence-led without lexical loop detection');
assert.doesNotMatch(designSource, /design_reasoning_loop|reasoning_loop_break|reopeningsAfterCommitment|" maybe ".*" perhaps "/s,
  'production must not classify hidden reasoning through benchmark-shaped phrase lists');
assert.match(designSource, /GRADE\|VIEWPORT\|CRITERION\|PASS_OR_FAIL[\s\S]*FINDING\|DESKTOP_OR_MOBILE_OR_BOTH\|CRITERION\|FAIL/,
  'the visual grader must use a structured decision protocol');
assert.doesNotMatch(designSource, /partially cut off[\s\S]*staggered[\s\S]*narrow rail/,
  'production must not infer visual verdicts from a hand-authored English defect vocabulary');
assert.match(designSource, /layout_evidence_required[\s\S]*design_layout_evidence_blocks_tool[\s\S]*Call inspect_layout/i,
  'rendered geometric failures must enforce deterministic DOM evidence through tool state');
assert.match(designSource, /name\\\":\\\"inspect_layout/,
  'the deterministic inspect_layout tool must be advertised');
assert.match(designSource, /name\\\":\\\"generate_video/,
  'the MiniMax H3 quality tool must be advertised');
assert.match(designSource, /todo_write is required before[\s\S]*todo_prerequisite_blocked/,
  'mutation, media and sign-off must be blocked until the current run authors a todo card');
assert.match(designSource, /incomplete_todo_continue[\s\S]*incomplete_todo_terminal/,
  'an unfinished work card must prevent a false successful terminal response');
assert.match(designSource, /incomplete_todo_progress_reset[\s\S]*design_note_concrete_tool_progress/,
  'the unfinished-terminal budget must reset after concrete tool progress');
assert.match(designSource, /design_html_tag_is_void[\s\S]*hidden HTML void elements do not conceal later visible exact copy/,
  'a hidden img/input must not make all following exact copy appear hidden');
assert.match(designSource, /HunyuanImage edit is byte-identical to its source; no fallback asset was written/,
  'image editing must fail closed instead of silently accepting a source-image fallback');
assert.match(designSource, /design_tool_generate_video[\s\S]*design_media_response_error\(response\)[\s\S]*json_object_string_field_alloc\(response, "id"/,
  'MiniMax H3 failures must surface the server error before parsing success identifiers');
assert.match(designSource, /surface that genuinely loads remote or delayed data[\s\S]*explicit data-state values[\s\S]*Visible prose alone does not prove/i,
  'DS4 must author machine-verifiable states for genuine loading surfaces before the artifact gate');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-design-qwen-test-'));
const workspace = path.join(tmp, 'workspace');
const home = path.join(tmp, 'home');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(home, { recursive: true });
const fixturePngB64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
fs.writeFileSync(path.join(workspace, 'viewport-probe.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;min-height:100%;background:rgb(20,40,180)}
@media(max-width:400px){html,body{background:rgb(20,210,90)}}
.top,.middle,.lower{height:1600px}.middle{background:rgb(190,40,20)}
.lower{background:rgb(210,180,20)}</style></head>
<body><header class="top" aria-label="viewport probe">viewport probe</header>
<section class="middle">middle page</section><section class="lower">lower page</section></body></html>`);
fs.writeFileSync(path.join(workspace, 'overlap-probe.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;min-height:100%;background:rgb(20,40,180)}
@media(max-width:400px){html,body{background:rgb(20,210,90)}}
main{position:relative}.node{position:absolute;inset:32px auto auto 32px;width:160px;height:52px}</style></head>
<body><main aria-label="overlap probe"><button class="node">First control</button>
<button class="node">Second control</button></main></body></html>`);
fs.writeFileSync(path.join(workspace, 'sparse-probe.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;min-height:100%;background:rgb(20,40,180)}
@media(max-width:400px){html,body{background:rgb(20,210,90)}}
.activity{height:900px;width:min(300px,100%);box-sizing:border-box;border:1px solid currentColor;padding:16px}</style></head>
<body><main><aside class="activity"><h1>Activity</h1><p>One compact event in an excessively stretched rail.</p></aside></main></body></html>`);
fs.writeFileSync(path.join(workspace, 'responsive-media-clean.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{margin:0;padding:24px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
.card{border:1px solid #222}.card img{display:block;width:100%;height:auto}.card h2{padding:12px;margin:0}
@media(max-width:600px){.cards{grid-template-columns:1fr}}</style></head><body><main><section class="cards">
${[1, 2, 3].map((n) => `<article class="card"><img width="100" height="100" src="data:image/png;base64,${fixturePngB64}" alt="Square probe ${n}"><h2>Item ${n}</h2></article>`).join('')}
</section></main></body></html>`);
fs.writeFileSync(path.join(workspace, 'responsive-media-broken.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{margin:0;padding:24px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
.card{border:1px solid #222}.card img{display:block;width:100%;height:180px}.card:nth-child(2) img{height:320px}.card h2{padding:12px;margin:0}
@media(max-width:600px){.cards{grid-template-columns:1fr}}</style></head><body><main><section class="cards">
${[1, 2, 3].map((n) => `<article class="card"><img width="100" height="100" src="data:image/png;base64,${fixturePngB64}" alt="Distorted probe ${n}"><h2>Item ${n}</h2></article>`).join('')}
</section></main></body></html>`);
fs.writeFileSync(path.join(workspace, 'responsive-video-broken.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{margin:0;padding:24px}.stage{position:relative;border:1px solid #222}
.stage video{display:block;width:100%;height:768px;object-fit:cover}
.stage img{display:block;width:100%;height:calc((100vw - 48px)*.5625);object-fit:cover}
.deterministic-overflow-culprit{width:409px;height:24px;white-space:nowrap}</style></head>
<body><main><section class="stage"><video width="1344" height="768" muted playsinline></video>
<img width="1344" height="768" src="data:image/png;base64,${fixturePngB64}" alt="Static fallback"></section></main>
<div class="deterministic-overflow-culprit">deterministic overflow offender</div></body></html>`);

const chrome = [
  process.env.DS4_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((candidate) => candidate && fs.existsSync(candidate));

function decodePng(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      assert.equal(data[12], 0, 'interlaced Chrome screenshots are not expected');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += length + 12;
  }
  assert.equal(bitDepth, 8);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  assert.ok(channels, `unsupported PNG color type ${colorType}`);
  const compressed = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  let source = 0;
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let line = 0; line < height; line++) {
    const filter = compressed[source++];
    row = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const raw = compressed[source++];
      const left = i >= channels ? row[i - channels] : 0;
      const up = previous[i];
      const upperLeft = i >= channels ? previous[i - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up :
        filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : NaN;
      assert.ok(Number.isFinite(predictor), `unsupported PNG filter ${filter}`);
      row[i] = (raw + predictor) & 255;
    }
    row.copy(pixels, line * stride);
    previous = row;
  }
  return {
    width,
    height,
    pixel(x, y) {
      assert.ok(x >= 0 && x < width && y >= 0 && y < height);
      const offset = y * stride + x * channels;
      return [...pixels.subarray(offset, offset + channels)];
    },
    find(predicate, step = 4) {
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const offset = y * stride + x * channels;
          const rgba = [...pixels.subarray(offset, offset + channels)];
          if (predicate(rgba)) return { x, y, rgba };
        }
      }
      return null;
    },
  };
}

function pngPixel(bytes, x, y) {
  const image = decodePng(bytes);
  return { width: image.width, height: image.height, rgba: image.pixel(x, y) };
}

/* Valid 1x1 PNG with binary NUL bytes: exact comparison catches accidental
 * strlen()-based truncation in the C HTTP bridge. */
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const header = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  checksum.writeUInt32BE(pngCrc32(body));
  return Buffer.concat([header, body, checksum]);
}

function onePixelRgbPng(red, green, blue) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, red, green, blue]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const editedPng = onePixelRgbPng(205, 34, 38);
assert.equal(editedPng.equals(png), false,
  'the Hunyuan integration fixture must contain edited pixels');
const h3Source = fs.readFileSync(path.join(root, 'scripts/h3-run.py'), 'utf8');
const h3Block = h3Source.match(/TEST_MP4_B64\s*=\s*\(([\s\S]*?)\n\)/)?.[1] || '';
const mp4 = Buffer.from([...h3Block.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join(''), 'base64');
assert.ok(mp4.length > 12 && mp4.subarray(4, 8).equals(Buffer.from('ftyp')),
  'the H3 protocol fixture must be a valid ISO-BMFF file');
const httpCalls = [];
let rawVisionCalls = 0;
let imagePipelineCalls = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/image/generate') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      httpCalls.push({ method: req.method, url: req.url, body, headers: req.headers });
      assert.equal(req.headers['x-requested-with'], 'ds4web');
      imagePipelineCalls++;
      if (imagePipelineCalls === 1) {
        assert.equal(body.action, 'generate');
        assert.equal(body.reasoning_effort, 'max');
        assert.match(body.prompt, /editorial observatory/i);
        assert.equal('image' in body, false, 'Ideogram generation must not carry a source image');
      } else {
        assert.equal(imagePipelineCalls, 2);
        assert.equal(body.action, 'edit');
        assert.equal(body.reasoning_effort, 'max');
        assert.equal(body.aspect, '16:9');
        assert.equal(body.preserve, 'none');
        assert.match(body.prompt, /remove the synthetic bloom/i);
        assert.equal(body.image, `data:image/png;base64,${png.toString('base64')}`,
          'Hunyuan editing must receive the exact generated pixels');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      /* The decoy string verifies that the runtime parses object members and
       * does not grab a quoted field-like fragment with strstr(). */
      res.end(JSON.stringify({
        ok: true,
        message: 'decoy: "id":"outside-project"',
        id: imagePipelineCalls === 1 ? 'image-job_1' : 'image-job_2',
        filename: imagePipelineCalls === 1 ? 'generated-test.png' : 'edited-test.png',
      }));
    });
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/api/image/file') {
    httpCalls.push({ method: req.method, url: req.url, headers: req.headers });
    const id = url.searchParams.get('id');
    const name = url.searchParams.get('name');
    assert.ok((id === 'image-job_1' && name === 'generated-test.png') ||
      (id === 'image-job_2' && name === 'edited-test.png'));
    assert.equal(req.headers['x-requested-with'], 'ds4web');
    const responsePng = id === 'image-job_2' ? editedPng : png;
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': responsePng.length });
    res.end(responsePng);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/video/generate') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      httpCalls.push({ method: req.method, url: req.url, body, headers: req.headers });
      assert.equal(req.headers['x-requested-with'], 'ds4web');
      assert.equal(body.profile, 'quality');
      assert.equal(body.encoder, 'official');
      assert.equal(body.licenseAccepted, true);
      assert.equal(body.duration, 5);
      assert.equal(body.aspect, '16:9');
      assert.match(body.prompt, /slow dolly/i);
      assert.equal(body.image, `data:image/png;base64,${editedPng.toString('base64')}`,
        'MiniMax H3 must receive the exact edited first frame');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: 'video-job_1', filename: 'generated-test.mp4' }));
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/video/file') {
    httpCalls.push({ method: req.method, url: req.url, headers: req.headers });
    assert.equal(url.searchParams.get('id'), 'video-job_1');
    assert.equal(url.searchParams.get('name'), 'generated-test.mp4');
    assert.equal(req.headers['x-requested-with'], 'ds4web');
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4.length });
    res.end(mp4);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/vision/describe') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      httpCalls.push({ method: req.method, url: req.url, body, headers: req.headers });
      assert.equal(req.headers['x-requested-with'], 'ds4web');
      if (body.path) {
        assert.match(body.path, /assets\/observatory(?:-edited)?\.png$/);
        assert.match(body.question, /corresponds to the user's stated request/i);
        assert.match(body.question, /do not score standalone aesthetic quality/i);
        assert.match(body.question, /brutalist observatory at blue hour/i);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('The visible subject is a blue-hour observatory and corresponds to the requested role.');
        return;
      }
      if (body.frame !== 'raw') {
        assert.equal(body.paths.length, 2);
        assert.ok(body.paths.every((item) => /assets\/observatory\.png$/.test(item)));
        assert.match(body.question, /numbered correspondence result per image/i);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('1. The observatory corresponds to the first requested role.\n' +
          '2. The observatory corresponds to the second requested role.');
        return;
      }
      assert.equal(body.paths.length, 4);
      assert.match(body.question, /selector contact sheets/i,
        'the visual gate must identify selector-driven contact sheets');
      assert.match(body.question, /never infer an overlap[\s\S]*across two different contact-sheet panels/i,
        'the visual gate must forbid cross-panel geometry inferences');
      assert.match(body.question, /repeated sibling cards\/media should have a coherent top, bottom, and image-height rhythm/i,
        'the composed-page gate must inspect repeated media alignment');
      assert.match(body.question, /large unexplained empty side of a section/i,
        'the composed-page gate must inspect desktop whitespace balance');
      rawVisionCalls++;
      const desktop = pngPixel(fs.readFileSync(body.paths[0]), 640, 800);
      const mobile = pngPixel(fs.readFileSync(body.paths[1]), 195, 800);
      const desktopSections = pngPixel(fs.readFileSync(body.paths[2]), 640, 500);
      const mobileSections = pngPixel(fs.readFileSync(body.paths[3]), 195, 500);
      assert.deepEqual([desktop.width, desktop.height], [1280, 1600]);
      assert.deepEqual([mobile.width, mobile.height], [390, 1600]);
      assert.deepEqual([desktopSections.width, desktopSections.height], [1280, 3600]);
      assert.deepEqual([mobileSections.width, mobileSections.height], [390, 3600]);
      assert.ok(desktop.rgba[2] > 150 && desktop.rgba[1] < 80,
        `desktop media query pixel was unexpected: ${desktop.rgba}`);
      assert.ok(mobile.rgba[1] > 160 && mobile.rgba[2] < 130,
        `mobile render did not use an exact <=400px viewport: ${mobile.rgba}`);
      if (rawVisionCalls === 1 || rawVisionCalls === 4) {
        const desktopSectionPixels = [
          pngPixel(fs.readFileSync(body.paths[2]), 320, 400).rgba,
          pngPixel(fs.readFileSync(body.paths[2]), 950, 400).rgba,
          pngPixel(fs.readFileSync(body.paths[2]), 320, 1200).rgba,
        ];
        assert.ok(desktopSectionPixels[0][2] > 140 && desktopSectionPixels[0][0] < 80,
          `desktop selector panel 1 did not isolate the blue hero section: ${desktopSectionPixels[0]}`);
        assert.ok(desktopSectionPixels[1][0] > 140 && desktopSectionPixels[1][1] < 100,
          `desktop selector panel 2 did not isolate the red middle section: ${desktopSectionPixels[1]}`);
        assert.ok(desktopSectionPixels[2][0] > 150 && desktopSectionPixels[2][1] > 120,
          `desktop selector panel 3 did not isolate the yellow lower section: ${desktopSectionPixels[2]}`);
        const mobileSectionPixels = [
          pngPixel(fs.readFileSync(body.paths[3]), 195, 600).rgba,
          pngPixel(fs.readFileSync(body.paths[3]), 195, 1800).rgba,
          pngPixel(fs.readFileSync(body.paths[3]), 195, 3000).rgba,
        ];
        assert.ok(mobileSectionPixels[0][1] > 150 && mobileSectionPixels[0][2] < 130,
          `mobile selector panel 1 did not isolate the green responsive hero: ${mobileSectionPixels[0]}`);
        assert.ok(mobileSectionPixels[1][0] > 140 && mobileSectionPixels[1][1] < 100,
          `mobile selector panel 2 did not isolate the red middle section: ${mobileSectionPixels[1]}`);
        assert.ok(mobileSectionPixels[2][0] > 150 && mobileSectionPixels[2][1] > 120,
          `mobile selector panel 3 did not isolate the yellow lower section: ${mobileSectionPixels[2]}`);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const grades = [
        'GRADE|DESKTOP|CONTRAST|PASS|Readable.',
        'GRADE|DESKTOP|OVERLAP|PASS|Clear.',
        'GRADE|DESKTOP|CLIPPING|PASS|Visible.',
        'GRADE|DESKTOP|OVERFLOW|PASS|Contained.',
        'GRADE|DESKTOP|COMPLETENESS|PASS|Complete.',
        'GRADE|MOBILE|CONTRAST|PASS|Readable.',
        'GRADE|MOBILE|OVERLAP|PASS|Clear.',
        'GRADE|MOBILE|CLIPPING|PASS|Visible.',
        'GRADE|MOBILE|OVERFLOW|PASS|Contained.',
        'GRADE|MOBILE|COMPLETENESS|PASS|Complete.',
      ].join('\n');
      res.end(rawVisionCalls === 4
        ? `${grades}\nFINDING|DESKTOP|COMPLETENESS|FAIL|Image-frame bottoms differ by approximately 370 px.`
        : grades);
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

let child;
let stdout = '';
let stderr = '';
const events = [];
const requests = [];
let lineBuf = '';
let finished = false;
let timeoutReason = '';
let inactivityTimeout;
let killEscalation;
// The Chrome branch performs 34 bounded renders (six three-viewport layout
// probes and four four-view visual checks). Guard a stalled operation instead
// of killing a healthy sequence merely because its cumulative work exceeds a
// short wall-clock deadline; retain a separate ceiling for endless output.
const inactivityBudgetMs = chrome ? 150_000 : 30_000;
const hardTimeoutMs = chrome ? 15 * 60_000 : 60_000;
function terminateForTimeout(reason) {
  timeoutReason = reason;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  clearTimeout(killEscalation);
  killEscalation = setTimeout(() => {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }, 3_000);
  killEscalation.unref?.();
}
function armInactivityTimeout() {
  clearTimeout(inactivityTimeout);
  inactivityTimeout = setTimeout(() => {
    terminateForTimeout(`no ds4-design output for ${inactivityBudgetMs}ms`);
  }, inactivityBudgetMs);
}
armInactivityTimeout();
const hardTimeout = setTimeout(() => {
  terminateForTimeout(`ds4-design exceeded the ${hardTimeoutMs}ms hard deadline`);
}, hardTimeoutMs);

function modelFrames(id, content) {
  return [
    `\x1e${JSON.stringify({ type: 'model_delta', id, kind: 'content', text: content })}\n`,
    `\x1e${JSON.stringify({ type: 'model_done', id })}\n`,
  ].join('');
}

const dsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="todo_write">',
  '<｜DSML｜parameter name="todos" string="true">[{"text":"Exercise the complete integration tool flow","status":"completed"}]</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '<｜DSML｜invoke name="generate_image">',
  '<｜DSML｜parameter name="path" string="true">assets/observatory.png</｜DSML｜parameter>',
  '<｜DSML｜parameter name="prompt" string="true">Editorial observatory at blue hour, precise architectural photography, cobalt and warm ivory palette, wide negative space, no text, no logos, no watermark. Preserve realistic concrete texture, physically plausible glass reflections, a clear dome silhouette, restrained practical lighting, legible depth from foreground rock to distant horizon, documentary optics, and enough clean negative space for an editorial headline without rendering any typography. Avoid fantasy structures, duplicate domes, warped architecture, synthetic bloom, excessive stars, oversaturation, people facing camera, signatures, captions, and interface chrome.</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const seeImageDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="see_image">',
  '<｜DSML｜parameter name="path" string="true">assets/observatory.png</｜DSML｜parameter>',
  '<｜DSML｜parameter name="question" string="true">Does this depict the requested brutalist observatory at blue hour?</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const seeImagesDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="see_image">',
  '<｜DSML｜parameter name="paths" string="true">["assets/observatory.png","assets/observatory.png"]</｜DSML｜parameter>',
  '<｜DSML｜parameter name="question" string="true">Does each image correspond to its requested observatory role?</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const seePageDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="see_page">',
  '<｜DSML｜parameter name="entry" string="true">viewport-probe.html</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const seeOverlapDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="see_page">',
  '<｜DSML｜parameter name="entry" string="true">overlap-probe.html</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const seeSparseDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="see_page">',
  '<｜DSML｜parameter name="entry" string="true">sparse-probe.html</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const inspectOverlapDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="inspect_layout">',
  '<｜DSML｜parameter name="entry" string="true">overlap-probe.html</｜DSML｜parameter>',
  '<｜DSML｜parameter name="selector" string="true">.node</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const inspectSparseDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="inspect_layout">',
  '<｜DSML｜parameter name="entry" string="true">sparse-probe.html</｜DSML｜parameter>',
  '<｜DSML｜parameter name="selector" string="true">.activity</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const seeContradictionDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="see_page">',
  '<｜DSML｜parameter name="entry" string="true">viewport-probe.html</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const blockedEditDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="edit">',
  '<｜DSML｜parameter name="path" string="true">viewport-probe.html</｜DSML｜parameter>',
  '<｜DSML｜parameter name="old_text" string="true">viewport probe</｜DSML｜parameter>',
  '<｜DSML｜parameter name="new_text" string="true">changed before evidence</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const inspectContradictionDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="inspect_layout">',
  '<｜DSML｜parameter name="entry" string="true">viewport-probe.html</｜DSML｜parameter>',
  '<｜DSML｜parameter name="selector" string="true">main</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const inspectResponsiveCleanDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="inspect_layout">',
  '<｜DSML｜parameter name="entry" string="true">responsive-media-clean.html</｜DSML｜parameter>',
  '<｜DSML｜parameter name="selector" string="true">.cards</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const inspectResponsiveBrokenDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="inspect_layout">',
  '<｜DSML｜parameter name="entry" string="true">responsive-media-broken.html</｜DSML｜parameter>',
  '<｜DSML｜parameter name="selector" string="true">.cards</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const inspectResponsiveVideoBrokenDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="inspect_layout">',
  '<｜DSML｜parameter name="entry" string="true">responsive-video-broken.html</｜DSML｜parameter>',
  '<｜DSML｜parameter name="selector" string="true">.stage</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const editImageDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="generate_image">',
  '<｜DSML｜parameter name="path" string="true">assets/observatory-edited.png</｜DSML｜parameter>',
  '<｜DSML｜parameter name="source_path" string="true">assets/observatory.png</｜DSML｜parameter>',
  '<｜DSML｜parameter name="aspect" string="true">16:9</｜DSML｜parameter>',
  '<｜DSML｜parameter name="preserve" string="true">none</｜DSML｜parameter>',
  '<｜DSML｜parameter name="prompt" string="true">Edit the brutalist observatory at blue hour: remove the synthetic bloom while preserving the exact architecture, blue-hour lighting, wide editorial composition and clean text-free sky. Do not add text, logos, people, duplicate structures or fantasy elements.</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const seeEditedImageDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="see_image">',
  '<｜DSML｜parameter name="path" string="true">assets/observatory-edited.png</｜DSML｜parameter>',
  '<｜DSML｜parameter name="question" string="true">Does the edited image still depict the requested brutalist observatory at blue hour without synthetic bloom?</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');
const generateVideoDsml = [
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="generate_video">',
  '<｜DSML｜parameter name="path" string="true">assets/observatory-h3.mp4</｜DSML｜parameter>',
  '<｜DSML｜parameter name="first_frame" string="true">assets/observatory-edited.png</｜DSML｜parameter>',
  '<｜DSML｜parameter name="duration" string="false">5</｜DSML｜parameter>',
  '<｜DSML｜parameter name="aspect" string="true">16:9</｜DSML｜parameter>',
  '<｜DSML｜parameter name="license_accepted" string="false">true</｜DSML｜parameter>',
  '<｜DSML｜parameter name="prompt" string="true">A slow dolly toward the brutalist observatory at blue hour, restrained cloud drift and subtle warm interior light, physically plausible architecture and camera motion, no cuts, no text, no logos, no warping, no added people.</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');

function consumeLine(line) {
  const marker = line.indexOf('\x1e');
  if (marker < 0) return;
  let event;
  try { event = JSON.parse(line.slice(marker + 1)); } catch { return; }
  events.push(event);
  if (event.type !== 'model_request') return;
  requests.push(event);
  if (requests.length === 1) {
    child.stdin.write(modelFrames(event.id, dsml));
  } else if (requests.length === 2) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /Generated a project-local PNG through Qwen3\.8 Max routing/);
    child.stdin.write(modelFrames(event.id, seeImageDsml));
  } else if (requests.length === 3) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /corresponds to the requested role/);
    child.stdin.write(modelFrames(event.id, seeImagesDsml));
  } else if (requests.length === 4) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /1\. The observatory corresponds/);
    assert.match(toolMessage?.content || '', /2\. The observatory corresponds/);
    if (chrome) child.stdin.write(modelFrames(event.id, seePageDsml));
    else {
      child.stdin.write(modelFrames(event.id, editImageDsml));
    }
  } else if (!chrome && requests.length === 5) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /full HunyuanImage-3\.0-Instruct/);
    child.stdin.write(modelFrames(event.id, seeEditedImageDsml));
  } else if (!chrome && requests.length === 6) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /corresponds to the requested role/);
    child.stdin.write(modelFrames(event.id, generateVideoDsml));
  } else if (!chrome && requests.length === 7) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /MiniMax H3 MP4 at quality profile/);
    child.stdin.write(modelFrames(event.id, 'done'));
    finished = true;
  } else if (requests.length === 5) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /desktop 1280px \+ mobile 390px top renders and isolated selector-section contact sheets/i,
      `see_page selector render failed; child stderr:\n${stderr.slice(-4000)}`);
    assert.match(toolMessage?.content || '', /GRADE\|MOBILE\|OVERFLOW\|PASS\|/);
    assert.match(toolMessage?.content || '', /DS4 DOM MOBILE OVERFLOW: PASS \(scrollWidth=390, clientWidth=390\)/);
    assert.match(toolMessage?.content || '', /DS4 DOM MOBILE INTERACTIVE OVERLAP: PASS \(pairs=0\)/);
    child.stdin.write(modelFrames(event.id, seeOverlapDsml));
  } else if (requests.length === 6) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /DS4 DOM DESKTOP INTERACTIVE OVERLAP: FAIL \(pairs=1\)/);
    assert.match(toolMessage?.content || '', /DS4 DOM MOBILE INTERACTIVE OVERLAP: FAIL \(pairs=1\)/);
    child.stdin.write(modelFrames(event.id, inspectOverlapDsml));
  } else if (requests.length === 7) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /\[inspect_layout: overlap-probe\.html selector="\.node"\]/);
    assert.match(toolMessage?.content || '', /DESKTOP 1280px: client\/scroll=1280\/1280/);
    assert.match(toolMessage?.content || '', /"targets":/);
    assert.match(toolMessage?.content || '', /"computed":\{"display":"[^"]+","position":"absolute","fontFamily":"[^"]+","fontSize":"[^"]+","fontWeight":"[^"]+","lineHeight":"[^"]+","writingMode":"[^"]+","textAlign":"[^"]+"\}/,
      'inspect_layout must expose rendered typography so font regressions are evidence, not a hypothesis');
    child.stdin.write(modelFrames(event.id, seeSparseDsml));
  } else if (requests.length === 8) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /DS4 DOM DESKTOP STRETCHED SPARSE PANEL: FAIL \(count=1, maxTail=\d+px\)/);
    assert.match(toolMessage?.content || '', /DS4 DOM MOBILE STRETCHED SPARSE PANEL: FAIL \(count=1, maxTail=\d+px\)/);
    child.stdin.write(modelFrames(event.id, inspectSparseDsml));
  } else if (requests.length === 9) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /\[inspect_layout: sparse-probe\.html selector="\.activity"\]/);
    child.stdin.write(modelFrames(event.id, seeContradictionDsml));
  } else if (requests.length === 10) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /DS4 VERDICT CONSISTENCY: FAIL/);
    assert.match(toolMessage?.content || '', /FINDING\|DESKTOP\|COMPLETENESS\|FAIL\|Image-frame bottoms differ by approximately 370 px/i);
    child.stdin.write(modelFrames(event.id, blockedEditDsml));
  } else if (requests.length === 11) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /layout evidence is required[\s\S]*call inspect_layout/i,
      'a contradictory geometric verdict must block edits until measured');
    child.stdin.write(modelFrames(event.id, inspectContradictionDsml));
  } else if (requests.length === 12) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /\[inspect_layout: viewport-probe\.html selector="main"\]/);
    child.stdin.write(modelFrames(event.id, inspectResponsiveCleanDsml));
  } else if (requests.length === 13) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /\[inspect_layout: responsive-media-clean\.html selector="\.cards"\]/);
    assert.match(toolMessage?.content || '', /DESKTOP 1280px:[^\n]*repeatedMediaGroups=1, misaligned=0, distorted=0/);
    assert.match(toolMessage?.content || '', /MOBILE 390px:[^\n]*repeatedMediaGroups=1, misaligned=0, distorted=0/);
    assert.match(toolMessage?.content || '', /"attrWidth":"100","attrHeight":"100","naturalWidth":1,"naturalHeight":1/,
      'inspect_layout must expose HTML dimensions and decoded intrinsic dimensions');
    const cleanLines = (toolMessage?.content || '').split('\n');
    const cleanDesktop = JSON.parse(cleanLines[cleanLines.findIndex((line) => line.startsWith('DESKTOP 1280px:')) + 1]);
    const cleanMobile = JSON.parse(cleanLines[cleanLines.findIndex((line) => line.startsWith('MOBILE 390px:')) + 1]);
    assert.deepEqual(cleanDesktop.repeatedMediaGroups[0].rows[0].horizontalGaps, [20, 20],
      'inspect_layout must expose exact horizontal gaps for repeated desktop components');
    assert.deepEqual(cleanDesktop.repeatedMediaGroups[0].verticalGaps, [],
      'a single desktop row must not invent vertical gaps');
    assert.equal(cleanDesktop.repeatedMediaGroups[0].computedColumnGap, 20);
    assert.equal(cleanDesktop.repeatedMediaGroups[0].computedRowGap, 20);
    assert.deepEqual(cleanMobile.repeatedMediaGroups[0].verticalGaps, [20, 20],
      'inspect_layout must expose exact vertical gaps after responsive column collapse');
    assert.ok(cleanMobile.repeatedMediaGroups[0].rows.every((row) => row.horizontalGaps.length === 0));
    child.stdin.write(modelFrames(event.id, inspectResponsiveBrokenDsml));
  } else if (requests.length === 14) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /\[inspect_layout: responsive-media-broken\.html selector="\.cards"\]/);
    assert.match(toolMessage?.content || '', /DESKTOP 1280px:[^\n]*repeatedMediaGroups=1, misaligned=1, distorted=3/,
      'desktop responsive distortion and sibling staggering must be deterministic failures');
    assert.match(toolMessage?.content || '', /MOBILE 390px:[^\n]*repeatedMediaGroups=1, misaligned=0, distorted=2/,
      'mobile responsive distortion must remain visible after the single-column collapse');
    child.stdin.write(modelFrames(event.id, inspectResponsiveVideoBrokenDsml));
  } else if (requests.length === 15) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /\[inspect_layout: responsive-video-broken\.html selector="\.stage"\]/);
    assert.match(toolMessage?.content || '', /MOBILE 390px:[^\n]*repeatedMediaGroups=1, misaligned=1, distorted=2/,
      'an unloaded H3 video with an extreme responsive crop and stacked fallback must fail geometry');
    const mobileReport = JSON.parse((toolMessage?.content || '')
      .slice((toolMessage?.content || '').indexOf('MOBILE 390px:')).split('\n')[1]);
    assert.ok(mobileReport.overflowingElements.some((item) =>
      item.tag === 'div' && item.text === 'deterministic overflow offender' &&
      item.viewportEscape === true && item.selector.includes('div:nth-child')),
    'inspect_layout must name the exact overflowing element instead of only reporting page width');
    const videoMedia = mobileReport.repeatedMediaGroups[0].items
      .find((item) => item.media.tag === 'video').media;
    assert.deepEqual(
      Object.fromEntries(Object.entries(videoMedia).filter(([key]) =>
        ['videoWidth', 'videoHeight', 'intrinsicWidth', 'intrinsicHeight', 'intrinsicSource', 'distorted'].includes(key))),
      { videoWidth: 0, videoHeight: 0, intrinsicWidth: 1344, intrinsicHeight: 768,
        intrinsicSource: 'html-attributes', distorted: true },
      'inspect_layout must fall back to declared video dimensions before metadata is decoded');
    child.stdin.write(modelFrames(event.id, editImageDsml));
  } else if (requests.length === 16) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /full HunyuanImage-3\.0-Instruct/);
    child.stdin.write(modelFrames(event.id, seeEditedImageDsml));
  } else if (requests.length === 17) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /corresponds to the requested role/);
    child.stdin.write(modelFrames(event.id, generateVideoDsml));
  } else if (requests.length === 18) {
    const body = JSON.parse(event.body);
    const toolMessage = body.messages.findLast?.((message) => message.role === 'tool') ||
      [...body.messages].reverse().find((message) => message.role === 'tool');
    assert.match(toolMessage?.content || '', /MiniMax H3 MP4 at quality profile/);
    assert.match(toolMessage?.content || '', /\(\d+ bytes, 5 seconds, 16:9\)\.\n/,
      'the H3 result must report complete, untruncated generation metadata');
    child.stdin.write(modelFrames(event.id, 'done'));
    finished = true;
  }
}

try {
  child = spawn(designBin, [
    '--remote-base-url', 'http://127.0.0.1:1',
    '--remote-model', 'deterministic-test',
    '--workspace', workspace,
    '--jsonl', '--nothink', '-c', '4096', '-n', '1024',
  ], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      DS4UI_DSTUDIO_URL: baseUrl,
      DS4UI_SSD_STREAMING_EFFECTIVE: '0',
      ...(chrome ? { DS4_CHROME: chrome } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    armInactivityTimeout();
    stdout += chunk;
    lineBuf += chunk;
    for (;;) {
      const nl = lineBuf.indexOf('\n');
      if (nl < 0) break;
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      consumeLine(line);
    }
  });
  let promptSent = false;
  child.stderr.on('data', (chunk) => {
    armInactivityTimeout();
    stderr += chunk;
    if (!promptSent && stderr.includes('+DWARFSTAR_WAITING')) {
      promptSent = true;
      child.stdin.write('Build it directly; do not ask questions. Generate and edit the requested visual asset, then create its H3 motion treatment. For this local contract fixture I explicitly confirm MiniMax H3 license and territory authorization.\n');
    } else if (finished && (stderr.match(/\+DWARFSTAR_WAITING/g) || []).length >= 2) {
      child.stdin.end();
    }
  });

  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(inactivityTimeout);
  clearTimeout(hardTimeout);
  clearTimeout(killEscalation);
  assert.equal(timeoutReason, '', `ds4-design test watchdog fired: ${timeoutReason}`);
  assert.deepEqual(exit, { code: 0, signal: null },
    `ds4-design failed${timeoutReason ? ` (${timeoutReason})` : ''}\n${stderr.slice(-4000)}\n${stdout.slice(-8000)}`);
  assert.equal(requests.length, chrome ? 18 : 7,
    'expected generation, optional visual tool, and final model rounds');
  assert.equal(httpCalls.length, chrome ? 13 : 9,
    'generate, file, and all optional visual probes should be called once');

  const outputPath = path.join(workspace, 'assets', 'observatory.png');
  assert.equal(fs.existsSync(outputPath), true, 'generated image should be written inside the project');
  assert.deepEqual(fs.readFileSync(outputPath), png, 'generated binary PNG should be preserved exactly');
  const editedPath = path.join(workspace, 'assets', 'observatory-edited.png');
  const videoPath = path.join(workspace, 'assets', 'observatory-h3.mp4');
  assert.deepEqual(fs.readFileSync(editedPath), editedPng,
    'edited binary PNG should be preserved exactly and differ from its source');
  assert.deepEqual(fs.readFileSync(videoPath), mp4, 'MiniMax H3 MP4 should be preserved exactly');
  assert.ok(events.some((event) => event.type === 'tool_call' && event.name === 'generate_image'));
  assert.ok(events.some((event) => event.type === 'tool_call_building'),
    'buffered DSML construction must be observable without leaking arguments');
  assert.ok(events.some((event) => event.type === 'tool_call_progress' &&
    Number(event.bytes) >= 0), 'buffered DSML should emit byte-count progress');
  assert.ok(events.some((event) => event.type === 'tool_result' &&
    event.name === 'generate_image' && /Qwen3\.8 Max routing/.test(event.output || '')));
  assert.ok(events.some((event) => event.type === 'tool_call' && event.name === 'see_image'));
  assert.ok(events.some((event) => event.type === 'tool_result' &&
    event.name === 'see_image' && /corresponds to the requested role/.test(event.output || '')));
  assert.equal(events.filter((event) => event.type === 'tool_call' && event.name === 'generate_image').length, 2,
    'Ideogram generation and Hunyuan editing must both execute');
  assert.equal(events.filter((event) => event.type === 'tool_call' && event.name === 'see_image').length, 3,
    'generated, batched and edited correspondence checks must all execute');
  assert.equal(events.filter((event) => event.type === 'tool_call' && event.name === 'generate_video').length, 1,
    'MiniMax H3 must execute once at the quality profile');
  if (chrome) {
    assert.ok(events.some((event) => event.type === 'tool_call' && event.name === 'see_page'));
    assert.ok(events.some((event) => event.type === 'tool_result' &&
      event.name === 'see_page' && /GRADE\|MOBILE\|OVERFLOW\|PASS\|/.test(event.output || '')));
    const visuals = events.filter((event) => event.type === 'visual_check');
    assert.equal(visuals.length, 4);
    assert.equal(visuals[0]?.pass, true);
    assert.deepEqual(
      Object.fromEntries(Object.entries(visuals[0]?.mobile || {}).filter(([key]) =>
        ['clientWidth', 'scrollWidth', 'overflow', 'interactiveOverlaps', 'stretchedPanels', 'maxPanelTail'].includes(key))),
      { clientWidth: 390, scrollWidth: 390, overflow: false, interactiveOverlaps: 0,
        stretchedPanels: 0, maxPanelTail: 0 });
    assert.equal(visuals[1]?.pass, false);
    assert.equal(visuals[1]?.desktop?.interactiveOverlaps, 1);
    assert.equal(visuals[1]?.mobile?.interactiveOverlaps, 1);
    assert.equal(visuals[2]?.pass, false);
    assert.equal(visuals[2]?.desktop?.stretchedPanels, 1);
    assert.equal(visuals[2]?.mobile?.stretchedPanels, 1);
    assert.equal(visuals[3]?.pass, false);
    assert.equal(visuals[3]?.verdictConsistency, false);
    assert.ok(events.some((event) => event.type === 'tool_result' &&
      event.name === 'edit' && /layout evidence is required[\s\S]*call inspect_layout/i.test(event.output || '')),
    'evidence-first runtime must prevent a layout edit before measurement');
    assert.ok(events.some((event) => event.type === 'tool_call' && event.name === 'todo_write'),
      'the integration flow must exercise the mandatory current-run work card');
    assert.equal(events.filter((event) => event.type === 'tool_call' &&
      event.name === 'inspect_layout').length, 6);
  }
  const history = fs.readFileSync(path.join(workspace, '.ds4-design', 'history.jsonl'), 'utf8');
  assert.match(history, /"type":"image_generated"/);
  assert.match(history, /"provider":"qwen38-routed-local"/);
  assert.match(history, /"operation":"generate"/);
  assert.match(history, /"operation":"edit"/);
  assert.match(history, /"type":"video_generated"/);
  assert.match(history, /"provider":"MiniMaxAI\/MiniMax-H3"/);
  console.log('ds4_design_qwen_test: ok');
} finally {
  clearTimeout(inactivityTimeout);
  clearTimeout(hardTimeout);
  clearTimeout(killEscalation);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
