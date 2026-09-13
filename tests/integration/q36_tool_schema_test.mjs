// Native typed tool arguments across final JSON, Anthropic and fragmented SSE.
// Explicit generated-byte fixtures, not model inference or quality scores.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('q36-tool-schema');
const report = {passed: false, started: new Date().toISOString(), cases: [],
  scope: 'Native parser and produced protocol bytes; explicit model-output fixtures, no inference'};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(`Evidence: ${run}`);
try {
  assert(process.argv[2], 'Supply the exact source tree');
  const legacy = process.argv[3] === '--legacy-parser-api';
  assert.equal(process.argv.length, legacy ? 4 : 3);
  report.legacyParserAPI = legacy; // Harness-only adapter for the preserved RED source.
  const source = fs.realpathSync(process.argv[2]);
  const probe = path.join(root, 'tests/support/q36_tool_schema_probe.c');
  const core = path.join(root, 'tests/support/q36_catalog_core_probe.c');
  const inputs = [probe, core, import.meta.filename, ...[
    'q36_server.c', 'q36.c', 'q36.h', 'q36_gpu.h', 'q36_image.c', 'q36_image.h',
    'q36_ssd.c', 'q36_ssd.h', 'rax.c', 'rax.h', 'rax_malloc.h'].map(file => path.join(source, file))];
  report.inputs = Object.fromEntries(inputs.map(file => [file, hash(file)]));
  const binary = path.join(run, 'native-tool-schema');
  const args = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    '-ffunction-sections', '-fdata-sections', '-I', source, probe, core,
    ...['q36_image.c', 'q36_ssd.c', 'rax.c'].map(file => path.join(source, file)), '-lm', '-pthread',
    '-o', binary, process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (legacy) args.unshift('-DQ36_SCHEMA_TEST_LEGACY_API');
  const build = spawnSync('cc', args, {encoding: 'utf8', timeout: 120000, maxBuffer: 2 ** 20});
  report.build = {args, status: build.status, stderr: build.stderr};
  assert.equal(build.status, 0, build.stderr); report.binarySHA256 = hash(binary);
  const workbook = '[{"name":"Workshops","rows":[["Workshop","Registered","Capacity","Remaining"],["Bookbinding",12,18,6],["Bicycle care",9,15,6],["Urban sketching",10,16,6]]}]';
  const toolBlock = (name, values) => `<tool_call>\n<function=${name}>\n${Object.entries(values).map(([key, value]) =>
    `<parameter=${key}>\n${typeof value === 'string' ? value : JSON.stringify(value)}\n</parameter>\n`).join('')}</function>\n</tool_call>`;
  const fixtures = [
    ['real Cowork sheets_json receipt', 'excel', 'sheets_json', 'string', workbook],
    ['array text retains spacing', 'excel', 'data_json', 'string', '[ ["α🙂", 2], ["x", 3] ]'],
    ['object text retains spacing', 'edit', 'old', 'string', '{ "keep": true }'],
    ['numeric text is not an integer', 'edit', 'old', 'string', '123'],
    ['boolean text is not a boolean', 'edit', 'old', 'string', 'false'],
    ['null text is not null', 'edit', 'old', 'string', 'null'],
    ['quotes are literal string bytes', 'edit', 'old', 'string', '"quoted"'],
    ['JSON-looking whitespace is preserved', 'edit', 'old', 'string', '  123  '],
    ['multiline string preserves exact bytes', 'write', 'content', 'string', 'line one\n  line two\n'],
    ['empty string remains empty', 'write', 'content', 'string', ''],
    ['Unicode and markup remain content', 'write', 'content', 'string', 'α🙂 &amp; <code>'],
    ['actual integer remains numeric', 'read', 'max_lines', 'integer', 123],
    ['actual boolean remains boolean', 'excel', 'header', 'boolean', false],
    ['actual array remains an array', 'array_tool', 'rows', 'array', [['x', 2]]],
    ['actual object remains an object', 'object_tool', 'data', 'object', {keep: true}],
    ['actual number retains fractions', 'number_tool', 'amount', 'number', 2.5],
  ].map(([name, tool, parameter, type, value]) => {
    const schemas = [{type: 'function', function: {name: tool, parameters: {type: 'object',
      properties: {[parameter]: {type}}, required: [parameter]}}}];
    // Qwen's documented XML parameter text has no extra JSON quoting for a
    // string. The recorded Cowork payload above exercises that exact ambiguity.
    const args = {[parameter]: value};
    return {name, schemas, generated: toolBlock(tool, args), expected: [{name: tool, args}]};
  });
  const workbookArgs = {action: 'create', path: 'workshops.xlsx', sheets_json: workbook};
  fixtures.push({name: 'complete real Cowork create call', schemas: [{type: 'function', function: {
    name: 'excel', parameters: {type: 'object', properties: {action: {type: 'string'},
      path: {type: 'string'}, sheets_json: {type: 'string'}}}}}],
    generated: toolBlock('excel', workbookArgs), expected: [{name: 'excel', args: workbookArgs}]});
  const group = [{name: 'text_tool', args: {value: 'false'}}, {name: 'bool_tool', args: {value: false}}];
  fixtures.push({name: 'successive calls with the same parameter use their own schema',
    schemas: group.map((call, i) => ({type: 'function', function: {name: call.name,
      parameters: {type: 'object', properties: {value: {type: i ? 'boolean' : 'string'}}}}})),
    generated: group.map(call => toolBlock(call.name, call.args)).join('\n\n'), expected: group});
  for (const type of ['string', 'object']) {
    const value = type === 'string' ? '{ "label": "x" }' : {label: 'x'};
    fixtures.push({name: `${type} type cannot be replaced by nested schema types`,
      schemas: [{type: 'function', function: {name: 'nested_tool', parameters: {type: 'object',
        properties: {value: {type, properties: {label: {type: type === 'string' ? 'integer' : 'string'}}}}}}}],
      generated: toolBlock('nested_tool', {value}), expected: [{name: 'nested_tool', args: {value}}]});
  }
  for (const api of ['responses', 'anthropic']) {
    const parameters = {type: 'object', properties: {value: {type: 'string'}}};
    fixtures.push({name: `${api} tool schema keeps literal JSON-looking strings`,
      schemas: [api === 'responses' ? {type: 'function', name: 'text_tool', parameters}
        : {name: 'text_tool', input_schema: parameters}],
      generated: toolBlock('text_tool', {value: '123'}), expected: [{name: 'text_tool', args: {value: '123'}}]});
  }
  for (const fixture of fixtures) {
    const {name, schemas, generated, expected} = fixture;
    for (const chunk of [1, 7, 8192]) {
      const row = {name, chunkBytes: chunk, schemas, generated, expected, passed: false};
      report.cases.push(row);
      const measured = spawnSync(binary, [JSON.stringify(schemas), String(chunk)], {
        input: generated, encoding: 'utf8', timeout: 10000, maxBuffer: 2 ** 20,
        env: {...process.env, ASAN_OPTIONS: 'halt_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'}});
      Object.assign(row, {status: measured.status, stdout: measured.stdout, stderr: measured.stderr});
      try {
        assert.equal(measured.status, 0, measured.stderr || String(measured.error));
        const observed = JSON.parse(measured.stdout); row.layout = observed.layout;
        const final = observed.calls.map(c => ({name: c.function.name, args: JSON.parse(c.function.arguments)}));
        const anthropic = observed.anthropic.filter(c => c.type === 'tool_use').map(c => ({name: c.name, args: c.input}));
        const responses = observed.responses.filter(c => c.type === 'function_call').map(c => ({name: c.name, args: JSON.parse(c.arguments)}));
        const streamed = new Map(); let stops = 0, done = 0;
        for (const line of observed.sse.split('\n').filter(s => s.startsWith('data: '))) {
          if (line === 'data: [DONE]') { done++; continue; }
          const event = JSON.parse(line.slice(6));
          for (const choice of event.choices || []) {
            if (choice.finish_reason === 'tool_calls') stops++;
            for (const c of choice.delta?.tool_calls || []) {
              const target = streamed.get(c.index) || {name: '', args: ''};
              if (c.function?.name) target.name += c.function.name;
              target.args += c.function?.arguments || ''; streamed.set(c.index, target);
            }
          }
        }
        row.observed = {final, anthropic, responses, streamed: [...streamed.values()].map(c => ({name: c.name, args: JSON.parse(c.args)}))};
        row.replay = observed.replay;
        assert.equal(row.replay.length, 4);
        for (const item of row.replay) {
          assert.equal(item.unchanged, true, `Native replay lost literal arguments: ${JSON.stringify(item)}`);
          assert.equal(item.changed, true, `Native replay replaced changed arguments: ${JSON.stringify(item)}`);
        }
        assert.equal(stops, 1); assert.equal(done, 1);
        for (const variant of Object.values(row.observed)) assert.deepEqual(variant, expected);
        row.passed = true;
      } catch (error) { row.error = error.stack; }
      console.log(`${row.passed ? 'PASS' : 'FAIL'} ${name}; chunk=${chunk}`);
      writeArtifact(run, 'results.json', report);
    }
  }
  for (const [file, before] of Object.entries(report.inputs)) assert.equal(hash(file), before, `Input changed: ${file}`);
  report.passed = report.cases.length === fixtures.length * 3 && report.cases.every(c => c.passed);
} catch (error) { report.error = error.stack; console.error(report.error); }
finally {
  report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report);
  console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.cases.filter(c => c.passed).length}/${report.cases.length}: ${run}`);
  if (!report.passed) process.exitCode = 1;
}
