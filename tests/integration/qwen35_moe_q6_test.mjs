// Real Metal kernels of the Qwen3.6 fork against an independent Q6_K oracle,
// before and after DStudio's versioned correction. Synthetic weights only:
// this proves kernel arithmetic and patch lifecycle, not model quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

assert.equal(process.platform, 'darwin', 'This kernel gate requires Metal; other hosts are not run');
const root = process.cwd(), source = fs.realpathSync(process.argv[2] || 'ds4-qwen35');
const run = artifactRunDir('qwen35-moe-q6');
const tree = path.join(run, 'engine source');
const script = path.join(root, 'scripts/apply-ds4-qwen35-q6k-moe.sh');
const patchFile = path.join(root, 'patch/ds4-qwen35-q6k-moe/moe-q6k-nibble.patch');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const report = { schema: 'dstudio.qwen35-moe-q6.v1', started: new Date().toISOString(),
  scope: 'Production Metal MoE kernels on synthetic Q6_K/Q8_0 blocks vs independent scalar oracle; patch lifecycle; no model weights',
  source, patchSHA256: sha(fs.readFileSync(patchFile)), checks: [], passed: false };
const save = () => writeArtifact(run, 'results.json', report);
const check = name => { report.checks.push(name); save(); console.log('PASS: ' + name); };
const command = (exe, args, options = {}) => spawnSync(exe, args, {
  encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024, ...options });
const apply = (action, dir = tree) => command('sh', [script, action], { env: { ...process.env, DS4_DIR: dir } });

// Build inputs only; never objects, binaries or weights from the checkout.
function snapshot(input, output) {
  const keep = name => /\.(c|h|m|inc|metal)$/.test(name) || name === 'Makefile';
  const visit = rel => {
    for (const entry of fs.readdirSync(path.join(input, rel), { withFileTypes: true })) {
      const name = path.join(rel, entry.name);
      if (entry.isDirectory() && (rel === '' ? entry.name === 'metal' : true)) visit(name);
      else if (entry.isFile() && keep(entry.name)) {
        fs.mkdirSync(path.dirname(path.join(output, name)), { recursive: true });
        fs.copyFileSync(path.join(input, name), path.join(output, name), fs.constants.COPYFILE_EXCL);
      }
    }
  };
  visit('');
}

function probe(label) {
  const r = command(path.join(run, 'probe'), [], { cwd: tree });
  fs.writeFileSync(path.join(run, `${label}.log`), r.stdout + r.stderr, { flag: 'wx' });
  const rows = r.stdout.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  report[label] = { status: r.status, rows }; save();
  return { status: r.status, rows: Object.fromEntries(rows.map(row => [row.case, row])) };
}

