// Real WebKit/Chromium rendering of production Markdown and styles with
// synthetic text. This focused layout fixture does not run a model or host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium, webkit} from 'playwright';

const html = fs.readFileSync('web/index.html', 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const between = (start, end) => {
  const first = script.indexOf(start), last = script.indexOf(end, first);
  assert(first >= 0 && last > first, 'production renderer fixture boundaries');
  return script.slice(first, last);
};
const renderer = between('const TEX_GREEK =',
  '/* ==================== Markdown (escape-first, XSS-safe) ==================== */') +
  between("const CODE = '\\u0000'", 'const MD_CACHE_MAX =') +
  '\nwindow.renderFixtureMarkdown = renderMarkdown;';
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
const root = path.resolve('tests/.artifacts/reasoning-spacing');
fs.mkdirSync(root, {recursive: true});
const run = fs.mkdtempSync(path.join(root, 'run-'));
const code = 'fn main() {\n    println!("fixture");\n}';
const markdown = 'Inspect the input.\nContinue on the next line.\n\n' +
  '1. **Check the request:**\n\n' +
  '   - First item\n   - Second item\n   - Third item\n\n' +
  '2. **Check the result:**\n\n' +
  '   - Keep the original text\n   - Keep the final answer\n\n' +
  '```rust\n' + code + '\n```';
const report = {scope: 'Production renderer/styles, synthetic layout fixture; no inference', browsers: []};
console.log(run);

const browserName = process.env.DSTUDIO_TEST_BROWSER;
assert.ok(!browserName || ['webkit', 'chromium'].includes(browserName));
for (const [name, engine] of [['webkit', webkit], ['chromium', chromium]].filter(([name]) => !browserName || name === browserName)) {
  const browser = await engine.launch();
  let page;
  const result = {name, passed: false, cases: []};
  report.browsers.push(result);
  try {
    page = await browser.newPage({viewport: {width: 1440, height: 1000}, colorScheme: 'dark'});
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setContent('<style>' + styles + '</style>');
    await page.addScriptTag({content: renderer});
    for (const agent of [false, true]) {
      const metrics = await page.evaluate(({markdown, code, agent}) => {
        document.body.replaceChildren();
        Object.assign(document.body.style, {display: 'grid', gridTemplateColumns: '1fr 1fr',
          gap: '32px', padding: '24px', height: 'auto', overflow: 'visible'});
        const host = document.createElement('section');
        host.className = 'thinking' + (agent ? ' agent-thought' : '');
        const body = document.createElement('div');
        body.className = 'thinking__body md';
        body.innerHTML = window.renderFixtureMarkdown(markdown);
        host.append(body);
        document.body.append(host);
        // Independent layout reference: the same rendered Markdown in the
        // ordinary answer surface, with matching typography, not whitespace.
        const reference = document.createElement('div');
        reference.className = 'md';
        reference.innerHTML = window.renderFixtureMarkdown(markdown);
        const typography = getComputedStyle(body);
        for (const key of ['fontSize', 'fontFamily', 'lineHeight', 'letterSpacing'])
          reference.style[key] = typography[key];
        document.body.append(reference);
        const landmarks = node => {
          const origin = node.querySelector('p').getBoundingClientRect().top;
          return [...node.querySelectorAll('p, li')].map(el => ({
            text: el.textContent, top: el.getBoundingClientRect().top - origin,
            height: el.getBoundingClientRect().height,
          }));
        };
        const sample = body.querySelector('pre code');
        const char = (node, offset) => {
          // Syntax highlighting splits code across nested spans/text nodes.
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let text;
          while ((text = walker.nextNode()) && offset >= text.length) offset -= text.length;
          if (!text) throw new Error('missing code character in fixture');
          const range = document.createRange();
          range.setStart(text, offset); range.setEnd(text, offset + 1);
          return range.getBoundingClientRect().toJSON();
        };
        const second = code.indexOf('    println');
        const referenceCode = reference.querySelector('pre code');
        const raw = document.createElement('div');
        raw.className = 'thinking__body';
        raw.textContent = 'First line\n\n  Indented line\nLast line';
        host.append(raw);
        const range = document.createRange(); range.selectNodeContents(raw);
        return {actual: landmarks(body), reference: landmarks(reference),
          code: sample.textContent, first: char(sample, 0), indented: char(sample, second + 4),
          referenceFirst: char(referenceCode, 0), referenceIndented: char(referenceCode, second + 4),
          rawLines: new Set([...range.getClientRects()].map(r => Math.round(r.top))).size};
      }, {markdown, code, agent});
      result.cases.push({agent, metrics});
      await page.screenshot({path: path.join(run, name + (agent ? '-agent' : '-chat') + '.png'), fullPage: true});
      assert.equal(metrics.actual.length, metrics.reference.length);
      for (let i = 0; i < metrics.actual.length; i++) {
        assert.equal(metrics.actual[i].text, metrics.reference[i].text);
        assert(Math.abs(metrics.actual[i].top - metrics.reference[i].top) < 1,
          `${name}: reasoning adds vertical space before ${metrics.actual[i].text}`);
        assert(Math.abs(metrics.actual[i].height - metrics.reference[i].height) < 1);
      }
      assert.equal(metrics.code, code, 'code bytes must be preserved');
      assert(metrics.indented.y > metrics.first.y, 'code newlines must remain visible');
      assert(metrics.indented.x > metrics.first.x &&
        Math.abs((metrics.indented.x - metrics.first.x) -
          (metrics.referenceIndented.x - metrics.referenceFirst.x)) < 1,
        'code indentation must remain visible');
      assert.equal(metrics.rawLines, 4, 'plain reasoning summaries retain explicit blank lines');
    }
    assert.deepEqual(errors, [], 'browser errors are not suppressed');
    result.passed = true;
  } catch (error) {
    result.error = String(error.stack || error);
    process.exitCode = 1;
    console.error(result.error);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
assert(report.browsers.every(result => result.passed), 'reasoning layout regressions failed');
