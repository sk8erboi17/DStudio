// Real previous installation -> native inference -> production network upgrade
// -> native inference using the retained cache. Isolated development regression,
// not general quality, exhaustive cache-format equivalence or a speed benchmark.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { artifactRunDir, writeArtifact, freePort, sleep } from '../support/real_harness.mjs';
import { hashStableFile } from '../support/quality_baseline.mjs';

const run = artifactRunDir('q36-upgrade-live');
const report = { started: new Date().toISOString(), passed: false, plannedChecks: 8, cases: [],
  scope: 'Real Metal legacy inference and production network upgrade in an isolated copy; no weight download or user app restart',
  settings: { backend: 'metal', context: 8192, prefillChunk: 128, quality: true,
    cacheK: 'f16', cacheV: 'f16', expertStreaming: false, diskKvLimitMb: 256 } };
const save = () => writeArtifact(run, 'results.json', report);
const hash = file => {
  assert.ok(fs.statSync(file).size <= 512 * 1024 * 1024, 'Never buffer model weights');
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
};
let active, activeExit, problem = '';
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => {
  problem ||= sig;
  if (active?.exitCode === null && active.signalCode === null) active.kill('SIGTERM');
});
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DS4|DSTUDIO_|Q36_|DYLD_|LD_|GIT_|MAKE)/.test(name)));
function snapshot(tree, { skipModels = false } = {}) {
  const files = {}, pending = [[tree, '']]; let count = 0, bytes = 0;
  while (pending.length) {
    const [directory, prefix] = pending.pop(), entries = fs.opendirSync(directory);
    try {
      for (let entry; (entry = entries.readSync());) {
        if (skipModels && !prefix && entry.name === 'gguf') continue;
        const name = prefix + entry.name, file = path.join(tree, name), st = fs.lstatSync(file);
        assert.ok(++count <= 8192 && name.length <= 1024 && name.split('/').length <= 20, 'Bounded installation inventory');
        if (st.isDirectory()) pending.push([file, name + '/']);
        else if (st.isSymbolicLink()) files[name] = { link: fs.readlinkSync(file) };
        else {
          assert.ok(st.isFile() && !name.endsWith('.gguf'), 'No special file or weight copy');
          assert.ok((bytes += st.size) <= 512 * 1024 * 1024, 'Bounded non-model installation bytes');
          files[name] = { bytes: st.size, sha256: hash(file), mode: st.mode & 0o777 };
        }
      }
    } finally { entries.closeSync(); }
  }
  return files;
}
function assertIsolation() {
  const ps = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(ps.status, 0, ps.stderr);
  const peers = ps.stdout.split('\n').filter(line => /\/(?:ds4|ds4-server|ds4-server-pld|ds4-agent|ds4-agent-jsonl|ds4-cowork|ds4-design|q36|q36-server|q27|DStudio|dstudio)$/.test(line.trim()));
  assert.deepEqual(peers.filter(line => Number(line.trim().split(/\s+/)[0]) !== active?.pid), [],
    'Unrelated inference present: stop only this test, not the other program');
}
function launch(binary, args, cwd, label) {
  assert.equal(active, undefined, 'Heavy phases must be sequential');
  const log = path.join(run, label + '.log'), fd = fs.openSync(log, 'wx');
  try { active = spawn(binary, args, { cwd, env, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  activeExit = new Promise((resolve, reject) => {
    active.once('error', reject);
    active.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { pid: active.pid, binary, argv: args, log };
}
async function finish(timeout, terminate = false) {
  if (terminate && active?.exitCode === null && active.signalCode === null) active.kill('SIGTERM');
  let timer;
  try {
    const exit = await Promise.race([activeExit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned phase deadline exceeded')), timeout);
    })]);
    active = undefined; activeExit = undefined;
    return exit;
  } finally { clearTimeout(timer); }
}
async function check(name, fn) {
  const row = { name, passed: false, started: new Date().toISOString() }; report.cases.push(row); save();
  try { await fn(row); row.passed = true; }
  catch (error) { row.error = error.stack; throw error; }
  finally { row.finished = new Date().toISOString(); save(); console.log(`${row.passed ? 'PASS' : 'FAIL'} ${name}`); }
}
async function inference(tree, model, row, label, messages, cacheDirectory = 'user-kv') {
  assertIsolation();
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  row.process = launch(path.join(tree, 'q36-server'), ['--model', model, '--metal', '--quality', '--ctx', '8192',
    '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--prefill-chunk', '128', '--host', '127.0.0.1', '--port', String(port),
    '--kv-disk-dir', path.join(tree, cacheDirectory), '--kv-disk-space-mb', '256', '--kv-cache-min-tokens', '1',
    '--kv-cache-boundary-align-tokens', '1', '--kv-cache-boundary-trim-tokens', '0'], tree, label);
  try {
    const deadline = Date.now() + 180000;
    while (true) {
      assert.equal(problem, ''); assertIsolation();
      assert.equal(active.exitCode, null, 'Engine exited before readiness');
      assert.equal(active.signalCode, null, 'Engine signaled before readiness');
      assert.ok(fs.statSync(row.process.log).size <= 32 * 1024 * 1024, 'Bounded native log');
      try {
        const reply = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(1000) });
        if (reply.ok) { row.catalog = await reply.json(); break; }
      } catch { /* Readiness remains bounded; failure is not a passing listener. */ }
      assert.ok(Date.now() < deadline, 'Native readiness deadline exceeded');
      await sleep(200);
    }
    const owner = spawnSync('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 32768 });
    assert.equal(owner.status, 0, owner.stderr);
    assert.deepEqual([...new Set(owner.stdout.trim().split(/\s+/).map(Number))], [active.pid], 'Listener is not this owned engine');
    row.request = { model: row.catalog.data[0].id, messages: messages || [{ role: 'user', content: 'Reply with exactly CEDAR-7316 and nothing else.' }],
      temperature: 0, seed: 19, max_tokens: 32, thinking: { type: 'disabled' }, chat_template_kwargs: { enable_thinking: false } };
    save();
    const reply = await fetch(base + '/v1/chat/completions', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row.request), signal: AbortSignal.timeout(120000) });
    row.httpStatus = reply.status; row.response = await reply.json(); save();
    assert.equal(reply.status, 200);
    assert.equal(row.response.choices[0].message.content.trim(), 'CEDAR-7316');
    assert.equal(row.response.choices[0].finish_reason, 'stop');
  } finally {
    row.exit = await finish(30000, true); save();
    assert.deepEqual(row.exit, { code: 0, signal: null }, 'Owned engine did not shut down successfully');
  }
}

