// SIMULATED: the vision-corpus run loop (tests/support/vision_corpus_runner.mjs)
// against the real model-free host and the page it serves, in headless
// Chromium. Real: the production page, the composer, the PDF reader with
// Poppler (and the OCR helper where one is built), the host's /v1 relay, the
// conversation store, the frozen corpus files and the grader. Simulated: the
// engine is a scripted loopback HTTP server behind the relay whose answers are
// authored here, and the launcher is a status overlay that says which model is
// loaded (the host runs in test mode and starts nothing). No model, no
// weights, no inference: nothing here says how any model reads an image.
//
// UNFINISHED: one scenario (Chat, authored correct answers for one text-layer
// PDF and one image). The scenarios PLAN.MD P4 lists as open (OCR on and off,
// evidence_page_not_sent, hallucination, engine error, Stop, text-only
// isolation, other modes) are not written. `make test-vision-corpus-runner`
// runs it explicitly; no broad gate includes it.
//   node tests/integration/vision_corpus_runner_test.mjs [tests/.build/dstudio-server-test] [build/dstudio-ocr]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { freePort, sleep } from '../support/real_harness.mjs';
import { oracleAnswer } from '../support/vision_corpus_grader.mjs';
import { loadCorpus, runVisionCorpus, selectQuestions } from '../support/vision_corpus_runner.mjs';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.log('vision_corpus_runner_test: Playwright is missing: NOT RUN (not a pass)'); process.exit(1); }

const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const ocrHelper = path.resolve(process.argv[3] || 'build/dstudio-ocr');
assert.ok(fs.existsSync(binary), `test host not built: ${binary}`);
fs.mkdirSync('tests/.artifacts/vision-corpus-runner', { recursive: true });
const run = fs.mkdtempSync(path.resolve('tests/.artifacts/vision-corpus-runner/run-'));
const corpus = loadCorpus();
const everyId = corpus.manifest.items.flatMap((item) => [item.id, ...item.questions.map((q) => q.id)]);
const report = { scope: 'SIMULATED engine and launcher; real host page, PDF reader, relay, store, corpus and grader; no model', checks: [] };
const save = () => fs.writeFileSync(path.join(run, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

const VISION_MODEL = 'gguf/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf';
const TEXT_MODEL = 'gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf';

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

// ---- the scripted engine --------------------------------------------------
// It answers /v1/models and /v1/chat/completions and keeps every body it
// received. `script(body, call)` decides each reply:
//   { text }                 a complete stream (or a JSON reply when the request is not a stream)
//   { status, error }        an HTTP error with an engine-style JSON body
//   { text, hold: deferred } a stream that starts and then waits on a barrier
async function startEngine() {
  const received = [];
  const state = { script: () => ({ text: 'unscripted' }), streaming: deferred() };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'scripted-fixture', context_length: 65536 }] })); return; }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"message":"unscripted endpoint"}}'); return; }
    const body = JSON.parse(raw);
    const call = { raw, body, closed: false };
    received.push(call);
    res.on('close', () => { call.closed = true; call.onClose?.(); });
    const reply = await state.script(body, call);
    if (reply.status) { res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: reply.error } })); return; }
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }] })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const delta = (content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
    if (reply.hold) {
      delta(reply.text.slice(0, 4));
      state.streaming.resolve(call);
      await Promise.race([reply.hold.promise, new Promise((resolve) => { call.onClose = resolve; })]);
      if (call.closed) return;
      delta(reply.text.slice(4));
    } else delta(reply.text);
    res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { port: server.address().port, received, state, close: () => { server.closeAllConnections(); server.close(); } };
}

// ---- the real host in test mode -------------------------------------------
async function startHost(name, enginePort, { ocr }) {
  const dir = path.join(run, name);
  for (const d of ['home', 'data', 'cache', 'ds4/gguf', 'workspace']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ds4/Makefile'), 'all:\n\t@true\n');
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(dir, 'host.log'), 'wx');
  const child = spawn(binary, [String(port), path.join(dir, 'ds4')], { stdio: ['ignore', log, log], detached: true,
    env: { ...process.env, HOME: path.join(dir, 'home'), DS4UI_TEST_MODE: '1', DS4UI_NO_WINDOW: '1', DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1',
      DS4UI_DATA_DIR: path.join(dir, 'data'), DSTUDIO_PDF_CACHE_DIR: path.join(dir, 'cache'), DS4UI_ENGINE_PORT: String(enginePort),
      DSTUDIO_OCR_HELPER: ocr ? ocrHelper : path.join(dir, 'ocr-helper-disabled') } });
  fs.closeSync(log);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let up = false;
  for (let i = 0; i < 200 && !up && child.exitCode === null; i++) {
    try { up = (await fetch(`${base}/api/status`)).ok; } catch { /* starting */ }
    if (!up) await sleep(50);
  }
  assert.ok(up, `the test host did not start: ${fs.readFileSync(path.join(dir, 'host.log'), 'utf8').slice(-2000)}`);
  const real = await (await fetch(`${base}/api/status`)).json();
  assert.equal(real.running, false, 'the test host must not start an engine');
  return { base, dir, child, workspace: path.join(dir, 'workspace'), log: path.join(dir, 'host.log'),
    stop: async () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } await Promise.race([exited, sleep(5000)]); } };
}

