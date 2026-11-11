# Native backends, model variants and harnesses

[All test guides](../README.md). Run commands from the repository root.
Each section retains its original scope, prerequisites, results and limitations;
a historical pass is not a pass on a newer runtime.

## Native backend and browser gates

### Cowork spreadsheet read scope and saved-file receipts

`make test-cowork test-cowork-bench-validate` executes the production Python
helper, C/JSON/Python bridge, native HTTP endpoints and document-table previews.
It uses actual generated Office files, not LLM answers. The read regressions
cover default A1:T50 omissions, explicit follow-up ranges, stale XLSX dimensions,
Unicode and character/byte limits, literal zero-padded IDs, formulas and source
preservation. A deterministic serialization counter verifies that a shared cell
string is not expanded thousands of times before the output budget is applied.
Document-table extraction must reject dimension metadata that excludes stored
cells. Writer receipts report normalized sheet names and ranges with
`readBack:false`; only a separate read observes saved values.

The read scope describes nonempty data in the selected worksheet, not formatting,
all workbook sheets or semantic verification. Output is bounded both to 750,000
characters and below the bridge's 1 MiB UTF-8 byte limit. These are file/tool
regressions; run the separate real Qwen tools gate below to assess that workflow.

### Qwen3.6 and Qwen3.8-27B on llama.cpp

Both models run on DStudio's bundled llama.cpp `b11836` (`f5027fb`), built
offline from `src/engines/llama.cpp` on first use. Agent and Cowork use the
pinned main `ds4` tool runtimes in remote mode against the owned resident
`llama-server`; Chat uses the same process through the `/v1` proxy. Design
uses its remote adapter over the same model RPC, with the tool schemas sent as
structured function tools (`DS4UI_REMOTE_TOOL_PROTOCOL=openai`).

`make test-resident-unit` compiles the production routing, preflight and
`/props` readiness functions: model-to-engine routing (the projector file is
not a model), every mode admitted for the llama.cpp models, context/power/DSpark
preflight and the refusal of SSD streaming, the llama.cpp/MLX install
locations, and readiness that must match the exact model path, alias, build,
slot count, context and vision modality (a 27B server without its projector
loaded is not ready). A `/props` reply from another model or build is not
ready. It has no retired-checkout or missing-projector-file case: the
refusal of a checkout whose receipt names another engine, and of a 27B launch
without its projector, is asserted by `make test-launch-preflight`.

`make test-resident-guard` (`tests/integration/resident_guard_test.mjs`) runs
the real `--resident-guard` process with a stand-in server script. Closing the
owner channel (Stop or host death) stops the server; a server ignoring SIGTERM
is killed after the 4-second grace; a changed executable is refused before
exec; an installation in progress is refused, not waited for; and the guard
runs only as a process-group leader. No model or llama.cpp build is involved.
Both targets are part of `make check-fast`.

```sh
make test-llama-resident-live DSTUDIO_LLAMA_MODELS=qwen36   # or qwen27
```

This explicit heavy gate builds or reuses the managed `llama.cpp`, launches the
real host in a private profile with the existing verified weights and runs six
cases per selected model: an Agent CSV total computed with real tool calls,
Agent recall, a Cowork summary of a saved file, a Design page saved with the
exact requested heading, Chat with thinking on (exact product plus reasoning
present) and off (no reasoning) and, in that same case, a 27B image question
with a pixel-only expected answer on llama.cpp (27B on MLX must refuse the
image), and owner death releasing the server. It refuses to start
when port 28000 is already listening. Receipts, requests and answers stay in
ignored `tests/.artifacts/llama-resident-live/`. The first Qwen3.6 attempt
(`run-vaKmku`) is retained as a failure: with thinking off it computed
4249045 instead of 4248045. The corrected case checks exact arithmetic with
thinking on and a thinking-off reply without reasoning; both models then passed
10/10 (`run-NFwKHF`: five cases each, before the Design case existed). These
are development regressions on Apple Metal, not
held-out quality, numerical parity or CUDA/ROCm/Vulkan qualification.

