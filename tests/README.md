# Tests: what each result actually proves

Correctness before performance. No test is accepted merely because a function
name, comment, prompt phrase or CSS declaration occurs in application source.

## q27 native Metal candidate

`make test-q27-metal-delta Q27_SOURCE=/path/to/q27` requires the separately
downloaded `8cd7083` source and real Metal hardware, but no model weights. It
copies sources into a new ignored directory, retains the original 512-thread
failure where reproduced, and applies the versioned 256-thread column patch.
The unchanged upstream operator suite, native CLI/server builds, 24 scalar
oracle and exact serial/chunk GPU comparisons, mixed host/shader rejection and
complete patch lifecycle must pass. This does not qualify whole-model answers,
custom q27-format conversion, CUDA, or DStudio's pending q27 application adapter.

## Nine original Design systems

`make test-design-originals` serves the real native catalog and all nine authored
packs. In Chromium and WebKit it exercises both themes, 320/390/768/1440px,
computed contrast, 200% text, radio/checkbox label columns, forms and dialog
focus return. Every pack is also opened as a standalone local file with HTTP
blocked. Market, Commons, Atlas and Canvas have domain interactions in normal
pages and the opaque app iframe: filters, cart totals/limits, literal replies,
review restoration, synchronized map/list selection, route ordering, object
edits, cancelled drags, keyboard selection and bounded undo/redo.

Each missing pack is still recognized as supported but unavailable; the native
setup endpoint must not fetch or overwrite it. `make test-design-self` exercises
the real Agent pack dispatcher and returned CSS/HTML bytes for every supported
ID. `make test-macos-bundle` validates the catalog materialized from the packaged
app. These are authored assets and model-free tests, not the 18 model-generated
projects required by the quality campaign or native desktop qualification.

## Design startup and baseline provenance

`make test-design-start` executes production catalog/migration JavaScript and
the native `/api/start` endpoint in an isolated empty-engine profile. It checks
retired/invalid/missing styles, delayed/offline/empty catalogs, deduplicated
requests, retries, preserved preferences and rejection without changing the
active configuration or admitting a task. A deliberately unavailable runtime
also verifies that admitted launches end in a failed task rather than hanging.
There are no weights or model-quality claims. The Agent/Design browser test
additionally holds the catalog response behind a barrier and checks the **first**
launch request, in Chromium and WebKit with simulated engine replies.

The included `make test-launch-preflight` invokes the real start handler with
a task-owned pipe-echo process representing an already running engine. Twenty-four
cases cover Qwen mode/checkout mismatches, missing model/PLE/drafter files and
incompatible forced SSD settings, including remote runtimes. Each rejected
request must leave that process responsive and keep configuration, credentials,
effective memory settings, task admission and pending steering unchanged.
The HTTP Design gate also checks a real child build failure **after** admission.
Neither test loads weights: these rejections do not qualify the supported Qwen
modes. Real Qwen3.8 Agent/Cowork workflows have a separate gate below.

`make test-agent-spawn` injects failures into the production launcher's three
pipe allocations and fork, for both Agent and Cowork. All eight cases must
release the prepared charter and every opened descriptor without publishing a
child. The prepared executable and checkpoint are fixtures; no model or child
process starts. This macOS-specific gate is included in `check-fast` on macOS.

`make test-launch-control` exercises the real HTTP host and owned subprocesses
with FIFO-blocked builders and tiny fixture checkpoint files. Eleven scenarios
cover responsive status and old-runtime input during preparation, failure without
publishing settings, task-specific/late cancellation, duplicate admission,
changed checkpoint/encoder identities, asynchronous handoff to a new PID,
TERM escalation, cancellation during loading, stale readiness messages and host
death. The test verifies actual stdin effects and child termination; no model
is loaded. Each run preserves its scripts, logs and receipt in
`tests/.artifacts/launch-control/http-*`.

`make test-ui-launch` runs the complete production UI in Chromium and WebKit
against an explicitly simulated HTTP launcher. Five response-barrier scenarios
check nonce generation, correct cancel-task identity, another window's pending
launch, canceled loading, preserved conversations/settings, duplicate shortcuts,
old error timers and successful transition to Agent. Screenshots and both failing
and successful receipts remain in unique `tests/.artifacts/launch-ui/run-*`
directories. These are browser interaction tests, not model-quality or native
desktop E2E claims. Both new targets are included in `make check-fast`.

`make test-quality-baseline` checks real-file hashing, archive Git provenance,
shared-store deduplication and complete receipt generation on isolated files.
Unselected managed `q36` installations and their binaries are included, with
C++/Objective-C++ sources, included C fragments and CMake recipes. The fixture
does not read the developer's real profile or execute engine binaries.
To capture a private baseline without loading
models, run `node tests/support/quality_baseline.mjs --hash-weights` (one bounded
read at a time). It reads the launcher's bounded `engine-checkout` setting and
the fixed managed sibling directories, including root-level checkpoint files.
`--engine PATH` and `--store PATH` add explicit locations. Broken weight links
and invalid settings are reported, not hidden as complete inventories. Source/binary identities,
the pre-existing diff and immutable hash receipts go into a new ignored
`tests/.artifacts/quality-multihardware/baseline-*` directory. A local SHA-256 is
provenance, not proof of checkpoint authenticity or inference correctness.

### Common-100 answer quality

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
node tests/live/engine_acceptance.mjs --infer --engines q36 \
  --installed-root /path/to/managed-engines --model-root /path/to/gguf \
  --common-quality --quality-use first-exposure
```

`--quality-use development-replay` is the default and must be used after exposure
to these cases. First exposure is to this frozen integration corpus, not a claim
that model training data has been audited. The five existing engine IDs are
accepted; `--model-file NAME.gguf` chooses one explicit existing quantization.
This path currently requests resident Metal execution (Qwen3.8-Flash-Next still
needs native SSD PLE); it does not claim expert-streaming or other-backend
coverage. Do not run a configuration that exceeds the host's memory budget.
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

`make test-qwen38-inspect` tests the reversible metadata-only PLE patch on a
private source copy. Add `--native ds4/gguf` to the documented Node command in
[the patch notes](../patch/ds4-qwen38-inspect/README.md) to build the real CLI
and check its OS prefetch behavior and actual GGUF summaries on macOS. The
ordinary uninstrumented CLI is checked too. This does not generate tokens.

`make test-engine-startup` runs four real HTTP startup cases without
`DS4UI_TEST_MODE`, with inference explicitly deferred and isolated source
fixtures. A persisted q36 checkout must not receive ds4 Agent recovery; clean
native sources remain usable and missing/legacy-modified native sources keep
their errors and backups. This gate is model-free and included in `check-fast`
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

## Model-stream integrity and Stop

`make test-remote-structured-tools REMOTE_TOOL_AGENT=/path/to/built/ds4-agent-jsonl`
runs the real lightweight Agent and Cowork tools against explicitly simulated
model frames. It covers exact argument/call-ID round trips, actual file creation
and readback, Office tools without a shell, interrupted/incomplete batches,
foreground shell cleanup, non-executable model prose, compaction, duplicate IDs
and invalid arguments. Literal and regex search execute the real dispatcher.
One-shot success, failure and Stop must produce distinct process outcomes.
Four repeated tool calls are fed byte-for-byte into the host watchdog, with
distinct transport IDs; a generated JSON record is not reconstructed by the
harness. This is integration coverage, not a real-model quality benchmark.

`make test-remote-turn-error` executes the host's control-frame parser and the
Task Graph scheduler/store. A failed turn followed by an idle marker must stay
failed in the task, node, durable result and journal replay; a successful next
turn must still complete. It uses an isolated workspace and simulated runtime
pipe, without starting or signalling an inference engine.

To rebuild and run the native tool suites on all four macOS source bases:

```sh
make test-agent-native-build AGENT_MAIN_TREE=ds4 AGENT_LAGUNA_TREE=ds4-laguna-s21 \
  AGENT_QWEN38_TREE=ds4-qwen38 AGENT_QWEN35_TREE=ds4-qwen35
