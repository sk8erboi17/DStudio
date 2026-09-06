// Allowlist public fictional answers/metrics; never copy runtime configuration,
// local paths, addresses, raw requests or image data from private receipts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { searchQualityCases, gradeSearchFacts } from '../fixtures/search_quality_cases.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const finite = n => { assert.ok(Number.isFinite(n) && n >= 0, 'Invalid timing'); return n; };

export function publicSearchReceipt(receipt) {
  assert.equal(receipt.status, 'complete', 'Do not publish an incomplete denominator');
  assert.equal(receipt.runs.length, searchQualityCases.length * 2);
  const seen = new Set();
  const runs = receipt.runs.map(row => {
    const task = searchQualityCases.find(c => c.id === row.id);
    assert.ok(task && ['before', 'after'].includes(row.variant));
    const key = row.id + ':' + row.variant;
    assert.ok(!seen.has(key), 'Duplicate case replaces missing evidence'); seen.add(key);
    const grade = gradeSearchFacts(task, row.facts);
    const facts = (row.facts || []).map(f => ({ fact: f.fact, ...(f.basis ? { basis: f.basis } : {}) }));
    if (receipt.fixtureVersion === 2 && task.minReadChars) assert.ok(row.readChars >= task.minReadChars, 'Late-text fixture not exercised');
    assert.ok(['pass', 'fail'].includes(row.status));
    return {
      id: row.id, variant: row.variant, originalStatus: row.status,
      originalGrade: row.grade || null,
      reviewedPass: !row.error && grade.pass, reviewedGrade: grade,
      readChars: row.readChars ?? null, captureStatus: row.captureStatus || null,
      timings: Object.fromEntries(['readMs', 'extractMs', 'totalMs'].map(k => [k, row.timings[k] === undefined ? null : finite(row.timings[k])])),
      facts, executionFailed: Boolean(row.error),
    };
  });
  return {
    schema: 'dstudio.search-evidence.public.v1', fixtureVersion: receipt.fixtureVersion || 1,
    scope: receipt.scope, started: receipt.started,
    host: { cpu: receipt.host.cpu, memoryBytes: receipt.host.memoryBytes },
    model: { file: path.basename(receipt.model.file), bytes: receipt.model.bytes },
    engineRevision: receipt.engineRevision,
    runtimeSources: Object.fromEntries(['before', 'after'].map(variant => [variant, {
      ...(receipt.sources?.[variant]?.revision ? { revision: receipt.sources[variant].revision } : {}),
      sha256: receipt.sources?.[variant]?.sha256,
    }])),
    settings: { context: receipt.launch.ctx, ssdStreaming: receipt.launch.ssdStreaming,
      nativeVisionActive: receipt.runtime.nativeVisionActive, temperature: 0, think: 'off' },
    prompts: searchQualityCases.map(c => ({ id: c.id, question: c.question, visual: Boolean(c.visual) })), runs,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [original, current, destination] = process.argv.slice(2);
  assert.ok(original && current && destination, 'Usage: node publish_search_quality.mjs ORIGINAL_JSON CURRENT_JSON PUBLIC_JSON');
  const read = file => { const bytes = fs.readFileSync(file); return { ...publicSearchReceipt(JSON.parse(bytes)), privateReceiptSha256: sha(bytes) }; };
  const result = { schema: 'dstudio.search-evidence.comparison.v1',
    limitations: [
      'Eight development cases, one paired run each: page reading and fact extraction, not full Search/Deep Research or general model quality.',
      'Before and after runtime source snapshots share the updated native host/engine. This isolates extraction/vision behavior, not an old-vs-new binary benchmark.',
      'Shared host: dependency/setup work overlapped part of collection. Timings include every case but do not establish a causal speedup; cold model load is excluded.',
      'Original fixture v1 repeated identical paragraphs that the browser deduplicated; its late-text passes are not evidence of long-page retrieval.',
      'Original visual-color grading falsely matched right inside bright. Corrected word-boundary and direction/value grading is tested and applied to both variants; original results retained.',
      'Only one native vision model was run. Two simple graphics do not qualify arbitrary screenshots or chart accuracy.',
    ], original: read(original), current: read(current) };
  assert.equal(result.current.fixtureVersion, 2);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
}
