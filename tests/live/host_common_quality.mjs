// REAL inference: the frozen common-100 corpus through the production DStudio
// host. The host prepares and owns the engine exactly as the app does (launch
// API, admitted memory mode, llama.cpp/MLX resident server or ds4-server), and
// every request goes through its /v1 proxy. One model per run, started alone.
//
//   node tests/live/host_common_quality.mjs --model gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
//   node tests/live/host_common_quality.mjs --model mlx/Qwen3.6-35B-A3B-mxfp8
//   node tests/live/host_common_quality.mjs --model gguf/DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf --ssd-streaming on
//     [--quality-use first-exposure|development-replay]   default development-replay
//     [--ready-timeout-ms N]                              0 = wait for the load without a bound
//     [--restart-failed-engine]                           after a case whose HTTP exchange did not complete,
//                                                         stop the host and its engine, start them again and
//                                                         go on with the next case (at most eight times)
//
// The corpus, grader, per-case deadlines and request fields are the frozen ones
// of tests/support/common_quality_runner.mjs. This runner adds only what the
// engine needs to honour "thinking off" (llama.cpp and MLX Qwen templates use
// chat_template_kwargs, as the app's own Chat request does) and records it.
// A requested SSD-streaming mode that the runtime does not report as effective
// stops the run before the first case: it is not evidence for that mode.
// A case that exceeds its frozen deadline leaves the engine generating, so no
// further request is sent to it. Without --restart-failed-engine the remaining
// cases stay not run. With it this runner, which owns the host, reaps the host
// and the engine and starts both again; the failed case is never retried and
// its receipt is never replaced.
// Receipts stay in ignored tests/.artifacts/host-common-quality/run-*/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { artifactRunDir, csrfHeaders, jsonFetch, resolveDStudioBinary, safeReadTail, sleep, startDStudio, writeArtifact }
  from '../support/real_harness.mjs';
import { createCommonQuality, finishCommonQuality, runCommonQuality } from '../support/common_quality_runner.mjs';
import { contamination, isEngineProcess, parsePs, preflight } from '../support/heavy_preflight.mjs';
import { engineIdentity, patchSetHash, repoIdentity, sha256File, weightIdentity } from '../support/campaign_identity.mjs';
import { toolchain } from '../support/quality_baseline.mjs';

const root = process.cwd();
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const modelFile = option('--model', '');
const ssdStreaming = option('--ssd-streaming', 'off');
const qualityUse = option('--quality-use', 'development-replay');
const readyTimeoutMs = Number(option('--ready-timeout-ms', '0'));
const restartFailedEngine = process.argv.includes('--restart-failed-engine');
assert.ok(modelFile && !path.isAbsolute(modelFile) && !modelFile.split('/').includes('..'), '--model is a path inside the model store, for example gguf/NAME.gguf');
assert.ok(['on', 'off'].includes(ssdStreaming), '--ssd-streaming is on or off');
assert.ok(['first-exposure', 'development-replay'].includes(qualityUse), '--quality-use must distinguish first exposure from development replay');
assert.ok(Number.isSafeInteger(readyTimeoutMs) && readyTimeoutMs >= 0, '--ready-timeout-ms is a non-negative integer');

// The host serves pinned Qwen GGUFs with llama.cpp and MLX folders with MLX;
// every other checkpoint in the store runs on ds4. The alias is the host's own
// resident model id.
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'scripts/qwen-variants.json'), 'utf8')).variants;
const variant = catalog.find((v) => v.path === modelFile);
const engine = variant ? variant.engine : 'ds4';
const alias = variant ? `${variant.family === 'qwen27' ? 'qwen3.8-27b' : 'qwen3.6-35b-a3b'}${variant.engine === 'mlx' ? '-mlx' : ''}` : null;
const pinned = variant ? Object.fromEntries(variant.files.map((f) => [f.file, { bytes: f.bytes, sha256: f.sha256 }])) : {};

