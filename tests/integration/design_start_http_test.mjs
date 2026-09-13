// Real native HTTP validation and task state, with an empty engine directory.
// No model, downloads or inference are used or claimed by this regression.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { freePort, sleep, csrfHeaders } from '../support/real_harness.mjs';

const parent = path.resolve('tests/.artifacts/design-start');
fs.mkdirSync(parent, { recursive: true });
const run = fs.mkdtempSync(path.join(parent, 'http-'));
const engine = path.join(run, 'empty engine'), workspace = path.join(run, 'workspace');
fs.mkdirSync(engine); fs.mkdirSync(workspace);
fs.writeFileSync(path.join(engine, 'Makefile'), 'all:\n\t@false\n');
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
const log = fs.openSync(path.join(run, 'host.log'), 'wx');
const child = spawn(binary, [String(port), engine], {
  cwd: process.cwd(), detached: true, stdio: ['ignore', log, log],
  env: { ...process.env, DS4UI_DATA_DIR: path.join(run, 'profile'), DS4UI_NO_WINDOW: '1',
    DS4UI_HOST: '127.0.0.1', DS4UI_TEST_MODE: '1', DS4UI_DEFER_ENGINE_START: '1' },
});
fs.closeSync(log);
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
const report = { schema: 'dstudio.design-start-regression.v1', inference: false,
  binarySHA256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), cases: [] };
