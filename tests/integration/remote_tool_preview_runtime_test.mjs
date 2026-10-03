// The actual native Agent and Cowork runtimes in structured remote mode (the
// llama.cpp/MLX path): argument fragments relayed by the host
// (model_tool_delta) must reach the transcript as live stanza frames while the
// call is generated, and the call must still execute only from the validated
// batch. Model frames are SIMULATED; no inference.
//   node tests/integration/remote_tool_preview_runtime_test.mjs <ds4-agent-jsonl>...
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const binaries = process.argv.slice(2).map((p) => fs.realpathSync(p));
assert(binaries.length, 'Supply already-built native Agent binaries; no implicit build or weights');
const output = artifactRunDir('remote-tool-preview-runtime');
const receipt = { scope: 'Real native Agent/Cowork processes and files; SIMULATED model frames; no inference', rows: [] };
const frame = (value) => '\x1e' + JSON.stringify(value) + '\n';
const CONTENT = 'Once upon a time\nthe keeper read "the note" \\ and smiled. é 🦊\n';
const ARGS = JSON.stringify({ path: 'story.md', content: CONTENT });
// Fragments cut inside the key, an escape, a multi-byte character and the value.
const cuts = [3, 11, 25, 40, 41, ARGS.indexOf('é') + 1, ARGS.length - 3];
const fragments = cuts.reduce((parts, at, i) => { parts.push(ARGS.slice(i ? cuts[i - 1] : 0, at)); return parts; }, []);
fragments.push(ARGS.slice(cuts.at(-1)));

for (const binary of binaries) for (const runtime of ['agent', 'cowork']) {
  const row = { binary, runtime, status: 'running' };
  receipt.rows.push(row);
  const work = path.join(output, `${receipt.rows.length}-${runtime}`); fs.mkdirSync(work, { recursive: true });
  const child = spawn(binary, ['--non-interactive', '--jsonl', '--remote-base-url', 'http://127.0.0.1:1',
    '--remote-model', 'preview-fixture', '--nothink', '-c', '8192', '-n', '256', '--chdir', work, '--prompt', 'Write the story.'],
    { cwd: work, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      DS4UI_REMOTE_TOOL_PROTOCOL: 'openai', DS4UI_RUNTIME_NAME: runtime, DS4UI_REMOTE_VISION: '',
      DS4UI_COWORK_HELPER: path.join(root, 'src/harness/cowork/office_tool.py'),
      DSTUDIO_STEER_PORT: '', DSTUDIO_STEER_KEY: '', DS4UI_SESSION_CACHE_DIR: path.join(work, 'sessions') } });
  let stdout = '', stderr = '', tail = '', requests = 0, failure = null, writeName = 'write';
  const events = [];
  const fail = (error) => { failure ||= error; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const timer = setTimeout(() => fail(new Error('preview runtime test exceeded 20 seconds')), 20000);
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (bytes) => {
    try {
      stdout += bytes; tail += bytes;
      const lines = tail.split('\n'); tail = lines.pop();
      for (const line of lines) {
        const at = line.indexOf('\x1e'); if (at < 0) continue;
        const event = JSON.parse(line.slice(at + 1)); events.push(event);
        if (event.type !== 'model_request') continue;
        requests++;
        if (requests === 1) {
          const names = JSON.parse(event.body).tools.map((t) => t.function.name);
          assert.ok(names.includes(writeName), `${runtime} has a write tool`);
          fragments.forEach((text, i) => child.stdin.write(frame({ type: 'model_tool_delta', id: event.id, index: 0,
            ...(i ? {} : { name: writeName, call_id: 'w1' }), text })));
          child.stdin.write(frame({ type: 'model_tool_calls', id: event.id,
            text: JSON.stringify([{ id: 'w1', type: 'function', function: { name: writeName, arguments: ARGS } }]) }) +
            frame({ type: 'model_done', id: event.id, text: 'tool_calls' }));
        } else {
          child.stdin.write(frame({ type: 'model_delta', id: event.id, kind: 'content', text: 'Saved.' }) +
            frame({ type: 'model_done', id: event.id, text: 'stop' }));
        }
      }
    } catch (error) { fail(error); }
  });
  const result = await closed; clearTimeout(timer);
  try {
    if (failure) throw failure;
    row.exit = result;
    assert.equal(requests, 2, 'one tool round, then the answer');
    const types = events.map((e) => e.type);
    const begin = types.indexOf('tool_call_begin'), executed = types.indexOf('tool_call');
    assert.ok(begin >= 0, 'the preview starts while the call is generated');
    assert.ok(executed > begin, 'the call executes after its preview, from the validated batch');
    assert.equal(events[begin].name, writeName);
    const params = events.slice(begin, executed).filter((e) => e.type === 'tool_call_param').map((e) => [e.param, e.path]);
    assert.deepEqual(params, [['path', ''], ['content', 'story.md']]);
    const body = events.slice(begin, executed).filter((e) => e.type === 'tool_body_delta').map((e) => e.text).join('');
    assert.equal(body, CONTENT, 'the previewed text is exactly the written text');
    assert.equal(fs.readFileSync(path.join(work, 'story.md'), 'utf8'), CONTENT);
    row.status = 'PASS';
  } catch (error) { row.status = 'FAIL'; row.error = String(error.stack || error); row.stderr = stderr.slice(-2000); process.exitCode = 1; }
  fs.writeFileSync(path.join(work, 'stdout.txt'), stdout);
  writeArtifact(output, 'results.json', receipt);
  console.log(`${row.status} ${runtime} ${path.basename(path.dirname(binary))}${row.error ? `\n${row.error}` : ''}`);
}
const passed = receipt.rows.filter((r) => r.status === 'PASS').length;
console.log(`remote_tool_preview_runtime_test: ${passed}/${receipt.rows.length} passed (real runtimes; simulated model frames); ${output}`);
