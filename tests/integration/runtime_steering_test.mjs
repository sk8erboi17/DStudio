// Actual Agent/Cowork/Design executables, real tools and owner-side transcript
// append. Model frames and host admission are deterministic fixtures, not LLMs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const inputs = process.argv.slice(2);
assert(inputs.length, 'Supply built runtime paths');
const invoke = (name, args) => '<｜DSML｜tool_calls><｜DSML｜invoke name="' + name + '">' +
  Object.entries(args).map(([k,v]) => `<｜DSML｜parameter name="${k}" string="true">${v}</｜DSML｜parameter>`).join('') +
  '</｜DSML｜invoke></｜DSML｜tool_calls>';
for (const input of inputs) {
  const binary = path.resolve(input), design = path.basename(binary).includes('design');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-steering-runtime-'));
  fs.writeFileSync(path.join(work, 'source.txt'), 'ACTUAL_TOOL_EVIDENCE');
  const key = 'a'.repeat(64), pending = [];
  let ack = 0, sealed = false, began = 0, requests = 0, stdout = '', stderr = '', failure;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const [credential, turn, confirmed, finish] = body.split('\n');
    assert.equal(credential, key);
    let payload;
    if (turn === '0') { began++; payload = '73'; }
    else {
      assert.equal(turn, '73');
      ack = Math.max(ack, Number(confirmed));
      const next = pending.find(x => x.seq > ack);
      payload = next ? `${next.seq}\n${next.text}` : '0';
      if (!next && finish === '1') sealed = true;
    }
    res.writeHead(200, { 'Content-Length': Buffer.byteLength(payload), 'Connection': 'close' }); res.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(binary, ['--non-interactive', '--jsonl', '--remote-base-url', 'http://127.0.0.1:1',
    '--remote-model', 'deterministic-steering-fixture', '--nothink', '-c', '8192', '-n', '256',
    design ? '--workspace' : '--chdir', work], {
    cwd: work, stdio: ['pipe','pipe','pipe'], env: { ...process.env,
      DSTUDIO_STEER_PORT: String(server.address().port), DSTUDIO_STEER_KEY: key },
  });
  const exit = once(child, 'exit');
  const timer = setTimeout(() => { failure = new Error('Runtime steering timed out'); child.kill('SIGKILL'); }, 20000);
  let tail = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk; tail += chunk;
    const lines = tail.split('\n'); tail = lines.pop();
    for (const line of lines) {
      const start = line.indexOf('\x1e'); if (start < 0) continue;
      let event; try { event = JSON.parse(line.slice(start + 1)); } catch { continue; }
      if (event.type !== 'model_request') continue;
      requests++;
      try {
        assert(requests <= 3, 'No extra turn or tool replay is allowed');
        const history = typeof event.body === 'string' ? event.body : JSON.stringify(event.body);
        if (requests >= 2) {
          assert(history.includes('FIRST_STEERING_CONTEXT'), 'Context must enter the next model request after the tool');
          assert(history.includes('ACTUAL_TOOL_EVIDENCE'), 'The prior real tool result must be retained');
        }
        if (requests === 3) assert(history.includes('FINAL_BOUNDARY_CONTEXT'), 'Late context must continue this turn instead of being lost at EOS');
        if (requests === 1) pending.push({ seq: 1, text: 'FIRST_STEERING_CONTEXT: keep the original work and add this constraint.' });
        if (requests === 2) pending.push({ seq: 2, text: 'FINAL_BOUNDARY_CONTEXT: acknowledge this before finishing.' });
        const text = requests === 1
          ? design ? invoke('read', { path: 'source.txt' }) : invoke('bash', { command: 'printf x >> effect.txt; cat source.txt' })
          : requests === 2 ? 'Initial final answer.' : 'Final answer with both context additions.';
        child.stdin.write('\x1e' + JSON.stringify({ type: 'model_delta', id: event.id, kind: 'content', text }) + '\n' +
          '\x1e' + JSON.stringify({ type: 'model_done', id: event.id }) + '\n');
        if (requests === 3) child.stdin.end();
      } catch (error) { failure = error; child.kill('SIGKILL'); }
    }
  });
  child.stdin.write('Read source.txt once and report what it contains.\n');
  try {
    const [code, signal] = await exit;
    if (failure) throw failure;
    assert.equal(code, 0, stderr); assert.equal(signal, null);
    assert.equal(requests, 3); assert.equal(began, 1, 'All model requests must belong to one turn');
    assert.equal(ack, 2); assert(sealed);
    if (!design) assert.equal(fs.readFileSync(path.join(work, 'effect.txt'), 'utf8'), 'x', 'Tool effects must not be replayed');
    console.log(`runtime_steering: PASS ${input} — one turn, three model rounds, two appends, real tool; inference simulated`);
  } catch (error) {
    console.error(stderr, stdout); throw error;
  } finally {
    clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
