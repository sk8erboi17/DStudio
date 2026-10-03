# Harnesses

A *harness* is the agent loop around a model: it decides which tool to call,
runs it and feeds the result back. DStudio has its own harnesses and can now
run two third-party coding agents in Agent mode. All of them live in
[`src/harness/`](../src/harness/):

| Harness | Location | Kind |
| --- | --- | --- |
| DStudio Agent | built from the ds4 engine's `ds4_agent.c` with [`patch/ds4-agent-jsonl`](../patch/ds4-agent-jsonl/README.md) | native (patches stay in `patch/`) |
| Cowork | [`src/harness/cowork`](../src/harness/cowork/) | native |
| Design | [`src/harness/design`](../src/harness/design/) | native |
| GSA / RSA | [`src/harness/gsa`](../src/harness/gsa/), [`src/harness/rsa`](../src/harness/rsa/) | Agent workflows |
| pi | [`src/harness/pi`](../src/harness/pi/) (earendil-works/pi `a276dab`) | third party, pinned snapshot |
| OpenCode | [`src/harness/opencode`](../src/harness/opencode/) (anomalyco/opencode `907b3bc`) | third party, pinned snapshot |
| pi-ds4 | [`src/harness/pi-ds4`](../src/harness/pi-ds4/) (mitsuhiko/pi-ds4 `db8806c`) | pi extension for ds4 |

The third-party snapshots use the engine manifest format
([`src/harness/manifest.json`](../src/harness/manifest.json)): per-file
SHA-256, recorded omissions, verified byte for byte before every build.

## How pi and OpenCode run inside DStudio

Choose **Settings → Harnesses → Agent harness**. The next Agent launch uses
the same model, engine, context and workspace; only the agent loop changes.

The host starts DStudio's bridge,
[`src/harness/bridge/dstudio-harness.mjs`](../src/harness/bridge/dstudio-harness.mjs),
in place of its native Agent runtime. The bridge speaks the native runtime's
protocol (prompt text and `\x1e` frames on stdin/stdout, `+DWARFSTAR_WAITING`
on stderr), so the transcript, diff cards, Stop, the Task Graph receipts and
the conversation store work unchanged. pi runs in its RPC mode; OpenCode runs
as a loopback `opencode serve` driven through its HTTP API and SSE events.

The harness always talks to one loopback OpenAI-compatible endpoint inside the
bridge, protected by a per-process token. Behind it:

- **Qwen3.6 / Qwen3.8-27B (llama.cpp)**, **Qwen3.6 (MLX)** and **remote
  endpoints**: the host's model RPC. The bridge never receives an API key, and Stop cancels the request.
- **DeepSeek and the other ds4 models**: a `ds4-server` the bridge starts from
  the selected engine and stops on exit. For pi this goes through **pi-ds4**,
  patched to use that server instead of cloning, building and starting its own
  ([patch notes](../patch/harness-pi-ds4/README.md)). For OpenCode the bridge
  configures its OpenAI-compatible provider with DeepSeek's reasoning field.

The endpoint applies DStudio's model identity, sampling and thinking choice
(`chat_template_kwargs.enable_thinking` for Qwen, `reasoning_effort` for ds4)
and keeps a long silent prefill alive, so no client idle timeout ends valid
model work.

**Process ownership.** The bridge leads its own process group; Stop and
escalation signal the whole group, so the harness and any `ds4-server` stop
with it. If DStudio dies, the bridge sees stdin close and stops its children.
After every live run the gate checks that no process of the run survives.

**Workspace confinement.** pi always loads
[`pi-workspace-guard.ts`](../src/harness/bridge/pi-workspace-guard.ts), which
blocks `read`/`write`/`edit`/`grep`/`find`/`ls` outside the workspace (real
paths, so a symlink cannot escape). OpenCode runs with
`external_directory: deny` and
[a patch](../patch/harness-opencode/README.md) that makes the workspace itself,
not its enclosing git repository, the boundary. Shell commands are not
sandboxed in any harness, including DStudio's own.

**Offline.** pi runs with `--offline`, no telemetry and no update checks.
OpenCode runs with the model catalog fetch, auto-update, sharing, LSP
downloads, project config and external skill folders disabled, and a private
XDG directory per harness.

## Installation

Settings → Harnesses → **Install**, or:

```sh
python3 scripts/install-harness.py --root <managed root> --harness pi        # also pi-ds4
python3 scripts/install-harness.py --root <managed root> --harness opencode
```

