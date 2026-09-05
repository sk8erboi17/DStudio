// Exercise the real launcher builder against a throwaway checkout and a fake
// compiler. No model, network, source-checkout writes or engine process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const launcher=path.resolve(process.argv[2]||'tests/.build/dstudio-server-test');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dstudio-pld-build-'));
const checkout=path.join(root,'engine with spaces');
const bin=path.join(root,'bin');
const read=id=>fs.readFileSync(`patch/ds4-server-pld/${id}.find`,'utf8');
try {
  fs.mkdirSync(checkout);fs.mkdirSync(bin);
  const source=['001','002','003','004','005','006','007'].map(read).join('\n')+
    '\n    if (job_cancelled(j)) {\n';
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
const input=fs.readFileSync(0,'utf8');
fs.appendFileSync('build-count','1');
if(process.env.PLD_TEST_MAKE_FAIL){
  fs.writeFileSync('ds4-server-pld','partial linker output',{mode:0o755});
  process.exit(7);
}
fs.writeFileSync('ds4-server-pld','derived test binary',{mode:0o755});
`,{mode:0o755});
  const run=(extra={})=>spawnSync(launcher,['--build-server-pld',checkout],{
    encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,...extra}});
  const clean=()=>{
    for(const [name,bytes] of originals)assert.deepEqual(fs.readFileSync(path.join(checkout,name)),bytes,name);
    assert.ok(!fs.existsSync(path.join(checkout,'ds4_server_pld.c')));
    assert.ok(!fs.existsSync(path.join(checkout,'ds4_server_pld.o')));
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
  stale();result=run({PLD_TEST_MAKE_FAIL:'1'});assert.equal(result.status,1);clean();
  assert.ok(!fs.existsSync(path.join(checkout,'.ds4ui-server-pld-version')));
  result=run();assert.equal(result.status,0,result.stderr+result.stdout);clean();
  assert.equal(fs.readFileSync(path.join(checkout,'build-count'),'utf8'),'111');
  stale();fs.writeFileSync(path.join(checkout,'ds4_server.c'),source.replace(read('006'),'anchor drift\n'));
  result=run();assert.equal(result.status,1);assert.match(result.stderr,/anchor missing/);
  assert.ok(!fs.existsSync(path.join(checkout,'ds4_server_pld.c')));
  fs.writeFileSync(path.join(checkout,'ds4_server.c'),source);clean();
  fs.writeFileSync(path.join(checkout,'ds4.h'),'older ABI\n');
  result=run();assert.equal(result.status,0);assert.match(result.stdout,/unsupported ABI; native server retained/);
  assert.equal(fs.readFileSync(path.join(checkout,'build-count'),'utf8'),'111');
  console.log('Chat PLD builder: cache, failure cleanup, source preservation, spaces, drift and older ABI passed');
} finally {
  fs.rmSync(root,{recursive:true,force:true});
}
