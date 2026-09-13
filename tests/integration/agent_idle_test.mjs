// Real native worker threads and command admission; blocked session API fixture.
// Reuse only an isolated prior build's core objects. No model/GPU session starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
assert.equal(process.platform, 'darwin', 'This native object-link gate targets macOS');
assert(process.argv[2], 'Supply an isolated already-built engine');
const engine = fs.realpathSync(process.argv[2]);
assert(engine.startsWith(path.join(root, 'tests/.artifacts/')), 'Never rebuild user-managed checkouts in this gate');
const at = process.argv.indexOf('--source');
const source = at < 0 ? null : fs.realpathSync(process.argv[at + 1]);
const run = artifactRunDir('agent-idle');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inputs = new Map();
const capture = file => {
  const full = path.resolve(root, file), digest = hash(fs.readFileSync(full));
  inputs.set(full, digest); return {file: full, sha256: digest};
};
const report = {started: new Date().toISOString(), engine, source,
  scope: 'Native threaded owner/readiness and JSONL notices; simulated blocking API, no inference',
  sanitizers: 'ASan/UBSan on Agent and DStudio helpers; retained upstream core objects not instrumented',
  commands: [], rows: [], passed: false};
const save = () => writeArtifact(run, 'results.json', report);
function command(exe, args, cwd = root, check = true, timeout = 120000) {
  const r = spawnSync(exe, args, {cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
    env: {...process.env, MAKEFLAGS: '', MFLAGS: '', DS4UI_SESSION_CACHE_DIR: path.join(run, 'cache')}});
  report.commands.push({exe, args, cwd, status: r.status, signal: r.signal, error: String(r.error || '')});
  writeArtifact(run, `command-${report.commands.length}.json`, {...report.commands.at(-1), stdout: r.stdout, stderr: r.stderr});
  save();
  if (check) assert.equal(r.status, 0, r.stderr || String(r.error || r.signal));
  return r;
}
try {
  report.inputs = ['tests/integration/agent_idle_test.mjs', 'tests/support/agent_idle_probe.c',
    'patch/ds4-agent-jsonl/manifest', 'patch/ds4-agent-jsonl/bases.json', 'patch/ds4-agent-jsonl/build.mk',
    'patch/ds4-agent-jsonl/remote-agent.cfrag', 'patch/ds4-agent-jsonl/remote-tools.cfrag',
    'extension/remote/dstudio_remote_llm.c', 'extension/cowork/ds4_cowork.c',
    path.join(engine, 'ds4_agent.c'), path.join(engine, 'ds4_web.c')].map(capture);
  report.coreObjects = fs.readdirSync(engine).filter(f => f.endsWith('.o')).map(f => capture(path.join(engine, f)));
  const emitter = path.join(run, 'emit');
  command('cc', ['-O1', '-std=c11', 'tests/support/emit_agent_patch.c', '-o', emitter]);
  if (source) {
    report.inputs.push(capture(source));
    fs.copyFileSync(source, path.join(run, 'agent-runtime.c'));
  } else command(emitter, [path.join(engine, 'ds4_agent.c'), path.join(run, 'agent-runtime.c')]);
  command(emitter, [path.join(engine, 'ds4_web.c'), path.join(run, 'web.c'), '--web']);
  report.derivedSHA256 = hash(fs.readFileSync(path.join(run, 'agent-runtime.c')));
  const binary = path.join(run, 'ds4-agent-jsonl');
  command('make', ['-f', path.join(root, 'patch/ds4-agent-jsonl/build.mk'),
    'JSONL_OUT=' + run, 'JSONL_AGENT_SRC=' + path.join(root, 'tests/support/agent_idle_probe.c'),
    'JSONL_WEB_SRC=' + path.join(run, 'web.c'),
    `JSONL_CFLAGS=-O1 -g -std=c11 -I${run} -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all`,
    'DSTUDIO_REMOTE_DIR=' + path.join(root, 'extension/remote'),
    'DSTUDIO_COWORK_DIR=' + path.join(root, 'extension/cowork'),
    'DSTUDIO_PLD_DIR=' + path.join(root, 'patch/ds4-agent-jsonl'), binary], engine);
  report.binarySHA256 = hash(fs.readFileSync(binary));
  const result = command(binary, [], run, false, 20000);
  report.rows = (result.stdout || '').split('\n').filter(x => x.startsWith('{"case":')).map(JSON.parse);
  report.notices = (result.stdout || '').split('\n').filter(x => x.startsWith('\x1e')).map(x => JSON.parse(x.slice(1)));
  report.inputsUnchanged = [...inputs].every(([file, digest]) => hash(fs.readFileSync(file)) === digest);
  save();
  assert(report.inputsUnchanged, 'Captured inputs changed during the gate');
  assert.equal(result.status, 0, 'Native owner/notice checks failed; original output retained');
  assert.equal(report.rows.length, 21, 'Expected all 20 behavioral checks and their summary');
  assert(report.rows.every(row => row.passed));
  assert.deepEqual(report.notices, [
    {type: 'runtime_notice', text: 'Stopped by user'},
    {type: 'runtime_notice', text: 'Quote " and newline\nCafé 日本語'},
  ]);
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString(); save(); console.log(run);
}
