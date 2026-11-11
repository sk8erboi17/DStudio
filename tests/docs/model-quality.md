# Model development checks and measured results

[All test guides](../README.md). Run commands from the repository root.
Each section retains its original scope, prerequisites, results and limitations;
a historical pass is not a pass on a newer runtime.

## Qwen Next on unified main

Flash Next now uses antirez/ds4 main `890898c`, not a separate managed engine.
The new Q2/Q4 GGUFs include original BF16 n-grams; historical base + PLE receipts
do not qualify those weights. [Migration and verification scope](../../docs/QWEN_NEXT_MAIN_MIGRATION.md).

Focused model-free entry points:

```sh
make test-engine-pins test-engine-setup-unit test-launch-preflight test-qwen27-model-ui
make test-agent-patch-migration test-runtime-patch-migration
make test-qwen38-agent test-qwen-session-reset test-qwen38-prepare-patch
make test-main-qwen-download
node tests/integration/glm53_m2max_patch_test.mjs /path/to/exact-main --unified-qwen
node tests/integration/agent_native_build_test.mjs /path/to/built-main
```

The native tests execute real parsers, tool effects, allocation failpoints and
Metal fixture buffers, with simulated model responses where declared. The
download test uses tiny real SHA-checked files and simulated transport. The
`--unified-qwen` stack gate also checks 40,448 hotlist IDs against an independent
int32 oracle under ASan/UBSan and the unchanged 256 KiB scratch bound.
`make test-first-launch-e2e` instead builds the bundled engine sources from an
empty profile through headless WebKit, with external network denied; it refuses weights before transfer and
checks Qwen Q2/Q4 reuse main and that the retired Qwen Next setup route is gone (404).

## Common-100 answer quality

`make test-common-quality-oracle` checks the evaluator without loading a model.
It exercises all 100 authored reference answers, known-wrong answers, ten real
before/after patch fixtures with preserved tests, strict JSON types/duplicates,
and code input preservation. Binary search also has counted element reads at
two sizes. Actual HTTP tests use **simulated replies** to verify that wrong
answers, truncation and missing long-context coverage fail; a transport failure
stops new requests by default and retains all unexecuted cases in the denominator.
The explicit `--restart-failed-engine` option instead waits for the process owner
to reap and replace its engine before the next case, at most eight times. It does
not retry the failed case. Simulations verify the handoff barrier, restart budget,
unchanged model requirement, interruption and failed owner; live receipts must
separately prove actual process teardown and subsequent inference.

The common corpus contains 12 arithmetic, 12 reasoning, 15 code, 10 debugging,
10 JSON, 10 extraction, 10 strict-instruction, eight Italian/English, eight
long-context and five insufficient-information tasks. Coding tasks are pure
Python functions; debugging returns actual unified diffs. These are not Agent
tool-loop tests or a comprehensive measure of open-ended language ability.
Language cases use explicit, objective choices or constrained transformations.

The code evaluator currently requires macOS `sandbox-exec`. Generated code
cannot read personal directories, write files, access the network or fork;
the Python subset additionally excludes imports, reflection and I/O. CPU,
runtime, input and output are bounded. A 256 MiB RSS watchdog terminates excess
memory use; this is a sampled termination threshold, **not a hard address-space
cap**. Other platforms have no unsafe fallback and are reported as unavailable.

An explicit existing-weight, single-engine run uses the native engine path:

```bash
node tests/live/engine_acceptance.mjs --infer --engines qwen \
  --installed-root /path/to/managed-engines --model-root /path/to/gguf \
  --common-quality --quality-use first-exposure
```

