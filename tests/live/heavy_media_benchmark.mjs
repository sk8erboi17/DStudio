import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const kindAt = argv.indexOf('--kind');
const outputAt = argv.indexOf('--output');
const separator = argv.indexOf('--');
if (kindAt < 0 || outputAt < 0 || separator < 0 || separator === argv.length - 1) {
  console.error('usage: node tests/live/heavy_media_benchmark.mjs --kind ideogram4|hunyuan-edit|image-pipeline|h3|design --output dir -- command [args...]');
  process.exit(2);
}
const kind = argv[kindAt + 1];
const outputDir = path.resolve(argv[outputAt + 1]);
const command = argv[separator + 1];
const commandArgs = argv.slice(separator + 2);
if (!['ideogram4', 'hunyuan-edit', 'image-pipeline', 'h3', 'design'].includes(kind)) {
  throw new Error(`unsupported benchmark kind: ${kind}`);
}

const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const commandHasScript = (command, name) =>
  new RegExp(`(?:^|\\s)(?:\\S*/)?${escaped(name)}(?:\\s|$)`).test(command);
const commandStartsExecutable = (command, name) =>
  new RegExp(`^(?:\\S*/)?${escaped(name)}(?:\\s|$)`).test(command);
function isRealHeavyConflict(command) {
  // Native Design self-tests do not map a GGUF or start an inference engine.
  if (commandStartsExecutable(command, 'ds4-design') && /(?:^|\s)--self-test(?:\s|$)/.test(command)) return false;
  const ideogram = commandHasScript(command, 'ideogram4-run.py') ||
    /(?:^|\s)\S*ideogram4\S*\/comfyui\/main\.py(?:\s|$)/.test(command);
  const hunyuan = commandHasScript(command, 'hunyuan-image3-edit.py') ||
    commandHasScript(command, 'hunyuan_first_step_probe.py') ||
    commandHasScript(command, 'hunyuan_reasoning_finite_probe.py');
  const h3 = commandHasScript(command, 'h3-run.py');
  const ds4 = commandStartsExecutable(command, 'ds4-server') ||
    commandStartsExecutable(command, 'ds4-design');
  // A router parent without a model is cheap and may stay alive, but each
  // loaded llama.cpp model runs as a child llama-server with an explicit
  // --model or --hf-repo argument. Treat it as a heavyweight conflict even
  // while idle: mapped weights still consume unified-memory headroom and can
  // silently force an image/video render into swap.
  const residentLlamaModel = commandStartsExecutable(command, 'llama-server') &&
    /(?:^|\s)--(?:model|hf-repo)(?:\s|=)/.test(command);
  const own = kind === 'ideogram4' ? ideogram :
    kind === 'hunyuan-edit' ? hunyuan :
    kind === 'image-pipeline' ? (ideogram || hunyuan) :
    kind === 'h3' ? h3 : ds4;
  return !own && (
    ideogram || hunyuan || h3 || ds4 || residentLlamaModel
  );
}
const conflicts = () => spawnSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8' })
  .stdout.split('\n')
  .filter(line => {
    if (line.includes('heavy_media_benchmark')) return false;
    const parsed = line.match(/^\s*\d+\s+\d+\s+(.*)$/);
    return parsed ? isRealHeavyConflict(parsed[1]) : false;
  });

function hostMemory() {
  if (process.platform !== 'darwin') return null;
  const vm = spawnSync('vm_stat', [], { encoding: 'utf8' }).stdout || '';
  const pageSize = Number(vm.match(/page size of (\d+) bytes/)?.[1] || 4096);
  const pages = (label) => Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] || 0);
  const swapText = spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).stdout || '';
  const swapUsedMiB = Number(swapText.match(/used = ([0-9.]+)M/)?.[1] || 0);
  return {
    wiredGiB: pages('Pages wired down') * pageSize / 1073741824,
    freeGiB: pages('Pages free') * pageSize / 1073741824,
    compressorGiB: pages('Pages occupied by compressor') * pageSize / 1073741824,
    swapUsedGiB: swapUsedMiB / 1024,
  };
}
function gpuMemoryGiB() {
  if (process.platform !== 'darwin') return null;
  const ioreg = spawnSync('ioreg', ['-r', '-c', 'AGXAccelerator', '-d', '1'], {
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  }).stdout || '';
  const bytes = Number(ioreg.match(/"In use system memory"=(\d+)/)?.[1] || 0);
  return bytes ? bytes / 1073741824 : null;
}
const before = conflicts();
if (before.length) {
  console.error(`Refusing heavyweight overlap:\n${before.join('\n')}`);
  process.exit(3);
}