```

Sources are copied into a new task-owned directory, without weights or reused
build objects. Agent/Cowork/Design are linked against each selected upstream;
the structured tool corpus runs both normally and with ASan/UBSan on the Agent
and first-party helpers. Upstream core/GPU objects are not sanitizer-instrumented.
First-party support, patches and native harness hashes must remain unchanged
during the run. Compilation does not expose new application modes or qualify
inference on another backend. Failed runs remain in `tests/.artifacts/`.
The same gate runs `agent_structured_probe.c` against each derived native
runtime: exact batch/argument/ID/history bounds, preparation without admission,
whole-group compaction, retained replay IDs, reset and allocation lifetimes.
It records native type sizes and a labeled model-free snapshot microbenchmark;
these timings are not model speed or a published before/after comparison.

`make test-model-rpc-input test-model-rpc-stream test-model-rpc-lifecycle test-model-rpc-interrupt test-remote-utf8` executes
the production native HTTP/SSE relay and shared runtime pipe consumer. The
61 stream/consumer scenarios use a simulated model, deliberately fragmented bytes,
actual outgoing request bodies and replays of the resulting runtime frames.
They cover Unicode, interleaved tool IDs, exact argument preservation, duplicates,
invalid/oversized inputs, incomplete endings and errors. A tool batch is not
published before successful completion. These are transport tests, not LLM
quality or proof that the structured dispatcher is integrated into every mode.

The stream gate repeats the shared corpus through native request-envelope
admission and the actual exec'd host worker
over HTTP and HTTPS, with two additional held-connection cases on each path:
Stop and death of the owning host (**63 cases per owner-relay path**). HTTPS
requires `curl` and `openssl`; it creates an isolated certificate and passes its
CA to the test child, without disabling TLS verification. Worker/process-group
exit, closed peer sockets and absence of named credential/body staging files
are checked. The owner-only relay has one active worker, at most one pending
request while cancellation is reaped, a 16 MiB body limit and 16 KiB delivery
staging. Its request deadline is monotonic; it does not retry a failed action.
Windows code is not qualified by these macOS process tests.

The **18 input scenarios** exercise the first-party request writer, native
stdout parser and exec'd worker, not a source-code contract. A real peer checks
the complete large Unicode request; a deliberately stopped upload worker must
not prevent the HTTP Stop handler from returning or the client from cancelling.
The host retains at most 16 KiB upload staging plus an 8 KiB unread pipe suffix;
only the worker decodes/validates the body, with a 16 MiB decoded limit. The
internal header follows the canonical `rpc_send_request` format: an embedded
`model_request` inside a display event cannot initiate a network operation.
Each stdout/stderr drain has its own 64 KiB budget. Other cases cover stale
split headers, invalid IDs/Unicode/JSON, duplicate envelope fields, incomplete
input, decoded-body overflow, display-record overflow and a terminal-delivery
deadline with a genuinely full runtime pipe. The deadline fault changes the
monotonic deadline, not the assertion or production timeout.
An early-rejection scenario resumes an intentionally stopped validator, then
observes its exit without reaping it before the owner resumes. The owner must
deliver the validator's original error even when the unfinished upload now
gets EPIPE; it must not overwrite that receipt with a generic pipe error.

Display events have an explicit 4 MiB ceiling (the existing transcript
capacity); exceeding it fails the runtime rather than publishing a truncated
tool event. Their whole-record watchdog hashing/transcript publication still
need critical-path review: input byte budgeting alone does not qualify that
separate work or the complete P10 latency/memory profile.

The six lifecycle scenarios force exact OS descriptor reuse, 200 rejected
duplicate admissions, credential changes after admission, a stopped helper
requiring escalation, a full runtime pipe, worker death, request deadline,
oversized body and a request queued before Stop. The HTTP Stop handler must
remain usable under real pipe backpressure. The flag comparison uses an
independent written-pipe oracle: Darwin may expose its kernel-owned
`FWASWRITTEN` history bit, which is not a changed nonblocking policy. Original
failures and the size/layout report are retained with the receipts.

The 36 interrupt scenarios invoke the actual HTTP handler, Task Graph cancel
and watchdog across Agent/Cowork/Design labels and both protocol APIs. Each
owns a real child using the shared reader and a held HTTP connection through
the exec'd worker; blocking and nonblocking/partial
stdin, SA_RESTART, discarded candidates and restored descriptor flags are
checked, as are peer disconnection and worker reaping. No existing user process
is signalled. All four gates are in `check-fast`. Detailed receipts live under
ignored `tests/.artifacts/model-rpc-stream/`, `model-rpc-lifecycle/` and
`model-rpc-input/`.

`node tests/integration/runtime_model_interrupt_test.mjs PATH_TO_RUNTIME ...`
goes further: the actual compiled Agent/Cowork/Design binaries receive SIGINT
during a silent prefill, incomplete frame or uncommitted tool. Each must return
to WAITING without more model bytes, retain the exact next prompt and execute
a real filesystem tool on the next turn in the **same process**. Cancelled
effects must not appear. The native build gate includes this test for every
built variant. Requests, logs, source/binary hashes and failed attempts remain
under ignored `tests/.artifacts/runtime-model-interrupt/`.

This qualifies the runtime wait, not cancellation of the upstream HTTP worker,
separately owned resident engine, full-pipe backpressure or model quality. Those
lifecycle and end-to-end acceptance requirements remain open in `PLAN.MD`.

## Goal and context during execution

`make test-goal test-steering` runs the production Goal scheduler/journal and
native HTTP/runtime steering transport. It checks bounded continuation, actual
receipt requirements, failed-command spoof rejection, pause/resume, partial
resume recovery, FIFO, duplicate/stale/closed-turn rejection and append-before-ACK.

`make test-steering-patch` exercises apply and repeated/drift rejection on
isolated copies of the installed main/Laguna sources, preserving unrelated edits.
`make test-agent-patch-migration` adds all seven pinned source bases and independent
Git apply/reversal. The three previous variants retain frozen legacy output
parity after reversing the separately recorded renderer and remote-interrupt
corrections solely for the historical oracle. Every variant first reverses its
v100 readiness delta to its frozen v99 hash. Laguna and older MoE reverse their
v99 continuation deltas, then the v98 publication delta, to recover their exact
v97 bytes first. The
newer main/Qwen variants have no fictitious legacy oracle. It requires local source
objects or exact base files; `DSTUDIO_AGENT_QWEN38_DIR` selects the isolated new
candidate. It does not perform a network install.

`make test-agent-compaction AGENT_LAGUNA_TREE=ENGINE_LAGUNA
QWEN35_AGENT_TREE=ENGINE_MOE` requires the already-built native cores.
It executes actual compaction and control calls with deterministic session and
tokenization fixtures under ASan/UBSan. Fourteen cases per branch check original
transcript and memory preservation during blocked preparation, failed summaries,
failed rebuilds, cancellation/late Stop, stale identities, one owner-only
publication, successful export, and an honestly reported export failure.
Twenty- and 200-ms barrier holds demonstrate control access during preparation;
probe-only timings distinguish preparation, control, lock wait/hold and actual
publication. A zero sub-microsecond reading means below timer resolution, not
zero work. These are diagnostic fixture observations, not an inference speed
benchmark or percentile study.

The shipped v98 patches pass **28/28** (`run-KKPyWK`, `run-wGTgjx`); original
v97 code passes **4/14 per branch** on the identical final harness
(`run-XvWWAk`, `run-ZQ7QxN`). Earlier 12-case failures and the initial missing
piped-mode warning are also retained under ignored `agent-compaction/`.
`--source /path/to/frozen-derived-agent.c` runs that exact before/after input
without mutating supplied engines. Add `--helper FROZEN_COMPACTION_TEXT_HEADER`
when that source predates the current private helper API; the runner captures
and compiles the exact historical helper in its own directory. No models are
loaded. Real-model continuation
quality, multimodal state and other backends are separate gates.

`make test-agent-continuation` adds native GGUF tokenizer and generation-loop
regressions on the production patch output. Override
`COMPACTION_LAGUNA_MODEL` / `COMPACTION_QWEN35_MODEL` for the installed GGUF
locations. The native core reads vocabulary/metadata only: **no weight tensors,
GPU inference or model-quality evaluation**. ASan/UBSan covers 50 Laguna and
53 Qwen framing checks, preserving the exact original tail token IDs across
BPE/ChatML/tool/think boundaries. A scripted 18,000-token response crosses three
compactions and must render identically to the non-compacted reference without
renewing its output budget. Sixteen Laguna / fourteen Qwen loop checks also
cover native speculative orchestration, where supported, oversize admission,
repeated memory export, Stop/failure and a partial tool followed by a complete
retry that writes the actual file exactly once. The v100 addition latches Stop
across the admission-to-dispatch gap; the earlier fifteen/thirteen-case receipts
below remain historical rather than being assigned the new denominator.

V99 production receipts `run-Jntg6Y` / `run-CGHiec` pass their checks plus the
existing 14 publication cases each. The identical final loop harness on v98
passes only **4/15 Laguna** (`run-5DMOsP`) and **3/13 Qwen** (`run-kAfUMN`).
The initial second-compaction memory-boundary failure is retained in
`run-iBnqeM` / `run-Vwpree`, not replaced by the corrected run.
`--generation-only --source FROZEN_AGENT --tokenizer-model GGUF` reproduces
that older baseline without requiring v99's new framing helpers. All receipts
are under ignored `tests/.artifacts/agent-compaction/`; no simulated throughput
is presented as model performance.

`make test-agent-continuation-live CONTINUATION_BUILD_RECEIPT=RESULTS_JSON
CONTINUATION_FAMILY=qwen35 CONTINUATION_MODEL=MODEL_GGUF` explicitly launches
the binary from a passing native build receipt, with real resident weights,
Metal, 8k context and isolated session/workspace files. Use `laguna` for the
other family and run them sequentially. It never downloads weights, restarts
the app or stops an existing engine. Six development cases cover an archived
fact, 200 generated C functions across actual compaction, another explicit
compaction, real file tools using the retained fact, Stop and same-process tool
recovery. Generated C is independently compiled and executed; no missing code
is repaired. Native trace inputs and private summary text are kept separate
from generated output. Original prompts, answers, failures, timings and exact
build/binary identities stay in ignored `agent-continuation-live/` artifacts.
This is not a held-out quality benchmark or a claim of numerical equivalence;
missing prerequisites and unexecuted cases remain failures/not run.

The first real Qwen MoE continuation run (`run-lFiDBs`, v99) passes **4/6**:
generated code, original facts and real tools survive compaction/Stop. It also
exposed premature `/compact` readiness and suppressed Stop feedback. Original
failures remain retained. The v100 replay `run-raYfjK` passes **5/6**: both control
defects are fixed, but generated C omits every function's return type, confirmed
by an independent C11 compiler. Laguna `run-krSaOZ` passes **4/6**: its generated
code compiles and runs through compaction, but the summary drops remembered
values. Post-Stop write/read succeeds; that case still fails its additional
check because the preceding `after.json` was never created. Both engines exit
normally with unchanged captured inputs. Initial Laguna `run-yftqXG` retains
the unsupported custom-prefill error with six cases not run. The runner now
uses Laguna's native prefill selection; Qwen retains its 512-token chunk.

These runs inject the native current session date/time, so even identical user
prompts and sampling are not token-identical A/B inputs. The v99/v100 Qwen traces
confirm this timestamp difference; no causal quality change is inferred from
4/6 versus 5/6. V101 revises the private summary instructions to retain explicit
future-use facts and earlier durable state. Its Laguna replay `run-QcP9k6`
passes 6/6 with independent code compilation/execution and real file checks.
Manual review still finds the first summary falsely declares an open reply
complete: this limitation is not covered by the six-case total, and remains
open. MoE v101 `run-lC2uDg` also passes 6/6, but its separate summary review
finds stale pending work after the task finished and a tool-shaped summary;
no tool is actually dispatched by that private summary. Broader summary-quality
acceptance is a separate gate.
A deadline aborts remaining scenarios instead of sending another prompt while
the prior engine operation is unknown.

V102 adds actual runtime reply state to the summary request and refreshes its
progress instructions. The same worker is tested first during an open reply,
then after its EOS and a manual compaction. The new checks consume the native
tokenizer's actual prompt; they are not source-text assertions or a claim that
a model obeyed it. Laguna `run-EJUCfG` and MoE `run-Kl7ppp` pass 18/18 and 16/16
loop checks plus their unchanged publication/framing sets. Frozen v101, with
its captured helper, passes 16/18 and 14/16 on the same C oracle
(`run-tDsUKF`, `run-4iJ6ks`): both runtime-state assertions fail. The subsequent
v102 native build `run-Ethbt2` passes 77/77 stages. Laguna's real replay
`run-b3xpGT` passes 6/6 and the separate scoped summary review: accurate
57/200 partial progress, then 200/200 complete, with both explicit facts kept.
MoE v102 and wider quality acceptance remain pending. Build, workflow and
summary evidence remain distinct, recorded in the
[upstream checkpoint](../docs/DS41_UPDATE_CHECKPOINT.md).

`make test-agent-idle AGENT_IDLE_ENGINE=ISOLATED_BUILT_ENGINE` compiles the actual
patched worker with ASan/UBSan and runs 20 command/ownership/notice checks, using
a deterministic blocked session API and no inference. It requires a task-owned
engine under `tests/.artifacts/`, not an installed checkout. Set
`AGENT_IDLE_FLAGS="--source FROZEN_DERIVED_AGENT"` for the unchanged before-code.
Laguna/MoE pass 20/20 on v100 versus 8/20 on v99; 1,000 control reads complete
while preparation is held, and worker layout is unchanged. `test-agent-native-build`
also executes this probe for each supplied current engine family.

`make test-agent-runtime-notice AGENT_NOTICE_RECEIPT=RESULTS_JSON` consumes the
actual passing native probe's JSONL notice records through the production UI
segmenter, including fragmented frames and quoted/Unicode text. Plain model text
must not become a service event, and a service message must not become an answer.
The app browser workflow additionally checks visible Stop feedback and absence
of raw JSON in WebKit and Chromium; its engine replies are explicitly simulated. Notice-only
conversations and invalid/empty frames are included in the 135 native-frame
consumer checks, including Design's empty-conversation decision.
Final browser receipts `agent-notice-visibility/webkit-ohVk0e` and
`chromium-Pn6ZYj` include a reopened notice-only Design conversation in light
and dark themes, completed entrance animations, on-screen geometry and at
least 4.5:1 notice contrast. Screenshots were visually reviewed. The original
fixture-timing/ownership failures remain retained; these passes are UI evidence,
not real-model or packaged-app qualification.

`make test-runtime-patch-migration` does the same for five web bases and four
server inputs (current/previous main, with/without native metrics). Exact raw
sources may be supplied in `DSTUDIO_RUNTIME_BASE_SOURCES`, named
`web-main-current.c`, `web-main-previous.c`, `web-laguna.c`, `web-qwen38.c`,
`web-qwen35.c`, `server-main-current.c` and `server-main-previous.c`.
The test applies the metrics prerequisite itself where required and checks all
hashes against the committed base manifests. This is not model-quality evidence.
`make test-steering-runtime` requires their already-built Agent/Cowork
binaries plus main Design: it executes real filesystem tools, inserts context
at two owner boundaries and proves the same turn continues without duplicate
effects. Model frames are deterministic fixtures; no weights are loaded.

`make test-unified-patch test-agent-build` is in `check-fast`. It executes the
native patcher and builder, including malformed/linked inputs, ambiguous patches,
build failures, source edits during compilation, forced termination and a
compiler that retains the checkout lease after its parent dies. A separate
regression replaces the staging pathname: publication is rejected and
cleanup stays confined to the retained directory, with an explicit visit bound.
The compiler in `test-agent-build` is explicitly simulated. In contrast,
`make test-agent-native-build` creates source-only main/Laguna snapshots and
really compiles and links both Agent/Cowork pairs on macOS, then runs their
filesystem tools and steering loop with simulated model frames. It additionally
builds the real main Chat PLD binary and checks its CLI, while asserting that
Laguna's unsupported PLD ABI leaves no derived server. No weights or
existing user runtimes are touched. See [patch prerequisites and limits](../patch/ds4-agent-jsonl/README.md).
The gate also builds Design and executes its real read tool and steering loop.
All three runtime types additionally exercise model-wait Stop and next-turn
tool execution without restarting the process, with model replies simulated.
It runs upstream Agent unit tests and fragmented rendering both with and without
a JSONL worker, under ASan/UBSan for private Agent/helper C objects. Core/GPU
objects remain uninstrumented. Set `AGENT_QWEN38_TREE` to also build the new
Qwen3.8 source; building a runtime alone does not qualify its application modes.
On macOS, `DSTUDIO_AGENT_BUILD_BACKEND=cpu make test-agent-native-build` selects
a fresh real CPU build; it does not qualify Windows or Linux behavior.

`make test-qwen38-agent QWEN38_AGENT_TREE=PATH_TO_BUILT_CANDIDATE` requires the
already-built `b4c3550`/`0bb323a`/`66b0e3f` source and native core objects. It executes the Qwen
parser, original Agent units, eight prompt combinations, real file writes,
Cowork document readback and rejected workspace escapes. Its model text and
engine identity are fixtures: this is protocol/tool behavior, not inference
quality. ASan/UBSan instrument the private Agent/parser/helper C objects only;
`QWEN38_AGENT_FLAGS=` disables them explicitly. It neither starts a model nor
changes the supplied engine checkout.

`make test-qwen35-agent QWEN35_AGENT_TREE=PATH_TO_BUILT_CANDIDATE
QWEN35_AGENT_FLAGS=--sanitize` performs the equivalent native Qwen3.6 gate on
pin `60fca11`: original Agent units, all 261 splits of a call containing literal
XML and delimiter escapes, malformed/duplicate/over-limit rejection, fixed-bound
scan counters, four prompt combinations and real document writes/readback.
Traversal, symlink escape and Cowork shell attempts must leave the fixtures
unchanged. Additional cases reject the unsupported recurrent checkpoint API
before any file/state access and preserve literal markup inside JSON documents.
The latter regression also runs against Qwen3.8's native parser.
Identity/text are simulated; only private Agent/helper C objects are
sanitizer-instrumented. `--upstream` reproduces the original unsupported parser
and is expected to fail, not count as a successful inference test.

`make test-metal-workspace` links a small probe against the already-built native
Metal objects for main, Laguna and both Qwen forks. It runs from the engine's
directory and from an unrelated workspace with spaces, through the production
host environment. Each run initializes the actual shader library and checks
257 GPU additions against a scalar result. `METAL_WORKSPACE_TREES` selects the
input trees; unavailable hardware/objects fail, never silently pass. This test
does not build in the supplied trees or load model weights. Eight missing
shader-path overrides were found by this test, including the GLM/vision, DFlash
and Qwen sources; compilation alone had not exercised workspace-relative loading.

The explicit live development gate is:

```sh
make tests/.build/agent-build-probe test-qwen38-tool-oracle
node tests/live/qwen38_agent_smoke.mjs ENGINE MODEL_GGUF PLE_GGUF
# Existing Qwen3.6 candidate, no PLE and no model download:
node tests/live/qwen38_agent_smoke.mjs ENGINE MODEL_GGUF --qwen35
```

It requires the already-built Qwen candidate's Agent/Cowork and actual weights.
Runs are sequential, with 16k context, a 512-token prefill chunk, 1,024 output
tokens per model round, temperature 0, seed 42, thinking/MTP/DSpark off and at
most 12 tool calls/600 seconds per workflow. No downloads, app restart or
termination of an existing engine are performed. This uses resident backbone
weights plus native SSD PLE for Qwen3.8, or resident weights without PLE for
Qwen3.6; neither uses expert streaming. It verifies exact generated
files, source preservation, required document tools and subsequent readback.
The Qwen3.6 variant also requires no disk checkpoint directory to be created.
The first run's Cowork failure is preserved: its original grader erroneously
forbade extra local reads despite the request permitting them. The corrected
oracle still rejects shell/network, wrong targets, missing writes/results and
missing document readback; the complete two-workflow run was repeated. These
are development checks, not held-out quality, numerical parity or app-mode
qualification. Runtime requests/answers and personal paths stay in ignored
`tests/.artifacts/qwen38-agent-live/` or `tests/.artifacts/qwen35-agent-live/`.

## Qwen real host workflows

```sh
make tests/.build/dstudio-server-test test-qwen38-tool-oracle
node tests/live/qwen38_host_smoke.mjs ENGINE MODEL_GGUF PLE_GGUF
# Qwen3.6: no PLE; additionally exercise generation interrupt and a new session:
node tests/live/qwen38_host_smoke.mjs ENGINE MODEL_GGUF --qwen35 --controls
# Separate reset lifecycle: visible prefill, cancellation with retained memory,
# then a successful reset and real tool read. Run one model at a time:
node tests/live/qwen38_host_smoke.mjs ENGINE MODEL_GGUF --qwen35 --reset-lifecycle
node tests/live/qwen38_host_smoke.mjs ENGINE MODEL_GGUF PLE_GGUF --reset-lifecycle
```

Use an already-installed `ds4-qwen38` at pin `66b0e3f`, or `ds4-qwen35` at
`60fca11f`, with the model (and Qwen3.8 PLE) resolving to its shared model
store. This runs the real headless HTTP host in a
private profile: asynchronous launch, the unmodified production Agent/Cowork
charters, structured tools, exact saved files and readback. Agent uses the
production automatic Task Graph route, including its actual durable journal.
Each mode must also remain usable for another read after a rejected Design
switch; the Agent-to-Cowork transition must replace only the test-owned process.

Runs are sequential with 16k context, thinking/MTP/DSpark off and expert
streaming off: resident backbone plus native SSD PLE for Qwen3.8, resident
weights without PLE for Qwen3.6. Sampling remains at the
production Agent defaults, **not** the fixed seed/temperature of the CLI gate.
Each workflow is bounded to 12 tool calls and 600 seconds, with bounded logs,
private KV directories and strict workspace checks. The runner refuses an
existing inference process; it does not download weights, restart the user's
app or stop unrelated engines. Requests, answers, process and binary identities,
source-install receipt and failures remain in `tests/.artifacts/qwen38-host-live/`
or `tests/.artifacts/qwen35-host-live/`.

`--controls` requires actual generated tokens before sending an interrupt,
checks the canceled task and the still-running engine, starts a new session
and requires another real tool read without changing earlier files. Its
separate deadlines are 120 seconds for generation, 15 for interruption, 600
for reset and 120 for readback; the 600-second workspace-workflow limit is
unchanged. Qwen3.6 must reject incomplete disk checkpoints before becoming
busy and must not create a checkpoint directory. Its requested power of 37
must be reported as effective native 100, without forwarding `--power`.
An early terminal reply fails this control gate; bounded follow-up status and
transcript observations are retained, not used to silently accept the failure.

The complete September 7 Qwen3.8 replay passed both workflows. Its initial Agent
attempt is retained as a failed test: the grader incorrectly rejected the
host's `.dstudio/task-graphs/` receipts. The corrected oracle permits only the
graph IDs reported by the host and checks journal identity, ordering, terminal
success, file/byte limits and symlink rejection; arbitrary hidden files remain
forbidden. Separate oracle regressions exercise valid and invalid workspaces.
This is two real development workflows, not held-out quality, numerical parity,
foreground desktop coverage or evidence for CUDA/ROCm.

The initial Qwen3.6 host control run remains failed: its workspace operations
passed, but the counting request ended before interruption could be tested.
The native Agent/Cowork CLI gate passed separately; it does not override that
host failure. The complete retry passed Agent and Cowork, including generated
tokens before interruption, canceled task receipts, new-session completion and
tool readback. It also exposed delayed native progress while the synchronous
reset ran. A generation interrupt did not qualify cancellation during reset.
The separate version-91 reset fix and gate below address that ownership path;
they do not erase or establish the cause of the initial counting failure.

`make test-qwen-session-reset QWEN35_AGENT_TREE=ENGINE35
QWEN38_AGENT_TREE=ENGINE38` executes the shipped patches and real native worker
with simulated inference and deterministic barriers: six Qwen3.6 cases and
seven Qwen3.8 cases. It checks the command reader remains available, old context
and attachments survive failure/cancellation, duplicate reset admission fails,
late cancellation prevents publication and save failure retains the old identity.
Both original synchronous baselines fail the three shared scenarios. ASan/UBSan
cover the Agent/helpers, not the already-built engine objects. The observed
arm64 worker sizes remain 2,144 and 2,184 bytes respectively; candidate session
count is bounded to one alongside the live session.

Patch 92 additionally requires the native Qwen3.8 empty-candidate API. Run
`make test-qwen38-prepare-patch QWEN38_AGENT_TREE=EXACT_SOURCE` for multi-file
apply/repeat/restore, drift, partial-state and symlink rejection. The explicit
`make test-qwen38-prepare-live QWEN38_AGENT_TREE=BUILT_CANDIDATE
QWEN38_MODEL=GGUF QWEN38_PLE=PLE_GGUF` loads actual Metal weights and checks
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
native 8,192-token chunks, so its fixture must span two chunks; Qwen3.6 reports
per token. No chunk-size/context override or numerical engine change is used.
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
See [the Qwen checkpoint](../docs/QWEN_CHECKPOINT.md) for final replay results
and the explicit desktop/quality/backend coverage gaps.

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

### Qwen27B host and UI integration

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
HTTP host with the same simulated installer/weights. Select WebKit or Chromium
with `DSTUDIO_TEST_BROWSER=webkit|chromium` and light/dark with
`DSTUDIO_TEST_THEME=light|dark`. It covers confirmation, setup, transfer, hashing,
Stop and Resume; download progress must never replace the composer model label.
Setup/hash verification do not display transfer percentages. Theme coverage
requires selecting and asserting the effective UI theme, not only OS emulation.
Screenshots and failed attempts are retained. This is not the foreground `.app`.
Partial deletion is deliberately unavailable for the 27B's private locked
staging format; the old neighboring-`.part` deleter must not claim to remove it.

`make test-qwen27-download-settings-live QWEN27_INSTALL_ROOT=/path/to/install`
uses a previously installed pinned q36 and both real components. The production
Settings HTTP path verifies the actual weights/projector and reuses the engine,
preserving their identities and current model selection. It starts no LLM and
does not substitute for an empty-network-install or inference-quality gate.

`make test-q36-host` executes 94 executable-identity/readiness/endpoint cases and 15 lifecycle
scenarios through the actual native host/preparation process, using a compiled
simulated engine. It checks exact process/file/configuration identity, fragmented
readiness, a listener/log that is not ready, responsive cancellation, reuse,
replacement, stale files, foreign ports, unsupported settings and host death
during an actual partial upload. The latter must not leak an ownership descriptor
through a fork-only HTTP relay. These are behavior tests, not model answers.
An exclusive installation lease must reject a launch before executing the
engine, while status/cancellation stay responsive. Loading, running and draining
keep a shared lease in the actual child through exec. Read-only installation
verification may coexist; update admission becomes available only after child
exit. A deterministic drain barrier proves host death cannot release the lease
early and a surviving HTTP relay cannot retain it afterwards. Both the current
94-case unit and 15-scenario host gate pass in Release and ASan/UBSan; this is
not native model/GPU numerical validation.
Omitted private port/cache settings reuse the owned model; explicit changes
reach the new process as actual arguments, while invalid values preserve the
working model. The fixture publishes received arguments before its ready barrier.
The earlier 63-case parser/host revision also passed with ASan/UBSan; that
receipt does not automatically qualify subsequent tool-owner changes or the
real inference engine's GPU execution.

`make test-q36-agent-host Q36_AGENT_SOURCE=/path/to/main/source` runs seventeen
scenarios with the actual native Agent/Cowork builds and filesystem tools.
Only the installer and model replies are simulated. It checks a separately
owned model across Chat/Agent/Cowork, structured call/result IDs, preserved
effects, rejected/cancelled preparation, late responses after Stop, loss of the
model owner and native Max at 96k. GSA/RSA admission is exercised through native,
automatic, explicit Task Graph and Goal routes: incompatible context must not
create tasks/graphs or touch the model, valid Max must reach the actual produced
model request, and a resumed Goal revalidates a replacement runtime. Ordinary
slash lookalikes stay unchanged. A real Bash verification must complete a Goal
even when its result frame follows terminal color output; failed/interrupted
receipts do not qualify. `make test-goal` also exercises those receipt cases
and the existing continuation, pause/resume and journal-recovery contracts.
The actual produced model requests must contain one formal schema per tool,
without DStudio-generated duplicate schemas in the system message. A user-owned
JSON example that deliberately names `read_pdf` must survive verbatim, and the
entire Cowork charter must still reach the model. This checks the native
preparation worker as well as the direct prompt builder; its remote-only build
setting must not change the selected model's tool protocol.
The two image scenarios exercise the real view_image tool through the native
host/transport: original PNG bytes, retained observations after file changes,
workspace/symlink confinement, and recovery after a simulated decoder error.
An unaccepted image cannot poison later turns or remove a previously accepted
one. Model replies remain simulated; these are not visual-quality results.
The produced prompt and `/api/status` must agree with the image tool: current
vision survives another mode's cancelled preparation, and model loss removes
the capability even when its projector remains installed.
`make test-q36-attachments-browser Q36_AGENT_SOURCE=/path/to/main/source`
extends the same isolated fixture to nineteen checks. It adds real browser
uploads and sends in Chat/Cowork, original workspace-file verification, actual
native image-tool execution and inspection of the received model payload.
Chat's final response must be acknowledged by the native conversation store,
read back and remain visible after completion; a transient stream bubble is
insufficient. Mode changes must keep the same owned model process.
The installer, model bytes and inference replies remain simulated; neither a
desktop `.app` nor visual comprehension is claimed. Set `DSTUDIO_TEST_BROWSER`
to `webkit` (default) or `chromium` and `DSTUDIO_TEST_THEME` to `light` (default)
or `dark`. Screenshots and all attempts remain in the ignored run directory.
`make test-qwen27-model-ui` also executes attachment preparation for Chat/Tutor,
Cowork and PDF routing, preserving attachments when a textual/cloud/LAN model
does not support those pixels. Its PDF renderer is simulated.
The native structured-bounds probe adds deterministic read/open/receipt barriers
for path replacement, source changes and cancellation, plus PNG/JPEG byte
encoding, special-file rejection, byte/count limits and owner retirement.
The source input is copied without weights,
is never modified, and is checked again after the test.

`make test-qwen27-model-ui` executes the production model catalog, settings and
request functions. It distinguishes 27B from Flash-Next, checks the exact
projector/quantization pair, preserves other models' preferences and verifies
native Max at 96k, declined/stale confirmations and model-specific restoration.
The existing `ui_model_picker_playwright_test.mjs` exercises actual controls,
launch requests and light/dark rendering for 27B as well as the earlier models.
Run it normally and with `DSTUDIO_TEST_BROWSER=webkit`; its engine is simulated.
`make test-ui-qwen-learn` includes the 27B's distinct Max/normal mapping and
temporary context, alongside the existing two Qwen families. Research, audits,
retry, expansion and Tutor run through production UI with simulated replies.

With a verified managed installation under a task-owned `tests/.artifacts/`
directory and existing weights, the explicit real gates are:

The current q36 installer candidate is `8362010`, with runtime `next-review`,
terminal `monitor`, then `monitor-owner` applied and recorded in that order.
`node tests/live/engine_acceptance.mjs --setup --engines main,q36` creates an
empty private installation and downloads/builds both sources, but no model
weights. On 12 September `engine-acceptance/run-37al3S` passes both setups
and actual executable startup. Its q36 receipt records 147 compiler-source
inputs and 255 managed files, including build outputs and non-source assets.
That fresh-install result does not test an existing-install upgrade.

The installer now prepares reviewed upgrades privately and atomically exchanges
the complete engine directory, retaining the original installation and an
identity journal. For older Metal receipts, it re-downloads and verifies the
original archive to reconstruct ownership. Unknown files are not adopted:
settings, projects, cache and weight aliases remain at the same paths. Regular
user files share their existing inodes, so the retained directory is **not an
immutable backup or undo of later user edits**. Unrecorded legacy build products
remain unchanged; conflicting new development-only build outputs are retained
separately, never substituted for the new desktop executables or runtime assets.
Additional patch requirements, edited managed files, unreviewed revisions,
active model leases and conflicting user files reject the update without
overwriting the working engine. Legacy macOS executables also receive an open-
vnode check; manual launches must stay stopped throughout migration.

`python3 tests/integration/q36_install_test.py` now has 42 model-free cases.
They use actual locks, files, processes, archive extraction, directory exchange
and fsync, but simulate network and compilation except for the busy native peer.
They cover cancellation before/after publication, fsync failure and idempotent
reopening, with no premature success or second exchange. A command-cleanup
regression verifies descendant drain and forbids signaling a reaped process-
group identity. macOS all-zombie groups are distinguished through libproc.
User C projects, their Makefiles and linked project directories survive an
upgrade without becoming compiler inputs or installer-owned files. Engine
source areas still reject changed, missing, extra or linked inputs. The source
areas are reviewed against each supported pin's actual build dependencies;
placing arbitrary code in the engine's own root/shader directories is not
treated as a separate user project.
Real caller-death tests kill only their own installer after a socket handshake.
The owned command must close even if it has already closed stdout or ignores
SIGTERM. A bounded supervisor retains the command's process-group identity
through its final signal/reap; the caller alone holds the lifetime pipe writer.
The raw command output limit is unchanged, including invalid-UTF-8 replacement
at the byte limit. Network/build fixture simulation remains distinct from the
actual network upgrade below.

The separate heavy upgrade gate uses an **unchanged copy of a real previous
task-owned installation**, not fabricated source/build receipts. It performs
native 27B inference, preserves an actual disk cache across a network download
and rebuild, then performs native inference again and checks reopening. It now
starts a fresh upgraded process to continue the old conversation, verifies the
reported reused-token count against the old KVC header, and compares the same
answer against a separate cold-cache process. The original installation and
model bytes are hash-checked; weights are not copied or downloaded. This is
one concrete cross-version reuse regression, not exhaustive cache-format or
numerical equivalence, long-context quality or every application mode.

```sh
make test-q36-upgrade-live \
  Q36_LEGACY_SOURCE=tests/.artifacts/previous-install/q36 \
  Q36_MAIN_SOURCE=tests/.artifacts/existing-install/ds4 \
  QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf
