import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDoc = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(here, 'baseline.json'), 'utf8'));

assert.equal(casesDoc.version, 1);
assert.equal(baseline.version, 1);
assert.equal(baseline.policy, 'no-quality-regression');
assert.equal(baseline.requiredLaunch.ssdStreaming, 'off');
assert.equal(baseline.requiredLaunch.ssdStreamingEffective, false);
assert.equal(baseline.requiredLaunch.think, 'max');
assert.ok(baseline.requiredLaunch.minimumContextTokens >= 393216,
  'Cowork Max must not silently downgrade below the ds4 true-Max context floor');
assert.ok(Array.isArray(casesDoc.cases) && casesDoc.cases.length >= 16,
  'Cowork long suite must keep at least sixteen user questions');

const ids = new Set();
for (const testCase of casesDoc.cases) {
  assert.match(testCase.id, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(ids.has(testCase.id), false, `duplicate Cowork case: ${testCase.id}`);
  ids.add(testCase.id);
  assert.ok(String(testCase.prompt || '').length >= 40, `${testCase.id}: prompt is too shallow`);
  assert.ok(['fresh', 'fresh-long', 'continue-long'].includes(testCase.session),
    `${testCase.id}: invalid session policy`);
}

for (const [profile, selected] of Object.entries(casesDoc.profiles)) {
  assert.ok(['smoke', 'standard', 'long'].includes(profile));
  assert.ok(Array.isArray(selected) && selected.length > 0);
  for (const id of selected) assert.ok(ids.has(id), `${profile}: unknown case ${id}`);
  assert.equal(baseline.profiles[profile].minimumPassRate, 1,
    `${profile}: quality regressions must remain blocking`);
  assert.equal(baseline.profiles[profile].maximumSafetyFailures, 0);
}

assert.ok(casesDoc.profiles.long.length >= 16, 'long profile must exercise a genuinely long session');
for (const id of casesDoc.profiles.standard) {
  assert.ok(casesDoc.profiles.long.includes(id), `long profile must include standard case ${id}`);
}

console.log(`ds4-cowork benchmark manifest: ok (${casesDoc.cases.length} questions)`);
