// The tools the actual native runtimes declare to the model. Cowork refuses
// bash/bash_status/bash_stop, so its prompt must not declare them; Agent keeps
// them. A real run showed the mismatch: Cowork called bash, got "bash is
// unavailable" and later reasoned for thousands of tokens about whether the
// listed tool existed (tests/.artifacts/cowork-quality-real/run-AFmGNa and
// run-d1MriS, retained). Model frames are SIMULATED; no inference.
//   node tests/integration/cowork_tool_prompt_test.mjs <ds4-cowork> <ds4-agent-jsonl>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const cowork = fs.realpathSync(process.argv[2] || path.join(root, 'ds4/ds4-cowork'));
const agent = fs.realpathSync(process.argv[3] || path.join(root, 'ds4/ds4-agent-jsonl'));
const output = artifactRunDir('cowork-tool-prompt');
const receipt = { scope: 'Real native Cowork/Agent runtimes; SIMULATED model frames; no inference', cowork, agent, rows: [] };
const frame = (value) => '\x1e' + JSON.stringify(value) + '\n';
const SHELL = ['bash', 'bash_status', 'bash_stop'];
const CLOSE = '</｜DSML｜parameter>';
const dsmlBash = '<｜DSML｜tool_calls><｜DSML｜invoke name="bash">' +
  `<｜DSML｜parameter name="command" string="true">ls${CLOSE}</｜DSML｜invoke></｜DSML｜tool_calls>`;

// One turn; returns every model request body and the runtime's stdout.
async function turn(binary, runtime, protocol, work, { callBash = false } = {}) {
  const child = spawn(binary, ['--non-interactive', '--jsonl', '--remote-base-url', 'http://127.0.0.1:1',
    '--remote-model', 'prompt-fixture', '--nothink', '-c', '8192', '-n', '256', '--chdir', work, '--prompt', 'List the files.'],
  { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DS4UI_REMOTE_TOOL_PROTOCOL: protocol,
    DS4UI_RUNTIME_NAME: runtime, DS4UI_REMOTE_VISION: '', DSTUDIO_STEER_PORT: '', DSTUDIO_STEER_KEY: '',
    DS4UI_COWORK_HELPER: path.join(root, 'src/harness/cowork/office_tool.py'), DS4UI_SESSION_CACHE_DIR: path.join(work, 'sessions') } });
  let tail = '', stdout = '';
  const requests = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += d; tail += d;
    const lines = tail.split('\n'); tail = lines.pop();
    for (const line of lines) {
      const at = line.indexOf('\x1e'); if (at < 0) continue;
      let ev; try { ev = JSON.parse(line.slice(at + 1)); } catch { continue; }
      if (ev.type !== 'model_request') continue;
      requests.push(JSON.parse(ev.body));
      const text = callBash && requests.length === 1 ? dsmlBash : 'Done.';
      child.stdin.write(frame({ type: 'model_delta', id: ev.id, kind: 'content', text }) + frame({ type: 'model_done', id: ev.id, text: 'stop' }));
    }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  return { requests, stdout };
}

const declaredDsml = (system) => [...system.matchAll(/"name": "([a-z_]+)"/g)].map((m) => m[1]);
const declaredStructured = (body) => (body.tools || []).map((t) => t.function?.name);

const cases = [
  ['Cowork DSML prompt declares no shell tool and keeps the file and Office tools', cowork, 'cowork', 'dsml', ({ requests }) => {
    const system = requests[0].messages[0].content;
    const names = declaredDsml(system);
    for (const name of ['read', 'list', 'search', 'write', 'edit']) assert.ok(names.includes(name), `missing ${name}`);
    assert.match(system, /write_document/);
    for (const name of SHELL) assert.ok(!names.includes(name), `declares ${name}`);
    assert.doesNotMatch(system, /For long-running bash commands/);
    return { declared: names };
  }],
  ['Cowork structured tool list declares no shell tool', cowork, 'cowork', 'openai', ({ requests }) => {
    const names = declaredStructured(requests[0]);
    assert.ok(names.includes('read') && names.includes('write_document'), names.join(','));
    for (const name of SHELL) assert.ok(!names.includes(name), `declares ${name}`);
    return { declared: names };
  }],
  ['Agent DSML prompt still declares the shell tools', agent, 'agent', 'dsml', ({ requests }) => {
    const names = declaredDsml(requests[0].messages[0].content);
    for (const name of SHELL) assert.ok(names.includes(name), `missing ${name}`);
    return { declared: names };
  }],
  ['a bash call in Cowork is still refused by the runtime', cowork, 'cowork', 'dsml', ({ requests }) => {
    assert.ok(requests.length >= 2, 'the refusal is returned to the model');
    const results = JSON.stringify(requests[1].messages.slice(1));
    assert.match(results, /bash is unavailable/);
    return {};
  }, { callBash: true }],
];

for (const [label, binary, runtime, protocol, check, options] of cases) {
  const row = { case: label, runtime, protocol };
  receipt.rows.push(row);
  const work = path.join(output, `${receipt.rows.length}-${runtime}-${protocol}`);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'notes.txt'), 'fixture\n');
  try {
    const result = await turn(binary, runtime, protocol, work, options);
    fs.writeFileSync(path.join(work, 'stdout.txt'), result.stdout);
    fs.writeFileSync(path.join(work, 'requests.json'), JSON.stringify(result.requests, null, 2));
    assert.ok(result.requests.length >= 1, 'no model request');
    Object.assign(row, check(result));
    row.status = 'PASS';
  } catch (error) {
    row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1;
  }
  console.log(`${row.status} ${label}${row.error ? `\n${row.error}` : ''}`);
}
writeArtifact(output, 'results.json', receipt);
const passed = receipt.rows.filter((r) => r.status === 'PASS').length;
console.log(`cowork_tool_prompt_test: ${passed}/${receipt.rows.length} passed (real runtimes; simulated model frames); ${output}`);
