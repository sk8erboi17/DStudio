// Actual managed q36 installation -> DStudio launch -> same-origin inference
// -> resident reuse -> owned Stop. Development regression, not broad quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { artifactRunDir, writeArtifact, freePort, sleep, csrfHeaders } from '../support/real_harness.mjs';
import { fileIdentity, hashStableFile } from '../support/quality_baseline.mjs';
import { assertSpreadsheetWorkflow } from '../support/cowork_spreadsheet_oracle.mjs';
import { q36VisionPNG } from '../support/q36_vision_fixtures.mjs';

const run = artifactRunDir('q36-host-live');
const options = process.argv.slice(6);
const browserName = options.find(arg => arg.startsWith('--browser='))?.slice(10) || '';
const withTools = options.includes('--tools');
const traceNative = options.includes('--trace-native');
const report = { started: new Date().toISOString(), passed: false, plannedChecks: 7 + 3 * !!browserName + 7 * withTools, cases: [],
  scope: 'Actual native DStudio host, verified managed installation and real Qwen27B Metal weights; ' +
    (browserName ? `production UI text and two pixel-only counterfactuals in headless ${browserName}, not the macOS .app window; ` : 'no browser; ') +
    (withTools ? 'native Agent repair, Cowork export and four pixel-only tool observations with independent oracles, not Task Graph qualification; ' : '') + 'no broad quality claim',
  hardware: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, ram: os.totalmem() },
  settings: { context: 8192, backend: 'metal', quality: true, prefillChunk: 128,
    threads: 'native default', cacheK: 'f16', cacheV: 'f16', expertStreaming: false, diskKvLimitMb: 256 } };
