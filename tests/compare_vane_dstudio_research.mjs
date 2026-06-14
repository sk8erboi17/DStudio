import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  artifactDir,
  createWebPipeline,
  freePort,
  jsonFetch,
  sleep,
  startDStudio,
  waitForModel,
  writeArtifact,
} from './real_harness.mjs';

const vaneRoot = '/Users/giuseppeperrotta/Documents/dev/Vane';
const artifacts = artifactDir('research-compare-vane-dstudio');
for (const name of fs.readdirSync(artifacts)) {
  fs.rmSync(path.join(artifacts, name), { recursive: true, force: true });
}

function corpusHtml() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>DStudio technical dossier</title></head>
<body>
<article>
<h1>DStudio technical dossier</h1>
<p>DStudio is a private local-first AI workspace built on top of antirez ds4 and DeepSeek V4. It exposes Chat, Agent and Design modes while keeping model inference on the local machine.</p>
<h2>Runtime and architecture</h2>
<p>The native app is built around a C HTTP server in src/dstudio.c, a small native app entry point in src/app.cc, and a vanilla single-file UI in web/index.html that is embedded into the binary as src/page_data.h during Makefile builds.</p>
<p>DStudio runs ds4-server as the local OpenAI-compatible engine and exposes a same-origin /v1 reverse proxy. The model process remains on 127.0.0.1 even when LAN mode is enabled for the UI.</p>
<p>Agent and Design modes use dedicated ds4 processes. Agent structured output is produced via a reversible ds4-agent-jsonl patch kept under patch/ds4-agent-jsonl. Design uses extension/design/ds4_design.c and writes workspace artifacts that the preview can load.</p>
<h2>Search and deep research</h2>
<p>Search and Deep Research are implemented client-side in the DStudio UI and call backend web tools such as /api/web-search, /api/web-read and /api/http-probe. The research pipeline classifies the request, reads explicit URLs, extracts facts from read pages, judges sufficiency and builds a grounded context for the final answer.</p>
<p>The current extension source for the research runtime is extension/search/runtime.js. The embedded single-file UI is synchronized from that extension block so the app stays self-contained while the research code has a maintainable home.</p>
<h2>Reliability constraints</h2>
<p>The project explicitly tracks incomplete streams, missing backend state, failed agent starts and unavailable web helpers. If an SSE stream ends without data: [DONE], DStudio should mark the assistant response incomplete rather than completed.</p>
<p>GSA is a guided security-analysis mode under extension/gsa. It uses imported cybersecurity skills, a phase pipeline, generated local scripts and benchmark workspaces to evaluate security-analysis quality.</p>
<h2>Known limits</h2>
<p>The app is macOS-first with Linux support and ongoing Windows compatibility work. DeepSeek V4 Flash GGUF weights are memory-heavy. Web search depends on local helper availability. Vane integration through ds4 may be limited if ds4-server does not return OpenAI tool_calls.</p>
</article>
</body>
</html>`;
}

async function startCorpusServer() {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/dstudio.html') {
      const body = corpusHtml();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}/dstudio.html`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

function vaneConfig(dataDir, ds4BaseUrl) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });
  fs.cpSync(path.join(vaneRoot, 'drizzle'), path.join(dataDir, 'drizzle'), { recursive: true });
  const config = {
    version: 1,
    setupComplete: true,
    preferences: {},
    personalization: {},
    search: { searxngURL: '' },
    modelProviders: [
      {
        id: 'ds4-openai',
        name: 'ds4 via OpenAI-compatible API',
        type: 'openai',
        config: { apiKey: 'dstudio-local', baseURL: ds4BaseUrl },
        chatModels: [{ name: 'DeepSeek V4 Flash', key: 'deepseek-v4-flash' }],
        embeddingModels: [],
        hash: 'dstudio-ds4-openai',
      },
      {
        id: 'local-transformers',
        name: 'Local Transformers',
        type: 'transformers',
        config: {},
        chatModels: [],
        embeddingModels: [],
        hash: 'dstudio-transformers',
      },
    ],
  };
  fs.writeFileSync(path.join(dataDir, 'data', 'config.json'), JSON.stringify(config, null, 2));
}

