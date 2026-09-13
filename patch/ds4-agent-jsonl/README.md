# Agent/Cowork: reproducible native patches

Version 102 contains seven explicit unified patch variants. Version 87 migrated
the three existing Agent adaptations without changing their output; version 88
added the Qwen3.8 candidate and version 89 fixes optional-renderer event handling
in every existing variant. Version 90 adds the Qwen3.6 native-tool candidate
and corrects JSON-document delimiter escaping in both Qwen variants.
Version 91 moves piped Qwen new-session preparation onto the existing worker,
with a private candidate context, cancellation and explicit terminal receipts.
Version 92 uses the [native empty-candidate API](../ds4-qwen38-prepare/README.md)
only for Qwen3.8 reset preparation. It can abandon a partial GPU layer without
changing the previous live conversation or the normal sync checkpoint contract.
The installer and Agent builder apply the required core/header patch first.
Version 93 rebuilds every consumer of the shared first-party remote transport.
Its explicit structured API retains tool IDs and argument bytes until successful
completion; interrupted candidates are discarded. Existing DSML callers reject
unexpected structured calls instead of silently losing them. The host relay now
validates actual choice/delta fields and preserves escaped Unicode. This is a
transport prerequisite, not Qwen27B mode enablement. No upstream Agent patch
bytes changed in version 93; the structured dispatcher described below was
added subsequently. The separately owned resident-server lifecycle still needs
integration.
Version 94 makes the shared model wait consult the owning runtime's interrupt
latch, including silent prefills and incomplete input frames. Already queued
cancelled-model bytes are discarded before WAITING within a fixed nonblocking
drain bound; a late host worker still needs generation fencing. POSIX Stop no
longer writes into the inference-data pipe; Task Graph cancellation and watchdog
use the same existing signal. All Agent/Cowork/Design consumers rebuild for the
explicit cancellation callback. `remote-interrupt-fix.patch` records the exact
first-party fragment delta, including clearing the consumed tool-cancel latch
at admission of the next turn after WAITING. The patch is reversed only for the
frozen version-86 migration oracle; the shipped fragment already contains it.
This does not yet cancel the host's HTTP worker or prove resident-server
teardown under pressure.
Version 95 adds an explicit `DS4UI_REMOTE_TOOL_PROTOCOL=openai` path to the
existing lightweight native Agent/Cowork runtime. The default remains `dsml`;
unknown protocols fail at startup. The model receives actual native function
schemas, and completed tool-call batches are validated before any tool runs.
Arguments retain their original JSON bytes in the transcript and are decoded
once for the existing dispatcher; textual DSML is not converted into actions.
Cowork retains its Office/document tools without arbitrary shell access.

Version 96 adds `main-v41.patch` for upstream `bd66c40`. It retains the new
V4.1 spaced DSML grammar in Agent and Cowork prompts/parsers, upstream's
continuation across compaction, bounded split-delimiter lookahead and model-stop
accounting in the shared PLD loop. Steering waits for a complete message boundary
rather than entering a still-open compacted assistant message. Other variants
retain their existing generation behavior through no-op compile-time hooks.
This adaptation is under verification; its presence is not model qualification.

Version 97 adds `qwen38-next.patch` for `2dda88e`, retaining that fork's upstream
main merge, native Qwen delimiters and reasoning behavior. It shares the bounded
compaction/model-stop hooks without replacing Qwen's inference semantics. The
seven-variant migration gate, native main/Laguna/Qwen Next builds, actual tool
effects with simulated model replies and sanitizer parser checks pass. These
checks do not qualify new model weights, CUDA, ROCm or M5 performance. The same
Agent source/hash applies at the current `ff4f0ff`; native builds also require
the separately tested [snapshot-allocation fix](../ds4-qwen38-snapshot/README.md).

Version 98 fixes compaction publication in Laguna (`448d569`) and the older
Qwen3.6 MoE fork (`60fca11`, same Agent bytes at `73434c4`). The worker keeps
the original transcript while rebuilding derived KV, then revalidates identity
and Stop/shutdown before a bounded pointer publication. Failure invalidates KV
without replacing the previous conversation or `MEMORY.MD`. A successful
compaction marks the session dirty; the best-effort memory export follows the
commit outside its lock, cleans up a failed temporary export and reports that
failure in piped JSONL mode too. This does not change native tokenization,
summary/tail selection or generation limits.

