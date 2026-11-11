import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  artifactRunDir, safeReadTail, startDStudio, startMode, writeArtifact,
} from '../../../tests/support/real_harness.mjs';
import { ownGitRevision } from '../../../tests/support/quality_baseline.mjs';
import { createReliabilityFixture, RELIABILITY_SUITE_SIZE } from './reliability-fixture.mjs';
import {
  cleanEnvironment, CODEX_PREFLIGHT_ARGS, codexCommand, codexPreflight, COMPETITOR_LABELS,
  harnessOrder, rounded, runCli, runCompetitor, selectHarnesses, startModelPinProxy,
  writeCodexConfig,
} from './cli-competitor-harness.mjs';

if (process.env.RUN_HEAVY !== '1') {
  console.error('Real Pi/OpenCode/Codex benchmark is disabled. Set RUN_HEAVY=1 explicitly.');
  process.exit(2);
}
const harnesses = selectHarnesses(process.env.DSTUDIO_COMPETITOR_HARNESSES);
const labels = harnesses.map((harness) => COMPETITOR_LABELS[harness]);
const labelList = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];

const artifacts = artifactRunDir('task-graph-cli-competitors-real');
console.log(`Immutable benchmark run: ${artifacts}`);
const workspace = path.join(artifacts, 'workspace');
const configRoot = path.join(artifacts, 'isolated-cli-config');
fs.mkdirSync(configRoot, { recursive: true });
const caseCount = Math.max(1, Math.min(RELIABILITY_SUITE_SIZE,
  Number(process.env.DSTUDIO_RELIABILITY_CASES || 50) || 50));
const maxOutputTokens = Math.max(256, Math.min(4096,
  Number(process.env.DSTUDIO_COMPETITOR_MAX_OUTPUT_TOKENS || 1024) || 1024));
const fixture = createReliabilityFixture({
  workspace,
  caseCount,
  variants: harnesses,
});
const onlyIds = new Set(String(process.env.DSTUDIO_RELIABILITY_ONLY || '')
  .split(',').map((value) => value.trim()).filter(Boolean));
const scenarios = onlyIds.size
  ? fixture.scenarios.filter((scenario) => onlyIds.has(scenario.id))
  : fixture.scenarios;
if (onlyIds.size && scenarios.length !== onlyIds.size)
  throw new Error(`unknown DSTUDIO_RELIABILITY_ONLY case(s): ${[...onlyIds].filter((id) =>
    !scenarios.some((scenario) => scenario.id === id)).join(', ')}`);