`--quality-use development-replay` is the default and must be used after exposure
to these cases. First exposure is to this frozen integration corpus, not a claim
that model training data has been audited. The native engine IDs `main`,
`laguna` and `qwen` are accepted; `--model-file NAME.gguf` chooses one explicit
existing quantization. `llama` is setup-only here: Qwen3.6/27B inference runs
through the host in `make test-llama-resident-live`, and a llama.cpp common-100
campaign has not been run.
This path currently requests resident Metal execution (Qwen3.8-Flash-Next reads
its embedded BF16 n-grams from SSD); it does not claim expert-streaming or other-backend
coverage. Do not run a configuration that exceeds the host's memory budget.
Before loading, the Qwen3.8-Flash-Next path hashes the complete weight file
against its fixed table and records the engine revision. Retained Qwen27B and
Qwen3.6 receipts from the retired `q36`/`ds4-qwen35` engines stay unchanged as
history; they are not llama.cpp results.

Models that only the host can serve use the production launch path instead:

```bash
node tests/live/host_common_quality.mjs --model gguf/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
node tests/live/host_common_quality.mjs --model mlx/Qwen3.6-35B-A3B-mxfp8
node tests/live/host_common_quality.mjs \
  --model gguf/DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf --ssd-streaming on
```

`host_common_quality.mjs` (`make test-host-common-quality HOST_QUALITY_ARGS=...`)
starts a task-owned headless host with a private profile and engine port, asks
it to launch the selected model alone and sends the same frozen corpus through
its `/v1` proxy. The corpus, grader, deadlines and request fields are unchanged.
For llama.cpp and MLX Qwen models it adds `chat_template_kwargs`
`enable_thinking: false`, the switch the app's Chat request uses, and records
it; an extra can never replace a frozen request field. It verifies pinned
weights against `scripts/qwen-variants.json`, records the engine's own
`/props` or model list, DStudio's source receipt, binary hashes, the shipped
patch-set digest and the effective memory mode. A requested SSD-streaming mode
that the runtime does not report as effective stops the run before the first
case. Receipts stay in `tests/.artifacts/host-common-quality/`.
With `--restart-failed-engine`, after a case whose HTTP exchange did not
complete (a frozen deadline, a dropped connection) the runner stops its host
and the engine, checks that the engine is gone and that weights and host
binary are unchanged, starts both again in the same memory mode and goes on
with the next case, at most eight times. The failed case is not retried and
stays failed; each restart is recorded. Without the option the remaining cases
stay not run, as in the native runner.

The native path now reads the engine revision from DStudio's
`.dstudio-source.json` receipt. A managed engine is installed from bundled
sources and is not a Git checkout; a common-100 run on an engine directory
without that receipt fails as unbound instead of borrowing another identity.

Both runners take a resource snapshot before starting a model
(`tests/support/heavy_preflight.mjs`, checked by `make test-heavy-preflight`).
It judges a foreign engine by the memory it holds: an idle router without a
loaded model is recorded and allowed, a process holding a model or one whose
footprint cannot be measured blocks the run. It never stops a process. The
host runner repeats the snapshot afterwards and marks the run contaminated if
another engine loaded a model meanwhile.

`node tests/live/quality_multihardware.mjs status` is the campaign coordinator:
it reads the ten selections of `tests/fixtures/quality_campaign.json` and every
common-100 receipt, and prints per selection what ran on the current engine
pin, model and memory mode. Receipts from retired engines, earlier pins or
another memory mode are listed as not counted with the reason. The first
terminal result on the current identities is the one counted: a later rerun of
unchanged deterministic work is listed but does not replace an initial
failure. Contributor selections and missing weights are BLOCKED, and an
interrupted run leaves all 100 cases not run. `... run [--only ID,...]` starts
the owning runner for each cell without a terminal result, one model at a
time; it is REAL inference and is not part of `check-real`.
`make test-quality-campaign` checks this accounting with synthetic receipts.

The host revalidates its launch dependencies before publishing a model: its own
executable, the assets directory, the model and the installer scripts. A
rebuild or an edit in the same tree while a run is being prepared is refused
with `Launch dependencies changed before publication` (run
`host-common-quality/run-2W3rhe`, November 10, is retained: a `make` rebuilt
the test host during the Qwen3.8-27B launch). Long campaign runs therefore use
a frozen copy of the sources: a Git worktree at the campaign commit with its
own built `tests/.build/dstudio-server-test`, started with
`DSTUDIO_REAL_DS4_DIR` pointing at the installed `ds4` store. Both runners
locate llama.cpp, MLX and Laguna beside that store, and each receipt records
the worktree's commit and that it is clean.