`compaction-publish.patch` records the exact v97-to-v98 delta, already folded
into both full variants. **Do not apply it again in production.** The migration
gate reverses it to recover the frozen v97 hashes before the older v86 oracle,
then checks forward/repeated application and preservation of unrelated files.
`make test-agent-compaction` executes the native function and real control
methods under ASan/UBSan: 14 cases per branch, including late cancellation,
stale identities, failed summary/rebuild, export failure and deliberately
blocked preparation. All 28 pass; the unchanged before-code passes 4/14 per
branch and its failed receipts are retained. Session calculation and tokenization
are explicit fixtures, not real-model quality evidence. Worker layout is
unchanged (2,144 bytes on arm64); opt-in probe measurements record preparation,
control and mutex/publication timing without adding production timers.
Version 99 backports the text-only continuation from upstream `e33a5b2` to
these two branches. A long answer resumes after compaction inside the same
generation loop and renderer, without renewing its output budget or inserting
a synthetic user/tool message into unfinished prose. Incomplete tool calls
are never executed; recovery explicitly asks for a smaller complete call.
Failure or Stop preserves the original partial answer and previous tool effects.

Version 100 fixes readiness and service feedback across all seven variants.
The first real Qwen MoE continuation run passed four of six checks: its 200
generated C functions compiled and executed correctly across compaction, and
file tools recovered the earlier facts and worked after Stop. However, manual
`/compact` announced WAITING before the worker committed, and JSONL mode hid
the native Stop notice. The original failed receipt remains retained; this is
development workflow coverage, not a held-out quality benchmark.

The worker now retains explicit ownership through deferred operations and
cleanup. Pending work and accepted commands prevent readiness, new turns and
reset admission; input allocation happens before the short admission lock.
The Stop latch is cleared at admission, not later at dispatch. The piped
frontend drains final output before WAITING. Bounded `runtime_notice` records
carry service messages separately from model prose; plain non-JSONL piping
keeps its prior clean-output behavior. The browser renders these notices without
showing their JSON or treating them as model answers.

Each `*-readiness.patch` records its exact v99-to-v100 delta; the full variants
already include it. Never apply both in production. The migration gate reverses
the newest delta first, preserving all frozen v99/v98/v97/v86 identities. Native
thread/barrier checks pass 20/20 on Laguna and older Qwen MoE; the same final
probe on v99 passes 8/20. Worker size remains 2,144 bytes on those arm64 builds.
The full v100 native-consumer rerun passes 77/77 stages. Its real-model replay
passes 5/6 on older MoE and 4/6 on Laguna: both control defects are corrected,
but MoE generates invalid C and Laguna loses explicitly remembered values in
the first summary. Post-Stop tools work; Laguna still fails the separate check
for a prior file that was never created. Original failures are retained.

Version 101 revises only the private summary instructions across all seven
variants. Explicit future-use facts take priority even after the current task
changes; exact names/values/units and user corrections must be retained. Earlier
applicable durable facts carry forward, unresolved contradictions stay explicit,
and the internal request must not be reported as user activity. This does not
add a second memory store or guarantee a model will summarize faithfully.
Native and real-model acceptance are separate; see the
[update checkpoint](../../docs/DS41_UPDATE_CHECKPOINT.md).

Each `*-durable-summary.patch` records the exact v100-to-v101 delta already
folded into its full variant. Do not apply it again in production. The seven-base
migration passes apply/repeat rejection/reversal, partial/drift rejection and
unrelated-edit preservation while retaining every frozen predecessor identity.

Version 102 carries the worker's actual open/closed reply state into the private
summary request. A temporarily inserted message closer cannot establish that
the current task finished. The instructions retain current requirements and
reconcile old pending work with later visible answers/tool results; summaries
must be plain text rather than a tool request or a request to save a file.
This is guidance plus runtime evidence, not automatic proof of task completion
or a guarantee of summary fidelity. The runtime does not dispatch summary text.

Each `*-progress-summary.patch` is the exact v101-to-v102 delta already folded
into the full variant; never apply it twice. Main/V4.1 and Qwen Next's inline
reserve calculation, and Laguna/MoE's shared `compaction_text.h`, tokenize both
possible runtime states and reserve the larger request. Their existing framing
and summary-output allowances remain unchanged. No tokenizer, KV implementation,
worker layout or generation budget is replaced. The helper must match the
manifest; historical source tests use their captured historical helper.

