// Explicit allowlist: public fictional tasks, checked outcomes and artifact
// hashes only. Never copy private model/config transcripts or filesystem paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { productQualityCases } from '../fixtures/product_quality_cases.mjs';

const [pilotPath, replayPath, browserPath] = process.argv.slice(2);
assert.ok(browserPath, 'Pass original results.json, completed Agent/Cowork replay and reviewed browser results.json');
const read = file => JSON.parse(fs.readFileSync(file));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pilot = read(pilotPath), replay = read(replayPath), browser = read(browserPath);
assert.equal(pilot.status, 'complete'); assert.equal(replay.status, 'complete');
assert.equal(browser.inputReceiptSha256, sha(fs.readFileSync(pilotPath)));
for (const key of ['model', 'context', 'ssdStreaming']) assert.deepEqual(pilot[key], replay[key], `Unmatched ${key}`);
assert.deepEqual(pilot.fixedSampling, replay.fixedSampling, 'Unmatched sampling');
assert.deepEqual(pilot.cases, productQualityCases, 'Original prompts/inputs differ');
assert.deepEqual(replay.cases, productQualityCases.filter(task => task.mode !== 'design'), 'Replay prompts/inputs differ');
assert.equal(pilot.runs.length, 6); assert.equal(replay.runs.length, 4);
const output = 'extension/benchmarks/product-comparison';
fs.mkdirSync(path.join(output, 'results'), { recursive: true });
fs.mkdirSync(path.join(output, 'examples'), { recursive: true });
const report = { schema: 'dstudio.product-comparison.public.v1', date: '2026-09-06',
  scope: 'Development pilot: one paired coding task, one document task and one website brief; not a general product ranking.',
  hardware: replay.host, model: path.basename(replay.model), settings: replay.fixedSampling,
  context: replay.context, ssdStreaming: replay.ssdStreaming, pins: replay.pins,
  opencodeVersion: replay.opencodeVersion, dStudioReplayRevision: replay.dstudioRevision,
  dStudioReplaySourceHashes: replay.sourceHashes,
  provenance: { pilotReceiptSha256: sha(fs.readFileSync(pilotPath)), replayReceiptSha256: sha(fs.readFileSync(replayPath)),
    browserReceiptSha256: sha(fs.readFileSync(browserPath)) },
  limitations: [
    'Shared M2 Max; development/setup activity overlapped parts of collection. Timings are end-to-end observations, not native decode rates or isolated causal speedups.',
    'Products use their actual local tools and system prompts. The shared proxy fixes temperature, reasoning and an 8192-token ceiling; smaller requested caps are preserved in the replay.',
    'OpenDesign advertises 128k context/16k output to its adapter; the actual shared engine uses 32k context and an 8192 output ceiling. The original pilot did not record every binary hash.',
    'OpenWork original attempts failed before inference because the harness did not wait for its managed proxy. Corrected runs are reported separately, not as product failures.',
    'OpenDesign hit the common 15-minute task deadline. Its partial saved website was still audited and is shown unchanged.',
    'Grader corrections: case-insensitive brand, disclosure at the requested final step, and correct routing of the second product. All original failed receipts are retained privately; corrections apply equally to both outputs.',
    'Browser checks cover the named workflow at desktop/tablet/mobile, not visual excellence, keyboard accessibility, every input path, or WebKit compatibility.',
  ],
  prompts: productQualityCases.map(({ id, mode, prompt }) => ({ id, mode, prompt })), runs: [], originalAttempts: [],
};
for (const task of productQualityCases) {
  for (const product of ['dstudio', task.competitor]) {
    const source = task.mode === 'design' ? pilot : replay;
    const row = source.runs.find(r => r.id === task.id && r.product === product); assert.ok(row);
    const audit = task.mode === 'design' ? browser.rows.find(r => r.product === product) : row.audit;
    assert.ok(audit?.checks?.length, 'Independent artifact checks required');
    const deadline = /task deadline/.test(row.error || '');
    const completed = !deadline && row.status !== 'fail' && row.status !== 'running';
    const result = { id: task.id, product, completed, artifactChecksPass: audit.pass === true,
      pass: completed && audit.pass === true,
      elapsedSeconds: Number.isFinite(row.turnMs) ? row.turnMs / 1000 : null,
      deadlineSeconds: deadline ? 900 : null, modelRequests: row.requests.length,
      checks: audit.checks.map(({ name, pass }) => ({ name, pass })) };
    if (task.mode === 'design') {
      const bytes = fs.readFileSync(path.join(row.workspace, task.entry));
      assert.equal(sha(bytes), audit.htmlSha256, 'Never publish a repaired output as the benchmark artifact');
      const html = bytes.toString('utf8');
      assert.ok(!/\/Users\/|\/var\/folders\/|api[_-]?key\s*[=:]/i.test(html), 'Review potentially private generated content');
      result.htmlSha256 = sha(bytes);
      fs.writeFileSync(path.join(output, 'examples', `${product}-workshop.html`), bytes);
      for (const width of [1440, 390]) fs.copyFileSync(path.join(path.dirname(browserPath), `${product}-${width}.png`),
        path.join(output, 'examples', `${product}-${width}.png`));
    } else {
      assert.ok(row.entrySha256, 'Missing original artifact digest');
      const bytes = fs.readFileSync(path.join(row.workspace, task.entry));
      assert.equal(sha(bytes), row.entrySha256);
      assert.ok(!/\/Users\/|\/var\/folders\/|api[_-]?key\s*[=:]/i.test(bytes.toString('utf8')));
      result.entrySha256 = row.entrySha256;
      fs.writeFileSync(path.join(output, 'examples', `${product}-${task.entry}`), bytes);
    }
    report.runs.push(result);
  }
}
for (const row of pilot.runs.filter(r => r.id !== 'design-workshop-journey')) report.originalAttempts.push({
  id: row.id, product: row.product, pass: false, modelRequests: row.requests.length,
  cause: row.product === 'dstudio' ? 'DStudio remote workspace regression: tools did not act in the requested project; fixed before replay.'
    : 'Harness setup error: managed OpenCode proxy was not ready; corrected before replay.',
});
const destination = path.join(output, 'results', '2026-09-06-m2-max.json');
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(destination);
