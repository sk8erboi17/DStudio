// REAL inference: the frozen vision corpus (tests/fixtures/vision_corpus)
// through the production host and page, on one selected model at a time.
//
// It starts the production host (tests/support/real_harness.mjs startDStudio,
// isolated engine port, no automatic engine start), launches the model through
// the app (/api/start with the GGUF), records what actually runs (the engine
// process's own arguments, the model and encoder/projector files with their
// SHA-256, the engine checkout's receipt, the effective mode and memory
// settings, the page's selected model) and runs the corpus through the run
// loop of tests/support/vision_corpus_runner.mjs, which grades each final
// answer with tests/support/vision_corpus_grader.mjs. Chat only: the loop's
// Agent, Cowork and Learn paths have never run, not even in simulation.
//
//   node tests/live/vision_corpus_live.mjs [options]       (make test-vision-corpus-live ARGS="...")
//   --model GGUF          vision model (default DeepSeek V4 Flash Vision-Exp IQ2XXS)
//   --encoder GGUF        the encoder or projector the vision model must run with;
//                         the engine's own arguments must name it (missing: BLOCKED)
//   --text-model GGUF     text-only model for --expect text-only and --switch-sequence
//                         (default Qwen3.6-35B-A3B UD-Q6_K_XL, llama.cpp, no projector)
//   --expect text-only    run on --text-model: images must be refused by the app
//                         and nothing visual may reach the model; graded as isolation
//   --switch-sequence     vision -> text -> vision in one host session and one
//                         browser profile; switches use the page's model picker,
//                         each phase reloads the app; the text phase first
//                         continues the last vision conversation (history probe)
//   --ocr on|off          off starts the host without the macOS OCR helper, so
//                         image-only pages reach the model only as pixels; on
//                         (default) reports OCR-answerable rows separately
//   --only a,b            items or questions (p01, i21, p01-q2, full ids)
//   --kind pdf|image  --limit N  --fresh-per-question
//   --think off|high|max (default off)  --ctx N (65536)  --ssd-streaming off|on|auto (off)
//   --hash full|none      SHA-256 of model and encoder files (default full)
//   --resume RUN_DIR      continue a run: only questions never asked are asked;
//                         every asked question keeps its outcome (not for --switch-sequence)
//   --artifacts DIR       parent of run-* (default tests/.artifacts/vision-corpus-live)
//   --binary PATH         host binary (default tests/.build/dstudio-server-test)
//   --host URL --dry-run  SIMULATED: drive an already started host whose engine
//                         is a fixture (tests/integration/vision_corpus_runner_test.mjs);
//                         the resource preflight is recorded, not enforced, and
//                         every model file must be under 1 MiB
//
// No wall-clock cutoff on loading or inference; Ctrl-C stops the current
// question through the page's Stop and ends the run (a second Ctrl-C exits).
// Refuses beside another engine (tests/support/heavy_preflight.mjs); missing
// weights, OCR helper or capability are BLOCKED (exit 2), never a pass. Every
// question's request bodies, engine responses, answer, grade and failure class
// stay under tests/.artifacts/vision-corpus-live/run-*/ and are never erased;
// a failed question is never asked again, in this run or on --resume.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { artifactDir, csrfHeaders, jsonFetch, repoRoot, safeReadTail, sleep, startDStudio } from '../support/real_harness.mjs';
import { contamination, preflight } from '../support/heavy_preflight.mjs';
import { GRADER_VERSION } from '../support/vision_corpus_grader.mjs';
import { EngineFailure, loadCorpus, runVisionCorpus, selectQuestions } from '../support/vision_corpus_runner.mjs';

export const LIVE_SCHEMA = 'dstudio.vision-corpus-live.v1';
const VISION_MODEL = 'gguf/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf';
const TEXT_MODEL = 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf';
const DRY_RUN_MAX_BYTES = 1024 * 1024;
const RESUME_KEEPS = ['--resume', '--host', '--binary', '--dry-run', '--artifacts'];

// ------------------------------------------------------------ options ----