Native Laguna/MoE tests now observe the actual generated summary requests and
prove that mid-reply compaction says open, while later manual compaction on the
same worker says closed. Together with byte-identical continuation and the old
checks, 18/18 Laguna and 16/16 MoE loop cases pass (`run-EJUCfG`, `run-Kl7ppp`),
plus 14 publication and 50/53 framing cases. The frozen v101 versions fail just
the two new state checks (`run-tDsUKF`, `run-4iJ6ks`). Inference is scripted in
these sanitizer probes. The complete native-consumer rebuild `run-Ethbt2`
passes 77/77 stages. The real Laguna replay `run-b3xpGT` subsequently passes
6/6 workflows and a separate scoped review of both summaries: 57 functions
correctly marked emitted during the open reply, then all 200 recognized after
completion. Both explicit facts survive; code compiles/executes and real tools
work before/after Stop. This single development run does not establish general
summary fidelity or a causal A/B improvement. The v102 MoE replay and its own
summary review remain pending; original failed receipts are retained.

The shared `compaction_text.h` handles Laguna's ordinary BPE wrappers and Qwen's
ChatML/tool containers using their native encoders. Retained tail token IDs
stay verbatim; summary-only closers never alter that tail. The bounded summary
is a user message, not new system authority. Compaction uses the stable system
prefix rather than importing the just-exported `MEMORY.MD` again: tests exposed
that re-import changing the open-answer boundary on the second compaction.
Startup/reset still load memory through their existing path. Native Laguna
speculation and Qwen's own tool parser remain in place; this does not enable
PLD or vision on an unsupported branch.

`laguna-continuation.patch` and `qwen35-continuation.patch` record each exact
v98-to-v99 delta. They are already folded into the full variants; **do not
apply them again in production**. Migration first reverses v102 reply state,
then v101 summary policy,
then v100 readiness,
then v99 and v98, to check
the unchanged historical oracles and replays the opposite order forwards.
`make test-agent-continuation` uses actual GGUF vocabularies without loading
weight tensors: 50 Laguna / 53 Qwen framing checks, plus 16 / 14 native-loop
checks with scripted inference, pass under ASan/UBSan on v100. The v99 gate
had 15 / 13 loop checks, with only 4/15 and 3/13 on v98; those receipts remain
unchanged. The new check proves Stop arriving before dispatch is not erased.
It covers three compactions in an 18,000-token answer, exact rendered bytes,
thinking transitions, output limits, memory export, Stop and real file effects
from a complete retry. The 14 publication checks per branch remain green.
These are behavioral regressions, **not real-model continuation quality or
CUDA/ROCm qualification**; those acceptance gates remain open.

Each assistant/calls/results group is retained as one transcript block, with
exact call IDs and explicit interrupted, unknown and not-executed outcomes.
Compaction drops whole groups while a bounded session-wide ID ledger prevents
replay of previously admitted actions. Reset retires the ledger; it is not
cross-restart exactly-once persistence. Stop cancels only the foreground shell
job admitted by the interrupted action, preserves earlier effects, and does
not run the remaining batch. Native errors are reported separately from idle
readiness; Task Graph also checks its operation's completion receipt before
publishing success. Transport IDs precede semantic tool fields so they cannot
defeat the existing repeated-action watchdog. Displayed model text cannot emit
native JSONL records through a raw record-separator byte.
Interactive errors leave the process available for the next prompt; one-shot
structured invocations instead exit 1 on failure and 130 on Stop, not 0.

`remote-structured-fix.patch` records the first-party fragment delta from 94.
`remote-tool-stop.patch` records the small worker-interrupt change already
included in all five complete upstream variants; do not apply it twice.
Migration tests reverse these deltas only to check the unchanged historical
oracle. Native builds retain the exact selected upstream's tool implementation.
Where older search schemas accepted arbitrary strings, the structured adapter
advertises only their actual literal/regex operations; native integer arguments
are declared as integers rather than silently truncating a fractional number.

