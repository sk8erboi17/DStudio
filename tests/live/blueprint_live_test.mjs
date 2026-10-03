// REAL inference: DStudio's Agent with actual DeepSeek weights maps a held-out
// fixture repository (tests/fixtures/blueprint/ticket-service) with the
// production Blueprint prompt, and the production core validates and verifies
// the written spec against the files. The expected structure below is an
// independent oracle written from the fixture's code, with thresholds fixed
// before the run. Heavy: run alone (one DeepSeek instance fits in memory).
//
//   node tests/live/blueprint_live_test.mjs
//   DSTUDIO_BLUEPRINT_CASES=architecture   (or sequence)  to run one case
//   DSTUDIO_REAL_TEST_TIMEOUT_MS=0          no wall-clock bound for model work
//
// Receipts (launch, model identity, prompts, transcripts, the written specs,
// grades, timings, failures) stay in tests/.artifacts/blueprint-live/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  artifactRunDir, csrfHeaders, extractFunction, jsonFetch, pollAgent, safeReadTail, sleep, startDStudio, startMode, writeArtifact,
} from '../support/real_harness.mjs';
import vm from 'node:vm';

const source = fs.readFileSync('web/index.html', 'utf8');
const ctx = vm.createContext({});
vm.runInContext(`${extractFunction(source, 'createBlueprintCore')}\nthis.core = createBlueprintCore();`, ctx);
const core = ctx.core;

const run = artifactRunDir('blueprint-live');
const workspace = path.join(run, 'workspace');
fs.cpSync('tests/fixtures/blueprint/ticket-service', workspace, { recursive: true });
fs.rmSync(path.join(workspace, 'README.md'));          // the oracle notes are not model input
const boundMs = Number(process.env.DSTUDIO_REAL_TEST_TIMEOUT_MS ?? 1_800_000);
const wanted = new Set(String(process.env.DSTUDIO_BLUEPRINT_CASES || 'architecture,sequence').split(',').map((s) => s.trim()));

// ---------- independent oracle (from the fixture's code) ----------
const MODULES = ['index', 'api', 'tickets', 'store', 'cache', 'queue', 'worker', 'notifier'];
const LABEL_HINTS = { api: /\b(api|http|router|routes?)\b/, tickets: /\btickets?\b(?!.*(db|store|cache|queue))/, store: /\b(store|sqlite|database|db)\b/,
  cache: /\b(cache|lru)\b/, queue: /\b(queue|redis)\b/, worker: /\bworker\b/, notifier: /\b(notifier|mail|email|smtp)\b/, index: /\b(index|entry|bootstrap|main)\b/ };
