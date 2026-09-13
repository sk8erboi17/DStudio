// Retain native failures as well as passes. No model, private user profile,
// downloaded weights or application restart is involved in this test.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const binary = path.resolve(process.argv[2]);
const root = path.resolve('tests/.artifacts/model-rpc-lifecycle');
fs.mkdirSync(root, {recursive: true});
const output = fs.mkdtempSync(path.join(root, 'run-'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['src/dstudio.c', 'src/dstudio_model_rpc.c', 'src/dstudio_model_stream.c',
  'src/dstudio_task_executor.c', 'tests/integration/model_rpc_lifecycle_test.c',
  'tests/integration/model_rpc_lifecycle_test.mjs'];
const sources = Object.fromEntries(sourceFiles.map(file => {
  const bytes = fs.readFileSync(file);
  const destination = path.join(output, 'sources', file);
  fs.mkdirSync(path.dirname(destination), {recursive: true}); fs.writeFileSync(destination, bytes);
  return [file, digest(bytes)];
}));
const result = spawnSync(binary, [], {encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024});
const rows = (result.stdout || '').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
const report = {scope: 'Real host owner, isolated native child processes and HTTP fixtures; no model quality claim',
  binary, binarySha256: digest(fs.readFileSync(binary)), sources, rows, code: result.status,
  signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
  passed: rows.filter(row => row.pass === true).length};
report.pass = result.status === 0 && report.passed === 6 && !rows.some(row => row.pass === false);
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
console.log(`model_rpc_lifecycle: ${report.passed}/6; ${output}`);
if (!report.pass) process.exitCode = 1;
