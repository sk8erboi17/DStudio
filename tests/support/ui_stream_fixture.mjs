// Model-free, bounded stream fixture shared by browser regressions and the
// operator-driven browser preview. No proxy, subprocess or model installation.
import { uiMockServer, jsonReply, requestBody, sseDelta, sseDone } from './ui_mock_server.mjs';

export const streamText = '# Risposta simulata\n\nTesto con **grassetto**, _corsivo_ e una formula $x^2 + y^2$.\n\n'
  + '| Colonna | Valore |\n| --- | --- |\n| Caffè | 42 |\n\n'
  + '```javascript\nfunction esempio() {\n    return "caffè 🧪";\n}\n```\n\n'
  + Array.from({ length: 64 }, (_, index) => `Riga ${String(index).padStart(3, '0')}: testo stabile da selezionare, leggere e copiare durante la generazione.`).join('\n\n') + '\n\n';

export function streamSeed(theme = 'dark') {
  const now = Date.now();
  const roadmap = { version: 1, title: 'Verifica Learn', goal: 'Leggere durante gli aggiornamenti.',
    stages: [{ id: 'lettura', title: 'Lettura', topics: [{ id: 'selezione', title: 'Selezione del testo',
      summary: 'Studiare il testo simulato.', outcome: 'Selezionare un passaggio.' }] }] };
  return { theme, settings: { workdirs: { agent: '/fixture/agent', cowork: '/fixture/cowork', design: '/fixture/design' } },
    chats: [
      { id: 'audit-chat', mode: 'chat', title: 'Verifica Chat', createdAt: now, updatedAt: now,
        messages: [{ id: 'audit-first-question', role: 'user', content: 'Conversazione isolata di verifica.' }] },
      { id: 'audit-other', mode: 'chat', title: 'Altra conversazione', createdAt: now, updatedAt: now - 1000,
        messages: [{ id: 'other-answer', role: 'assistant', content: 'Questa conversazione non deve ricevere il testo di un altro turno.' }] },
      ...['agent', 'cowork', 'design'].map(mode => ({ id: `audit-${mode}`, mode, title: `Verifica ${mode}`,
        createdAt: now, updatedAt: now, messages: [], transcript: '', workdir: `/fixture/${mode}` })),
      { id: 'audit-learn', mode: 'roadmap', title: 'Verifica Learn', createdAt: now, updatedAt: now,
        messages: [{ id: 'audit-roadmap', role: 'assistant', content: '```dstudio-roadmap\n' + JSON.stringify(roadmap) + '\n```' }] },
    ] };
}

// These selectors are shared by the two real-browser streaming regressions.
// Admission still happens through the UI and the fixture's HTTP protocol.
export async function startFixtureStream(page, mode, prompt = 'Verifica della selezione') {
  let scroller = '#messages', paragraphs = '.msg--assistant .msg__content p', input = '#composer-input';
  if (mode === 'tutor') {
    await page.locator('#tab-roadmap').click();
    await page.getByRole('button', { name: 'Study Selezione del testo', exact: true }).click();
    scroller = '.roadmap-study__scroll'; paragraphs = '.roadmap-study-msg--assistant .md p'; input = '.roadmap-study__input';
    await page.locator(input).fill(prompt); await page.locator('.roadmap-study__send').click();
  } else {
    if (mode !== 'chat') {
      await page.locator(`#tab-${mode}`).click();
      const dialog = page.locator('#workdir-dialog'); await dialog.waitFor();
      await dialog.getByRole('button', { name: /^(Start|Launch)/ }).click();
      await page.locator('#loading-overlay').waitFor({ state: 'hidden' });
      scroller = '#agent-view';
      paragraphs = mode === 'design' ? '#agent-view .todos-card li span:last-child' : '#agent-view .seg--text p';
    }
    await page.locator(input).fill(prompt); await page.locator('#btn-send').click();
  }
  await page.locator(paragraphs).filter({ hasText: 'Riga 020:' }).first().waitFor();
  await page.waitForFunction(() => !document.body.classList.contains('chat-drop-anim') && !document.querySelector('.hero-ghost'));
  return { scroller, paragraphs, input };
}

// Executed in the real browser, after an explicit quiet HTTP barrier has allowed
// the production debounce to publish. No access to private application globals.
export function fixtureTextSaved({ mode, contains, equals }) {
  const chats = JSON.parse(localStorage.getItem('ds4web.chats.v2')).chats;
  const ids = JSON.parse(localStorage.getItem('ds4web.active.v2')).ids;
  const chat = chats.find(chat => chat.id === ids[mode === 'tutor' ? 'roadmap' : mode]);
  if (!chat) return false;
  const actual = mode === 'tutor' ? Object.values(chat.messages.find(message => message.roadmapStudyThreads)?.roadmapStudyThreads || {})[0]?.messages.at(-1)?.content
    : mode === 'chat' ? chat.messages.at(-1)?.content : chat.transcript;
  return contains !== undefined ? String(actual || '').includes(contains) : String(actual || '').trim() === equals.trim();
}