A patch answer whose last diff line lacks only its newline terminator is
accepted after exactly one newline is restored; prose, fences, wrong paths and
broken hunk counts still fail. That correction changed the corpus identity to
`5727dcb4…`. Earlier receipts are re-evaluated without new inference by
`node tests/support/regrade_common_quality.mjs OLD/results.json NEW_DIR "defect"`,
which writes a separate directory and never edits the original. Use an original
run as the source: a regrade directory has no per-case requests and is rejected.
Installation/protocol smoke tests remain separate from this quality option.

Requests use a 65,536-token capacity, temperature 0, seed 20260909, thinking off
and 2,048 output tokens. Frozen deadlines are 180 s for ordinary cases, 240 s
for code/patch cases, 900 s for long contexts. A long case additionally needs
at least 12,000 actual reported prompt tokens; configured capacity alone is not
coverage. Requests, complete responses, source/grader hashes, runtime identity,
timings and failures are retained in a fresh ignored `engine-acceptance` run.
The first model-quality campaign is separate from the evaluator's passing tests;
neither implies numerical parity, PDF/vision quality or desktop qualification.

`node tests/support/common_quality_summary.mjs TERMINAL_RESULTS.json NEW_PUBLIC.json`
creates a new aggregate only after a run is terminal. It checks all 100 cases,
category counts, stored totals and model/binary provenance; simulated model-free
HTTP receipts cannot qualify as model results. It excludes personal paths, raw
prompts and answers. An unrequested JSON wrapper around a correct value is
classified separately but **remains failed**. `common_quality_summary_test.mjs`
checks these publication boundaries with explicitly synthetic unit data.
It reads the receipts of both runners: the native one records one weight file
and the engine binary; the host one records every weight file, the engine's
install receipt and the host binary (an MLX model folder is identified by one
digest over its file list). Both receipts also store the compiler and tools
present when the run started (`toolchainAtRun`): the installers do not record
which compiler built an engine, so the binary's SHA-256 remains its identity.

The campaign's reviewed aggregates and charts are published in
[`docs/benchmarks/quality-multihardware/`](../../docs/benchmarks/quality-multihardware/README.md).
`python3 extension/benchmarks/qwen-quality/plot-results.py` regenerates every
chart and refuses an aggregate that has no reviewed entry for its receipt;
`make test-qwen-quality-chart` checks the drawn bars against the published
numbers, that unexecuted tasks are drawn and counted, and that each reviewed
run is published once with its own receipt digest.

Patch variants, fixtures and tests for the retired Qwen Next fork
(`test-qwen38-inspect`, `test-qwen38-snapshot-patch` and the compressed fork
sources they read) and for earlier main revisions were removed on October 27,
2026: every patch test now covers only the bundled main and Laguna.
Default backend link tests cover the active main and Laguna trees; Qwen Next
uses main and llama.cpp builds with CMake. Supply full source paths to `backend_link_test.mjs` for an
explicit historical backend-routing run. Its compiler outputs remain simulated.

`make test-engine-startup` runs five real HTTP startup cases without
`DS4UI_TEST_MODE`, with inference explicitly deferred and isolated source
fixtures. A persisted checkout whose `.dstudio-source.json` receipt names an
engine DStudio does not run (or no engine) must be left untouched, never
receive ds4 Agent recovery and be refused with `unsupported_engine` when chosen
explicitly; clean native sources remain
usable and missing/legacy-modified native sources keep their errors and backups. This gate is model-free and included in `check-fast`
on the current POSIX host, not a Windows or inference qualification.