// The simulated launcher: the page (and the run loop, which reads the status
// through the page) is told that `modelFile` is loaded and ready, with or
// without active native vision. Everything else in the status is the host's.
function launcher({ modelFile, vision, forbidden, fault }) {
  return async (context) => {
    await context.route('**/api/status', async (route) => {
      const response = await route.fetch();
      const real = await response.json();
      await route.fulfill({ response, json: { ...real, mode: 'server', running: true, ready: true, stage: 'Ready (simulated)', loadPct: 100, ds4dirOk: true, webdirOk: true,
        modelFile, variant: 'flash', variants: { flash: true }, nativeVisionActive: vision, deepseekVisionActive: vision, deepseekVisionInstalled: vision,
        config: { ctx: 65536, power: 100, think: 'off', ssdStreaming: 'off' } } });
    });
    // The real host's System check reports the missing engine and weights of
    // this empty store as fatal and the page opens it over the composer; the
    // simulated launcher reports the loaded model, so its check is clean too.
    await context.route('**/api/doctor', (route) => route.fulfill({ json: { ok: true, ready: true, fatal: 0, warnings: 0, summary: 'Ready (simulated)', checks: [] } }));
    // The page must never try to launch a model in this test.
    await context.route('**/api/start', async (route) => { forbidden.push(`POST /api/start ${route.request().postData()}`); await route.abort(); });
    await context.route('**/api/embed/setup', async (route) => { forbidden.push('POST /api/embed/setup'); await route.abort(); });
    if (fault) await context.addInitScript(fault);
  };
}

async function check(name, fn) {
  const row = { name };
  report.checks.push(row);
  const started = performance.now();
  try { Object.assign(row, await fn()); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1; }
  row.ms = Math.round(performance.now() - started);
  save();
  console.log(`${row.status}: ${name}${row.error ? `\n${row.error}` : ''}`);
}

const questionOfPrompt = (body) => {
  const text = JSON.stringify(body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
  for (const item of corpus.manifest.items) for (const q of item.questions) if (text.includes(JSON.stringify(q.prompt).slice(1, -1))) return { item, q };
  return null;
};
// A planner request gets a plan; an answer request gets the authored answer the scenario chooses.
const scripted = (answerFor) => (body, call) => {
  if (!body.stream) return { text: answerFor.plan || '{"mode":"overview","pages":"","query":""}' };
  const hit = questionOfPrompt(body);
  assert.ok(hit, 'the scripted engine received a question that is not in the corpus');
  return answerFor(hit, body, call);
};

let browser, engine;
const hosts = [];
try {
  browser = await chromium.launch();
  engine = await startEngine();
  const host = await startHost('host-no-ocr', engine.port, { ocr: false });
  hosts.push(host);

  const runCase = async (name, { host: h = host, only, kind, limit, mode = 'chat', expect = 'vision', modelFile = VISION_MODEL, vision = true, fault, script, control, onEvent, freshPerQuestion }) => {
    const runDir = fs.mkdtempSync(path.join(run, `${name}-`));
    const forbidden = [];
    const before = engine.received.length;
    engine.state.script = script;
    const result = await runVisionCorpus({ runDir, baseUrl: h.base, corpus, groups: selectQuestions(corpus.manifest, { only, kind, limit }), mode, expect, browser,
      workspace: h.workspace, freshPerQuestion, control, onEvent, settings: { think: 'off', temperature: 0 },
      prepareContext: launcher({ modelFile, vision, forbidden, fault }), report: { simulated: 'scripted engine and status overlay; no model' } });
    return { result, runDir, forbidden, received: engine.received.slice(before), row: (id) => result.questions.find((r) => r.id === id) };
  };

  // The only scenario so far: authored correct answers for one text-layer PDF
  // and one image. The scenarios listed as open in PLAN.MD P4 are not here yet.
  await check('authored correct answers pass; files attached in order; no item id sent', async () => {
    const out = await runCase('smoke', { only: ['p01', 'i21'], script: scripted(({ item, q }) => ({ text: oracleAnswer(q, item.language) })) });
    for (const r of out.result.questions) console.log(`  ${r.id}: ${r.status} ${r.class} ${r.outcome} ${r.error ? r.error.split('\n')[0] : ''}`);
    assert.deepEqual(out.forbidden, [], 'the page tried to launch a model');
    assert.equal(out.result.summary.denominator, 9);
    assert.equal(out.result.summary.passed, 9, JSON.stringify(out.result.summary));
    const image = out.row('i21-shapes-count-q1');
    assert.deepEqual(image.tiles, ['i21.png']);
    const answer = image.requests.filter((r) => r.kind === 'answer').at(-1);
    assert.equal(answer.imageParts.count, 1);
    assert.equal(answer.imageParts.items[0].corpusFile, 'images/i21.png', 'the image part is the corpus file, byte for byte');
    assert.equal(image.evidence.path, 'pixels');
    const pdf = out.row('p01-marina-notice-q1');
    assert.deepEqual(pdf.tiles, ['p01.pdf']);
    assert.equal(pdf.evidence.path, 'text-layer');
    for (const r of out.result.questions) assert.deepEqual(r.itemIdsSent, [], `${r.id}: an item id reached the engine`);
    for (const call of out.received) assert.ok(!everyId.some((id) => call.raw.includes(id)), 'an item id reached the scripted engine');
    assert.deepEqual(out.result.pageErrors, [], 'the page raised errors');
    return { summary: out.result.summary };
  });
} catch (error) {
  report.error = String(error.stack || error);
  process.exitCode = 1;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  engine?.close();
  for (const h of hosts) await h.stop();
  save();
  const passed = report.checks.filter((row) => row.status === 'PASS').length;
  console.log(`vision_corpus_runner_test: ${passed}/${report.checks.length} passed (SIMULATED engine and launcher; real host, page, PDF reader, relay and grader; no model); ${run}`);
}
