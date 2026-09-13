// Actual browser interactions on unchanged generated files. Identical semantic
// checks for both products, no model self-ratings and no repaired outputs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { hasWorkshopIdentity, hasHonestWorkshopConfirmation } from '../fixtures/product_design_expectations.mjs';
import { createProductArtifactServer } from './product_artifact_server.mjs';
import { measureWorkshopRadioLayout } from './workshop_radio_layout.mjs';
const file = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'Pass pilot results.json');
const browserOption = process.argv.indexOf('--browser');
const browserName = browserOption < 0 ? 'chromium' : process.argv[browserOption + 1];
assert.ok(['chromium', 'webkit'].includes(browserName), 'Use --browser chromium or webkit');
const receipt = JSON.parse(fs.readFileSync(file));
const candidates = receipt.runs.filter(r => r.id === 'design-workshop-journey' && r.status !== 'running');
assert.ok(candidates.length, 'No completed Design task yet');
const output = fs.mkdtempSync(path.join(path.dirname(file), 'browser-audit-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { scope: `Real ${browserName} desktop/tablet/mobile and interactive workflow, not an aesthetic score`, browser: browserName,
  inputReceiptSha256: sha(fs.readFileSync(file)), receiptStatus: receipt.status, rows: [] };
const server = createProductArtifactServer(candidates);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await ({ chromium, webkit })[browserName].launch({ headless: true });
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
          if (await radio.count()) {
            // Click the visible, associated label as a user would. A native
            // input can intentionally be 1px/pointer-events:none while its
            // label remains the working pointer target. Never force-check it.
            const card = page.locator('label').filter({ has: radio.first() });
            if (await card.count()) await card.first().click();
            else await radio.first().check();
            assert.ok(await radio.first().isChecked(), 'Visible choice did not select its native radio');
            return;
          }
          const button = page.getByRole('button', { name: new RegExp(label, 'i') });
          if (await button.count()) return button.first().click();
          return page.getByText(label, { exact: true }).first().click();
        };
        assert.ok(await next().isDisabled(), 'Workshop choice must be required');
        await choose('Bicycle care'); await next().click();
        assert.ok(await next().isDisabled(), 'Day choice must be required');
        const dayLayout = await measureWorkshopRadioLayout(page);
        row.dayRadioLayout = { applicable: dayLayout.length > 0, measurements: dayLayout };
        if (dayLayout.length) assert.ok(dayLayout.every(item => item.textClearsIndicatorColumn),
          'Day label text falls into the radio indicator column');
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
      await check('native radio keyboard selection, when used', async () => {
        await page.reload();
        const radios = page.getByRole('radio');
        const count = await radios.count();
        row.nativeRadioKeyboardApplicable = count > 0;
        if (!count) return;
        assert.ok(count >= 3, 'Missing workshop radio choices');
        await radios.first().focus();
        await page.keyboard.press('Space');
        assert.ok(await radios.first().isChecked(), 'Space did not select the focused choice');
        await page.keyboard.press('ArrowDown');
        assert.ok(await radios.nth(1).isChecked(), 'Arrow key did not move radio selection');
        assert.ok(await page.getByRole('button', { name: /^Continue\b/i }).first().isEnabled());
      });
      await check('small phone and doubled text preserve choice-label layout', async () => {
        for (const [width, textScale] of [[320, 1], [390, 2]]) {
          await page.reload(); await page.setViewportSize({ width, height: 1000 });
          if (textScale === 2) await page.evaluate(() => {
            // Freeze each element's original computed size before applying the
            // multiplier: inherited font sizes must not compound recursively.
            const sizes = [...document.body.querySelectorAll('*')].map(e => [e, parseFloat(getComputedStyle(e).fontSize)]);
            for (const [e, size] of sizes) e.style.setProperty('font-size', `${size * 2}px`, 'important');
          });
          const layout = await measureWorkshopRadioLayout(page);
          const dimensions = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
          assert.ok(dimensions[0] <= dimensions[1] + 1, `Overflow at ${width}px / ${textScale}x text`);
          if (layout.length) assert.ok(layout.every(item => item.textClearsIndicatorColumn),
            `Radio label overlap at ${width}px / ${textScale}x text`);
          (row.textResizeChecks ||= []).push({ width, textScale, radioApplicable: layout.length > 0, measurements: layout });
        }
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
if (report.rows.some(row => !row.pass)) process.exitCode = 1;
