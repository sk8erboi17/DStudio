// Executes scripts/download-ds41-1017.sh and the repo-root download-model.sh
// with a fake `hf` and tiny hashed payloads; nothing here reads script source.
// Transport is simulated; no model weights. Production size/sha stay
// hard-coded: only the explicit DSTUDIO_DS41_1017_TEST_* switch scales the
// oracle to the fixture. The expected pins below were taken independently from
// the Hugging Face API at each pinned revision.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = process.cwd(), script = path.join(root, 'scripts/download-ds41-1017.sh');
const run = artifactRunDir('ds41-1017-download'), bin = path.join(run, 'bin'), out = path.join(run, 'ds4/gguf');
fs.mkdirSync(bin); fs.mkdirSync(out, {recursive: true});
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const releases = [
  // antirez's official 1017 Q2: the file upstream ds4 5379c1c's ds41f-q2 names, with its published digest.
  {target: 'ds41f-q2', repo: 'antirez/deepseek-v4.1-flash-gguf', rev: '9dcee51692e6540f697141fc98b097e3c96492a3',
   file: 'DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf', bytes: 365713686528, sha: '5296e85ff64b42ecb62c8d0c0c54e1caa07e3df8e93112f2365ebbaed62ce93a'},
  // Community 1017 vision sidecar (source revision 1bae0e10, the same as the Q2's).
  {target: 'ds41f-1017-vision', repo: 'nazeshinjite/DeepSeek-V4.1-Flash-1017-ds4-GGUF', rev: '796f58533a0e4b7a89cb006b22aeb44e783f0323',
   file: 'DeepSeek-V4.1-Flash-1017-Vision.gguf', bytes: 970555552, sha: '861f1097e8686111fa23dc4a6bf139fd0c4cc114db2f1b4090a267f7683c0dbf'},
];
// Upstream 5379c1c's ds41f-q2 still carries the original Q2's digest; the 1017 file must not be checked against it.
const STALE_UPSTREAM_SHA = '1ce6a8f8806205c13330d7ca287bd198331dc5ca35ccc5d8a9a92a188a6f6f42';
const payload = file => Buffer.from(`independently hashed fixture: ${file}\n`);
const requests = path.join(run, 'hf.jsonl');
fs.writeFileSync(path.join(bin, 'hf'), `#!${process.execPath}
const fs=require('fs'),path=require('path');const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify({a,tok:process.env.HF_TOKEN||''})+'\\n');
if(process.env.DSTUDIO_TEST_HF_FAIL==='1')process.exit(7);
if(a[0]!=='download'||!a.includes('--local-dir'))process.exit(8);
const body=process.env.DSTUDIO_TEST_HF_BODY||('independently hashed fixture: '+a[2]+'\\n');
fs.writeFileSync(path.join(a[a.indexOf('--local-dir')+1],a[2]),body);
`, {flag: 'wx', mode: 0o755});
const report = {scope: 'DStudio-owned 1017 downloader with simulated transport and real small-file SHA verification; no weights', cases: [], passed: false};
const save = () => writeArtifact(run, 'results.json', report);
const calls = () => fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function download(r, ok, extra = {}, {test = true, args = []} = {}) {
  const p = payload(r.file);
  const env = {...process.env, PATH: bin + path.delimiter + process.env.PATH, HOME: run, DS4_GGUF_DIR: out, HF_TOKEN: '', ...extra};
  if (test) Object.assign(env, {DSTUDIO_DS41_1017_TEST_MODE: '1', DSTUDIO_DS41_1017_TEST_BYTES: String(p.length), DSTUDIO_DS41_1017_TEST_SHA: hash(p)});
  const res = spawnSync('sh', [script, r.target, ...args], {cwd: path.join(run, 'ds4'), env, encoding: 'utf8', timeout: 30000});
  report.cases.push({target: r.target, ok, code: res.status, stderr: res.stderr, stdout: res.stdout}); save();
  assert(!res.error && !res.signal); assert.equal(res.status === 0, ok, res.stderr + res.stdout); return res;
}
try {
  // Production pins, as the script reports them (no transport, no file written).
  for (const r of releases) {
    const res = spawnSync('sh', [script, r.target, '--print-pin'], {encoding: 'utf8', env: {PATH: process.env.PATH}});
    report.cases.push({target: r.target, printPin: res.stdout}); save();
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `${r.repo} ${r.rev} ${r.file} ${r.bytes} ${r.sha}\n`);
    assert(!res.stdout.includes(STALE_UPSTREAM_SHA));
  }
  assert.deepEqual(fs.readdirSync(out), []);
  for (const r of releases) {
    const file = path.join(out, r.file), stamp = file + '.verified';
    download(r, true);
    const [argv] = calls().slice(-1).map(c => c.a);
    assert.deepEqual(argv.slice(0, 3), ['download', r.repo, r.file]);
    assert.equal(argv[argv.indexOf('--revision') + 1], r.rev);
    assert.equal(argv[argv.indexOf('--max-workers') + 1], '1');
    assert.equal(argv[argv.indexOf('--repo-type') + 1], 'model');
    assert.equal(fs.realpathSync(argv[argv.indexOf('--local-dir') + 1]), fs.realpathSync(out));
    assert.deepEqual(fs.readFileSync(file), payload(r.file)); assert(fs.existsSync(stamp));
    // Idempotent: verified + stamped => no transport, no re-hash needed.
    const n = calls().length; download(r, true); assert.equal(calls().length, n);
    // Stamp is not trusted when the file changes underneath it (same size, new mtime).
    fs.writeFileSync(file, Buffer.alloc(payload(r.file).length, 120));
    const later = new Date(Date.now() + 5000); fs.utimesSync(file, later, later); // a real rewrite moves mtime past the stamp's second
    // A file that was already there and does not verify is refused but NEVER removed or renamed
    // (the weights folder is shared with the stock app); the stale stamp (our own marker) goes.
    let res = download(r, false); assert.match(res.stderr, /Checksum mismatch/); assert.match(res.stderr, /left untouched/);
    assert(fs.existsSync(file), 'pre-existing file left in place'); assert(!fs.existsSync(stamp));
    assert(!fs.readdirSync(out).some(f => f.includes('.rejected.')));
    for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f)); // test-owned fixtures only
    // Wrong size on disk: same rule.
    fs.writeFileSync(file, 'short');
    res = download(r, false); assert.match(res.stderr, /Incorrect file size/); assert(fs.existsSync(file));
    assert.equal(fs.readFileSync(file, 'utf8'), 'short');
    for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
    // Transport failure leaves nothing accepted.
    res = download(r, false, {DSTUDIO_TEST_HF_FAIL: '1'}); assert(!fs.existsSync(file));
    // A download that produces bad bytes is deleted (exact path only); neighbours in the folder survive.
    const neighbours = ['DeepSeek-V4.1-Flash-Q2.gguf', 'DeepSeek-V4.1-Flash-Q2.gguf.part', r.file + '.rejected.1', 'other.verified'];
    for (const n of neighbours) fs.writeFileSync(path.join(out, n), 'stock ' + n);
    res = download(r, false, {DSTUDIO_TEST_HF_BODY: 'x'.repeat(payload(r.file).length)});
    assert.match(res.stderr, /Checksum mismatch/); assert.match(res.stderr, /was deleted/);
    assert(!fs.existsSync(file) && !fs.existsSync(stamp));
    assert(!fs.readdirSync(out).some(f => f.startsWith(r.file + '.rejected.') && f !== r.file + '.rejected.1'));
    for (const n of neighbours) assert.equal(fs.readFileSync(path.join(out, n), 'utf8'), 'stock ' + n, n + ' untouched');
    // Same for a wrong-size download.
    res = download(r, false, {DSTUDIO_TEST_HF_BODY: 'tiny'}); assert.match(res.stderr, /Incorrect file size/); assert(!fs.existsSync(file));
    for (const n of neighbours) assert(fs.existsSync(path.join(out, n)));
    for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
  }
  // Token handling: --token / HF_TOKEN / the cached token reach hf through its environment, never argv.
  const q2 = releases[0];
  download(q2, true, {}, {args: ['--token', 'tok-arg']});
  assert(!calls().at(-1).a.includes('--token') && !calls().at(-1).a.includes('tok-arg'));
  assert.equal(calls().at(-1).tok, 'tok-arg');
  for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
  download(q2, true, {HF_TOKEN: 'tok-env'});
  assert(!calls().at(-1).a.includes('--token') && !calls().at(-1).a.includes('tok-env'));
  assert.equal(calls().at(-1).tok, 'tok-env');
  for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
  download(q2, true, {});
  assert.equal(calls().at(-1).tok, ''); assert(!calls().at(-1).a.includes('--token'));
  for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
  // Production oracle: without the test switch the fixture cannot pass.
  const res = download(q2, false, {}, {test: false});
  assert.match(res.stderr, /Incorrect file size/); assert(!fs.existsSync(path.join(out, q2.file)));
  for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
  // Unknown targets (including the retired community-Q2 target) and missing hf.
  for (const t of ['ds41f-1017-q2', 'ds41f-q4', 'ds41f-vision']) {
    const bad = spawnSync('sh', [script, t], {cwd: run, encoding: 'utf8', env: {...process.env, PATH: bin + path.delimiter + process.env.PATH}});
    assert.equal(bad.status, 1, t); assert.match(bad.stderr, /Unknown target/);
  }
  const nohf = spawnSync('sh', [script, q2.target], {cwd: path.join(run, 'ds4'), encoding: 'utf8',
    env: {PATH: '/usr/bin:/bin', HOME: run, DS4_GGUF_DIR: out}});
  if (!spawnSync('sh', ['-c', 'command -v hf']).stdout.toString().trim()) assert.notEqual(nohf.status, 0);
  // Root CLI, executed: a scratch project root holds the real download-model.sh and helper,
  // with stub make/dstudio (the CLI's build + engine-install steps) and a stub vendored
  // ds4/download_model.sh that records what reaches it.
  const proj = path.join(run, 'cli'), stubs = path.join(run, 'cli-bin'), vendored = path.join(run, 'vendored.jsonl');
  fs.mkdirSync(path.join(proj, 'scripts'), {recursive: true}); fs.mkdirSync(path.join(proj, 'ds4/gguf'), {recursive: true});
  fs.mkdirSync(stubs);
  fs.copyFileSync(path.join(root, 'download-model.sh'), path.join(proj, 'download-model.sh'));
  fs.copyFileSync(script, path.join(proj, 'scripts/download-ds41-1017.sh'));
  fs.writeFileSync(path.join(proj, 'ds4/ds4.c'), '');
  fs.writeFileSync(path.join(stubs, 'make'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  fs.writeFileSync(path.join(proj, 'dstudio'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  fs.writeFileSync(path.join(proj, 'ds4/download_model.sh'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(vendored)}\n`, {mode: 0o755});
  const cliOut = path.join(proj, 'ds4/gguf');
  const cli = (target, extra = {}) => {
    const p = payload(releases.find(r => r.target === target)?.file || target);
    const env = {...process.env, PATH: [stubs, bin, process.env.PATH].join(path.delimiter), HOME: run, HF_TOKEN: '',
      DSTUDIO_DS41_1017_TEST_MODE: '1', DSTUDIO_DS41_1017_TEST_BYTES: String(p.length), DSTUDIO_DS41_1017_TEST_SHA: hash(p), ...extra};
    delete env.DS4_GGUF_DIR;
    const r = spawnSync('sh', [path.join(proj, 'download-model.sh'), target], {encoding: 'utf8', env, timeout: 30000});
    report.cases.push({cli: target, code: r.status, stderr: r.stderr, stdout: r.stdout}); save(); return r;
  };
  for (const r of releases) {
    const n = calls().length, res = cli(r.target);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(calls().length, n + 1, `${r.target} reaches the pinned downloader`);
    const argv = calls().at(-1).a;
    assert.deepEqual(argv.slice(0, 3), ['download', r.repo, r.file]);
    assert.equal(argv[argv.indexOf('--revision') + 1], r.rev);
    // Without DS4_GGUF_DIR the CLI lands files in the project's shared ds4/gguf.
    assert.equal(fs.realpathSync(argv[argv.indexOf('--local-dir') + 1]), fs.realpathSync(cliOut));
    assert(fs.existsSync(path.join(cliOut, r.file)));
  }
  assert(!fs.existsSync(vendored), 'the 1017 targets never reach the vendored downloader');
  // The original-checkpoint targets still go to the vendored ds4 downloader.
  for (const t of ['ds41f-q4', 'ds41f-vision']) {
    const n = calls().length, res = cli(t);
    assert.equal(res.status, 0, res.stderr); assert.equal(calls().length, n);
  }
  assert.deepEqual(fs.readFileSync(vendored, 'utf8').trim().split('\n'), ['ds41f-q4', 'ds41f-vision']);
  // Help lists the targets with their checkpoints.
  const help = spawnSync('sh', [path.join(proj, 'download-model.sh'), '--help'], {encoding: 'utf8'});
  assert.equal(help.status, 0);
  assert.match(help.stdout, /ds41f-q2, ds41f-1017-vision\s+-> DeepSeek V4.1 Flash 1017/);
  assert.match(help.stdout, /ds41f-q4, ds41f-vision\s+-> DeepSeek V4.1 Flash original checkpoint/);
  assert.doesNotMatch(help.stdout, /ds41f-1017-q2/);
  report.passed = true; console.log('PASS: 1017 downloader (executed): pins per target, verifies size+sha, deletes only its own failed downloads, token via env, idempotent; root CLI routes ds41f-q2/ds41f-1017-vision to it and Q4/original vision to the vendored downloader');
} catch (e) { report.error = e.stack; console.error(e); process.exitCode = 1; }
finally { save(); console.log(run); }
