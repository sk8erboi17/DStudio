import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { hasFictionalLocalDemoDisclosure } from './lumen_disclosure_contract.mjs';

const site = path.resolve(process.argv[2] || '');
const evidence = path.resolve(process.argv[3] || path.join(site, '.release-evidence'));
if (!fs.statSync(site, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('usage: node tests/lumen_site_release_gate.mjs SITE_DIR [EVIDENCE_DIR]');
  process.exit(2);
}

const required = [
  'index.html', 'README.md', 'MEDIA_AND_MODELS.md', '.nojekyll',
  'assets/blue-hour-observatory.png', 'assets/deep-archive.png',
  'assets/local-sheet.png', 'assets/shared-lens.png',
  'assets/observatory-blue-hour.mp4',
];
for (const relative of required) {
  const stat = fs.statSync(path.join(site, relative), { throwIfNoEntry: false });
  assert.ok(stat?.isFile(), `missing release file: ${relative}`);
  assert.ok(stat.size > 0, `empty release file: ${relative}`);
  assert.ok(stat.size < 100 * 1024 * 1024, `GitHub file limit exceeded: ${relative}`);
}
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(absolute) : [absolute];
});
const allFiles = walk(site);
assert.equal(allFiles.some(file => path.basename(file) === '.DS_Store'), false, '.DS_Store is not releasable');
assert.equal(allFiles.some(file => /(?:^|\/)__pycache__(?:\/|$)/.test(file)), false, '__pycache__ is not releasable');

const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
const releaseDocs = [
  fs.readFileSync(path.join(site, 'README.md'), 'utf8'),
  fs.readFileSync(path.join(site, 'MEDIA_AND_MODELS.md'), 'utf8'),
].join('\n');
assert.doesNotMatch(releaseDocs, /Qwen(?:2\.5|[- ]Image)/i,
  'retired Qwen Image/Qwen2.5 media path must not appear in the release');
for (const model of [
  'mlx-community/Qwen3.8-27B-8bit', 'Comfy-Org/Ideogram-4',
  'HunyuanImage-3.0-Instruct-NF4-v2', 'MiniMaxAI/MiniMax-H3',
]) assert.ok(releaseDocs.includes(model), `missing model provenance: ${model}`);
assert.doesNotMatch(releaseDocs, /__[A-Z0-9_]+__/, 'unresolved documentation placeholder');
assert.doesNotMatch(html, /__[A-Z0-9_]+__/, 'unresolved release placeholder');
for (const exact of [
  'LUMEN OBSERVATORY', 'NIGHT 04', 'The sky is a shared archive',
  '18 October — 19:30', 'Reserve a telescope', 'The Deep Archive',
  'The Local Sheet', 'The Shared Lens', 'Arrive at dusk',
  'Claim an instrument', 'Write one line',
]) assert.ok(html.includes(exact), `missing exact copy: ${exact}`);
for (const structural of [/<header\b/i, /<main\b/i, /<footer\b/i, /<form\b/i, /<video\b/i]) {
  assert.match(html, structural, `missing semantic structure: ${structural}`);
}
assert.equal(hasFictionalLocalDemoDisclosure(html), true,
  'visible fictional local-demo/no-reservation disclosure missing');
