import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
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
    path.join(repoRoot, 'ds4'),
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
      let st = null;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isFile() && st.size > 0) out.push({ file: sub ? `${sub}/${name}` : name, size: st.size });
    }
  }
  return out;
}

/* Native HTTP request: unlike global fetch (undici), it has no 300s
 * headers-timeout, so long stream:false model generations on slow local
 * engines keep waiting for the first byte up to the explicit abort signal. */
function httpJsonRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { ...(options.headers || {}) };
    if (options.body && !('Content-Length' in headers)) {
      headers['Content-Length'] = String(Buffer.byteLength(options.body));
    }
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: `${u.pathname}${u.search}`,
      method: options.method || 'GET',
      headers,
      signal: options.signal,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: () => Promise.resolve(text),
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export async function jsonFetch(baseUrl, urlPath, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : Number(options.timeoutMs);
  const signal = options.signal || (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  const res = await httpJsonRequest(`${baseUrl}${urlPath}`, { ...options, signal });
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
  };
  const maxTokens = opts.maxTokens ?? 800;
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if (!off && opts.thinkLevel) body.reasoning_effort = opts.thinkLevel === 'max' ? 'max' : 'high';
  const json = await jsonFetch(baseUrl, '/v1/chat/completions', {
    method: 'POST',
    timeoutMs: opts.timeoutMs ?? Number(process.env.DSTUDIO_REAL_CALL_TIMEOUT_MS || 0),
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  return json?.choices?.[0]?.message?.content || '';
}

/* Streamed variant for slow local models. A disconnected/aborted client is
 * observed while decoding, so the engine can cancel promptly instead of
 * continuing an invisible stream:false generation in the background. */
export async function completeTextStream(baseUrl, messages, opts = {}) {
  const off = opts.thinkLevel === 'off';
  const body = {
    model: opts.model || 'ds4',
    messages,
    stream: true,
    stream_options: { include_usage: true },
    think: !off,
    temperature: opts.temperature ?? 0,
  };
  const maxTokens = opts.maxTokens ?? 800;
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if (!off && opts.thinkLevel) {
    body.reasoning_effort = opts.thinkLevel === 'max' ? 'max' : 'high';
  }
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DSTUDIO_REAL_CALL_TIMEOUT_MS || 0);
  const signal = opts.signal || (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  return await new Promise((resolve, reject) => {
    const u = new URL(`${baseUrl}/v1/chat/completions`);
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Content-Length': String(Buffer.byteLength(payload)),
      },
    }, (res) => {
      let wire = '';
      let content = '';
      let reasoning = '';
      let errorText = '';
      let finishReason = null;
      let usage = null;
      const consume = (frame) => {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trimStart();
          if (!data || data === '[DONE]') continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event.error) throw new Error(event.error.message || event.error);
          const delta = event?.choices?.[0]?.delta || {};
          content += delta.content || '';
          reasoning += delta.reasoning_content || delta.reasoning || '';
          if (event?.choices?.[0]?.finish_reason) {
            finishReason = event.choices[0].finish_reason;
          }
          if (event?.usage) usage = event.usage;
          opts.onProgress?.({ content, reasoning, event });
        }
      };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          errorText += chunk;
          return;
        }
        wire += chunk;
        for (;;) {
          const boundary = wire.search(/\r?\n\r?\n/);
          if (boundary < 0) break;
          const match = wire.slice(boundary).match(/^\r?\n\r?\n/);
          const width = match?.[0]?.length || 2;
          const frame = wire.slice(0, boundary);
          wire = wire.slice(boundary + width);
          try { consume(frame); } catch (error) { req.destroy(error); }
        }
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(errorText || `HTTP ${res.statusCode}`));
          return;
        }
        if (wire.trim()) {
          try { consume(wire); } catch (error) { reject(error); return; }
        }
        resolve({ content, reasoning, finishReason, usage });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export async function startDStudio({ binaryArg, label = 'dstudio-real', ignoreExternal = false,
  isolatedEnginePort = false, env = {} } = {}) {
  if (!ignoreExternal && process.env.DSTUDIO_REAL_BASE_URL) {
    const baseUrl = normalizeBaseUrl(process.env.DSTUDIO_REAL_BASE_URL);
    await jsonFetch(baseUrl, '/api/status', { timeoutMs: 10_000 });
    return { baseUrl, external: true, stop() {} };
  }

  const { dir: ds4Dir, ggufs } = resolveDs4Dir();
  const bin = resolveDStudioBinary(binaryArg);
  const port = await freePort();
  const enginePort = isolatedEnginePort ? await freePort() : 28000;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-home-`));
  const realHome = process.env.DSTUDIO_REAL_HOME || os.homedir();
  const toolPath = [
    path.join(realHome, '.local', 'share', 'flashcards', 'gsa-tools', 'bin'),
    path.join(realHome, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env.PATH || '',
  ].filter(Boolean).join(path.delimiter);
  const logPath = path.join(home, 'dstudio.log');
  const log = fs.openSync(logPath, 'w');
  const child = spawn(bin, [String(port), ds4Dir], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      DSTUDIO_REAL_HOME: realHome,
      PATH: toolPath,
      DS4UI_HOST: '127.0.0.1',
      DS4UI_PAGE_FROM_DISK: '1',
      ...(isolatedEnginePort ? { DS4UI_ENGINE_PORT: String(enginePort) } : {}),
      ...env,
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
        enginePort,
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
          // ds4 intentionally keeps its visible CDP Chrome alive between
          // short helper invocations. Real tests use a unique temporary HOME,
          // so terminate only processes tied to that exact isolated profile.
          const profile = path.join(home, '.ds4', 'browser');
          if (process.platform !== 'win32') {
            let pids = [];
            try {
              pids = execFileSync('pgrep', ['-f', profile], { encoding: 'utf8' })
                .split(/\s+/).map(Number).filter((pid) => pid > 1 && pid !== process.pid);
            } catch {}
            for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
            await sleep(300);
            for (const pid of pids) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {} }
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
  // A non-positive timeout explicitly means "wait until ready". This is used
  // by quality benchmarks whose local models must not be cut off merely for
  // taking longer than an arbitrary wall-clock budget.
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  let last = '';
  while (Date.now() < deadline) {
    const st = await jsonFetch(baseUrl, '/api/status', { timeoutMs: 5000 });
    last = JSON.stringify(st);
    if (st.ready && st.mode === body.mode) return st;
    if (st.running === false && st.engineError) {
      throw new Error(`Mode ${body.mode} stopped during startup: ${st.engineError}`);
    }
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
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
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

export function searchRuntimeSource() {
  return fs.readFileSync(path.join(repoRoot, 'extension', 'search', 'runtime.js'), 'utf8');
}

export function createWebPipeline(baseUrl) {
  const js = searchRuntimeSource();
  const roadmapProtocolMatch = js.match(/const ROADMAP_OUTPUT_PROTOCOL = String\.raw`([\s\S]*?)`;/);
  if (!roadmapProtocolMatch) throw new Error('ROADMAP_OUTPUT_PROTOCOL not found in search runtime');
  const names = [
    'compactText',
    'balancedEvidenceText',
    'researchReportWantsTechnical',
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
    'isAbortLikeError',
    'webPipelineError',
    'completeWebPipelineText',
    'parseWebPipelineJson',
    'completeWebPipelineObject',
    'researchPurposeValue',
    'roadmapResearchQueries',
    'normalizeResearchClassification',
    'classifyResearchRequest',
    'summarizeSourcesForPicker',
    'normalizeSourcePick',
    'roadmapSourceSelectionScore',
    'roadmapPdfSource',
    'likelyUnauthorizedRoadmapMirror',
    'lowValueRoadmapDiscoveryPage',
    'roadmapDiscoveryCandidateEligible',
    'roadmapDiscoveryCandidatePool',
    'diversifyRoadmapSourcePick',
    'pickSourcesToRead',
    'normalizeResearchAction',
    'summarizeFactsForModel',
    'summarizeResearchState',
    'planNextResearchAction',
    'roadmapResearchActionWithFallback',
    'normalizeExtractedFacts',
    'extractFactsFromPage',
    'normalizeRoadmapBatchFacts',
    'extractFactsFromRoadmapBatch',
    'extractFactsFromReadSources',
    'judgeResearchSufficiency',
    'buildFactsContext',
    'sourceIdForFact',
    'buildResearchReportDraft',
    'factIdsFromFacts',
    'uncitedEvidenceLines',
    'researchReportQuality',
    'synthesizeResearchReport',
    'buildFinalResearchContext',
    'buildRoadmapEvidenceContext',
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
    const WEB_SEARCH_PLAN_TIMEOUT_MS = Number.POSITIVE_INFINITY;
    const WEB_SEARCH_REQUEST_TIMEOUT_MS = Number.POSITIVE_INFINITY;
    const WEB_RESEARCH_PLAN_TIMEOUT_MS = Number.POSITIVE_INFINITY;
    const WEB_RESEARCH_JUDGE_TIMEOUT_MS = Number.POSITIVE_INFINITY;
    const WEB_RESEARCH_TOTAL_TIMEOUT_MS = Number.POSITIVE_INFINITY;
    const ROADMAP_OUTPUT_PROTOCOL = String.raw\`${roadmapProtocolMatch[1]}\`;
    function isLanClientMode() { return false; }
    ${functions}
    return { searchWithPlan, runDeepResearch, buildWebContext, roadmapOutputProtocol: ROADMAP_OUTPUT_PROTOCOL };
  `);
  const Api = {
    completeText: async (payload, signal) => completeText(baseUrl, payload.messages, {
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      thinkLevel: payload.thinkLevel,
      timeoutMs: Number(process.env.DSTUDIO_REAL_CALL_TIMEOUT_MS || 0),
      signal,
    }),
  };
  const Engine = {
    webSearch: async (query, _signal, options = {}) => jsonFetch(baseUrl, '/api/web-search', {
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify({
        query,
        preferFallback: !!options.preferFallback,
        cdpOnly: !!options.cdpOnly,
      }),
      timeoutMs: 240_000,
    }),
    webRead: async (url, _signal, options = {}) => jsonFetch(baseUrl, '/api/web-read', {
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify({ url, cdpOnly: !!options.cdpOnly }),
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
          excerpt: String(s.content || '').slice(0, 4000),
        })),
      }),
    },
  ], { maxTokens: 0, timeoutMs: Number(process.env.DSTUDIO_REAL_JUDGE_TIMEOUT_MS || 0), thinkLevel: 'off' });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge did not return JSON: ${text}`);
  return JSON.parse(m[0]);
}

export async function roadmapJudge(baseUrl, { request, roadmap, sources, researchContext }) {
  const text = await completeText(baseUrl, [
    {
      role: 'system',
      content: [
        'You are a strict learning-roadmap evaluator. Return strict JSON only.',
        'Evaluate the roadmap against the learner request and the read research evidence.',
        'Score each dimension from 0 to 10: completeness, prerequisiteLogic, conceptualDepth, adaptiveGranularity, practiceAndAssessment, personalization, researchGrounding, and feasibility.',
        'Adaptive granularity means the roadmap derives its shape from conceptual breadth and learner scope: broad domains with multiple independent outcomes or prerequisite chains are split into meaningful stages or branches, while narrow skills are kept compact. Topic and stage sizes may differ. Penalize preset catalogues, uniform sizing, arbitrary count padding, broad umbrella topics, and artificial fragmentation.',
        'Penalize laundry lists, vague outcomes, circular or forward prerequisites, repeated generic exercises, invented URLs, missing foundations, missing advanced depth, and plans that cannot fit the stated time.',
        'Passing requires every dimension >= 7, overall >= 8, concrete observable mastery checks, and a coherent capstone.',
        'Schema: {"overall":number,"pass":boolean,"dimensions":{"completeness":number,"prerequisiteLogic":number,"conceptualDepth":number,"adaptiveGranularity":number,"practiceAndAssessment":number,"personalization":number,"researchGrounding":number,"feasibility":number},"strengths":["item"],"failures":["item"],"reason":"short verdict"}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        request,
        roadmap,
        researchContext: String(researchContext || '').slice(0, 36_000),
        sources: (sources || []).map((source) => ({
          title: source.title,
          url: source.url,
          read: !!source.read,
          excerpt: String(source.content || '').slice(0, 2400),
        })),
      }),
    },
  ], {
    maxTokens: 0,
    timeoutMs: Number(process.env.DSTUDIO_REAL_JUDGE_TIMEOUT_MS || 0),
    thinkLevel: 'off',
  });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`roadmap judge did not return JSON: ${text}`);
  return JSON.parse(match[0]);
}
