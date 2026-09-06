// Independent behavioral audit of real generated artifacts, never model self-grades.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {chromium} from 'playwright';

const run=path.resolve(process.argv[2]||'');
assert.ok(process.argv[2],'Pass a completed comparison output directory');
const source=JSON.parse(fs.readFileSync(path.join(run,'report.json'),'utf8'));
const partial=process.argv[3]==='--completed-only';
assert.ok(!process.argv[3] || partial,'Unknown audit option');
const auditPath=path.join(run,partial?'audit.partial.json':'audit.json');
// Preserve earlier audit receipts when a completed case is added or a harness
// defect is corrected. The model's original workspace is never repaired here.
if(fs.existsSync(auditPath)) {
  const history=fs.mkdtempSync(path.join(run,'audit-history-'));
  fs.copyFileSync(auditPath,path.join(history,path.basename(auditPath)));
}
const pending=source.cases.filter(c=>c.status==='running').map(c=>c.id);
assert.ok(partial || pending.length===0,'Run is still active; use --completed-only for a clearly labelled partial audit');
const completed=source.cases.filter(c=>c.status!=='running');
assert.ok(completed.length,'No completed cases to audit yet');
const suite=JSON.parse(fs.readFileSync(path.join(run,'frozen-cases.json'),'utf8'));
assert.equal(new Set(source.cases.map(c=>c.id)).size,source.cases.length,'Duplicate case receipts');
assert.ok(source.cases.every(c=>suite.cases.some(frozen=>frozen.id===c.id)),'Unknown case receipt');
assert.ok(partial || completed.length===(source.caseCount ?? suite.cases.length),
  'Some requested cases were never run; use --completed-only for a clearly labelled partial audit');
