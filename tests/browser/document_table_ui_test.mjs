import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const ui = fs.readFileSync('web/index.html', 'utf8');
const start = ui.indexOf('      const documentTableOpenCells = new Set();');
const end = ui.indexOf('      function attachToolOutput(fold, ev) {', start);
assert.ok(start > 0 && end > start);
const render = ui.slice(start, end);
const fixture = JSON.parse(execFileSync('python3', ['-c', `
import json, runpy
case = runpy.run_path('tests/unit/document_table_test.py')['DocumentTableTests']()
case.setUp()
try:
    case.simple('Owner: Zoë <script>window.injected=1</script>', 'Zoë')
    case.call('update', revision=1, rows_json=[{'id':'unread','label':'Not yet extracted','cells':{}}])
    result = case.call('export', output='comparison.html')
    print(json.dumps({'result':result, 'html':(case.root/'comparison.html').read_text()}))
finally:
    case.tearDown()
`], { encoding: 'utf8' }));
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { throw new Error('Playwright required for document-table browser verification'); }

const browser = await chromium.launch({ headless: true });
const dir = 'tests/.artifacts/document-table';
fs.mkdirSync(dir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  const cssStart = ui.indexOf('    .document-table-preview {');
  const cssEnd = ui.indexOf('    /* The transcript, full width', cssStart);
  assert.ok(cssStart > 0 && cssEnd > cssStart);
  await page.setContent(`<!doctype html><style>body{font:14px system-ui;margin:24px}.document-table-preview{max-width:100%}${ui.slice(cssStart, cssEnd)}</style><main id="preview"></main>`);
  await page.addScriptTag({ content: `
    function el(tag, attrs = {}, children = []) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value);
      }
      node.append(...children);
      return node;
    }
    ${render}
    window.renderTable = buildDocumentTablePreview;
  ` });
  await page.evaluate(data => document.querySelector('#preview').append(window.renderTable(JSON.stringify(data))), fixture.result);
  assert.equal(await page.locator('tbody tr').count(), 2);
  assert.equal(await page.locator('details[open]').count(), 0);
  await page.locator('.document-table-cell summary').first().click();
  assert.equal(await page.locator('.document-table-cell[open]').count(), 1);
  await page.evaluate(data => document.querySelector('#preview').replaceChildren(window.renderTable(JSON.stringify(data))), fixture.result);
  assert.equal(await page.locator('.document-table-cell[open]').count(), 1, 'evidence stays open across transcript rerenders');
  assert.match(await page.locator('blockquote').first().innerText(), /Owner: Zoë <script>/);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.match(await page.locator('.document-table-preview').innerText(), /not that the interpretation is correct/);
  await page.screenshot({ path: `${dir}/cowork-desktop.png`, fullPage: true });
  // Keyboard disclosure and mobile overflow remain usable without colour cues.
  await page.locator('.document-table-cell summary').last().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.document-table-cell[open]').count(), 2);
  await page.setViewportSize({ width: 360, height: 780 });
  const bounds = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(bounds.document <= bounds.width, JSON.stringify(bounds));
  await page.screenshot({ path: `${dir}/cowork-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => window.renderTable('{bad json')), null);
  assert.equal(await page.evaluate(() => window.renderTable(JSON.stringify({format:'other',columns:[],rows:[]}))), null);
  await page.setContent(fixture.html);
  await page.locator('summary').first().click();
  assert.match(await page.locator('details[open]').innerText(), /source.txt · line:1/);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.deepEqual(requests, [], 'neither inline preview nor standalone export makes external requests');
} finally { await browser.close(); }
console.log('Document-table real helper output and browser previews passed (no model)');
