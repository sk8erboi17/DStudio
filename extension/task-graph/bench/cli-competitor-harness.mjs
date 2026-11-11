// Side-effect-free parts of the third-party CLI benchmark (Pi, OpenCode,
// Codex): environment isolation, the model pin proxy, process control and
// event parsing. run-cli-competitors.mjs uses them against a real model;
// tests/integration/codex_responses_protocol_test.mjs runs the same functions
// against a scripted server. Nothing here starts an engine or loads a model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { changeAllowed, changedFiles, workspaceSnapshot } from './reliability-fixture.mjs';

export const COMPETITOR_HARNESSES = Object.freeze(['pi', 'opencode', 'codex']);
export const COMPETITOR_LABELS = Object.freeze({ pi: 'Pi', opencode: 'OpenCode', codex: 'Codex' });

// DSTUDIO_COMPETITOR_HARNESSES selects a subset (for example `codex` alone, or
// `pi,opencode` to repeat the published two-harness run). Order in the value
// is irrelevant: the canonical order above is kept.
export function selectHarnesses(value) {
  const requested = String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!requested.length) return [...COMPETITOR_HARNESSES];
  const unknown = requested.filter((item) => !COMPETITOR_HARNESSES.includes(item));
  if (unknown.length) throw new Error(`unknown DSTUDIO_COMPETITOR_HARNESSES value(s): ${unknown.join(', ')}`);
  return COMPETITOR_HARNESSES.filter((harness) => requested.includes(harness));
}

// Two harnesses alternate. Three go through all six orders in turn, so over
// every six scenarios each one runs first, second and third twice and precedes
// each other one three times.
const HARNESS_ORDERS = Object.freeze([
  ['pi', 'opencode', 'codex'],
  ['opencode', 'pi', 'codex'],
  ['pi', 'codex', 'opencode'],
  ['opencode', 'codex', 'pi'],
  ['codex', 'pi', 'opencode'],
  ['codex', 'opencode', 'pi'],
]);

export function harnessOrder(index, selected) {
  if (selected.length === 2) return index % 2 === 0 ? [...selected] : [...selected].reverse();
  return HARNESS_ORDERS[index % HARNESS_ORDERS.length].filter((harness) => selected.includes(harness));
}

