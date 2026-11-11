// SIMULATED: the vision-corpus run loop (tests/support/vision_corpus_runner.mjs)
// and the real-model runner's own control flow (tests/live/vision_corpus_live.mjs
// --dry-run) against the real model-free host and the page it serves, in
// headless Chromium. Real: the production page, the composer, the model
// picker, the PDF reader with Poppler and the macOS OCR helper, the host's
// /v1 relay, its /api/start launch path and process ownership, the
// conversation store, the frozen corpus files and the grader. Simulated: the
// engine is a scripted loopback HTTP server whose answers are authored here.
// The scenarios of the run loop tell the page which model is loaded with a
// status overlay (the host starts nothing); the dry run lets the host launch a
// fixture ds4-server (tests/support/vision_corpus_fixture_engine.mjs) from a
// fixture checkout whose model files are a few bytes. No model, no weights, no
// inference: nothing here says how any model reads an image.
//
// Scenarios: authored correct answers; OCR text labelled as OCR and counted
// apart from pixels; evidence_page_not_sent; hallucinated answers to
// unanswerable questions; an engine error and a dropped stream mid-run; Stop
// during an answer; text-only isolation; and the live runner's dry run
// (launch, identities, vision -> text -> vision with the history probe,
// retention, Ctrl-C and --resume, missing weights). Chat only.
//   node tests/integration/vision_corpus_runner_test.mjs [tests/.build/dstudio-server-test] [build/dstudio-ocr]
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
const report = { scope: 'SIMULATED engine and launcher; real host page, launch path, PDF reader, OCR helper, relay, store, corpus and grader; no model', checks: [] };
const save = () => fs.writeFileSync(path.join(run, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

const VISION_MODEL = 'gguf/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf';
const ENCODER = 'gguf/DeepSeek-V4-Flash-Vision-Encoder.gguf';
const TEXT_MODEL = 'gguf/DeepSeek-V4-Flash-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-0731.gguf';
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

// ---- the scripted engine --------------------------------------------------
// It answers /v1/models and /v1/chat/completions and keeps every body it
// received. `script(body, call)` decides each reply:
//   { text }                 a complete stream (or a JSON reply when the request is not a stream)
//   { status, error }        an HTTP error with an engine-style JSON body
//   { text, reset: true }    part of a stream, then the connection drops
//   { text, hold: deferred } a stream that starts and then waits on a barrier
async function startEngine() {
  const received = [], faults = [];
  const state = { script: () => ({ text: 'unscripted' }), streaming: deferred() };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'scripted-fixture', context_length: 65536 }] })); return; }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"message":"unscripted endpoint"}}'); return; }
    const body = JSON.parse(raw);
    // Set by the fixture engine of the dry run: which launch served this request.
    const call = { raw, body, closed: false, model: req.headers['x-fixture-engine-model'] || null, vision: req.headers['x-fixture-engine-vision'] || null, pid: req.headers['x-fixture-engine-pid'] || null };
    received.push(call);
    res.on('close', () => { call.closed = true; call.onClose?.(); });
    let reply;
    try { reply = await state.script(body, call); }
    catch (error) { faults.push(String(error.stack || error)); reply = { status: 500, error: `scripted engine: ${error.message}` }; }
    if (reply.status) { res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: reply.error } })); return; }
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }] })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const delta = (content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
    if (reply.reset) {
      // The engine dies mid-answer: part of the text, then the connection drops.
      delta(reply.text);
      await sleep(100);
      res.socket.destroy();
      return;
    }
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
  return { port: server.address().port, received, faults, state, close: () => { server.closeAllConnections(); server.close(); } };
}

// ---- a fixture checkout for the dry run ------------------------------------
// What the host's real launch path needs to start a Chat engine: sources with
// none of the anchors its patches adapt (every patch skips them), a
// ds4-server that reports decode metrics (the strings the host looks for) and
// execs the fixture engine, and model files that are a few bytes.
function fixtureCheckout(dir) {
  fs.mkdirSync(path.join(dir, 'gguf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Makefile'), 'all:\n\t@true\n');
  for (const name of ['ds4.c', 'ds4.h', 'ds4_help.c', 'ds4_server.c']) fs.writeFileSync(path.join(dir, name), '/* fixture checkout for the vision corpus dry run: no engine source */\n');
  fs.writeFileSync(path.join(dir, 'ds4-server'), `#!/bin/sh\n# fixture ds4-server, no model: decode_tokens_per_second decode_elapsed_seconds\nexec "${process.execPath}" "${path.resolve('tests/support/vision_corpus_fixture_engine.mjs')}" "$@"\n`, { mode: 0o755 });
  const files = {};
  for (const model of [VISION_MODEL, ENCODER, TEXT_MODEL]) {
    const bytes = Buffer.from(`fixture only, not model weights: ${model}\n`);
    fs.writeFileSync(path.join(dir, model), bytes);
    files[model] = sha256(bytes);
  }
  return files;
}

