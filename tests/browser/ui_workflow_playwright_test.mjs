// Real production UI in Chromium/WebKit; every runtime, phase persistence and
// workspace reply is SIMULATED. No engine, model, tool subprocess or inference
// starts. HTTP barriers make phase acceptance/cancellation ordering explicit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { uiMockServer, jsonReply, requestBody, seedUi } from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName), 'Unknown browser');
fs.mkdirSync('tests/.artifacts/ui-workflow', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/ui-workflow/${browserName}-`);
const workspace = '/tmp/dstudio-workflow-ui-test-with-a-long-folder-name-for-public-architecture-and-session-boundary-review';
const targetUrl = 'https://review.example.test/account/public-architecture-and-session-boundary-review/captured-navigation-with-a-long-resource-identity';
const source = fs.readFileSync('web/index.html', 'utf8');
const receipt = {
  scope: 'Real browser and production UI; simulated HTTP runtime, persistence and files; no inference',
  browserName, sourceSha256: createHash('sha256').update(source).digest('hex'), cases: [],
};
const flows = { gsa: ['selection', 'preflight', 'validation', 'report'], rsa: ['inventory', 'capture', 'structure', 'review'] };
const prompt = (run, phase) => `FLOW_UI:${run.kind}:${run.id}:${phase}`;
const event = (value) => '\x1e' + JSON.stringify(value) + '\n';
const runs = new Map();
const files = new Map();
const starts = [], phases = [], sends = [], interrupts = [], fileReads = [];
let mode = 'agent', raw = '', working = false, currentTurn = null, sequence = 0;
let saveBarrier = null, startBarrier = null, rejectNextPhase = false;

function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
function relative(value) {
  return String(value || '').replace(workspace + '/', '').replace(/^\/+/, '');
}
function statePath(run) { return `${run.dir}/run_state.json`; }
function nativeState(run, status = 'working', phase = flows[run.kind][0], error = '') {
  return {
    ...(run.kind === 'rsa' ? { module: 'rsa', structurePath: `${workspace}/STRUCTURE.MD` } : {}),
    runId: run.id, status, phase, iteration: run.iteration, parentRunDir: run.parentRunDir,
    targetUrl: run.targetUrl, targetHost: new URL(run.targetUrl).host,
    profileRequested: run.profile, profileEffective: 'passive',
    startedMs: 1791000000000, updatedMs: 1791000000100,
    completedMs: status === 'complete' ? 1791000000200 : 0, error,
  };
}
function writeState(run, status, phase, error = '') {
  files.set(statePath(run), JSON.stringify(nativeState(run, status, phase, error), null, 2) + '\n');
}
function phasePayload(kind, phase) {
  const evidence = [{ id: 'E1', status: 'VERIFIED', source: 'captures/headers.txt', evidence: 'Captured headers contain the session boundary.', confidence: 'high' }];
  if (kind === 'gsa') {
    if (phase === 'selection') return { phase, targetUrl, files: [{ path: 'src/session.ts', reason: 'Account entry boundary' }], tools: ['read'], hypotheses: [{ title: 'Session cookie boundary', why: 'Verify the recorded cookie scope', tools: ['read'] }], localScripts: [], stop_if: 'Recorded evidence disproves the hypothesis' };
    if (phase === 'preflight') return { phase, hypotheses: [{ title: 'Session cookie boundary', entrypoints: ['src/session.ts:8'], evidence_needed: ['captured cookie headers'], kill_criteria: ['cookie scope is constrained'], attacker: 'unauthenticated visitor' }], validationPlan: { checks: [] } };
    if (phase === 'validation') return { phase, evidence, findings: [{ title: 'Recorded session boundary', severity: 'low', evidence: ['captures/headers.txt:1'], impact: 'Recorded account context', confidence: 'high', exploit_path: 'public capture', missing_evidence: '', attack_chain: [] }] };
    return '## Verdict: inconclusive\n\nOnly recorded public evidence was available. Server-owned report bytes.\n';
  }
  if (phase === 'inventory') return { phase, kind, targetUrl, surface: [{ url: targetUrl, type: 'page', evidence: 'Captured HTML' }], collectors: [{ id: 'html_inventory', status: 'selected', why: 'Read recorded assets' }], sections: [{ name: 'Frontend Architecture', status: 'weak', nextEvidence: 'captured script inventory' }], tools: ['read'], nextActions: ['read captures'], unknowns: ['Private backend'] };
  if (phase === 'capture') return { phase, kind, evidence, collectors: [{ id: 'html_inventory', status: 'complete', evidenceRefs: ['evidence.jsonl:E1'] }], routeGraph: { nodes: 2, edges: 1 }, claims: [], remainingUnknowns: ['Private backend'] };
  if (phase === 'structure') return { phase, kind, structurePath: `${workspace}/STRUCTURE.MD`, updatedSections: ['Frontend Architecture'], claims: [{ id: 'C1', status: 'VERIFIED', section: 'Frontend Architecture', claim: 'The capture includes one script asset.', evidenceRefs: ['evidence.jsonl:E1'] }], claimAudit: { unsupportedClaims: 0, missingEvidenceRefs: 0 }, remainingUnknowns: ['Private backend'] };
  return { phase, kind, status: 'complete', structurePath: `${workspace}/STRUCTURE.MD`, qualityGate: { pass: true, failedChecks: [] }, claimAudit: { unsupportedClaims: 0, missingEvidenceRefs: 0 }, remainingUnknowns: ['Private backend'] };
}
function finishTurn() {
  assert.ok(currentTurn, 'The test must finish an admitted runtime turn');
  const { run, phase } = currentTurn;
  const payload = phasePayload(run.kind, phase);
  raw += event({ type: 'tool_call', name: 'read', input: { path: 'captures/headers.txt' } });
  raw += event({ type: 'tool_result', name: 'read', output: 'recorded-session-boundary: present' });
  raw += typeof payload === 'string' ? payload : event({ type: 'gsa_phase', phase, payloadJson: JSON.stringify(payload) });
  working = false;
  currentTurn = null;
}

const server = await uiMockServer(async (req, res, url) => {
  if (url.pathname === '/api/status') {
    jsonReply(res, { mode, running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)',
      agentWorking: working, agentSessionWorking: false, workdir: workspace, ds4dirOk: true,
      webdirOk: true, lan: false, modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf',
      variant: 'flash', variants: { flash: true }, config: { ctx: 65536, power: 100 } });
    return true;
  }
  if (url.pathname === '/api/start') { mode = (await requestBody(req)).mode || 'agent'; jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/fs/list') { const b = await requestBody(req); jsonReply(res, { ok: true, path: b.path || workspace, entries: 1, dirs: [] }); return true; }
  if (['/api/user-skills', '/api/design-systems', '/api/updates/check'].includes(url.pathname)) {
    jsonReply(res, { ok: true, skills: [], designSystems: [], sections: [] }); return true;
  }
  if (url.pathname === '/api/gsa/tools') {
    jsonReply(res, { ok: true, gsaTools: { mode: 'tool-assisted', tools: [{ name: 'read', category: 'workspace/read', notes: 'Recorded files only.', found: true, enabled: true }] } }); return true;
  }
  const startMatch = /^\/api\/(gsa|rsa)\/start$/.exec(url.pathname);
  if (startMatch) {
    const body = await requestBody(req), kind = startMatch[1];
    starts.push({ kind, ...body });
    const run = { id: `${kind}-ui-${++sequence}`, kind, targetUrl: body.targetUrl || targetUrl,
      profile: body.profile || 'passive', iteration: sequence, parentRunDir: body.parentRunDir || '', mission: body.mission };
    run.dir = `.dstudio/${kind}/runs/${run.id}`;
    runs.set(run.id, run);
    writeState(run, 'ready', flows[kind][0]);
    files.set(`${run.dir}/target.md`, `# Target\n\n${run.targetUrl}\n`);
    if (startBarrier) await startBarrier.promise;
    jsonReply(res, { ok: true, runId: run.id, taskId: sequence, workdir: workspace,
      runDir: `${workspace}/${run.dir}`, statePath: `${workspace}/${statePath(run)}`,
      targetUrl: run.targetUrl, iteration: run.iteration, parentRunDir: run.parentRunDir,
      profileRequested: run.profile, profileEffective: 'passive', candidateCount: 1,
      prompt: prompt(run, flows[kind][0]), structurePath: kind === 'rsa' ? `${workspace}/STRUCTURE.MD` : '',
      gsaTools: { tools: [] }, rsaTools: { tools: [] } }); return true;
  }
  const phaseMatch = /^\/api\/(gsa|rsa)\/phase$/.exec(url.pathname);
  if (phaseMatch) {
    const body = await requestBody(req), run = runs.get(body.runId);
    phases.push({ kind: phaseMatch[1], ...body });
    assert.ok(run, 'Phase-save request references an admitted run');
    if (saveBarrier) await saveBarrier.promise;
    if (rejectNextPhase) {
      rejectNextPhase = false;
      writeState(run, 'incomplete', body.phase, 'Fixture rejected unsupported evidence');
      jsonReply(res, { ok: false, error: 'Fixture rejected unsupported evidence', statePath: `${workspace}/${statePath(run)}` }, 422);
      return true;
    }
    const names = flows[run.kind], at = names.indexOf(body.phase), next = names[at + 1], complete = !next;
    const name = body.phase === 'report' ? 'report.md' : `${body.phase}.json`;
    files.set(`${run.dir}/${name}`, body.output);
    if (body.phase === 'capture' || body.phase === 'validation') files.set(`${run.dir}/evidence.jsonl`, JSON.stringify({ id: 'E1', status: 'VERIFIED', source: 'captures/headers.txt', evidence: 'Server-owned evidence bytes' }) + '\n');
    if (run.kind === 'rsa' && ['structure', 'review'].includes(body.phase)) files.set('STRUCTURE.MD', '# Frontend Architecture\n\nServer-owned structure bytes.\n');
    writeState(run, complete ? 'complete' : 'working', next || body.phase);
    jsonReply(res, { ok: true, complete, taskId: phases.length, nextPrompt: next ? prompt(run, next) : '',
      statePath: `${workspace}/${statePath(run)}`, structurePath: run.kind === 'rsa' ? `${workspace}/STRUCTURE.MD` : '' }); return true;
  }
  if (url.pathname === '/api/agent/send') {
    const body = await requestBody(req), match = /FLOW_UI:(gsa|rsa):([^:\s]+):([a-z]+)/.exec(body.prompt || '');
    assert.ok(match, 'Workflow sends a native prepared prompt');
    assert.equal(working, false, 'The UI must never overlap admitted runtime turns');
    sends.push(body);
    currentTurn = { run: runs.get(match[2]), phase: match[3] };
    const from = Buffer.byteLength(raw);
    raw += `\x01USER\x02${body.displayPrompt || ''}\x01ENDUSER\x02\n`;
    working = true;
    jsonReply(res, { ok: true, from, at: Buffer.byteLength(raw) }); return true;
  }
  if (url.pathname === '/api/agent/poll') {
    const bytes = Buffer.from(raw), since = Number(url.searchParams.get('since')) || 0;
    jsonReply(res, { base: 0, len: bytes.length, text: bytes.subarray(since).toString('utf8'),
      working, sessionWorking: false, ready: true, loadPct: 100 }); return true;
  }
  if (url.pathname === '/api/agent/interrupt') {
    interrupts.push(await requestBody(req)); working = false; currentTurn = null;
    jsonReply(res, { ok: true }); return true;
  }
  if (url.pathname === '/api/agent/fs/list') {
    const body = await requestBody(req), rel = relative(body.path), prefix = rel ? rel + '/' : '';
    const entries = new Map();
    for (const [name, content] of files) {
      if (!name.startsWith(prefix)) continue;
      const tail = name.slice(prefix.length), [leaf] = tail.split('/');
      if (!leaf) continue;
      entries.set(leaf, { name: leaf, path: prefix + leaf, type: tail.includes('/') ? 'directory' : 'file', size: Buffer.byteLength(content), mtimeMs: 1791000000100 });
    }
    jsonReply(res, { ok: true, root: workspace, path: rel, entries: [...entries.values()], truncated: false }); return true;
  }
  if (url.pathname === '/api/agent/fs/read') {
    const body = await requestBody(req), rel = relative(body.path);
    fileReads.push(rel);
    if (!files.has(rel)) { jsonReply(res, { ok: false, code: 'not_found', error: 'Fixture file does not exist' }, 404); return true; }
    const content = files.get(rel);
    jsonReply(res, { ok: true, root: workspace, path: rel, content, size: Buffer.byteLength(content),
      digest: createHash('sha256').update(content).digest('hex'), mtimeMs: 1791000000100,
      utf8: true, binary: false, tooLarge: false, writable: false, symlink: false }); return true;
  }
  return false;
});

