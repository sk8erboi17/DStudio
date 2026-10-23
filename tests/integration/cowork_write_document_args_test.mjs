// The actual native Cowork runtime: every write_document argument the model
// sends must reach the Office helper. A real run lost final_newline=false
// because the runtime forwarded only a fixed list of argument names
// (tests/.artifacts/pld-real-cowork-ab-fixed-nonl-20261003, retained). Both
// tool protocols are driven: structured calls (llama.cpp/MLX) and DSML text.
// Model frames are SIMULATED; no inference.
//   node tests/integration/cowork_write_document_args_test.mjs <ds4-cowork or ds4-agent-jsonl>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const binary = fs.realpathSync(process.argv[2] || path.join(root, 'ds4/ds4-cowork'));
const output = artifactRunDir('cowork-write-document-args');
const receipt = { scope: 'Real native Cowork runtime and Office helper; SIMULATED model frames; no inference', binary, rows: [] };
const frame = (value) => '\x1e' + JSON.stringify(value) + '\n';
const TEXT = 'first line\nlast line';
const CLOSE = '</｜DSML｜parameter>';
const dsmlCall = (args) => '<｜DSML｜tool_calls><｜DSML｜invoke name="write_document">' +
  Object.entries(args).map(([k, v]) => `<｜DSML｜parameter name="${k}" string="${typeof v === 'string'}">${v}${CLOSE}`).join('') +
  '</｜DSML｜invoke></｜DSML｜tool_calls>';

async function turn(protocol, work, args) {
  const child = spawn(binary, ['--non-interactive', '--jsonl', '--remote-base-url', 'http://127.0.0.1:1',
    '--remote-model', 'args-fixture', '--nothink', '-c', '8192', '-n', '256', '--chdir', work, '--prompt', 'Write the file.'],
  { cwd: work, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DS4UI_REMOTE_TOOL_PROTOCOL: protocol,
    DS4UI_RUNTIME_NAME: 'cowork', DS4UI_REMOTE_VISION: '', DSTUDIO_STEER_PORT: '', DSTUDIO_STEER_KEY: '',
    DS4UI_COWORK_HELPER: path.join(root, 'src/harness/cowork/office_tool.py'), DS4UI_SESSION_CACHE_DIR: path.join(work, 'sessions') } });
  let tail = '', stdout = '', requests = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += d; tail += d;
    const lines = tail.split('\n'); tail = lines.pop();
    for (const line of lines) {
      const at = line.indexOf('\x1e'); if (at < 0) continue;
      let ev; try { ev = JSON.parse(line.slice(at + 1)); } catch { continue; }
      if (ev.type !== 'model_request') continue;
      if (++requests === 1 && protocol === 'openai') {
        child.stdin.write(frame({ type: 'model_tool_calls', id: ev.id, text: JSON.stringify([{ id: 'd1', type: 'function',
          function: { name: 'write_document', arguments: JSON.stringify(args) } }]) }) + frame({ type: 'model_done', id: ev.id, text: 'tool_calls' }));
      } else if (requests === 1) {
        child.stdin.write(frame({ type: 'model_delta', id: ev.id, kind: 'content', text: dsmlCall(args) }) + frame({ type: 'model_done', id: ev.id, text: 'stop' }));
      } else {
        child.stdin.write(frame({ type: 'model_delta', id: ev.id, kind: 'content', text: 'Done.' }) + frame({ type: 'model_done', id: ev.id, text: 'stop' }));
      }
    }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  return stdout;
}

for (const protocol of ['openai', 'dsml']) {
  for (const [label, extra, expected] of [['final_newline=false keeps the text as written', { final_newline: false }, TEXT],
    ['by default the last line is ended', {}, `${TEXT}\n`]]) {
    const row = { protocol, case: label };
    receipt.rows.push(row);
    const work = path.join(output, `${receipt.rows.length}-${protocol}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      const stdout = await turn(protocol, work, { path: 'out.txt', title: 'Out', content: TEXT, ...extra });
      fs.writeFileSync(path.join(work, 'stdout.txt'), stdout);
      assert.equal(fs.readFileSync(path.join(work, 'out.txt'), 'utf8'), expected);
      row.status = 'PASS';
    } catch (error) {
      row.status = 'FAIL'; row.error = String(error.stack || error); process.exitCode = 1;
    }
    console.log(`${row.status} ${protocol}: ${label}${row.error ? `\n${row.error}` : ''}`);
  }
}
writeArtifact(output, 'results.json', receipt);
const passed = receipt.rows.filter((r) => r.status === 'PASS').length;
console.log(`cowork_write_document_args_test: ${passed}/${receipt.rows.length} passed (real runtime and helper; simulated model frames); ${output}`);
