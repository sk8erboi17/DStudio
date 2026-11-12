// A real image from the local media model through the app (usage case
// design/real-image-or-video-pixels, image half). The production host runs
// its /api/image/generate pipeline (Ideogram 4 for a new image) on the
// installed model; the result is fetched from /api/image/file and decoded and
// drawn by a real browser on the host's own origin, where its pixels must not
// be uniform and its size must follow the requested aspect ratio. A Chat
// model's dstudio-image directive and the Chat message rendering are not part
// of this check; video (MiniMax H3) is not either.
//
// Usage: node tests/live/media_image_live.mjs [tests/.build/dstudio-server-test]
// The model is read from ~/.dstudio/ideogram4 (DSTUDIO_IDEOGRAM4_HOME); the job
// itself runs in the test host's private HOME. No wall-clock cutoff; refuses
// beside another engine. Receipts: tests/.artifacts/media-image-live/run-*/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { artifactRunDir, csrfHeaders, jsonFetch, safeReadTail, startDStudio } from '../support/real_harness.mjs';
import { contamination, preflight } from '../support/heavy_preflight.mjs';

const realHome = process.env.DSTUDIO_REAL_HOME || os.homedir();
const modelHome = process.env.DSTUDIO_IDEOGRAM4_HOME || path.join(realHome, '.dstudio', 'ideogram4');
const run = artifactRunDir('media-image-live');
const request = { action: 'generate', prompt: 'A red bicycle leaning against a white brick wall, daylight photograph.',
  aspect: '1:1', preset: 'low', preserve: 'none', job: `image-live-${crypto.randomBytes(4).toString('hex')}` };
const receipt = { schema: 1, purpose: 'local image generation through the host, decoded by a browser', request,
  modelHome: path.basename(modelHome), started: new Date().toISOString(), status: 'running', failures: [] };
const save = () => fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
save();

const before = preflight({ dir: run });
receipt.preflight = { ok: before.ok, reasons: before.reasons };
let server = null, browser = null;
try {
  if (!before.ok) throw Object.assign(new Error(before.reasons.join('; ')), { blocked: true });
  if (!fs.existsSync(modelHome)) throw Object.assign(new Error(`no Ideogram 4 installation at ${modelHome}`), { blocked: true });
  server = await startDStudio({ binaryArg: process.argv[2], label: 'media-image', env: { DSTUDIO_IDEOGRAM4_HOME: modelHome } });
  const t0 = performance.now();
  const result = await jsonFetch(server.baseUrl, '/api/image/generate', { method: 'POST', headers: csrfHeaders, timeoutMs: 0,
    body: JSON.stringify(request) }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  receipt.seconds = (performance.now() - t0) / 1000;
  receipt.result = result; save();
  if (!result.ok || !result.url) throw new Error(`generation failed: ${String(result.error || result.log || JSON.stringify(result)).slice(0, 600)}`);
  const bytes = Buffer.from(await (await fetch(server.baseUrl + result.url)).arrayBuffer());
  fs.writeFileSync(path.join(run, 'image.png'), bytes);
  receipt.file = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    png: bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) };
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(server.baseUrl + '/api/status');
  receipt.decoded = await page.evaluate(async (url) => {
    const img = new Image(); img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0, sum = 0, sq = 0;
    for (let i = 0; i < data.length; i += 4 * 97) { const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++; sum += y; sq += y * y; }
    const mean = sum / n;
    return { width: img.naturalWidth, height: img.naturalHeight, samples: n, meanLuma: mean, stdLuma: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
  }, result.url);
  if (!receipt.file.png) receipt.failures.push('the file is not a PNG');
  if (!(receipt.decoded.width >= 256 && receipt.decoded.height >= 256)) receipt.failures.push(`image is ${receipt.decoded.width}x${receipt.decoded.height}`);
  if (Math.abs(receipt.decoded.width / receipt.decoded.height - 1) > 0.02) receipt.failures.push('the image does not follow the requested 1:1 aspect ratio');
  if (!(receipt.decoded.stdLuma > 8)) receipt.failures.push(`the pixels are nearly uniform (luma standard deviation ${receipt.decoded.stdLuma.toFixed(2)})`);
  receipt.contamination = contamination(before, preflight({ dir: run }));
  for (const line of receipt.contamination) receipt.failures.push(`contaminated: ${line}`);
  receipt.status = receipt.failures.length ? 'failed' : 'passed';
} catch (error) {
  receipt.status = error.blocked ? 'blocked' : 'failed'; receipt.error = String(error?.stack || error);
} finally {
  await browser?.close();
  if (server?.logPath) fs.writeFileSync(path.join(run, 'host.log'), safeReadTail(server.logPath, 2 * 1024 * 1024));
  await server?.stop();
  receipt.finished = new Date().toISOString(); save();
  console.log(`${receipt.status.toUpperCase()}: ${receipt.failures.join(' | ') || receipt.error?.split('\n')[0] || `${receipt.decoded.width}x${receipt.decoded.height} image in ${receipt.seconds.toFixed(0)} s`} (${path.relative(process.cwd(), run)}/receipt.json)`);
  process.exitCode = receipt.status === 'passed' ? 0 : 1;
}
