// Authored oracle fixtures, NOT LLM-generated projects or benchmark results.
// Exercise the real auditor through Chromium/WebKit and retain deliberate FAILs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {chromium, webkit} from 'playwright';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';
import {exerciseDesignProject, designProjectScenarios} from '../support/design_project_interactions.mjs';
import {measureProjectChoices} from '../support/design_project_layout.mjs';
import {snapshotProject, serveProjectSnapshot, validateProjectAuditInput, auditProjectView} from '../support/design_project_audit.mjs';
import {pathToFileURL} from 'node:url';
import {validateDesignProjects} from '../support/design_project_cases.mjs';

const run = artifactRunDir('design-project-auditor'), workspace = path.join(run, 'fixture');
fs.mkdirSync(workspace);
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{font:17px system-ui;color:#161b22;background:#fff;margin:20px}button,input{font:inherit;padding:8px;max-width:100%;color:inherit;background:inherit;border:1px solid #8c96a2;border-radius:3px}label{display:block}article{margin:16px 0}dialog{max-width:80vw}label.choice{display:grid;grid-template-columns:24px 1fr;gap:8px;max-width:260px}input[type=radio]{margin:0;width:18px;height:18px}input[type=checkbox]{width:18px;height:18px}@media(prefers-color-scheme:dark){body,dialog{color:#eaeef5;background:#181b22}}</style>
<h1>BRIDGE NOTES</h1><p>Small crossings, large stories</p><p>Sample data</p>
<label>Search <input type="search" oninput="filterEntries()"></label><button onclick="clearEntries()">Clear</button>
<main><article><h2>Footbridge 12</h2><button onclick="readNote(this,0)">Read field note</button></article>
<article><h2>Canal crossing</h2><button onclick="readNote(this,1)">Read field note</button></article>
<article><h2>Railway span</h2><button onclick="readNote(this,2)">Read field note</button></article></main>
<p id="empty" hidden>No entries found</p><dialog><h2></h2><p></p><button onclick="document.querySelector('dialog').close()">Close</button></dialog>
<script>
window.fault = '';
const titles=['Footbridge 12','Canal crossing','Railway span'];
const notes=['Neighbours built a small crossing to reach the shared garden by foot.','The crossing sits beside the old canal and opens a quiet route through town.','The railway span links two streets above the freight tracks and a repair yard.'];
function filterEntries(){let n=0;document.querySelectorAll('article').forEach((el,i)=>{el.hidden=!titles[i].toLowerCase().includes(document.querySelector('input').value.toLowerCase());if(!el.hidden)n++});document.querySelector('#empty').hidden=!!n;}
function clearEntries(){if(window.fault==='clear')return;document.querySelector('input').value='';filterEntries();}
function readNote(el,i){const d=document.querySelector('dialog');d.querySelector('h2').textContent=titles[i];d.querySelector('p').textContent=notes[window.fault==='same-note'?0:i];d.showModal();}
document.querySelector('dialog').addEventListener('cancel',event=>{
  if(!['deferred-close','blocked-close'].includes(window.fault))return;
  event.preventDefault();
  if(window.fault==='deferred-close')setTimeout(()=>event.target.close(),100);
});
</script></html>`;
fs.writeFileSync(path.join(workspace, 'index.html'), fixture, {flag: 'wx'});
const choice = `<!doctype html><html><style>body{margin:20px;font:18px system-ui}label{display:grid;grid-template-columns:20px 1fr;gap:8px;width:260px}input{width:18px;height:18px;margin:0}</style><label><input type="radio" name="pick"><span>A deliberately long choice title and description that should wrap only in its own text column.</span></label><label for="other">A separately associated checkbox label that stays outside the indicator column.</label><input type="checkbox" id="other"></html>`;
// The second external label is intentionally laid out on a separate row and
// must be reported as a geometry problem, not skipped because it uses `for`.
fs.writeFileSync(path.join(workspace, 'choice.html'), choice, {flag: 'wx'});
const original = snapshotProject(workspace), server = await serveProjectSnapshot(original);
const domainFixtures=[];
for(const [file,caseIndex,faults] of [
  ['design-reading-list.html',1,[['same-essay',/identical bodies/],['shared-read',/Mark as read/],
    ['shared-note',/Missing visible content/],['markup-note',/Missing visible content/],['empty-note',/empty note cannot/]]],
  ['design-repair-queue.html',2,[['stale-state',/Unexpected visible content/],['broken-retry',/Missing visible content/],
    ['wrong-detail',/Dialog does not match its table row/],['missing-empty',/Missing visible content/]]],
  ['design-incident-board.html',3,[['shared-assignment',/assignee|strictly equal/i],
    ['filter-reset-assignment',/assignee|strictly equal/i],['wrong-row-state',/Missing visible content|Expected one accessible/i],
    ['missing-empty',/no open|AssertionError/i],['history-out-of-order',/history action order/i],
    ['stale-counts',/incident count/i],['history-drop-earlier',/history action/i],['auto-apply-draft',/draft assignment/i]]],
]){
  const folder=path.join(run,file.replace('.html',''));fs.mkdirSync(folder);
  fs.copyFileSync(new URL('../fixtures/'+file,import.meta.url),path.join(folder,'index.html'));
  const snapshot=snapshotProject(folder);
  domainFixtures.push({file,folder,caseIndex,faults,snapshot,server:await serveProjectSnapshot(snapshot)});
}
const report = {scope: 'Authored fixture tests of audit correctness; no model generation or product-quality score', checks: []};
const save = () => writeArtifact(run, 'report.json', report);
async function check(name, fn) {
  const row = {name}; report.checks.push(row);
  try { await fn(); row.status = 'pass'; }
  catch (error) { row.status = 'fail'; row.error = error.stack; throw error; }
  finally { save(); console.log(row.status + ': ' + name); }
}
try {
  const raw = fs.readFileSync(new URL('../fixtures/design_pack_projects.json', import.meta.url)), suite = JSON.parse(raw);
  const cases = validateDesignProjects(suite), digest = crypto.createHash('sha256').update(raw).digest('hex');
  const source = {suite: {sha256: digest, planned: 18, selected: cases.map(c => c.id)}, caseCount: 18,
    binarySha256: 'a'.repeat(64), model: {sha256: 'b'.repeat(64), bytes: 1}, engineIdentity: {commit: 'c'.repeat(40)},
    inference: {context: 32768}, memory: 'Synthetic admission fixture, not a real model',
    cases: cases.map(c => ({id: c.id, prompt: c.prompt, entry: c.entry, designSystemId: c.designSystemId, status: 'idle'}))};
  await check('all eighteen workflows have a scenario; malformed/partial provenance is rejected', async () => {
    assert.equal(validateProjectAuditInput(source, suite, digest).length, 18);
    assert.equal(Object.keys(designProjectScenarios).length, 18);
    for (const change of [s => s.cases.pop(), s => s.cases[0].prompt = 'different task', s => s.cases[0].id = s.cases[1].id,
      s => s.suite.sha256 = 'd'.repeat(64), s => s.suite.selected.pop(), s => s.cases[0].status = 'running',
      s => s.model.sha256 = '', s => s.interrupted = true]) {
      const input = structuredClone(source); change(input); assert.throws(() => validateProjectAuditInput(input, suite, digest));
    }
    const incomplete = structuredClone(source); incomplete.cases.pop();
    assert.equal(validateProjectAuditInput(incomplete, suite, digest, {partial: true}).length, 18);
    await assert.rejects(exerciseDesignProject({interaction: 'unimplemented'}, null, null, async () => {}), /No interaction oracle/);
  });
  await check('snapshot rejects symlink escape and HTTP serves only frozen project bytes', async () => {
    const outside = path.join(run, 'outside.txt'); fs.writeFileSync(outside, 'never serve this');
    const linked = path.join(run, 'linked'); fs.mkdirSync(linked); fs.copyFileSync(path.join(workspace, 'index.html'), path.join(linked, 'index.html'));
    fs.symlinkSync(outside, path.join(linked, 'escape.txt'));
    assert.throws(() => snapshotProject(linked), /symlink/);
    for (const target of ['/outside.txt', '/project/%2e%2e%2foutside.txt', '/project/%2foutside.txt', '/project/missing.js']) {
      const response = await fetch(server.base + target); assert.ok(response.status >= 400); assert.doesNotMatch(await response.text(), /never serve this/);
    }
    assert.equal(await (await fetch(server.base + '/project/index.html')).text(), fixture);
  });
  for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await type.launch({headless: true});
    try {
      const context = await browser.newContext({viewport: {width: 390, height: 900}}); context.setDefaultTimeout(1500);
      const page = await context.newPage();
      for (const framed of [false, true]) await check(`${name}: actual search, three distinct dialogs and keyboard focus ${framed ? 'inside opaque frame' : 'standalone'}`, async () => {
        await page.goto(server.base + (framed ? '/preview' : '/project/index.html'));
        const scope = framed ? page.frameLocator('iframe') : page, steps = [];
        await exerciseDesignProject(cases[0], scope, page, async (label, fn) => { await fn(); steps.push(label); });
        assert.equal(steps.length, 2);
        if (framed) assert.equal(await page.frames()[1].evaluate(() => self.origin), 'null');
      });
      for (const theme of ['light', 'dark']) for (const kind of ['http', 'opaque', 'file', 'text200']) {
        await check(`${name}: full ${theme}/${kind} audit pipeline on authored reference fixture`, async () => {
          const settings = {id: `${name}-${theme}-${kind}`, engine: name, theme, width: 390,
            frame: kind === 'opaque', textScale: kind === 'text200' ? 2 : 1, interactions: true};
          const target = kind === 'file'
            ? {url: pathToFileURL(path.join(workspace, 'index.html')).href, allowedPrefix: pathToFileURL(workspace + path.sep).href}
            : {url: server.base + (settings.frame ? '/preview' : '/project/index.html'), allowedPrefix: server.base + '/project/'};
          const record = {...settings, scope: 'Authored oracle fixture, not LLM quality', checks: [], screenshots: []};
          const saveView = () => writeArtifact(run, `${settings.id}-fixture-audit.json`, record);
          await auditProjectView(browser, target, cases[0], settings, run, record, saveView);
          assert.equal(record.status, 'pass', JSON.stringify(record.checks.filter(c => c.status !== 'pass')));
        });
      }
      for (const [fault, error] of [['clear', /Missing visible content/], ['same-note', /identical notes/]]) {
        await check(`${name}: deliberately broken ${fault} cannot pass the interaction oracle`, async () => {
          await page.goto(server.base + '/project/index.html'); await page.evaluate(fault => { window.fault = fault; }, fault);
          let captured;
          try { await exerciseDesignProject(cases[0], page, page, async (_, fn) => fn()); }
          catch (failure) { captured = failure; }
          writeArtifact(run, `${name}-${fault}-expected-failure.json`, {scope: 'Deliberately broken authored fixture', observed: String(captured?.message)});
          assert.ok(captured, 'broken controls incorrectly passed'); assert.match(captured.message, error);
        });
      }
      await check(`${name}: dialog closure on the next UI update is awaited within the original action budget`,async()=>{
        await page.goto(server.base+'/project/index.html');await page.evaluate(()=>{window.fault='deferred-close';});
        await exerciseDesignProject(cases[0],page,page,async(_,fn)=>fn());
      });
      await check(`${name}: preventing Escape forever cannot pass dialog closure`,async()=>{
        await page.goto(server.base+'/project/index.html');await page.evaluate(()=>{window.fault='blocked-close';});
        await assert.rejects(exerciseDesignProject(cases[0],page,page,async(_,fn)=>fn()),/Timeout|dialog did not close/);
      });
      await check(`${name}: wrapped and external labels are measured; broken radio layout is caught`, async () => {
        await page.goto(server.base + '/project/choice.html');
        const initial = await measureProjectChoices(page); assert.equal(initial.length, 2);
        assert.equal(initial[0].clearsIndicatorColumn, true); assert.equal(initial[1].clearsIndicatorColumn, false);
        await page.locator('label').first().evaluate(label => { label.style.display = 'block'; });
        assert.equal((await measureProjectChoices(page))[0].clearsIndicatorColumn, false);
        await page.screenshot({path: path.join(run, `${name}-deliberately-broken-choices.png`)});
      });
      for(const fixture of domainFixtures){
        const c=cases[fixture.caseIndex];
        for(const framed of [false,true])await check(`${name}: ${c.interaction} positive ${framed?'opaque':'standalone'}`,async()=>{
          await page.goto(fixture.server.base+(framed?'/preview':'/project/index.html'));
          const scope=framed?page.frameLocator('iframe'):page,steps=[];
          await exerciseDesignProject(c,scope,page,async(label,fn)=>{await fn();steps.push(label);});
          assert.equal(steps.length,fixture.caseIndex===1?3:2);
        });
        for(const [fault,pattern] of fixture.faults)await check(`${name}: ${c.interaction} catches ${fault}`,async()=>{
          await page.goto(fixture.server.base+'/project/index.html');
          await page.evaluate(fault=>{window.fault=fault;render();},fault);
          let captured;
          try{await exerciseDesignProject(c,page,page,async(_,fn)=>fn());}catch(error){captured=error;}
          writeArtifact(run,`${name}-${c.id}-${fault}-expected-failure.json`,{
            scope:'Deliberately defective authored oracle fixture, not a model failure',error:String(captured?.message)});
          assert.ok(captured,'Deliberately broken workflow incorrectly passed');assert.match(captured.message,pattern);
        });
        for(const theme of ['light','dark'])await check(`${name}: ${c.interaction} complete ${theme} view pipeline`,async()=>{
          const settings={id:`${name}-${theme}-domain`,engine:name,theme,width:390,frame:false,textScale:1,interactions:true};
          const record={...settings,checks:[],screenshots:[]};
          const saveView=()=>writeArtifact(run,`${name}-${theme}-${c.id}-fixture-audit.json`,record);
          await auditProjectView(browser,{url:fixture.server.base+'/project/index.html',allowedPrefix:fixture.server.base+'/project/'},
            c,settings,run,record,saveView);
          assert.equal(record.status,'pass',JSON.stringify(record.checks.filter(row=>row.status!=='pass')));
        });
      }
      await context.close();
    } finally { await browser.close(); }
  }
  await check('browser audit preserves every original fixture byte', async () => {
    assert.deepEqual(snapshotProject(workspace).hashes, original.hashes);
    for(const fixture of domainFixtures)assert.deepEqual(snapshotProject(fixture.folder).hashes,fixture.snapshot.hashes);
  });
} finally { await server.close(); for(const fixture of domainFixtures)await fixture.server.close(); save(); }
console.log(`Audit regressions (not LLM quality): ${run}`);
