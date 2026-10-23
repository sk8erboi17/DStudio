// Real engine, real checkpoint identities: which V4.1 language/vision GGUF
// pairs does the actual ds4 binary accept? The headers (metadata and tensor
// table) of the four published files are fetched by HTTP range at pinned
// revisions; each fixture is a sparse file of the published size with that
// header, so no weights are downloaded or read. `ds4 --inspect` opens both
// models, binds the vision sidecar and applies the pairing check, then returns
// before any weight is loaded. Two binaries are built from the pinned engine
// with the production runtime patch stack: without and with the V4.1 pairing
// patch. Network is needed for the headers (cached under tests/.artifacts).
// This checks pairing admission only; it does not run image inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactDir, artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

if (process.platform !== 'darwin') {
  console.log('v41_vision_pairing_live_test: V4.1 vision is Metal-only; NOT RUN on ' + process.platform);
  process.exit(1);
}
const root = process.cwd();
const run = artifactRunDir('v41-vision-pairing-live');
const cache = path.join(artifactDir('v41-vision-pairing-live'), 'headers');
fs.mkdirSync(cache, {recursive: true});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ANTIREZ = {repo: 'antirez/deepseek-v4.1-flash-gguf', rev: '9dcee51692e6540f697141fc98b097e3c96492a3'};
const COMMUNITY = {repo: 'nazeshinjite/DeepSeek-V4.1-Flash-1017-ds4-GGUF', rev: '796f58533a0e4b7a89cb006b22aeb44e783f0323'};
const files = {
  originalQ2: {...ANTIREZ, file: 'DeepSeek-V4.1-Flash-Q2.gguf', bytes: 365713686528},
  q2_1017: {...ANTIREZ, file: 'DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf', bytes: 365713686528},
  originalVision: {...ANTIREZ, file: 'DeepSeek-V4.1-Flash-Vision.gguf', bytes: 970555552},
  vision1017: {...COMMUNITY, file: 'DeepSeek-V4.1-Flash-1017-Vision.gguf', bytes: 970555552},
};
const report = {scope: 'Real ds4 --inspect on published V4.1 headers in sparse files; pairing admission only, no weights read, no image inference',
  files, builds: {}, cases: [], passed: false};
const save = () => writeArtifact(run, 'results.json', report);

// Minimal GGUF v3 header walk: returns the data offset (end of the header).
function headerEnd(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const need = n => { if (p + n > buf.length) throw new RangeError('short'); };
  const u32 = () => { need(4); const x = v.getUint32(p, true); p += 4; return x; };
  const u64 = () => { need(8); const x = v.getBigUint64(p, true); p += 8; return Number(x); };
  const str = () => { const n = u64(); need(n); const s = buf.subarray(p, p + n).toString('utf8'); p += n; return s; };
  const size = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8};
  const value = t => {
    if (t === 8) return str();
    if (t === 9) {
      const et = u32(), n = u64();
      if (et === 8) { for (let i = 0; i < n; i++) str(); return null; }
      need(size[et] * n); p += size[et] * n; return null;
    }
    need(size[t]); const at = p; p += size[t];
    return t === 4 ? v.getUint32(at, true) : null;
  };
  need(4); assert.equal(buf.subarray(0, 4).toString('latin1'), 'GGUF'); p = 4;
  u32(); const tensors = u64(), kvs = u64();
  let alignment = 32;
  for (let i = 0; i < kvs; i++) {
    const key = str(), x = value(u32());
    if (key === 'general.alignment') alignment = x;
  }
  for (let i = 0; i < tensors; i++) { str(); const dims = u32(); need(8 * dims); p += 8 * dims; u32(); u64(); }
  return Math.ceil(p / alignment) * alignment;
}

async function header(spec) {
  const cached = path.join(cache, `${spec.rev.slice(0, 8)}-${spec.file}.header`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached);
  const url = `https://huggingface.co/${spec.repo}/resolve/${spec.rev}/${spec.file}`;
  for (let want = 4 << 20; want <= 256 << 20; want *= 2) {
    const res = await fetch(url, {headers: {Range: `bytes=0-${want - 1}`}, signal: AbortSignal.timeout(120000)});
    assert.equal(res.status, 206, `${spec.file}: expected a partial response`);
    const buf = Buffer.from(await res.arrayBuffer());
    try {
      const end = headerEnd(buf);
      const bytes = buf.subarray(0, end);
      fs.writeFileSync(cached + '.tmp', bytes); fs.renameSync(cached + '.tmp', cached);
      return bytes;
    } catch (error) { if (!(error instanceof RangeError)) throw error; }
  }
  throw new Error(`${spec.file}: header larger than 256 MiB`);
}

