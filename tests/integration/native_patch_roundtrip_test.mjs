import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { artifactRunDir } from '../support/real_harness.mjs';
import { nativePatchRoundtrip } from '../support/native_patch_roundtrip.mjs';

assert.ok(process.argv[2], 'Pass an existing managed main source checkout');
const run = artifactRunDir('native-patch-roundtrip');
const report = { source: fs.realpathSync(process.argv[2]), started: new Date().toISOString(), status: 'FAIL' };
try {
  report.evidence = nativePatchRoundtrip({ support: process.cwd(), source: report.source,
    scratch: path.join(run, 'source') });
  report.status = 'PASS';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
report.finished = new Date().toISOString();
fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`${report.status}: ${run}${report.error ? '\n' + report.error : ''}`);
