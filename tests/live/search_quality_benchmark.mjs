// Explicit actual-model acceptance/measurement run. One model, identical public
// fixtures and sampling before/after, original failures retained. Source-level
// extraction here executes whole production functions; assertions concern the
// facts/HTTP/pixels, never the presence of implementation strings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { startDStudio, startMode, jsonFetch, completeTextStream } from '../support/real_harness.mjs';
import { searchQualityCases, gradeSearchFacts, SEARCH_QUALITY_FIXTURE_VERSION } from '../fixtures/search_quality_cases.mjs';

assert.ok(process.argv.includes('--run'), 'Pass --run to launch actual weights; this is not a model-free test.');
const root = process.cwd();
fs.mkdirSync('tests/.artifacts', { recursive: true });
const work = fs.mkdtempSync(path.join(root, 'tests/.artifacts/search-quality-live-'));
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const gguf = option('--gguf', 'gguf/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf');
const selected = option('--cases', searchQualityCases.map(t => t.id).join(',')).split(',');
const cases = searchQualityCases.filter(t => selected.includes(t.id));
assert.equal(cases.length, selected.length, 'unknown/duplicate case');
const beforeSource = execFileSync('git', ['show', 'c3329de:extension/search/runtime.js'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const afterSource = fs.readFileSync('extension/search/runtime.js', 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const report = { schema: 'dstudio.search-quality.v1', started: new Date().toISOString(),
  fixtureVersion: SEARCH_QUALITY_FIXTURE_VERSION,
  scope: 'Development acceptance: page read + production evidence extraction, not a complete search-engine/Deep Research or competitor benchmark.',
  host: { cpu: os.cpus()[0].model, memoryBytes: os.totalmem(), platform: os.platform(), arch: os.arch() },
  sources: { before: { revision: 'c3329de', sha256: sha(beforeSource) }, after: { sha256: sha(afterSource) } },
  cases: cases.map(({ html, ...task }) => ({ ...task, fixtureSha256: sha(html) })), runs: [], status: 'running' };
const save = () => fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(report, null, 2));
let host, chrome, chromeLog;
const fixtureServer = http.createServer((req, res) => {
  const task = cases.find(t => req.url === '/' + t.id);
  res.writeHead(task ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(task?.html || '<p>Fixture not found.</p>');
});
const requestLog = [];
const makeRuntime = (source, variant) => new Function('Api', 'Engine', `
  const WEB_CONTEXT_CHARS=1800;
  const WEB_RESEARCH_JUDGE_TIMEOUT_MS=120000;
  ${source}
  return {applyReadResultToSource, extractFactsFromPage};
`)(
  { completeText: async (payload, signal) => {
    const start = performance.now();
    const row = { variant, request: payload, status: 'running' }; requestLog.push(row);
    try {
      const response = await completeTextStream(host.baseUrl, payload.messages, {
        model: payload.model, temperature: payload.temperature, maxTokens: payload.maxTokens,
        thinkLevel: payload.thinkLevel, timeoutMs: 120000, signal,
      });
      Object.assign(row, { response, status: 'complete' });
      assert.equal(response.finishReason, 'stop', 'truncated/incomplete generation is not a passing extraction');
      return response.content;
    } finally {
      row.elapsedMs = performance.now() - start;
      fs.writeFileSync(path.join(work, 'requests.json'), JSON.stringify(requestLog, null, 2));
    }
  } },
  { status: () => jsonFetch(host.baseUrl, '/api/status') },
);

try {
  // The production helper currently owns port 9333. Refuse reuse: this test
  // must never navigate a user's existing debugging/browser session.
  const reservation = net.createServer();
  reservation.listen(9333, '127.0.0.1'); await once(reservation, 'listening');
  await new Promise(resolve => reservation.close(resolve));
  chromeLog = fs.openSync(path.join(work, 'chrome.log'), 'w');
  chrome = spawn(option('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9333',
    `--user-data-dir=${path.join(work, 'chrome-profile')}`, 'about:blank',
  ], { stdio: ['ignore', chromeLog, chromeLog] });
  let browserReady = false;
  for (let i = 0; i < 80; i++) {
    if (chrome.exitCode !== null) throw new Error('isolated Chrome exited');
    try { if ((await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(1000) })).ok) { browserReady = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(browserReady, 'isolated Chrome unavailable');
  host = await startDStudio({ ignoreExternal: true, isolatedEnginePort: true,
    env: { DS4UI_DEFER_ENGINE_START: '1', DSTUDIO_KV_DIR: path.join(work, 'kv') } });
  const launch = { mode: 'server', gguf, ctx: 8192, power: 100, ssdStreaming: 'off', dspark: false, think: 'off', port: host.enginePort };
  report.launch = launch; save();
  console.log(`Starting actual vision model. Receipts: ${path.relative(root, work)}`);
  const loadStart = performance.now();
  const status = await startMode(host.baseUrl, launch, 600000);
  report.loadMs = performance.now() - loadStart;
  assert.equal(status.nativeVisionActive, true, 'the actual engine must have its matching native encoder');
  report.runtime = status;
  report.engineRevision = execFileSync('git', ['-C', host.ds4Dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  report.model = { file: gguf, bytes: fs.statSync(path.join(host.ds4Dir, gguf)).size };
  const runtimes = { before: makeRuntime(beforeSource, 'before'), after: makeRuntime(afterSource, 'after') };
  fixtureServer.listen(0, '127.0.0.1'); await once(fixtureServer, 'listening');
  const fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
  for (const [caseIndex, task] of cases.entries()) {
    // Alternate the order to expose warm/cache asymmetry instead of making
    // every after run benefit from the preceding before run.
    for (const variant of caseIndex % 2 ? ['after', 'before'] : ['before', 'after']) {
      const row = { id: task.id, variant, status: 'running', timings: {} }; report.runs.push(row); save();
      const start = performance.now();
      try {
        const readStart = performance.now();
        const url = fixtureBase + '/' + task.id;
        const read = await jsonFetch(host.baseUrl, '/api/web-read', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ds4web' },
          body: JSON.stringify({ url, includeImage: variant === 'after', cdpOnly: true }), timeoutMs: 120000 });
        row.timings.readMs = performance.now() - readStart;
        assert.equal(read.ok, true);
        row.readChars = read.markdown.length;
        if (task.minReadChars) assert.ok(row.readChars >= task.minReadChars,
          `late-page fixture collapsed to ${row.readChars} chars; minimum ${task.minReadChars}`);
        row.captureStatus = read.visual?.status || 'not_requested';
        if (variant === 'after' && task.visual) {
          assert.equal(read.visual?.status, 'captured', 'HTTP path must deliver real pixels');
          fs.writeFileSync(path.join(work, `${task.id}-page.jpg`), Buffer.from(read.visual.dataUrl.split(',')[1], 'base64'));
        }
        const source = runtimes[variant].applyReadResultToSource({ url, sourceId: 'S1' }, read, task.question);
        row.source = JSON.parse(JSON.stringify(source));
        const extractStart = performance.now();
        const facts = await runtimes[variant].extractFactsFromPage(task.question, source,
          { model: 'ds4', webVisionModel: status.modelFile, webSignal: AbortSignal.timeout(240000) });
        row.timings.extractMs = performance.now() - extractStart;
        row.facts = facts; row.visual = source.visual;
        row.grade = gradeSearchFacts(task, facts);
        row.status = row.grade.pass ? 'pass' : 'fail';
      } catch (error) { row.status = 'fail'; row.error = error.stack; }
      row.timings.totalMs = performance.now() - start;
      save(); console.log(`${variant} / ${task.id}: ${row.status} (${(row.timings.totalMs / 1000).toFixed(1)} s)`);
    }
  }
  report.status = 'complete';
  report.afterAllPass = report.runs.filter(row => row.variant === 'after').every(row => row.status === 'pass');
  save();
  if (!report.afterAllPass) process.exitCode = 1;
} catch (error) { report.status = 'failed'; report.error = error.stack; save(); throw error; }
finally {
  if (host) { fs.copyFileSync(host.logPath, path.join(work, 'engine-host.log')); await host.stop(); }
  fixtureServer.closeAllConnections(); await new Promise(resolve => fixtureServer.close(resolve));
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM'); const timer = setTimeout(() => chrome.kill('SIGKILL'), 5000);
    await once(chrome, 'close'); clearTimeout(timer);
  }
  if (chromeLog !== undefined) fs.closeSync(chromeLog);
}