// ---- the real host in test mode -------------------------------------------
async function startHost(name, enginePort, { ocr, checkout, env = {} }) {
  const dir = path.join(run, name);
  for (const d of ['home', 'data', 'cache', 'workspace']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const ds4 = checkout ? checkout(path.join(dir, 'ds4')) && path.join(dir, 'ds4') : path.join(dir, 'ds4');
  if (!checkout) { fs.mkdirSync(path.join(ds4, 'gguf'), { recursive: true }); fs.writeFileSync(path.join(ds4, 'Makefile'), 'all:\n\t@true\n'); }
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(dir, 'host.log'), 'wx');
  const child = spawn(binary, [String(port), ds4], { stdio: ['ignore', log, log], detached: true,
    env: { ...process.env, HOME: path.join(dir, 'home'), DS4UI_TEST_MODE: '1', DS4UI_NO_WINDOW: '1', DS4UI_DEFER_ENGINE_START: '1', DS4UI_HOST: '127.0.0.1',
      DS4UI_DATA_DIR: path.join(dir, 'data'), DSTUDIO_PDF_CACHE_DIR: path.join(dir, 'cache'), DS4UI_ENGINE_PORT: String(enginePort),
      // The ds4 instance lock is machine-wide (/tmp/ds4.lock): a test host
      // would otherwise attach to a real engine of this machine that holds it.
      DS4_LOCK_FILE: path.join(dir, 'ds4.lock'),
      DSTUDIO_OCR_HELPER: ocr ? ocrHelper : path.join(dir, 'ocr-helper-disabled'), ...env } });
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
  return { base, dir, ds4, child, enginePort, workspace: path.join(dir, 'workspace'), log: path.join(dir, 'host.log'),
    // The host's process group: the host and any engine it launched.
    stop: async () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } await Promise.race([exited, sleep(5000)]); } };
}

// The simulated launcher: the page (and the run loop, which reads the status
// through the page) is told that `modelFile` is loaded and ready, with or
// without active native vision. Everything else in the status is the host's.
function launcher({ modelFile, vision, forbidden, fault }) {
  return async (context) => {
    await context.route('**/api/status', async (route) => {
      // A status poll can be in flight when the run closes its context.
      try {
        const response = await route.fetch();
        const real = await response.json();
        await route.fulfill({ response, json: { ...real, mode: 'server', running: true, ready: true, stage: 'Ready (simulated)', loadPct: 100, ds4dirOk: true, webdirOk: true,
          modelFile, variant: 'flash', variants: { flash: true }, nativeVisionActive: vision, deepseekVisionActive: vision, deepseekVisionInstalled: vision,
          config: { ctx: 65536, power: 100, think: 'off', ssdStreaming: 'off' } } });
      } catch (error) { if (!/closed/i.test(String(error?.message))) throw error; }
    });
    // The real host's System check reports the missing engine and weights of
    // this empty store as fatal and the page opens it over the composer; the
    // simulated launcher reports the loaded model, so its check is clean too.
    await context.route('**/api/doctor', (route) => route.fulfill({ json: { ok: true, ready: true, fatal: 0, warnings: 0, summary: 'Ready (simulated)', checks: [] } }).catch(() => {}));
    // The page must never try to launch a model in this test.
    await context.route('**/api/start', async (route) => { forbidden.push(`POST /api/start ${route.request().postData()}`); await route.abort().catch(() => {}); });
    await context.route('**/api/embed/setup', async (route) => { forbidden.push('POST /api/embed/setup'); await route.abort().catch(() => {}); });
    if (fault) await context.addInitScript(fault);
  };
}