The remote transcript owner is the lightweight runtime turn loop. Limits are
16 calls/batch, 64 arguments/call, 1 MiB argument JSON/call, 2 MiB total argument
JSON/batch, 4,096 parser tokens, 255-byte IDs, 127-byte names, 4,096 message
blocks and 4,096 admitted IDs/session. Tracked transcript payload is limited to
16 MiB, with separately bounded identity/structure overhead. Snapshot preparation
reserves at most 128 MiB and rejects a serialized body over 16 MiB. Allocation
or budget failure stops further actions; no successful undo is implied.
These are per-runtime bounds, not a measured whole-engine memory guarantee.
The host now admits the owned 27B server and its verified projector separately
from the lightweight tool process. `DS4UI_REMOTE_VISION=qwen27-openai` is set
only for that ready model; textual/legacy endpoints do not acquire view_image.
This capability does not qualify a different model, backend or remote service.
Durable remote transcript recovery and complete mode/quality qualification
remain unfinished work.

`remote-vision.patch` records the first-party image adaptation from the exact
pre-image fragments (SHA-256 `51d98f15…` and `6bbf0259…`, checked in the migration
gate). The installer builds the current first-party fragments through its
existing fingerprinted include path; do not apply this delta a second time.
For the frozen v86 oracle only, reverse image → structured → interruption
deltas; forward replay uses the opposite order and must reproduce exact bytes.

Image observations retain original PNG/JPEG bytes, not embeddings or mutable
paths. They are bounded to 2 MiB per file, eight retained images and the existing
16 MiB transcript/wire budget. Reads resolve within the admitted workspace,
walk directory descriptors without following swapped symlinks, and revalidate
file identity before publication. Pixel decoding, visual encoding and projection stay in the
selected inference engine; a file-read receipt is not decoding success.
The pinned Qwen API accepts image spans in user observations: complete linked
tool results are followed by explicitly identified images in call order.
After an incomplete/failed model response, only unconfirmed new image candidates
are retired; accepted images and original files stay intact. No tool is replayed
automatically. Reset/compaction retire the entire owning group and its bytes.
The new call pointer grows the call record from 56 to 64 bytes on macOS arm64;
delivery state fits existing padding. The native probe reports layouts and
model-free snapshot timings; these are not inference performance claims.
The separate Qwen3.6 host integration has two passing real development
workflows; foreground desktop and general quality qualification remain open.
Passing the native patch gate alone does not qualify the desktop app.
The host enables Qwen3.8 Agent/Cowork with the new pin and
its required PLE; Design and other hardware still require separate qualification.

| Source base | Patch |
| --- | --- |
| antirez/ds4 `bd66c402070042bf0a79ad6ece8242de4c93680c` | [main-v41.patch](main-v41.patch) |
| antirez/ds4 `c0a6119f363ef82125877142f13fb3fe491cba14` | [main-current.patch](main-current.patch) |
| antirez/ds4 `f62ca29a308724cde5bc99134ede19104b2a3260` (identical Agent source) | [main-current.patch](main-current.patch) |
| antirez/ds4 `f4d03f6cf9f11c1e7b630bcb160853acfba7c52a` | [main-previous.patch](main-previous.patch) |
| antirez/ds4 Laguna `448d5695d1c86401a4e9447c440feb983b73e6de` | [laguna.patch](laguna.patch) |
| ivanfioravanti/ds4-metal `2dda88ed7bc596087f5282a6020d7409ca713ff3` | [qwen38-next.patch](qwen38-next.patch), after the matching [empty-candidate core patch](../ds4-qwen38-prepare/README.md) |
| ivanfioravanti/ds4-metal `ff4f0ff4fdff70d6b7c3941ef437b91dde960e14` (identical Agent source) | [qwen38-next.patch](qwen38-next.patch), with native preparation and snapshot-allocation patches |
| ivanfioravanti/ds4-metal `b4c355079d375d20821ece732e99195c71b32c06` | [qwen38.patch](qwen38.patch) |
| ivanfioravanti/ds4-metal `0bb323aa63cf7ed6167ae91a7606e1d875d404a3` (identical Agent source) | [qwen38.patch](qwen38.patch) |
| ivanfioravanti/ds4-metal `66b0e3fc3bf0f548db1ec0c0dd19f4e43567a7f8` (identical Agent source) | [qwen38.patch](qwen38.patch) |
| ivanfioravanti/ds4-metal `82d031408c50419957fd44b7e9c2d423890b24bd` (identical Agent source) | [qwen38.patch](qwen38.patch) |
| ivanfioravanti/ds4-metal `b85a6174da6d0ea3139b48194a2ca108097657b1` (identical Agent source; native parser/tool regression passed, not full model qualification) | [qwen38.patch](qwen38.patch) |
| vagrillo/ds4 `60fca11f0c8b16ca50c757324dddd717ba043098` | [qwen35.patch](qwen35.patch) |
| vagrillo/ds4 `73434c4bb9d8bb18425a2577edada69d25d44c47` (documentation-only update; identical Agent/core source) | [qwen35.patch](qwen35.patch) |

