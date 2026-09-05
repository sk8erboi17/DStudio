// Explicit heavyweight gate: every supported installed GGUF, sequentially,
// through the real bundled launcher and Chat UI. No simulated responses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { webkit } from 'playwright';
import { freePort, sleep, csrfHeaders } from '../support/real_harness.mjs';

assert.equal(process.platform,'darwin');
assert.ok(process.argv[2], 'Pass a successful first-launch artifact directory (task-owned sources).');
const installation = fs.realpathSync(process.argv[2]);
const receipt = JSON.parse(fs.readFileSync(path.join(installation,'results.json'),'utf8'));
assert.equal(receipt.schema,'dstudio.first-launch.v1');
assert.equal(receipt.status,'pass','source-installation E2E must pass first');
const sources = path.join(installation,'support');
const app = path.join(installation,'DStudio.app/Contents/MacOS/DStudio');
const modelRoot = fs.realpathSync(process.argv[3] || 'ds4/gguf');
const run = fs.mkdtempSync(path.resolve('tests/.artifacts/installed-models-'));
const report = {schema:'dstudio.installed-models-e2e.v1',started:new Date().toISOString(),
  scope:'Real DStudio model selection/start API, Metal loading, checked HTTP answers and real headless WebKit Chat SSE/rendering. Not a capability benchmark, full-context test or multimodal/Agent qualification.',
  host:{cpu:os.cpus()[0]?.model,memoryBytes:os.totalmem()},installation,models:[],excluded:[]};
