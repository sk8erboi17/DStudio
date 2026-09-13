// Actual native state copy/allocator recovery; initialized CPU fixtures only.
// The explicit vision variant covers checkpoint identities, not CPU vision inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const vision = process.argv[3] === 'vision';
const run = artifactRunDir(vision ? 'q36-vision-prepare-unit' : 'q36-text-prepare-unit');
const report = {started: new Date().toISOString(), status: 'FAIL', commands: [], inputs: {},
  mode: vision ? 'visual checkpoint preparation' : 'text preparation',
  scope: 'Production CPU/session preparation, initialized state, allocator/cancel failpoints; no model/forward/GPU inference'};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = () => writeArtifact(run, 'results.json', report);
console.log('Evidence: ' + run); save();
try {
  assert(process.argv.length === 3 || (process.argv.length === 4 && vision),
    'Supply exact q36 source directory and optional vision checkpoint variant');
  const engine = fs.realpathSync(process.argv[2]);
  const fixture = path.resolve(import.meta.dirname, '../support/q36_text_prepare_unit.c');
  const source = vision ? path.resolve(import.meta.dirname, '../support/q36_vision_prepare_unit.c') : fixture;
  for (const file of [source, fixture, import.meta.filename, ...['q36.c', 'q36.h', 'q36_gpu.h', 'q36_quant.h',
    'q36_image.h', 'q36_ssd.h', 'q36_iq_tables.h', 'q36_iq3s_grid_values.inc'].map(n => path.join(engine, n))])
    report.inputs[file] = hash(file);
  fs.copyFileSync(source, path.join(run, 'probe-source.c'), fs.constants.COPYFILE_EXCL);
  if (vision) fs.copyFileSync(fixture, path.join(run, 'q36_text_prepare_unit.c'), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(import.meta.filename, path.join(run, 'harness.mjs'), fs.constants.COPYFILE_EXCL);
  const binary = path.join(run, 'probe');
  const args = ['-std=c11', '-O1', '-ffunction-sections', '-fdata-sections', '-fsanitize=address,undefined',
    '-fno-omit-frame-pointer', '-I', engine, source, '-lm', '-pthread', '-o', binary,
    process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
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
  assert(report.result.cases >= (vision ? 18 * 18 : 1500)); assert.equal(report.result.failures, 0);
  assert.equal(report.result.liveAllocations, 0);
  assert(report.result.copyBytes64 > 0);
  assert.equal(report.result.copyBytes64, report.result.copyBytes4096);
  report.status = 'PASS';
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {
  for (const [file, expected] of Object.entries(report.inputs)) if (hash(file) !== expected) {
    report.status = 'FAIL'; report.changedInput = file; process.exitCode = 1;
  }
  report.finished = new Date().toISOString(); save();
}
