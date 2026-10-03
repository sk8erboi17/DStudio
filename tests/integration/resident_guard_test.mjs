// The production --resident-guard (src/dstudio_resident.c) with real processes
// and a stand-in llama-server script: it starts the admitted executable only,
// stops it when its owner channel closes (Stop or host death), escalates to
// SIGKILL for a server that ignores SIGTERM, and refuses a changed executable
// or an installation in progress. The MLX kind (<root>/mlx/venv/bin/python3)
// uses the same guard with its own installation lease. No model, llama.cpp
// build or MLX runtime is involved.
//   node tests/integration/resident_guard_test.mjs [tests/.build/dstudio-server-test]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-guard-'));
const install = path.join(root, 'llama.cpp');
const server = path.join(install, 'bin', 'llama-server');
fs.mkdirSync(path.dirname(server), { recursive: true });
const mlxInstall = path.join(root, 'mlx');
const mlxServer = path.join(mlxInstall, 'venv', 'bin', 'python3');
fs.mkdirSync(path.dirname(mlxServer), { recursive: true });
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function writeServer(ignoreTerm, file = server) {
  fs.writeFileSync(file, `#!/bin/sh
echo "$$" > "${root}/server.pid"
${ignoreTerm ? "trap '' TERM" : `trap 'echo term > "${root}/server.term"; exit 0' TERM`}
while :; do sleep 0.05; done
`, { mode: 0o755 });
  fs.rmSync(path.join(root, 'server.pid'), { force: true });
  fs.rmSync(path.join(root, 'server.term'), { force: true });
}
// Same format as launch_identity(): dev:ino:size:mtime:mtime_ns:ctime:ctime_ns.
function identity(file) {
  const s = fs.statSync(file, { bigint: true });
  const sec = (ns) => ns / 1000000000n, frac = (ns) => ns % 1000000000n;
  return [s.dev, s.ino, s.size, sec(s.mtimeNs), frac(s.mtimeNs), sec(s.ctimeNs), frac(s.ctimeNs)].join(':');
}
function guard(id = identity(server), dir = install, exe = server) {
  // detached: a fresh session, so the guard is its group's leader as in the host.
  const child = spawn(binary, ['--resident-guard', dir, id, exe, '--model', 'x.gguf'],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: true });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, err })));
  return { child, exited };
}
async function serverPid() {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(path.join(root, 'server.pid'))) return Number(fs.readFileSync(path.join(root, 'server.pid'), 'utf8'));
    await sleep(50);
  }
  throw new Error('the guard did not start the server');
}
function holdLease(name) {
  const holder = spawn('python3', ['-c', `import fcntl,os,time
fd=os.open(${JSON.stringify(path.join(root, name))}, os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX); print('held', flush=True); time.sleep(30)`], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((r) => holder.stdout.once('data', () => r(holder)));
}
async function check(name, fn) {
  const row = { name };
  try { await fn(row); row.status = 'PASS'; } catch (error) { row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1; }
  results.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
}

try {
  await check('closing the owner channel stops the server and the guard', async (row) => {
    writeServer(false);
    const g = guard();
    const pid = await serverPid();
    assert.ok(alive(pid));
    const t0 = Date.now();
    g.child.stdio[3].destroy();               // the host closed its end, or died
    const done = await g.exited;
    row.ms = Date.now() - t0;
    assert.ok(fs.existsSync(path.join(root, 'server.term')), 'the server received SIGTERM');
    assert.equal(alive(pid), false);
    assert.equal(done.code, 0, `guard exit: ${JSON.stringify(done)}`);
    assert.ok(row.ms < 3000, `stopped in ${row.ms} ms`);
  });

  await check('a server ignoring SIGTERM is killed after the 4 s grace', async (row) => {
    writeServer(true);
    const g = guard();
    const pid = await serverPid();
    const t0 = Date.now();
    g.child.stdio[3].destroy();
    const done = await g.exited;
    row.ms = Date.now() - t0;
    assert.equal(alive(pid), false, 'no server outlives its guard');
    assert.ok(row.ms >= 3500 && row.ms < 8000, `escalated after ${row.ms} ms`);
    assert.equal(done.code, 128 + 9, 'the guard reports the SIGKILL');
  });

  await check('a changed executable is refused before exec', async () => {
    writeServer(false);
    const stale = identity(server);
    fs.appendFileSync(server, '# edited\n');
    const done = await guard(stale).exited;
    assert.equal(done.code, 126);
    assert.match(done.err, /installation or executable changed/);
    assert.equal(fs.existsSync(path.join(root, 'server.pid')), false, 'never executed');
  });

  await check('an installation in progress is refused, not waited for', async () => {
    writeServer(false);
    const holder = spawn('python3', ['-c', `import fcntl,os,time
fd=os.open(${JSON.stringify(path.join(root, '.dstudio-llama-install.lock'))}, os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX); print('held', flush=True); time.sleep(30)`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => holder.stdout.once('data', r));
    try {
      const t0 = Date.now();
      const done = await guard().exited;
      assert.equal(done.code, 125);
      assert.match(done.err, /being installed/);
      assert.ok(Date.now() - t0 < 2000);
    } finally { holder.kill('SIGKILL'); }
  });

  await check('MLX: the guard starts only <root>/mlx/venv/bin/python3 and stops it with its owner', async (row) => {
    writeServer(false, mlxServer);
    assert.equal((await guard(identity(mlxServer), mlxInstall, server).exited).code, 2, 'another kind\'s executable is refused');
    const g = guard(identity(mlxServer), mlxInstall, mlxServer);
    const pid = await serverPid();
    const t0 = Date.now();
    g.child.stdio[3].destroy();
    const done = await g.exited;
    row.ms = Date.now() - t0;
    assert.ok(fs.existsSync(path.join(root, 'server.term')));
    assert.equal(alive(pid), false);
    assert.equal(done.code, 0, `guard exit: ${JSON.stringify(done)}`);
  });

  await check('MLX has its own installation lease: its installer blocks it, llama.cpp\'s does not', async () => {
    writeServer(false, mlxServer);
    let holder = await holdLease('.dstudio-mlx-install.lock');
    try {
      const done = await guard(identity(mlxServer), mlxInstall, mlxServer).exited;
      assert.equal(done.code, 125); assert.match(done.err, /being installed/);
      assert.equal(fs.existsSync(path.join(root, 'server.pid')), false, 'never executed');
    } finally { holder.kill('SIGKILL'); }
    holder = await holdLease('.dstudio-llama-install.lock');
    try {
      const g = guard(identity(mlxServer), mlxInstall, mlxServer);
      await serverPid();
      g.child.stdio[3].destroy();
      assert.equal((await g.exited).code, 0);
    } finally { holder.kill('SIGKILL'); }
  });

  await check('an install directory of any other name is refused', async () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(other, 'bin'), { recursive: true });
    fs.copyFileSync(server, path.join(other, 'bin', 'llama-server'));
    const done = await guard(identity(path.join(other, 'bin', 'llama-server')), other, path.join(other, 'bin', 'llama-server')).exited;
    assert.equal(done.code, 2);
  });

  await check('the guard only runs as a process-group leader', async () => {
    const r = spawnSync(binary, ['--resident-guard', install, identity(server), server], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    assert.equal(r.status, 2, 'a guard sharing its parent group cannot own the server group');
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
const passed = results.filter((r) => r.status === 'PASS').length;
console.log(`resident_guard_test: ${passed}/${results.length} passed (real processes, stand-in server; no model)`);