async function request(endpoint, body) {
  const res = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST',
    headers: csrfHeaders, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000) });
  return { status: res.status, body: await res.json() };
}
const ownedState = s => Object.fromEntries(['running', 'mode', 'modelFile', 'variant', 'skill', 'designSystem', 'config', 'workdir'].map(k => [k, s[k]]));
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await request('/api/status')).status === 200; if (ready) break; } catch {}
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  assert.ok(ready, 'native host failed to become ready');
  const initial = (await request('/api/status')).body;
  assert.equal(initial.running, false);
  const cases = [
    ['retired style', { designSystem: 'retired-import' }, 400],
    ['unknown style', { designSystem: 'unknown-original' }, 400],
    ['invalid style path', { designSystem: '../folio' }, 400],
    ['missing workspace', { workdir: path.join(run, 'missing') }, 400],
    ['invalid context', { ctx: 1 }, 400],
    ['invalid variant', { variant: 'not-a-model' }, 400],
    ['missing selected checkpoint', { gguf: 'gguf/DeepSeek-V4-Flash-missing.gguf' }, 400],
    ['unsupported model component', { gguf: 'gguf/Qwen3.8-Flash-Next-PLE-Q4_1.gguf' }, 400],
  ];
  for (const [name, extra, status] of cases) {
    const row = { name }, before = (await request('/api/status')).body;
    const beforeTasks = (await request('/api/tasks')).body.tasks;
    try {
      row.request = { mode: 'design', workdir: workspace, variant: before.variant === 'flash' ? 'pro' : 'flash',
        skill: 'must-not-publish', ctx: 65536, ...extra };
      row.response = await request('/api/start', row.request);
      assert.equal(row.response.status, status);
      assert.equal(row.response.body.ok, false);
      row.after = (await request('/api/status')).body;
      assert.deepEqual(ownedState(row.after), ownedState(before), 'rejected launch changed the active configuration');
      const afterTasks = (await request('/api/tasks')).body.tasks;
      assert.deepEqual(afterTasks, beforeTasks, 'validation must not admit a task');
      row.status = 'PASS';
    } catch (error) { row.status = 'FAIL'; row.error = error.message; }
    report.cases.push(row);
    console.log(`${name}: ${row.status}${row.error ? ': ' + row.error : ''}`);
  }
  const catalog = await request('/api/design-systems');
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.designSystems.some(s => s.id === 'folio'));
  assert.ok(catalog.body.catalogIds.includes('folio'));
  const packRoot = path.join(run, 'isolated assets');
  const pack = path.join(packRoot, 'extension/design-systems/folio');
  fs.mkdirSync(path.join(packRoot, 'extension/design'), { recursive: true });
  fs.writeFileSync(path.join(packRoot, 'extension/design/build-design.sh'), '#!/bin/sh\nexit 87\n');
  assert.equal((await request('/api/webdir', { path: packRoot })).status, 200);
  for (const [name, files] of [
    ['missing pack', []],
    ['incomplete pack', ['DESIGN.md']],
  ]) {
    const row = { name };
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(pack, file)), { recursive: true });
      fs.writeFileSync(path.join(pack, file), 'Original fixture\n');
    }
    try {
      const before = (await request('/api/status')).body;
      const beforeTasks = (await request('/api/tasks')).body.tasks;
      row.response = await request('/api/start', { mode: 'design', designSystem: 'folio', workdir: workspace });
      assert.equal(row.response.status, 409);
      assert.equal(row.response.body.code, 'design_system_incomplete');
      assert.deepEqual(ownedState((await request('/api/status')).body), ownedState(before));
      assert.deepEqual((await request('/api/tasks')).body.tasks, beforeTasks);
      const currentCatalog = (await request('/api/design-systems')).body;
      assert.ok(currentCatalog.catalogIds.includes('folio'), 'missing assets must not retire a supported style');
      assert.ok(!currentCatalog.designSystems.some(s => s.id === 'folio' && s.available !== false));
      row.status = 'PASS';
    } catch (error) { row.status = 'FAIL'; row.error = error.message; }
    report.cases.push(row); console.log(`${name}: ${row.status}`);
  }
  for (const file of ['DESIGN.md', 'tokens.css', 'components.html', 'assets/preview.js', 'references/recipes.md']) {
    fs.mkdirSync(path.dirname(path.join(pack, file)), { recursive: true });
    fs.writeFileSync(path.join(pack, file), 'Complete local fixture\n');
  }
  // Presence checks must succeed so the negative really reaches a child build.
  // These are explicitly tiny fixture bytes, never passed to an inference engine.
  assert.ok(initial.modelFile && !path.isAbsolute(initial.modelFile) && !initial.modelFile.includes('..'));
  const fixtureModel = path.join(engine, initial.modelFile);
  fs.mkdirSync(path.dirname(fixtureModel), { recursive: true });
  fs.writeFileSync(fixtureModel, 'not model weights\n', { flag: 'wx' });
  fs.mkdirSync(path.join(packRoot, 'scripts'));
  for (const script of ['apply-ds4-glm53-m2max.sh', 'apply-ds4-vision-streaming.sh'])
    fs.writeFileSync(path.join(packRoot, 'scripts', script), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(packRoot, 'extension/design/build-design.sh'),
    '#!/bin/sh\nprintf "%s\\n" "$1" >> "$DS4_DIR/build-attempts"\nexit 87\n');
  let buildAttempts = 0;
  for (const style of ['folio', '', 'none']) {
    const row = { name: `valid style ${style || '(default)'}: downstream failure terminates task` };
    try {
      const before = (await request('/api/status')).body;
      row.response = await request('/api/start', { mode: 'design', designSystem: style, workdir: workspace });
      assert.equal(row.response.status, 409, 'the deliberately failing build cannot launch a model');
      assert.ok(row.response.body.taskId, 'a valid request is admitted before the deliberate build failure');
      assert.deepEqual(fs.readFileSync(path.join(engine, 'build-attempts'), 'utf8').trim().split('\n'),
        Array(++buildAttempts).fill('build'), 'exactly one real build child must execute per admitted launch');
      const task = (await request('/api/task?id=' + row.response.body.taskId)).body.task;
      assert.equal(task.status, 'failed');
      // Preparation failure is now before publication, not merely before exec.
      // Preserve every active setting, including the previous style.
      assert.deepEqual(ownedState((await request('/api/status')).body), ownedState(before));
      assert.equal((await request('/api/status')).body.running, false);
      row.status = 'PASS';
    } catch (error) { row.status = 'FAIL'; row.error = error.message; }
    report.cases.push(row); console.log(`${row.name}: ${row.status}`);
  }
} finally {
  if (child.exitCode === null && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => {
    if (child.exitCode === null && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    resolve();
  }, 10000); })]);
  clearTimeout(timer);
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Preserved native HTTP evidence: ${run}`);
}
process.exitCode = report.cases.every(c => c.status === 'PASS') ? 0 : 1;
