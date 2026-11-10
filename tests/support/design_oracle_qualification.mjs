// Qualification of the Design interaction oracles (PLAN.MD P8) with authored
// fixtures: one reference page per frozen case that the oracle must accept,
// standalone and inside the opaque preview frame, and deliberately broken
// variants of the same page that it must reject for the stated reason. These
// are authored test fixtures, never model-generated projects or results.
//
// A fixture is tests/fixtures/design_oracles/CASE_ID.html plus CASE_ID.json:
//   { "case": "CASE_ID", "steps": N,
//     "faults": [{ "name": "...", "caughtAs": "regex source", "flags": "i" }],
//     "variants": [{ "name": "...", "why": "what this equally correct page does differently" }] }
// The page exposes `window.fault` (empty by default) and a global `render()`;
// setting a fault name and calling render() switches on that one defect.
// `variants` are optional: other correct ways to satisfy the brief, switched
// on with `window.variant = name; render()`. The oracle must accept each one,
// so that a correct generated page is not failed for its markup or wording.
//
//   node tests/support/design_oracle_qualification.mjs CASE_ID [--browser chromium|webkit]
// runs one fixture alone (both browsers by default) and prints every check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactRunDir, writeArtifact } from './real_harness.mjs';
import { exerciseDesignProject } from './design_project_interactions.mjs';
import { auditProjectView, serveProjectSnapshot, snapshotProject } from './design_project_audit.mjs';
import { validateDesignProjects } from './design_project_cases.mjs';

const fixtureRoot = fileURLToPath(new URL('../fixtures/design_oracles/', import.meta.url));
const MINIMUM_FAULTS = 3;

export function frozenCases() {
  return validateDesignProjects(JSON.parse(fs.readFileSync(new URL('../fixtures/design_pack_projects.json', import.meta.url), 'utf8')));
}

// Reads and validates the fixture specifications. `only` restricts the set.
export function loadOracleFixtures(cases, { dir = fixtureRoot, only = null } = {}) {
  const out = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    assert.equal(`${spec.case}.json`, name, `${name}: the file is named after its case`);
    const caseSpec = cases.find((item) => item.id === spec.case);
    assert.ok(caseSpec, `${name}: unknown frozen case ${spec.case}`);
    const html = path.join(dir, `${spec.case}.html`);
    assert.ok(fs.existsSync(html), `${name}: missing reference page ${spec.case}.html`);
    assert.match(fs.readFileSync(html, 'utf8'), /Authored [^<>]{0,60}fixture/i, `${spec.case}.html must say it is an authored fixture`);
    assert.ok(Number.isSafeInteger(spec.steps) && spec.steps > 0, `${name}: steps is the number of oracle steps`);
    assert.ok(Array.isArray(spec.faults) && spec.faults.length >= MINIMUM_FAULTS, `${name}: at least ${MINIMUM_FAULTS} deliberate faults`);
    assert.equal(new Set(spec.faults.map((fault) => fault.name)).size, spec.faults.length, `${name}: fault names are unique`);
    for (const fault of spec.faults) {
      assert.match(fault.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${name}: fault names are lower-case words`);
      assert.ok(typeof fault.caughtAs === 'string' && fault.caughtAs.length >= 4, `${name}: ${fault.name} states how the oracle reports it`);
      new RegExp(fault.caughtAs, fault.flags || '');
    }
    for (const variant of spec.variants || []) {
      assert.match(variant.name || '', /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${name}: variant names are lower-case words`);
      assert.ok(typeof variant.why === 'string' && variant.why.length >= 12, `${name}: ${variant.name} says why it is also correct`);
      assert.ok(!spec.faults.some((fault) => fault.name === variant.name), `${name}: ${variant.name} is both a fault and a variant`);
    }
    assert.equal(new Set((spec.variants || []).map((variant) => variant.name)).size, (spec.variants || []).length, `${name}: variant names are unique`);
    if (!only || only.has(spec.case)) out.push({ spec, caseSpec, html });
  }
  if (only) for (const id of only) assert.ok(out.some((fixture) => fixture.spec.case === id), `no oracle fixture for ${id}`);
  return out;
}

// Copies the reference page into the run directory and serves that frozen copy.
export async function serveOracleFixture(fixture, run) {
  const folder = path.join(run, fixture.spec.case);
  fs.mkdirSync(folder);
  fs.copyFileSync(fixture.html, path.join(folder, 'index.html'));
  const snapshot = snapshotProject(folder);
  return { ...fixture, folder, snapshot, server: await serveProjectSnapshot(snapshot) };
}