`tests/live/desktop_chat_e2e.mjs` attaches only to an explicitly provided
task-owned `desktop-e2e-*` bundle/profile and verifies its process identity before
typing. It uses the real macOS window, Accessibility, keyboard and Send control,
then checks a new persisted answer against an independent JSON/arithmetic oracle
and the native accessibility tree. It records window-only screenshots, which
require a separate visual review. It neither launches nor stops the app. This
is one real Chat workflow, not headless browser coverage or model qualification.
Arguments are test directory, owned GUI PID, localhost URL and an optional exact
model filename (for example `gguf/Qwen3.8-27B-UD-Q6_K_XL.gguf`). The process
owner/start identity is revalidated before native interaction; the optional
model assertion prevents qualifying the wrong already-loaded checkpoint.

Learn and Pi/OpenCode live runners now print a new `run-*` output directory
on every invocation; use that exact directory when reviewing/publishing a run.
They do not clear historical attempts. Research-only development replay in Learn
requires both `DSTUDIO_REAL_ROADMAP_REUSE_RESEARCH=1` and
`DSTUDIO_REAL_ROADMAP_RESEARCH_FROM=PATH_TO_PRIOR_RUN`; the recorded input must
match exactly. Reused research is labeled replay, not a fresh E2E measurement.
For an explicitly non-thinking Learn diagnostic, set
`DSTUDIO_REAL_ROADMAP_THINK_LEVEL=off`. The generation request and progress
receipt now record that setting. Its default remains `max`, matching Learn's
product generation path; an engine launch default of `think: off` alone does
not override a request that explicitly enables reasoning.

## Qwen real host workflows

```sh
make tests/.build/dstudio-server-test test-qwen38-tool-oracle
node tests/live/qwen38_host_smoke.mjs ENGINE MODEL_GGUF
# Additionally exercise generation interrupt and a new session:
node tests/live/qwen38_host_smoke.mjs ENGINE MODEL_GGUF --controls
# Separate reset lifecycle: visible prefill, cancellation with retained memory,
# then a successful reset and real tool read:
node tests/live/qwen38_host_smoke.mjs ENGINE MODEL_GGUF --reset-lifecycle
```

Use an already-installed `ds4` at pin `890898c`, with the single-file model
resolving to its shared model store. The former `--qwen35` variant on
`ds4-qwen35` is rejected; its receipts below are retained history. This runs the real headless HTTP host in a
private profile: asynchronous launch, the unmodified production Agent/Cowork
charters, structured tools, exact saved files and readback. Agent uses the
production automatic Task Graph route, including its actual durable journal.
Each mode must also remain usable for another read after a rejected Design
switch; the Agent-to-Cowork transition must replace only the test-owned process.

Runs are sequential with 16k context, thinking/MTP/DSpark off and expert
streaming off: resident backbone plus embedded BF16 n-grams on SSD. Sampling remains at the
production Agent defaults, **not** the fixed seed/temperature of the CLI gate.
Each workflow is bounded to 12 tool calls and 600 seconds, with bounded logs,
private KV directories and strict workspace checks. The runner refuses an
existing inference process; it does not download weights, restart the user's
app or stop unrelated engines. Requests, answers, process and binary identities,
source-install receipt and failures remain in `tests/.artifacts/qwen38-host-live/`
(older Qwen3.6 receipts stay in `tests/.artifacts/qwen35-host-live/`).

`--controls` requires actual generated tokens before sending an interrupt,
checks the canceled task and the still-running engine, starts a new session
and requires another real tool read without changing earlier files. Its
separate deadlines are 120 seconds for generation, 15 for interruption, 600
for reset and 120 for readback; the 600-second workspace-workflow limit is
unchanged. An early terminal reply fails this control gate; bounded follow-up status and
transcript observations are retained, not used to silently accept the failure.

