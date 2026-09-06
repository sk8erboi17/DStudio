// Independent output checks. A runtime's success/idle event is not evidence
// that it actually repaired a function or wrote an accurate document.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { productQualityCases } from '../fixtures/product_quality_cases.mjs';

export function auditProductWorkspace(task, workspace) {
  const checks = [];
  const check = (name, test) => {
    try { test(); checks.push({ name, pass: true }); }
    catch (error) { checks.push({ name, pass: false, error: error.message }); }
  };
  const target = path.join(workspace, task.entry);
  check('requested file exists', () => assert.ok(fs.existsSync(target)));
  for (const [file, text] of Object.entries(task.files)) {
    if (file === task.entry) continue;
    check(`input ${file} unchanged`, () => assert.equal(fs.readFileSync(path.join(workspace, file), 'utf8'), text));
  }
  if (task.mode === 'agent') {
    const cases = [
      { rows: [], expected: [] },
      { rows: [{ timestamp: '2026-05-01T23:30:00-02:00', amount: 7 }, { timestamp: '2026-05-02T10:00:00Z', amount: '5' }], expected: [{ date: '2026-05-02', total: 12 }] },
      { rows: [{ timestamp: '2026-05-02T00:30:00+02:00', amount: -3 }, { timestamp: '2026-05-01T20:00:00Z', amount: 8 }, { timestamp: '2026-04-30T01:00:00Z', amount: 2 }], expected: [{ date: '2026-04-30', total: 2 }, { date: '2026-05-01', total: 5 }] },
      { rows: [{ timestamp: 'not a date', amount: 5 }, { timestamp: '2026-05-02T10:00:00Z', amount: 'NaN' }, { timestamp: '2026-05-02T10:00:00Z', amount: 'Infinity' }, { timestamp: '2026-05-02T10:00:00Z', amount: 4 }], expected: [{ date: '2026-05-02', total: 4 }] },
    ];
    for (const [index, c] of cases.entries()) check(`independent UTC/sum case ${index + 1}`, () => {
      const script = `import {summarize} from ${JSON.stringify(pathToFileURL(target).href)}; console.log(JSON.stringify(summarize(${JSON.stringify(c.rows)})));`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: workspace, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout.trim()), c.expected);
    });
    // Discover actual saved regression files, then execute them. Their pass is
    // complementary to the independent oracle, never a replacement for it.
    const tests = [];
    const walk = (dir, depth = 0) => {
      if (depth > 3 || tests.length > 30 || !fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file, depth + 1);
        else if (entry.isFile() && /(?:test|spec).*\.m?js$|\.test\.m?js$/.test(entry.name)) tests.push(file);
      }
    }; walk(workspace);
    check('permanent regression tests saved and executable', () => {
      assert.ok(tests.length > 0 && tests.length <= 30, 'No bounded saved regression test set');
      const run = spawnSync(process.execPath, ['--test', ...tests], { cwd: workspace, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
      assert.equal(run.status, 0, run.stdout + run.stderr);
    });
  } else if (task.mode === 'cowork') {
    const text = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const rows = text.split('\n').filter(line => line.includes('|'));
    check('Bookbinding uses the approved owner/date and cites update', () => assert.ok(rows.some(r => /Bookbinding/i.test(r) && /Noor/.test(r) && /2026-10-15/.test(r) && /update\.md/.test(r))));
    check('unchanged Bicycle care remains with its source', () => assert.ok(rows.some(r => /Bicycle care/i.test(r) && /Ivo/.test(r) && /2026-10-13/.test(r) && /brief\.md/.test(r))));
    check('correct participant total and exclusion rule', () => assert.ok(/(?<!\d)24(?!\d)/.test(text) && /cancel/i.test(text) && /exclud|not count|omitt|ignoring|ignore/i.test(text)));
    check('unresolved room is not invented', () => assert.ok(/room[^\n]{0,100}(unresolved|undecided|not assigned|pending|unassigned|unknown|to be|TBD)|(unresolved|undecided|pending|unassigned|unknown)[^\n]{0,60}room/i.test(text)));
  } else return { checks, pass: false, pendingBrowserAudit: true };
  return { checks, pass: checks.every(c => c.pass) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const file = process.argv[2]; assert.ok(file, 'Pass a completed pilot results.json');
  const receipt = JSON.parse(fs.readFileSync(file));
  assert.equal(receipt.status, 'complete', 'Wait for all product tasks to finish before a final audit');
  const rows = receipt.runs.map(row => ({ id: row.id, product: row.product, originalStatus: row.status,
    audit: row.workspace ? auditProductWorkspace(productQualityCases.find(c => c.id === row.id), row.workspace) : { pass: false, reason: 'No workspace' } }));
  const destination = path.join(fs.mkdtempSync(path.join(path.dirname(file), 'independent-audit-')), 'results.json');
  fs.writeFileSync(destination, JSON.stringify({ scope: 'Independent code/document effects; design browser audit remains separate',
    inputReceiptSha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), rows }, null, 2));
  console.log(destination);
  console.log(rows.map(r => `${r.id}/${r.product}: ${r.audit.pass ? 'pass' : r.audit.pendingBrowserAudit ? 'browser audit pending' : 'fail'}`).join('\n'));
}