fs.mkdirSync(outputDir, { recursive: true });
const startedAt = new Date();
const startedMs = Date.now();
const memoryBefore = hostMemory();
const gpuMemoryBeforeGiB = gpuMemoryGiB();
const child = spawn('/usr/bin/time', ['-l', command, ...commandArgs], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
// Long quality renders must not be invalidated by display/system sleep. The
// sidecar watches the time-wrapper PID and exits by itself with the worker;
// keeping it outside the measured command preserves the worker's rusage.
const caffeine = process.platform === 'darwin' && fs.existsSync('/usr/bin/caffeinate')
  ? spawn('/usr/bin/caffeinate', ['-dimsu', '-w', String(child.pid)], { stdio: 'ignore' })
  : null;
let stdout = '';
let stderr = '';
const overlap = new Set();
let peakWiredGiB = memoryBefore?.wiredGiB ?? null;
let minimumFreeGiB = memoryBefore?.freeGiB ?? null;
let peakSwapUsedGiB = memoryBefore?.swapUsedGiB ?? null;
let peakGpuMemoryGiB = gpuMemoryBeforeGiB;
let monitorTicks = 0;
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
const monitor = setInterval(() => {
  for (const line of conflicts()) overlap.add(line);
  const memory = hostMemory();
  if (!memory) return;
  peakWiredGiB = Math.max(peakWiredGiB ?? memory.wiredGiB, memory.wiredGiB);
  minimumFreeGiB = Math.min(minimumFreeGiB ?? memory.freeGiB, memory.freeGiB);
  peakSwapUsedGiB = Math.max(peakSwapUsedGiB ?? memory.swapUsedGiB, memory.swapUsedGiB);
  monitorTicks++;
  if (monitorTicks % 5 === 0) {
    const gpu = gpuMemoryGiB();
    if (gpu !== null) peakGpuMemoryGiB = Math.max(peakGpuMemoryGiB ?? gpu, gpu);
  }
}, 1000);
const ended = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
clearInterval(monitor);
if (caffeine && caffeine.exitCode === null) caffeine.kill('SIGTERM');

const maxRss = stderr.match(/(\d+)\s+maximum resident set size/);
const peakFootprint = stderr.match(/(\d+)\s+peak memory footprint/);
const memoryAfter = hostMemory();
const gpuMemoryAfterGiB = gpuMemoryGiB();
const report = {
  kind,
  ok: ended.code === 0 && overlap.size === 0,
  exitCode: ended.code,
  signal: ended.signal,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  elapsedSeconds: (Date.now() - startedMs) / 1000,
  processMaxRssGiB: maxRss ? Number(maxRss[1]) / 1073741824 : null,
  peakMemoryFootprintGiB: peakFootprint ? Number(peakFootprint[1]) / 1073741824 : null,
  hostMemory: {
    before: memoryBefore,
    after: memoryAfter,
    peakWiredGiB,
    minimumFreeGiB,
    peakSwapUsedGiB,
    swapGrowthGiB: memoryBefore && memoryAfter
      ? memoryAfter.swapUsedGiB - memoryBefore.swapUsedGiB : null,
    gpuMemoryBeforeGiB,
    gpuMemoryAfterGiB,
    peakGpuMemoryGiB,
  },
  overlap: [...overlap],
  command: [command, ...commandArgs],
  sleepPrevention: caffeine ? 'caffeinate -dimsu while worker is alive' : null,
};
fs.writeFileSync(path.join(outputDir, 'stdout.log'), stdout);
fs.writeFileSync(path.join(outputDir, 'stderr.log'), stderr);
fs.writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(ended.code || 4);
