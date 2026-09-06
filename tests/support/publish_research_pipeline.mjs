// Public results require a complete denominator and an explicit independent
// semantic review bound to each unchanged raw row. Model self-ratings are not
// consumed. Public summaries are reviewed paraphrases, not full page extracts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { researchPipelineCases } from '../fixtures/research_pipeline_cases.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const finite = value => { assert.ok(Number.isFinite(value) && value >= 0, 'Invalid measured duration'); return value; };

export function publicPipelineReceipt(receipt, review) {
  assert.equal(receipt.status, 'complete', 'Incomplete runs cannot become a complete benchmark');
  assert.deepEqual(receipt.cases, researchPipelineCases, 'Every fixed question must remain in scope');
  const variants = receipt.variants || ['before', 'after'];
  assert.ok(variants.length && variants.every(v => ['before', 'after'].includes(v)));
  assert.equal(new Set(variants).size, variants.length);
  const expectedCount = researchPipelineCases.length * variants.length;
  assert.equal(receipt.runs.length, expectedCount); assert.equal(review.rows.length, expectedCount);
  const byKey = new Map(review.rows.map(row => [row.key, row]));
  assert.equal(byKey.size, expectedCount, 'Duplicate review hides an unreviewed answer');
  const seen = new Set();
  const runs = receipt.runs.map(row => {
    const key = `${row.id}:${row.variant}`;
    assert.ok(researchPipelineCases.some(c => c.id === row.id) && variants.includes(row.variant));
    assert.ok(!seen.has(key), 'Duplicate run replaces a missing case'); seen.add(key);
    const audited = byKey.get(key); assert.ok(audited, 'Missing independent review');
    assert.equal(audited.rawRowSha256, digest(JSON.stringify(row)), 'Review is for a different result');
    for (const name of ['requestedFactsCorrect', 'sourceSupportChecked', 'noUndisclosedConflict', 'requestedFormatFollowed'])
      assert.equal(typeof audited[name], 'boolean', `Missing review criterion ${name}`);
    assert.ok(typeof audited.summary === 'string' && audited.summary.trim().length > 10);
    const complete = row.status === 'completed-pending-independent-review' && !row.error && row.delivery?.complete !== false;
    const words = String(row.answer || '').trim().split(/\s+/).filter(Boolean).length;
    const task = researchPipelineCases.find(c => c.id === row.id);
    const lengthPass = task.mode !== 'research' || (task.id === 'accessible-target-comparison' ? words < 250 : words <= 250);
    assert.ok(!audited.requestedFormatFollowed || lengthPass, 'Review cannot waive the explicit 250-word instruction');
    const pass = complete && audited.requestedFactsCorrect && audited.sourceSupportChecked &&
      audited.noUndisclosedConflict && audited.requestedFormatFollowed && lengthPass;
    return { id: row.id, variant: row.variant, originalStatus: row.status, pass,
      review: Object.fromEntries(['requestedFactsCorrect', 'sourceSupportChecked', 'noUndisclosedConflict', 'requestedFormatFollowed', 'summary'].map(k => [k, audited[k]])),
      rawRowSha256: audited.rawRowSha256, answerSha256: digest(row.answer || ''), answerWords: words,
      totalSeconds: finite(row.totalMs) / 1000,
      pipelineSeconds: row.pipelineMs === undefined ? null : finite(row.pipelineMs) / 1000,
      finalAnswerSeconds: row.pipelineMs === undefined ? null : finite(row.totalMs - row.pipelineMs) / 1000,
      modelRequests: row.requests.length,
      searchQueries: row.web.filter(w => w.type === 'search').length,
      pageReads: row.web.filter(w => w.type === 'read').length,
      extractedFacts: row.result?.facts?.length ?? 0,
      selectedAnswerFacts: row.result?.judge?.answerFactIds || [],
      automaticAnswerReview: row.result?.reportQuality?.deliveryVersion === 1 ? {
        accepted: row.result.reportQuality.ok === true,
        writerAttempts: row.result.reportAttempts?.length || 0,
        comparedNumberGroups: row.result.reportQuality.comparisons?.length || 0,
        differingDefinitionGroups: (row.result.reportQuality.comparisons || []).filter(item => item.relation === 'different').length,
        deliveredWithoutSecondWriter: Boolean(row.delivery),
      } : null,
      readSources: (row.result?.sources || []).filter(s => s.read).map(s => ({ id: s.sourceId, url: s.url })),
      executionFailed: Boolean(row.error) || row.delivery?.complete === false,
    };
  });
  const result = { started: receipt.started, scope: receipt.scope, variants,
    hardware: receipt.host, model: path.basename(receipt.model), modelBytes: receipt.modelBytes,
    engineRevision: receipt.engineRevision, settings: receipt.settings,
    before: receipt.before, after: receipt.after, runs };
  assert.ok(!/\/Users\/|\/var\/folders\/|data:image\/|remoteApiKey/.test(JSON.stringify(result)), 'Review public payload for private material');
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [input, reviewFile, destination] = process.argv.slice(2);
  assert.ok(destination, 'Pass complete results.json, independent review.json and public destination');
  const raw = fs.readFileSync(input), reviewBytes = fs.readFileSync(reviewFile);
  const output = { ...publicPipelineReceipt(JSON.parse(raw), JSON.parse(reviewBytes)),
    privateReceiptSha256: digest(raw), reviewSha256: digest(reviewBytes) };
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(output, null, 2) + '\n');
  console.log(destination);
}
