// Execute the real Office CLI; replay its results as native tool events.
// No LLM. Distinguish a full CSV inspect from XLSX metadata and partial reads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {assertSpreadsheetWorkflow} from '../support/cowork_spreadsheet_oracle.mjs';

const run = artifactRunDir('cowork-spreadsheet-oracle'), work = path.join(run, 'workspace');
fs.mkdirSync(work);
const sourceRows = [['Activity', 'Capacity', 'Registered'], ['Workshop', 8, 3], ['Tour', 9, 4]];
const outputRows = sourceRows.map((row, i) => [...row, i ? row[1] - row[2] : 'Remaining']);
const csv = sourceRows.map(row => row.join(',')).join('\n') + '\n';
fs.writeFileSync(path.join(work, 'source.csv'), csv);
const spec = {sourcePath: 'source.csv', sourceRows, outputPath: 'result.xlsx', outputRows};
const report = {started: new Date().toISOString(), passed: false, cases: [],
  scope: 'Real Office subprocess, CSV/XLSX files; simulated tool-event transport, no model'};
let sequence = 0;
function call(args) {
  const id = 'call-' + ++sequence, file = path.join(run, id + '.json');
  writeArtifact(run, id + '.json', {protocol: 'ds4.cowork.tool.v1', tool: 'spreadsheet',
    args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]))});
  const r = spawnSync('python3', ['-B', 'extension/cowork/office_tool.py', '--request-json', file, '--workspace', work],
    {encoding: 'utf8', timeout: 10000, maxBuffer: 2 ** 20});
  writeArtifact(run, id + '.result.json', {status:r.status, stdout:r.stdout, stderr:r.stderr});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return [{type:'tool_call', call_id:id, name:'excel', input:args},
    {type:'tool_result', call_id:id, name:'excel', outcome:'returned', output:r.stdout}];
}
function check(name, fn) {
  const row = {name, passed:false}; report.cases.push(row);
  fn(); row.passed = true;
}
try {
  const inspect = call({action:'inspect', path:'source.csv'});
  const read = call({action:'read', path:'source.csv'});
  const partial = call({action:'read', path:'source.csv', range:'A1:C2'});
  const create = call({action:'create', path:'result.xlsx', sheet:'Results', data_json:JSON.stringify(outputRows)});
  const back = call({action:'read', path:'result.xlsx', sheet:'Results', range:'A1:D3'});
  const metadata = call({action:'inspect', path:'result.xlsx'});
  const events = [...inspect, ...create, ...back];
  check('CSV inspect actually returns the same complete cells as read', () => {
    assert.equal(inspect[1].output, read[1].output);
    assert.equal(assertSpreadsheetWorkflow(events, spec).sourceAction, 'inspect');
    assert.equal(assertSpreadsheetWorkflow([...read, ...create, ...back], spec).sourceAction, 'read');
  });
  check('partial CSV data cannot establish a complete read', () =>
    assert.throws(() => assertSpreadsheetWorkflow([...partial, ...create, ...back], spec)));
  check('XLSX inspect is metadata, not saved-cell readback', () =>
    assert.throws(() => assertSpreadsheetWorkflow([...inspect, ...create, ...metadata], spec)));
  check('XLSX inspect cannot establish source cells either', () =>
    assert.throws(() => assertSpreadsheetWorkflow([...metadata, ...create, ...back],
      {...spec, sourcePath:'result.xlsx', sourceRows:outputRows})));
  check('readback cannot precede creation', () =>
    assert.throws(() => assertSpreadsheetWorkflow([...inspect, ...back, ...create], spec)));
  check('source must have returned before creation was requested', () =>
    assert.throws(() => assertSpreadsheetWorkflow([inspect[0], create[0], inspect[1], create[1], ...back], spec)));
  for (const [name, mutate] of [
    ['wrong source cell', e => {e[1].output = e[1].output.replace('Workshop\t8', 'Workshop\t7');}],
    ['wrong saved cell', e => {e[5].output = e[5].output.replace('Workshop\t8', 'Workshop\t7');}],
    ['truncated data', e => {e[1].output = e[1].output.replace('"textTruncated":false', '"textTruncated":true');}],
    ['missing columns', e => {e[1].output = e[1].output.replace('"omitted":[]', '"omitted":["right"]');}],
    ['failed result', e => {e[1].outcome = 'failed';}],
    ['wrong call id', e => {e[1].call_id = 'unknown';}],
    ['wrong result tool', e => {e[1].name = 'read';}],
    ['unrelated source path', e => {e[0].input.path = 'other.csv';}],
  ]) check(name + ' is rejected', () => {
    const changed = structuredClone(events); mutate(changed);
    assert.throws(() => assertSpreadsheetWorkflow(changed, spec));
  });
  check('duplicate Office calls cannot reuse another result', () =>
    assert.throws(() => assertSpreadsheetWorkflow([...events, inspect[0]], spec)));
  check('assistant prose is not source evidence', () =>
    assert.throws(() => assertSpreadsheetWorkflow([{type:'assistant',content:inspect[1].output}, ...create, ...back], spec)));
  assert.equal(fs.readFileSync(path.join(work, 'source.csv'), 'utf8'), csv);
  assert.equal(report.cases.length, 16);
  report.passed = true;
  console.log('Office workflow oracle: 16/16 PASS; real CSV/XLSX helper, no model');
} catch (error) {
  report.error = String(error.stack || error); throw error;
} finally {
  report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report);
  console.log(run);
}
