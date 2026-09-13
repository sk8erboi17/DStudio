// Common-100 request/receipt loop. Engine ownership stays in the live harness.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {httpJsonRequest} from './real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const grader = path.join(root, 'tests/support/common_model_quality.py');
const python = process.env.DSTUDIO_QUALITY_PYTHON || 'python3';
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const write = (file, value, exclusive = false) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });

export function createCommonQuality(directory) {
  const manifest = JSON.parse(execFileSync(python, ['-B', grader, '--manifest'], { cwd: root, maxBuffer: 4 * 1024 ** 2, timeout: 10000 }));
  assert.equal(manifest.cases.length, 100);
  assert.equal(new Set(manifest.cases.map(c => c.id)).size, 100);
  fs.mkdirSync(directory);
  write(path.join(directory, 'manifest.json'), manifest, true);
  const report = { schema: 'dstudio.common-quality-run.v1', directory,
    corpus: manifest.identity, runnerSha256: digest(fs.readFileSync(new URL(import.meta.url))),
    transportSha256: digest(fs.readFileSync(new URL('./real_harness.mjs',import.meta.url))),
    evaluationUse: 'first-run candidate; classify against prior exposure before publication',
    scope: manifest.scope, settings: manifest.settings, categoryCounts: manifest.counts,
    planned: 100, status: 'pending', cases: manifest.cases.map(c => ({ id: c.id, category: c.category, status: 'pending' })) };
  saveCommonQuality(report);
  return { manifest, report };
}

export function saveCommonQuality(report) {
  const count = status => report.cases.filter(row => row.status === status).length;
  report.summary = { denominator: report.planned, passed: count('pass'), failed: count('fail'),
    notRun: count('not_run'), pending: count('pending') + count('running') };
  write(path.join(report.directory, 'results.json'), report);
}

export function finishCommonQuality(report, reason) {
  for (const row of report.cases) {
    if (row.status === 'pending') Object.assign(row, { status: 'not_run', reason: reason || 'run did not reach this case' });
    else if (row.status === 'running') Object.assign(row, { status: 'fail', reason: reason || 'interrupted before a complete response' });
  }
  for (const recovery of report.recoveries || []) if (recovery.status === 'running')
    Object.assign(recovery, { status: 'fail', error: reason || 'interrupted before native readiness', finished: new Date().toISOString() });
  report.finished = new Date().toISOString();
  report.status = report.cases.every(row => row.status === 'pass') ? 'pass' : 'fail';
  saveCommonQuality(report);
  return report;
}

function requireLocalEngine(base) {
  const url = new URL(base);
  assert.equal(url.protocol, 'http:', 'common quality uses native local HTTP');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'common quality must use the owned local engine');
  assert.equal(url.username + url.password + url.search + url.hash, '', 'unexpected engine URL credentials or suffix');
  return base;
}