The complete September 7 Qwen3.8 replay passed both workflows. Its initial Agent
attempt is retained as a failed test: the grader incorrectly rejected the
host's `.dstudio/task-graphs/` receipts. The corrected oracle permits only the
graph IDs reported by the host and checks journal identity, ordering, terminal
success, file/byte limits and symlink rejection; arbitrary hidden files remain
forbidden. Separate oracle regressions exercise valid and invalid workspaces.
This is two real development workflows, not held-out quality, numerical parity,
foreground desktop coverage or evidence for CUDA/ROCm.

The following Qwen3.6 receipts were produced on the retired `ds4-qwen35` fork
and are retained as history. The initial Qwen3.6 host control run remains failed: its workspace operations
passed, but the counting request ended before interruption could be tested.
The native Agent/Cowork CLI gate passed separately; it does not override that
host failure. The complete retry passed Agent and Cowork, including generated
tokens before interruption, canceled task receipts, new-session completion and
tool readback. It also exposed delayed native progress while the synchronous
reset ran. A generation interrupt did not qualify cancellation during reset.
The separate version-91 reset fix and gate below address that ownership path;
they do not erase or establish the cause of the initial counting failure.

`make test-qwen-session-reset QWEN38_AGENT_TREE=ENGINE38` executes the shipped
patches and real native worker with simulated inference and deterministic
barriers: seven Qwen3.8 cases (the six retired Qwen3.6 cases ran on `ds4-qwen35`). It checks the command reader remains available, old context
and attachments survive failure/cancellation, duplicate reset admission fails,
late cancellation prevents publication and save failure retains the old identity.
The original synchronous baseline fails the three shared scenarios. ASan/UBSan
cover the Agent/helpers, not the already-built engine objects. The observed
arm64 Qwen3.8 worker size remains 2,184 bytes; candidate session
count is bounded to one alongside the live session.

Patch 92 additionally requires the native Qwen3.8 empty-candidate API. Run
`make test-qwen38-prepare-patch QWEN38_AGENT_TREE=EXACT_SOURCE` for multi-file
apply/repeat/restore, drift, partial-state and symlink rejection. The explicit
`make test-qwen38-prepare-live QWEN38_AGENT_TREE=BUILT_CANDIDATE
QWEN38_MODEL=GGUF` loads actual Metal weights and checks
cancellation, old-session preservation and bit-identical logits/state against
normal sync. It is a development regression, not held-out answer quality.
`qwen38-prepare-live/run-8t4x4R` passed eight checks; the original preflight
shader-path harness failure remains `run-Okzbuo`. The separate real host replay
`qwen38-host-live/run-xdrRmf` passed Agent/Cowork reset and file workflows with
the unchanged 15-second Stop deadline. Earlier failed replays remain recorded.

`--reset-lifecycle` uses actual weights, a random conversation-only code and a
task-owned project-memory fixture which forces a genuine prompt-cache miss.
It must observe prefill while busy, cancel within the existing 15-second
deadline, receive exactly one native terminal error, and recall the exact code
without tools. A second reset must complete, emit one success receipt and permit
a real read without changing prior files. Each reset remains bounded to 600
seconds; these development replays are not speed or held-out quality benchmarks.
The memory fixture is model-specific: the Qwen3.8 pin reports progress after
native 8,192-token chunks, so its fixture must span two chunks. No chunk-size/context override or numerical engine change is used.
The shared progress oracle requires unfinished work (`0 < done < total`).
The first Qwen3.8 attempt, `run-uAb5iW`, remains failed: its 4,358-token reset
completed successfully in one chunk, without an intermediate observation where
cancellation could be tested. The longer-fixture retry is separate evidence,
not a retroactive pass or an intra-GPU-kernel cancellation guarantee.