// Positive in both containers, every fault rejected for its stated reason, and
// the complete audited view in both themes. `check(name, fn)` is the caller's reporter.
export async function qualifyOracleFixture({ name, browser, page, run, check }, fixture) {
  const c = fixture.caseSpec;
  for (const framed of [false, true]) await check(`${name}: ${c.interaction} positive ${framed ? 'opaque' : 'standalone'}`, async () => {
    await page.goto(fixture.server.base + (framed ? '/preview' : '/project/index.html'));
    const scope = framed ? page.frameLocator('iframe') : page, steps = [];
    await exerciseDesignProject(c, scope, page, async (label, fn) => { await fn(); steps.push(label); });
    assert.equal(steps.length, fixture.spec.steps);
  });
  for (const variant of fixture.spec.variants || []) await check(`${name}: ${c.interaction} accepts ${variant.name}`, async () => {
    await page.goto(fixture.server.base + '/project/index.html');
    await page.evaluate((active) => { window.variant = active; render(); }, variant.name);
    const steps = [];
    await exerciseDesignProject(c, page, page, async (label, fn) => { await fn(); steps.push(label); });
    assert.equal(steps.length, fixture.spec.steps);
  });
  for (const fault of fixture.spec.faults) await check(`${name}: ${c.interaction} catches ${fault.name}`, async () => {
    await page.goto(fixture.server.base + '/project/index.html');
    await page.evaluate((active) => { window.fault = active; render(); }, fault.name);
    let captured;
    try { await exerciseDesignProject(c, page, page, async (_, fn) => fn()); } catch (error) { captured = error; }
    writeArtifact(run, `${name}-${c.id}-${fault.name}-expected-failure.json`, {
      scope: 'Deliberately defective authored oracle fixture, not a model failure', error: String(captured?.message) });
    assert.ok(captured, 'Deliberately broken workflow incorrectly passed');
    assert.match(captured.message, new RegExp(fault.caughtAs, fault.flags || ''));
  });
  for (const theme of ['light', 'dark']) await check(`${name}: ${c.interaction} complete ${theme} view pipeline`, async () => {
    const settings = { id: `${name}-${theme}-domain`, engine: name, theme, width: 390, frame: false, textScale: 1, interactions: true };
    const record = { ...settings, checks: [], screenshots: [] };
    const saveView = () => writeArtifact(run, `${name}-${theme}-${c.id}-fixture-audit.json`, record);
    await auditProjectView(browser, { url: fixture.server.base + '/project/index.html', allowedPrefix: fixture.server.base + '/project/' },
      c, settings, run, record, saveView);
    assert.equal(record.status, 'pass', JSON.stringify(record.checks.filter((row) => row.status !== 'pass')));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [caseId, ...rest] = process.argv.slice(2);
  if (!caseId) { console.error('usage: design_oracle_qualification.mjs CASE_ID [--browser chromium|webkit]'); process.exit(2); }
  const wanted = rest.includes('--browser') ? [rest[rest.indexOf('--browser') + 1]] : ['chromium', 'webkit'];
  const playwright = await import('playwright');
  const run = artifactRunDir('design-oracle-qualification');
  const [loaded] = loadOracleFixtures(frozenCases(), { only: new Set([caseId]) });
  const fixture = await serveOracleFixture(loaded, run);
  const report = { scope: 'One authored oracle fixture, checked alone; not a model result', case: caseId, checks: [] };
  const check = async (label, fn) => {
    const row = { name: label }; report.checks.push(row);
    try { await fn(); row.status = 'pass'; } catch (error) { row.status = 'fail'; row.error = String(error.stack || error); }
    writeArtifact(run, 'report.json', report);
    console.log(`${row.status}: ${label}${row.error ? `\n${row.error.split('\n').slice(0, 12).join('\n')}` : ''}`);
  };
  try {
    for (const name of wanted) {
      const browser = await playwright[name].launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 390, height: 900 } }); context.setDefaultTimeout(1500);
        await qualifyOracleFixture({ name, browser, page: await context.newPage(), run, check }, fixture);
        await context.close();
      } finally { await browser.close(); }
    }
    await check('the audit left every fixture byte unchanged', async () => assert.deepEqual(snapshotProject(fixture.folder).hashes, fixture.snapshot.hashes));
  } finally { await fixture.server.close(); }
  const failed = report.checks.filter((row) => row.status !== 'pass');
  console.log(`${caseId}: ${report.checks.length - failed.length}/${report.checks.length} checks passed\nReceipts: ${run}`);
  process.exitCode = failed.length ? 1 : 0;
}
