// Native payload reads and ownership: initialized CPU state, no model weights.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const run = artifactRunDir('q36-payload-prepare');
const report = {started: new Date().toISOString(), status: 'FAIL', commands: [], inputs: {},
  variant: process.argv[3] === '--direct-baseline' ? 'direct-baseline' : 'private-preparation',
  scope: 'Production CPU/native payload read/write; short I/O and cancel; no model/forward/GPU inference'};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = () => writeArtifact(run, 'results.json', report);
console.log('Evidence: ' + run); save();
try {
  assert(process.argv.length === 3 || (process.argv.length === 4 && ['--direct-baseline', '--write-only'].includes(process.argv[3])),
    'Supply exact q36 source directory and optional --direct-baseline or --write-only');
  if (process.argv[3] === '--write-only') report.scope = 'Production native payload writing only; short writes and cancellation; no inference';
  const engine = fs.realpathSync(process.argv[2]);
  const source = path.resolve(import.meta.dirname, '../support/q36_payload_prepare_unit.c');
  const fixture = path.resolve(import.meta.dirname, '../support/q36_text_prepare_unit.c');
  for (const file of [source, fixture, import.meta.filename, ...['q36.c', 'q36.h', 'q36_gpu.h', 'q36_quant.h',
    'q36_image.h', 'q36_ssd.h', 'q36_iq_tables.h', 'q36_iq3s_grid_values.inc'].map(n => path.join(engine, n))])
    report.inputs[file] = hash(file);
  for (const file of [source, fixture, import.meta.filename])
    fs.copyFileSync(file, path.join(run, path.basename(file)), fs.constants.COPYFILE_EXCL);
  const binary = path.join(run, 'probe');
  const args = ['-std=c11', '-O1', '-ffunction-sections', '-fdata-sections', '-fsanitize=address,undefined',
    '-fno-omit-frame-pointer', '-I', engine, source, '-lm', '-pthread', '-o', binary,
    process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
  if (process.argv[3] === '--direct-baseline') args.unshift('-DDSTUDIO_Q36_PAYLOAD_BASELINE');
  if (process.argv[3] === '--write-only') args.unshift('-DDSTUDIO_Q36_PAYLOAD_WRITE_ONLY');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_)/.test(name)));
  env.ASAN_OPTIONS = 'detect_leaks=0';
  for (const [command, argv, seconds] of [['cc', args, 120], [binary, [], 30]]) {
    const r = spawnSync(command, argv, {env, encoding: 'utf8', timeout: seconds * 1000, maxBuffer: 2 ** 21});
    report.commands.push({command, args: argv, status: r.status, signal: r.signal,
      stdout: r.stdout, stderr: r.stderr, error: r.error?.message}); save();
    if (command === binary && r.stdout) report.result = JSON.parse(r.stdout);
    assert.equal(r.status, 0, r.stderr || r.error?.message);
  }
  report.binarySHA256 = hash(binary);
  assert(report.result.cases >= (process.argv[3] === '--write-only' ? 12 : 1000)); assert.equal(report.result.failures, 0);
  assert.equal(report.result.liveAllocations, 0);
  report.status = 'PASS';
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {
  for (const [file, expected] of Object.entries(report.inputs)) if (hash(file) !== expected) {
    report.status = 'FAIL'; report.changedInput = file; process.exitCode = 1;
  }
  report.finished = new Date().toISOString(); save();
}
