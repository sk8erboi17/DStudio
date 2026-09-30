// Actual native HTTP updates: upstream fetching is retired, user files persist.
// The engine checkout and Git peer are fixtures; no inference or external fetch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {freePort,sleep} from '../support/real_harness.mjs';

const root=path.resolve('tests/.artifacts/engine-updates');fs.mkdirSync(root,{recursive:true});
const run=fs.mkdtempSync(path.join(root,'run-'));
const engine=path.join(run,'ds4'),helpers=path.join(run,'helpers'),calls=path.join(run,'git-calls');
fs.mkdirSync(path.join(engine,'.git'),{recursive:true});fs.mkdirSync(helpers);
fs.writeFileSync(path.join(engine,'.git/HEAD'),'ref: refs/heads/main\n');
for(const name of ['ds4.c','ds4.h','Makefile','user-notes.txt'])fs.writeFileSync(path.join(engine,name),`fixture ${name}\n`);
fs.writeFileSync(path.join(helpers,'git'),`#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`,{mode:0o755});
const originals=Object.fromEntries(['ds4.c','ds4.h','Makefile','user-notes.txt'].map(n=>[n,fs.readFileSync(path.join(engine,n)).toString('base64')]));
const port=await freePort(),base=`http://127.0.0.1:${port}`,log=fs.openSync(path.join(run,'host.log'),'wx');
const host=spawn(path.resolve(process.argv[2]),[String(port),engine],{stdio:['ignore',log,log],env:{...process.env,
  PATH:helpers+path.delimiter+process.env.PATH,DS4UI_TEST_MODE:'1',DS4UI_NO_WINDOW:'1',
  DS4UI_DEFER_ENGINE_START:'1',DS4UI_DATA_DIR:path.join(run,'profile'),DS4UI_HOST:'127.0.0.1'}});
fs.closeSync(log);const exited=new Promise(resolve=>{host.once('exit',resolve);host.once('error',resolve);});
const report={scope:'Actual native HTTP; simulated checkout/Git peer, no inference',cases:[],passed:false};
try {
  let ready=false;
  for(let i=0;i<100;i++) {
    assert.equal(host.exitCode,null);
    try {ready=(await fetch(base+'/api/status')).ok;if(ready)break;}catch{}
    await sleep(50);
  }
  assert(ready);
  const check=await fetch(base+'/api/updates/check');assert.equal(check.status,200);
  const status=await check.json(),engineRow=status.sections.find(row=>row.id==='ds4-latest');
  assert.equal(engineRow.action,null,'Bundled engine revisions must not offer upstream pulling');
  assert.equal(fs.existsSync(calls),false,'Checking updates must not invoke upstream Git');
  report.cases.push('Update check exposes a bundled engine without fetching');
  const response=await fetch(base+'/api/updates/run',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'ds4web'},
    body:JSON.stringify({tasks:['ds4-latest']})});
  assert.equal(response.status,409);
  const result=await response.json();assert.equal(result.ok,false);assert(result.error.length>0);
  assert.equal(fs.existsSync(calls),false,'A stale client must not fetch or pull an engine');
  for(const [name,bytes]of Object.entries(originals))assert.equal(fs.readFileSync(path.join(engine,name)).toString('base64'),bytes);
  report.cases.push('Retired upstream update rejects before commands or source changes');
  report.passed=true;
}catch(error){report.error=String(error.stack||error);process.exitCode=1;console.error(report.error);}
finally{
  if(host.exitCode===null&&host.signalCode===null){host.kill('SIGTERM');await exited;}
  fs.writeFileSync(path.join(run,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(run);
}