const save = () => fs.writeFileSync(path.join(run,'results.json'),JSON.stringify(report,null,2)+'\n');
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
report.appSha256 = hash(app);
report.harnessSha256 = hash(new URL(import.meta.url));
const weights = fs.readdirSync(modelRoot).filter(f=>f.endsWith('.gguf'));
const supported = f => /^(?:DeepSeek-V4-Flash(?!.*(?:DSpark|Vision-Encoder))|GLM-5\.3-Flash-Q2\.gguf$|laguna-s-2\.1-|Qwen3\.6-35B-A3B-|Qwen3\.8-Flash-Next-(?!PLE|.*MTP))/i.test(f);
const filter = process.argv[4] || '';
const candidates = weights.filter(f=>supported(f)&&(!filter||f.includes(filter)));
report.filter = filter || null;
assert.ok(candidates.length,'no real model weights found');
report.excluded = weights.filter(f=>!supported(f)).map(file=>({file,reason:/DSpark|Vision-Encoder|PLE|MTP/i.test(file)?'Auxiliary file, not a standalone chat model':'Not an officially integrated chat model'}));
const modelsDir = path.join(sources,'ds4/gguf');
if (!fs.lstatSync(modelsDir).isSymbolicLink()) {
  assert.deepEqual(fs.readdirSync(modelsDir),[],'only replace the empty task-owned model directory');
  fs.rmdirSync(modelsDir); fs.symlinkSync(modelRoot,modelsDir);
}
assert.equal(fs.realpathSync(modelsDir),modelRoot);
let browser, launcher, base, activeContext;
const live = pid => {try {process.kill(pid,0);return true;}catch{return false;}};
async function http(endpoint,body,timeout=240000) {
  const r = await fetch(base+endpoint,{method:body===undefined?'GET':'POST',headers:csrfHeaders,
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  const text = await r.text(); assert.equal(r.status,200,text.slice(0,4000));return JSON.parse(text);
}
async function stopLauncher() {
  await activeContext?.close().catch(()=>{});activeContext=null;
  if(!launcher)return;
  if(launcher.exitCode === null && launcher.signalCode === null) {
    await http('/api/stop',{},15000).catch(()=>{});
    const done = new Promise(resolve=>launcher.once('exit',resolve));
    try {process.kill(-launcher.pid,'SIGTERM');}catch{}
    await Promise.race([done,sleep(5000)]);
    if(launcher.exitCode === null && launcher.signalCode === null) {try{process.kill(-launcher.pid,'SIGKILL');}catch{}}
  }
  launcher=null;
}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{
  report.interrupted=true;save();await stopLauncher();await browser?.close();process.exit(130);
});
async function checked(row,name,fn) {
  const check={name};row.checks.push(check);save();const t=performance.now();
  try {check.evidence=await fn();check.status='pass';}
  catch(e){
    check.status='fail';check.error=e.message;
    const page=activeContext?.pages()[0];
    if(page) await page.screenshot({path:path.join(run,`${report.models.length-1}-failure.png`),fullPage:true}).catch(()=>{});
  }
  check.seconds=(performance.now()-t)/1000;save();console.log(`${row.file}: ${name}: ${check.status}`);
}
try {
  const listener=spawnSync('lsof',['-nP','-iTCP:28000','-sTCP:LISTEN','-t'],{encoding:'utf8'});
  assert.equal((listener.stdout||'').trim(),'','stop the existing engine explicitly before this heavyweight sweep; do not adopt it');
  browser=await webkit.launch({headless:true});
  // Smallest resident model first; all heavy processes are strictly sequential.
  candidates.sort((a,b)=>fs.statSync(path.join(modelRoot,a)).size-fs.statSync(path.join(modelRoot,b)).size);
  for(const [index,file] of candidates.entries()) {
    const dirName=/^Qwen3\.6/i.test(file)?'ds4-qwen35':/^Qwen3\.8/i.test(file)?'ds4-qwen38':/^laguna/i.test(file)?'ds4-laguna-s21':'ds4';
    const dir=path.join(sources,dirName);
    const ssd=dirName==='ds4'?'on':'off';
    const profile=path.join(run,`profile-${index}`);fs.mkdirSync(profile);
    const stat=fs.statSync(path.join(modelRoot,file));
    const row={file,bytes:stat.size,mtime:stat.mtime.toISOString(),engine:dirName,checks:[],
      configuration:{ctx:8192,ssdStreaming:ssd,power:100,dspark:false,think:'off'},
      mode:dirName==='ds4-qwen38'?'resident backbone + native SSD PLE':ssd==='on'?'SSD expert streaming':'resident Metal'};
    report.models.push(row);save();console.log(`LOAD ${index+1}/${candidates.length}: ${file} (${row.mode})`);
    try {
      const env={...process.env,DS4UI_DATA_DIR:profile,DS4UI_NO_WINDOW:'1',DS4UI_DEFER_ENGINE_START:'1',
        DS4UI_HOST:'127.0.0.1',DSTUDIO_KV_DIR:path.join(profile,'kv')};delete env.DS4UI_TEST_MODE;
      const port=await freePort();base=`http://127.0.0.1:${port}`;
      const fd=fs.openSync(path.join(run,`${index}-launcher.log`),'wx');
      launcher=spawn(app,[String(port),path.join(sources,'ds4')],{cwd:'/',env,detached:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);
      let initial;
      for(let i=0;i<120;i++){try{initial=await http('/api/status',undefined,2000);break;}catch{}await sleep(250);}
      assert.ok(initial,'bundled launcher did not start');assert.equal(initial.running,false);
      const catalog=await http('/api/ggufs');
      const matches=catalog.ggufs.filter(g=>g.file===file);
      assert.equal(matches.length,1,'a model must have exactly one matching engine');
      assert.equal(matches[0].engineDir,dir);row.catalog=matches[0];
      row.checkout=await http('/api/engine/checkout',{dir});assert.equal(row.checkout.ok,true);
      const enginePort=await freePort();
      row.launchRequest={mode:'server',gguf:`gguf/${file}`,port:enginePort,...row.configuration};
      const t=performance.now();
      row.launchResponse=await http('/api/start',row.launchRequest,180000);
      assert.equal(row.launchResponse.ok,true);assert.notEqual(row.launchResponse.shared,true,'must own the loaded model');save();
      let models,st;
      const deadline=Date.now()+600000;
      while(Date.now()<deadline){
        st=await http('/api/status',undefined,5000);
        if(st.engineError)throw Error(st.engineError);
        try{models=await http('/v1/models',undefined,3000);if(models.data?.length&&st.ready)break;}catch{}
        await sleep(1000);
      }
      assert.ok(st?.ready&&models?.data?.length,'model readiness timed out');
      assert.equal(st.modelFile,`gguf/${file}`);assert.equal(st.ds4dir,dir);assert.equal(st.config.ctx,8192);
      row.loadSeconds=(performance.now()-t)/1000;row.readyStatus=st;row.apiModels=models;
      row.status='loaded';save();console.log(`READY ${file}: ${row.loadSeconds.toFixed(1)}s`);
      const processIds=execFileSync('lsof',['-nP',`-iTCP:${enginePort}`,'-sTCP:LISTEN','-t'],{encoding:'utf8'}).trim().split(/\s+/).map(Number);
      assert.equal(processIds.length,1);row.enginePid=processIds[0];assert.ok(live(row.enginePid));
      const command=execFileSync('ps',['-p',String(row.enginePid),'-o','comm='],{encoding:'utf8'}).trim();
      const executable=path.resolve(dir,command);
      assert.ok(['ds4-server','ds4-server-pld'].includes(path.basename(executable)));
      assert.equal(path.dirname(executable),dir);
      row.binary={path:executable,sha256:hash(executable)};
      const request=prompt=>({model:models.data[0].id,messages:[{role:'user',content:prompt}],temperature:0,seed:42,max_tokens:256,
        think:false,thinking:{type:'disabled'},stream:false});
      await checked(row,'exact arithmetic through DStudio HTTP',async()=>{
        const req=request('What is 17 multiplied by 19? Reply with only the integer.');
        row.arithmeticRequest=req;
        const response=await http('/v1/chat/completions',req);row.arithmeticResponse=response;
        assert.equal(response.choices[0].finish_reason,'stop');assert.equal(response.choices[0].message.content.trim(),'323');return{request:req,response};
      });
      await checked(row,'structured extraction through DStudio HTTP',async()=>{
        const req=request('Return ONLY a JSON object with keys city and count. Record: city=Torino; count=7. count must be a number.');
        row.extractionRequest=req;
        const response=await http('/v1/chat/completions',req);row.extractionResponse=response;
        assert.equal(response.choices[0].finish_reason,'stop');assert.deepEqual(JSON.parse(response.choices[0].message.content),{city:'Torino',count:7});return{request:req,response};
      });
      await checked(row,'real Chat UI sends, streams and renders the checked answer',async()=>{
        activeContext=await browser.newContext({viewport:{width:1280,height:900}});
        await activeContext.addInitScript(({file,dir,ssd,model})=>{
          localStorage.setItem('ds4web.settings.v2',JSON.stringify({v:2,onboarded:true,modelGguf:`gguf/${file}`,modelEngineDir:dir,
            model,ctxSize:8192,enginePower:100,ssdStreaming:ssd,dspark:false,thinkLevel:'off',maxTokens:256,temperature:0,webMode:'off',qualityDefaultsVersion:2}));
        },{file,dir,ssd,model:models.data[0].id});
        const page=await activeContext.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.goto(base+'/',{waitUntil:'domcontentloaded'});
        await page.locator('#composer-input').waitFor({state:'visible',timeout:30000});
        const pending=page.waitForResponse(r=>r.url().includes('/v1/chat/completions')&&r.request().method()==='POST',{timeout:240000});
        await page.locator('#composer-input').fill('What is 19 + 23? Reply with only the integer.');await page.locator('#btn-send').click();
        const response=await pending;assert.equal(response.status(),200);
        const raw=await response.text();fs.writeFileSync(path.join(run,`${index}-chat.sse`),raw);
        let answer='',finish;let done=false;
        for(const line of raw.split(/\r?\n/)){if(!line.startsWith('data:'))continue;const value=line.slice(5).trim();if(value==='[DONE]'){done=true;continue;}if(!value)continue;const event=JSON.parse(value);answer+=event.choices?.[0]?.delta?.content||'';finish=event.choices?.[0]?.finish_reason||finish;}
        row.uiAnswer=answer;row.uiRequest=response.request().postDataJSON();save();
        assert.equal(done,true);assert.equal(finish,'stop');assert.equal(answer.trim(),'42');
        // Receiving the complete SSE body in the test runner does not mean the
        // page has consumed its queued stream callbacks and painted the text.
        await page.locator('.msg--assistant:not(.msg--streaming) .md').filter({hasText:/^42$/}).waitFor({state:'visible',timeout:15000});
        assert.equal((await page.locator('.msg--assistant .md').last().innerText()).trim(),'42');
        assert.deepEqual(errors,[]);assert.equal((await http('/api/status')).modelFile,`gguf/${file}`);
        await page.screenshot({path:path.join(run,`${index}-chat.png`),fullPage:true});
        const evidence={request:response.request().postDataJSON(),answer,finish,done,errors};
        await activeContext.close();activeContext=null;return evidence;
      });
      row.status=row.checks.every(c=>c.status==='pass')?'pass':'fail';
    } catch(e) {row.status='fail';row.error=e.stack;console.error(`${file}: ${e.message}`);}
    finally {
      await stopLauncher();
      if(row.enginePid){row.stopped=!live(row.enginePid);if(!row.stopped){row.status='fail';row.stopError='owned engine did not stop';}}
      row.finished=new Date().toISOString();save();
    }
  }
  report.status=report.models.every(m=>m.status==='pass')?'pass':'fail';
} catch(e) {report.status='fail';report.error=e.stack;console.error(e);}
finally {await stopLauncher();await browser?.close();report.finished=new Date().toISOString();save();console.log(`Evidence: ${run}`);}
process.exitCode=report.status==='pass'?0:1;