try {
  fs.mkdirSync(tree);
  snapshot(source, tree);
  assert.equal(command('sh',[path.join(root,'scripts/apply-ds4-qwen35-prefill.sh'),'restore'],
    {env:{...process.env,DS4_DIR:tree}}).status,0,'restore the private prefill overlay before reproducing upstream kernels');
  assert.equal(command('sh',[path.join(root,'scripts/apply-ds4-qwen35-catalog.sh'),'restore'],
    {env:{...process.env,DS4_DIR:tree}}).status,0,'restore the private server catalog before testing its upgrade');
  const shader = path.join(tree, 'metal/qwen35.metal');
  report.originalShaderSHA256 = sha(fs.readFileSync(shader));
  // An installed engine may already carry the correction. Restore the private
  // copy to the exact upstream shader (restore is byte-exact, checked below).
  if (apply('check').stdout.trim() === 'Qwen3.6 Q6_K MoE patch: already applied') {
    assert.equal(apply('restore').status, 0);
    report.sourceShaderWasCorrected = true;
    report.originalShaderSHA256 = sha(fs.readFileSync(shader));
  }
  assert.equal(apply('check').stdout.trim(), 'Qwen3.6 Q6_K MoE patch: applicable', 'expected the unpatched fork shader');
  const objects = ['ds4.o', 'ds4_distributed.o', 'ds4_tp.o', 'ds4_ssd.o', 'ds4_metal.o', 'ds4_layer_pack.o'];
  const built = command('make', ['-C', tree, '-j4', ...objects]);
  fs.writeFileSync(path.join(run, 'engine-build.log'), built.stdout + built.stderr, { flag: 'wx' });
  assert.equal(built.status, 0, built.stderr.slice(-2000));
  const linked = command(process.env.CC || 'cc', ['-O2', '-std=c11', '-Wno-unused-function', '-I', tree,
    path.join(root, 'tests/support/qwen35_moe_q6_probe.c'), ...objects.map(o => path.join(tree, o)),
    '-lm', '-pthread', '-framework', 'Foundation', '-framework', 'Metal', '-o', path.join(run, 'probe')]);
  fs.writeFileSync(path.join(run, 'probe-build.log'), linked.stdout + linked.stderr, { flag: 'wx' });
  assert.equal(linked.status, 0, linked.stderr);

  // RED: the unmodified fork must reproduce the defect, while the oracle
  // agrees with the fork's own dense Q6_K kernel and all Q8_0 paths.
  const before = probe('before');
  assert.equal(before.status, 1, 'the original kernels must fail the oracle');
  assert.equal(before.rows['dense-q6-control'].matvec.bad, 0, 'oracle must agree with the dense Q6_K reference kernel');
  for (const stage of ['gateUp', 'down']) assert.equal(before.rows['ud-q8-layer'][stage].bad, 0, 'Q8_0 paths are correct');
  assert(before.rows['ud-q6-layer'].gateUp.bad > 0, 'routed Q6_K gate/up must be wrong before the patch');
  assert.equal(before.rows['ud-q6-layer'].down.bad, 0, 'Q8_0 down is unaffected');
  assert(before.rows['all-q6'].down.bad > 0, 'Q6_K down must be wrong before the patch');
  check('original fork reproduces wrong Q6_K MoE decoding; oracle and Q8_0 paths agree');

  // GREEN: the versioned correction repairs every Q6_K branch.
  assert.equal(apply('apply').status, 0);
  assert.equal(apply('apply').stdout.trim(), 'Qwen3.6 Q6_K MoE patch: already applied');
  const after = probe('after');
  assert.equal(after.status, 0, 'every case must match the oracle after the patch');
  for (const row of Object.values(after.rows))
    for (const stage of ['gateUp', 'down', 'matvec']) if (row[stage]) assert.equal(row[stage].bad, 0, `${row.case}/${stage}`);
  check('patched kernels match the oracle for UD-Q6_K_XL, Q8_0 and all-Q6_K layouts');

  // Lifecycle: exact restore, unrelated edits, drift, partial and links.
  assert.equal(apply('restore').status, 0);
  assert.equal(sha(fs.readFileSync(shader)), report.originalShaderSHA256, 'restore is byte-exact');
  fs.appendFileSync(shader, '\n/* unrelated contributor note */\n');
  const edited = fs.readFileSync(shader);
  assert.equal(apply('apply').status, 0); assert.equal(apply('restore').status, 0);
  assert.deepEqual(fs.readFileSync(shader), edited, 'unrelated edits survive apply/restore');
  check('repeat apply, byte-exact restore and unrelated edits');

  const original = fs.readFileSync(shader, 'utf8');
  const lines = original.split('\n');
  const firstHunk = lines.findIndex(l => l.includes('const int ql_shift = (quarter & 1) * 4;'));
  const partial = [...lines]; partial[firstHunk] = partial[firstHunk].replace('(quarter & 1) * 4', '(quarter >> 1) * 4');
  fs.writeFileSync(shader, partial.join('\n'));
  let r = apply('apply');
  assert.notEqual(r.status, 0, 'a partially corrected shader is not complete');
  assert.equal(fs.readFileSync(shader, 'utf8'), partial.join('\n'), 'rejected partial state is unchanged');
  const drift = [...lines]; drift[firstHunk - 1] += ' // drift';
  fs.writeFileSync(shader, drift.join('\n'));
  r = apply('apply');
  assert.notEqual(r.status, 0, 'drifted context is rejected');
  assert.equal(fs.readFileSync(shader, 'utf8'), drift.join('\n'), 'rejected drift is unchanged');
  fs.writeFileSync(shader, original);
  const linkDir = path.join(run, 'linked engine');
  fs.mkdirSync(path.join(linkDir, 'metal'), { recursive: true });
  fs.copyFileSync(path.join(tree, 'ds4.h'), path.join(linkDir, 'ds4.h'));
  fs.symlinkSync(shader, path.join(linkDir, 'metal/qwen35.metal'));
  r = apply('apply', linkDir);
  assert.equal(r.status, 2, 'a linked shader is rejected');
  assert.equal(fs.readFileSync(shader, 'utf8'), original, 'link target unchanged');
  fs.writeFileSync(path.join(linkDir, 'ds4.h'), '/* other engine */\n');
  fs.unlinkSync(path.join(linkDir, 'metal/qwen35.metal'));
  fs.copyFileSync(shader, path.join(linkDir, 'metal/qwen35.metal'));
  assert.equal(apply('apply', linkDir).status, 1, 'another engine ABI is rejected');
  check('partial, drifted, linked and wrong-ABI sources are rejected without changes');

  // Production wiring: the real launch-preparation worker must correct an
  // existing installation before any Qwen3.6 engine starts, and refuse to
  // start a drifted shader instead of running known-wrong arithmetic.
  const host = process.argv[3] && fs.realpathSync(process.argv[3]);
  if (!host) throw new Error('Supply the DStudio host binary to verify launch preparation');
  // The worker treats EOF on stdin as loss of its owner, exactly as in the
  // app: keep the pipe open until it exits, then close it.
  const prepare = (label, shaderText) => new Promise((resolve, reject) => {
    const engine = path.join(run, label, 'ds4-qwen35');
    fs.mkdirSync(path.join(engine, 'metal'), { recursive: true });
    fs.copyFileSync(path.join(tree, 'ds4.h'), path.join(engine, 'ds4.h'));
    for (const file of ['ds4.c','ds4_gpu.h','ds4_metal.m'])
      fs.copyFileSync(path.join(tree,file),path.join(engine,file));
    fs.writeFileSync(path.join(engine, 'metal/qwen35.metal'), shaderText);
    // Simulated build dependency graph for this shader-focused launch fixture.
    // The full native rebuild is exercised separately below.
    fs.copyFileSync(path.join(tree, 'ds4_server.c'), path.join(engine, 'ds4_server.c'));
    const cat = command('sh', [path.join(root, 'scripts/apply-ds4-qwen35-catalog.sh'), 'apply'], { env: { ...process.env, DS4_DIR: engine } });
    assert.equal(cat.status, 0, cat.stderr);
    fs.writeFileSync(path.join(engine, 'ds4-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(engine,'Makefile'),'ds4-server:\n\t@exit 0\n');
    const child = spawn(host, ['--prepare-launch', 'server', engine, root, 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf',
      '', '', 'local', '1', 'keep-external', '28000'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 120000);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer); child.stdin.destroy();
      fs.writeFileSync(path.join(run, `${label}-prepare.log`), out + err, { flag: 'wx' });
      const line = out.split('\n').find(l => l.startsWith('{"v":1'));
      if (!line) return reject(new Error(`${label}: preparation result missing (status ${code})`));
      resolve({ result: JSON.parse(line), shader: fs.readFileSync(path.join(engine, 'metal/qwen35.metal'), 'utf8'), engine });
    });
  });
  const ready = await prepare('existing-install', original);
  assert.equal(ready.result.ok, true, ready.result.error);
  assert.equal(apply('check', ready.engine).stdout.trim(), 'Qwen3.6 Q6_K MoE patch: already applied');
  const drifted = await prepare('drifted-install', drift.join('\n'));
  assert.equal(drifted.result.ok, false, 'a drifted Qwen3.6 shader must not start');
  assert.match(drifted.result.error, /Q6_K/);
  assert.equal(drifted.shader, drift.join('\n'), 'failed preparation leaves the shader unchanged');
  check('launch preparation corrects an existing install and refuses a drifted shader');

  // An install upgraded in place never received the model-catalog patch, so
  // its server advertised DeepSeek aliases for a loaded Qwen model. Launch
  // preparation must apply it and rebuild only the stale native server.
  const full = path.join(run, 'catalog-install', 'ds4-qwen35');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.cpSync(tree, full, { recursive: true, verbatimSymlinks: true });
  fs.writeFileSync(path.join(full, 'metal/qwen35.metal'), original);
  const catalogScript = path.join(root, 'scripts/apply-ds4-qwen35-catalog.sh');
  const catalog = () => command('sh', [catalogScript, 'check'], { env: { ...process.env, DS4_DIR: full } }).stdout.trim();
  assert.equal(catalog(), 'Qwen catalog patch: applicable', 'fixture reproduces an install without the catalog patch');
  const server = path.join(full, 'ds4-server');
  assert(!fs.existsSync(server));
  const upgraded = await new Promise((resolve, reject) => {
    const child = spawn(host, ['--prepare-launch', 'server', full, root, 'gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf',
      '', '', 'local', '1', 'keep-external', '28000'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 600000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer); child.stdin.destroy();
      fs.writeFileSync(path.join(run, 'catalog-install-prepare.log'), out + err, { flag: 'wx' });
      const line = out.split('\n').find(l => l.startsWith('{"v":1'));
      line ? resolve(JSON.parse(line)) : reject(new Error('catalog preparation result missing'));
    });
  });
  assert.equal(upgraded.ok, true, upgraded.error);
  assert.equal(catalog(), 'Qwen catalog patch: already applied');
  assert.equal(apply('check', full).stdout.trim(), 'Qwen3.6 Q6_K MoE patch: already applied');
  assert(fs.statSync(server).mtimeMs >= fs.statSync(path.join(full, 'ds4_server.c')).mtimeMs, 'server rebuilt from patched source');
  const help = command(server, ['--help'], { cwd: full, timeout: 20000 });
  assert.equal(help.status, 0, help.stderr);
  check('launch preparation applies the missing catalog patch and rebuilds the stale server');
  report.passed = true;
} catch (e) { report.error = e.stack; console.error(e); process.exitCode = 1; }
finally { report.finished = new Date().toISOString(); save(); console.log('Evidence: ' + run); }
