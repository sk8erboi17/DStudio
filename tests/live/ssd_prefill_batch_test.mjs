import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

assert.equal(process.platform,'darwin','NOT RUN: macOS Metal required');
const repo=process.cwd();
const source=path.resolve(process.argv[2] || 'ds4');
const model=path.resolve(process.argv[3] || path.join(source,'gguf/DeepSeek-V4-Flash-Vision-Exp-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf'));
const encoder=path.resolve(process.argv[4] || path.join(source,'gguf/DeepSeek-V4-Flash-Vision-Encoder.gguf'));
for (const file of [model,encoder]) assert.ok(fs.statSync(file).size>0,'NOT RUN: existing real weights required');
fs.mkdirSync('tests/.artifacts',{recursive:true});
const root=fs.mkdtempSync(path.resolve('tests/.artifacts/ssd-prefill-'));
const engine=path.join(root,'engine');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const receipt={passed:false,scope:'real Metal kernels + real transformer layer 0; NOT full-LLM/PDF E2E',
  context:131072,ssd:true,cacheExperts:256,model,modelBytes:fs.statSync(model).size,encoder,
  patchSHA256:hash(fs.readFileSync('patch/ds4-glm53-m2max/native-decode.patch')),steps:[],comparisons:[]};
const save=()=>fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(receipt,null,2));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('DS4_')));
async function run(command,args,{cwd=engine,expected=0,timeout=180000,extra={}}={}) {
  const name=`${String(receipt.steps.length+1).padStart(2,'0')}-${path.basename(command)}`;
  console.log(`Running ${name}`);
  const start=Date.now(),chunks=[];
  const child=spawn(command,args,{cwd,env:{...env,...extra},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>chunks.push(b));child.stderr.on('data',b=>chunks.push(b));
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
  let code;
  try {code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}
  finally {clearTimeout(timer);}
  const output=Buffer.concat(chunks).toString();
  fs.writeFileSync(path.join(root,name+'.log'),output);
  receipt.steps.push({command,args,code,timedOut,elapsedMs:Date.now()-start,log:name+'.log'});save();
  assert.ok(!timedOut,`${name}: TIMEOUT, not a passing negative test`);
  assert.equal(code,expected,`${name}: ${output.slice(-5000)}`);
  return output;
}
const hook=(name,action)=>run('sh',[path.join(repo,`scripts/apply-ds4-${name}.sh`),action],{extra:{DS4_DIR:engine}});
const objects=['ds4_image.o','ds4_distributed.o','ds4_tp.o','ds4_ssd.o','ds4_metal.o','ds4_layer_pack.o'];
async function compileLayer(name) {
  await run('make',['-j2',...objects]);
  const binary=path.join(root,name);
  await run('cc',['-O1','-std=c11','-D_GNU_SOURCE','-fno-finite-math-only','-I',engine,
    path.join(repo,'tests/live/ssd_prefill_batch_probe.c'),...objects.map(o=>path.join(engine,o)),
    '-framework','Foundation','-framework','Metal','-lm','-lpthread','-o',binary]);
  return binary;
}
async function compileQ2(name) {
  const binary=path.join(root,name);
  await run('cc',['-O3','-ffast-math','-fno-finite-math-only','-fobjc-arc','-I',engine,
    path.join(repo,'tests/live/ssd_batch_q2_probe.m'),path.join(engine,'ds4_image.o'),
    '-framework','Foundation','-framework','Metal','-lm','-lpthread','-o',binary]);
  return binary;
}
const layer=(binary,n,expected=0)=>run(binary,[model,encoder,path.join(root,'probe.lock'),String(n),
  path.join(root,`${path.basename(binary)}-${n}.f32`)],{expected,timeout:60000});
const counts=[1,2,139,760,761,1024];
try {
  // Only local clean Git objects, no model copies or writes to the user's engine.
  await run('git',['clone','-q','--shared',source,engine],{cwd:repo});
  receipt.commit=(await run('git',['rev-parse','HEAD'])).trim();
  for (const name of ['visible-downloads','media-memory','server-metrics','glm53-runtime','vision-streaming']) await hook(name,'apply');
  // Trusted reference is upstream without our GLM/M2 port, same weights/tokens.
  const reference=await compileLayer('layer-reference');
  for (const n of counts) await layer(reference,n);
  await hook('glm53-m2max','apply');
  await run('git',['apply','--reverse',path.join(repo,'patch/ds4-glm53-m2max/batch-entry-limit.patch')]);
  const brokenQ2=await compileQ2('q2-legacy');
  assert.match(await run(brokenQ2,[],{expected:1,timeout:60000}),/BATCH REJECTED: tokens=2 per_token=6 distinct=12/);
  const broken=await compileLayer('layer-legacy');
  assert.match(await layer(broken,139,1),/failed to encode down path tokens=139 unique=30/);
  // Upgrade exactly as the app does, without disabling the optimized path.
  assert.match(await hook('glm53-m2max','apply'),/upgraded batch resource limit/);
  await hook('glm53-m2max','apply');
  const fixedQ2=await compileQ2('q2-fixed');
  const oracle=await run(fixedQ2,[],{timeout:60000});
  assert.equal((oracle.match(/Q2 EXACT CPU ORACLE PASS/g)||[]).length,4);
  const fixed=await compileLayer('layer-fixed');
  for (const n of counts) {
    await layer(fixed,n);
    const before=fs.readFileSync(path.join(root,`layer-reference-${n}.f32`));
    const after=fs.readFileSync(path.join(root,`layer-fixed-${n}.f32`));
    assert.ok(after.equals(before),`all layer outputs must match upstream exactly for ${n} tokens (reference=${hash(before)}, fixed=${hash(after)})`);
    receipt.comparisons.push({tokens:n,floatValues:after.length/4,sha256:hash(after),bitwiseEqual:true});save();
  }
  // Preserve the original GLM top-8/cache numerical coverage as well.
  await run('make',['test-metal-stream-index']);
  receipt.passed=true;save();
  console.log(`PASS: old port fails, upgraded port passes 4 exact CPU kernel oracles and ${counts.length} bitwise upstream layer comparisons at 128k + SSD. Evidence: ${root}`);
} finally {save();}
