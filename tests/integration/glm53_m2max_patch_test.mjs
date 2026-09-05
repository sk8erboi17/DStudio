// Real patch lifecycle on sparse source fixtures. No model or compiler needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const script = path.resolve('scripts/apply-ds4-glm53-m2max.sh');
const patch = fs.readFileSync('patch/ds4-glm53-m2max/native-decode.patch', 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-glm-port-'));
const checkout = path.join(root, 'engine with spaces');
const bin = path.join(root, 'bin');
const before = new Map();
const files = [];
try {
  fs.mkdirSync(checkout); fs.mkdirSync(bin);
  // Mac-only packaging logic is testable without a Metal device.
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\nprintf "%s\\n" "${TEST_SYSTEM:-Darwin}"\n', {mode:0o755});
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  // Reconstruct old-side hunks at their original line numbers. Unchanged
  // regions are padding: this tests all shipped anchors, not model mechanics.
  for (const section of patch.split(/^diff --git /m).slice(1)) {
    const name = section.match(/^a\/(\S+) b\/(\S+)/)[2];
    files.push(name);
    if (/^new file mode /m.test(section)) continue;
    const out = [];
    let inHunk = false;
    for (const line of section.split('\n')) {
      const header = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
      if (header) {
        while (out.length < Number(header[1]) - 1) out.push('');
        inHunk = true;
      } else if (inHunk && (line[0] === ' ' || line[0] === '-')) out.push(line.slice(1));
    }
    if (name === 'ds4.c') out.push('// static bool ds4_model_is_glm53');
    const bytes = Buffer.from(out.join('\n') + '\n');
    fs.mkdirSync(path.dirname(path.join(checkout, name)), {recursive:true});
    fs.writeFileSync(path.join(checkout, name), bytes);
    before.set(name, bytes);
  }
  const snapshot = () => new Map(files.map(name => [name,
    fs.existsSync(path.join(checkout,name)) ? fs.readFileSync(path.join(checkout,name)) : null]));
  const run = (action, extra={}) => spawnSync('sh', [script, action], {
    encoding:'utf8', env:{...process.env, DS4_DIR:checkout, PATH:`${bin}:${process.env.PATH}`, ...extra}
  });
  const pass = action => { const r=run(action); assert.equal(r.status,0,r.stderr+r.stdout); return r; };
  const initial = snapshot();
  assert.match(pass('check').stdout, /applicable/); assert.deepEqual(snapshot(),initial);
  pass('apply'); const applied = snapshot(); assert.notDeepEqual(applied, initial);
  assert.ok(applied.get('tests/test_metal_stream_index.m'));
  assert.match(pass('apply').stdout, /already applied/); assert.deepEqual(snapshot(),applied);
  pass('check'); assert.deepEqual(snapshot(),applied);
  pass('restore'); assert.deepEqual(snapshot(),initial);
  pass('restore'); assert.deepEqual(snapshot(),initial);
  assert.ok(!fs.existsSync(path.join(root,'.git/index')), 'parent Git index untouched');

  // Fail before applying any other hunk when the final file has drifted.
  const metal = path.join(checkout,'metal/moe.metal');
  fs.writeFileSync(metal, 'user changed this file\n');
  let saved = snapshot(); let result=run('apply');
  assert.equal(result.status,1); assert.match(result.stderr,/source drift or partial patch/);
  assert.deepEqual(snapshot(),saved);
  fs.writeFileSync(metal,before.get('metal/moe.metal'));

  pass('apply');
  fs.writeFileSync(path.join(checkout,'ds4_bench.c'),before.get('ds4_bench.c'));
  saved=snapshot(); result=run('apply');
  assert.equal(result.status,1); assert.deepEqual(snapshot(),saved);
  result=run('restore'); assert.equal(result.status,1); assert.deepEqual(snapshot(),saved);
  fs.writeFileSync(path.join(checkout,'ds4_bench.c'),applied.get('ds4_bench.c'));
  pass('restore'); assert.deepEqual(snapshot(),initial);

  // An unrelated edit survives both directions, including shifted hunk lines.
  const core = path.join(checkout,'ds4.c');
  fs.writeFileSync(core, Buffer.concat([Buffer.from('// user preamble\n'),before.get('ds4.c')]));
  saved=snapshot(); pass('apply'); pass('restore'); assert.deepEqual(snapshot(),saved);
  result=run('invalid'); assert.equal(result.status,2); assert.deepEqual(snapshot(),saved);
  result=run('apply',{TEST_SYSTEM:'Linux'}); assert.equal(result.status,0);
  assert.deepEqual(snapshot(),saved);
  fs.writeFileSync(core,'// non-GLM engine\n'); saved=snapshot();
  assert.match(pass('apply').stdout,/non-GLM checkout skipped/); assert.deepEqual(snapshot(),saved);
  console.log('GLM M2 Max patch: all anchors, check/apply/restore, idempotence, drift, partial state, unrelated edits, spaces, parent Git and platform gates PASS');
} finally {
  fs.rmSync(root,{recursive:true,force:true});
}

// Optional pinned-source stack check; --shared uses only local Git objects and
// never copies untracked GGUFs. Legacy patch(1) .orig files are left visible.
if (process.argv[2]) {
  const stack = fs.mkdtempSync(path.join(os.tmpdir(),'dstudio-glm-stack-'));
  const engine = path.join(stack,'engine');
  const run = (cmd,args,extra={}) => {
    const r=spawnSync(cmd,args,{encoding:'utf8',...extra});
    assert.equal(r.status,0,r.stderr+r.stdout);
    process.stdout.write(r.stdout);
    return r;
  };
  try {
    run('git',['clone','-q','--shared',path.resolve(process.argv[2]),engine]);
    const hooks=['visible-downloads','media-memory','server-metrics','glm53-runtime','glm53-m2max'];
    const hook = (name,action) => run('sh',[`scripts/apply-ds4-${name}.sh`,action],{
      env:{...process.env,DS4_DIR:engine}
    });
    for (const name of hooks) hook(name,'apply');
    hook('glm53-m2max','check');
    for (const name of [...hooks].reverse()) hook(name,'restore');
    run('git',['-C',engine,'diff','--exit-code']);
    run('git',['-C',engine,'status','--short']);
    console.log('Pinned main: complete managed patch stack and exact tracked-source restoration PASS');
  } finally {
    fs.rmSync(stack,{recursive:true,force:true});
  }
}