const run = artifactRunDir('host-common-quality');
const report = { schema: 'dstudio.host-common-quality.v1', started: new Date().toISOString(), status: 'running',
  scope: 'REAL inference through the production host: frozen common-100 answers with an independent grader. Not numerical parity, vision, tool-loop or desktop qualification.',
  selection: { modelFile, engine, catalogId: variant?.id || null, quantization: variant?.quant || null }, qualityUse,
  requested: { ssdStreaming, think: 'off', restartFailedEngine }, runner: { sha256: await sha256File(new URL(import.meta.url)) } };
const save = () => writeArtifact(run, 'results.json', report);
console.log(`Evidence: ${run}`); save();

let server = null, quality = null, ownedEngines = [];
let interrupted = false;
const shutdown = async () => {
  try { await server?.stop?.(); } catch { /* task-owned host */ }
  // The host stops its engine when it exits. Anything recorded as started under
  // this run's host and still alive with the same command is ours to end.
  for (let i = 0; i < 100 && ownedEngines.some(alive); i++) await sleep(100);
  for (const row of ownedEngines.filter(alive)) { try { process.kill(row.pid, 'SIGTERM'); } catch {} }
  for (let i = 0; i < 100 && ownedEngines.some(alive); i++) await sleep(100);
  report.teardown = { leftRunning: ownedEngines.filter(alive).map((row) => row.pid) };
};
function alive(row) {
  try {
    const command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(row.pid)], { encoding: 'utf8', timeout: 5000 }).trim();
    return command === row.command;
  } catch { return false; }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  interrupted = true;
  if (quality && ['pending', 'running'].includes(quality.report.status)) finishCommonQuality(quality.report, signal);
  await shutdown();
  report.status = 'interrupted'; report.finished = new Date().toISOString(); save();
  process.exit(130);
});

