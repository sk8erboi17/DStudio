// Execute the native downloader with tiny hashed fixture payloads. Network
// transport is simulated; this does not download or validate real model weights.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {ownGitRevision} from '../support/quality_baseline.mjs';

const root=process.cwd(), engine=fs.realpathSync(process.argv[2] || 'ds4');
const run=artifactRunDir('main-qwen-download'), bin=path.join(run,'bin'), out=path.join(run,'gguf');
fs.mkdirSync(bin); fs.mkdirSync(out);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const releases=[
  {target:'ds41f-q2', file:'DeepSeek-V4.1-Flash-Q2.gguf', bytes:365713686528,
    sha:'1ce6a8f8806205c13330d7ca287bd198331dc5ca35ccc5d8a9a92a188a6f6f42', repo:'antirez/deepseek-v4.1-flash-gguf', revision:'dd8a266f7145edc19e2334b46e19b6821f221dc7'},
  {target:'qwen38-q2', file:'Qwen3.8-Flash-Next-Q2.gguf', bytes:147207127040,
    sha:'b1b93fa69aca5f187b0fb813aca8f3ec1beb5cf8cf0bd38cf041b93e0b6ccac9', repo:'antirez/qwen3.8-flash-next-gguf', revision:'d600fe1a43d2e1cdcadb85144ce3142f66f9eefe'},
  {target:'qwen38-q4k', file:'Qwen3.8-Flash-Next-Q4.gguf', bytes:177280286720,
    sha:'680944460a8cbe93ba8b6d7b6107213ffb7e22320bd913000e563ca0a0f25a8a', repo:'antirez/qwen3.8-flash-next-gguf', revision:'d600fe1a43d2e1cdcadb85144ce3142f66f9eefe'},
];
const payload=file=>Buffer.from(`independently hashed fixture: ${file}\n`);
const source=fs.readFileSync(path.join(engine,'download_model.sh'));
// Only scale the release fixture's byte/hash oracle, never bypass verification
// or substitute a hash command. Assertions below observe produced files/errors.
let script=source.toString();
for(const r of releases)script=script.replaceAll(`expected_bytes=${r.bytes}`,`expected_bytes=${payload(r.file).length}`)
  .replaceAll(`expected_sha=${r.sha}`,`expected_sha=${hash(payload(r.file))}`);
const downloader=path.join(run,'download_model.sh'); fs.writeFileSync(downloader,script,{flag:'wx'});
const requests=path.join(run,'hf.jsonl');
fs.writeFileSync(path.join(bin,'hf'),`#!${process.execPath}
const fs=require('fs'),path=require('path');const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify(a)+'\\n');
if(process.env.DSTUDIO_TEST_HF_FAIL==='1')process.exit(7);
if(a[0]!=='download'||!a.includes('--local-dir'))process.exit(8);
fs.writeFileSync(path.join(a[a.indexOf('--local-dir')+1],a[2]),'independently hashed fixture: '+a[2]+'\\n');
`,{flag:'wx',mode:0o755});
fs.writeFileSync(path.join(bin,'curl'),'#!/bin/sh\necho fixture-legacy-curl >&2\nexit 7\n',{flag:'wx',mode:0o755});
const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,DS4_GGUF_DIR:out};
const report={scope:'Native downloader with simulated transport and real small-file SHA verification; no model weights',
  revision:ownGitRevision(engine),sourceSHA256:hash(source),cases:[],passed:false};
const save=()=>writeArtifact(run,'results.json',report);
function download(target,ok=true,extra={}) {
  const r=spawnSync('sh',[downloader,target],{cwd:run,env:{...env,...extra},encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  report.cases.push({target,expectedSuccess:ok,code:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr});save();
  assert(!r.error && !r.signal);assert.equal(r.status===0,ok,r.stderr+r.stdout);return r;
}
try {
  for(const release of releases){
    download(release.target);
    const argv=fs.readFileSync(requests,'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(argv[0],'download');assert.equal(argv[1],release.repo);assert.equal(argv[2],release.file);
    assert.equal(argv[argv.indexOf('--revision')+1],release.revision);
    assert.equal(argv[argv.indexOf('--max-workers')+1],'1');
    assert.deepEqual(fs.readFileSync(path.join(out,release.file)),payload(release.file));
    assert.equal(fs.realpathSync(path.join(run,'ds4flash.gguf')),path.join(out,release.file));
    const before=fs.readFileSync(requests);download(release.target);
    assert.deepEqual(fs.readFileSync(requests),before,'verified existing file needs no transport');
  }
  // Neither a truncated file nor equal-length corrupt bytes may become success.
  const current=fs.realpathSync(path.join(run,'ds4flash.gguf'));
  for(const release of releases.slice(1)) {
    fs.writeFileSync(path.join(out,release.file),'short');
    assert.match(download(release.target,false).stderr,/Incorrect file size/i);
    fs.writeFileSync(path.join(out,release.file),Buffer.alloc(payload(release.file).length,120));
    const r=download(release.target,false);assert.match(r.stderr+r.stdout,/Checksum mismatch/i);
    fs.writeFileSync(path.join(out,release.file),payload(release.file));
  }
  assert.equal(fs.realpathSync(path.join(run,'ds4flash.gguf')),current);
  fs.unlinkSync(path.join(out,releases[1].file)); // Test-owned fixture, never user weights.
  download('qwen38-q2',false,{DSTUDIO_TEST_HF_FAIL:'1'});
  assert.equal(fs.realpathSync(path.join(run,'ds4flash.gguf')),current);
  assert(!fs.existsSync(path.join(out,releases[1].file)));
  const count=fs.readFileSync(requests,'utf8');
  const legacy=download('glm53-q2',false);assert.match(legacy.stderr,/fixture-legacy-curl/);
  assert.equal(fs.readFileSync(requests,'utf8'),count,'legacy GLM retains visible curl transport');
  assert(!fs.readdirSync(out).some(f=>/PLE/.test(f)),'no separate Qwen PLE request');
  assert.deepEqual(fs.readFileSync(path.join(engine,'download_model.sh')),source,'input checkout preserved');
  report.passed=true;console.log('PASS: main Qwen/DeepSeek download identities, bounded HF, real hashes, failures, reuse and legacy GLM routing');
}catch(e){report.error=e.stack;console.error(e);process.exitCode=1;}
finally{save();console.log(run);}
