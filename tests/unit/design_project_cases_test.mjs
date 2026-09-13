import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateDesignProjects, observeSelectedDesignPack} from '../support/design_project_cases.mjs';

const raw = fs.readFileSync(new URL('../fixtures/design_pack_projects.json', import.meta.url));
const suite = JSON.parse(raw), before = JSON.stringify(suite);
const cases = validateDesignProjects(suite);
assert.equal(cases.length, 18);
assert.equal(JSON.stringify(suite), before, 'forming execution prompts must not mutate original briefs');
for (const c of cases) {
  assert.ok(c.prompt.startsWith(suite.commonPrompt + '\n'));
  assert.ok(c.prompt.endsWith(suite.cases.find(x => x.id === c.id).prompt));
  assert.equal(c.entry, 'index.html');
}
for (const change of [s => s.cases.pop(), s => s.cases[0].designSystemId = 'unknown',
  s => s.cases[1].designSystemId = 'market', s => s.cases[0].id = '../escape',
  s => s.cases[1].id = s.cases[0].id, s => s.cases[1].prompt = s.cases[0].prompt,
  s => s.cases[1].interaction = s.cases[0].interaction, s => s.cases[0].entry = '../index.html',
  s => s.commonPrompt = '', s => s.cases[0].requiredText = [], s => s.cases[0].prompt = 'x'.repeat(8193)]) {
  const invalid = structuredClone(suite); change(invalid);
  assert.throws(() => validateDesignProjects(invalid));
}
const body = '# Authored pack\nReal tokens and component instructions.\n';
const event = (type, name, data = {}) => ({type, name, ...data});
for (const sequence of [
  [event('tool_result', 'design_system', {output: body})],
  [event('tool_call', 'design_system', {input: {name: 'market'}}), event('tool_result', 'design_system', {output: 'Tool error: no such pack'})],
  [event('tool_call', 'design_system', {input: {name: 'folio'}}), event('tool_result', 'design_system', {output: body})],
  [event('tool_call', 'design_system', {input: {name: 'market'}}), event('tool_result', 'design_system', {output: body.slice(0, -1)})]
]) {
  const receipt = {designSystemId: 'market', designSystemLoaded: false};
  for (const e of sequence) observeSelectedDesignPack(receipt, e, body);
  assert.equal(receipt.designSystemLoaded, false, 'calling a tool or receiving different/truncated bytes is not pack loading');
}
const receipt = {designSystemId: 'market', designSystemLoaded: false};
observeSelectedDesignPack(receipt, event('tool_call', 'design_system', {input: {name: 'market'}}), body);
observeSelectedDesignPack(receipt, event('tool_result', 'design_system', {output: body + '\nInventory: tokens.css'}), body);
assert.equal(receipt.designSystemLoaded, true);
console.log('PASS eighteen-brief corpus, pack coverage, isolated paths and frozen execution prompts; no model generation or quality claim');
