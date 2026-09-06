import assert from 'node:assert/strict';
import { researchRegressions } from '../support/check_research_quality.mjs';
import { publicPipelineReceipt, digest } from '../support/publish_research_pipeline.mjs';
import { researchPipelineCases } from '../fixtures/research_pipeline_cases.mjs';

// Synthetic bookkeeping, not synthetic results published as real inference.
const receipt = { status: 'complete', cases: researchPipelineCases, variants: ['before', 'after'],
  model: 'fixture.gguf', host: {}, settings: {}, runs: researchPipelineCases.flatMap(task => ['before', 'after'].map(variant => ({
    id: task.id, variant, status: 'completed-pending-independent-review', answer: 'Fixture answer.',
    requests: [1], web: [], totalMs: 2000, pipelineMs: 1500,
  }))) };
const review = { rows: receipt.runs.map(row => ({ key: `${row.id}:${row.variant}`, rawRowSha256: digest(JSON.stringify(row)),
  requestedFactsCorrect: true, sourceSupportChecked: true, noUndisclosedConflict: true, requestedFormatFollowed: true,
  summary: 'Synthetic accounting check only.',
})) };
const output = publicPipelineReceipt(receipt, review);
assert.equal(output.runs.length, 8); assert.equal(output.runs[0].finalAnswerSeconds, .5);
const failed = structuredClone(review); failed.rows[0].noUndisclosedConflict = false;
assert.equal(publicPipelineReceipt(receipt, failed).runs.filter(r => r.pass).length, 7, 'Source conflicts remain failures');
const selfApproved = structuredClone(receipt);
selfApproved.runs[0].result = { reportQuality: { deliveryVersion: 1, ok: true } };
const independentlyRejected = structuredClone(failed);
independentlyRejected.rows[0].rawRowSha256 = digest(JSON.stringify(selfApproved.runs[0]));
const selfApprovedOutput = publicPipelineReceipt(selfApproved, independentlyRejected).runs[0];
assert.equal(selfApprovedOutput.automaticAnswerReview.accepted, true);
assert.equal(selfApprovedOutput.pass, false, 'Automatic review never overrides an independently observed error');
const notDelivered = structuredClone(receipt);
notDelivered.runs[0].delivery = { complete: false };
const deliveryReview = structuredClone(review);
deliveryReview.rows[0].rawRowSha256 = digest(JSON.stringify(notDelivered.runs[0]));
assert.equal(publicPipelineReceipt(notDelivered, deliveryReview).runs[0].pass, false);
const changed = structuredClone(receipt); changed.runs[0].answer = 'Changed answer';
assert.throws(() => publicPipelineReceipt(changed, review), /different result/);
assert.throws(() => publicPipelineReceipt({ ...receipt, status: 'running' }, review), /Incomplete/);
assert.throws(() => publicPipelineReceipt({ ...receipt, runs: receipt.runs.slice(1) }, review));
assert.throws(() => publicPipelineReceipt(receipt, { rows: review.rows.map(() => review.rows[0]) }), /Duplicate/);
const tooLong = structuredClone(receipt); tooLong.runs[4].answer = 'word '.repeat(251);
const waived = structuredClone(review); waived.rows[4].rawRowSha256 = digest(JSON.stringify(tooLong.runs[4]));
assert.throws(() => publicPipelineReceipt(tooLong, waived), /250-word/);
const exclusive = structuredClone(receipt); exclusive.runs[6].answer = 'word '.repeat(250);
const exclusiveReview = structuredClone(review); exclusiveReview.rows[6].rawRowSha256 = digest(JSON.stringify(exclusive.runs[6]));
assert.throws(() => publicPipelineReceipt(exclusive, exclusiveReview), /250-word/, 'Below 250 is exclusive, unlike at most 250');
const leaked = structuredClone(review); leaked.rows[0].summary = 'Private /Users/example/report.txt';
assert.throws(() => publicPipelineReceipt(receipt, leaked), /private material/);
const candidate = { variants: ['after'], runs: structuredClone(output.runs.filter(row => row.variant === 'after')) };
assert.deepEqual(researchRegressions(output, candidate), []);
candidate.runs[1].review.requestedFactsCorrect = false;
assert.deepEqual(researchRegressions(output, candidate), ['python-versioned-suffix: lost requestedFactsCorrect']);
const partialReference = structuredClone(output);
for (const row of partialReference.runs.filter(row => row.id === 'venus-rotation-orbit')) row.review.noUndisclosedConflict = false;
candidate.runs[1].review.requestedFactsCorrect = true;
candidate.runs[2].review.noUndisclosedConflict = false;
assert.deepEqual(researchRegressions(partialReference, candidate), [], 'An explicitly recorded unresolved failure is not a new regression');
assert.throws(() => researchRegressions(output, { ...candidate, runs: candidate.runs.slice(1) }));
assert.throws(() => researchRegressions(output, { ...candidate, runs: candidate.runs.map(() => candidate.runs[0]) }));
console.log('research_pipeline_publication: full denominators, conflict failures, exact review binding, word limit, timing/privacy and per-requirement regression gate passed');
