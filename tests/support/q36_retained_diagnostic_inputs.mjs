// Admission for a retained Qwen failure, not a new quality evaluator. No model
// is loaded here. Patch ordering is exercised only on a private source copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

export function retainedDiagnosticOptions(args) {
  const options = args.slice(5);
  assert.ok(args.length >= 5 && options.every(o => ['--preflight-only', '--f16-attention'].includes(o)),
    'Supply Q36_DIR MODEL TERMINAL_COMMON100_RUN CASE_ID EXPECTED_BINARY_SHA256 [--preflight-only] [--f16-attention]');
  assert.equal(new Set(options).size, options.length, 'Duplicate diagnostic option');
  const attention = options.includes('--f16-attention');
  return {inputs: args.slice(0, 5), preflightOnly: options.includes('--preflight-only'),
    variant: attention ? 'bounded-f16-attention' : 'original-f16-diagnostic',
    patchNames: ['q36-metal-runtime', 'q36-agent-tty', 'q36-metal-diagnostics',
      ...(attention ? ['q36-f16-attention'] : [])]};
}

export function diagnosticSourceNames(engine) {
  return execFileSync('git', ['-C',engine,'ls-files','--cached','--others','--exclude-standard','-z'],
    {encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
      env:{PATH:process.env.PATH,LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
        GIT_CEILING_DIRECTORIES:path.dirname(engine)}}).split('\0').filter(Boolean);
}

export function selectRetainedDiagnosticCase(before, manifest, original, caseId) {
  assert.match(caseId, /^[a-z][a-z0-9_-]{0,127}$/, 'Invalid retained case identity');
  const entry = before.results.find(row => row.engine === 'q36');
  assert.ok(before.finished && entry?.status === 'fail', 'Use a finished failed q36 run');
  assert.equal(original.corpus, manifest.identity);
  assert.ok(original.finished && original.status === 'fail', 'Retained run is not terminal');
  assert.equal(manifest.cases.length, 100); assert.equal(original.cases.length, 100);
  assert.equal(new Set(manifest.cases.map(c => c.id)).size, 100);
  assert.deepEqual(original.cases.map(c => c.id), manifest.cases.map(c => c.id));
  assert.ok(original.cases.every(c => ['pass', 'fail'].includes(c.status)), 'Incomplete retained run');
  assert.deepEqual(original.summary, {denominator:100,
    passed:original.cases.filter(c => c.status === 'pass').length,
    failed:original.cases.filter(c => c.status === 'fail').length, notRun:0, pending:0});
  const index = manifest.cases.findIndex(c => c.id === caseId);
  assert.ok(index >= 0, 'Unknown frozen case');
  const item = manifest.cases[index], old = original.cases[index];
  assert.equal(item.category, 'long_context'); assert.equal(old.status, 'fail');
  assert.equal(item.deadline_ms, 900000, 'Preserve the original long-case deadline');
  return {entry, index, item, old};
}

export function validateRetainedDiagnosticRequest(payload, item, manifest, original) {
  assert.deepEqual(payload, {model:original.requestedModel,
    messages:[{role:'user', content:item.prompt}], temperature:manifest.settings.temperature,
    seed:manifest.settings.seed, max_tokens:item.max_tokens, think:false,
    thinking:{type:'disabled'}, stream:false}, 'Retained request differs from frozen inputs');
}

export function verifyDiagnosticPatchStack(engine, directory, names, patches) {
  assert.ok(!fs.existsSync(directory), 'Patch validation needs a new private directory');
  assert.ok(names.length > 0 && names.length < 4096);
  const hashes = new Map(), sha = data => crypto.createHash('sha256').update(data).digest('hex');
  let bytes = 0;
  for (const name of names) {
    assert.ok(!path.isAbsolute(name) && !name.split('/').some(p => !p || p === '.' || p === '..'));
    const file = path.join(engine, name), st = fs.lstatSync(file);
    assert.ok(st.isFile() && !st.isSymbolicLink() && st.size <= 64*1024*1024);
    assert.equal(fs.realpathSync(file), file, 'Linked source input');
    bytes += st.size; assert.ok(bytes <= 128*1024*1024, 'Patch validation source budget');
    hashes.set(name, sha(fs.readFileSync(file)));
  }
  fs.mkdirSync(directory);
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), {recursive:true});
    fs.copyFileSync(path.join(engine, name), path.join(directory, name), fs.constants.COPYFILE_EXCL);
  }
  const env = {PATH:process.env.PATH, LC_ALL:'C', GIT_CONFIG_NOSYSTEM:'1',
    GIT_CONFIG_GLOBAL:'/dev/null', GIT_CEILING_DIRECTORIES:path.dirname(directory)};
  const git = args => execFileSync('git', ['-C', directory, ...args],
    {env, timeout:10000, maxBuffer:1024*1024, stdio:['ignore','pipe','pipe']});
  git(['init', '-q']);
  // An overlay can invalidate the base patch's context without invalidating
  // the installed stack. Remove overlays first, then reproduce the same stack.
  for (const file of [...patches].reverse()) git(['apply', '--reverse', file]);
  for (const file of patches) git(['apply', '--whitespace=error', file]);
  for (const [name, hash] of hashes) {
    assert.equal(sha(fs.readFileSync(path.join(directory, name))), hash, 'Patch round-trip differs: '+name);
    assert.equal(sha(fs.readFileSync(path.join(engine, name))), hash, 'Candidate source changed: '+name);
  }
  return {directory, files:names.length, bytes, restored:[...patches].reverse(), applied:patches,
    sourcePreserved:true, roundTripIdentical:true};
}
