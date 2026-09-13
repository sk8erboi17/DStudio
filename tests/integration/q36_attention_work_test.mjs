// Bounded native Metal kernel test; no weights, model process or app mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('q36-attention-work');
const report = {started: new Date().toISOString(), scope: 'Real Metal F16 attention; no LLM quality or end-to-end speed claim',
  passed: false, commands: [], host: {platform: process.platform, arch: process.arch}};
const save = () => writeArtifact(run, 'results.json', report);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function command(binary, args, cwd, env) {
  const row = {binary, args, cwd}; report.commands.push(row); save();
  const result = await new Promise(resolve => {
    const child = spawn(binary, args, {cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', error = '', escalation;
    const stop = reason => {
      if (error) return; error = reason;
      try {if (child.pid) process.kill(-child.pid, 'SIGTERM');} catch {}
      escalation = setTimeout(() => {try {if (child.pid) process.kill(-child.pid, 'SIGKILL');} catch {}}, 1000);
    };
    const timer = setTimeout(() => stop('120-second command deadline'), 120000);
    child.stdout.on('data', x => {stdout += x; if (stdout.length > 2 ** 20) stop('stdout limit');});
    child.stderr.on('data', x => {stderr += x; if (stderr.length > 2 ** 20) stop('stderr limit');});
    child.on('error', e => {error = String(e);});
    child.on('close', (status, signal) => {clearTimeout(timer); clearTimeout(escalation); resolve({status, signal, error, stdout, stderr});});
  });
  Object.assign(row, result); save(); return result;
}
try {
  assert.equal(process.platform, 'darwin', 'Metal unavailable: NOT RUN');
  assert.ok(process.argv.length===3 || process.argv.length===4&&['--segmented', '--profile-stages'].includes(process.argv[3]),
    'Supply one built q36 source directory and optional --segmented or --profile-stages');
  report.segmentedExpectation=process.argv.length===4;
  report.isolatedStageDiagnostic=process.argv[3]==='--profile-stages';
  if (report.isolatedStageDiagnostic) report.scope += '; encoder-isolated diagnostic perturbs scheduling, not production latency';
  const source = fs.realpathSync(process.argv[2]);
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(Q36_|DYLD_)/.test(key)) delete env[key];
  report.inputs = {};
  const inputs = ['q36_metal.m', 'q36_gpu.h', 'q36_ssd.o', 'q36_gpu_core_metal.o', 'q36_image.o',
    ...fs.readdirSync(path.join(source, 'metal')).filter(f => f.endsWith('.metal')).map(f => `metal/${f}`)];
  for (const relative of inputs) report.inputs[relative] = hash(fs.readFileSync(path.join(source, relative)));
  const probeSource = path.join(root, 'tests/support/q36_attention_work_probe.m');
  report.probeSha256 = hash(fs.readFileSync(probeSource)); report.harnessSha256 = hash(fs.readFileSync(import.meta.filename));
  const capturedProbe = path.join(run, 'probe-source.m');
  fs.copyFileSync(probeSource, capturedProbe, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(import.meta.filename, path.join(run, 'harness.mjs'), fs.constants.COPYFILE_EXCL);
  const binary = path.join(run, 'attention-probe');
  const build = await command('clang', ['-O2', '-fno-fast-math', '-ffp-contract=off', '-fobjc-arc',
    `-DDSTUDIO_Q36_METAL_SOURCE=${JSON.stringify(path.join(source, 'q36_metal.m'))}`, '-I', source,
    capturedProbe, 'q36_ssd.o', 'q36_gpu_core_metal.o', 'q36_image.o',
    '-framework', 'Foundation', '-framework', 'Metal', '-lm', '-pthread', '-o', binary], source, env);
  assert.equal(build.status, 0, build.stderr); assert.equal(build.error, '');
  report.binarySha256 = hash(fs.readFileSync(binary));
  const measured = await command(binary, report.segmentedExpectation?[process.argv[3]]:[], source, env);
  report.measurements = measured.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  report.inputsPreserved = inputs.every(f => hash(fs.readFileSync(path.join(source, f))) === report.inputs[f]);
  report.inputsPreserved &&= hash(fs.readFileSync(probeSource)) === report.probeSha256 &&
    hash(fs.readFileSync(capturedProbe)) === report.probeSha256 &&
    hash(fs.readFileSync(import.meta.filename)) === report.harnessSha256;
  assert(report.inputsPreserved); assert.equal(measured.error, '');
  assert.equal(measured.status, 0, measured.stderr); assert.equal(report.measurements.at(-1).passed, true);
  report.passed = true;
} catch (error) {report.error = error.stack || String(error); process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); save(); console.log(JSON.stringify({run, passed: report.passed, measurements: report.measurements, error: report.error}, null, 2));}
