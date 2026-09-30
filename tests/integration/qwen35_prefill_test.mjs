// Real hybrid-model operators and sessions with synthetic weights. Exact
// upstream single-token execution is the oracle; no held-out quality run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {artifactRunDir,writeArtifact} from '../support/real_harness.mjs';

const root=path.resolve(import.meta.dirname,'../..'),run=artifactRunDir('qwen35-prefill');
const tree=path.join(run,'candidate'),reference=path.join(run,'reference');
const script=path.join(root,'scripts/apply-ds4-qwen35-prefill.sh');
const patch=path.join(root,'patch/ds4-qwen35-prefill/prefill-73434c4.patch');
const files=['ds4.c','ds4_gpu.h','ds4_metal.m','metal/qwen35.metal'];
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const report={started:new Date().toISOString(),passed:false,commands:[],checks:[],cases:[],
  scope:'Real Metal hybrid recurrent/attention/MoE sessions, synthetic Q6_K/Q8_0 weights; original decode oracle, bounded prefill and cancellation; no model quality'};
const save=()=>writeArtifact(run,'results.json',report);
const env={...process.env};
for(const key of Object.keys(env)) if(/^(DS4|DYLD_|GIT_|MAKEFLAGS$|MFLAGS$)/.test(key)) delete env[key];
async function command(binary,args,cwd,extra={}) {
  const row={binary,args,cwd};report.commands.push(row);save();
  const result=await new Promise(resolve=>{
    const child=spawn(binary,args,{cwd,env:{...env,...extra},detached:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',error='',killTimer;
    const stop=reason=>{if(error)return;error=reason;try{process.kill(-child.pid,'SIGTERM');}catch{}
      killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1000);};
    const timer=setTimeout(()=>stop('240-second command deadline'),240000);
    child.stdout.on('data',d=>{stdout+=d;if(stdout.length>2**20)stop('stdout limit');});
    child.stderr.on('data',d=>{stderr+=d;if(stderr.length>2**20)stop('stderr limit');});
    child.on('error',e=>{error=String(e);});
    child.on('close',(status,signal)=>{clearTimeout(timer);clearTimeout(killTimer);resolve({status,signal,error,stdout,stderr});});
  });
  Object.assign(row,result);save();assert.equal(result.error,'');return result;
}
const check=name=>{report.checks.push(name);save();};
const apply=(action,dir=tree)=>command('/bin/sh',[script,action],dir,{DS4_DIR:dir});
function snapshot(input,output) {
  fs.mkdirSync(output);
  function visit(rel) {
    for(const entry of fs.readdirSync(path.join(input,rel),{withFileTypes:true})) {
      const name=path.join(rel,entry.name);
      if(entry.isDirectory()&&(rel==='' ? entry.name==='metal' : true))visit(name);
      else if(entry.isFile()&&(/\.(c|h|m|inc|metal)$/.test(entry.name)||entry.name==='Makefile')) {
        fs.mkdirSync(path.dirname(path.join(output,name)),{recursive:true});
        fs.copyFileSync(path.join(input,name),path.join(output,name),fs.constants.COPYFILE_EXCL);
      }
    }
  }
  visit('');
}
function bytes(dir=tree){return files.map(f=>fs.readFileSync(path.join(dir,f)));}
function restore(data){files.forEach((f,i)=>fs.writeFileSync(path.join(tree,f),data[i]));}
const objects=['ds4_metal.o','ds4_distributed.o','ds4_tp.o','ds4_ssd.o','ds4_layer_pack.o'];
async function build(dir,label) {
  let r=await command('make',['-j2',...objects],dir);assert.equal(r.status,0,r.stderr);
  const binary=path.join(run,label+'-probe');
  r=await command('cc',['-O2','-std=c11','-Wno-unused-function',
    ...(label==='batch'?['-DDSTUDIO_Q35_BATCH_PROBE']:[]),
    `-DDSTUDIO_QWEN35_SOURCE=${JSON.stringify(path.join(dir,'ds4.c'))}`,'-I',dir,
    path.join(root,'tests/support/qwen35_prefill_probe.c'),...objects.map(o=>path.join(dir,o)),
    '-lm','-pthread','-framework','Foundation','-framework','Metal','-o',binary],dir);
  assert.equal(r.status,0,r.stderr);return binary;
}
try {
  assert.equal(process.platform,'darwin','Metal unavailable: NOT RUN');
  const source=fs.realpathSync(process.argv[2]||'ds4-qwen35');snapshot(source,tree);
  const original=bytes(source);report.inputSHA256=Object.fromEntries(files.map((f,i)=>[f,sha(original[i])]));
  report.patchSHA256=sha(fs.readFileSync(patch));report.scriptSHA256=sha(fs.readFileSync(script));
  assert.equal((await apply('restore')).status,0);
  const q6=await command('/bin/sh',[path.join(root,'scripts/apply-ds4-qwen35-q6k-moe.sh'),'apply'],tree,{DS4_DIR:tree});
  assert.equal(q6.status,0,q6.stderr);
  snapshot(tree,reference);const baseline=bytes();
  assert.equal((await apply('check')).status,0);assert.deepEqual(bytes(),baseline);
  assert.equal((await apply('apply')).status,0);const adapted=bytes();
  assert(files.every((_,i)=>!adapted[i].equals(baseline[i])));
  assert.equal((await apply('apply')).status,0);assert.deepEqual(bytes(),adapted);
  assert.equal((await apply('restore')).status,0);assert.deepEqual(bytes(),baseline);
  check('check, apply, repeat apply and byte-exact restore');
  for(const f of files)fs.appendFileSync(path.join(tree,f),'\n/* unrelated contributor fixture */\n');
  const unrelated=bytes();assert.equal((await apply('apply')).status,0);assert.equal((await apply('restore')).status,0);
  assert.deepEqual(bytes(),unrelated);check('unrelated changes survive round-trip');restore(baseline);
  for(const f of files) {
    const r=await command('git',['apply','--include='+f,patch],tree,{GIT_CEILING_DIRECTORIES:run});assert.equal(r.status,0,r.stderr);
    const partial=bytes();for(const action of ['check','apply','restore']) {
      assert.equal((await apply(action)).status,1);assert.deepEqual(bytes(),partial);
    }
    restore(baseline);
    fs.writeFileSync(path.join(tree,f),'incompatible source fixture\n');const drift=bytes();
    assert.equal((await apply('apply')).status,1);assert.deepEqual(bytes(),drift);restore(baseline);
    const file=path.join(tree,f),saved=file+'.saved';fs.renameSync(file,saved);fs.symlinkSync(saved,file);
    assert.equal((await apply('apply')).status,2);assert.deepEqual(fs.readFileSync(saved),baseline[files.indexOf(f)]);
    fs.unlinkSync(file);fs.renameSync(saved,file);
  }
  check('every partial file, source drift and linked target rejected without mutation');
  assert.equal((await apply('apply')).status,0);
  // Q6_K decoding remains installed after the larger prefill overlay.
  assert.equal((await command('/bin/sh',[path.join(root,'scripts/apply-ds4-qwen35-q6k-moe.sh'),'check'],tree,{DS4_DIR:tree})).status,0);
  const scalar=await build(reference,'reference'),batch=await build(tree,'candidate');
  for(const q6 of [0,1]) for(const length of [1,17,64,65,130]) {
    const base=path.join(run,`${q6}-${length}`),expected=base+'.reference.bin',actual=base+'.batch.bin',cancelled=base+'.cancelled.bin';
    const a=await command(scalar,['scalar',String(length),String(q6),expected,base+'.unused'],reference);
    assert.equal(a.status,0,a.stderr);
    const b=await command(batch,['batch',String(length),String(q6),actual,cancelled],tree);
    assert.equal(b.status,0,b.stderr);
    const wanted=fs.readFileSync(expected),got=fs.readFileSync(actual);
    // All logits, all recurrent/conv state and every committed F16 KV row.
    assert(got.equals(wanted),`Q6=${q6}, length=${length}: decode differs; retained both state files`);
    assert(fs.readFileSync(cancelled).equals(got),'interrupted extension changes prior data');
    if(length===130 && q6===0)
      assert(fs.readFileSync(actual+'.long-attention').equals(fs.readFileSync(expected+'.long-attention')),
        'long-context attention tiles differ from the original single-query kernel');
    if(length>64)assert(fs.readFileSync(actual+'.prefix64').equals(
      fs.readFileSync(path.join(run,`${q6}-64.reference.bin`))), 'interrupted prefill loses the completed first chunk');
    report.cases.push({allQ6:!!q6,tokens:length,stateBytes:got.length,byteExact:true,
      checkpointSHA256:sha(got),cancelPreserved:true,details:JSON.parse(b.stdout.trim())});save();
  }
  check('10 batched sessions equal unmodified token-by-token execution byte for byte');
  check('append/replacement cancellation, candidate allocation failures and resumed session');
  const red=await command(scalar,['batch','17','0',path.join(run,'red.bin'),path.join(run,'red-cancel.bin')],reference);
  assert.notEqual(red.status,0,'the original one-token prefill must fail the batch gate');
  report.originalPrefillFailsBatchGate=true;
  for(const f of ['ds4.c','ds4_gpu.h','ds4_metal.m']) {
    const q=await command('make',['-q','-W',f,'ds4_metal.o'],tree);
    if(f!=='ds4.c')assert.equal(q.status,1,'GPU build must invalidate changed input');
  }
  assert.deepEqual(bytes(source),original,'user source changed');
  assert.equal(sha(fs.readFileSync(patch)),report.patchSHA256);assert.equal(sha(fs.readFileSync(script)),report.scriptSHA256);
  report.passed=true;
} catch(error) {report.error=error.stack||String(error);process.exitCode=1;}
finally {report.finished=new Date().toISOString();save();console.log(JSON.stringify({run,passed:report.passed,cases:report.cases.length,error:report.error}));}
