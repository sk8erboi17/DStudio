// Real native builder and subprocess/file ownership. The compiler below is an
// explicit fixture; actual engine builds/tool behavior are a separate gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { artifactRunDir, sleep, writeArtifact } from '../support/real_harness.mjs';

const probe = path.resolve(process.argv[2] || 'tests/.build/agent-build-probe');
const run = artifactRunDir('agent-build');
const assets = path.join(run, 'assets with spaces');
const expectedVersion = JSON.parse(fs.readFileSync('patch/ds4-agent-jsonl/bases.json')).currentManifestVersion;
const engine = path.join(run, 'engine with spaces');
const tools = path.join(run, 'tools');
for (const p of [assets, engine, tools]) fs.mkdirSync(p);
fs.cpSync('patch', path.join(assets, 'patch'), { recursive: true });
for (const p of ['extension/remote', 'extension/cowork', 'scripts'])
  fs.mkdirSync(path.join(assets, p), { recursive: true });
for (const script of ['apply-ds4-glm53-m2max.sh', 'apply-ds4-vision-streaming.sh'])
  fs.writeFileSync(path.join(assets, 'scripts', script), '#!/bin/sh\nexit 0\n');
for (const file of ['ds4_agent.c', 'ds4_web.c']) fs.copyFileSync(path.join('ds4', file), path.join(engine, file));
for (const file of ['ds4.c', 'ds4.h', 'Makefile']) fs.writeFileSync(path.join(engine, file), '// builder fixture\n');
for (const file of ['ds4-agent-jsonl', 'ds4-cowork'])
  fs.writeFileSync(path.join(engine, file), '#!/bin/sh\nprintf "old-runtime\\n"\n', { mode: 0o755 });
