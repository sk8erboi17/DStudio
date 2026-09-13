// Native compaction publication/recovery with a deterministic session API.
// Tokenizers and inference are simulated here, not model-quality evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';

const root = path.resolve(import.meta.dirname, '../..');
assert.equal(process.platform, 'darwin', 'Native object link currently qualified on macOS only');
const args = process.argv.slice(2);
assert(args[0], 'Supply an already-built Laguna or older Qwen MoE engine');
const engine = fs.realpathSync(args[0]);
const value = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
const family = value('--family');
assert(['laguna', 'qwen35'].includes(family), 'Specify --family laguna|qwen35');
const source = value('--source') ? fs.realpathSync(value('--source')) : null;
const helper = value('--helper') ? fs.realpathSync(value('--helper')) : null;
assert(!helper || source, 'A historical compaction helper requires an explicit matching source');
const tokenizerModel = value('--tokenizer-model') ? fs.realpathSync(value('--tokenizer-model')) : null;
const generationOnly = args.includes('--generation-only');
assert(!generationOnly || (source && tokenizerModel), '--generation-only is for an explicit baseline source and model');
const run = artifactRunDir('agent-compaction');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const tracked = new Map();
const retainInput = file => {
  const absolute = path.resolve(root, file), bytes = fs.readFileSync(absolute);
  tracked.set(absolute, hash(bytes)); return {file: absolute, sha256: hash(bytes)};
};
const report = {started: new Date().toISOString(), engine, family, source, helper,
  scope: 'Native compaction/control behavior; deterministic inference and tokenization fixtures; no weights',
  sanitizers: 'ASan/UBSan on native Agent and DStudio helpers; existing upstream core objects not instrumented',
  commands: [], rows: [], passed: false};
