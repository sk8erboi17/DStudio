import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  artifactDir,
  csrfHeaders,
  jsonFetch,
  startDStudio,
  writeArtifact,
} from '../support/real_harness.mjs';

const booksDir = path.resolve(process.env.DSTUDIO_RAG_BOOKS_DIR ||
  path.join(os.homedir(), 'Desktop', 'Books'));
assert.ok(fs.statSync(booksDir).isDirectory(), `Books directory not found: ${booksDir}`);

const artifacts = artifactDir('pdf-rag-real');
const keepArtifacts = process.env.DSTUDIO_RAG_KEEP_ARTIFACTS === '1';
let previousReport = null;
if (keepArtifacts) {
  try {
    previousReport = JSON.parse(fs.readFileSync(path.join(artifacts, 'report.json'), 'utf8'));
  } catch {}
}
if (!keepArtifacts) {
  for (const name of fs.readdirSync(artifacts)) {
    fs.rmSync(path.join(artifacts, name), { recursive: true, force: true });
  }
}
const cacheDir = path.join(artifacts, 'cache');
fs.mkdirSync(cacheDir, { recursive: true });
process.env.DSTUDIO_PDF_CACHE_DIR = cacheDir;
process.env.DSTUDIO_EMBED_DIR ||= path.join(os.homedir(), '.dstudio', 'llama-embed');
process.env.DSTUDIO_EMBED_BIN_DIR ||= path.join(os.homedir(), '.dstudio', 'llama-vision');
process.env.HF_HOME ||= path.join(os.homedir(), '.cache', 'huggingface');
process.env.DS4UI_TEST_MODE = '1'; // PDF/embedding endpoints only; never load the 86GB chat model.

const names = fs.readdirSync(booksDir).filter((name) => name.toLowerCase().endsWith('.pdf'));
function book(fragment) {
  const found = names.find((name) => name.toLowerCase().includes(fragment.toLowerCase()));
  assert.ok(found, `PDF matching "${fragment}" not found in ${booksDir}`);
  return path.join(booksDir, found);
}

const allCases = [
  {
    id: 'attention-positional',
    pdf: book('Attention Is All You Need'),
    query: 'How does the Transformer inject token order without recurrence, and why are sine and cosine frequencies useful for relative positions?',
    alternateQuery: 'In the Transformer paper, what are the positional-encoding equations and why are their wavelengths arranged as a geometric progression?',
    expectedPages: [6],
    evidence: /positional encod|sine and cosine|sinusoid/i,
  },
  {
    id: 'hnsw-levels',
    pdf: book('Hierarchical Navigable Small World'),
    query: 'How does HNSW randomly choose the maximum layer of a new element, and why does that distribution produce logarithmic search scaling?',
    alternateQuery: 'What probability law governs an element level in HNSW, and what normalization factor mL does the paper recommend?',
    expectedPages: [3, 4],
    evidence: /exponential|geometric distribution|maximum layer|mL parameter/i,
  },
  {
    id: 'faiss-fastscan',
    pdf: book('THE FAISS LIBRARY'),
    query: 'Which Faiss optimization interleaves quantized codes so SIMD register shuffles can evaluate several product-quantization lookup tables in parallel?',
    alternateQuery: 'Explain how Faiss FastScan lays out product-quantization codes and performs SIMD table lookups from registers.',
    expectedPages: [21],
    evidence: /FastScan|interleaved|LUT lookups|register/i,
  },
  {
    id: 'fluent-iterator',
    pdf: book('Fluent Python'),
    query: 'Why should a Python iterable create a fresh independent iterator for every traversal instead of acting as its own iterator, and how does the Sentence example evolve?',
    alternateQuery: 'Which protocol difference between an iterable and an iterator allows two independent loops over Sentence, and how is SentenceIterator used?',
    expectedPages: [633, 634, 635, 636, 637],
    evidence: /SentenceIterator|multiple independent iterators|iterable.*iterator|generator function/i,
  },
  {
    id: 'pml-reparameterization',
    pdf: book('Probabilistic Machine Learning'),
    query: 'How does the VAE reparameterization trick move randomness outside the encoder parameters so gradients can flow through the sampled latent variable?',
    alternateQuery: 'Write the Gaussian latent-sample reparameterization used by a VAE and explain why it permits backpropagation through the encoder.',
    expectedPages: [715, 716],
    evidence: /reparameterization trick|gradients can flow|expectation is independent/i,
  },
];
const requestedCases = new Set(String(process.env.DSTUDIO_RAG_CASES || '')
  .split(',').map((value) => value.trim()).filter(Boolean));
const cases = requestedCases.size
  ? allCases.filter((testCase) => requestedCases.has(testCase.id))
  : allCases;
assert.ok(cases.length, `No RAG cases matched DSTUDIO_RAG_CASES=${[...requestedCases].join(',')}`);

