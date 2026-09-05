import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Explicit real-Metal regression: only the existing vision encoder is mapped.
// Never starts/stops DStudio, an LLM server, or a download.
assert.equal(process.platform, 'darwin', 'NOT RUN: this test requires macOS Metal');
const repo = process.cwd();
const source = path.resolve(process.argv[2] || 'ds4');
const encoder = path.resolve(process.argv[3] || path.join(source, 'gguf/DeepSeek-V4-Flash-Vision-Encoder.gguf'));
assert.ok(fs.statSync(encoder).size > 0, 'NOT RUN: actual encoder weights are required');
fs.mkdirSync('tests/.artifacts', { recursive: true });
const root = fs.mkdtempSync(path.resolve('tests/.artifacts/vision-stream-'));
const engine = path.join(root, 'engine');
const receipt = { inference: 'real encoder and routing kernels only; no LLM', restarted: false, encoder,
  encoderBytes: fs.statSync(encoder).size, passed: false, steps: [] };
let step = 0;
async function run(command, args, options = {}) {
  const name = `${String(++step).padStart(2, '0')}-${path.basename(command)}`;
  const log = path.join(root, `${name}.log`);
  const start = Date.now();
  const child = spawn(command, args, { cwd: options.cwd || repo, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', b => chunks.push(b));
  child.stderr.on('data', b => chunks.push(b));
  const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  const text = Buffer.concat(chunks).toString();
  fs.writeFileSync(log, text);
  receipt.steps.push({ command, args, code, elapsedMs: Date.now() - start, log: path.basename(log) });
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(receipt, null, 2));
  assert.equal(code, options.expected ?? 0, `${name} failed: ${text.slice(-4000)}`);
  return text;
}
const hook = action => run('sh', [path.join(repo, 'scripts/apply-ds4-vision-streaming.sh'), action], { env: { DS4_DIR: engine } });
const objects = ['ds4_image.o', 'ds4_distributed.o', 'ds4_tp.o', 'ds4_ssd.o', 'ds4_metal.o', 'ds4_layer_pack.o'];
async function compile(name) {
  await run('make', ['-j2', ...objects], { cwd: engine });
  const binary = path.join(root, name);
  await run('cc', ['-O1', '-std=c11', '-D_GNU_SOURCE', '-fno-finite-math-only', '-I', engine,
    path.join(repo, 'tests/live/vision_stream_mapping_probe.c'), ...objects.map(o => path.join(engine, o)),
    '-framework', 'Foundation', '-framework', 'Metal', '-lm', '-lpthread', '-o', binary]);
  return binary;
}
try {
  // Local Git objects only: no weights, dirty source, downloads or user's
  // build products are copied. The checkout belongs entirely to this test.
  await run('git', ['clone', '-q', '--shared', source, engine]);
  receipt.commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: engine })).trim();
  await hook('check');
  const before = await compile('probe-before');
  const failed = await run(before, [encoder], { cwd: engine, expected: 1 });
  assert.match(failed, /FAIL; 6 failures/, 'unpatched baseline must reproduce both failures across three real span changes');
  assert.match(failed, /not covered by mapped model views/);
  await hook('apply');
  await hook('apply'); // idempotence
  const after = await compile('probe-after');
  const passed = await run(after, [encoder], { cwd: engine });
  assert.match(passed, /PASS; 0 failures/);
  assert.doesNotMatch(passed, /not covered by mapped model views/);
  const baseline = failed.match(/^baseline: ([0-9a-f ]+)$/m)?.[1];
  assert.ok(baseline, 'unpatched encoder/router baseline hashes must be available');
  assert.equal(passed.match(/^baseline: ([0-9a-f ]+)$/m)?.[1], baseline,
    'the patch must also preserve the original pre-remap encoder/router outputs');
  receipt.baselineHashes = baseline.split(' ');
  await hook('restore');
  await hook('restore');
  await run('git', ['diff', '--exit-code'], { cwd: engine });
  receipt.passed = true;
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(receipt, null, 2));
  console.log(`vision_stream_mapping_test: PASS — unpatched fails 6/6, patched passes 6/6; exact pre/post-remap encoder and router outputs. Evidence: ${root}`);
} finally {
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(receipt, null, 2));
}