Two initial Qwen3.6 reset replays are retained as failures (`run-KaB607` and
`run-l76E5r`). Both had correct recall but exposed test-decoder defects: status
frames interleaved between answer tokens, then the reserved final-line Task
Graph receipt already hidden by the UI. The shared oracle now decodes those
transport elements for both Qwen variants before an exact-answer assertion.
Regressions at every split retain wrong codes, extra prose, repeated receipts
and malformed frames as failures; an echoed question is never an answer.
Qwen3.8's second reset attempt (`run-QQtql2`) also remains failed: cancellation
and recall were correct, but the grader included the native autosave system
line in the answer. The decoder now removes only that exact terminal shape.
A regression executes the actual UI `splitUserTurns`/`segmentAgent` functions
to verify the same text/system separation for correct and wrong answers.
See [the Qwen checkpoint](../../docs/QWEN_CHECKPOINT.md) for final replay results
and the explicit desktop/quality/backend coverage gaps.

## Focused gates and measured results

Image presets: `make test-image-pipeline` executes the production coordinator
and shell with explicitly simulated pixels. `make test-image-runtime` compares
all four presets, seven aspect ratios and every CFG step to the installed
official Ideogram/Comfy scheduler, including progress and the unchanged MAX
default; it does not generate images. `make test-http-lan` checks native HTTP
dispatch and rejects invalid presets. It also runs
`tests/integration/http_lan_security_test.mjs`, which sends real requests from
this machine's LAN address. They check four boundaries. Web tools refuse every
spelling of a loopback/link-local target and every redirect to one, while LAN
pages stay readable. A foreign `Host` is refused (DNS rebinding). CORS is
granted only to loopback/private origins. The chat mirror needs the CSRF header
and stays bounded. Without a LAN IPv4 address it reports BLOCKED, not a pass. The Settings browser test runs in Chromium
and WebKit; the video browser and native Design interrupt tests check that the
saved preset reaches image requests without changing editing or video profiles.

The opt-in [Hermes-inspired live benchmark](../live/image_preset_benchmark.py)
starts the actual installed Ideogram worker sequentially, with real weights.
It retains per-image captions, hashes, parameters, progress, failures and
wall time including model startup/shutdown. PNG sanity checks are separate from
visual prompt-adherence review. Public charts use Matplotlib; see
[image preset results](../../extension/benchmarks/image-presets/README.md).

Current main compatibility, native Metal fixtures and empty-directory setup:
[September 7 update](../../docs/history/ds4-main-update-2026-09-07.md).
`node tests/integration/upstream_agent_prompt_test.mjs ds4` requires the already
built current main checkout on macOS. It compiles ten actual patched
Agent/Cowork prompt builders and parses the emitted schemas to verify native
vision capability gating, tool parameters and GLM envelope placement. It uses
an isolated source copy, does not load weights and is not a model-quality test.
Add `--laguna` with an already-built supported Laguna checkout to run its six
native/DSML/remote prompt cases instead. Both variants verify that the runtime
supplies all Office schemas without relying on duplicate JSON in `COWORK.md`;
the main variant retains its ten checks unchanged. Compiler and assertion
failures remain in the run's command logs and final receipt.

Qwen protocol tests likewise require the matching prepared core, not just a
checkout bearing a familiar branch name. In particular, `test-qwen38-agent`
needs the supported Agent source plus the versioned
[`ds4-qwen38-prepare`](../../patch/ds4-qwen38-prepare/README.md) adaptation and
rebuilt core objects. The harness does not patch the supplied checkout or
reinterpret a missing API as a passing test.

Historical main engine update and real DeepSeek/GLM prefill/decode comparison:
[September 5 update](../../docs/history/ds4-main-update-2026-09-05.md).
`make test-main-decode-metrics` checks timing-span parsing and refuses speed
comparisons for failed workloads or changed model/prompt identities. The live
runner is opt-in and starts one actual model at a time.

DeepSeek V4.1 Q2 SSD measurement is explicit and separate from that historical
before/after comparison:

```sh
node tests/live/ds41_ssd_benchmark.mjs ds4 ds4/gguf/DeepSeek-V4.1-Flash-Q2.gguf tests/.artifacts/ds41-ssd-new-run 8 32768
```