function sparse(name, spec, bytes) {
  const file = path.join(run, 'gguf', spec.file);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const fd = fs.openSync(file, 'wx');
  fs.writeSync(fd, bytes, 0, bytes.length, 0);
  fs.ftruncateSync(fd, spec.bytes);
  fs.closeSync(fd);
  report.files[name].headerBytes = bytes.length; report.files[name].headerSHA256 = sha(bytes);
  return file;
}

function build(label, withPairing) {
  const dir = path.join(run, `ds4-${label}`);
  fs.cpSync(path.join(root, 'src/engines/ds4'), dir, {recursive: true});
  const git = args => assert.equal(spawnSync('git', ['-C', dir, ...args], {encoding: 'utf8'}).status, 0, args.join(' '));
  git(['init', '-q']); git(['add', '-A']);
  git(['-c', 'user.email=test@localhost', '-c', 'user.name=test', 'commit', '-qm', 'pinned']);
  const scripts = ['visible-downloads', 'media-memory', 'server-metrics', 'glm53-runtime', 'glm53-m2max',
    'vision-streaming', ...(withPairing ? ['v41-vision-pairing'] : [])];
  const applied = [];
  for (const name of scripts) {
    const r = spawnSync('/bin/sh', [path.join(root, `scripts/apply-ds4-${name}.sh`), 'apply'],
      {encoding: 'utf8', env: {...process.env, DS4_DIR: dir}});
    assert.equal(r.status, 0, `${label}: ${name}: ${r.stderr}`);
    applied.push(`${name}: ${r.stdout.trim()}`);
  }
  const make = spawnSync('make', ['-j8', 'ds4'], {cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20});
  fs.writeFileSync(path.join(run, `build-${label}.log`), make.stdout + make.stderr);
  assert.equal(make.status, 0, `${label}: ds4 build failed (see build-${label}.log)`);
  const binary = path.join(dir, 'ds4');
  report.builds[label] = {applied, binarySHA256: sha(fs.readFileSync(binary))}; save();
  return binary;
}

const refusal = /DeepSeek vision sidecar does not match the language checkpoint/;
function inspect(binary, model, vision) {
  const r = spawnSync(binary, ['--inspect', '--metal', '-m', model, '--vision', vision],
    {encoding: 'utf8', timeout: 120000, maxBuffer: 16 << 20});
  return {status: r.status, signal: r.signal, refused: refusal.test(r.stderr),
    stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(-2000)};
}

try {
  const paths = {};
  for (const [name, spec] of Object.entries(files)) paths[name] = sparse(name, spec, await header(spec));
  save();
  const binaries = {pinned: build('pinned', false), patched: build('patched', true)};
  // accepted: the engine opens the pair; otherwise it must refuse it explicitly.
  const matrix = [
    ['originalQ2', 'originalVision', {pinned: true, patched: true}],
    ['q2_1017', 'vision1017', {pinned: false, patched: true}],
    ['originalQ2', 'vision1017', {pinned: false, patched: false}],
    // The pinned engine checks only the sidecar's revision, so it pairs the
    // 1017 language model with the original vision weights; the patch refuses.
    ['q2_1017', 'originalVision', {pinned: true, patched: false}],
  ];
  for (const [model, vision, expected] of matrix) for (const [label, binary] of Object.entries(binaries)) {
    const result = inspect(binary, paths[model], paths[vision]);
    const row = {engine: label, model, vision, expectedAccepted: expected[label], ...result};
    report.cases.push(row); save();
    if (expected[label]) {
      assert.equal(result.status, 0, `${label} should accept ${model} + ${vision}:\n${result.stderr}`);
      // Accepted means the open completed: the inspection summary of the V4.1 model.
      assert.match(result.stdout, /^arch:\s+deepseek41$/m);
      assert.match(result.stdout, /^gguf:\s+v3, \d+ metadata keys, 1046 tensors$/m);
    }
    else {
      assert.notEqual(result.status, 0, `${label} should refuse ${model} + ${vision}`);
      assert(result.refused, `${label} must refuse ${model} + ${vision} as a mismatched sidecar:\n${result.stderr}`);
    }
    console.log(`${label.padEnd(7)} ${model} + ${vision}: ${expected[label] ? 'accepted' : 'refused'} (expected)`);
  }
  report.passed = true;
  console.log(`PASS: V4.1 sidecar pairing on the real engine; receipts: ${run}`);
} catch (error) { report.error = error.stack; console.error(error); process.exitCode = 1; }
finally {
  save();
  // The sparse fixtures and engine copies are large on paper; keep only receipts.
  fs.rmSync(path.join(run, 'gguf'), {recursive: true, force: true});
  for (const label of ['pinned', 'patched']) fs.rmSync(path.join(run, `ds4-${label}`), {recursive: true, force: true});
}
