// Preserve each previously demonstrated requirement, not just an aggregate score.
// Inputs must be independently reviewed public receipts, not model self-scores.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { researchPipelineCases } from '../fixtures/research_pipeline_cases.mjs';

export function researchRegressions(reference, candidate) {
  assert.deepEqual(candidate.variants, ['after'], 'Acceptance requires one complete current-version replay');
  assert.equal(candidate.runs.length, researchPipelineCases.length);
  assert.equal(new Set(candidate.runs.map(row => row.id)).size, researchPipelineCases.length);
  const regressions = [];
  for (const task of researchPipelineCases) {
    const earlier = reference.runs.filter(row => row.id === task.id);
    const current = candidate.runs.find(row => row.id === task.id);
    assert.ok(earlier.length && current, 'No narrowing the question set');
    if (current.executionFailed) regressions.push(`${task.id}: execution failed`);
    for (const criterion of ['requestedFactsCorrect', 'sourceSupportChecked', 'noUndisclosedConflict', 'requestedFormatFollowed']) {
      assert.equal(typeof current.review?.[criterion], 'boolean');
      assert.ok(earlier.every(row => typeof row.review?.[criterion] === 'boolean'));
      if (earlier.some(row => row.review[criterion]) && !current.review[criterion])
        regressions.push(`${task.id}: lost ${criterion}`);
    }
  }
  return regressions;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [referenceFile, candidateFile] = process.argv.slice(2);
  assert.ok(candidateFile, 'Pass reviewed reference and current public JSON');
  const failures = researchRegressions(JSON.parse(fs.readFileSync(referenceFile)), JSON.parse(fs.readFileSync(candidateFile)));
  if (failures.length) {
    console.error('Research quality regression (a shorter/faster answer cannot waive this):\n' + failures.join('\n'));
    process.exitCode = 1;
  } else console.log('No lost requirement against the recorded baseline/update strengths. Existing failed criteria remain failures, not passes.');
}
