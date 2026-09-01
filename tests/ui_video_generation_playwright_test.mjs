import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('ui_video_generation_playwright_test: playwright missing, skipping');
  process.exit(0);
}

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, 'web');
const workerSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'h3-run.py'), 'utf8');
const mp4Block = workerSource.match(/TEST_MP4_B64\s*=\s*\(([\s\S]*?)\n\)/)?.[1] || '';
const mp4Base64 = [...mp4Block.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join('');
const testVideo = Buffer.from(mp4Base64, 'base64');
assert.ok(testVideo.length > 500, 'the H3 protocol test video must be available');
const testImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const requestOrder = [];
const externalRequests = [];
const progressStages = [];
let engineRunning = true;
let engineStarting = false;
let engineReadyAt = 0;
let progressReads = 0;
let generationBody = null;
let pipelineGenerationBody = null;
let directGenerationBody = null;
let directFrameGenerationBody = null;
let imageGenerationBody = null;
let cancelledImageGenerationBody = null;
let holdNextImageGeneration = false;
let releaseHeldImageGeneration = null;
let resolveImageStop = null;
const imageStopBodies = [];
let chatRequests = 0;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function engineStatus() {
  if (engineStarting && Date.now() >= engineReadyAt) {
    engineStarting = false;
    engineRunning = true;
  }
  const processRunning = engineRunning || engineStarting;
  return {
    mode: processRunning ? 'server' : 'none', running: processRunning, ready: engineRunning,
    loadPct: engineRunning ? 100 : (engineStarting ? 45 : 0),
    stage: engineRunning ? 'Ready' : (engineStarting ? 'Mapping the model…' : 'Engine stopped'),
    agentWorking: false, workdir: '', ds4dirOk: true, webdirOk: true, lan: false,
    config: { ctx: 65536, power: 90, think: 'off', ssdStreaming: 'auto' },
    variants: { flash: true, pro: false }, variant: 'flash',
    modelFile: 'gguf/DeepSeek-V4-Flash-test.gguf', engineLine: engineRunning ? 'ready' : 'stopped',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api/status') {
    json(res, 200, engineStatus());
    return;
  }
  if (url.pathname === '/api/store') {
    if (req.method === 'POST') await readBody(req);
    json(res, 200, { ok: true, rev: 0, data: null });
    return;
  }
  if (url.pathname === '/api/storerev') {
    json(res, 200, { rev: 0 });
    return;
  }
  if (url.pathname === '/api/ggufs') {
    json(res, 200, { ok: true, activeEngine: '/engines/ds4', ggufs: [{
      file: 'gguf/DeepSeek-V4-Flash-test.gguf',
      path: 'gguf/DeepSeek-V4-Flash-test.gguf',
      engineDir: '/engines/ds4', branch: 'main', size: 87_000_000_000,
      activeEngine: true,
    }] });
    return;
  }
  if (url.pathname === '/api/engine/checkouts') {
    json(res, 200, { ok: true, checkouts: [] });
    return;
  }
  if (url.pathname === '/api/doctor') {
    json(res, 200, { ok: true, issues: [], checks: [] });
    return;
  }
  if (url.pathname === '/api/diagnostics') {
    json(res, 200, { ok: true, tasks: [], recentLogs: [] });
    return;
  }
  if (url.pathname === '/api/updates/check') {
    json(res, 200, { ok: true, sections: [], tasks: [] });
    return;
  }
  if (url.pathname === '/api/remote/status') {
    json(res, 200, { ok: true, enabled: false });
    return;
  }
  if (url.pathname === '/api/lan-client/chats') {
    json(res, 200, { ok: true, chats: [] });
    return;
  }
  if (url.pathname === '/api/embed/stop' && req.method === 'POST') {
    requestOrder.push('embed-stop');
    json(res, 200, { ok: true, stopped: true });
    return;
  }
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    requestOrder.push('engine-stop');
    engineRunning = false;
    engineStarting = false;
    json(res, 200, { ok: true, running: false });
    return;
  }
  if (url.pathname === '/api/start' && req.method === 'POST') {
    requestOrder.push('engine-start');
    await readBody(req);
    engineRunning = false;
    engineStarting = true;
    engineReadyAt = Date.now() + 650;
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/video/status') {
    json(res, 200, {
      ok: true, supported: true, installed: true,
      downloadedBytes: 53924785072, totalBytes: 53924785072,
      nativeInstalled: true, encoder: 'official',
      model: 'MiniMaxAI/MiniMax-H3', runtime: 'h3.c/Metal',
    });
    return;
  }
  if (url.pathname === '/api/video/progress') {
    const states = [
      { stage: 'download', label: 'Checking local open weights…', progress: 18 },
      { stage: 'model-load', label: 'Loading H3 into unified memory…', progress: 67 },
      { stage: 'conditioning', label: 'Encoding the prompt on Apple Metal…', progress: 68 },
      { stage: 'sampling', label: 'Sampling H3 on Apple Metal · 5/20 steps complete…',
        progress: 76, step: 5, totalSteps: 20, etaSeconds: 180 },
    ];
    const state = states[Math.min(progressReads++, states.length - 1)];
    progressStages.push(state.stage);
    json(res, 200, { ok: true, state: 'running', ...state });
    return;
  }
  if (url.pathname === '/api/video/generate' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!generationBody) generationBody = body;
    else if (!pipelineGenerationBody) pipelineGenerationBody = body;
    else if (!directGenerationBody) directGenerationBody = body;
    else directFrameGenerationBody = body;
    requestOrder.push('video-generate');
    await new Promise((resolve) => setTimeout(resolve, 3200));
    json(res, 200, {
      ok: true,
      id: body.job,
      filename: 'minimax-h3-test.mp4',
      model: 'MiniMaxAI/MiniMax-H3',
      profile: body.profile,
      url: `/api/video/file?id=${encodeURIComponent(body.job)}&name=minimax-h3-test.mp4`,
    });
    return;
  }
  if (url.pathname === '/api/video/file') {
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': testVideo.length,
      'accept-ranges': 'bytes',
    });
    res.end(testVideo);
    return;
  }
  if (url.pathname === '/api/video/stop' && req.method === 'POST') {
    requestOrder.push('video-stop');
    json(res, 200, { ok: true, running: false });
    return;
  }
  if (url.pathname === '/api/image/progress') {
    json(res, 200, {
      ok: true, state: 'running', stage: 'sampling',
      label: 'Generating the Ideogram opening frame…', progress: 60,
    });
    return;
  }
  if (url.pathname === '/api/image/generate' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!imageGenerationBody) imageGenerationBody = body;
    else cancelledImageGenerationBody = body;
    requestOrder.push('image-generate');
    assert.equal(engineRunning, false, 'the chat model must remain stopped while Ideogram creates the H3 frame');
    if (holdNextImageGeneration) {
      holdNextImageGeneration = false;
      await new Promise((resolve) => { releaseHeldImageGeneration = resolve; });
      releaseHeldImageGeneration = null;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (res.destroyed) return;
    json(res, 200, {
      ok: true, id: body.job, filename: 'ideogram-first-frame.png',
      url: `/api/image/file?id=${encodeURIComponent(body.job)}&name=ideogram-first-frame.png`,
    });
    return;
  }
  if (url.pathname === '/api/image/stop' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    imageStopBodies.push(body);
    requestOrder.push('image-stop');
    releaseHeldImageGeneration?.();
    resolveImageStop?.(body);
    resolveImageStop = null;
    json(res, 200, { ok: true, running: false, id: body.job });
    return;
  }
  if (url.pathname === '/api/image/file') {
    requestOrder.push('image-file');
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': testImage.length,
    });
    res.end(testImage);
    return;
  }
  if (url.pathname === '/v1/models') {
    json(res, 200, { data: [{ id: 'deepseek-v4-flash', context_length: 65536 }] });
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    requestOrder.push('chat');
    chatRequests++;
    assert.equal(engineRunning, true, 'chat must wait until the local engine reports ready');
    const payload = JSON.parse(await readBody(req) || '{}');
    assert.equal(payload.stream, true, 'video routing should begin as a normal local SSE chat');
    const directive = chatRequests === 1 ? [
          'Avvio la generazione locale con il modello open-weight.',
          '```dstudio-video',
          JSON.stringify({
            prompt: 'A paper boat crossing a rain puddle; synchronized rain and soft piano.',
            duration: null,
            aspect: null,
            useFirstFrame: false,
          }),
          '```',
        ].join('\n') : chatRequests === 2
      ? 'Motore locale ripristinato.'
      : chatRequests === 5
      ? 'Ripresa completata dopo l’interruzione.'
      : [
          'Creo prima il frame con Ideogram e poi lo animo localmente.',
          '```dstudio-video',
          JSON.stringify({
            prompt: 'The paper boat begins to move across the puddle; cinematic tracking shot and synchronized rain.',
            duration: 5,
            aspect: '16:9',
            useFirstFrame: false,
            firstFramePrompt: 'A cinematic still image of a small paper boat resting in a rain puddle at sunset.',
          }),
          '```',
        ].join('\n');
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: directive }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: 20, total_tokens: 45 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(events);
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  const file = url.pathname === '/' ? path.join(webRoot, 'index.html') : path.join(webRoot, url.pathname);
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let browser;
try {
  browser = await chromium.launch();
} catch {
  server.close();
  console.log('ui_video_generation_playwright_test: browser missing, skipping');
  process.exit(0);
}