[`bases.json`](bases.json) records source, patch and output hashes. The shared
first-party remote implementation remains in `remote-agent.cfrag`, included at
its original position instead of copied into every delta.

The Qwen3.8 variant preserves the fork's native function/parameter parser, prompt
format, reasoning template and PLE options. Cowork schemas are placed inside
the native tools envelope, one JSON object per line. Literal `</tool_call>`
inside document/code content no longer prematurely terminates a parameter;
an incomplete parameter still cannot become an executable call. This fix was
reproduced on the unmodified upstream parser across every split of a 241-byte
test call. Two small real-weight development workflows on `0bb323a` now prove
native Agent and Cowork tool selection, file creation and readback on M2 Max.
Two subsequent real host workflows on `66b0e3f` verify launch, automatic Agent
Task Graph, Cowork document tools and post-rejection continuation. They do not
qualify held-out quality, every tool, desktop interaction or other hardware.

Qwen3.6's pinned server already renders ChatML and native function/parameter
calls, but its Agent only recognizes DeepSeek/GLM calls. The new candidate
backports the Qwen XML parser from the pinned Qwen3.8 source, adapting it to
the older Agent API and preserving Qwen3.6's own tokenizer, turn terminators,
generation loop and kernels. It does not insert DeepSeek's Max prefix into
Qwen conversations. Cowork receives the existing general-purpose Office schemas.
Literal markup and escaped closing delimiters remain document data; duplicate
parameters and incomplete calls cannot execute. Run-owned parser storage is
limited to 1 MiB of call text, 32 calls, 64 arguments/call and 127-byte names.
It is released on reset/cancellation; exceeding a limit is an explicit parse
error. Incremental value scans and fixed-size delimiter tails avoid quadratic
rescanning, with deterministic visit-counter regressions. No Qwen3.6 vision,
PLD or desktop-mode qualification is implied. Qwen3.6 disk checkpoint
reads/writes are refused before touching the incomplete upstream payload API;
bootstrap does not create that cache, and the existing live context is retained.
The application still saves its conversations independently.
Two real-weight development workflows on the final candidate passed on M2 Max:
Agent and Cowork produced independently checked files and read them back,
without creating the incomplete disk-checkpoint cache. This qualifies those
two native workflows only. Subsequent real headless host checks pass file
effects, generation interruption, new-session completion and readback for
Agent and Cowork. The first host control failure remains retained; a successful
retry does not resolve its cause. That replay also exposed a synchronous reset
which occupied the native command thread and delayed progress/interrupts;
version 91 addresses that separate issue as described below. Earlier failures
and the pre-cache-fix run are retained.

## Qwen new-session ownership

For the Qwen3.6 and Qwen3.8 piped Agent/Cowork runtimes, `/new` admits one reset
on the existing worker. The command reader can continue consuming progress and
interrupts while the system prompt is prepared. A required autosave must finish
successfully first; a later cancellation does not undo that completed save.

Preparation owns at most one candidate session in addition to the live session,
with the same configured context and shared immutable model weights. The engine's
native context/model dimensions bound its KV allocation. No context downgrade,
extra inference worker, unbounded queue or second model copy is introduced.
Allocation errors returned by the native API leave the old context intact;
this is not a promise of recovery from an OS-level process kill.

A compatible system-prompt cache may populate only the candidate; its tokens
must match the newly prepared prompt exactly. There are no speculative cache
writes. The owner revalidates session, engine, config, transcript and cancellation
before a bounded pointer/metadata swap. Old buffers and Qwen3.8 image references
are released outside the shared lock. Failure retains the earlier conversation
and attachments, and emits one error receipt before returning idle. Qwen3.8
autosave metadata is published only after the native save succeeds.