```

Eight phase outcomes, requests, answers, old/new receipts and failures are retained
in ignored `q36-upgrade-live/`. A failed pre-upgrade response is a failure, not a
valid working baseline; subsequent phases remain not run in that attempt.

```sh
make test-q36-host-live Q36_SOURCE=tests/.artifacts/your-install/q36 \
  QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf \
  QWEN27_PROJECTOR=/path/to/Qwen3.8-27B-mmproj-F16.gguf
make test-q36-host-browser-live Q36_SOURCE=tests/.artifacts/your-install/q36 \
  QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf \
  QWEN27_PROJECTOR=/path/to/Qwen3.8-27B-mmproj-F16.gguf
make test-q36-host-tools-live Q36_SOURCE=tests/.artifacts/your-install/q36 \
  QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf \
  QWEN27_PROJECTOR=/path/to/Qwen3.8-27B-mmproj-F16.gguf
```

The first gate has seven checks: actual host launch, catalog, two exact text
answers, exact streaming, same-process reuse and Stop releasing the port.
The real native process must also exclude an exclusive installer through its
lifetime, allow shared read-only validation/reuse and release its lease on Stop.
The second adds three real Chat interactions in headless WebKit: an exact text
answer and two pixel-only counterfactuals. The latter have identical prompts
and filenames but different known colors. Each uses a new conversation and
checks the actual image-bearing request, independently expected answer and
host-persisted history, excluding prior conversations from its oracle.
It is not an interaction with the installed macOS `.app` window. Both hash the
actual inputs, use Metal/Q6/F16 KV, context 8192 and a 256 MiB disk-KV budget,
and refuse an unrelated active engine. Model aliases are hard links inside
the task-owned installation, never copies or moves of the user's weights.
No weights are downloaded. Logs, complete answers and screenshots remain under
ignored `q36-host-live/`; review screenshots before claiming visual acceptance.
These development regressions do not replace held-out quality evaluation;
the earlier 11/12 quality failure remains open.

The tools gate retains all seven native checks and adds seven: the real 27B
fixes a Python program and runs its unchanged tests; Cowork reads a CSV,
creates an XLSX and reads it back; Chat then answers again with the same
resident process. The harness separately executes an unchanged Python oracle
and reopens the workbook using an independent bounded OOXML reader, not the
writer's own helper. It records prompts, tool calls/results, errors, final task
state, output files and hashes. A claimed completion is insufficient.
Four additional pixel-only questions use actual view_image calls in Agent and
Cowork: changed colors and left/right order, with no expected answer in file
names, metadata or prompts. The exact final answer, actual tool receipts and
unchanged original PNGs are checked. Each new turn gets its own 240-second
budget; the existing ten checks and their deadlines remain unchanged. This
expanded fourteen-check gate is a development regression, not the broader
held-out PDF/image corpus or a desktop-window qualification.
`make test-q36-host-tools-browser-live` combines all fourteen native/tool checks
with those three real-browser cases (seventeen checks). The image Chat cases
retain the existing 45-second response deadline, each with an added declared
run budget; native Chat, tool-turn and Stop deadlines are unchanged. Use the
same `Q36_SOURCE`, `QWEN27_MODEL` and `QWEN27_PROJECTOR` arguments above.
The workflow oracle matches returned source/readback cells and call/result
ordering, not just tool names. A CSV/TSV `inspect` can be a complete read;
XLSX `inspect` is metadata and cannot replace cell reading. Partial/truncated
results, mismatched IDs, wrong values, missing results and readback before
creation fail. `node tests/unit/cowork_spreadsheet_oracle_test.mjs` executes
the real Office CLI on temporary CSV/XLSX files in sixteen model-free cases;
it is included in `test-cowork-unit`. The unchanged independent OOXML check
still validates saved values, row order, sheet identity and absence of formulas.
Original failed receipts are preserved when correcting a grader; a post-hoc
workflow audit cannot turn an unfinished/timeout run into a passing full gate.
This uses direct native orchestration, not Task Graph qualification. Each
tool turn has a declared 240-second deadline; no earlier Chat/Stop deadline
is increased. Main's pinned native tool runtime must be installed as the
`ds4` sibling of the isolated `q36` tree. Tools are built before inputs are
frozen, without loading a second model. The first readiness-harness failure
remains recorded; submission must wait for the native ready/idle handshake,
not merely a successful launch HTTP response.

`make test-q36-host-tools-trace` repeats the same real-tool gate and deadlines
with a diagnostic-only host that appends the native server's existing `--trace`
option. It records the actual requests, rendered prompts and phase timings
under the ignored run directory, with an 8 MiB observed log limit and the same
overall run bound. It neither edits the inference binary nor substitutes a
different tool loop. A diagnostic run is not a substitute for the normal-host
qualification run. No trace is enabled in the installed application.

To diagnose native readback costs without modifying an installed engine:

```sh
make test-q36-sync-profile-live Q36_SOURCE=/path/to/installed/q36 \
  QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf \
  Q36_NATIVE_TRACE=tests/.artifacts/q36-host-live/your-run/native-trace.log
