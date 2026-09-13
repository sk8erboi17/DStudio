// Execute the compiled native extractor in a real, isolated browser. Search
// pages are synthetic and entirely intercepted; no Google/network or LLM run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const source = fs.realpathSync(process.argv[2] || '.');
const browserKind = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
const run = artifactRunDir('q36-search-extract');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const probe = path.join(root, 'tests/support/q36_web_search_probe.c');
const report = {started: new Date().toISOString(), source, browser: browserKind,
  scope: 'Real browser/native search-extractor development fixtures; no live search, model or HTTP tool-loop acceptance',
  inputs: {}, commands: [], cases: [], passed: false};
const save = () => writeArtifact(run, 'results.json', report);
let browser;
function command(exe, args) {
  const env = exe === 'git' ? {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: path.dirname(source)} : process.env;
  const out = spawnSync(exe, args, {env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
  report.commands.push({exe, args, code: out.status, signal: out.signal, error: String(out.error || ''),
    stdout: out.stdout, stderr: out.stderr}); save();
  assert.equal(out.status, 0, out.stderr || String(out.error || out.signal));
  return out.stdout;
}
const link = (url, body, style = '') => `<a href="${url}" style="${style}">${body}</a>`;
const fixtureCases = [
  {id: 'plain-result', html: link('https://example.test/page', 'Example page'),
    links: ['- [Example page](https://example.test/page)']},
  {id: 'legacy-q-redirect', html: link('https://www.google.com/url?q=https%3A%2F%2Fexample.test%2Fpage', 'Example page'),
    links: ['- [Example page](https://example.test/page)']},
  {id: 'opaque-goto-heading', html: link('https://www.google.com/goto?url=opaque-token', '<h3>Example heading</h3><span>Extra snippet</span>'),
    links: ['- [Example heading](https://www.google.com/goto?url=opaque-token)']},
  {id: 'regional-goto-heading', html: link('https://www.google.it/goto?url=opaque-token', '<h3>Pagina italiana</h3>'),
    links: ['- [Pagina italiana](https://www.google.it/goto?url=opaque-token)']},
  {id: 'heading-not-snippet', html: link('https://example.test/page', '<h3>Article title</h3><span>Not part of title</span>'),
    links: ['- [Article title](https://example.test/page)']},
  {id: 'goto-needs-heading', html: link('https://www.google.com/goto?url=opaque-token', 'Navigation link'), links: []},
  {id: 'goto-needs-target', html: link('https://www.google.com/goto', '<h3>Navigation heading</h3>'), links: []},
  {id: 'google-navigation', html: link('https://www.google.com/search?q=next', '<h3>Next page</h3>'), links: []},
  {id: 'non-http-links', html: ['javascript:alert(1)', 'mailto:fixture@example.test', 'data:text/plain,fixture', 'file:///fixture']
    .map(url => link(url, '<h3>Not a web page</h3>')).join(''), links: []},
  {id: 'hidden-links', html: ['display:none', 'visibility:hidden', 'opacity:0', 'width:0;height:0;overflow:hidden']
    .map((style, i) => link(`https://example.test/hidden-${i}`, 'Hidden page', style)).join(''), links: []},
  {id: 'deduplicate-target', html: link('https://example.test/page', 'First title') + link('https://example.test/page', 'Second title'),
    links: ['- [First title](https://example.test/page)']},
  {id: 'escape-heading', html: link('https://example.test/page', '<h3>  Source [one]   </h3><span>snippet</span>'),
    links: ['- [Source \\[one\\]](https://example.test/page)']},
  {id: 'link-and-snapshot-bounds', html: Array.from({length: 30}, (_, i) => link(`https://example.test/${i}`, `Result ${i}`)).join('') + '<p>' + 'x'.repeat(5000) + '</p>',
    links: Array.from({length: 20}, (_, i) => `- [Result ${i}](https://example.test/${i})`), snapshotLength: 1200},
];
try {
  assert(process.argv[2], 'Supply the reviewed q36 source directory');
  if (fs.existsSync(path.join(source, '.git'))) {
    const top = command('git', ['-C', source, 'rev-parse', '--show-toplevel']).trim();
    assert.equal(fs.realpathSync(top), source, 'A surrounding repository is not engine provenance');
    report.revision = command('git', ['-C', source, 'rev-parse', 'HEAD']).trim();
  } else {
    const receipt = path.join(source, '.dstudio-source.json');
    assert(fs.existsSync(receipt), 'An archive needs its own source receipt');
    report.revision = JSON.parse(fs.readFileSync(receipt, 'utf8')).commit;
    report.inputs[receipt] = sha(receipt);
  }
  assert(/^[0-9a-f]{40}$/.test(report.revision), 'Missing exact upstream revision');
  report.toolchain = command('cc', ['--version']).trim();
  for (const file of [probe, import.meta.filename, path.join(source, 'q36_web.c'), path.join(source, 'q36_web.h')])
    report.inputs[file] = sha(file);
  const binary = path.join(run, 'native-search-extractor');
  command('cc', ['-std=c11', '-D_DARWIN_C_SOURCE', '-D_POSIX_C_SOURCE=200809L', '-O1', '-I' + source,
    probe, '-o', binary]);
  const script = command(binary, []); report.binarySHA256 = sha(binary);
  writeArtifact(run, 'native-extractor.js', script);
  const playwright = await import('playwright');
  assert(['chromium', 'webkit'].includes(browserKind), 'Use Chromium or WebKit');
  browser = await playwright[browserKind].launch({headless: true});
  const context = await browser.newContext({viewport: {width: 900, height: 700}, serviceWorkers: 'block'});
  const page = await context.newPage();
  let html = '', rejectedRequests = 0;
  await context.route('**/*', route => {
    if (route.request().url() === 'https://www.google.com/search?q=dstudio-fixture')
      return route.fulfill({contentType: 'text/html', body: '<!doctype html><style>a{display:block}h3{margin:0}</style>' + html});
    rejectedRequests++; return route.abort();
  });
  for (const fixture of fixtureCases) {
    const row = {id: fixture.id, passed: false}; report.cases.push(row); save();
    try {
      html = fixture.html;
      await page.goto('https://www.google.com/search?q=dstudio-fixture');
      row.output = await page.evaluate(script);
      const [head, snapshot] = row.output.split('\n## Text snapshot\n');
      row.links = head.split('\n').filter(line => line.startsWith('- ['));
      assert.deepEqual(row.links, fixture.links);
      assert(snapshot.length <= 1200);
      if (fixture.snapshotLength) assert.equal(snapshot.length, fixture.snapshotLength);
      row.passed = true;
    } catch (error) { row.error = String(error.stack || error); }
    save();
    console.log(`${browserKind}/${fixture.id}: ${row.passed ? 'PASS' : 'FAIL'}`);
  }
  report.rejectedRequests = rejectedRequests;
  assert.equal(rejectedRequests, 0, 'Fixture unexpectedly requested an external resource');
  report.inputsUnchanged = Object.entries(report.inputs).every(([file, hash]) => sha(file) === hash);
  assert(report.inputsUnchanged, 'Native/browser inputs changed while the gate ran');
  report.passed = report.cases.every(row => row.passed);
} catch (error) { report.error = String(error.stack || error); console.error(report.error); }
finally {
  if (browser) await browser.close();
  report.finished = new Date().toISOString(); save();
  console.log('Preserved browser extractor evidence: ' + run);
}
if (!report.passed) process.exitCode = 1;
