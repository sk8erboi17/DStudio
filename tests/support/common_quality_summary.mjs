// Public aggregate only. Never rewrite scores or publish raw prompts/paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const areas = {
  arithmetic: ['Calcolo e unità', 12], reasoning: ['Ragionamento', 12],
  code: ['Codice prodotto', 15], debugging: ['Correzione di bug', 10],
  json: ['JSON e struttura', 10], extraction: ['Estrazione di dati', 10],
  instructions: ['Istruzioni e formato', 10], language: ['Italiano e inglese', 8],
  long_context: ['Contesto lungo', 8], insufficient: ['Dati insufficienti', 5],
};
function sameJSON(a, b) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && sameJSON(a[k], b[k]));
}

export function failureClass(row) {
  if (row.status === 'not_run') return 'not_run';
  if (row.status === 'pass') return null;
  if (row.promptCoverage === false) return 'coverage_missing';
  if (row.finishReason && row.finishReason !== 'stop') return 'incomplete_answer';
  if (row.httpStatus && row.httpStatus !== 200) return 'transport_or_engine_error';
  const grade = row.grade;
  if(!grade) return row.httpStatus===200&&row.finishReason==='stop'?'ungraded_response':'transport_or_engine_error';
  // This is diagnostic classification, NOT partial credit or a regrade. A
  // scalar/array wrapped in an unrequested object still fails the task.
  if (grade && Object.hasOwn(grade, 'expected') && grade.actual &&
      !Array.isArray(grade.actual) && typeof grade.actual === 'object' &&
      (Array.isArray(grade.expected) || grade.expected === null || typeof grade.expected !== 'object')) {
    const values = Object.values(grade.actual);
    if (values.length === 1 && sameJSON(values[0], grade.expected)) return 'right_value_wrong_container';
  }
  if (['code', 'debugging'].includes(row.category)) return 'code_or_patch_failure';
  if (grade?.error) return 'unparseable_or_invalid_format';
  return 'wrong_answer_or_structure';
}

export function summarizeCommonQuality(report, receiptSha256) {
  assert.equal(report.schema, 'dstudio.common-quality-run.v1');
  assert.equal(report.planned, 100);
  assert.equal(report.cases?.length, 100, 'unexecuted cases must remain in the denominator');
  assert.equal(new Set(report.cases.map(row => row.id)).size, 100);
  assert.ok(report.finished && ['pass', 'fail'].includes(report.status), 'only terminal runs can be published');
  assert.match(report.corpus, /^[0-9a-f]{64}$/);
  assert.match(receiptSha256, /^[0-9a-f]{64}$/);
  const failures = {}, categories = [];
  for (const [area, [label, expected]] of Object.entries(areas)) {
    const rows = report.cases.filter(row => row.category === area);
    assert.equal(rows.length, expected, `missing cases in ${area}`);
    const count = status => rows.filter(row => row.status === status).length;
    for (const row of rows) {
      assert.ok(['pass', 'fail', 'not_run'].includes(row.status));
      const reason = failureClass(row);
      if (reason) failures[reason] = (failures[reason] || 0) + 1;
    }
    categories.push({ area, label, cases: expected, passed: count('pass'), failed: count('fail'), notRun: count('not_run') });
  }
  const sum = key => categories.reduce((total, area) => total + area[key], 0);
  const summary = { denominator: 100, passed: sum('passed'), failed: sum('failed'), notRun: sum('notRun'), pending: 0 };
  assert.deepEqual(report.summary, summary, 'stored score disagrees with observable case outcomes');
  assert.equal(report.status, summary.passed === 100 ? 'pass' : 'fail');
  const runtime = report.runtime;
  const recoveries = report.recoveries || [], policy = report.recoveryPolicy || { maxEngineRestarts: 0, failedCasesRetried: false };
  assert.ok(Number.isSafeInteger(policy.maxEngineRestarts) && policy.maxEngineRestarts >= 0 && policy.maxEngineRestarts <= 16);
  assert.equal(policy.failedCasesRetried, false, 'retries cannot replace original failed cases');
  assert.ok(recoveries.length <= policy.maxEngineRestarts);
  assert.equal(new Set(recoveries.map(x => x.afterCaseId)).size, recoveries.length);
  for (const recovery of recoveries) {
    assert.ok(['ready', 'fail'].includes(recovery.status), 'unfinished native recovery cannot be published');
    assert.equal(report.cases.find(x => x.id === recovery.afterCaseId)?.status, 'fail', 'recovery must retain its triggering failure');
  }
  const engineRestarts = { limit: policy.maxEngineRestarts, requested: recoveries.length,
    ready: recoveries.filter(x => x.status === 'ready').length, failed: recoveries.filter(x => x.status === 'fail').length,
    failedCasesRetried: false };
  if (summary.passed || summary.failed) {
    assert.match(runtime?.model?.sha256 || '', /^[0-9a-f]{64}$/, 'model evidence is required; simulated HTTP tests are not model quality');
    assert.match(runtime?.binarySha256 || '', /^[0-9a-f]{64}$/);
  }
  let correction;
  if(report.regrading) {
    const original=report.regrading.originalSummary;
    assert.equal(original.denominator,100);
    assert.equal(original.pending,0);
    for(const key of ['passed','failed','notRun'])assert.ok(Number.isInteger(original[key]) && original[key]>=0);
    assert.equal(original.passed+original.failed+original.notRun,100);
    assert.equal(report.regrading.inferenceRepeated,false);
    assert.match(report.regrading.sourceReceiptSha256,/^[0-9a-f]{64}$/);
    assert.match(report.regrading.sourceCorpus,/^[0-9a-f]{64}$/);
    assert.equal(report.regrading.graderCorpus,report.corpus);
    correction={originalSummary:original,sourceReceiptSha256:report.regrading.sourceReceiptSha256,
      previousCorpus:report.regrading.sourceCorpus,correctedCorpus:report.corpus,
      inferenceRepeated:false,changedCaseCount:report.regrading.changedCases.length};
  }
  return { schema: 'dstudio.common-quality-public.v1', corpus: report.corpus,
    sourceReceiptSha256: receiptSha256, evaluationUse: report.evaluationUse,
    summary, categories, failures, correction, engineRestarts,
    model: runtime ? { engine: runtime.engine, weightSha256: runtime.model?.sha256,
      weightBytes: runtime.model?.bytes, binarySha256: runtime.binarySha256,
      upstreamCommit: runtime.installer?.commit } : null,
    settings: { context: report.settings.context, temperature: report.settings.temperature,
      thinking: report.settings.thinking, seed: report.settings.seed, maxOutputTokens: report.settings.max_tokens },
    limitations: ['Controlled common-100 tasks, not general intelligence or numerical parity.',
      'Code tasks evaluate returned programs and patches, not an Agent tool loop.',
      'Every format failure remains failed, even when a nested value is correct.',
      'When enabled, an owned engine restart precedes the next case; failed cases are never retried or replaced.',
      'No raw requests, responses, personal paths or source documents are published by this aggregate.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4, 'usage: node common_quality_summary.mjs TERMINAL_RESULTS.json NEW_PUBLIC.json');
  const raw = fs.readFileSync(process.argv[2]);
  const output = summarizeCommonQuality(JSON.parse(raw), sha(raw));
  fs.writeFileSync(process.argv[3], JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(output.summary));
}