```

This explicitly heavy diagnostic extracts the retained first Agent request,
builds two test-only native executables and runs them sequentially with the
same real weights. It preserves the rendered prompt, quality mode, F16 KV and
8k context, but uses **eight greedy token choices**, not the original Agent
sampling or tool loop. The first choice uses prefill logits, so at most seven
decode evaluations are timed. It is not an Agent completion or answer-quality
test, and cannot replace the unchanged 240-second real-tools gate.

Before running a model, real Metal copies/readbacks check that instrumentation
preserves bytes, non-finite values, invalid-range failures and reset behavior.
Then prompt tokens, chosen tokens and SHA-256 of every full logit vector must
match the uninstrumented replay. Eleven fixed counter buckets occupy 440 bytes;
records are emitted once per phase, without per-token logs or extra workers.
The wrappers are never linked into a managed runtime or desktop app. Each
native replay has a 240-second deadline and 8 MiB output cap; another engine
causes the diagnostic to stop only its own process. No downloads or settings
changes occur. Inputs, compilation commands, outputs and failures remain in
ignored `q36-sync-profile/` artifacts.

Readback wall time includes waiting for **actual GPU computation**. It is not
all removable synchronization overhead; GPU-busy time must be read alongside
it. The report is a single diagnostic pair, not a speedup claim or percentile
benchmark. Sampled process RSS is not total GPU/unified-memory consumption.

The model-free template regression requires Python/Jinja2, a C compiler and
the already available GGUF files (only bounded metadata is read):

```sh
make test-q36-chat-template Q36_SOURCE=/path/to/patched/q36 \
  QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf \
  QWEN36_MODEL=/path/to/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf
```

It executes the production native parser/renderer with ASan/UBSan against the
exact embedded Jinja templates: eight assistant/tool histories, both explicit
`preserve_thinking` values and thinking off. Assertions compare whole prompts,
not source text. Both supplied models give 32 cases; omitting `QWEN36_MODEL`
tests only the 27B and does not qualify 35B. Original templates, input identities,
expected/actual output and every failure remain in ignored `q36-chat-template/`.
The empty-reasoning regression was red in 18 cases before the patch and green
in all 32 after it. This is format correctness, not inference or numerical parity.

`make test-q36-owner Q36_SOURCE=/path/to/built/patched/q36` tests the native
private owner socket with real processes, file descriptors and signals, plus
the actual server's startup-error path. Deliberately blocked preparation,
cancelled publication, wrong descriptors, a full unread socket, parent SIGKILL
before/after readiness, descriptor inheritance and replaced model paths are
checked normally and with ASan/UBSan. Engine/session contents are fixtures:
this is not an inference-quality or desktop-integration test. The complete
Metal patch gate runs it after its fresh build. Evidence is retained in ignored
`tests/.artifacts/q36-owner/` runs, including failures.

`make test-q36-owner-live Q36_SOURCE=/path/to/built/patched/q36 QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf QWEN27_PROJECTOR=/path/to/Qwen3.8-27B-mmproj-F16.gguf`
sequentially loads the existing hash-verified real model/projector on Metal,
validates the private readiness against opened-file identities and the HTTP
catalog, checks two exact text answers, then closes the owner channel and
requires a clean server exit and released port. It refuses an occupied engine
environment without stopping other apps. Requests, answers, identities, timings
and failures remain in ignored `q36-owner-live` artifacts. These are development
lifecycle regressions, not broad quality or proof that DStudio's picker and all
application modes are integrated.

`make test-q36-agent-tty Q36_SOURCE=/path/to/reviewed/q36` validates the
latest upstream CLI terminal candidate in a new source copy. It reproduces
`NO_TERMINAL` before the fix, exercises seven fictional-password scenarios,
verifies real EOF and terminal-mode restoration, checks 32 normal/cancelled
job lifetimes without descriptor leaks, and tests patch repeat/restore,
partial application, drift and symlink rejection. Baseline and candidate share
the corrected terminal oracle. No actual password, sudo, model or desktop
Agent-quality claim is involved; see the [patch notes](../patch/q36-agent-tty/README.md).

`make test-q36-search-extract Q36_SOURCE=/path/to/reviewed/q36` compiles a small
native emitter and executes the production search extractor in an isolated
Chromium browser. Set `DSTUDIO_TEST_BROWSER=webkit` for the WebKit counterpart.
Thirteen controlled-page cases cover opaque Google heading redirects, legacy
query redirects, title extraction/escaping, duplicates, visibility, non-HTTP
links and output limits. All page requests are intercepted; this is not live
Google search, a CDP transport test or model quality. `8362010` passes 13/13
in each browser (`run-Isb3Cz`, `run-W9TijB`); the same final oracle on
`8ce8924` retains four failures in each (`run-D1lr73`, `run-dIrVma`, 9/13).
Earlier `run-TLV8lU`, `run-1ylAjx` and `run-76SZoH` receipts remain retained.
Receipts contain compiled
extractor bytes, observed outputs, source hashes and unchanged-input checks.

`make test-q36-monitor-control Q36_SOURCE=REVIEWED_SOURCE Q36_MONITOR_OBJECTS=BUILT_COPY`
is a separate native concurrency regression on `8362010`: the unmodified and
terminal-only versions still fail; `Q36_MONITOR_FLAGS=--owner` tests the
[separate ownership fix](../patch/q36-agent-tty/README.md) in a private copy.
It includes the actual Agent under ASan/UBSan and runs a real, task-owned shell,
with a deterministic barrier on one output-file write. The control accessor
must complete while that write is blocked, and a concurrent trylock must show
the job mutex is available. Final command output and normal exit are checked
after releasing the barrier. Native helper objects must have matching source;
no engine checkout is rebuilt and no weights are loaded.
`q36-monitor-control/run-SDJGtD` reproduces both blocked-control checks while
preserving output and normal exit (job 1,208 bytes; worker 2,736 bytes). This
does not invalidate the distinct earlier terminal-EOF checks, but prevents
claiming the monitor critical path is qualified. The fix must include signal,
reap and terminal-message ownership, not just move one write out of the lock.
Set `Q36_MONITOR_FLAGS=--upstream` to compile the original Agent from the exact
Git object in a private source fixture. The same final harness reproduces the
failure in upstream `run-p2HLgN` and adapted `run-ChNShO`; both retain normal
exit, exact output and unchanged inputs. Thus this blocked-write defect is
upstream behavior, not introduced by DStudio's terminal-lifetime adaptation.

Final owner receipt `run-g38GQE` passes 7 native cases and 14 patch-lifecycle
checks. It adds real Stop during blocked output, independent-job progress,
signal/exit PID lifetime, short-write/ENOSPC bookkeeping, failed thread creation
and deduplicated terminal-failure notices. Common baseline cases remain failed
in `run-QWH68o` (upstream) and `run-puGjgb` (terminal-only), 1/5 each; the two
owner-specific notice cases are not part of that denominator. Profile counters
are probe-only; the held-signal EOF busy loop found in `run-fPmMoX` is now a
bounded-iteration regression. These are injected-failure timings, not model
performance. `Q36_MONITOR_FLAGS='--owner --tsan'` selects ThreadSanitizer instead
of ASan/UBSan; `run-PnMjJT` passes the same 7 cases and 14 lifecycle checks.
Existing helper objects are not instrumented in either mode.
`Q36_AGENT_TTY_FLAGS=--monitor-owner` selects the full native Agent/password/PTY
rerun with this delta; `run-gd2ap6_q` passes 28 stages and 32 leak-free lifetimes.
The supplied reviewed checkout and model files are never changed by these tests.

`make test-q36-metal-diagnostics Q36_SOURCE=/path/to/built/q36` validates the
[optional diagnostic candidate](../patch/q36-metal-diagnostics/README.md):
actual Metal command options and 64 GPU-computed values, then explicitly
simulated error objects to check exact status reporting, missing information,
output bounds and no retry under the shared mutex. It does not reproduce or
fix the long-context driver failure. Recorded common-100 inputs stay frozen.

`make test-q36-retained-diagnostic-inputs` exercises diagnostic admission with
fictional terminal receipts and real patch application in private directories.
It accepts the corpus's underscore-containing IDs, rejects changed requests,
partial runs and relaxed deadlines, and includes untracked sources introduced
by patches. Overlays are removed in reverse order and reapplied in forward
order; every source byte, including unrelated changes, must be preserved.

To investigate one recorded long-context failure, use the separately reviewed
diagnostic build and its expected binary SHA-256:

```sh
node tests/live/q36_retained_request_diagnostic.mjs \
  /path/to/reviewed/q36 /path/to/model.gguf /path/to/terminal-common100-run \
  long_context-single-needle EXPECTED_BINARY_SHA256 --preflight-only