// VISION_RUNNER_CHECK=text runs only the checks whose name contains it; the
// others are reported as skipped and the run exits non-zero.
const filter = process.env.VISION_RUNNER_CHECK || '';
async function check(name, fn) {
  const row = { name };
  report.checks.push(row);
  if (filter && !name.includes(filter)) { row.status = 'SKIPPED'; process.exitCode = 1; console.log(`SKIPPED (VISION_RUNNER_CHECK): ${name}`); return; }
  const started = performance.now();
  try { Object.assign(row, await fn()); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1; }
  row.ms = Math.round(performance.now() - started);
  save();
  console.log(`${row.status}: ${name}${row.error ? `\n${row.error}` : ''}`);
}

const userText = (body) => JSON.stringify(body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
const questionOfPrompt = (body) => {
  const text = userText(body);
  for (const item of corpus.manifest.items) for (const q of item.questions) if (text.includes(JSON.stringify(q.prompt).slice(1, -1))) return { item, q };
  return null;
};
// The history probe's question is the runner's own, not a corpus question.
const PROBE = /attached earlier in this conversation|allegato prima in questa conversazione/;
// A planner request gets a plan; an answer request gets the authored answer the scenario chooses.
const scripted = (answerFor) => (body, call) => {
  if (!body.stream) return { text: answerFor.plan || '{"mode":"overview","pages":"","query":""}' };
  if (PROBE.test(userText(body))) return { text: 'I cannot see any image in this conversation; I only have its text.' };
  const hit = questionOfPrompt(body);
  assert.ok(hit, 'the scripted engine received a question that is not in the corpus');
  return answerFor(hit, body, call);
};
const oracle = ({ item, q }) => ({ text: oracleAnswer(q, item.language) });
// Answer requests of one question, from what the engine actually received.
const answerCalls = (received, id) => received.filter((call) => call.body.stream && questionOfPrompt(call.body)?.q.id === id);
const imageParts = (body) => body.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((part) => part?.type === 'image_url') : []);

