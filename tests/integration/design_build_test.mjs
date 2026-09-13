// Production host, script, patch application and filesystem operations. Only
// Make/compiler output is simulated here; native compilation has its own gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {artifactRunDir, sleep, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const probeInput = path.resolve(process.argv[2] || 'tests/.build/agent-build-probe');
const run = artifactRunDir('design-build');
// A rebuild elsewhere in the workspace must not change the executable halfway
// through this run. Support inputs are copied below for the same reason.
const probe = path.join(run,'builder-probe');
fs.copyFileSync(probeInput,probe);
const assets = path.join(run, 'support with spaces'), engine = path.join(run, 'engine with spaces');
const tools = path.join(run, 'tools'), countFile = path.join(run, 'compiler-count');
for (const dir of [assets, engine, tools]) fs.mkdirSync(dir);
for (const dir of ['extension/design', 'extension/remote', 'patch/ds4-media-memory'])
  fs.cpSync(path.join(root, dir), path.join(assets, dir), {recursive: true});
// Optional historical script reproduces the original defect in an isolated
// copy. It is never installed in the user's support tree.
const legacy = process.env.DSTUDIO_TEST_DESIGN_LEGACY;
if (legacy) {
  fs.copyFileSync(legacy, path.join(assets, 'extension/design/build-design.sh'));
  fs.mkdirSync(path.join(assets, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/apply-ds4-media-memory.sh'), path.join(assets, 'scripts/apply-ds4-media-memory.sh'));
}
const names = ['ds4.c', 'ds4.h', 'ds4_cuda.cu', 'ds4_gpu.h', 'ds4_metal.m', 'ds4_server.c', 'Makefile'];
for (const name of names) fs.copyFileSync(path.join(root, 'ds4', name), path.join(engine, name));
// A managed checkout may already own the memory patch. Normalize only this
// fixture, so fresh application and caller-owned complete application are both
// exercised. A failed/partial reverse is not silently accepted as a clean base.
const patchFile=path.join(assets,'patch/ds4-media-memory/residency-lease.patch');
const patchEnv={...process.env,GIT_CEILING_DIRECTORIES:run};
if(spawnSync('git',['-C',engine,'apply','--reverse','--check',patchFile],{env:patchEnv}).status===0)
  assert.equal(spawnSync('git',['-C',engine,'apply','--reverse',patchFile],{env:patchEnv}).status,0);
assert.equal(spawnSync('git',['-C',engine,'apply','--check',patchFile],{env:patchEnv}).status,0,'fixture is not a complete known patch base');
const binary = path.join(engine, 'ds4-design'), stamp = path.join(engine, 'ds4-design.ver');
fs.writeFileSync(binary, '#!/bin/sh\nprintf "old-runtime\\n"\n', {mode: 0o755});
fs.writeFileSync(stamp, 'historical-stamp\n');
fs.mkdirSync(path.join(engine, 'gguf'));
fs.writeFileSync(path.join(engine, 'gguf', 'private.gguf'), 'not a model, must remain untouched');
fs.writeFileSync(path.join(engine, 'ds4.o'), 'existing shared object');
fs.writeFileSync(path.join(engine, 'contributor-notes.txt'), 'unrelated user file');
const originals = new Map([...names, 'ds4.o', 'gguf/private.gguf', 'contributor-notes.txt'].map(name => [name, fs.readFileSync(path.join(engine, name))]));
const statIdentity = file => { const st = fs.statSync(file, {bigint: true}); return [st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].map(String).join(':'); };
const identities = new Map([...originals.keys()].map(name => [name, statIdentity(path.join(engine, name))]));
const snapshot = () => new Map([binary, stamp].map(file => [file, fs.readFileSync(file)]));
const assertSnapshot = before => { for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, file); };
const assertSources = () => { for (const [name, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(engine,name)), bytes, name); };
const stale = () => fs.writeFileSync(stamp, 'explicitly-stale\n');
const count = () => fs.existsSync(countFile) ? fs.readFileSync(countFile,'utf8').length : 0;
const env = extra => ({...process.env, PATH: `${tools}:${process.env.PATH}`, MAKEFLAGS:'', MFLAGS:'',
  DESIGN_TEST_COUNT:countFile, ...extra});
fs.writeFileSync(path.join(tools,'make'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('dstudio-design-config')) {
  if(process.env.DESIGN_TEST_REAL_CONFIG) {
    const r=require('node:child_process').spawnSync('/usr/bin/make',process.argv.slice(2),{stdio:'inherit'});process.exit(r.status===null?1:r.status);
  }
  process.stdout.write('simulated compiler v1 '+(process.env.CFLAGS||'')+'\\n'); process.exit(0);
}
fs.appendFileSync(process.env.DESIGN_TEST_COUNT,'1');
fs.writeFileSync('ds4-design','partial linker output',{mode:0o755});
if(process.env.DESIGN_TEST_GATE) {
  fs.writeFileSync(process.env.DESIGN_TEST_GATE+'.entered',JSON.stringify({pid:process.pid,cwd:process.cwd()}));
  fs.readFileSync(process.env.DESIGN_TEST_GATE);
}
if(process.env.DESIGN_TEST_FAIL)process.exit(17);
fs.writeFileSync('ds4-design',process.env.DESIGN_TEST_EMPTY?'':'#!/bin/sh\\nprintf "new-runtime\\\\n"\\n');
fs.chmodSync('ds4-design',process.env.DESIGN_TEST_NONEXEC?0o644:0o755);
if(process.env.DESIGN_TEST_LINK) {fs.unlinkSync('ds4-design');fs.symlinkSync(process.env.DESIGN_TEST_LINK,'ds4-design');}
`,{mode:0o755});

const report={scope:'Production Design builder; simulated compiler, real patch/files/processes. No inference.',
  probeSHA256:crypto.createHash('sha256').update(fs.readFileSync(probe)).digest('hex'),legacy:!!legacy,cases:[]};
function invoke(extra={},action='design') {
  const result=spawnSync(probe,[assets,engine,action],{encoding:'utf8',timeout:30000,env:env(extra)});
  fs.appendFileSync(path.join(run,'invocations.log'),JSON.stringify({action,extra,status:result.status,signal:result.signal})+'\n'+result.stdout+result.stderr);
  return result;
}
function pass(result) {assert.equal(result.status,0,result.error?.message||result.stdout+result.stderr);}
async function test(name,fn) {
  const row={name};
  try {await fn(row);row.status='PASS';}catch(error){row.status='FAIL';row.error=String(error.stack||error);}
  report.cases.push(row);writeArtifact(run,'progress.json',report);console.log(`${row.status}: ${name}${row.error?'\n'+row.error:''}`);
}
async function until(fn,message) {const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await sleep(50);}throw Error(message);}
const groups=new Set();let sequence=0;
async function blocked() {
  stale();const gate=path.join(run,`gate-${++sequence}`);
  assert.equal(spawnSync('mkfifo',[gate]).status,0);
  const log=fs.openSync(path.join(run,`held-${sequence}.log`),'wx');
  const child=spawn(probe,[assets,engine,'design'],{detached:true,stdio:['ignore',log,log],env:env({DESIGN_TEST_GATE:gate})});
  fs.closeSync(log);groups.add(child.pid);
  let exited;
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited={code,signal};resolve(exited);}));
  await until(()=>{if(exited)throw Error(`builder exited before compiler barrier: ${JSON.stringify(exited)}`);return fs.existsSync(gate+'.entered');},'compiler did not enter the deterministic FIFO barrier');
  const marker=JSON.parse(fs.readFileSync(gate+'.entered'));
  return {child,exit,marker,
    release(){const fd=fs.openSync(gate,fs.constants.O_WRONLY|fs.constants.O_NONBLOCK);fs.writeSync(fd,'continue');fs.closeSync(fd);},
    kill(){try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}};
}

try {
  await test('failed link preserves the old executable, stamp and every original source/object',()=>{
    const before=snapshot(),n=count();assert.equal(invoke({DESIGN_TEST_FAIL:'1'}).status,1);assert.equal(count(),n+1,'reached the failing linker');assertSnapshot(before);assertSources();
  });
  if(!legacy) {
    await test('successful private build publishes an executable without altering source identities',()=>{
      pass(invoke());assertSources();
      for(const [name,identity] of identities)assert.equal(statIdentity(path.join(engine,name)),identity,name);
      const result=spawnSync(binary,[],{encoding:'utf8'});assert.equal(result.status,0);assert.equal(result.stdout,'new-runtime\n');
      assert(!fs.readdirSync(engine).some(name=>name.startsWith('.ds4ui-design-build-')),'private stage cleanup');
    });
    await test('repeat and status reuse a byte-bound receipt, not a timestamp',()=>{
      const n=count(),before=snapshot();pass(invoke());const result=invoke({},'design-status');pass(result);assert.match(result.stdout,/up to date/);
      assert.equal(count(),n);assertSnapshot(before);assertSources();
    });
    await test('changed binary bytes cannot borrow an old valid stamp',()=>{
      fs.appendFileSync(binary,'# corrupted after build\n');const result=invoke({},'design-status');pass(result);assert.match(result.stdout,/needs rebuild/);
      const n=count();pass(invoke());assert.equal(count(),n+1);
    });
    await test('shared remote Unicode header invalidates the private Design build by bytes',()=>{
      pass(invoke()); const n=count(), file=path.join(assets,'extension/remote/dstudio_wire_string.h');
      const bytes=fs.readFileSync(file), stat=fs.statSync(file);
      try {
        fs.appendFileSync(file,'\n/* isolated transport-header revision */\n');
        fs.utimesSync(file,stat.atime,stat.mtime);
        pass(invoke()); assert.equal(count(),n+1);
        pass(invoke()); assert.equal(count(),n+1);
      } finally {fs.writeFileSync(file,bytes);}
    });
    await test('compiler configuration and untracked GPU/header inputs invalidate freshness',()=>{
      const n=count();pass(invoke({CFLAGS:'-O1 -DDS4_NO_GPU'}));assert.equal(count(),n+1);
      pass(invoke({CFLAGS:'-O1 -DDS4_NO_GPU'}));assert.equal(count(),n+1);
      fs.mkdirSync(path.join(engine,'cuda'));
      fs.writeFileSync(path.join(engine,'cuda','new.cuh'),'// untracked input\n');
      pass(invoke({CFLAGS:'-O1 -DDS4_NO_GPU'}));assert.equal(count(),n+2);
    });
    await test('real Make configuration detects a compiler wrapper changed without a version change',()=>{
      const wrapper=path.join(tools,'cc');fs.writeFileSync(wrapper,'#!/bin/sh\nexec /usr/bin/cc "$@"\n',{mode:0o755});
      const extra={DESIGN_TEST_REAL_CONFIG:'1',CC:'cc',CFLAGS:'-O1 -DDS4_NO_GPU'},n=count();
      try {pass(invoke(extra));assert.equal(count(),n+1);pass(invoke(extra));assert.equal(count(),n+1);
        fs.appendFileSync(wrapper,'# changed wrapper bytes, same --version\n');pass(invoke(extra));assert.equal(count(),n+2);
      }finally{fs.unlinkSync(wrapper);}
    });
    await test('partial patch is rejected as a whole, with old runtime and contributor edit preserved',()=>{
      const file=path.join(engine,'ds4.h');const data=fs.readFileSync(file);stale();const before=snapshot();
      fs.writeFileSync(file,data.toString().replace('int ds4_engine_set_power(ds4_engine *e, int power_percent);','int contributor_changed_public_api(void);'));
      const edited=fs.readFileSync(file),n=count();
      try {assert.equal(invoke().status,1);assertSnapshot(before);assert.equal(count(),n);assert.deepEqual(fs.readFileSync(file),edited);}
      finally{fs.writeFileSync(file,data);}
    });
    await test('empty, non-executable and symlink linker results cannot replace a runtime',()=>{
      const target=path.join(run,'unrelated-executable');fs.writeFileSync(target,'do not touch',{mode:0o755});
      for(const extra of [{DESIGN_TEST_EMPTY:'1'},{DESIGN_TEST_NONEXEC:'1'},{DESIGN_TEST_LINK:target}]) {
        stale();const before=snapshot(),n=count();assert.equal(invoke(extra).status,1);assert.equal(count(),n+1);assertSnapshot(before);assert.equal(fs.readFileSync(target,'utf8'),'do not touch');
      }
    });
    await test('a complete already-applied patch remains owned by the caller',()=>{
      const patch=path.join(assets,'patch/ds4-media-memory/residency-lease.patch');
      const result=spawnSync('git',['-C',engine,'apply',patch],{encoding:'utf8',env:{...process.env,GIT_CEILING_DIRECTORIES:run}});
      assert.equal(result.status,0,result.stderr);const applied=new Map(names.map(name=>[name,fs.readFileSync(path.join(engine,name))]));
      try {pass(invoke());for(const [name,bytes]of applied)assert.deepEqual(fs.readFileSync(path.join(engine,name)),bytes);}
      finally {for(const name of names)fs.writeFileSync(path.join(engine,name),originals.get(name));}
    });
    await test('complete legacy labels normalize privately; a partial legacy edit is preserved and rejected',()=>{
      const common=path.join(assets,'patch/ds4-media-memory/residency-lease.patch');
      const labels=path.join(assets,'patch/ds4-media-memory/legacy-labels.patch');
      function apply(...args) {const r=spawnSync('git',['-C',engine,'apply',...args],{encoding:'utf8',env:{...process.env,GIT_CEILING_DIRECTORIES:run}});assert.equal(r.status,0,r.stderr);}
      apply(common);apply('--reverse',labels);
      const legacyBytes=new Map(names.map(name=>[name,fs.readFileSync(path.join(engine,name))]));
      try {pass(invoke());for(const [name,bytes]of legacyBytes)assert.deepEqual(fs.readFileSync(path.join(engine,name)),bytes);
        const file=path.join(engine,'ds4.c');fs.writeFileSync(file,legacyBytes.get('ds4.c').toString().replace('temporary Qwen memory pressure active','contributor custom memory pressure active'));
        const edited=fs.readFileSync(file),before=snapshot(),n=count();assert.equal(invoke().status,1);assert.equal(count(),n);assertSnapshot(before);assert.deepEqual(fs.readFileSync(file),edited);
      }finally{for(const name of names)fs.writeFileSync(path.join(engine,name),originals.get(name));}
    });
    await test('an original header changed during compilation rejects the private candidate',async row=>{
      const held=await blocked(),before=snapshot(),file=path.join(engine,'ds4.h'),bytes=fs.readFileSync(file);row.compiler=held.marker;
      try {assertSources();fs.appendFileSync(file,'\n/* contributor edit during compile */\n');const edited=fs.readFileSync(file);
        held.release();assert.equal((await held.exit).code,1);assertSnapshot(before);assert.deepEqual(fs.readFileSync(file),edited);
      }finally{held.kill();fs.writeFileSync(file,bytes);}
    });
    await test('Design, Agent and Chat contenders share the inherited build lease',async row=>{
      const held=await blocked(),before=snapshot(),n=count();row.compiler=held.marker;
      try {for(const action of ['design','build','server']) {const result=invoke({},action);assert.equal(result.status,1);assert.match(result.stderr,/build is busy/);}
        assert.equal(count(),n);assertSnapshot(before);held.release();assert.equal((await held.exit).code,0);
      }finally{held.kill();}
    });
    await test('a surviving compiler cannot publish after its native parent dies',async row=>{
      const held=await blocked(),before=snapshot();row.compiler=held.marker;
      try {process.kill(held.child.pid,'SIGKILL');assert.equal((await held.exit).signal,'SIGKILL');process.kill(held.marker.pid,0);
        assert.equal(invoke().status,1);held.release();
        await until(()=>{const r=invoke({},'design-status');return r.status===0;},'compiler lease did not release');
        assertSnapshot(before);assertSources();pass(invoke());
      }finally{held.kill();}
    });
    await test('killing the whole build group leaves original data usable and permits retry',async row=>{
      const held=await blocked(),before=snapshot();row.compiler=held.marker;
      try {held.kill();assert.equal((await held.exit).signal,'SIGKILL');assertSnapshot(before);assertSources();
        await until(()=>invoke().status===0,'new build did not recover after process-group death');
      }finally{held.kill();}
    });
    await test('replacing a scratch pathname cannot redirect writes or cleanup into another directory',async row=>{
      const held=await blocked(),before=snapshot();row.compiler=held.marker;
      const stage=path.dirname(held.marker.cwd),moved=stage+'-moved',protectedDir=path.join(run,'protected-directory');
      fs.mkdirSync(protectedDir);fs.writeFileSync(path.join(protectedDir,'source-list.next'),'preserve this list');
      fs.writeFileSync(path.join(protectedDir,'prepared.ver'),'preserve this receipt');
      try {fs.renameSync(stage,moved);fs.symlinkSync(protectedDir,stage);held.release();assert.equal((await held.exit).code,1);
        assertSnapshot(before);assert.equal(fs.readFileSync(path.join(protectedDir,'source-list.next'),'utf8'),'preserve this list');
        assert.equal(fs.readFileSync(path.join(protectedDir,'prepared.ver'),'utf8'),'preserve this receipt');
        assert.deepEqual(fs.readdirSync(protectedDir).sort(),['prepared.ver','source-list.next']);
      }finally{held.kill();if(fs.lstatSync(stage).isSymbolicLink())fs.unlinkSync(stage);}
    });
    await test('only the engine own Git identity affects freshness, never an ancestor repository',()=>{
      pass(invoke());const n=count();
      function git(cwd,...args){const r=spawnSync('git',['-C',cwd,'-c','core.hooksPath=/dev/null',...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
      git(run,'init','-q');git(run,'config','user.name','DStudio test');git(run,'config','user.email','test@dstudio.invalid');
      fs.writeFileSync(path.join(run,'parent-note'),'parent');git(run,'add','parent-note');git(run,'commit','-qm','parent identity');
      pass(invoke());assert.equal(count(),n);
      git(engine,'init','-q');git(engine,'config','user.name','DStudio test');git(engine,'config','user.email','test@dstudio.invalid');
      git(engine,'add','ds4.h');git(engine,'commit','-qm','engine identity');
      pass(invoke());assert.equal(count(),n+1);pass(invoke());assert.equal(count(),n+1);
      fs.writeFileSync(path.join(engine,'revision-note'),'new revision');git(engine,'add','revision-note');git(engine,'commit','-qm','new engine revision');
      pass(invoke());assert.equal(count(),n+2);
    });
    await test('source and publication symlinks are rejected without touching their target',()=>{
      const target=path.join(run,'protected');fs.writeFileSync(target,'preserve');
      const linked=path.join(engine,'injected.h');fs.symlinkSync(target,linked);
      try {assert.equal(invoke().status,1);}finally{fs.unlinkSync(linked);}
      fs.unlinkSync(binary);fs.symlinkSync(target,binary);
      try {assert.equal(invoke().status,1);assert.equal(fs.readFileSync(target,'utf8'),'preserve');}
      finally{fs.unlinkSync(binary);}
    });
  }
} finally {
  for(const pid of groups){try{process.kill(-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
  report.status=report.cases.length===(legacy?1:18)&&report.cases.every(row=>row.status==='PASS')?'PASS':'FAIL';
  writeArtifact(run,'results.json',report);console.log(`Preserved Design build evidence: ${run}`);process.exitCode=report.status==='PASS'?0:1;
}