export function rounded(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

export function cleanEnvironment(overrides, source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/(?:_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)$/.test(key) ||
        /^(?:AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS)/.test(key) ||
        /^(?:OPENCODE_|PI_CODING_AGENT_|PI_OFFLINE|PI_TELEMETRY)/.test(key) ||
        /^(?:OPENAI_|CODEX_)/.test(key)) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

// The Codex CLI states the kind of each request (`turn`, `compaction`, ...) in
// a header, not in the body.
function codexRequestKind(headers) {
  try {
    const kind = JSON.parse(String(headers['x-codex-turn-metadata'] || '')).request_kind;
    return typeof kind === 'string' ? kind : null;
  } catch {
    return null;
  }
}

// One loopback proxy stands between every competitor CLI and the engine. It
// refuses any model id other than `ds4`, applies the benchmark's declared
// settings where a CLI cannot express them, and records what each run asked
// for. `responsesMaxOutputTokens` is the output limit applied to a Responses
// request that carries none (Codex has no setting for it).
export async function startModelPinProxy(enginePort, { responsesMaxOutputTokens = null } = {}) {
  let activeRunId = null;
  const observations = new Map();
  const observe = (record) => {
    const runId = activeRunId;
    if (!runId) return;
    if (!observations.has(runId)) observations.set(runId, []);
    observations.get(runId).push(record);
  };
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
      // This is an origin server for the engine's API only. A CLI told to use
      // it as its HTTP proxy (the Codex environment does that, so nothing can
      // leave the machine) reaches this branch for any other destination.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(request.url || '')) {
        observe({ path: request.url, method: request.method, blocked: true });
        response.writeHead(403, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'benchmark proxy forwards only the pinned local engine' } }));
        return;
      }
      let body = Buffer.concat(chunks);
      let payload = null;
      if (body.length) {
        try { payload = JSON.parse(body.toString('utf8')); } catch {}
      }
      const responsesRequest = request.method === 'POST' && request.url === '/v1/responses';
      const record = {
        path: request.url,
        method: request.method,
        model: typeof payload?.model === 'string' ? payload.model : null,
        toolSchemas: Array.isArray(payload?.tools) ? payload.tools.length : 0,
        stream: payload?.stream === true,
      };
      if (responsesRequest) {
        // What the CLI asked for itself, before the settings below are applied.
        record.nativeReasoningEffort = payload?.reasoning?.effort ?? null;
        record.nativeMaxOutputTokens = payload?.max_output_tokens ?? null;
        record.previousResponseId = payload?.previous_response_id ?? null;
        record.toolOutputs = Array.isArray(payload?.input)
          ? payload.input.filter((item) => item?.type === 'function_call_output').length : 0;
        record.requestKind = codexRequestKind(request.headers);
      }
      observe(record);
      if ((request.url === '/v1/chat/completions' || responsesRequest) && record.model !== 'ds4') {
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
      // The Responses equivalent: the engine thinks unless `reasoning.effort`
      // is "none". Codex is configured to send that itself (recorded above);
      // it is enforced here as well so a request that omits it cannot think.
      if (responsesRequest && payload && typeof payload === 'object') {
        const reasoning = payload.reasoning && typeof payload.reasoning === 'object' ? payload.reasoning : {};
        payload.reasoning = { ...reasoning, effort: 'none' };
        if (responsesMaxOutputTokens && payload.max_output_tokens === undefined)
          payload.max_output_tokens = responsesMaxOutputTokens;
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
      // A CLI that is stopped mid-answer closes its connection after the
      // request was read in full, which `aborted` does not report. Without
      // this the engine would go on generating for a client that has left.
      response.on('close', () => {
        if (!response.writableFinished) upstream.destroy();
      });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  });
  // HTTPS through a proxy starts with CONNECT. Refuse and record it.
  server.on('connect', (request, socket) => {
    observe({ path: request.url, method: 'CONNECT', blocked: true });
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
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

export function terminateProcessTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}

// A CLI process the caller can act on while it runs: `stop()` ends it the way
// a timeout does, `child.stdin` is open when options.stdin is 'pipe', and
// options.onStderr sees each chunk as it arrives. `done` resolves when the
// process has closed. A timeoutMs of 0 sets no deadline.
export function startCli(command, args, options) {
  const outputLimit = 32 * 1024 * 1024;
  const stopSignal = options.stopSignal || 'SIGTERM';
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: [options.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let overflow = false;
  let stopped = false;
  let spawnError = null;
  const end = () => {
    terminateProcessTree(child, stopSignal);
    setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 5000).unref();
  };
  const append = (target, chunk) => {
    const text = chunk.toString('utf8');
    if (target === 'stdout') stdout += text;
    else stderr += text;
    if (stdout.length + stderr.length > outputLimit && !overflow) {
      overflow = true;
      terminateProcessTree(child, stopSignal);
    }
  };
  child.stdout.on('data', (chunk) => append('stdout', chunk));
  child.stderr.on('data', (chunk) => {
    append('stderr', chunk);
    if (options.onStderr) options.onStderr(chunk.toString('utf8'));
  });
  if (child.stdin) child.stdin.on('error', () => {});
  child.on('error', (error) => { spawnError = error.message; });
  const timer = options.timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    end();
  }, options.timeoutMs) : null;
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code, signal, stdout, stderr, timedOut, overflow, spawnError, stopped,
        wallClockMs: rounded(performance.now() - startedAt),
      });
    });
  });
  return {
    child,
    done,
    output: () => ({ stdout, stderr }),
    stop() {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      stopped = true;
      end();
      return true;
    },
  };
}

