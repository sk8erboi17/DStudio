// Executes scripts/download-ds41-1017.sh and the repo-root download-model.sh
// routing with a fake `hf` and tiny hashed payloads. Transport is simulated; no
// model weights. Production size/sha stay hard-coded: only the explicit
// DSTUDIO_DS41_1017_TEST_* switch scales the oracle to the fixture.
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
const REPO = 'nazeshinjite/DeepSeek-V4.1-Flash-1017-ds4-GGUF', REV = '796f58533a0e4b7a89cb006b22aeb44e783f0323';
const releases = [
  {target: 'ds41f-1017-q2', file: 'DeepSeek-V4.1-Flash-1017-Q2.gguf', bytes: 365713686528, sha: 'f57e6c3e5e68c513249e1c472a2600bf59792ca78cacb7ac0531a6056376856e'},
  {target: 'ds41f-1017-vision', file: 'DeepSeek-V4.1-Flash-1017-Vision.gguf', bytes: 970555552, sha: '861f1097e8686111fa23dc4a6bf139fd0c4cc114db2f1b4090a267f7683c0dbf'},
];
const payload = file => Buffer.from(`independently hashed fixture: ${file}\n`);
// The production constants in the script must equal the pinned artifacts.
const src = fs.readFileSync(script, 'utf8');
for (const r of releases) { assert(src.includes(r.sha), r.sha); assert(src.includes(String(r.bytes)), String(r.bytes)); }
assert(src.includes(REPO) && src.includes(REV));
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
  for (const r of releases) {
    const file = path.join(out, r.file), stamp = file + '.verified';
    download(r, true);
    const [argv] = calls().slice(-1).map(c => c.a);
    assert.deepEqual(argv.slice(0, 3), ['download', REPO, r.file]);
    assert.equal(argv[argv.indexOf('--revision') + 1], REV);
    assert.equal(argv[argv.indexOf('--max-workers') + 1], '1');
    assert.equal(argv[argv.indexOf('--repo-type') + 1], 'model');
    assert.equal(fs.realpathSync(argv[argv.indexOf('--local-dir') + 1]), fs.realpathSync(out));
    assert.deepEqual(fs.readFileSync(file), payload(r.file)); assert(fs.existsSync(stamp));
    // Idempotent: verified + stamped => no transport, no re-hash needed.
    const n = calls().length; download(r, true); assert.equal(calls().length, n);
    // Stamp is not trusted when the file changes underneath it (same size, new mtime).
    fs.writeFileSync(file, Buffer.alloc(payload(r.file).length, 120));
    const later = new Date(Date.now() + 5000); fs.utimesSync(file, later, later); // a real rewrite moves mtime past the stamp's second
    let res = download(r, false); assert.match(res.stderr, /Checksum mismatch/);
    assert(!fs.existsSync(file), 'corrupt file moved aside, not accepted'); assert(!fs.existsSync(stamp));
    assert(fs.readdirSync(out).some(f => f.startsWith(r.file + '.rejected.')));
    for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f)); // test-owned fixtures only
    // Wrong size on disk.
    fs.writeFileSync(file, 'short');
    res = download(r, false); assert.match(res.stderr, /Incorrect file size/); assert(!fs.existsSync(file));
    for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
    // Transport failure leaves nothing accepted.
    res = download(r, false, {DSTUDIO_TEST_HF_FAIL: '1'}); assert(!fs.existsSync(file));
    // Download that produces bad bytes is rejected.
    res = download(r, false, {DSTUDIO_TEST_HF_BODY: 'x'.repeat(payload(r.file).length)});
    assert.match(res.stderr, /Checksum mismatch/); assert(!fs.existsSync(file));
    for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
  }
  // Token handling: explicit --token and HF_TOKEN reach hf; none leaks otherwise.
  const q2 = releases[0];
  download(q2, true, {}, {args: ['--token', 'tok-arg']});
  assert.equal(calls().at(-1).a[calls().at(-1).a.indexOf('--token') + 1], 'tok-arg');
  for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
  download(q2, true, {HF_TOKEN: 'tok-env'});
  assert.equal(calls().at(-1).a[calls().at(-1).a.indexOf('--token') + 1], 'tok-env');
  for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
  // Production oracle: without the test switch the fixture cannot pass.
  const res = download(q2, false, {}, {test: false});
  assert.match(res.stderr, /Incorrect file size/); assert(!fs.existsSync(path.join(out, q2.file)));
  for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
  // Unknown target and missing hf.
  const bad = spawnSync('sh', [script, 'ds41f-q2'], {cwd: run, encoding: 'utf8'}); assert.notEqual(bad.status, 0);
  const nohf = spawnSync('sh', [script, q2.target], {cwd: path.join(run, 'ds4'), encoding: 'utf8',
    env: {PATH: '/usr/bin:/bin', HOME: run, DS4_GGUF_DIR: out}});
  if (!spawnSync('sh', ['-c', 'command -v hf']).stdout.toString().trim()) assert.notEqual(nohf.status, 0);
  // Root CLI routes the new targets to this downloader (and lists them).
  const cli = fs.readFileSync(path.join(root, 'download-model.sh'), 'utf8');
  assert(cli.includes('ds41f-1017-*)') && cli.includes('scripts/download-ds41-1017.sh') && cli.includes('ds41f-1017-q2, ds41f-1017-vision'));
  assert(cli.indexOf('ds41f-1017-*)') < cli.indexOf('exec sh ./download_model.sh'));
  report.passed = true; console.log('PASS: 1017 downloader pins repo/revision, verifies size+sha, rejects corrupt/short files, idempotent, tokens, CLI routing');
} catch (e) { report.error = e.stack; console.error(e); process.exitCode = 1; }
finally { save(); console.log(run); }