On the tested arm64 layout, the two reset flags use existing padding:
Qwen3.6's worker remains 2,144 bytes and Qwen3.8's remains 2,184 bytes.
Deterministic barriers verify that blocked preparation does not block progress
consumption or mutate the live context. This is a responsiveness/correctness
change, not a claimed decode-speed improvement. The legacy main/Laguna and TTY
reset paths are unchanged and are not qualified by these Qwen tests.
Durable progress retains the native granularity: per-token Qwen3.6 versus
completed 8,192-token chunks on Qwen3.8. Version 92 polls cancellation between
GPU layers of the private reset candidate and during bounded host staging.
Display-only layer events are not durable token checkpoints. Normal live sync
still checks only its original safe-prefix boundaries; no general kernel
preemption is claimed. The live reset fixture still spans multiple native chunks.
See the [Qwen stopping checkpoint](../../docs/QWEN_CHECKPOINT.md) for real-run
receipts, retained failures and remaining work.

Renderer-only captures are allowed by upstream without an Agent worker. JSONL
reasoning notifications now check that a configured worker exists. The shipped
variants already include [renderer-events-fix.patch](renderer-events-fix.patch):
**do not apply that delta again**. It documents the post-migration correction
and lets migration tests reverse only that reviewed change before comparing
against the unchanged frozen version-86 byte oracle.

The host applies one complete exact-context variant to a private source copy.
It rejects missing inputs, partial/repeated application, ambiguous candidates
and changed hunk context. Unrelated edits may shift line offsets but are retained.
There is no fuzz or whitespace repair. Inputs/output are bounded to 16 MiB and
512 hunks; at most eight variants are considered. Source identity is fixed by
the caller, not a path embedded in a patch.

On POSIX, a checkout-scoped build lease stays inherited by the compiler if the
parent exits. Agent/web derived sources, first-party objects and both linked
executables remain in a private directory until the build succeeds. The two
original input files are revalidated before publication and never rewritten.
The staging directory's identity is retained by an open descriptor. Replacing
its pathname rejects publication; bounded, non-recursive cleanup only operates
on that retained directory, not a replacement or symlink target.
An interrupted build may leave a private staging directory but cannot leave the
original Agent source patched. A pre-existing legacy marker is refused while
preserving both source and backup; automatic verified recovery is not implemented.
The native engine's separate patches and core object compilation still operate
in the managed checkout. Design now shares this lease and builds a private
source snapshot; unrelated external builds do not participate automatically.
The two Agent/Cowork final renames are not a crash-atomic pair transaction, and
mtime/version freshness is not a complete dependency signature.

## Verification

- `make test-unified-patch`: native application, exact line boundaries,
  ambiguity, malformed manifests, bounded regular files and private failure.
- `make test-agent-build`: the production builder with a **simulated compiler**;
  failed/incomplete links, source edits, kill, concurrent builds and old outputs.
- `make test-agent-patch-migration`: the three historical bases against frozen
  version-86 native output after reversing the documented renderer fix, plus
  four newer main/Qwen variants against their recorded derived hashes. All seven use independent
  Git apply/reversal, including unrelated edits,
  CRLF, partial/repeated application and drift. Requires the pinned local Git
  objects or exact files in `DSTUDIO_AGENT_BASE_SOURCES` named after each base.
  `DSTUDIO_AGENT_QWEN38_DIR` can point to the isolated candidate instead of the
  older managed Qwen checkout; `DSTUDIO_AGENT_QWEN35_DIR` selects Qwen3.6.
  It never downloads sources or weights implicitly.
- `make test-agent-native-build`: macOS source-only copies of main and Laguna,
  real compiler/linker, Agent/Cowork and Design tools, upstream Agent unit tests
  and fragmented renderer events with ASan/UBSan on private C objects. Native
  engine/GPU objects are not sanitizer-instrumented. Includes main
  Chat PLD build/CLI and explicit Laguna PLD rejection. Override
  `AGENT_MAIN_TREE`/`AGENT_LAGUNA_TREE` for other locations; set
  `AGENT_QWEN38_TREE` to additionally test the Qwen candidate and its explicit
  Chat PLD rejection. `DSTUDIO_AGENT_BUILD_BACKEND=cpu` selects a fresh CPU build
  instead of Metal. Tool responses come
  from real filesystem actions; model responses are deterministic fixtures.
  `DSTUDIO_AGENT_BUILD_HOST` may point to an isolated bundle's `DStudio` binary:
  the same test invokes its build CLI from `/`, materializes support files in
  a task-owned profile and checks that its actual patch assets match the source.