Those 10/10 runs used `b11371`. On `b11836` (October 23) Qwen3.6 passed the
current six cases (`run-7Ad19x`); the first attempt (`run-RpFauU`) failed on a
stale `agentDiskCheckpointsSupported` assertion written before transcript
restoration and is retained. On November 11, 2026 Qwen3.8-27B passed the six
cases on `b11836` too (`run-vQz1Lv`, from a clean worktree at `11cd3cef`): the
Design case took 3,367 s, inside the test's one-hour bound.

`make test-llama-install-profile` (in `check-fast`) executes the installer's
production build recipes, receipts and leases with simulated toolchains
(tiny `nvcc`/`hipconfig`/`amdgpu-arch`/`glslc` executables): the macOS recipe
keeps its original build identity; Linux/Windows add every CPU variant and a
module per detected backend; a requested backend without a toolchain fails;
an unrecorded `libggml-*` module or changed bytes make an installation not
current; exclusive install and shared server leases exclude each other.

`make test-llama-dynamic-build [LLAMA_DYNAMIC_INFER=gguf/MODEL.gguf]` builds the
dynamic (Linux/Windows) layout for real on macOS, offline under `sandbox-exec`:
shared libraries, every Apple CPU variant and the Metal module. It checks that
no load command points into the deleted stage, that the server runs from a new
location and lists Metal, reuse, and tamper rejection; the optional model run
loads existing weights once and checks one exact answer. The first run is
retained as a failure (`run-n4hyywj1`): its relocation check matched raw bytes
and caught `__FILE__` source paths that the tested static build also contains;
the corrected check reads `otool -l` load commands. This does not execute
CUDA, ROCm, Vulkan, Linux or Windows; those paths were only cross-compiled with
`zig cc` (x86_64/aarch64 Windows, x86_64 Linux).

### Qwen3.6 on MLX (Apple Silicon)

Qwen3.6-35B-A3B also runs from the MLX MXFP8 folder
(`mlx-community/Qwen3.6-35B-A3B-mxfp8`, pinned revision `5c216c8`) on the MLX
runtime bundled as unmodified wheels in `src/engines/mlx/` (mlx 0.32.4,
mlx-lm 0.32.2). The same resident owner, guard and model RPC serve it; only the
server (`python -m mlx_lm server` from a private virtual environment, with
`patch/mlx-lm-single-model`) and the readiness probe (`/v1/models` must list
exactly the admitted folder) differ.

- `make test-mlx-install-unit` (in `check-fast`): wheel verification against the
  manifest (changed, extra or linked wheels install nothing), per-Python hash
  selection, interpreter discovery with simulated interpreters, the receipt
  rule, and the patch's apply/repeat/reverse/drift lifecycle with real
  `git apply` on the `server.py` taken from the bundled wheel.
- `make test-mlx-install` (explicit; macOS 26, Python 3.12-3.14): a real
  installation into a new root with outbound network denied by `sandbox-exec`
  (pinned versions, Metal reachable, the server CLI runs, reuse, a changed
  interpreter is not current). No model is loaded.
- `make test-mlx-download-host` (in `check-fast`; Apple Silicon): seven real
  HTTP/process/file scenarios with a simulated installer and tiny weight files:
  the runtime installs before any weight transfer without changing the selected
  model, progress counts the folder and its private stages against the pinned
  36.67 GB, Open folder, verification is not completion, installer and
  verification failures, the refused partial cleanup, a linked folder admitted by
  its target's identity, and the real downloader rejecting a folder replaced
  after admission (`--verify-only`, offline).
- `make test-mlx-model-ui` (in `check-fast`): the production catalog/download UI
  functions; the download is offered on a Mac only.
- `make test-resident-unit` and `make test-resident-guard` include the MLX
  readiness rule and the MLX guard kind with its own installation lease.