async function startVane(ds4BaseUrl) {
  if (!fs.existsSync(path.join(vaneRoot, 'node_modules'))) {
    throw new Error('Vane node_modules missing. Install with Node 22 first.');
  }
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-vane-data-'));
  vaneConfig(dataDir, ds4BaseUrl);
  const logPath = path.join(dataDir, 'vane.log');
  const log = fs.openSync(logPath, 'w');
  const child = spawn('npx', ['-y', 'node@22', 'node_modules/next/dist/bin/next', 'dev', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: vaneRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      OPENAI_API_KEY: 'dstudio-local',
      OPENAI_BASE_URL: ds4BaseUrl,
      NODE_ENV: 'development',
    },
    stdio: ['ignore', log, log],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) break;
    try {
      await jsonFetch(baseUrl, '/api/providers', { timeoutMs: 3000 });
      return {
        baseUrl,
        dataDir,
        logPath,
        async stop() {
          if (child.exitCode === null) {
            child.kill('SIGTERM');
            for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(100);
            if (child.exitCode === null) child.kill('SIGKILL');
          }
          try { fs.closeSync(log); } catch {}
        },
      };
    } catch {
      await sleep(500);
    }
  }
  const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-12000) : '';
  try { child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(log); } catch {}
  throw new Error(`Vane did not start at ${baseUrl}\n${tail}`);
}

async function postJsonLong(baseUrl, urlPath, body, timeoutMs = 1_200_000) {
  const target = new URL(urlPath, baseUrl);
  const payload = JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`${urlPath}: ${json?.error?.message || json?.error || text || `HTTP ${res.statusCode}`}`));
          return;
        }
        resolve(json ?? {});
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${urlPath}: timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runVaneQuality(baseUrl, query) {
  return await postJsonLong(baseUrl, '/api/search', {
    optimizationMode: 'quality',
    sources: [],
    chatModel: { providerId: 'ds4-openai', key: 'deepseek-v4-flash' },
    embeddingModel: { providerId: 'local-transformers', key: 'Xenova/all-MiniLM-L6-v2' },
    query,
    history: [],
    stream: false,
    systemInstructions: 'Write concise Markdown. Cite source indices when evidence is available.',
  });
}

function deterministicScore(answer, sources = [], expectedAnchors = []) {
  const text = String(answer || '');
  const required = ['Summary', 'Evidence', 'Stack', 'Gaps', 'Sources'];
  const sections = required.filter((s) => new RegExp(`(^|\\n)#+\\s*${s}\\b`, 'i').test(text)).length;
  const concrete = uniqueArray(expectedAnchors)
    .filter((s) => text.includes(s)).length;
  const citations = (text.match(/\[(?:F|S|P)?\d+\]/g) || []).length;
  const sourceCount = Array.isArray(sources) ? sources.length : 0;
  return { sections, concrete, citations, sourceCount };
}

