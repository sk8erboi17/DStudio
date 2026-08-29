import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const designBin = path.join(root, 'ds4', 'ds4-design');
assert.equal(fs.existsSync(designBin), true, 'ds4-design must be built');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-design-chrome-term-'));
const chromePidFile = path.join(tmp, 'chrome.pid');
const chromeProfileFile = path.join(tmp, 'chrome-profile.txt');
const fakeChrome = path.join(tmp, 'fake-chrome.sh');
fs.writeFileSync(fakeChrome, `#!/bin/sh
printf '%s\n' "$$" > "$DS4_TEST_CHROME_PID_FILE"
for arg in "$@"; do
  case "$arg" in
    --user-data-dir=*)
      profile="\${arg#--user-data-dir=}"
      mkdir -p "$profile/Default/Cache"
      printf 'owned renderer state\n' > "$profile/Default/Cache/state"
      printf '%s\n' "$profile" > "$DS4_TEST_CHROME_PROFILE_FILE"
      ;;
  esac
done
trap '' TERM INT HUP
while :; do sleep 10; done
`);
fs.chmodSync(fakeChrome, 0o755);

let child;
let decoy;
let rendererPid = 0;
let rendererProfile = '';

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

const timeout = setTimeout(() => child?.kill('SIGKILL'), 15_000);

try {
  child = spawn(designBin, ['--self-test'], {
    cwd: root,
    env: {
      ...process.env,
      DS4_CHROME: fakeChrome,
      DS4_TEST_CHROME_PID_FILE: chromePidFile,
      DS4_TEST_CHROME_PROFILE_FILE: chromeProfileFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  await Promise.race([
    waitFor(() => fs.existsSync(chromePidFile) && fs.existsSync(chromeProfileFile), 8_000,
      `self-test did not start the renderer\n${stderr}`),
    exitPromise.then((exit) => {
      throw new Error(`self-test exited before starting renderer: ${JSON.stringify(exit)}\n${stderr}`);
    }),
  ]);
  rendererPid = Number.parseInt(fs.readFileSync(chromePidFile, 'utf8'), 10);
  rendererProfile = fs.readFileSync(chromeProfileFile, 'utf8').trim();
  assert.equal(alive(rendererPid), true, 'renderer fixture must be alive before termination');
  assert.match(path.basename(rendererProfile), /^ds4-design-chrome-[A-Za-z0-9]+$/,
    'renderer must report its isolated profile path');
  assert.equal(fs.existsSync(rendererProfile), true,
    'renderer profile must exist before termination');
  assert.equal(fs.existsSync(path.join(rendererProfile, 'Default', 'Cache', 'state')), true,
    'renderer fixture must create nested profile state before termination');

  decoy = spawn('/bin/sh', [
    '-c', 'trap "" TERM INT HUP; while :; do sleep 10; done',
    'ds4-chrome-prefix-decoy', `--user-data-dir=${rendererProfile}-decoy`,
  ], { detached: true, stdio: 'ignore' });
  await waitFor(() => alive(decoy.pid), 2_000,
    'prefix-sharing Chrome decoy did not start');

  child.kill('SIGTERM');
  const exit = await exitPromise;
  assert.deepEqual(exit, { code: 0, signal: null },
    'the Design SIGTERM handler must perform an orderly owned-child shutdown');
  await waitFor(() => !alive(rendererPid), 3_000,
    `renderer PID ${rendererPid} survived ds4-design SIGTERM`);
  await waitFor(() => !fs.existsSync(rendererProfile), 3_000,
    `renderer profile ${rendererProfile} survived ds4-design SIGTERM`);
  assert.equal(alive(decoy.pid), true,
    'cleanup matched a user-data-dir prefix instead of the exact Chrome argument');
  console.log('design_chrome_termination_test: ok');
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (alive(rendererPid)) {
    try { process.kill(-rendererPid, 'SIGKILL'); } catch {}
    try { process.kill(rendererPid, 'SIGKILL'); } catch {}
  }
  if (decoy && alive(decoy.pid)) {
    try { process.kill(-decoy.pid, 'SIGKILL'); } catch {}
    try { process.kill(decoy.pid, 'SIGKILL'); } catch {}
  }
  if (rendererProfile && path.basename(rendererProfile).startsWith('ds4-design-chrome-'))
    fs.rmSync(rendererProfile, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
