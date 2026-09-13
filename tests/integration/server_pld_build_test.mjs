// Exercise the real launcher builder against a throwaway checkout and a fake
// compiler. No model, network, source-checkout writes or engine process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
const launcher=path.resolve(process.argv[2]||'tests/.build/dstudio-server-test');
const root=artifactRunDir('server-pld-build');
const checkout=path.join(root,'engine with spaces');
const bin=path.join(root,'bin');
const report={scope:'Production Chat PLD builder; simulated compiler and source fixture, no inference',
  started:new Date().toISOString(),builds:[],passed:false};
// Preimages are fixture plumbing for the real transformer/builder. Exact native
// output on the pinned sources has its independent runtime-patch-migration gate.
const preimages=fs.readFileSync('patch/ds4-server-pld/main-current.patch','utf8')
  .split(/\n@@[^\n]*\n/).slice(1).map(hunk=>hunk.split('\n')
    .filter(line=>line[0]===' '||line[0]==='-').map(line=>line.slice(1)).join('\n')+'\n');
try {
  fs.mkdirSync(checkout);fs.mkdirSync(bin);
  const source=preimages.join('\n/* unrelated fixture region */\n');
  fs.writeFileSync(path.join(checkout,'ds4_server.c'),source);
  fs.writeFileSync(path.join(checkout,'ds4.c'),'\nvoid ds4_session_gpu_warmup() {}\n');
  fs.writeFileSync(path.join(checkout,'ds4.h'),'dspark_exact_sampling\n');
  fs.writeFileSync(path.join(checkout,'Makefile'),'# test only\n');
  fs.writeFileSync(path.join(checkout,'ds4-server'),'native baseline\n');
  fs.writeFileSync(path.join(checkout,'ds4.o'),'normal core object\n');
  const originals=new Map(['ds4_server.c','ds4.c','ds4.h','ds4-server','ds4.o','Makefile']
    .map(name=>[name,fs.readFileSync(path.join(checkout,name))]));
  fs.writeFileSync(path.join(bin,'make'),`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const input=fs.readFileSync(0,'utf8');
fs.appendFileSync('build-count','1');
const out=process.argv.find(a=>a.startsWith('JSONL_OUT='))?.slice('JSONL_OUT='.length)||'.';
const target=path.join(out,'ds4-server-pld');
if(process.env.PLD_TEST_SWAP_STAGE){
  const replacement='unrelated-compiler-fixture',retained=out+'.retained';
  fs.mkdirSync(replacement);fs.writeFileSync(path.join(replacement,'keep'),'preserve this directory');
  fs.renameSync(out,retained);fs.symlinkSync(replacement,out);
  fs.writeFileSync('swapped-stage.json',JSON.stringify({out,retained,replacement}));
}
if(process.env.PLD_TEST_MAKE_FAIL){
  fs.writeFileSync(target,'partial linker output',{mode:0o755});
  process.exit(7);
}
if(process.env.PLD_TEST_MUTATE_SOURCE)fs.appendFileSync('ds4_server.c','\\n/* contributor edit during build */\\n');
if(process.env.PLD_TEST_OUTPUT==='missing')process.exit(0);
if(process.env.PLD_TEST_OUTPUT==='symlink'){
  fs.symlinkSync(path.resolve('ds4-server'),target);process.exit(0);
}
if(process.env.PLD_TEST_OUTPUT==='empty'){
  fs.writeFileSync(target,'',{mode:0o755});process.exit(0);
}
if(process.env.PLD_TEST_OUTPUT==='not-executable'){
  fs.writeFileSync(target,'link output',{mode:0o644});process.exit(0);
}
fs.writeFileSync(target,'derived test binary',{mode:0o755});
`,{mode:0o755});
  const run=(extra={})=>{
    const r=spawnSync(launcher,['--build-server-pld',checkout],{
      encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
      env:{...process.env,PATH:`${bin}:${process.env.PATH}`,...extra}});
    report.builds.push({extra,code:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr,error:r.error?.message});
    writeArtifact(root,'results.json',report);return r;
  };
  const clean=()=>{
    for(const [name,bytes] of originals)assert.deepEqual(fs.readFileSync(path.join(checkout,name)),bytes,name);
    assert.ok(!fs.existsSync(path.join(checkout,'ds4_server_pld.c')));
    assert.ok(!fs.existsSync(path.join(checkout,'ds4_server_pld.o')));
    assert.ok(!fs.readdirSync(checkout).some(name=>name.startsWith('.ds4ui-server-build-')));
  };
  let result=run();assert.equal(result.status,0,result.stderr+result.stdout);clean();
  assert.equal(fs.readFileSync(path.join(checkout,'build-count'),'utf8'),'1');
  result=run();assert.equal(result.status,0,result.stderr+result.stdout);clean();
  assert.equal(fs.readFileSync(path.join(checkout,'build-count'),'utf8'),'1','unchanged build is cached');
  if (process.platform === 'darwin') {
    const metal=path.join(checkout,'ds4_metal.m');
    fs.writeFileSync(metal,'updated Metal implementation\n');
    // Only Metal is newer. All other builder inputs keep their original times.
    const future=new Date(Date.now()+10000);
    fs.utimesSync(metal,future,future);
    result=run();assert.equal(result.status,0,result.stderr+result.stdout);clean();
    assert.equal(fs.readFileSync(path.join(checkout,'build-count'),'utf8'),'11','Metal-only patch forces relink');
    fs.utimesSync(metal,new Date(0),new Date(0));
    result=run();assert.equal(result.status,0,result.stderr+result.stdout);clean();
    assert.equal(fs.readFileSync(path.join(checkout,'build-count'),'utf8'),'11','rebuilt Metal is cached');
    fs.unlinkSync(metal);
    fs.writeFileSync(path.join(checkout,'build-count'),'1');
  }
  const stale=()=>fs.utimesSync(path.join(checkout,'ds4-server-pld'),new Date(0),new Date(0));
  const workingBinary=fs.readFileSync(path.join(checkout,'ds4-server-pld'));
  stale();result=run({PLD_TEST_MAKE_FAIL:'1'});assert.equal(result.status,1);clean();
  assert.deepEqual(fs.readFileSync(path.join(checkout,'ds4-server-pld')),workingBinary,
    'A failed linker must not overwrite the previously working Chat runtime');
  assert.ok(!fs.existsSync(path.join(checkout,'.ds4ui-server-pld-version')));
  result=run();assert.equal(result.status,0,result.stderr+result.stdout);clean();
  assert.equal(fs.readFileSync(path.join(checkout,'build-count'),'utf8'),'111');
  stale();fs.writeFileSync(path.join(checkout,'ds4_server.c'),source.replace(preimages[1],'upstream drift\n'));
  result=run();assert.equal(result.status,1);assert.match(result.stderr,/no complete exact-context unified patch/);
  assert.ok(!fs.existsSync(path.join(checkout,'ds4_server_pld.c')));
  fs.writeFileSync(path.join(checkout,'ds4_server.c'),source);clean();
  fs.writeFileSync(path.join(checkout,'ds4.h'),'older ABI\n');
  result=run();assert.equal(result.status,0);assert.match(result.stdout,/unsupported ABI; native server retained/);
  assert.equal(fs.readFileSync(path.join(checkout,'build-count'),'utf8'),'111');
  fs.writeFileSync(path.join(checkout,'ds4.h'),originals.get('ds4.h'));
  for(const kind of ['missing','symlink','empty','not-executable']){
    stale();result=run({PLD_TEST_OUTPUT:kind});assert.equal(result.status,1,kind);clean();
    assert.deepEqual(fs.readFileSync(path.join(checkout,'ds4-server-pld')),workingBinary,kind);
    assert.ok(!fs.existsSync(path.join(checkout,'.ds4ui-server-pld-version')),kind);
  }
  stale();result=run({PLD_TEST_MUTATE_SOURCE:'1'});assert.equal(result.status,1);
  assert.match(result.stderr,/source changed during build/);
  assert.equal(fs.readFileSync(path.join(checkout,'ds4_server.c'),'utf8'),source+'\n/* contributor edit during build */\n');
  assert.deepEqual(fs.readFileSync(path.join(checkout,'ds4-server-pld')),workingBinary);
  assert.ok(!fs.existsSync(path.join(checkout,'.ds4ui-server-pld-version')));
  fs.writeFileSync(path.join(checkout,'ds4_server.c'),source);clean();
  // This case intentionally preserves a renamed staging directory for diagnosis;
  // run it after the normal-cleanup cases without changing their assertions.
  stale();result=run({PLD_TEST_SWAP_STAGE:'1'});assert.equal(result.status,1);
  assert.match(result.stderr,/private Chat build directory changed/);
  const swapped=JSON.parse(fs.readFileSync(path.join(checkout,'swapped-stage.json')));
  assert(fs.lstatSync(path.join(checkout,swapped.out)).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(checkout,swapped.replacement,'keep'),'utf8'),'preserve this directory');
  assert.equal(fs.readFileSync(path.join(checkout,swapped.replacement,'ds4-server-pld'),'utf8'),'derived test binary');
  assert.deepEqual(fs.readdirSync(path.join(checkout,swapped.retained)),[], 'Cleanup is confined to the retained owned directory');
  assert.deepEqual(fs.readFileSync(path.join(checkout,'ds4-server-pld')),workingBinary);
  for(const [name,bytes] of originals)assert.deepEqual(fs.readFileSync(path.join(checkout,name)),bytes,name);
  assert.ok(!fs.existsSync(path.join(checkout,'.ds4ui-server-pld-version')));
  console.log('Chat PLD builder: cache, failure cleanup, source/directory ownership, spaces, drift and older ABI passed');
  report.passed=true;
} catch(error) {
  report.error=error.stack;throw error;
} finally {
  report.finished=new Date().toISOString();writeArtifact(root,'results.json',report);
  console.log(`Preserved Chat PLD builder evidence: ${root}`);
}
