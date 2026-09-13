// Real HTTP + actual grader, deliberately simulated model replies. No weights.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { artifactRunDir } from '../support/real_harness.mjs';
import { createCommonQuality, runCommonQuality, finishCommonQuality } from '../support/common_quality_runner.mjs';

const run = artifactRunDir('common-quality-http');
const golden = JSON.parse(execFileSync('python3', ['-B', '-c',
  "import sys,json; sys.path.insert(0,'tests/support'); import common_model_quality as q; print(json.dumps([q.golden_answer(c) for c in q.CASES]))"],
{ encoding: 'utf8', maxBuffer: 1024 ** 2 }));
let scenario = 'full', index = 0, inFlight = 0, peak = 0;
let expectedManifest;
const errors = [];
const server = http.createServer(async (req, res) => {
  inFlight++; peak = Math.max(peak, inFlight);
  try {
    assert.equal(req.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const packet = JSON.parse(Buffer.concat(chunks));
    assert.equal(packet.model, 'fixture-not-a-real-model');
    assert.equal(packet.messages[0].content, expectedManifest.cases[index].prompt);
    assert.equal(packet.max_tokens, 2048);
    assert.equal(packet.temperature, 0);
    assert.equal(packet.seed, 20260909);
    assert.equal(packet.think, false);
    assert.deepEqual(packet.thinking, { type: 'disabled' });
    const current = index++;
    if (scenario.startsWith('http-failure') && (current === 2 || (scenario === 'http-failure-limit' && current === 3))) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'fixture engine crashed' }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: packet.model,
      usage: { prompt_tokens: scenario === 'full' && current === 87 ? 200 : 30000, completion_tokens: 10 },
      choices: [{ finish_reason: scenario === 'full' && current === 1 ? 'length' : 'stop',
        message: { role: 'assistant', content: scenario === 'full' && current === 0 ? '999' : golden[current] } }] }));
  } catch (error) {
    errors.push(error.stack);
    res.writeHead(500); res.end(JSON.stringify({ error: error.message }));
  } finally { inFlight--; }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const full = createCommonQuality(path.join(run, 'full'));
  expectedManifest = full.manifest;
  await runCommonQuality(full, { base, model: 'fixture-not-a-real-model' });
  assert.deepEqual(full.report.summary, { denominator: 100, passed: 97, failed: 3, notRun: 0, pending: 0 });
  assert.equal(full.report.cases[87].category, 'long_context');
  assert.equal(full.report.cases[87].grade.passed, true);
  assert.equal(full.report.cases[87].promptCoverage, false, 'correct answer is not sufficient for a long-context claim');
  assert.equal(index, 100, 'wrong answers and truncation do not erase subsequent cases');
  assert.equal(peak, 1, 'requests must be sequential');
  assert.equal(errors.length, 0, errors.join('\n'));
  await assert.rejects(runCommonQuality(full, { base, model: 'fixture-not-a-real-model' }), /replay|overwrite/);

  scenario = 'http-failure'; index = 0;
  const failed = createCommonQuality(path.join(run, 'http-failure'));
  expectedManifest = failed.manifest;
  await runCommonQuality(failed, { base, model: 'fixture-not-a-real-model' });
  assert.deepEqual(failed.report.summary, { denominator: 100, passed: 2, failed: 1, notRun: 97, pending: 0 });
  assert.equal(index, 3, 'do not send more work after an ambiguous native transport failure');
  const raw = JSON.parse(fs.readFileSync(path.join(failed.report.directory, '003-arithmetic-rational/response.json')));
  assert.equal(raw.error, 'fixture engine crashed');

  scenario = 'http-failure-recovery'; index = 0;
  const recovered = createCommonQuality(path.join(run, 'engine-recovery'));
  expectedManifest = recovered.manifest;
  let recoveries = 0;
  const entered = Promise.withResolvers(), handoff = Promise.withResolvers();
  const recovering = runCommonQuality(recovered, {base, model: 'fixture-not-a-real-model', maxEngineRestarts: 1,
    restartFailedEngine: async ({afterCaseId, previousBase}) => {
      recoveries++;
      assert.equal(afterCaseId, expectedManifest.cases[2].id);
      assert.equal(previousBase, base); assert.equal(index, 3);
      // Deterministic owner-handoff barrier: no next request may be enqueued.
      entered.resolve(); await handoff.promise;
      assert.equal(index, 3); assert.equal(inFlight, 0);
      return {base, model: 'fixture-not-a-real-model'};
    }});
  await entered.promise;
  assert.equal(index, 3); assert.equal(recovered.report.cases[3].status, 'pending');
  assert.equal(recovered.report.recoveries[0].status, 'running');
  handoff.resolve(); await recovering;
  assert.equal(recoveries, 1); assert.equal(index, 100);
  assert.deepEqual(recovered.report.summary, {denominator: 100, passed: 99, failed: 1, notRun: 0, pending: 0});
  assert.equal(recovered.report.cases[2].httpStatus, 500, 'original failed case must not be retried');
  assert.equal(recovered.report.recoveries[0].status, 'ready');
  assert.equal(recovered.report.status, 'fail', 'later successes cannot erase the earlier failure');

  scenario = 'http-failure-limit'; index = 0;
  const limited = createCommonQuality(path.join(run, 'recovery-limit'));
  expectedManifest = limited.manifest; recoveries = 0;
  await runCommonQuality(limited, {base, model: 'fixture-not-a-real-model', maxEngineRestarts: 1,
    restartFailedEngine: async () => {recoveries++; return {base, model: 'fixture-not-a-real-model'};}});
  assert.equal(recoveries, 1); assert.equal(index, 4);
  assert.deepEqual(limited.report.summary, {denominator: 100, passed: 2, failed: 2, notRun: 96, pending: 0});

  for (const issue of ['failed-owner', 'changed-model', 'external-url']) {
    scenario = 'http-failure'; index = 0;
    const rejected = createCommonQuality(path.join(run, issue)); expectedManifest = rejected.manifest;
    await runCommonQuality(rejected, {base, model: 'fixture-not-a-real-model', maxEngineRestarts: 1,
      restartFailedEngine: async () => {
        if (issue === 'failed-owner') throw Error('fixture old engine not reaped');
        return {base: issue === 'external-url' ? 'http://example.invalid' : base,
          model: issue === 'changed-model' ? 'different-model' : 'fixture-not-a-real-model'};
      }});
    assert.equal(index, 3); assert.equal(rejected.report.recoveries[0].status, 'fail');
    assert.deepEqual(rejected.report.summary, {denominator: 100, passed: 2, failed: 1, notRun: 97, pending: 0});
  }

  const absent = createCommonQuality(path.join(run, 'missing-weights'));
  finishCommonQuality(absent.report, 'fixture weights unavailable');
  assert.deepEqual(absent.report.summary, { denominator: 100, passed: 0, failed: 0, notRun: 100, pending: 0 });
  assert.equal(absent.report.status, 'fail');
  assert.ok(absent.report.cases.every(row => row.reason === 'fixture weights unavailable'));
  const interrupted = createCommonQuality(path.join(run, 'interrupted-owner'));
  interrupted.report.cases[0].status = 'running';
  interrupted.report.recoveries = [{afterCaseId: interrupted.report.cases[0].id, status: 'running'}];
  finishCommonQuality(interrupted.report, 'SIGTERM');
  assert.deepEqual(interrupted.report.summary, {denominator: 100, passed: 0, failed: 1, notRun: 99, pending: 0});
  assert.equal(interrupted.report.recoveries[0].status, 'fail');
  assert.equal(interrupted.report.recoveries[0].error, 'SIGTERM');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`PASS common-100 HTTP/evaluator accounting; simulated replies only. ${run}`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
