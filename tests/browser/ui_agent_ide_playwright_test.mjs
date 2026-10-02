// Open IDE view (Agent mode) in a real browser against the REAL host file
// handlers (tests/support/agent_workspace_host.c → src/dstudio_agent_workspace.c)
// on a task-owned workspace. The agent stream is SIMULATED: events are scripted
// in the format recorded from ds4-agent-jsonl (tool_call_begin / tool_call_param
// / tool_body_delta with visualizer text, then tool_call / tool_result), and the
// test performs each tool's file effect itself. No model or inference runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { uiMockServer, jsonReply, requestBody, seedUi } from '../support/ui_mock_server.mjs';

const browserName = process.env.DSTUDIO_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const hostBinary = path.resolve(process.argv[2] || 'tests/.build/agent_workspace_host');
fs.mkdirSync('tests/.artifacts/ui-agent-ide', { recursive: true });
const dir = fs.mkdtempSync(`tests/.artifacts/ui-agent-ide/${browserName}-`);
const workspace = path.resolve(dir, 'workspace è');
fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# Fixture\n\nThe agent reads and writes files here.\n');
fs.writeFileSync(path.join(workspace, 'docs/notes.md'), '# Notes\n\n- simulated workspace\n');
const source = fs.readFileSync('web/index.html', 'utf8');
const receipt = { scope: 'Real browser and real host file handlers; agent stream and tool effects simulated; no inference',
  browserName, sourceSha256: createHash('sha256').update(source).digest('hex'), cases: [] };

// ---------- real host file handlers ----------
const host = spawn(hostBinary, [workspace], { stdio: ['pipe', 'pipe', 'pipe'] });
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

// ---------- simulated agent runtime + proxy to the real file handlers ----------
const RS = '\x1e';
// The IDE re-reads open files in the background (turn end, bash refresh). A
// step that changes a file outside the IDE holds those reads so the order of
// "external write, then Save" is deterministic.
let readBarrier = null, readsInFlight = 0;
function holdReads(rel) {
  let release;
  readBarrier = { path: rel, released: new Promise((r) => { release = r; }) };
  return () => { readBarrier = null; release(); };
}
async function readsSettled() {
  const deadline = Date.now() + 8000;
  while (readsInFlight > 0) {
    if (Date.now() > deadline) throw Error('IDE reads did not settle');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const ev = (o) => RS + JSON.stringify(o) + '\n';
let raw = '', working = false, mode = 'server';
const requests = [];
const server = await uiMockServer(async (req, res, url) => {
  if (url.pathname.startsWith('/api/agent/fs/')) {
    const body = Buffer.concat(await (async () => { const c = []; for await (const x of req) c.push(x); return c; })());
    const headers = { 'Content-Type': 'application/json' };
    if (req.headers['x-requested-with']) headers['X-Requested-With'] = req.headers['x-requested-with'];
    const read = url.pathname === '/api/agent/fs/read';
    // Barrier: a held read reaches the host only after release (see readBarrier).
    if (read && readBarrier && JSON.parse(body.toString('utf8') || '{}').path === readBarrier.path) await readBarrier.released;
    if (read) readsInFlight++;
    let r;
    try { r = await fetch(`http://127.0.0.1:${hostPort}${url.pathname}`, { method: req.method, headers, body }); }
    finally { if (read) readsInFlight--; }
    const text = await r.text();
    requests.push({ path: url.pathname, status: r.status, body: body.toString('utf8').slice(0, 400) });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(text);
    return true;
  }
  if (url.pathname === '/api/status') {
    jsonReply(res, { mode, running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)',
      agentWorking: working, agentSessionWorking: false, nativeVisionActive: true, workdir: workspace,
      ds4dirOk: true, webdirOk: true, lan: false, modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf',
      config: { ctx: 65536, power: 100 }, variant: 'flash', variants: { flash: true } });
    return true;
  }
  if (url.pathname === '/api/start') { const b = await requestBody(req); mode = b.mode || 'server'; jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/fs/list') { const b = await requestBody(req); jsonReply(res, { ok: true, path: b.path || workspace, entries: 2, dirs: ['docs'] }); return true; }
  if (url.pathname === '/api/user-skills') { jsonReply(res, { ok: true, skills: [] }); return true; }
  if (url.pathname === '/api/design-systems') { jsonReply(res, { ok: true, designSystems: [] }); return true; }
  if (url.pathname === '/api/updates/check') { jsonReply(res, { ok: true, sections: [] }); return true; }
  if (url.pathname === '/api/task-graphs') { jsonReply(res, { ok: true, graphs: [] }); return true; }
  if (url.pathname === '/api/agent/poll') {
    const bytes = Buffer.from(raw), since = Number(url.searchParams.get('since')) || 0;
    jsonReply(res, { base: 0, len: bytes.length, text: bytes.subarray(since).toString('utf8'), working,
      sessionWorking: false, ready: true, loadPct: 100 });
    return true;
  }
  if (url.pathname === '/api/agent/interrupt') { working = false; jsonReply(res, { ok: true }); return true; }
  if (url.pathname === '/api/agent/send') {
    const b = await requestBody(req);
    raw += `\x01USER\x02${b.displayPrompt}\x01ENDUSER\x02\n`;
    working = true;
    jsonReply(res, { ok: true, from: 0, at: Buffer.byteLength(raw) });
    return true;
  }
  return false;
});

const now = Date.now();
const seed = { theme: 'dark', settings: { workdirs: { agent: workspace } },
  chats: [{ id: 'ide-agent', mode: 'agent', title: 'IDE fixture', createdAt: now, updatedAt: now, messages: [], transcript: '', workdir: workspace }] };

const browser = await ({ chromium, webkit })[browserName].launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.setDefaultTimeout(8000);
const evidence = await seedUi(page, server.origin, seed);
let shot = 0;
const capture = (name) => page.screenshot({ path: path.join(dir, `${String(shot++).padStart(2, '0')}-${name}.png`) });
const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 8000 });
const ideText = () => page.evaluate(() => document.querySelector('#ide-layer').textContent);
async function step(name, fn) {
  const row = { name };
  try { await fn(row); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = error.stack; process.exitCode = 1; await capture(`fail-${name.replace(/\W+/g, '-')}`).catch(() => {}); }
  receipt.cases.push(row);
  console.log(`${row.status} ${name}${row.error ? `\n${row.error}` : ''}`);
  if (row.status === 'FAIL') throw Error(`stopped after: ${name}`);
}

