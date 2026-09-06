// Real relocated macOS app in headless mode + empty data + WebKit UI + network engine builds.
// Only the weight-download boundary is refused: no simulated setup responses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { webkit } from 'playwright';
import { freePort, sleep } from '../support/real_harness.mjs';

assert.equal(process.platform, 'darwin', 'this gate requires macOS, not a skipped pass');
const repo = process.cwd();
const appSource = path.resolve(process.argv[2] || 'DStudio.app');
fs.mkdirSync(path.resolve('tests/.artifacts'), { recursive: true });
const run = fs.mkdtempSync(path.resolve('tests/.artifacts/first-launch-'));
const app = path.join(run, 'DStudio.app');
const data = path.join(run, 'support');
const temp = path.join(run, 'tmp');
fs.mkdirSync(temp);
assert.equal(fs.existsSync(data), false);
const report = {
  schema: 'dstudio.first-launch.v1', started: new Date().toISOString(),
  scope: 'Real bundled app binary in headless mode, empty profile, automated headless WebKit UI, real engine downloads/builds. Weight downloads refused before transfer; no model inference or native-window testing.',
  results: [], requests: [], weightBoundaries: [], pageErrors: [],
};
const save = () => fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(report, null, 2) + '\n');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const env = { ...process.env, DS4UI_DATA_DIR: data, TMPDIR: temp,
  DS4UI_HOST: '127.0.0.1', DSTUDIO_KV_DIR: path.join(run, 'kv') };
for (const key of ['DS4UI_TEST_MODE', 'DS4UI_NO_WINDOW', 'DS4UI_SKIP_LOADING',
  'DS4UI_DEFER_ENGINE_START', 'DS4_DIR', 'DS4UI_PORT']) delete env[key];
