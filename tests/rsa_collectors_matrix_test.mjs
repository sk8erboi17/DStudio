import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

try {
  await import('playwright');
} catch {
  console.log('rsa_collectors_matrix_test: playwright missing, skipping');
  process.exit(0);
}

const repoRoot = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-rsa-matrix-'));

const pages = {
  '/spa': `<!doctype html>
<html><head><title>Fixture SPA</title><link rel="stylesheet" href="/spa.css"></head>
<body><div id="root"></div><script src="/spa-app.js"></script></body></html>`,
  '/auth': `<!doctype html>
<html><head><title>Fixture Auth</title></head>
<body><h1>Account Portal</h1><a href="/login">Log in</a><a href="/signup">Create account</a>
<form action="/login" method="post"><input name="email" placeholder="Email"><input name="password" type="password"><button>Sign in</button></form>
<script src="/auth-app.js"></script></body></html>`,
  '/media': `<!doctype html>
<html><head><title>Fixture Media</title></head>
<body><h1>Video archive</h1><video controls src="/media/sample.mp4"></video>
<a href="/download/archive.zip">Download</a><script src="/media-app.js"></script></body></html>`,
};

const scripts = {
  '/spa-app.js': `
    const next = window.__NEXT_DATA__ = { props: {}, page: '/spa' };
    localStorage.setItem('fixture_theme', 'light');
    history.pushState({}, '', '/spa');
    fetch('/api/spa/data').then(r => r.json()).then(() => {});
    ReactDOM.createRoot(document.getElementById('root'));
  `,
  '/auth-app.js': `
    fetch('/api/session').then(r => r.json());
    const oauth = '/auth/oauth/google';
    const billing = '/billing/portal';
  `,
  '/media-app.js': `
    const hlsManifest = 'https://cdn.fixture.local/video/master.m3u8?token=abc&expires=999999';
    const signedMp4 = 'https://assets.fixture.local/object.mp4?X-Amz-Signature=abc&X-Amz-Credential=test';
    fetch('/download/archive.zip');
  `,
  '/spa.css': 'body{font-family:system-ui}',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('User-agent: *\nDisallow: /private\n');
    return;
  }
  if (url.pathname === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end('<urlset><url><loc>/spa</loc></url><url><loc>/auth</loc></url><url><loc>/media</loc></url></urlset>');
    return;
  }
  if (url.pathname === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"name":"Fixture"}');
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/download/')) {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session_hint=anon; Path=/; SameSite=Lax' });
    res.end(JSON.stringify({ ok: true, route: url.pathname }));
    return;
  }
  if (pages[url.pathname]) {
    const headers = { 'content-type': 'text/html' };
    if (url.pathname === '/auth') headers['set-cookie'] = 'session_hint=anon; Path=/; SameSite=Lax';
    res.writeHead(200, headers);
    res.end(pages[url.pathname]);
    return;
  }
  if (scripts[url.pathname]) {
    res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' });
    res.end(scripts[url.pathname]);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function runCompare(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 90_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, error, stdout, stderr, timedOut });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

try {
  const cases = [
    { id: 'spa', path: '/spa', expect: (e) => e.spaSignals.detected && e.frontendSignals.some((s) => s.id === 'react') },
    { id: 'auth', path: '/auth', expect: (e) => e.authSignals.detected },
    { id: 'media', path: '/media', expect: (e) => e.mediaSignals.detected && e.cdnSignals.signed },
  ];
  for (const c of cases) {
    const out = path.join(tmp, c.id);
    const target = `http://127.0.0.1:${port}${c.path}`;
    const run = await runCompare(['extension/rsa/bench/compare.mjs', '--target', target, '--out', out, '--query', 'fixture']);
    assert.equal(run.status, 0, `compare failed for ${c.id} status=${run.status} signal=${run.signal} timedOut=${run.timedOut} error=${run.error?.message || ''}
stdout:
${run.stdout}
stderr:
${run.stderr}`);
    const evidence = JSON.parse(fs.readFileSync(path.join(out, 'new', 'evidence.json'), 'utf8'));
    const collectors = JSON.parse(fs.readFileSync(path.join(out, 'new', 'collectors.json'), 'utf8'));
    const audit = JSON.parse(fs.readFileSync(path.join(out, 'new', 'claim-audit.json'), 'utf8'));
    const gate = JSON.parse(fs.readFileSync(path.join(out, 'new', 'quality-gate.json'), 'utf8'));
    assert.equal(collectors.length >= 10, true, `${c.id} should run broad deterministic collectors`);
    assert.equal(audit.status, 'complete', `${c.id} should write a claim audit`);
    assert.equal(gate.status, 'complete', `${c.id} should write a quality gate`);
    assert.equal(c.expect(evidence), true, `${c.id} expected detector did not fire`);
  }
  console.log('rsa_collectors_matrix_test: ok');
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