const CORE_PAIRS = [['api', 'tickets'], ['tickets', 'store'], ['tickets', 'cache'], ['tickets', 'queue'], ['worker', 'queue'], ['worker', 'notifier']];
const OPTIONAL_PAIRS = [['index', 'api'], ['index', 'worker']];
const pairKey = (a, b) => [a, b].sort().join('~');
function moduleOf(node) {
  const counts = new Map();
  for (const s of node.sources) {
    const m = s.path.match(/^src\/([a-z]+)\.js$/);
    if (m && MODULES.includes(m[1])) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  if (counts.size) return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const text = `${node.label} ${node.id}`.toLowerCase();
  return MODULES.find((m) => LABEL_HINTS[m].test(text)) || '';
}

const CASES = [
  { kind: 'architecture', focus: '', name: 'architecture',
    grade(spec, verify) {
      const map = new Map(spec.nodes.map((n) => [n.id, moduleOf(n)]));
      const components = new Set([...map.values()].filter((m) => m && m !== 'index'));
      const pairs = new Set(spec.edges.map((e) => [map.get(e.from), map.get(e.to)]).filter(([a, b]) => a && b && a !== b).map(([a, b]) => pairKey(a, b)));
      const allowed = new Set([...CORE_PAIRS, ...OPTIONAL_PAIRS].map(([a, b]) => pairKey(a, b)));
      const found = CORE_PAIRS.filter(([a, b]) => pairs.has(pairKey(a, b))).map(([a, b]) => `${a}~${b}`);
      const unsupported = [...pairs].filter((p) => !allowed.has(p));
      const directed = spec.edges.filter((e) => map.get(e.from) === 'api' && map.get(e.to) === 'tickets').length > 0;
      const evidence = citationRate(verify);
      const checks = {
        components: { value: components.size, of: 7, pass: components.size >= 5 },
        corePairs: { value: found.length, of: CORE_PAIRS.length, found, pass: found.length >= 4 },
        unsupportedPairs: { value: unsupported.length, pairs: unsupported, pass: unsupported.length <= 1 },
        evidence: { ...evidence, pass: evidence.rate >= 0.7 },
        apiCallsTickets: { value: directed, pass: true, note: 'reported, not gating' },
      };
      return { mapping: Object.fromEntries(map), checks };
    } },
  { kind: 'sequence', focus: 'GET /tickets/:id when the ticket is not in the cache', name: 'sequence',
    grade(spec, verify) {
      const map = new Map(spec.nodes.map((n) => [n.id, moduleOf(n)]));
      const parts = new Set([...map.values()].filter((m) => ['api', 'tickets', 'cache', 'store'].includes(m)));
      const into = spec.steps.map((s) => map.get(s.to));
      const firstCache = into.indexOf('cache'), firstStore = into.indexOf('store'), lastCache = into.lastIndexOf('cache');
      const ordered = firstCache >= 0 && firstStore > firstCache && lastCache > firstStore;
      const evidence = citationRate(verify);
      const checks = {
        participants: { value: parts.size, of: 4, pass: parts.size >= 3 },
        cacheMissOrder: { value: { firstCache, firstStore, lastCache }, pass: ordered },
        evidence: { ...evidence, pass: evidence.rate >= 0.7 },
      };
      return { mapping: Object.fromEntries(map), steps: spec.steps.map((s) => `${s.from}->${s.to}: ${s.label}`), checks };
    } },
];
function citationRate(verify) {
  const c = verify.counts;
  const total = c.verified + c.moved + c.unverified + c.missing + c.unquoted + c.skipped;
  const found = c.verified + c.moved;
  return { citations: total, quoteFound: found, verifiedAtLines: c.verified, rate: total ? Math.round((found / total) * 1000) / 1000 : 0 };
}

// ---------- run ----------
const receipt = { scope: 'REAL inference: DStudio Agent + DeepSeek weights; production Blueprint prompt/validation/verification; held-out fixture and independent oracle',
  startedAt: new Date().toISOString(), cases: [], failures: [] };
let server = null;
function selectGguf(ggufs) {
  const requested = process.env.DSTUDIO_BLUEPRINT_GGUF;
  if (requested) return ggufs.find((g) => g.file === requested || g.file.endsWith(`/${requested}`));
  const usable = ggufs.filter((g) => /DeepSeek-V4-Flash/i.test(g.file) && !/Encoder|DSpark|MXFP4/i.test(g.file));
  return usable.find((g) => /IQ2XXS/i.test(g.file)) || usable[0];
}
async function waitTurn(baseUrl, since) {
  const t0 = performance.now();
  let pos = since, text = '', sawWork = false, last = null;
  for (;;) {
    const r = await pollAgent(baseUrl, pos);
    last = r;
    if (r.text) text += r.text;
    pos = r.len ?? pos;
    if (r.working) sawWork = true;
    if (sawWork && !r.working && !r.sessionWorking) return { text, pos, ms: Math.round(performance.now() - t0) };
    if (boundMs > 0 && performance.now() - t0 > boundMs) return { text, pos, ms: Math.round(performance.now() - t0), timedOut: true, last };
    await sleep(1000);
  }
}
async function newSession(baseUrl) {
  const r = await jsonFetch(baseUrl, '/api/design/session', { method: 'POST', headers: csrfHeaders, body: JSON.stringify({ action: 'new' }), timeoutMs: 30_000 });
  for (let i = 0; i < 600; i++) {
    const st = await jsonFetch(baseUrl, '/api/status', { timeoutMs: 5000 });
    if (!st.agentSessionWorking && !st.agentWorking) return r;
    await sleep(1000);
  }
  throw new Error('the new session did not settle');
}

try {
  server = await startDStudio({ label: 'blueprint-live', isolatedEnginePort: true });
  receipt.host = { baseUrl: server.baseUrl, external: !!server.external };
  const gguf = selectGguf(server.ggufs || []);
  assert.ok(gguf, 'no DeepSeek V4 Flash GGUF available: BLOCKED, not a pass');
  const launch = { mode: 'agent', model: 'standard', variant: 'flash', gguf: gguf.file, port: server.enginePort,
    ctx: Number(process.env.DSTUDIO_BLUEPRINT_CTX || 65536), power: Number(process.env.DSTUDIO_BLUEPRINT_POWER || 90),
    think: process.env.DSTUDIO_BLUEPRINT_THINK || 'high', ssdStreaming: 'off', workdir: workspace };
  writeArtifact(run, 'launch.json', launch);
  const t0 = performance.now();
  const startup = await startMode(server.baseUrl, launch, boundMs);
  receipt.startupMs = Math.round(performance.now() - t0);
  receipt.model = { file: startup.modelFile, config: startup.config, variant: startup.variant, mode: startup.mode };
  writeArtifact(run, 'startup.json', startup);
  assert.equal(startup.mode, 'agent');

  // The UI prepares the folder through the host before sending (the write
  // tool does not create directories); the test does exactly the same.
  for (const d of [path.join(workspace, '.dstudio'), path.join(workspace, '.dstudio/blueprints')]) {
    const r = await jsonFetch(server.baseUrl, '/api/fs/mkdir', { method: 'POST', headers: csrfHeaders, body: JSON.stringify({ path: d }) });
    assert.ok(r.ok, `mkdir ${d}: ${JSON.stringify(r)}`);
  }

  let since = (await pollAgent(server.baseUrl, 0)).len || 0;
  for (const c of CASES.filter((x) => wanted.has(x.name))) {
    const row = { name: c.name, kind: c.kind, focus: c.focus };
    receipt.cases.push(row);
    try {
      if (receipt.cases.length > 1) { await newSession(server.baseUrl); since = (await pollAgent(server.baseUrl, 0)).len || since; }
      const rel = `.dstudio/blueprints/${c.kind}-live.json`;
      const prompt = core.buildPrompt({ kind: c.kind, focus: c.focus, path: rel });
      writeArtifact(run, `${c.name}.prompt.txt`, prompt);
      const sent = await jsonFetch(server.baseUrl, '/api/agent/send', { method: 'POST', headers: csrfHeaders,
        body: JSON.stringify({ prompt, displayPrompt: `Blueprint · ${core.KINDS[c.kind].label}${c.focus ? ` · ${c.focus}` : ''}` }), timeoutMs: 30_000 });
      assert.ok(sent.ok, `send failed: ${JSON.stringify(sent)}`);
      const turn = await waitTurn(server.baseUrl, since);
      since = turn.pos;
      row.turnMs = turn.ms;
      writeArtifact(run, `${c.name}.transcript.txt`, turn.text);
      if (turn.timedOut) throw new Error(`no result within the test bound of ${boundMs} ms (BLOCKED, not a pass)`);
      const file = path.join(workspace, rel);
      row.fileWritten = fs.existsSync(file);
      assert.ok(row.fileWritten, `the Agent did not write ${rel}`);
      const text = fs.readFileSync(file, 'utf8');
      writeArtifact(run, `${c.name}.blueprint.json`, text);
      let raw;
      try { raw = JSON.parse(text); } catch (e) { throw new Error(`the written file is not JSON: ${e.message}`); }
      const { spec, issues } = core.normalize(raw);
      row.issues = issues;
      assert.ok(spec && !issues.some((i) => i.level === 'error'), `invalid blueprint: ${JSON.stringify(issues.filter((i) => i.level === 'error'))}`);
      assert.equal(spec.kind, c.kind);
      const verify = await core.verifySpec(spec, async (p) => {
        const full = path.join(workspace, p);
        return full.startsWith(workspace + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, 'utf8') : null;
      });
      row.verify = { claims: verify.claims, supported: verify.supported, counts: verify.counts,
        citations: verify.citations.map((x) => ({ owner: x.owner, path: x.path, lines: x.lines, quote: x.quote, status: x.status, line: x.line })) };
      row.size = { nodes: spec.nodes.length, relationships: core.relationships(spec).length, groups: spec.groups.length };
      const lay = core.layout(spec);
      writeArtifact(run, `${c.name}.svg`, core.renderSvg(spec, lay, (k) => verify.items.get(k) || ''));
      const g = c.grade(spec, verify);
      row.grade = g;
      row.pass = Object.values(g.checks).every((x) => x.pass);
      row.status = row.pass ? 'PASS' : 'FAIL';
      if (!row.pass) receipt.failures.push(`${c.name}: ${Object.entries(g.checks).filter(([, v]) => !v.pass).map(([k]) => k).join(', ')}`);
    } catch (error) {
      row.status = 'FAIL';
      row.error = String(error.stack || error);
      receipt.failures.push(`${c.name}: ${error.message}`);
    }
    console.log(`${row.status} ${c.name}${row.turnMs ? ` (${Math.round(row.turnMs / 1000)} s)` : ''}${row.error ? `\n${row.error}` : ''}`);
    writeArtifact(run, 'results.json', receipt);
  }
} catch (error) {
  receipt.failures.push(`run: ${error.message}`);
  receipt.error = String(error.stack || error);
  if (server?.logPath) receipt.hostLogTail = safeReadTail(server.logPath);
  console.error(error);
} finally {
  receipt.finishedAt = new Date().toISOString();
  writeArtifact(run, 'results.json', receipt);
  try { await server?.stop?.(); } catch { /* the host is task-owned */ }
}
const passed = receipt.cases.filter((c) => c.status === 'PASS').length;
console.log(`blueprint_live_test (REAL DeepSeek): ${passed}/${receipt.cases.length} passed${receipt.failures.length ? `; failures: ${receipt.failures.join(' | ')}` : ''}\nReceipts: ${run}`);
if (!receipt.cases.length || passed !== receipt.cases.length || receipt.failures.length) process.exitCode = 1;
