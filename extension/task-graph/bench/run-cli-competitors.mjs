import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  artifactDir, safeReadTail, startDStudio, startMode, writeArtifact,
} from '../../../tests/real_harness.mjs';
import {
  changeAllowed, changedFiles, createReliabilityFixture, workspaceSnapshot,
} from './reliability-fixture.mjs';

if (process.env.RUN_HEAVY !== '1') {
  console.error('Real Pi/OpenCode benchmark is disabled. Set RUN_HEAVY=1 explicitly.');
  process.exit(2);
}

const artifacts = artifactDir('task-graph-cli-competitors-real');
for (const name of fs.readdirSync(artifacts))
  fs.rmSync(path.join(artifacts, name), { recursive: true, force: true });
const workspace = path.join(artifacts, 'workspace');
const configRoot = path.join(artifacts, 'isolated-cli-config');
fs.mkdirSync(configRoot, { recursive: true });
const caseCount = Math.max(1, Math.min(100,
  Number(process.env.DSTUDIO_RELIABILITY_CASES || 50) || 50));
const maxOutputTokens = Math.max(256, Math.min(4096,
  Number(process.env.DSTUDIO_COMPETITOR_MAX_OUTPUT_TOKENS || 1024) || 1024));
const fixture = createReliabilityFixture({
  workspace,
  caseCount,
  variants: ['pi', 'opencode'],
});
const scenarios = fixture.scenarios;
execFileSync('git', ['init', '--quiet'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['config', 'user.name', 'DStudio Benchmark'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'benchmark@localhost'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['add', '.'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['commit', '--quiet', '-m', 'benchmark fixture'], { cwd: workspace, stdio: 'ignore' });

function rounded(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function commandOutput(command, args, cwd = process.cwd()) {
  try {
    return execFileSync(command, args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function revisionInfo(cwd) {
  return {
    commit: commandOutput('git', ['rev-parse', '--short=12', 'HEAD'], cwd) || 'unknown',
    dirty: Boolean(commandOutput('git', ['status', '--porcelain'], cwd)),
  };
}

function selectModel(ggufs) {
  const requested = process.env.DSTUDIO_TASK_GRAPH_GGUF;
  if (requested) {
    const exact = ggufs.find((item) => item.file === requested || item.file.endsWith(`/${requested}`));
    assert.ok(exact, `DSTUDIO_TASK_GRAPH_GGUF not found: ${requested}`);
    return exact;
  }
  const usable = ggufs.filter((item) => !/DSpark-support|MXFP4|Vision-Encoder|GLM-5\.2/i.test(item.file));
  return usable.find((item) => /DeepSeek-V4-Flash-IQ2XXS.*imatrix/i.test(item.file)) || usable[0];
}

function hardwareInfo() {
  const chip = process.platform === 'darwin'
    ? commandOutput('sysctl', ['-n', 'machdep.cpu.brand_string'])
    : os.cpus()[0]?.model;
  return {
    chip: chip || os.arch(),
    logicalCores: os.cpus().length,
    memoryBytes: os.totalmem(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
  };
}

function cleanEnvironment(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)$/.test(key) ||
        /^(?:AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS)/.test(key) ||
        /^(?:OPENCODE_|PI_CODING_AGENT_|PI_OFFLINE|PI_TELEMETRY)/.test(key)) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

function writeCliConfigs(baseUrl, contextTokens) {
  const piHome = path.join(configRoot, 'pi-home');
  const piDir = path.join(piHome, '.pi', 'agent');
  fs.mkdirSync(piDir, { recursive: true });
  const piConfig = {
    providers: {
      dstudio: {
        baseUrl: `${baseUrl}/v1`,
        api: 'openai-completions',
        apiKey: 'local-benchmark',
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: 'max_tokens',
        },
        models: [{
          id: 'ds4',
          name: 'DeepSeek V4 Flash via DStudio',
          reasoning: false,
          input: ['text'],
          contextWindow: contextTokens,
          maxTokens: Math.min(maxOutputTokens, Math.floor(contextTokens / 2)),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  };
  fs.writeFileSync(path.join(piDir, 'models.json'), `${JSON.stringify(piConfig, null, 2)}\n`);

  const openCodeHome = path.join(configRoot, 'opencode-home');
  const openCodeConfigDir = path.join(openCodeHome, '.config', 'opencode');
  const openCodeData = path.join(openCodeHome, '.local', 'share');
  const openCodeCache = path.join(openCodeHome, '.cache');
  fs.mkdirSync(openCodeConfigDir, { recursive: true });
  fs.mkdirSync(openCodeData, { recursive: true });
  fs.mkdirSync(openCodeCache, { recursive: true });
  const openCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    model: 'dstudio/ds4',
    small_model: 'dstudio/ds4',
    enabled_providers: ['dstudio'],
    autoupdate: false,
    share: 'disabled',
    lsp: false,
    formatter: false,
    mcp: {},
    tools: {
      bash: true,
      read: true,
      edit: true,
      write: true,
      question: false,
      task: false,
      skill: false,
      todowrite: false,
      todoread: false,
      webfetch: false,
      websearch: false,
      codesearch: false,
      glob: false,
      grep: false,
      list: false,
      lsp: false,
      batch: false,
      apply_patch: false,
    },
    experimental: { openTelemetry: false },
    provider: {
      dstudio: {
        npm: '@ai-sdk/openai-compatible',
        name: 'DStudio local benchmark',
        options: {
          baseURL: `${baseUrl}/v1`,
          apiKey: 'local-benchmark',
          timeout: 1_200_000,
          headerTimeout: 1_200_000,
          chunkTimeout: 1_200_000,
        },
        models: {
          ds4: {
            name: 'DeepSeek V4 Flash via DStudio',
            limit: {
              context: contextTokens,
              output: Math.min(maxOutputTokens, Math.floor(contextTokens / 2)),
            },
          },
        },
      },
    },
  };
  const openCodeConfigPath = path.join(openCodeConfigDir, 'opencode.json');
  fs.writeFileSync(openCodeConfigPath, `${JSON.stringify(openCodeConfig, null, 2)}\n`);

  return {
    pi: {
      config: piConfig,
      env: cleanEnvironment({
        HOME: piHome,
        PWD: workspace,
        PI_CODING_AGENT_DIR: piDir,
        PI_OFFLINE: '1',
        PI_TELEMETRY: '0',
      }),
    },
    opencode: {
      config: openCodeConfig,
      env: cleanEnvironment({
        HOME: openCodeHome,
        PWD: workspace,
        XDG_CONFIG_HOME: path.join(openCodeHome, '.config'),
        XDG_DATA_HOME: openCodeData,
        XDG_CACHE_HOME: openCodeCache,
        OPENCODE_CONFIG: openCodeConfigPath,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig),
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_SHARE: '1',
        OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
        OPENCODE_PURE: '1',
      }),
    },
  };
}

async function startModelPinProxy(enginePort) {
  let activeRunId = null;
  const observations = new Map();
  const server = http.createServer((request, response) => {
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length <= 16 * 1024 * 1024) chunks.push(chunk);
    });
    request.on('end', () => {
      if (length > 16 * 1024 * 1024) {
        response.writeHead(413).end('benchmark request too large');
        return;
      }
      let body = Buffer.concat(chunks);
      let payload = null;
      if (body.length) {
        try { payload = JSON.parse(body.toString('utf8')); } catch {}
      }
      const runId = activeRunId;
      const record = {
        path: request.url,
        method: request.method,
        model: typeof payload?.model === 'string' ? payload.model : null,
        toolSchemas: Array.isArray(payload?.tools) ? payload.tools.length : 0,
        stream: payload?.stream === true,
      };
      if (runId) {
        if (!observations.has(runId)) observations.set(runId, []);
        observations.get(runId).push(record);
      }
      if (request.url === '/v1/chat/completions' && record.model !== 'ds4') {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'benchmark model pin rejected a non-ds4 request' } }));
        return;
      }
      // Pi and OpenCode do not expose DS4's vendor-specific `think` switch.
      // Enforce the benchmark's declared thinking=off setting at the local
      // compatibility boundary, just as DStudio passes --no-think to its
      // native Agent runtime.
      if (request.url === '/v1/chat/completions' && payload && typeof payload === 'object') {
        payload.think = false;
        delete payload.reasoning_effort;
        body = Buffer.from(JSON.stringify(payload));
      }
      const headers = { ...request.headers, host: `127.0.0.1:${enginePort}` };
      delete headers['transfer-encoding'];
      headers['content-length'] = String(body.length);
      headers.connection = 'close';
      const upstream = http.request({
        hostname: '127.0.0.1', port: enginePort, path: request.url,
        method: request.method, headers,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', (error) => {
        if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: error.message } }));
      });
      request.on('aborted', () => upstream.destroy());
      if (body.length) upstream.write(body);
      upstream.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    begin(runId) {
      assert.equal(activeRunId, null, 'competitor benchmark runs must remain sequential');
      activeRunId = runId;
      observations.set(runId, []);
    },
    end(runId) {
      assert.equal(activeRunId, runId);
      activeRunId = null;
      return observations.get(runId) || [];
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function terminateProcessTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}

async function runCli(command, args, options) {
  const outputLimit = 32 * 1024 * 1024;
  const startedAt = performance.now();
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    let spawnError = null;
    const append = (target, chunk) => {
      const text = chunk.toString('utf8');
      if (target === 'stdout') stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > outputLimit && !overflow) {
        overflow = true;
        terminateProcessTree(child, 'SIGTERM');
      }
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (error) => { spawnError = error.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, 'SIGTERM');
      setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 5000).unref();
    }, options.timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code, signal, stdout, stderr, timedOut, overflow, spawnError,
        wallClockMs: rounded(performance.now() - startedAt),
      });
    });
  });
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

