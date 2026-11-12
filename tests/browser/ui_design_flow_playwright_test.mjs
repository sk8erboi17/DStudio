// Design mode after the brief, in a real browser against the REAL host project
// handlers (tests/support/agent_workspace_host.c in "design" mode:
// /api/design/files, /api/design/file and /api/design/preview/) on a
// task-owned project folder. The Design runtime stream is SIMULATED with the
// events ds4-design emits for question(), propose() and write (the shapes are
// those tests/integration/design_turn_gates_test.mjs receives from the real
// runtime), and the test performs the writes' file effects. No model runs.
//   1. the designer's questions appear above the composer; answering sends the
//      §QUESTION_ANSWER turn and the work continues; a reload does not ask again;
//   2. proposed directions are compared side by side and full size, and one is
//      picked;
//   3. the canvas exports every project file as a zip that an independent
//      reader (Python's zipfile) verifies byte for byte; a file the host cannot
//      serve stops the export instead of being archived as an error text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, webkit, firefox } from 'playwright';
import { uiMockServer, jsonReply, requestBody, seedUi } from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit', 'firefox'].includes(browserName));
const hostBinary = path.resolve(process.argv[2] || 'tests/.build/agent_workspace_host');
fs.mkdirSync('tests/.artifacts/ui-design-flow', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/ui-design-flow/${browserName}-`);
const project = path.resolve(dir, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'brief.md'), '# Thursday reading club\n');
const receipt = { scope: 'Real browser, real host project handlers; Design stream and file effects simulated; no inference', browserName, cases: [] };

const host = spawn(hostBinary, [project, 'design'], { stdio: ['pipe', 'pipe', 'pipe'] });
let hostOut = '', hostLog = '';
const hostLines = [];
host.stdout.on('data', (d) => {
  hostOut += d;
  const lines = hostOut.split('\n'); hostOut = lines.pop();
  for (const l of lines) { hostLines.push(l); hostLog += l + '\n'; }
});
host.stderr.on('data', (d) => { hostLog += d; });
const waitLine = async (pred, what) => {
  const deadline = Date.now() + 10000;
  for (;;) {
    const i = hostLines.findIndex(pred);
    if (i >= 0) return hostLines.splice(i, 1)[0];
    if (Date.now() > deadline || host.exitCode != null) throw Error(`host did not report ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const hostPort = Number((await waitLine((l) => l.startsWith('PORT '), 'its port')).slice(5));
async function hostWorking(on) {
  host.stdin.write(`working ${on ? 1 : 0}\n`);
  await waitLine((l) => l === 'ok', 'the working acknowledgement');
}

const ev = (o) => '\x1e' + JSON.stringify(o) + '\n';
let raw = '', working = false, mode = 'server';
const sends = [], requests = [];
const server = await uiMockServer(async (req, res, url) => {
  // Real host handlers: the project listing, its files and the preview route.
  if (req.method === 'GET' && (url.pathname === '/api/design/files' || url.pathname === '/api/design/file' ||
      url.pathname.startsWith('/api/design/preview/') || url.pathname === '/api/design/annotator.js')) {
    const r = await fetch(`http://127.0.0.1:${hostPort}${url.pathname}${url.search}`);
    const body = Buffer.from(await r.arrayBuffer());
    requests.push({ path: url.pathname, query: url.search, status: r.status, bytes: body.length,
      names: url.pathname === '/api/design/files' ? JSON.parse(body).files.map((f) => f.name) : undefined });
    res.writeHead(r.status, Object.fromEntries(['content-type', 'content-security-policy', 'x-content-type-options', 'cache-control']
      .map((name) => [name, r.headers.get(name)]).filter(([, value]) => value !== null)));
    res.end(body);
    return true;
  }
  if (url.pathname === '/api/status') {
    jsonReply(res, { mode, running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)',
      agentWorking: working, agentSessionWorking: false, nativeVisionActive: true, workdir: project,
      ds4dirOk: true, webdirOk: true, lan: false, modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf',
      config: { ctx: 65536, power: 100 }, variant: 'flash', variants: { flash: true } });
    return true;
  }
  if (url.pathname === '/api/start') { const b = await requestBody(req); mode = b.mode || 'server'; jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/fs/list') { const b = await requestBody(req); jsonReply(res, { ok: true, path: b.path || project, entries: fs.readdirSync(project).length, dirs: [] }); return true; }
  if (url.pathname === '/api/user-skills') { jsonReply(res, { ok: true, skills: [] }); return true; }
  if (url.pathname === '/api/design-systems') { jsonReply(res, { ok: true, designSystems: [], catalogIds: [] }); return true; }
  if (url.pathname === '/api/design/state') { jsonReply(res, { ok: true, state: { seq: 1, phase: 'idle' } }); return true; }
  if (url.pathname === '/api/design/events') { jsonReply(res, { ok: true, events: [] }); return true; }
  if (url.pathname === '/api/design/artifacts') { jsonReply(res, { ok: true, artifacts: [] }); return true; }
  if (url.pathname === '/api/design/session') { await requestBody(req); jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/updates/check') { jsonReply(res, { ok: true, sections: [] }); return true; }
  if (url.pathname === '/api/agent/poll') {
    const bytes = Buffer.from(raw), since = Number(url.searchParams.get('since')) || 0;
    jsonReply(res, { base: 0, len: bytes.length, text: bytes.subarray(since).toString('utf8'), working,
      sessionWorking: false, ready: true, loadPct: 100 });
    return true;
  }
  if (url.pathname === '/api/agent/interrupt') { working = false; jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/agent/send') {
    const b = await requestBody(req);
    sends.push(b);
    // As the host replies (api_agent_send): "from" is where this turn's echo
    // starts in the transcript buffer, "at" where it ends.
    const from = Buffer.byteLength(raw);
    raw += `\x01USER\x02${b.displayPrompt}\x01ENDUSER\x02\n`;
    working = true;
    jsonReply(res, { ok: true, from, at: Buffer.byteLength(raw) });
    return true;
  }
  return false;
});

const now = Date.now();
const seed = { theme: 'dark', settings: { workdirs: { design: project } },
  chats: [{ id: 'design-flow', mode: 'design', title: 'New design', createdAt: now, updatedAt: now, messages: [], transcript: '', workdir: project }] };
const browser = await ({ chromium, webkit, firefox })[browserName].launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(8000);
const evidence = await seedUi(page, server.origin, seed);
let shot = 0;
const capture = (name) => page.screenshot({ path: path.join(dir, `${String(shot++).padStart(2, '0')}-${name}.png`) });
const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 });
async function step(name, fn) {
  const row = { name };
  try { await fn(row); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = error.stack; process.exitCode = 1; await capture(`fail-${name.replace(/\W+/g, '-')}`).catch(() => {}); }
  receipt.cases.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
  if (row.status === 'FAIL') throw Error(`stopped after: ${name}`);
}
const arrived = async (n, what) => {
  for (const deadline = Date.now() + 8000; sends.length <= n;) {
    assert.ok(Date.now() < deadline, `${what} never arrived`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return sends.at(-1);
};
async function endTurn(text) {
  raw += `${text}\n`;
  working = false;
  await hostWorking(false);
}
// A write as the runtime streams it, with the file effect performed here.
function writes(name, content) {
  fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
  raw += ev({ type: 'tool_call_begin', name: 'write' }) + ev({ type: 'tool_call_param', param: 'path', path: '' })
    + ev({ type: 'tool_call_param', param: 'content', path: name }) + ev({ type: 'tool_body_delta', text: content })
    + ev({ type: 'tool_call', name: 'write', input: { path: name, content: content.slice(0, 200) } });
  fs.writeFileSync(path.join(project, name), content);
  raw += ev({ type: 'tool_result', name: 'write', output: `Wrote ${Buffer.byteLength(content)} bytes to ${name}` });
}
const pageHtml = (title, color, extra = '') => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n`
  + `<link rel="stylesheet" href="css/site.css">\n<style>body { background: ${color}; }</style>\n</head>\n<body>\n<main>\n<h1 id="title">${title}</h1>\n${extra}</main>\n</body>\n</html>\n`;

const QUESTIONS = [
  { id: 'audience', label: 'Who reads it?', type: 'text', placeholder: 'e.g. library members' },
  { id: 'tone', label: 'Which tone?', type: 'radio', options: [{ value: 'quiet', label: 'Quiet', description: 'Paper and serif type' }, { value: 'lively', label: 'Lively' }] },
];
const ANSWER = '§QUESTION_ANSWER\nAnswers to the clarification:\nWho reads it?: Adult members of the library\nWhich tone?: quiet\n§END';
const DIRECTIONS = [
  { entry: 'a.html', tag: 'A', name: 'Paper', desc: 'Large serif headline' },
  { entry: 'b.html', tag: 'B', name: 'Evening', desc: 'Dark palette' },
  { entry: 'c.html', tag: 'C', name: 'Index', desc: 'A list of the season' },
];

try {
  await page.goto(server.origin);

  await step('the designer asks its questions above the composer', async (row) => {
    await page.locator('#tab-design').click();
    const dialog = page.locator('#workdir-dialog'); await dialog.waitFor();
    // Start once the dialog has listed the project folder.
    await dialog.getByText('No subfolders').waitFor();
    await dialog.getByRole('button', { name: /^(Start|Launch)/ }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: /What should we design\?/ }).waitFor();
    await page.locator('#composer-input').fill('Design a one-page site for our Thursday reading club.');
    await page.locator('#btn-send').click();
    await arrived(0, 'the brief');
    await hostWorking(true);
    // The runtime's question() round: the call, the question event, its result.
    raw += ev({ type: 'tool_call', name: 'question', input: { id: 'brief', title: 'Before I sketch', questions: JSON.stringify(QUESTIONS) } })
      + ev({ type: 'question', id: 'brief', title: 'Before I sketch', questions: QUESTIONS })
      + ev({ type: 'tool_result', name: 'question', output: "Question event emitted. Stop this turn and wait for the user's answer.\n" });
    const form = page.locator('#plan-actions[data-kind="question"] .qform');
    await form.waitFor({ state: 'visible' });
    assert.equal(await form.locator('.qform-head .qt').innerText(), 'Before I sketch');
    assert.equal(await form.locator('.qform-head .qmeta').innerText(), '2 questions');
    assert.deepEqual(await form.locator('.q-label').evaluateAll((ns) => ns.map((n) => n.textContent)), ['1Who reads it?', '2Which tone?'], 'two numbered questions');
    await page.locator('#agent-view .seg--sys', { hasText: 'Clarification requested' }).waitFor();
    const [questions, composer] = await Promise.all([page.locator('#plan-actions').boundingBox(), page.locator('#composer-input').boundingBox()]);
    row.layout = { questions, composer };
    assert.ok(questions.y + questions.height <= composer.y + 1, 'the questions sit above the composer');
    // While the designer is still finishing its turn the answer is held back.
    await form.locator('input[type="text"]').fill('Adult members of the library');
    await form.getByRole('button', { name: /Quiet/ }).click();
    await form.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('Wait for the agent to finish asking the question.').waitFor();
    assert.equal(sends.length, 1, 'nothing is sent while the turn runs');
    await capture('questions');
    await endTurn('');
  });

  await step('the answer is sent once, the questions close and the work continues', async (row) => {
    await until(() => document.querySelector('#btn-stop')?.hidden === true);
    const form = page.locator('#plan-actions[data-kind="question"] .qform');
    assert.equal(await form.locator('input[type="text"]').inputValue(), 'Adult members of the library', 'the typed answer was kept');
    await form.getByRole('button', { name: 'Continue' }).click();
    const sent = await arrived(1, 'the answer');
    row.prompt = sent.prompt;
    assert.equal(sent.prompt, ANSWER);
    await page.locator('#plan-actions').waitFor({ state: 'hidden' });
    await page.locator('#agent-view .seg--cmd', { hasText: 'Clarification answered' }).waitFor();
    assert.equal(await page.locator('#agent-view').getByText('§QUESTION_ANSWER').count(), 0, 'the protocol markers stay out of the conversation');
    await hostWorking(true);
    fs.mkdirSync(path.join(project, 'css'), { recursive: true });
    writes('css/site.css', 'body { margin: 0; font: 18px/1.5 Georgia, serif; } main { padding: 32px; }\n');
    writes('index.html', pageHtml('Thursday reading club', '#fbf8f1', '<p>For adult members of the library.</p>\n'));
    await endTurn('The club page is written for adult members, in a quiet tone.');
    await page.locator('#agent-view', { hasText: 'The club page is written for adult members' }).waitFor();
    assert.equal(sends.length, 2);
  });

  await step('a reload does not ask the answered questions again', async () => {
    // Reload once the conversation, with the answer and the reply after it,
    // is saved (the store writes it shortly after the turn ends).
    await until(() => (JSON.parse(localStorage.getItem('ds4web.chats.v2') || '{}').chats || [])
      .some((c) => c.mode === 'design' && /The club page is written/.test(c.transcript || '')));
    await page.reload();
    await page.locator('#agent-view .seg--cmd', { hasText: 'Clarification answered' }).waitFor();
    await page.locator('#agent-view', { hasText: 'The club page is written for adult members' }).waitFor();
    assert.equal(await page.locator('#plan-actions').isVisible(), false);
    assert.equal(await page.locator('#plan-actions .qform').count(), 0);
  });

  await step('the proposed directions are compared side by side and full size', async (row) => {
    await page.locator('#composer-input').fill('Show me three directions for the club page.');
    await page.locator('#btn-send').click();
    await arrived(2, 'the directions request');
    await hostWorking(true);
    writes('a.html', pageHtml('Read together', '#fbf8f1'));
    writes('b.html', pageHtml('Thursdays, chapter by chapter', '#102a2c'));
    writes('c.html', pageHtml('The season index', '#efe6d2', '<ol><li>October: The Leopard</li></ol>\n'));
    raw += ev({ type: 'tool_call', name: 'propose', input: { directions: JSON.stringify(DIRECTIONS) } })
      + ev({ type: 'proposal', directions: DIRECTIONS })
      + ev({ type: 'tool_result', name: 'propose', output: 'Proposed 3 directions. The user can compare them and pick one to refine.\n' });
    await endTurn('');
    const cards = page.locator('#agent-view .proposal .pd-card');
    await cards.nth(2).waitFor();
    assert.equal(await page.locator('#agent-view .proposal .proposal-sub').innerText(), '3 directions — pick one to refine');
    assert.deepEqual(await cards.locator('.pd-name').allInnerTexts(), ['Paper', 'Evening', 'Index']);
    // Each card is a live preview of its own file, served by the host.
    for (const [i, d] of DIRECTIONS.entries()) {
      const frame = cards.nth(i).locator('iframe.pd-frame');
      assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
      assert.match(new URL(await frame.getAttribute('src'), server.origin).pathname, new RegExp(`/api/design/preview/${d.entry.replace('.', '\\.')}$`));
      await cards.nth(i).scrollIntoViewIfNeeded();   // the previews load lazily
      await cards.nth(i).frameLocator('iframe.pd-frame').locator('#title').waitFor({ state: 'attached' });
    }
    assert.deepEqual(await Promise.all(DIRECTIONS.map((_, i) => cards.nth(i).frameLocator('iframe.pd-frame').locator('#title').textContent())),
      ['Read together', 'Thursdays, chapter by chapter', 'The season index']);
    const boxes = await Promise.all(DIRECTIONS.map((_, i) => cards.nth(i).boundingBox()));
    row.boxes = boxes;
    assert.ok(boxes.every((b) => Math.abs(b.y - boxes[0].y) < 2) && boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x, 'side by side');
    await capture('proposal');
    // The full-size view walks the project's screens as the page last listed
    // them (it polls every second): let one listing with all three arrive and
    // be followed by another, so the first was applied.
    for (let seen = 0, from = 0, deadline = Date.now() + 8000; seen < 2;) {
      assert.ok(Date.now() < deadline, 'the page did not list the directions');
      const i = requests.findIndex((r, k) => k >= from && r.names && DIRECTIONS.every((d) => r.names.includes(d.entry)));
      if (i >= 0) { seen++; from = i + 1; } else await new Promise((r) => setTimeout(r, 50));
    }
    // Full size: open B, step to the next screen and back.
    await cards.nth(1).locator('.pd-frame-wrap').click();
    await page.locator('#ws-fs').waitFor({ state: 'visible' });
    const fsTitle = (text) => page.frameLocator('#ws-fs .fs-frame').locator('#title', { hasText: text }).waitFor();
    await fsTitle('Thursdays, chapter by chapter');
    await page.locator('#ws-fs [data-fs="next"]').click();
    await fsTitle('The season index');
    await page.locator('#ws-fs [data-fs="prev"]').click();
    await fsTitle('Thursdays, chapter by chapter');
    await page.locator('#ws-fs [data-fs="close"]').click();
    await page.locator('#ws-fs').waitFor({ state: 'hidden' });
  });

  await step('picking a direction sends the choice and marks it chosen', async (row) => {
    const cards = page.locator('#agent-view .proposal .pd-card');
    await cards.nth(1).getByRole('button', { name: 'Use this' }).click();
    const sent = await arrived(3, 'the chosen direction');
    row.prompt = sent.prompt;
    assert.equal(sent.prompt, 'Use direction B (b.html). Continue refining only this one; drop the other directions.');
    await until(() => document.querySelectorAll('#agent-view .proposal .pd-card--locked').length === 1);
    assert.deepEqual(await page.locator('#agent-view .proposal .pd-card .pd-use').allInnerTexts(), ['Use this', '✓ Chosen', 'Use this']);
    assert.equal(await page.locator('#agent-view .proposal .pd-card--locked .pd-name').innerText(), 'Evening');
    await capture('proposal-chosen');
    await endTurn('Refining direction B only (simulated).');
    await until(() => document.querySelector('#btn-stop')?.hidden === true);
  });

  // Every byte value, so a text decoding or a length error shows.
  const MARK = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 37 + 11) & 255));
  fs.mkdirSync(path.join(project, 'img'), { recursive: true });
  fs.writeFileSync(path.join(project, 'img/mark.png'), MARK);
  fs.mkdirSync(path.join(project, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(project, 'notes/brief ü.md'), 'Città, caffè and a ✓ in a nested file name.\n');
  const verifyZip = (file) => {
    const script = 'import json, sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nbad = z.testzip()\n'
      + 'print(json.dumps({"bad": bad, "files": {i.filename: z.read(i).hex() for i in z.infolist()}, "utf8": [bool(i.flag_bits & 0x800) for i in z.infolist()]}))\n';
    const r = spawnSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  await step('Export saves every project file in a zip that another reader verifies byte for byte', async (row) => {
    await page.locator('#btn-agent-ide').click();
    await page.locator('#agent-ide').waitFor({ state: 'visible' });
    await page.locator('#ide-canvas').click();
    await page.locator('#ws-canvas').waitFor({ state: 'visible' });
    await page.locator('.cv-board[data-name="b.html"]').waitFor();
    const listed = (await (await fetch(`http://127.0.0.1:${hostPort}/api/design/files`)).json()).files.map((f) => f.name).sort();
    row.listed = listed;
    assert.deepEqual(listed, ['a.html', 'b.html', 'brief.md', 'c.html', 'css/site.css', 'img/mark.png', 'index.html', 'notes/brief ü.md']);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#cv-export').click()]);
    row.filename = download.suggestedFilename();
    assert.equal(row.filename, 'project.zip', 'named after the project folder');
    const zip = path.join(dir, 'export.zip');
    await download.saveAs(zip);
    const read = verifyZip(zip);
    assert.equal(read.bad, null, 'every CRC matches');
    assert.deepEqual(Object.keys(read.files).sort(), listed);
    for (const name of listed) assert.equal(read.files[name], fs.readFileSync(path.join(project, name)).toString('hex'), `${name} bytes`);
    assert.ok(read.utf8.every(Boolean), 'names are marked UTF-8');
    await page.getByText(`Exported ${listed.length} files → project.zip`).waitFor();
    await capture('exported');
  });

  await step('a file the host cannot serve stops the export instead of being archived as an error', async (row) => {
    // Larger than the host serves (MAX_PAGE, 8 MiB), e.g. a generated clip.
    fs.mkdirSync(path.join(project, 'media'), { recursive: true });
    fs.writeFileSync(path.join(project, 'media/clip.mp4'), Buffer.alloc(9 * 1024 * 1024, 7));
    const served = await fetch(`http://127.0.0.1:${hostPort}/api/design/file?name=media%2Fclip.mp4`);
    row.hostStatus = served.status;
    assert.equal(served.ok, false, 'the host refuses to serve it');
    const downloads = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    await page.locator('#cv-export').click();
    await page.getByText('Export failed: cannot read media/clip.mp4').waitFor();
    await page.waitForTimeout(500);
    row.downloads = downloads;
    assert.deepEqual(downloads, [], 'no archive is offered');
    await capture('export-refused');
  });

  assert.deepEqual(evidence.errors, [], 'no page errors');
  assert.deepEqual(evidence.external, [], 'no external requests');
} finally {
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ ...receipt, sends: sends.map((s) => ({ displayPrompt: s.displayPrompt, prompt: s.prompt?.slice(0, 300) })),
    requests: requests.slice(-60), hostLog: hostLog.slice(-4000) }, null, 2));
  await browser.close();
  server.close();
  host.stdin.end();
}
const passed = receipt.cases.filter((c) => c.status === 'PASS').length;
console.log(`ui_design_flow (${browserName}, simulated Design stream): ${passed}/${receipt.cases.length}; receipts: ${dir}`);
if (passed !== receipt.cases.length) process.exitCode = 1;
