// Actual native HTTP -> PNG/projector/tool results -> Qwen27B -> HTTP/SSE answers.
// Development counterfactuals, not broad held-out quality or desktop acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {fileIdentity, hashStableFile, ownGitRevision} from '../support/quality_baseline.mjs';
import {q36VisionPNG} from '../support/q36_vision_fixtures.mjs';

const root = path.resolve(import.meta.dirname, '../..'), run = artifactRunDir('q36-http-vision-live');
const report = {started: new Date().toISOString(), status: 'fail',
  scope: 'Real native HTTP, original pixel inputs, tool-result counterfactuals and Qwen27B answers; not general quality, numerical parity or DStudio Agent integration',
  host: {platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, memory: os.totalmem()},
  settings: {context: 8192, cacheK: 'f16', cacheV: 'f16', prefill: 128, threads: 4,
    quality: true, thinking: false, sampling: 'greedy', expertStreaming: false},
  inputs: {}, weights: [], cases: [], commands: []};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = () => writeArtifact(run, 'results.json', report);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(Q36_|DS4|DSTUDIO_|DYLD_|GIT_|MAKEFLAGS$|MFLAGS$)/.test(name)));
let child, exit, timer, traceWatch, resourceWatch, escalation, log = '', logBytes = 0, interrupted = false;
function stop(reason) {
  report.stopReason ||= reason;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {process.kill(-child.pid, 'SIGTERM');} catch (error) {if (error.code !== 'ESRCH') throw error;}
  escalation ||= setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {process.kill(-child.pid, 'SIGKILL');} catch (error) {if (error.code !== 'ESRCH') throw error;}
    }
  }, 5000);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {interrupted = true; stop(signal);});
