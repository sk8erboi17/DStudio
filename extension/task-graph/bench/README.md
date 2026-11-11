# Third-party CLI comparison: Pi, OpenCode and Codex

`run-cli-competitors.mjs` gives the fifty reliability fixtures of
`reliability-fixture.mjs` to third-party coding agents that all use the same
locally served model, and grades the files each one leaves, independently of
what it says. Pi and OpenCode results are published; see the
[Task Graph guide](../README.md#verification). The Codex CLI is the third
harness.

**Status on November 11, 2026.** The Codex harness is implemented, and its
protocol loop passes against a scripted server (`make test-codex-protocol`, 26
cases, codex-cli 0.167.0, macOS on Apple Silicon). **No Codex run with a real
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
of its cases. It is part of `check-fast` and exits non-zero with `NOT RUN` when
the CLI is missing.

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

## Open before a Codex comparison

- **Context size.** The first request of a one-line task is about 25.5 KB of
  JSON before any file content. Whether that fits the default 8,192-token
  context depends on the model's tokenizer and was not measured. If it does not
  fit, the engine refuses the request or the CLI compacts mid-task. Choose one
  context for all harnesses first.
- **Equivalence.** Codex uses another endpoint, another system prompt and
  another tool set than Pi and OpenCode. Which settings count as equivalent is
  not decided here.
- **Publication.** `publish-cli-comparison.mjs` and the plots read Pi and
  OpenCode only.