export async function uiStreamFixture({ speed = 'fast', autoFinish = false, maxChunks = 128, document } = {}) {
  if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 512) throw Error('Fixture chunk budget must be 1–512');
  let mode = 'server', context = 65536, working = false, raw = '', content = '', response, timer, chunks = 0;
  // Pausing automatic fixture chunks is a deterministic quiet barrier for the
  // production persistence debounce. It does not complete the active request.
  const pause = () => { clearInterval(timer); timer = null; };
  const finish = () => { pause(); working = false; if (response && !response.destroyed) sseDone(response); response = null; };
  const append = delta => {
    content += delta;
    if (response && !response.destroyed) sseDelta(response, delta); else raw += delta;
  };
  const start = () => {
    working = true; chunks = 0;
    timer = setInterval(() => {
      if (chunks === maxChunks) { pause(); if (autoFinish) finish(); return; }
      const burst = speed === 'bursty' ? 7 : 1;
      for (let i = 0; i < burst && chunks < maxChunks; i++) {
        const n = ++chunks;
        append(`Aggiunta ${String(n).padStart(3, '0')}: **testo** simulato ${n % 3 ? 'caffè' : '🧪'} durante lo stream.\n\n`);
      }
    }, speed === 'slow' ? 180 : speed === 'bursty' ? 80 : 10);
  };
  const server = await uiMockServer(async (req, res, url) => {
    if (url.pathname === '/api/status') {
      jsonReply(res, { mode, running: true, ready: true, loadPct: 100, stage: 'Ready (simulated)',
        agentWorking: working, agentSessionWorking: false, nativeVisionActive: true, workdir: `/fixture/${mode}`,
        ds4dirOk: true, webdirOk: true, lan: false, modelFile: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf',
        config: { ctx: context, power: 100 }, variant: 'flash', variants: { flash: true } }); return true;
    }
    if (url.pathname === '/api/start') {
      const body = await requestBody(req); mode = body.mode || 'server'; context = body.ctx || context;
      jsonReply(res, { ok: true }); return true;
    }
    if (url.pathname === '/api/fs/list') { const body = await requestBody(req); jsonReply(res, { ok: true, path: body.path || '/fixture', entries: 0, dirs: [] }); return true; }
    if (url.pathname === '/api/user-skills') { jsonReply(res, { ok: true, skills: [] }); return true; }
    if (url.pathname === '/api/design-systems') { jsonReply(res, { ok: true, designSystems: [] }); return true; }
    if (url.pathname === '/api/design/state') { jsonReply(res, { ok: true, state: { seq: 1, phase: 'idle' } }); return true; }
    if (url.pathname === '/api/design/events') { jsonReply(res, { ok: true, events: [] }); return true; }
    if (url.pathname === '/api/design/files') { jsonReply(res, { ok: true, files: [] }); return true; }
    if (url.pathname === '/api/design/artifacts') { jsonReply(res, { ok: true, artifacts: [] }); return true; }
    if (url.pathname === '/api/design/session') { await requestBody(req); jsonReply(res, { ok: true }); return true; }
    if (url.pathname === '/api/updates/check') { jsonReply(res, { ok: true, sections: [] }); return true; }
    if (url.pathname === '/api/agent/poll') {
      const bytes = Buffer.from(raw), since = Number(url.searchParams.get('since')) || 0;
      jsonReply(res, { base: 0, len: bytes.length, text: bytes.subarray(since).toString('utf8'), working,
        sessionWorking: false, ready: true, loadPct: 100 }); return true;
    }
    if (url.pathname === '/api/agent/interrupt') { finish(); jsonReply(res, { ok: true }); return true; }
    if (url.pathname === '/v1/chat/completions' || url.pathname === '/api/agent/send') {
      const body = await requestBody(req);
      if (working) { jsonReply(res, { error: 'Simulated runtime already working' }, 409); return true; }
      clearInterval(timer); content = streamText;
      if (url.pathname === '/v1/chat/completions') {
        response = res; res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        sseDelta(res, content);
        res.once('close', () => { if (response === res) { clearInterval(timer); working = false; response = null; } });
      } else {
        response = null;
        const todos = mode === 'design' ? '\x1e' + JSON.stringify({ type: 'todos', todos:
          Array.from({ length: 64 }, (_, n) => ({ text: `Riga ${String(n).padStart(3, '0')}: testo stabile da selezionare, leggere e copiare durante la generazione.`, status: 'pending' })) }) + '\n' : '';
        raw = `\x01USER\x02${body.displayPrompt}\x01ENDUSER\x02\n\x1e${JSON.stringify({ type: 'reasoning_end' })}\n${todos}${content}`;
        jsonReply(res, { ok: true, from: 0, at: Buffer.byteLength(raw) });
      }
      start(); return true;
    }
    return false;
  }, { document });
  return { ...server, pause, finish, append, state: () => ({ mode, working, chunks, raw, content }),
    close: () => { clearInterval(timer); response?.destroy(); server.close(); } };
}
