#!/usr/bin/env node
/*
 * Real end-to-end GSA loop test against the DeepSeek V4 Pro cloud API.
 *
 * Drives a running DStudio launcher (default http://127.0.0.1:5500) through the
 * full GSA advisory loop using the remote/cloud model backend:
 *
 *   /api/start      -> launch the agent with modelBackend=remote (api.deepseek.com)
 *   /api/gsa/start  -> prepare a GSA run (prompt for selection)
 *   /api/agent/send -> feed each phase prompt to the agent
 *   /api/agent/poll -> stream the agent transcript (tool calls + model text)
 *   /api/gsa/phase  -> validate + save each phase, fetch the next prompt
 *
 * Phase order: selection -> preflight -> validation -> report.
 * "Loop" iterations: after a run completes, the next iteration starts with
 * parentRunDir = the previous run (the GSA advisory-chain loop).
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-... node tests/gsa_cloud_loop_test.mjs \
 *     [--base-url http://127.0.0.1:5500] [--iterations 2] [--timeout-min 20] \
 *     [--case reverse-engineering-easy-03-protocol-decoder] [--model deepseek-v4-pro]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  csrfHeaders,
  jsonFetch,
  normalizeBaseUrl,
  pollAgent,
  repoRoot,
  sleep,
  startMode,
} from './real_harness.mjs';

const FIXTURES_ROOT = path.join(repoRoot, 'extension', 'gsa', 'fixtures');

function usage() {
  console.error([
    'usage: node tests/gsa_cloud_loop_test.mjs [options]',
    '',
    'Options:',
    '  --base-url <url>    Running DStudio launcher (default http://127.0.0.1:5500)',
    '  --model <id>        Cloud model id (default deepseek-v4-pro)',
    '  --iterations <n>    Number of GSA loop iterations (default 2)',
    '  --timeout-min <n>   Timeout per phase turn (default 20)',
    '  --case <id>         Benchmark fixture id (default reverse-engineering-easy-03-protocol-decoder)',
    '  --workdir <dir>     Use an explicit workspace instead of copying a fixture',
    '  --no-restore         Do not restore the local server after the test',
    '',
    'Env:',
    '  DEEPSEEK_API_KEY    Cloud API key (auto-detected from the running app if omitted)',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    args[key] = value;
  }
  return args;
}

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeText(file, text) { mkdirp(path.dirname(file)); fs.writeFileSync(file, text); }
function writeJson(file, value) { writeText(file, JSON.stringify(value, null, 2) + '\n'); }

function stripTranscript(raw) {
  return String(raw || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x01USER\x02[\s\S]*?\x01ENDUSER\x02\n?/g, '')
    .replace(/\x1e[^\n]*(?:\n|$)/g, '')
    .replace(/<\/?think>/g, '')
    .trim();
}

function eventLines(raw) {
  const out = [];
  const re = /\x1e([^\n]*)/g;
  let m;
  while ((m = re.exec(String(raw || ''))) !== null) {
    try { out.push(JSON.parse(m[1])); } catch {}
  }
  return out;
}

function collectToolUse(raw) {
  const toolCalls = [];
  for (const ev of eventLines(raw)) {
    if (ev?.type !== 'tool_call') continue;
    const name = ev.name || ev.tool || '';
    const input = ev.input || {};
    toolCalls.push({ name, input });
  }
  return toolCalls;
}

function extractBalancedObjects(text) {
  const out = [];
  const s = String(text || '');
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0, inString = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { out.push(s.slice(start, i + 1)); break; }
      }
    }
  }
  return out;
}

function containsPlaceholder(value) {
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return ['...', 'file:line', 'relative/path', 'why this file matters',
      'concrete risk', 'reachable code path', 'what would make this audit not worth continuing']
      .includes(s);
  }
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value && typeof value === 'object') return Object.values(value).some(containsPlaceholder);
  return false;
}

function phaseJsonIsConcrete(parsed, phase) {
  if (!parsed || parsed.phase !== phase || containsPlaceholder(parsed)) return false;
  if (phase === 'selection') {
    return Array.isArray(parsed.files) &&
      parsed.files.some((f) => typeof f?.path === 'string' && f.path.trim()) &&
      Array.isArray(parsed.hypotheses) &&
      parsed.hypotheses.some((h) => typeof h?.title === 'string' && h.title.trim());
  }
  if (phase === 'preflight') {
    return Array.isArray(parsed.hypotheses) &&
      parsed.hypotheses.some((h) =>
        typeof h?.title === 'string' && h.title.trim() &&
        Array.isArray(h.entrypoints) && h.entrypoints.length);
  }
  if (phase === 'validation') {
    return Array.isArray(parsed.findings) &&
      parsed.findings.some((f) =>
        typeof f?.title === 'string' && f.title.trim() &&
        typeof f?.confidence === 'string' && f.confidence.trim());
  }
  return true;
}

function extractPhaseJson(raw, phase) {
  const cleaned = stripTranscript(raw)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const candidates = extractBalancedObjects(cleaned).reverse();
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (phaseJsonIsConcrete(parsed, phase)) return JSON.stringify(parsed, null, 2) + '\n';
    } catch {}
  }
  throw new Error(`could not extract ${phase} JSON from agent output`);
}

function extractReportMarkdown(raw) {
  const cleaned = stripTranscript(raw)
    .replace(/^```(?:markdown|md)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const verdict = cleaned.lastIndexOf('## Verdict');
  if (verdict >= 0) return cleaned.slice(verdict).trim();
  return cleaned;
}

function thinkControl(value) {
  return `\x1e${JSON.stringify({ type: 'control', name: 'think', value })}\n`;
}

function missionFor(item) {
  return [
    `Perform a high-signal local-only GSA security review for project "${item.title}".`,
    `Domain: ${item.category}.`,
    'Inspect the copied workspace source and artifacts only.',
    'Do not assume a vulnerability exists.',
    'Return confirmed_issue, no_issue, or inconclusive only when the evidence supports it.',
    'Use concrete file:line citations and create scratch Python scripts in scripts/ only when useful.',
    'If tools are available, treat them as advisory only; manual source/artifact reasoning remains decisive.',
    'A missing external command is not a hard failure: state what is missing, then continue with source, artifacts and bounded Python helpers when possible.',
    'External recon is out of scope for this benchmark case.',
  ].join('\n');
}

function fixtureIndex() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, 'index.json'), 'utf8'));
}

function findFixture(id) {
  return fixtureIndex().find((i) => i.id === id);
}

function copyWorkspace(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, filter: (p) => !p.split(path.sep).includes('.dstudio') });
}

async function readCloudApiKeyFromApp() {
  // The launcher stores settings in WKWebView localStorage (UTF-16LE in sqlite).
  const db = path.join(os.homedir(), 'Library', 'WebKit', 'dev.ds4.DStudio', 'WebsiteData');
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'localstorage.sqlite3') files.push(p);
    }
  };
  walk(db);
  if (!files.length) return '';
  try {
    const raw = execFileSync('sqlite3', [files[0], "SELECT value FROM ItemTable WHERE key='ds4web.settings.v2';"], { encoding: 'utf8' });
    // value is UTF-16LE bytes read back as latin1-ish; decode and strip NULs.
    const buf = Buffer.from(raw, 'binary');
    const text = buf.toString('utf16le');
    const settings = JSON.parse(text);
    return settings.deepseekApiKey || '';
  } catch {
    return '';
  }
}

async function resolveCloudApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const fromApp = await readCloudApiKeyFromApp();
  if (fromApp) return fromApp;
  throw new Error('No cloud API key found. Set DEEPSEEK_API_KEY or run DStudio with a DeepSeek API key configured.');
}

async function waitAgentQuiet(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastLen = -1, stable = 0;
  while (Date.now() < deadline) {
    try {
      const r = await pollAgent(baseUrl, 0);
      const len = Number.isFinite(Number(r.len)) ? Number(r.len) : -1;
      if (r.working === false && len === lastLen) { stable++; if (stable >= 2) return true; }
      else stable = 0;
      lastLen = len;
    } catch { return false; }
    await sleep(1000);
  }
  return false;
}

async function safeInterruptAgent(baseUrl, reason = 'cloud loop test cleanup', status = 'canceled') {
  try {
    await jsonFetch(baseUrl, '/api/agent/interrupt', {
      method: 'POST', headers: csrfHeaders,
      body: JSON.stringify({ reason, status }), timeoutMs: 5_000,
    });
  } catch {}
  await waitAgentQuiet(baseUrl, 30_000);
}

async function sendAgentPromptWithRetry(baseUrl, body) {
  // The previous phase is interrupted early (once its JSON is captured) to save
  // tokens. The remote backend can take a beat to fully settle that interrupt,
  // so retry a transient "interrupt is still settling" 409 instead of failing.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      return await jsonFetch(baseUrl, '/api/agent/send', {
        method: 'POST', headers: csrfHeaders,
        body: JSON.stringify(body),
        timeoutMs: 30_000,
      });
    } catch (e) {
      const msg = e?.message || String(e);
      if (/interrupt is still settling|still loading|runtime is not active/.test(msg) && Date.now() < deadline) {
        await sleep(1500);
        continue;
      }
      throw e;
    }
  }
}

async function sendAgentTurn(baseUrl, prompt, displayPrompt, timeoutMs, outDir, phase) {
  const sent = await sendAgentPromptWithRetry(baseUrl, {
    prompt: `${thinkControl('max')}${prompt}`, displayPrompt,
  });
  writeJson(path.join(outDir, `${phase}.send.json`), sent);
  const start = Number.isFinite(Number(sent.at)) ? Number(sent.at) : Number(sent.from || 0);
  const deadline = Date.now() + timeoutMs;
  let pos = start, raw = '', last = null;
  let lastProgressAt = Date.now();
  let emptyReadySince = 0;
  const stallTimeoutMs = Math.min(timeoutMs, 8 * 60 * 1000);
  const noStartTimeoutMs = Math.min(timeoutMs, 3 * 60 * 1000);
  const emptyReadyGraceMs = 15_000;
  const maxRawBytes = 400_000;
  const liveRawPath = path.join(outDir, `${phase}.raw.live.txt`);

  while (Date.now() < deadline) {
    const r = await pollAgent(baseUrl, pos);
    last = r;
    if (r.text) { raw += r.text; lastProgressAt = Date.now(); }
    pos = Number.isFinite(Number(r.len)) ? Number(r.len) : pos;

    if (!raw.trim()) {
      if (r.working === false) {
        emptyReadySince ||= Date.now();
        if (Date.now() - emptyReadySince > emptyReadyGraceMs) {
          writeText(path.join(outDir, `${phase}.raw.txt`), raw);
          throw new Error(`agent turn no transcript started during ${phase}; last poll: ${JSON.stringify(last)}`);
        }
      } else emptyReadySince = 0;
      if (Date.now() - lastProgressAt > noStartTimeoutMs) {
        writeText(path.join(outDir, `${phase}.raw.txt`), raw);
        await safeInterruptAgent(baseUrl, `phase ${phase} no transcript started`);
        throw new Error(`agent turn no transcript started during ${phase} after ${Math.round(noStartTimeoutMs / 1000)}s`);
      }
    }

    if (phase !== 'report' && raw.trim()) {
      try {
        extractPhaseJson(raw, phase);
        writeText(path.join(outDir, `${phase}.raw.txt`), raw);
        await safeInterruptAgent(baseUrl, `phase ${phase} JSON captured`, 'completed');
        return raw;
      } catch {}
    }

    if (r.working === false && raw.trim()) {
      writeText(path.join(outDir, `${phase}.raw.txt`), raw);
      if (!stripTranscript(raw)) throw new Error(`agent turn ended without useful output during ${phase}`);
      return raw;
    }

    if (raw.length > maxRawBytes) {
      writeText(path.join(outDir, `${phase}.raw.txt`), raw);
      await safeInterruptAgent(baseUrl, `phase ${phase} transcript budget exceeded`);
      throw new Error(`agent turn exceeded transcript budget during ${phase}; raw bytes=${raw.length}`);
    }

    if (raw.trim() && Date.now() - lastProgressAt > stallTimeoutMs) {
      writeText(path.join(outDir, `${phase}.raw.txt`), raw);
      await safeInterruptAgent(baseUrl, `phase ${phase} stalled`);
      throw new Error(`agent turn stalled during ${phase}; no transcript progress for ${Math.round((Date.now() - lastProgressAt) / 1000)}s`);
    }

    await sleep(1000);
  }
  writeText(path.join(outDir, `${phase}.raw.txt`), raw);
  await safeInterruptAgent(baseUrl, `phase ${phase} timed out`);
  throw new Error(`agent turn timed out during ${phase}; last poll: ${JSON.stringify(last)}`);
}

async function runGsaIteration(baseUrl, { workdir, mission, targetUrl, parentRunDir, iteration, outRoot, timeoutMs }) {
  const iterDir = path.join(outRoot, `iteration-${iteration}`);
  mkdirp(iterDir);
  const startedAt = Date.now();

  const start = await jsonFetch(baseUrl, '/api/gsa/start', {
    method: 'POST', headers: csrfHeaders,
    body: JSON.stringify({
      workdir, mission, targetUrl: targetUrl || '',
      parentRunDir: parentRunDir || '', disabledTools: '',
      profile: 'passive', authorized: false,
    }),
    timeoutMs: 60_000,
  });
  writeJson(path.join(iterDir, 'gsa-start.json'), start);

  const result = {
    iteration,
    runId: start.runId,
    runDir: start.runDir,
    candidateCount: start.candidateCount,
    parentRunDir: start.parentRunDir || '',
    phases: {},
    toolCalls: [],
    durationMs: 0,
  };

  const transcriptParts = [];
  let prompt = start.prompt;
  const phaseOrder = ['selection', 'preflight', 'validation', 'report'];
  for (const phase of phaseOrder) {
    const t0 = Date.now();
    console.log(`    [${iteration}] ${phase}: sending prompt…`);
    const raw = await sendAgentTurn(baseUrl, prompt, `/gsa iter${iteration} ${phase}`, timeoutMs, iterDir, phase);
    transcriptParts.push(`\n\n===== ${phase.toUpperCase()} =====\n\n${raw}`);
    const toolCalls = collectToolUse(raw);
    result.toolCalls.push(...toolCalls);

    let output;
    if (phase === 'report') {
      output = extractReportMarkdown(raw);
    } else {
      output = extractPhaseJson(raw, phase);
    }
    writeText(path.join(iterDir, `${phase}.${phase === 'report' ? 'md' : 'json'}`), output + '\n');

    const phaseRes = await jsonFetch(baseUrl, '/api/gsa/phase', {
      method: 'POST', headers: csrfHeaders,
      body: JSON.stringify({ workdir, runId: start.runId, phase, output }),
      timeoutMs: 60_000,
    });
    writeJson(path.join(iterDir, `${phase}.phase-response.json`), phaseRes);

    if (!phaseRes.ok) {
      throw new Error(`GSA phase ${phase} rejected: ${phaseRes.error || JSON.stringify(phaseRes)}`);
    }
    result.phases[phase] = {
      ok: true,
      toolCalls: toolCalls.length,
      toolNames: [...new Set(toolCalls.map((t) => t.name))],
      rawBytes: raw.length,
      elapsedMs: Date.now() - t0,
      complete: !!phaseRes.complete,
    };
    console.log(`    [${iteration}] ${phase}: ok (${toolCalls.length} tool calls, ${Math.round((Date.now() - t0) / 1000)}s)${toolCalls.length ? ` tools=${[...new Set(toolCalls.map((t) => t.name))].join(',')}` : ''}`);
    prompt = phaseRes.nextPrompt;
    if (phase !== 'report' && !prompt) throw new Error(`GSA phase ${phase} did not return a nextPrompt`);
  }

  result.durationMs = Date.now() - startedAt;
  result.report = extractReportMarkdown(transcriptParts.join('\n')) || '## Verdict: (missing)';
  writeText(path.join(iterDir, 'report.md'), result.report + '\n');
  writeJson(path.join(iterDir, 'manifest.json'), result);
  return result;
}

const args = parseArgs(process.argv);
const baseUrl = normalizeBaseUrl(args['base-url'] || 'http://127.0.0.1:5500');
const model = args.model || 'deepseek-v4-pro';
const iterations = Math.max(1, Number(args.iterations || 2));
const timeoutMs = Number(args['timeout-min'] || 20) * 60_000;

// 1. Verify the launcher is up.
let status;
try {
  status = await jsonFetch(baseUrl, '/api/status', { timeoutMs: 10_000 });
} catch (e) {
  console.error(`DStudio launcher not reachable at ${baseUrl}: ${e?.message || e}`);
  process.exit(1);
}
console.log(`Launcher: ${baseUrl} (mode=${status.mode}, variant=${status.variant})`);

// 2. Resolve cloud API key + workspace.
const apiKey = await resolveCloudApiKey();
console.log(`Cloud backend: https://api.deepseek.com model=${model} key=${apiKey.slice(0, 7)}…`);

let workdir;
let mission;
if (args.workdir) {
  workdir = path.resolve(args.workdir);
  mission = missionFor({ title: path.basename(workdir), category: 'general' });
} else {
  const caseId = args.case || 'reverse-engineering-easy-03-protocol-decoder';
  const item = findFixture(caseId);
  if (!item) { console.error(`unknown fixture: ${caseId}`); process.exit(1); }
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), `gsa-cloud-${item.id}-`));
  copyWorkspace(path.join(repoRoot, item.workspace), workdir);
  mission = missionFor(item);
  console.log(`Workspace: ${workdir} (fixture ${item.id})`);
}

const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsa-cloud-loop-out-'));
console.log(`Artifacts: ${outRoot}`);
console.log(`Iterations: ${iterations}, phase timeout: ${Math.round(timeoutMs / 60000)} min\n`);

// 3. Launch the agent with the remote cloud backend.
const launchBody = {
  mode: 'agent',
  model: 'uncensored',
  variant: 'flash',
  ctx: 65536,
  power: 90,
  think: 'max',
  workdir,
  modelBackend: 'remote',
  remoteBaseUrl: 'https://api.deepseek.com',
  remoteModel: model,
  remoteApiKey: apiKey,
};
console.log('Launching agent in remote/cloud mode…');
await startMode(baseUrl, launchBody, 60_000);
console.log('Agent ready (remote backend).\n');

// 4. Run the GSA loop.
const results = [];
let parentRunDir = '';
let restoreServer = true;
try {
  for (let i = 1; i <= iterations; i++) {
    console.log(`=== GSA loop iteration ${i} ===`);
    const r = await runGsaIteration(baseUrl, {
      workdir, mission, targetUrl: '', parentRunDir, iteration: i, outRoot, timeoutMs,
    });
    results.push(r);
    parentRunDir = r.runDir;
    console.log(`=== iteration ${i} complete in ${Math.round(r.durationMs / 1000)}s (run ${r.runId}) ===\n`);
  }
  restoreServer = !args['no-restore'];
} catch (e) {
  console.error(`\nGSA loop FAILED: ${e?.message || e}`);
  await safeInterruptAgent(baseUrl, 'cloud loop test failure').catch(() => {});
} finally {
  // Restore the local server the user had running before this test.
  if (restoreServer) {
    console.log('\nRestoring local server…');
    try {
      await jsonFetch(baseUrl, '/api/start', {
        method: 'POST', headers: csrfHeaders,
        body: JSON.stringify({ mode: 'server', model: 'uncensored', variant: 'flash' }),
        timeoutMs: 30_000,
      });
    } catch (e) { console.error(`restore failed: ${e?.message || e}`); }
  }
}

// 5. Summary.
writeJson(path.join(outRoot, 'summary.json'), { results });
console.log('\n===== SUMMARY =====');
for (const r of results) {
  const totalTools = r.toolCalls.length;
  console.log(`Iteration ${r.iteration} (${r.runId}): ${Object.keys(r.phases).join(' -> ')} | tool calls=${totalTools} | ${Math.round(r.durationMs / 1000)}s`);
}
const ok = results.length === iterations && results.every((r) => ['selection', 'preflight', 'validation', 'report'].every((p) => r.phases[p]?.ok));
console.log(`\nRESULT: ${ok ? 'PASS — GSA loop completed all phases across all iterations' : 'FAIL'} (${results.length}/${iterations} iterations completed)`);
console.log(`Artifacts: ${outRoot}`);
process.exit(ok ? 0 : 1);