const sourceNames = ['ds4_agent.c', 'ds4_web.c', 'ds4.c', 'ds4.h', 'Makefile'];
const original = new Map(sourceNames.map(name => [name, fs.readFileSync(path.join(engine, name))]));
const identities = new Map(sourceNames.map(name => {
  const st = fs.statSync(path.join(engine, name), { bigint: true });
  return [name, [st.dev, st.ino, st.mtimeNs, st.ctimeNs].map(String).join(':')];
}));
const binaries = () => new Map(['ds4-agent-jsonl', 'ds4-cowork'].map(name => [name, fs.readFileSync(path.join(engine, name))]));
const assertBytes = snapshot => { for (const [name, bytes] of snapshot) assert.deepEqual(fs.readFileSync(path.join(engine, name)), bytes, name); };
const sourceBytes = () => assertBytes(original);
const stamp = path.join(engine, 'ds4-agent-jsonl.ver');
const stale = () => { if (fs.existsSync(stamp)) fs.unlinkSync(stamp); };
const count = () => fs.existsSync(path.join(engine, 'build-count')) ? fs.readFileSync(path.join(engine, 'build-count'), 'utf8').length : 0;
const env = extra => ({ ...process.env, PATH: `${tools}:${process.env.PATH}`, ...extra });
fs.writeFileSync(path.join(tools, 'make'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
fs.readFileSync(0, 'utf8');
fs.appendFileSync('build-count', '1');
const target = process.argv[4];
const arg = process.argv.find(a => a.startsWith('JSONL_OUT='));
const out = arg ? arg.slice('JSONL_OUT='.length) : '.';
fs.writeFileSync(path.join(out, 'ds4-agent-jsonl'), 'partial linker output', { mode: 0o755 });
if (process.env.BUILD_GATE) {
  fs.writeFileSync(process.env.BUILD_GATE + '.entered', JSON.stringify({ pid: process.pid, out, target }));
  fs.readFileSync(process.env.BUILD_GATE, 'utf8');
}
if (process.env.BUILD_FAIL) process.exit(7);
fs.writeFileSync(path.join(out, 'ds4-agent-jsonl'), '#!/bin/sh\\nprintf "new-runtime\\\\n"\\n', { mode: 0o755 });
if (!process.env.BUILD_MISSING_COWORK)
  fs.copyFileSync(path.join(out, 'ds4-agent-jsonl'), path.join(out, 'ds4-cowork'));
`, { mode: 0o755 });

const report = { schema: 'dstudio.agent-build.v1', started: new Date().toISOString(),
  scope: 'Production C builder; simulated compiler, actual processes/files. No weights or inference.',
  probeSHA256: crypto.createHash('sha256').update(fs.readFileSync(probe)).digest('hex'), cases: [] };
function invoke(extra = {}, action = 'build') {
  const r = spawnSync(probe, [assets, engine, action], { encoding: 'utf8', timeout: 15000, env: env(extra) });
  fs.appendFileSync(path.join(run, 'builds.log'), `\n${JSON.stringify({ extra, action, status: r.status, signal: r.signal })}\n${r.stdout}${r.stderr}`);
  return r;
}
function pass(r) { assert.equal(r.status, 0, r.error?.message || r.stderr + r.stdout); }
async function test(name, fn) {
  const row = { name };
  try { await fn(row); row.status = 'PASS'; }
  catch (e) { row.status = 'FAIL'; row.error = e.stack; }
  report.cases.push(row); console.log(`${name}: ${row.status}${row.error ? ': ' + row.error : ''}`);
  writeArtifact(run, 'progress.json', report);
}
const jobs = new Set();
async function until(fn, message) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw Error(message);
}
let sequence = 0;
async function blocked() {
  stale();
  const gate = path.join(run, `gate-${++sequence}`);
  assert.equal(spawnSync('mkfifo', [gate]).status, 0);
  const log = fs.openSync(path.join(run, `held-${sequence}.log`), 'wx');
  const child = spawn(probe, [assets, engine, 'build'], {
    detached: true, env: env({ BUILD_GATE: gate }), stdio: ['ignore', log, log],
  });
  fs.closeSync(log); jobs.add(child.pid);
  const exit = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  await until(() => fs.existsSync(gate + '.entered'), 'compiler did not reach the explicit FIFO barrier');
  const marker = JSON.parse(fs.readFileSync(gate + '.entered', 'utf8'));
  let released = false;
  return { child, exit, marker,
    release() {
      if (released) return;
      const fd = fs.openSync(gate, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      fs.writeSync(fd, 'release\n'); fs.closeSync(fd); released = true;
    },
    killGroup() { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } },
  };
}

try {
  await test('successful build leaves upstream bytes, identity and timestamps untouched', () => {
    pass(invoke()); sourceBytes();
    for (const name of sourceNames) {
      const st = fs.statSync(path.join(engine, name), { bigint: true });
      assert.equal([st.dev, st.ino, st.mtimeNs, st.ctimeNs].map(String).join(':'), identities.get(name), name);
    }
    for (const file of ['ds4-agent-jsonl', 'ds4-cowork']) {
      const r = spawnSync(path.join(engine, file), [], { encoding: 'utf8' });
      assert.equal(r.status, 0); assert.equal(r.stdout, 'new-runtime\n');
    }
    assert.equal(Number(fs.readFileSync(stamp, 'utf8')), expectedVersion);
    assert.ok(!fs.existsSync(path.join(engine, 'ds4_agent.c.ds4ui.bak')));
  });
  await test('unchanged repeat uses the completed build without another compiler invocation', () => {
    const n = count(); pass(invoke()); assert.equal(count(), n); sourceBytes();
  });
  await test('failed and incomplete links preserve both previously working runtimes', () => {
    const before = binaries();
    for (const extra of [{ BUILD_FAIL: '1' }, { BUILD_MISSING_COWORK: '1' }]) {
      stale(); const r = invoke(extra); assert.equal(r.status, 1, r.stdout + r.stderr);
      sourceBytes(); assertBytes(before); assert.ok(!fs.existsSync(stamp));
    }
  });
  await test('an upstream edit during compilation prevents publication and is preserved', async row => {
    const before = binaries(), held = await blocked(); row.compiler = held.marker;
    try {
      sourceBytes(); assertBytes(before);
      fs.appendFileSync(path.join(engine, 'ds4_agent.c'), '\n/* user edit during compilation */\n');
      const edited = fs.readFileSync(path.join(engine, 'ds4_agent.c'));
      held.release(); assert.equal((await held.exit).code, 1);
      assert.deepEqual(fs.readFileSync(path.join(engine, 'ds4_agent.c')), edited);
      assertBytes(before); assert.ok(!fs.existsSync(stamp));
    } finally { held.killGroup(); fs.writeFileSync(path.join(engine, 'ds4_agent.c'), original.get('ds4_agent.c')); }
  });
  await test('killing the entire build group cannot patch upstream or replace an executable', async row => {
    const before = binaries(), held = await blocked(); row.compiler = held.marker;
    try {
      sourceBytes(); assertBytes(before);
      held.killGroup(); assert.equal((await held.exit).signal, 'SIGKILL');
      sourceBytes(); assertBytes(before); assert.ok(!fs.existsSync(stamp));
      await until(() => { const r = invoke(); return r.status === 0; }, 'new build could not recover after group death');
      sourceBytes();
    } finally { held.killGroup(); }
  });
  await test('compiler retains its build lease after parent death; competing build cannot interfere', async row => {
    const before = binaries(), held = await blocked(); row.compiler = held.marker;
    try {
      process.kill(held.child.pid, 'SIGKILL'); assert.equal((await held.exit).signal, 'SIGKILL');
      process.kill(held.marker.pid, 0); // the original compiler, not a stale lock-file assumption
      const n = count(), competing = invoke();
      assert.equal(competing.status, 1); assert.match(competing.stderr, /build is busy/);
      assert.equal(count(), n); sourceBytes(); assertBytes(before);
      const server = invoke({}, 'server');
      assert.equal(server.status, 1); assert.match(server.stderr, /build is busy/);
      assert.equal(count(), n); sourceBytes(); assertBytes(before);
      held.release();
      await until(() => invoke().status === 0, 'lease was not released after the compiler exited');
      sourceBytes();
    } finally { held.killGroup(); }
  });
  await test('symlinked build lock is rejected without changing its target', () => {
    const lock = path.join(engine, '.ds4ui-native-build.lock');
    fs.unlinkSync(lock);
    const target = path.join(run, 'unrelated-lock-target'); fs.writeFileSync(target, 'preserve me');
    fs.symlinkSync(target, lock);
    try { assert.equal(invoke().status, 1); assert.equal(fs.readFileSync(target, 'utf8'), 'preserve me'); }
    finally { fs.unlinkSync(lock); }
  });
  await test('legacy crash marker cannot authorize overwriting source from an unverified backup', () => {
    const src = path.join(engine, 'ds4_agent.c'), backup = path.join(engine, 'ds4_agent.c.ds4ui.bak');
    fs.writeFileSync(src, '/*DS4UI_JSONL*/\ncontributor changes\n');
    fs.writeFileSync(backup, 'unverified historical backup\n');
    try {
      const r = invoke({}, 'restore'); assert.equal(r.status, 1);
      assert.equal(fs.readFileSync(src, 'utf8'), '/*DS4UI_JSONL*/\ncontributor changes\n');
      assert.equal(fs.readFileSync(backup, 'utf8'), 'unverified historical backup\n');
    } finally { fs.writeFileSync(src, original.get('ds4_agent.c')); }
  });
} finally {
  // Signal only process groups started by this test. Preserve all receipts,
  // staged linker outputs and original failed cases for inspection.
  for (const pid of jobs) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  report.status = report.cases.length === 8 && report.cases.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL';
  report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report);
  console.log(`Preserved Agent build evidence: ${run}`);
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
