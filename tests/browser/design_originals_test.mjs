// Actual native catalog/preview HTTP + Chromium and WebKit rendering.
// No model, no simulated catalog. This checks packs and UI behavior, not LLM quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium, webkit} from 'playwright';
import {freePort, sleep, csrfHeaders} from '../support/real_harness.mjs';
import {renderedContrast, doubleRenderedText, renderedReflow} from '../support/design_preview_accessibility.mjs';

const root = process.cwd();
fs.mkdirSync('tests/.artifacts', {recursive:true});
const run = fs.mkdtempSync(path.resolve('tests/.artifacts/design-originals-'));
for (const d of ['install/extension/design','install/ds4/gguf','data'])
  fs.mkdirSync(path.join(run,d), {recursive:true});
const install = path.join(run,'install');
fs.cpSync('extension/design-systems', path.join(install,'extension/design-systems'), {recursive:true});
fs.copyFileSync('extension/design/build-design.sh', path.join(install,'extension/design/build-design.sh'));
fs.writeFileSync(path.join(install,'ds4/Makefile'),'all:\n\t@true\n');
// An old install can retain a stale directory. It must neither appear nor load.
fs.mkdirSync(path.join(install,'extension/design-systems/retired'));
fs.writeFileSync(path.join(install,'extension/design-systems/retired/DESIGN.md'),'---\nname: Retired\n---\nOld imported content.');
fs.writeFileSync(path.join(install,'extension/design-systems/retired/components.html'),'<h1>Retired</h1>');
const base = 'http://127.0.0.1:' + await freePort();
const log = fs.openSync(path.join(run,'server.log'),'wx');
const server = spawn(path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test'),
  [new URL(base).port,path.join(install,'ds4')], {
    cwd:install,env:{...process.env,DS4UI_TEST_MODE:'1',DS4UI_HOST:'127.0.0.1',DS4UI_DATA_DIR:path.join(run,'data')},
    detached:true,stdio:['ignore',log,log],
  });