function parseArgs(argv) {
  const o = { model: VISION_MODEL, encoder: '', textModel: TEXT_MODEL, expect: 'vision', switchSequence: false, ocr: 'on', only: [], kind: '', limit: 0,
    freshPerQuestion: false, think: 'off', ctx: 65536, ssdStreaming: 'off', hash: 'full', resume: '', artifacts: '', binary: '', host: '', dryRun: false,
    mode: 'chat', given: [] };
  const value = (i, name) => { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--help' || name === '-h') { o.help = true; continue; }
    o.given.push(name);
    switch (name) {
      case '--model': o.model = value(i++, name); break;
      case '--encoder': o.encoder = value(i++, name); break;
      case '--text-model': o.textModel = value(i++, name); break;
      case '--expect': o.expect = value(i++, name); break;
      case '--switch-sequence': o.switchSequence = true; break;
      case '--ocr': o.ocr = value(i++, name); break;
      case '--only': o.only = value(i++, name).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--kind': o.kind = value(i++, name); break;
      case '--limit': o.limit = Number(value(i++, name)); break;
      case '--fresh-per-question': o.freshPerQuestion = true; break;
      case '--think': o.think = value(i++, name); break;
      case '--ctx': o.ctx = Number(value(i++, name)); break;
      case '--ssd-streaming': o.ssdStreaming = value(i++, name); break;
      case '--hash': o.hash = value(i++, name); break;
      case '--resume': o.resume = value(i++, name); break;
      case '--artifacts': o.artifacts = value(i++, name); break;
      case '--binary': o.binary = value(i++, name); break;
      case '--host': o.host = value(i++, name).replace(/\/+$/, ''); break;
      case '--dry-run': o.dryRun = true; break;
      case '--mode': o.mode = value(i++, name); break;
      default: throw new Error(`unknown option ${name} (see --help)`);
    }
  }
  if (o.mode !== 'chat') throw new Error(`--mode ${o.mode}: the run loop's Agent, Cowork and Learn paths have never run, not even in simulation; only chat is supported`);
  assert.ok(['vision', 'text-only'].includes(o.expect), '--expect is vision or text-only');
  assert.ok(['on', 'off'].includes(o.ocr), '--ocr is on or off');
  assert.ok(['off', 'high', 'max'].includes(o.think), '--think is off, high or max');
  assert.ok(['off', 'on', 'auto'].includes(o.ssdStreaming), '--ssd-streaming is off, on or auto');
  assert.ok(['full', 'none'].includes(o.hash), '--hash is full or none');
  assert.ok(Number.isInteger(o.ctx) && o.ctx >= 1024, '--ctx is a token count');
  assert.ok(Number.isInteger(o.limit) && o.limit >= 0, '--limit is a count');
  assert.ok(!(o.switchSequence && o.expect === 'text-only'), '--switch-sequence runs both models; do not combine it with --expect text-only');
  assert.ok(!o.dryRun || o.host, '--dry-run drives an already started test host: give --host');
  for (const file of [o.model, o.textModel, ...(o.encoder ? [o.encoder] : [])]) assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'), `${file}: a model is a path relative to the engine folder`);
  return o;
}

// The phases a run consists of; fixed in run.json when the run is created.
function phasesOf(o) {
  if (o.switchSequence) return [
    { name: '1-vision', model: o.model, expect: 'vision', launch: 'api' },
    { name: '2-text', model: o.textModel, expect: 'text-only', launch: 'picker', historyProbe: true },
    { name: '3-vision', model: o.model, expect: 'vision', launch: 'picker' },
  ];
  return o.expect === 'text-only' ? [{ name: '1-text-only', model: o.textModel, expect: 'text-only', launch: 'api' }]
    : [{ name: '1-vision', model: o.model, expect: 'vision', launch: 'api' }];
}

// ------------------------------------------------------------ identity ----

const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 }).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});

