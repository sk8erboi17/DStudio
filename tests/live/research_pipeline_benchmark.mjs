// Complete production Search/Research orchestration + final answer, actual
// public web search/read and one actual engine. No simulated discovery index,
// model answers, competitor claims, or model self-score as a quality oracle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { startDStudio, startMode, jsonFetch, csrfHeaders, completeTextStream, sleep } from '../support/real_harness.mjs';
import { researchPipelineCases } from '../fixtures/research_pipeline_cases.mjs';

assert.ok(process.argv.includes('--run'), 'Pass --run to launch actual weights and browse public websites.');
// Fail before starting a heavy model if a deterministic production regression
// already fails. A shell caller must not accidentally bypass the prerequisite.
execFileSync('make', ['test-search-evidence', 'test-frontend-unit'], { stdio: 'inherit' });
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const root = process.cwd(), work = fs.mkdtempSync(path.join(root, 'tests/.artifacts/research-pipeline-'));
const selected = option('--cases', researchPipelineCases.map(c => c.id).join(',')).split(',');
const cases = researchPipelineCases.filter(t => selected.includes(t.id));
assert.ok(cases.length); assert.equal(cases.length, selected.length, 'Unknown/duplicate case');
const variantNames = option('--variants', 'before,after').split(',');
assert.ok(variantNames.length && variantNames.every(v => ['before', 'after'].includes(v)));
assert.equal(new Set(variantNames).size, variantNames.length, 'Duplicate variant');
const sha = value => createHash('sha256').update(value).digest('hex');
const beforeRevision = option('--before', 'c3329de');
const before = execFileSync('git', ['show', `${beforeRevision}:extension/search/runtime.js`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const after = fs.readFileSync('extension/search/runtime.js', 'utf8');
const report = { schema: 'dstudio.research-pipeline.v1', started: new Date().toISOString(), status: 'running',
  scope: 'Development comparison, complete pipeline and final answer on real public websites; independent semantic answer review required.',
  host: { cpu: os.cpus()[0].model, memoryBytes: os.totalmem() },
  before: { revision: beforeRevision, sha256: sha(before) }, after: { sha256: sha(after) },
  settings: { model: 'ds4', temperature: 0, thinkLevel: 'off', context: 32768, ssdStreaming: 'off', finalMaxTokens: 2800, caseDeadlineMs: 1200000 },
  cases, variants: variantNames, runs: [] };
const save = () => fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(report, null, 2));
let host, chrome, chromeLog, active, activeController, requestId = 0, interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true; activeController?.abort(new DOMException('Benchmark interrupted', 'AbortError'));
});
const invoke = async (payload, signal, phase) => {
  const id = ++requestId, start = performance.now();
  const row = { id, phase, case: active.id, variant: active.variant, request: payload, status: 'running' };
  const file = path.join(work, `request-${String(id).padStart(4, '0')}.json`);
  fs.writeFileSync(file, JSON.stringify(row, null, 2));
  active.requests.push(id); save();
  try {
    const response = await completeTextStream(host.baseUrl, payload.messages, {
      model: payload.model, temperature: payload.temperature, maxTokens: payload.maxTokens,
      thinkLevel: payload.thinkLevel, signal, timeoutMs: 900000,
    });
    row.response = response; row.status = 'complete';
    assert.equal(response.finishReason, 'stop', 'Output budget exhaustion is not a complete answer');
    return response.content;
  } catch (error) { row.status = 'fail'; row.error = error.message; throw error; }
  finally { row.elapsedMs = performance.now() - start; fs.writeFileSync(file, JSON.stringify(row, null, 2)); }
};
const makeRuntime = source => new Function('Api', 'Engine', `
  const WEB_CONTEXT_CHARS = 1800;
  const WEB_SEARCH_PLAN_TIMEOUT_MS = Infinity, WEB_SEARCH_REQUEST_TIMEOUT_MS = Infinity;
  const WEB_RESEARCH_PLAN_TIMEOUT_MS = Infinity, WEB_RESEARCH_JUDGE_TIMEOUT_MS = Infinity, WEB_RESEARCH_TOTAL_TIMEOUT_MS = Infinity;
  function isLanClientMode() { return false; }
  ${source}
  return { runResearchPipeline, DEEP_RESEARCH_SYSTEM_PROMPT, DEEP_RESEARCH_SYNTHESIS_OUTPUT_PROTOCOL,
    researchReportForDelivery: typeof researchReportForDelivery === 'function' ? researchReportForDelivery : null };
`)(
  { completeText: (payload, signal) => invoke(payload, signal, 'pipeline') },
  { status: () => jsonFetch(host.baseUrl, '/api/status', { timeoutMs: 3000 }),
    webSearch: async (query, signal, options = {}) => {
      const start = performance.now();
      const response = await jsonFetch(host.baseUrl, '/api/web-search', { method: 'POST', headers: csrfHeaders,
        signal, timeoutMs: 240000, body: JSON.stringify({ query, preferFallback: !!options.preferFallback, cdpOnly: !!options.cdpOnly }) });
      active.web.push({ type: 'search', query, elapsedMs: performance.now() - start, response }); save(); return response;
    },
    webRead: async (url, signal, options = {}) => {
      const start = performance.now();
      const response = await jsonFetch(host.baseUrl, '/api/web-read', { method: 'POST', headers: csrfHeaders,
        signal, timeoutMs: 120000, body: JSON.stringify({ url, cdpOnly: !!options.cdpOnly, includeImage: options.includeImage === true }) });
      active.web.push({ type: 'read', url, elapsedMs: performance.now() - start, response }); save(); return response;
    },
  },
);
try {
  const reservation = net.createServer(); reservation.listen(9333, '127.0.0.1'); await once(reservation, 'listening');
  await new Promise(resolve => reservation.close(resolve));
  chromeLog = fs.openSync(path.join(work, 'chrome.log'), 'w');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9333',
    `--user-data-dir=${path.join(work, 'chrome-profile')}`, 'about:blank',
  ], { stdio: ['ignore', chromeLog, chromeLog] });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    assert.equal(chrome.exitCode, null, 'Owned browser exited');
    try { if ((await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await sleep(200);
  }
  assert.ok(ready, 'Owned browser not ready');
  const listeners = execFileSync('/usr/sbin/lsof', ['-n', '-P', '-iTCP:9333', '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
    .trim().split(/\s+/).map(Number);
  assert.deepEqual([...new Set(listeners)], [chrome.pid], 'Never navigate an unrelated browser that won a port race');
  host = await startDStudio({ ignoreExternal: true, isolatedEnginePort: true,
    env: { DS4UI_DEFER_ENGINE_START: '1', DSTUDIO_KV_DIR: path.join(work, 'kv') } });
  report.model = 'gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf';
  console.log(`Complete live pipeline benchmark: ${path.relative(root, work)}`); save();
  report.runtime = await startMode(host.baseUrl, { mode: 'server', gguf: report.model, ctx: 32768,
    think: 'off', power: 100, ssdStreaming: 'off', dspark: false, port: host.enginePort }, 600000);
  report.engineRevision = execFileSync('git', ['-C', host.ds4Dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  report.modelBytes = fs.statSync(path.join(host.ds4Dir, report.model)).size;
  const variants = { before: makeRuntime(before), after: makeRuntime(after) };
  for (const [index, task] of cases.entries()) {
    for (const variant of (index % 2 ? ['after', 'before'] : ['before', 'after']).filter(v => variantNames.includes(v))) {
      if (interrupted) break;
      active = { id: task.id, variant, status: 'running', requests: [], web: [], trace: [] };
      report.runs.push(active); save();
      activeController = new AbortController();
      const timer = setTimeout(() => activeController.abort(new DOMException('Case deadline', 'TimeoutError')), report.settings.caseDeadlineMs);
      const start = performance.now();
      try {
        const runtime = variants[variant];
        const result = await runtime.runResearchPipeline(task.question, report.settings, {
          mode: task.mode, signal: activeController.signal, onTrace: trace => { active.trace = trace; save(); },
        });
        active.pipelineMs = performance.now() - start; active.result = result; save();
        // Use the same exact-answer handoff as the app. Historical runtimes
        // still execute their original second writer; do not relabel a draft
        // or skip a production inference merely to improve benchmark latency.
        const delivery = runtime.researchReportForDelivery?.({ mode: task.mode, ...result }, task.question);
        if (delivery) {
          active.answer = delivery.content;
          active.delivery = { complete: delivery.complete, error: delivery.error };
          assert.ok(delivery.complete, delivery.error);
        } else active.answer = await invoke({ model: 'ds4', temperature: 0, thinkLevel: 'off', maxTokens: 2800,
          messages: [
            { role: 'system', content: task.mode === 'research'
              ? runtime.DEEP_RESEARCH_SYSTEM_PROMPT + '\n' + runtime.DEEP_RESEARCH_SYNTHESIS_OUTPUT_PROTOCOL
              : 'Answer the user from the read-source evidence. Cite sources beside supported claims. State gaps; do not invent facts.' },
            { role: 'user', content: task.question + '\n\n' + result.context },
          ] }, activeController.signal, 'final-answer');
        active.primaryRead = task.primary.map(prefix => ({ prefix, read: result.sources.some(source =>
          source.read && [source.url, source.canonicalUrl].some(url => String(url || '').startsWith(prefix))) }));
        active.status = 'completed-pending-independent-review';
      } catch (error) { active.status = 'fail'; active.error = error.stack; }
      finally { clearTimeout(timer); active.totalMs = performance.now() - start; save(); }
      console.log(`${task.id}/${variant}: ${active.status} (${(active.totalMs / 1000).toFixed(1)} s)`);
    }
    if (interrupted) break;
  }
  report.status = interrupted ? 'interrupted' : 'complete'; save();
} catch (error) { report.status = 'failed'; report.error = error.stack; save(); throw error; }
finally {
  if (host) { fs.copyFileSync(host.logPath, path.join(work, 'engine.log')); await host.stop(); }
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM'); const timer = setTimeout(() => chrome.kill('SIGKILL'), 5000);
    await once(chrome, 'close'); clearTimeout(timer);
  }
  if (chromeLog !== undefined) fs.closeSync(chromeLog);
}
