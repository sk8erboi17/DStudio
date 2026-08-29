import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const outputAt = args.indexOf('--output');
let outputDir = '';
if (outputAt >= 0) {
  outputDir = path.resolve(args[outputAt + 1] || '');
  args.splice(outputAt, 2);
}
const promptAt = args.indexOf('--prompt-file');
let promptFile = '';
if (promptAt >= 0) {
  promptFile = path.resolve(args[promptAt + 1] || '');
  args.splice(promptAt, 2);
}
const requirePassAt = args.indexOf('--require-pass');
const requirePass = requirePassAt >= 0;
if (requirePass) args.splice(requirePassAt, 1);
const images = args;
if (images.length < 1 || images.length > 4) {
  console.error('usage: node tests/vision_qwen38_real_probe.mjs [--output dir] [--prompt-file file] [--require-pass] image.png [image.png ...]');
  process.exit(2);
}

const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasScript = (command, name) =>
  new RegExp(`(?:^|\\s)(?:\\S*/)?${escaped(name)}(?:\\s|$)`).test(command);
const startsExecutable = (command, name) =>
  new RegExp(`^(?:\\S*/)?${escaped(name)}(?:\\s|$)`).test(command);
const realConflict = command => {
  if (startsExecutable(command, 'ds4-design') && /(?:^|\s)--self-test(?:\s|$)/.test(command)) return false;
  return hasScript(command, 'image-route-qwen38.py') || hasScript(command, 'ideogram4-run.py') ||
    hasScript(command, 'hunyuan-image3-edit.py') || hasScript(command, 'h3-run.py') ||
    startsExecutable(command, 'ds4-server') || startsExecutable(command, 'ds4-design');
};
const runningHeavy = () => spawnSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8' })
  .stdout.split('\n')
  .filter(line => {
    if (line.includes('vision_qwen38_real_probe')) return false;
    const parsed = line.match(/^\s*\d+\s+\d+\s+(.*)$/);
    return parsed ? realConflict(parsed[1]) : false;
  });
const before = runningHeavy();
if (before.length) {
  console.error(`Refusing to overlap Qwen3.8 with another heavyweight model:\n${before.join('\n')}`);
  process.exit(3);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dstudio-qwen38-real-'));
const request = path.join(temp, 'request.json');
const mime = file => file.toLowerCase().endsWith('.jpg') || file.toLowerCase().endsWith('.jpeg')
  ? 'image/jpeg' : 'image/png';
const reviewerPrompt = promptFile ? fs.readFileSync(promptFile, 'utf8').trim() : [
  'You are the visual quality reviewer for a finished responsive website.',
  'Inspect every supplied screenshot directly. Identify the page, describe its visual hierarchy and media,',
  'then give 3 concise, concrete improvements. Pay special attention to whether editorial cards need imagery,',
  'whether the hero would benefit from subtle motion, and whether any timeline feels visually under-designed.',
  'End with exactly: VERDICT: PASS or VERDICT: REVISE.',
].join(' ');
const content = [{
  type: 'text',
  text: reviewerPrompt,
}, ...images.map(file => ({
  type: 'image_url',
  image_url: { url: `data:${mime(file)};base64,${fs.readFileSync(file).toString('base64')}` },
}))];
fs.writeFileSync(request, JSON.stringify({
  messages: [{ role: 'user', content }],
  reasoning_effort: 'max',
}));

const time = '/usr/bin/time';
const command = ['/bin/sh', path.join(root, 'scripts/vision-qwen38-run.sh'), '--request', request];
const startedAt = new Date();
const startedMs = Date.now();
const child = spawn(time, ['-l', ...command], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
const caffeine = process.platform === 'darwin' && fs.existsSync('/usr/bin/caffeinate')
  ? spawn('/usr/bin/caffeinate', ['-dimsu', '-w', String(child.pid)], { stdio: 'ignore' })
  : null;
let stdout = '';
let stderr = '';
const overlap = new Set();
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
const monitor = setInterval(() => {
  for (const line of runningHeavy()) overlap.add(line);
}, 1000);
const ended = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
clearInterval(monitor);
if (caffeine && caffeine.exitCode === null) caffeine.kill('SIGTERM');
fs.rmSync(temp, { recursive: true, force: true });
if (overlap.size) {
  console.error(`Heavyweight overlap detected:\n${[...overlap].join('\n')}`);
  process.exit(4);
}
const maxRss = stderr.match(/(\d+)\s+maximum resident set size/);
const peakFootprint = stderr.match(/(\d+)\s+peak memory footprint/);
const jsonLine = stdout.trim().split('\n').findLast(line => line.startsWith('{'));
const response = jsonLine ? JSON.parse(jsonLine) : null;
const answer = response?.choices?.[0]?.message?.content || '';
const verdict = answer.match(/VERDICT:\s*(PASS|REVISE)\s*$/i)?.[1]?.toUpperCase() || null;
const report = {
  ok: ended.code === 0 && (!requirePass || verdict === 'PASS'),
  processOk: ended.code === 0,
  gateRequired: requirePass,
  gatePass: verdict === 'PASS',
  exitCode: ended.code,
  signal: ended.signal,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  elapsedSeconds: (Date.now() - startedMs) / 1000,
  images: images.map(file => path.resolve(file)),
  model: response?.model,
  mlxPeakMemoryGb: response?.peak_memory_gb,
  processMaxRssGiB: maxRss ? Number(maxRss[1]) / 1073741824 : null,
  peakMemoryFootprintGiB: peakFootprint ? Number(peakFootprint[1]) / 1073741824 : null,
  finishReason: response?.choices?.[0]?.finish_reason,
  overlap: false,
  sleepPrevention: caffeine ? 'caffeinate -dimsu while worker is alive' : null,
  verdict,
  answer,
};
if (outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'answer.md'), `${report.answer}\n`);
}
console.log(JSON.stringify({ ...report, answer: report.answer.slice(0, 800), outputDir: outputDir || null }, null, 2));
if (ended.code !== 0) process.exit(ended.code || 1);
if (!report.ok) process.exit(5);