const save = () => writeArtifact(run, 'results.json', report);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function probeInstallationLease(tree, shared = false) {
  const result = spawnSync('python3', ['-c', `
import fcntl, json, os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
try:
    fcntl.flock(fd, (fcntl.LOCK_SH if sys.argv[2] == 'shared' else fcntl.LOCK_EX) | fcntl.LOCK_NB)
except BlockingIOError:
    acquired = False
else:
    acquired = True
print(json.dumps({'acquired': acquired}))
os.close(fd)
`, path.join(path.dirname(tree), '.dstudio-q36-install.lock'), shared ? 'shared' : 'exclusive'],
  {encoding: 'utf8', timeout: 3000, maxBuffer: 4096});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
let host, terminal, timer, watcher, base, resident = 0, problem = '';
let model, projector, modelHash, projectorHash;
function signalHost(reason) { problem ||= reason; if (host && host.exitCode === null && host.signalCode === null) host.kill('SIGTERM'); }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => signalHost(signal));
function assertIsolation() {
  const ps = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5000 });
  assert.equal(ps.status, 0, ps.stderr);
  const rows = ps.stdout.split('\n').map(s => s.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), executable: m[3] }));
  const owned = row => {
    let current = row;
    for (let i = 0; current && i < 12; i++) {
      if (current.pid === host?.pid) return true;
      current = rows.find(r => r.pid === current.ppid);
    }
    return false;
  };
  const engines = rows.filter(r => /\/(?:ds4|ds4-server|ds4-server-pld|ds4-agent|ds4-agent-jsonl|ds4-cowork|ds4-design|q36|q36-server|q27|DStudio|dstudio)$/.test(r.executable));
  assert.deepEqual(engines.filter(r => !owned(r)), [], 'Unrelated engine present: stop only this test, never the other process');
}
async function request(endpoint, body, timeout = 5000) {
  const response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: csrfHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  return { status: response.status, body: await response.json() };
}
async function until(fn, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { assert(!problem, problem); const value = await fn(); if (value) return value; await sleep(50); }
  throw new Error(message);
}
async function check(name, fn) {
  const started = performance.now();
  const row = { name, passed: false, started: new Date().toISOString() }; report.cases.push(row); save();
  try { await fn(row); row.passed = true; }
  catch (error) { row.error = error.stack; throw error; }
  finally {
    row.caseElapsedMs = performance.now() - started;
    row.finished = new Date().toISOString();
    save(); console.log(`${row.passed ? 'PASS' : 'FAIL'} ${name}`);
  }
}
async function toolTurn(row, prompt) {
  row.prompt = prompt;
  const started = performance.now();
  // /api/start accepts the child launch before its actual WAITING handshake.
  // A 200 response is not permission to submit into a still-loading runtime.
  row.ready = await until(async () => {
    const state = (await request('/api/status')).body;
    assert.equal(state.residentPid, resident);
    assert.equal(state.engineError, '', state.engineError);
    return state.ready && !state.agentWorking && !state.agentSessionWorking ? state : false;
  }, 'Native tool frontend did not complete its readiness handshake');
  row.submission = await request('/api/agent/send', { prompt, orchestration: 'native' });
  assert.equal(row.submission.status, 200, JSON.stringify(row.submission));
  let since = row.submission.body.from;
  assert.ok(Number.isSafeInteger(since));
  row.transcript = '';
  row.state = await until(async () => {
    const packet = await request(`/api/agent/poll?since=${since}`);
    assert.equal(packet.status, 200);
    assert.ok(packet.body.base <= since, 'Transcript was evicted before observation');
    since = packet.body.len; row.transcript += packet.body.text;
    assert.ok(Buffer.byteLength(row.transcript) <= 2 ** 20, 'Bounded tool transcript exceeded');
    save();
    const state = (await request('/api/status')).body;
    assert.equal(state.residentPid, resident, 'Tool turn replaced its owned model');
    assert.equal(state.engineError, '', state.engineError);
    return !packet.body.working && state.ready && !state.agentWorking ? state : false;
  }, 'Real tool turn exceeded its 240-second deadline', 240000);
  row.elapsedMs = performance.now() - started;
  row.task = (await request(`/api/task?id=${row.submission.body.taskId}`)).body;
  assert.equal(row.task.task?.status, 'completed', JSON.stringify(row.task));
  row.events = [...row.transcript.matchAll(/\x1e([^\n]+)\n/g)].map(m => JSON.parse(m[1]));
  const calls = row.events.filter(event => event.type === 'tool_call');
  const results = row.events.filter(event => event.type === 'tool_result');
  assert.ok(calls.length > 0, 'Model prose is not a tool effect');
  for (const call of calls) assert.ok(results.some(result => result.call_id === call.call_id && result.name === call.name),
    'Tool call has no corresponding result: ' + call.call_id);
}
// Independent OOXML reader, not the Office tool that produced the workbook.
// Accept the standard inline/shared-string representations, but require saved
// numeric values (not unevaluated formulas) for this explicitly values-only task.
const workbookOracle = `import json, posixpath, sys, zipfile, xml.etree.ElementTree as E
n = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
r = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
with zipfile.ZipFile(sys.argv[1]) as z:
    infos = z.infolist()
    assert len(infos) <= 128 and sum(i.file_size for i in infos) <= 8388608
    sheets = E.fromstring(z.read('xl/workbook.xml')).find(n+'sheets')
    assert len(sheets) == 1 and sheets[0].get('name') == 'Workshops'
    rels = {x.get('Id'): x.get('Target') for x in E.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    target = rels[sheets[0].get(r+'id')]
    target = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/'+target)
    assert target.startswith('xl/')
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        shared = [''.join(x.itertext()) for x in E.fromstring(z.read('xl/sharedStrings.xml'))]
    cells = {}
    for c in E.fromstring(z.read(target)).iter(n+'c'):
        assert c.find(n+'f') is None, 'Expected saved values, not formulas'
        t = c.get('t'); v = c.findtext(n+'v')
        if t == 'inlineStr': value = ''.join(x.text or '' for x in c.iter(n+'t'))
        elif t == 's': value = shared[int(v)]
        elif t in ('str', 'e', 'b'): value = v
        else: value = float(v) if v is not None else None
        cells[c.get('r')] = value
    expected = [['Workshop','Registered','Capacity','Remaining'], ['Bookbinding',12,18,6], ['Bicycle care',9,15,6], ['Urban sketching',10,16,6]]
    actual = [[cells.get(chr(65+c)+str(i+1)) for c in range(4)] for i in range(4)]
    assert actual == expected, repr(actual)
    assert not any(value is not None and key not in {chr(65+c)+str(i+1) for c in range(4) for i in range(4)} for key,value in cells.items())
    print(json.dumps({'sheet':'Workshops','rows':actual}))
`;
console.log(`Evidence: ${run}`);
try {
  assert.equal(process.platform, 'darwin', 'Metal unavailable: NOT RUN');
  assert.ok(process.argv.length >= 6 && new Set(options).size === options.length &&
    options.every(arg => ['--tools', '--trace-native', '--browser=webkit', '--browser=chromium'].includes(arg)) &&
    options.filter(arg => arg.startsWith('--browser=')).length <= 1,
    'Supply DStudio test binary, managed q36 tree, model, projector and optional --tools / --browser=webkit|chromium / --trace-native');
  const binary = fs.realpathSync(process.argv[2]), tree = fs.realpathSync(process.argv[3]);
  if (traceNative) assert.equal(path.basename(binary), 'q36-host-trace', 'Use the explicit diagnostic host for native tracing');
  assert.ok(tree.startsWith(fs.realpathSync('tests/.artifacts') + path.sep) && path.basename(tree) === 'q36',
    'This gate prepares model aliases only inside a task-owned artifact installation');
  model = fs.realpathSync(process.argv[4]); projector = fs.realpathSync(process.argv[5]);
  assertIsolation();
  // Hard links add no weight bytes and never move or modify the original files.
  // Cross-filesystem inputs fail explicitly instead of silently copying 26 GB.
  const shared = path.join(path.dirname(tree), 'ds4/gguf'); fs.mkdirSync(shared, { recursive: true });
  for (const [source, name] of [[model, 'Qwen3.8-27B-UD-Q6_K_XL.gguf'], [projector, 'Qwen3.8-27B-mmproj-F16.gguf']]) {
    const target = path.join(shared, name);
    if (!fs.existsSync(target)) fs.linkSync(source, target);
    const a = fs.statSync(source, { bigint: true }), b = fs.statSync(target, { bigint: true });
    assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino);
  }
  modelHash = await hashStableFile(model); projectorHash = await hashStableFile(projector);
  assert.equal(modelHash.bytes, 25299061664);
  assert.equal(modelHash.sha256, '701d8fa9ed214ab21bfc130cd2a7df19ca89bbef7713e2dfb19f3c63696aa917');
  assert.equal(projectorHash.bytes, 927607488);
  assert.equal(projectorHash.sha256, 'cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e');
  report.weights = { model: modelHash, projector: projectorHash };
  const validation = spawnSync(binary, ['--install-engine', 'q36', path.dirname(tree)],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 120000, maxBuffer: 2 ** 20 });
  writeArtifact(run, 'install-check.log', (validation.stdout || '') + (validation.stderr || ''));
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  const receiptFile = path.join(tree, '.dstudio-source.json');
  report.installation = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const inputs = [binary, path.join(tree, 'q36-server'), receiptFile, import.meta.filename,
    'src/dstudio.c', 'src/dstudio_q36.c', 'src/dstudio_launch.c', 'src/dstudio_engine_install.c', 'src/dstudio_model_rpc.c',
    'scripts/install-q36.py', 'scripts/apply-q36-metal-runtime.sh', 'patch/q36-metal-runtime/next-review.patch',
    'scripts/apply-q36-agent-tty.sh', 'patch/q36-agent-tty/monitor.patch', 'patch/q36-agent-tty/monitor-owner.patch',
    'patch/q36-metal-runtime/cache-usage.patch',
    'extension/remote/dstudio_json_tokens.h', 'web/index.html',
    'tests/support/quality_baseline.mjs', 'tests/support/real_harness.mjs',
    'tests/support/cowork_spreadsheet_oracle.mjs', 'tests/support/q36_vision_fixtures.mjs'];
  if (withTools) {
    const main = path.join(path.dirname(tree), 'ds4');
    const build = spawnSync(binary, ['--build-jsonl', main],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 180000, maxBuffer: 2 ** 20 });
    writeArtifact(run, 'native-tools-build.log', (build.stdout || '') + (build.stderr || ''));
    assert.equal(build.status, 0, build.stderr || build.stdout);
    report.toolInstallation = JSON.parse(fs.readFileSync(path.join(main, '.dstudio-source.json'), 'utf8'));
    inputs.push(...['ds4-agent-jsonl', 'ds4-cowork', 'ds4_agent.c', 'ds4.c', 'Makefile', '.dstudio-source.json'].map(file => path.join(main, file)),
      'patch/ds4-agent-jsonl/manifest', 'patch/ds4-agent-jsonl/remote-tools.cfrag', 'patch/ds4-agent-jsonl/remote-agent.cfrag',
      'patch/ds4-agent-jsonl/remote-vision.patch',
      'extension/remote/dstudio_remote_llm.c', 'extension/remote/dstudio_remote_llm.h',
      'extension/cowork/office_tool.py', 'extension/cowork/COWORK.md', 'extension/cowork/document_table.py');
  }
  report.inputs = Object.fromEntries(inputs.map(file => [path.resolve(file), hash(file)])); save(); assertIsolation();
  const port = await freePort(), enginePort = await freePort(); base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DS4|DSTUDIO_|Q36_|DYLD_|LD_)/.test(key)));
  Object.assign(env, { DS4UI_DATA_DIR: path.join(run, 'profile'), DSTUDIO_KV_DIR: path.join(run, 'kv'),
    DS4UI_NO_WINDOW: '1', DS4UI_DEFER_ENGINE_START: '1', DS4UI_TEST_MODE: '1', DS4UI_HOST: '127.0.0.1' });
  if (traceNative) {
    report.diagnostic = { source: 'tests/support/q36_host_trace.c', path: path.join(run, 'native-trace.log'),
      maxBytes: 8 * 1024 * 1024, qualification: false };
    env.DSTUDIO_TEST_Q36_TRACE = report.diagnostic.path;
    report.inputs[path.resolve(report.diagnostic.source)] = hash(report.diagnostic.source);
  }
  const log = fs.openSync(path.join(run, 'host.log'), 'wx');
  host = spawn(binary, [String(port), tree], { cwd: process.cwd(), env, stdio: ['ignore', log, log] }); fs.closeSync(log);
  report.hostPid = host.pid;
  terminal = new Promise(resolve => { host.once('exit', (code, signal) => resolve({ code, signal })); host.once('error', e => resolve({ error: e.message })); });
  // Extra scenarios receive their own declared budget; existing request and
  // Stop deadlines are unchanged. These are development runs, not speed claims.
  report.deadlineMs = 360000 + (browserName ? 2 * 45000 : 0) + (withTools ? 540000 + 4 * 240000 : 0);
  timer = setTimeout(() => signalHost(`${report.deadlineMs}-ms bounded live gate deadline`), report.deadlineMs);
  watcher = setInterval(() => {
    try {
      assertIsolation();
      if (traceNative && fs.existsSync(report.diagnostic.path))
        assert.ok(fs.statSync(report.diagnostic.path).size <= report.diagnostic.maxBytes, 'Native diagnostic trace exceeded its size bound');
    } catch (e) { signalHost(e.message); }
  }, 1000);
  await until(async () => { try { return (await request('/api/status')).status === 200; } catch { return false; } }, 'Host did not listen');
  const config = { mode: 'server', gguf: 'gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf', ctx: 8192, power: 100,
    port: enginePort, kvSpaceMb: 256, kvMinTokens: 128, think: 'off', ssdStreaming: 'off' };
  await check('host launches its verified real model and publishes private readiness', async row => {
    const started = performance.now(); row.request = config; row.launch = await request('/api/start', config, 150000);
    row.launchMs = performance.now() - started; assert.equal(row.launch.status, 200, JSON.stringify(row.launch.body));
    row.state = (await request('/api/status')).body; resident = row.state.residentPid;
    assert.ok(resident > 0); assert.equal(row.state.ready, true); assert.equal(row.state.modelFile, config.gguf);
    assert.equal(row.state.ds4dir, tree); assert.equal(row.state.config.ctx, config.ctx);
    assert.equal(row.state.config.ssdStreamingEffective, false); assert.equal(row.state.nativeVisionActive, true);
    assert.equal(row.launch.body.residentPid, resident);
    if (traceNative) assert.ok(fs.existsSync(report.diagnostic.path), 'Diagnostic host did not enable the actual native trace');
    row.nativeCommand = spawnSync('/bin/ps', ['-p', String(resident), '-o', 'command='], { encoding: 'utf8' }).stdout.trim();
    row.installationLease = probeInstallationLease(tree);
    assert.equal(row.installationLease.acquired, false, 'The real native process must retain its lease through exec');
  });
  await check('the same-origin model catalog belongs to the admitted Qwen server', async row => {
    row.response = await request('/v1/models'); assert.equal(row.response.status, 200);
    assert.equal(row.response.body.data[0].id, 'qwen3.8-27b');
    assert.equal(row.response.body.data[0].context_length, 8192);
  });
  for (const [question, expected] of [
    ['The exact identifier is CEDAR-4628. Return only that identifier, with no explanation.', 'CEDAR-4628'],
    ['Compute 17 + 26. Return only the integer, with no explanation.', '43'],
  ]) await check('real response through DStudio: ' + expected, async row => {
    row.request = { model: 'qwen3.8-27b', messages: [{ role: 'user', content: question }], temperature: 0,
      top_p: 1, top_k: 0, min_p: 0, seed: 1, max_tokens: 32, think: false };
    row.expected = expected; const started = performance.now();
    row.response = await request('/v1/chat/completions', row.request, 45000); row.elapsedMs = performance.now() - started;
    assert.equal(row.response.status, 200, JSON.stringify(row.response.body));
    assert.equal(row.response.body.model, 'qwen3.8-27b');
    assert.equal(row.response.body.choices[0].message.content.trim(), expected);
    assert.equal(row.response.body.choices[0].finish_reason, 'stop');
    assert.ok(row.response.body.usage.completion_tokens > 0);
  });
  await check('real SSE streaming preserves answer bytes and its terminal event', async row => {
    row.expected = 'CYPRESS-2815';
    row.request = { model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'Return only CYPRESS-2815, exactly as written.' }],
      temperature: 0, top_p: 1, top_k: 0, min_p: 0, seed: 1, max_tokens: 32, think: false, stream: true,
      stream_options: { include_usage: true } };
    const started = performance.now();
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: csrfHeaders,
      body: JSON.stringify(row.request), signal: AbortSignal.timeout(45000) });
    row.status = response.status; assert.equal(response.status, 200);
    row.raw = ''; for await (const chunk of response.body) { row.raw += Buffer.from(chunk).toString('utf8'); assert(row.raw.length <= 65536); }
    row.elapsedMs = performance.now() - started;
    const events = row.raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
    assert.equal(events.at(-1), '[DONE]');
    const frames = events.filter(line => line !== '[DONE]').map(line => JSON.parse(line));
    row.answer = frames.map(frame => frame.choices?.[0]?.delta?.content || '').join('');
    assert.equal(row.answer.trim(), row.expected);
    assert.ok(frames.some(frame => frame.choices?.[0]?.finish_reason === 'stop'));
  });
  await check('a repeated launch reuses the real resident model', async row => {
    row.sharedLease = probeInstallationLease(tree, true);
    assert.equal(row.sharedLease.acquired, true, 'Read-only preparation must remain available during inference');
    row.launch = await request('/api/start', config, 30000);
    assert.equal(row.launch.status, 200); assert.equal(row.launch.body.reused, true); assert.equal(row.launch.body.residentPid, resident);
    assert.equal((await request('/api/status')).body.ready, true);
    row.exclusiveLease = probeInstallationLease(tree);
    assert.equal(row.exclusiveLease.acquired, false, 'Verification must not release the actual engine lease');
  });
  async function browserChatCase(row, pixelIndex) {
    const playwright = await import('playwright');
    const browser = await playwright[browserName].launch();
    let page;
    row.requests = []; row.pageErrors = []; row.browser = browserName;
    const pixels = pixelIndex === undefined ? null : q36VisionPNG(pixelIndex);
    row.expected = pixels ? ['red', 'blue'][pixelIndex] : 'BIRCH-6942';
    row.prompt = pixels ? 'Look at the attached image. Return only its dominant color in lowercase English, without punctuation or explanation.'
      : 'Return only the exact identifier BIRCH-6942. No explanation or extra punctuation.';
    if (pixels) {
      row.sourceSHA256 = crypto.createHash('sha256').update(pixels).digest('hex');
      fs.writeFileSync(path.join(run, `browser-source-${pixelIndex}.png`), pixels, {flag: 'wx'});
    }
    try {
      page = await browser.newPage({viewport: {width: 1440, height: 1000}});
      page.on('pageerror', error => row.pageErrors.push(String(error)));
      page.on('request', req => {
        if (req.url() !== base + '/v1/chat/completions') return;
        try {
          assert.ok(row.requests.length < 8, 'Unexpected repeated inference requests');
          const body = req.postData(); assert.ok(body && body.length <= 65536, 'Unexpected UI prompt growth');
          row.requests.push({url: req.url(), body: JSON.parse(body)});
        } catch (error) { row.requestError = String(error); }
      });
      await page.addInitScript(({origin, tree, modelFile}) => {
        if (window.top !== window || location.origin !== origin) return;
        localStorage.setItem('ds4web.settings.v2', JSON.stringify({v: 2, onboarded: true,
          theme: 'dark', chatBackend: 'local', baseUrl: origin, model: 'qwen3.8-27b', modelGguf: modelFile,
          modelEngineDir: tree, modelVariant: 'flash', ctxSize: 8192, thinkLevel: 'off',
          enginePower: 100, ssdStreaming: 'off', dspark: false, metalHotlistSeed: false,
          webMode: 'off', temperature: 0, maxTokens: 32, systemPrompt: 'Answer exactly as requested.'}));
      }, {origin: base, tree, modelFile: config.gguf});
      await page.goto(base, {waitUntil: 'domcontentloaded'});
      const picker = page.locator('#cbar-model .cbar-model-btn');
      await picker.filter({hasText: 'Qwen3.8-27B'}).waitFor({timeout: 10000});
      await picker.click();
      const menu = page.getByRole('dialog', {name: 'Choose a model'});
      const loaded = menu.getByRole('region', {name: 'Loaded'}).locator('.cbar-model-item').filter({hasText: 'Qwen3.8-27B'});
      await loaded.waitFor();
      assert.equal(await loaded.count(), 1);
      assert.doesNotMatch(await menu.innerText(), /mmproj|Qwen3\.8-Flash-Next/);
      await page.screenshot({path: path.join(run, 'browser-model-selected.png')});
      await loaded.click();
      await menu.waitFor({state: 'hidden'});
      // The two cases keep the same filename and prompt; only pixels differ.
      // Use a real new conversation so an earlier answer cannot satisfy the
      // store oracle or leak into the next model request as history.
      if (pixels) {
        await page.locator('#btn-new-chat').click();
        await page.locator('#chat-file-input').setInputFiles({name: 'input.png', mimeType: 'image/png', buffer: pixels});
        await page.locator('.composer__file-name').filter({hasText: 'input.png'}).waitFor();
      }
      const priorChats = new Set(((await request('/api/store')).body.data?.chats || []).map(chat => chat.id));
      await page.locator('#composer-input').fill(row.prompt);
      await page.locator('#btn-send').click();
      // Verify the owner's saved conversation, not the prompt or an optimistic
      // streaming frame, then independently check the rendered assistant node.
      row.answer = await until(async () => {
        assert.ok(!row.requestError, row.requestError);
        const store = (await request('/api/store')).body;
        for (const chat of store.data?.chats || []) {
          if (pixels && priorChats.has(chat.id)) continue;
          const messages = chat.messages || [], index = messages.findIndex(m => m.role === 'user' && m.content === row.prompt);
          const answer = index >= 0 ? messages[index + 1] : null;
          if (answer?.role === 'assistant' && answer.content && !answer.streaming && answer.status !== 'streaming') {
            row.chatId = chat.id; row.savedUser = messages[index]; return answer;
          }
        }
        return false;
      }, 'The actual browser response was not durably saved', 45000);
      assert.equal(row.answer.error || '', '');
      assert.equal(!!row.answer.incomplete, false);
      assert.equal(row.answer.content.trim(), row.expected);
      const rendered = page.locator('.msg--assistant .msg__content').last();
      assert.equal((await rendered.innerText()).trim(), row.expected);
      assert.equal(row.requests.length, 1);
      assert.equal(row.requests[0].body.model, 'qwen3.8-27b');
      assert.equal(row.requests[0].body.think, false); assert.equal(row.requests[0].body.temperature, 0);
      if (pixels) {
        const images = row.requests[0].body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .filter(part => part.type === 'image_url');
        assert.equal(images.length, 1, 'The fresh conversation must send exactly its current image');
        const uri = images[0].image_url.url;
        assert.match(uri, /^data:image\/(png|jpeg);base64,/);
        row.wireImageSHA256 = crypto.createHash('sha256').update(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')).digest('hex');
        assert.equal(row.savedUser.attachments?.filter(item => item.kind === 'image').length, 1);
      }
      row.after = (await request('/api/status')).body;
      assert.equal(row.after.residentPid, resident); assert.equal(row.after.ready, true);
      assert.equal(row.after.modelFile, config.gguf); assert.equal(row.after.config.ctx, 8192);
      assert.deepEqual(row.pageErrors, []);
      row.screenshot = path.join(run, pixels ? `browser-pixels-${pixelIndex}-dark.png` : 'browser-answer-dark.png');
      await page.screenshot({path: row.screenshot});
    } catch (error) {
      await page?.screenshot({path: path.join(run, 'browser-failure.png')}).catch(() => {});
      throw error;
    } finally { await browser.close(); }
  }
  if (browserName) {
    await check('the real UI selects, requests, renders and persists an exact answer from the resident 27B', row => browserChatCase(row));
    for (const index of [0, 1]) await check(`the real UI sends pixel-only image ${index + 1} and persists its independently checked color`,
      row => browserChatCase(row, index));
  }
  if (withTools) {
    const agentWork = path.join(run, 'agent-workspace'), coworkWork = path.join(run, 'cowork-workspace');
    fs.mkdirSync(agentWork); fs.mkdirSync(coworkWork);
    const verifier = `from total import total\nassert total(7,6,2) == 44\nassert total(11,0,4) == 4\nassert total(0,9,3) == 3\nassert total(2.5,4,1) == 11\nprint('VERIFIED_4_CASES')\n`;
    fs.writeFileSync(path.join(agentWork, 'total.py'), 'def total(unit_price, quantity, handling):\n    return unit_price + quantity + handling\n');
    fs.writeFileSync(path.join(agentWork, 'verify.py'), verifier);
    const sourceCsv = 'Workshop,Registered,Capacity\nBookbinding,12,18\nBicycle care,9,15\nUrban sketching,10,16\n';
    fs.writeFileSync(path.join(coworkWork, 'workshops.csv'), sourceCsv);
    async function imageTurns(mode, work, indices) {
      for (let n = 0; n < indices.length; n++) await check(`real ${mode} reads pixel-only image ${n + 1} with the selected projector`, async row => {
        const index = indices[n], filename = `observation-${n + 1}.png`, file = path.join(work, filename);
        const pixels = q36VisionPNG(index); fs.writeFileSync(file, pixels, { flag: 'wx' });
        row.imageSHA256 = hash(file); row.imageBytes = pixels.length;
        row.expected = ['red', 'blue', 'blue,red', 'red'][index];
        const question = index === 2
          ? 'Name the color on the left and the color on the right, in that order. Reply with the two lowercase color names separated by a comma only.'
          : 'What single color fills the image? Reply with one lowercase color word only.';
        // File names/PNG metadata and prompts contain no expected color. Use
        // the vision tool, not shell pixel inspection or a supplied text label.
        await toolTurn(row, `Use view_image to inspect ${filename}. ${question}`);
        const calls = row.events.filter(e => e.type === 'tool_call');
        assert(calls.every(e => e.name === 'view_image'), 'Pixel test must use the actual visual observation tool, not another inspection path');
        assert(calls.some(e => e.input.path === filename || e.input.path === file));
        const terminalResults = [...row.transcript.matchAll(/\x1e([^\n]+)\n/g)]
          .filter(m => JSON.parse(m[1]).type === 'tool_result');
        assert(terminalResults.length > 0);
        assert(row.events.some(e => e.type === 'tool_result' && e.name === 'view_image' && e.output.startsWith('Image bytes attached')));
        const last = terminalResults.at(-1);
        row.answer = row.transcript.slice(last.index + last[0].length).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
        assert.equal(row.answer.replace(/\s*,\s*/g, ','), row.expected);
        assert.equal(hash(file), row.imageSHA256, 'The tool must not change original pixels');
      });
    }
    await check('real Agent fixes the program and executes its unchanged regression tests without reloading the model', async row => {
      row.initialVerification = spawnSync('python3', ['-B', '-c', verifier], { cwd: agentWork, encoding: 'utf8', timeout: 5000 });
      assert.equal(row.initialVerification.status, 1, 'The initial fixture must actually fail');
      row.launch = await request('/api/start', { ...config, mode: 'agent', workdir: agentWork }, 30000);
      assert.equal(row.launch.status, 200, JSON.stringify(row.launch));
      assert.equal(row.launch.body.reused, true); assert.equal(row.launch.body.residentPid, resident);
      await toolTurn(row, 'Read total.py and verify.py. Fix total.py: the total must be unit_price multiplied by quantity, plus handling once. Do not change verify.py. Run python3 -B verify.py with your tools and report the actual result. Make the change on disk, not just in your reply.');
      assert.equal(fs.readFileSync(path.join(agentWork, 'verify.py'), 'utf8'), verifier);
      row.fixedSource = fs.readFileSync(path.join(agentWork, 'total.py'), 'utf8');
      row.verification = spawnSync('python3', ['-B', '-c', verifier], { cwd: agentWork, encoding: 'utf8', timeout: 5000 });
      assert.equal(row.verification.status, 0, row.verification.stderr);
      assert.equal(row.verification.stdout.trim(), 'VERIFIED_4_CASES');
      assert.ok(row.events.some(e => e.type === 'tool_result' && /^bash(?:_|$)/.test(e.name) && e.output.includes('VERIFIED_4_CASES')),
        'Agent must actually execute the requested verification, not merely edit the file');
    });
    await imageTurns('Agent', agentWork, [0, 1]);
    await check('real Cowork reads a CSV and exports an independently reopened XLSX using its Office tools', async row => {
      row.launch = await request('/api/start', { ...config, mode: 'cowork', workdir: coworkWork }, 30000);
      assert.equal(row.launch.status, 200, JSON.stringify(row.launch));
      assert.equal(row.launch.body.reused, true); assert.equal(row.launch.body.residentPid, resident);
      await toolTurn(row, 'Use your spreadsheet tools to read workshops.csv and create workshops.xlsx with exactly one sheet named Workshops. Preserve the three rows and their order. Columns must be Workshop, Registered, Capacity, Remaining. Remaining is Capacity minus Registered. Write numeric values, not formulas, and do not add a totals row. Reopen the saved workbook with your spreadsheet tool to verify it. Do not modify workshops.csv.');
      assert.equal(fs.readFileSync(path.join(coworkWork, 'workshops.csv'), 'utf8'), sourceCsv);
      const workbook = path.join(coworkWork, 'workshops.xlsx');
      assert.ok(fs.statSync(workbook).size < 2 ** 20);
      row.verification = spawnSync('python3', ['-c', workbookOracle, workbook], { encoding: 'utf8', timeout: 5000 });
      assert.equal(row.verification.status, 0, row.verification.stderr);
      row.workbook = JSON.parse(row.verification.stdout); row.workbookSHA256 = hash(workbook);
      row.officeWorkflow = assertSpreadsheetWorkflow(row.events, {
        sourcePath:'workshops.csv', sourceRows:sourceCsv.trimEnd().split('\n').map(line => line.split(',')),
        outputPath:'workshops.xlsx', outputRows:row.workbook.rows,
      });
      assert.ok(!row.events.some(e => e.type === 'tool_call' && /^bash(?:_|$)/.test(e.name)));
    });
    await imageTurns('Cowork', coworkWork, [1, 2]);
    await check('Chat still answers correctly after the real Agent and Cowork tool loops with the same model process', async row => {
      row.launch = await request('/api/start', config, 30000);
      assert.equal(row.launch.status, 200); assert.equal(row.launch.body.reused, true); assert.equal(row.launch.body.residentPid, resident);
      row.request = { model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'Return only MAPLE-7531, exactly as written.' }],
        temperature: 0, top_p: 1, top_k: 0, min_p: 0, seed: 1, max_tokens: 32, think: false };
      row.response = await request('/v1/chat/completions', row.request, 45000);
      assert.equal(row.response.status, 200); assert.equal(row.response.body.model, 'qwen3.8-27b');
      assert.equal(row.response.body.choices[0].message.content.trim(), 'MAPLE-7531');
      assert.equal(row.response.body.choices[0].finish_reason, 'stop');
    });
  }
  await check('host Stop releases the actual owned model and its port', async row => {
    const started = performance.now(); row.response = await request('/api/stop', {}, 2000); assert.equal(row.response.status, 200);
    row.state = await until(async () => { const s = (await request('/api/status')).body; return !s.running && !s.residentPid ? s : false; }, 'Owned engine did not stop', 7000);
    row.stopMs = performance.now() - started; assert.equal(row.state.ready, false);
    const listener = net.createServer();
    try { await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(enginePort, '127.0.0.1', resolve); }); }
    finally { if (listener.listening) await new Promise(resolve => listener.close(resolve)); }
    row.installationLease = probeInstallationLease(tree);
    assert.equal(row.installationLease.acquired, true, 'Actual engine exit must release update admission');
    resident = 0;
  });
  for (const [file, before] of Object.entries(report.inputs)) assert.equal(hash(file), before, 'Input changed: ' + file);
  assert.equal(fileIdentity(fs.statSync(model, { bigint: true })), modelHash.identity);
  assert.equal(fileIdentity(fs.statSync(projector, { bigint: true })), projectorHash.identity);
  assert(!problem, problem); report.passed = true;
} catch (error) { report.error = error.stack; console.error(report.error); process.exitCode = 1; }
finally {
  clearTimeout(timer); clearInterval(watcher);
  if (host && host.exitCode === null && host.signalCode === null) {
    try { await request('/api/stop', {}); } catch {}
    host.kill('SIGTERM'); report.hostExit = await Promise.race([terminal, sleep(6000).then(() => null)]);
    if (!report.hostExit) { host.kill('SIGKILL'); report.hostExit = await terminal; }
  }
  // A failed or timed-out run still needs input provenance. Never make a
  // later successful artifact audit overwrite the original failure receipt.
  report.changedInputs = [];
  for (const [file, expected] of Object.entries(report.inputs || {})) {
    try { if (hash(file) !== expected) report.changedInputs.push({ file, reason: 'hash changed' }); }
    catch (error) { report.changedInputs.push({ file, reason: String(error) }); }
  }
  if (report.changedInputs.length) {
    report.passed = false;
    report.inputAuditError = 'Inputs changed during the run';
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString(); save();
  console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.cases.filter(c => c.passed).length}/${report.plannedChecks}: ${run}`);
}