const save = () => writeArtifact(run, 'results.json', report);
function command(exe, params, {check = true, timeout = 120000, cwd = root} = {}) {
  const r = spawnSync(exe, params, {cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
    env: {...process.env, DS4UI_SESSION_CACHE_DIR: path.join(run, 'cache')}});
  const row = {exe, args: params, cwd, status: r.status, signal: r.signal, error: String(r.error || '')};
  report.commands.push(row); save();
  writeArtifact(run, 'command-' + report.commands.length + '.json', {...row, stdout: r.stdout, stderr: r.stderr});
  if (check) assert.equal(r.status, 0, r.stderr || r.error?.message || String(r.signal));
  return r;
}
try {
  report.engineGit = ownGitRevision(engine);
  report.inputs = ['tests/integration/agent_compaction_test.mjs', 'tests/support/agent_compaction_probe.c',
    'patch/ds4-agent-jsonl/compaction_text.h',
    'tests/support/emit_agent_patch.c', 'src/dstudio.c', 'patch/ds4-agent-jsonl/manifest',
    'patch/ds4-agent-jsonl/' + family + '.patch', path.join(engine, 'ds4_agent.c'),
    path.join(engine, 'ds4.h'), path.join(engine, 'ds4_web.c')].map(retainInput);
  const emitter = path.join(run, 'emit');
  command('cc', ['-O1', '-std=c11', 'tests/support/emit_agent_patch.c', '-o', emitter]);
  if (source) {
    report.inputs.push(retainInput(source));
    fs.copyFileSync(source, path.join(run, 'ds4_agent.c'));
  } else command(emitter, [path.join(engine, 'ds4_agent.c'), path.join(run, 'ds4_agent.c')]);
  if (helper) {
    // Historical source must compile against its actual historical helper;
    // never rewrite a frozen source merely to fit the current private ABI.
    report.inputs.push(retainInput(helper));
    fs.copyFileSync(helper, path.join(run, 'compaction_text.h'));
  }
  command(emitter, [path.join(engine, 'ds4_web.c'), path.join(run, 'ds4_web.c'), '--web']);
  report.derivedSHA256 = hash(fs.readFileSync(path.join(run, 'ds4_agent.c')));
  const flags = ['-O1', '-std=c11', '-g', '-fno-omit-frame-pointer',
    '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
    ...(family === 'laguna' ? ['-DDSTUDIO_COMPACT_LAGUNA'] : []),
    ...[run, engine, path.join(root, 'extension/remote'), path.join(root, 'extension/cowork'),
      path.join(root, 'patch/ds4-agent-jsonl')].flatMap(p => ['-I', p])];
  const objects = ['ds4', 'ds4_distributed', 'ds4_tp', 'ds4_ssd', 'ds4_metal', 'ds4_layer_pack',
    'ds4_help', 'ds4_kvstore', 'linenoise', 'ds4_gpu_args'].map(n => path.join(engine, n + '.o'));
  if (fs.existsSync(path.join(engine, 'ds4_prompt_prefix.o'))) objects.push(path.join(engine, 'ds4_prompt_prefix.o'));
  report.engineObjects = objects.map(retainInput);
  for (const [name, file] of [['web', path.join(run, 'ds4_web.c')],
    ['cowork', path.join(root, 'extension/cowork/ds4_cowork.c')],
    ['remote', path.join(root, 'extension/remote/dstudio_remote_llm.c')],
    ['pld', path.join(root, 'patch/ds4-agent-jsonl/pld_core.c')]]) {
    report.inputs.push(retainInput(file));
    const object = path.join(run, name + '.o');
    command('cc', [...flags, '-c', file, '-o', object]); objects.push(object);
  }
  const binary = path.join(run, 'probe');
  command('cc', [...flags, '-Wno-unused-function', 'tests/support/agent_compaction_probe.c', ...objects,
    '-lm', '-pthread', '-framework', 'Foundation', '-framework', 'Metal', '-o', binary]);
  report.binarySHA256 = hash(fs.readFileSync(binary));
  for (const scenario of ['summary_failure', 'summary_cancel', 'summary_eval_failure', 'empty_summary',
    'rebuild_failure', 'rebuild_cancel', 'late_cancel', 'late_stop', 'stale_session',
    'stale_transcript', 'success', 'memory_failure', 'delayed_20ms', 'delayed_200ms']) {
    const cwd = path.join(run, scenario); fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'MEMORY.MD'), '# Earlier confirmed memory\n\nKeep this until compaction commits.\n');
    const r = command(binary, [scenario], {cwd, check: false, timeout: 20000});
    const line = r.stdout?.split('\n').findLast(x => x.startsWith('{"case":'));
    report.rows.push({scenario, exitCode: r.status,
      ...(line ? JSON.parse(line) : {passed: false, error: r.stderr || String(r.error)})});
    // Export failures must not leave private candidate files behind.
    const files = fs.readdirSync(cwd);
    report.rows.at(-1).noTemporaryFiles = !files.some(f => f.startsWith('MEMORY.MD.tmp.'));
    if (!report.rows.at(-1).noTemporaryFiles) report.rows.at(-1).passed = false;
    save();
    console.log(family + '/' + scenario + ': ' + (report.rows.at(-1).passed ? 'PASS' : 'FAIL'));
  }
  if (tokenizerModel) {
    // Native vocabulary/chat encoders only: never create a model session or
    // initialize GPU inference. Core is rebuilt privately with sanitizers.
    for (const file of ['tests/support/agent_compaction_tokenizer.c',
      'tests/support/agent_compaction_text_probe.c', 'tests/support/agent_continuation_probe.c',
      path.join(engine, 'ds4.c')])
      report.inputs.push(retainInput(file));
    const stat = fs.statSync(tokenizerModel);
    report.tokenizer = {scope: 'Actual native GGUF tokenizer; no inference or weight tensor reads',
      model: {file: tokenizerModel, bytes: stat.size, modifiedMs: stat.mtimeMs}, rows: []};
    const core = path.join(run, 'tokenizer-core.o');
    command('cc', [...flags, '-c', 'tests/support/agent_compaction_tokenizer.c', '-o', core]);
    report.tokenizer.generationOnly = generationOnly;
    report.tokenizer.probes = [];
    for (const probe of generationOnly ? ['agent_continuation_probe'] :
      ['agent_compaction_text_probe', 'agent_continuation_probe']) {
      const nativeProbe = path.join(run, probe);
      command('cc', [...flags, '-Wno-unused-function', 'tests/support/' + probe + '.c',
        core, ...objects.filter(file => file !== path.join(engine, 'ds4.o')),
        '-lm', '-pthread', '-framework', 'Foundation', '-framework', 'Metal', '-o', nativeProbe]);
      const result = command(nativeProbe, [tokenizerModel], {check: false, cwd: run, timeout: 30000});
      const rows = (result.stdout || '').split('\n').filter(x => x.startsWith('{"case":')).map(JSON.parse);
      const passed = result.status === 0 && rows.length > 0 && rows.every(row => row.passed);
      report.tokenizer.probes.push({probe, binarySHA256: hash(fs.readFileSync(nativeProbe)),
        scope: probe === 'agent_continuation_probe' ? 'Native loop/tokenizer, scripted inference' : 'Native tokenizer framing',
        rows, exitCode: result.status, passed});
      report.tokenizer.rows.push(...rows.map(row => ({...row, probe})));
      save();
    }
    const after = fs.statSync(tokenizerModel);
    report.tokenizer.modelUnchanged = after.size === stat.size && after.mtimeMs === stat.mtimeMs;
    report.tokenizer.passed = report.tokenizer.probes.every(probe => probe.passed) && report.tokenizer.modelUnchanged;
    save();
    console.log(family + '/native-tokenizer: ' + (report.tokenizer.passed ? 'PASS' : 'FAIL'));
  }
  report.inputsUnchanged = [...tracked].every(([file, expected]) => hash(fs.readFileSync(file)) === expected);
  assert(report.inputsUnchanged, 'A captured input changed during the gate');
  assert(report.rows.every(r => r.passed && r.exitCode === 0), 'Compaction invariants failed; original receipts retained');
  if (report.tokenizer) assert(report.tokenizer.passed, 'Native tokenizer framing failed; receipt retained');
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString(); save(); console.log(run);
}
