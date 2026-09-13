// Explicit real-weight benchmark. Never downloads, stops another application,
// changes system limits or treats a partially downloaded GGUF as ready.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {freePort, sleep, jsonFetch} from '../support/real_harness.mjs';
import {prefillMetrics, workloadSummary} from '../support/main_decode_metrics.mjs';
import {ds41Model, ds41Tasks, checkDs41Answer, ds41TextReport, ds41MemoryMode} from '../support/ds41_benchmark.mjs';

const [engineArg, modelArg, outputArg, cacheArg = '8', contextArg = '32768'] = process.argv.slice(2);
assert.ok(engineArg && modelArg && outputArg,
  'Usage: node tests/live/ds41_ssd_benchmark.mjs ENGINE VERIFIED_Q2_FILE NEW_OUTPUT_DIR [EXPERT_CACHE_GIB=8] [CONTEXT=32768]');
assert.equal(process.platform, 'darwin', 'V4.1 is qualified here only for native Metal');
const cacheGiB = Number(cacheArg), context = Number(contextArg);
assert.ok(Number.isInteger(cacheGiB) && cacheGiB >= 1 && cacheGiB <= 32);
assert.ok(Number.isInteger(context) && context >= 4096 && context <= 32768);
const inherited = Object.keys(process.env).filter(k => /^(DS4_|DS4UI_|DSTUDIO_|METAL_)/.test(k));
assert.equal(inherited.length, 0, 'Remove inherited engine overrides: ' + inherited.join(', '));
const engine = fs.realpathSync(engineArg), model = path.resolve(modelArg), output = path.resolve(outputArg);
assert.equal(path.basename(model), ds41Model.file, 'only the reviewed Q2 artifact is accepted');
assert.equal(fs.existsSync(output), false, 'each attempt needs a new evidence directory');
fs.mkdirSync(output, {recursive: true});
const binary = path.join(engine, 'ds4-server'), logPath = path.join(output, 'engine.log');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const command = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 ** 2});
const memory = () => ({
  sysctl: command('sysctl', ['vm.swapusage', 'kern.memorystatus_vm_pressure_level', 'iogpu.wired_limit_mb']),
  vmstat: command('vm_stat', []),
});
const cases = ds41Tasks();
const report = {
  schema: 'dstudio.ds41-ssd.v1', startedAt: new Date().toISOString(), evidence: output,
  host: {cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem(), platform: os.platform(), release: os.release()},
  contextTokens: context, expertCacheGiB: cacheGiB, cases, plannedRequests: cases.gates.length + cases.workloads.length * 3,
  gates: [], runs: [], memorySamples: [], allCorrect: false,
  method: 'One sequential native server, full model SHA-256 verified before launch, exact-answer checks, greedy sampling with reasoning disabled. Five independent instruction gates followed by three distinct workloads repeated three times. A per-repetition prefix prevents full-prompt reuse. Warm expert reuse is allowed; no disk KV, MTP, DSpark or PLD. No quality equivalence or cross-backend claim.',
};
const save = () => {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'performance.txt'), ds41TextReport(report));
};
save(); console.log('Evidence: ' + output);
let child, exited = false, finished, stopping, monitor, monitorError;
async function stop() {
  if (stopping) return stopping;
  if (!child || exited) return;
  stopping = (async () => {
    child.kill('SIGTERM');
    const escalation = setTimeout(() => {if (!exited) child.kill('SIGKILL');}, 10000);
    try {await finished;} finally {clearTimeout(escalation);}
  })();
  return stopping;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  report.interrupted = signal; report.error = 'Benchmark interrupted'; save();
  clearInterval(monitor); await stop(); process.exit(130);
});
try {
  assert.equal(fs.realpathSync(command('git', ['-C', engine, 'rev-parse', '--show-toplevel']).trim()), engine,
    'engine checkout cannot inherit a surrounding repository identity');
  report.commit = command('git', ['-C', engine, 'rev-parse', 'HEAD']).trim();
  assert.equal(report.commit, 'bd66c402070042bf0a79ad6ece8242de4c93680c', 'unexpected engine revision');
  report.sourceDiffSha256 = crypto.createHash('sha256').update(command('git', ['-C', engine, 'diff', '--binary'])).digest('hex');
  report.binary = {path: binary, sha256: digest(binary)};
  report.harness = Object.fromEntries([import.meta.filename,
    fileURLToPath(new URL('../support/ds41_benchmark.mjs', import.meta.url)),
    fileURLToPath(new URL('../support/main_decode_metrics.mjs', import.meta.url)),
    fileURLToPath(new URL('../support/real_harness.mjs', import.meta.url))].map(file => [path.basename(file), digest(file)]));
  report.shaders = Object.fromEntries(fs.readdirSync(path.join(engine, 'metal')).filter(f => f.endsWith('.metal')).map(f => [f, digest(path.join(engine, 'metal', f))]));
  report.initialMemory = memory();
  report.backgroundProcesses = command('ps', ['-axo', 'pid,ppid,user,lstart,rss,comm']);
  const fd = fs.openSync(model, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let identity;
  try {
    identity = fs.fstatSync(fd);
    assert.ok(identity.isFile()); assert.equal(identity.size, ds41Model.bytes, 'incomplete model file');
    report.model = {...ds41Model, path: model, device: identity.dev, inode: identity.ino, mtimeMs: identity.mtimeMs}; save();
    const hash = crypto.createHash('sha256'); let bytes = 0, lastProgress = performance.now();
    const hashStarted = performance.now();
    for await (const chunk of fs.createReadStream(model, {fd, autoClose: false, highWaterMark: 8 * 1024 ** 2})) {
      hash.update(chunk); bytes += chunk.length;
      if (performance.now() - lastProgress >= 30000) {
        console.log(`Full SHA-256 verification: ${(bytes / identity.size * 100).toFixed(1)}%`); lastProgress = performance.now();
      }
    }
    const after = fs.fstatSync(fd);
    assert.equal(bytes, ds41Model.bytes); assert.equal(after.size, identity.size); assert.equal(after.mtimeMs, identity.mtimeMs);
    report.model.verifiedSha256 = hash.digest('hex');
    assert.equal(report.model.verifiedSha256, ds41Model.sha256, 'full-file digest mismatch');
    report.model.hashSeconds = (performance.now() - hashStarted) / 1000;
  } finally {fs.closeSync(fd);}
  const current = fs.lstatSync(model);
  assert.ok(current.isFile()); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
  assert.equal(current.size, identity.size); assert.equal(current.mtimeMs, identity.mtimeMs);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  report.args = ['--metal', '-m', model, '--host', '127.0.0.1', '--port', String(port),
    '--ctx', String(context), '--tokens', '512', '--power', '100', '--ssd-streaming',
    '--ssd-streaming-cache-experts', `${cacheGiB}GB`];
  const logFd = fs.openSync(logPath, 'wx'), started = performance.now();
  child = spawn(binary, report.args, {cwd: engine, stdio: ['ignore', logFd, logFd]}); fs.closeSync(logFd);
  report.pid = child.pid;
  finished = new Promise(resolve => {
    child.once('error', e => {exited = true; resolve({error: e.message});});
    child.once('exit', (code, signal) => {exited = true; resolve({code, signal});});
  });
  monitor = setInterval(() => {
    if (exited) return;
    try {
      if (fs.statSync(logPath).size > 64 * 1024 ** 2) throw Error('Engine log exceeds the 64 MiB limit');
      if (report.memorySamples.length >= 900) throw Error('Benchmark exceeds the 75 minute collection limit');
      report.memorySamples.push({seconds: (performance.now() - started) / 1000,
        process: command('ps', ['-p', String(child.pid), '-o', 'pid,ppid,user,lstart,rss,comm'])});
    } catch (e) {monitorError = e; clearInterval(monitor); void stop();}
  }, 5000);
  save();
  let models;
  while (performance.now() - started < 900000) {
    if (exited) throw Error('Engine exited before readiness: ' + JSON.stringify(await finished));
    if (monitorError) throw monitorError;
    try {models = await jsonFetch(base, '/v1/models', {timeoutMs: 2000}); break;} catch {}
    await sleep(1000);
  }
  assert.equal(models?.data?.[0]?.id, 'deepseek-v4.1-flash', 'wrong model or readiness timeout');
  report.models = models; report.loadSeconds = (performance.now() - started) / 1000;
  report.runtimeMemory = ds41MemoryMode(fs.readFileSync(logPath, 'utf8')); save();
  assert.equal(report.runtimeMemory?.expertStreaming, true, 'native expert SSD-streaming diagnostics are missing or inconsistent');
  assert.equal(report.runtimeMemory.targetGiB, cacheGiB, 'requested and native SSD budget disagree');
  console.log(`V4.1 ready in ${report.loadSeconds.toFixed(1)} s`);
  async function ask(task, repeat, group) {
    const row = {id: task.id, repeat, request: {model: models.data[0].id,
      messages: [{role: 'user', content: `Independent request ${repeat}:\n${task.prompt}`}],
      temperature: 0, seed: 73, max_tokens: 512, think: false, thinking: {type: 'disabled'}, stream: false}};
    group.push(row); save();
    const offset = fs.statSync(logPath).size, begin = performance.now();
    let transportFailed = false;
    try {
      try {row.response = await jsonFetch(base, '/v1/chat/completions', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(row.request), timeoutMs: 600000,
      });} catch (e) {transportFailed = true; throw e;}
      checkDs41Answer(task, row.response); row.correct = true;
      const usage = row.response.usage;
      row.tokens = usage?.completion_tokens;
      row.decodeSeconds = usage?.ds4?.decode_elapsed_seconds;
      row.tokensPerSecond = usage?.ds4?.decode_tokens_per_second;
      assert.ok(row.tokens > 0 && row.decodeSeconds > 0 && row.tokensPerSecond > 0, 'missing native decode metrics');
      assert.ok(Math.abs(row.tokens / row.decodeSeconds - row.tokensPerSecond) < 0.02, 'native token/time mismatch');
      row.status = 'pass';
    } catch (e) {row.status = 'fail'; row.error = e.message;}
    row.wallSeconds = (performance.now() - begin) / 1000;
    const prefill = prefillMetrics(fs.readFileSync(logPath).subarray(offset).toString());
    if (prefill) Object.assign(row, {prefillTokens: prefill.tokens, prefillSeconds: prefill.seconds, prefillTokensPerSecond: prefill.tokensPerSecond});
    save(); console.log(`${task.id} #${repeat}: ${row.status}, ${row.tokensPerSecond ?? 'n/a'} decode tok/s`);
    if (transportFailed) throw Error(`Interrupted/failed HTTP request ${task.id}; no further inference is admitted`);
    if (monitorError) throw monitorError;
    if (exited) throw Error('Engine exited during inference');
  }
  for (const task of cases.gates) await ask(task, 0, report.gates);
  for (let repeat = 1; repeat <= 3; repeat++) for (const task of cases.workloads) await ask(task, repeat, report.runs);
  report.summary = Object.fromEntries(cases.workloads.map(t => [t.id, workloadSummary(report.runs.filter(r => r.id === t.id))]));
  report.allCorrect = [...report.gates, ...report.runs].length === report.plannedRequests &&
    [...report.gates, ...report.runs].every(r => r.status === 'pass');
} catch (e) {report.error = e.message; console.error(e.message);}
finally {
  clearInterval(monitor); await stop();
  if (finished) {
    report.process = await finished;
    if (report.process.code !== 0 || report.process.signal || report.process.error) {
      report.shutdownFailed = true; report.allCorrect = false;
    }
  }
  try {report.finalMemory = memory();} catch (e) {report.finalMemory = {error: e.message};}
  if (monitorError) {report.error = monitorError.message; report.allCorrect = false;}
  report.finishedAt = new Date().toISOString(); save();
}
process.exitCode = report.allCorrect ? 0 : 1;