// A file's identity. The digest is computed once per run and reused while
// size, modification time and inode are unchanged (a resumed run rechecks those).
async function fileIdentity(file, cache, hashMode) {
  let st;
  try { st = fs.statSync(file); } catch { return { path: file, present: false }; }
  const real = fs.realpathSync(file);
  // An MLX model is a directory of safetensors and configuration files: its
  // digest covers every file's relative path, size and SHA-256.
  if (st.isDirectory()) {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full); else if (entry.isFile()) files.push(full);
        if (files.length > 1024) throw new Error(`${file}: more than 1024 files`);
      }
    };
    walk(real);
    const parts = [];
    for (const part of files) parts.push({ rel: path.relative(real, part), ...(await fileIdentity(part, cache, hashMode)) });
    const listing = parts.map((part) => `${part.rel}\t${part.bytes}\t${part.sha256}`).join('\n');
    return { path: file, realpath: real, present: true, kind: 'directory', bytes: parts.reduce((n, part) => n + part.bytes, 0),
      sha256: hashMode === 'none' ? null : crypto.createHash('sha256').update(listing).digest('hex'),
      files: parts.map(({ rel, bytes, sha256 }) => ({ path: rel, bytes, sha256 })) };
  }
  const key = `${real}|${st.size}|${st.mtimeMs}|${st.ino}`;
  const out = { path: file, realpath: real, present: true, bytes: st.size, mtime: st.mtime.toISOString(), inode: st.ino };
  if (hashMode === 'none') return { ...out, sha256: null, hash: 'not computed (--hash none)' };
  if (!cache[key]) {
    const started = performance.now();
    cache[key] = { sha256: await sha256File(real), ms: Math.round(performance.now() - started), at: new Date().toISOString() };
  }
  return { ...out, sha256: cache[key].sha256, hashMs: cache[key].ms, hashedAt: cache[key].at };
}

const samePath = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); } };

function processInfo(pid) {
  try {
    const command = execFileSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 }).trim();
    const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 }).trim();
    return { pid, started, command, argv: command.split(/\s+/) };
  } catch { return { pid, gone: true }; }
}

function listenerPid(port) {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', timeout: 10_000 });
    return Number(/^p(\d+)$/m.exec(out)?.[1] || 0);
  } catch { return 0; }
}

const flag = (argv, ...names) => { for (const name of names) { const at = argv.indexOf(name); if (at >= 0) return argv[at + 1] ?? ''; } return null; };

function gitIdentity() {
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean).length;
    return { revision, dirtyEntries: dirty };
  } catch (error) { return { error: String(error.message).slice(0, 200) }; }
}