try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
  page.on('request', (request) => {
    const target = new URL(request.url());
    if (target.hostname !== '127.0.0.1') externalRequests.push(request.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem('ds4web.settings.v2', JSON.stringify({
      v: 2, onboarded: true, theme: 'dark', baseUrl: '', chatBackend: 'local',
      model: 'deepseek-v4-flash', modelVariant: 'flash', thinkLevel: 'off',
      qualityDefaultsVersion: 1,
      ctxSize: 65536, enginePower: 90, ssdStreaming: 'auto', webMode: 'off',
      videoLicenseAccepted: true, videoEncoder: 'official',
      videoProfile: 'preview', videoDuration: 8, videoAspect: '9:16',
    }));
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-settings').click();
  await page.locator('#set-nav [data-pane="video"]').click();
  await page.locator('#set-video-status').filter({ hasText: 'Ready:' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#set-video-license').isChecked(), true);
  assert.equal(await page.locator('#set-video-profile').inputValue(), 'preview');
  assert.equal(await page.locator('#set-video-duration').inputValue(), '8');
  assert.equal(await page.locator('#set-video-aspect').inputValue(), '9:16');
  await page.locator('#set-close').click();

  await page.locator('#composer-input').fill('Crea un video di una barchetta di carta sotto la pioggia.');
  await page.locator('#btn-send').click();

  const progress = page.locator('.msg-video-generation');
  await progress.waitFor({ state: 'visible', timeout: 15000 });
  assert.match(await progress.textContent() || '', /H3|open weights|unified memory|video/i);

  const card = page.locator('.msg-generated-video');
  await card.waitFor({ state: 'visible', timeout: 20000 });
  const player = card.locator('video');
  assert.equal(await player.getAttribute('controls'), '', 'the generated H3 result needs native playback controls');
  assert.match(await player.getAttribute('src') || '', /^\/api\/video\/file\?/);
  const download = card.locator('.msg-generated-video__download');
  assert.match(await download.getAttribute('href') || '', /^\/api\/video\/file\?/);
  assert.equal(await download.getAttribute('download'), 'minimax-h3-test.mp4');
  assert.match(await card.textContent() || '', /MiniMax H3.*8s.*9:16.*preview profile.*local open weights/s);

  assert.ok(generationBody, 'the local H3 endpoint must receive a generation request');
  assert.equal(generationBody.duration, 8, 'saved duration applies when the model leaves duration unspecified');
  assert.equal(generationBody.aspect, '9:16', 'saved aspect applies when the model leaves aspect unspecified');
  assert.equal(generationBody.profile, 'preview', 'saved render profile must reach the local worker');
  assert.equal(generationBody.encoder, 'official');
  assert.equal(generationBody.licenseAccepted, true);
  assert.equal('image' in generationBody, false, 'text-to-video should not invent a first frame');

  const chatIndex = requestOrder.indexOf('chat');
  const releaseEmbed = requestOrder.indexOf('embed-stop', chatIndex + 1);
  const stopIndex = requestOrder.indexOf('engine-stop', releaseEmbed + 1);
  const generateIndex = requestOrder.indexOf('video-generate', stopIndex + 1);
  const restartIndex = requestOrder.indexOf('engine-start', generateIndex + 1);
  assert.ok(chatIndex >= 0 && releaseEmbed > chatIndex &&
    stopIndex > releaseEmbed && generateIndex > stopIndex && restartIndex > generateIndex,
  `memory handoff order is wrong: ${JSON.stringify(requestOrder)}`);
  assert.ok(progressStages.includes('model-load') && progressStages.includes('sampling'),
    `H3 progress stages were not surfaced: ${JSON.stringify(progressStages)}`);

  const assistantText = await page.locator('.msg--assistant .msg__content').last().textContent() || '';
  assert.doesNotMatch(assistantText, /dstudio-video|"useFirstFrame"/,
    'the private video routing directive must not leak into the transcript');
  assert.equal(externalRequests.some((url) => /api\.minimax\.io/i.test(url)), false,
    `generation must stay local: ${JSON.stringify(externalRequests)}`);

  engineRunning = false;
  engineStarting = false;
  requestOrder.push('test-engine-down');
  await page.locator('#composer-input').fill('Rispondi dopo il ripristino del motore.');
  await page.locator('#btn-send').click();
  const recoveredReply = page.locator('.msg--assistant .msg__content').last();
  await recoveredReply.filter({ hasText: 'Motore locale ripristinato.' }).waitFor({ state: 'visible', timeout: 10000 });
  const downIndex = requestOrder.lastIndexOf('test-engine-down');
  const recoveryStart = requestOrder.indexOf('engine-start', downIndex + 1);
  const recoveredChat = requestOrder.indexOf('chat', recoveryStart + 1);
  assert.ok(recoveryStart > downIndex && recoveredChat > recoveryStart,
    `a stopped local engine must restart before chat: ${JSON.stringify(requestOrder)}`);

  const pipelineStart = requestOrder.length;
  await page.locator('#composer-input').fill(
    'Prima crea una barchetta nella pozzanghera con il generatore locale, poi usa quell’immagine come primo frame del video.',
  );
  await page.locator('#btn-send').click();
  const pipelineReply = page.locator('.msg--assistant').last();
  await pipelineReply.locator('.msg-generated-image').waitFor({ state: 'visible', timeout: 15000 });
  await pipelineReply.locator('.msg-generated-video').waitFor({ state: 'visible', timeout: 20000 });

  assert.ok(imageGenerationBody, 'the direct Ideogram pipeline must receive the generated-first-frame request');
  assert.equal(imageGenerationBody.action, 'generate');
  assert.match(imageGenerationBody.prompt, /paper boat.*rain puddle/i);
  assert.ok(pipelineGenerationBody, 'H3 must receive the chained video request');
  assert.match(pipelineGenerationBody.image || '', /^data:image\/png;base64,/, 'the Ideogram PNG must become H3 first-frame data');
  assert.equal(pipelineGenerationBody.duration, 5);
  assert.equal(pipelineGenerationBody.aspect, '16:9');

  const pipelineEvents = requestOrder.slice(pipelineStart);
  const pipelineStop = pipelineEvents.indexOf('engine-stop');
  const imageGenerate = pipelineEvents.indexOf('image-generate');
  const imageRead = pipelineEvents.indexOf('image-file', imageGenerate + 1);
  const h3Generate = pipelineEvents.indexOf('video-generate', imageRead + 1);
  const pipelineRestart = pipelineEvents.indexOf('engine-start', h3Generate + 1);
  assert.ok(pipelineStop >= 0 && imageGenerate > pipelineStop && imageRead > imageGenerate &&
    h3Generate > imageRead && pipelineRestart > h3Generate,
  `Ideogram → H3 pipeline order is wrong: ${JSON.stringify(pipelineEvents)}`);
  assert.equal(pipelineEvents.filter((event) => event === 'engine-stop').length, 1,
    'the chat model should be released only once for the full image → H3 pipeline');
  assert.equal(pipelineEvents.filter((event) => event === 'engine-start').length, 1,
    'the chat model should be restored only after both media stages complete');

  const pipelineText = await pipelineReply.locator('.msg__content').textContent() || '';
  assert.doesNotMatch(pipelineText, /dstudio-video|firstFramePrompt/,
    'the chained media directive must stay private');

  // H3 is also a first-class composer target. Selecting it must skip the
  // formatting-only Chat request, preserve the raw Context-IR prompt, and use
  // explicit duration/aspect values from that prompt.
  await page.locator('#cbar-model .cbar-model-btn').click();
  const h3Option = page.locator('#cbar-model .cbar-model-item').filter({ hasText: 'MiniMax H3' });
  await h3Option.waitFor({ state: 'visible', timeout: 10000 });
  await h3Option.click();
  await page.locator('#cbar-model .cbar-model-btn').filter({ hasText: 'MiniMax H3 · video' }).waitFor();
  assert.match(await page.locator('#composer-input').getAttribute('placeholder') || '', /Scene.*Action.*Camera.*Look.*Audio/);

  await page.locator('#cbar-model .cbar-model-btn').click();
  await page.locator('.h3-prompt-template').click();
  assert.equal(await page.locator('#composer-input').inputValue(), [
    'Scene: ', 'Action: ', 'Camera: ', 'Look: ', 'Audio: ',
  ].join('\n'));

  const directPrompt = [
    'Scene: a single red fox in a snowy pine forest for 10 seconds, 4:3.',
    'Action: the fox walks left to right and looks at the camera once.',
    'Camera: stable medium-height lateral tracking shot, 50 mm lens.',
    'Look: photorealistic fur, cold dawn light and a warm rim light.',
    'Audio: soft footsteps in snow and light wind, no music.',
  ].join('\n');
  const directChatRequests = chatRequests;
  const cardCountBeforeDirect = await page.locator('.msg-generated-video').count();
  await page.locator('#composer-input').fill(directPrompt);
  await page.locator('#btn-send').click();
  await page.waitForFunction((count) => document.querySelectorAll('.msg-generated-video').length > count,
    cardCountBeforeDirect, { timeout: 20000 });
  assert.ok(directGenerationBody, 'selecting H3 in the model picker must invoke the video endpoint');
  assert.equal(directGenerationBody.prompt, directPrompt, 'direct H3 mode must preserve the upstream-style prompt verbatim');
  assert.equal(directGenerationBody.duration, 10, 'direct H3 mode should recognize an explicit duration');
  assert.equal(directGenerationBody.aspect, '4:3', 'direct H3 mode should recognize an explicit aspect ratio');
  assert.equal('image' in directGenerationBody, false);
  assert.equal(chatRequests, directChatRequests, 'direct H3 mode must not call the Chat model first');

  // An image attached while H3 is selected is sent directly as --first-frame;
  // no secondary visual model is involved.
  await page.locator('#chat-file-input').setInputFiles({
    name: 'opening-frame.png', mimeType: 'image/png', buffer: testImage,
  });
  await page.locator('.composer__file').waitFor({ state: 'visible' });
  const cardCountBeforeFrame = await page.locator('.msg-generated-video').count();
  await page.locator('#composer-input').fill('The camera moves slowly around the subject. Audio: quiet forest ambience.');
  await page.locator('#btn-send').click();
  await page.waitForFunction((count) => document.querySelectorAll('.msg-generated-video').length > count,
    cardCountBeforeFrame, { timeout: 20000 });
  assert.ok(directFrameGenerationBody, 'H3 opening-frame mode must reach the video endpoint');
  assert.match(directFrameGenerationBody.image || '', /^data:image\/png;base64,/,
    'the attached PNG must become native H3 first-frame data');
  assert.equal(directFrameGenerationBody.duration, 8, 'saved duration should apply without an explicit value');
  assert.equal(directFrameGenerationBody.aspect, '9:16', 'saved aspect should apply without an explicit value');
  assert.equal(chatRequests, directChatRequests, 'opening-frame H3 mode must also bypass Chat routing');

  // Return to the text-only Chat model before exercising its attachment guard.
  await page.locator('#cbar-model .cbar-model-btn').click();
  const chatModelOption = page.locator('#cbar-model .cbar-model-item').filter({ hasText: 'DeepSeek V4 Flash' });
  await chatModelOption.waitFor({ state: 'visible', timeout: 10000 });
  await chatModelOption.click();
  await page.locator('#cbar-model .cbar-model-btn').filter({ hasText: 'Flash' }).waitFor();
  await page.locator('#btn-new-chat').click();

  // Stopping during the generated-first-frame stage must cancel that exact
  // image worker, must never start H3, and must leave Chat usable afterwards.
  const cancelStart = requestOrder.length;
  const generatedVideoCountBeforeCancel = await page.locator('.msg-generated-video').count();
  holdNextImageGeneration = true;
  const imageStopped = new Promise((resolve) => { resolveImageStop = resolve; });
  const heldImageRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname === '/api/image/generate');
  await page.locator('#composer-input').fill(
    'Create a still image first, then animate it; I may stop while the opening frame is rendering.',
  );
  await page.locator('#btn-send').click();
  await heldImageRequest;
  await page.locator('#btn-stop').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#btn-stop').click();
  const stoppedImageBody = await Promise.race([
    imageStopped,
    new Promise((_, reject) => setTimeout(() => reject(new Error('image stop endpoint was not called')), 10000)),
  ]);
  const cancelledReply = page.locator('.msg--assistant .msg__content').last();
  await cancelledReply.filter({ hasText: 'Video generation cancelled.' })
    .waitFor({ state: 'visible', timeout: 15000 });
  assert.ok(cancelledImageGenerationBody?.job, 'the interrupted image request must carry a stable job id');
  assert.equal(stoppedImageBody.job, cancelledImageGenerationBody.job,
    'Stop must target the exact image job created by this UI request');
  assert.equal(imageStopBodies.filter((body) => body.job === cancelledImageGenerationBody.job).length, 1,
    'the interrupted image worker must receive exactly one stop request');
  assert.equal(requestOrder.slice(cancelStart).includes('video-generate'), false,
    'H3 must not start after its opening-frame image was interrupted');
  assert.equal(await page.locator('.msg-generated-video').count(), generatedVideoCountBeforeCancel,
    'an interrupted opening-frame stage must not create a partial video card');

  await page.locator('#composer-input').fill('Confirm that Chat resumed after the interrupted media job.');
  await page.locator('#btn-send').click();
  await page.locator('.msg--assistant .msg__content').last()
    .filter({ hasText: 'Ripresa completata dopo l’interruzione.' })
    .waitFor({ state: 'visible', timeout: 10000 });

  const chatsBeforeImageGuard = chatRequests;
  await page.locator('#chat-file-input').setInputFiles({
    name: 'edit-source.png', mimeType: 'image/png', buffer: testImage,
  });
  await page.locator('.composer__file').waitFor({ state: 'visible' });
  await page.locator('#composer-input').fill('Edit this image and make the background blue.');
  const userCountBeforeImageGuard = await page.locator('.msg--user').count();
  assert.equal(await page.locator('#btn-send').isEnabled(), true,
    'the text-only attachment guard must be reachable');
  await page.locator('#btn-send').click();
  await page.locator('.toast').filter({ hasText: 'This model is text-only' })
    .waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.locator('.msg--user').count(), userCountBeforeImageGuard,
    'a text-only model must retain the unsent image request');
  assert.equal(chatRequests, chatsBeforeImageGuard,
    'a rejected image attachment must not call the text-only chat model');

  assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors, null, 2)}`);
  console.log('ui_video_generation_playwright_test: ok');
} finally {
  await browser.close().catch(() => {});
  server.close();
}
