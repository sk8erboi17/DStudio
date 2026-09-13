// Diagnostic regression: real q36 shell/monitor and control access with a
// deterministic slow-output barrier. Never loads weights or edits the engine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const [sourceArg, objectsArg, variant, sanitizer] = process.argv.slice(2);
assert(process.argv.length <= 6 && (sanitizer === undefined || sanitizer === '--tsan'),
  'Optional final --tsan selects ThreadSanitizer instead of ASan/UBSan');
assert(variant === undefined || variant === '--upstream' || variant === '--owner',
  'Select the reviewed source, --upstream original or --owner reproducible candidate');
assert.equal(process.platform, 'darwin', 'The current native link requires macOS');
assert(sourceArg && objectsArg, 'Supply reviewed q36 sources and a matching built object directory');
const source = fs.realpathSync(sourceArg), objectDir = fs.realpathSync(objectsArg);
const run = artifactRunDir('q36-monitor-control');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tracked = new Map();
const capture = file => {
  const bytes = fs.readFileSync(file), sha256 = hash(bytes);
  tracked.set(file, sha256); return {file, sha256, bytes: bytes.length};
};
const report = {started: new Date().toISOString(), source, objectDir,
  agentVariant: variant === '--upstream' ? 'upstream' : variant === '--owner' ? 'monitor-owner' : 'reviewed-adaptation',
  scope: 'Native monitor/control regression with an injected slow write and a real shell; no model or GPU inference',
  sanitizers: (sanitizer ? 'ThreadSanitizer' : 'ASan/UBSan') +
    ' on the included Agent/probe; existing native helper objects are not instrumented',
  commands: [], passed: false};