console.log(`Evidence: ${run}`); save();
try {
  assert.equal(process.platform, 'darwin', 'NOT RUN: legacy Metal migration requires macOS');
  assert.equal(process.argv.length, 6, 'Supply test host, original legacy q36 tree, model and existing main engine tree');
  const [host, original, model, main] = process.argv.slice(2).map(file => fs.realpathSync(file));
  const ownedArtifacts = fs.realpathSync('tests/.artifacts') + path.sep;
  assert.ok(original.startsWith(ownedArtifacts) && main.startsWith(ownedArtifacts), 'Use prior task-owned installations, not user checkouts');
  assertIsolation();
  const destination = path.join(run, 'upgrade root with spaces'), tree = path.join(destination, 'q36');
  fs.mkdirSync(tree, { recursive: true });
  report.destination = destination;
  report.inputs = Object.fromEntries([host, import.meta.filename, 'scripts/install-q36.py', 'src/dstudio_engine_install.c',
    'scripts/apply-q36-metal-runtime.sh', 'scripts/apply-q36-agent-tty.sh',
    'patch/q36-metal-runtime/next-review.patch', 'patch/q36-agent-tty/monitor.patch', 'patch/q36-agent-tty/monitor-owner.patch',
    'patch/q36-metal-runtime/cache-usage.patch']
    .map(file => [path.resolve(file), hash(file)]));
  const before = snapshot(original, { skipModels: true }); report.original = { path: original, files: before };
  const receiptFile = path.join(tree, '.dstudio-source.json');
  await check('copy a real previous installation without copying any model bytes', async row => {
    report.weights = await hashStableFile(model);
    assert.equal(report.weights.bytes, 25299061664);
    assert.equal(report.weights.sha256, '701d8fa9ed214ab21bfc130cd2a7df19ca89bbef7713e2dfb19f3c63696aa917');
    for (const [name, file] of Object.entries(before)) {
      const output = path.join(tree, name); fs.mkdirSync(path.dirname(output), { recursive: true });
      if (file.link !== undefined) fs.symlinkSync(file.link, output);
      else { fs.copyFileSync(path.join(original, name), output, fs.constants.COPYFILE_EXCL); fs.chmodSync(output, file.mode); }
    }
    assert.deepEqual(snapshot(tree), before);
    row.receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.equal(row.receipt.commit, 'd67687ed15ad9f52b755a9b5fdfc0214ea937555');
    assert.equal(row.receipt.engine, 'q36'); assert.equal(row.receipt.backend, 'metal');
    assert.equal(row.receipt.managedFiles, undefined, 'This must exercise actual legacy ownership migration');
    for (const [name, digest] of Object.entries({ ...row.receipt.sources, ...row.receipt.binaries })) assert.equal(hash(path.join(tree, name)), digest);
    fs.symlinkSync(main, path.join(destination, 'ds4'), 'dir');
    fs.symlinkSync('../ds4/gguf', path.join(tree, 'gguf'), 'dir');
    fs.mkdirSync(path.join(tree, 'user-project'), { recursive: true });
    writeArtifact(tree, 'user-project/README.md', 'User project: preserve these bytes.');
    writeArtifact(tree, 'user-project/main.c', '#include <stdio.h>\nint main(void) { puts("PROJECT-19"); return 0; }\n');
    writeArtifact(tree, 'user-project/Makefile', 'all:\n\t$(CC) main.c -o project\n');
    fs.symlinkSync('user-project', path.join(tree, 'linked-project'), 'dir');
    row.project = snapshot(path.join(tree, 'user-project'));
    writeArtifact(destination, 'settings.json', { context: 131072, engine: 'q36' });
    row.settingsSha256 = hash(path.join(destination, 'settings.json'));
  });
  await check('the previous native engine actually loads the real 27B and answers correctly', row => inference(tree, model, row, 'legacy-engine'));
  const userData = snapshot(path.join(tree, 'user-kv'));
  assert.ok(Object.keys(userData).length > 0, 'The old engine did not produce a real cache to preserve');
  report.oldCache = userData;
  // Read the public KVC v1 envelope independently of the engine loader. The
  // old process has exited; no cache writer can change these header identities.
  // Do not interpret private tensor payloads or claim numerical equivalence.
  report.oldCacheHeaders = Object.keys(userData).filter(name => name.endsWith('.kv')).map(name => {
    const fd = fs.openSync(path.join(tree, 'user-kv', name), 'r'), header = Buffer.alloc(52);
    try { assert.equal(fs.readSync(fd, header, 0, header.length, 0), header.length); }
    finally { fs.closeSync(fd); }
    assert.equal(header.subarray(0, 3).toString('ascii'), 'KVC'); assert.equal(header[3], 1);
    return { name, tokens: header.readUInt32LE(8), context: header.readUInt32LE(16),
      payloadBytes: header.readBigUInt64LE(40).toString(), textBytes: header.readUInt32LE(48) };
  });
  assert.ok(report.oldCacheHeaders.length > 0, 'A real persisted native KV checkpoint is required');
  const oldReceiptHash = hash(receiptFile), oldDirectory = fs.statSync(tree).ino;
  await check('production installer downloads, patches and builds an actual upgrade without losing user data', async row => {
    row.process = launch(host, ['--install-engine', 'q36', destination], process.cwd(), 'upgrade');
    row.exit = await finish(900000);
    assert.deepEqual(row.exit, { code: 0, signal: null });
    row.receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.equal(row.receipt.commit, '8362010a301b3360296e435703f58ffc230a024a');
    assert.equal(row.receipt.upgradeFrom.receiptSHA256, oldReceiptHash);
    assert.equal(row.receipt.upgradeFrom.ownershipReconstructed, true);
    const backup = path.join(destination, row.receipt.upgradeFrom.backup);
    assert.equal(fs.statSync(backup).ino, oldDirectory);
    assert.equal(hash(path.join(backup, '.dstudio-source.json')), oldReceiptHash);
    for (const [name, digest] of Object.entries(row.receipt.managedFiles)) assert.equal(hash(path.join(tree, name)), digest);
    assert.deepEqual(snapshot(path.join(tree, 'user-kv')), userData);
    assert.equal(hash(path.join(destination, 'settings.json')), report.cases[0].settingsSha256);
    assert.equal(fs.readFileSync(path.join(tree, 'user-project/README.md'), 'utf8'), 'User project: preserve these bytes.');
    assert.deepEqual(snapshot(path.join(tree, 'user-project')), report.cases[0].project);
    assert.equal(fs.readlinkSync(path.join(tree, 'linked-project')), 'user-project');
    for (const name of Object.keys(report.cases[0].project)) {
      assert.equal(row.receipt.sources['user-project/' + name], undefined, 'User code is not engine source');
      assert.equal(row.receipt.managedFiles['user-project/' + name], undefined, 'Do not adopt user projects');
    }
    assert.equal(fs.readlinkSync(path.join(tree, 'gguf')), '../ds4/gguf');
    assert.deepEqual(snapshot(original, { skipModels: true }), before);
    row.cachePreservedDuringUpgrade = true;
  });
  const continuation = [...report.cases[1].request.messages,
    { role: 'assistant', content: report.cases[1].response.choices[0].message.content },
    { role: 'user', content: 'Repeat the exact code you just gave me, and nothing else.' }];
  let continuedResponse;
  await check('a newly started upgraded engine actually reuses the previous version disk KV for a continuation', async row => {
    await inference(tree, model, row, 'upgraded-continuation', continuation);
    row.cachedTokens = row.response.usage?.prompt_tokens_details?.cached_tokens;
    assert.ok(row.cachedTokens > 0, 'Preserved files alone do not prove disk KV reuse');
    assert.ok(report.oldCacheHeaders.some(header => header.tokens === row.cachedTokens),
      'Cached tokens must correspond to an original persisted checkpoint');
    continuedResponse = row.response;
  });
  await check('the identical continuation without any old cache returns the same correct answer', async row => {
    const coldCache = path.join(tree, 'cold-reference-kv');
    assert.equal(fs.existsSync(coldCache), false, 'The cold reference cannot inherit the previous cache');
    await inference(tree, model, row, 'cold-continuation', continuation, 'cold-reference-kv');
    assert.equal(row.response.usage?.prompt_tokens_details?.cached_tokens, 0);
    assert.equal(row.response.choices[0].message.content, continuedResponse.choices[0].message.content);
    assert.equal(row.response.usage.completion_tokens, continuedResponse.usage.completion_tokens);
    assert.equal(row.request.model, report.cases[3].request.model);
  });
  await check('the upgraded native engine answers correctly with the preserved cache directory', row => inference(tree, model, row, 'upgraded-engine'));
  await check('reopening verifies the same published installation without a second exchange', async row => {
    const inode = fs.statSync(tree).ino, receiptHash = hash(receiptFile);
    row.process = launch(host, ['--install-engine', 'q36', destination], process.cwd(), 'reopen');
    row.exit = await finish(120000);
    assert.deepEqual(row.exit, { code: 0, signal: null });
    assert.equal(fs.statSync(tree).ino, inode); assert.equal(hash(receiptFile), receiptHash);
    assert.equal(fs.readdirSync(destination).filter(name => name.startsWith('.dstudio-q36-stage-')).length, 1);
    assert.deepEqual(snapshot(path.join(tree, 'user-project')), report.cases[0].project);
  });
  await check('source inputs, original installation and full model hash remain unchanged', async row => {
    row.changedInputs = Object.entries(report.inputs).filter(([file, digest]) => hash(file) !== digest).map(([file]) => file);
    assert.deepEqual(row.changedInputs, []);
    assert.deepEqual(snapshot(original, { skipModels: true }), before);
    const after = await hashStableFile(model);
    assert.equal(after.sha256, report.weights.sha256); assert.equal(after.bytes, report.weights.bytes);
    assert.equal(problem, ''); assertIsolation();
  });
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (active) {
    try { report.cleanupExit = await finish(10000, true); }
    catch (error) {
      report.cleanupError = error.stack;
      if (active?.exitCode === null && active.signalCode === null) active.kill('SIGKILL');
      try { report.forcedExit = await finish(10000); } catch (last) { report.forcedCleanupError = last.stack; }
      report.passed = false; process.exitCode = 1;
    }
  }
  report.finished = new Date().toISOString(); save();
  console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${path.join(run, 'results.json')}`);
}