function canonicalToolCall(harness, event) {
  if (harness === 'pi') {
    return JSON.stringify({ name: event.toolName, input: event.args || {} });
  }
  return JSON.stringify({
    name: event.part?.tool,
    input: event.part?.state?.input || event.part?.state?.metadata?.input || {},
  });
}

function eventText(harness, event) {
  if (harness === 'opencode') return event.type === 'text' ? String(event.part?.text || '') : '';
  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_end')
    return String(event.assistantMessageEvent.content || '');
  if (event.type !== 'message_end' || event.message?.role !== 'assistant') return '';
  if (typeof event.message.content === 'string') return event.message.content;
  if (!Array.isArray(event.message.content)) return '';
  return event.message.content
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text || ''))
    .join('\n');
}

function analyzeEvents(harness, stdout, expected) {
  const events = parseEvents(stdout);
  const completedTools = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => harness === 'pi'
      ? event.type === 'tool_execution_end'
      : event.type === 'tool_use' && ['completed', 'error'].includes(event.part?.state?.status));
  const lastToolIndex = completedTools.at(-1)?.index ?? -1;
  const answerIndex = events.findIndex((event, index) =>
    index > lastToolIndex && eventText(harness, event).includes(expected));
  let previous = '';
  let repeated = 0;
  let maximumRepeated = 0;
  for (const { event } of completedTools) {
    const canonical = canonicalToolCall(harness, event);
    repeated = canonical === previous ? repeated + 1 : 1;
    previous = canonical;
    maximumRepeated = Math.max(maximumRepeated, repeated);
  }
  return {
    parsedEvents: events.length,
    calls: completedTools.length,
    maximumRepeated,
    answerAfterTool: lastToolIndex >= 0 && answerIndex > lastToolIndex,
  };
}

