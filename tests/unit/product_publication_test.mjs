import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = 'extension/benchmarks/product-comparison';
const bytes = fs.readFileSync(path.join(root, 'results/2026-09-06-m2-max.json'));
const data = JSON.parse(bytes);
assert.equal(data.runs.length, 6);
assert.equal(data.originalAttempts.length, 4, 'Keep original attempts, including setup failures');
assert.ok(!/\/Users\/|\/var\/folders\/|OPENWORK_TOKEN|remoteApiKey/.test(bytes.toString()), 'Private runtime data in public output');
for (const row of data.runs) {
  assert.equal(row.pass, row.completed && row.artifactChecksPass);
  assert.equal(row.artifactChecksPass, row.checks.every(c => c.pass));
  const artifact = row.id.startsWith('agent') ? 'summary.mjs' : row.id.startsWith('cowork') ? 'plan.md' : 'workshop.html';
  const file = path.join(root, 'examples', `${row.product}-${artifact}`);
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), row.htmlSha256 || row.entrySha256);
  if (artifact === 'summary.mjs') {
    const { summarize } = await import(pathToFileURL(path.resolve(file)));
    assert.deepEqual(summarize([{ timestamp: '2026-05-01T23:30:00-02:00', amount: 7 },
      { timestamp: '2026-05-02T10:00:00Z', amount: '5' }]), [{ date: '2026-05-02', total: 12 }]);
  }
}
const incomplete = data.runs.find(r => r.product === 'opendesign');
assert.equal(incomplete.pass, false); assert.equal(incomplete.elapsedSeconds, null);
assert.equal(incomplete.deadlineSeconds, 900, 'A deadline must not turn into a successful runtime');
for (const product of ['dstudio', 'opendesign']) for (const width of [1440, 390]) {
  const png = fs.readFileSync(path.join(root, 'examples', `${product}-${width}.png`));
  assert.equal(png.readUInt32BE(16), width);
  assert.ok(png.readUInt32BE(20) >= 1000);
}
console.log('product_publication: six outcomes, original failures, artifact hashes/execution, private-data exclusion and real PNG dimensions passed');