export async function runCli(command, args, options) {
  return await startCli(command, args, options).done;
}

export function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

// `codex exec --json` reports each shell command it ran as one item, started
// and then completed with the exit status. That item is the tool call.
function codexToolEnded(event) {
  return event.type === 'item.completed' && event.item?.type === 'command_execution';
}

export function canonicalToolCall(harness, event) {
  if (harness === 'pi') {
    return JSON.stringify({ name: event.toolName, input: event.args || {} });
  }
  if (harness === 'codex') {
    return JSON.stringify({ name: event.item?.type, input: { command: event.item?.command || '' } });
  }
  return JSON.stringify({
    name: event.part?.tool,
    input: event.part?.state?.input || event.part?.state?.metadata?.input || {},
  });
}

function eventText(harness, event) {
  if (harness === 'opencode') return event.type === 'text' ? String(event.part?.text || '') : '';
  if (harness === 'codex') {
    return event.type === 'item.completed' && event.item?.type === 'agent_message'
      ? String(event.item.text || '') : '';
  }
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

export function analyzeEvents(harness, stdout, task) {
  const events = parseEvents(stdout);
  const completedTools = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => harness === 'pi'
      ? event.type === 'tool_execution_end'
      : harness === 'codex'
        ? codexToolEnded(event)
        : event.type === 'tool_use' && ['completed', 'error'].includes(event.part?.state?.status));
  const lastToolIndex = completedTools.at(-1)?.index ?? -1;
  const answerText = events.slice(lastToolIndex + 1)
    .map((event) => eventText(harness, event)).join('\n');
  const required = [task.expected, ...(task.answerMustContain || [])];
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
    answerAfterTool: lastToolIndex >= 0 && required.every((value) => answerText.includes(value)),
  };
}

// One task for one CLI: run it under the pin proxy, then grade the files it
// left, independently of what it said. `command` is { command, args, env,
// stopSignal? }; the caller keeps the returned output as evidence.
export async function runCompetitor({ proxy, harness, scenario, workspace, command, timeoutMs }) {
  const task = scenario.variants[harness];
  const before = workspaceSnapshot(workspace);
  const runId = `${harness}-${scenario.id}`;
  proxy.begin(runId);
  let execution;
  try {
    execution = await runCli(command.command, command.args, {
      cwd: workspace,
      env: command.env,
      timeoutMs,
      stopSignal: command.stopSignal,
    });
  } finally {
    // Requests have completed before the CLI exits; the proxy remains alive for the next run.
  }
  const observed = proxy.end(runId);
  // Only the Codex environment names the proxy as its HTTP(S) proxy, so only a
  // Codex run can leave refused outbound attempts here.
  const modelRequests = observed.filter((request) => !request.blocked);
  const modelPath = harness === 'codex' ? '/v1/responses' : '/v1/chat/completions';
  const after = workspaceSnapshot(workspace);
  const changed = changedFiles(before, after);
  const unexpectedChanges = changed.filter((file) => !changeAllowed(file, task.allowedChanges));
  const external = task.score();
  const events = analyzeEvents(harness, execution.stdout, task);
  const modelPinVerified = modelRequests.length > 0 &&
    modelRequests.every((request) => request.path === modelPath && request.model === 'ds4');
  const agentClaimedDone = events.answerAfterTool;
  const result = {
    variant: harness,
    scenario: scenario.id,
    taskType: scenario.templateId,
    taskSuccess: Boolean(execution.code === 0 && external.ok && agentClaimedDone &&
      unexpectedChanges.length === 0),
    expectedAnswerAfterTool: agentClaimedDone,
    incorrectCompletionClaim: Boolean(agentClaimedDone && (!external.ok || unexpectedChanges.length)),
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
      ...(harness === 'codex' ? {
        // The CLI prints no event for a command its sandbox refused, so the
        // tool results it replays to the model are counted here as well. A
        // compaction replaces the history: this is a lower bound.
        toolOutputsSent: Math.max(0, ...modelRequests.map((request) => request.toolOutputs || 0)),
        compactionRequests: modelRequests.filter((request) => request.requestKind === 'compaction').length,
        nativeReasoningEfforts: [...new Set(modelRequests.map((request) => request.nativeReasoningEffort))],
        blockedOutbound: observed.filter((request) => request.blocked).map((request) => `${request.method} ${request.path}`),
      } : {}),
    },
  };
  return { result, execution };
}