const browser = await ({ chromium, webkit })[browserName].launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.setDefaultTimeout(10000);
const now = Date.now();
const evidence = await seedUi(page, server.origin, { theme: 'light',
  settings: { workdirs: { agent: workspace }, gsaMode: 'off', rsaMode: 'off', gsaLoop: 'off' },
  chats: [{ id: 'workflow-agent', mode: 'agent', title: 'Workflow fixture', createdAt: now,
    updatedAt: now, workdir: workspace, messages: [], transcript: '' }] });
let shot = 0;
const capture = name => page.screenshot({ path: path.join(dir, `${String(shot++).padStart(2, '0')}-${name}.png`), fullPage: true });
const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 10000 });
async function step(name, fn) {
  const row = { name };
  try { await fn(row); row.status = 'PASS'; }
  catch (error) {
    row.status = 'FAIL'; row.error = error.stack; process.exitCode = 1;
    row.observed = await page.evaluate(() => ({
      status: document.querySelector('#wf-status')?.textContent,
      error: document.querySelector('#wf-error')?.textContent,
      persistedRuns: JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{"chats":[]}').chats.map(c => ({ id: c.id, workflowRuns: c.workflowRuns })),
    })).catch(() => null);
    await capture(`fail-${name.replace(/\W+/g, '-')}`).catch(() => {});
  }
  receipt.cases.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
  if (row.status === 'FAIL') throw Error(`Stopped after: ${name}`);
}
async function admitted(count) {
  const deadline = Date.now() + 10000;
  while (sends.length < count) {
    if (Date.now() >= deadline) throw Error(`Expected ${count} admitted sends, got ${sends.length}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(sends.length, count);
}
async function saved(count) {
  await until(count => document.querySelectorAll('#wf-steps [data-state="saved"]').length === count, count);
}
async function requestedPhase(count) {
  const deadline = Date.now() + 10000;
  while (phases.length < count) {
    if (Date.now() >= deadline) throw Error(`Expected native phase request ${count}, got ${phases.length}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(phases.length, count);
}
async function editSetup() {
  const edit = page.locator('#wf-edit-setup');
  if (!(await page.locator('#wf-mission').isVisible()) && await edit.isVisible()) await edit.click();
  await page.locator('#wf-mission').waitFor({ state: 'visible' });
}
async function checkLabels() {
  const observed = await page.evaluate(() => {
    const selector = document.querySelector('#wf-iterations'), style = getComputedStyle(selector);
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    ctx.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const label = selector.selectedOptions[0]?.textContent || '';
    const textWidth = ctx.measureText(label).width + (parseFloat(style.letterSpacing) || 0) * Math.max(0, label.length - 1);
    const left = parseFloat(style.paddingLeft) || 0, right = parseFloat(style.paddingRight) || 0;
    // A native dropdown reserves room for its indicator as well as its text.
    const available = selector.clientWidth - left - Math.max(right, 20);
    const metadata = [...document.querySelectorAll('.wf-metadata dt, .wf-metadata dd')].map(node => {
      const box = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter(r => r.width > 0), css = getComputedStyle(node);
      const rows = new Set(rects.map(r => Math.round(r.top * 10))).size;
      const lineHeight = parseFloat(css.lineHeight) || parseFloat(css.fontSize) * 1.5;
      const chrome = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + (parseFloat(css[key]) || 0), 0);
      return { text: node.textContent, width: box.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        height: box.height, maximumHeight: node.tagName === 'DD' ? Math.max(parseFloat(css.minHeight) || 0, rows * lineHeight + chrome) + 2 : null,
        clipped: rects.some(r => r.left < box.left - 1 || r.right > box.right + 1) };
    });
    const sizing = document.querySelector('#wf-iteration-label'), sizingStyle = sizing ? getComputedStyle(sizing) : null;
    const fonts = value => value ? { font: value.font, fontFamily: value.fontFamily, fontWeight: value.fontWeight,
      fontSize: value.fontSize, letterSpacing: value.letterSpacing } : null;
    return { label, textWidth, available, metadata, selectFont: fonts(style), sizingFont: fonts(sizingStyle),
      selectClientWidth: selector.clientWidth, sizingWidth: sizing?.getBoundingClientRect().width,
      wrapperWidth: selector.closest('.wf-iteration-picker')?.getBoundingClientRect().width };
  });
  assert.ok(observed.label.length > 0);
  assert.ok(observed.textWidth <= observed.available + 1, `Selected iteration label is clipped: ${JSON.stringify(observed)}`);
  assert.ok(observed.metadata.every(m => !m.clipped && m.scrollWidth <= m.clientWidth + 1),
    `Metadata text is clipped: ${JSON.stringify(observed.metadata)}`);
  assert.ok(observed.metadata.every(m => m.maximumHeight === null || m.height <= m.maximumHeight),
    `Metadata value retains excess blank height: ${JSON.stringify(observed.metadata)}`);
  assert.equal(await page.locator('#wf-target-meta').textContent(), targetUrl);
  assert.equal(await page.locator('#wf-workspace-meta').textContent(), path.posix.basename(workspace));
  return observed;
}
async function settleWaitingVisual(targetPage) {
  await targetPage.clock.runFor(450);
  await targetPage.locator('#wf-wait-phrase').evaluate(async node => {
    const entering = node.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().iterations));
    await Promise.allSettled(entering.map(animation => animation.finished));
  });
}

