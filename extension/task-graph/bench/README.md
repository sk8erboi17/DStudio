# Third-party CLI comparison: Pi, OpenCode and Codex

`run-cli-competitors.mjs` gives the fifty reliability fixtures of
`reliability-fixture.mjs` to third-party coding agents that all use the same
locally served model, and grades the files each one leaves, independently of
what it says. Pi and OpenCode results are published; see the
[Task Graph guide](../README.md#verification). The Codex CLI is the third
harness.

**Status on November 11, 2026.** The Codex harness is implemented, and its
protocol loop passes against a scripted server (`make test-codex-protocol`, 26
cases, codex-cli 0.167.0, macOS on Apple Silicon; 26/26 again the same day
after the CLI updated itself to 0.167.1). **No Codex run with a real
model has been made.** Until one is recorded there is no Codex result to quote
or compare. Linux and Windows were not run.

## How each CLI is run

Every task starts a new non-interactive session in the shared benchmark
workspace. Each CLI gets a home directory created for the run; nothing is read
from the user's own configuration, and `cleanEnvironment` removes API keys,
tokens and every `OPENAI_*`, `CODEX_*`, `OPENCODE_*` and Pi variable.

One loopback proxy (`startModelPinProxy`) stands between the CLIs and the
engine. It refuses any model id other than `ds4`, turns thinking off, and
records the requests of each run.

| | Pi | OpenCode | Codex |
| --- | --- | --- | --- |
| Engine endpoint | `/v1/chat/completions` | `/v1/chat/completions` | `/v1/responses` |
| Tools | read, bash, edit, write | bash, read, edit, write | the CLI's shell tool (`exec_command`, `write_stdin`) |
| Thinking off | proxy sets `think: false` | proxy sets `think: false` | CLI sends `reasoning.effort: "none"`; the proxy enforces it |
| Output limit | set in the CLI's configuration | set in the CLI's configuration | added by the proxy (the CLI has no setting) |
| Sandbox set by the runner | none | none | the CLI's own: writes only in the workspace (not `/tmp` or `$TMPDIR`), no network for commands |
| Stopped with | `SIGTERM` | `SIGTERM` | `SIGINT` (see below) |

The Codex configuration is written by `writeCodexConfig` in
`cli-competitor-harness.mjs`. The CLI runs as
`codex exec --json --strict-config --ephemeral --skip-git-repo-check --model ds4 --sandbox workspace-write --cd WORKSPACE PROMPT`.
`--strict-config` makes the CLI refuse a configuration key it does not know, so
an isolation setting cannot be dropped silently by another CLI version.
Agents, goals, images, browser, plugins, apps, skills and web search are off,
as comparable features are for the other two.

Before any task, `codex doctor --json --network-only` must report model `ds4`
on provider `dstudio` with the Responses wire API, and its provider probe
(`GET /v1/models`) must arrive at the proxy. This sends no model request.

`DSTUDIO_COMPETITOR_HARNESSES` selects a subset; the default is all three.
Two harnesses alternate; three go through all six orders in turn.

```sh
# All three, fifty tasks each
DSTUDIO_RELIABILITY_CASES=50 make test-task-graph-cli-competitors-real
# Codex alone, or the two published harnesses exactly as before
DSTUDIO_COMPETITOR_HARNESSES=codex make test-task-graph-cli-competitors-real
DSTUDIO_COMPETITOR_HARNESSES=pi,opencode make test-task-graph-cli-competitors-real
```

A Codex result also records, for each task, the reasoning effort the CLI sent
itself, the number of compaction requests, the tool results it replayed to the
model, and any connection it attempted to something other than the engine.

## `make test-codex-protocol`

Runs the installed `codex` binary against a scripted loopback server, through
the same proxy, configuration, command line, event parser and grading function
the benchmark uses. The server's event shapes, their order and the framing
follow the `responses_sse_*` emitters of the pinned
`src/engines/ds4/ds4_server.c`, and it refuses the requests that engine
refuses (a stored-response reference, or a tool result whose call is not
replayed). It needs the Codex CLI and Node, plus `python3` and `curl` for two
of its cases. It is explicit, not part of `check-fast` (the broad gate does not
depend on a third-party CLI that updates on its own), and exits non-zero with
`NOT RUN` when the CLI is missing.

It proves, by file contents, exit status, the CLI's JSON events and the exact
requests the server received:

- A tool call is executed for real, its result returns under the same call id,
  and the final answer follows. Two calls in one response and a second round
  each get exactly one result.
- Reasoning summaries are printed and replayed. Replies written one byte at a
  time, with multi-byte characters cut in the middle, arrive intact.
- A second invocation resumes a session by replaying its whole history.
- An incomplete, failed, truncated or reset response, a malformed final frame,
  an engine context-length error and a request for another model all end as a
  failed run, never as a success.
- A stopped run closes the engine connection through the proxy, and a command
  it started does not outlive it.
- Writes outside the workspace and network access from a command are refused.
- Poisoned `OPENAI_*` and `CODEX_*` variables and another Codex home have no
  effect, and no credential header is sent.
- Three fixture tasks (create a file, read a fact, repair code), solved or
  mis-solved by the script in nine runs, are graded by the benchmark's own
  function: a correct solution passes; a wrong file, a touched bystander file,
  an answer without a tool call, an unrepaired test and a broken stream do not.

It does **not** prove:

- Anything about a model or about Codex as an agent. Every reply is scripted.
- That `ds4-server` behaves as its source was read. The engine was not started:
  tokenization, prompt rendering, cache reuse, real reasoning and the engine's
  own tool-call parsing are not exercised.
- Other CLI versions or platforms. The observations below are from
  codex-cli 0.167.0 on macOS.
- How the kernel delivered the split writes; it may join adjacent ones.

## What codex-cli 0.167.0 was observed to do

- It posts to `/v1/responses` under the configured `base_url`, with
  `stream: true`, `store: false`, no `previous_response_id` and no
  `Authorization` header for a provider without a key. Every request replays
  the whole history; `prompt_cache_key` and the `session-id` header are the
  session id.
- It sends no output limit.
- It runs a function call as soon as that item is complete, before
  `response.completed`. If the stream then breaks, the command has run and the
  turn fails.
- It skips a frame it cannot parse when valid frames surround it.
- It prints no `command_execution` event for a command that failed on a write
  its sandbox refused, although the refusal is returned to the model.
  `toolStats.calls` counts events, so it can be lower than the number of calls.
- `write_stdin` continues a running command: two calls, one command event.
- It advertises `request_user_input`, and answers a call to it at once with
  "unavailable in Default mode"; a non-interactive run does not wait.
- When the reported input nears `model_context_window` (seen at 8,000 and
  8,092 of 8,192 tokens), it sends a compaction request (same endpoint, no
  tools) and replaces its history with the reply.
- On `SIGTERM` it exits and leaves a running command alive; on `SIGINT` it ends
  the command first. The runner therefore stops Codex with `SIGINT`.
- With its default features it tried to reach `chatgpt.com`, `github.com` and
  `api.github.com`. With `plugins` off no such attempt was seen. The Codex
  environment also names the proxy as its HTTP(S) proxy, which refuses and
  records any other destination.

## Case sets: held-out and recovery

Status on November 12, 2026: the cases, their oracles and their selection
exist and are tested without any agent (`make test-agent-lane-cases`, 203
checks). **No agent has run a held-out case, and no real model has run any
lane case**, so there is no result to quote. The six-agent runner, its
`--plan` mode and its publication are tested without a model; see
[the six-agent lane](#six-agent-lane-run-agent-lanemjs).

| Set | Cases | Selected by |
| --- | --- | --- |
| `development` | the fifty of `reliability-fixture.mjs`, unchanged | default of every runner |
| `held-out` | twenty in `held-out-fixture.mjs`: ten kinds the fifty lack, two each | `run-agent-lane.mjs --set held-out` (or `all`) only |
| `recovery` | twelve in `recovery-fixture.mjs`: dirty workspace, a tool that fails once, a half-applied change, steering, Stop/resume, two sessions in one workspace | `run-agent-lane.mjs --set recovery` only |

`run-reliability.mjs` and `run-cli-competitors.mjs` run the fifty only. Every
held-out and recovery oracle reads only what the task left (file bytes, the
output and status of programs it runs itself with inputs the workspace never
held, and git's own records), never what an agent said.

**Held-out rule.** Do not run the held-out cases, read their transcripts or
look at their outcomes while changing a prompt, an agent, a harness or a
grader. The first execution of a case by an agent is that agent's held-out
result; a run after such a change is a development replay and must be reported
as one. Held-out and development results are never merged in one figure or
total. `frozen-cases.json` records the digest of every case (files and every
instruction); re-freezing a held-out case after agents were tuned turns its
later results into development replays.

The reference and wrong results that prove the oracles are in
`case-references.mjs`, which no runner imports and no agent is shown.

## Six-agent lane (`run-agent-lane.mjs`)

The six agents of PLAN.MD P9 are the clean upstream `ds4-agent`, the DStudio
Agent (direct), the same Agent through Task Graph, Pi, OpenCode and Codex. A
lane (`equivalent` or `product`) gives every agent every case of a set, in a
workspace of its own, in a seeded counterbalanced order, three times by
default. Rows an agent cannot run stay in the plan and in every result as
BLOCKED (missing on this machine, or no proven driver) or NOT_COMPARABLE (the
agent's interface cannot represent the mechanic or lane), with the reason.

**Status on November 12, 2026.** The runner, its `--plan` mode and its
publication are tested without a model (below). **No lane has run with a real
model**: there is no six-agent result to quote. The `product` lane is BLOCKED
for every agent until its configuration is frozen in `agent-lane.mjs`.

### What is tested without a model

`make test-agent-lane-mechanics` (explicit; needs pi, OpenCode, Codex,
python3 and git) drives the installed CLIs through the lane runner's own code
against scripted loopback servers behind the lane's pin proxy: a Chat
Completions stand-in for Pi and OpenCode and the Responses stand-in of
`make test-codex-protocol` for Codex, both following the pinned `ds4_server.c`
emitters. For each CLI: the plan row, a workspace checked against the plan's
digest, the isolated configuration and preflight (`pi --list-models`,
`opencode models`, `codex doctor`), the CLI's real tool calls changing the
workspace, the case's own oracle grading it, and the result row with its
evidence files. Cases: `dirty-workspace-01` (one prompt), `two-sessions-01`
(two invocations; the second must not see the first conversation) and, for
Codex, `stop-resume-01` (SIGINT once `journal.log` holds step 2, then
`codex exec resume` of the same session). Controls: a scripted wrong solution
(the uncommitted file "tidied") must be failed by the oracle with a false
completion claim, and a Stop whose point the turn never reaches must be
`inconclusive` and must not be resumed. A CLI that is not installed is
BLOCKED by the runner's probe and the test fails.

November 12, 2026, macOS on Apple Silicon, pi 1.4.0, OpenCode 1.18.18,
codex-cli 0.167.1: 16/16 checks; the same attempts also passed in three
earlier runs of the test with 15 checks. The three agents that
run the model in their own process (upstream `ds4-agent`, DStudio Agent and
DStudio checked) are BLOCKED in this test: no scripted server can stand in
for in-process inference, so their drivers have never run.

`make test-agent-lane-plan` (part of `check-fast`) executes `--plan` as a
program on a stated machine (stand-in engine files, a one-byte stand-in GGUF,
and pi/OpenCode/Codex shims that only record their calls): `--set all` prints
and writes 70 cases x 6 agents x 3 repetitions = 1,260 attempts, each
(repetition, case, agent) once with its frozen workspace digest, every agent
in each position 35 times and directly after every other agent 35 times; the
same options give the same bytes; the CLIs are only asked `--version` and no
workspace or run directory is created; unavailable agents, mechanics and the
product lane are BLOCKED or NOT_COMPARABLE with their reasons; invalid options
exit 2 before writing anything.

`make test-agent-lane-publication` (part of `check-fast`; needs Matplotlib)
publishes and plots SYNTHETIC receipts written by the test, shaped by the
runner's own plan and result-row functions; every receipt and figure says
SYNTHETIC, and the figures stay in `tests/.artifacts`.

It does **not** prove anything about a model or an agent, the behaviour of the
engine, the in-process drivers (upstream `ds4-agent` single, two sessions and
steering; the DStudio Agent's host driver), Linux or other CLI versions.

### Defects found by these tests and fixed

- OpenCode received every prompt wrapped in double quotes, with the quotes
  inside it escaped (`opencode run` quotes each message argument that contains
  a space; `packages/opencode/src/cli/cmd/run.ts`, observed with 1.18.18). The
  benchmark now passes the prompt as its space-separated pieces after `--`,
  which the CLI joins back byte for byte; the test asserts the exact bytes the
  model receives. The September 4 OpenCode publication was produced with the
  quoted prompt.
- `--seed --output DIR` took `--output` as the seed and `DIR` as the host
  binary; an option value that starts with `--` is now refused.
- The CLI setup of the real runner was inline in it; it is now
  `prepareCliLane` and `runCliLaneAttempt` in `lane-drivers.mjs`, the code the
  mechanics test runs, and the preflight keeps each CLI's output.

### Observed

- Codex 0.167.1 replays the command that was running when it was stopped as
  `aborted by user`, even when that command's effect (here: step 2 written to
  the journal) is already in the workspace; the stop point is a workspace
  state, reached before the CLI records the command's end. It is a race: in
  four of five runs the stopped call was replayed this way, in one with its
  completed output; the test accepts either and records which. The case's
  resume instruction asks the agent to read the journal, which shows the
  truth.

### Clean upstream `ds4-agent`

`node extension/task-graph/bench/build-upstream-agent.mjs` copies the pinned
sources of `src/engines/ds4` (verified against the manifest, no network) into
`tests/.artifacts/upstream-agent-clean/<commit>` and runs upstream's own
`make ds4-agent`; no DStudio patch is applied and no model is opened (only
`ds4-agent --help` runs). November 12, 2026: ds4 `890898cfb437ed256be58ebcf7c58a6dfa8f2f53`,
498 source files, no patches, 22 s on darwin arm64 with Apple clang 21.0.0,
binary sha256 `26fa03305fae5a7ac63f533fedc0244a70492b5dfe7a09cfe98f81e93058a48b`
(3,126,776 bytes); its help has no `--jsonl` or `--remote-base-url`, the
DStudio patch's options. `--check` verifies an existing build.

### Running the real lanes

Real model, sequential, many hours; `RUN_HEAVY=1` is set by the target. The
runner selects the GGUF the other runners select (DeepSeek V4 Flash IQ2XXS
imatrix unless `DSTUDIO_TASK_GRAPH_GGUF` names another).

```sh
node extension/task-graph/bench/build-upstream-agent.mjs        # once per checkout
node extension/task-graph/bench/run-agent-lane.mjs --plan --set all tests/.build/dstudio-server-test
# First run of the three in-process drivers, on development cases only:
make test-agent-lane-real AGENT_LANE_ARGS='--set development --repetitions 1 --agents upstream-agent,native-agent,task-graph'
# The complete equivalent lane (70 cases) and the long/recovery cases:
make test-agent-lane-real AGENT_LANE_ARGS='--lane equivalent --set all'
make test-agent-lane-real AGENT_LANE_ARGS='--lane equivalent --set recovery'
# A stopped lane continues where it was: --resume tests/.artifacts/agent-lane-real/<run>
node extension/task-graph/bench/publish-cli-comparison.mjs --lanes OUT.json RESULT.json...
python3 extension/task-graph/bench/plot-cli-comparison.py OUT.json FIGURE_DIR
```

The complete equivalent lane is 1,260 attempts; in the planned order it needs
999 model loads (every attempt of the three in-process agents starts its own,
and the shared server comes back after each). From the September 4 runs
(mean task 28 to 38 s, Agent-mode start about 31 s) that is very roughly 18
to 21 hours; an extrapolation, not a measurement (Codex and the upstream agent
were never timed, and each turn may run up to the runner's 20-minute turn
limit, `DSTUDIO_LANE_TURN_TIMEOUT_MS`). The recovery set is 216 rows, 150 of
them planned, with 116 loads (a few hours). The development run of the three
in-process agents is 150 attempts and 150 loads (about 2.5 hours). The product
lane is BLOCKED for every row and runs nothing.

## Open before a Codex comparison

- **Context size.** The first request of a one-line task is about 25.5 KB of
  JSON before any file content. Whether that fits the default 8,192-token
  context depends on the model's tokenizer and was not measured. If it does not
  fit, the engine refuses the request or the CLI compacts mid-task. Choose one
  context for all harnesses first.
- **Equivalence.** Codex uses another endpoint, another system prompt and
  another tool set than Pi and OpenCode. Which settings count as equivalent is
  not decided here.
- **Publication.** The September 4 publication (`publish-cli-comparison.mjs`
  with two inputs, and its plots) reads Pi and OpenCode only. The six-agent
  lanes are published with `--lanes` (all six agents, both lanes, each cell
  completed / planned attempts with failed, inconclusive, harness-error and
  not-run attempts in the denominator; BLOCKED and NOT_COMPARABLE cells drawn
  as such; time compared only on the cases every measured agent completed,
  with the number of those cases). Tested on synthetic receipts only; nothing
  has been published.
