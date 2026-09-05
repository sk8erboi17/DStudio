// Real native HTTP + Poppler and execution of production attachment functions.
// No model: the planner is simulated and counted, never called for fitting PDFs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {spawn, execFileSync} from 'node:child_process';
import {webkit} from 'playwright';
import {freePort, sleep, csrfHeaders} from '../support/real_harness.mjs';
import {pdfFixture, compactPages} from '../support/pdf_read_fixture.mjs';

fs.mkdirSync('tests/.artifacts', {recursive: true});
const run = fs.mkdtempSync(path.resolve('tests/.artifacts/pdf-complete-'));
for (const d of ['data', 'cache', 'ds4/gguf']) fs.mkdirSync(path.join(run, d), {recursive: true});
fs.writeFileSync(path.join(run, 'ds4/Makefile'), 'all:\n\t@true\n');
const base = `http://127.0.0.1:${await freePort()}`;
const log = fs.openSync(path.join(run, 'server.log'), 'wx');
const server = spawn(path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test'),
  [new URL(base).port, path.join(run, 'ds4')], {
    env: {...process.env, DS4UI_TEST_MODE:'1', DS4UI_DATA_DIR:path.join(run,'data'),
      DSTUDIO_PDF_CACHE_DIR:path.join(run,'cache'), DS4UI_HOST:'127.0.0.1'},
    stdio:['ignore',log,log], detached:true,
  });