function commandFor(harness, prompt, scenarioId, environments) {
  if (harness === 'pi') {
    return {
      command: 'pi',
      args: [
        '--print', '--mode', 'json', '--provider', 'dstudio', '--model', 'ds4',
        '--api-key', 'local-benchmark', '--thinking', 'off', '--no-session',
        '--tools', 'read,bash,edit,write', '--no-extensions', '--no-skills',
        '--no-prompt-templates', '--no-context-files', '--approve', '--offline', prompt,
      ],
      env: environments.pi.env,
    };
  }
  return {
    command: 'opencode',
    args: [
      'run', '--pure', '--auto', '--format', 'json', '--print-logs', '--log-level', 'INFO',
      '--model', 'dstudio/ds4', '--agent', 'build', '--dir', workspace,
      '--title', `benchmark-${scenarioId}`, prompt,
    ],
    env: environments.opencode.env,
  };
}

async function runCompetitor(proxy, environments, harness, scenario) {
  const task = scenario.variants[harness];
  const before = workspaceSnapshot(workspace);
  const runId = `${harness}-${scenario.id}`;
  const command = commandFor(harness, task.prompt, scenario.id, environments);
  proxy.begin(runId);
  let execution;
  try {
    execution = await runCli(command.command, command.args, {
      cwd: workspace,
      env: command.env,
      timeoutMs: Number(process.env.DSTUDIO_COMPETITOR_TURN_TIMEOUT_MS || 1_200_000),
    });
  } finally {
    // Requests have completed before the CLI exits; the proxy remains alive for the next run.
  }
  const modelRequests = proxy.end(runId);
  const after = workspaceSnapshot(workspace);
  const changed = changedFiles(before, after);
  const unexpectedChanges = changed.filter((file) => !changeAllowed(file, task.allowedChanges));
  const external = task.score();
  const events = analyzeEvents(harness, execution.stdout, task.expected);
  const modelPinVerified = modelRequests.length > 0 &&
    modelRequests.every((request) => request.path === '/v1/chat/completions' && request.model === 'ds4');
  const agentClaimedDone = events.answerAfterTool;
  const result = {
    variant: harness,
    scenario: scenario.id,
    taskSuccess: Boolean(execution.code === 0 && external.ok && agentClaimedDone),
    expectedAnswerAfterTool: agentClaimedDone,
    incorrectCompletionClaim: Boolean(agentClaimedDone && !external.ok),
    externalCheck: external,
    changedFiles: changed,
    unexpectedChanges,
    toolStats: { calls: events.calls, maximumRepeated: events.maximumRepeated },
    wallClockMs: execution.wallClockMs,
    humanRecoveryInterventions: 0,
    process: {
      exitCode: execution.code,
      signal: execution.signal,
      timedOut: execution.timedOut,
      outputOverflow: execution.overflow,
      spawnError: execution.spawnError,
    },
    protocol: {
      parsedEvents: events.parsedEvents,
      modelRequests: modelRequests.length,
      modelPinVerified,
      requestsWithToolSchemas: modelRequests.filter((request) => request.toolSchemas > 0).length,
      requestedModels: [...new Set(modelRequests.map((request) => request.model))],
    },
  };
  writeArtifact(artifacts, `${scenario.id}-${harness}-stdout.jsonl`, execution.stdout);
  writeArtifact(artifacts, `${scenario.id}-${harness}-stderr.txt`, execution.stderr);
  writeArtifact(artifacts, `${scenario.id}-${harness}-result.json`, result);
  return result;
}