The sources ship with DStudio. Their JavaScript dependencies do not: this
explicit step downloads them once, pinned by each lockfile (`npm ci`;
`bun install --frozen-lockfile` with a private `bun@1.3.14`), applies the
versioned patches with `git apply --check` first, builds in a private stage
and publishes `<root>/harness/<name>` with a receipt (pin, patch SHA-256s,
entry-point SHA-256). A changed pin, patch set or entry point makes the
installation not current. Measured on an M2 Max: pi about 3 minutes,
OpenCode about 6 (a 103 MB executable). Launching afterwards is offline.

## What was tested — October 3, 2026, Apple M2 Max, macOS

`make test-harness-live` runs each harness × model through the production host
with real weights and three generated tasks checked independently: compute a
CSV total and write it to a file (exact contents), answer a code from a file
in the same session, and a file-tool read outside the workspace that must not
return the outside file.

| | Qwen3.6-35B-A3B (llama.cpp) | Qwen3.6-35B-A3B (MLX) | Qwen3.8-27B (llama.cpp) | DeepSeek V4 Flash (ds4-server) |
| --- | --- | --- | --- | --- |
| pi | 3/3 | 3/3 | 3/3 | 3/3 (pi-ds4) |
| OpenCode | 3/3 | 3/3 | 3/3 | 3/3 |

The MLX column ran later the same day (`run-AezcOn`, 6/6), after the native
MLX run below.

Retained failures: `run-Q00iea` ran a stale host binary (the native Agent
answered; the confinement case caught it, and the target now rebuilds the
host); `run-qIhfpz` showed OpenCode reading beside the workspace, which led to
the confinement patch. Both receipts stay under `tests/.artifacts/harness-live/`.

Native harnesses with the llama.cpp models (`make test-llama-resident-live`):
Agent, Cowork and Chat pass on both models. On **Qwen3.6 MLX** all six native
checks pass, Design included (`run-scIcQY`; the three earlier MLX failures
and their fixes are listed in [tests/README.md](../tests/README.md#qwen36-on-mlx-apple-silicon)). **Design** now runs on them with
structured tool calls: Qwen3.6 saved a page with the exact requested heading
through the full Design flow (todo, write, read, edit, verify, critique,
artifact). Its first attempt over the DSML text protocol is retained as a
failure (`run-seDvHn`): Qwen wrote malformed DSML, so llama.cpp models now
receive Design's tool schemas as function tools. On Qwen3.8-27B with thinking
on, the first Design run is retained as **BLOCKED** (`run-i63kwA`): the saved
page already had the exact requested `<h1>` and `verify_artifact` reported 0
errors, but the turn was still verifying and critiquing when the test's
one-hour turn bound expired (about 8 tokens per second). Rerun with the same
settings and no turn bound (`DSTUDIO_REAL_TEST_TIMEOUT_MS=0`, `run-X0nLw6`), the
whole 27B run passed 6/6: Design finished in 37 minutes with the exact
heading, and Agent, recall, Cowork, Chat and owner death passed again. The
slow turn is the model's speed, not a hang.

## The complete matrix and what is not covered

Every inference path reaches every harness: DStudio Agent, Cowork and Design
run on ds4 models, llama.cpp models, the MLX model and remote endpoints; pi and
OpenCode run in Agent mode on the same four. The cells above are the ones executed with
real weights. Not run with pi/OpenCode: GLM 5.3, Qwen3.8-Flash-Next, Laguna and
DeepSeek V4.1 (they use the same bridge-owned `ds4-server` path as DeepSeek V4
Flash), and cloud endpoints (the same model RPC path as llama.cpp). Linux,
Windows, CUDA, ROCm and Vulkan are not run; the harness launch is rejected on
Windows. pi and OpenCode do not run Cowork or Design, which keep DStudio's own
tools. These are development regressions, not a quality benchmark.

Known limits: model RPC validates at most 32768 JSON tokens per request, so a
very long harness session can be refused rather than truncated; pi and
OpenCode keep their sessions in memory for the lifetime of the Agent process
(DStudio still saves the transcript); mid-turn steering is not forwarded to
external harnesses.

## Tests

- `make test-harness-bridge` (check-fast): the bridge's production classes with
  simulated pi, OpenCode, host RPC and ds4-server.
- `make test-harness-patches` (check-fast): patch apply/repeat/reverse/drift,
  receipt rules and the bundled snapshots' identity.
- `make test-harness-live`: real models (`DSTUDIO_HARNESSES`,
  `DSTUDIO_HARNESS_MODELS`, `DSTUDIO_HARNESS_CTX`).