It requires the complete pinned 365.7 GB file and verifies its full SHA-256
before starting one native Metal server, with an explicit 8 GiB expert cache
and 32,768-token context. Engram's disk table is separate from expert streaming.
It neither downloads weights nor stops another application. Five exact-answer
checks and three distinct workloads repeated three times retain all 14 planned
outcomes, raw responses, native processed-token prefill/decode times, settings,
source/binary/model identity, memory samples and failures. A timeout stops the
owned engine before further requests; it is not silently retried. Each attempt
requires a new directory, containing `results.json`, `engine.log` and a readable
`performance.txt`. No qualified speed appears in the text report until all
checks pass. These bounded tasks are not broad model-quality or numerical-parity
qualification. `make test-main-decode-metrics` also checks this benchmark's exact
oracles, truncation rejection, missing-evidence handling and failure reporting.

`make test-server-metrics-patch` executes the actual native JSON/SSE serializers
before/after the usage patch on current main, previous main and Laguna. It also
checks complete apply/check/restore, partial/drift rejection and preservation of
unrelated edits. The counters are controlled fixtures, not measured inference.
Source prerequisites, locations and timing boundaries are in the
[patch notes](../../patch/ds4-server-metrics/README.md).

`make test-search-evidence` executes query-aware page excerpt selection and
the actual evidence-extraction request path with simulated model replies. It
checks late-page/Unicode evidence, fixed input bounds and cancellation without
publishing stale facts or issuing another call. Its loopback HTTP test verifies
real request closure and independent deadlines. It is not an LLM quality test;
live research and competitor work is tracked in
[the quality plan](../../docs/SEARCH_AGENT_QUALITY_PLAN.md).

The [real page-evidence comparison](../../extension/search/bench/README.md) runs
eight public fictional questions through actual Chrome and a resident native
vision model. The complete version-2 run is 3/8 before and 8/8 after, with all
latencies and original failed/grader receipts retained. It is not a full research
pipeline or competitor benchmark. `make test-search-publication` checks public
export bounds/denominators and the actual Matplotlib chart values.

`make test-remote-agent-workspace` executes the real Agent binary with simulated
model frames and actual read/write/bash tools. Absolute and relative `--chdir`
paths must affect all tools exactly once; missing directories fail before an
inference request. This catches the remote-mode regression caused by upstream
moving the local engine's `chdir` later. No weights are loaded by this gate.

`make test-web-visual-unit` executes the native same-page screenshot response
adapter. `make test-web-visual-browser` additionally requires Chrome and Python
Pillow: it compiles the browser helper against all four installed engine source
trees, reads a public fixture in isolated headless Chrome, decodes the JPEG and
checks its actual colors, retained text, exact page-tab cleanup and aggregate
fragmented-response limit. It preserves each run in a fresh ignored directory.
Neither target loads weights or establishes that a model interpreted the image
correctly. Search's simulated-model gate separately checks multimodal request
content, capability/model-switch validation, three-capture bounds, cancellation
and exclusion of image blobs from serialized chats.

Published benchmark charts use Matplotlib. Regenerate the engine, Design and
anonymous PDF charts from committed aggregates with
`python3 tests/support/publish_benchmark_charts.py`; run
`python3 tests/unit/published_benchmark_charts_test.py` to exercise actual
export validation, private-field exclusion, plotted values and PNG rendering.
These tests do not add inference or quality measurements. See the
[README results](../../README.md#latest-measured-results) for their distinct scopes.

| Directory | Executes | Does not prove |
| --- | --- | --- |
| `unit/` | Production functions with controlled inputs and checked outputs | A model answered correctly |
| `browser/` | Real browser interactions, usually with simulated engine responses | Real model inference or real downloads |
| `integration/` | Tools, files, subprocesses, HTTP, build lifecycle | Model quality unless real weights are explicitly loaded |
| `live/` | Explicit network, hardware and/or real-model runs | All models, platforms or workloads are correct |
| `support/`, `fixtures/` | Shared harnesses and controlled input data | Independent test results |
