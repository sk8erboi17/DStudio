// Explicit heavyweight gate: every supported installed model, sequentially,
// through the real bundled launcher and Chat UI. No simulated responses.
// Engines as the app routes them: DeepSeek, Qwen3.8-Flash-Next and Laguna on
// ds4 (Laguna from its own checkout), the Qwen3.6 and Qwen3.8-27B GGUFs on the
// bundled llama.cpp, the Qwen3.6 MLX folder on MLX. DeepSeek V4.1 Flash runs
// only with expert SSD streaming; GLM 5.3 is left to contributor hardware
// (PLAN.MD) and is listed as excluded with that reason.
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
// Model files (gguf/NAME.gguf) and MLX model folders (mlx/NAME, beside gguf/).
const mlxRoot = path.join(path.dirname(modelRoot),'mlx');
const weights = [...fs.readdirSync(modelRoot).filter(f=>f.endsWith('.gguf')),
  ...(fs.existsSync(mlxRoot)?fs.readdirSync(mlxRoot).filter(f=>fs.existsSync(path.join(mlxRoot,f,'config.json'))).map(f=>`mlx/${f}`):[])];
const auxiliary = f => /DSpark|Vision-Encoder|mmproj|-PLE-|MTP/i.test(f);
const engineOf = f => /^mlx\//.test(f)?'mlx':/^(?:Qwen3\.6-35B-A3B-|Qwen3\.8-27B-)/i.test(f)?'llama':/^laguna-s-2\.1-/i.test(f)?'laguna':
  /^(?:DeepSeek-V4-Flash-|DeepSeek-V4\.1-Flash-|Qwen3\.8-Flash-Next-)/i.test(f)?'ds4':null;
const contributor = f => /^GLM-5\.3-|^DeepSeek-V4\.1-Flash-(?!1017)/i.test(f);
const supported = f => !auxiliary(f) && !contributor(f) && engineOf(f)!==null;
const filter = process.argv[4] || '';
const candidates = weights.filter(f=>supported(f)&&(!filter||f.includes(filter)));
report.filter = filter || null;
assert.ok(candidates.length,'no real model weights found');
report.excluded = weights.filter(f=>!supported(f)).map(file=>({file,reason:auxiliary(file)?'Auxiliary file, not a standalone chat model':
  contributor(file)?'Left to contributor hardware (PLAN.MD); not run on this machine':'Not an officially integrated chat model'}));
const modelsDir = path.join(sources,'ds4/gguf');
if (!fs.lstatSync(modelsDir).isSymbolicLink()) {
  assert.deepEqual(fs.readdirSync(modelsDir),[],'only replace the empty task-owned model directory');
  fs.rmdirSync(modelsDir); fs.symlinkSync(modelRoot,modelsDir);
}
assert.equal(fs.realpathSync(modelsDir),modelRoot);
// The MLX folders sit beside gguf/ in the model store; link them the same way.
const mlxDir = path.join(sources,'ds4/mlx');
if (fs.existsSync(mlxRoot) && !(fs.existsSync(mlxDir) && fs.lstatSync(mlxDir).isSymbolicLink())) {
  if (fs.existsSync(mlxDir)) { assert.deepEqual(fs.readdirSync(mlxDir),[],'only replace an empty task-owned MLX directory'); fs.rmdirSync(mlxDir); }
  fs.symlinkSync(fs.realpathSync(mlxRoot),mlxDir);
}
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
  const bytesOf = f => { const p=/^mlx\//.test(f)?path.join(mlxRoot,f.slice(4)):path.join(modelRoot,f);
    return fs.statSync(p).isDirectory()?fs.readdirSync(p).reduce((n,x)=>n+fs.statSync(path.join(p,x)).size,0):fs.statSync(p).size; };
  candidates.sort((a,b)=>bytesOf(a)-bytesOf(b));
  for(const [index,file] of candidates.entries()) {
    // llama.cpp and MLX models are served by DStudio's own resident servers;
    // the main installation supplies their model store.
    const engine=engineOf(file);
    const dirName=engine==='laguna'?'ds4-laguna-s21':'ds4';
    const dir=path.join(sources,dirName);
    const rel=/^mlx\//.test(file)?file:`gguf/${file}`;
    const next=/^Qwen3\.8-Flash-Next/i.test(file);
    const ssd=/^DeepSeek-V4\.1-Flash-1017/i.test(file)?'on':'off';
    const profile=path.join(run,`profile-${index}`);fs.mkdirSync(profile);
    const row={file,bytes:bytesOf(file),engine,checks:[],
      configuration:{ctx:8192,ssdStreaming:ssd,power:100,dspark:false,think:'off'},
      mode:engine==='llama'?'llama.cpp, weights in Metal memory':engine==='mlx'?'MLX, unified memory':
        next?'resident backbone + embedded BF16 n-grams on SSD':ssd==='on'?'SSD expert streaming':'resident Metal'};
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
      // The GGUF catalog lists model files; an MLX model is a folder the page
      // offers from the Qwen variant catalog instead.
      if(engine!=='mlx'){
        const matches=catalog.ggufs.filter(g=>g.path===rel);
        assert.equal(matches.length,1,'a model must have exactly one matching engine');
        assert.equal(matches[0].engineDir,dir);row.catalog=matches[0];
      } else row.catalog=null;
      row.checkout=await http('/api/engine/checkout',{dir});assert.equal(row.checkout.ok,true);
      const enginePort=await freePort();
      row.launchRequest={mode:'server',gguf:rel,port:enginePort,...row.configuration};
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
      assert.equal(st.modelFile,rel);assert.equal(st.ds4dir,dir);assert.equal(st.config.ctx,8192);
      row.ssdStreamingEffective=st.config?.ssdStreamingEffective ?? st.ssdStreamingEffective ?? null;
      assert.equal(row.ssdStreamingEffective===true,ssd==='on','the effective memory mode is the requested one');
      row.loadSeconds=(performance.now()-t)/1000;row.readyStatus=st;row.apiModels=models;
      row.status='loaded';save();console.log(`READY ${file}: ${row.loadSeconds.toFixed(1)}s`);
      const processIds=execFileSync('lsof',['-nP',`-iTCP:${enginePort}`,'-sTCP:LISTEN','-t'],{encoding:'utf8'}).trim().split(/\s+/).map(Number);
      assert.equal(processIds.length,1);row.enginePid=processIds[0];assert.ok(live(row.enginePid));
      const command=execFileSync('ps',['-p',String(row.enginePid),'-o','comm='],{encoding:'utf8'}).trim();
      const executable=path.resolve(dir,command);
      if(engine==='llama') assert.equal(path.basename(executable),'llama-server','llama.cpp serves this model');
      else if(engine==='mlx') assert.match(path.basename(executable),/^python/i,'the MLX server serves this model');
      else { assert.ok(['ds4-server','ds4-server-pld'].includes(path.basename(executable))); assert.equal(path.dirname(executable),dir); }
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
        await activeContext.addInitScript(({rel,dir,ssd,model})=>{
          localStorage.setItem('ds4web.settings.v2',JSON.stringify({v:2,onboarded:true,modelGguf:rel,modelEngineDir:dir,
            model,ctxSize:8192,enginePower:100,ssdStreaming:ssd,dspark:false,thinkLevel:'off',maxTokens:256,temperature:0,webMode:'off',qualityDefaultsVersion:2}));
        },{rel,dir,ssd,model:models.data[0].id});
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
        assert.deepEqual(errors,[]);assert.equal((await http('/api/status')).modelFile,rel);
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
