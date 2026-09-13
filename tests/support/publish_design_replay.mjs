// Publish unchanged model output, never a hand-repaired replacement for the
// original paired benchmark. Raw model transcripts/configuration remain ignored.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { productQualityCases } from '../fixtures/product_quality_cases.mjs';

const [receiptPath, ...auditPaths] = process.argv.slice(2);
assert.equal(auditPaths.length, 2, 'Pass the live receipt and Chromium/WebKit audit receipts');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptBytes = fs.readFileSync(receiptPath), receipt = JSON.parse(receiptBytes);
assert.equal(receipt.status, 'complete');
assert.deepEqual(receipt.cases, productQualityCases.filter(c => c.mode === 'design'), 'Use the same brief, no corrective user prompt');
assert.equal(receipt.runs.length, 1);
const run = receipt.runs[0];
assert.equal(run.product, 'dstudio');
assert.ok(run.requests.length, 'Real model requests required');
const completed = run.status !== 'fail' && Number.isFinite(run.turnMs);
const deadline = run.status === 'fail' && /DStudio task deadline/.test(run.error || '');
assert.ok(completed || deadline, 'Classify unexpected runtime failures before publication');
const output = 'extension/benchmarks/product-comparison';
const original = fs.readFileSync(path.join(output, 'results/2026-09-06-m2-max.json'));
const html = fs.readFileSync(path.join(run.workspace, 'workshop.html'));
if (completed) assert.equal(sha(html), run.entrySha256, 'Generated HTML changed after runtime completion');
assert.ok(!/\/Users\/|\/var\/folders\/|api[_-]?key\s*[=:]/i.test(html.toString()), 'Private content must not be published');
const audits = auditPaths.map(file => {
  const data = JSON.parse(fs.readFileSync(file));
  assert.equal(data.inputReceiptSha256, sha(receiptBytes));
  assert.equal(data.rows.length, 1);
  const row = data.rows[0];
  assert.equal(row.product, 'dstudio');
  assert.equal(row.htmlSha256, sha(html));
  assert.ok(row.checks.length);
  assert.equal(row.pass, row.checks.every(c => c.pass));
  return { file, data, row };
});
assert.deepEqual(audits.map(a => a.data.browser).sort(), ['chromium', 'webkit']);
const report = {
  schema: 'dstudio.design-regeneration.public.v1', date: receipt.started.slice(0, 10),
  scope: 'One from-scratch Design development replay of the original brief. No human edits to generated HTML. Not a new paired comparison or a general quality score.',
  prompt: receipt.cases[0].prompt,
  hardware: receipt.host, model: path.basename(receipt.model), settings: receipt.fixedSampling,
  context: receipt.context, ssdStreaming: receipt.ssdStreaming,
  runtime: { revision: receipt.dstudioRevision, dirty: receipt.dstudioDirty, engineRevision: receipt.engineRevision,
    sourceHashes: receipt.sourceHashes },
  completed, elapsedSeconds: completed ? run.turnMs / 1000 : null, deadlineSeconds: deadline ? 900 : null,
  attemptSeconds: run.attemptMs / 1000, modelRequests: run.requests.length,
  artifactChecksPass: audits.every(a => a.row.pass), pass: completed && audits.every(a => a.row.pass),
  completionIssue: deadline ? 'Agent hit the deadline while iterating on static/fake-DOM checks. Those checks are not end-to-end evidence.' : null,
  htmlSha256: sha(html),
  provenance: { originalPublicReceiptSha256: sha(original), liveReceiptSha256: sha(receiptBytes),
    artifactDigestCapture: completed ? 'runtime completion, then unchanged in both browser audits' : 'post-deadline independent browser audits; no completion digest was captured by the pilot',
    harnessSha256: receipt.harnessSha256, audits: audits.map(a => ({ browser: a.data.browser, sha256: sha(fs.readFileSync(a.file)) })) },
  browsers: audits.map(({ data, row }) => ({ browser: data.browser, pass: row.pass,
    checks: row.checks.map(({ name, pass }) => ({ name, pass })),
    radioLayout: row.radioLayout, dayRadioLayout: row.dayRadioLayout,
    nativeRadioKeyboardApplicable: row.nativeRadioKeyboardApplicable, textResizeChecks: row.textResizeChecks })),
  limitations: [
    'Known development brief, not a held-out task. Original failed HTML, screenshots and paired timings remain unchanged.',
    'One regeneration only; no claim that every future page will be correct. Browser geometry and named controls are not a comprehensive accessibility or aesthetic review.',
    'A 900-second deadline is not a completion time. The unfinished agent run remains failed even if its generated file passes independent browser checks. Model loading and independent audits are outside the task timer.',
    'Raw tool/model transcripts remain private. No human edits were made to the generated HTML. The published file matches both independent browser audits by SHA-256.',
    'Initial browser audits targeted the hidden 1px native radio input and timed out. The corrected grader clicks its visible associated label and asserts actual native selection, without force or programmatic checking.',
  ],
};
report.initialBrowserAudits = fs.readdirSync(path.dirname(receiptPath)).filter(name => name.startsWith('browser-audit-')).flatMap(name => {
  const file = path.join(path.dirname(receiptPath), name, 'results.json');
  if (!fs.existsSync(file) || auditPaths.some(p => path.resolve(p) === path.resolve(file))) return [];
  const bytes = fs.readFileSync(file), data = JSON.parse(bytes);
  if (data.inputReceiptSha256 !== sha(receiptBytes)) return [];
  return [{ browser: data.browser, sha256: sha(bytes), rows: data.rows.map(r => ({ pass: r.pass,
    checks: r.checks.map(({ name, pass }) => ({ name, pass })) })) }];
});
const chromiumAudit = audits.find(a => a.data.browser === 'chromium');
report.screenshots = [1440, 390].map(width => ({ width, file: `examples/dstudio-regenerated-${width}.png`,
  sha256: sha(fs.readFileSync(path.join(path.dirname(chromiumAudit.file), `dstudio-${width}.png`))) }));
const bytes = JSON.stringify(report, null, 2) + '\n';
assert.ok(!/\/Users\/|\/var\/folders\/|remoteApiKey/.test(bytes));
fs.writeFileSync(path.join(output, 'examples/dstudio-workshop-regenerated.html'), html);
for (const width of [1440, 390]) fs.copyFileSync(path.join(path.dirname(chromiumAudit.file), `dstudio-${width}.png`),
  path.join(output, 'examples', `dstudio-regenerated-${width}.png`));
const destination = path.join(output, 'results/2026-09-06-design-regeneration.json');
fs.writeFileSync(destination, bytes);
assert.equal(sha(fs.readFileSync(path.join(output, 'results/2026-09-06-m2-max.json'))), sha(original));
console.log(`${destination}: runtime ${report.completed ? 'completed' : 'unfinished'}, browser checks ${report.artifactChecksPass ? 'passed' : 'failed'}`);
