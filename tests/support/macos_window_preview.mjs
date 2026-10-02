// Bounded native UI fixture for OS drag/visual inspection; all APIs simulated.
// Usage: node .../macos_window_preview.mjs NATIVE_TEST_BINARY HTTP_DOCUMENT_FIXTURE
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { artifactRunDir } from './real_harness.mjs';
import { uiMockServer, jsonReply } from './ui_mock_server.mjs';

assert.equal(process.platform, 'darwin', 'actual Cocoa preview requires macOS');
const binary = path.resolve(process.argv[2]);
const document = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const dir = artifactRunDir('native-window-preview');
const bundle = path.join(dir, 'DStudio Window Test.app');
const executable = path.join(bundle, 'Contents/MacOS/window-test');
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.copyFileSync(binary, executable); fs.chmodSync(executable, 0o755);
fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.ds4.DStudioWindowTest.${path.basename(dir)}</string>
<key>CFBundleExecutable</key><string>window-test</string><key>CFBundleName</key><string>DStudio Window Test</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
const seed = { image: 'data:image/png;base64,' + fs.readFileSync('tests/fixtures/ui-images/image-1.png').toString('base64'),
  storage: {
    'ds4web.settings.v2': { v: 2, onboarded: true, theme: 'dark', baseUrl: '', chatBackend: 'local',
      model: 'deepseek-v4-flash', modelVariant: 'flash', thinkLevel: 'off', qualityDefaultsVersion: 1,
      modelGguf: 'gguf/DeepSeek-V4-Flash-Vision-Exp-test.gguf', ctxSize: 65536, enginePower: 100, webMode: 'off' },
    'ds4web.chats.v2': { v: 2, deleted: [], chats: [{ id: 'native-fixture', mode: 'chat', title: 'Native window test',
      createdAt: Date.now(), updatedAt: Date.now(), messages: [
        { id: 'native-user', role: 'user', content: 'Verifica la barra e la selezione.' },
        { id: 'native-answer', role: 'assistant', content: 'Questa è una finestra di prova con risposte simulate.\n\nPuoi selezionare questo testo senza spostare la finestra.' },
      ] }] },
    'ds4web.active.v2': { v: 2, ids: { chat: 'native-fixture' } },
  } };
const seedFile = path.join(dir, 'seed.json'); fs.writeFileSync(seedFile, JSON.stringify(seed));
const server = await uiMockServer((req, res, url) => {
  if (url.pathname !== '/api/updates/check') return false;
  jsonReply(res, { ok: true, sections: [] }); return true;
}, { document });
const log = fs.openSync(path.join(dir, 'native.log'), 'wx');
console.log(`Preview bundle: ${bundle}\nEvidence: ${dir}`);
const child = spawn(executable, ['--preview', server.origin, path.join(dir, 'window.json'), seedFile],
  { stdio: ['ignore', log, log] }); fs.closeSync(log);
const exit = await new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error: error.message })); });
server.close();
fs.writeFileSync(path.join(dir, 'http.json'), JSON.stringify({ scope: 'Simulated runtime; no engine', requests: server.requests, missing: server.missing, exit }, null, 2));
assert.equal(exit.code, 0, 'native fixture must complete');
const window = JSON.parse(fs.readFileSync(path.join(dir, 'window.json'), 'utf8'));
assert.equal(window.nativeBlobImageDecoded, true);
assert.ok(window.moves.length > 0 && window.currentFrame !== window.initialFrame, 'OS drag must actually move the window');
assert.deepEqual(server.missing, []);
console.log('Native OS drag and WKWebView image decoding: PASS');