execFileSync('git', ['init', '--quiet'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['config', 'user.name', 'DStudio Benchmark'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'benchmark@localhost'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['add', '.'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['commit', '--quiet', '-m', 'benchmark fixture'], { cwd: workspace, stdio: 'ignore' });

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function commandOutput(command, args, cwd = process.cwd(), env = process.env) {
  try {
    return execFileSync(command, args, {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function revisionInfo(cwd) {
  const own = ownGitRevision(cwd);
  if (!own) {
    const file = path.join(cwd, '.dstudio-source.json');
    const receipt = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    return { commit: receipt?.commit || 'unknown', dirty: null,
      provenance: receipt ? 'download-receipt-unverified-content' : 'unknown-archive' };
  }
  return {
    commit: own.head,
    dirty: Boolean(own.status),
    provenance: 'own-git',
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
  if (harness === 'codex') return codexCommand({ workspace, prompt, env: environments.codex.env });
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

function byTask(runs) {
  return Object.fromEntries(fixture.templates.map((template) => {
    const matching = runs.filter((run) => run.taskType === template.id);
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

  proxy = await startModelPinProxy(server.enginePort, {
    // Pi and OpenCode send this limit themselves; Codex has no setting for it.
    responsesMaxOutputTokens: Math.min(maxOutputTokens, Math.floor(launch.ctx / 2)),
  });
  const environments = writeCliConfigs(proxy.baseUrl, launch.ctx);
  const versions = Object.fromEntries(harnesses.map((harness) => [harness, (harness === 'codex'
    ? commandOutput('codex', ['--version'], workspace, environments.codex.env)
    : commandOutput(harness, ['--version'])) || 'unknown']));
  writeArtifact(artifacts, 'cli-config.json', {
    versions,
    ...Object.fromEntries(harnesses.map((harness) => [harness, environments[harness].config])),
  });

  // Resolve each isolated provider before timing tasks. This setup check also
  // prevents OpenCode's first measured turn from including an adapter package
  // fetch while keeping model prefill and all inference inside task timing.
  const preflightRuns = {};
  if (harnesses.includes('pi')) {
    preflightRuns.pi = await runCli('pi', ['--list-models', 'dstudio', '--offline'], {
      cwd: workspace, env: environments.pi.env, timeoutMs: 300_000,
    });
  }
  if (harnesses.includes('opencode')) {
    preflightRuns.opencode = await runCli('opencode', ['models', 'dstudio', '--pure'], {
      cwd: workspace, env: environments.opencode.env, timeoutMs: 300_000,
    });
  }
  let codexProbe = [];
  if (harnesses.includes('codex')) {
    proxy.begin('codex-preflight');
    try {
      preflightRuns.codex = await runCli('codex', [...CODEX_PREFLIGHT_ARGS], {
        cwd: workspace, env: environments.codex.env, timeoutMs: 300_000,
      });
    } finally {
      codexProbe = proxy.end('codex-preflight');
    }
  }
  const preflightOk = {
    pi: (run) => run.code === 0 && /\bdstudio\b[\s\S]*\bds4\b/i.test(run.stdout),
    opencode: (run) => run.code === 0 && /dstudio\/ds4/i.test(run.stdout),
    // The CLI itself reports ds4 on the dstudio Responses provider, its
    // provider probe arrived at the pin proxy, and it tried nothing else.
    codex: (run) => run.code === 0 && codexPreflight(run.stdout).ok &&
      codexProbe.some((request) => request.method === 'GET' && request.path === '/v1/models') &&
      !codexProbe.some((request) => request.blocked),
  };
  const preflight = Object.fromEntries(harnesses.map((harness) => [harness, {
    ok: preflightOk[harness](preflightRuns[harness]),
    exitCode: preflightRuns[harness].code,
    wallClockMs: preflightRuns[harness].wallClockMs,
  }]));
  for (const harness of harnesses) {
    writeArtifact(artifacts, `${harness}-preflight.txt`,
      `${preflightRuns[harness].stdout}\n${preflightRuns[harness].stderr}`);
  }
  for (const harness of harnesses) {
    assert.equal(preflight[harness].ok, true,
      `${COMPETITOR_LABELS[harness]} did not resolve the pinned DStudio model`);
  }

  const runs = Object.fromEntries(harnesses.map((harness) => [harness, []]));
  for (let index = 0; index < scenarios.length; index++) {
    const scenario = scenarios[index];
    for (const harness of harnessOrder(index, harnesses)) {
      fixture.resetScenario(scenario, harness);
      const { result, execution } = await runCompetitor({
        proxy, harness, scenario, workspace,
        command: commandFor(harness, scenario.variants[harness].prompt, scenario.id, environments),
        timeoutMs: Number(process.env.DSTUDIO_COMPETITOR_TURN_TIMEOUT_MS || 1_200_000),
      });
      writeArtifact(artifacts, `${scenario.id}-${harness}-stdout.jsonl`, execution.stdout);
      writeArtifact(artifacts, `${scenario.id}-${harness}-stderr.txt`, execution.stderr);
      writeArtifact(artifacts, `${scenario.id}-${harness}-result.json`, result);
      runs[harness].push(result);
    }
    console.log(`cli_agents: ${index + 1}/${scenarios.length} ${scenario.id} · ${harnesses
      .map((harness) => `${harness}=${runs[harness].at(-1).taskSuccess}`).join(' ')}`);
  }

  const summaries = Object.fromEntries(harnesses.map((harness) => [harness, summarize(runs[harness])]));
  const allRuns = harnesses.flatMap((harness) => runs[harness]);
  const result = {
    schemaVersion: 1,
    ok: harnesses.every((harness) => runs[harness].length === scenarios.length) &&
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
      matchedCases: scenarios.length,
      selectedCaseFilter: onlyIds.size ? [...onlyIds] : null,
      maxOutputTokens,
      localEndpointEnforced: true,
    },
    cliVersions: versions,
    fixture: fixture.metadata,
    preflight,
    startupMs,
    comparison: {
      scenarios: scenarios.length,
      ...summaries,
      runs,
    },
    humanRecoveryInterventions: 0,
    wallClockMs: rounded(performance.now() - benchmarkStartedAt),
    limitations: [
      `${scenarios.length} matched cases draw from ${fixture.templates.length} local-agent task families with five different fixtures per family in the complete suite.`,
      `Out of scope: ${fixture.metadata.coverage.excluded.join('; ')}.`,
      `${labelList} ran ${['', 'in alternating order ', 'in rotating order (all six orders in turn) '][harnesses.length - 1]}with a fresh non-interactive session for every task.`,
      `${['The CLI', 'Both CLIs', 'All three CLIs'][harnesses.length - 1]} used the same continuously loaded DStudio server model; a local proxy rejected any model id other than ds4.`,
      ...(harnesses.includes('codex') ? [
        'Codex used the engine\'s Responses endpoint, Pi and OpenCode its chat-completions endpoint. Thinking off was enforced for every CLI at the proxy (each Codex run records the reasoning effort the CLI sent itself); the proxy also applied the declared output limit to Codex requests because the CLI has no setting for one.',
      ] : []),
      'The DStudio Native Agent and automatic checked Agent results are produced in a separate load because ds4 prevents the large Agent and server runtimes from owning the model simultaneously.',
      'CLI process startup is included in task time; reliability, not speed, is the primary comparison.',
    ],
  };
  writeArtifact(artifacts, 'result.json', result);
  assert.equal(result.ok, true, `${labels.join('/')} benchmark protocol failed: ${JSON.stringify(result, null, 2)}`);
  console.log(`task_graph_cli_competitors_real: ok · ${harnesses
    .map((harness) => `${COMPETITOR_LABELS[harness]} ${summaries[harness].successes}/${runs[harness].length}`).join(' · ')} · SSD streaming off`);
} catch (error) {
  writeArtifact(artifacts, 'failure.txt', `${error?.stack || error}\n\n${safeReadTail(server?.logPath)}`);
  throw error;
} finally {
  if (proxy) await proxy.close();
  if (server) await server.stop();
}
