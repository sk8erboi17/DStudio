// Real native runtimes and filesystem tools. Only model replies are simulated.
// SIGINT must work without a control frame or more model bytes, then the same
// process must execute a subsequent turn. Never start an inference engine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

const inputs = process.argv.slice(2);
assert(inputs.length, 'Supply already-built Agent/Cowork/Design binaries');
const output = artifactRunDir('runtime-model-interrupt');
const receipt = { scope: 'Native SIGINT, same-process next turn and real tools; simulated model, no weights', rows: [] };
receipt.sources = Object.fromEntries(['extension/remote/dstudio_remote_llm.c', 'extension/remote/dstudio_remote_llm.h',
  'extension/remote/dstudio_wire_string.h', 'patch/ds4-agent-jsonl/remote-agent.cfrag', 'extension/design/ds4_design.c',
  'tests/integration/runtime_model_interrupt_test.mjs'].map(file => {
    const bytes = fs.readFileSync(file), target = path.join(output, 'sources', file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target);
    return [file, crypto.createHash('sha256').update(bytes).digest('hex')];
  }));
const save = () => writeArtifact(output, 'results.json', receipt);
const invoke = (name, args) => '<｜DSML｜tool_calls><｜DSML｜invoke name="' + name + '">' +
  Object.entries(args).map(([key, value]) => `<｜DSML｜parameter name="${key}" string="true">${value}</｜DSML｜parameter>`).join('') +
  '</｜DSML｜invoke></｜DSML｜tool_calls>';
const frame = event => '\x1e' + JSON.stringify(event) + '\n';
for (const input of inputs) {
  const binary = fs.realpathSync(input), design = path.basename(binary).includes('design');
  for (const phase of ['silent-prefill', 'partial-frame', 'uncommitted-tool']) {
    const row = { binary, binarySha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
      phase, status: 'running', started: new Date().toISOString() };
    receipt.rows.push(row); save();
    const work = path.join(output, String(receipt.rows.length)); fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'source.txt'), 'POST_STOP_TOOL_EVIDENCE');
    let child, stdout = '', stderr = '', tail = '', requests = 0, waiting = 0, stage = 'starting', failure;
    let stopTimer;
    const fail = error => {
      failure ||= error;
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const timeout = setTimeout(() => fail(new Error('Native interrupt/resume test exceeded 20 seconds')), 20000);
    try {
      child = spawn(binary, ['--non-interactive', '--jsonl', '--remote-base-url', 'http://127.0.0.1:1',
        '--remote-model', 'interrupt-fixture', '--nothink', '-c', '8192', '-n', '256',
        design ? '--workspace' : '--chdir', work], { cwd: work, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DSTUDIO_STEER_PORT: '', DSTUDIO_STEER_KEY: '',
          DSTUDIO_DESIGN_CACHE_DIR: path.join(work, 'design-cache') } });
      row.pid = child.pid;
      child.stdin.on('error', fail);
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', bytes => {
        try {
          stdout += bytes; tail += bytes;
          assert(stdout.length <= 4 * 1024 * 1024, 'Bounded runtime output');
          const lines = tail.split('\n'); tail = lines.pop();
          for (const line of lines) {
            const start = line.indexOf('\x1e'); if (start < 0) continue;
            const event = JSON.parse(line.slice(start + 1));
            if (event.type !== 'model_request') continue;
            requests++;
            assert(requests <= 3, 'Interrupted model request must not be retried');
            if (requests === 1) {
              stage = 'interrupted';
              if (phase === 'partial-frame') child.stdin.write('\x1e{"type":"model_delta","id":' + event.id + ',"text":"unfinished');
              if (phase === 'uncommitted-tool') child.stdin.write(frame({ type: 'model_delta', id: event.id,
                kind: 'content', text: invoke('bash', { command: 'printf invalid >> abandoned.txt' }) }));
              assert(child.kill('SIGINT'), 'Signal only this owned runtime');
              stopTimer = setTimeout(() => fail(new Error('Runtime did not return to WAITING within 2 seconds of SIGINT')), 2000);
            } else if (requests === 2) {
              assert.equal(stage, 'resumed');
              const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
              assert.equal(body.messages.filter(message => message.role === 'user').at(-1).content,
                // Design consumes the input record's trailing CR/LF; Agent
                // retains it. Do not trim arbitrary content or accept prefixes.
                'Read source.txt and report its contents.' + (design ? '' : '\n'),
                'The new prompt must not inherit partial protocol bytes');
              const content = design ? invoke('read', { path: 'source.txt' }) :
                invoke('bash', { command: 'printf x >> committed.txt; cat source.txt' });
              child.stdin.write(frame({ type: 'model_delta', id: event.id, kind: 'content', text: content }) +
                frame({ type: 'model_done', id: event.id }));
            } else {
              const history = typeof event.body === 'string' ? event.body : JSON.stringify(event.body);
              assert(history.includes('POST_STOP_TOOL_EVIDENCE'), 'The resumed turn must receive its actual tool result');
              child.stdin.write(frame({ type: 'model_delta', id: event.id, kind: 'content', text: 'Resumed after Stop.' }) +
                frame({ type: 'model_done', id: event.id }));
              stage = 'finishing';
            }
          }
        } catch (error) { fail(error); }
      });
      child.stderr.on('data', bytes => {
        try {
          stderr += bytes; assert(stderr.length <= 4 * 1024 * 1024, 'Bounded runtime errors');
          const count = stderr.split('+DWARFSTAR_WAITING').length - 1;
          while (waiting < count) {
            waiting++;
            if (stage === 'starting') { stage = 'first'; child.stdin.write('This turn will be stopped before model completion.\n'); }
            else if (stage === 'interrupted') {
              clearTimeout(stopTimer); stage = 'resumed';
              assert(!fs.existsSync(path.join(work, 'abandoned.txt')), 'A cancelled tool must not execute');
              child.stdin.write('Read source.txt and report its contents.\n');
            } else if (stage === 'finishing') { stage = 'finished'; child.stdin.end(); }
          }
        } catch (error) { fail(error); }
      });
      row.exit = await done;
      if (failure) throw failure;
      assert.deepEqual(row.exit, { code: 0, signal: null });
      assert.equal(stage, 'finished'); assert.equal(requests, 3); assert.equal(waiting, 3);
      assert(!fs.existsSync(path.join(work, 'abandoned.txt')), 'Cancelled effects cannot appear after resume');
      if (!design) assert.equal(fs.readFileSync(path.join(work, 'committed.txt'), 'utf8'), 'x');
      row.status = 'pass';
    } catch (error) {
      row.status = 'fail'; row.error = String(error.stack || error); process.exitCode = 1;
    } finally {
      clearTimeout(timeout); clearTimeout(stopTimer);
      writeArtifact(work, 'stdout.log', stdout); writeArtifact(work, 'stderr.log', stderr);
      row.requests = requests; row.waiting = waiting; row.finished = new Date().toISOString(); save();
      console.log(`${row.status.toUpperCase()} ${path.basename(binary)}/${phase}${row.error ? ': ' + row.error.split('\n')[0] : ''}`);
    }
  }
}
console.log(`Preserved native Stop/resume evidence: ${output}`);