- Real inference: `make test-llama-resident-live DSTUDIO_LLAMA_MODELS=qwen36mlx`
  and `make test-harness-live DSTUDIO_HARNESS_MODELS=qwen36mlx` (results in
  [docs/HARNESSES.md](../../docs/HARNESSES.md)).

October 3, 2026, M2 Max, the user's existing verified MXFP8 folder linked into
`ds4/mlx/`: the resident live run passed **6/6** (`run-scIcQY`): Agent CSV
total, recall, Cowork, Design with the exact `<h1>` (133 s), Chat with
thinking on (reasoning present, exact product) and off (no reasoning), and a
killed host leaving no MLX server. Startup, including the offline MLX
installation, took 22 s. Three earlier runs are retained as failures, each
fixed in production code with a regression:

- `run-dI6doj`: `/api/start` rejected the folder as a missing model file (only
  regular files counted); `model_rel_present` now admits an MLX folder with
  `config.json` (unit-tested with a file, an empty folder and a link).
- `run-GDiTZ0`: the loaded server was never declared ready, because its
  Python HTTP server answers `HTTP/1.0` and the probe accepted only `HTTP/1.1`.
  The probe now accepts both; the unit test replays the real server's reply.
- `run-JzTNjb`: 4/6. Chat lost the reasoning (MLX names the field `reasoning`;
  fixed by `patch/mlx-lm-reasoning-content`) and Design stopped with
  `finish_reason=length` (upstream's 512-token default for requests without a
  limit; the server now starts with `--max-tokens` equal to the context).

These are development regressions on one Mac, not a quality comparison with
the llama.cpp Qwen3.6 or a numerical-parity claim for MXFP8.

The MLX downloader's `--verify-only` mode (since merged into
`scripts/download-qwen-variant.py --variant qwen36-mlx`) checked an existing
local copy against all 20 pins (36,665,809,057 bytes) in 27 s.

### Every pinned Qwen3.6 and Qwen3.8-27B variant

`scripts/qwen-variants.json` pins 63 variants: 24 GGUF and 8 MLX for
Qwen3.6-35B-A3B, 25 GGUF and 6 MLX for Qwen3.8-27B (every 27B GGUF with the
pinned F16 projector; both BF16 GGUFs split in two files). `make
test-qwen-variants` (in `check-fast`) runs everything below without network,
engines or weights; model files are tiny or sparse fixtures. These checks prove
download, recognition, routing and refusal behavior, not inference: only the
default selections (Q6_K_XL, MXFP8) have run on real weights.

- `tests/integration/qwen_variant_download_test.py` executes the generic
  downloader `scripts/download-qwen-variant.py` and its real curl transfers
  against a loopback HTTP fixture with a test catalog: a single-file GGUF, a
  27B GGUF with its projector fetched from its own pin, a split BF16 variant
  landing in `gguf/` under its own names, and an MLX folder that publishes
  `config.json` last, with D/V progress phases. A size or digest mismatch is
  refused without publication (the partial stays resumable), a replaced store
  is never written, `--verify-only` never downloads, a non-loopback base URL is
  refused, and read-only commands touch neither disk nor network. The shipped
  catalog validates, has the expected counts and keeps the three original
  pins (`qwen36-q6`, `qwen27-q6`, `qwen36-mlx`) frozen: changing any of their
  files is refused. The same file runs the repository `download-model.sh` with
  stub `make`/`dstudio`: every target, the original ones included, installs its
  engine (llama.cpp or MLX) and lands in `ds4/gguf/` or `ds4/mlx/<folder>/`
  through this one downloader, an unknown target stops before building, and
  `--list-qwen` lists the catalog.
- `tests/integration/qwen27_download_test.py` exercises the downloader's
  per-file machinery (resume, linked or oversized partials, concurrent leaders,
  SIGTERM, replaced stores, credentials).
