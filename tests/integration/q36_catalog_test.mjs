// Actual core model identity and native HTTP serialization, fixture metadata.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..'), run = artifactRunDir('q36-catalog');
const report = {scope: 'Core identity and HTTP serializer with fixture model state; not inference',
  status: 'fail', checks: [], commands: []};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(`Evidence: ${run}`);
try {
  assert.equal(process.argv.length, 3, 'Supply the exact prepared q36 source checkout');
  const source = fs.realpathSync(process.argv[2]);
  const probes = ['q36_catalog_core_probe.c', 'q36_catalog_http_probe.c'].map(n => path.join(root, 'tests/support', n));
  const inputs = ['q36.c', 'q36_server.c', 'q36.h'].map(n => path.join(source, n)).concat(probes, import.meta.filename);
  report.inputs = Object.fromEntries(inputs.map(file => [file, hash(file)]));
  const execute = (binary, args) => {
    const result = spawnSync(binary, args, {encoding: 'utf8', timeout: 120000, maxBuffer: 2 ** 21});
    report.commands.push({binary, args, status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr, error: String(result.error || '')});
    writeArtifact(run, 'results.json', report);
    assert.equal(result.status, 0, String(result.error || '') + result.stderr);
    return result.stdout;
  };
  const exe = path.join(run, 'catalog');
  const args = ['-std=c11', '-O1', '-ffunction-sections', '-fdata-sections', '-I', source,
    ...probes, '-lm', '-pthread', '-o', exe,
    process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
  execute('cc', args);
  const families = [['qwen3.6-35b-a3b', 'Qwen 3.6 35B A3B'],
    ['qwen3.8-27b', 'Qwen 3.8 27B'], ['kat-coder-v2.5-dev', 'KAT-Coder V2.5 Dev']];
  for (let family = 0; family < families.length; family++) for (const route of ['list', 'detail']) {
    const wire = execute(exe, [String(family), route]);
    const at = wire.indexOf('\r\n\r\n'); assert(at > 0);
    const headers = wire.slice(0, at), body = wire.slice(at + 4);
    assert.match(headers, /^HTTP\/1\.1 200 /);
    assert.equal(Number(headers.match(/content-length:\s*(\d+)/i)?.[1]), Buffer.byteLength(body));
    const response = JSON.parse(body), model = route === 'list' ? response.data[0] : response;
    if (route === 'list') {assert.equal(response.object, 'list'); assert.equal(response.data.length, 1);}
    assert.equal(model.id, families[family][0]); assert.equal(model.name, families[family][1]);
    assert.equal(model.context_length, 8192); assert.equal(model.top_provider.max_completion_tokens, 256);
    report.checks.push({family: families[family][0], route, status: 'pass'});
  }
  for (const [file, expected] of Object.entries(report.inputs)) assert.equal(hash(file), expected);
  report.binarySHA256 = hash(exe); report.status = 'pass';
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report);}
