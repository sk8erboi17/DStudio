// Execute the actual native metadata command. No source inspection, network,
// model loading or user profile. Also works with the built desktop executable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const run=artifactRunDir('engine-pins'), sandbox=path.join(run,'empty profile with spaces');
const report={started:new Date().toISOString(),scope:'Actual native metadata command; no inference',passed:false,cases:[]};
try {
  const binary=fs.realpathSync(process.argv[2]);
  report.binarySHA256=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  fs.mkdirSync(sandbox);
  const env={...process.env};
  for(const key of Object.keys(env)) if(/^DS4|^DSTUDIO|^DYLD_/.test(key))delete env[key];
  Object.assign(env,{DS4UI_DATA_DIR:path.join(sandbox,'must not be created'),PATH:path.join(sandbox,'no helpers')});
  const invoke=(app,args)=>{
    const before=fs.readdirSync(sandbox).sort();
    const r=spawnSync(app,args,{cwd:sandbox,env,encoding:'utf8',timeout:5000,maxBuffer:65536});
    assert.equal(r.error,undefined,r.error?.message);assert.equal(r.signal,null);
    assert.deepEqual(fs.readdirSync(sandbox).sort(),before,'Metadata command wrote application state');
    return r;
  };
  const first=invoke(binary,['--engine-pins']);assert.equal(first.status,0,first.stderr);
  const pins=JSON.parse(first.stdout);assert.equal(pins.schema,'dstudio.engine-pins.v1');
  const repositories={main:'antirez/ds4',laguna:'antirez/ds4',qwen:'ivanfioravanti/ds4-metal',qwen35:'vagrillo/ds4',q36:'Ninnix/q36'};
  assert.deepEqual(pins.engines.map(e=>e.id).sort(),Object.keys(repositories).sort());
  assert.equal(new Set(pins.engines.map(e=>e.directory)).size,pins.engines.length);
  for(const engine of pins.engines) {
    assert.match(engine.commit,/^[a-f0-9]{40}$/);
    assert.equal(engine.archiveURL,`https://codeload.github.com/${repositories[engine.id]}/tar.gz/${engine.commit}`);
    assert.equal(path.basename(engine.directory),engine.directory);
  }
  report.cases.push({name:'Complete installer identities without creating a profile or using PATH helpers',passed:true});
  const repeat=invoke(binary,['--engine-pins']);assert.equal(repeat.status,0);
  assert.deepEqual(JSON.parse(repeat.stdout),pins);
  report.cases.push({name:'Repeated metadata reads preserve identities and have no state effects',passed:true});
  const invalid=invoke(binary,['--engine-pins','unexpected']);assert.equal(invalid.status,2);
  assert.equal(invalid.stdout,'');assert(invalid.stderr.length>0);
  report.cases.push({name:'Invalid arguments fail before startup or state discovery',passed:true});
  const moved=path.join(sandbox,'relocated DStudio');fs.copyFileSync(binary,moved);fs.chmodSync(moved,0o755);
  const relocated=invoke(moved,['--engine-pins']);assert.equal(relocated.status,0,relocated.stderr);
  assert.deepEqual(JSON.parse(relocated.stdout),pins);
  report.cases.push({name:'Relocated executable with spaces reports the same compiled pins',passed:true});
  report.pins=pins;report.passed=true;
} catch(error) {report.error=String(error.stack||error);console.error(report.error);process.exitCode=1;}
finally {report.finished=new Date().toISOString();writeArtifact(run,'results.json',report);console.log(run);}
