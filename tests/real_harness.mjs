import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export const repoRoot = process.cwd();
export const csrfHeaders = {
  'Content-Type': 'application/json',
  'X-Requested-With': 'ds4web',
};

export function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function artifactDir(name) {
  const dir = path.join(repoRoot, 'tests', '.artifacts', name);
  mkdirp(dir);
  return dir;
}

export function writeArtifact(dir, name, data) {
  mkdirp(dir);
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(path.join(dir, name), body);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

export function normalizeBaseUrl(raw) {
  const u = new URL(raw);
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

export function resolveDStudioBinary(arg) {
  const candidates = [
    arg,
    process.env.DSTUDIO_REAL_BIN,
    path.join(repoRoot, 'tests', '.build', 'dstudio-server-test'),
    path.join(repoRoot, 'dstudio'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
  throw new Error(`DStudio test binary not found. Run make first or set DSTUDIO_REAL_BIN.`);
}

export function resolveDs4Dir() {
  const candidates = [
    process.env.DSTUDIO_REAL_DS4_DIR,
    process.env.DS4_DIR,
    path.join(os.homedir(), 'Documents', 'dev', 'ds4'),
    path.join(os.homedir(), 'Documents', 'ds4'),
    path.resolve(repoRoot, '..', 'ds4'),
  ].filter(Boolean);
  for (const c of candidates) {
    const dir = path.resolve(c);
    if (!fs.existsSync(path.join(dir, 'ds4_server.c'))) continue;
    const ggufs = listGgufs(dir);
    if (ggufs.length) return { dir, ggufs };
  }
  throw new Error(
    `No usable ds4 checkout with a .gguf model found. ` +
    `Set DSTUDIO_REAL_DS4_DIR or DSTUDIO_REAL_BASE_URL.`
  );
}

export function listGgufs(dir) {
  const out = [];
  for (const sub of ['gguf', '']) {
    const root = path.join(dir, sub);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.gguf')) continue;
      const full = path.join(root, name);
      const st = fs.statSync(full);
      if (st.isFile() && st.size > 0) out.push({ file: sub ? `${sub}/${name}` : name, size: st.size });
    }
  }
  return out;
}

export async function jsonFetch(baseUrl, urlPath, options = {}) {
  const signal = options.signal || AbortSignal.timeout(options.timeoutMs || 30_000);
  const res = await fetch(`${baseUrl}${urlPath}`, { ...options, signal });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const message = json?.error?.message || json?.error || text || `HTTP ${res.status}`;
    throw new Error(`${urlPath}: ${message}`);
  }
  return json ?? {};
}

export async function completeText(baseUrl, messages, opts = {}) {
  const off = opts.thinkLevel === 'off';
  const body = {
    model: opts.model || 'ds4',
    messages,
    stream: false,
    think: !off,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 800,
  };
  if (!off && opts.thinkLevel) body.reasoning_effort = opts.thinkLevel === 'max' ? 'max' : 'high';
  const json = await jsonFetch(baseUrl, '/v1/chat/completions', {
    method: 'POST',
    timeoutMs: opts.timeoutMs || 600_000,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  return json?.choices?.[0]?.message?.content || '';
}

export async function startDStudio({ binaryArg, label = 'dstudio-real', ignoreExternal = false } = {}) {
  if (!ignoreExternal && process.env.DSTUDIO_REAL_BASE_URL) {
    const baseUrl = normalizeBaseUrl(process.env.DSTUDIO_REAL_BASE_URL);
    await jsonFetch(baseUrl, '/api/status', { timeoutMs: 10_000 });
    return { baseUrl, external: true, stop() {} };
  }

  const { dir: ds4Dir, ggufs } = resolveDs4Dir();
  const bin = resolveDStudioBinary(binaryArg);
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-home-`));
  const logPath = path.join(home, 'dstudio.log');
  const log = fs.openSync(logPath, 'w');
  const child = spawn(bin, [String(port), ds4Dir], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      DS4UI_HOST: '127.0.0.1',
      DS4UI_PAGE_FROM_DISK: '1',
    },
    stdio: ['ignore', log, log],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const cleanup = () => {
    try { fs.closeSync(log); } catch {}
  };
  child.once('exit', cleanup);

  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) {
      const tail = safeReadTail(logPath);
      throw new Error(`DStudio exited during startup.\n${tail}`);
    }
    try {
      await jsonFetch(baseUrl, '/api/status', { timeoutMs: 1000 });
      return {
        baseUrl,
        external: false,
        ds4Dir,
        ggufs,
        home,
        logPath,
        child,
        async stop() {
          if (child.exitCode === null) {
            child.kill('SIGTERM');
            for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(100);
            if (child.exitCode === null) child.kill('SIGKILL');
          }
        },
      };
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`DStudio did not become reachable at ${baseUrl}.\n${safeReadTail(logPath)}`);
}

export function safeReadTail(file, max = 12000) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return s.slice(Math.max(0, s.length - max));
  } catch {
    return '';
  }
}

export async function waitForModel(baseUrl, timeoutMs = Number(process.env.DSTUDIO_REAL_TEST_TIMEOUT_MS || 1_800_000)) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const status = await jsonFetch(baseUrl, '/api/status', { timeoutMs: 3000 });
      last = JSON.stringify(status);
      const answer = await completeText(baseUrl, [
        { role: 'user', content: 'Reply with exactly: alive' },
      ], { maxTokens: 16, timeoutMs: 120_000, thinkLevel: 'off' });
      if (/alive/i.test(answer)) return { status, answer };
      last = `unexpected model answer: ${answer}`;
    } catch (e) {
      last = e?.message || String(e);
    }
    await sleep(3000);
  }
  throw new Error(`Model did not answer before timeout. Last state: ${last}`);
}

export async function startMode(baseUrl, body, timeoutMs = 300_000) {
  const res = await jsonFetch(baseUrl, '/api/start', {
    method: 'POST',
    headers: csrfHeaders,
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error(`start failed: ${JSON.stringify(res)}`);
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const st = await jsonFetch(baseUrl, '/api/status', { timeoutMs: 5000 });
    last = JSON.stringify(st);
    if (st.ready && st.mode === body.mode) return st;
    await sleep(1000);
  }
  throw new Error(`Mode ${body.mode} did not become ready. Last status: ${last}`);
}

export async function pollAgent(baseUrl, since = 0) {
  return await jsonFetch(baseUrl, `/api/agent/poll?since=${encodeURIComponent(String(since))}`, {
    timeoutMs: 10_000,
  });
}

export async function waitForAgentText(baseUrl, since = 0, predicate = () => false, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  let all = '';
  let pos = since;
  let last = null;
  while (Date.now() < deadline) {
    const r = await pollAgent(baseUrl, pos);
    last = r;
    if (r.text) all += r.text;
    pos = r.len ?? pos;
    if (predicate(all, r)) return { text: all, poll: r, since: pos };
    if (r.working === false && all) return { text: all, poll: r, since: pos };
    await sleep(1000);
  }
  throw new Error(`Agent/design did not finish before timeout. Last poll: ${JSON.stringify(last)}\n${all.slice(-4000)}`);
}

export function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}`);
  if (start === -1) throw new Error(`${name} not found`);
  const asyncPrefix = 'async ';
  if (src.slice(Math.max(0, start - asyncPrefix.length), start) === asyncPrefix) {
    start -= asyncPrefix.length;
  }
  const params = src.indexOf('(', start);
  if (params === -1) throw new Error(`${name} parameters not found`);
  let paramsDepth = 0;
  let brace = -1;
  for (let i = params; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') i += 2;
        else if (src[i] === quote) break;
        else i++;
      }
    } else if (ch === '/' && next === '/') {
      i = src.indexOf('\n', i + 2);
      if (i === -1) throw new Error(`${name} parameters not closed`);
    } else if (ch === '/' && next === '*') {
      i = src.indexOf('*/', i + 2);
      if (i === -1) throw new Error(`${name} parameters comment not closed`);
      i++;
    } else if (ch === '(') {
      paramsDepth++;
    } else if (ch === ')') {
      paramsDepth--;
      if (paramsDepth === 0) {
        brace = src.indexOf('{', i);
        break;
      }
    }
  }
  if (brace === -1) throw new Error(`${name} body not found`);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} body is not balanced`);
}

export function webScriptSource() {
  const html = fs.readFileSync(path.join(repoRoot, 'web', 'index.html'), 'utf8');
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('module script not found');
  return m[1];
}

export function createWebPipeline(baseUrl) {
  const js = webScriptSource();
  const names = [
    'compactText',
    'buildWebContext',
    'stripJsonFence',
    'uniqueStrings',
    'validSourceKinds',
    'normalizeSourceKind',
    'technicalQuestionLikely',
    'classifySourceKind',
    'sourceKindGuidance',
    'sourceAdapterProfile',
    'sourceMetadataSummary',
    'applyReadResultToSource',
    'readSourceUnusable',
    'urlOriginAndParts',
    'adapterCandidateUrls',
    'seedAdapterCandidateSources',
    'webTimeoutLabel',
    'isAbortLikeError',
    'webPipelineError',
    'completeWebPipelineText',
    'parseWebPipelineJson',
    'completeWebPipelineObject',
    'normalizeResearchClassification',
    'classifyResearchRequest',
    'summarizeSourcesForPicker',
    'normalizeSourcePick',
    'pickSourcesToRead',
    'normalizeResearchAction',
    'summarizeFactsForModel',
    'summarizeResearchState',
    'planNextResearchAction',
    'normalizeExtractedFacts',
    'extractFactsFromPage',
    'extractFactsFromReadSources',
    'judgeResearchSufficiency',
    'buildFactsContext',
    'writeFinalFromFacts',
    'addSourceToState',
    'executeWebSearchQueries',
    'readUrlsIntoState',
    'runResearchPipeline',
    'normalizeSearchPlan',
    'completeSearchPlan',
    'planWebSearch',
    'webSourceHost',
    'explicitUserUrls',
    'sourcePathParts',
    'seedExplicitUrlSources',
    'sourcePathIdentity',
    'userAskedExternalComparison',
    'sameExplicitSourceFamily',
    'selectableSourcesAfterExplicitRead',
    'sourceTextBlob',
    'isLikelyPrimarySource',
    'sourcePrimaryReadScore',
    'mandatoryPrimaryReadSources',
    'mergeSourceSelections',
    'scoreWebSource',
    'rankWebSources',
    'selectedWebSources',
    'normalizeSearchReadPlan',
    'selectSearchReads',
    'readableWebSearchError',
    'planTraceDetail',
    'emitSearchTrace',
    'searchWithPlan',
    'normalizeResearchPlan',
    'completeResearchPlan',
    'planDeepResearch',
    'sourceKey',
    'summarizeSourcesForJudge',
    'summarizeProbesForJudge',
    'normalizeResearchJudge',
    'normalizeResearchReadPlan',
    'summarizeSourcesForReadSelection',
    'selectResearchReads',
    'judgeDeepResearch',
    'readResearchSources',
    'probeResearchSources',
    'buildResearchContext',
    'runDeepResearch',
  ];
  const functions = names.map((n) => extractFunction(js, n)).join('\n\n');
  const factory = new Function('Api', 'Engine', 'performance', 'AbortSignal', 'URL', `
    const WEB_CONTEXT_CHARS = 1800;
    const WEB_SEARCH_PLAN_TIMEOUT_MS = 45_000;
    const WEB_SEARCH_REQUEST_TIMEOUT_MS = 240_000;
    const WEB_RESEARCH_PLAN_TIMEOUT_MS = 90_000;
    const WEB_RESEARCH_JUDGE_TIMEOUT_MS = 90_000;
    const WEB_RESEARCH_TOTAL_TIMEOUT_MS = Number(process.env.DSTUDIO_REAL_TEST_TIMEOUT_MS || 1_800_000);
    ${functions}
    return { searchWithPlan, runDeepResearch, buildWebContext };
  `);
  const Api = {
    completeText: async (payload, signal) => completeText(baseUrl, payload.messages, {
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      thinkLevel: payload.thinkLevel,
      timeoutMs: 600_000,
      signal,
    }),
  };
  const Engine = {
    webSearch: async (query) => jsonFetch(baseUrl, '/api/web-search', {
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify({ query }),
      timeoutMs: 240_000,
    }),
    webRead: async (url) => jsonFetch(baseUrl, '/api/web-read', {
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify({ url }),
      timeoutMs: 120_000,
    }),
    httpProbe: async (url, method = 'HEAD') => jsonFetch(baseUrl, '/api/http-probe', {
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify({ url, method }),
      timeoutMs: 60_000,
    }),
  };
  return factory(Api, Engine, performance, AbortSignal, URL);
}

export async function modelJudge(baseUrl, { question, answer, sources, report }) {
  const text = await completeText(baseUrl, [
    {
      role: 'system',
      content: [
        'You are a strict test judge. Return strict JSON only.',
        'Score 0-10. Passing requires technical specificity, source-grounding, and no snippet-only claims.',
        'Schema: {"score":number,"pass":boolean,"reason":"short","failures":["item"]}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        question,
        answer,
        report,
        sources: (sources || []).map((s) => ({
          title: s.title,
          url: s.url,
          read: !!s.read,
          reader: s.reader || '',
          excerpt: String(s.content || '').slice(0, 1000),
        })),
      }),
    },
  ], { maxTokens: 500, timeoutMs: 300_000, thinkLevel: 'off' });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge did not return JSON: ${text}`);
  return JSON.parse(m[0]);
}