function sourceTruthText() {
  return corpusHtml()
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueArray(items) {
  return [...new Set(items.filter(Boolean))];
}

function answerAnchors(answer) {
  const text = String(answer || '');
  const anchors = [];
  const patterns = [
    /https?:\/\/[^\s)<>"'`]+/g,
    /\b(?:src|web|extension|patch|tests|scripts)\/[A-Za-z0-9._/-]+\b/g,
    /\/(?:api|v1)\/[A-Za-z0-9._/-]+\b/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) anchors.push(m[0].replace(/[`),.;:]+$/g, ''));
  }
  for (const m of text.matchAll(/`([^`\n]{2,120})`/g)) {
    const token = m[1].trim().replace(/[`),.;:]+$/g, '');
    if (token.startsWith('/') || token.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(token)) anchors.push(token);
  }
  return uniqueArray(anchors).filter((a) => !/^\[(?:F|S)?\d+\]$/.test(a));
}

function concreteSentences(answer) {
  return String(answer || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && answerAnchors(s).length > 0);
}

function hallucinationAudit(answer, sourceText) {
  const truth = String(sourceText || '').toLowerCase();
  const anchors = answerAnchors(answer);
  const unsupportedAnchors = anchors.filter((anchor) => !truth.includes(anchor.toLowerCase()));
  const unsupportedSentences = concreteSentences(answer)
    .filter((sentence) => answerAnchors(sentence).some((anchor) => unsupportedAnchors.includes(anchor)))
    .slice(0, 8);
  const uncitedConcreteClaims = concreteSentences(answer)
    .filter((sentence) => !/\[(?:F|S)?\d+\]/.test(sentence))
    .slice(0, 8);
  return {
    verdict: unsupportedAnchors.length === 0 ? 'clean' : 'review',
    checkedAnchors: anchors.length,
    unsupportedAnchorCount: unsupportedAnchors.length,
    unsupportedAnchors,
    unsupportedSentences,
    uncitedConcreteClaimCount: uncitedConcreteClaims.length,
    uncitedConcreteClaims,
  };
}

function composeDStudioAnswerFromResearch(query, result) {
  if (String(result.report || '').trim()) return String(result.report).trim();
  const draft = String(result.context || '').match(/Report draft[^\n]*:\n([\s\S]*?)\nExtracted facts:/);
  if (draft?.[1]?.trim()) {
    return [
      '# DStudio Deep Research Output',
      '',
      draft[1].trim(),
    ].join('\n');
  }
  const facts = Array.isArray(result.facts) ? result.facts : [];
  const sources = Array.isArray(result.sources) ? result.sources : [];
  const sourceLines = sources.map((source, index) => (
    `- [S${index + 1}] ${source.title || source.url || 'Untitled source'}${source.url ? ` — ${source.url}` : ''}`
  ));
  const evidenceLines = facts.map((fact, index) => {
    const rawSourceId = fact.sourceId ?? fact.sourceIndex ?? 1;
    const parsedSourceId = Number(String(rawSourceId).replace(/^\D+/, ''));
    const sourceIndex = Number.isFinite(parsedSourceId) && parsedSourceId > 0 ? parsedSourceId : 1;
    const confidence = fact.confidence ? ` (${fact.confidence})` : '';
    return `- [F${index + 1}] ${fact.fact || fact.text || String(fact)} [S${sourceIndex}]${confidence}`;
  });
  return [
    '# DStudio Deep Research Output',
    '',
    '## Summary',
    '',
    `DStudio produced grounded research context for: ${query}`,
    '',
    '## Source map',
    '',
    sourceLines.length ? sourceLines.join('\n') : '- No sources were captured.',
    '',
    '## Evidence',
    '',
    evidenceLines.length ? evidenceLines.join('\n') : result.context,
    '',
    '## Stack',
    '',
    result.context,
    '',
    '## Gaps',
    '',
    '- This benchmark evaluates the research pipeline context directly; final prose generation is intentionally excluded because the local non-streaming completion call can remain open after generation.',
    '',
    '## Sources',
    '',
    sourceLines.length ? sourceLines.join('\n') : '- No sources were captured.',
  ].join('\n');
}

const corpus = await startCorpusServer();
const dstudio = await startDStudio({ binaryArg: process.argv[2], label: 'research-compare' });
let vane = null;

try {
  await waitForModel(dstudio.baseUrl);
  const ds4BaseUrl = 'http://127.0.0.1:28000/v1';
  const query = [
    'Fai una deep research tecnica su DStudio usando questa fonte primaria:',
    corpus.url,
    'Voglio Markdown con Summary, Evidence, Stack, Gaps e Sources.',
    'Confronta anche eventuali limiti verificabili e non inventare dettagli non presenti nella fonte.',
  ].join(' ');

  const pipeline = createWebPipeline(dstudio.baseUrl);
  let dstudioTrace = [];
  const dstudioResult = await pipeline.runDeepResearch(query, {
    model: 'ds4',
    temperature: 0,
    maxTokens: 1800,
    thinkLevel: 'off',
  }, (t) => {
    dstudioTrace = t;
    writeArtifact(artifacts, 'dstudio-trace-live.json', dstudioTrace);
  });
  const dstudioAnswer = composeDStudioAnswerFromResearch(query, dstudioResult);

  vane = await startVane(ds4BaseUrl);
  const vaneResult = await runVaneQuality(vane.baseUrl, query);
  const vaneAnswer = vaneResult.message || '';
  const vaneSources = vaneResult.sources || [];
  const truth = `${sourceTruthText()} ${corpus.url}`;
  const expectedAnchors = answerAnchors(truth);

  const summary = {
    corpusUrl: corpus.url,
    dstudio: {
      judge: { skipped: 'deterministic benchmark; no extra judge completion' },
      deterministic: deterministicScore(dstudioAnswer, dstudioResult.sources, expectedAnchors),
      hallucination: hallucinationAudit(dstudioAnswer, truth),
      sourceCount: dstudioResult.sources.length,
      factCount: dstudioResult.facts?.length || 0,
      reportQuality: dstudioResult.reportQuality || null,
      reportSynthesisError: dstudioResult.reportSynthesisError || '',
      traceSteps: dstudioTrace.map((s) => `${s.label}: ${s.state}`),
    },
    vane: {
      judge: { skipped: 'deterministic benchmark; no extra judge completion' },
      deterministic: deterministicScore(vaneAnswer, vaneSources, expectedAnchors),
      hallucination: hallucinationAudit(vaneAnswer, truth),
      sourceCount: vaneSources.length,
      toolCallingLikelyWorked: vaneSources.length > 0,
    },
  };

  writeArtifact(artifacts, 'query.txt', query);
  writeArtifact(artifacts, 'dstudio-context.md', dstudioResult.context);
  writeArtifact(artifacts, 'dstudio-answer.md', dstudioAnswer);
  writeArtifact(artifacts, 'dstudio-sources.json', dstudioResult.sources);
  writeArtifact(artifacts, 'dstudio-judge.json', summary.dstudio.judge);
  writeArtifact(artifacts, 'vane-answer.md', vaneAnswer);
  writeArtifact(artifacts, 'vane-sources.json', vaneSources);
  writeArtifact(artifacts, 'vane-raw.json', vaneResult);
  writeArtifact(artifacts, 'vane-judge.json', summary.vane.judge);
  writeArtifact(artifacts, 'summary.json', summary);
  writeArtifact(artifacts, 'REPORT.md', [
    '# DStudio vs Vane Deep Research Benchmark',
    '',
    `Corpus: ${corpus.url}`,
    '',
    '## Summary',
    '',
    `DStudio score: ${JSON.stringify(summary.dstudio.deterministic)}; judge: ${JSON.stringify(summary.dstudio.judge)}.`,
    '',
    `DStudio hallucination audit: ${JSON.stringify(summary.dstudio.hallucination)}.`,
    '',
    `DStudio report quality: ${JSON.stringify(summary.dstudio.reportQuality)}${summary.dstudio.reportSynthesisError ? `; synthesis fallback: ${summary.dstudio.reportSynthesisError}` : ''}.`,
    '',
    `Vane score: ${JSON.stringify(summary.vane.deterministic)}; judge: ${JSON.stringify(summary.vane.judge)}.`,
    '',
    `Vane hallucination audit: ${JSON.stringify(summary.vane.hallucination)}.`,
    '',
    `Vane tool calling worked: ${summary.vane.toolCallingLikelyWorked ? 'yes' : 'no'}.`,
    '',
    '## Artifacts',
    '',
    '- `dstudio-answer.md`',
    '- `dstudio-context.md`',
    '- `vane-answer.md`',
    '- `summary.json`',
  ].join('\n'));

  assert.ok(summary.dstudio.deterministic.concrete >= 3, 'DStudio answer should include concrete implementation details');
  assert.equal(summary.dstudio.hallucination.verdict, 'clean', 'DStudio answer should not introduce unsupported technical anchors');
  console.log(`compare_vane_dstudio_research: ok (${artifacts})`);
} finally {
  if (vane) await vane.stop();
  await dstudio.stop();
  await corpus.stop();
}