// Codex CLI configuration for the benchmark. Every key was accepted by
// codex-cli 0.167.0 under --strict-config, which rejects unknown ones.
//
// The home directory is created for the run: no login, no API key and nothing
// from the user's ~/.codex. The provider speaks the Responses API to the model
// pin proxy. Features that add tools Pi and OpenCode are not given (agents,
// goals, images, browser, plugins, apps, skills, web search) are off; what
// remains is the CLI's own shell tool. With `plugins` on, the CLI also tried
// to reach chatgpt.com and github.com; that is off, and the environment below
// names the pin proxy as HTTP(S) proxy, which refuses and records any other
// destination.
const CODEX_DISABLED_FEATURES = Object.freeze([
  'plugins', 'remote_plugin', 'plugin_discovery_prefetch', 'plugin_sharing', 'apps',
  'api_key_model_discovery', 'multi_agent', 'goals', 'view_image', 'image_generation',
  'browser_use', 'computer_use', 'hooks', 'skill_search', 'tool_suggest',
]);

export function codexConfigToml({ baseUrl, contextTokens }) {
  return [
    '# Written by the DStudio CLI benchmark for one run. Not a user configuration.',
    'model = "ds4"',
    'model_provider = "dstudio"',
    // The benchmark declares thinking off.
    'model_reasoning_effort = "none"',
    // The CLI compacts its history when the reported usage nears this size.
    `model_context_window = ${Number(contextTokens)}`,
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    // No AGENTS.md from the workspace or its parents.
    'project_doc_max_bytes = 0',
    'check_for_update_on_startup = false',
    // Credentials, if any were ever written, stay in this home, never the keychain.
    'cli_auth_credentials_store = "file"',
    'mcp_oauth_credentials_store = "file"',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[skills]',
    'include_instructions = false',
    '',
    '[skills.bundled]',
    'enabled = false',
    '',
    '[features]',
    ...CODEX_DISABLED_FEATURES.map((feature) => `${feature} = false`),
    '',
    // Writes are confined to the workspace: by default the sandbox would also
    // allow /tmp and $TMPDIR. Commands get no network.
    '[sandbox_workspace_write]',
    'network_access = false',
    'exclude_tmpdir_env_var = true',
    'exclude_slash_tmp = true',
    '',
    '[model_providers.dstudio]',
    'name = "DStudio local benchmark"',
    `base_url = ${JSON.stringify(`${baseUrl}/v1`)}`,
    'wire_api = "responses"',
    // A failed or interrupted request is a failed run, not a silent second attempt.
    'request_max_retries = 0',
    'stream_max_retries = 0',
    // Same patience as the OpenCode provider: a slow local prefill is not an error.
    'stream_idle_timeout_ms = 1200000',
    '',
  ].join('\n');
}

