import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProductArtifactServer } from '../support/product_artifact_server.mjs';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'product-artifact-server-'));
const candidates = ['first', 'second'].map(product => {
  const workspace = path.join(work, product); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'workshop.html'), `<h1>${product}</h1>`);
  return { product, workspace };
});
fs.symlinkSync(path.join(candidates[0].workspace, 'workshop.html'), path.join(candidates[1].workspace, 'outside.html'));
const server = createProductArtifactServer(candidates);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const product of ['first', 'second']) {
    const response = await fetch(`${base}/${product}/workshop.html`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `<h1>${product}</h1>`);
  }
  assert.equal((await fetch(`${base}/missing/workshop.html`)).status, 404);
  assert.equal((await fetch(`${base}/second/outside.html`)).status, 403);
  assert.equal((await fetch(`${base}/second/%2e%2e%2ffirst/workshop.html`)).status, 404);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(work, { recursive: true });
}
console.log('product_artifact_server: both product routes, unknown product and traversal/symlink confinement passed');