```

The preflight loads no model and does not validate inference. Remove only
`--preflight-only` for an explicitly authorized live diagnosis: it verifies the
complete pinned weight hash, captures the binary, freezes the request and
retains the original 900-second deadline. The one owned engine is closed on
completion/failure/cancellation; other engines are never stopped. The test
refuses another DStudio/ds4/q36 engine, caps combined logs at 16 MiB and the HTTP
response at 2 MiB, and records driver diagnostics without retrying the request.
Each invocation owns a new ignored directory. Its outcome does not replace
the original common-100 result, qualify model quality or measure a speedup.
Add `--f16-attention` only for the separately built
[bounded F16 candidate](../patch/q36-f16-attention/README.md), both at preflight
and live execution. This records the fourth patch and verifies the complete
stack; it does not change the request or relax its deadline. Captured patch
files, binary, source copy and original failed receipts are retained separately.

`make test-q36-metal-runtime Q36_SOURCE=/path/to/pinned/q36` checks the
[Qwen27B Metal candidate patch](../patch/q36-metal-runtime/README.md) in an
isolated source-only copy, including real compilation, patch lifecycle,
blocked driver allocation, both 35B/27B data layouts, MRoPE and projector matmul/attention against
independent scalar oracles. Requires macOS/Metal, a C/Objective-C toolchain,
Git and the documented source revision; it downloads nothing and leaves
installed engines and the app unchanged. Add `QWEN27_PROJECTOR=/path/to/file`
to run the real pinned F16 projector on two RGB fixtures and compare its
embeddings with the native scalar encoder. This optional component test is
NOT_RUN when omitted. Neither path runs an LLM or establishes Qwen27B
application-mode, image-understanding or other-backend qualification.
The complete gate also requires the batched cache/decode ownership regression
below. Its original failed receipts remain; the 9 September gate after the F16
attention fix passes all 40 stages, including that ownership check. These are
model-free native/Metal checks, not a full-model quality qualification.

Add `Q36_NEXT_REVIEW=1` for an explicitly reviewed newer source. The receipt
records both the original checkout hashes and `builtSourceFiles`: the exact
compiler and shader inputs in the private copy, after patch-lifecycle fixtures.
These identities are different because the lifecycle test deliberately retains
unrelated contributor comments. Both sets must remain unchanged throughout
execution. A downstream live run must use the compiled-source identities, not
attribute the original checkout's hashes to the built binary.

`make test-q36-attention-work Q36_SOURCE=/path/to/built/q36` reproduces long
F16 attention without weights, comparing every query with single-query execution
and an independent analytic fixture. It observes actual GPU command duration,
output guards, tensor-view bounds, overflow rejection and failed-submission
recovery. All comparisons run on the same existing shader. The original driver
failure and slower total time after subdivision remain recorded: shorter GPU
commands do not by themselves mean faster model inference.

`make test-q36-f16-attention Q36_SOURCE=/path/to/built/candidate` runs the
candidate's 18 patch-lifecycle checks and 18 actual GPU input cases, including
extreme values, sinks, both tile boundaries, allocation/submission failures and
every encoder-creation stage. It compares every query directly with the
unchanged original shader, not with the candidate's own single-query wrapper.
It checks bounded work, temporary tensor accounting, output guards and recovery
after failure. This explicit target neither changes the managed installer nor
loads weights. Captured probe/harness identities and source hashes must remain
unchanged; none of these operator checks establishes full-model quality.
The additional dimensions 1/33/64/128 exercise inactive lanes, shared-memory
barriers and partial eight-value tails. Actual Metal pipeline metadata bounds
static threadgroup storage to 4 KiB, separately from temporary tensor accounting.
The probe records command-buffer GPU times for each two-kernel phase. For an
explicit **scheduling-perturbed stage diagnostic**, run
`node tests/integration/q36_attention_work_test.mjs /path/to/built/candidate --profile-stages`.
This submits each encoder separately to identify its GPU cost; it is not a
production-latency measurement or a replacement for the eighteen-case gate.

The common-100 runner has an explicit `--restart-failed-engine` option. Only the
tester's native engine is stopped and reaped before a fresh process is started
with the same weights, binary and settings. At most eight restarts are allowed;
the failed case remains failed and is never retried. Subsequent cases keep their
original prompts/deadlines. Missing readiness, changed identity, cancellation or
an exhausted restart budget stops the run with remaining cases marked not run.
HTTP/ownership-handoff simulations are labeled as simulations; actual process
exit, restart identity and subsequent inference require the separate live run.

`make test-qwen-quality-chart` checks actual Matplotlib bars against the reviewed
public common-100 aggregate, preserving every failure and rejecting incomplete,
inconsistent or simulated measurements. The chart is tied to the reviewed
source receipt so another model/run cannot inherit its hardware/date captions.
Recreate it with `python3 extension/benchmarks/qwen-quality/plot-results.py`;
the [benchmark notes](../extension/benchmarks/qwen-quality/README.md) distinguish
the completed development replay from the later F16 candidate under test.

The same gate also runs `make test-q36-dense-quant` and `make test-q36-catalog`
equivalents against its prepared copy: 75 CPU FFN composition cases with mixed
weight formats under ASan/UBSan, and actual model-list/detail HTTP serialization
for three controlled model states. Run either target alone with
`Q36_SOURCE=/path/to/patched/q36`. These are behavioral regressions, not model
answers. `make test-qwen27-download test-q36-install` uses real local HTTP,
archives, filesystem races and subprocesses; it does not download weights.
The q36 installer suite has 42 tests, including nonblocking shared/exclusive
admission, a publication racing lease conversion, alias rejection, bounded
managed-file inventory, preservation of later user notes/cache/model aliases,
and special files in place of a binary. A FIFO must fail within the test's
three-second subprocess deadline, never hang in the verifier. Fixture builds
remain simulated; the empty network-install command above is the real build
test. Legacy receipts without a managed-file inventory retain their earlier
verification scope and are not authorization to overwrite unrecorded files.
Reviewed legacy upgrades reconstruct ownership from the exact verified archive;
unknown user files are preserved, not adopted.

For an explicit network setup and real Qwen27B acceptance run with already
downloaded, hash-verified weights:

```sh
node tests/live/engine_acceptance.mjs --setup --infer --engines q36 --model-root /path/to/model-store
```

This runs the native server, not DStudio Chat/Agent/Cowork/Learn integration.
All 12 checks and failed responses remain in the denominator. Source/binary
identity is verified from the installer receipt; no Vulkan or full-logit parity
is inferred from a Metal answer test.

`make test-q36-request-parity-live Q36_SOURCE=/path/to/installed/q36 QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf`
replays the retained Python-answer failure through the real native HTTP parser,
then the CPU and Metal cores sequentially. It verifies the complete weight hash,
source receipt, actual prompt tokens and full-vocabulary finite logits. It keeps
the pinned upstream distribution tolerances and separately executes the Python
answer oracle: matching wrong answers remain a failed test. Requires already
built, pinned native objects; no download, user-engine stop or app change. This
is a development regression, not independent architectural parity or held-out
quality. It has a 900-second native deadline and bounded output.

`make test-q36-text-prepare Q36_SOURCE=/path/to/patched/q36` executes native
private text preparation with initialized CPU state and ASan/UBSan. It covers
all nine K/V format pairings, every allocation failure, cancellation, changed
prefill/cache configuration and exact state preservation: 2,070 scenarios in
the current revision. Counted copy bytes are equal at context capacities 64 and
4,096 with the same active tokens. This does not run forward inference; the
tiny MTP-state fixtures are not MTP numerical qualification. The complete Metal
patch gate also runs it, including header apply/restore/drift/link rejection.
The native fork phase must preserve exact prefix state without forward work;
failure to reserve token history must return before modifying the previous state.

`make test-q36-vision-prepare Q36_SOURCE=/path/to/review-candidate/q36` exercises
the new revision's private visual checkpoint fork with initialized native CPU
buffers and ASan/UBSan. It checks exact active KV/recurrent copies, independent
image identities and MRoPE state, allocation/cancellation failures, mismatched
image fingerprints/geometry/positions and overlapping appended images. A
mismatch must start an empty private candidate, never reuse another image's
checkpoint. Text-only preparation still cannot inherit a visual checkpoint.
Copy work is unchanged between context capacities 64 and 4,096 at fixed active
state. This is a model-free ownership test, not CPU vision support or real-image
answer qualification; it applies only to the isolated q36 update candidate.

`make test-q36-payload-prepare Q36_SOURCE=/path/to/patched/q36` executes native
payload restoration under ASan/UBSan with initialized CPU state, not mock
serialization. It covers every truncated byte count, cancellation through the
final byte, header/token/configuration errors, all nine K/V formats and every
observed allocation failure. A larger logits buffer checks the 64 KiB transfer
bound; policy fields and zero tracked native allocation leaks are asserted.
The current gate has 9,757 scenarios and 48,564 assertions, including twelve
native payload-writer cases: bounded transfers, pre/mid/final-byte cancellation,
short/failed writes and unchanged source bytes. The caller's live
state and output pointer must survive failure. `Q36_DIRECT_BASELINE=1` uses
the original in-place reader with the same preservation requirements. These
are model-free state tests, not GPU/MTP inference or a public HTTP cache test.

`make test-q36-payload-schedule Q36_SOURCE=/path/to/built/patched/q36` tests
the native scheduled serializer with real Metal buffers and ASan/UBSan. Build
the exact patched checkout first (`make -C /path/to/q36 -j2 metal`); the harness
hashes source, object and test inputs before and after execution. Its 186 cases
cover a separately assembled byte oracle across both model shapes (four
initialized layers), all nine K/V pairs, recurrent precision and logits location,
admission/read/output failures, private restoration, scheduled logits,
cancellation and unchanged active read visits when only context capacity grows.
Scheduled forks retain exact native KV/recurrent/logit/hidden bytes, allocate
outside backend admission and copy at most 64 KiB per lease. Two actual private
KV grows copy the same eight active rows; admission failure/cancellation keeps
the source and output pointer intact.
Deterministic blocked input/output allows independent GPU operations through a
**scheduling fixture**. No model is loaded;
this is not a server concurrency or quality test.

`make test-q36-cache-owner Q36_SOURCE=/path/to/patched/q36` runs the actual
native file reader/writer and decode scheduler with simulated numerical sessions.
Eight scenarios cover blocked reads/writes, exact prefill frontiers, cancelled
reads/writes, stale publication, corruption and final persistence after worker
shutdown. A second slot must finish its
scheduler round-trip before the disk barrier opens; prior file bytes and both
slot states are checked. The current patch passes. The preceding patch's four
read-path failures are retained. This acceptance remains required by the complete
`test-q36-metal-runtime` gate without an expected-failure exemption.
Both harnesses keep receipts in ignored artifacts; neither starts the user app.

`make test-q36-batched-cache-live Q36_SOURCE=/path/to/installed/q36 QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf`
is an explicit real-model regression. It starts its own two-slot engine, checks
exact answers, stops it, restores real disk KV in a fresh process and checks
concurrent requests and earlier cache bytes. Context is 4,096, prefill 128,
F16 KV, quality mode and resident weights; no expert streaming or image encoder.
It refuses overlap with a user's engine/app, bounds logs/runtime, retains failed
receipts and stops only its own process group. It is not a throughput benchmark,
broad language-quality score or DStudio desktop acceptance.
The initial 8/10 run is retained: its cold-cache ceiling excluded the prompts,
and shutdown refused final serialization. The corrected harness keeps all
original answer/cache assertions and adds a persisted shutdown-file check.
The subsequent historical run on patch `960b1505` passes 11/11, including seven exact answers and independent
checks of native cache files. Both engine processes exit cleanly. Two concurrent
slots were exercised, but no two-item decode batch was observed; this does not
qualify fused-batch numerics. A restore delayed by another prefill still requires
fairness/queue profiling, not a claimed cache speedup.
The current harness has fifteen checks: cancellation after observable real
continued prefill, an uninterrupted control and reestablishment of the same
resident session. The next answer must retain the exact pre-cancel frontier
and the native control's cache decision. Qwen's empty thinking markers can
cause a legitimate disk hit even without Stop; requiring a RAM hit produced
an initial retained 12/13 failure. With the permanent control, patch `1677e0f6`
passes 15/15 and `960b1505` fails 2/15: cancellation finishes the prompt and
replaces the previous frontier. All eleven original checks remain.

`make test-q36-session-batch-live Q36_SOURCE=/path/to/installed/q36 QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf`
builds the pinned upstream session-batch test from source in an ignored run
directory. It runs actual 1/2/4/8-session Metal computation with F16/F16 and
Q8_0/Q4_0 KV, preserving upstream's full-logit, argmax, identical-prompt,
payload, invalid-input and ordered-fallback assertions. The upstream full-logit
bound is 0.25 absolute, not bitwise equivalence. Its default quality-off,
512-context, eight-token prefill settings are distinct from the HTTP corpus.
The runner rejects skips and missing batch sizes and requires actual native
2/4/8-row execution plus the ordered fallback. The Vulkan-named entrypoint
uses upstream's Metal test compatibility; this does not qualify Vulkan, HTTP
scheduling, application modes or general answer quality. No model downloads,
app restart or implicit inclusion in model-free gates.

The first run on `1677e0f6` failed both KV phases: rows 4..7 in the eight-row
batch diverged (maximum absolute logit error 9.62949), including one different
next-token choice. The original receipt remains; passing 1/2/4 rows did not
qualify eight. This is cross-session scratch reuse, not a looser numerical
tolerance or a reason to omit a batch size.

`make test-q36-recurrent-batch Q36_SOURCE=/path/to/patched/q36` isolates that
bug without model weights. It executes the real native recurrent batch and
Metal kernels against an independent-storage oracle, using synthetic weights
and both real recurrent layouts. Its 96 cases cover 1..8 sessions, capacities
8/16, fused/unfused/mixed convolution and two successive steps, checking exact
output, convolution history and recurrent state. The old revision fails 24
cases (336 assertions); patch `aa26ffa9` passes all 9,216 assertions with
ASan/UBSan. The test changes neither upstream's real-model oracle nor its 0.25
bound. It is part of the model-free runtime gate, not 96 real-model answers or
proof of Vulkan parity.

The unchanged real-model upstream oracle subsequently passes both KV phases
on `aa26ffa9`: all 30 full-logit comparisons (1/2/4/8 rows), identical next-token
choices, and the native payload/invalid-input/fallback assertions. Maximum
absolute error is 0.00828552 for F16/F16 and 0.214759 for Q8_0/Q4_0, below the
original 0.25 bound, not bitwise equality. This does not establish general
answer quality or full application concurrency. Original failed runs remain.
The existing real HTTP cache/Stop corpus also passes 15/15 again on this
rebuilt revision, preserving the no-Stop control and exact prior frontier.

`make test-q36-http-text-batched Q36_SOURCE=/path/to/patched/q36` executes the
same 24 HTTP/cache transaction cases as the single-session gate with actual
batched scheduling and simulated native numerical work. The old batched path
fails 20 cases; private whole-prompt preparation passes them without changing
the single-session assertions. This is not inference or desktop qualification.

`make test-q36-text-prepare-live Q36_SOURCE=/path/to/installed/q36 QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf`
loads the real model once and tests seven native text preparations plus six
payload restorations. It compares full checkpoint payloads and finite logits
byte for byte, with four subsequent decode steps in **each** case, including
every cancellation. Native chunk/byte boundaries trigger interruption; payload
cases include a missing final byte, full restoration and legacy token-only
replay. Payload FILEs are memory-backed, so their timings are not SSD speed.
Add `Q36_DIRECT_BASELINE=1` to execute the original in-place APIs against the
same preservation requirements: the expanded retained baseline is 2/13, and
private preparation is 13/13. The earlier seven-case receipts remain intact.
This measures native state semantics, not held-out answer quality, complete
HTTP cache transactions, app Stop or desktop modes.
It uses at most three test sessions sharing one engine, bounded snapshots/output
and a 600-second deadline. It refuses another running engine and stops only its
own test process if another engine starts; no downloads or app restarts.
`make test-q36-text-schedule-live Q36_SOURCE=/path/to/installed/q36 QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf`
runs those same thirteen numerical cases through scheduled native fork, prefix
sync and payload restore, including nonempty legacy token replay. The backend
lease is a single-owner fixture; actual server concurrency is tested separately.

`make test-q36-vision-session-live Q36_SOURCE=/path/to/installed/q36 QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf QWEN27_PROJECTOR=/path/to/Qwen3.8-27B-mmproj-F16.gguf`
decodes four original PNG pixel fixtures through the real projector and Metal
language model. It checks colors, left/right order, return to text, malformed
span rejection and already-cancelled text/image synchronization from both text
and visual sessions. Prompt tokens, position and full-vocabulary logits must
survive that pre-cancelled request. Inputs and grader are frozen in each receipt;
the 600-second run has one model, bounded output and no app/engine mutation.
This does not cover cancellation after prefill has started, HTTP image handoff,
desktop integration or the separate 30-PDF/20-image held-out corpus.

`make test-q36-vision-answer-oracle` checks the color/order grader without models.
Comma-separated names allow surrounding whitespace, as the image prompt does;
wrong order, wrong colors, explanations, invalid UTF-8, nonfinite or incomplete
generation still fail. The original whitespace false negative is retained and
has a separate, explicit regrade receipt, not an overwritten result.

`make test-q36-http-vision Q36_SOURCE=/path/to/patched/q36` compiles the actual
HTTP parser/renderer with ASan/UBSan: 37 cases cover image bytes/typed positions,
ordering, malformed/unsupported input and inclusive count/byte limits. Eleven
additional cases execute the production session-publication path with a
simulated native worker, deterministic barriers and real sockets. A blocked
preparation must leave previous state intact while metadata remains available;
failure, stale ownership, context mismatch, shutdown and TCP reset cannot publish.
A legal TCP half-close must still allow completion; explicit per-request
cancellation must retain the previous session both before and during private
preparation. The harness now observes
worker termination as well as barrier admission, so an early production failure
cannot leave the test waiting for a preparation that never started. These are
not model quality tests; the outer Metal patch gate runs and freezes them too.

For the isolated `8ce8924` rebase, run
`node tests/integration/q36_http_vision_test.mjs /path/to/q36 --next`.
This selects its actual parser ABI and adds native Responses/tool/Anthropic
image acceptance; the prior unsupported paths remain explicitly checked on
the older runtime. The probe reports request-owned random markers and their
actual byte positions without replacing them in the rendered output. The
common image, bounds and session-publication assertions remain unchanged.
The next-ABI owner scenarios also run with prepared synthetic image embeddings
and pending tool IDs (61 total cases). Only successful session publication may
retire those IDs; failed/cancelled preparation retains them. These exercise the
real HTTP ownership path, not pixel quality or a simulated model answer.

`make test-q36-http-vision-live Q36_SOURCE=/path/to/installed/q36 QWEN27_MODEL=/path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf QWEN27_PROJECTOR=/path/to/Qwen3.8-27B-mmproj-F16.gguf`
launches the actual native server with verified LLM/projector hashes and checks
28 HTTP workflows: color counterfactuals, two-image order, real decoder error,
text recovery, JSON and SSE completion, including clients that half-close their
request but keep reading. It also cancels a partially received body and actual
image preparation through the native request-ID endpoint, checks recovery and
removal of finished identities. Metadata is probed during image preparation.
Seven tool scenarios require an actual generated `read_file` call, validated
arguments, a real fixture-file read, and exact case-sensitive answers to two
different tool results in each of OpenAI, Responses and Anthropic. Native trace
receipts must show actual RAM tool replay in the generation path. This is not
the DStudio Agent loop, nor a disk-cache replay test.
The 600-second run uses one Metal model at 8k context, F16 KV, greedy decoding
and no expert streaming. Inputs, outputs, exact server binary and original
failures are retained; another running engine or user app prevents launch.
The private opt-in trace is checked every 250 ms against an 8 MiB limit; its
watchdog and engine are cleaned up at the end. No throughput claim uses this run.
Process ownership is rechecked every second; if a user app or another engine
starts, the harness terminates only its own test model and records interruption.
The retained half-close runs are 14/16 and 16/16; the extended cancellation
before/after runs are 19/21 and 21/21, with identical prompts/settings and verified
weights (fresh opaque request IDs per attempt). They do not establish broad
vision quality, per-request app cancellation, other backends or desktop support.
The expanded three-protocol run passes 28/28 on the `4c43f699…` patch; the
earlier 24/24 OpenAI-only receipt retains its original scope and harness.

For the explicitly selected `8ce8924` or `8362010` review checkout, rebuild that isolated
source with `make -C /path/to/q36 -B -j2 metal`, then run:

```sh
node tests/live/q36_http_vision_live_test.mjs /path/to/q36 /path/to/Qwen3.8-27B-UD-Q6_K_XL.gguf /path/to/Qwen3.8-27B-mmproj-F16.gguf --next
```

This does not create an installation receipt or promote the installer pin.
The harness verifies the checkout's own revision and complete review patch,
freezes its bounded source set and binary, and rechecks them after execution.
An archive/source-only copy must instead supply `--native-receipt FILE` from
the current successful `test-q36-metal-runtime` gate. This verifies its reviewed
base, actual binary, complete compiled source/shader inventory and current
build harness/patch. It never inherits DStudio's parent Git revision. Older
receipts without compiled-source identities cannot qualify this path; rebuild
in a new private directory and retain the original receipt unchanged.

For that source-copy path, run `make test-q36-http-review` with `Q36_SOURCE`
set to the native gate's `source with spaces` directory, `Q36_NATIVE_RECEIPT`
to its `results.json`, and the existing `QWEN27_MODEL`/`QWEN27_PROJECTOR` paths.
This invokes the actual CLI's `--preflight-only` mode with matching and
deliberately invalid receipts. It starts no model or socket, does not verify
weights and must record zero inference cases with status `preflight-pass`.
It tests admission/provenance, not model correctness. The subsequent real
`test-q36-http-vision-live` command accepts the same paths plus
`Q36_NEXT_REVIEW=1` and optional `Q36_DISK_CACHE=1`; it performs weight
verification and actual inference. A preflight pass is never a live pass.

For an actual managed installation, use `make test-q36-http-install` with
`Q36_SOURCE`, `QWEN27_MODEL` and `QWEN27_PROJECTOR`. Its 16 admission cases
use private copies of installed source/binary bytes and deliberately changed
receipts. They reject altered/missing/extra/linked sources, a nonregular or
stale server, wrong revision/backend, changed patch/installer and patch order.
They also accept unrelated C projects and linked project directories without
compiling or modifying them. They never start a model or verify weights. The
managed live path recomputes the production installer source inventory,
including Vulkan inputs; Metal-only
build receipts remain a separate path. A current managed pin retains all 40
native image/tool scenarios (46 with disk cache) without requiring `--next`.
The legacy installed pin keeps its distinct 28/34-case renderer expectations.
`q36-http-install/run-bsmPUH` passes 14/14 and
`q36-http-review/run-aGwGJa` passes the existing 13/13 source-copy cases on
the revised admission harness. These preflight receipts are not inference passes.
The subsequent actual managed-install replay `q36-http-vision-live/run-oGEVFX`
passes all 46 cases with disk cache, unchanged 157 captured inputs and both
verified weights, native exit 0 and its owned PID reaped. It uses the same
prompts/oracles/deadlines, with no `--next` flag or fabricated Git provenance.
On 12 September, the new native gate `q36-metal-runtime/run-nY4HeX` passes
43/43 stages including the projector and 52 captured compiler/shader inputs;
`q36-http-review/run-fOY8Ec` passes all 13 admission cases. The new exact-revision
real run `q36-http-vision-live/run-jfuPOr` passes 46/46 on `8362010`, with
unchanged inputs/weights and native exit 0. It preserves all four earlier disk
checkpoints through Stop and the eight uninterrupted-continuation fields.
This is new scoped evidence, not inherited from `8ce8924`, a broad quality
qualification or installer promotion. Original failed receipts remain intact.

It keeps all 28 original workflows and adds 12 real model/tool checks across
the three APIs: an actual generated file-read call, a real file result, and
an authenticated tool-only continuation that must remember the original image
without resending it. A new image in the tool result must change the exact color
answer while preserving the matching historical frontier. These are 40
development workflows, not held-out vision quality or the DStudio Agent loop.
`q36-http-vision-live/run-vf7idm` passes all 40 on the rebuilt review candidate
with unchanged source/binary/projector/model identities and normal engine exit.
The earlier failed quality/long-context receipts remain; this run does not
enable the installer revision or qualify a different Qwen model/backend.
Adding `--disk-cache` retains all 46 scenarios; its first next-revision run
`run-MO5enE` is **43/46 FAIL**. Existing file hashes survive actual Stop, but
the preceding image state bypasses cold text checkpoint preparation, breaking
the original uninterrupted-cache oracle and its dependent comparison.
The full receipt and the separate template/canonicalization mismatch remain
in the [update checkpoint](../docs/DS41_UPDATE_CHECKPOINT.md); no failure was
removed or counted as a pass.
The preserved-thinking review now requires exact `memory-token` reuse for
uninterrupted continuation; the historical variant keeps its original explicit
token-mismatch/disk-text oracle. Both still compare all eight frontier fields
before/after Stop, alongside exact answers and unchanged files. The corrected
template/image-to-text run `run-6jY0tA` is **45/46 FAIL**: the old session is
retained, but an eviction checkpoint is published before replacement commits.
Its strict directory comparison is not relaxed. The final review defers that
save until successful owner publication. The final-source real replay
`run-fSs5iW` passes **46/46**, keeping all expected answers, case ordering and
deadlines. Four published files remain identical through Stop; the exact code
and all eight native cache-decision fields match uninterrupted continuation
(1,302-token live prefix, 1,326-token prompt, `memory-token`, no disk reuse).
Original inputs remain unchanged and the engine exits 0. This closes the
scoped cache regression, not full quality, long-context or DStudio app support;
the installer pin and original failed receipts are unchanged.

Add `Q36_DISK_CACHE=1` for the 34-case native HTTP corpus. It retains all 28
workflows and adds cold/continued checkpoint publication, a real disk-prefix
hit, an uninterrupted chat-continuation oracle, Stop after a private checkpoint
has actually been written, and continuation after Stop. Cache files have a
4 GiB budget; previously published names, sizes and SHA-256 hashes must survive
Stop unchanged and no private temporary file may escape cleanup. Control and
Stop keep their original one- and fifteen-second limits. The current
`c392ca1a…` run passes 34/34. This is a real native cache transaction test,
not DStudio's application Stop, a storage benchmark or broad answer quality.
The initial 32/33 receipt is retained. Its last assertion incorrectly required
RAM reuse: the native renderer drops an empty thinking block from assistant
history, so the incoming prefix differs even without cancellation. The new
uninterrupted execution establishes the cache oracle; after Stop all eight
frontier/cache-decision fields and the exact answer must match it. The same
harness and oracles apply to both engine revisions.
The final previous-server run is 31/34. Both revisions receive real Stop at the
native 512-token checkpoint; private publication, identical previous files and
the original time limits remain required. Earlier receipts that waited for a
private-checkpoint marker unavailable in the old server are retained separately
and do not prove its actual Stop behavior.

`make test-q36-http-text-prepare Q36_SOURCE=/path/to/patched/q36` executes 24
production HTTP text/cache transaction scenarios with ASan/UBSan, real sockets,
native cache metadata/files, and explicitly simulated inference. Deterministic
barriers cover private preparation, cancellation, stale ownership/context,
shutdown, allocation failure, disk/token/BPE-prefix reuse and corrupt payloads.
Write/rename failures, cache disabled/low-budget behavior, 64-file admission,
duplicate destinations, the 8 GiB hard ceiling and repeated tool-map bytes are
also checked. The previous server passes 3/24, the candidate 24/24; a retained
intermediate 23/24 exposed undercounted serialized tool blocks. No assertion was
weakened. Add `Q36_DIRECT_BASELINE=1` only for the historical in-place source.
This gate is included in the complete 29-stage native Metal patch test; it does
not qualify batched scheduling or model answer quality.

For the explicit `8ce8924` review, invoke the script with `--next`:

```sh
node tests/integration/q36_http_text_prepare_test.mjs /path/to/q36-review --next
node tests/integration/q36_http_text_prepare_test.mjs /path/to/q36-review --next --batched
```

The 46 single-session cases retain the original 24, then cover actual native
template/checkpoint agreement, independent text after images, exact visual
identity rejection and pending-tool retirement. Eleven further cases keep a
newer unsaved live session alongside an older committed disk file. No file can
be published/evicted while a replacement is preparing or after it fails, is
cancelled, loses ownership, changes context or encounters shutdown. Successful
retirement must preserve and reload the old live tokens/logits exactly. The
batched gate runs its 36 applicable text cases, not unsupported batched images.
Final targeted before/after results are 35/46 to 46/46 and 25/36 to 36/36,
respectively; the earlier real 45/46 failure remains. These are deterministic
production-control/cache tests with simulated numerical work, not model quality.

`make test-q36-cache-usage Q36_SOURCE=/path/to/installed/q36` verifies the
separate `cache-usage.patch` against a bounded private source copy of the
current `8362010` installation. Its 12 stages cover patch lifecycle, all partial
hunks, drift, symlink/ABI rejection, unrelated edits and dependency invalidation
for both native server consumers. The included ASan/UBSan HTTP suites have
78 single-session and 68 batched cases: existing transaction regressions plus
actual OpenAI completion/chat, Responses and Anthropic JSON/SSE usage, each with
cold, disk, memory-token and memory-byte prefixes. A preparing/cancelled result
cannot claim committed reuse. Responses' initial zero-usage placeholder is
checked separately from its terminal receipt. Native session calculations are
simulated; this does not run a model. See the [patch evidence and application
order](../patch/q36-metal-runtime/README.md#committed-text-cache-usage-receipts).

`make test-q36-http-control Q36_SOURCE=/path/to/patched/q36` executes sixteen
native HTTP/control scenarios with ASan/UBSan, actual socket messages and
deterministic receive barriers. It covers cancellation before body completion,
duplicate live IDs, sixteen occupied generation leases with responsive metadata
and cancellation, malformed framing, cleanup, queued/active cancellation without
affecting another request, and preventing executable tool calls after an error.
It also verifies owner-only tool replay for all three HTTP parsers, unchanged
captured settings, pre-cancellation, context admission after exact rendering,
and actual tool-map/trace bytes without holding the corresponding shared locks.
The preceding native revision passes 9/16 with the same final corpus; the
candidate passes 16/16. To run that historical baseline, invoke
`node tests/integration/q36_http_control_test.mjs /path/to/previous/q36 --direct-baseline`.
That option preserves the old owner's no-reparse behavior; it is not a second
production path or a simulated implementation of the new helper.
Queue tests use explicitly simulated tokenization/work, not real inference.
The receipt includes compiled hot-record sizes. The optional
[`q36_http_control_profile.c`](support/q36_http_control_profile.c) probe measures
the actual admission/cancel/release mutex paths with 1/8/16 active fixtures and
128 repetitions. It is model-free and uncontended, with timer overhead/resolution;
zero clock ticks do not mean zero work. It is not a throughput or application
latency benchmark, and adds no production profiling overhead.

`make test-q36-tool-replay-identity Q36_SOURCE=/path/to/patched/q36` executes
93 native cases with ASan/UBSan. Tool IDs cannot replace a changed tool name,
argument, JSON type, call count or order. It preserves exact sampled bytes for
equivalent reordered objects, checks real disk-map serialization/restoration,
large integers, malformed/ambiguous JSON, replay bounds, and rejects unrelated
content/reasoning in cached blocks. Deterministic barriers exercise overlapping
preparations, stale/evicted mappings and allocation/text work outside the cache
mutex. The same corpus passes 22/93 on the preceding server and 93/93 after
the repair; failed receipts remain. No model or actual tool is run by this gate.
Legacy multi-call disk records lack positional identity and must fall back to
rendering incoming calls. New v2 disk records retain the full group and ID
positions. This remains a required stage of the full Metal patch gate.

`make test-q36-tool-map Q36_SOURCE=/path/to/patched/q36` executes 84 native
ASan/UBSan cases: real file round-trips after freeing the original RAM cache,
call order, 247 byte-truncation positions, invalid/duplicate identities,
current-RAM precedence, allocation failures, bounded index chains/eviction and
atomic existing-file replacement. Allocation barriers exercise overlapping
duplicate insertion, stale rebind and absent/present/absent identity races;
a colliding-key fixture checks actual sampled bytes. Deterministic blocked writes verify that
`tool_mu` remains available, changed mappings/destinations cannot publish and
all task-owned temporary files are removed. The 36-case original disk corpus
fails 19 cases on the preceding revision. Use the harness without `--v2` to run
that common corpus; `--v2` adds the new native snapshot/replacement entry points.
No model or actual tool runs in either form. The outer batched `kv_mu` disk
catalog path and its enclosing `inference_mu` are separate and remain unqualified.

The isolated next-revision candidate uses tool-map version 3 for sampled
empty-reasoning metadata. Run
`node tests/integration/q36_tool_map_test.mjs /path/to/q36 --v3` for all 97
native cases, including different preludes on IDs sharing sampled text,
disk-only replay, v1/v2 legacy byte fixtures, unknown flags and a stale-write
race in which only the prelude changes. Legacy maps do not invent metadata
they never stored. This does not promote the candidate or qualify model output.

`make test-q36-tool-schema Q36_SOURCE=/path/to/patched/q36` executes the native
schema parser, tool decoder, API serializers and incremental SSE with ASan/UBSan.
Its 22 generated-byte fixtures include the actual failing Cowork spreadsheet
call, literal JSON-looking strings, Unicode/whitespace, true non-string values,
mixed consecutive tools and nested schemas. Each is delivered in 1-, 7- and
8,192-byte fragments: 66 cases. Assertions compare typed arguments in OpenAI,
Responses and Anthropic output and reassemble the actual SSE argument bytes.
Every case also writes/loads native tool maps and verifies exact single/batched
RAM/disk replay, while changed arguments must miss without losing incoming data.
The report records request/property/stream sizes. This is neither real inference
nor a model-quality benchmark; the original 24/48 failure receipt is retained.
For the preceding source, the harness-only `--legacy-parser-api` option adapts
the old function signatures without changing the semantic assertions.

The HTTP text-preparation byte-budget oracle reads the actual produced map:
v1 repeats text per ID, whereas v2 stores one group plus ordinal/ID records.
Both versions retain the exact one-byte-too-small budget rejection and no-write
assertions. The former RAM-size comparison's failing receipt is retained;
it was not a valid format-independent disk-budget oracle.

The existing `q36_http_control_profile.c` accepts `--tool-replay` to measure the
production cache-reader path with 1/16/256 KiB arguments, one actual cache entry,
128/100,000 configured ID ceilings and 128 repetitions. It reports layout,
total time, instrumented lock wait/hold, and time outside those observed locks.
That last value includes harness/clock overhead, not just JSON comparison.
It is a model-free uncontended microprofile, not an inference throughput or
concurrent-service latency claim. Public benchmark charts remain subject to
Matplotlib, reviewed data and GitHub publication requirements.

`--tool-store` on the same opt-in profile measures native ID rebindings and
actual temporary-file writes separately, using identical payloads before and
after the disk-map change. It records layout, active entries, actual disk bytes,
total time and lock wait/hold distributions. The new path has shorter bounded
tool-lock holds but higher total preparation time in this microprofile; do not
report it as a decoding speedup. Neither profile instruments production code.

`make test-q36-cancel-admission Q36_SOURCE=/path/to/patched/q36` runs 24 native
admission scenarios with ASan/UBSan and initialized bounded state. It verifies
pre-cancelled reset, prefix append and cache hit, invalid requests and an allowed
unchanged-prompt request. CPU buffers are real; the GPU fixtures do not execute
GPU code. The Metal runtime patch gate includes this suite; actual Metal state
is exercised separately by the full-model test above.

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
available. See [upstream admission](../docs/ENGINE_UPSTREAM_ALIGNMENT.md) for
checkouts, platform scopes, evidence format and limitations. A checker-fixture
PASS is never an engine, inference or multi-platform qualification PASS.

`make test-backend-link` executes GNU Make with each of the four local upstream
Makefiles and compares native versus Agent/Chat-PLD/Design linker invocations
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
quality. See [behavior, limits and branch evidence](../docs/GOALS_AND_STEERING.md).

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
popover anchoring, exact model-to-engine selection, keyboard/search behavior,
and the visible geometry and hit targets of **all** composer controls, including
Send and the readable reasoning level. It waits for the real sidebar transition
instead of disabling animations. Each attempt keeps a separate receipt and
screenshots; failures also capture the visible page. These layout checks do not
claim that a simulated engine generated a correct answer.

## Focused gates and measured results

Image presets: `make test-image-pipeline` executes the production coordinator
and shell with explicitly simulated pixels. `make test-image-runtime` compares
all four presets, seven aspect ratios and every CFG step to the installed
official Ideogram/Comfy scheduler, including progress and the unchanged MAX
default; it does not generate images. `make test-http-lan` checks native HTTP
dispatch and rejects invalid presets. The Settings browser test runs in Chromium
and WebKit; the video browser and native Design interrupt tests check that the
saved preset reaches image requests without changing editing or video profiles.

The opt-in [Hermes-inspired live benchmark](live/image_preset_benchmark.py)
starts the actual installed Ideogram worker sequentially, with real weights.
It retains per-image captions, hashes, parameters, progress, failures and
wall time including model startup/shutdown. PNG sanity checks are separate from
visual prompt-adherence review. Public charts use Matplotlib; see
[image preset results](../extension/benchmarks/image-presets/README.md).

Current main compatibility, native Metal fixtures and empty-directory setup:
[September 7 update](../docs/DS4_MAIN_UPDATE_2026-09-07.md).
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
[`ds4-qwen38-prepare`](../patch/ds4-qwen38-prepare/README.md) adaptation and
rebuilt core objects. The harness does not patch the supplied checkout or
reinterpret a missing API as a passing test.

Historical main engine update and real DeepSeek/GLM prefill/decode comparison:
[September 5 update](../docs/DS4_MAIN_UPDATE_2026-09-05.md).
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
[patch notes](../patch/ds4-server-metrics/README.md).

`make test-search-evidence` executes query-aware page excerpt selection and
the actual evidence-extraction request path with simulated model replies. It
checks late-page/Unicode evidence, fixed input bounds and cancellation without
publishing stale facts or issuing another call. Its loopback HTTP test verifies
real request closure and independent deadlines. It is not an LLM quality test;
live research and competitor work is tracked in
[the quality plan](../docs/SEARCH_AGENT_QUALITY_PLAN.md).

The [real page-evidence comparison](../extension/search/bench/README.md) runs
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
[README results](../README.md#latest-measured-results) for their distinct scopes.

| Directory | Executes | Does not prove |
| --- | --- | --- |
| `unit/` | Production functions with controlled inputs and checked outputs | A model answered correctly |
| `browser/` | Real browser interactions, usually with simulated engine responses | Real model inference or real downloads |
| `integration/` | Tools, files, subprocesses, HTTP, build lifecycle | Model quality unless real weights are explicitly loaded |
| `live/` | Explicit network, hardware and/or real-model runs | All models, platforms or workloads are correct |
| `support/`, `fixtures/` | Shared harnesses and controlled input data | Independent test results |

## Clean installation and real inference

```sh
make test-setup-live                  # Real GitHub downloads + builds: main, Laguna, Qwen3.8, Qwen3.6
make test-first-launch-e2e            # Headless .app + real WebKit UI + fresh network engine installation
make test-inference-live              # Real resident Metal: installed DeepSeek + Laguna
make test-inference-live ENGINES=qwen  # Requires downloaded Qwen base + PLE
make test-engine-acceptance           # Fresh builds AND real inference for all four engines
make test-qwen-chat-live              # Actual DStudio launch + Chat HTTP proxy, real Qwen
make benchmark-qwen-decode            # Native generation tok/s, three exact-output checks
```

The setup gate calls DStudio's production headless installer, using the same
archive installer and runtime builders as app setup. It starts with no engine
directory, downloads pinned source archives over HTTPS, builds the executables,
executes their help command, and checks that optional engines share the model
store. It does **not** simulate a browser onboarding click. Existing user
checkouts, models, preferences and running processes are not replaced or stopped.

`test-first-launch-e2e` instead relocates the signed `.app`, starts its real
binary from `/` with an empty `DS4UI_DATA_DIR`, and uses headless WebKit to
operate the first-run installation controls. `DS4UI_TEST_MODE` is **not** set.
It clicks Install, chooses the optional models, and checks real setup responses,
pinned revisions, compiled executable startup, automatic checkout selection,
shared model storage and discovery after reload. It also reverses/reapplies six
native main adaptations on a private source copy and requires exact file
preservation. This is not the complete Agent/server-PLD/web patch stack. The
same focused check is `make test-native-patch-roundtrip`; it uses the production
M2 build-hunk selector and metrics integrity checks. An existing engine-port listener (or a test-owned sentinel)
must survive installation and test shutdown.

Only `/api/model/download` is intentionally refused at the browser boundary,
**after** actual optional-engine setup; weights are not downloaded and inference
is not counted as tested by this gate. Model-start attempts are also blocked.
No setup/build/catalog response is simulated. This is headless application/UI
coverage, not Finder double-click, native title-bar, or native file-picker QA.
Evidence and screenshots are retained in `tests/.artifacts/first-launch-*/`.

To follow a successful setup with real loading of every supported installed GGUF:

```sh
node tests/live/installed_models_e2e.mjs tests/.artifacts/first-launch-<successful-run> ds4/gguf
```

This heavyweight gate requires the existing inference engine to be stopped
explicitly. It uses the freshly built runtimes and links their empty task-owned
GGUF directory to existing weights, without copying or moving them. Models are
loaded **one at a time**, with 8k context, DSpark off, resident Qwen/Laguna and
SSD expert streaming for main DeepSeek/GLM models. Qwen3.8 keeps its native SSD
PLE. Each model must become ready, return exact arithmetic and JSON extraction
answers through DStudio, then answer a checked prompt through the real Chat UI,
including completed SSE and visible rendered text. No response is mocked.
Auxiliary GGUFs and unsupported models are listed separately; missing weights,
timeouts, truncated answers and failed checks are not passes. This does not
qualify all quantizations, maximum context, vision, Agent or Cowork behavior.

The inference gate starts a real `ds4-server`, waits for its live model catalog,
and checks arithmetic, structured extraction, ordering, Unicode, multi-turn
recall, longer-context lookup, code reasoning, malformed-request recovery and
actual SSE completion. Expected answers are independently checked, not supplied
by a model judge. Missing weights, a failed build, truncation and wrong answers
fail the run. No nonempty-answer-only pass criteria.
The tool check requires a real model-generated function call and correct use of
a controlled tool result; it does not claim autonomous execution of an Agent.

The Qwen Chat gate uses an isolated DStudio data directory, invokes the actual
launch API, rejects reuse of an unrelated engine, and sends the same checked
tasks through DStudio's Chat proxy. It does not simulate a browser click.

Each unique run retains requests, responses, failures, exact install receipts,
binary SHA-256, model path/size/mtime, load time and response time under
`tests/.artifacts/engine-acceptance/`. No model content is committed. Timings
describe this run, not a universal speed benchmark. The acceptance checks are
not full-logit comparisons against BF16/CPU, and do not establish general model
quality, tool-use quality, CUDA parity or exhaustive context-boundary correctness.

Qwen3.8 has experimental **Chat, Agent and Cowork** integration on macOS Metal
with the new engine pin. Its Design adapter is not implemented. Qwen3.6 now has
an experimental **Agent/Cowork host integration**, in
addition to Chat. Design and forced expert SSD streaming remain rejected
before stopping the current runtime. Only Qwen3.8 needs the SSD-backed PLE file. Qwen3.6 uses the
31.8 GB Q6_K_XL file, without PLE or expert SSD streaming. Its disk KV checkpoint
path is disabled until the fork can serialize its complete recurrent state.

For a fresh Qwen3.6 source/build check (including its primary-store dependency):

```sh
node tests/live/engine_acceptance.mjs --setup --engines main,qwen35
make test-engine-setup-unit test-qwen35-download
# Use the empty-model fresh-install path printed by the setup run:
node tests/integration/qwen35_setup_http_test.mjs path/from-setup-output/fresh-install
# Explicit, heavyweight; requires installed Qwen3.6 weights:
node tests/live/engine_acceptance.mjs --infer --engines qwen35 --via-app
```

The setup gate downloads into an empty private installation and now executes
both Qwen structured runtimes as well as the native binaries. The HTTP gate
also repeats the real CLI installation, runs Agent/Cowork `--help`, verifies
source and binary preservation, checks the declared capability and requires
the shared weights directory to remain empty. It does not run inference.
The updated fresh and repeated Qwen3.6 installation gates passed on September 7.
Qwen3.8 throughput and answer results must not be attributed to Qwen3.6.

The September 7 quality campaign added a native Qwen3.6 inference baseline:
11/12 development answer/protocol checks passed; its Python filtering answer
was incorrect (`22` instead of independently executed `16`). The original
private receipt is `engine-acceptance/run-m8zF5Z/`; this is not held-out quality
qualification. The same run revealed incorrect DeepSeek aliases in the native
model catalog, a separate defect now addressed by
[`ds4-qwen35-catalog`](../patch/ds4-qwen35-catalog/README.md). Fresh and repeated
Qwen3.6 setup apply the patch before building. Existing checkouts are not
silently rewritten at every Chat launch; run engine setup to upgrade them.

`make test-qwen35-catalog QWEN35_DIR=/path/to/source` copies the native server
source, tests the reversible patch lifecycle and compiles its actual HTTP
catalog serializer. Metadata is controlled and no weights are loaded. Real
Qwen acceptance separately verifies that `/v1/models` names Qwen correctly;
that metadata check does not replace or alter the answer checks.

## Local regression suite

### Vision encoder with SSD streaming (real Metal)

```sh
make test-vision-streaming-live
# Optional existing source/encoder locations:
make test-vision-streaming-live VISION_DS4_DIR=/path/to/ds4 VISION_ENCODER=/path/to/encoder.gguf
```

This explicit, bounded regression clones the pinned local Git source into an
ignored test directory and maps only the installed 933 MB DeepSeek Vision-Exp
encoder. It does not launch a language model, restart the app or touch downloads.
Real Metal kernels encode a synthetic image and route text/image token IDs before
and after three alternating language-weight span replacements. The unpatched
build must reproduce six mapping failures; the patched build must preserve the
exact encoder and routing outputs on all six checks. Baseline output hashes must
also match between the separate unpatched/patched builds. Patch apply/restore is
checked twice, with exact tracked-source restoration.

Logs, engine revision and the run receipt remain under
`tests/.artifacts/vision-stream-*/`. Missing hardware/weights or a failure is not
counted as a pass. This verifies the reproduced memory-mapping regression, not
full PDF comprehension, end-to-end LLM inference or BF16 reference equivalence.
The native fix takes effect only when a rebuilt engine is started; this test
cannot update an already-running process.

### Small SSD prefill batches (real Metal, 128k context)

```sh
make test-ssd-prefill-batch-live
# Optional existing checkout (default installed Vision-Exp weights under gguf/):
make test-ssd-prefill-batch-live SSD_TEST_DS4_DIR=/path/to/ds4
# Or specify existing GGUF and encoder explicitly:
node tests/live/ssd_prefill_batch_test.mjs /path/to/ds4 /path/to/model.gguf /path/to/encoder.gguf
```

This sequential test reproduces the DStudio GLM/M2 port's DeepSeek regression:
the old port rejects a batch with more than eight distinct experts, although
each token selects only six. It builds clean, task-owned engine sources and
checks that the production migration fixes both the real Metal kernel and the
real first transformer layer. Nothing restarts the app, copies/downloads weights
or changes user preferences. Each layer process has a 60-second deadline and
loads layer 0 only, with 131072 context, SSD on and a 256-expert cache (about
4.17 GiB planned GPU allocation on the tested Flash model).

- Four synthetic GPU batches check every result against an **exact CPU oracle**:
  12, 30 and 384 distinct experts, plus GLM's eight experts per token. Invalid
  per-token counts 0/9 and resource count 385 remain rejected.
- Six real-weight cases (1, 2, 139, 760, 761 and 1024 tokens) check **every output
  float bit-for-bit against upstream without the GLM/M2 port**. This covers the
  reported 139-token failure and both sides of the selected-address boundary.
- The legacy binaries must reproduce the specific kernel/layer failures; a
  timeout or missing dependency cannot satisfy the negative test. Existing
  GLM top-8/cache numerical tests run as well.

Logs, patch/engine identity, raw layer outputs and hashes are retained in
ignored `tests/.artifacts/ssd-prefill-*/`. This is a numerical layer regression,
**not** full-model inference, PDF comprehension, a 128k-token input test, BF16
equivalence or a speed benchmark. The context allocation is 128k; each tested
input contains at most 1024 tokens.

`make test-glm53-m2max-patch` also exercises fresh apply/restore and installed
legacy migration, with dry checks, partial-state refusal and unrelated-edit
preservation. Native readiness and the PLD builder tests verify that Metal-only
source changes invalidate old binaries. Frontend behavior tests verify that a
generic prefill failure is no longer mislabeled as an out-of-memory diagnosis.

### Model-free checks

For an explicit real-embedding benchmark of every PDF in a supplied directory,
see [PDF library benchmark](../docs/PDF_LIBRARY_BENCHMARK.md). It retains private
source-grounded questions, per-file cold/warm times, retrieval/evidence failures
and matplotlib charts in ignored artifacts. This tests retrieval, not answers
from a generative model.

For complete PDF reading, run `make test-pdf-complete` (Poppler and Playwright
WebKit required). This executes the native reader on actual PDF fixtures and
compares all text, page by page, to independent Poppler extraction. It covers
uneven page lengths, warm/changed inputs, sparse/scanned/oversized fallbacks,
native images, mixed attachment preparation and full Chat upload with actual
source highlights. Only the browser's engine response is simulated; no model
is loaded. Reports/screenshots are kept in ignored `tests/.artifacts/pdf-complete-*`.
See [the reading design and limits](../docs/PDF_READING.md).

For PDF evidence, run `make test-pdf-evidence`, also with
`DSTUDIO_TEST_BROWSER=webkit`. This uses real synthetic PDFs, the native HTTP
endpoint and Poppler to verify passage matching, render geometry and clickable
links. Repeated labels retain all distinct passages in a modal chooser; no
unattached source or ambiguous calculation is silently accepted. Choosing a
different page aborts the old request and a delayed reply cannot replace the
current image/highlights. Invalid/truncated metadata is hidden with an honest
warning. The full-app attachment browser test separately verifies streaming and
chat reload with repeated labels (simulated model answer, no inference).
The evidence suite also exercises collapsed source cards, keyboard expansion,
direct quotation-to-page navigation and narrow-screen wrapping in both themes;
the original quotation bytes still reach Poppler unchanged. Screenshots are in
`tests/.artifacts/pdf-evidence/`.

Run `node tests/browser/ui_model_picker_playwright_test.mjs` (also with
`DSTUDIO_TEST_BROWSER=webkit`) for the composer picker. This uses a simulated
launcher, not model inference. It checks the popup's actual distance from the
model button with a multiline draft, viewport bounds, keyboard/search behavior,
outside-click dismissal and light/dark layouts.

`make check-fast` runs local functional/browser/integration tests without a
large language model. `make test-cowork`, `make test-frontend-unit`,
`make test-pdf-evidence` and `make test-pld` select narrower suites. Stateful test
doubles remain useful for failure/recovery coverage but are labeled as such.
`make test-video-open-weight` is separate: it compiles and runs a small real
Metal attention-equivalence probe and requires the installed H3 checkout.

Settings and model-switch regressions can also run in WebKit (the browser engine
used by the macOS app):

```sh
node tests/browser/ui_settings_redesign_playwright_test.mjs
DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_settings_redesign_playwright_test.mjs
```

Both require the corresponding Playwright browser installed. They click Done
with invalid fields in hidden panes and exercise Qwen/DeepSeek/GLM selection,
SSD preferences, cancellation, duplicate clicks, delayed preparation, stale
readiness, progress and launch errors. Background download progress and paused
state remain in Settings while the composer retains the model name, including
after a reload; these display-only interactions must issue no engine/download
mutations. Filtering/refreshing the model list also preserves the selected
download target; the confirmed request must name that exact model, not the first
option in the refreshed list. Loading visibility is hit-tested in the browser. The launcher
responses are simulated; no weights are loaded and these
tests do not measure inference. Screenshots go under `tests/.artifacts/`.

The composer model picker has its own browser regression:

```sh
node tests/browser/ui_model_picker_playwright_test.mjs
DSTUDIO_TEST_BROWSER=webkit node tests/browser/ui_model_picker_playwright_test.mjs
```

It searches installed models by name/quantization, excludes manual engine-branch
choices and support files, checks keyboard navigation and viewport fit in both
themes, and verifies that selecting Qwen chooses its matching engine before
launching. Catalog delays/errors and background download polling must preserve
search input and focus. The launcher is simulated; this is not real inference.
Screenshots and the request receipt go under `tests/.artifacts/model-picker/`.

The old source-pattern contract files were removed. Their useful parser, LAN,
Markdown and browser checks were retained as behavioral tests. Build-failure
injection tests cover cleanup and source preservation, not compiler correctness;
real first-run builds provide that separate evidence.

Original Design packs and native agent quality have separate checks:
`make test-design-originals` exercises the actual catalog and rendered components;
`tests/live/design_originals_comparison.mjs` launches the real native agent.
`make test-design-generation-process` tests its process/capture path with real
subprocesses and **simulated native protocol**, without a model. Unicode and
multiline input survive chunk boundaries, both output pipes drain before
artifact acceptance, and malformed/incomplete JSON cannot become a PASS. The
test also exercises cancellation, original deadlines, owned-group cleanup,
failed log admission and a real OS-limited file write failure. Existing output
is never replaced. Raw log prefixes, exact received/persisted counts and failures
remain available when capture fails. Each real case admits at most 128 MiB of
stdout, 32 MiB of stderr, a 2 MiB line and 16,384 events / 16 MiB of structured
events. One write per pipe is in flight; a slow disk applies backpressure, not an
unbounded memory queue. These are explicit benchmark resource limits, not
claims about native tool maxima. Startup/turn deadlines remain 15/30 minutes;
overrides may shorten them, not hide failures by extending them. Generation
latency ends at idle; teardown and total capture time are recorded separately.
`tests/support/design_comparison_audit.mjs` operates completed generated pages;
`tests/support/design_comparison_report.mjs` summarizes two full audits, retaining
failures and rejecting mismatched models, prompts, settings or audit revisions.
The eighteen-pack auditor under development is
`tests/support/design_project_audit.mjs`, with separate task-specific browser
scenarios and immutable, bounded export snapshots. Run
`make test-design-project-auditor` for **authored grader fixtures**, not model
quality: the shared pipeline, editorial search/dialog, reading-list notes,
repair-queue and incident assignment/resolution scenarios run in
Chromium/WebKit, both appearances, local files, an opaque iframe and enlarged
text (the enlarged-text/file matrix currently qualifies the shared editorial
pipeline; the new domain oracles cover both browsers, themes and opaque frames).
Broken Clear, repeated essay/dialog content, shared or HTML-interpreted notes,
stale rows/counters, shared assignees, auto-applied drafts, incomplete or
out-of-order history, wrong item details, broken Retry, misaligned radios, symlink escape
and incomplete provenance must fail. A forged successful-delivery flag with
incomplete native capture is rejected; unstarted projects remain NOT RUN in the
18-case denominator. The remaining fourteen scenario oracles and native
eighteen-project generation are not yet qualified; see
[Design systems](../docs/DESIGN_SYSTEMS.md). No manual benchmark HTML repair.

`make test-design-project-resources` exercises actual Chromium/WebKit error
events on explicitly authored defective pages. Errors arriving during teardown
remain failures. Per view, retained browser problems are bounded to 64 entries,
64 KiB of serialized entries and 4 KiB per text detail (without splitting
Unicode). Any exceeded bound closes that view and fails it, retaining the prefix
and explicit overload reason; it never becomes a truncated success. Console,
script, opaque-frame and blocked-network floods are covered, and a separate
browser context remains usable. These are retained-evidence bounds, not a hard
RSS limit on the browser's internal event transport. Dialog checks await actual
closure within the existing three-second action budget; a dialog that permanently
prevents Escape still fails. None of these fixture tests measures LLM quality.

`make test-design-comparison-report` tests this accounting with synthetic
receipts; it is not an inference or aesthetic-quality test.
`node tests/live/design_generation_limit_test.mjs` explicitly loads real DS4
weights and deliberately limits each round to one token. It checks three bounded
continuations, an honest incomplete status, return to the input loop and prior
file preservation. This is runtime fault injection, not a useful-answer or model
quality test. Run it sequentially after other model tests. An optional captured
comparison directory selects its frozen executable/source to reproduce the old
failure; that failing receipt is retained rather than counted as passing.
`make test-design-tool-recovery` executes the native loop with deliberately
truncated simulated model frames and verifies exact file preservation/retry
results. `make test-design-archive-build` compiles a real local source archive
without engine Git metadata and checks rebuilds after source changes. Neither
test loads a model; the archive test does not download its fixture.
`make test-design-build-freshness` executes the production native builder and
script with an explicitly simulated compiler: 17 cases cover failed/incomplete
links, byte-bound freshness, compiler flags, untracked GPU/header changes,
complete/partial patches, concurrent Agent/Chat builds, parent/group death,
stale source rejection, directory replacement and symlink confinement. Failed
and successful receipts are retained under `tests/.artifacts/design-build/`.
The native archive gate supplies the separate real compilation/startup proof.

Design now builds in a private source/object snapshot under the checkout's
native build lease. It does not patch the original checkout or reuse its shared
objects. Only the native owner publishes the prepared executable; a surviving
compiler cannot publish after that owner dies. The derived stamp includes source,
support and selected Make/compiler configuration digests plus the executable's
digest. A crash between executable and stamp replacement is not a fresh build.
Compiler/linker program bytes, resolved Apple tools and SDK identity are part of
the configuration receipt. If a custom command cannot be resolved, it remains
buildable but is not eligible for cached reuse. One focused case uses real Make
and the real compiler metadata to change a wrapper without changing its version.
For a direct developer build use `./dstudio --build-design ENGINE_DIR`; the shell
entry point accepts `DSTUDIO_BUILD_HOST` for an explicit current host binary.
Snapshots admit at most 4,096 source files, 32 MiB per file and 128 MiB of source;
cleanup is descriptor-anchored and bounded. Eight retained interrupted snapshots
block another build for inspection, rather than authorizing deletion by name.
Windows' prebuilt-runtime path is separate and is not qualified by these macOS
tests. Full cross-backend/toolchain qualification remains a separate gate.
To limit the existing native build/tool gate to the changed Design path, use
`DSTUDIO_NATIVE_DESIGN_ONLY=1 node tests/integration/agent_native_build_test.mjs
MAIN_DIR LAGUNA_DIR QWEN38_DIR`; add `DSTUDIO_AGENT_BUILD_BACKEND=cpu` for CPU.
Each supplied checkout is copied into an isolated source fixture; weights are
not copied or loaded. Runtime tool frames are simulated in this gate.
See [Design systems and regression coverage](../docs/DESIGN_SYSTEMS.md).
Successful previews and prompt-string checks are not counted as model quality.

Actual-product comparison helpers live under `tests/support/product_*`;
`tests/live/product_quality_pilot.mjs --run` requires the pinned OpenWork and
OpenDesign checkouts and their installed runtime tools. It starts the actual
servers, not a generic standalone OpenCode task, and routes their inference to
one shared local model. Run it sequentially. Independent code/document and
Chromium workflow audits reopen the saved outputs. The artifact-serving and
semantic grader regressions are model-free:

```sh
node tests/unit/product_artifact_server_test.mjs
node tests/unit/product_design_grader_test.mjs
```

`make test-search-evidence` also covers whole-loop work budgets and actual HTTP
stream cancellation. Its model/page responses are simulated. In contrast,
`node tests/live/research_pipeline_benchmark.mjs --run` loads real weights and
executes full Search/Research against public websites, including the final
answer. Each invocation creates a fresh ignored receipt directory and preserves
failures. Review every answer against the fixed primary-source expectations
before publishing a quality score; completion and citations alone are not a pass.

Focused regressions exercise URL-heavy page excerpts, overlapping windows,
Unicode offsets, preserved original language/length constraints, evidence-ID
selection and cancellation during synthesis. They run production functions
with synthetic source/model data, not real-model quality measurements.
`research_answer_review_test.mjs` exercises omitted counter-evidence, bounded
writer/reviewer corrections, actual word counts (including exclusive bounds),
malformed/unknown review IDs, transport failure and cancellation. Additional
regressions preserve valid multi-envelope JSON comparisons and correct an
invented evidence gap without deleting the general rule that answers it.
The distinct
`research_reply_delivery_test.mjs` executes the production assistant-reply
lifecycle: exact reviewed text reaches the rendered and persisted message,
failed review stays incomplete, and ordinary Chat/Search still stream normally.
These are simulated model/UI dependencies, not a desktop WebKit E2E run.

For a new measured replay, `--before COMMIT` records the intended historical
runtime; `--variants after` keeps all four questions without re-running that
historical version. The live runner follows each runtime's actual final-answer
handoff, including direct delivery of reviewed reports in the new version.
Independent answer review remains mandatory; the model review is not the grader.

The complete [pipeline report](../extension/search/bench/PIPELINE.md) separates
live answer reviews from those deterministic checks. Its publisher requires
every question and a review bound to each unchanged raw row. After review,
`node tests/support/check_research_quality.mjs REFERENCE_JSON CURRENT_JSON`
rejects any lost previously demonstrated requirement, even if the aggregate
score or latency improves. The current receipt must contain all four after
cases; a partial retry cannot satisfy this gate.

`make test-product-comparison-publication` also runs a real headless Chromium
layout regression on the untouched published website. It detects wrapped radio
labels entering the indicator column at 390/1440 px, tests an independent good
layout, and verifies the original artifact hash. A passing regression detector
does not mean the archived design passed: its visual defects remain visible.
The same target now checks the untouched DS4-regenerated artifact in Chromium
and WebKit, with five radio choices and the complete journey at four widths.
It is a model-free regression of saved output, not a new inference run.

`make test-design-self` also reproduces the radio defect through the production
`verify_artifact` geometry gate and `inspect_layout`, then verifies a CSS-only
repair at 1280/768/390 px. That synthetic fixture is a regression test, not a
replacement for a model-generated benchmark artifact.

To regenerate the workshop from an empty workspace using the real Design
runtime and local DS4 weights, without rerunning unrelated competitors:

```sh
node tests/live/product_quality_pilot.mjs --run --products dstudio --cases design-workshop-journey
node tests/support/product_design_browser_audit.mjs PATH_TO_RESULTS_JSON --browser chromium
node tests/support/product_design_browser_audit.mjs PATH_TO_RESULTS_JSON --browser webkit
```

This is a development replay of the same brief, not a new head-to-head ranking.
The browser audits operate the unchanged generated HTML, including native radio
keyboard selection when present and both workshop/day label geometry. Preserve
the original failed artifact and every unsuccessful replay; never hand-edit
generated HTML or substitute a manually corrected screenshot.

See the [real-run report](../docs/ENGINE_ACCEPTANCE.md) for actual failures as well
as successes. Qwen native generation throughput is reported separately from
DStudio Chat latency and from the small cross-engine acceptance battery.