assert.match(html, /prefers-reduced-motion\s*:\s*reduce/i, 'reduced-motion CSS missing');
const videoTag = html.match(/<video\b[^>]*>/i)?.[0] || '';
for (const attribute of ['autoplay', 'muted', 'loop', 'playsinline']) {
  assert.match(videoTag, new RegExp(`\\b${attribute}\\b`, 'i'), `hero video is missing ${attribute}`);
}
assert.match(html, /poster=["']assets\/blue-hour-observatory\.png["']/i, 'local hero poster missing');
assert.match(html, /(?:src=["']assets\/observatory-blue-hour\.mp4["']|<source\b[^>]*src=["']assets\/observatory-blue-hour\.mp4["'])/i,
  'local H3 MP4 missing from hero');
assert.doesNotMatch(html, /<(?:script|img|source|video)\b[^>]*\bsrc=["']https?:/i, 'remote runtime/media dependency');
assert.doesNotMatch(html, /<link\b[^>]*\bhref=["']https?:/i, 'remote stylesheet/font dependency');
assert.doesNotMatch(html, /@import\s+(?:url\()?\s*["']?https?:|url\(\s*["']?https?:/i, 'remote CSS dependency');
assert.doesNotMatch(html, /javascript\s*:/i, 'javascript: URL is forbidden');

const idMatches = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map(match => match[1]);
assert.equal(new Set(idMatches).size, idMatches.length, 'duplicate HTML id');
const ids = new Set(idMatches);
for (const match of html.matchAll(/\bhref=["']#([^"']+)["']/gi)) {
  assert.ok(ids.has(match[1]), `broken local target: #${match[1]}`);
}
for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
  const attrs = match[1];
  const decorative = /aria-hidden=["']true["']|role=["']presentation["']/i.test(attrs);
  const alt = attrs.match(/\balt=["']([^"']*)["']/i)?.[1];
  assert.ok(decorative || (alt && alt.trim().length >= 12), `non-specific image alt: ${match[0]}`);
}

const ffprobe = spawnSync('ffprobe', [
  '-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,width,height:format=duration',
  '-of', 'json', path.join(site, 'assets/observatory-blue-hour.mp4'),
], { encoding: 'utf8' });
assert.equal(ffprobe.status, 0, ffprobe.stderr);
const media = JSON.parse(ffprobe.stdout);
const video = media.streams.find(stream => stream.codec_name);
assert.equal(video?.codec_name, 'h264', 'hero codec must be H.264');
assert.equal(video?.pix_fmt, 'yuv420p', 'hero pixel format must be yuv420p');
assert.equal(video?.width, 1344, 'hero width must match H3 Quality');
assert.equal(video?.height, 768, 'hero height must match H3 Quality');
assert.ok(Number(media.format.duration) >= 4.5 && Number(media.format.duration) <= 5.5,
  `hero duration is ${media.format.duration}s`);

const hashes = Object.fromEntries(required.map(relative => [
  relative,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(site, relative))).digest('hex'),
]));

const mime = file => ({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.mp4': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
})[path.extname(file).toLowerCase()] || 'application/octet-stream';
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const absolute = path.resolve(site, relative);
  if (absolute !== site && !absolute.startsWith(`${site}${path.sep}`)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  const stat = fs.statSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': mime(absolute), 'Content-Length': stat.size });
  fs.createReadStream(absolute).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
fs.mkdirSync(evidence, { recursive: true });

let browser;
const views = {};
try {
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ channel: 'chrome' });
  }
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900, isMobile: false },
    { name: 'mobile', width: 390, height: 844, isMobile: true },
  ]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    const consoleErrors = [];
    const requestFailures = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('requestfailed', request => requestFailures.push(`${request.url()} ${request.failure()?.errorText}`));
    await page.goto(origin, { waitUntil: 'networkidle' });
    const metrics = await page.evaluate(() => {
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        images: [...document.images].map(image => ({
          src: image.getAttribute('src'), complete: image.complete,
          naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        })),
        resources: performance.getEntriesByType('resource').map(entry => entry.name),
        undersized: [...document.querySelectorAll('a[href],button,input,select,textarea,summary')]
          .filter(visible).map(element => {
            const rect = element.getBoundingClientRect();
            return { tag: element.tagName, text: (element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 60), width: rect.width, height: rect.height };
          }).filter(item => item.width < 43.5 || item.height < 43.5),
      };
    });
    assert.equal(metrics.scrollWidth, metrics.clientWidth, `${viewport.name} horizontal overflow`);
    assert.ok(metrics.images.length >= 4, `${viewport.name} must load four still images`);
    assert.ok(metrics.images.every(image => image.complete && image.naturalWidth > 0), `${viewport.name} broken image`);
    assert.ok(metrics.resources.every(resource => resource.startsWith(origin)), `${viewport.name} remote resource`);
    assert.deepEqual(metrics.undersized, [], `${viewport.name} has undersized controls`);
    assert.deepEqual(consoleErrors, [], `${viewport.name} console errors`);
    assert.deepEqual(requestFailures, [], `${viewport.name} request failures`);

    await page.keyboard.press('Tab');
    const firstFocus = await page.evaluate(() => ({
      href: document.activeElement?.getAttribute('href'),
      outline: getComputedStyle(document.activeElement).outlineStyle,
      boxShadow: getComputedStyle(document.activeElement).boxShadow,
    }));
    assert.match(firstFocus.href || '', /^#/, `${viewport.name} first tab should reach the skip link`);
    assert.ok(firstFocus.outline !== 'none' || firstFocus.boxShadow !== 'none',
      `${viewport.name} skip link focus is invisible`);

    if (viewport.isMobile) {
      const menu = page.locator('button[aria-controls][aria-expanded]').first();
      assert.equal(await menu.count(), 1, 'mobile menu button missing');
      await menu.click();
      assert.equal(await menu.getAttribute('aria-expanded'), 'true', 'mobile menu did not open');
      await page.keyboard.press('Escape');
      assert.equal(await menu.getAttribute('aria-expanded'), 'false', 'Escape did not close mobile menu');
      assert.equal(await menu.evaluate(element => element === document.activeElement), true, 'menu focus was not restored');
    }

    const details = page.locator('details').first();
    assert.equal(await details.count(), 1, 'FAQ details missing');
    await details.locator('summary').click();
    assert.equal(await details.evaluate(element => element.open), true, 'FAQ did not open');

    const form = page.locator('form').first();
    assert.equal(await form.count(), 1, 'reservation form missing');
    await form.locator('input[required]').evaluateAll(elements => elements.forEach((element, index) => {
      if (element.type === 'email') element.value = 'visitor@example.test';
      else if (element.type === 'checkbox' || element.type === 'radio') element.checked = true;
      else element.value = `Visitor ${index + 1}`;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }));
    await form.locator('select[required]').evaluateAll(elements => elements.forEach(element => {
      const option = [...element.options].find(item => item.value);
      if (option) element.value = option.value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }));
    const beforeUrl = page.url();
    await form.locator('button[type="submit"],input[type="submit"]').first().click();
    await page.waitForTimeout(100);
    assert.equal(page.url(), beforeUrl, 'local reservation form navigated away');
    const liveText = await page.locator('[aria-live]').allTextContents();
    assert.ok(liveText.some(text => text.trim().length > 10), 'reservation form produced no visible live status');

    await page.screenshot({ path: path.join(evidence, `${viewport.name}.png`), fullPage: true });
    views[viewport.name] = { ...metrics, consoleErrors, requestFailures };
    await context.close();
  }

  const reduced = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await reduced.newPage();
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
  const motion = await page.locator('video').first().evaluate(element => ({
    paused: element.paused, autoplay: element.autoplay, currentTime: element.currentTime,
  }));
  assert.ok(motion.paused || !motion.autoplay, `reduced motion left hero playing: ${JSON.stringify(motion)}`);
  await reduced.close();

  const report = {
    ok: true,
    checkedAt: new Date().toISOString(),
    files: required,
    hashes,
    video: { ...video, duration: Number(media.format.duration) },
    views,
    reducedMotion: motion,
  };
  fs.writeFileSync(path.join(evidence, 'release-gate.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, evidence, video: report.video }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