const save = () => writeArtifact(run, 'results.json', report);
function command(exe, args, timeout) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^DS4(?:UI)?_|^DSTUDIO_|^Q36_|^GIT_/.test(k)));
  env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CEILING_DIRECTORIES = path.dirname(run);
  const r = spawnSync(exe, args, {cwd: run, env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024});
  const row = {exe, args, status: r.status, signal: r.signal, error: String(r.error || '')};
  report.commands.push(row); save();
  writeArtifact(run, 'command-' + report.commands.length + '.json', {...row, stdout: r.stdout, stderr: r.stderr});
  return r;
}
try {
  const top = command('git', ['-C', source, 'rev-parse', '--show-toplevel'], 5000);
  assert(top.status === 0 && fs.realpathSync(top.stdout.trim()) === source, 'Source must own its Git identity');
  const head = command('git', ['-C', source, 'rev-parse', 'HEAD'], 5000);
  assert.equal(head.status, 0, head.stderr);
  report.sourceGit = {head: head.stdout.trim()};
  assert.equal(report.sourceGit.head, '8362010a301b3360296e435703f58ffc230a024a', 'Use the exact reviewed native monitor ABI');
  const probe = path.join(root, 'tests/support/q36_agent_monitor_probe.c');
  const names = ['q36_help', 'q36_kvstore', 'q36_ssd', 'q36_web', 'linenoise',
    'q36_gpu_core_metal', 'q36_metal', 'q36_image', 'q36_prompt_prefix'];
  const objects = names.map(n => path.join(objectDir, n + '.o'));
  // Native helpers must match their copied build sources, not just have familiar
  // object names. Agent/probe is compiled afresh from the exact source above.
  const helpers = names.map(n => n === 'q36_metal' ? n + '.m' :
    n === 'q36_gpu_core_metal' ? 'q36.c' : n + '.c');
  for (const file of helpers)
    assert.equal(hash(fs.readFileSync(path.join(source, file))), hash(fs.readFileSync(path.join(objectDir, file))),
      'Mismatched helper build source: ' + file);
  report.inputs = [probe, import.meta.filename,
    ...fs.readdirSync(source).filter(n => /\.(?:h|c|m)$/.test(n)).map(n => path.join(source, n)),
    ...objects].map(capture);
  if (variant === '--upstream') {
    const original = command('git', ['-C', source, 'show', report.sourceGit.head + ':q36_agent.c'], 5000);
    assert.equal(original.status, 0, original.stderr);
    // Private source fixture from the exact Git object. The reviewed checkout
    // is never restored, patched or rebuilt by this comparison.
    writeArtifact(run, 'q36_agent.c', original.stdout);
    report.inputs.push(capture(path.join(run, 'q36_agent.c')));
  }
  if (variant === '--owner') {
    const patch = path.join(root, 'patch/q36-agent-tty/monitor-owner.patch');
    const prerequisite = path.join(root, 'patch/q36-agent-tty/monitor.patch');
    const script = path.join(root, 'scripts/apply-q36-agent-tty.sh');
    report.inputs.push(...[patch, prerequisite, script].map(capture));
    writeArtifact(run, 'q36_agent.c', fs.readFileSync(path.join(source, 'q36_agent.c'), 'utf8'));
    writeArtifact(path.join(run, 'tests'), 'test_agent_password.py',
      fs.readFileSync(path.join(source, 'tests/test_agent_password.py'), 'utf8'));
    const applied = command('/usr/bin/env', ['Q36_DIR=' + run, '/bin/sh', script, 'apply', 'monitor-owner'], 5000);
    assert.equal(applied.status, 0, applied.stderr);
    // Exercise the production installer on isolated malformed/partial states,
    // never on the reviewed checkout. Every rejection must preserve its input.
    const file = path.join(run, 'q36_agent.c');
    const candidate = fs.readFileSync(file);
    const apply = (action, expected = 0) => {
      const r = command('/usr/bin/env', ['Q36_DIR=' + run, '/bin/sh', script, action, 'monitor-owner'], 5000);
      assert.equal(r.status, expected, r.stderr); return r;
    };
    report.lifecycle = [];
    const checked = (name, fn) => {fn(); report.lifecycle.push({name, passed: true}); save();};
    checked('repeat apply and check preserve candidate', () => {
      apply('apply'); apply('check'); assert.deepEqual(fs.readFileSync(file), candidate);
    });
    const unrelated = '\n/* Unrelated owner-lifecycle fixture. */\n';
    fs.appendFileSync(file, unrelated);
    const adapted = fs.readFileSync(file);
    apply('restore'); const baseline = fs.readFileSync(file);
    checked('restore, repeat restore and reapply preserve same-file contributor data', () => {
      apply('restore'); assert.deepEqual(fs.readFileSync(file), baseline);
      apply('apply'); assert.deepEqual(fs.readFileSync(file), adapted);
      apply('restore'); assert.deepEqual(fs.readFileSync(file), baseline);
    });
    // Fragment parsing is fixture construction only: correctness is rejection
    // and byte preservation by the real application script for every hunk.
    const content = fs.readFileSync(patch, 'utf8');
    const first = content.indexOf('\n@@');
    const header = content.slice(0, first + 1);
    const hunks = content.slice(first + 1).split(/(?=^@@ )/m).filter(Boolean);
    assert(hunks.length > 1, 'Expected a multi-hunk owner adaptation');
    for (const [index, hunk] of hunks.entries()) checked('partial hunk ' + index + ' rejected atomically', () => {
      fs.writeFileSync(file, baseline);
      const fragment = path.join(run, 'fragment-' + index + '.patch');
      writeArtifact(run, path.basename(fragment), header + hunk);
      const result = command('git', ['apply', fragment], 5000);
      assert.equal(result.status, 0, result.stderr);
      const partial = fs.readFileSync(file);
      assert(!partial.equals(baseline), 'Fixture patch did not alter the private source');
      for (const action of ['apply', 'check', 'restore']) {
        apply(action, 1); assert.deepEqual(fs.readFileSync(file), partial);
      }
    });
    checked('drift rejected without mutation', () => {
      fs.writeFileSync(file, 'incompatible source fixture\n');
      for (const action of ['apply', 'check', 'restore']) {
        apply(action, 1); assert.equal(fs.readFileSync(file, 'utf8'), 'incompatible source fixture\n');
      }
    });
    checked('linked source rejected without modifying destination', () => {
      fs.writeFileSync(file, baseline);
      const saved = file + '.saved'; fs.renameSync(file, saved); fs.symlinkSync(saved, file);
      apply('apply', 2); assert.deepEqual(fs.readFileSync(saved), baseline);
      fs.unlinkSync(file); fs.renameSync(saved, file);
    });
    checked('missing prerequisite rejected without mutation', () => {
      const removed = command('/usr/bin/env', ['Q36_DIR=' + run, '/bin/sh', script, 'restore', 'monitor'], 5000);
      assert.equal(removed.status, 0, removed.stderr);
      const absent = fs.readFileSync(file); apply('apply', 1); assert.deepEqual(fs.readFileSync(file), absent);
      const restored = command('/usr/bin/env', ['Q36_DIR=' + run, '/bin/sh', script, 'apply', 'monitor'], 5000);
      assert.equal(restored.status, 0, restored.stderr); assert.deepEqual(fs.readFileSync(file), baseline);
    });
    checked('final original-byte reapply', () => {
      fs.writeFileSync(file, fs.readFileSync(path.join(source, 'q36_agent.c')));
      apply('apply'); assert.deepEqual(fs.readFileSync(file), candidate);
    });
    report.inputs.push(capture(path.join(run, 'q36_agent.c')));
  }
  const binary = path.join(run, 'probe');
  const built = command('cc', ['-O1', '-g', '-std=c11', '-DQ36_METAL', '-Wno-unused-function',
    ...(variant === '--owner' ? ['-DDSTUDIO_Q36_MONITOR_OWNER_TEST'] : []),
    '-fno-omit-frame-pointer', sanitizer ? '-fsanitize=thread' : '-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',
    '-I', run, '-I', source, probe, ...objects, '-lm', '-pthread', '-framework', 'Foundation',
    '-framework', 'Metal', '-o', binary], 120000);
  assert.equal(built.status, 0, built.stderr || String(built.error));
  report.binarySHA256 = hash(fs.readFileSync(binary));
  report.results = [];
  const scenarios = [[], ['--cancel'], ['--signal-race'], ['--write-failure'], ['--thread-failure']];
  if (variant === '--owner') scenarios.push(['--terminal-cancel'], ['--terminal-timeout']);
  for (const args of scenarios) {
    const result = command(binary, args, 15000);
    const line = result.stdout?.split('\n').find(l => l.startsWith('{"case":'));
    report.results.push({args, exit: result.status, result: line ? JSON.parse(line) : null});
    save();
  }
  report.result = report.results[0].result;
  report.inputsUnchanged = [...tracked].every(([file, sha256]) => hash(fs.readFileSync(file)) === sha256);
  assert(report.inputsUnchanged, 'Input changed during the diagnostic');
  assert(report.results.every(r => r.exit === 0 && r.result?.passed),
    'Native output/control/ownership regression failed; all original receipts retained');
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString(); save(); console.log(run);
}