try {
  quality = createCommonQuality(path.join(run, 'common-100'));
  quality.report.evaluationUse = qualityUse;

  const before = preflight({ dir: root });
  report.preflight = before; save();
  assert.ok(before.ok, `BLOCKED, not a pass: ${before.reasons.join('; ')}`);

  server = await startDStudio({ label: 'host-common', isolatedEnginePort: true, ignoreExternal: true });
  const hostBinary = resolveDStudioBinary();
  report.host = { baseUrl: server.baseUrl, binary: path.relative(root, hostBinary), binarySha256: await sha256File(hostBinary),
    repository: repoIdentity(root), patchSet: patchSetHash(root) };
  const target = path.join(server.ds4Dir, modelFile);
  assert.ok(fs.existsSync(target), `weights unavailable: ${modelFile} (BLOCKED, not a pass)`);
  console.log(`Verifying weights: ${modelFile}`);
  report.weights = await weightIdentity(target, { cacheFile: path.join(root, 'tests/.artifacts/campaign/weight-sha256.json'), pinned,
    onHash: (file, bytes) => console.log(`  hashing ${path.basename(file)} (${(bytes / 1024 ** 3).toFixed(1)} GiB)`) });
  save();
  if (variant) assert.ok(report.weights.verified, 'the installed weights do not match the pinned catalog (BLOCKED, not a pass)');

  const settings = quality.manifest.settings;
  // Ask the host to launch the model and wait until it reports it ready, in
  // the requested memory mode. Used for the first start and for a restart.
  const launchModel = async () => {
    const launch = { mode: 'server', model: 'standard', variant: 'flash', gguf: modelFile, port: server.enginePort,
      ctx: settings.context, power: 100, think: 'off', ssdStreaming, dspark: false, workdir: '' };
    const loadStarted = performance.now();
    const started = await jsonFetch(server.baseUrl, '/api/start', { method: 'POST', headers: csrfHeaders, body: JSON.stringify(launch), timeoutMs: readyTimeoutMs });
    assert.ok(started.ok, `launch refused: ${JSON.stringify(started)}`);
    let status;
    for (;;) {
      status = await jsonFetch(server.baseUrl, '/api/status', { timeoutMs: 10000 });
      if (status.ready && status.mode === 'server') break;
      if (status.running === false && status.engineError) throw new Error(`engine stopped during startup: ${status.engineError}`);
      assert.ok(server.child.exitCode === null, 'the host exited during startup');
      if (readyTimeoutMs > 0 && performance.now() - loadStarted > readyTimeoutMs) throw new Error('the model did not become ready (BLOCKED, not a pass)');
      await sleep(1000);
    }
    const effective = { modelFile: status.modelFile, ssdStreaming: status.config?.ssdStreaming ?? status.ssdStreaming,
      ssdStreamingEffective: status.config?.ssdStreamingEffective ?? status.ssdStreamingEffective,
      ssdStreamingReason: status.config?.ssdStreamingReason ?? status.ssdStreamingReason,
      ctx: status.config?.ctx, residentPid: status.residentPid, status };
    assert.equal(status.modelFile, modelFile, 'the host loaded another model');
    assert.equal(effective.ssdStreamingEffective, ssdStreaming === 'on',
      `SSD streaming requested ${ssdStreaming} but the runtime reports effective=${effective.ssdStreamingEffective} (${effective.ssdStreamingReason || 'no reason'}): not evidence for this memory mode`);
    return { launch, effective, loadSeconds: (performance.now() - loadStarted) / 1000 };
  };
  // Engine processes started under this run's host.
  const discoverOwnedEngines = () => {
    const table = parsePs(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 ** 2 }));
    const under = new Set([server.child.pid]);
    for (let grew = true; grew;) { grew = false; for (const row of table) if (under.has(row.ppid) && !under.has(row.pid)) { under.add(row.pid); grew = true; } }
    return table.filter((row) => under.has(row.pid) && row.pid !== server.child.pid && isEngineProcess(row))
      .map((row) => ({ pid: row.pid, command: row.command }));
  };
  const first = await launchModel();
  report.launch = first.launch; report.loadSeconds = first.loadSeconds; report.effective = first.effective;
  save();
  ownedEngines = discoverOwnedEngines();
  const enginePort = `http://127.0.0.1:${server.enginePort}`;
  // llama.cpp and MLX are installed beside the ds4 store, which need not be
  // inside this source tree (a frozen worktree runs against the installed engines).
  const installRoot = path.dirname(server.ds4Dir);
  report.engine = { processes: ownedEngines.map((row) => ({ pid: row.pid, command: row.command.slice(0, 600) })) };
  if (engine === 'llama') {
    const props = await jsonFetch(enginePort, '/props', { timeoutMs: 10000 });
    report.engine.props = { build: props.build_info, alias: props.model_alias, model: props.model_path,
      ctx: props.default_generation_settings?.n_ctx, slots: props.total_slots };
    assert.equal(props.model_alias, alias);
    assert.equal(path.basename(props.model_path), path.basename(modelFile));
    report.engine.identity = await engineIdentity(path.join(installRoot, 'llama.cpp'), ['bin/llama-server']);
  } else if (engine === 'mlx') {
    const models = await jsonFetch(enginePort, '/v1/models', { timeoutMs: 10000 });
    report.engine.models = (models.data || []).map((m) => m.id);
    assert.deepEqual(report.engine.models, [fs.realpathSync(target)]);
    report.engine.identity = await engineIdentity(path.join(installRoot, 'mlx'), []);
  } else {
    report.engine.identity = await engineIdentity(server.ds4Dir, ['ds4-server']);
  }
  const proxied = await jsonFetch(server.baseUrl, '/v1/models', { timeoutMs: 10000 });
  report.engine.proxyModels = (proxied.data || []).map((m) => m.id);
  const model = alias || report.engine.proxyModels[0];
  assert.ok(model, 'the host lists no model');
  save();

  quality.report.runtime = { engine, selection: report.selection, weights: { totalBytes: report.weights.totalBytes,
    files: report.weights.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })) },
    host: report.host, launch: report.launch, effective: { ssdStreamingEffective: report.effective.ssdStreamingEffective, ctx: report.effective.ctx },
    engine: report.engine, hardware: before.host, memoryBytes: before.memory.totalBytes, toolchainAtRun: toolchain() };
  const requestExtras = engine === 'ds4' ? {} : { chat_template_kwargs: { enable_thinking: false } };
  const restart = async ({ afterCaseId }) => {
    assert.ok(!interrupted, 'the run was interrupted; no engine restart');
    const row = { afterCaseId, started: new Date().toISOString(), previousHostPid: server.child.pid, previousEngines: ownedEngines.map((e) => e.pid) };
    (report.restarts ??= []).push(row); save();
    await shutdown();
    assert.deepEqual(report.teardown.leftRunning, [], 'the previous engine must be gone before its replacement starts');
    row.reaped = new Date().toISOString(); save();
    assert.ok(!interrupted, 'the run was interrupted during engine teardown');
    // The same bytes that were verified at the start (a cache hit unless the file changed).
    const again = await weightIdentity(target, { cacheFile: path.join(root, 'tests/.artifacts/campaign/weight-sha256.json'), pinned });
    assert.deepEqual(again.files.map((f) => [f.name, f.sha256]), report.weights.files.map((f) => [f.name, f.sha256]), 'the weights changed before the restart');
    assert.equal(await sha256File(hostBinary), report.host.binarySha256, 'the host binary changed during the evaluation');
    server = await startDStudio({ label: 'host-common', isolatedEnginePort: true, ignoreExternal: true });
    const next = await launchModel();
    ownedEngines = discoverOwnedEngines();
    Object.assign(row, { ready: new Date().toISOString(), loadSeconds: next.loadSeconds, hostPid: server.child.pid,
      engines: ownedEngines.map((e) => e.pid), ssdStreamingEffective: next.effective.ssdStreamingEffective });
    save();
    return { base: server.baseUrl, model };
  };
  const result = await runCommonQuality(quality, { base: server.baseUrl, model, requestExtras, onProgress: save,
    maxEngineRestarts: restartFailedEngine ? 8 : 0, restartFailedEngine: restartFailedEngine ? restart : undefined,
    assertAlive: () => assert.ok(!interrupted && server.child.exitCode === null, 'the owned host exited or the run was interrupted') });
  report.summary = result.summary;
  const after = preflight({ dir: root });
  report.postflight = { memory: after.memory, foreignEngines: after.foreignEngines, contamination: contamination(before, after) };
  report.status = result.status === 'pass' && !report.postflight.contamination.length ? 'pass' : 'fail';
  if (report.postflight.contamination.length) report.error = `contaminated by another engine: ${report.postflight.contamination.join('; ')}`;
} catch (error) {
  report.status = 'fail'; report.error = String(error.stack || error);
  if (quality && ['pending', 'running'].includes(quality.report.status)) finishCommonQuality(quality.report, error.message);
  report.summary = quality?.report.summary;
  console.error(`FAILED: ${error.message}`);
} finally {
  if (server?.logPath) writeArtifact(run, 'host.log', safeReadTail(server.logPath, 400000));
  if (server?.residentLogPath && fs.existsSync(server.residentLogPath)) writeArtifact(run, 'resident-server.log', safeReadTail(server.residentLogPath, 4 * 1024 * 1024));
  await shutdown();
  report.finished = new Date().toISOString(); save();
}
const s = report.summary || {};
console.log(`host_common_quality (REAL ${engine} ${modelFile}, SSD streaming ${ssdStreaming}): ${s.passed ?? 0}/${s.denominator ?? 100} passed, ${s.failed ?? 0} failed, ${s.notRun ?? 0} not run\nReceipts: ${run}`);
process.exitCode = report.status === 'pass' ? 0 : 1;
