// Actual product entry points, not replacements built around a generic CLI.
// Each server owns an isolated data/config directory outside this repository,
// so generated projects cannot inherit DStudio's contributor instructions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { freePort, sleep } from './real_harness.mjs';

export const PRODUCT_PINS = {
  openwork: '6c5dfca66a239b65a113fc7c787e5e17de43d59b',
  opendesign: '3d0d15fc55031e8e6cead709491e7b82565c4dee',
};

function identity(repo, product) {
  const revision = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(revision, PRODUCT_PINS[product], 'Comparison source changed; review and pin it explicitly.');
  const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  assert.equal(dirty, '', 'Do not benchmark a silently modified competitor.');
  return { product, revision };
}

function isolatedEnvironment(work, toolBin) {
  const env = {
    PATH: [toolBin, '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    LANG: 'en_US.UTF-8', TMPDIR: os.tmpdir(),
    XDG_CONFIG_HOME: path.join(work, 'config'),
    XDG_DATA_HOME: path.join(work, 'data'),
    XDG_CACHE_HOME: path.join(work, 'cache'),
    XDG_STATE_HOME: path.join(work, 'state'),
    OPENCODE_CONFIG_DIR: path.join(work, 'config', 'opencode'),
    OPENCODE_DB: path.join(work, 'opencode.db'),
  };
  for (const name of ['config', 'data', 'cache', 'state', 'config/opencode'])
    fs.mkdirSync(path.join(work, name), { recursive: true });
  return env;
}

async function launch({ product, repo, toolBin, logDir, args, extraEnv, health }) {
  const provenance = identity(repo, product);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `dstudio-${product}-comparison-`));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${product}.log`);
  const fd = fs.openSync(logPath, 'wx', 0o600);
  const env = { ...isolatedEnvironment(work, toolBin), ...extraEnv(work) };
  const invocation = args({ repo, work, port });
  const child = spawn(invocation[0], invocation.slice(1), {
    cwd: repo, env, detached: true, stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode || spawnError) return;
    const closed = once(child, 'close');
    // Only this process group, never a name-based kill of user applications.
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    await closed; clearTimeout(timer);
  };
  const api = async (route, { method = 'GET', body, headers = {}, timeoutMs = 60000 } = {}) => {
    const response = await fetch(baseUrl + route, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (response.status === 204 && !text) return {};
    let result;
    try { result = JSON.parse(text); } catch { throw new Error(`${product} ${route}: non-JSON HTTP ${response.status}`); }
    if (!response.ok) throw new Error(`${product} ${route}: HTTP ${response.status}: ${JSON.stringify(result).slice(0, 1200)}`);
    return result;
  };
  try {
    let lastError;
    for (let i = 0; i < 180; i++) {
      if (spawnError || child.exitCode !== null || child.signalCode)
        throw new Error(`${product} startup failed; private log: ${logPath}`, { cause: spawnError });
      try {
        const ready = await api(health, { timeoutMs: 1000 });
        return { ...provenance, work, baseUrl, logPath, child, api, stop, ready };
      } catch (error) { lastError = error; }
      await sleep(500);
    }
    throw new Error(`${product} readiness deadline; inspect ${logPath}`, { cause: lastError });
  } catch (error) { await stop(); throw error; }
}

export async function startOpenWork({ repo, toolBin, logDir }) {
  const token = randomBytes(24).toString('hex');
  const hostToken = randomBytes(24).toString('hex');
  const server = await launch({ product: 'openwork', repo, toolBin, logDir, health: '/health',
    args: ({ repo, work, port }) => [path.join(toolBin, 'bun'), path.join(repo, 'apps/server/dist/cli.js'),
      '--host', '127.0.0.1', '--port', String(port), '--workspace', path.join(work, 'workspace'), '--approval', 'auto'],
    extraEnv: work => {
      fs.mkdirSync(path.join(work, 'workspace'));
      return { OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken,
        OPENWORK_SERVER_CONFIG: path.join(work, 'server.json'),
        OPENWORK_DATA_DIR: path.join(work, 'openwork-data'),
        OPENWORK_ENV_STORE: path.join(work, 'env.json'),
        OPENWORK_RUNTIME_DB: path.join(work, 'runtime.sqlite'),
        OPENWORK_MANAGE_OPENCODE: '1', OPENWORK_OPENCODE_BIN: '/opt/homebrew/bin/opencode',
        OPENWORK_MANAGED_OPENCODE_CWD: path.join(work, 'workspace') };
    },
  });
  const api = (route, options = {}) => server.api(route, {
    ...options, headers: { Authorization: `Bearer ${token}`, 'x-openwork-host-token': hostToken, ...options.headers },
  });
  try {
    // The HTTP listener precedes managed-engine startup in OpenWork's CLI.
    // /health alone does not prove the workspace can run an agent.
    for (let i = 0; i < 180; i++) {
      if (server.child.exitCode !== null || server.child.signalCode) throw new Error('OpenWork exited before its managed engine was ready');
      const status = await api('/capabilities');
      if (status?.proxy?.opencode === true) {
        return { ...server, api, workspace: path.join(server.work, 'workspace') };
      }
      await sleep(500);
    }
    throw new Error('OpenWork managed-engine readiness deadline; see private log');
  } catch (error) { await server.stop(); throw error; }
}

export async function startOpenDesign({ repo, toolBin, logDir }) {
  return launch({ product: 'opendesign', repo, toolBin, logDir, health: '/api/daemon/status',
    args: ({ repo, port }) => [path.join(toolBin, 'node'), path.join(repo, 'apps/daemon/dist/cli.js'),
      'daemon', 'start', '--headless', '--host', '127.0.0.1', '--port', String(port)],
    extraEnv: work => ({ OD_DATA_DIR: path.join(work, 'od-data') }),
  });
}