function byTask(runs) {
  return Object.fromEntries(fixture.templates.map((template) => {
    const matching = runs.filter((run) => run.scenario.replace(/-\d+$/, '') === template.id);
    return [template.id, {
      runs: matching.length,
      successes: matching.filter((run) => run.taskSuccess).length,
    }];
  }));
}

function summarize(runs) {
  const successes = runs.filter((run) => run.taskSuccess).length;
  return {
    successes,
    successRatePercent: rounded(successes / runs.length * 100, 1),
    incorrectCompletionClaims: runs.filter((run) => run.incorrectCompletionClaim).length,
    unexpectedModificationRuns: runs.filter((run) => run.unexpectedChanges.length).length,
    processFailures: runs.filter((run) => run.process.exitCode !== 0).length,
    modelPinFailures: runs.filter((run) => !run.protocol.modelPinVerified).length,
    medianWallClockMs: rounded(median(runs.map((run) => run.wallClockMs))),
    maximumRepeatedToolCalls: Math.max(...runs.map((run) => run.toolStats.maximumRepeated)),
    byTask: byTask(runs),
  };
}

let server = await startDStudio({
  binaryArg: process.argv[2], label: 'dstudio-task-graph-cli-competitors', isolatedEnginePort: true,
});
let proxy = null;
const benchmarkStartedAt = performance.now();

