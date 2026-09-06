// Real third-party servers and public APIs; no inference/quality claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOpenWork, startOpenDesign } from '../support/product_comparison.mjs';
const [openworkRepo, opendesignRepo, toolsDir] = process.argv.slice(2).map(p => path.resolve(p));
assert.ok(openworkRepo && opendesignRepo && toolsDir, 'Pass built OpenWork, OpenDesign and isolated tool-bin paths');
const output = fs.mkdtempSync('tests/.artifacts/product-setup-');
const report = { scope: 'Actual pinned product startup + public workspace/project APIs; no model task', products: [] };
for (const [start, repo] of [[startOpenWork, openworkRepo], [startOpenDesign, opendesignRepo]]) {
  let server;
  const row = { repo, status: 'running' }; report.products.push(row);
  try {
    server = await start({ repo, toolBin: toolsDir, logDir: path.resolve(output) });
    Object.assign(row, { product: server.product, revision: server.revision, work: server.work });
    if (server.product === 'openwork') {
      const result = await server.api('/workspaces');
      row.workspaces = result;
      assert.ok(JSON.stringify(result).includes(server.workspace), 'Actual workspace must be advertised');
    } else {
      const result = await server.api('/api/projects', { method: 'POST', body: { id: 'setup-proof', name: 'Isolated setup proof', skipDiscoveryBrief: true } });
      row.project = result;
      const reopened = await server.api('/api/projects/setup-proof');
      assert.ok(JSON.stringify(reopened).includes('setup-proof'), 'Created project must reopen through public API');
    }
    row.status = 'pass';
  } catch (error) { row.status = 'fail'; row.error = error.stack; process.exitCode = 1; }
  finally { await server?.stop(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); }
  console.log(`${row.product || path.basename(repo)}: ${row.status}`);
}
console.log(`Private setup receipts: ${output}`);
