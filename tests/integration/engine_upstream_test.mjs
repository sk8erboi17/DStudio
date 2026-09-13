// Real local Git histories/remotes, real patch checks and immutable receipts.
// These fixtures qualify the admission checker, never an actual engine release.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkUpstream, patchSetHash} from '../../scripts/check-engine-upstream.mjs';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const run = artifactRunDir('engine-upstream'), seed = path.join(run,'seed');
const remote = path.join(run,'remote.git'), candidate = path.join(run,'candidate');
const report = {scope:'Admission checker with controlled Git repositories; no engine qualification',
  started:new Date().toISOString(),cases:[],passed:false};
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const save = () => writeArtifact(run,'results.json',report);
const git = (dir,args,input) => {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  const r = spawnSync('git',['-C',dir,'-c','user.name=DStudio fixture','-c','user.email=fixture@invalid',
    ...args], {input,env,encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
  assert.equal(r.status,0,r.stderr || r.error?.message); return r.stdout.trim();
};
const write = (name, content) => {fs.writeFileSync(path.join(run,name),content); return {path:name,sha256:sha(content)};};
try {
  fs.mkdirSync(seed); git(seed,['init','-q','--initial-branch=main']);
  fs.writeFileSync(path.join(seed,'core.c'),'int value = 1;\n');
  git(seed,['add','core.c']); git(seed,['commit','-qm','baseline']);
  const base = git(seed,['rev-parse','HEAD']);
  fs.writeFileSync(path.join(seed,'core.c'),'int value = 2;\n');
  git(seed,['commit','-qam','native change']); const tip = git(seed,['rev-parse','HEAD']);
  git(run,['clone','-q','--bare',seed,remote]); git(run,['clone','-q',remote,candidate]);
  const patch = write('adaptation.patch','--- a/core.c\n+++ b/core.c\n@@ -1 +1 @@\n-int value = 2;\n+int value = 3;\n');
  patch.check = 'apply';
  const evidence = write('behavior.json',JSON.stringify({passed:true,meaning:'fixture output only'})+'\n');
  const receiptData = {passed:true,finished:'2026-09-08T00:00:00Z',
    qualification:{schema:'dstudio.engine-qualification.v1',target:'qwen38/metal/fixture',
      platform:'macos',engineRevision:tip,patchSetSHA256:patchSetHash([patch]),gate:'behavior',evidence:[evidence]}};
  const receipt = write('receipt.json',JSON.stringify(receiptData)+'\n');
  const manifest = {schemaVersion:1,
    tracks:[{id:'qwen38',repository:remote,ref:'refs/heads/main',base,recordedTip:tip}],
    targets:[{id:'qwen38/metal/fixture',sourceTrack:'qwen38',revision:tip,tracks:['qwen38'],
      platform:'macos',patches:[patch],requiredGates:['behavior'],receipts:[receipt],
      reviews:[{track:'qwen38',commit:tip,decision:'integrated',
        reason:'Controlled native-change fixture has matching behavioral evidence.',evidence:[evidence]}]}]};
  const check = (label, change, expected, options = {}) => {
    const m = structuredClone(manifest); change?.(m);
    const before = fs.readFileSync(path.join(candidate,'core.c'));
    const head = git(candidate,['rev-parse','HEAD']);
    const r = checkUpstream({manifest:m,root:run,repositories:{qwen38:candidate},...options});
    assert.equal(Object.values(r.issueCounts).reduce((sum,n)=>sum+n,0),r.issueCount);
    if (!r.issues.some(issue=>issue.subject==='manifest')) {
      const selected=m.targets.filter(t=>!options.platform || options.platform==='all' || t.platform===options.platform);
      assert.equal(r.targets.length,selected.length,'Failed targets disappeared from the matrix');
    }
    assert.deepEqual(fs.readFileSync(path.join(candidate,'core.c')),before,'Checker mutated source');
    assert.equal(git(candidate,['rev-parse','HEAD']),head,'Checker moved HEAD');
    if (expected === 'PASS') assert.equal(r.passed,true,JSON.stringify(r.issues));
    else {
      assert.equal(r.passed,false,label);
      assert(r.issues.some(i=>i.code === expected),JSON.stringify(r.issues));
    }
    options.inspect?.(r);
    report.cases.push({name:label,passed:true,observed:r}); save(); console.log('PASS: '+label);
  };
  check('exact history, patch, scoped receipt and review pass',null,'PASS');
  check('an empty platform selection cannot qualify a release',null,'MISSING_TARGETS',{platform:'windows'});
  check('another platform is outside this release, never counted as qualified',m=>{
    const other=structuredClone(m.targets[0]);other.id='qwen38/cuda/fixture';other.platform='linux';m.targets.push(other);
  },'PASS',{platform:'macos'});
  check('named patch sets bind the same exact input bytes',m=>{
    m.patchSets={native:m.targets[0].patches};delete m.targets[0].patches;m.targets[0].patchSet='native';
  },'PASS');
  check('unknown patch sets cannot drop required adaptations',m=>{
    delete m.targets[0].patches;m.targets[0].patchSet='missing';
  },'INVALID_MANIFEST');
  check('ambiguous patch set definitions are rejected',m=>m.targets[0].patchSet='also-present','INVALID_MANIFEST');
  const pins={schema:'dstudio.engine-pins.v1',engines:[{id:'fixture',commit:tip,archiveURL:remote+'/archive/'+tip}]};
  const metadataApp=(name, data, tail='')=>{
    const entry=write(name,`#!${process.execPath}\nimport fs from 'node:fs';\nif(process.argv[2]!=='--engine-pins')process.exit(2);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(data))});\n${tail}\n`);
    const app=path.join(run,entry.path);fs.chmodSync(app,0o755);return app;
  };
  const scoped=m=>{m.requireInstallerPins=true;m.targets[0].installerId='fixture';};
  const app=metadataApp('pin-export.mjs',pins);
  check('actual metadata protocol binds the compiled installer to the candidate',scoped,'PASS',{application:app});
  check('metadata probes cannot inherit interactive startup',scoped,'PASS',
    {application:metadataApp('headless-pin-export.mjs',pins,
      "if(process.env.DS4UI_NO_WINDOW!=='1'||process.env.DS4UI_TEST_MODE!=='1'||process.env.DS4UI_DEFER_ENGINE_START!=='1')process.exit(4);")});
  check('mandatory installer metadata cannot be omitted',scoped,'INVALID_MANIFEST');
  const stale=structuredClone(pins);stale.engines[0].commit=base;
  check('a compiled old pin cannot inherit new candidate results',scoped,'STALE_INSTALLER_PIN',
    {application:metadataApp('stale-pin-export.mjs',stale)});
  check('an unimplemented installer remains missing',m=>{scoped(m);m.targets[0].installerId='qwen27';},
    'INSTALLER_MISSING',{application:app});
  check('metadata exporter failure blocks publication',scoped,'PIN_EXPORT_FAILED',
    {application:metadataApp('failed-pin-export.mjs',pins,'process.exit(3);')});
  check('an executable changed during its metadata read is rejected',scoped,'INVALID_MANIFEST',
    {application:metadataApp('changed-pin-export.mjs',pins,"fs.appendFileSync(import.meta.filename,'\\n');")});
  if (process.platform === 'darwin') {
    // Run the production publication target with a tiny bundle fixture. Skip
    // its separately tested real-app smoke prerequisite; never replace the
    // production admission prerequisite or publication recipe with a mock.
    const bundle=path.join(run,'fixture.app');fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle,'fixture.txt'),'Publication gate fixture, not an application.\n');
    const env={...process.env};
    for(const key of Object.keys(env)) if(key.startsWith('GIT_') || ['MAKEFLAGS','MFLAGS','MAKELEVEL','MAKEOVERRIDES'].includes(key))delete env[key];
    const publish=(label, m, pass)=>{
      const input=write(label+'-manifest.json',JSON.stringify(m)+'\n');
      const archive=path.join(run,label+'.zip');
      const r=spawnSync('make',['-s','-o','test-macos-bundle','dist-macos',
        'APPDIR='+bundle,'DIST_DIR='+run,
        'MAC_ZIP='+archive,'MAC_SHA='+archive+'.sha256',
        'ENGINE_UPSTREAM_FLAGS=--root '+run+' --manifest '+input.path+' --repo qwen38='+candidate],
        {cwd:fileURLToPath(new URL('../../',import.meta.url)),env,encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
      writeArtifact(run,label+'-publication.log',(r.stdout||'')+(r.stderr||''));
      assert.equal(r.error,undefined);assert.equal(r.signal,null);
      assert.equal(r.status===0,pass,r.stderr);assert.equal(fs.existsSync(archive),pass);
      report.cases.push({name:label+' production publication dependency',passed:true,publicationAllowed:pass});save();
    };
    const missing=structuredClone(manifest);missing.targets[0].receipts=[];
    publish('missing-evidence',missing,false);
    publish('complete-fixture-evidence',manifest,true);
  }
  const foreignGit={GIT_DIR:path.join(seed,'.git'),GIT_WORK_TREE:seed,GIT_INDEX_FILE:path.join(seed,'.git/index'),
    GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'remote.origin.url',GIT_CONFIG_VALUE_0:'https://invalid.example/redirected'};
  const oldGit=Object.fromEntries(Object.keys(foreignGit).map(key=>[key,process.env[key]]));
  try {
    Object.assign(process.env,foreignGit);
    check('inherited Git context cannot redirect source or configuration',null,'PASS');
  } finally {
    for(const [key,value] of Object.entries(oldGit)) {
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
  git(candidate,['apply',path.join(run,'adaptation.patch')]);
  check('an installed patch is checked by its real reverse applicability',m=>m.targets[0].patches[0].check='reverse','PASS');
  git(candidate,['apply','--reverse',path.join(run,'adaptation.patch')]);
  check('a patch removed from the candidate cannot pass its installed-state check',m=>m.targets[0].patches[0].check='reverse','PATCH_CONFLICT');
  check('commit cannot be omitted from the source review',m=>m.targets[0].reviews=[],'UNCLASSIFIED_COMMIT');
  check('a pending source judgment cannot authorize promotion',m=>m.targets[0].reviews[0].decision='pending','INVALID_MANIFEST');
  check('missing receipt stays missing',m=>m.targets[0].receipts=[],'MISSING_GATE');
  check('a second required behavior cannot inherit the first result',m=>m.targets[0].requiredGates.push('vision'),'MISSING_GATE');
  check('another backend is checked independently',m=>{
    const other=structuredClone(m.targets[0]);other.id='qwen38/cuda/fixture';m.targets.push(other);
  },'STALE_RECEIPT');
  check('changed patch hash invalidates admission',m=>m.targets[0].patches[0].sha256='0'.repeat(64),'CONTENT_CHANGED');
  check('missing patch invalidates admission',m=>m.targets[0].patches[0].path='missing.patch','ENOENT');
  const alteredReceipt = (label, change, expected) => {
    const r=structuredClone(receiptData);change(r);
    const entry=write('changed-receipt.json',JSON.stringify(r)+'\n');
    check(label,m=>m.targets[0].receipts=[entry],expected);
  };
  alteredReceipt('failed behavior cannot pass',r=>r.passed=false,'GATE_FAILED');
  const failedReceipt=write('failed-receipt.json',JSON.stringify({...receiptData,passed:false})+'\n');
  check('a successful retry cannot hide a retained failed gate',m=>m.targets[0].receipts.push(failedReceipt),'GATE_FAILED');
  alteredReceipt('unfinished behavior cannot pass',r=>delete r.finished,'GATE_FAILED');
  alteredReceipt('old engine result cannot qualify a new candidate',r=>r.qualification.engineRevision=base,'STALE_RECEIPT');
  alteredReceipt('another operating system cannot qualify this target',r=>r.qualification.platform='windows','STALE_RECEIPT');
  alteredReceipt('old patch set cannot qualify new adapter bytes',r=>r.qualification.patchSetSHA256='f'.repeat(64),'STALE_RECEIPT');
  alteredReceipt('unscoped green report cannot qualify a backend',r=>delete r.qualification,'INVALID_MANIFEST');
  alteredReceipt('missing raw evidence cannot be counted',r=>r.qualification.evidence[0].path='missing.json','ENOENT');
  fs.writeFileSync(path.join(run,evidence.path),'changed evidence\n');
  check('changed raw receipts are rejected',null,'CONTENT_CHANGED');
  fs.writeFileSync(path.join(run,evidence.path),JSON.stringify({passed:true,meaning:'fixture output only'})+'\n');
  fs.writeFileSync(path.join(candidate,'core.c'),'int value = 4;\n');
  check('real conflicting patch rejects promotion without repairing source',null,'PATCH_CONFLICT');
  fs.writeFileSync(path.join(candidate,'core.c'),'int value = 2;\n');
  check('wrong candidate revision is not the reviewed engine',m=>m.targets[0].revision=base,'WRONG_CANDIDATE');
  check('offline report never pretends current remote freshness',null,'FRESHNESS_UNVERIFIED',{offline:true});
  fs.mkdirSync(path.join(candidate,'archive'));
  check('an archive cannot inherit parent Git identity',null,'PARENT_GIT_REJECTED',
    {repositories:{qwen38:path.join(candidate,'archive')}});
  check('mismatched origin is rejected',m=>m.tracks[0].repository=seed,'WRONG_ORIGIN');
  fs.symlinkSync(path.join(run,evidence.path),path.join(run,'linked.json'));
  check('linked evidence is rejected',m=>m.targets[0].reviews[0].evidence[0].path='linked.json','INVALID_MANIFEST');
  check('empty target matrix cannot produce a green release',m=>m.targets=[],'INVALID_MANIFEST');
  check('duplicate combinations cannot hide omissions',m=>m.targets.push(structuredClone(m.targets[0])),'INVALID_MANIFEST');
  check('bounded diagnostics retain every failed target and the complete totals',m=>{
    const template=structuredClone(m.targets[0]);template.requiredGates=Array.from({length:17},(_,i)=>'gate-'+i);
    template.receipts=[];template.reviews=[];
    m.targets=Array.from({length:80},(_,i)=>({...structuredClone(template),id:'fixture/target-'+i}));
  },'MISSING_GATE',{inspect:r=>{
    assert.equal(r.issues.length,1024);assert.equal(r.issueCount,1440);
    assert.equal(r.issueCounts.MISSING_GATE,1360);assert.equal(r.issueCounts.UNCLASSIFIED_COMMIT,80);
    assert.equal(r.targets.length,80);assert(r.targets.every(target=>!target.passed && target.issueCount===18));
  }});
  check('unknown review tracks cannot be silently accepted',m=>m.targets[0].reviews.push({
    ...m.targets[0].reviews[0],track:'omitted-engine'}),'INVALID_MANIFEST');
  check('unobserved review commits cannot be used as source evidence',m=>m.targets[0].reviews.push({
    ...m.targets[0].reviews[0],commit:'0'.repeat(40)}),'INVALID_MANIFEST');
  fs.writeFileSync(path.join(seed,'core.c'),'int value = 5;\n');
  git(seed,['commit','-qam','new unreviewed upstream']);
  const next=git(seed,['rev-parse','HEAD']);
  git(remote,['fetch','-q',seed,'main:main']);
  check('new unfetched remote tip blocks admission',null,'UNREVIEWED_TIP');
  git(candidate,['fetch','-q','origin']);
  check('fetched unreviewed history still blocks admission',null,'UNCLASSIFIED_COMMIT');
  const orphan=git(seed,['commit-tree','HEAD^{tree}','-m','unrelated history']);
  git(remote,['fetch','-q',seed,orphan]);
  git(remote,['update-ref','refs/heads/main',orphan,next]);
  git(candidate,['fetch','-q','origin']);
  check('rewritten unrelated upstream cannot be mistaken for a fast-forward',null,'DIVERGED_HISTORY');
  report.passed=true;
} catch(error) {report.error=String(error.stack||error);console.error(report.error);process.exitCode=1;}
finally {report.finished=new Date().toISOString();save();console.log(run);}
