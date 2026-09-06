// Actual native Agent process/tools with simulated model frames. No weights.
// Reproduces the upstream chdir relocation regression on absolute AND relative
// workspace paths, and requires invalid paths to fail before a model request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const binary = path.resolve(process.argv[2] || 'ds4/ds4-agent-jsonl');
const output = fs.mkdtempSync(path.join(process.cwd(), 'tests/.artifacts/remote-workspace-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-remote-workspace-'));
const invoke = (name, args) => `<｜DSML｜invoke name="${name}">` +
  Object.entries(args).map(([k, v]) => `<｜DSML｜parameter name="${k}" string="true">${v}</｜DSML｜parameter>`).join('') + '</｜DSML｜invoke>';
const rows = [];
for (const name of ['absolute', 'relative', 'missing']) {
  const launch = path.join(work, name); fs.mkdirSync(launch);
  const workspace = path.join(launch, `${name} workspace è`);
  if (name !== 'missing') {
    fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'source.txt'), 'SELECTED_WORKSPACE_SOURCE');
  }
  fs.writeFileSync(path.join(launch, 'source.txt'), 'WRONG_LAUNCH_SOURCE');
  let count = 0, stdout = '', stderr = '', tail = '', failure;
  const row = { name, status: 'running' }; rows.push(row);
  const child = spawn(binary, ['--non-interactive', '--jsonl', '--remote-base-url', 'http://127.0.0.1:1',
    '--remote-model', 'simulated-workspace-gate', '--nothink', '-c', '4096', '-n', '256',
    '--chdir', name === 'relative' ? path.basename(workspace) : workspace,
    '-p', 'Read source.txt and save the requested outputs.'], { cwd: launch, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  const timer = setTimeout(() => { failure = new Error('Native remote workspace gate timed out'); child.kill('SIGKILL'); }, 20000);
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk; tail += chunk;
    const lines = tail.split('\n'); tail = lines.pop();
    for (const line of lines) {
      const index = line.indexOf('\x1e'); if (index < 0) continue;
      let e; try { e = JSON.parse(line.slice(index + 1)); } catch { continue; }
      if (e.type !== 'model_request') continue;
      count++;
      try {
        if (count === 2) assert.ok(e.body.includes('SELECTED_WORKSPACE_SOURCE'), 'Read tool used the wrong workspace');
        assert.ok(count <= 2, 'Unexpected extra model round');
      } catch (error) { failure = error; child.kill('SIGTERM'); continue; }
      const text = count === 1 ? '<｜DSML｜tool_calls>' +
        invoke('read', { path: 'source.txt' }) + invoke('write', { path: 'created.txt', content: 'WORKSPACE_WRITE_OK' }) +
        invoke('bash', { command: 'pwd -P > observed-cwd.txt' }) + '</｜DSML｜tool_calls>' : 'Done.';
      child.stdin.write('\x1e' + JSON.stringify({ type: 'model_delta', id: e.id, kind: 'content', text }) + '\n' +
        '\x1e' + JSON.stringify({ type: 'model_done', id: e.id }) + '\n');
    }
  });
  try {
    const [code, signal] = await exit; clearTimeout(timer);
    if (failure) throw failure;
    if (name === 'missing') { assert.notEqual(code, 0); assert.equal(count, 0); }
    else {
      assert.equal(signal, null); assert.equal(code, 0, stderr); assert.equal(count, 2);
      assert.equal(fs.readFileSync(path.join(workspace, 'created.txt'), 'utf8'), 'WORKSPACE_WRITE_OK');
      assert.equal(fs.readFileSync(path.join(workspace, 'observed-cwd.txt'), 'utf8').trim(), fs.realpathSync(workspace));
    }
    assert.equal(fs.existsSync(path.join(launch, 'created.txt')), false);
    assert.equal(fs.existsSync(path.join(launch, 'observed-cwd.txt')), false);
    row.status = 'pass';
  } catch (error) { row.status = 'fail'; row.error = error.stack; process.exitCode = 1; }
  finally {
    clearTimeout(timer); fs.writeFileSync(path.join(output, name + '-stdout.txt'), stdout);
    fs.writeFileSync(path.join(output, name + '-stderr.txt'), stderr);
    row.requests = count; fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ scope: 'Actual tools, simulated model; no inference quality claim', binary, rows }, null, 2));
  }
}
console.log(`remote_agent_workspace: ${rows.filter(r => r.status === 'pass').length}/3; receipts: ${output}`);