env.DS4UI_NO_WINDOW = '1';
env.DS4UI_DEFER_ENGINE_START = '1';
let child, browser, page, sentinel;
let serverPid;
const external = () => {
  const r = spawnSync('lsof', ['-nP', '-iTCP:28000', '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return (r.stdout || '').trim().split(/\s+/).filter(Boolean).map(Number).sort((a,b) => a-b);
};
let protectedPids = [];
let setupSurface;
function checkExternal() {
  for (const pid of protectedPids) process.kill(pid, 0);
  assert.deepEqual(external(), protectedPids, 'setup must not stop or replace the existing engine-port listener');
}
async function json(endpoint) {
  const r = await fetch(report.base + endpoint, { signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, 200); return r.json();
}
async function step(name, fn) {
  const row = { name, started: new Date().toISOString() }; report.results.push(row); save();
  console.log(`START ${name}`);
  const t = performance.now();
  try { row.evidence = await fn(); checkExternal(); row.status = 'pass'; }
  catch(e) { row.status = 'fail'; row.error = e.stack; throw e; }
  finally { row.seconds = (performance.now()-t)/1000; save(); console.log(`${row.status}: ${name} (${row.seconds.toFixed(1)}s)`); }
}
const configs = {
  main: { dir: 'ds4', endpoint: '/api/ds4/setup', commit: 'f4d03f6cf9f11c1e7b630bcb160853acfba7c52a' },
  laguna: { dir: 'ds4-laguna-s21', endpoint: '/api/laguna/setup', target: 'laguna-q4', commit: '448d5695d1c86401a4e9447c440feb983b73e6de' },
  qwen: { dir: 'ds4-qwen38', endpoint: '/api/qwen/setup', target: 'qwen38-q4k', commit: 'bd9cfbccc03a709a3f00b50e0ac1cc41c3fcf02d' },
  qwen35: { dir: 'ds4-qwen35', endpoint: '/api/qwen35/setup', target: 'qwen36-q6', commit: '60fca11f0c8b16ca50c757324dddd717ba043098' },
};
function verifyRuntime(id, response) {
  const cfg = configs[id], dir = path.join(data, cfg.dir);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.built, true);
  assert.equal(response.downloaded, true, 'must actually download into an absent checkout');
  let receipt = response;
  if (id.startsWith('qwen')) receipt = JSON.parse(fs.readFileSync(path.join(dir, '.dstudio-source.json'), 'utf8'));
  assert.equal(receipt.commit, cfg.commit);
  const binaries = id.startsWith('qwen') ? ['ds4','ds4-server','ds4-agent']
    : ['ds4','ds4-server','ds4-agent-jsonl','ds4-cowork','ds4-design'];
  const runtime = {};
  for (const bin of binaries) {
    const executable = path.join(dir, bin);
    const r = spawnSync(executable, ['--help'], { cwd: dir, env, timeout: 20000, encoding: 'utf8' });
    fs.writeFileSync(path.join(run, `${id}-${bin}-help.log`), (r.stdout || '') + (r.stderr || ''));
    assert.equal(r.error, undefined); assert.equal(r.status, 0, `${bin}: ${r.stderr}`);
    assert.match(r.stdout + r.stderr, /usage|options/i);
    runtime[bin] = { sha256: sha(executable), bytes: fs.statSync(executable).size };
  }
  assert.deepEqual(fs.readdirSync(path.join(data,'ds4/gguf')), [], 'no weights or partial downloads');
  if (id !== 'main') assert.equal(fs.realpathSync(path.join(dir,'gguf')), path.join(data,'ds4/gguf'));
  return { response, receipt, runtime };
}
try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', appSource]);
  execFileSync('/usr/bin/ditto', [appSource, app]);
  report.appSha256 = sha(path.join(app,'Contents/MacOS/DStudio'));
  report.sourceRevision = execFileSync('git', ['rev-parse','HEAD'], { encoding:'utf8' }).trim();
  report.sourceDiff = execFileSync('git', ['diff','--','src/dstudio_setup.c','src/dstudio.c'], { encoding:'utf8' });
  protectedPids = external();
  if (!protectedPids.length) {
    sentinel = spawn(process.execPath, ['-e', "require('net').createServer(s=>s.end()).listen(28000,'127.0.0.1',()=>console.log('ready'))"],
      {detached:true,stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject) => {
      sentinel.once('error',reject); sentinel.once('exit',code=>reject(Error(`sentinel exited: ${code}`)));
      sentinel.stdout.once('data',resolve);
    });
    protectedPids = external();
    assert.ok(protectedPids.includes(sentinel.pid));
  }
  report.protectedListeners = protectedPids;
  const port = await freePort(); report.base = `http://127.0.0.1:${port}`;
  const fd = fs.openSync(path.join(run,'app.log'),'wx');
  child = spawn(path.join(app,'Contents/MacOS/DStudio'), [String(port)], {
    cwd: '/', env, detached: true, stdio: ['ignore',fd,fd],
  });
  fs.closeSync(fd);
  child.on('error', e => { report.launchError = e.message; save(); });
  await step('headless first launch from relocated signed app and empty data', async () => {
    let st;
    for (let i=0;i<120;i++) {
      assert.equal(child.exitCode, null, 'bundled app must remain running');
      try { st = await json('/api/status'); break; } catch { await sleep(250); }
    }
    assert.ok(st, 'native app must open its HTTP host');
    const owner = execFileSync('lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-t'],{encoding:'utf8'}).trim();
    serverPid = Number(owner); assert.equal(serverPid, child.pid);
    report.processes = { headlessApp:child.pid };
    assert.equal(st.webdir, data); assert.equal(st.ds4dir, path.join(data,'ds4'));
    assert.equal(st.ds4dirOk, false); assert.equal(st.running, false);
    assert.deepEqual(await json('/api/store'), {rev:0,data:null}, 'first launch must not read the user chat store');
    for (const c of Object.values(configs)) assert.equal(fs.existsSync(path.join(data,c.dir)), false);
    assert.equal(fs.existsSync(path.join(app,'Contents/Resources/DStudio/ds4')), false);
    return st;
  });
  browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  // Deliberate test boundary: actual model transfers and inference are out of scope.
  await context.route('**/api/model/download', async route => {
    report.weightBoundaries.push({ url: route.request().url(), body: route.request().postDataJSON(), time: new Date().toISOString() }); save();
    await route.fulfill({ status:409, contentType:'application/json', body:JSON.stringify({ok:false,error:'Installation test: engine prepared; weight download intentionally not run.'}) });
  });
  await context.route('**/api/start', async route => {
    report.unexpectedModelLaunch = true; save(); await route.abort('blockedbyclient');
  });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => { report.pageErrors.push(e.message); save(); });
  page.on('response', async response => {
    if (response.request().method() !== 'POST') return;
    if (!/\/api\/(?:ds4\/setup|laguna\/setup|qwen\/setup|qwen35\/setup|engine\/checkout)$/.test(response.url())) return;
    try { report.requests.push({ url: response.url(), status: response.status(), body: await response.json() }); save(); } catch {}
  });
  await step('real loading page offers first-run engine installation', async () => {
    await page.goto(report.base + '/loading.html', {waitUntil:'domcontentloaded'});
    await page.locator('#onboard-dialog[open], #ds4dir-dialog[open]').first().waitFor({state:'visible',timeout:30000});
    if(await page.locator('#doctor-dialog').isVisible()) await page.locator('#doctor-close').click();
    setupSurface = await page.locator('#onboard-dialog').isVisible() ? 'onboarding' : 'engine-gate';
    const input = setupSurface === 'onboarding' ? '#onboard-ds4dir' : '#ds4dir-path-in';
    assert.equal(await page.locator(input).inputValue(), path.join(data,'ds4'));
    await page.screenshot({path:path.join(run,'01-first-launch.png'),fullPage:true});
    return { url:page.url(), noSavedBrowserState:true, setupSurface };
  });
  await step('main: onboarding Install ds4 downloads, patches and compiles', async () => {
    const response = page.waitForResponse(r => r.url().endsWith(configs.main.endpoint) && r.request().method() === 'POST', {timeout:1200000});
    const button = page.locator(setupSurface === 'onboarding' ? '#onboard-ds4dir-setup-btn' : '#ds4dir-setup');
    await button.click();
    assert.equal(await button.isDisabled(),true,'immediate busy feedback');
    await page.screenshot({path:path.join(run,'02-installing.png'),fullPage:true});
    const result = await response; assert.equal(result.status(),200,await result.text());
    const evidence = verifyRuntime('main',await result.json());
    assert.equal(evidence.response.wasRunning,false); assert.equal(evidence.response.restarted,false);
    assert.equal(evidence.response.jsonlPrepared,true); assert.equal(evidence.response.designPrepared,true);
    if (setupSurface !== 'onboarding') {
      await page.locator('#ds4dir-dialog').waitFor({state:'hidden'});
      if(await page.locator('#doctor-dialog').isVisible()) await page.locator('#doctor-close').click();
      await page.locator('#btn-settings').click();
      await page.locator('#settings-dialog').getByRole('button',{name:'Models',exact:true}).click();
    }
    await page.locator(setupSurface === 'onboarding' ? '#onboard-models select' : '#set-models select').waitFor({state:'visible'});
    await page.screenshot({path:path.join(run,'03-main-installed.png'),fullPage:true});
    return evidence;
  });
  for (const id of ['laguna','qwen','qwen35']) {
    await step(`${id}: model choice installs the matching absent engine`, async () => {
      const cfg = configs[id];
      const modelHost = page.locator(setupSurface === 'onboarding' ? '#onboard-models' : '#set-models');
      assert.equal(fs.existsSync(path.join(data,cfg.dir)),false);
      const response = page.waitForResponse(r => r.url().endsWith(cfg.endpoint) && r.request().method() === 'POST',{timeout:1200000});
      await modelHost.locator('select').selectOption(cfg.target);
      await modelHost.getByRole('button',{name:'Download',exact:true}).click();
      await page.locator('#confirm-go').click();
      const result = await response; assert.equal(result.status(),200,await result.text());
      const evidence = verifyRuntime(id,await result.json());
      await modelHost.locator('select').waitFor({state:'visible',timeout:60000});
      assert.ok(report.weightBoundaries.some(r => r.body.target === cfg.target),'actual UI must reach the weight boundary');
      const st = await json('/api/status'); assert.equal(st.ds4dir,path.join(data,cfg.dir)); assert.equal(st.running,false);
      evidence.catalog = await json('/api/engine/checkouts');
      const entry = evidence.catalog.checkouts.find(c=>c.dir===st.ds4dir);
      assert.ok(entry?.active && entry.hasServer);
      await page.screenshot({path:path.join(run,`04-${id}-installed.png`),fullPage:true});
      return evidence;
    });
  }
  await step('all engines remain discoverable after browser reload', async () => {
    await page.reload({waitUntil:'domcontentloaded'});
    await page.locator('#btn-settings').waitFor({state:'visible',timeout:30000});
    const catalog = await json('/api/engine/checkouts');
    for (const cfg of Object.values(configs)) assert.ok(catalog.checkouts.some(c=>c.dir===path.join(data,cfg.dir)&&c.hasServer));
    assert.deepEqual((await json('/api/ggufs')).ggufs,[]);
    // A startup attempt is refused at the inference boundary, never an engine-install mock.
    assert.deepEqual(report.pageErrors,[]);
    execFileSync('codesign',['--verify','--deep','--strict',app]);
    assert.equal(sha(path.join(app,'Contents/MacOS/DStudio')),report.appSha256);
    return catalog;
  });
  await step('complete main patch stack reverses and reapplies without source loss', async () => {
    const patches = ['ds4-visible-downloads/visible-partials.patch', 'ds4-media-memory/residency-lease.patch',
      'ds4-server-metrics/usage-metrics.patch', 'ds4-glm53-runtime/streaming-memory.patch',
      'ds4-glm53-m2max/native-decode.patch', 'ds4-vision-streaming/vision-map.patch'];
    const scratch = path.join(run,'patch-roundtrip'); fs.mkdirSync(scratch);
    const files = new Set();
    // Patch headers only route fixture copies; assertions execute git apply and
    // compare the resulting files, not source names/wording/regex contracts.
    for (const p of patches) for (const m of fs.readFileSync(path.join(data,'patch',p),'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]);
    const before = {};
    for (const f of files) {
      const src = path.join(data,'ds4',f), dest = path.join(scratch,f);
      fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(src,dest); before[f]=sha(src);
    }
    const applyEnv = {...env,GIT_CEILING_DIRECTORIES:run};
    for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE']) delete applyEnv[key];
    for (const p of [...patches].reverse()) execFileSync('git',['-C',scratch,'apply','--unidiff-zero','--reverse',path.join(data,'patch',p)],{env:applyEnv});
    for (const p of patches) execFileSync('git',['-C',scratch,'apply','--unidiff-zero',path.join(data,'patch',p)],{env:applyEnv});
    for (const f of files) {assert.equal(sha(path.join(scratch,f)),before[f]);assert.equal(sha(path.join(data,'ds4',f)),before[f]);}
    return {patches:patches.map(p=>({file:p,sha256:sha(path.join(data,'patch',p))})),filesChecked:files.size};
  });
  report.status='pass';
} catch(e) {
  report.status='fail'; report.error=e.stack;
  if(page) {
    await page.screenshot({path:path.join(run,'failure.png'),fullPage:true}).catch(()=>{});
    fs.writeFileSync(path.join(run,'failure.html'),await page.content().catch(()=>''));
  }
  console.error(e); process.exitCode=1;
} finally {
  await browser?.close();
  // Only the headless app and its descendants belong to this test.
  for(const pid of new Set([serverPid, child?.pid])) if(pid) {try{process.kill(-pid,'SIGTERM');}catch{}}
  await sleep(1000);
  for(const pid of new Set([serverPid, child?.pid])) if(pid) {try{process.kill(-pid,'SIGKILL');}catch{}}
  try { checkExternal(); report.externalListenerPreserved=true; } catch(e) {report.status='fail';report.cleanupError=e.message;process.exitCode=1;}
  if(sentinel && sentinel.exitCode === null && sentinel.signalCode === null) {
    const exited = new Promise(resolve=>sentinel.once('exit',resolve));
    process.kill(-sentinel.pid,'SIGTERM');
    await exited;
  }
  report.finished=new Date().toISOString();save();
  console.log(`Evidence: ${run}`);
}