- `tests/unit/qwen_variants_unit.c` executes the host's catalog loader and its
  consumers on fixture trees: the compiled original pins equal their catalog
  entries; the 22 textual edits in
  `tests/fixtures/qwen-variants/invalid-edits.json` (also applied to the Python
  loader) are each rejected as a whole, leaving only the original pins; the
  catalog endpoint serves the file byte for byte, or the original pins when it
  is missing; recognition of non-default quantizations on both engines,
  hidden second split parts, refused unpublished and modified names; labels
  with the quantization; preflight for a missing split part or projector,
  power, context and SSD streaming; the launch spec (27B MLX has no projector,
  27B GGUF has one), its dependencies (split part, catalog file) and the real
  llama.cpp/MLX argument lists; listings; download sizes, byte progress and
  paused-download detection after a restart; refused partial cleanup.
- `tests/integration/qwen_variant_download_host_test.mjs` drives the real host
  over HTTP with simulated installers and a simulated generic downloader: a
  non-default GGUF and a 27B MLX folder each install their engine first,
  receive `--variant`, their store and its identity, report bounded progress
  against the pinned size and complete only on the downloader's exit (off
  Apple Silicon the MLX target is refused instead); a failed MLX verification
  stays resumable; unpinned targets are refused; a support
  directory without the catalog serves the original pins, which the production
  UI functions offer.
- `tests/unit/qwen_variants_ui_test.mjs` and the extended
  `tests/unit/qwen27_model_test.mjs` execute the production UI functions on the
  served document: offers, labels and grouping per family and engine, MLX on a
  Mac only, offers disappearing when every file is present, split and projector
  rules, quantization labels in the picker, and image attachments kept but
  refused on 27B MLX. `tests/browser/ui_model_picker_playwright_test.mjs`
  (Chromium and WebKit) now shows pinned non-default quantizations with their
  labels and still hides an unpublished `Qwen3.8-27B-Q4_K_M.gguf`.
- `make test-macos-bundle` checks that the bundled host serves the materialized
  catalog byte for byte and that the materialized generic downloader validates
  and lists it.

Real-weight verification of the variants is planned as five checks with the
production-host gate and has NOT RUN (no weights downloaded yet); see
[docs/WORK_IN_PROGRESS.md](../../docs/WORK_IN_PROGRESS.md).

### Streaming and live tool previews

`make test-streaming-live` (explicit, real weights) samples `/api/agent/poll`,
the transcript the UI reads, every 100 ms during one turn per path (DStudio
Agent, pi, OpenCode, Cowork, Design). `DSTUDIO_STREAM_SCENARIO=prose` measures
plain text; `write` asks for a file and measures the live tool preview
(`tool_body_delta` text) while the call is generated, then checks that the file
exists in the workspace and that nothing was written outside it. A path passes
when its output arrives in at least five increments and no increment carries
more than half of it.

October 3, 2026, M2 Max: prose streamed on all five paths with Qwen3.6
(`run-JG9D0a`). The first `write` run (`run-FELWf8`) streamed **none** of the
five on llama.cpp: tool-call arguments reached runtimes and harnesses only as a
complete call. After the fix (the host relays `model_tool_delta`, the remote
client and the bridge turn it into live frames), Agent, Cowork, Design and
OpenCode streamed (`run-gOFF8d`), pi did not, because pi's RPC wire strips the
partial message the bridge read (retained failure); with that corrected, pi and
OpenCode streamed (`run-Vhzkb3`). DeepSeek (ds4): Agent, pi-ds4 and OpenCode
streamed (`run-RPpkpT`, `run-sijpLh`; one OpenCode attempt was refused because
the test sent its prompt while the harness was still loading, now awaited).
MLX first previewed every file in one or two blocks (`run-eaO4iF`, retained):
the MLX server itself held a tool call until it was complete.
`patch/mlx-lm-tool-streaming` converts Qwen's tool format while it is generated;
then all five paths streamed on MLX (`run-CqtFx5`).
`make test-mlx-install-unit` also checks that conversion against the wheel's
own parser on random calls and every split.
Two OpenCode runs (`run-FELWf8`, `run-gOFF8d`) wrote their file into the
enclosing repository through the shell after the write tool was refused; the
stray files were removed and `patch/harness-opencode/workspace-root.patch` makes
the workspace the root OpenCode reports.

