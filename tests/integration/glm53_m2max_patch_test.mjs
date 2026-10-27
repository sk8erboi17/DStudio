// Real patch lifecycle on a copy of the bundled main sources (src/engines/ds4).
// No model or compiler needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const script = path.resolve('scripts/apply-ds4-glm53-m2max.sh');
const engineSource = path.resolve('src/engines/ds4');
// Every file the composed port touches; the hook itself composes the patch.
const files = [...new Set(['native-decode-main-qwen.patch', 'build-main-current.patch', 'hotlist-main-layout.patch']
  .flatMap(f => fs.readFileSync(path.join('patch/ds4-glm53-m2max', f), 'utf8').match(/^\+\+\+ b\/\S+/gm))
  .map(line => line.slice(6)))];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-glm-port-'));
const checkout = path.join(root, 'engine with spaces');
const bin = path.join(root, 'bin');
const before = new Map();
try {
  fs.mkdirSync(checkout); fs.mkdirSync(bin);
  // Mac-only packaging logic is testable without a Metal device.
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\nprintf "%s\\n" "${TEST_SYSTEM:-Darwin}"\n', {mode:0o755});
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  for (const name of files) {
    const from = path.join(engineSource, name);
    if (!fs.existsSync(from)) continue; // created by the port
    fs.mkdirSync(path.dirname(path.join(checkout, name)), {recursive:true});
    fs.copyFileSync(from, path.join(checkout, name));
    before.set(name, fs.readFileSync(from));
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

  // Install the previously shipped release using its reversible migration
  // delta. Exercise the actual hook; compare every output file, not anchors.
  const installLegacy = () => {
    pass('apply');
    const r = spawnSync('git', ['-C', checkout, 'apply', '--reverse',
      path.resolve('patch/ds4-glm53-m2max/batch-entry-limit.patch')], {
      encoding:'utf8', env:{...process.env, GIT_CEILING_DIRECTORIES:root}
    });
    assert.equal(r.status,0,r.stderr+r.stdout);
  };
  installLegacy(); const legacy = snapshot();
  assert.notDeepEqual(legacy,applied);
  assert.match(pass('check').stdout,/upgrade available/); assert.deepEqual(snapshot(),legacy);
  assert.match(pass('apply').stdout,/upgraded batch resource limit/);
  assert.deepEqual(snapshot(),applied);
  pass('apply'); assert.deepEqual(snapshot(),applied);
  installLegacy(); pass('restore'); assert.deepEqual(snapshot(),initial);
  installLegacy();
  fs.writeFileSync(path.join(checkout,'ds4_bench.c'),before.get('ds4_bench.c'));
  const partialLegacy=snapshot();
  for (const action of ['check','apply','restore']) {
    assert.equal(run(action).status,1); assert.deepEqual(snapshot(),partialLegacy);
  }
  fs.writeFileSync(path.join(checkout,'ds4_bench.c'),applied.get('ds4_bench.c'));
  const legacyCore=path.join(checkout,'ds4.c');
  fs.writeFileSync(legacyCore,Buffer.concat([Buffer.from('// preserved user edit\n'),legacy.get('ds4.c')]));
  pass('apply');
  assert.deepEqual(fs.readFileSync(legacyCore),Buffer.concat([Buffer.from('// preserved user edit\n'),applied.get('ds4.c')]));
  pass('restore'); fs.writeFileSync(legacyCore,before.get('ds4.c'));
  assert.deepEqual(snapshot(),initial);

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
  console.log('GLM M2 Max patch (bundled main): lifecycle, legacy migration/restore, idempotence, drift, partial state, preserved edits and platform gates PASS');
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
    const hooks=['visible-downloads','media-memory','server-metrics','glm53-runtime','glm53-m2max','vision-streaming'];
    if (process.argv.includes('--unified-qwen')) hooks.push('qwen38-prepare');
    const hook = (name,action) => run('sh',[`scripts/apply-ds4-${name}.sh`,action],{
      env:{...process.env,DS4_DIR:engine}
    });
    for (const name of hooks) hook(name,'apply');
    hook('glm53-m2max','check');
    hook('vision-streaming','check');
    if (process.argv.includes('--unified-qwen')) {
      hook('qwen38-prepare','check');
      hook('qwen38-prepare','apply');
      const probe=path.join(stack,'hotlist-layout');
      run('cc',['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer',
        '-ffunction-sections','-fdata-sections','-Wno-unused-function','-I',engine,
        'tests/support/main_hotlist_layout_probe.c','-Wl,-dead_strip','-lm','-pthread','-o',probe]);
      run(probe,[]);
    }
    for (const name of [...hooks].reverse()) hook(name,'restore');
    run('git',['-C',engine,'diff','--exit-code']);
    run('git',['-C',engine,'status','--short']);
    console.log('Pinned main: complete managed patch stack and exact tracked-source restoration PASS');
  } finally {
    fs.rmSync(stack,{recursive:true,force:true});
  }
}
