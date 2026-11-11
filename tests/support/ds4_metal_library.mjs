// Offline compile of a ds4 checkout's Metal library, as the engine assembles
// it at startup (ds4_metal.m: the embedded base source, then every file of its
// required_sources list in order). ds4 compiles its shaders at run time, so a
// kernel edit is otherwise only exercised by loading a model. Harness plumbing:
// the engine's own source list is read to build the same input; the evidence
// is the Metal compiler's result.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function decodeCString(literal) {
  return literal.replace(/\\(.)/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === '"' || c === '\\' || c === "'") return c;
    if (c === 't') return '\t';
    throw new Error(`unsupported escape \\${c} in the embedded Metal source`);
  });
}

export function assembleMetalSource(engineDir) {
  const host = fs.readFileSync(path.join(engineDir, 'ds4_metal.m'), 'utf8');
  const start = host.indexOf('static const char *ds4_gpu_source =');
  if (start < 0) throw new Error('ds4_metal.m has no embedded ds4_gpu_source');
  const end = host.indexOf(';\n', start);
  const base = [...host.slice(start, end).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => decodeCString(m[1])).join('');
  const list = host.indexOf('required_sources = @[');
  if (list < 0) throw new Error('ds4_metal.m has no required_sources list');
  const files = [...new Set([...host.slice(list, host.indexOf('];', list)).matchAll(/@"(metal\/[A-Za-z0-9_]+\.metal)"/g)].map(m => m[1]))];
  if (!files.length) throw new Error('empty required_sources list');
  return { files, source: base + files.map(f => fs.readFileSync(path.join(engineDir, f), 'utf8')).join('') };
}

// Returns { status: 'compiled' | 'failed' | 'not-run', ... }. 'not-run' means
// this machine has no Metal compiler (xcrun metal); it is not a pass.
export function compileMetalLibrary(engineDir, workDir) {
  const tool = spawnSync('xcrun', ['-f', 'metal'], { encoding: 'utf8' });
  if (tool.status !== 0) return { status: 'not-run', reason: 'no Metal compiler (xcrun -f metal failed)' };
  const { files, source } = assembleMetalSource(engineDir);
  const input = path.join(workDir, 'ds4-library.metal');
  fs.writeFileSync(input, source);
  const r = spawnSync('xcrun', ['metal', '-c', input, '-o', path.join(workDir, 'ds4-library.air')],
    { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 ** 2 });
  const errors = (r.stderr || '').split('\n').filter(line => /\berror\b/.test(line));
  return { status: r.status === 0 && !errors.length ? 'compiled' : 'failed', files: files.length, errors, output: (r.stderr || '').slice(-4000) };
}