export function writeCodexConfig({ home, baseUrl, contextTokens, source = process.env }) {
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const config = codexConfigToml({ baseUrl, contextTokens });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), config);
  // The CLI runs every command through a login shell. This isolated home has
  // no profile, so the system profile alone orders PATH and puts /usr/bin
  // first: on macOS `python3` then is the Xcode shim, which cannot write its
  // cache inside the CLI's sandbox, takes about ten seconds and floods the
  // command output (the code-repair task failed intermittently because of
  // it). Give the login shell the PATH the other two harnesses run with.
  const searchPath = String(source.PATH || '').replace(/'/g, `'\\''`);
  for (const profile of ['.zprofile', '.profile'])
    fs.writeFileSync(path.join(home, profile), `export PATH='${searchPath}'\n`);
  return {
    config,
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      HTTP_PROXY: baseUrl, HTTPS_PROXY: baseUrl, ALL_PROXY: baseUrl,
      http_proxy: baseUrl, https_proxy: baseUrl, all_proxy: baseUrl,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    },
  };
}

// The CLI runs each shell command in a process group of its own, so a signal
// to the CLI's group does not reach it. On SIGINT the CLI ends its commands
// before it exits; on SIGTERM it exits and leaves them running, where they
// could still write into the workspace of the next task.
export const CODEX_STOP_SIGNAL = 'SIGINT';

// One non-interactive turn in `workspace`, events as JSONL on stdout, nothing
// kept on disk afterwards.
export function codexExecArgs({ workspace, prompt }) {
  return [
    'exec', '--json', '--strict-config', '--ephemeral', '--skip-git-repo-check',
    '--model', 'ds4', '--sandbox', 'workspace-write', '--cd', workspace, prompt,
  ];
}

export function codexCommand({ workspace, prompt, env }) {
  return { command: 'codex', args: codexExecArgs({ workspace, prompt }), env, stopSignal: CODEX_STOP_SIGNAL };
}

// The preflight asks the CLI itself which model and provider it resolved and
// whether it can reach the provider; it sends no model request.
export const CODEX_PREFLIGHT_ARGS = Object.freeze(['doctor', '--json', '--network-only']);

export function codexPreflight(stdout) {
  let report = null;
  try { report = JSON.parse(stdout); } catch {}
  const config = report?.checks?.['config.load'];
  const reachability = report?.checks?.['network.provider_reachability'];
  const transport = report?.checks?.['network.websocket_reachability'];
  const result = {
    model: config?.details?.model ?? null,
    provider: config?.details?.['model provider'] ?? null,
    wireApi: transport?.details?.['wire API'] ?? null,
    providerReachability: reachability?.status ?? null,
  };
  return {
    ...result,
    ok: config?.status === 'ok' && result.model === 'ds4' && result.provider === 'dstudio' &&
      result.wireApi === 'responses' && result.providerReachability === 'ok',
  };
}

// Isolated configuration and environment of the three CLIs for one run: no
// file or variable of the user's own setup is read. `workspace` is the
// directory the CLIs are started in.
export function writeCompetitorConfigs({ configRoot, workspace, baseUrl, contextTokens, maxOutputTokens }) {
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

  const codex = writeCodexConfig({ home: path.join(configRoot, 'codex-home'), baseUrl, contextTokens });

  return {
    codex: {
      config: codex.config,
      env: cleanEnvironment({ ...codex.env, PWD: workspace }),
    },
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

// One non-interactive task for one CLI: { command, args, env, stopSignal? }.
export function competitorCommand({ harness, prompt, workspace, title, environments }) {
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
  if (harness === 'codex') return codexCommand({ workspace, prompt, env: environments.codex.env });
  return {
    command: 'opencode',
    args: [
      'run', '--pure', '--auto', '--format', 'json', '--print-logs', '--log-level', 'INFO',
      '--model', 'dstudio/ds4', '--agent', 'build', '--dir', workspace,
      '--title', title, '--', ...openCodeMessageArgs(prompt),
    ],
    env: environments.opencode.env,
  };
}

// `opencode run` joins its message arguments with spaces, but first wraps each
// argument that contains a space in double quotes and escapes the quotes
// inside it (packages/opencode/src/cli/cmd/run.ts; observed with 1.18.18), so
// a prompt given as one argument reaches the model as `"...\"...\"..."`.
// Given as its space-separated pieces after `--`, no piece contains a space
// and the join rebuilds the prompt byte for byte. Runs of spaces give empty
// pieces, which the join restores too.
export function openCodeMessageArgs(prompt) {
  return String(prompt).split(' ');
}
