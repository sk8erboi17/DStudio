// Execute patched, current upstream prompt builders, not source-text contracts.
// Requires an already built main engine with its native core objects. Derived
// Agent objects are private build outputs; compile probe-only copies here.
// No engine startup, weights, network calls or changes to the supplied checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { artifactRunDir, writeArtifact } from '../support/real_harness.mjs';

assert.equal(process.platform, 'darwin', 'this native link gate currently targets macOS');
assert.ok(process.argv[2], 'provide the built current main engine directory');
assert.ok(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--laguna'));
const laguna = process.argv[3] === '--laguna';
const engine = path.resolve(process.argv[2]);
const scratch = artifactRunDir('agent-prompts');
const report = {started: new Date().toISOString(), passed: false, engine, laguna,
  scope: `${laguna ? 6 : 10} real native prompt builders; no inference`};
let commandCount = 0;
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
  writeArtifact(scratch, `command-${++commandCount}.json`, { command: [cmd, ...args],
    status: result.status, error: String(result.error || ''), stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
  return result.stdout;
};
// Parse actual generated schema objects. Examples or prose are not schemas.
function schemas(prompt) {
  const result = [];
  for (let start = 0; start < prompt.length; start++) {
    if (prompt[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < prompt.length; end++) {
      const c = prompt[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const raw = JSON.parse(prompt.slice(start, end + 1));
          const schema = raw.type === 'function' ? raw.function : raw;
          if (schema?.name && schema.parameters) result.push(schema);
        } catch { /* Non-schema illustrative prose. */ }
        start = end;
        break;
      }
    }
  }
  return result;
}
try {
  const emit = path.join(scratch, 'emit');
  run('cc', ['-O1', '-std=c11', 'tests/support/emit_agent_patch.c', '-o', emit]);
  run(emit, [path.join(engine, 'ds4_agent.c'), path.join(scratch, 'ds4_agent.c')]);
  run(emit, [path.join(engine, 'ds4_web.c'), path.join(scratch, 'ds4_web.c'), '--web']);
  const includes = [scratch, engine, path.resolve('extension/remote'), path.resolve('extension/cowork'), path.resolve('patch/ds4-agent-jsonl')];
  const objects = ['ds4_distributed', 'ds4_tp', 'ds4_ssd', 'ds4_metal',
    'ds4_layer_pack', 'ds4_help', 'ds4_kvstore', 'linenoise', 'ds4_gpu_args',
    ...(laguna ? ['ds4', 'rax'] : ['ds4_image', 'ds4_prompt_prefix'])];
  // V4.1's core references the native Engram module even in a model-free
  // prompt probe. Require its object when the source exists; old forks do not
  // have that module and must retain their own link boundary.
  if (fs.existsSync(path.join(engine, 'ds4_engram.c'))) objects.push('ds4_engram');
  const derived = [
    ['ds4_pld_core', path.resolve('patch/ds4-agent-jsonl/pld_core.c'), ...(laguna ? [] : ['-DDSTUDIO_PLD_NATIVE'])],
    ['ds4_web', path.join(scratch, 'ds4_web.c')],
    ['ds4_cowork', path.resolve('extension/cowork/ds4_cowork.c')],
    ['dstudio_remote_llm', path.resolve('extension/remote/dstudio_remote_llm.c')],
  ];
  for (const [name, source, ...flags] of derived)
    run('cc', ['-O1', '-std=c11', ...flags, ...includes.flatMap(dir => ['-I', dir]), '-c', source, '-o', path.join(scratch, `${name}.o`)]);
  const probe = path.join(scratch, 'probe');
  run('cc', ['-O1', '-std=c11', '-Wno-unused-function', ...(laguna ? ['-DDSTUDIO_TEST_LAGUNA'] : []), ...includes.flatMap(dir => ['-I', dir]),
    'tests/support/agent_prompt_probe.c', ...objects.map(name => path.join(engine, `${name}.o`)),
    ...derived.map(([name]) => path.join(scratch, `${name}.o`)),
    '-lm', '-pthread', '-framework', 'Foundation', '-framework', 'Metal', '-o', probe]);
  const rows = run(probe, [], { cwd: scratch }).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, laguna ? 6 : 10);
  for (const row of rows) {
    const tools = schemas(row.prompt);
    const names = tools.map(tool => tool.name);
    assert.ok(names.includes('read') && names.includes('write') && names.includes('edit'), row.case);
    assert.equal(names.filter(name => name === 'view_image').length, row.case.endsWith('-1') ? 1 : 0, row.case);
    assert.equal(names.filter(name => name === 'document_table').length, row.case.includes('cowork') ? 1 : 0, row.case);
    for (const name of ['excel', 'read_document', 'write_document', 'write_pdf', 'presentation'])
      assert.equal(names.filter(n => n === name).length, row.case.includes('cowork') ? 1 : 0,
        `${row.case}: the runtime owns its complete Office schemas without duplicate charter definitions`);
    const read = tools.find(tool => tool.name === 'read').parameters.properties;
    assert.equal(read.path.type, 'string');
    if (laguna) assert.equal(read.max_lines.type, 'number');
    else {
      assert.equal(read.start_line.type, 'integer');
      assert.match(row.prompt, /Read output is limited to 128 KiB/, `${row.case}: retain native file-tool limits`);
    }
    if (row.case.endsWith('-laguna')) {
      const body = row.prompt.split('<available_tools>')[1]?.split('</available_tools>')[0];
      assert.ok(body, 'Laguna schemas must retain their native envelope');
      assert.equal(schemas(body).length, tools.length, row.case);
    }
    if (row.case.includes('glm')) {
      // The introduction also mentions the empty <tools></tools> notation.
      const body = row.prompt.slice(row.prompt.lastIndexOf('<tools>') + 7).split('</tools>')[0];
      assert.ok(body, 'GLM tools must be inside their native envelope');
      assert.equal(schemas(body).length, tools.length, row.case);
    }
  }
  Object.assign(report, {passed: true, rows});
  console.log(`${laguna ? 'Laguna' : 'Current upstream'} Agent/Cowork prompts: ${rows.length} native builders, parsed tool schemas and native envelopes PASS (no model)`);
} catch (error) {
  report.error = String(error.stack || error);
  throw error;
} finally {
  report.finished = new Date().toISOString();
  writeArtifact(scratch, 'results.json', report);
  console.log(`Preserved native prompt evidence: ${scratch}`);
}
