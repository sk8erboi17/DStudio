// Production page in a real browser; simulated launcher, no inference.
// The saved theme must be on the static shell before the app has loaded its
// history. A deterministic barrier keeps the asynchronous history database
// from ever opening, so the app module cannot reach its own theme step: what
// the page shows is only what was applied before the first paint.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { uiMockServer } from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
let browserType;
try { browserType = (await import('playwright'))[browserName]; }
catch { console.log('ui_theme_first_paint_playwright_test: playwright missing, NOT RUN'); process.exit(1); }

const server = await uiMockServer();
let browser;
try { browser = await browserType.launch(); }
catch { server.close(); console.log('ui_theme_first_paint_playwright_test: browser missing, NOT RUN'); process.exit(1); }

const artifactRoot = 'tests/.artifacts/theme-first-paint';
fs.mkdirSync(artifactRoot, { recursive: true });
const artifactDir = fs.mkdtempSync(`${artifactRoot}/${browserName}-`);
const report = { scope: `Production page in ${browserName}; simulated launcher; history load held by a barrier; no inference`, cases: [] };

// [saved settings value, emulated OS scheme, expected theme on the shell]
const cases = [
  ['dark', { v: 2, onboarded: true, theme: 'dark' }, 'light', 'dark'],
  ['light', { v: 2, onboarded: true, theme: 'light' }, 'dark', 'light'],
  ['system follows a dark OS', { v: 2, onboarded: true, theme: 'system' }, 'dark', 'dark'],
  ['system follows a light OS', { v: 2, onboarded: true, theme: 'system' }, 'light', 'light'],
  ['an unknown theme value is dark, as in the app', { v: 2, onboarded: true, theme: 'sepia' }, 'light', 'dark'],
  ['another schema version keeps the default', { v: 1, theme: 'dark' }, 'dark', 'light'],
  ['no saved settings keep the default', null, 'dark', 'light'],
  ['damaged settings keep the default', '{not json', 'dark', 'light'],
];
try {
  for (const [name, saved, colorScheme, expected] of cases) {
    const row = { name, expected };
    report.cases.push(row);
    const page = await browser.newPage({ viewport: { width: 900, height: 600 }, colorScheme, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(({ saved, origin }) => {
      if (window !== window.top || location.origin !== origin) return;
      if (saved !== null) localStorage.setItem('ds4web.settings.v2', typeof saved === 'string' ? saved : JSON.stringify(saved));
      // Barrier: the history database never answers, so Store.load() stays pending.
      const pending = { set onsuccess(_) {}, set onerror(_) {}, set onupgradeneeded(_) {}, set onblocked(_) {}, addEventListener() {} };
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open: () => { window.__historyOpenAttempts = (window.__historyOpenAttempts || 0) + 1; return pending; } } });
    }, { saved, origin: server.origin });
    try {
      await page.goto(`${server.origin}/`, { waitUntil: 'load' });
      // The app module has started and is waiting on the barrier.
      await page.waitForFunction(() => window.__historyOpenAttempts > 0 && document.body.inert === true, null, { timeout: 15000 });
      const state = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, inert: document.body.inert,
        busy: document.body.getAttribute('aria-busy'), background: getComputedStyle(document.body).backgroundColor }));
      row.observed = state;
      assert.equal(state.inert, true, 'the app is still loading its history');
      assert.equal(state.theme, expected, 'the shell has the saved theme before the app finished loading');
      // What is painted, independently of the attribute: the sidebar rail pixel.
      const image = `${artifactDir}/${report.cases.length}-${expected}.png`;
      await page.screenshot({ path: image });
      const rail = await page.locator('.sb-rail').boundingBox();
      const shot = await page.screenshot({ clip: { x: Math.round(rail.x + rail.width / 2), y: Math.round(rail.y + rail.height - 40), width: 1, height: 1 } });
      row.railPixelPngBytes = shot.length;
      const luminance = await page.evaluate(() => {
        const [r, g, b] = getComputedStyle(document.querySelector('.sb-rail')).backgroundColor.match(/\d+/g).map(Number);
        return (r + g + b) / 3;
      });
      row.railLuminance = luminance;
      assert.ok(expected === 'dark' ? luminance < 80 : luminance > 180, `the rail is painted ${expected} (mean channel ${luminance})`);
      assert.deepEqual(errors, [], 'no page error while the history load is held');
      row.status = 'PASS';
    } catch (error) { row.status = 'FAIL'; row.error = String(error.stack || error); }
    finally { await page.close(); }
  }
} finally {
  fs.writeFileSync(`${artifactDir}/receipt.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close().catch(() => {}); server.close();
}
for (const row of report.cases) console.log(`${row.status}: ${row.name}${row.error ? `\n${row.error}` : ''}`);
console.log(`ui_theme_first_paint_playwright_test (${browserName}; simulated launcher): ${artifactDir}/receipt.json`);
assert.ok(report.cases.every((row) => row.status === 'PASS'), 'the saved theme is not on the shell before the app has loaded');