fs.closeSync(log);
const report = {scope:'Native catalog, offline original previews and rendered interactions. No inference.',checks:[],screenshots:[],contrast:[]};
const save=()=>fs.writeFileSync(path.join(run,'report.json'),JSON.stringify(report,null,2));
async function check(name,fn) {
  const record={name};report.checks.push(record);const t=performance.now();
  try {await fn();record.status='pass';}
  catch(e){record.status='fail';record.error=e.stack;throw e;}
  finally{record.ms=performance.now()-t;save();console.log(record.status+': '+name);}
}
let browser;
try {
  let ready=false;
  for(let i=0;i<120;i++){try{if((await fetch(base+'/api/status')).ok){ready=true;break;}}catch{}await sleep(100);}
  assert.ok(ready,'native server did not start');
  let catalog;
  await check('native catalog contains exactly five complete originals, excludes retired folders',async()=>{
    catalog=(await (await fetch(base+'/api/design-systems')).json()).designSystems;
    assert.deepEqual(catalog.map(s=>s.id).sort(),['folio','forma','grove','pulse','signal']);
    assert.ok(catalog.every(s=>s.hasComponents && s.hasAssets && s.hasReferences));
    const legacy=await fetch(base+'/api/design-system-preview/retired/components.html');
    assert.equal(legacy.status,404);
    const ready=await fetch(base+'/api/setup/content',{method:'POST',headers:csrfHeaders});
    assert.equal(ready.status,200);assert.equal((await ready.json()).bundled,true);
  });
  await check('missing bundled asset reports incomplete without fetching or overwriting content',async()=>{
    const css=path.join(install,'extension/design-systems/folio/tokens.css');
    const bytes=fs.readFileSync(css);fs.renameSync(css,css+'.saved');
    try {
      const r=await fetch(base+'/api/setup/content',{method:'POST',headers:csrfHeaders});
      assert.equal(r.status,409);assert.equal((await r.json()).contentOk,false);
      assert.equal(fs.existsSync(css),false);
      const status=await (await fetch(base+'/api/status')).json();
      assert.equal(status.contentDownloading ?? status.config?.contentDownloading,false);
      assert.deepEqual(fs.readFileSync(css+'.saved'),bytes);
    } finally {fs.renameSync(css+'.saved',css);}
  });
  for (const [engine,type] of [['chromium',chromium],['webkit',webkit]]) {
    browser=await type.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const external=[],errors=[];
    const consoleErrors=[];
    await context.route('**/*',route=>{
      if(!route.request().url().startsWith(base+'/')){external.push(route.request().url());return route.abort();}
      return route.continue();
    });
    const page=await context.newPage();
    await page.route(base+'/__design_test_host',route=>route.fulfill({
      contentType:'text/html',body:'<!doctype html><title>Isolated preview host</title>'
    }));
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
    for (const system of catalog) {
      await check(engine+' / '+system.name+' / responsive examples, appearances and working components',async()=>{
        await page.goto(base+'/api/design-system-preview/'+system.id+'/components.html');
        for(const appearance of ['light','dark']) {
          if(await page.locator('html').getAttribute('data-theme')!==appearance)
            await page.locator('[data-theme-toggle]').click();
          for(const width of [1440,768,390,320]) {
            await page.setViewportSize({width,height:1000});
            const measure=await page.evaluate(()=>({
              scroll:document.documentElement.scrollWidth,
              width:document.documentElement.clientWidth,
              title:document.querySelector('[data-panel="example"] h1')?.getBoundingClientRect().width,
            }));
            assert.ok(measure.scroll<=measure.width+1,JSON.stringify({system:system.id,appearance,width,...measure}));
            assert.ok(measure.title>0);
            if(engine==='chromium' && [1440,390].includes(width)){
              const name=system.id+'-'+appearance+'-'+width+'.png';
              await page.screenshot({path:path.join(run,name),fullPage:true});report.screenshots.push(name);
            }
          }
          await page.setViewportSize({width:390,height:1000});
          await page.getByRole('button',{name:'Components',exact:true}).click();
          await page.getByRole('heading',{name:'A working visual vocabulary.'}).waitFor();
          assert.ok(await page.getByRole('button',{name:'Unavailable'}).isDisabled());
          await page.getByLabel('Project name',{exact:true}).fill('A project with a deliberately long, translated working title');
          await page.getByRole('button',{name:'Try primary action'}).click();
          await page.getByRole('dialog').waitFor();
          const dialogPairs=await renderedContrast(page);
          report.contrast.push({engine,system:system.id,appearance,view:'Dialog',pairs:dialogPairs});save();
          assert.deepEqual(dialogPairs.filter(p=>p.ratio+.01<p.minimum),[], 'insufficient rendered dialog text contrast');
          await page.getByLabel('Name',{exact:true}).fill('');
          await page.getByLabel('Email',{exact:true}).fill('');
          await page.getByRole('button',{name:'Complete preview'}).click();
          assert.equal(await page.locator('#request-status').textContent(),'');
          await page.getByLabel('Name',{exact:true}).fill('Ada');
          await page.getByLabel('Email',{exact:true}).fill('ada@example.test');
          await page.getByRole('button',{name:'Complete preview'}).click();
          await page.getByRole('status').filter({hasText:'Nothing was sent or booked.'}).waitFor();
          await page.keyboard.press('Escape');
          assert.equal(await page.getByRole('dialog').count(),0);
          assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Try primary action');
          await page.getByRole('button',{name:'Example',exact:true}).click();
        }
        if(system.id==='signal'){
          await page.getByLabel('Filter work queue').fill('metadata');
          assert.equal(await page.locator('[data-record]:visible').count(),1);
          await page.getByLabel('Filter work queue').fill('nothing-matches-xyz');
          await page.getByText('No matching items. Try another search.').waitFor();
          assert.equal(await page.locator('[data-record]:visible').count(),0);
        }
        if(system.id==='grove'){
          await page.locator('[data-choice]').nth(1).click();
          assert.equal(await page.locator('[data-choice][aria-pressed="true"]').count(),1);
          await page.locator('[data-choice-status]').filter({hasText:'Wednesday'}).waitFor();
        }
        assert.deepEqual(external,[],'preview attempted external requests');
        assert.deepEqual(errors,[],'preview JavaScript errors');
      });
      await check(engine+' / '+system.name+' / rendered contrast and 200% text reflow',async()=>{
        for (const appearance of ['light','dark']) for (const view of ['Example','Components']) {
          await page.goto(base+'/api/design-system-preview/'+system.id+'/components.html');
          if(appearance==='dark') await page.locator('[data-theme-toggle]').click();
          await page.getByRole('button',{name:view,exact:true}).click();
          const pairs=await renderedContrast(page);
          assert.ok(pairs.length>20,'no rendered text pairs measured');
          report.contrast.push({engine,system:system.id,appearance,view,pairs});save();
          assert.deepEqual(pairs.filter(p=>p.ratio+.01<p.minimum),[], 'insufficient rendered text contrast');
          await doubleRenderedText(page);
          for (const width of [1440,390]) {
            await page.setViewportSize({width,height:1000});
            assert.deepEqual(await renderedReflow(page),[], '200% text '+appearance+' '+view+' '+width);
          }
          if(engine==='chromium') {
            const name=system.id+'-'+appearance+'-'+view.toLowerCase()+'-text200.png';
            await page.screenshot({path:path.join(run,name),fullPage:true});report.screenshots.push(name);
          }
          if(view==='Components') {
            await page.getByRole('button',{name:'Try primary action',exact:true}).click();
            await page.getByRole('dialog').waitFor();
            assert.deepEqual(await renderedReflow(page),[], '200% dialog text reflow');
            await page.getByLabel('Name',{exact:true}).fill('Ada');
            await page.getByLabel('Email',{exact:true}).fill('ada@example.test');
            await page.getByRole('button',{name:'Complete preview'}).click();
            await page.getByRole('status').filter({hasText:'Nothing was sent or booked.'}).waitFor();
            await page.keyboard.press('Escape');
            assert.equal(await page.getByRole('dialog').count(),0);
          }
        }
      });
      await check(engine+' / '+system.name+' / actual preview inside opaque app sandbox',async()=>{
        // A fresh host document avoids leaving the app's polling callbacks alive
        // after replacing its DOM. Only the frame is under test here.
        await page.goto(base+'/__design_test_host');
        await page.setContent('<iframe title="Design preview" sandbox="allow-scripts allow-forms" style="width:100%;height:900px;border:0" src="'+base+'/api/design-system-preview/'+system.id+'/components.html"></iframe>');
        const preview=page.frameLocator('iframe');
        await preview.getByRole('button',{name:'Components',exact:true}).click();
        try {await preview.getByRole('button',{name:'Try primary action',exact:true}).click({timeout:5000});}
        catch(e){report.previewFailure={engine,system:system.id,consoleErrors,errors};save();throw e;}
        await preview.getByRole('dialog').waitFor();
        await preview.getByLabel('Name',{exact:true}).fill('Ada');
        await preview.getByLabel('Email',{exact:true}).fill('ada@example.test');
        await preview.getByRole('button',{name:'Complete preview'}).click();
        await preview.getByRole('status').filter({hasText:'Nothing was sent or booked.'}).waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await preview.getByRole('dialog').count(),0);
        assert.equal(await preview.locator(':focus').textContent(),'Try primary action');
        assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
      });
    }
    await browser.close();browser=null;
  }
} finally {
  if(browser)await browser.close();
  try{process.kill(-server.pid,'SIGTERM');}catch{}
  await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));
  save();console.log('Evidence: '+run);
}
