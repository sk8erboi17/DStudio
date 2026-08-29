import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-pages-release-gate-'));
const local = path.join(temp, 'local');
const remote = path.join(temp, 'remote');
const evidence = path.join(temp, 'evidence');
fs.mkdirSync(local);

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>PHASE / SHIFT</title>
<style>*{box-sizing:border-box}html,body{margin:0;max-width:100%;overflow-x:clip}body{font:18px/1.5 sans-serif;padding:24px}</style>
</head><body><main><h1>PHASE / SHIFT</h1><p>MACHINES THAT REFUSE STILLNESS</p>
<p>14—15 NOVEMBER · Hall 03 · Enter at 20:00</p></main></body></html>`;
fs.writeFileSync(path.join(local, 'index.html'), html);
fs.writeFileSync(path.join(local, 'README.md'), '# Deployment fixture\n');
fs.writeFileSync(path.join(local, 'asset.txt'), 'signed deployment asset\n');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = Object.fromEntries(['index.html', 'README.md', 'asset.txt'].map(relative => [relative, {
  bytes: fs.statSync(path.join(local, relative)).size,
  sha256: sha256(path.join(local, relative)),
}]));
const manifest = {
  schema: 'ds4.design.release.v1', caseId: 'fullstack-kinetic-museum',
  pagesUrl: 'https://example.github.io/phase-shift/', benchmarkPass: true,
  toolCompliance: true, elapsedMs: 1000, generatedAt: '2026-08-27T00:00:00.000Z', files,
};
fs.writeFileSync(path.join(local, 'RELEASE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.cpSync(local, remote, { recursive: true });

const serverCode = String.raw`
const fs=require('fs'),http=require('http'),path=require('path');
const root=process.env.DS4_PAGES_ROOT;
const mime={'.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
const server=http.createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
  const relative=pathname==='/'?'index.html':pathname.replace(/^\/+/, '');
  const file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}
  const stat=fs.statSync(file,{throwIfNoEntry:false});
  if(!stat?.isFile()){res.writeHead(404).end();return}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':stat.size});
  fs.createReadStream(file).pipe(res);
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\n'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;

let server;
try {
  server = spawn(process.execPath, ['-e', serverCode], {
    env: { ...process.env, DS4_PAGES_ROOT: remote },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('fixture server did not start')), 5000);
    server.once('error', reject);
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/^(\d+)\n/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}/`;
  const invoke = (expectFailure = false, destination = evidence) => {
    const result = spawnSync(process.execPath, [
      'tests/design_pages_release_gate.mjs', local, 'fullstack-kinetic-museum', base, destination,
    ], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
      env: {
        ...process.env, DSTUDIO_PAGES_TEST_MODE: '1',
        DSTUDIO_PAGES_TIMEOUT_MS: '750', DSTUDIO_PAGES_POLL_MS: '25',
      },
    });
    if (!expectFailure) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result;
  };

  const passed = invoke();
  assert.match(passed.stdout, /"ok": true/);
  const report = JSON.parse(fs.readFileSync(path.join(evidence, 'pages-release-gate.json'), 'utf8'));
  assert.equal(report.ok, true);
  assert.equal(report.deployed['asset.txt'].sha256, files['asset.txt'].sha256);
  assert.equal(report.views.desktop.scrollWidth, report.views.desktop.clientWidth);
  assert.equal(report.views.mobile.scrollWidth, report.views.mobile.clientWidth);

  fs.writeFileSync(path.join(remote, 'asset.txt'), 'different deployed bytes\n');
  const rejected = invoke(true, path.join(temp, 'negative-evidence'));
  assert.notEqual(rejected.status, 0, 'a deployed asset hash mismatch must fail');
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /deployed (?:byte count|hash) differs: asset\.txt/);

  console.log('design_pages_release_gate_test: ok');
} finally {
  server?.kill('SIGTERM');
  fs.rmSync(temp, { recursive: true, force: true });
}
