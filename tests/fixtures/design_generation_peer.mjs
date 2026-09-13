#!/usr/bin/env node
// Deliberately simulated native Design wire peer. No model, inference or
// generated-project quality is being tested by this fixture.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const mode = process.env.DESIGN_CAPTURE_FIXTURE || 'success';
const workspace = process.env.DESIGN_CAPTURE_WORKSPACE
  || process.argv[process.argv.indexOf('--workspace') + 1];
const event = value => Buffer.from('\x1e' + JSON.stringify(value) + '\n');
const marker = Buffer.from('+DWARFSTAR_WAITING\n');
const write = (fd, bytes) => { for (let offset = 0; offset < bytes.length;)
  offset += fs.writeSync(fd, bytes, offset, bytes.length - offset); };
const pack = '---\nname: Folio\n---\nFixture café 🌿 — entire pack.\n';
let input = Buffer.alloc(0), descendant;
const held = setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  if (mode === 'ignore-term' || mode === 'orphan-pipe') return;
  if (mode === 'drain-on-term') write(1, event({type: 'shutdown_receipt', value: 'drained café 🌿'}));
  if (mode === 'bad-on-term') write(1, Buffer.from('\x1e{invalid-after-idle}\n'));
  if (descendant) descendant.kill('SIGTERM');
  clearInterval(held); process.exit(mode === 'bad-exit' ? 17 : 0);
});
if (mode === 'startup-timeout') { /* intentionally no readiness */ }
else if (mode === 'stdin-closed') {
  fs.closeSync(0); write(2, marker);
} else {
  // Both marker and Unicode JSON can cross arbitrary transport boundaries.
  for (const byte of marker) write(2, Buffer.of(byte));
}
if (mode !== 'stdin-closed') process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  if (input.length > 65536) throw new Error('fixture input overflow');
  if (input.at(-1) !== 10) return;
  fs.writeFileSync(path.join(workspace, 'received.txt'), input);
  if (mode === 'turn-timeout' || mode === 'cancel' || mode === 'ignore-term') return;
  if (mode === 'stdout-limit') { write(1, Buffer.alloc(16384, 120)); return; }
  if (mode === 'stderr-limit') { write(2, Buffer.alloc(16384, 120)); return; }
  if (mode === 'long-line') { write(1, Buffer.alloc(2048, 120)); return; }
  if (mode === 'event-count') {
    for (let i = 0; i < 32; i++) write(1, event({type: 'tick', i}));
    return;
  }
  if (mode === 'event-bytes') {
    for (let i = 0; i < 8; i++) write(1, event({type: 'tick', text: 'x'.repeat(100)}));
    return;
  }
  if (mode === 'incomplete') {
    write(1, Buffer.from('\x1e{"type":"artifact","entry":"index.html"}'));
    process.exit(0);
  }
  if (mode === 'bad-utf8') write(1, Buffer.concat([Buffer.from('\x1e{"type":"bad","x":"'), Buffer.of(0xc3), Buffer.from('"}\n')]));
  if (mode === 'bad-event') write(1, Buffer.from('\x1e{invalid-json}\n'));
  if (mode === 'no-artifact') { write(2, marker); return; }
  if (mode === 'orphan-pipe') {
    descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
      {stdio: ['ignore', 'inherit', 'inherit']});
    fs.writeFileSync(path.join(workspace, 'descendant.json'), JSON.stringify({pid: descendant.pid}));
    return;
  }
  if (mode === 'symlink-entry') {
    const outside=path.join(workspace,'../outside.txt');fs.writeFileSync(outside,'not the deliverable');
    fs.symlinkSync(outside,path.join(workspace,'index.html'));
  } else {
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><title>Fixture café 🌿</title>');
    if (mode === 'oversized-entry') {
      const fd=fs.openSync(path.join(workspace,'index.html'),'r+');fs.ftruncateSync(fd,32*1024*1024+1);fs.closeSync(fd);
    }
  }
  write(1, event({type: 'tool_call', name: 'design_system', input: {name: 'folio'}}));
  const loaded = event({type: 'tool_result', name: 'design_system', output: pack});
  for (const byte of loaded) write(1, Buffer.of(byte));
  if (mode === 'backpressure') for (let i = 0; i < 4096; i++)
    write(1, Buffer.from(`prose ${i} — café 🌿 ${'x'.repeat(500)}\n`));
  write(1, event({type: 'artifact', entry: mode === 'wrong-entry' ? 'different.html' : 'index.html', title: 'Fixture café 🌿'}));
  if (mode === 'quoted-marker') {
    write(2, Buffer.from('Do not treat +DWARFSTAR_WAITING inside a log message as completion\n'));
    return;
  }
  write(2, marker);
  if (mode === 'exit-after-idle') process.exit(0);
});
