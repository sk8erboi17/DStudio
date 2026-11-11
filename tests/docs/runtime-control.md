# Runtime transport, Stop, Goals and steering

[All test guides](../README.md). Run commands from the repository root.
Each section retains its original scope, prerequisites, results and limitations;
a historical pass is not a pass on a newer runtime.

## Host relay and model RPC

`make test-v1-relay` executes the production relay with real sockets and
deterministically simulates 601 silent poll intervals. It checks exact fragmented
HTTP/error/binary bytes and a real TCP reset on an abandoned response rather
than an ambiguous FIN. `make test-model-rpc-lifecycle` also exercises the actual
owned local model worker's Stop/reset and reaping. In `make test-roadmap-request`,
`roadmap_request_test.mjs` checks only test-support code: the request helpers of
the live Learn runner (`tests/support/real_harness.mjs` and
`roadmap_generation_settings.mjs`) must send the selected reasoning setting,
including explicit thinking off, to a simulated engine. It does not execute the
app's Learn requests; the target's other files do run the production Learn
phase functions (see the [UI guide](ui.md#complete-simulated-ui-matrix)).
These are model-free regressions, not quality results.

`make test-v1-proxy-exchange` builds and launches the real native host with an
empty task-owned profile and a loopback engine fixture on a reserved ephemeral
port. It checks GET/empty POST, buffered and fragmented large UTF-8 bodies,
exact HTTP/error/SSE/binary response bytes, long request paths, responsive status
while the backend is blocked, and Stop without duplicate effects or poisoning
the next call. It retains the host relay's existing EOF-as-cancellation policy;
request half-close is not supported here. The long-path test first failed with
bytes sent beyond the old header buffer, then passed with the bounded shared
exchange. Since November 11, 2026 it also covers an engine port where
nothing listens, as beside an Agent, Cowork or Design session: `/api/status`
must answer within one second while the relay retries, and the request then
gets the same 503. Before, those retries (25 × 100 ms) slept on the host's
control loop and status waited about 2.4 s behind them (measured on the
previous host: 2,394 ms); they now run in the forked relay after one
non-blocking attempt. An engine that starts listening during the retries is
still reached, once. Logs and receipts stay in `tests/.artifacts/v1-proxy-exchange/`.
It starts no model, uses no weights, and does not contact or signal a user's
engine. The executed platform is macOS; Windows execution remains not run.

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

To rebuild only unified main, run `node tests/integration/agent_native_build_test.mjs ds4`.

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
shared stream/consumer scenarios (62 on November 11, 2026; each run prints its
total) use a simulated model, deliberately fragmented bytes,
actual outgoing request bodies and replays of the resulting runtime frames.
They cover Unicode, interleaved tool IDs, exact argument preservation, duplicates,
invalid/oversized inputs, incomplete endings and errors. A tool batch is not
published before successful completion. These are transport tests, not LLM
quality or proof that the structured dispatcher is integrated into every mode.

The stream gate repeats the shared corpus through native request-envelope
admission and the actual exec'd host worker
over HTTP and HTTPS, with two additional held-connection cases on each path:
Stop and death of the owning host (**two more than the shared corpus on each
owner-relay path**: 64 on that date). HTTPS
requires `curl` and `openssl`; it creates an isolated certificate and passes its
CA to the test child, without disabling TLS verification. Worker/process-group
exit, closed peer sockets and absence of named credential/body staging files
are checked. The owner-only relay has one active worker, at most one pending
request while cancellation is reaped, a 16 MiB body limit and 16 KiB delivery
staging. Inference has no automatic elapsed-work deadline; Stop, owner death,
actual transport failure and blocked terminal delivery remain separate. It does
not retry a failed action.
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

The seven lifecycle scenarios (the runner requires exactly seven passes) force
exact OS descriptor reuse, 200 rejected
duplicate admissions, credential changes after admission, a stopped helper
requiring escalation, a full runtime pipe, worker death, actual connection failure,
oversized body, a request queued before Stop and a local Stop that resets the
owned inference socket and reaps only the request worker. The HTTP Stop handler must
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
`make test-agent-patch-migration` runs the native transformer on the two pinned
source bases of `patch/ds4-agent-jsonl/bases.json` (main and Laguna) with
independent Git apply/reversal, unrelated edits, CRLF input and
repeat/partial/drift rejection. Each base first reverses its recorded deltas,
newest first, each to its frozen predecessor hash: the two Cowork deltas on
main, and on Laguna those two, then progress summary, durable summary, worker
readiness, compaction continuation and the publication delta. Laguna alone
retains frozen legacy output parity, after the separately recorded renderer and
remote-tool-stop corrections are reversed solely for the historical oracle. The
main variant has no fictitious legacy oracle. It requires local source
objects or exact base files. It does not perform a network install.
This guide earlier described seven bases with an older MoE variant; since
October 27, 2026 the migration tests cover only the bundled main and Laguna
(see the [test cleanup](installation.md#test-cleanup-october-25-2026)).

`make test-agent-compaction AGENT_LAGUNA_TREE=ENGINE_LAGUNA` requires the
already-built native Laguna core. The test accepts `--family laguna` only: the
Qwen MoE branch ran on the retired `ds4-qwen35` fork, and its results below are
history.
It executes actual compaction and control calls with deterministic session and
tokenization fixtures under ASan/UBSan. Fourteen cases check original
transcript and memory preservation during blocked preparation, failed summaries,
failed rebuilds, cancellation/late Stop, stale identities, one owner-only
publication, successful export, and an honestly reported export failure.
Twenty- and 200-ms barrier holds demonstrate control access during preparation;
probe-only timings distinguish preparation, control, lock wait/hold and actual
publication. A zero sub-microsecond reading means below timer resolution, not
zero work. These are diagnostic fixture observations, not an inference speed
benchmark or percentile study.

With both branches at the time, the shipped v98 patches passed **28/28**
(`run-KKPyWK`, `run-wGTgjx`); original
v97 code passed **4/14 per branch** on the identical final harness
(`run-XvWWAk`, `run-ZQ7QxN`). Earlier 12-case failures and the initial missing
piped-mode warning are also retained under ignored `agent-compaction/`.
`--source /path/to/frozen-derived-agent.c` runs that exact before/after input
without mutating supplied engines. Add `--helper FROZEN_COMPACTION_TEXT_HEADER`
when that source predates the current private helper API; the runner captures
and compiles the exact historical helper in its own directory. No models are
loaded. Real-model continuation
quality, multimodal state and other backends are separate gates.

`make test-agent-continuation` adds native GGUF tokenizer and generation-loop
regressions on the production patch output, for Laguna only. Override
`COMPACTION_LAGUNA_MODEL` for the installed GGUF
location. The native core reads vocabulary/metadata only: **no weight tensors,
GPU inference or model-quality evaluation**. ASan/UBSan covers 50 Laguna
framing checks, preserving the exact original tail token IDs across
BPE/ChatML/tool/think boundaries. A scripted 18,000-token response crosses three
compactions and must render identically to the non-compacted reference without
renewing its output budget. Eighteen Laguna loop checks (sixteen before the two
v102 runtime-state checks) also
cover native speculative orchestration, where supported, oversize admission,
repeated memory export, Stop/failure and a partial tool followed by a complete
retry that writes the actual file exactly once. The v100 addition latches Stop
across the admission-to-dispatch gap; the earlier fifteen/thirteen-case receipts
below remain historical rather than being assigned the new denominator. The
Qwen MoE branch (53 framing and fourteen loop checks at that time) ran on the
retired fork and is no longer runnable; its counts below are history.

November 11, 2026 (macOS, an installed Laguna engine whose receipt names the
bundled pin `448d569`): the target stopped at its
prerequisite `test-agent-continuation-oracle`. One of the three cases of
`agent_continuation_control_test.mjs` still expects a Qwen prefill selection
that `tests/live/agent_continuation_live.mjs` now refuses, so it fails (2/3)
and Make does not reach the probes; `make test-agent-continuation-live` has the
same prerequisite. That case tested a branch removed with the retired Qwen MoE
engines; it was corrected the same day to require what the runner does now
(Laguna selects its native prefill, every other family is refused) and the
prerequisite passes 3/3. Started directly with
`node tests/integration/agent_compaction_test.mjs ENGINE_LAGUNA --family laguna --tokenizer-model GGUF`,
the probes passed 14 publication cases, 50 framing checks and 18 loop checks.

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
CONTINUATION_FAMILY=laguna CONTINUATION_MODEL=MODEL_GGUF` explicitly launches
the binary from a passing native build receipt, with real resident weights,
Metal, 8k context and isolated session/workspace files. Laguna is the only
supported family; the earlier Qwen3.6 family ran on the retired `ds4-qwen35` fork. It never downloads weights, restarts
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
[upstream checkpoint](../../docs/DS41_UPDATE_CHECKPOINT.md).

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

`make test-runtime-patch-migration` does the same for the two web bases (main
and Laguna) and two server inputs (current main without and with native
metrics; no previous main). Only the Laguna web base keeps frozen legacy byte
parity. Exact raw
sources may be supplied in `DSTUDIO_RUNTIME_BASE_SOURCES`, named
`web-main-qwen.c`, `web-laguna.c` and `server-main-latest.c`. A managed
installation has no Git objects and its `ds4_server.c` already carries native
adaptations, so there the server inputs fail as missing unless that directory
is supplied; the bundled `ds4_web.c` and `ds4_server.c` under `src/engines/`
are the exact bases.
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
existing user runtimes are touched. See [patch prerequisites and limits](../../patch/ds4-agent-jsonl/README.md).
The gate also builds Design and executes its real read tool and steering loop.
All three runtime types additionally exercise model-wait Stop and next-turn
tool execution without restarting the process, with model replies simulated.
It runs upstream Agent unit tests and fragmented rendering both with and without
a JSONL worker, under ASan/UBSan for private Agent/helper C objects. Core/GPU
objects remain uninstrumented. Building a runtime alone does not qualify its
application modes.
On macOS, `DSTUDIO_AGENT_BUILD_BACKEND=cpu make test-agent-native-build` selects
a fresh real CPU build; it does not qualify Windows or Linux behavior.

`make test-qwen38-agent QWEN38_AGENT_TREE=PATH_TO_BUILT_CANDIDATE` requires the
already-built unified main source and native core objects (historical fork
inputs remain available for replays). It executes the Qwen
parser, original Agent units, eight prompt combinations, real file writes,
Cowork document readback and rejected workspace escapes. Its model text and
engine identity are fixtures: this is protocol/tool behavior, not inference
quality. ASan/UBSan instrument the private Agent/parser/helper C objects only;
`QWEN38_AGENT_FLAGS=` disables them explicitly. It neither starts a model nor
changes the supplied engine checkout.

`make test-metal-workspace` links a small probe against the already-built native
Metal objects for main and Laguna (Qwen3.8 uses main). It runs from the engine's
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
node tests/live/qwen38_agent_smoke.mjs ENGINE MODEL_GGUF
```

It requires the already-built Qwen candidate's Agent/Cowork and actual weights.
Runs are sequential, with 16k context, a 512-token prefill chunk, 1,024 output
tokens per model round, temperature 0, seed 42, thinking/MTP/DSpark off and at
most 12 tool calls/600 seconds per workflow. No downloads, app restart or
termination of an existing engine are performed. This uses resident backbone
weights plus embedded BF16 n-grams on SSD, without expert streaming. It verifies
exact generated files, source preservation, required document tools and
subsequent readback. The former `--qwen35` variant is rejected: Qwen3.6 now runs
on llama.cpp and is covered by `make test-llama-resident-live`.
The first run's Cowork failure is preserved: its original grader erroneously
forbade extra local reads despite the request permitting them. The corrected
oracle still rejects shell/network, wrong targets, missing writes/results and
missing document readback; the complete two-workflow run was repeated. These
are development checks, not held-out quality, numerical parity or app-mode
qualification. Runtime requests/answers and personal paths stay in ignored
`tests/.artifacts/qwen38-agent-live/` (older Qwen3.6 receipts stay in
`tests/.artifacts/qwen35-agent-live/`).
