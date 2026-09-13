// Model-free regression on the actual, unchanged DS4-generated replay.
// Generation provenance is checked separately from browser behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { measureWorkshopRadioLayout } from '../support/workshop_radio_layout.mjs';
import { hasHonestWorkshopConfirmation } from '../fixtures/product_design_expectations.mjs';

const root = 'extension/benchmarks/product-comparison';
const file = `${root}/examples/dstudio-workshop-regenerated.html`;
const bytes = fs.readFileSync(file);
const receipt = JSON.parse(fs.readFileSync(`${root}/results/2026-09-06-design-regeneration.json`));
const sha = data => createHash('sha256').update(data).digest('hex');
assert.equal(sha(bytes), receipt.htmlSha256);
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    const errors = [], external = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => { external.push(route.request().url()); return route.abort(); });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.setContent(bytes.toString());
      const rows = await measureWorkshopRadioLayout(page);
      assert.equal(rows.length, 3);
      assert.ok(rows.every(r => r.textClearsIndicatorColumn), `${name}/${width}: workshop text overlaps indicator column`);
      assert.ok(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled());
      await page.getByText('Bookbinding', { exact: true }).click();
      const radios = page.getByRole('radio');
      assert.ok(await radios.first().isChecked(), 'Clicking the visible label must select its native radio');
      await radios.first().focus(); await page.keyboard.press('ArrowDown');
      assert.ok(await radios.nth(1).isChecked());
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      assert.ok(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled());
      const days = await measureWorkshopRadioLayout(page);
      assert.equal(days.length, 2); assert.ok(days.every(r => r.textClearsIndicatorColumn));
      await page.getByText('Thursday', { exact: true }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      assert.ok(await page.getByText('Bicycle care', { exact: true }).filter({ visible: true }).isVisible());
      assert.ok(await page.getByText('Thursday', { exact: true }).filter({ visible: true }).isVisible());
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      assert.ok(await page.getByRole('radio', { name: /Thursday/ }).isChecked());
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      assert.ok(await page.getByRole('radio', { name: /Bicycle care/ }).isChecked());
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('button', { name: /Confirm plan/ }).click();
      assert.ok(hasHonestWorkshopConfirmation(await page.locator('body').innerText()));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`${name}: unchanged model output, 4 widths, 5 radio labels, clicks, keyboard, Back, review and confirmation passed`);
  } finally { await browser.close(); }
}
assert.equal(sha(fs.readFileSync(file)), receipt.htmlSha256);
