import assert from 'node:assert/strict';

const systems = ['folio', 'signal', 'forma', 'grove', 'pulse', 'market', 'commons', 'atlas', 'canvas'];

// Corpus validation, not validation of DStudio source or a generated project.
export function validateDesignProjects(suite) {
  assert.equal(suite.schema, 'dstudio.design-projects.v1');
  assert.equal(suite.cases?.length, 18, 'two real briefs per original pack required');
  assert.equal(new Set(suite.cases.map(c => c.id)).size, 18, 'unique artifact namespaces required');
  assert.equal(new Set(suite.cases.map(c => c.prompt)).size, 18, 'briefs cannot be duplicates');
  assert.equal(new Set(suite.cases.map(c => c.interaction)).size, 18, 'distinct interaction scenarios required');
  assert.ok(typeof suite.commonPrompt === 'string' && suite.commonPrompt.length > 0 && suite.commonPrompt.length < 8192);
  for (const id of systems) assert.equal(suite.cases.filter(c => c.designSystemId === id).length, 2, `missing pair for ${id}`);
  for (const c of suite.cases) {
    assert.match(c.id, /^[a-z][a-z0-9-]{1,63}$/);
    assert.ok(systems.includes(c.designSystemId));
    assert.equal(c.entry, 'index.html');
    assert.ok(typeof c.prompt === 'string' && c.prompt.length > 0 && c.prompt.length < 8192);
    assert.ok(Array.isArray(c.requiredText) && c.requiredText.length >= 3 && c.requiredText.length <= 10);
    assert.ok(c.requiredText.every(s => typeof s === 'string' && s.length > 0 && s.length < 128));
    assert.match(c.interaction, /^[a-z][a-z0-9-]{1,63}$/);
  }
  return suite.cases.map(c => ({...c, prompt: `${suite.commonPrompt}\nSelected design_system: ${c.designSystemId}.\n${c.prompt}`}));
}

export function observeSelectedDesignPack(receipt, event, expectedBody) {
  assert.ok(typeof expectedBody === 'string' && expectedBody.length > 0);
  if (event.type === 'tool_call' && event.name === 'design_system')
    receipt.pendingDesignSystem = event.input?.name || null;
  if (event.type === 'tool_result' && event.name === 'design_system') {
    if (receipt.pendingDesignSystem === receipt.designSystemId && typeof event.output === 'string'
        && event.output.startsWith(expectedBody)) receipt.designSystemLoaded = true;
    receipt.pendingDesignSystem = null;
  }
}
