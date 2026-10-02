// A disposable browser origin for direct computer-use exploration. Everything
// is simulated, including persistence, tools and inference. No native app or
// model process is launched. External browser fetches are denied by this
// preview's CSP; the native host's actual CSP has a separate integration test.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { initializeUiFixture } from './ui_mock_server.mjs';
import { streamSeed, uiStreamFixture } from './ui_stream_fixture.mjs';

fs.mkdirSync('tests/.artifacts/ui-interaction', { recursive: true });
const dir = fs.mkdtempSync('tests/.artifacts/ui-interaction/run-');
const source = fs.readFileSync('web/index.html', 'utf8');
const document = { headers: { 'content-type': 'text/html',
  'content-security-policy': "connect-src 'self'; img-src 'self' data: blob:" }, body: '' };
const server = await uiStreamFixture({ speed: 'slow', document });
const init = `(${initializeUiFixture.toString()})(${JSON.stringify({ origin: server.origin, ...streamSeed() })});`;
document.body = source.replace('<head>', '<head><script>' + init + '</script>');
const receipt = { scope: 'Operator-driven browser UI; all inference and tools simulated', origin: server.origin,
  startedAt: new Date().toISOString(), sourceSha256: createHash('sha256').update(source).digest('hex') };
let stopped = false;
let manualChunks = 0;
const commands = createInterface({ input: process.stdin });
const save = () => fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ ...receipt,
  requests: server.requests, missing: server.missing, stream: server.state(), store: server.storeSnapshot() }, null, 2) + '\n');
const stop = reason => {
  if (stopped) return;
  stopped = true; clearInterval(checkpoint); clearTimeout(deadline); commands.close();
  receipt.finishedAt = new Date().toISOString(); receipt.stopReason = reason;
  save(); server.close();
};
const checkpoint = setInterval(save, 1000);
// This is a lifetime limit of the isolated preview, not a production work limit.
const deadline = setTimeout(() => stop('isolated preview lifetime'), 600000);
process.once('SIGINT', () => stop('operator preview closed'));
process.once('SIGTERM', () => stop('operator preview closed'));
// The controller changes only the simulated wire stream. UI actions stay in
// the computer-use browser. Commands and injected bytes are bounded per preview.
commands.on('line', command => {
  if (command === 'pause') server.pause();
  else if (command === 'append' && server.state().working && manualChunks < 16)
    server.append(`Aggiornamento manuale ${++manualChunks}: caffè 🧪 conservato durante la selezione.\n\n`);
  else if (command === 'finish') server.finish();
  else if (command === 'close') return stop('operator preview closed');
  else receipt.commandError = 'Unknown or inadmissible fixture command';
  receipt.manualChunks = manualChunks; save();
});
save(); console.log(JSON.stringify({ origin: server.origin, artifacts: path.resolve(dir) }));