fs.closeSync(log);
const report = {scope:'Real PDF extraction, page completeness, evidence and attachment routing; no inference', checks:[]};
let browser;
const save = () => fs.writeFileSync(path.join(run,'report.json'), JSON.stringify(report,null,2));
const uri = pdf => `data:application/pdf;base64,${pdf.toString('base64')}`;
async function post(body, endpoint='/api/pdf/describe', expected=200) {
  const res = await fetch(base+endpoint,{method:'POST',headers:csrfHeaders,body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const r = await res.json(); assert.equal(res.status,expected,JSON.stringify(r)); return r;
}
async function check(name, fn) {
  const r = {name}; report.checks.push(r); const start=performance.now();
  try {await fn(); r.status='pass';} catch(e) {r.status='fail';r.error=e.stack;throw e;}
  finally {r.ms=performance.now()-start;save();console.log(`${r.status}: ${name}`);}
}
function fixture(name,pages) {const file=path.join(run,`${name}.pdf`);const bytes=pdfFixture(pages);fs.writeFileSync(file,bytes);return {file,bytes};}
try {
  let ready=false;
  for(let i=0;i<120;i++){try{if((await fetch(base+'/api/status')).ok){ready=true;break;}}catch{}await sleep(50);}
  assert.ok(ready,'reader server failed to start');
  const compact=fixture('compact',compactPages);
  const source = {data_uri:uri(compact.bytes),profile:'complete',max_chars:8192,evidence:true};
  let result;
  await check('complete text matches independent Poppler extraction byte for byte, on every physical page',async()=>{
    result=await post(source);
    assert.equal(result.completeText,true);assert.equal(result.truncated,false);assert.equal(result.sampled,false);
    assert.equal(result.retrievalChunks,0);assert.equal(result.textPages,2);
    const tool=['/opt/homebrew/bin/pdftotext','/usr/local/bin/pdftotext','/usr/bin/pdftotext'].find(f=>fs.existsSync(f));
    assert.ok(tool,'Poppler required; missing dependency is not a pass');
    const expected=execFileSync(tool,['-layout','-enc','UTF-8',compact.file,'-'],{encoding:'utf8'}).split('\f').filter(Boolean);
    assert.equal(result.text,expected.map((s,i)=>`\n--- Pagina ${i+1} (testo) ---\n${s}\n`).join(''));
    assert.ok(Buffer.byteLength(result.text)<=8192);
    assert.match(result.text,/ZEBRA-7319/);assert.match(result.text,/1\.234,50/);
  });
  await check('ordinary overview also preserves a long second page when the full text fits',async()=>{
    const overview=await post({...source,profile:'interactive'});
    assert.equal(overview.text,result.text);assert.equal(overview.sampled,false);
  });
  await check('last-page evidence is verified against the retained original and rendered',async()=>{
    const proof=await post({documentId:result.documentId,page:2,quote:'Final calibration code: ZEBRA-7319.',render:true},'/api/pdf/evidence');
    assert.equal(proof.status,'matched');assert.ok(proof.boxes.length>0);
    fs.writeFileSync(path.join(run,'evidence.jpg'),Buffer.from(proof.image.split(',')[1],'base64'));
    assert.equal((await post({documentId:result.documentId,page:1,quote:'ZEBRA-7319'},'/api/pdf/evidence')).status,'not_found');
  });
  await check('warm and modified documents cannot share stale text or source identity',async()=>{
    const warm=await post(source);assert.equal(warm.cached,true);assert.equal(warm.text,result.text);
    const changed=fixture('changed',[compactPages[0],{lines:compactPages[1].lines.map(s=>s.replace('ZEBRA-7319','LYNX-6428'))}]);
    const r=await post({...source,data_uri:uri(changed.bytes)});
    assert.notEqual(r.documentId,result.documentId);assert.match(r.text,/LYNX-6428/);assert.doesNotMatch(r.text,/ZEBRA-7319/);
  });
  const large=fixture('large',Array.from({length:8},()=>compactPages[1]));
  const scan=fixture('scan',[{lines:[],image:true}]);
  const sparse=fixture('sparse',[compactPages[0],{lines:['42']}]);
  const visual=fixture('visual',compactPages.map(p=>({...p,image:true})));
  const five=fixture('five-visual',Array.from({length:5},()=>({...compactPages[0],image:true})));
  await check('oversize, scanned, sparse and over-limit visual PDFs require the existing planner',async()=>{
    for(const f of [large,scan,sparse,five]) {
      const r=await post({...source,data_uri:uri(f.bytes),native_vision:f===five});
      assert.equal(r.readPlanRequired,true);assert.equal(r.completeText,false);assert.equal(r.text,undefined);
    }
    const fallback=await post({...source,data_uri:uri(large.bytes),profile:'interactive',pages:'8'});
    assert.equal(fallback.textLayerCached,true);assert.match(fallback.text,/Pagina 8/);assert.doesNotMatch(fallback.text,/Pagina 1/);
  });
  await check('native vision retains every rendered page, even with an embedded text layer',async()=>{
    const r=await post({...source,data_uri:uri(visual.bytes),native_vision:true});
    assert.equal(r.completeText,true);assert.deepEqual(r.vision.map(v=>v.page),[1,2]);assert.equal(r.text,result.text);
    for(const v of r.vision) assert.match(v.image,/^data:image\/jpeg;base64,/);
  });
  await check('complete probe rejects incompatible explicit ranges instead of silently ignoring them',async()=>{
    await post({...source,pages:'2'},'/api/pdf/describe',400);
  });
  await check('production attachment preparation skips planner only after a proven complete read; mixed files route remaining PDFs',async()=>{
    const html=fs.readFileSync('web/index.html','utf8');
    const start=html.indexOf('      async function analyzePdfAttachment('),end=html.indexOf('      function attachTileMeta(',start);
    assert.ok(start>=0&&end>start,'attachment harness extraction failed');
    const entries=new Map(),pending=[];const calls=[];let plans=0;
    const sandbox={console,AbortSignal,setInterval,clearInterval,Map,
      imageAttachData:entries,pendingAttachments:pending,renderPendingAttachments(){},
      isLanClientMode:()=>false,Store:{getSettings:()=>({})},
      rememberImageData:(id,e)=>entries.set(id,e),
      ensureEmbeddingSetup:()=>{throw Error('complete read must not install embeddings');},
      routePdfReadPlan:async()=>{plans++;return {mode:'pages',pages:'8'};},
      fetch:async(url,opts)=>{if(url==='/api/pdf/describe')calls.push(JSON.parse(opts.body));return fetch(base+url,opts);},
    };
    const api=vm.runInNewContext(`${html.slice(start,end)}\n({preparePdfAttachments,analyzePdfAttachment})`,sandbox);
    const add=(id,f)=>{const a={id,kind:'pdf',name:`${id}.pdf`,content:''};entries.set(id,{pdfBytes:uri(f.bytes)});return a;};
    const a=add('compact',compact),b=add('large',large);
    await api.preparePdfAttachments([a,b],'What is the final calibration code?');
    assert.equal(plans,1);assert.equal(calls.length,3);assert.deepEqual(calls.map(c=>c.profile),['complete','complete','interactive']);
    assert.match(a.content,/ZEBRA-7319/);assert.match(b.content,/Pagina 8/);
    assert.match(a.documentId,/^[a-f0-9]{64}$/);assert.equal(entries.get(a.id).pdfBytes,undefined);assert.equal(entries.get(b.id).pdfBytes,undefined);
    plans=0;calls.length=0;
    const c=add('visual',visual);await api.preparePdfAttachments([c],'Describe this PDF',{nativeVision:true});
    assert.equal(plans,0);assert.equal(pending.length,2);assert.equal(calls.length,1);
    // Older host / transient probe error must preserve original bytes and route.
    const original=sandbox.fetch;let first=true;
    sandbox.fetch=async(url,opts)=>{if(first&&url==='/api/pdf/describe'){first=false;return new Response(JSON.stringify({ok:true,text:'partial'}));}return original(url,opts);};
    const d=add('retry',large);await api.preparePdfAttachments([d],'Read page 8');assert.equal(plans,1);assert.match(d.content,/Pagina 8/);
  });
  await check('headless full Chat upload uses one completion and opens real last-page highlights (simulated engine only)',async()=>{
    browser=await webkit.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1280,height:1000}});
    await context.addInitScript(origin=>{
      // Playwright injects into child frames too. Seed the app, not opaque
      // preview sandboxes where storage access is intentionally unavailable.
      if(window!==window.top || location.origin!==origin)return;
      localStorage.setItem('ds4web.settings.v2',JSON.stringify({
        v:2,onboarded:true,model:'deepseek-v4-flash',modelGguf:'gguf/test.gguf',
        ctxSize:8192,enginePower:100,ssdStreaming:'off',thinkLevel:'off',maxTokens:256,
        temperature:0,webMode:'off',qualityDefaultsVersion:2,
      }));
    },base);
    const fulfill=(route,value)=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    await context.route('**/api/status',r=>fulfill(r,{mode:'server',running:true,ready:true,stage:'Ready',loadPct:100,
      ds4dirOk:true,webdirOk:true,lan:false,variants:{flash:true},variant:'flash',modelFile:'gguf/test.gguf',
      config:{ctx:8192,power:100,think:'off',ssdStreaming:'off'}}));
    await context.route('**/api/doctor',r=>fulfill(r,{ok:true,issues:[],checks:[]}));
    await context.route('**/v1/models',r=>fulfill(r,{data:[{id:'deepseek-v4-flash',context_length:8192}]}));
    const completions=[],reads=[],forbidden=[],errors=[];
    await context.route('**/api/start',async r=>{forbidden.push(r.request().postData());await r.abort();});
    await context.route('**/api/embed/setup',async r=>{forbidden.push('embedding setup');await r.abort();});
    await context.route('**/v1/chat/completions',async route=>{
      const req=route.request().postDataJSON();completions.push(req);
      // The only simulated boundary. PDF bytes/text, citations and rendering
      // below use the real server; this is not a model-quality assertion.
      const evidence={citations:[{id:'P2',documentId:result.documentId,page:2,quote:'Final calibration code: ZEBRA-7319.'}]};
      const answer=`ZEBRA-7319 [P2]\n\n\`\`\`dstudio-pdf-evidence\n${JSON.stringify(evidence)}\n\`\`\``;
      if(!req.stream){await fulfill(route,{choices:[{message:{content:'{"mode":"overview"}'}}]});return;}
      await route.fulfill({contentType:'text/event-stream',body:
        `data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:null}]})}\n\n`+
        `data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`});
    });
    report.browserErrors=errors;
    const page=await context.newPage();page.on('pageerror',e=>errors.push({message:e.message,stack:e.stack}));
    page.on('request',r=>{if(r.url().endsWith('/api/pdf/describe'))reads.push(r.postDataJSON());});
    await page.goto(base+'/',{waitUntil:'domcontentloaded'});
    await page.locator('#composer-input').waitFor({state:'visible'});
    await page.locator('#chat-file-input').setInputFiles(compact.file);
    await page.locator('#composer-files').getByText('compact.pdf',{exact:true}).waitFor({state:'visible'});
    await page.locator('#composer-input').fill('What is the final calibration code?');
    await page.locator('#btn-send').click();
    await page.locator('.msg--assistant:not(.msg--streaming) .pdf-evidence-inline').waitFor({state:'visible'});
    assert.equal(completions.length,1,'no planning inference before the answer');assert.equal(completions[0].stream,true);
    assert.equal(reads.length,1);assert.equal(reads[0].profile,'complete');
    const prompt=JSON.stringify(completions[0].messages);
    for(const needle of ['ZEBRA-7319','37.25','Sample 48','Pagina 1','Pagina 2'])assert.ok(prompt.includes(needle),needle);
    await page.locator('.pdf-evidence-inline').click();
    await page.locator('.pdf-evidence-highlight').first().waitFor({state:'visible'});
    await page.locator('.pdf-evidence-highlight').first().scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(run,'chat-evidence.png'),fullPage:true});
    assert.doesNotMatch(await page.locator('.msg--assistant').innerText(),/dstudio-pdf-evidence|"documentId"/);
    assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
    await context.close();
  });
  report.status='pass';
} catch(e) {report.status='fail';report.error=e.stack;process.exitCode=1;console.error(e);}
finally {
  await browser?.close();
  try{process.kill(-server.pid,'SIGTERM');}catch{}
  await sleep(300);if(server.exitCode===null&&server.signalCode===null){try{process.kill(-server.pid,'SIGKILL');}catch{}}
  save();console.log(`Evidence: ${run}`);
}