try {
  await page.clock.install({ time: new Date(now) });
  await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-agent').click();
  await page.locator('#btn-workflow').waitFor({ state: 'visible' });

  await step('the real workflow opens with empty waiting phases and restores the composer on close', async () => {
    assert.equal((await page.locator('#btn-workflow').innerText()).trim(), 'Open RSA/GSA');
    await page.locator('#cbar-gear').click();
    await page.locator('#cbar-pop').waitFor({ state: 'visible' });
    assert.doesNotMatch(await page.locator('#cbar-pop').innerText(), /Security profile|Open tools|\bGSA\b|\bRSA\b/i);
    await page.locator('#cbar-gear').click();
    await page.locator('#btn-workflow').click();
    await page.locator('#workflow-surface').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#composer-input').isVisible(), false);
    assert.equal(await page.locator('#wf-steps button').count(), 4);
    assert.equal(await page.locator('#wf-steps [data-state="waiting"]').count(), 4);
    assert.equal(await page.locator('#wf-tools').isVisible(), true);
    assert.equal(starts.length, 0);
    assert.equal(sends.length, 0);
    assert.equal(await page.locator('#wf-wait').count(), 0, 'Idle setup must not imply active work');
    assert.doesNotMatch(await page.locator('#workflow-surface').innerText(), /Simulated demo|Next event|atlas\.example/);
    await capture('gsa-empty-light');
    await page.locator('#wf-back').click();
    await page.locator('#workflow-surface').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#composer-input').isVisible(), true);
    await page.locator('#btn-workflow').click();
  });

  await step('GSA setup reaches the existing admission API and displays its effective profile', async row => {
    await page.locator('#wf-mode-gsa').click();
    await editSetup();
    await page.locator('#wf-mission').fill('Review recorded account and session boundaries.');
    await page.locator('#wf-target').fill(targetUrl);
    await page.locator('#wf-profile').selectOption('red-authorized');
    await page.locator('#wf-authorized').check();
    assert.equal(await page.locator('#wf-mission').inputValue(), 'Review recorded account and session boundaries.');
    assert.equal(await page.locator('#wf-target').inputValue(), targetUrl);
    await page.locator('#wf-loop').uncheck();
    await page.locator('#wf-play').click();
    await admitted(1);
    assert.deepEqual({ kind: starts[0].kind, workdir: starts[0].workdir, mission: starts[0].mission,
      targetUrl: starts[0].targetUrl, profile: starts[0].profile, authorized: starts[0].authorized },
    { kind: 'gsa', workdir: workspace, mission: 'Review recorded account and session boundaries.',
      targetUrl, profile: 'red-authorized', authorized: true });
    row.start = starts[0];
    await page.locator('#wf-profile-meta').filter({ hasText: /Passive/i }).waitFor();
    row.labels = await checkLabels();
    await page.setViewportSize({ width: 600, height: 900 });
    row.narrowCurrentLabels = await checkLabels();
    assert.equal(row.narrowCurrentLabels.label, row.labels.label, 'Narrow layouts retain the full selected Current iteration label');
    await capture('gsa-current-label-narrow');
    await page.setViewportSize({ width: 1360, height: 900 });
    assert.match(sends[0].prompt, /FLOW_UI:gsa:gsa-ui-1:selection/);
    assert.match(sends[0].prompt, /"value":"max"/);
    await capture('gsa-running-light');
  });

  await step('empty live Activity rotates with virtual time, stops off-view, and yields to a real tool event', async row => {
    const wait = page.locator('#wf-wait'), phrase = page.locator('#wf-wait-phrase');
    await wait.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#wf-activity').getAttribute('aria-busy'), 'true');
    assert.match(await wait.innerText(), /Waiting for Agent activity/);
    row.first = await phrase.textContent();
    await page.clock.runFor(3400);
    row.next = await phrase.textContent();
    assert.notEqual(row.next, row.first, 'Decorative waiting copy rotates without a wall-clock sleep');
    assert.equal(phases.length, 0, 'Waiting decoration cannot publish phase progress');
    assert.equal(await wait.evaluate(n => n.getAnimations({ subtree: true }).some(a => a.playState === 'running')), true);
    await wait.scrollIntoViewIfNeeded();
    await settleWaitingVisual(page);
    await capture('gsa-live-waiting-light');

    const beforeClose = await phrase.textContent();
    await page.locator('#wf-back').click();
    await page.clock.runFor(6800);
    assert.equal(await phrase.textContent(), beforeClose, 'Closing the pane stops its decorative timer');
    assert.equal(await wait.isVisible(), false);
    await page.locator('#btn-workflow').click();
    await wait.waitFor({ state: 'visible' });

    await page.locator('#wf-tab-output').click();
    await page.clock.runFor(6800);
    assert.equal(await wait.count(), 0, 'Hidden Activity does not retain a running waiting view');
    await page.locator('#wf-tab-activity').click();
    await wait.waitFor({ state: 'visible' });
    await page.locator('#wf-steps [data-phase="preflight"]').click();
    await page.clock.runFor(3400);
    assert.equal(await wait.count(), 0, 'A selected future phase must not show a working spinner');
    await page.locator('#wf-follow').click();
    await wait.waitFor({ state: 'visible' });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.runFor(34);
    const staticPhrase = await phrase.textContent();
    await page.clock.runFor(6800);
    assert.equal(await phrase.textContent(), staticPhrase, 'Reduced motion keeps the waiting phrase static');
    assert.equal(await wait.evaluate(n => n.getAnimations({ subtree: true }).some(a => a.playState === 'running')), false);
    await capture('gsa-live-waiting-reduced-motion');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    raw += event({ type: 'tool_call', name: 'read', input: { path: 'captures/live-scope.txt' } });
    await page.clock.runFor(600);
    await page.locator('#wf-activity .wf-event').filter({ hasText: 'captures/live-scope.txt' }).waitFor();
    assert.equal(await wait.count(), 0, 'The first actual tool event replaces the waiting decoration');
    assert.equal(await page.locator('#wf-activity').getAttribute('aria-busy'), 'false');
    assert.equal(phases.length, 0);
    raw += event({ type: 'tool_result', name: 'read', output: 'scoped capture received' });
  });

  await step('a pending native save stays saving and Pause holds exactly the next unsent phase', async () => {
    await page.locator('#wf-play').click();
    saveBarrier = barrier();
    finishTurn();
    await until(() => document.querySelector('#wf-steps [data-state="saving"]'));
    await requestedPhase(1);
    assert.equal(await page.locator('#wf-steps [data-state="saved"]').count(), 0);
    assert.equal(phases.length, 1);
    assert.equal(sends.length, 1);
    assert.equal(files.has(`${runs.get('gsa-ui-1').dir}/selection.json`), false);
    const pending = saveBarrier; saveBarrier = null; pending.release();
    await saved(1);
    await page.locator('#wf-play').filter({ hasText: /Resume/i }).waitFor();
    assert.equal(await page.locator('#wf-wait').count(), 0, 'A paused unsent phase has no working spinner');
    await flush();
    assert.equal(sends.length, 1, 'Pause must leave preflight unsent');
    await capture('gsa-paused-after-selection');
  });

  await step('Next phase admits one turn and remains paused after its accepted save', async () => {
    await page.locator('#wf-next').click();
    await admitted(2);
    assert.match(sends[1].prompt, /:preflight/);
    finishTurn();
    await saved(2);
    await page.locator('#wf-play').filter({ hasText: /Resume/i }).waitFor();
    await flush();
    assert.equal(sends.length, 2, 'Step must leave validation unsent');
  });

  await step('Resume continues queued work without replay and completes all four native phase saves', async () => {
    await page.locator('#wf-play').click();
    await admitted(3);
    assert.match(sends[2].prompt, /:validation/);
    finishTurn();
    await admitted(4);
    assert.match(sends[3].prompt, /:report/);
    finishTurn();
    await saved(4);
    assert.equal(phases.map(p => p.phase).join(','), 'selection,preflight,validation,report');
    assert.equal(starts.length, 1);
    assert.equal(sends.length, 4);
    assert.equal(new Set(phases.map(p => `${p.runId}:${p.phase}`)).size, 4);
    await capture('gsa-complete-light');
  });

  await step('artifact preview shows actual host bytes and not the phase view text', async () => {
    const report = `${runs.get('gsa-ui-1').dir}/report.md`;
    await page.locator(`#wf-artifacts button[data-path="${report}"]`).click();
    await until(content => document.querySelector('#wf-preview-text')?.textContent === content, files.get(report));
    await page.locator('#wf-preview-text').waitFor({ state: 'visible' });
    await page.locator('#wf-preview-text').scrollIntoViewIfNeeded();
    assert.ok(fileReads.includes(report), 'Artifact selection must read through the host endpoint');
    assert.equal(await page.locator('#wf-preview-text').textContent(), files.get(report));
    await capture('gsa-report-preview');
  });

  await step('RSA uses its own admission and phases, and Stop ignores a late accepted save', async () => {
    await page.locator('#wf-mode-rsa').click();
    await editSetup();
    await page.locator('#wf-mission').fill('Map the captured public frontend into STRUCTURE.MD.');
    await page.locator('#wf-target').fill(targetUrl);
    await page.locator('#wf-play').click();
    await admitted(5);
    assert.equal(starts[1].kind, 'rsa');
    assert.equal(starts[1].targetUrl, targetUrl);
    assert.match(sends[4].prompt, /FLOW_UI:rsa:rsa-ui-2:inventory/);
    saveBarrier = barrier();
    const expectedPhase = phases.length + 1;
    finishTurn();
    await until(() => document.querySelector('#wf-steps [data-state="saving"]'));
    await requestedPhase(expectedPhase);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/rsa/phase')
      .then(value => ({ value }), error => ({ error }));
    await page.locator('#wf-stop').click();
    await until(() => document.querySelector('#wf-status[data-state="stopped"]'));
    assert.equal(await page.locator('#wf-wait').count(), 0, 'Stopped persistence does not show active work');
    assert.equal(await page.locator('#wf-play').isEnabled(), false, 'New analysis waits until the native phase-save owner settles');
    assert.equal(starts.length, 2);
    const pending = saveBarrier; saveBarrier = null; pending.release();
    const reply = await response; assert.ok(reply.value, reply.error?.message);
    await saved(1);
    await until(() => !document.querySelector('#wf-play').disabled);
    await flush();
    assert.equal(sends.length, 5, 'A cancelled save response must not send Capture');
    assert.equal(interrupts.length, 0, 'A finished runtime turn does not require an interrupt during phase persistence');
    assert.match(await page.locator('#workflow-surface').innerText(), /Stopped/i);
    assert.ok(files.has(`${runs.get('rsa-ui-2').dir}/inventory.json`), 'Stop preserves an effect already committed by the host');
    await capture('rsa-stopped-late-save');
  });

  await step('reloading reads persisted run state without resending any phase', async () => {
    const sendCount = sends.length, startCount = starts.length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#tab-agent').click();
    await page.locator('#btn-workflow').click();
    await page.locator('#workflow-surface').waitFor({ state: 'visible' });
    await page.locator('#wf-mode-rsa').click();
    await page.locator('#wf-artifacts button').first().waitFor();
    await flush();
    assert.equal(sends.length, sendCount, 'Reload must not replay a tool/model phase');
    assert.equal(starts.length, startCount, 'Reload must not admit a new run');
    assert.ok(fileReads.includes(statePath(runs.get('rsa-ui-2'))), 'Reload validates the persisted native state file');
  });

  await step('a native rejection reports an incomplete run and cannot create a saved phase', async () => {
    await page.locator('#wf-mode-gsa').click();
    await editSetup();
    await page.locator('#wf-mission').fill('Check the evidence rejection path.');
    rejectNextPhase = true;
    await page.locator('#wf-play').click();
    await admitted(6);
    finishTurn();
    await page.locator('#wf-error').filter({ hasText: 'Fixture rejected unsupported evidence' }).waitFor();
    await flush();
    assert.equal(sends.length, 6);
    assert.equal(await page.locator('#wf-steps [data-state="saved"]').count(), 0);
    assert.ok(await page.locator('#wf-steps [data-state="incomplete"]').count() >= 1);
    assert.equal(files.has(`${runs.get('gsa-ui-3').dir}/selection.json`), false);
    await capture('gsa-rejected');
  });

  await step('workflow controls and phase cards remain usable at a narrow width', async row => {
    await page.setViewportSize({ width: 600, height: 900 });
    const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workflow: document.querySelector('#workflow-surface').scrollWidth - document.querySelector('#workflow-surface').clientWidth }));
    row.overflow = overflow;
    assert.ok(overflow.page <= 1 && overflow.workflow <= 1, `Horizontal overflow: ${JSON.stringify(overflow)}`);
    await page.locator('#wf-mode-rsa').click();
    await page.locator('#wf-artifacts button').first().waitFor();
    row.labels = await checkLabels();
    await page.locator('#wf-steps button').last().click();
    assert.equal(await page.locator('#wf-steps button').last().getAttribute('aria-pressed'), 'true');
    await capture('rsa-narrow-light');
  });

  await step('Stop during admission discards the late prepared prompt without sending it', async () => {
    await page.locator('#wf-mode-gsa').click();
    await editSetup();
    await page.locator('#wf-mission').fill('Check cancellation during native preparation.');
    startBarrier = barrier();
    await page.locator('#wf-play').click();
    const deadline = Date.now() + 10000;
    while (starts.length < 4) {
      if (Date.now() >= deadline) throw Error('The native preparation request did not arrive');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(sends.length, 6);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/gsa/start')
      .then(value => ({ value }), error => ({ error }));
    await page.locator('#wf-stop').click();
    const pending = startBarrier; startBarrier = null; pending.release();
    const reply = await response; assert.ok(reply.value, reply.error?.message);
    await flush();
    assert.equal(sends.length, 6, 'A cancelled preparation must never dispatch the prepared prompt');
    assert.match(await page.locator('#workflow-surface').innerText(), /Stopped|cancelled|incomplete/i);
    await capture('gsa-cancelled-preparation');
  });

  await step('Stop interrupts an active RSA runtime turn and preserves prior saved runs', async () => {
    await page.locator('#wf-mode-rsa').click();
    await editSetup();
    await page.locator('#wf-mission').fill('Check stopping an active runtime turn.');
    await page.locator('#wf-play').click();
    await admitted(7);
    assert.match(sends[6].prompt, /FLOW_UI:rsa:rsa-ui-5:inventory/);
    assert.equal(working, true);
    await page.locator('#wf-wait').waitFor({ state: 'visible' });
    await page.locator('#wf-stop').click();
    await until(() => document.querySelector('#wf-status[data-state="stopped"]'));
    assert.equal(interrupts.length, 1);
    assert.equal(working, false);
    assert.equal(await page.locator('#wf-wait').count(), 0, 'An interrupted turn has no working spinner');
    assert.equal(sends.length, 7);
    assert.ok(files.has(`${runs.get('gsa-ui-1').dir}/report.md`));
    assert.ok(files.has(`${runs.get('rsa-ui-2').dir}/inventory.json`));
    assert.ok(await page.locator('#wf-steps [data-state="incomplete"]').count() >= 1);
    await capture('rsa-interrupted-active-turn');
  });

  await step('missing native state stays honest and Refresh retries without dispatching work', async () => {
    await page.locator('#wf-mode-gsa').click();
    const run = runs.get('gsa-ui-1'), filename = statePath(run), content = files.get(filename);
    files.delete(filename);
    await page.locator('#wf-iterations').selectOption(run.id);
    await page.locator('#wf-error').filter({ hasText: 'Fixture file does not exist' }).waitFor();
    assert.equal(await page.locator('#wf-play').isEnabled(), true);
    assert.equal(await page.locator('#wf-status').getAttribute('data-state'), 'unavailable');
    files.set(filename, content);
    const sendCount = sends.length, startCount = starts.length;
    await page.locator('#wf-refresh').click();
    await saved(4);
    assert.equal(sends.length, sendCount);
    assert.equal(starts.length, startCount);
    assert.equal(await page.locator('#wf-error').isVisible(), false);
    await capture('native-state-retry');
  });

  await step('nullable and scalar optional artifact rows do not break findings or evidence controls', async () => {
    const run = runs.get('gsa-ui-1'), filename = `${run.dir}/validation.json`;
    const original = files.get(filename), parsed = JSON.parse(original);
    files.set(filename, JSON.stringify({ ...parsed, evidence: [null, 7, 'legacy row', ...parsed.evidence], findings: [null, false, 9, ...parsed.findings] }));
    await page.locator('#wf-refresh').click();
    await page.locator('#wf-steps [data-phase="validation"]').click();
    await page.locator('#wf-tab-findings').click();
    await page.locator('#wf-findings').filter({ hasText: 'Recorded session boundary' }).waitFor();
    await page.locator('#wf-evidence').filter({ hasText: 'Captured headers contain the session boundary.' }).waitFor();
    assert.deepEqual(evidence.errors, []);
    files.set(filename, original);
    await capture('nullable-artifact-rows');
  });

  await step('a new GSA turn without structured output cannot resave an older run phase event', async () => {
    await editSetup();
    await page.locator('#wf-mission').fill('Verify old phase events cannot be reused.');
    await page.locator('#wf-play').click();
    await admitted(8);
    assert.match(sends[7].prompt, /FLOW_UI:gsa:gsa-ui-6:selection/);
    const phaseCount = phases.length;
    raw += 'No structured output was supplied for this new run.\n';
    working = false; currentTurn = null;
    await until(() => document.querySelector('#agent-view')?.textContent.includes('No structured output was supplied for this new run.'));
    await flush();
    assert.equal(phases.length, phaseCount, 'Older run events must not be saved for the current run');
    await page.locator('#wf-stop').click();
    await until(() => document.querySelector('#wf-status[data-state="stopped"]'));
    assert.equal(phases.length, phaseCount);
    assert.equal(sends.length, 8);
    assert.equal(files.has(`${runs.get('gsa-ui-6').dir}/selection.json`), false);
  });

  await step('Pause holds the completed Loop until Resume, then Follow keeps Stop on the next iteration', async () => {
    await editSetup();
    await page.locator('#wf-mission').fill('Review another recorded path after each saved report.');
    await page.locator('#wf-loop').check();
    await page.locator('#wf-play').click();
    await admitted(9);
    for (let count = 10; count <= 12; count++) { finishTurn(); await admitted(count); }
    assert.match(sends[11].prompt, /FLOW_UI:gsa:gsa-ui-7:report/);
    await page.locator('#wf-play').click();
    saveBarrier = barrier();
    const expectedPhase = phases.length + 1;
    finishTurn();
    await until(() => document.querySelector('#wf-steps [data-state="saving"]'));
    await requestedPhase(expectedPhase);
    assert.equal(sends.length, 12);
    assert.equal(starts.length, 7);
    const pending = saveBarrier; saveBarrier = null; pending.release();
    await saved(4);
    await page.locator('#wf-play').filter({ hasText: 'Resume loop' }).waitFor();
    await flush();
    assert.equal(sends.length, 12, 'Pause on the final report must not dispatch a loop iteration');
    assert.equal(starts.length, 7);
    assert.equal(await page.locator('#wf-stop').isEnabled(), true, 'The waiting loop remains cancellable');
    await capture('gsa-loop-paused-final-report');
    await page.locator('#wf-play').click();
    await admitted(13);
    assert.match(sends[12].prompt, /FLOW_UI:gsa:gsa-ui-8:selection/);
    await until(() => document.querySelector('#wf-iterations')?.value === 'gsa-ui-8');
    assert.equal(await page.locator('#wf-stop').isEnabled(), true);
    assert.equal(starts.at(-1).parentRunDir, `${workspace}/${runs.get('gsa-ui-7').dir}`);
    assert.ok(files.has(`${runs.get('gsa-ui-7').dir}/report.md`));
    await page.locator('#wf-iterations').selectOption('gsa-ui-1');
    await page.locator('#wf-follow').click();
    await until(() => document.querySelector('#wf-iterations')?.value === 'gsa-ui-8');
    assert.equal(await page.locator('#wf-stop').isEnabled(), true);
    await page.locator('#wf-stop').click();
    await until(() => document.querySelector('#wf-status[data-state="stopped"]'));
    assert.equal(interrupts.length, 2);
    assert.equal(await page.locator('#wf-loop').isChecked(), false);
    assert.equal(sends.length, 13);
    await capture('gsa-loop-follow-stopped');
  });

  await step('dark setup stays editable and a real admitted empty phase shows its waiting indicator', async row => {
    const darkPage = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    darkPage.setDefaultTimeout(10000);
    const darkEvidence = await seedUi(darkPage, server.origin, { theme: 'dark',
      settings: { workdirs: { agent: workspace }, gsaMode: 'off', rsaMode: 'off', gsaLoop: 'off' },
      chats: [{ id: 'workflow-dark', mode: 'agent', title: 'Dark workflow fixture', createdAt: now,
        updatedAt: now, workdir: workspace, messages: [], transcript: '' }] });
    try {
      await darkPage.clock.install({ time: new Date(now) });
      await darkPage.goto(server.origin, { waitUntil: 'domcontentloaded' });
      await darkPage.locator('#tab-agent').click();
      await darkPage.locator('#btn-workflow').click();
      await darkPage.locator('#workflow-surface').waitFor({ state: 'visible' });
      await darkPage.locator('#wf-mode-rsa').click();
      if (!(await darkPage.locator('#wf-mission').isVisible())) await darkPage.locator('#wf-edit-setup').click();
      await darkPage.locator('#wf-mission').fill('Map the public architecture from recorded captures.');
      await darkPage.locator('#wf-target').fill(targetUrl);
      assert.equal(await darkPage.locator('#wf-mission').inputValue(), 'Map the public architecture from recorded captures.');
      assert.equal(await darkPage.locator('#wf-target').inputValue(), targetUrl);
      await darkPage.screenshot({ path: path.join(dir, `${String(shot++).padStart(2, '0')}-rsa-dark-setup.png`), fullPage: true });
      await darkPage.locator('#wf-play').click();
      await admitted(14);
      await darkPage.locator('#wf-wait').waitFor({ state: 'visible' });
      await darkPage.locator('#wf-wait').scrollIntoViewIfNeeded();
      await settleWaitingVisual(darkPage);
      await darkPage.screenshot({ path: path.join(dir, `${String(shot++).padStart(2, '0')}-rsa-dark-waiting.png`), fullPage: true });
      await darkPage.locator('#wf-steps button').last().click();
      assert.equal(await darkPage.locator('#wf-steps button').last().getAttribute('aria-pressed'), 'true');
      assert.equal(await darkPage.locator('#wf-wait').count(), 0);
      row.overflow = await darkPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(row.overflow <= 1);
      await darkPage.screenshot({ path: path.join(dir, `${String(shot++).padStart(2, '0')}-rsa-dark.png`), fullPage: true });
      await darkPage.locator('#wf-stop').click();
      await darkPage.waitForFunction(() => document.querySelector('#wf-status[data-state="stopped"]'));
      assert.equal(await darkPage.locator('#wf-wait').count(), 0);
      assert.deepEqual(darkEvidence.errors, []);
      assert.deepEqual(darkEvidence.external, []);
    } finally { await darkPage.close(); }
  });

  assert.deepEqual(evidence.errors, [], 'No browser errors');
  assert.deepEqual(evidence.external, [], 'No external requests');
  assert.deepEqual(server.missing, [], 'Every API request has an explicit simulated fixture');
} finally {
  saveBarrier?.release(); startBarrier?.release();
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ ...receipt, starts, phases,
    sends, interrupts, fileReads, requests: server.requests, unmocked: server.missing,
    browserErrors: evidence.errors, externalRequests: evidence.external,
    persistence: server.storeSnapshot() }, null, 2));
  await browser.close(); server.close();
}
console.log(`ui_workflow (${browserName}, simulated HTTP, no inference): ${receipt.cases.filter(c => c.status === 'PASS').length}/${receipt.cases.length}; receipts: ${dir}`);