const MAIN = 'fn main() {\n    println!("Hello, IDE!");\n}\n';
try {
  await page.goto(server.origin);

  await step('the Agent header offers Open IDE instead of Graph', async () => {
    await page.locator('#tab-agent').click();
    const dialog = page.locator('#workdir-dialog'); await dialog.waitFor();
    await dialog.getByRole('button', { name: /^(Start|Launch)/ }).click();
    await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
    await page.locator('#btn-agent-ide').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#btn-task-graph').count(), 0);
    assert.equal((await page.locator('#btn-agent-ide').innerText()).trim(), 'Open IDE');
  });

  await step('a turn starts and the IDE takes over the pane with the real workspace listing', async () => {
    await page.locator('#composer-input').fill('Scrivi un hello world in Rust');
    await page.locator('#btn-send').click();
    await until(() => document.querySelector('.agent-working, .agent-response-status.is-live'));
    await hostWorking(true);
    // The working line offers the same view as the header button.
    const shortcut = page.locator('#agent-view .agent-working__ide');
    await shortcut.waitFor({ state: 'visible' });
    assert.equal((await shortcut.innerText()).trim(), 'Open in IDE to see it live');
    await shortcut.click();
    await page.locator('#agent-ide').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#btn-agent-ide').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#agent-view').isVisible(), false, 'the transcript is hidden behind the IDE');
    assert.equal(await page.locator('#composer-input').isVisible(), false, 'the composer is hidden behind the IDE');
    await page.locator('#ide-tree [data-ide-file="README.md"]').waitFor();
    await page.locator('#ide-tree [data-ide-dir="docs"]').waitFor();
    assert.match(await page.locator('#ide-chip').innerText(), /working/i);
  });

  await step('a comic thought bubble shows the reasoning and stays as the last thought', async () => {
    assert.equal(await page.locator('#ide-thought').isVisible(), false);
    raw += ev({ type: 'reasoning_start' }) + 'Devo creare un progetto Rust. ';
    await until((v) => !document.querySelector('#ide-thought').hidden
      && /progetto Rust/.test(document.querySelector('#ide-thought-tx').textContent), null);
    assert.equal(await page.locator('#ide-thought-name').innerText(), 'DeepSeek');
    raw += 'Scrivo main.rs con un saluto.\n';
    await until(() => /main\.rs con un saluto/.test(document.querySelector('#ide-thought-tx').textContent));
    assert.equal(await page.locator('#ide-thought-state').innerText(), 'is thinking');
    assert.equal(await page.locator('#ide-thought .ide-thought-caret').count(), 1);
    await capture('thought-bubble');
    raw += ev({ type: 'reasoning_end' });
    await until(() => document.querySelector('#ide-thought-state').textContent === '· last thought');
    assert.equal(await page.locator('#ide-thought').isVisible(), true, 'the last thought stays on screen');
    assert.match(await page.locator('#ide-thought-tx').innerText(), /main\.rs con un saluto/);
    assert.equal(await page.locator('#ide-thought .ide-thought-caret').count(), 0);
  });

  await step('the cursor follows a streamed write before the file exists on disk', async (row) => {
    // The path parameter streams first: its partial value must never become a tab.
    const tabsBefore = await page.locator('#ide-tabs [data-ide-tab]').count();
    raw += ev({ type: 'tool_call_begin', name: 'write' })
      + '🛠️ write ' + ev({ type: 'tool_call_param', param: 'path', path: '' })
      + ' path=hello/sr';
    await until(() => [...document.querySelectorAll('#agent-view .diff-path')].some((n) => n.textContent === 'hello/sr'));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    row.partialPathTabs = await page.locator('#ide-tabs [data-ide-tab]').evaluateAll((ns) => ns.map((n) => n.dataset.ideTab));
    assert.equal(row.partialPathTabs.length, tabsBefore, 'a partial path opened a tab');
    assert.equal(await page.locator('#ide-fpill').isVisible(), false);
    raw += 'c/main.rs' + ev({ type: 'tool_call_param', param: 'content', path: 'hello/src/main.rs' })
      + '\nfn main() {\n' + ev({ type: 'tool_body_delta', text: 'fn main() {\n    println!("Hel' });
    await until(() => document.querySelector('#ide-layer .ide-caret') && /Hel/.test(document.querySelector('#ide-layer').textContent));
    row.flag = await page.locator('#ide-layer .ide-caret-flag').innerText();
    assert.equal(row.flag, 'DeepSeek');
    assert.deepEqual(await page.locator('#ide-tabs [data-ide-tab]').evaluateAll((ns) => ns.map((n) => n.dataset.ideTab)),
      ['hello/src/main.rs'], 'only the final path is opened');
    assert.match(await page.locator('#ide-stream').innerText(), /not on disk yet/);
    assert.equal(await page.locator('#ide-input').evaluate((n) => n.readOnly), true);
    assert.equal(fs.existsSync(path.join(workspace, 'hello/src/main.rs')), false);
    assert.ok(await page.locator('#ide-tree .ide-tr.pending').count() >= 1, 'the target is listed as pending');
    // The last thought stays while the agent writes, and never covers its caret.
    assert.equal(await page.locator('#ide-thought').isVisible(), true);
    assert.match(await page.locator('#ide-thought-tx').innerText(), /main\.rs con un saluto/);
    const overlap = await page.evaluate(() => {
      const a = document.querySelector('#ide-layer .ide-caret').getBoundingClientRect();
      const b = document.querySelector('#ide-thought-cloud, .ide-thought-cloud').getBoundingClientRect();
      return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    });
    assert.equal(overlap, false, 'the bubble covers the agent caret');
    await capture('streaming-write');
  });

  await step('manual navigation stops following and Follow returns to the cursor', async () => {
    await page.locator('#ide-tree [data-ide-file="README.md"]').click();
    await until(() => /The agent reads/.test(document.querySelector('#ide-layer').textContent));
    assert.equal(await page.locator('#ide-follow').isChecked(), false);
    raw += ev({ type: 'tool_body_delta', text: 'lo, IDE!");\n' });
    await page.locator('#ide-fpill').waitFor({ state: 'visible' });
    assert.match(await page.locator('#ide-fpill').innerText(), /hello\/src\/main\.rs/);
    await page.locator('#ide-fpill button').click();
    await until(() => /Hello, IDE!/.test(document.querySelector('#ide-layer').textContent));
    assert.equal(await page.locator('#ide-follow').isChecked(), true);
  });

  await step('after tool_result the editor shows the bytes re-read from disk', async () => {
    raw += ev({ type: 'tool_body_delta', text: '}\n' }) + '\n'
      + ev({ type: 'tool_call', name: 'write', input: { path: 'hello/src/main.rs', content: MAIN } });
    fs.mkdirSync(path.join(workspace, 'hello/src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'hello/src/main.rs'), MAIN);
    raw += ev({ type: 'tool_result', name: 'write', output: 'wrote 3 lines to hello/src/main.rs' });
    await until(() => /written by/.test(document.querySelector('#ide-stream').textContent));
    assert.equal(await page.locator('#ide-input').inputValue(), MAIN);
    assert.ok(await page.locator('#ide-gutter .ide-gl.add').count() >= 3, 'new lines are marked as added');
    assert.equal(await page.locator('#ide-changes-badge').innerText(), '1');
    await page.locator('#ide-tree [data-ide-dir="hello"]').waitFor();
    assert.equal(await page.locator('#ide-layer .ide-caret').count(), 0);
    assert.ok(requests.some((r) => r.path === '/api/agent/fs/read' && r.status === 200 && r.body.includes('hello/src/main.rs')));
  });

  await step('the thought bubble can be hidden until the next thought', async () => {
    raw += ev({ type: 'reasoning_start' }) + 'Ora aggiorno il README. ';
    await until(() => !document.querySelector('#ide-thought').hidden && /aggiorno il README/.test(document.querySelector('#ide-thought-tx').textContent));
    await page.locator('#ide-thought-hide').click();
    await until(() => document.querySelector('#ide-thought').hidden);
    raw += 'Aggiungo il comando cargo build.';
    // Barrier: the (hidden) transcript has consumed the new reasoning bytes.
    await until(() => /comando cargo build/.test(document.querySelector('#agent-view').textContent));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await page.locator('#ide-thought').isVisible(), false, 'a dismissed bubble stays hidden while that thought continues');
    raw += ev({ type: 'reasoning_end' });
    await until(() => /comando cargo build/.test(document.querySelector('#agent-view').textContent));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await page.locator('#ide-thought').isVisible(), false, 'closing the dismissed thought does not bring it back');
  });

  await step('a streamed edit marks replaced and inserted lines, then reloads', async () => {
    raw += ev({ type: 'tool_call_begin', name: 'edit' })
      + '🛠️ edit ' + ev({ type: 'tool_call_param', param: 'path', path: '' })
      + ' path=README.md' + ev({ type: 'tool_call_param', param: 'old', path: 'README.md' })
      + '\n- The agent reads and writes files here.\n' + ev({ type: 'tool_body_delta', text: 'The agent reads and writes files here.\n' })
      + ev({ type: 'tool_call_param', param: 'new', path: 'README.md' })
      + '+ The agent reads and writes files here.\n' + ev({ type: 'tool_body_delta', text: 'The agent reads and writes files here.\nRun: cargo run' });
    await until(() => document.querySelector('#ide-layer .ide-ln.del') && document.querySelector('#ide-layer .ide-ln.ins'));
    assert.equal(await page.locator('#ide-tabs .ide-tab.on [data-ide-tab]').getAttribute('data-ide-tab'), 'README.md');
    await capture('streaming-edit');
    const next = '# Fixture\n\nThe agent reads and writes files here.\nRun: cargo run\n';
    raw += ev({ type: 'tool_body_delta', text: '\n' }) + '\n'
      + ev({ type: 'tool_call', name: 'edit', input: { path: 'README.md', old: 'The agent reads and writes files here.\n', new: 'The agent reads and writes files here.\nRun: cargo run\n' } });
    fs.writeFileSync(path.join(workspace, 'README.md'), next);
    raw += ev({ type: 'tool_result', name: 'edit', output: 'edited README.md' });
    await until((want) => document.querySelector('#ide-input').value === want, next);
    assert.ok(await page.locator('#ide-gutter .ide-gl.add, #ide-gutter .ide-gl.mod').count() >= 1);
    assert.equal(await page.locator('#ide-changes-badge').innerText(), '2');
  });

  await step('the next thought brings the bubble back after a dismissal', async () => {
    raw += ev({ type: 'reasoning_start' });
    await until(() => !document.querySelector('#ide-thought').hidden && document.querySelector('#ide-thought .ide-thought-wait'));
    assert.match(await page.locator('#ide-thought-tx').innerText(), /comando cargo build/, 'an empty new block keeps the previous words');
    raw += 'Controllo i file creati.';
    await until(() => /Controllo i file creati/.test(document.querySelector('#ide-thought-tx').textContent));
    raw += ev({ type: 'reasoning_end' });
  });

  await step('bash commands stream into the terminal panel', async () => {
    raw += ev({ type: 'tool_call_begin', name: 'bash' })
      + '🛠️ $ ' + ev({ type: 'tool_call_param', param: 'command', path: '' })
      + 'ls hello/src' + ev({ type: 'tool_body_delta', text: 'ls hello/src' });
    await until(() => document.querySelector('#ide-term .ide-term-caret') && /ls hello\/src/.test(document.querySelector('#ide-term').textContent));
    raw += '\n' + ev({ type: 'tool_call', name: 'bash', input: { command: 'ls hello/src' } })
      + ev({ type: 'tool_result', name: 'bash', output: 'main.rs\nbash job=1 pid=1 status=done elapsed_sec=0.0 timed_out=0\n' });
    await until(() => /main\.rs/.test(document.querySelector('#ide-term').textContent) && !document.querySelector('#ide-term .ide-term-caret'));
  });

  await step('the editor stays read-only while the agent works', async () => {
    await page.locator('#ide-input').click();
    await page.keyboard.type('X');
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8').includes('X'), false);
    assert.equal((await page.locator('#ide-input').inputValue()).includes('X'), false);
    assert.equal(await page.locator('#ide-save').isVisible(), false);
  });

  await step('when the turn ends the file becomes editable and saves exact bytes', async () => {
    raw += 'Fatto.\n';
    working = false;
    await hostWorking(false);
    await until(() => document.querySelector('#ide-chip').textContent === 'Editable');
    // The turn-end re-read of the files the agent touched completes first.
    await until(() => !document.querySelector('#ide-input').readOnly);
    assert.equal(await page.locator('#ide-layer .ide-ln.del, #ide-layer .ide-ln.ins').count(), 0,
      'a finished edit is never shown again as pending');
    // The transparent textarea must sit exactly over the highlighted text: a
    // double click on a word drawn by the layer selects that word in the input.
    const at = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector('#ide-layer'), NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.textContent.indexOf('cargo');
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(node, i); range.setEnd(node, i + 5);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    });
    assert.ok(at, 'the layer draws the README text');
    await page.mouse.dblclick(at.x, at.y);
    assert.equal(await page.locator('#ide-input').evaluate((n) => n.value.slice(n.selectionStart, n.selectionEnd)), 'cargo');
    await page.locator('#ide-input').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await page.keyboard.type('Caffè 🧪 "q" \\ fine\n');
    await page.locator('#ide-save').waitFor({ state: 'visible' });
    const typed = await page.locator('#ide-input').inputValue();
    await page.locator('#ide-save').click();
    await until(() => document.querySelector('#ide-save').hidden);
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), typed);
    assert.ok(typed.endsWith('Caffè 🧪 "q" \\ fine\n'));
    await capture('saved');
  });

  await step('a save over bytes changed on disk is refused until the user chooses', async () => {
    // Without the barrier a late background re-read can show the conflict
    // before Save, which is also correct but skips the host's refusal.
    const release = holdReads('README.md');
    await readsSettled();
    await page.locator('#ide-input').click();
    await page.keyboard.type('mine\n');
    const mine = await page.locator('#ide-input').inputValue();
    const external = '# Changed outside the IDE\n';
    fs.writeFileSync(path.join(workspace, 'README.md'), external);
    await page.locator('#ide-save').click();
    await page.locator('#ide-banner [data-ide-conflict="mine"]').waitFor();
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), external, 'the stale save changed nothing');
    assert.ok(requests.some((r) => r.path === '/api/agent/fs/write' && r.status === 409));
    release();
    await readsSettled();
    await page.locator('#ide-banner [data-ide-conflict="mine"]').click();
    await page.locator('#ide-save').click();
    await until(() => document.querySelector('#ide-save').hidden);
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), mine);
  });

  await step('the host refuses a save while it reports the agent working', async () => {
    await page.locator('#ide-input').click();
    await page.keyboard.type('late\n');
    const before = fs.readFileSync(path.join(workspace, 'README.md'), 'utf8');
    await hostWorking(true); // the UI still believes the agent is idle
    await page.locator('#ide-save').click();
    await until(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /agent is working/i.test(t.textContent)));
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), before);
    assert.ok(requests.some((r) => r.path === '/api/agent/fs/write' && r.status === 409));
    await hostWorking(false);
    await page.locator('#ide-revert').click();
  });

  await step('Task Graph stays reachable from the IDE and the pill leaves with Agent mode', async () => {
    await page.locator('#ide-task-graph').click();
    await page.locator('#task-graph-dialog').waitFor({ state: 'visible' });
    await page.locator('#task-graph-close').click();
    await page.locator('#ide-back').click();
    await page.locator('#agent-view').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#agent-ide').isVisible(), false);
    await page.locator('#tab-server').click();
    await page.locator('#btn-agent-ide').waitFor({ state: 'hidden' });
  });

  assert.deepEqual(evidence.errors, [], 'no page errors');
  assert.deepEqual(evidence.external, [], 'no external requests');
  receipt.unmocked = server.missing;
} finally {
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ ...receipt, requests, hostLog: hostLog.slice(-4000) }, null, 2));
  await browser.close();
  server.close();
  host.stdin.end();
}
const passed = receipt.cases.filter((c) => c.status === 'PASS').length;
console.log(`ui_agent_ide (${browserName}, simulated agent stream): ${passed}/${receipt.cases.length}; receipts: ${dir}`);