async function waitFor(predicate, seconds, label) {
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    if (predicate()) return;
    assert(!interrupted, 'Interrupted');
    if (child) assert.equal(child.exitCode, null, 'Engine exited before ' + label);
    await delay(25);
  }
  throw new Error('Deadline waiting for ' + label);
}
async function check(name, body) {
  const row = {name, status: 'fail'}; report.cases.push(row); save();
  try {await body(row); row.status = 'pass';}
  catch (error) {row.error = String(error.stack || error);}
  save(); console.log(`${row.status.toUpperCase()}: ${name}`);
}
console.log('Evidence: ' + run); save();
async function execute() {
  const flags = process.argv.slice(5);
  const nativeAt = flags.indexOf('--native-receipt');
  let nativeReceipt;
  if (nativeAt >= 0) {
    assert(flags[nativeAt + 1] && !flags[nativeAt + 1].startsWith('--'), 'Missing native build receipt');
    nativeReceipt = fs.realpathSync(flags[nativeAt + 1]); flags.splice(nativeAt, 2);
  }
  assert(process.argv.length >= 5 && new Set(flags).size === flags.length &&
    flags.every(flag => ['--disk-cache', '--next', '--preflight-only'].includes(flag)),
    'Supply native q36, Qwen27B GGUF, its F16 projector and optional --disk-cache/--next/--preflight-only/--native-receipt FILE');
  const diskCache = flags.includes('--disk-cache'), nextReview = flags.includes('--next');
  let currentRenderer = nextReview;
  const preflightOnly = flags.includes('--preflight-only');
  assert(!nativeReceipt || nextReview, 'Native review receipt requires --next');
  report.preflightOnly = preflightOnly;
  report.nextReview = nextReview;
  assert.equal(process.platform, 'darwin', 'Metal hardware required');
  const [engine, model, projector] = process.argv.slice(2, 5).map(file => fs.realpathSync(file));
  env.GIT_CEILING_DIRECTORIES = path.dirname(engine);
  const binary = path.join(engine, 'q36-server');
  const binaryInfo = fs.lstatSync(binary);
  assert(binaryInfo.isFile() && binaryInfo.size <= 256 * 1024 * 1024,
    'Server binary must be bounded regular data');
  const idle = () => {
    const measured = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], {encoding: 'utf8', timeout: 5000});
    assert.equal(measured.status, 0, measured.stderr);
    const active = measured.stdout.split('\n').filter(line =>
      /\/(?:ds4|ds4-server|ds4-agent|ds4-agent-jsonl|ds4-cowork|ds4-design|q36|q36-server|q36_test|q27)(?:\s|$)|\/DStudio\.app\/Contents\/MacOS\/DStudio$/.test(line) &&
      Number(line.trim().split(/\s+/)[0]) !== child?.pid);
    assert.deepEqual(active, [], 'Another inference process is running; nothing was stopped');
  };
  if (!preflightOnly) idle();
  if (nextReview) {
    // An explicitly selected review checkout is not an installed/promoted runtime.
    // Freeze its own Git identity, applied patch and complete bounded source set.
    const git = ownGitRevision(engine);
    let build, revision = git?.head;
    if (nativeReceipt) {
      const stat = fs.lstatSync(nativeReceipt);
      assert(stat.isFile() && stat.size <= 32 * 1024 * 1024, 'Native receipt is not bounded regular data');
      report.inputs[nativeReceipt] = hash(nativeReceipt);
      build = JSON.parse(fs.readFileSync(nativeReceipt));
      assert(build.passed && build.finished && build.nextReview && build.stages?.length > 0 &&
        build.stages.every(row => row.passed), 'A terminal passing reviewed native build is required');
      revision = build.sourceRevision?.head;
      if (git) assert.equal(git.head, revision, 'Checkout revision differs from the build provenance');
      assert.equal(hash(binary), build.serverSHA256, 'Server binary differs from the native build');
      for (const [relative, expected] of [
        ['tests/integration/q36_metal_runtime_test.mjs', build.harnessSHA256],
        ['scripts/apply-q36-metal-runtime.sh', build.scriptSHA256],
        ['patch/q36-metal-runtime/next-review.patch', build.patchSHA256],
      ]) {
        const file = path.join(root, relative); assert.equal(hash(file), expected, 'Native build input changed: ' + relative);
        report.inputs[file] = expected;
      }
    }
    // Both exact revisions were source-reviewed; the newer change affects
    // Agent exit/web behavior, not the HTTP inference core. This admits a test,
    // never transfers the older revision's inference results to the new one.
    assert(['8ce8924fde5797ece13df16d87246cbe4fffbea6',
      '8362010a301b3360296e435703f58ffc230a024a'].includes(revision), 'Unreviewed q36 revision');
    report.review = {engine, git, revision, backend: 'metal', installed: false,
      ...(nativeReceipt ? {nativeBuild: {file: nativeReceipt, sha256: report.inputs[nativeReceipt],
        sourceRevision: build.sourceRevision, serverSHA256: build.serverSHA256}} : {})};
    const patch = path.join(root, 'patch/q36-metal-runtime/next-review.patch');
    const checked = spawnSync('git', ['-C', engine, 'apply', '--reverse', '--check', patch],
      {env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
    assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
    report.inputs[patch] = hash(patch);
    let count = 0, bytes = 0;
    const capture = relative => {
      for (const entry of fs.readdirSync(path.join(engine, relative), {withFileTypes: true})) {
        const name = path.join(relative, entry.name), file = path.join(engine, name);
        if (entry.isDirectory()) {
          if (entry.name !== '.git' && (relative || ['metal', 'third_party', 'tests'].includes(entry.name))) capture(name);
        } else if (/\.(c|h|m|metal|inc)$/.test(entry.name) || entry.name === 'Makefile') {
          assert(entry.isFile(), 'Linked/nonregular source: ' + name);
          count++; bytes += fs.statSync(file).size;
          assert(count <= 4096 && bytes <= 64 * 1024 * 1024, 'Source capture budget exceeded');
          report.inputs[file] = hash(file);
        }
      }
    };
    capture('');
    report.review.sourceCount = count; report.review.sourceBytes = bytes;
    if (build) {
      assert(build.builtSourceFiles && Object.keys(build.builtSourceFiles).length === count, 'Incomplete built-source inventory');
      for (const [relative, expected] of Object.entries(build.builtSourceFiles)) {
        assert(!path.isAbsolute(relative) && !relative.split('/').some(p => !p || p === '.' || p === '..'),
          'Invalid native source identity');
        assert.equal(report.inputs[path.join(engine, relative)], expected, 'Native source drift: ' + relative);
      }
    }
  } else {
    const receiptFile = path.join(engine, '.dstudio-source.json'), info = fs.lstatSync(receiptFile);
    assert(info.isFile() && info.size <= 1024 * 1024, 'Installation receipt must be bounded regular data');
    report.inputs[receiptFile] = hash(receiptFile);
    report.installation = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert(['d67687ed15ad9f52b755a9b5fdfc0214ea937555',
      '8362010a301b3360296e435703f58ffc230a024a'].includes(report.installation.commit), 'Unreviewed installed revision');
    assert.equal(report.installation.engine, 'q36'); assert.equal(report.installation.backend, 'metal');
    currentRenderer = report.installation.commit === '8362010a301b3360296e435703f58ffc230a024a';
    const runtimePatch = `patch/q36-metal-runtime/${currentRenderer ? 'next-review' : 'runtime'}.patch`;
    const patchOrder = [runtimePatch, ...(currentRenderer ? [
      'patch/q36-agent-tty/monitor.patch', 'patch/q36-agent-tty/monitor-owner.patch',
      'patch/q36-metal-runtime/cache-usage.patch'] : [])];
    const patchInputs = [...patchOrder, 'scripts/apply-q36-metal-runtime.sh',
      ...(currentRenderer ? ['scripts/apply-q36-agent-tty.sh'] : [])];
    assert.deepEqual(Object.keys(report.installation.patches || {}).sort(), patchInputs.sort(), 'Incomplete installed patch inventory');
    const installer = path.join(root, 'scripts/install-q36.py');
    report.inputs[installer] = hash(installer);
    if (currentRenderer) {
      assert.deepEqual(report.installation.patchOrder, patchOrder, 'Installed patch order differs from the reviewed stack');
      assert.equal(hash(installer), report.installation.installerSHA256, 'Installer identity changed');
    }
    for (const name of patchInputs) {
      const file = path.join(root, name), actual = hash(file);
      assert.equal(actual, report.installation.patches[name], 'Installed patch input drift: ' + name);
      report.inputs[file] = actual;
    }
    // Execute the production census, including Vulkan inputs and strict shader
    // discovery, but not unrelated user projects. The receipt cannot choose
    // which engine areas we inspect. No build, binary or model is executed.
    const census = spawnSync('python3', ['-B', '-c',
      'import importlib.util,json,pathlib,sys\n' +
      'spec=importlib.util.spec_from_file_location("q36_installer",sys.argv[1])\n' +
      'installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)\n' +
      'print(json.dumps(installer.source_identity(pathlib.Path(sys.argv[2]),installed=True)))',
      installer, engine], {env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
    assert(!census.error, census.error?.message);
    assert.equal(census.status, 0, 'Installed source inspection failed: ' + census.stderr);
    const actualSources = JSON.parse(census.stdout);
    assert.deepEqual(actualSources, report.installation.sources, 'Installed source inventory or content changed');
    for (const [name, digest] of Object.entries(actualSources)) report.inputs[path.join(engine, name)] = digest;
    assert.equal(hash(binary), report.installation.binaries?.['q36-server'], 'Installed server binary changed');
  }
  report.nativeApiGeneration = currentRenderer ? 'preserved-prelude-and-authenticated-vision' : 'legacy-pinned';
  report.plannedChecks = (currentRenderer ? 40 : 28) + (diskCache ? 6 : 0);
  for (const file of [binary, import.meta.filename, path.join(root, 'tests/support/q36_vision_fixtures.mjs')]) {
    report.inputs[file] = hash(file);
  }
  fs.copyFileSync(import.meta.filename, path.join(run, 'harness.mjs'));
  fs.copyFileSync(path.join(root, 'tests/support/q36_vision_fixtures.mjs'), path.join(run, 'fixtures.mjs'));
  if (preflightOnly) {
    report.scope = 'Source and compiled-binary admission only; weights not verified, no model, socket or inference started';
    report.status = 'preflight-pass';
    return;
  }
  const weightPins = [
    [model, 25299061664, '701d8fa9ed214ab21bfc130cd2a7df19ca89bbef7713e2dfb19f3c63696aa917'],
    [projector, 927607488, 'cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e'],
  ];
  for (const [file, bytes, expected] of weightPins) {
    assert.equal(fs.statSync(file).size, bytes);
    const identity = await hashStableFile(file); assert.equal(identity.sha256, expected);
    report.weights.push({file, bytes, ...identity}); save();
  }
  const pixels = Array.from({length: 4}, (_, index) => q36VisionPNG(index));
  pixels.forEach((bytes, index) => fs.writeFileSync(path.join(run, `input-${index}.png`), bytes, {flag: 'wx'}));
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve);});
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  idle();
  const traceFile = path.join(run, 'native-trace.txt');
  const traceLimit = 8 * 1024 * 1024;
  report.trace = {file: traceFile, maximumBytes: traceLimit, pollingMilliseconds: 250};
  const args = ['--model', model, '--vision', projector, '--metal', '--quality', '--ctx', '8192',
    '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--prefill-chunk', '128', '--threads', '4',
    '--tokens', '32', '--host', '127.0.0.1', '--port', String(port), '--trace', traceFile];
  const cacheDir = path.join(run, 'native-kv-cache');
  if (diskCache) {
    report.settings.diskCache = {budgetMiB: 4096, minimumTokens: 512, coldMaximum: 4096,
      continuedInterval: 512, boundaryTrim: 32, boundaryAlignment: 128};
    args.push('--kv-disk-dir', cacheDir, '--kv-disk-space-mb', '4096', '--kv-cache-min-tokens', '512',
      '--kv-cache-cold-max-tokens', '4096', '--kv-cache-continued-interval-tokens', '512',
      '--kv-cache-boundary-trim-tokens', '32', '--kv-cache-boundary-align-tokens', '128');
  }
  report.argv = [binary, ...args];
  child = spawn(binary, args, {cwd: engine, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  report.pid = child.pid; save();
  exit = new Promise(resolve => {
    child.once('error', error => resolve({error: String(error)}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    logBytes += bytes.length;
    if (logBytes <= 8 * 1024 * 1024) {log += bytes.toString('utf8'); process.stderr.write(bytes);}
    else stop('log byte limit');
  });
  timer = setTimeout(() => stop('600-second run deadline'), 600000);
  // Opt-in native diagnostics are private test evidence, not a throughput run.
  // Bound their lifetime and observed size; never read an unbounded trace.
  traceWatch = setInterval(() => {
    try {if (fs.statSync(traceFile).size > traceLimit) stop('trace byte limit');}
    catch (error) {if (error.code !== 'ENOENT') stop('trace observation failure');}
  }, 250);
  resourceWatch = setInterval(() => {
    try {idle();}
    catch {stop('Another app/engine started or process ownership could not be revalidated; releasing only the test model');}
  }, 1000);
  await waitFor(() => log.includes('listening on http://'), 120, 'native readiness');
  const catalog = await fetch(url + '/v1/models', {signal: AbortSignal.timeout(5000)}).then(r => r.json());
  assert.equal(catalog.data[0].id, 'qwen3.8-27b'); assert.equal(catalog.data[0].context_length, 8192);
  const image = bytes => ({type: 'image_url', image_url: {url: 'data:image/png;base64,' + bytes.toString('base64')}});
  const text = value => ({type: 'text', text: value});
  const request = content => ({model: 'qwen3.8-27b', messages: [{role: 'user', content}],
    temperature: 0, top_p: 1, top_k: 0, min_p: 0, seed: 1, max_tokens: 32,
    chat_template_kwargs: {enable_thinking: false}});
  const send = async (row, payload, expectedStatus = 200, requestId, endpoint = '/v1/chat/completions') => {
    row.request = payload; row.endpoint = endpoint;
    const start = performance.now();
    const response = await fetch(url + endpoint, {method: 'POST',
      headers: {'Content-Type': 'application/json', ...(requestId ? {'X-DStudio-Request-Id': requestId} : {})},
      body: JSON.stringify(payload), signal: AbortSignal.timeout(120000)});
    row.statusCode = response.status; row.raw = await response.text(); row.seconds = (performance.now() - start) / 1000;
    assert.equal(response.status, expectedStatus, row.raw);
    row.response = JSON.parse(row.raw); return row.response;
  };
  const halfClosedResponse = async (row, payload) => {
    row.request = payload;
    const body = JSON.stringify(payload);
    row.requestWire = `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
    const start = performance.now();
    row.wire = await new Promise((resolve, reject) => {
      const parts = []; let bytes = 0, settled = false;
      const socket = net.createConnection({host: '127.0.0.1', port, allowHalfOpen: true});
      const timeout = setTimeout(() => finish(new Error('120-second half-close response deadline')), 120000);
      function finish(error) {
        if (settled) return; settled = true;
        clearTimeout(timeout); socket.destroy();
        row.wire = Buffer.concat(parts).toString('utf8');
        if (error) reject(error); else resolve(row.wire);
      }
      socket.once('connect', () => socket.end(row.requestWire));
      socket.on('data', data => {
        bytes += data.length;
        if (bytes > 1024 * 1024) finish(new Error('Half-close response exceeds 1 MiB'));
        else parts.push(data);
      });
      socket.once('error', finish);
      socket.once('end', () => finish());
      socket.once('close', () => {if (!settled) finish(new Error('Response closed before EOF'));});
    });
    row.seconds = (performance.now() - start) / 1000;
    const boundary = row.wire.indexOf('\r\n\r\n');
    assert(boundary >= 0, 'Missing complete HTTP headers');
    row.statusCode = Number(/^HTTP\/1\.1 (\d+)/.exec(row.wire)?.[1]);
    row.raw = row.wire.slice(boundary + 4);
    assert.equal(row.statusCode, 200, row.raw);
  };
  const answer = (row, expected) => {
    const choice = row.response.choices[0];
    row.answer = choice.message.content.trim(); row.expected = expected;
    assert.equal(choice.finish_reason, 'stop');
    assert.equal(row.answer.toLowerCase().replace(/\s*,\s*/g, ','), expected);
  };
  await check('text baseline before images', async row => {await send(row, request('What is 6+8? Reply with the integer only.')); answer(row, '14');});
  for (let index = 0; index < 4; index++) {
    const prompt = index === 2 ? 'Name the color on the left and the color on the right, in that order. Reply with the two lowercase color names separated by a comma only.' :
      'What single color fills the image? Reply with one lowercase color word only.';
    await check(`pixel counterfactual ${index}`, async row => {
      const offset = log.length;
      const response = send(row, request([image(pixels[index]), text(prompt)]));
      // Retain failures even if the parallel metadata check fails first.
      const tracked = response.then(value => ({value}), error => ({error}));
      let status, controlError;
      try {
        await waitFor(() => log.slice(offset).includes('visual request preparation started'), 10, 'image preparation');
        const t = performance.now();
        status = await fetch(url + '/v1/models', {signal: AbortSignal.timeout(5000)}).then(r => r.json());
        row.controlMilliseconds = performance.now() - t;
      } catch (error) {controlError = error;}
      const result = await tracked; if (result.error) throw result.error;
      if (controlError) throw controlError;
      assert.equal(status.data[0].id, 'qwen3.8-27b');
      assert(row.controlMilliseconds < 1000, 'Control metadata blocked during image preparation');
      answer(row, ['red', 'blue', 'blue,red', 'red'][index]);
    });
    await check(`text recovery ${index}`, async row => {await send(row, request('What is 6+8? Reply with the integer only.')); answer(row, '14');});
  }
  await check('two separate images keep their order', async row => {
    await send(row, request([image(pixels[1]), image(pixels[0]), text('Name the single color in each image, in image order. Reply with two lowercase color names separated by a comma only.')]));
    answer(row, 'blue,red');
  });
  await check('invalid native PNG returns an error', async row => {
    await send(row, request([image(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])), text('Describe the image.')]), 500);
    assert.match(row.response.error.message, /PNG/);
  });
  await check('text recovery after native decoder failure', async row => {await send(row, request('What is 6+8? Reply with the integer only.')); answer(row, '14');});
  await check('real SSE carries the image answer and completion', async row => {
    row.request = {...request([image(pixels[0]), text('What single color fills the image? Reply with one lowercase color word only.')]), stream: true};
    const response = await fetch(url + '/v1/chat/completions', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(row.request), signal: AbortSignal.timeout(120000)});
    row.statusCode = response.status; row.raw = await response.text(); assert.equal(response.status, 200, row.raw);
    const events = row.raw.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.slice(0, -1).map(line => JSON.parse(line));
    row.answer = chunks.map(part => part.choices?.[0]?.delta?.content || '').join('').trim();
    assert.equal(row.answer, 'red'); assert(chunks.some(part => part.choices?.[0]?.finish_reason === 'stop'));
  });
  await check('HTTP half-close still receives the native image answer', async row => {
    await halfClosedResponse(row, request([image(pixels[0]), text('What single color fills the image? Reply with one lowercase color word only.')]));
    row.response = JSON.parse(row.raw); answer(row, 'red');
  });
  await check('HTTP half-close still receives complete native image SSE', async row => {
    await halfClosedResponse(row, {...request([image(pixels[1]), text('What single color fills the image? Reply with one lowercase color word only.')]), stream: true});
    const events = row.raw.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
    assert.equal(events.at(-1), '[DONE]');
    const chunks = events.slice(0, -1).map(line => JSON.parse(line));
    row.answer = chunks.map(part => part.choices?.[0]?.delta?.content || '').join('').trim();
    assert.equal(row.answer, 'blue'); assert(chunks.some(part => part.choices?.[0]?.finish_reason === 'stop'));
  });
  await check('text recovery after half-closed requests', async row => {
    await send(row, request('What is 6+8? Reply with the integer only.')); answer(row, '14');
  });
  const cancel = async (row, id) => {
    row.cancelAttempts = [];
    // 404 means not registered/active, not a successful cancellation. This
    // bounded retry only resolves header-admission timing for this unique ID.
    const until = performance.now() + 2000;
    do {
      const response = await fetch(url + `/v1/requests/${id}/cancel`, {method: 'POST', signal: AbortSignal.timeout(2000)});
      const raw = await response.text(); row.cancelAttempts.push({status: response.status, raw});
      if (response.status === 202) {assert.equal(JSON.parse(raw).cancellation_requested, true); return;}
      assert.equal(response.status, 404, raw); await delay(25);
    } while (performance.now() < until);
    throw new Error('Request cancellation was never admitted');
  };
  await check('native HTTP cancels a partially received body', async row => {
    row.requestId = crypto.randomUUID();
    let cancellation;
    row.requestWire = `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-DStudio-Request-Id: ${row.requestId}\r\nContent-Length: 10000\r\n\r\n{`;
    row.wire = await new Promise((resolve, reject) => {
      const parts = []; let bytes = 0, settled = false;
      const socket = net.createConnection({host: '127.0.0.1', port, allowHalfOpen: true});
      const timeout = setTimeout(() => finish(new Error('Partial-body cancellation deadline')), 15000);
      function finish(error) {
        if (settled) return; settled = true; clearTimeout(timeout); socket.destroy();
        row.wire = Buffer.concat(parts).toString('utf8');
        if (error) reject(error); else resolve(row.wire);
      }
      socket.once('connect', () => {
        socket.write(row.requestWire); cancellation = cancel(row, row.requestId); cancellation.catch(finish);
      });
      socket.on('data', data => {bytes += data.length; if (bytes > 65536) finish(new Error('Control response limit')); else parts.push(data);});
      socket.once('error', finish); socket.once('end', () => finish());
      socket.once('close', () => {if (!settled) finish(new Error('Control response closed before EOF'));});
    });
    await cancellation;
    assert.match(row.wire, /^HTTP\/1\.1 499 /);
    assert.equal(row.cancelAttempts.at(-1).status, 202);
  });
  await check('native cancellation interrupts actual image preparation', async row => {
    row.requestId = crypto.randomUUID(); const offset = log.length;
    const pending = send(row, request([...Array.from({length: 8}, () => image(pixels[0])),
      text('Name the color in each image in order.')]), 499, row.requestId)
      .then(value => ({value}), error => ({error}));
    let cancellationError;
    try {
      await waitFor(() => log.slice(offset).includes('visual request preparation started'), 10, 'cancellable native image preparation');
      await cancel(row, row.requestId);
    } catch (error) {cancellationError = error;}
    const result = await pending;
    if (cancellationError) throw cancellationError;
    if (result.error) throw result.error;
    assert.match(row.response.error.message, /interrupted; previous session retained/);
  });
  await check('text recovery after explicit image cancellation', async row => {
    await send(row, request('What is 6+8? Reply with the integer only.')); answer(row, '14');
  });
  let completedId;
  await check('request identity preserves a normal native answer', async row => {
    completedId = row.requestId = crypto.randomUUID();
    await send(row, request('What is 6+8? Reply with the integer only.'), 200, completedId); answer(row, '14');
  });
  await check('finished request cannot be cancelled as if still running', async row => {
    row.requestId = completedId;
    const response = await fetch(url + `/v1/requests/${completedId}/cancel`, {method: 'POST', signal: AbortSignal.timeout(2000)});
    row.statusCode = response.status; row.raw = await response.text(); assert.equal(response.status, 404, row.raw);
  });
  const toolRequest = {...request('Read code.txt with read_file. After receiving the tool result, reply with the exact code from the file and nothing else.'),
    max_tokens: 128, tools: [{type: 'function', function: {name: 'read_file',
      description: 'Read the complete contents of the requested local text file.',
      parameters: {type: 'object', properties: {path: {type: 'string', enum: ['code.txt']}},
        required: ['path'], additionalProperties: false}}}], tool_choice: 'auto'};
  let toolMessage, toolCall;
  await check('native model produces an executable structured file-read call', async row => {
    await send(row, toolRequest);
    const choice = row.response.choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message.tool_calls.length, 1);
    const call = choice.message.tool_calls[0];
    assert.equal(call.type, 'function'); assert.equal(call.function.name, 'read_file');
    assert.deepEqual(JSON.parse(call.function.arguments), {path: 'code.txt'});
    assert.equal(typeof call.id, 'string'); assert(call.id.length > 0);
    toolCall = call;
    toolMessage = {role: 'assistant', content: choice.message.content ?? null, tool_calls: choice.message.tool_calls};
  });
  for (const api of ['OpenAI', 'Responses', 'Anthropic']) {
    for (const [index, expected] of ['CN4-739', 'DW8-216'].entries()) {
      await check(`native ${api} tool continuation uses changed file result ${index}`, async row => {
      assert(toolCall && toolMessage, 'The preceding real tool-call generation failed');
      // Two independent fixture workspaces supply the same requested filename
      // with different bytes. Neither expected code is in the initial prompt.
      const workspace = path.join(run, `tool-workspace-${api}-${index}`);
      fs.mkdirSync(workspace);
      const file = path.join(workspace, 'code.txt');
      fs.writeFileSync(file, expected + '\n', {flag: 'wx'});
      const args = JSON.parse(toolCall.function.arguments);
      assert.equal(args.path, 'code.txt'); // No arbitrary path from the model.
      const content = fs.readFileSync(path.join(workspace, args.path), 'utf8');
      row.toolExecution = {name: toolCall.function.name, callId: toolCall.id, workspace,
        arguments: args, bytes: Buffer.byteLength(content), sha256: hash(file), result: content};
      const offset = fs.statSync(traceFile).size;
      if (api === 'OpenAI') {
        await send(row, {...toolRequest, max_tokens: 32, messages: [...toolRequest.messages,
          toolMessage, {role: 'tool', tool_call_id: toolCall.id, content}]});
        assert.equal(row.response.choices[0].finish_reason, 'stop');
        row.answer = row.response.choices[0].message.content.trim();
      } else if (api === 'Responses') {
        await send(row, {model: toolRequest.model, temperature: 0, top_p: 1, max_output_tokens: 32,
          chat_template_kwargs: {enable_thinking: false},
          tools: [{type: 'function', ...toolRequest.tools[0].function}],
          input: [...toolRequest.messages, {type: 'function_call', call_id: toolCall.id,
            name: toolCall.function.name, arguments: toolCall.function.arguments},
            {type: 'function_call_output', call_id: toolCall.id, output: content}]}, 200, undefined, '/v1/responses');
        assert.equal(row.response.status, 'completed');
        const messages = row.response.output.filter(item => item.type === 'message');
        assert.equal(messages.length, 1); assert.equal(messages[0].role, 'assistant');
        assert(!row.response.output.some(item => item.type === 'function_call'));
        row.answer = messages[0].content.filter(item => item.type === 'output_text').map(item => item.text).join('').trim();
      } else {
        await send(row, {model: toolRequest.model, temperature: 0, top_p: 1, max_tokens: 32,
          thinking: {type: 'disabled'}, tools: [{name: toolCall.function.name,
            description: toolRequest.tools[0].function.description,
            input_schema: toolRequest.tools[0].function.parameters}],
          messages: [...toolRequest.messages, {role: 'assistant', content: [{type: 'tool_use',
            id: toolCall.id, name: toolCall.function.name, input: args}]},
            {role: 'user', content: [{type: 'tool_result', tool_use_id: toolCall.id, content}]}]},
          200, undefined, '/v1/messages');
        assert.equal(row.response.stop_reason, 'end_turn');
        assert(row.response.content.every(item => item.type === 'text'));
        row.answer = row.response.content.map(item => item.text).join('').trim();
      }
      row.expected = expected;
      assert.equal(row.response.model, toolRequest.model);
      assert.equal(row.answer, expected, 'The code must match exactly, including case');
      assert(fs.statSync(traceFile).size <= traceLimit, 'Trace byte limit exceeded');
      row.trace = fs.readFileSync(traceFile).subarray(offset).toString('utf8');
      assert.match(row.trace, /^tool_replay: mem=1 disk=0 canonical=0 missing_ids=0$/m,
        'The production generation path did not resolve the sampled tool call');
      });
    }
  }
  if (currentRenderer) {
    // Native 8ce8924 adds authenticated tool-only vision continuation. Each
    // actual model-generated ID must retain its original pixels, while a new
    // tool image must change the answer. No expected color is in the text.
    for (const api of ['OpenAI', 'Responses', 'Anthropic']) {
      const endpoint = api === 'OpenAI' ? '/v1/chat/completions' : api === 'Responses' ? '/v1/responses' : '/v1/messages';
      const key = api === 'Responses' ? 'input' : 'messages';
      const imagePart = bytes => api === 'Anthropic' ? {type: 'image',
        source: {type: 'base64', media_type: 'image/png', data: bytes.toString('base64')}} :
        api === 'Responses' ? {type: 'input_image', image_url: 'data:image/png;base64,' + bytes.toString('base64')} : image(bytes);
      const textPart = value => ({type: api === 'Responses' ? 'input_text' : 'text', text: value});
      const common = {model: toolRequest.model, temperature: 0, top_p: 1,
        ...(api === 'Responses' ? {max_output_tokens: 128} : {max_tokens: 128}),
        ...(api === 'Anthropic' ? {thinking: {type: 'disabled'}} : {chat_template_kwargs: {enable_thinking: false}}),
        tools: api === 'OpenAI' ? toolRequest.tools : api === 'Responses' ? [{type: 'function', ...toolRequest.tools[0].function}] :
          [{name: 'read_file', description: toolRequest.tools[0].function.description,
            input_schema: toolRequest.tools[0].function.parameters}]};
      for (const addImage of [false, true]) {
        const label = `${api} authenticated vision continuation ${addImage ? 'with changed tool pixels' : 'without resending pixels'}`;
        let actualCall;
        await check(label + ': generated file-read call', async row => {
          await send(row, {...common, [key]: [{role: 'user', content: [imagePart(pixels[0]), textPart(
            'Read code.txt with read_file once. After the file has been read, name the dominant color of the most recent image. Reply with one lowercase color word only and do not call tools again.')]}]},
          200, undefined, endpoint);
          const calls = api === 'OpenAI' ? row.response.choices[0].message.tool_calls :
            api === 'Responses' ? row.response.output.filter(item => item.type === 'function_call') :
            row.response.content.filter(item => item.type === 'tool_use');
          assert.equal(calls?.length, 1);
          const call = calls[0], id = api === 'Responses' ? call.call_id : call.id;
          const name = api === 'OpenAI' ? call.function.name : call.name;
          const args = api === 'Anthropic' ? call.input : JSON.parse(api === 'OpenAI' ? call.function.arguments : call.arguments);
          assert.equal(name, 'read_file'); assert.deepEqual(args, {path: 'code.txt'});
          assert.equal(typeof id, 'string'); assert(id.length > 0);
          actualCall = {id, name, args};
        });
        await check(label + ': exact color and retained image frontier', async row => {
          assert(actualCall, 'The preceding real tool call failed');
          const workspace = path.join(run, `vision-tool-${api}-${addImage}`);
          fs.mkdirSync(workspace);
          const file = path.join(workspace, actualCall.args.path);
          fs.writeFileSync(file, 'Checkpoint complete.\n', {flag: 'wx'});
          const content = fs.readFileSync(file, 'utf8');
          row.toolExecution = {...actualCall, file, result: content, sha256: hash(file)};
          const parts = [...(addImage ? [imagePart(pixels[1])] : []), textPart(content)];
          const result = api === 'OpenAI' ? {role: 'tool', tool_call_id: actualCall.id, content: parts} :
            api === 'Responses' ? {type: 'function_call_output', call_id: actualCall.id, output: parts} :
            {role: 'user', content: [{type: 'tool_result', tool_use_id: actualCall.id, content: parts}]};
          await send(row, {...common, [key]: [result]}, 200, undefined, endpoint);
          row.expected = addImage ? 'blue' : 'red';
          if (api === 'OpenAI') {
            assert.equal(row.response.choices[0].finish_reason, 'stop');
            row.answer = row.response.choices[0].message.content.trim();
          } else if (api === 'Responses') {
            assert.equal(row.response.status, 'completed');
            assert(!row.response.output.some(item => item.type === 'function_call'));
            row.answer = row.response.output.flatMap(item => item.content || [])
              .filter(item => item.type === 'output_text').map(item => item.text).join('').trim();
          } else {
            assert.equal(row.response.stop_reason, 'end_turn');
            assert(row.response.content.every(item => item.type === 'text'));
            row.answer = row.response.content.map(item => item.text).join('').trim();
          }
          assert.equal(row.answer, row.expected);
          const usage = row.response.usage;
          row.cachedTokens = (usage?.cache_read_input_tokens || 0) +
            (usage?.prompt_tokens_details?.cached_tokens || 0) + (usage?.input_tokens_details?.cached_tokens || 0);
          assert(row.cachedTokens > 0, 'Authenticated tool-only continuation lost its actual image-conditioned prefix');
        });
      }
    }
  }
  if (diskCache) {
    const expected = 'LM7-284';
    const records = Array.from({length: 90}, (_, i) => `Record ${String(i).padStart(3, '0')}: archived item, no special code.`).join('\n');
    const sourceRequest = request(`The verification code is ${expected}.\nDataset:\n${records}\nReply with the verification code and nothing else.`);
    let sourceMessage, uninterruptedDecision;
    const exactCode = row => {
      assert.equal(row.response.model, 'qwen3.8-27b');
      const choice = row.response.choices[0]; assert.equal(choice.finish_reason, 'stop');
      row.answer = choice.message.content.trim(); row.expected = expected; assert.equal(row.answer, expected);
      return {role: 'assistant', content: choice.message.content};
    };
    const traceSince = offset => {
      assert(fs.statSync(traceFile).size <= traceLimit);
      return fs.readFileSync(traceFile).subarray(offset).toString('utf8');
    };
    const cacheDecision = trace => Object.fromEntries([
      'live_tokens_before', 'prompt_tokens', 'live_prompt_common',
      'memory_token_reusable', 'memory_miss_reason', 'cache_source',
      'cached_tokens', 'disk_cached_tokens',
    ].map(name => {
      const value = new RegExp(`^${name}: (.+)$`, 'm').exec(trace)?.[1];
      assert(value !== undefined, 'Native cache trace omitted ' + name);
      return [name, value];
    }));
    const continuation = () => {
      assert(sourceMessage, 'Earlier actual source response failed');
      return {...sourceRequest, messages: [...sourceRequest.messages, sourceMessage,
        {role: 'user', content: 'Repeat the verification code exactly, and nothing else.'}]};
    };
    const cacheFiles = () => {
      const result = [], dirs = [cacheDir];
      while (dirs.length) {
        const dir = dirs.pop();
        for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
          const file = path.join(dir, e.name);
          assert(!e.isSymbolicLink(), 'Unexpected cache symlink');
          if (e.isDirectory()) {assert(dirs.length < 16); dirs.push(file);}
          else if (e.isFile()) result.push(file);
          assert(result.length <= 256, 'Cache file-count bound exceeded');
        }
      }
      return result.sort();
    };
    const snapshot = async () => {
      const rows = []; let bytes = 0;
      for (const file of cacheFiles()) {
        assert(!path.basename(file).includes('.tmp.'), 'Private checkpoint escaped terminal cleanup');
        if (!file.endsWith('.kv')) continue;
        bytes += fs.statSync(file).size; assert(bytes <= 4096 * 1024 * 1024, 'Disk-cache budget exceeded');
        rows.push({file: path.relative(cacheDir, file), bytes: fs.statSync(file).size,
          sha256: (await hashStableFile(file)).sha256});
      }
      return rows;
    };
    await check('real cold text preparation publishes native checkpoints and a correct answer', async row => {
      const offset = log.length; await send(row, sourceRequest); sourceMessage = exactCode(row);
      row.cache = await snapshot(); assert(row.cache.length > 0);
      row.nativeLog = log.slice(offset);
      assert.match(row.nativeLog, /kv cache prepared tokens=\d+/);
    });
    await check('uninterrupted native chat continuation establishes the exact cache oracle', async row => {
      const offset = fs.statSync(traceFile).size;
      await send(row, continuation()); exactCode(row); row.trace = traceSince(offset);
      row.cacheDecision = cacheDecision(row.trace);
      if (currentRenderer) {
        // The reviewed GGUF-matching renderer preserves the empty prelude.
        // The fixed checkpoint must retain that exact prefix, not strip it
        // and silently re-prefill. The independent native policy regression
        // also checks both preserved and omitted-history renderings.
        assert.equal(row.cacheDecision.memory_token_reusable, '1');
        assert.equal(row.cacheDecision.memory_miss_reason, 'live-prefix-match');
        assert.equal(row.cacheDecision.cache_source, 'memory-token');
        assert.equal(row.cacheDecision.live_prompt_common, row.cacheDecision.live_tokens_before);
        assert.equal(row.cacheDecision.cached_tokens, row.cacheDecision.live_tokens_before);
        assert.equal(row.cacheDecision.disk_cached_tokens, '0');
      } else {
        // The older pinned renderer omits empty reasoning from past turns.
        // Its explicit mismatch must not be converted into stale-state reuse.
        assert.equal(row.cacheDecision.memory_token_reusable, '0');
        assert.equal(row.cacheDecision.memory_miss_reason, 'token-mismatch');
        assert.equal(row.cacheDecision.cache_source, 'disk-text');
        assert(Number(row.cacheDecision.live_prompt_common) < Number(row.cacheDecision.live_tokens_before));
      }
      assert(Number(row.cacheDecision.cached_tokens) >= 512);
      uninterruptedDecision = row.cacheDecision;
    });
    await check('a different prompt retires the live text session without losing its disk checkpoint', async row => {
      await send(row, request('What is 6+8? Reply with the integer only.')); answer(row, '14');
      row.cache = await snapshot(); assert(row.cache.length > 0);
    });
    await check('real disk-prefix restore returns the original exact answer', async row => {
      const offset = fs.statSync(traceFile).size;
      await send(row, sourceRequest); sourceMessage = exactCode(row);
      row.trace = traceSince(offset); assert.match(row.trace, /cache_source: disk-text/);
      row.cache = await snapshot();
    });
    await check('Stop during real text prefill retains all previously committed checkpoint bytes', async row => {
      row.before = await snapshot();
      const offset = log.length;
      row.requestId = crypto.randomUUID();
      const payload = request('Temporary replacement dataset.\n' +
        Array.from({length: 220}, (_, i) => `Temporary item ${i}: this unrelated entry has no answer.`).join('\n') +
        '\nReply only with temporary.');
      const pending = send(row, payload, 499, row.requestId).then(value => ({value}), error => ({error}));
      let failure;
      try {
        // Both revisions must actually receive Stop. The old server publishes
        // immediately, so waiting only for the new "prepared" wording would
        // test a missing phase, not its real cancellation behavior.
        const checkpoint = () => /kv cache (prepared|stored) tokens=512\b/.exec(log.slice(offset));
        await waitFor(checkpoint, 60, 'the native text checkpoint before Stop');
        row.checkpointPhase = checkpoint()[1];
        const begin = performance.now();
        row.metadata = await fetch(url + '/v1/models', {signal: AbortSignal.timeout(2000)}).then(r => r.json());
        row.controlMilliseconds = performance.now() - begin;
        assert.equal(row.metadata.data[0].id, 'qwen3.8-27b');
        assert(row.controlMilliseconds < 1000, 'Text preparation blocked metadata');
        row.cancelStarted = performance.now(); await cancel(row, row.requestId);
      } catch (error) {failure = error;}
      const result = await pending;
      if (row.cancelStarted) row.cancelSeconds = (performance.now() - row.cancelStarted) / 1000;
      row.after = await snapshot();
      if (failure) throw failure; if (result.error) throw result.error;
      assert(row.cancelSeconds < 15, 'Stop exceeded its original 15-second bound');
      assert.equal(row.checkpointPhase, 'prepared', 'Uncommitted checkpoint was published before full prompt success');
      assert.match(row.response.error.message, /previous session retained/);
      assert.deepEqual(row.after, row.before);
    });
    await check('real continuation after Stop preserves the uninterrupted native frontier and correct answer', async row => {
      assert(uninterruptedDecision, 'Uninterrupted native comparison did not pass');
      const offset = fs.statSync(traceFile).size;
      await send(row, continuation());
      exactCode(row); row.trace = traceSince(offset);
      row.cacheDecision = cacheDecision(row.trace);
      assert.deepEqual(row.cacheDecision, uninterruptedDecision,
        'Stop changed the previous frontier or the native continuation cache decision');
      row.cache = await snapshot();
    });
  }
  report.status = report.cases.every(row => row.status === 'pass') ? 'pass' : 'fail';
  if (report.status !== 'pass') process.exitCode = 1;
}
try {await execute();}
catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {
  clearTimeout(timer);
  clearInterval(traceWatch);
  clearInterval(resourceWatch);
  stop('test complete');
  if (exit) report.nativeExit = await exit;
  clearTimeout(escalation);
  fs.writeFileSync(path.join(run, 'native.log'), log, {flag: 'wx'});
  for (const [file, expected] of Object.entries(report.inputs)) if (hash(file) !== expected) {
    report.status = 'fail'; report.changedInput = file; process.exitCode = 1;
  }
  for (const weight of report.weights) if (fileIdentity(fs.statSync(weight.file, {bigint: true})) !== weight.identity) {
    report.status = 'fail'; report.changedWeight = weight.file; process.exitCode = 1;
  }
  if (report.review && JSON.stringify(ownGitRevision(report.review.engine)) !== JSON.stringify(report.review.git)) {
    report.status = 'fail'; report.changedReviewCheckout = true; process.exitCode = 1;
  }
  if (interrupted || report.stopReason !== 'test complete') {report.status = 'fail'; process.exitCode = 1;}
  report.finished = new Date().toISOString(); save();
  console.log(JSON.stringify({run, status: report.status, passed: report.cases.filter(r => r.status === 'pass').length, total: report.cases.length}));
}
