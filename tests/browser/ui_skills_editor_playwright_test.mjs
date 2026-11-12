// Skills editor (Agent) in a real browser against the REAL native host's
// /api/user-skills handlers (tests/.build/dstudio-server-test, test mode, a
// task-owned HOME), so the saved pack is the file the Agent runtime reads
// (DS4UI_USER_SKILLS_DIR = $HOME/.local/share/flashcards/ds4-skills). The Agent
// session around it is SIMULATED by the UI fixture server: no runtime or model
// runs, and the "later turn" is the prompt the page sends to /api/agent/send.
//   node tests/browser/ui_skills_editor_playwright_test.mjs [dstudio-server-test]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, webkit } from 'playwright';
import { uiMockServer, jsonReply, requestBody, seedUi } from '../support/ui_mock_server.mjs';
import { artifactRunDir, freePort, sleep, writeArtifact } from '../support/real_harness.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const binary = path.resolve(process.argv[2] || 'tests/.build/dstudio-server-test');
assert.ok(fs.existsSync(binary), `${binary} is required (make tests/.build/dstudio-server-test); missing is not a pass`);
const run = artifactRunDir(`ui-skills-editor-${browserName}`);
const home = path.join(run, 'home'), workspace = path.join(run, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(path.join(run, 'ds4'));
const skillsDir = path.join(home, '.local/share/flashcards/ds4-skills');
const receipt = { scope: 'Real browser and real host skill files; simulated Agent session; no model', browserName, cases: [] };

const port = await freePort(), hostBase = `http://127.0.0.1:${port}`;
const log = fs.openSync(path.join(run, 'host.log'), 'w');
const host = spawn(binary, [String(port), path.join(run, 'ds4')], { stdio: ['ignore', log, log],
  env: { ...process.env, HOME: home, DS4UI_DATA_DIR: path.join(run, 'data'), DS4UI_TEST_MODE: '1', DS4UI_NO_WINDOW: '1', DS4UI_HOST: '127.0.0.1' } });
fs.closeSync(log);
const hostExited = once(host, 'exit');
for (let i = 0; ; i++) {
  try { if ((await fetch(hostBase + '/api/status')).ok) break; } catch {}
  assert.ok(i < 100 && host.exitCode === null, 'native host did not start');
  await sleep(50);
}

let mode = 'server';
const starts = [], sends = [], saves = [];
const server = await uiMockServer(async (req, res, url) => {
  if (url.pathname.startsWith('/api/user-skills')) {
    const body = req.method === 'POST' ? Buffer.concat(await (async () => { const c = []; for await (const x of req) c.push(x); return c; })()) : undefined;
    const headers = { 'Content-Type': 'application/json' };
    if (req.headers['x-requested-with']) headers['X-Requested-With'] = req.headers['x-requested-with'];
    const r = await fetch(hostBase + url.pathname + url.search, { method: req.method, headers, body });
    const text = await r.text();
    if (req.method === 'POST') saves.push({ path: url.pathname, status: r.status, reply: text });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(text);
    return true;
  }
  if (url.pathname === '/api/status') {
    jsonReply(res, { mode, running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)', agentWorking: false,
      agentSessionWorking: false, workdir: workspace, ds4dirOk: true, webdirOk: true, lan: false,
      modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf', config: { ctx: 65536, power: 100 }, variant: 'flash', variants: { flash: true } });
    return true;
  }
  if (url.pathname === '/api/start') { const b = await requestBody(req); starts.push(b); mode = b.mode || 'server'; jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/agent/send') {
    const b = await requestBody(req); sends.push(b);
    jsonReply(res, { ok: true, from: 0, at: 0 });
    return true;
  }
  if (url.pathname === '/api/agent/poll') { jsonReply(res, { base: 0, len: 0, text: '', working: false, sessionWorking: false, ready: true, loadPct: 100 }); return true; }
  if (url.pathname === '/api/fs/list') { jsonReply(res, { ok: true, path: workspace, entries: 0, dirs: [] }); return true; }
  if (url.pathname === '/api/design-systems') { jsonReply(res, { ok: true, designSystems: [] }); return true; }
  if (url.pathname === '/api/updates/check') { jsonReply(res, { ok: true, sections: [] }); return true; }
  if (url.pathname === '/api/task-graphs') { jsonReply(res, { ok: true, graphs: [] }); return true; }
  return false;
});

const now = Date.now();
const browser = await ({ chromium, webkit })[browserName].launch();
let context, page, evidence;
// The app window in a fresh browser profile, switched to Agent.
async function openApp() {
  context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  evidence = await seedUi(page, server.origin, { settings: { workdirs: { agent: workspace } },
    chats: [{ id: 'skills-agent', mode: 'agent', title: 'Skills fixture', createdAt: now, updatedAt: now, messages: [], transcript: '', workdir: workspace }] });
  await page.goto(server.origin);
  if (mode !== 'agent') {
    await page.locator('#tab-agent').click();
    const workdirDialog = page.locator('#workdir-dialog');
    await workdirDialog.waitFor();
    await workdirDialog.getByRole('button', { name: /^(Start|Launch)/ }).click();
  } // else the (simulated) host already runs Agent and the page opens on it
  await page.waitForFunction(() => !document.querySelector('#agent-view')?.hidden);
}
async function step(name, fn) {
  const row = { name };
  try { await fn(row); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = error.stack; process.exitCode = 1;
    await page.screenshot({ path: path.join(run, `fail-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {}); }
  receipt.cases.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
  if (row.status === 'FAIL') throw Error(`stopped after: ${name}`);
}
async function openSkillPicker() {
  await page.locator('#cbar-gear').click();
  await page.locator('.skill-open').click();
  await page.locator('#skills-dialog').waitFor({ state: 'visible' });
}
async function sendTurn(text) {
  const before = sends.length;
  await page.locator('#composer-input').fill(text);
  await page.locator('#btn-send').click();
  for (let i = 0; sends.length === before; i++) { assert.ok(i < 100, `no send for ${text}`); await sleep(50); }
  return sends.at(-1);
}

// Markdown with what a JSON body and a frontmatter file must keep exactly.
const body = [
  '# When to use', 'Review a diff before it is merged.', '', '# How to work',
  '- Quote the "exact" line, keep C:\\paths\\ and `code` as written.', '\tIndented with a tab; è, 世界 and 🦊 stay.', '',
  '---', '', '# Checklist', '- [ ] Tests run', '- [ ] No secrets',
].join('\n');
const packFile = (id) => path.join(skillsDir, id, 'SKILL.md');

try {
  await openApp();

  await step('a new skill written in the editor is saved as a Markdown pack on this machine', async () => {
    await openSkillPicker();
    await page.locator('#skills-picker-manage').click();
    await page.locator('#skills-editor').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#skills-editor-title').textContent(), 'New skill');
    await page.locator('#skill-name').fill('House review');
    assert.equal(await page.locator('#skill-id').inputValue(), 'house-review', 'the id follows the name');
    await page.locator('#skill-desc').fill('Review diffs the house way.');
    await page.locator('#skill-body').fill(body);
    await page.locator('#skill-save').click();
    await page.locator('#skills-dialog').waitFor({ state: 'hidden' });
    assert.equal(fs.readFileSync(packFile('house-review'), 'utf8'),
      `---\nname: House review\ndescription: Review diffs the house way.\nmodes: [agent]\n---\n\n${body}\n`);
    await page.getByText('Skill set: house-review').waitFor();
  });

  await step('the next Agent turn uses the saved skill without restarting the runtime', async () => {
    const startsBefore = starts.length;
    const sent = await sendTurn('Review the open diff.');
    assert.equal(sent.displayPrompt, 'Review the open diff.');
    assert.match(sent.prompt, /\[DStudio selected skill: house-review\][\s\S]*call skill\("house-review"\)[\s\S]*Review the open diff\.$/);
    assert.equal(starts.length, startsBefore, 'no restart');
    const listed = await (await fetch(hostBase + '/api/user-skills')).json();
    assert.deepEqual(listed.skills, [{ id: 'house-review', name: 'House review', description: 'Review diffs the house way.' }]);
  });

  await step('editing the skill loads the saved text and rewrites the same pack', async () => {
    await openSkillPicker();
    await page.locator('.skills-cat', { hasText: 'Your skills' }).click();
    await page.locator('.skill-card', { hasText: 'House review' }).locator('.skill-card__edit').click();
    await page.locator('#skills-editor').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#skills-editor-title').textContent(), 'Edit skill');
    assert.equal(await page.locator('#skill-id').isDisabled(), true, 'the id the agent calls cannot change');
    await page.waitForFunction((b) => document.querySelector('#skill-body').value === b, body);
    assert.equal(await page.locator('#skill-desc').inputValue(), 'Review diffs the house way.');
    const edited = body + '\n- [ ] Changelog updated';
    await page.locator('#skill-body').fill(edited);
    await page.locator('#skill-desc').fill('Review diffs and the changelog.');
    await page.locator('#skill-save').click();
    await page.locator('#skills-dialog').waitFor({ state: 'hidden' });
    assert.equal(fs.readFileSync(packFile('house-review'), 'utf8'),
      `---\nname: House review\ndescription: Review diffs and the changelog.\nmodes: [agent]\n---\n\n${edited}\n`);
    assert.deepEqual(fs.readdirSync(skillsDir), ['house-review'], 'an edit does not create a second pack');
    // Opening and saving again without a change keeps the file byte for byte.
    const saved = fs.readFileSync(packFile('house-review'));
    await openSkillPicker();
    await page.locator('.skills-cat', { hasText: 'Your skills' }).click();
    await page.locator('.skill-card', { hasText: 'House review' }).locator('.skill-card__edit').click();
    await page.waitForFunction((b) => document.querySelector('#skill-body').value === b, edited);
    await page.locator('#skill-save').click();
    await page.locator('#skills-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(fs.readFileSync(packFile('house-review')), saved);
  });

  await step('a skill too long to store is refused in the editor instead of being cut short', async (row) => {
    await openSkillPicker();
    await page.locator('#skills-picker-manage').click();
    await page.locator('#skill-name').fill('Long recipe');
    const long = '# Recipe\n' + 'Every step of the long recipe stays.\n'.repeat(1200); // about 43 KiB
    await page.locator('#skill-body').fill(long);
    await page.locator('#skill-save').click();
    const warn = page.locator('#skill-warn');
    await warn.waitFor({ state: 'visible' });
    row.warning = await warn.innerText();
    assert.match(row.warning, /too long/i);
    assert.equal(await page.locator('#skill-body').inputValue(), long, 'the text stays in the editor');
    assert.ok(!fs.existsSync(path.join(skillsDir, 'long-recipe')), 'nothing truncated was written');
    await page.locator('#skill-cancel').click();
  });

  await step('in a new app window with an empty browser profile the saved skill is listed from the machine', async () => {
    assert.deepEqual(evidence.errors, [], `page errors: ${evidence.errors.join('\n')}`);
    await context.close();
    await openApp();
    await openSkillPicker();
    await page.locator('.skills-cat', { hasText: 'Your skills' }).click();
    await page.locator('.skill-card', { hasText: 'House review' }).waitFor();
    assert.match(await page.locator('.skill-card', { hasText: 'House review' }).innerText(), /Review diffs and the changelog\./);
    assert.deepEqual(evidence.errors, [], `page errors: ${evidence.errors.join('\n')}`);
    assert.deepEqual(server.missing, [], `unmocked requests: ${server.missing.join(', ')}`);
  });
} finally {
  receipt.saves = saves;
  writeArtifact(run, 'results.json', receipt);
  await browser.close().catch(() => {});
  server.close();
  if (host.exitCode === null) { host.kill('SIGTERM'); await hostExited; }
  console.log(`Skills editor evidence: ${run}`);
}