export async function runCommonQuality({ manifest, report }, { base, model, assertAlive = () => {}, onProgress = () => {},
  restartFailedEngine, maxEngineRestarts = 0 }) {
  let activeBase = requireLocalEngine(base);
  assert.ok(Number.isSafeInteger(maxEngineRestarts) && maxEngineRestarts >= 0 && maxEngineRestarts <= 16,
    'bounded native-engine restart count required');
  assert.ok(maxEngineRestarts === 0 || typeof restartFailedEngine === 'function', 'restart requires the native process owner');
  assert.equal(report.status, 'pending', 'do not replay or overwrite an existing evaluation');
  report.started = new Date().toISOString();
  report.status = 'running';
  report.requestedModel = model;
  report.recoveryPolicy = { maxEngineRestarts, failedCasesRetried: false };
  report.recoveries = [];
  let stopped = '';
  for (let index = 0; index < manifest.cases.length; index++) {
    const item = manifest.cases[index], row = report.cases[index];
    const request = { model, messages: [{ role: 'user', content: item.prompt }],
      temperature: manifest.settings.temperature, seed: manifest.settings.seed,
      max_tokens: item.max_tokens, think: false, thinking: { type: 'disabled' }, stream: false };
    const directory = path.join(report.directory, `${String(index + 1).padStart(3, '0')}-${item.id}`);
    row.status = 'running'; row.started = new Date().toISOString(); row.deadlineMs = item.deadline_ms;
    const began = performance.now();
    let receivedCompleteHTTP = false;
    try {
      assertAlive();
      for (const [file, hash] of Object.entries(manifest.files))
        assert.equal(digest(fs.readFileSync(path.join(root, file))), hash, `Frozen quality input changed: ${file}`);
      fs.mkdirSync(directory);
      write(path.join(directory, 'request.json'), request, true);
      saveCommonQuality(report); onProgress();
      const response = await httpJsonRequest(activeBase + '/v1/chat/completions', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ds4web' },
        body: JSON.stringify(request), signal: AbortSignal.timeout(item.deadline_ms),maxResponseBytes:2*1024**2 });
      const raw = await response.text();
      fs.writeFileSync(path.join(directory, 'response.json'), raw, { flag: 'wx' });
      row.httpStatus = response.status;
      assert.equal(response.status, 200, `HTTP ${response.status}: ${raw.slice(0, 2000)}`);
      const body = JSON.parse(raw);
      receivedCompleteHTTP = true;
      row.usage = body.usage;
      row.responseModel = body.model;
      row.finishReason = body.choices?.[0]?.finish_reason;
      assert.equal(body.choices?.length, 1, 'expected exactly one response choice');
      assert.equal(row.finishReason, 'stop', 'truncated or incomplete answer');
      const answer = body.choices[0].message?.content;
      assert.equal(typeof answer, 'string', 'no textual answer');
      assert.ok(answer.length, 'empty answer');
      const graded = execFileSync(python, ['-B', grader, '--grade', item.id, '--out', path.join(directory, 'oracle')],
        { cwd: root, input: JSON.stringify({ identity: manifest.identity, answer }), encoding: 'utf8',
          maxBuffer: 1024 ** 2, timeout: item.kind === 'patch' ? 25000 : 15000 });
      row.grade = JSON.parse(graded);
      row.promptCoverage = item.minimum_prompt_tokens
        ? Number.isSafeInteger(row.usage?.prompt_tokens) && row.usage.prompt_tokens >= item.minimum_prompt_tokens : true;
      row.minimumPromptTokens = item.minimum_prompt_tokens;
      row.status = row.grade.passed && row.promptCoverage ? 'pass' : 'fail';
      if (!row.promptCoverage) row.error = 'long-context coverage not demonstrated by actual prompt token usage';
    } catch (error) {
      row.status = 'fail'; row.error = error.stack || String(error);
      if(error.code)row.errorCode=error.code;
      if(error.cause)row.errorCause={name:error.cause.name,code:error.cause.code,message:error.cause.message};
      // An aborted transport or server error may leave native inference active.
      // Do not enqueue another request or count the unexecuted cases as passes.
      if (!receivedCompleteHTTP) stopped = `${item.id}: ${error.message}`;
      if (error.code === 'ETIMEDOUT' || error.status !== undefined) stopped ||= `${item.id}: evaluator failed`;
    } finally {
      row.elapsedMs = performance.now() - began;
      row.finished = new Date().toISOString();
      saveCommonQuality(report); onProgress();
      console.log(`common-100 ${index + 1}/100 ${item.id}: ${row.status}`);
    }
    if (stopped) {
      if (!restartFailedEngine || report.recoveries.length >= maxEngineRestarts || index + 1 === manifest.cases.length) break;
      const recovery = { afterCaseId: item.id, started: new Date().toISOString(), status: 'running', reason: stopped };
      report.recoveries.push(recovery); saveCommonQuality(report); onProgress();
      try {
        // Only the process owner may reap the old engine and establish the new
        // one. Await that handoff before sending the next independent case;
        // never retry this failed request, overwrite its receipt or overlap LLMs.
        const next = await restartFailedEngine({ afterCaseId: item.id, previousBase: activeBase });
        assert.equal(next.model, model, 'engine restart must preserve the selected model');
        activeBase = requireLocalEngine(next.base);
        assertAlive(); recovery.status = 'ready'; stopped = '';
      } catch (error) {
        recovery.status = 'fail'; recovery.error = error.stack || String(error);
        stopped = `native engine restart failed after ${item.id}: ${error.message}`;
      } finally {
        recovery.finished = new Date().toISOString(); saveCommonQuality(report); onProgress();
      }
      if (stopped) break;
    }
  }
  return finishCommonQuality(report, stopped);
}