try {
  const model = selectModel(server.ggufs);
  assert.ok(model, 'No supported full local GGUF found');
  const launch = {
    mode: 'server', model: 'standard', variant: 'flash', gguf: model.file,
    port: server.enginePort,
    ctx: Number(process.env.DSTUDIO_RELIABILITY_CTX || 8192),
    power: Number(process.env.DSTUDIO_RELIABILITY_POWER || 70),
    think: 'off', ssdStreaming: 'off', workdir: workspace,
  };
  writeArtifact(artifacts, 'launch.json', launch);
  const startupStartedAt = performance.now();
  const startup = await startMode(server.baseUrl, launch,
    Number(process.env.DSTUDIO_RELIABILITY_START_TIMEOUT_MS || 1_800_000));
  const startupMs = rounded(performance.now() - startupStartedAt);
  writeArtifact(artifacts, 'startup.json', startup);
  assert.equal(startup.config?.ssdStreaming, 'off');
  assert.equal(startup.config?.ssdStreamingEffective, false,
    `SSD streaming remained effective: ${startup.config?.ssdStreamingReason || 'unknown'}`);

  proxy = await startModelPinProxy(server.enginePort);
  const environments = writeCliConfigs(proxy.baseUrl, launch.ctx);
  const versions = {
    pi: commandOutput('pi', ['--version']) || 'unknown',
    opencode: commandOutput('opencode', ['--version']) || 'unknown',
  };
  writeArtifact(artifacts, 'cli-config.json', {
    versions,
    pi: environments.pi.config,
    opencode: environments.opencode.config,
  });

  // Resolve each isolated provider before timing tasks. This setup check also
  // prevents OpenCode's first measured turn from including an adapter package
  // fetch while keeping model prefill and all inference inside task timing.
  const piPreflight = await runCli('pi', ['--list-models', 'dstudio', '--offline'], {
    cwd: workspace, env: environments.pi.env, timeoutMs: 300_000,
  });
  const openCodePreflight = await runCli('opencode', ['models', 'dstudio', '--pure'], {
    cwd: workspace, env: environments.opencode.env, timeoutMs: 300_000,
  });
  const preflight = {
    pi: {
      ok: piPreflight.code === 0 && /\bdstudio\b[\s\S]*\bds4\b/i.test(piPreflight.stdout),
      exitCode: piPreflight.code,
      wallClockMs: piPreflight.wallClockMs,
    },
    opencode: {
      ok: openCodePreflight.code === 0 && /dstudio\/ds4/i.test(openCodePreflight.stdout),
      exitCode: openCodePreflight.code,
      wallClockMs: openCodePreflight.wallClockMs,
    },
  };
  writeArtifact(artifacts, 'pi-preflight.txt', `${piPreflight.stdout}\n${piPreflight.stderr}`);
  writeArtifact(artifacts, 'opencode-preflight.txt', `${openCodePreflight.stdout}\n${openCodePreflight.stderr}`);
  assert.equal(preflight.pi.ok, true, 'Pi did not resolve the pinned DStudio model');
  assert.equal(preflight.opencode.ok, true, 'OpenCode did not resolve the pinned DStudio model');

  const pi = [];
  const opencode = [];
  for (let index = 0; index < scenarios.length; index++) {
    const scenario = scenarios[index];
    const order = index % 2 === 0 ? ['pi', 'opencode'] : ['opencode', 'pi'];
    for (const harness of order) {
      fixture.resetScenario(scenario, harness);
      const result = await runCompetitor(proxy, environments, harness, scenario);
      (harness === 'pi' ? pi : opencode).push(result);
    }
    const piRun = pi.at(-1);
    const openCodeRun = opencode.at(-1);
    console.log(`cli_agents: ${index + 1}/${scenarios.length} ${scenario.id} · pi=${piRun.taskSuccess} opencode=${openCodeRun.taskSuccess}`);
  }

  const piSummary = summarize(pi);
  const openCodeSummary = summarize(opencode);
  const allRuns = [...pi, ...opencode];
  const result = {
    schemaVersion: 1,
    ok: pi.length === scenarios.length && opencode.length === scenarios.length &&
      allRuns.every((run) => run.protocol.modelPinVerified) &&
      allRuns.every((run) => run.protocol.requestsWithToolSchemas > 0),
    measuredAt: new Date().toISOString(),
    dstudio: revisionInfo(process.cwd()),
    ds4: revisionInfo(server.ds4Dir),
    hardware: hardwareInfo(),
    model: { file: model.file, bytes: model.size },
    configuration: {
      contextTokens: launch.ctx,
      power: launch.power,
      thinking: launch.think,
      ssdStreaming: startup.config?.ssdStreaming,
      ssdStreamingEffective: startup.config?.ssdStreamingEffective,
      ssdStreamingReason: startup.config?.ssdStreamingReason,
      fullModelReady: startup.ready === true,
      matchedCases: caseCount,
      maxOutputTokens,
      localEndpointEnforced: true,
    },
    cliVersions: versions,
    preflight,
    startupMs,
    comparison: {
      scenarios: scenarios.length,
      pi: piSummary,
      opencode: openCodeSummary,
      runs: { pi, opencode },
    },
    humanRecoveryInterventions: 0,
    wallClockMs: rounded(performance.now() - benchmarkStartedAt),
    limitations: [
      `${caseCount} matched cases cycle through read, write and code-repair fixtures.`,
      'Pi and OpenCode ran in alternating order with a fresh non-interactive session for every task.',
      'Both CLIs used the same continuously loaded DStudio server model; a local proxy rejected any model id other than ds4.',
      'The DStudio Native Agent and automatic checked Agent results are produced in a separate load because ds4 prevents the large Agent and server runtimes from owning the model simultaneously.',
      'CLI process startup is included in task time; reliability, not speed, is the primary comparison.',
    ],
  };
  writeArtifact(artifacts, 'result.json', result);
  assert.equal(result.ok, true, `Pi/OpenCode benchmark protocol failed: ${JSON.stringify(result, null, 2)}`);
  console.log(`task_graph_cli_competitors_real: ok · Pi ${piSummary.successes}/${pi.length} · OpenCode ${openCodeSummary.successes}/${opencode.length} · SSD streaming off`);
} catch (error) {
  writeArtifact(artifacts, 'failure.txt', `${error?.stack || error}\n\n${safeReadTail(server?.logPath)}`);
  throw error;
} finally {
  if (proxy) await proxy.close();
  if (server) await server.stop();
}