let browser, engine;
const hosts = [];
// The hosts lead their own process groups (with any engine they launched):
// they must not outlive this test, also when it crashes.
process.on('exit', () => { for (const h of hosts) try { process.kill(-h.child.pid, 'SIGKILL'); } catch { /* gone */ } });
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
    for (const r of result.questions) console.log(`  ${r.id}: ${r.status} ${r.class} ${r.outcome ?? ''}`);
    return { result, runDir, forbidden, received: engine.received.slice(before), row: (id) => result.questions.find((r) => r.id === id) };
  };
  const lastAnswer = (row) => row.requests.filter((r) => r.kind === 'answer').at(-1);

  await check('authored correct answers pass; files attached in order; no item id sent', async () => {
    const out = await runCase('smoke', { only: ['p01', 'i21'], script: scripted(oracle) });
    assert.deepEqual(out.forbidden, [], 'the page tried to launch a model');
    assert.equal(out.result.summary.denominator, 9);
    assert.equal(out.result.summary.passed, 9, JSON.stringify(out.result.summary));
    const image = out.row('i21-shapes-count-q1');
    assert.deepEqual(image.tiles, ['i21.png']);
    const answer = lastAnswer(image);
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

  // A scanned page with the OCR helper on and off. With it, the reader sends
  // the recognised text labelled as OCR beside the page image, and the rows
  // count as answerable from OCR, not as pixel-path evidence; without it, only
  // the page image carries the facts.
  const ocrAvailable = fs.existsSync(ocrHelper);
  const ocrHost = ocrAvailable ? await startHost('host-ocr', engine.port, { ocr: true }) : null;
  if (ocrHost) hosts.push(ocrHost);
  await check('OCR text travels labelled as OCR and is counted apart from the pixel path', async () => {
    assert.ok(ocrAvailable, `NOT RUN (not a pass): the OCR helper ${ocrHelper} is missing; build it with make build/dstudio-ocr (macOS)`);
    const on = await runCase('ocr-on', { host: ocrHost, only: ['p20'], script: scripted(oracle) });
    const off = await runCase('ocr-off', { only: ['p20'], script: scripted(oracle) });
    const facts = ['p20-scan-letter-q1', 'p20-scan-letter-q2', 'p20-scan-letter-q3', 'p20-scan-letter-q4'];
    for (const id of facts) {
      const withOcr = on.row(id), without = off.row(id);
      assert.equal(withOcr.status, 'pass', id);
      const sent = lastAnswer(withOcr).text;
      assert.deepEqual(sent.ocrPages, [1], `${id}: page 1 travels as an OCR block`);
      assert.deepEqual(sent.textLayerPages, [], `${id}: an image-only page has no text layer`);
      assert.ok(withOcr.evidence.facts.some((fact) => fact.inOcrSent), `${id}: the fact is in the OCR text that was sent`);
      assert.ok(withOcr.evidence.facts.every((fact) => !fact.inTextLayerSent), `${id}: OCR text is not counted as text layer`);
      assert.equal(withOcr.evidence.path, 'answerable-from-ocr', id);
      assert.equal(without.status, 'pass', id);
      assert.deepEqual(lastAnswer(without).text.ocrPages, [], `${id}: no OCR without the helper`);
      assert.equal(without.evidence.path, 'pixels', id);
      assert.deepEqual(lastAnswer(without).imageParts.items.map((part) => part.pdfPage?.page), [1], `${id}: the rendered page is the only carrier`);
    }
    assert.equal(on.result.questions[0].pdfReads[0].ocrAvailable, true);
    assert.equal(off.result.questions[0].pdfReads.at(-1).ocrAvailable, false);
    assert.equal(on.result.summary.answerableFromOcrPasses, 4);
    assert.equal(on.result.summary.pixelPathPasses, 0, 'an OCR-answerable pass is not pixel-path evidence');
    assert.equal(off.result.summary.pixelPathPasses, 4);
    assert.equal(off.result.summary.answerableFromOcrPasses, 0);
    return { ocrOn: on.result.summary, ocrOff: off.result.summary };
  });

  // A five-page scan: a whole-document read hands the model four rendered
  // pages, so the fact on page 5 never reaches it. A wrong answer there is an
  // omission of the app, not a reading failure of the model.
  await check('a fact on a page that was not sent fails as evidence_page_not_sent', async () => {
    const wrong = 'Il revisore nominato è Ottavio Brena.';
    const out = await runCase('page-not-sent', { only: ['p26'], script: scripted((hit) => hit.q.id.endsWith('-q4') ? { text: wrong } : oracle(hit)) });
    const row = out.row('p26-scan-registro-q4');
    assert.equal(row.status, 'fail');
    assert.equal(row.class, 'evidence_page_not_sent');
    assert.equal(row.grade.class, 'wrong_value', 'the grade itself still says what the answer was');
    assert.equal(row.answer.text, wrong, 'the raw answer is retained');
    assert.equal(row.evidence.reached, false);
    assert.deepEqual(row.evidence.facts.map((fact) => [fact.page, fact.pixelsSent]), [[5, false]]);
    assert.deepEqual(row.pdfReads.length, 0, 'the follow-up question reuses the first read');
    assert.deepEqual(out.row('p26-scan-registro-q1').pdfReads.at(-1).visionPages.map((p) => p.page), [1, 2, 3, 4]);
    assert.deepEqual(lastAnswer(row).imageParts.items.map((part) => part.pdfPage?.page), [1, 2, 3, 4]);
    for (const id of ['p26-scan-registro-q1', 'p26-scan-registro-q2', 'p26-scan-registro-q3']) {
      assert.equal(out.row(id).status, 'pass', id);
      assert.equal(out.row(id).evidence.path, 'pixels', id);
    }
    assert.equal(out.result.summary.evidenceNotSent, 1);
    return { summary: out.result.summary };
  });

  await check('an invented answer to an unanswerable question fails, with its class', async () => {
    const answers = { 'p01-marina-notice-q4': 'Boats longer than twelve metres pay 690 EUR per quarter.',
      'i21-shapes-count-q5': 'I cannot see a number inside the star, but it is probably 5.' };
    const out = await runCase('hallucination', { only: ['p01-q4', 'i21-q5'], script: scripted(({ q }) => ({ text: answers[q.id] })) });
    assert.equal(out.result.summary.denominator, 2);
    assert.deepEqual([out.row('p01-marina-notice-q4').status, out.row('p01-marina-notice-q4').class], ['fail', 'no_refusal']);
    assert.deepEqual([out.row('i21-shapes-count-q5').status, out.row('i21-shapes-count-q5').class], ['fail', 'refused_then_guessed']);
    for (const [id, text] of Object.entries(answers)) assert.equal(out.row(id).answer.text, text, `${id}: the raw answer is retained`);
    return { classes: out.result.summary.classes };
  });

  await check('an engine error and a dropped stream fail their question only; nothing is retried', async () => {
    const out = await runCase('engine-error', { only: ['i21'], script: scripted((hit) => hit.q.id.endsWith('-q2') ? { status: 500, error: 'scripted engine failure' }
      : hit.q.id.endsWith('-q3') ? { text: 'The answer', reset: true } : oracle(hit)) });
    const http500 = out.row('i21-shapes-count-q2'), dropped = out.row('i21-shapes-count-q3');
    assert.deepEqual([http500.status, http500.class, http500.error], ['fail', 'engine_error', 'scripted engine failure']);
    assert.deepEqual([dropped.status, dropped.class], ['fail', 'engine_error']);
    assert.equal(dropped.answer.text, 'The answer', 'the partial answer is kept');
    assert.match(dropped.error, /interrupted/i);
    for (const id of ['i21-shapes-count-q1', 'i21-shapes-count-q4', 'i21-shapes-count-q5']) assert.equal(out.row(id).status, 'pass', id);
    for (const id of ['i21-shapes-count-q2', 'i21-shapes-count-q3']) assert.equal(answerCalls(out.received, id).length, 1, `${id} reached the engine once`);
    // A failed turn leaves the conversation in an unknown state: the next question starts again with the file.
    const next = out.row('i21-shapes-count-q4');
    assert.ok(next.conversation > dropped.conversation, 'a new conversation after the failure');
    assert.deepEqual(next.tiles, ['i21.png']);
    assert.equal(lastAnswer(next).imageParts.items[0].corpusFile, 'images/i21.png');
    return { summary: out.result.summary };
  });

  await check('Stop during an answer keeps the partial text, closes the engine request and fails only that question', async () => {
    const control = { stopTurn: false, abortRun: false };
    engine.state.streaming = deferred();
    const hold = deferred();
    const running = runCase('stop', { only: ['p01'], control, script: scripted((hit) => hit.q.id.endsWith('-q2') ? { ...oracle(hit), hold } : oracle(hit)) });
    const call = await engine.state.streaming.promise;
    control.stopTurn = true;
    const out = await running;
    hold.resolve();
    assert.equal(call.closed, true, 'Stop closed the engine request');
    const stopped = out.row('p01-marina-notice-q2');
    assert.deepEqual([stopped.status, stopped.class, stopped.outcome], ['fail', 'stopped', 'stopped']);
    assert.equal(stopped.answer.text, 'The', 'the streamed part is kept');
    assert.equal(stopped.answer.finishReason, 'aborted');
    assert.equal(answerCalls(out.received, 'p01-marina-notice-q2').length, 1, 'the stopped question is not asked again');
    for (const id of ['p01-marina-notice-q1', 'p01-marina-notice-q3', 'p01-marina-notice-q4']) assert.equal(out.row(id).status, 'pass', id);
    assert.deepEqual(out.row('p01-marina-notice-q3').tiles, ['p01.pdf'], 'the next question starts again with the file');
    return { summary: out.result.summary };
  });

  // A model without vision: the page refuses images and keeps them, a PDF
  // travels as its text layer only, and a fact that exists only in pixels has
  // an honest limitation as its correct answer. The runner removes a refused
  // file before attaching the next one, as a user would.
  await check('text-only isolation: images refused and kept, nothing visual sent, pixel facts graded as limitations', async () => {
    const limitation = { 'p10-chart-bar-q1': 'The loaf counts are in the chart image, which I cannot see; the text I received does not state them.',
      'p10-chart-bar-q3': 'I cannot read the chart, so I cannot tell how many loaves Alder and Elm baked.',
      'p20-scan-letter-q1': 'The letter is a scan and no text of it reached me, so I cannot tell how many trays were ordered.' };
    const out = await runCase('text-only', { only: ['i21', 'p10', 'p20-q1'], expect: 'text-only', modelFile: TEXT_MODEL, vision: false,
      script: scripted((hit) => limitation[hit.q.id] ? { text: limitation[hit.q.id] } : oracle(hit)) });
    for (const r of out.result.questions.filter((row) => row.item === 'i21-shapes-count')) {
      assert.deepEqual([r.status, r.class, r.outcome], ['pass', 'refused_by_app', 'blocked_by_page'], r.id);
      assert.equal(r.textOnly.attachmentKept, true, r.id);
      assert.deepEqual(r.requests, [], `${r.id}: nothing was sent`);
      assert.equal(answerCalls(out.received, r.id).length, 0, r.id);
    }
    assert.deepEqual(out.row('i21-shapes-count-q2').removedBeforeAttach, ['i21.png'], 'the kept file is removed before the next attach');
    assert.deepEqual([out.row('p10-chart-bar-q1').status, out.row('p10-chart-bar-q1').grade.type], ['pass', 'honest-limitation']);
    assert.equal(out.row('p10-chart-bar-q3').status, 'pass');
    // The oracle answer states a value that no text it received contains.
    assert.deepEqual([out.row('p10-chart-bar-q2').status, out.row('p10-chart-bar-q2').class], ['fail', 'pixel_fact_stated_without_pixels']);
    assert.deepEqual([out.row('p10-chart-bar-q4').status, out.row('p10-chart-bar-q4').evidence.path], ['pass', 'text-layer']);
    assert.equal(out.row('p10-chart-bar-q5').status, 'pass');
    assert.deepEqual([out.row('p20-scan-letter-q1').status, out.row('p20-scan-letter-q1').grade.type], ['pass', 'honest-limitation']);
    for (const read of out.result.questions.flatMap((row) => row.pdfReads || [])) assert.deepEqual([read.textOnly, read.nativeVision, read.visionPages], [true, false, []]);
    for (const call of out.received) assert.deepEqual(imageParts(call.body), [], 'no image part reached the text-only model');
    assert.equal(out.result.summary.visualPayloadViolations, 0);
    return { summary: out.result.summary };
  });

  // ---- the live runner, model-free -----------------------------------------
  // A host launches a fixture ds4-server through its real /api/start path on
  // its own engine port (never the shared 28000). The runner is executed as
  // the maintainer runs it, with --dry-run --host.
  const fixturePort = await freePort();
  let fixtureFiles = null;
  const dry = await startHost('host-dry-run', fixturePort, { ocr: false, checkout: (dir) => (fixtureFiles = fixtureCheckout(dir)),
    env: { DSTUDIO_FIXTURE_ENGINE_UPSTREAM: `http://127.0.0.1:${engine.port}` } });
  hosts.push(dry);
  const runLive = async (name, args, { whileRunning } = {}) => {
    const artifacts = path.join(run, `live-${name}`);
    const before = engine.received.length;
    const child = spawn(process.execPath, ['tests/live/vision_corpus_live.mjs', '--dry-run', '--host', dry.base, ...args, ...(args.includes('--resume') ? [] : ['--artifacts', artifacts])],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    // A fixture engine answers at once: a runner still busy after ten minutes is
    // stuck. It gets its own Ctrl-C first, so it closes its browser.
    const stuck = setTimeout(() => { output += '\n[test] the runner is stuck: SIGTERM\n'; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 30_000).unref(); }, 600_000);
    await whileRunning?.(child);
    const { code, signal } = await exited;
    clearTimeout(stuck);
    fs.writeFileSync(path.join(run, `live-${name}.log`), output);
    const runDir = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : fs.existsSync(artifacts) ? fs.readdirSync(artifacts).filter((d) => d.startsWith('run-')).map((d) => path.join(artifacts, d))[0] : null;
    const json = (rel) => JSON.parse(fs.readFileSync(path.join(runDir, rel), 'utf8'));
    return { code, signal, output, runDir, json, received: engine.received.slice(before) };
  };
  const stopEngine = async () => {
    await fetch(`${dry.base}/api/stop`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'ds4web' }, body: '{}' });
    for (let i = 0; i < 100 && (await (await fetch(`${dry.base}/api/status`)).json()).running; i++) await sleep(100);
  };

  await check('dry run: launch, identities, vision -> text -> vision through the picker, history probe, receipts', async () => {
    engine.state.script = scripted(oracle);
    const out = await runLive('switch', ['--switch-sequence', '--only', 'p01,i21', '--model', VISION_MODEL, '--encoder', ENCODER, '--text-model', TEXT_MODEL, '--ocr', 'off']);
    assert.equal(out.code, 0, `exit ${out.code}\n${out.output.slice(-3000)}`);
    assert.match(out.output, /PASS \(SIMULATED dry run, no model\)/);
    const def = out.json('run.json'), session = out.json('session-1.json');
    assert.equal(def.dryRun, true);
    assert.deepEqual(def.phases.map((p) => [p.name, p.model, p.expect]), [['1-vision', VISION_MODEL, 'vision'], ['2-text', TEXT_MODEL, 'text-only'], ['3-vision', VISION_MODEL, 'vision']]);
    assert.equal(session.preflight.enforced, false);
    const [vision1, text, vision2] = session.phases;
    // What actually ran, from the engine process's own arguments and the files it named.
    for (const [phase, model, encoder] of [[vision1, VISION_MODEL, ENCODER], [text, TEXT_MODEL, null], [vision2, VISION_MODEL, ENCODER]]) {
      const id = phase.identity;
      assert.deepEqual(id.problems, [], phase.name);
      assert.equal(id.engineArgs.model, model, phase.name);
      assert.equal(id.engineArgs.encoder, encoder, phase.name);
      assert.equal(Number(id.engineArgs.port), fixturePort, `${phase.name}: the engine listens on the host's own port`);
      assert.equal(id.model.sha256, fixtureFiles[model], phase.name);
      assert.equal(id.encoder?.sha256 ?? null, encoder ? fixtureFiles[encoder] : null, phase.name);
      assert.equal(id.status.nativeVisionActive, Boolean(encoder), phase.name);
      assert.equal(id.status.modelFile, model, phase.name);
    }
    assert.equal(vision1.launch.via, '/api/start');
    assert.equal(vision1.launch.request.gguf, VISION_MODEL);
    assert.equal(vision1.launch.request.port, undefined, 'a driven host keeps its own engine port');
    for (const phase of [text, vision2]) {
      assert.equal(phase.launch.via, 'model picker', phase.name);
      assert.equal(phase.launch.request.port, undefined, 'the page names no port');
      assert.equal(phase.launch.pageSettings.modelGguf, phase.model, `${phase.name}: the page saved the switch`);
    }
    // Three launches, three engine processes; the text one received no pixels.
    const pids = new Set(out.received.map((call) => call.pid));
    assert.equal(pids.size, 3, 'each phase ran on its own engine process');
    const textCalls = out.received.filter((call) => call.model === TEXT_MODEL);
    assert.ok(textCalls.length > 0);
    for (const call of textCalls) assert.deepEqual(imageParts(call.body), [], 'the text-only engine received no image part');
    assert.ok(out.received.filter((call) => call.model === VISION_MODEL && call.vision === ENCODER).some((call) => imageParts(call.body).length));
    const phaseResults = Object.fromEntries(def.phases.map((p) => [p.name, out.json(`${p.name}/results.json`)]));
    assert.equal(phaseResults['1-vision'].summary.passed, 9);
    assert.equal(phaseResults['3-vision'].summary.passed, 9);
    assert.equal(phaseResults['3-vision'].questions.find((r) => r.id === 'i21-shapes-count-q1').evidence.path, 'pixels', 'vision works again after the switch back');
    const textRows = phaseResults['2-text'].questions;
    assert.deepEqual(textRows.filter((r) => r.item === 'i21-shapes-count').map((r) => r.class), Array(5).fill('refused_by_app'));
    assert.ok(textRows.filter((r) => r.item === 'p01-marina-notice').every((r) => r.status === 'pass' && r.textOnly.violation === false));
    // The text phase first continued the last vision conversation, image in its history.
    const probe = phaseResults['2-text'].historyProbe;
    assert.deepEqual([probe.status, probe.class, probe.item], ['pass', 'history_isolated', 'i21-shapes-count']);
    assert.ok(probe.restored.attachments.some((a) => a.kind === 'image' && a.name === 'i21.png'), 'the restored conversation holds the image');
    assert.deepEqual(probe.visualPayload, []);
    assert.ok(probe.attachmentsAfter.length >= probe.restored.attachments.length, 'nothing dropped from the conversation');
    assert.equal(phaseResults['2-text'].app.pageSettings.modelGguf, TEXT_MODEL, 'the reloaded page selects the text model');
    // Every asked question keeps its request, answer and row.
    for (const p of def.phases) for (const name of fs.readdirSync(path.join(out.runDir, p.name, 'questions'))) {
      const files = fs.readdirSync(path.join(out.runDir, p.name, 'questions', name));
      assert.ok(files.includes('row.json') && files.includes('answer.txt'), `${p.name}/${name}`);
      const row = JSON.parse(fs.readFileSync(path.join(out.runDir, p.name, 'questions', name, 'row.json'), 'utf8'));
      if (row.class !== 'refused_by_app') assert.ok(files.some((f) => /^engine-request-\d+-answer\.json$/.test(f)), `${p.name}/${name}: the answer request is kept`);
    }
    return { phases: session.phases.map((p) => ({ name: p.name, status: p.status, summary: p.summary })) };
  });

  await check('dry run: Ctrl-C interrupts the current answer; --resume asks only what was never asked', async () => {
    await stopEngine();
    const hold = deferred();
    engine.state.streaming = deferred();
    engine.state.script = scripted((hit) => hit.q.id.endsWith('-q2') ? { ...oracle(hit), hold } : oracle(hit));
    const first = await runLive('resume-1', ['--only', 'p01', '--ocr', 'off'], { whileRunning: async (child) => {
      await engine.state.streaming.promise;
      child.kill('SIGINT');
    } });
    hold.resolve();
    assert.equal(first.code, 1, `exit ${first.code}\n${first.output.slice(-3000)}`);
    assert.match(first.output, /INCOMPLETE/);
    const after1 = first.json('1-vision/results.json');
    const status1 = Object.fromEntries(after1.questions.map((r) => [r.id, r.status]));
    assert.deepEqual(status1, { 'p01-marina-notice-q1': 'pass', 'p01-marina-notice-q2': 'interrupted', 'p01-marina-notice-q3': 'not_run', 'p01-marina-notice-q4': 'not_run' });
    assert.equal(after1.questions[1].class, 'interrupted_by_operator');
    assert.equal(first.json('session-1.json').interrupted.signal, 'SIGINT');
    const q1Receipt = path.join(first.runDir, '1-vision', 'questions', '001-p01-marina-notice-q1', 'row.json');
    const q1Bytes = fs.readFileSync(q1Receipt);

    await stopEngine();
    engine.state.script = scripted(oracle);
    const second = await runLive('resume-2', ['--resume', first.runDir]);
    assert.equal(second.code, 1, 'an interrupted question keeps the run incomplete');
    assert.match(second.output, /INCOMPLETE/);
    const after2 = second.json('1-vision/results.json');
    assert.deepEqual(Object.fromEntries(after2.questions.map((r) => [r.id, r.status])),
      { 'p01-marina-notice-q1': 'pass', 'p01-marina-notice-q2': 'interrupted', 'p01-marina-notice-q3': 'pass', 'p01-marina-notice-q4': 'pass' });
    assert.deepEqual(after2.resume, { carried: 2, recoveredFromReceipt: 0, interrupted: 0, toAsk: 2 });
    for (const id of ['p01-marina-notice-q1', 'p01-marina-notice-q2']) assert.equal(answerCalls(second.received, id).length, 0, `${id} is not asked again`);
    for (const id of ['p01-marina-notice-q3', 'p01-marina-notice-q4']) assert.equal(answerCalls(second.received, id).length, 1, `${id} is asked once`);
    assert.deepEqual(after2.questions[2].tiles, ['p01.pdf'], 'the resumed question starts a conversation with the file');
    // Nothing of the first session is erased or rewritten.
    assert.deepEqual(fs.readFileSync(q1Receipt), q1Bytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.runDir, '1-vision', 'results.before-session-2.json'), 'utf8')).questions.map((r) => r.status), Object.values(status1));
    assert.ok(fs.existsSync(path.join(first.runDir, 'session-1.json')) && fs.existsSync(path.join(first.runDir, 'session-2.json')));
    assert.equal(second.json('session-2.json').phases[0].identity.model.sha256, first.json('session-1.json').phases[0].identity.model.sha256);
    // --resume takes the run's own options and nothing else.
    const refused = await runLive('resume-refused', ['--resume', first.runDir, '--only', 'p01-q1']);
    assert.equal(refused.code, 1);
    assert.match(refused.output, /--resume continues the run with its own options; remove --only/);
    return { first: after1.summary, second: after2.summary };
  });

  await check('dry run: missing weights are BLOCKED and nothing is asked', async () => {
    await stopEngine();
    const out = await runLive('blocked', ['--only', 'p01-q1', '--model', 'gguf/not-installed.gguf']);
    assert.equal(out.code, 2);
    assert.match(out.output, /BLOCKED \(SIMULATED dry run, no model\): not installed in .*gguf\/not-installed\.gguf/);
    assert.equal(out.json('session-1.json').status, 'blocked');
    assert.equal(out.received.length, 0, 'no request reached an engine');
    assert.equal(fs.existsSync(path.join(out.runDir, '1-vision')), false);
    return {};
  });
  assert.deepEqual(engine.faults, [], 'the scripted engine received a request it could not answer');
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
  console.log(`vision_corpus_runner_test: ${passed}/${report.checks.length} passed (SIMULATED engine and launcher; real host, page, launch path, PDF reader, OCR helper, relay and grader; no model); ${run}`);
}
