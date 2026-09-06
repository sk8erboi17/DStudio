import assert from 'node:assert/strict';
import fs from 'node:fs';
import { publicSearchReceipt } from '../support/publish_search_quality.mjs';
const published = JSON.parse(fs.readFileSync('extension/search/bench/results/2026-09-06-m2-max-evidence.json'));
assert.equal(published.current.runs.length, 16);
for (const [variant, passes] of [['before', 3], ['after', 8]])
  assert.equal(published.current.runs.filter(r => r.variant === variant && r.reviewedPass).length, passes);
// A synthetic adapter receipt tests export boundaries, not model quality.
const input = { status: 'complete', fixtureVersion: 2, host: published.current.host,
  model: { file: '/private/secret/model.gguf', bytes: 1 }, sources: { before: { privateToken: 'DO_NOT_EXPORT' } }, launch: { ctx: 8192 },
  runtime: { nativeVisionActive: true, privateToken: 'DO_NOT_EXPORT' },
  runs: published.current.runs.map(r => ({ ...r, status: r.originalStatus, grade: r.originalGrade, privatePath: '/private/secret' })),
};
const result = publicSearchReceipt(input);
assert.ok(!JSON.stringify(result).includes('/private/'));
assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPORT'));
assert.throws(() => publicSearchReceipt({ ...input, status: 'running' }));
assert.throws(() => publicSearchReceipt({ ...input, runs: [...input.runs.slice(1), input.runs[1]] }));
const short = structuredClone(input);
short.runs.find(r => r.id === 'late-setting').readChars = 600;
assert.throws(() => publicSearchReceipt(short));
const corrupt = structuredClone(input); corrupt.runs[0].timings.totalMs = -1;
assert.throws(() => publicSearchReceipt(corrupt));
assert.ok(published.original.runs.some(r => r.originalStatus === 'fail' && r.reviewedPass), 'Original grader failure must remain visible');
console.log('search_publication: full denominators, retained failures, metrics and private-field exclusion passed');