Model-free coverage of the same path, all in `check-fast` except the runtime
target: `make test-remote-tool-preview-unit` (the C argument scanner on every
two-cut split, escapes, surrogate pairs, path after content, nested values,
malformed input, bounded batches), `make test-model-rpc-stream` (the host relays
fragments in order, with the name and call id first, and they concatenate to
the validated batch, which still comes once), `make test-harness-bridge` (the
JS scanner, tool fragments streamed to the harness, a validated batch that
differs is an error, ds4 SSE tap, pi's wire events) and
`make test-remote-tool-preview REMOTE_TOOL_AGENT=...` (the built Agent and Cowork
runtimes, main and Laguna, emit the exact previewed text before executing).

### App-binary helper modes

The desktop app binary re-executes itself for the server guard
(`--resident-guard`), the model RPC worker and launch preparation. The guard
mode was missing from the app's dispatch, so in the real app every llama.cpp or
MLX start failed with "guard closed its owner channel" (tests use the server
binary, which dispatched it). `make test-macos-bundle` now also runs the guard
test against the bundled app binary (8/8), and the MLX resident run passed 6/6
through the app binary (`run-qzjivw`).

### Harnesses: pi and OpenCode as the Agent runtime

`make test-harness-bridge` (in `check-fast`) executes the bridge's production
classes with real processes and sockets; pi, OpenCode, the host's model RPC
and ds4-server are explicitly simulated. It covers stdin framing and the
quiet-interval prompt boundary (the test sets the interval to 30 ms; the
production 200 ms default is not timed), frames that cannot be forged by model
text, the
loopback endpoint's identity/sampling/thinking rules, one model request at a
time, Stop failing in-flight and queued requests without letting a late frame
through, pi RPC and OpenCode SSE event translation, user-echo exclusion and
the WAITING marker after finished and stopped turns. The turn-error marker is
checked only as the bytes the output writer emits: no simulated harness run
ends in a turn error. `make test-harness-patches` (in `check-fast`) runs
real `git apply` on private copies: apply, repeat-apply rejection, exact
reverse, drift rejection without changes, the receipt rule (a different patch
set, pin or entry point is not current) and the bundled snapshots' identity.

`make test-harness-live` (explicit, real weights, sequential) runs pi and
OpenCode through the production host with Qwen3.6 and Qwen3.8-27B (llama.cpp)
and DeepSeek V4 Flash (bridge-owned ds4-server): a CSV total written to a file,
a code read in the same session and a file-tool read outside the workspace,
each checked independently, plus no surviving process after the host stops.
Since November 11 `DSTUDIO_HARNESS_MODELS` also accepts `laguna`, `next`
(Qwen3.8-Flash-Next Q4) and `v41` (DeepSeek V4.1 1017 Q2, started with expert
SSD streaming; the row fails when that mode is not the effective one). Their
first run, November 11 (`harness-live/run-QcD4eH`, development check): on
Qwen3.8-Flash-Next and V4.1 both harnesses wrote the CSV total and answered
from the workspace file (8/8); the outside-workspace case passed once
(OpenCode on Next) and was BLOCKED three times because the model attempted
no read, so confinement was not exercised there (not a pass and not an
escape). Both Laguna rows failed at startup: the runner did not select
Laguna's checkout before the launch as the app does, so the bridge started
main's `ds4-server` on Laguna's weights and it exited. The runner now selects
the checkout the host's model catalog names; Laguna is to be run again.
October 3, 2026: 18/18 on all six combinations. Retained failures:
`run-Q00iea` (a stale host binary ran the native Agent; the target now
rebuilds the host) and `run-qIhfpz` (OpenCode read beside the workspace; fixed
by `patch/harness-opencode`). See [docs/HARNESSES.md](../../docs/HARNESSES.md).

`make test-llama-resident-live` also includes a Design case: the saved page
must contain the exact generated `<h1>`. Qwen3.6 passed with structured tool
calls; its first DSML-text attempt (`run-seDvHn`) is retained as a failure.
On Qwen3.8-27B (thinking on) the first run is retained as BLOCKED at the
one-hour turn bound (`run-i63kwA`): the page with the exact heading was saved
and verified, but the turn had not finished. The same run with no turn bound
(`DSTUDIO_REAL_TEST_TIMEOUT_MS=0`, `run-X0nLw6`) passed 6/6, Design in 2241 s.

`make test-qwen27-download-host` runs seven real HTTP/process/file scenarios,
with explicitly simulated installer and model bytes. It verifies asynchronous
engine preparation, two-component progress, a captured store despite another
checkout selection, Open folder for that same store, verification before
completion, Stop, failures and Resume.
A native ownership regression keeps a separate process alive while cancelling
the blocked installer; the download must not inherit the host's model-stop
signal handler. New cold owner state is 4,108 bytes, with a fixed two-file scan
and at most four one-byte downloader phase notifications. No hot layout changes.

`make test-qwen27-download` executes the real Python/curl downloader against tiny
HTTP fixtures: hashes, exact-range resume, size bounds, concurrent leaders,
directory/file identity, failure preservation and transfer/verification phases.
The host passes the admitted store's device/inode so a replacement directory
cannot receive a stale download after engine preparation.

`make test-ui-qwen27-download` exercises the actual Settings controls and native
HTTP host with the same simulated installer/weights. Each run uses one browser
and one theme (WebKit and light by default, as the Make target runs it). Select
WebKit or Chromium
with `DSTUDIO_TEST_BROWSER=webkit|chromium` and light/dark with
`DSTUDIO_TEST_THEME=light|dark`. It covers confirmation, setup, transfer, hashing,
Stop and Resume; download progress must never replace the composer model label.

`make test-qwen27-download-settings-live QWEN27_INSTALL_ROOT=/path/to/install`
uses a previously installed pinned `llama.cpp` and both real components. The
production Settings HTTP path verifies the actual weights/projector and reuses
the engine, preserving their identities and current model selection. It starts
no LLM and does not substitute for an empty-network-install or inference gate.

`make test-qwen27-model-ui` executes the production model catalog, settings and
request functions. It distinguishes 27B from Flash-Next, checks the exact
projector/quantization pair, preserves other models' preferences, and sends
`chat_template_kwargs.enable_thinking` without a `reasoning_effort` for the
llama.cpp models. The existing `ui_model_picker_playwright_test.mjs` exercises
actual controls, launch requests and light/dark rendering for 27B as well as
the earlier models. Run it normally and with `DSTUDIO_TEST_BROWSER=webkit`;
its engine is simulated. `make test-qwen27-model-ui` also executes attachment
preparation for Chat/Tutor, Cowork and PDF routing, preserving attachments when
a textual/cloud/LAN model does not support those pixels. Its PDF renderer is
simulated.

`node tests/unit/cowork_spreadsheet_oracle_test.mjs` executes the real Office
CLI on temporary CSV/XLSX files in sixteen model-free cases; it is included in
`test-cowork-unit`. A CSV/TSV `inspect` can be a complete read; XLSX `inspect`
is metadata and cannot replace cell reading. Partial/truncated results,
mismatched IDs, wrong values, missing results and readback before creation fail.
`make test-goal` exercises Goal receipt cases and the existing continuation,
pause/resume and journal-recovery contracts.

`make test-macos-bundle` exercises current-main Chat runtime preparation using
the materialized bundle payload from Finder's `/` working directory, and checks
that the bundle ships the `main`, `laguna` and `llama` sources with the
installer pin. The lifecycle compiler is explicitly simulated. An old bundle
lacking the current PLD patch fails this test; a separate actual native build
verifies compilation. No model is loaded or user app restarted by this gate.

The common-100 runner in `tests/live/engine_acceptance.mjs` has an explicit
`--restart-failed-engine` option. Only the tester's native engine is stopped and
reaped before a fresh process is started with the same weights, binary and
settings. At most eight restarts are allowed; the failed case remains failed and
is never retried. Subsequent cases keep their original prompts/deadlines.
Missing readiness, changed identity, cancellation or an exhausted restart budget
stops the run with remaining cases marked not run.

`make test-qwen-quality-chart` checks actual Matplotlib bars against the reviewed
public common-100 aggregate, preserving every failure and rejecting incomplete,
inconsistent or simulated measurements. The chart is tied to the reviewed
source receipt so another model/run cannot inherit its hardware/date captions.
Recreate it with `python3 extension/benchmarks/qwen-quality/plot-results.py`.
The [benchmark notes](../../extension/benchmarks/qwen-quality/README.md) describe
that development replay; it was measured on the retired `q36` engine and is not
a llama.cpp result.

`make test-engine-upstream test-engine-pins` tests release admission separately
from model quality. The first suite uses controlled Git remotes, real patch
conflicts, scoped receipt failures and the actual `dist-macos` publication
recipe with a tiny fixture bundle. The second executes the compiled native
`--engine-pins` command, including a relocated path with spaces, invalid
arguments and no profile writes or model startup. To test the desktop binary
itself, run `node tests/integration/engine_pins_test.mjs /path/to/DStudio.app/Contents/MacOS/DStudio`.

`make check-engine-upstream` is a different command: it checks the declared
candidate matrix, current remote revisions and actual installer metadata. The
initial matrix intentionally fails while required source reviews, installers
and qualification receipts are missing. `dist-macos` runs it against the
freshly built bundle before making a release ZIP; normal `.app` builds remain
available. See [upstream admission](../../docs/ENGINE_UPSTREAM_ALIGNMENT.md) for
checkouts, platform scopes, evidence format and limitations. A checker-fixture
PASS is never an engine, inference or multi-platform qualification PASS.

`make test-backend-link` executes GNU Make with the two local upstream
Makefiles (`ds4` and `ds4-laguna-s21`; other source trees only when passed as
arguments) and compares native versus Agent/Chat-PLD/Design linker invocations
for Metal, CPU, CUDA and ROCm. ROCm arguments come from the upstream target's
actual recursive Make invocation, not a copied core-object list. The compilers
and linkers are explicitly simulated; this checks backend routing and complete
object/library selection, not compilation or inference on unavailable GPUs.

`make test-pld-build` checks the production Chat builder with a simulated compiler:
cache, Metal-only invalidation, preservation of a working binary on failed links,
invalid linker outputs, source changes during compilation and unsupported ABI.
It retains the original failures and successful runs under ignored
`tests/.artifacts/server-pld-build/`; no compiler fixture is counted as inference.

`node tests/browser/ui_agent_design_playwright_test.mjs` checks the real UI's
Chat continuation, native steering, late-reply draft preservation, receipt
reconciliation across turn changes and Goal controls. Run also with
`DSTUDIO_TEST_BROWSER=webkit`. `node tests/browser/ui_roadmap_playwright_test.mjs`
checks the learning pipeline and Tutor continuation with prior context intact.
Browser HTTP/model replies are simulated. None of these tests measures model
quality. See [behavior, limits and branch evidence](../../docs/GOALS_AND_STEERING.md).

`make test-ui-qwen-learn` exercises that full Learn/Tutor workflow for Qwen3.8
and Qwen3.6, including model-specific thinking, unchanged configured context,
research/audit/retry routing, text selection, reading position and persistence.
It also repairs moved engine paths during generation, block expansion and
Tutor, without discarding the pending question (`DSTUDIO_TEST_STALE_CHECKOUT=1`).
Repeat with `DSTUDIO_TEST_BROWSER=webkit make test-ui-qwen-learn`.
The original DeepSeek case remains the runner's default; `DSTUDIO_TEST_MODEL`
accepts `deepseek`, `qwen38` or `qwen35`. Each run serves one frozen HTML input
and retains its hash, requests, outcome and failure screenshot in ignored
`tests/.artifacts/roadmap-browser/`. These are simulated-engine UI tests, not
model-quality results or a foreground `.app` E2E.

`make test-chat-lifecycle test-follow-scroll` executes the production settings,
readiness, HTTP/SSE and scroll functions with deterministic barriers/frames.
It checks stale model selections (including A → B → A), immutable request
inputs, cancellation and shared launch interest, plus deferred scroll writes.
Checkout tests execute the production resolver, launch preparation and API
client together: repaired identities propagate to each caller without borrowing
another caller's sampling/thinking/context or reviving an obsolete selection.
The same gates are prerequisites of `make test-frontend-unit`. Their receipts
are separate from real-model testing and preserve the original failed runs.

Browser fixture preferences must be initialized only in the top-level app's
own origin. Preview frames retain their opaque sandbox; browser errors are not
suppressed to accommodate test initialization. The gear, context and attachment
preview regressions also accept `DSTUDIO_TEST_BROWSER=webkit` (default Chromium).

The model-picker browser gate checks light/dark at desktop, 390 px and 320 px:
popover anchoring, the exact launched model file without a checkout switch
(the fixture has one main installation), keyboard/search behavior,
and the visible geometry and hit targets of **all** composer controls, including
Send and the readable reasoning level. It waits for the real sidebar transition
instead of disabling animations. Each attempt keeps a separate receipt and
screenshots; failures also capture the visible page. These layout checks do not
claim that a simulated engine generated a correct answer.

### Engine source-delta review

`make test-engine-delta-review` (in `check-fast`) checks the main-track review
recorded in `docs/engine-upstream.json`, without a clone or network:

- every review's evidence file exists inside the repository, is not a link and
  hashes to its recorded SHA-256; every review names a commit of the
  [inventory](../../docs/upstream/main-delta-2026-11-11.json) once, in the
  inventory's order;
- the production generator (`scripts/engine-delta-review.mjs --check`)
  reproduces the manifest bytes from that inventory, after checking that
  `src/engines/` still holds the files that were compared with upstream;
- on macOS, the generator's compiled path rules equal the preprocessor's
  include closure of upstream's default build, taken from a dry run of the
  shipped Makefile on a private copy (elsewhere this part prints `NOT RUN`);
- on a synthetic Git history made by the test, a commit that touches only a
  CUDA file or only Makefile lines of another platform is not applicable, one
  that touches a shared file is integrated, one whose path no rule covers or
  whose runtime file the shipped tree does not have stays unclassified, and a
  target built from its own branch gets no decision for a runtime change; a
  second run writes identical bytes; the real
  admission checker accepts the generated reviews and still reports each
  unclassified commit; a shipped tree that differs from its pin (changed,
  extra, missing, wrong executable bit, or a runtime file declared omitted) is
  refused without output.

It does not read upstream history and reviews no commit: a PASS says the
recorded classification is the one the rules give, not that a classification
is right about behaviour. [Method and limits](../../docs/ENGINE_UPSTREAM_ALIGNMENT.md#main-delta-review).


### Codex CLI Responses protocol (scripted server)

`make test-codex-protocol` (explicit, not part of `check-fast`: the broad gate
does not depend on a third-party CLI that updates on its own; `NOT RUN` and
failing without the Codex CLI) runs the installed `codex exec` against a
scripted loopback server
that speaks the Responses API as the pinned `ds4-server` source does, through
the third-party CLI benchmark's own proxy, configuration, command line, event
parser and grading function. It checks file contents, exit status, the CLI's
JSON events and the exact requests received: a complete tool loop, reasoning,
split and Unicode frames, call identifiers, resume, compaction, Stop,
truncated/malformed/refused responses, the sandbox, isolation from the user's
environment and three fixture tasks graded by the benchmark. Every reply is
scripted: it proves nothing about a model, about Codex as an agent or about
the running engine. November 11, 2026: 26/26 with codex-cli 0.167.0 on macOS;
other versions and platforms were not run. Scope, observations and what
remains open: [extension/task-graph/bench/README.md](../../extension/task-graph/bench/README.md).