- `make test-qwen38-agent QWEN38_AGENT_TREE=PATH_TO_BUILT_CANDIDATE`: executes
  upstream Agent units, fragmented native Qwen parsing, eight native prompt
  combinations, real file writes and Cowork document creation/readback. Traversal
  and symlink writes outside its private workspace must fail without damage.
  Model text and engine identity are explicit fixtures; no model is loaded.
  ASan/UBSan instrument the parser/Agent/helper C objects, not upstream core
  objects. `QWEN38_AGENT_FLAGS=` disables those sanitizers explicitly.
- `make test-qwen35-agent QWEN35_AGENT_TREE=PATH_TO_BUILT_CANDIDATE
  QWEN35_AGENT_FLAGS=--sanitize`: real native linking, original Agent units,
  261 stream splits, native schemas, malformed/duplicate/over-limit rejection,
  JSON document escapes, linear scan counters, recurrent disk-cache guards
  and real Agent/Cowork filesystem effects. Model text
  and identity are simulated. No weights are loaded or source checkout edited.
- `make test-qwen-session-reset QWEN35_AGENT_TREE=PATH_TO_QWEN35
  QWEN38_AGENT_TREE=PATH_TO_QWEN38`: actual native command reader and worker
  with a deterministic simulated-inference barrier. Six Qwen3.6 and seven
  Qwen3.8 scenarios cover cancellation, failure, success, allocation failure,
  late cancellation, duplicate admission and Qwen3.8 save failure/attachments.
  The original synchronous code fails the three shared baseline scenarios.
  Agent/helper objects use ASan/UBSan; prebuilt engine objects do not.
- `node tests/integration/upstream_agent_prompt_test.mjs PATH_TO_BUILT_MAIN`:
  ten native prompt builders, parsed schemas and vision/remote gating. It builds
  its own derived probe objects without changing the supplied engine checkout.
- `make test-metal-workspace`: actually initializes each supplied Metal backend
  through the host's shader-path setup from an unrelated workspace and checks
  257 exact additions. Existing native objects are required; no weights are
  loaded. This catches runtime source-path omissions that a compile cannot.
- `node tests/live/qwen38_agent_smoke.mjs ENGINE MODEL_GGUF PLE_GGUF`: explicitly
  loads the candidate's real weights, sequentially runs Agent and Cowork, and
  checks tool receipts, exact file contents, source preservation and readback.
  The backbone is resident and PLE SSD-backed; context 16k, thinking/MTP off.
  Logs, filenames and paths are private ignored artifacts. This is a development
  smoke, not the held-out benchmark or an end-to-end desktop test. Its independent
  trace checks have a model-free gate, `make test-qwen38-tool-oracle`.
  `ENGINE MODEL_GGUF --qwen35` selects the already-built Qwen3.6 candidate,
  with resident weights and no PLE or Qwen3.8-specific power configuration.
- `node tests/live/qwen38_host_smoke.mjs ENGINE MODEL_GGUF PLE_GGUF`: the same
  development task through actual host launch/send/poll APIs, automatic routing,
  full production charters, private KV, exact artifacts and durable graph receipts.
  It rejects a Design switch while each real engine is active, then requires
  another real read. Native sampling defaults are retained; this is not a
  throughput comparison to the fixed-seed CLI run.
  Add `--reset-lifecycle` to observe live reset prefill, cancel it, recall a
  random code held only in the old conversation, then complete another reset
  and read back the previously created file. Use `ENGINE MODEL_GGUF --qwen35
  --reset-lifecycle` for Qwen3.6. Run the two models sequentially.

Receipts and failed attempts remain under ignored `tests/.artifacts/`. The first
two targets are in `check-fast`. macOS builds, tool execution and sanitizer
checks do not establish model quality, numerical parity or CUDA/ROCm/Windows
qualification. Those require their separate hardware and real-weight gates.