function selectedPages(text) {
  return [...String(text || '').matchAll(/--- Pagina (\d+) \(/g)].map((match) => Number(match[1]));
}

const server = await startDStudio({ binaryArg: process.argv[2], label: 'dstudio-pdf-rag-real' });
try {
  const setupStarted = performance.now();
  const setup = await jsonFetch(server.baseUrl, '/api/embed/setup', {
    method: 'POST',
    headers: csrfHeaders,
    body: '{}',
    timeoutMs: Number(process.env.DSTUDIO_RAG_SETUP_TIMEOUT_MS || 1_200_000),
  });
  assert.equal(setup.ok, true, `embedding setup failed: ${JSON.stringify(setup)}`);
  const report = {
    generatedAt: new Date().toISOString(),
    runKind: keepArtifacts ? 'cache-preserved' : 'clean-cache',
    setupMs: Math.round(performance.now() - setupStarted),
    cases: [],
  };

  for (const testCase of cases) {
    const payload = {
      path: testCase.pdf,
      profile: 'semantic',
      semantic_query: testCase.query,
      max_chars: 20 * 1024,
    };
    const started = performance.now();
    const result = await jsonFetch(server.baseUrl, '/api/pdf/describe', {
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify(payload),
      timeoutMs: Number(process.env.DSTUDIO_RAG_CALL_TIMEOUT_MS || 1_800_000),
    });
    const coldMs = Math.round(performance.now() - started);
    const pages = selectedPages(result.text);
    const hit = testCase.expectedPages.some((page) => pages.includes(page));
    assert.equal(result.ok, true, `${testCase.id}: read failed`);
    assert.equal(result.hybrid, true, `${testCase.id}: should use hybrid retrieval`);
    assert.ok(result.retrievalChunks > 0, `${testCase.id}: should index overlapping passages`);
    assert.ok(result.retrievalChunks >= result.total,
      `${testCase.id}: passage index should cover at least one chunk per text page`);
    assert.equal(hit, true,
      `${testCase.id}: expected one of pages ${testCase.expectedPages}, retrieved ${pages}`);
    assert.match(result.text, testCase.evidence,
      `${testCase.id}: retrieved context should contain answer-bearing evidence`);
    assert.ok(result.contentChars <= 21 * 1024,
      `${testCase.id}: fixed prompt budget should remain bounded`);

    const warmStarted = performance.now();
    const warm = await jsonFetch(server.baseUrl, '/api/pdf/describe', {
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify(payload),
      timeoutMs: 120_000,
    });
    const warmMs = Math.round(performance.now() - warmStarted);
    assert.equal(warm.cached, true, `${testCase.id}: identical retrieval should hit the response cache`);
    if (!result.cached) {
      assert.ok(warmMs < coldMs, `${testCase.id}: warm retrieval should be faster than cold retrieval`);
    }

    const alternatePayload = { ...payload, semantic_query: testCase.alternateQuery };
    const alternateStarted = performance.now();
    const alternate = await jsonFetch(server.baseUrl, '/api/pdf/describe', {
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify(alternatePayload),
      timeoutMs: 120_000,
    });
    const alternateMs = Math.round(performance.now() - alternateStarted);
    const alternatePages = selectedPages(alternate.text);
    assert.equal(alternate.ok, true, `${testCase.id}: alternate-query read failed`);
    assert.equal(alternate.hybrid, true, `${testCase.id}: alternate query should use hybrid retrieval`);
    assert.ok(testCase.expectedPages.some((page) => alternatePages.includes(page)),
      `${testCase.id}: alternate query expected one of pages ${testCase.expectedPages}, retrieved ${alternatePages}`);
    assert.match(alternate.text, testCase.evidence,
      `${testCase.id}: alternate query should retain answer-bearing evidence`);
    assert.equal(alternate.textLayerCached, true,
      `${testCase.id}: a different query should reuse the extracted text layer`);
    assert.equal(alternate.embeddingIndexCached, true,
      `${testCase.id}: a different query should reuse the embedding index`);
    assert.equal(alternate.figureIndexCached, true,
      `${testCase.id}: a different query should reuse the figure index`);
    if (!result.cached && !alternate.cached) {
      assert.ok(alternateMs < coldMs,
        `${testCase.id}: different-query retrieval with document caches should beat cold indexing`);
    }

    const item = {
      id: testCase.id,
      pdf: path.basename(testCase.pdf),
      query: testCase.query,
      totalPages: result.total,
      retrievalChunks: result.retrievalChunks,
      selectedPages: pages,
      expectedPages: testCase.expectedPages,
      contentChars: result.contentChars,
      coldCached: result.cached === true,
      coldMs,
      warmMs,
      alternateQuery: testCase.alternateQuery,
      alternateSelectedPages: alternatePages,
      alternateCached: alternate.cached === true,
      alternateMs,
      documentCaches: {
        textLayer: alternate.textLayerCached === true,
        embeddings: alternate.embeddingIndexCached === true,
        figures: alternate.figureIndexCached === true,
      },
    };
    report.cases.push(item);
    writeArtifact(artifacts, `${testCase.id}-context.txt`, result.text);
    writeArtifact(artifacts, `${testCase.id}-alternate-context.txt`, alternate.text);
    const firstLabel = result.cached ? 'cached-first' : 'cold';
    console.log(`${testCase.id}: pages ${pages.join(', ')}; ${result.retrievalChunks} chunks; ${firstLabel} ${coldMs} ms; alternate ${alternateMs} ms; warm ${warmMs} ms`);
  }
  const previousRuns = Array.isArray(previousReport?.runs)
    ? previousReport.runs
    : previousReport?.cases
      ? [{
          generatedAt: previousReport.generatedAt || null,
          runKind: previousReport.runKind || 'legacy',
          setupMs: previousReport.setupMs,
          cases: previousReport.cases,
        }]
      : [];
  report.runs = [
    ...previousRuns,
    {
      generatedAt: report.generatedAt,
      runKind: report.runKind,
      setupMs: report.setupMs,
      cases: report.cases,
    },
  ].slice(-6);
  writeArtifact(artifacts, 'report.json', report);
  console.log('real_pdf_rag_test: ok');
} finally {
  await server.stop();
}
