// Admission for a retained Qwen failure, not a new quality evaluator. No model
// is loaded here. Patch ordering is exercised only on a private source copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {ownGitRevision} from './quality_baseline.mjs';

export function diagnosticRevision(engine) {
  const git=ownGitRevision(engine);
  if(git)return {commit:git.head,git};
  const file=path.join(engine,'.dstudio-source.json'),info=fs.lstatSync(file);
  assert(info.isFile()&&!info.isSymbolicLink()&&info.size<=1024*1024,'Expected bounded archive provenance');
  const bytes=fs.readFileSync(file),receipt=JSON.parse(bytes);
  assert.equal(receipt.engine,'q36');assert.equal(receipt.backend,'metal');
  assert.match(receipt.commit,/^[a-f0-9]{40}$/);
  return {commit:receipt.commit,git:null,receiptSHA256:crypto.createHash('sha256').update(bytes).digest('hex')};
}

export function retainedDiagnosticPatchFiles(commit,attention) {
  const current=commit==='1305843c735380f912619548b121cba8601f2f85';
  assert(current||commit==='d02b6a20a7662300003c859e186ceb5bec7aa849','Unreviewed diagnostic revision');
  const pairs=current ? [
    ['q36-metal-runtime/runtime-1305843.patch','apply-q36-metal-runtime.sh'],
    ['q36-agent-tty/monitor.patch','apply-q36-agent-tty.sh'],
    ['q36-agent-tty/monitor-owner.patch','apply-q36-agent-tty.sh'],
    ['q36-metal-runtime/cache-usage.patch','apply-q36-metal-runtime.sh'],
    ...(attention ? [['q36-f16-attention/online-1305843.patch','apply-q36-f16-attention.sh']] : []),
    ['q36-metal-diagnostics/runtime.patch','apply-q36-metal-diagnostics.sh']
  ] : [
    ['q36-metal-runtime/runtime.patch','apply-q36-metal-runtime.sh'],
    ['q36-agent-tty/runtime.patch','apply-q36-agent-tty.sh'],
    ['q36-metal-diagnostics/runtime.patch','apply-q36-metal-diagnostics.sh'],
    ...(attention ? [['q36-f16-attention/runtime.patch','apply-q36-f16-attention.sh']] : [])
  ];
  return pairs.map(([patch,script])=>({patch:'patch/'+patch,script:'scripts/'+script}));
}

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

export function diagnosticSourceNames(engine,patchFiles=[]) {
  if(!ownGitRevision(engine)) {
    // Use the installer's actual compiler-input census. An archive inside
    // DStudio must never inherit DStudio's Git HEAD or list its source files.
    const installer=path.resolve(import.meta.dirname,'../../scripts/install-q36.py');
    const code='import importlib.util,json,sys; from pathlib import Path; s=importlib.util.spec_from_file_location("installer",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.source_identity(Path(sys.argv[2]),installed=True)))';
    const inventory=JSON.parse(execFileSync('python3',['-B','-c',code,installer,engine],
      {encoding:'utf8',timeout:10000,maxBuffer:1024*1024}));
    const names=new Set(Object.keys(inventory));
    // Patch round-trips also need upstream tests/documentation touched by a
    // reviewed adaptation, even when they are not compiler inputs. Headers
    // only route the snapshot; actual application proves compatibility.
    for(const file of patchFiles)for(const [,name]of fs.readFileSync(file,'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)) {
      assert(!path.isAbsolute(name)&&!name.split('/').some(p=>!p||p==='.'||p==='..'));
      names.add(name);
    }
    return [...names];
  }
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
