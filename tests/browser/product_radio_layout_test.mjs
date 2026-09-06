import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { measureWorkshopRadioLayout } from '../support/workshop_radio_layout.mjs';
const file = 'extension/benchmarks/product-comparison/examples/dstudio-workshop.html';
const original = fs.readFileSync(file);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  const archived = [];
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.setContent(original.toString());
    const rows = await measureWorkshopRadioLayout(page);
    assert.equal(rows.length, 3);
    archived.push({ width, aligned: rows.filter(row => row.textClearsIndicatorColumn).length, total: rows.length });
  }
  assert.deepEqual(archived, [
    { width: 390, aligned: 0, total: 3 },
    { width: 768, aligned: 3, total: 3 },
    { width: 1440, aligned: 0, total: 3 },
  ], 'Reproduce the actual phone/desktop defects and distinguish the unaffected tablet layout');
  // Independent positive fixture: a real two-column layout, multiline text,
  // and an associated native radio. Not a repaired benchmark output.
  await page.setContent(`<style>
    label { display:grid; grid-template-columns:20px 1fr; gap:12px; width:210px; padding:16px; }
    input { position:absolute; opacity:0; } i { display:block; width:20px; height:20px; border:1px solid; border-radius:50%; }
  </style><label><input type="radio" name="choice" value="example"><i aria-hidden="true"></i><span>A long descriptive label wraps on several lines while maintaining a separate indicator column.</span></label>`);
  const good = await measureWorkshopRadioLayout(page);
  assert.equal(good.length, 1); assert.equal(good[0].textClearsIndicatorColumn, true);
  await page.getByText('A long descriptive label', { exact: false }).click();
  assert.equal(await page.getByRole('radio').isChecked(), true);
  assert.equal(hash(fs.readFileSync(file)), hash(original), 'The original generated artifact remains untouched');
  console.log(JSON.stringify({ check: 'radio label column geometry', archivedArtifactSha256: hash(original), archived,
    positiveFixturePassed: true, scope: 'The regression detector passes; the archived phone design still fails visual layout.' }));
} finally { await browser.close(); }
