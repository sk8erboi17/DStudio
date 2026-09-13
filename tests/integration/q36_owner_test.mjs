// Native owner socket / process-lifetime tests. Engine state is a fixture;
// actual-model readiness and answers belong to the separately labeled live run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

if (process.argv[2] === '--guardian') {
  const [, , , exe, model, phase] = process.argv;
  const child = spawn(exe, [phase === 'loading' ? 'blocked' : 'normal', model],
    {stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']});
  let output = '';
  child.stderr.resume(); child.stdio[3].resume();
  child.stdout.on('data', bytes => {
    output += bytes;
    if (output.length > 4096) process.exit(2);
    if (phase === 'loading' && output.includes('preparing\n') ||
        phase === 'ready' && output.includes('ready\n')) {
      process.stdout.write(JSON.stringify({pid: child.pid, phase}) + '\n');
      output = '';
    } else if (phase === 'ready' && output.includes('preparing\n')) child.stdio[4].write('G');
  });
  child.on('exit', () => process.exit(3));
  await new Promise(() => {});
} else {
  const root = path.resolve(import.meta.dirname, '../..'), run = artifactRunDir('q36-owner');
  const report = {started: new Date().toISOString(), status: 'fail',
    scope: 'Native control and file identity, real sockets/processes; fixture engine, no model quality',
    cases: [], commands: []};
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const save = () => writeArtifact(run, 'results.json', report);
  const identity = file => {
    const s = typeof file === 'number' ? fs.fstatSync(file, {bigint: true}) : fs.statSync(file, {bigint: true});
    return [s.dev, s.ino, s.size, s.mtimeNs / 1000000000n, s.mtimeNs % 1000000000n,
      s.ctimeNs / 1000000000n, s.ctimeNs % 1000000000n].join(':');
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const children = new Set();
  async function until(predicate, message, ms = 2000) {
    const deadline = performance.now() + ms;
    while (!predicate() && performance.now() < deadline) await delay(10);
    assert(predicate(), message);
  }
  function start(exe, args, extra = {}) {
    const child = spawn(exe, args, {stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], ...extra});
    children.add(child);
    const r = {stdout: '', stderr: '', wire: '', exit: null, error: '', child};
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr'],
      [child.stdio[3], 'wire']]) {
      stream?.on('data', bytes => {
        r[key] += bytes;
        if (r[key].length > 65536) {r.error = `${key} limit`; child.kill('SIGKILL');}
      });
    }
    const timer = setTimeout(() => {r.error = '6-second process deadline'; child.kill('SIGKILL');}, 6000);
    r.done = new Promise(resolve => {
      child.on('error', error => {r.error = String(error);});
      child.on('close', (code, signal) => {
        clearTimeout(timer); children.delete(child); r.exit = {code, signal}; resolve(r);
      });
    });
    return r;
  }
  async function checked(name, fn) {
    const started = performance.now(), row = {name, status: 'fail'};
    report.cases.push(row); save();
    try {await fn(row); row.status = 'pass'; console.log(`PASS: ${name}`);}
    catch (e) {row.error = String(e.stack || e); throw e;}
    finally {row.ms = performance.now() - started; save();}
  }
  async function exit(r, code) {
    await r.done;
    assert.equal(r.error, '', r.error); assert.equal(r.exit.signal, null, r.stderr);
    assert.equal(r.exit.code, code, r.stderr); return r;
  }
  const gate = async r => {
    await until(() => r.stdout.includes('preparing\n') || r.exit, 'preparation barrier unavailable');
    assert(!r.exit, r.stderr); assert.equal(r.wire, '', 'readiness preceded preparation');
  };
  console.log(`Evidence: ${run}`);
  try {
    assert(process.argv.length === 3 || process.argv.length === 4 && process.argv[3] === '--server',
      'Supply prepared pinned q36 source and optional --server to require the actual built executable');
    const source = fs.realpathSync(process.argv[2]);
    const probes = ['q36_owner_core_probe.c', 'q36_owner_probe.c'].map(n => path.join(root, 'tests/support', n))
      .concat(path.join(source, 'q36_ssd.c'));
    const inputs = ['q36.c', 'q36.h', 'q36_server.c'].map(n => path.join(source, n))
      .concat(probes, import.meta.filename);
    const server = path.join(source, 'q36-server');
    if (process.argv[3] === '--server') inputs.push(server);
    report.inputs = Object.fromEntries(inputs.map(file => [file, hash(file)]));
    const model = path.join(run, 'model bytes'), vision = path.join(run, 'vision bytes'), mtp = path.join(run, 'mtp bytes');
    for (const file of [model, vision, mtp]) fs.writeFileSync(file, 'owned non-weight fixture: ' + path.basename(file));
    for (const sanitize of [false, true]) {
      const exe = path.join(run, sanitize ? 'owner-asan' : 'owner');
      const args = ['-std=c11', '-O1', '-g', '-ffunction-sections', '-fdata-sections', '-I', source,
        ...probes, '-lm', '-pthread', '-o', exe, process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
      if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
      if (sanitize) args.unshift('-fsanitize=address,undefined', '-fno-sanitize-recover=all', '-fno-omit-frame-pointer');
      const build = spawnSync('cc', args, {encoding: 'utf8', timeout: 60000, maxBuffer: 2 ** 21});
      report.commands.push({binary: 'cc', args, status: build.status, stdout: build.stdout, stderr: build.stderr}); save();
      assert.equal(build.status, 0, String(build.error || '') + build.stderr);
      report[`${sanitize ? 'sanitized' : 'normal'}BinarySHA256`] = hash(exe);
      const tag = sanitize ? 'ASan/UBSan' : 'normal';
      for (const [name, args, expected, value] of [
        ['default CLI unchanged', ['parse'], 0, '-1\n'],
        ['explicit channel', ['parse', '--dstudio-owner-fd', '3'], 0, '3\n'],
        ['duplicate channel', ['parse', '--dstudio-owner-fd', '3', '--dstudio-owner-fd', '4'], 2],
        ['negative channel', ['parse', '--dstudio-owner-fd', '-3'], 2],
        ['missing channel value', ['parse', '--dstudio-owner-fd'], 2],
        ['disabled supervision', ['disabled'], 0], ['stdio rejected', ['stdio'], 2],
        ['channel closes across exec', ['flags'], 0],
        ['bad model FD preserves output', ['bad-identity', path.join(run, 'absent')], 0],
        ['directory is not a model', ['bad-identity', run], 0],
        ['bad projector preserves output', ['bad-identity', model, run], 0],
        ['bad MTP preserves output', ['bad-identity', model, vision, run], 0],
      ]) await checked(`${tag}: ${name}`, async row => {
        const r = await exit(start(exe, args), expected);
        row.stdout = r.stdout; row.stderr = r.stderr;
        if (value !== undefined) assert.equal(r.stdout, value);
        assert.equal(r.wire, '');
      });
      for (const file of [model, '/dev/null']) await checked(`${tag}: non-socket channel ${path.basename(file)}`, async () => {
        const fd = fs.openSync(file, 'r');
        try {await exit(start(exe, ['invalid'], {stdio: ['ignore', 'pipe', 'pipe', fd, 'pipe']}), 2);}
        finally {fs.closeSync(fd);}
      });
      for (const sidecars of [false, true]) await checked(`${tag}: readiness after barrier, ${sidecars ? 'sidecars' : 'text only'}`, async row => {
        const r = start(exe, ['normal', model, ...(sidecars ? [vision, mtp] : [])]);
        await gate(r); r.child.stdio[4].write('G');
        await until(() => r.wire.endsWith('\n') || r.exit, 'no complete private readiness');
        const data = JSON.parse(r.wire); row.receipt = data;
        assert.equal(data.version, 1); assert.equal(data.event, 'ready'); assert.equal(data.pid, r.child.pid);
        assert.equal(data.model, 'qwen3.8-27b'); assert.equal(data.backend, 'cpu'); assert.equal(data.context, 8192);
        assert.equal(data.host, '127.0.0.1'); assert(data.port > 0 && data.port <= 65535);
        assert.equal(data.cache_k, 'f16'); assert.equal(data.cache_v, 'q8_0'); assert.equal(data.ssd_streaming, false);
        assert.equal(data.model_file, identity(model));
        assert.equal(data.vision_file, sidecars ? identity(vision) : '');
        assert.equal(data.mtp_file, sidecars ? identity(mtp) : '');
        r.child.stdio[3].destroy(); await exit(r, 0);
      });
      await checked(`${tag}: opened file identity survives path replacement`, async () => {
        const r = start(exe, ['normal', model]); await gate(r);
        const old = path.join(run, `old-model-${tag.replaceAll('/', '-')}`);
        fs.renameSync(model, old); fs.writeFileSync(model, 'new path is not the loaded model');
        r.child.stdio[4].write('G');
        await until(() => r.wire.endsWith('\n') || r.exit, 'no identity receipt');
        const data = JSON.parse(r.wire);
        assert.equal(data.model_file, identity(old)); assert.notEqual(data.model_file, identity(model));
        r.child.stdio[3].destroy(); await exit(r, 0);
      });
      for (const mode of ['cancelled', 'bad-listener']) await checked(`${tag}: ${mode} cannot publish ready`, async () => {
        const r = start(exe, [mode, model]); await gate(r); r.child.stdio[4].write('G');
        await exit(r, 0); assert.equal(r.wire, '');
      });
      await checked(`${tag}: unresponsive reader cannot block readiness`, async () => {
        const r = start(exe, ['saturated', model]);
        await gate(r); r.child.stdio[4].write('G'); await exit(r, 0);
      });
      await checked(`${tag}: owner EOF bounds an uninterruptible preparation`, async row => {
        const r = start(exe, ['blocked', model]); await gate(r);
        const started = performance.now(); r.child.stdio[3].destroy(); await exit(r, 130);
        row.stopMs = performance.now() - started; assert(row.stopMs < 4500); assert.equal(r.wire, '');
      });
      await checked(`${tag}: unexpected owner command stops only its engine`, async () => {
        const r = start(exe, ['normal', model]); await gate(r); r.child.stdio[4].write('G');
        await until(() => r.wire.endsWith('\n'), 'no ready');
        r.child.stdio[3].write('not-a-command'); await exit(r, 0);
      });
      for (const phase of ['loading', 'ready']) await checked(`${tag}: parent SIGKILL during ${phase} leaves no running engine`, async row => {
        const r = start(process.execPath, [import.meta.filename, '--guardian', exe, model, phase]);
        await until(() => r.stdout.includes('\n') || r.exit, 'guardian did not publish owned PID');
        const {pid} = JSON.parse(r.stdout.trim()); assert(Number.isSafeInteger(pid) && pid > 1);
        row.pid = pid; const started = performance.now(); r.child.kill('SIGKILL'); await r.done;
        const live = () => {
          const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {encoding: 'utf8', timeout: 1000});
          if (state.error) throw state.error;
          return state.status === 0 && !state.stdout.trim().startsWith('Z');
        };
        try {await until(() => !live(), 'owned engine still running after parent death', 4500);}
        finally {
          if (live()) {
            const actual = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {encoding: 'utf8', timeout: 1000});
            if (actual.status === 0 && actual.stdout.trim().startsWith(exe + ' ')) process.kill(pid, 'SIGKILL');
          }
        }
        row.stopMs = performance.now() - started;
      });
    }
    if (process.argv[3] === '--server') {
      const missing = path.join(run, 'no-model-was-downloaded');
      for (const fd of ['1', '99']) await checked(`actual server: invalid FD ${fd} rejected before loading`, async row => {
        const r = await exit(start(server, ['--cpu', '--model', missing, '--dstudio-owner-fd', fd]), 2);
        assert.equal(r.wire, ''); row.stderr = r.stderr;
      });
      await checked('actual server: failed model load cannot emit ready', async row => {
        const r = await exit(start(server, ['--cpu', '--model', missing, '--dstudio-owner-fd', '3']), 1);
        assert.equal(r.wire, ''); row.stderr = r.stderr;
      });
      await checked('actual server: standalone help retains default behavior', async () => {
        const r = await exit(start(server, ['--help']), 0); assert.equal(r.wire, '');
      });
    }
    for (const [file, expected] of Object.entries(report.inputs)) assert.equal(hash(file), expected, `Input changed: ${file}`);
    report.status = 'pass';
  } catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
  finally {
    for (const child of children) child.kill('SIGKILL');
    report.finished = new Date().toISOString(); save();
  }
}