const server=http.createServer((req,res)=>{
  let file;
  try{file=path.resolve(run,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));}catch{res.writeHead(400).end();return;}
  if(!file.startsWith(run+path.sep)){res.writeHead(403).end();return;}
  try{
    const bytes=fs.readFileSync(file),ext=path.extname(file);
    res.writeHead(200,{'Content-Type':{'.html':'text/html','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml','.png':'image/png'}[ext]||'application/octet-stream'}).end(bytes);
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
const audit={label:source.label,partial,scope:'Independent rendered task requirements and working interactions; aesthetics are reviewed separately.',
  auditorSha256:crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),
  notYetAudited:suite.cases.filter(c=>!completed.some(r=>r.id===c.id)).map(c=>c.id),cases:[]};
const save=()=>fs.writeFileSync(auditPath,JSON.stringify(audit,null,2));
async function chooseState(page,label){
  const button=page.getByRole('button',{name:new RegExp('^'+label+'\\b','i')});
  if(await button.count())return button.first().click();
  const radio=page.getByRole('radio',{name:new RegExp('^'+label+'\\b','i')});
  if(await radio.count())return radio.first().check();
  for(const select of await page.locator('select:visible').all()){
    const option=await select.locator('option').filter({hasText:new RegExp('^'+label+'$','i')}).getAttribute('value').catch(()=>null);
    if(option!==null)return select.selectOption(option);
  }
  throw Error('No accessible control for state '+label);
}
async function searchField(page){
  const input=page.locator('input[type="search"]:visible,input[placeholder*="search" i]:visible,input[aria-label*="search" i]:visible');
  assert.ok(await input.count(),'No visible search field');
  const field=input.first();
  const named=page.getByRole('searchbox',{name:/\S/}).or(page.getByRole('textbox',{name:/\S/}))
    .or(page.getByRole('combobox',{name:/\S/}));
  assert.equal(await field.and(named).count(),1,'Search has no accessible label');
  return field;
}
try {
  for(const result of completed){
    const c=suite.cases.find(c=>c.id===result.id),record={id:c.id,checks:[],screenshots:[]};
    audit.cases.push(record);
    const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const external=[],errors=[],missing=[];
    await context.route('**/*',route=>{
      if(!route.request().url().startsWith(base+'/')){external.push(route.request().url());return route.abort();}
      return route.continue();
    });
    const page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    page.on('response',r=>{if(r.status()>=400)missing.push({url:r.url(),status:r.status()});});
    async function check(name,fn){
      const out={name};record.checks.push(out);
      try{await fn();out.pass=true;}catch(e){out.pass=false;out.error=e.message;}
      save();console.log(c.id+' / '+name+': '+out.pass);
    }
    try {
      await check('agent completed and registered its artifact',async()=>{
        assert.equal(result.status,'idle');assert.ok(result.artifact);assert.ok(result.entryExists);
        assert.ok(!result.generationLimitReached,'Native turn ended at its generation recovery limit');
      });
      if(!result.entryExists)continue;
      await page.goto(base+'/'+c.id+'/workspace/'+c.entry);
      for(const width of [1440,768,390]){
        await check('rendered content and page fit at '+width+'px',async()=>{
          await page.setViewportSize({width,height:1000});
          await page.waitForTimeout(150);
          const measure=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth,text:document.body.innerText}));
          assert.ok(measure.scroll<=measure.width+1,JSON.stringify({scroll:measure.scroll,width:measure.width}));
          assert.ok(measure.text.trim().length>80,'Empty or failed render');
          const name=c.id+'-'+width+'.png';await page.screenshot({path:path.join(run,name),fullPage:true});record.screenshots.push(name);
        });
      }
      await page.setViewportSize({width:1440,height:1000});
      await check('required content is present in the delivered page',async()=>{
        // A visible line break does not remove words from a heading. Keep the
        // case/content requirement, but treat rendered whitespace uniformly.
        const normalize=text=>text.replace(/\s+/gu,' ').trim();
        const text=normalize(await page.locator('body').innerText());
        for(const required of c.requiredText)assert.ok(text.includes(normalize(required)),'Missing: '+required);
      });
      await check('in-page navigation has valid destinations',async()=>{
        record.navigation=await page.evaluate(()=>[...document.querySelectorAll('a[href]')].flatMap(a=>{
          const url=new URL(a.href,location.href);
          if(url.origin!==location.origin || url.pathname!==location.pathname ||
             url.search!==location.search || !url.hash || url.hash==='#')return [];
          let id;try{id=decodeURIComponent(url.hash.slice(1));}catch{return [{text:a.innerText,href:a.getAttribute('href'),resolved:false}];}
          return [{text:a.innerText,href:a.getAttribute('href'),resolved:!!document.getElementById(id) ||
            [...document.getElementsByName(id)].some(e=>e.tagName==='A')}];
        }));
        assert.deepEqual(record.navigation.filter(link=>!link.resolved),[],
          'In-page links point to missing destinations: '+JSON.stringify(record.navigation.filter(link=>!link.resolved)));
      });
      await check('task-specific interaction works, including recovery',async()=>{
        if(c.id==='archive'){
          const input=await searchField(page);
          await input.fill('Railway');
          assert.ok(await page.getByText('Railway span',{exact:true}).first().isVisible());
          assert.equal(await page.getByText('Footbridge 12',{exact:true}).first().isVisible(),false);
          await input.fill('not-a-real-entry-xyz');
          assert.equal(await page.getByText('Railway span',{exact:true}).first().isVisible(),false);
          assert.ok(await page.getByText(/no (results|entries|matches|field notes)|nothing found/i).first().isVisible(),'Missing empty state');
          await input.fill('');
          await page.getByText('Read the field note',{exact:true}).first().click();
          await page.locator('dialog:visible').waitFor({timeout:3000});
          const text=await page.locator('dialog:visible').innerText();
          assert.ok(/footbridge/i.test(text) && /neighbou?rhood/i.test(text),'Dialog does not contain the requested field note');
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('dialog:visible').count(),0);
        }else if(c.id==='repair'){
          const input=await searchField(page);await input.fill('radio');
          assert.ok(await page.getByText('Portable radio',{exact:true}).first().isVisible());
          assert.equal(await page.getByText('Desk lamp',{exact:true}).first().isVisible(),false);
          await input.fill('');
          await chooseState(page,'Loading');
          assert.equal(await page.getByText('Desk lamp',{exact:true}).first().isVisible(),false,'Loading still shows populated records');
          const loading=page.getByRole('progressbar').or(page.locator('[aria-busy="true"]'))
            .or(page.getByRole('status',{name:/loading|please wait/i}))
            .or(page.getByText(/loading[. …]|loading (items|queue|repairs)|please wait/i));
          assert.ok(await loading.filter({visible:true}).count(),'Loading has no visible progress or wait feedback');
          await chooseState(page,'Empty');
          assert.equal(await page.getByText('Desk lamp',{exact:true}).first().isVisible(),false,'Empty still shows populated records');
          await chooseState(page,'Error');
          assert.equal(await page.getByText('Desk lamp',{exact:true}).first().isVisible(),false,'Error still shows populated records');
          await page.getByRole('button',{name:/retry/i}).first().click();
          await page.getByText('Desk lamp',{exact:true}).first().waitFor({timeout:3000});
          await chooseState(page,'Empty');
          assert.equal(await page.getByText('Desk lamp',{exact:true}).first().isVisible(),false);
          await chooseState(page,'Populated');
          await page.getByText('Desk lamp',{exact:true}).first().waitFor({timeout:3000});
        }else{
          const next=()=>page.getByRole('button',{name:/^Continue\b/i}).first();
          const reviewChoice=pattern=>page.getByText(pattern).filter({visible:true}).first().waitFor({timeout:3000});
          assert.ok(await next().isDisabled(),'Continue must require a workshop choice');
          await page.getByText('Bicycle care',{exact:true}).first().click();
          await next().click();
          assert.ok(await next().isDisabled(),'Continue must require a day choice');
          await page.getByText('Thursday',{exact:true}).first().click();
          await next().click();
          await reviewChoice(/Bicycle care/);
          await reviewChoice(/Thursday/);
          await page.getByRole('button',{name:/^Back\b/i}).first().click();
          assert.ok(await next().isEnabled(),'Back discarded the day selection');
          await page.getByRole('button',{name:/^Back\b/i}).first().click();
          assert.ok(await next().isEnabled(),'Back discarded the workshop selection');
          await next().click();
          assert.ok(await next().isEnabled(),'Revisiting the day step discarded the day selection');
          await next().click();
          await reviewChoice(/Bicycle care/);
          await reviewChoice(/Thursday/);
          const completionFeedback=()=>page.getByText(/No booking was made/i).filter({visible:true})
            .or(page.getByRole('button',{name:/start over|restart|reset/i}).filter({visible:true}));
          const priorFeedback=await completionFeedback().elementHandles();
          await page.getByRole('button',{name:/complete|confirm|finish/i}).first().click();
          await page.getByText(/No booking was made/i).filter({visible:true}).first().waitFor({timeout:3000});
          let changed=false;
          for(const deadline=Date.now()+3000;Date.now()<deadline;){
            changed=await completionFeedback().evaluateAll((nodes,prior)=>nodes.some(n=>!prior.includes(n)),priorFeedback);
            if(changed)break;
            await page.waitForTimeout(50);
          }
          await Promise.all(priorFeedback.map(handle=>handle.dispose()));
          assert.ok(changed,'Final action produced no new completion feedback; a permanent footer notice is not confirmation');
        }
      });
      await check('export has no missing assets, script errors or external requests',async()=>{
        assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);assert.deepEqual(external,[]);
      });
    }finally{await context.close();save();}
  }
}finally{await browser.close();await new Promise(r=>server.close(r));save();}
if(audit.cases.some(c=>c.checks.some(x=>!x.pass)))process.exitCode=1;
