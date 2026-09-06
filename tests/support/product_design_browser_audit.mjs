// Actual browser interactions on unchanged generated files. Identical semantic
// checks for both products, no model self-ratings and no repaired outputs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { hasWorkshopIdentity, hasHonestWorkshopConfirmation } from '../fixtures/product_design_expectations.mjs';
import { createProductArtifactServer } from './product_artifact_server.mjs';
import { measureWorkshopRadioLayout } from './workshop_radio_layout.mjs';
const file = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'Pass pilot results.json');
const receipt = JSON.parse(fs.readFileSync(file));
const candidates = receipt.runs.filter(r => r.id === 'design-workshop-journey' && r.status !== 'running');
assert.ok(candidates.length, 'No completed Design task yet');
const output = fs.mkdtempSync(path.join(path.dirname(file), 'browser-audit-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { scope: 'Real Chromium desktop/tablet/mobile and interactive workflow, not an aesthetic score',
  inputReceiptSha256: sha(fs.readFileSync(file)), receiptStatus: receipt.status, rows: [] };
const server = createProductArtifactServer(candidates);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
try {
  for (const candidate of candidates) {
    const row = { product: candidate.product, originalStatus: candidate.status, checks: [], screenshots: [] }; report.rows.push(row);
    const check = async (name, work) => {
      try { await work(); row.checks.push({ name, pass: true }); }
      catch (error) { row.checks.push({ name, pass: false, error: error.message }); }
      save();
    };
    const target = path.join(candidate.workspace || output, 'workshop.html');
    await check('requested HTML exists', async () => assert.ok(fs.existsSync(target)));
    if (!fs.existsSync(target)) { row.pass = false; continue; }
    row.htmlSha256 = sha(fs.readFileSync(target));
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [], external = [], missing = [];
    await context.route('**/*', route => {
      if (!route.request().url().startsWith(base + '/')) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(4000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) missing.push(response.url()); });
    try {
      await page.goto(`${base}/${candidate.product}/workshop.html`);
      for (const width of [1440, 768, 390]) {
        await check(`required identity and no horizontal overflow at ${width}px`, async () => {
        await page.setViewportSize({ width, height: 1000 }); await page.waitForTimeout(100);
        const measure = await page.evaluate(() => ({ w: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, text: document.body.innerText.replace(/\s+/g, ' ') }));
        const screenshot = `${candidate.product}-${width}.png`;
        await page.screenshot({ path: path.join(output, screenshot), fullPage: true }); row.screenshots.push(screenshot);
        assert.ok(measure.scroll <= measure.w + 1, 'Horizontal page overflow');
        assert.ok(hasWorkshopIdentity(measure.text), 'Required brand or heading missing');
        });
        const radioLayout = await measureWorkshopRadioLayout(page);
        // Keep geometry separate from function. No radio means not applicable,
        // never a fabricated visual pass for a different control structure.
        (row.radioLayout ||= []).push({ width, applicable: radioLayout.length > 0, measurements: radioLayout });
        if (radioLayout.length) await check(`radio label text clears indicator column at ${width}px`, async () => {
          assert.ok(radioLayout.every(item => item.textClearsIndicatorColumn), 'Wrapped label text falls into the radio indicator column');
        });
      }
      row.initialDemoLabel = /\b(sample|demo|illustrative)\b/i.test(await page.locator('body').innerText());
      await check('choices, gating, Back, Review and real completion feedback', async () => {
        const next = () => page.getByRole('button', { name: /^Continue\b/i }).first();
        const choose = async label => {
          const radio = page.getByRole('radio', { name: new RegExp(label, 'i') });
          if (await radio.count()) return radio.first().check();
          const button = page.getByRole('button', { name: new RegExp(label, 'i') });
          if (await button.count()) return button.first().click();
          return page.getByText(label, { exact: true }).first().click();
        };
        assert.ok(await next().isDisabled(), 'Workshop choice must be required');
        await choose('Bicycle care'); await next().click();
        assert.ok(await next().isDisabled(), 'Day choice must be required');
        await choose('Thursday'); await next().click();
        const visible = pattern => page.getByText(pattern).filter({ visible: true }).first();
        assert.ok(await visible(/Bicycle care/).isVisible()); assert.ok(await visible(/Thursday/).isVisible());
        await page.getByRole('button', { name: /^Back\b/i }).first().click();
        assert.ok(await next().isEnabled(), 'Back discarded the day');
        await page.getByRole('button', { name: /^Back\b/i }).first().click();
        assert.ok(await next().isEnabled(), 'Back discarded the workshop');
        await next().click(); await next().click();
        const before = await page.locator('body').innerText();
        await page.getByRole('button', { name: /complete|confirm|finish/i }).first().click();
        await visible(/No booking was made/i).waitFor();
        assert.notEqual(await page.locator('body').innerText(), before, 'Final action produced no visible state change');
        assert.ok(hasHonestWorkshopConfirmation(await page.locator('body').innerText()),
          'Final confirmation must disclose no booking, local demo and sample data');
      });
      await check('offline artifact has no script errors or missing dependencies', async () => {
        assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(missing, []);
      });
      await check('audit did not alter original file', async () => assert.equal(sha(fs.readFileSync(target)), row.htmlSha256));
    } finally { await context.close(); }
    row.pass = row.checks.every(c => c.pass); save();
  }
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); save(); }
console.log(`Actual browser audit: ${output}`);
for (const row of report.rows) console.log(`${row.product}: ${row.pass ? 'pass' : 'fail'}`);
