import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDoc = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(here, 'baseline.json'), 'utf8'));

assert.equal(casesDoc.schema, 'ds4.design.benchmark.v1');
assert.equal(baseline.schema, 'ds4.design.quality-baseline.v1');
assert.equal(baseline.policy, 'strict-no-regression');
assert.equal(baseline.rubric, 'ds4-design-quality-v2');
assert.ok(baseline.minimumCritiqueComposite >= 8.5);
assert.equal(baseline.requiredLaunch.ssdStreaming, 'off');
assert.equal(baseline.requiredLaunch.ssdStreamingEffective, false);
assert.equal(baseline.requiredLaunch.think, 'max');
assert.equal(baseline.requiredLaunch.reasoningCapTokens, 0,
  'Design Max must default to unlimited per-round reasoning');
assert.ok(baseline.requiredLaunch.minimumContextTokens >= 393216,
  'Design Max must not silently downgrade below the ds4 true-Max context floor');
assert.ok(Array.isArray(casesDoc.cases) && casesDoc.cases.length >= 9);

const ids = new Set();
for (const testCase of casesDoc.cases) {
  assert.match(testCase.id, /^[a-z0-9-]+$/);
  assert.equal(ids.has(testCase.id), false, `duplicate case ${testCase.id}`);
  ids.add(testCase.id);
  assert.ok(['fresh', 'fresh-long', 'continue-long'].includes(testCase.session));
  assert.equal(typeof testCase.prompt, 'string');
  assert.ok(testCase.prompt.length >= 100, `${testCase.id}: prompt is too shallow`);
  assert.ok(Array.isArray(testCase.requiredTools) && testCase.requiredTools.length > 0);
  assert.ok(Array.isArray(testCase.requiredText));
  if (!testCase.safety) {
    assert.match(testCase.entry, /\.html$/);
    for (const tool of ['verify_artifact', 'critique_write', 'artifact']) {
      assert.ok(testCase.requiredTools.includes(tool), `${testCase.id}: missing ${tool} gate`);
    }
  }
}

for (const [profile, selected] of Object.entries(casesDoc.profiles)) {
  assert.ok(Object.hasOwn(baseline.profiles, profile), `${profile}: undeclared baseline profile`);
  assert.ok(Array.isArray(selected) && selected.length >= 1);
  for (const id of selected) assert.ok(ids.has(id), `${profile}: unknown case ${id}`);
  const floor = baseline.profiles[profile];
  assert.ok(floor, `${profile}: missing baseline`);
  assert.equal(floor.minimumPassRate, 1, `${profile}: quality regression is not allowed`);
  assert.equal(floor.minimumToolCompliance, 1, `${profile}: tool regression is not allowed`);
  assert.equal(floor.maximumSafetyFailures, 0, `${profile}: safety regressions are not allowed`);
}

const longSessions = casesDoc.profiles.long.map((id) =>
  casesDoc.cases.find((testCase) => testCase.id === id)?.session);
assert.ok(longSessions.includes('fresh-long') && longSessions.filter((value) => value === 'continue-long').length >= 3,
  'long profile must contain a seeded multi-turn revision session');
assert.ok(casesDoc.cases.some((testCase) => testCase.requiredTools.includes('generate_image')),
  'benchmark must cover Qwen3.8-routed local image generation');
const creativeCases = casesDoc.profiles['creative-full-stack'].map((id) =>
  casesDoc.cases.find((testCase) => testCase.id === id));
assert.ok(creativeCases.length >= 4,
  'creative full-stack profile needs at least four independently generated sites');
for (const testCase of creativeCases) {
  assert.equal(testCase.fullStack, true, `${testCase.id}: full-stack marker missing`);
  for (const tool of ['generate_image', 'see_image', 'generate_video', 'inspect_layout',
    'see_page', 'verify_artifact', 'critique_write', 'artifact']) {
    assert.ok(testCase.requiredTools.includes(tool), `${testCase.id}: missing full-stack tool ${tool}`);
  }
  assert.ok(testCase.requiredToolCounts?.generate_image >= 2,
    `${testCase.id}: must exercise Ideogram generation and Hunyuan editing`);
  assert.equal(testCase.requiredToolCounts?.see_image, 2,
    `${testCase.id}: Qwen correspondence must inspect exactly the generation and edit, not H3 frames`);
  assert.ok(testCase.requiredToolCounts?.generate_video >= 1,
    `${testCase.id}: every creative site test must include MiniMax H3`);
  assert.deepEqual(testCase.requiredToolOrder?.slice(0, 5),
    ['generate_image', 'see_image', 'generate_image', 'see_image', 'generate_video'],
    `${testCase.id}: heavy media tools must run serially in the required order`);
  for (const output of [testCase.generatedImage, testCase.editedImage, testCase.video])
    assert.match(output, /^assets\/[a-z0-9-]+\.(?:png|mp4)$/);
}
const creativityFloor = baseline.profiles['creative-full-stack'];
assert.ok(creativityFloor.maximumPairwiseCloneScore <= 0.82);
assert.ok(creativityFloor.minimumDistinctHeroSchemas >= 2);
assert.equal(creativityFloor.minimumDistinctPrimaryFontStacks, creativeCases.length);
assert.equal(creativityFloor.minimumDistinctDisplayFontStacks, creativeCases.length);
assert.equal(creativityFloor.minimumDistinctTypeSystems, creativeCases.length);
assert.equal(creativityFloor.minimumDistinctRenderedPrimaryFonts, creativeCases.length);
assert.equal(creativityFloor.minimumDistinctRenderedDisplayFonts, creativeCases.length);
assert.equal(creativityFloor.minimumDistinctRenderedTypeSystems, creativeCases.length);
const userFontCase = creativeCases.find((testCase) => testCase.requestedFont);
assert.ok(userFontCase, 'creative profile must test an explicit user font decision');
assert.match(userFontCase.prompt, new RegExp(userFontCase.requestedFont, 'i'));
assert.ok(casesDoc.cases.some((testCase) => testCase.safety),
  'benchmark must cover workspace safety');

console.log(`ds4-design benchmark: ok (${casesDoc.cases.length} cases, strict baselines)`);
