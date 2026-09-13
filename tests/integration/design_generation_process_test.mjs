// Real subprocesses/files and simulated native protocol, never LLM quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runDesignGeneration} from '../support/design_generation_process.mjs';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const peer = path.join(root, 'tests/fixtures/design_generation_peer.mjs');
const run = artifactRunDir('design-generation-process');
const rows = [];
const prompt = 'Build café 🌿.\nKeep this second line intact.';
const pack = '---\nname: Folio\n---\nFixture café 🌿 — entire pack.\n';
const save = () => writeArtifact(run, 'results.json', {scope: 'Simulated native Design protocol; actual process/log handling, no model quality', rows});
function directory(id) { const p = path.join(run, id); fs.mkdirSync(p); return p; }
function gone(pid) {
  if (!pid) return;
  assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'}, `owned process ${pid} must be reaped`);
}
async function check(id, test) {
  const row = {id, status: 'running'}; rows.push(row); save();
  try { await test(row); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = error.stack; throw error; }
  finally { save(); }
}

async function cli(id, mode) {
  const dir = directory(id), engine = path.join(dir, 'engine'), packs = path.join(dir, 'extension');
  fs.mkdirSync(engine); fs.mkdirSync(path.join(packs, 'design-systems/folio'), {recursive: true});
  fs.mkdirSync(path.join(packs, 'craft'));
  fs.writeFileSync(path.join(packs, 'design-systems/folio/DESIGN.md'), pack);
  for (const name of ['ds4.c', 'ds4.h', 'ds4_metal.m']) fs.writeFileSync(path.join(engine, name), 'simulated source identity\n');
  writeArtifact(engine, '.dstudio-source.json', {repository: 'fixture-only', commit: 'simulated'});
  const model = path.join(dir, 'fixture.gguf'); fs.writeFileSync(model, 'NOT REAL WEIGHTS');
  const suite = path.join(dir, 'suite.json'); writeArtifact(dir, 'suite.json', {cases: [
    {id: 'fixture', entry: 'index.html', prompt, designSystemId: 'folio'},
  ]});
  const result = spawnSync(process.execPath, [path.join(root, 'tests/live/design_originals_comparison.mjs'),
    'simulated-protocol', peer, engine, packs, path.join(dir, 'captured'), peer], {cwd: root,
    env: {...process.env, DESIGN_COMPARE_SUITE: suite, DESIGN_COMPARE_MODEL: model,
      DESIGN_COMPARE_STARTUP_TIMEOUT_MS: '10000', DESIGN_COMPARE_TIMEOUT_MS: '10000', DESIGN_CAPTURE_FIXTURE: mode},
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
  writeArtifact(dir, 'process.json', {status: result.status, signal: result.signal, error: String(result.error || ''),
    stdout: result.stdout, stderr: result.stderr});
  return {result, report: JSON.parse(fs.readFileSync(path.join(dir, 'captured/report.json')))};
}

try {
  // Run this alone against the preceding runner to preserve a real RED receipt.
  await check('malformed-event-must-not-pass-cli', async row => {
    const {result, report} = await cli('cli-malformed', 'bad-event');
    row.receipt = report.cases[0];
    assert.equal(result.status, 1, 'Malformed native event must fail, even if a later artifact exists');
    assert.equal(report.cases[0].generationPassed, false);
  });
  if (!process.argv.includes('--baseline')) {
    for (const mode of ['success', 'backpressure', 'drain-on-term', 'exit-after-idle']) await check(mode, async row => {
      const dir = directory(mode), events = [];
      row.receipt = await runDesignGeneration({binary: process.execPath, args: [peer], cwd: dir,
        directory: dir, env: {...process.env, DESIGN_CAPTURE_WORKSPACE: dir, DESIGN_CAPTURE_FIXTURE: mode}, prompt,
        onEvent: event => events.push(event), limits: {startupMs: 10000, turnMs: 10000}});
      const r = row.receipt; assert.equal(r.status, 'idle'); assert.equal(r.cleanupComplete, true);
      assert.equal(r.promptSubmitted, true); assert.equal(r.errorCount, 0); gone(r.pid);
      assert.equal(fs.readFileSync(path.join(dir, 'received.txt'), 'utf8'), prompt + '\n');
      assert.equal(events.find(e => e.type === 'tool_result').output, pack);
      assert.equal(events.find(e => e.type === 'artifact').title, 'Fixture café 🌿');
      if (mode === 'drain-on-term') assert.equal(events.at(-1).value, 'drained café 🌿');
      if (mode === 'backpressure') {
        const lines = fs.readFileSync(path.join(dir, 'stdout.txt'), 'utf8').split('\n').filter(s => s.startsWith('prose '));
        assert.equal(lines.length, 4096);
        for (let i = 0; i < lines.length; i++) assert.equal(lines[i], `prose ${i} — café 🌿 ${'x'.repeat(500)}`);
      }
      for (const name of ['stdout', 'stderr']) {
        assert.equal(r.output[name].complete, true);
        assert.equal(fs.statSync(path.join(dir, name + '.txt')).size, r.output[name].receivedBytes);
      }
    });
    await check('native-runner-entry-and-pack-after-capture', async row => {
      const {result, report} = await cli('cli-success', 'success'); row.receipt = report.cases[0];
      assert.equal(result.status, 0); assert.equal(row.receipt.generationPassed, true);
      assert.equal(row.receipt.designSystemLoaded, true); assert.equal(row.receipt.capture.cleanupComplete, true);
    });
    const failures = [
      ['bad-event', 'stdout-protocol-error'], ['bad-utf8', 'stdout-protocol-error'],
      ['bad-on-term', 'stdout-protocol-error'],
      ['incomplete', 'stdout-incomplete-event'], ['bad-exit', 'process-exit-error'],
      ['stdout-limit', 'stdout-log-limit', {stdoutBytes: 1024}],
      ['stderr-limit', 'stderr-log-limit', {stderrBytes: 1024}],
      ['long-line', 'stdout-line-limit', {lineBytes: 128}],
      ['event-count', 'stdout-protocol-error', {events: 2}],
      ['event-bytes', 'stdout-protocol-error', {eventBytes: 96}],
      ['startup-timeout', 'startup-timeout', {startupMs: 300}],
      ['turn-timeout', 'turn-timeout', {turnMs: 300}],
      ['quoted-marker', 'turn-timeout', {turnMs: 300}],
      ['stdin-closed', 'stdin-error'],
    ];
    for (const [mode, expected, bound = {}] of failures) await check(mode, async row => {
      const dir = directory(mode);
      row.receipt = await runDesignGeneration({binary: process.execPath, args: [peer], cwd: dir,
        directory: dir, env: {...process.env, DESIGN_CAPTURE_WORKSPACE: dir, DESIGN_CAPTURE_FIXTURE: mode},
        prompt, limits: {startupMs: 10000, turnMs: 10000, ...bound}});
      const r = row.receipt; assert.equal(r.status, expected); assert.equal(r.cleanupComplete, true); gone(r.pid);
      assert.ok(r.errors.length > 0 && r.errors.length <= 8);
      for (const name of ['stdout', 'stderr']) {
        const bytes = fs.statSync(path.join(dir, name + '.txt')).size;
        assert.equal(bytes, r.output[name].persistedBytes);
        assert.ok(bytes <= r.limits[name + 'Bytes']);
      }
      if (mode.endsWith('-limit')) {
        const name = mode.startsWith('stderr') ? 'stderr' : 'stdout';
        assert.equal(r.output[name].persistedBytes, 1024);
        assert.ok(r.output[name].receivedBytes > 1024); assert.equal(r.output[name].complete, false);
      }
      if (mode === 'event-count') assert.equal(r.eventCount, 2);
      if (mode === 'event-bytes') assert.equal(r.eventCount, 0);
      if (mode === 'startup-timeout') assert.equal(fs.existsSync(path.join(dir, 'received.txt')), false);
    });
    await check('observer-failure-retained', async row => {
      const dir = directory('observer-error');
      row.receipt = await runDesignGeneration({binary: process.execPath, args: [peer], cwd: dir,
        directory: dir, env: {...process.env, DESIGN_CAPTURE_WORKSPACE: dir, DESIGN_CAPTURE_FIXTURE: 'success'},
        prompt, onEvent: () => { throw new Error('deliberate receipt observer failure'); }});
      assert.equal(row.receipt.status, 'stdout-protocol-error');
      assert.match(row.receipt.errors[0].message, /deliberate receipt observer failure/); gone(row.receipt.pid);
    });
    for (const mode of ['cancel', 'ignore-term', 'orphan-pipe']) await check(mode, async row => {
      const dir = directory(mode), controller = new AbortController();
      row.receipt = await runDesignGeneration({binary: process.execPath, args: [peer], cwd: dir,
        directory: dir, env: {...process.env, DESIGN_CAPTURE_WORKSPACE: dir, DESIGN_CAPTURE_FIXTURE: mode}, prompt,
        signal: controller.signal, onReady: () => { if (mode === 'cancel') controller.abort(); },
        limits: {startupMs: 10000, turnMs: 300, terminateMs: 300, cleanupMs: 3000}});
      assert.equal(row.receipt.status, mode === 'cancel' ? 'interrupted' : 'turn-timeout');
      assert.equal(row.receipt.cleanupComplete, true); gone(row.receipt.pid);
      if (mode !== 'cancel') assert.equal(row.receipt.escalated, true);
      if (mode === 'orphan-pipe') {
        const {pid} = JSON.parse(fs.readFileSync(path.join(dir, 'descendant.json')));
        // The OS reaps the killed grandchild; we never signal an adopted or
        // unrelated PID. A live descendant after the grace is a real failure.
        const start = performance.now();
        for (;;) {
          try { process.kill(pid, 0); }
          catch (error) { assert.equal(error.code, 'ESRCH'); break; }
          assert.ok(performance.now() - start < 3000, 'owned descendant leaked');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
    });
    await check('cancelled-before-admission', async row => {
      const dir = directory('pre-cancel'), controller = new AbortController(); controller.abort();
      row.receipt = await runDesignGeneration({binary: 'must-not-be-started', args: [], directory: dir,
        prompt, signal: controller.signal});
      assert.equal(row.receipt.status, 'interrupted'); assert.equal(row.receipt.pid, undefined);
      assert.deepEqual(fs.readdirSync(dir), []);
    });
    await check('spawn-error-and-log-closure', async row => {
      const dir = directory('missing-executable');
      row.receipt = await runDesignGeneration({binary: path.join(dir, 'absent'), args: [], cwd: dir,
        directory: dir, prompt});
      assert.equal(row.receipt.status, 'process-error'); assert.equal(row.receipt.cleanupComplete, true);
      assert.equal(row.receipt.output.stdout.complete, true);
    });
    await check('exclusive-log-admission', async () => {
      const dir = directory('exclusive-logs'); fs.writeFileSync(path.join(dir, 'stderr.txt'), 'earlier evidence');
      await assert.rejects(runDesignGeneration({binary: 'must-not-start', args: [], directory: dir, prompt}), {code: 'EEXIST'});
      assert.equal(fs.readFileSync(path.join(dir, 'stderr.txt'), 'utf8'), 'earlier evidence');
    });
    await check('real-file-size-error', async row => {
      const dir = directory('file-size-error');
      const code = 'import os,resource,signal,sys; resource.setrlimit(resource.RLIMIT_FSIZE,(1024,1024)); signal.signal(signal.SIGXFSZ,signal.SIG_IGN); os.execv(sys.argv[1],sys.argv[1:])';
      const r = spawnSync('python3', ['-c', code, process.execPath,
        path.join(root, 'tests/support/design_generation_file_limit_probe.mjs'), dir, peer],
        {encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024});
      writeArtifact(dir, 'probe.json', {status: r.status, signal: r.signal, error: String(r.error || ''), stdout: r.stdout, stderr: r.stderr});
      assert.equal(r.status, 0); row.receipt = JSON.parse(r.stdout);
      assert.equal(row.receipt.status, 'stdout-write-error'); assert.equal(row.receipt.cleanupComplete, true);
      assert.equal(row.receipt.output.stdout.complete, false);
      assert.equal(fs.statSync(path.join(dir, 'stdout.txt')).size, 1024); gone(row.receipt.pid);
    });
    await check('idle-without-artifact-is-not-generation', async row => {
      const {result, report} = await cli('cli-no-artifact', 'no-artifact'); row.receipt = report.cases[0];
      assert.equal(result.status, 1); assert.equal(row.receipt.status, 'idle');
      assert.equal(row.receipt.generationPassed, false);
    });
    for(const mode of ['wrong-entry','symlink-entry','oversized-entry'])await check(mode,async row=>{
      const {result,report}=await cli('cli-'+mode,mode);row.receipt=report.cases[0];
      assert.equal(result.status,1);assert.equal(row.receipt.status,'idle');
      assert.equal(row.receipt.generationPassed,false);
      if(mode!=='wrong-entry')assert.equal(row.receipt.entrySha256,undefined);
      if(mode==='symlink-entry')assert.equal(row.receipt.entryIsRegular,false);
      if(mode==='oversized-entry')assert.match(row.receipt.entryError,/32 MiB export limit/);
    });
    await check('invalid-capture-bounds-rejected-before-files', async () => {
      const dir = directory('invalid-bounds');
      for (const limits of [{turnMs: 1800001}, {events: 0}, {unknown: 1}, {startupMs: Infinity}])
        await assert.rejects(runDesignGeneration({binary: 'must-not-start', args: [], directory: dir, prompt, limits}));
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  }
} finally { console.log(`Design process evidence: ${run}`); }
