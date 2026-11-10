// Resource preflight for sequential real-model runs (PLAN.MD P0).
//
// It measures and records; it never stops or signals a process. The live
// harness that calls it owns the decision to start a model. A foreign engine
// is judged by the memory it actually holds, not by its name alone: an idle
// router without a loaded model is recorded and allowed, a process holding a
// model is a competing heavyweight and blocks the run. A footprint that cannot
// be measured blocks too.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

// Executable basenames of the engines and hosts DStudio can start.
export const ENGINE_COMMAND = /^(?:ds4|ds4-server|ds4-server-pld|ds4-agent|ds4-agent-jsonl|ds4-cowork|ds4-design|llama-server|DStudio|dstudio|dstudio-server-test)$/;
// A process below this holds no model: the smallest supported checkpoint is several GiB.
export const HEAVY_FOOTPRINT_BYTES = 1024 ** 3;
const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

export function parsePs(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const command = match[4].trim();
    const executable = command.split(/\s+/)[0];
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, command, executable });
  }
  return rows;
}

// MLX runs inside Python; identify it by its server module instead of the interpreter name.
export function isEngineProcess(row) {
  const base = row.executable.split('/').pop();
  return ENGINE_COMMAND.test(base) || /\bmlx_lm(?:\.server|\s+server)\b/.test(row.command);
}

export function parseFootprint(text) {
  const match = String(text).match(/Footprint:\s*([0-9.]+)\s*(B|KB|MB|GB|TB)\b/);
  return match ? Math.round(Number(match[1]) * UNITS[match[2]]) : null;
}

function descendants(rows, rootPid) {
  const owned = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); grew = true; }
  }
  return owned;
}

// Pure decision over a process table. `footprintOf(pid)` returns bytes or null.
export function classifyEngines(rows, { ownerPid, footprintOf, heavyBytes = HEAVY_FOOTPRINT_BYTES }) {
  const owned = descendants(rows, ownerPid);
  const foreign = [];
  for (const row of rows) {
    if (!isEngineProcess(row) || owned.has(row.pid)) continue;
    const footprintBytes = footprintOf(row.pid);
    const state = footprintBytes === null ? 'unmeasured' : footprintBytes >= heavyBytes ? 'heavy' : 'idle';
    foreign.push({ pid: row.pid, ppid: row.ppid, command: row.command.slice(0, 400), rssBytes: row.rssBytes, footprintBytes, state });
  }
  const blocking = foreign.filter((row) => row.state !== 'idle');
  return { foreign, blocking,
    reasons: blocking.map((row) => row.state === 'heavy'
      ? `pid ${row.pid} holds ${(row.footprintBytes / 1024 ** 3).toFixed(1)} GiB: ${row.command.slice(0, 120)}`
      : `pid ${row.pid} footprint could not be measured: ${row.command.slice(0, 120)}`) };
}

function measureFootprint(pid) {
  try {
    return parseFootprint(execFileSync('/usr/bin/footprint', [String(pid)], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return null; }
}

export function hostMemory() {
  const out = { totalBytes: os.totalmem() };
  if (process.platform !== 'darwin') return out;
  try {
    const vm = execFileSync('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 5000 });
    const page = Number(vm.match(/page size of (\d+) bytes/)?.[1] || 16384);
    const pages = (label) => Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] || 0) * page;
    Object.assign(out, { freeBytes: pages('Pages free'), inactiveBytes: pages('Pages inactive'), speculativeBytes: pages('Pages speculative'),
      wiredBytes: pages('Pages wired down'), compressorBytes: pages('Pages occupied by compressor') });
    const swap = execFileSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 5000 });
    out.swapUsedBytes = Math.round(Number(swap.match(/used = ([0-9.]+)M/)?.[1] || 0) * 1024 ** 2);
  } catch (error) { out.error = String(error.message); }
  return out;
}

export function diskFreeBytes(dir) {
  const stat = fs.statfsSync(dir);
  return stat.bavail * stat.bsize;
}

// Snapshot taken before a model is started. `ok` is false when a foreign
// process holds a model, a footprint is unknown, or the disk is too full.
export function preflight({ ownerPid = process.pid, dir = process.cwd(), minDiskFreeBytes = 0 } = {}) {
  const table = parsePs(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 ** 2 }));
  const engines = classifyEngines(table, { ownerPid, footprintOf: measureFootprint });
  const freeBytes = diskFreeBytes(dir);
  const reasons = [...engines.reasons];
  if (freeBytes < minDiskFreeBytes) reasons.push(`only ${(freeBytes / 1024 ** 3).toFixed(1)} GiB free on the volume of ${dir}`);
  return { taken: new Date().toISOString(), ok: reasons.length === 0, reasons, foreignEngines: engines.foreign,
    memory: hostMemory(), diskFreeBytes: freeBytes, host: { platform: os.platform(), arch: os.arch(), release: os.release(), cpu: os.cpus()[0]?.model } };
}

// After the run: a foreign engine that appeared or grew into a model while the
// measurement ran shared its memory and GPU. The run stays recorded but is
// marked contaminated instead of being reported as clean evidence.
export function contamination(before, after) {
  const known = new Map(before.foreignEngines.map((row) => [row.pid, row]));
  return after.foreignEngines.filter((row) => row.state !== 'idle')
    .map((row) => `pid ${row.pid} ${known.has(row.pid) ? 'grew' : 'appeared'} during the run (${row.state}): ${row.command.slice(0, 120)}`);
}
