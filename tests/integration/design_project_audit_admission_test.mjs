// Execute the old auditor against a new corpus. Synthetic receipts, no model
// or generated-page quality claim: unknown workflows must not silently pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import crypto from 'node:crypto';
import {validateDesignProjects} from '../support/design_project_cases.mjs';
import {auditDesignProjects} from '../support/design_project_audit.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const run = artifactRunDir('design-project-audit-admission');
const suite = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/design_pack_projects.json')));
writeArtifact(run, 'frozen-cases.json', suite);
writeArtifact(run, 'report.json', {label: 'simulated-unqualified-projects', caseCount: 18,
  cases: suite.cases.map(c => ({id: c.id, status: 'idle', entryExists: true}))});
const result = spawnSync(process.execPath, [path.join(root, 'tests/support/design_comparison_audit.mjs'), run],
  {cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
writeArtifact(run, 'admission.json', {scope: 'Legacy auditor rejection with simulated receipt inputs',
  status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: String(result.error || '')});
assert.equal(result.status, 1);
assert.match(result.stderr, /legacy auditor implements only archive, repair and workshop/);
assert.equal(fs.existsSync(path.join(run, 'audit.json')), false, 'no passing or partial quality receipt may be produced');
assert.equal(fs.existsSync(path.join(run, 'audit.partial.json')), false);
console.log(`PASS new workflows cannot receive an unimplemented legacy audit: ${run}`);

// The dedicated auditor must not trust generationPassed alone or convert
// unstarted cases into failed generations. This admission fails before any
// browser/workspace is opened; all data below is an explicitly forged fixture.
const partial=path.join(run,'dedicated-partial');fs.mkdirSync(partial);
const bytes=fs.readFileSync(path.join(root,'tests/fixtures/design_pack_projects.json'));
fs.writeFileSync(path.join(partial,'frozen-cases.json'),bytes,{flag:'wx'});
const cases=validateDesignProjects(suite);
writeArtifact(partial,'report.json',{label:'forged-native-capture-fixture',caseCount:18,
  suite:{sha256:crypto.createHash('sha256').update(bytes).digest('hex'),planned:18,selected:cases.map(c=>c.id)},
  binarySha256:'a'.repeat(64),model:{sha256:'b'.repeat(64),bytes:1},engineIdentity:{fixture:true},
  inference:{fixture:true},memory:'Simulated admission; no real model',
  cases:cases.map((c,i)=>({...c,status:i?'not-run':'idle',generationPassed:!i,
    artifact:{entry:'index.html'},entryExists:true,entryIsRegular:true,entrySha256:'c'.repeat(64),
    exitCode:0,signal:null,capture:{status:'idle',cleanupComplete:false}}))});
await assert.rejects(auditDesignProjects(partial),/Unfinished generation/);
const audited=await auditDesignProjects(partial,{partial:true});
assert.deepEqual(audited.report.summary,{denominator:18,passed:0,failed:1,notRun:17});
assert.equal(audited.report.status,'fail');assert.match(audited.report.cases[0].error,/cleanup and delivery identities/);
assert.equal(audited.report.cases.flatMap(c=>c.views).length,0,'Invalid capture must not enter browser qualification');
console.log('PASS failed native capture remains failed; 17 unstarted projects remain NOT RUN, not hidden from the denominator');