// --------------------------------------------------------------- main -----

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\nimport ')[0].replace(/^\/\/ ?/gm, '')); return 0; }

  // ---- the run directory and its fixed definition
  const corpus = loadCorpus();
  let runDir, def;
  if (opts.resume) {
    runDir = path.resolve(opts.resume);
    def = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(def.schema, LIVE_SCHEMA, `${runDir} is not a vision corpus live run`);
    const extra = opts.given.filter((name) => name.startsWith('--') && !RESUME_KEEPS.includes(name));
    assert.deepEqual(extra, [], `--resume continues the run with its own options; remove ${extra.join(', ')}`);
    assert.ok(!def.options.switchSequence, 'a switch sequence measures switches within one host session; a resumed one would not: start a new run');
    assert.equal(opts.dryRun, def.dryRun, def.dryRun ? 'this run is a dry run: resume it with --dry-run --host' : 'this run used real weights: --dry-run cannot resume it');
    assert.equal(corpus.manifestSha256, def.corpus.manifestSha256, 'the corpus manifest changed since this run started');
    Object.assign(opts, def.options, { resume: opts.resume, host: opts.host, binary: opts.binary, dryRun: def.dryRun });
  } else {
    const parent = path.resolve(opts.artifacts || artifactDir('vision-corpus-live'));
    fs.mkdirSync(parent, { recursive: true });
    runDir = fs.mkdtempSync(path.join(parent, 'run-'));
  }
  const groups = selectQuestions(corpus.manifest, { only: opts.only, kind: opts.kind, limit: opts.limit });
  const questionIds = groups.flatMap(({ questions }) => questions.map((q) => q.id));
  if (!def) {
    def = { schema: LIVE_SCHEMA, created: new Date().toISOString(), dryRun: opts.dryRun,
      scope: opts.dryRun ? 'SIMULATED dry run: fixture engine and scripted answers, no model' : 'REAL inference through the production host and page',
      options: { mode: opts.mode, model: opts.model, textModel: opts.textModel, expect: opts.expect, switchSequence: opts.switchSequence, ocr: opts.ocr,
        encoder: opts.encoder, only: opts.only, kind: opts.kind, limit: opts.limit, freshPerQuestion: opts.freshPerQuestion, think: opts.think, ctx: opts.ctx, ssdStreaming: opts.ssdStreaming, hash: opts.hash },
      phases: phasesOf(opts), corpus: { directory: path.relative(repoRoot, corpus.root), manifestSha256: corpus.manifestSha256 }, grader: GRADER_VERSION, questions: questionIds };
    fs.writeFileSync(path.join(runDir, 'run.json'), `${JSON.stringify(def, null, 2)}\n`, { flag: 'wx' });
  }
  assert.deepEqual(questionIds, def.questions, 'the selection no longer names the same questions');

  const sessionNo = fs.readdirSync(runDir).filter((name) => /^session-\d+\.json$/.test(name)).length + 1;
  const sessionFile = path.join(runDir, `session-${sessionNo}.json`);
  const session = { schema: LIVE_SCHEMA, session: sessionNo, started: new Date().toISOString(), argv: process.argv.slice(2), dryRun: opts.dryRun,
    scope: def.scope, dstudio: gitIdentity(), node: process.version, phases: [], problems: [], status: 'running' };
  const saveSession = () => fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`);
  saveSession();
  const hashCacheFile = path.join(runDir, 'file-digests.json');
  const hashCache = fs.existsSync(hashCacheFile) ? JSON.parse(fs.readFileSync(hashCacheFile, 'utf8')) : {};
  const saveHashes = () => fs.writeFileSync(hashCacheFile, `${JSON.stringify(hashCache, null, 2)}\n`);
  const label = (s) => `${s.toUpperCase()}${opts.dryRun ? ' (SIMULATED dry run, no model)' : ''}`;
  const finish = (status, reason) => {
    session.status = status; if (reason) session.reason = reason;
    session.finished = new Date().toISOString(); saveSession();
    fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify({ schema: LIVE_SCHEMA, session: sessionNo, status, reason, dryRun: opts.dryRun, phases: session.phases.map(({ name, model, summary, historyProbe, status: phaseStatus }) => ({ name, model, status: phaseStatus, summary, historyProbe })) }, null, 2)}\n`);
    console.log(`vision-corpus-live: ${label(status)}${reason ? `: ${reason}` : ''} (${path.relative(process.cwd(), runDir)})`);
    return status === 'pass' ? 0 : status === 'blocked' ? 2 : 1;
  };

  // ---- Ctrl-C: Stop the current question through the page, then end the run.
  const control = { stopTurn: false, abortRun: false };
  let interrupts = 0;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (++interrupts > 1) { session.status = 'interrupted'; saveSession(); process.exit(130); }
    control.abortRun = true; session.interrupted = { signal, at: new Date().toISOString() }; saveSession();
    console.log(`vision-corpus-live: ${signal}: stopping the current question; the remaining ones stay not run (resume with --resume ${path.relative(process.cwd(), runDir)})`);
  });

  // ---- resources: never start a model beside another engine
  const external = Boolean(opts.host);
  const hostPid = external ? listenerPid(new URL(opts.host).port || 80) : 0;
  const ownerPid = [process.pid, ...(hostPid ? [hostPid] : [])];
  const before = preflight({ ownerPid, dir: runDir });
  session.preflight = { before, enforced: !opts.dryRun };
  saveSession();
  if (!before.ok && !opts.dryRun) return finish('blocked', `another engine holds memory: ${before.reasons.join('; ')}`);
  if (!before.ok) session.preflight.note = 'not enforced: a dry run loads fixture files of at most 1 MiB';

  // ---- the host
  let server = null, browser = null, context = null;
  const ocrHelper = path.join(repoRoot, 'build', 'dstudio-ocr');
  try {
    if (external) {
      server = { baseUrl: opts.host, external: true, enginePort: null, stop: async () => {} };
      session.host = { external: true, baseUrl: opts.host, process: hostPid ? processInfo(hostPid) : null,
        ocr: { requested: opts.ocr, enforced: false, note: 'an external host keeps its own OCR helper; OCR text that reached the model is reported per question' } };
    } else {
      if (opts.ocr === 'on' && process.platform === 'darwin' && !fs.existsSync(ocrHelper)) return finish('blocked', `--ocr on needs the OCR helper ${path.relative(repoRoot, ocrHelper)} (make build/dstudio-ocr)`);
      server = await startDStudio({ binaryArg: opts.binary || undefined, label: 'vision-corpus-live', ignoreExternal: true, isolatedEnginePort: true,
        env: { DS4UI_DEFER_ENGINE_START: '1', DSTUDIO_OCR_HELPER: opts.ocr === 'off' ? path.join(runDir, 'ocr-helper-disabled') : ocrHelper } });
      const binary = server.child.spawnfile;
      session.host = { external: false, baseUrl: server.baseUrl, enginePort: server.enginePort, pid: server.child.pid, binary: { path: binary, ...(await fileIdentity(binary, hashCache, 'full')) },
        engineDir: server.ds4Dir, logPath: server.logPath, ocr: { requested: opts.ocr, enforced: true, helper: opts.ocr === 'off' ? 'a missing file: the host has no OCR' : ocrHelper } };
    }
    saveSession();
    const base = server.baseUrl;
    const status = () => jsonFetch(base, '/api/status', { timeoutMs: 15_000 });

    // ---- the weights: present (and, for a dry run, tiny) before anything starts
    const catalog = (await jsonFetch(base, '/api/ggufs', { timeoutMs: 60_000 })).ggufs || [];
    const engineDir = (await status()).ds4dir;
    const needed = [...new Set([...def.phases.map((phase) => phase.model), ...(opts.encoder && def.phases.some((phase) => phase.expect === 'vision') ? [opts.encoder] : [])])];
    const missing = needed.filter((model) => !catalog.some((g) => g.path === model && path.resolve(g.engineDir || engineDir) === path.resolve(engineDir)));
    session.weights = needed.map((model) => ({ model, installed: !missing.includes(model), bytes: catalog.find((g) => g.path === model)?.size ?? null }));
    saveSession();
    if (missing.length) return finish('blocked', `not installed in ${engineDir}: ${missing.join(', ')}`);
    if (opts.dryRun) {
      const big = session.weights.filter((w) => !(w.bytes <= DRY_RUN_MAX_BYTES));
      if (big.length) return finish('blocked', `a dry run must not load weights: ${big.map((w) => `${w.model} is ${w.bytes} bytes`).join(', ')}`);
    }

    let currentModel = null;
    const assertAlive = async () => {
      if (server.child && server.child.exitCode !== null) throw new EngineFailure(`the host exited (code ${server.child.exitCode})`);
      let st;
      try { st = await status(); } catch (error) { throw new EngineFailure(`the host did not answer /api/status: ${error.message}`); }
      if (!st.running || st.modelFile !== currentModel) throw new EngineFailure(`the engine is not running ${currentModel} (running ${st.running}, model ${st.modelFile}, error ${st.engineError || 'none'})`);
    };
    // Loading is model work: no wall-clock limit, only liveness and the engine's own error.
    const waitReady = async (model) => {
      const started = performance.now();
      for (;;) {
        if (server.child && server.child.exitCode !== null) throw new EngineFailure(`the host exited while loading (code ${server.child.exitCode})`);
        if (control.abortRun) throw new EngineFailure('the run was interrupted while the model loaded');
        const st = await status();
        if (st.ready && st.running && st.mode === 'server' && st.modelFile === model && !st.launchTaskId) return { status: st, readyMs: Math.round(performance.now() - started) };
        if (!st.running && st.engineError && !st.launchTaskId) throw new EngineFailure(`the engine did not start: ${st.engineError}`);
        await sleep(1000);
      }
    };
    const launch = async (model) => {
      const request = { mode: 'server', model: 'standard', variant: 'flash', gguf: model, ctx: opts.ctx, power: 100, think: opts.think,
        ssdStreaming: opts.ssdStreaming, workdir: '', ...(server.enginePort ? { port: server.enginePort } : {}) };
      const reply = await jsonFetch(base, '/api/start', { method: 'POST', headers: csrfHeaders, body: JSON.stringify(request), timeoutMs: 0 });
      if (reply.ok === false) throw new EngineFailure(`the host refused the launch: ${JSON.stringify(reply)}`);
      // The host adopts a ds4 engine that already holds the port or the
      // machine-wide instance lock instead of starting one: that engine is
      // not the selected model's launch, whatever it serves.
      if (reply.shared) throw new EngineFailure(`the host attached to an existing DS4 engine instead of launching ${model}: ${JSON.stringify(reply)} (stage: ${(await status()).stage})`);
      currentModel = model;
      return { via: '/api/start', request, reply, ...(await waitReady(model)) };
    };
    // The user's path: the composer's model picker, which saves the page's
    // selection and asks the host to switch (the page sends no port).
    const switchInPage = async (model) => {
      const page = await context.newPage();
      try {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.locator('#composer-input').waitFor({ state: 'visible', timeout: 60_000 });
        await page.locator('#cbar-model .cbar-model-btn').click();
        const menu = page.getByRole('dialog', { name: 'Choose a model' });
        await menu.getByRole('textbox', { name: 'Search models' }).fill(path.basename(model));
        const row = menu.locator('.cbar-model-item').filter({ hasText: path.basename(model) });
        await row.first().waitFor({ state: 'visible', timeout: 60_000 });
        assert.equal(await row.count(), 1, `the model picker lists ${path.basename(model)} ${await row.count()} times`);
        // The host answers /api/start once the launch is prepared: building a runtime is not bounded here.
        const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/start' && r.request().method() === 'POST', { timeout: 0 });
        await row.click();
        const response = await answered;
        const request = JSON.parse(response.request().postData() || '{}');
        const reply = await response.json().catch(() => ({}));
        if (reply.ok === false) throw new EngineFailure(`the host refused the page's launch: ${JSON.stringify(reply)}`);
        if (reply.shared) throw new EngineFailure(`the host attached to an existing DS4 engine instead of launching ${model}: ${JSON.stringify(reply)}`);
        currentModel = model;
        const ready = await waitReady(model);
        await page.waitForFunction(() => !document.querySelector('#loading-overlay:not([hidden])'), null, { timeout: 60_000 }).catch(() => {});
        const pageSettings = await page.evaluate(() => { try { const s = JSON.parse(localStorage.getItem('ds4web.settings.v2') || 'null'); return s && { model: s.model ?? null, modelGguf: s.modelGguf ?? null }; } catch { return null; } });
        return { via: 'model picker', request, reply, pageSettings, ...ready };
      } finally { await page.close().catch(() => {}); }
    };
    // What actually runs: the engine process's arguments and the files they name.
    const identify = async (phase) => {
      const st = await status();
      const diagnostics = await jsonFetch(base, '/api/diagnostics', { timeoutMs: 15_000 }).catch(() => null);
      const pid = st.residentPid || diagnostics?.runtime?.pid || 0;
      const proc = pid > 0 ? processInfo(pid) : null;
      const argv = proc?.argv || [];
      const dir = st.ds4dir || engineDir;
      const resolve = (rel) => rel ? (path.isAbsolute(rel) ? rel : path.join(dir, rel)) : null;
      // MLX runs as `python -m mlx_lm server --model DIR`: --model before -m.
      const modelArg = flag(argv, '--model', '-m'), encoderArg = flag(argv, '--vision', '--mmproj');
      const id = { at: new Date().toISOString(),
        status: { mode: st.mode, running: st.running, ready: st.ready, stage: st.stage, modelFile: st.modelFile, ds4dir: st.ds4dir, config: st.config,
          nativeVisionActive: st.nativeVisionActive, deepseekVisionActive: st.deepseekVisionActive, glmVisionActive: st.glmVisionActive,
          deepseekVisionInstalled: st.deepseekVisionInstalled, glmVisionInstalled: st.glmVisionInstalled, residentPid: st.residentPid },
        engineProcess: proc, engineArgs: { model: modelArg, encoder: encoderArg, port: flag(argv, '--port'), ctx: flag(argv, '--ctx', '--ctx-size', '-c', '--max-tokens'), ssdStreaming: argv.includes('--ssd-streaming') },
        model: await fileIdentity(resolve(phase.model), hashCache, opts.hash),
        encoder: encoderArg ? await fileIdentity(resolve(encoderArg), hashCache, opts.hash) : null,
        engineCheckout: (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.dstudio-source.json'), 'utf8')); } catch { return null; } })(),
        servedModels: await jsonFetch(base, '/v1/models', { timeoutMs: 30_000 }).catch((error) => ({ error: error.message })) };
      saveHashes();
      // The engine must have opened the selected file; the app's vision flag must match the encoder it was given.
      const problems = [];
      if (!proc || proc.gone) problems.push('no engine process found for the running model');
      else if (modelArg && !samePath(resolve(modelArg), resolve(phase.model))) problems.push(`the engine opened ${modelArg}, not ${phase.model}`);
      if (phase.expect === 'vision' && !encoderArg) problems.push('the engine was started without a vision encoder or projector');
      else if (phase.expect === 'vision' && opts.encoder && !samePath(resolve(encoderArg), resolve(opts.encoder))) problems.push(`the engine was started with ${encoderArg}, not --encoder ${opts.encoder}`);
      if (phase.expect === 'text-only' && encoderArg) problems.push(`the text-only model was started with ${encoderArg}`);
      if (Boolean(encoderArg) !== (st.nativeVisionActive === true)) problems.push(`the app reports nativeVisionActive ${st.nativeVisionActive} with encoder ${encoderArg || 'none'}`);
      if (server.enginePort && Number(id.engineArgs.port) !== server.enginePort && !st.residentPid) problems.push(`the engine listens on ${id.engineArgs.port}, not the host's isolated port ${server.enginePort}`);
      id.problems = problems;
      return id;
    };

    // ---- the browser: one profile for the whole session
    let chromium;
    try { ({ chromium } = await import('playwright')); } catch { return finish('blocked', 'Playwright is missing'); }
    browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false });
    context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    session.browser = { name: 'chromium', version: browser.version() };

    let previousProbeItem = null;
    for (const [index, phase] of def.phases.entries()) {
      const phaseDir = path.join(runDir, phase.name);
      fs.mkdirSync(phaseDir, { recursive: true });
      const resultsFile = path.join(phaseDir, 'results.json');
      let previous = null;
      if (fs.existsSync(resultsFile)) {
        previous = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
        // The ledger is updated in place; keep the state this session started from.
        fs.copyFileSync(resultsFile, path.join(phaseDir, `results.before-session-${sessionNo}.json`), fs.constants.COPYFILE_EXCL);
      }
      const entry = { name: phase.name, model: phase.model, expect: phase.expect, dir: path.relative(runDir, phaseDir), status: 'running' };
      session.phases.push(entry);
      saveSession();
      if (control.abortRun) { entry.status = 'not_run'; break; }
      try {
        entry.launch = index === 0 || phase.launch === 'api' ? await launch(phase.model) : await switchInPage(phase.model);
        entry.identity = await identify(phase);
      } catch (error) {
        entry.status = 'fail'; entry.error = String(error.stack || error).slice(0, 4000);
        session.problems.push(`${phase.name}: ${error.message}`); saveSession();
        break;
      }
      saveSession();
      if (entry.identity.problems.length) {
        session.problems.push(...entry.identity.problems.map((p) => `${phase.name}: ${p}`));
        entry.status = 'fail'; saveSession();
        break;
      }
      if (phase.historyProbe && !previousProbeItem) session.problems.push(`${phase.name}: history probe not run: the previous phase asked no question`);
      const relaunches = [];
      const report = { scope: def.scope, phase: phase.name, session: sessionNo, identity: entry.identity };
      const result = await runVisionCorpus({ runDir: phaseDir, baseUrl: base, corpus, groups, mode: opts.mode, expect: phase.expect, browser, context,
        settings: { think: opts.think, temperature: 0 }, freshPerQuestion: opts.freshPerQuestion, control, report, previous,
        historyProbe: phase.historyProbe && previousProbeItem ? { item: previousProbeItem } : undefined,
        assertAlive,
        // An engine that died is started again for the next question (recorded); the failed one is not asked again.
        afterFailure: async ({ row }) => {
          let st = null; try { st = await status(); } catch { /* checked below */ }
          if (st?.running && st.modelFile === currentModel) return {};
          const relaunch = { after: row.id, at: new Date().toISOString(), before: st && { running: st.running, engineError: st.engineError, modelFile: st.modelFile } };
          relaunches.push(relaunch);
          Object.assign(relaunch, await launch(phase.model));
          relaunch.identity = await identify(phase);
          if (relaunch.identity.problems.length || relaunch.identity.model.sha256 !== entry.identity.model.sha256 ||
            relaunch.identity.encoder?.sha256 !== entry.identity.encoder?.sha256) throw new Error(`the relaunched engine is not the same model: ${relaunch.identity.problems.join('; ') || 'different files'}`);
          return { reload: true };
        } });
      entry.relaunches = relaunches.length ? relaunches : undefined;
      entry.summary = result.summary;
      entry.historyProbe = result.historyProbe ? { status: result.historyProbe.status, class: result.historyProbe.class, item: result.historyProbe.item } : undefined;
      entry.status = result.status || 'fail';
      // OCR text that reached the model in a run meant to have none.
      const ocrRows = result.questions.filter((row) => (row.requests || []).some((r) => r.text?.ocrChars > 0)).map((row) => row.id);
      entry.ocrTextSent = { questions: ocrRows.length, ...(opts.ocr === 'off' && ocrRows.length ? { violation: true, ids: ocrRows } : {}) };
      if (opts.ocr === 'off' && ocrRows.length) { entry.status = 'fail'; session.problems.push(`${phase.name}: OCR text reached the model in an --ocr off run (${ocrRows.length} questions)`); }
      saveSession();
      const lastAsked = [...result.questions].reverse().find((row) => row.status !== 'not_run' && row.status !== 'blocked' && !row.carried);
      previousProbeItem = lastAsked ? groups.find(({ item }) => item.id === lastAsked.item)?.item : null;
      if (control.abortRun) break;
    }
    for (const phase of def.phases.slice(session.phases.length)) session.phases.push({ name: phase.name, model: phase.model, expect: phase.expect, status: 'not_run' });

    // ---- the outcome
    session.preflight.after = preflight({ ownerPid, dir: runDir });
    session.preflight.contamination = contamination(before, session.preflight.after);
    if (session.preflight.contamination.length && !opts.dryRun) session.problems.push(...session.preflight.contamination.map((line) => `contaminated: ${line}`));
    // pass: every question of every phase passed and nothing else went wrong.
    // blocked: the selection lacked the capability the run is about (no question asked).
    // incomplete: questions stayed unasked or were interrupted, and none failed.
    const phases = session.phases;
    const allBlocked = phases.every((p) => p.summary && p.summary.blocked === p.summary.denominator);
    const anyFailed = phases.some((p) => p.summary?.failed > 0 || p.historyProbe?.status === 'fail' || (p.status === 'fail' && !p.summary));
    const anyOpen = phases.some((p) => p.status === 'not_run' || p.summary?.notRun > 0 || p.summary?.interrupted > 0 || p.summary?.pending > 0);
    const verdict = session.problems.length || anyFailed ? 'fail' : allBlocked ? 'blocked' : anyOpen ? 'incomplete'
      : phases.every((p) => p.status === 'pass') ? 'pass' : 'fail';
    for (const phase of phases) if (phase.summary) {
      const s = phase.summary;
      console.log(`  ${phase.name} (${phase.model}): ${s.passed}/${s.denominator} passed, ${s.failed} failed, ${s.interrupted} interrupted, ${s.notRun} not run, ${s.blocked} blocked; pixel-path passes ${s.pixelPathPasses}, OCR-answerable passes ${s.answerableFromOcrPasses}, evidence not sent ${s.evidenceNotSent}, visual payload to a text-only model ${s.visualPayloadViolations}${phase.historyProbe ? `; history probe ${phase.historyProbe.status} (${phase.historyProbe.class})` : ''}`);
    }
    return finish(verdict, session.problems.join('; ') || (session.interrupted ? `interrupted by ${session.interrupted.signal}` : undefined));
  } catch (error) {
    session.error = String(error.stack || error).slice(0, 8000);
    return finish('fail', `runner error: ${String(error.message || error).split('\n')[0]}`);
  } finally {
    await browser?.close().catch(() => {});
    if (server && !server.external) {
      await jsonFetch(server.baseUrl, '/api/stop', { method: 'POST', headers: csrfHeaders, body: '{}', timeoutMs: 120_000 }).catch(() => {});
      if (server.logPath) fs.writeFileSync(path.join(runDir, `host-session-${sessionNo}.log`), safeReadTail(server.logPath, 4 * 1024 * 1024));
      if (server.residentLogPath && fs.existsSync(server.residentLogPath)) fs.writeFileSync(path.join(runDir, `resident-session-${sessionNo}.log`), safeReadTail(server.residentLogPath, 4 * 1024 * 1024));
      await server.stop();
    }
  }
}

process.exitCode = await main().catch((error) => { console.error(`vision-corpus-live: ${error.message}`); return 1; });
