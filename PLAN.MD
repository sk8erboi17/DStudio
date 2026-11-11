# DStudio — remaining macOS completion work

Updated November 10, 2026. This document contains only unfinished implementation
and acceptance work. The full campaign remains incomplete. On November 10, 2026
the owner resumed it: complete every item of this plan and of
[the WIP](docs/WORK_IN_PROGRESS.md), then perform the final simplification step
([P12](#p12)) and, once that is finished, rewrite the README and re-record its
media ([P13](#p13)). This authorizes the campaign's sequential real-model runs on the
maintainer's Mac, including the owner-reserved quality reruns; it does not turn
an unfinished, failed or blocked requirement into a pass.

Completed tranches, superseded reconnaissance, original failures and exact
receipt identities are in the [archived plan](docs/history/plan-through-2026-10-01.md).
Use [the WIP](docs/WORK_IN_PROGRESS.md) for the shorter backlog,
[the Qwen checkpoint](docs/QWEN_CHECKPOINT.md) for model-specific work and
[engine admission](docs/ENGINE_UPSTREAM_ALIGNMENT.md) for release requirements.
Removing a completed task from this backlog does not qualify the entire model.

**Documentation ownership.** This is the canonical detailed list of unfinished
campaign requirements and retained failures. [README](README.md) is the product
entry point; [the WIP](docs/WORK_IN_PROGRESS.md) is a short navigation page.
[Test guides](tests/README.md) own commands and verification scope, while
[historical reports](docs/history/README.md) retain dated results. Updating those
summaries does not change this plan's acceptance criteria or denominators.

<a id="scope"></a>
## Scope and order

Every included selection requires real **Chat, Agent, Learn and Cowork**
workflows with the selected model, correct tools, verified results and reopened
outputs. Design is a separate fifth path. Only macOS on Apple Silicon/Metal is
in this campaign.

| Selection | Engine pin | Execution order |
| --- | --- | --- |
| DeepSeek V4 Flash Vision-Exp IQ2XXS | main 890898c | First group |
| Laguna S 2.1 Q4_K_M | laguna 448d569 | First group |
| Qwen3.6-35B-A3B UD-Q6_K_XL | llama.cpp f5027fb (b11836) | First group |
| Qwen3.8-27B UD-Q6_K_XL | llama.cpp f5027fb (b11836) | First group |
| Qwen3.6-35B-A3B MXFP8 | MLX: mlx 0.32.4 36969c0, mlx-lm 0.32.2 93e6d4a | First group (added October 25) |
| Qwen3.8-Flash-Next single-file Q4 | main 890898c | First group |
| Qwen3.8-Flash-Next single-file Q2 | main 890898c | First group; not qualified |
| DeepSeek V4.1 Flash 1017 Q2 | main 890898c | After the first group; SSD expert streaming only ([below](#v41-ssd)) |
| DeepSeek V4.1 Flash Q4 | main 890898c | Contributor hardware ([below](#contributors)) |
| GLM 5.3 Flash Q2 | main 890898c | Contributor hardware ([below](#contributors)) |

These are recorded pins, not a claim that remote tips were rechecked for this
update. Exact revisions, patches and release targets live in
[engine-upstream.json](docs/engine-upstream.json); bundled-source provenance is
documented in [BUNDLED_ENGINES.md](docs/BUNDLED_ENGINES.md). The retired Qwen
Next fork is neither an installer target nor a bundled reference.

On October 3 the owner replaced the vagrillo/ds4 (`ds4-qwen35`) and Ninnix/q36
Qwen engines with the bundled llama.cpp; their earlier results are history.

On October 23, 2026 the bundled llama.cpp moved from `b11371` (`99b9548`)
to `b11836` (`f5027fb`). On `b11836` Qwen3.6 passed the same six production-host
checks again (`run-7Ad19x`); an earlier attempt (`run-RpFauU`) stopped on a
stale test assertion that predated transcript restoration and is retained.
On November 11 Qwen3.8-27B passed the same six checks on `b11836`
(`run-vQz1Lv`, clean worktree at `11cd3cef`; its Design case took 56 minutes).
This is the development gate, not qualification; `b11371` results do not
transfer.

The retained Next Q4 common-100 result (75/100, including 8/8 long cases)
belongs to main `0aaea5a`. It is not qualification of the current `890898c`
pin. The November 4 V4.1 HTTP-resume correction and a verified full 1017 Q2
transfer are recorded in [the change note](docs/changes/2026-11-04.md);
download integrity does not close any model-quality or vision gate.

Since October 22 the Q2 row is the official antirez 1017 checkpoint
(`ds41f-q2`, revision `9dcee516`) with the community 1017 vision sidecar. The
original V4.1 Q2 remains downloadable as `ds41f-q2-original` so existing
partial downloads stay resumable; V4.1 Q4 is the original checkpoint. The
retained strict-format failure (13/14) belongs to the original Q2 and stays
FAIL there; it neither transfers to nor is cleared by the 1017 file, which
needs its own qualification. With the versioned
[vision-pairing patch](patch/ds4-v41-vision-pairing/README.md), each V4.1
checkpoint opens only with its own sidecar (`make test-v41-vision-pairing-live`
checks the headers, not inference). V4.1 vision qualification follows P4.

<a id="contributors"></a>
**Maintainer's execution plan and contributor hardware.** The maintainer,
Giuseppe Perrotta, runs this campaign on an Apple M2 Max with 96 GB of unified
memory. DeepSeek V4.1 Flash Q4 (518.6 GB with disk-backed Engram tables and a
0.97 GB vision sidecar) and GLM 5.3 Flash Q2 (96.5 GB plus its 1.1 GB vision
encoder) are not in the maintainer's execution plan. V4.1 Q4 has not run on
that Mac; GLM 5.3 runs there only with SSD expert streaming, and only its 100
reference continuations on an earlier main revision exist. Their complete
qualification is left to contributors. The two selections stay in scope and in
every denominator as BLOCKED, never as passed or excluded.
A contributor with an Apple Silicon Mac that can run them is welcome to take
them on, and likewise DeepSeek V4.1 1017 Q2 in the memory modes the maintainer
does not cover ([below](#v41-ssd)): use the recorded pins (ds4 main `890898c`
with the versioned patches), the frozen cases and the evidence contract below;
keep every failed attempt; record the machine, unified memory, effective memory
mode (resident, SSD expert streaming, Engram, disk KV), context and settings;
and share only reviewed aggregates and provenance hashes. Results from another
machine qualify that machine's configuration, not the maintainer's Mac. DStudio
has not established a minimum memory size for these models.

<a id="v41-ssd"></a>
**DeepSeek V4.1 1017 Q2: maintainer's plan, SSD expert streaming only
(November 10).** On November 10, 2026 the owner returned DeepSeek V4.1 Flash
1017 Q2 (365.7 GB with disk-backed Engram tables, plus a 0.97 GB vision
sidecar), and only that selection, to the maintainer's execution plan, with
one condition: it runs with SSD expert streaming only. It had been left to
contributors as BLOCKED since October 25. V4.1 Q4 is not part of this decision
and stays BLOCKED ([above](#contributors)).

- Every 1017 Q2 campaign run on the maintainer's Mac starts with SSD expert
  streaming On and records the effective mode reported by the runtime
  (`ssdStreamingEffective`). A run where streaming is not effective is not
  campaign evidence for it, and the setting is never turned off to make a
  case pass.
- A result qualifies 1017 Q2 in that memory mode on that Mac. Resident weights
  and the lazy memory-mapped path used with streaming Off are not qualified by
  it; they stay open to contributors with more memory and are never inferred
  from a streaming result.
- 1017 Q2 leaves BLOCKED and is **not run**: its verified weights are on the
  maintainer's SSD, and no campaign case was executed by this decision. It
  keeps every applicable requirement of this plan, including its own 100 text
  cases.
- Existing V4.1 evidence is unchanged and limited: the 14-case set on the
  original Q2 (13/14, retained as FAIL for that file) and the real Learn
  development runs of November 4–10 on 1017 Q2 with streaming effective, with
  their retained failures ([P3](#p3), [change notes](docs/changes/2026-11-10.md)).
  Neither qualifies a selection.

Returning 1017 Q2 to the plan started no run by itself; its runs follow the
first group in the resumed campaign.

Since October 25 the MLX Qwen3.6-35B-A3B MXFP8 path (Apple Silicon, macOS 26,
text only) is the tenth selection and part of the maintainer's execution plan.
It is a different engine and quantization from the GGUF row: neither one's
results qualify the other, and no quality comparison between them exists yet.
Its current results are development checks only (six production-host checks,
pi/OpenCode tasks and tool-call streaming). The admission matrix has no MLX
target yet; adding it with its required gates is part of P2.

<a id="qwen-variants"></a>
**Pinned Qwen variants (added October 25).** Every standard published
quantization of Qwen3.6-35B-A3B and Qwen3.8-27B is now downloadable and
selectable: 24 + 25 unsloth GGUFs on llama.cpp (every 27B GGUF with the pinned
F16 projector; both BF16 GGUFs split in two files) and 8 + 6 mlx-community
folders on MLX, 63 variants pinned by revision, size and SHA-256 in
[scripts/qwen-variants.json](scripts/qwen-variants.json). Qwen3.8-27B on MLX is
a new engine combination and text only (images are refused). Q6_K_XL (both
models on llama.cpp) and MXFP8 (Qwen3.6 on MLX) stay the campaign's
qualification selections; the other variants are not selections and do not
enter the selection denominators. They share the engine, tokenizer, chat
template and tool format of a checked variant but use other quantization
kernels (and the split BF16 another loading path and about 69 GB of memory), so
they are downloadable but not individually verified. Their fixture-based checks
(`make test-qwen-variants`) cover download, recognition, routing and refusals,
not inference.

Instead of one check per other variant (60 checks, about 1.4 TB of downloads), the
verification plan is five representative real-weight checks with the
production-host development gate (`make test-llama-resident-live
DSTUDIO_LLAMA_MODELS=<id>`: its six checks, plus the refused image request on
27B MLX), run one at a time, about 98 GB of downloads in total. All five are
required and **NOT RUN**: disk space no longer blocks them (about 586 GiB free
on October 25), but no weights have been downloaded for them yet:

| # | Variant (id) | Download | What it represents |
| --- | --- | ---: | --- |
| 1 | Qwen3.6-35B-A3B UD-Q4_K_M GGUF (`qwen36-q4_k_m`), through the new generic downloader | 22.1 GB | K-quant kernels on the new download path |
| 2 | Qwen3.6-35B-A3B UD-IQ4_XS GGUF (`qwen36-iq4_xs`) | 17.7 GB | i-quant kernels |
| 3 | Qwen3.6-35B-A3B MXFP4_MOE GGUF (`qwen36-mxfp4_moe`) | 21.7 GB | MXFP4 MoE kernels |
| 4 | Qwen3.6-35B-A3B MLX nvfp4 (`qwen36-mlx-nvfp4`) | 20.4 GB | MLX nvfp4 mode |
| 5 | Qwen3.8-27B MLX 4bit (`qwen27-mlx-4bit`) | 16.1 GB | the new 27B-on-MLX combination (affine mode, text only) |

A passing check covers its own variant on the maintainer's Mac; it does not
qualify the other variants, and none of the five qualifies a selection.

Out of scope: non-macOS platforms/backends, multi-GPU/distributed execution,
q27's removed Linux/CUDA admission target, Pro/GLM5.2, other
uninstalled LLM families, the four non-Vision DeepSeek V4 Flash variants and
their 0731 drafter, and the Ideogram/Hunyuan/MiniMax generation workers.
Preserve existing support and user data. Excluded workers may not be replaced
with fake outputs claimed as real. LLM image/PDF inputs, required native
vision components and local/CSS/SVG Design assets remain included.

Do not infer vision capability from a family name or an absent launcher
adapter. Check the original checkpoint, matching processor/projector/encoder,
engine, backend and mode. File presence does not prove a verified download;
a saved setting does not prove the effective runtime configuration.

Planned order: P0 → P1 → P2/P3/P4 → P5 → P6/P7/P8 → P9 → P10 → P11 → P12 → P13.
V4.1 1017 Q2 follows the first group on the maintainer's Mac, with SSD expert
streaming only ([its scope](#v41-ssd)). V4.1 Q4 and GLM stay in the denominator
as BLOCKED until a contributor runs them ([contributor hardware](#contributors)).
Source builds sharing a checkout and heavy inference sharing the GPU are
sequential.

<a id="baseline"></a>
<a id="order"></a>
## Evidence contract

Use the existing runtime owners, journal and persistence transactions described
in [AGENTS.md](AGENTS.md). Preparation uses immutable inputs outside shared
locks, then owner-side identity/lifecycle revalidation and bounded publication.
A blocked worker must leave control responsive. Stale/duplicate results cannot
commit; cancellation preserves prior data; durable replay preserves ordering.

Task states: TO_DO, IN_PROGRESS, IMPLEMENTED_PENDING_VERIFICATION, VERIFIED.
Executed test states: PASS, FAIL, BLOCKED, NOT_APPLICABLE with reasons;
exclusions: OUT_OF_SCOPE. Unstarted required cases remain visibly not run.
Retain every failed attempt, artifact and retry under a new run identity.
Missing dependencies, credentials, permissions, weights or Mac resources
cannot count as passing.

Each campaign result binds:

```text
caseId, suiteRevision, mode, feature, checkpointId, weightFormat,
quantization, weightSHA256, engineRepository, engineCommit, patchSetHash,
binarySHA256, backend, GPU/device, platform, driver/toolchain,
encoder/projector/processor identities, requestedSettings, effectiveSettings,
contextCapacity, processedTokens, runId, repetition, inputHash, expectedResult,
observedResult, status, reason, timings, memory, artifactHashes, rawReceipt
```

Model loading/inference, preparation, PDF planning and Research have no automatic
application wall-clock cutoff. Stop, owner-death cleanup, count/byte/concurrency
limits and identity revalidation remain required. Explicit positive budgets in
saved/API Task Graphs and isolated evaluation/fault-injection deadlines retain
their original semantics; never raise them to conceal a failure.
Private documents, questions, transcripts, local paths and raw evidence stay
in ignored artifacts. Publish reviewed aggregates and provenance hashes.

<a id="p0"></a>
## P0 — Complete the baseline and campaign census

Status: IN_PROGRESS; remaining verification and coordinator work.

1. Complete the inventory across all configured stores and symlinks, deduplicate
   identities and distinguish LLMs, native vision components, drafters, partial
   downloads and excluded files. Reuse verified hashes only under the applicable
   identity/integrity policy; do not redo completed full hashes without cause.
2. Bind every current source/archive, patch stack, compiler/options, binary and
   actually installed bundle to a receipt. A surrounding repository's Git
   identity cannot identify an engine snapshot. Revalidate all configured paths
   and working integrations against the current content.
   On November 10 the maintainer's Laguna checkout turned out to be a legacy
   in-place patched tree without a source receipt, whose `ds4.c`, `ds4.h` and
   `ds4_metal.m` differ from the pinned install. It was moved aside unchanged
   and Laguna was installed again from the bundled `448d569` sources, so its
   results can be bound to the pin. The native common-100 runner now takes the
   engine revision from DStudio's source receipt and refuses an engine without
   one. Since November 11 both corpus runners store the compiler and tools
   present when a run starts, and the llama.cpp install receipt already holds
   its CMake version and options. Still open: the ds4 installers do not record
   the compiler and flags that built an engine (its binary SHA-256 is the
   identity), and the installed app bundle is not bound to a run.
3. Complete the case-level census of unit, integration, browser, live, upstream
   and publication suites, including prerequisites and exclusions. Since
   November 10 `node tests/support/test_census.mjs` lists every test file and
   the target, gate or documented manual command that reaches it (276 files,
   none reached by nothing; see [the test index](tests/README.md#suite-census)),
   and the four live runners that erased their earlier receipts now write a
   new run directory each time. Still open: the census is per file, not per
   case, and does not yet record each suite's prerequisites and exclusions.
4. Complete the coordinator using existing runners and the frozen
   [common corpus](tests/fixtures/common_model_quality_cases.py).
   `tests/live/quality_multihardware.mjs` exists since November 10: it reads
   the ten selections of `tests/fixtures/quality_campaign.json` and every
   common-100 receipt, reports coverage and denominators on the current engine
   pin, model and memory mode, and starts the owning runner one model at a time
   ([how it counts](tests/docs/model-quality.md#common-100-answer-quality)).
   It covers the common-100 suite only: the product, numerical, vision and
   desktop suites are not in its matrix yet. The public report
   [`docs/benchmarks/quality-multihardware/`](docs/benchmarks/quality-multihardware/README.md)
   exists since November 11 with the reviewed common-100 aggregates and their
   Matplotlib charts; it grows as runs are reviewed and holds no other suite
   yet. A coordinator checks coverage, identities, exit states and
   denominators; it is not another inference implementation or application
   scheduler.
5. Perform resource preflight before each heavy run and retain its baseline,
   requests, answers, screenshots and original generated files under
   `tests/.artifacts/quality-multihardware/<run-id>/`. Stop only verified
   campaign-owned processes or processes explicitly authorized by the owner.

Acceptance: every target and applicable case identified; no lost/duplicated
files, inherited Git identity, overwritten receipt or unrecorded prerequisite.

<a id="p1"></a>
## P1 — Finish startup and lifecycle acceptance

Status: IMPLEMENTED_PENDING_VERIFICATION for the complete final desktop matrix.
The retired Design-setting migration and native validation regressions are
already implemented; they are not new implementation tasks.

1. Complete final native-desktop coverage of persisted retired/valid/none/
   unknown settings, missing packs, delayed/offline catalogs and reopening.
   Correlate the first launch request, persisted state and native task result.
2. Complete real model-switch races, late readiness/download replies, duplicate
   clicks, cancellation during build/load, active tools, window closure and
   restart. Rejected/stale launches must preserve the working model, settings,
   pending input and earlier effects, without orphans or double publication.
3. Investigate the retained isolated WebKit Design gallery-filter clearing
   failure. It did not reproduce in unchanged focused or later complete
   simulated runs; no causal fix is established. Preserve the failing receipt
   and reproduce before changing production or weakening the test.

Acceptance: responsive control, exact ownership and terminal task states on the
final app. Simulated browser successes do not close native/model races.

<a id="p2"></a>
## P2 — Complete engine alignment and admission

Status: IN_PROGRESS. The admission checker, bundled-source distribution,
patch migrations and retired-Next removal are implemented.

1. Complete the applicable source-delta/equivalence reviews for every active
   engine at its recorded pin. Before a source tranche or final release,
   explicitly recheck remote revisions and record the date/SHA; never make
   setup fetch or pull a moving upstream tree.
2. Resolve the missing release receipts/reviews in
   [the matrix](docs/engine-upstream.json). Since November 11 it declares ten
   macOS targets with 135 required gate slots and zero linked receipts (nine
   targets and 107 slots before). This is incomplete qualification, not 135
   failed tests. MLX now has its target, and the three host-served targets
   carry the gates required of every selection
   ([what changed](docs/ENGINE_UPSTREAM_ALIGNMENT.md)). Link existing evidence
   only when its exact engine/patch/model/binary identities and scope match.
3. Complete Agent/Cowork dependency signatures, coordinated crash-safe
   publication of the runtime pair and verified recovery of legacy patched
   source markers. Preserve originals, backups and unrelated checkout edits.
   See [the build limitations](patch/ds4-agent-jsonl/README.md#verification).
4. Complete current full-model multi-session coverage for the llama.cpp
   Qwen models and the MLX Qwen3.6 server (the q36 directory/parser item
   retired with that engine). Profile the relevant control and owner paths; do
   not claim multi-session quality from operator or single-owner fixtures.
5. For new changes, retain versioned external `.patch` files with exact bases/
   order. Exercise fresh/repeat/restore, partial/drift/wrong-order rejection,
   crash/failure and unrelated-edit preservation. Changing an actual dependency
   must invalidate and rebuild the consumed binary.

Acceptance: all relevant deltas classified or honestly unresolved, reproducible
patches, complete supported macOS admission evidence and no false alignment claim.

<a id="problems"></a>
<a id="p3"></a>
## P3 — Finish adapters and per-model mode parity

Status: IN_PROGRESS. Chat, Agent, Cowork and Design run on the llama.cpp Qwen
models and the MLX Qwen3.6, with development checks only.

1. Design on Qwen3.6 and Qwen3.8-27B (llama.cpp) and on the MLX Qwen3.6 is
   implemented with structured tool calls; each passed one real development
   Design case through the production host on October 3. The 27B Design run
   with thinking on hit that test's former one-hour bound before finishing;
   keep that receipt. Remaining: qualify Design on these paths through P8, and
   implement and qualify the independent Design adapter for
   Qwen3.8-Flash-Next. Keep any unsupported launch explicitly rejected and
   DeepSeek/GLM/Laguna usable.
2. Transcript restoration is implemented (October 3): Agent, Cowork and Design
   on llama.cpp/MLX (and a LAN host) save the transcript after every turn and
   rebuild it after a restart; old tool calls never run again
   (`make test-remote-session`, real runtimes with simulated model frames).
   Still open: bounded KV/session snapshot restoration across engine restarts,
   including every native recurrent/KV dependency (a restored session is now
   prefilled again), and saved pi/OpenCode sessions on these models. Saved
   conversation history alone is not KV resumption. A candidate route is
   llama-server's slot save/restore ([proposal 2](#proposals)).
3. Complete Learn/Tutor on every selection: effective thinking/context,
   research → curriculum → audit → lesson/exercise/correction, actual references,
   progress and reopen. No hidden DeepSeek fallback or generic DeepSeek-only
   context policy imposed on Qwen.
   November 4 implementation: roadmap generation saves an outline and each
   developed stage; streamed generation/audits/repairs/block expansion detect
   substantial exact reasoning cycles and recover the current phase. Automatic
   retries are bounded by count, with no elapsed-work or productive-reasoning
   token cutoff. Interrupted drafts and incomplete verification remain visible
   and saved. Model-free checks are documented in
   [Learn UI coverage](tests/docs/ui.md); real-weight qualification remains open.
   November 5 retains a later real V4.1 audit failure: reordered repeated
   paragraphs escaped that first guard, and the auditor lacked read-source
   excerpts. Factual verification now uses finite evidence-backed batches,
   saved verdicts and complete stage-pair/capstone consistency checks; unresolved
   evidence blocks publication. Reordered-paragraph recovery is covered by a
   private replay and synthetic negatives. See the
   [audit correction](docs/changes/2026-11-05.md). Complete real-weight Learn
   qualification, including the retained six-stage draft, is still open.
   A further real first-batch stall is also retained. At the owner's request,
   High is now the default and Learn/GSA/RSA reasoning is selectable rather
   than forced to Max. Max requires a loop warning and any context-increase
   confirmation. Model-free Off/High/Max request and guided-turn checks pass;
   this does not qualify the stalled draft at High.
   Retry now uses one current workspace view with collapsed attempt history.
   Saved authored stages are keyed to learner input/instructions/evidence,
   independently of runtime effort/context; audit receipts remain bound to
   model/settings/evidence. The retained six-stage draft loads in a read-only
   replay. Full real verification of that draft remains open.
   The real High attempt later stopped at 46/122 checks after three responses
   omitted one requested id. Partial-response recovery now saves independently
   valid verdicts and requests only missing/invalid ids within the original
   three-request budget. A private response replay retains those 46 checks and
   the next three valid ids; this is not a new real inference acceptance run.
   A subsequent storage failure was independent of model speed: the browser
   history quota was exhausted while the native file still had free disk space.
   Shared history now migrates to IndexedDB without emergency text deletion;
   native saves acknowledge checked atomic publication, and Learn waits for a
   durable checkpoint before advancing. Retry refuses unavailable storage before
   appending another draft. Real browser/native-file tests cover all five modes,
   Tutor payloads, failures, restart and competing windows. A private replay
   preserves all 23 attempts, six stages and 46 checks. These storage checks do
   not complete real-roadmap acceptance or engine KV reuse.
   November 6 corrects false evidence gaps caused by fixed prefix-heavy
   excerpts and clarifies whole-roadmap final-project scope. Retrieval now
   shares the existing bounded batch capacity across literal passages; changed
   content/project contracts retire dependent verdicts while preserving authored
   work and compatible stage-pair receipts. Overlong newly authored fields are
   refused instead of silently clipped. Authored regressions and a private
   model-free witness replay pass; real revised-auditor quality, genuine source
   gaps and full-roadmap acceptance remain open. See the
   [scoped correction](docs/changes/2026-11-06.md).
4. Rerun the retained Next Learn incident with the intended effective reasoning
   request. Its diagnostic harness is corrected, but the real non-thinking
   loop/completion outcome is not established.
5. Revalidate the retained Qwen3.6 long-Agent timeout and partial-function
   overcount on llama.cpp and MLX. v102's failure was measured on the retired
   engine and stays historical; correct any reproducible summary/completion
   defect on the current stack.
6. Complete native vision adapters/components where the checkpoint requires
   them, particularly the unqualified Qwen3.6/Next paths, through P4.
   Qualify Next Q2 independently of Q4.
7. For all ten selections verify tool call/result identity, parsing, reasoning,
   streamed events, cancel/reset/continuation, Goals/live input and reopened
   Cowork exports. Keep the existing DStudio tool loops and workspace confinement.
   A resident server has separate PID/lease/cancellation ownership from its
   lightweight Agent/Cowork client; never load a second unowned copy.
8. pi and OpenCode run as Agent harnesses (24/24 real development tasks on
   Qwen3.6 llama.cpp, Qwen3.6 MLX, Qwen3.8-27B and DeepSeek V4 Flash; see
   [the harness results](docs/HARNESSES.md)). Run them with GLM, Laguna,
   Qwen3.8-Flash-Next, DeepSeek V4.1 and a cloud endpoint, and qualify Plan,
   GSA and RSA with them. Keep their workspace confinement and model identity.

Acceptance: four complete modes with independently checked effects, selected
model identity and supported image/PDF semantics. Design receives its own gates.

<a id="p4"></a>
## P4 — Complete PDF, vision and text-model isolation

Status: IN_PROGRESS; extraction, evidence and browser foundations exist.
Scanned pages are read with local Apple Vision OCR on macOS, labelled as OCR
with OCR line evidence (`make test-pdf-ocr`). OCR text is a derived
representation; it does not qualify a model's pixel path.

1. Record matching checkpoint/tokenizer/processor/encoder/projector identities,
   capability, installation and effective mode/backend. Verify component
   revision/hash/format mismatches, corruption, download resume and cancellation.
2. Establish compatible numerical references for preprocessing, resize/tiling,
   image order, embeddings, positions, projector and session/KV state. Rendering
   a correct page is not encoder or answer qualification.
3. Freeze at least **30 PDFs + 20 images per vision checkpoint**, in addition
   to text cases: native/scanned/mixed/multipage, charts/tables/diagrams, small
   text, rotations, ordered images and unanswerable inputs. Include facts found
   only in pixels and independently prove they are absent from extracted text.
   Since November 11 one authored corpus is frozen in
   `tests/fixtures/vision_corpus/`: 32 PDFs (80 pages, 26 of them image-only)
   and 28 image items (36 files, four ordered sets), English and Italian, with
   282 questions of which 60 are unanswerable. `make test-vision-corpus`
   proves on the committed files that each of the 81 pixel-only facts is
   absent from what the production PDF reader extracts without OCR
   ([what it checks](tests/docs/regression.md#frozen-vision-corpus)). Still
   open: no model has seen it and no runner or grader for its expected-answer
   types exists; on macOS the OCR helper can read the image-only pages, so a
   pixel-path run must disable it or report those pages separately; a
   whole-document read hands at most four rendered pages to native vision, so
   some pixel-only facts on later pages need a page-directed question.
4. Run real answer checks with the actual selected model/component in all four
   modes. Retain source/page hashes, physical numbering, original bytes,
   payloads, expected results, outputs and failures.
5. Exercise protected/corrupt/oversized documents, missing pages/components,
   cancellation, exhaustion and a valid subsequent request. Keep explicit
   byte/page/resolution/context/memory budgets and honest omissions.
6. For verified text-only models, test observable rejection of pixels/vision
   tokens/visual embeddings through UI, API, history, tools and runtime. Preserve
   attachments; declared text extraction and labelled OCR may still be used.
   A scan without usable text or OCR produces an honest limitation.
7. Verify vision → text → vision after reload in every mode. Summaries, tool
   results, caches, late responses and KV cannot reinject incompatible data.
8. Revalidate citation chooser → physical page → highlight, light/dark and
   reopened sessions, on the final app. Independent answer correctness remains
   separate from extraction/retrieval/highlight success.

Acceptance: documented real pixel paths, independent correct answers, observable
text-model isolation and intact source data after error or Stop. No fallback VLM.

<a id="p5"></a>
## P5 — Extend installation, upgrade and recovery coverage

Status: IN_PROGRESS. Main, Laguna and llama.cpp build offline from isolated
empty relocated profiles; MLX installs from its bundled verified wheels with
outbound network denied (`make test-mlx-install`, no model). The real q36
cross-version cache-preserving upgrade was verified before q36 was retired and
does not cover llama.cpp or MLX. Extend this evidence rather than scheduling
those as new features.

1. Complete the final-bundle matrix using task-owned empty profiles and paths
   with spaces. Setup must verify pinned bundled sources with external source
   network denied; missing/altered sources fail without remote fallback.
2. Reuse verified weights without moving or copying user stores. Admit only
   completely verified model/components and bind the actually launched binary,
   patch stack, components and effective settings.
3. Execute controlled inference and a complete task in each required mode.
   This is separate from model-free installation/build tests.
4. Extend previous-install upgrade coverage to every active engine, preserving
   settings, projects, compatible sessions/caches and model identity.
5. Complete interruption/resume, corrupt/partial state, missing dependency,
   patch/build failure, concurrent preparation/update, owner death, cancellation
   and reopen recovery. Failed candidates cannot replace a working runtime or
   acquire ownership by finishing first.
6. Retain bounded staging/output, exact source/target revalidation, no double
   publication and the existing durable commit path. Repeat invalidated cases
   against the final build; native desktop setup remains P7.

Acceptance: fresh/upgrade/recovery receipts matching the final installation and
real four-mode results, with all failed attempts and preserved user bytes.

<a id="p6"></a>
## P6 — Complete numerical, answer and product quality

Status: IN_PROGRESS. The common 100-case corpus and grader exist.
Current-main single-file Next Q4 scored **75/100**, including **8/8**
long-context cases (September 29). The September 29 Qwen3.8-27B **61/100**
(q36) and corrected-Q6_K Qwen3.6 **63/100** (vagrillo/ds4) were measured on the
retired engines: they are history and do not score llama.cpp or MLX, which
have not run the corpus. All failures are retained; details and receipt
identities are in [the Qwen checkpoint](docs/QWEN_CHECKPOINT.md).

1. Run the common 100 cases and the original long-context requests for
   Qwen3.6 and Qwen3.8-27B on llama.cpp, and for Qwen3.6 on MLX,
   with compatible model/quant-specific numerical references. The 27B
   online-softmax and 3.6 batched-prefill overlays retired with their engines;
   their operator checks do not carry over. The owner authorized these
   corpus reruns on November 10.
2. Complete current qualification of the other included selections, retaining
   development replays separately from first-exposure/held-out evaluations.
   Retained from November 11: Laguna's common-100 run stopped at its first
   long-context case with `Metal command batch failed: Impacting
   Interactivity` in the second 16,384-token prefill batch (51/100, 12 not
   run; `engine-acceptance/run-QMNdf9`). Establish whether it reproduces on an
   idle machine, and whether Laguna needs smaller Metal batches as main has
   with `--prefill-chunk`; an adaptation goes under `patch/` with a numerical
   comparison against the 16,384-token batch.
   Address software-caused failures and report answer/format failures honestly.
   Temperature-zero reruns of unchanged engines are not new evidence of a fix.
   Keep the retained llama.cpp Qwen3.6 thinking-off arithmetic error.
3. Verify tokenizer/templates/stops, finite logits, quant/dequant, prefill/
   decode, attention/GDN/recurrence, KV save/load/replay/rewind, snapshot tail,
   context boundaries, multiple sessions and cancellation. Use exact checks
   where required and documented tolerances elsewhere.
4. Complete applicable actual OpenAI Chat Completions/Responses and Anthropic
   server protocols, tools/reasoning/caching, shared remote transport and
   sanitizers. Unavailable cloud credentials/access remain explicitly BLOCKED;
   no additional model download is authorized. Inspect the exact supported
   pinned upstream oracles; missing
   compatible references remain unresolved rather than borrowed from a family.
5. On contributor hardware ([see scope](#contributors)), run GLM's **100 continuations** on the
   matching final stack with NLL/first-token/greedy/logprob coverage and long
   contexts. This is not 100 answered questions. Verify scorer support for
   each architecture; no llama.cpp or unrelated-model oracle download.
6. Complete actual Chat, Agent, Learn/Tutor and Cowork quality, source-grounded
   facts, independently reopened DOCX/PDF/XLSX/PPTX content/formulas/revisions,
   interrupted tools, steering and resume without duplicated effects.
   Cowork on DeepSeek V4 Flash Vision-Exp IQ2XXS: resume profile 2/2; long
   profile 10/11 so far. `ambiguous-edit` failed in a reasoning loop until the
   test's one-hour limit and a second sample was stopped on request;
   `path-escape`, `long-seed`, `long-followup`, `long-revision` and
   `long-deck` have not run. Run them on runtime v106, which no longer declares
   the refused shell tools, and keep the failed receipts. A reasoning-budget
   pause is proposed for the `ambiguous-edit` loop ([proposal 3](#proposals)).
7. Complete Search/Research held-out answers and actual native-vision webpage
   checks beyond the existing development questions and single-model fixtures.
   Verify requested detail/language/length, grounded disagreements and honest
   incomplete outcomes. Model self-review is not an independent answer grader.
8. Execute every applicable standard/long/slow case from the P0 census.
   `make check-real` currently includes only ASCII diagrams, Search/Research
   and remote tests; `make check` alone is not complete campaign coverage.

The frozen minimum text distribution remains:

| Area | Cases | Independent oracle |
| --- | ---: | --- |
| Calculation and units | 12 | Calculation and conditions |
| Verifiable reasoning | 12 | Solution/constraints |
| Generated code | 15 | Tests outside the model |
| Debugging | 10 | Before/after tests and preserved files |
| JSON/schema | 10 | Parsing and semantic schema |
| Extraction | 10 | Frozen sources and expected fields |
| Strict instructions/format | 10 | Observable original constraints |
| Italian/English | 8 | Task-specific expected result/rubric |
| Long context | 8 | Hidden needle/relations |
| Insufficient information | 5 | Verified absence |
| **Total per selection** | **100** | |

Ten selections require a minimum 1,000 text-case executions on their applicable
paths across the complete campaign, plus product, numerical and vision cases.
Preserve denominators, original deadlines and grader semantics. Correct a grader
only with evidence, a behavioral regression and the same correction for all
variants. A declared secondary judge may assist; it cannot qualify its own answer.

<a id="p7"></a>
## P7 — Complete the real desktop matrix

Status: IN_PROGRESS; earlier individual Chat workflows and simulated UI runs
are complementary evidence, not full native-model desktop acceptance.

1. Use the actual foreground DStudio.app, launcher and real weights in an
   isolated profile with owned ports. Record procedures, actual mouse/keyboard
   or accessibility actions, screenshots, logs and independently verified files.
2. Complete all ten selections × four modes: **at least 40 workflows**.
   Chat includes stream/copy/Stop/next question; Agent read/edit/test and confined
   effects; Learn curriculum/lesson/exercise/correction/progress/reopened Tutor;
   Cowork document/table changes, export and independently reopened files.
3. Include first/normal launch, setup, picker/load/switch, saved settings,
   native dialogs/focus/keyboard/resize/scroll, failures and return to operation.
4. Repeat real image/PDF inputs in every supported vision mode and negative
   payload checks for text-only models. Exercise history/cache/tool results
   across vision → text → vision and reopen.
5. Verify messages during generation/tools, ACK/order, pause/resume, cancellation,
   errors, restart and multiple sessions with exact terminal states and effects.
6. Finish Design gallery/setting migration, real generation, working preview,
   revision, export and standalone reopen. Repeat critical cases on the frozen
   final build and correlate model/engine/component/artifact identities.

Acceptance: actual desktop procedures with independent results. Missing desktop
permission/tool is BLOCKED with a ready procedure, never replaced by mock PASS.

<a id="p8"></a>
## P8 — Finish the Design auditor and generated-project matrix

Status: IN_PROGRESS. Twenty-five offline systems now exist; the 18 frozen briefs
and generation/resource harnesses cover the original nine systems only.
The sixteen added systems require separate future generated-output qualification. All eighteen interaction oracles have qualification fixtures since November 11; the limits found are open (item 1).

1. Qualify the remaining **14 domain interaction oracles** with independent
   positive/negative behavioral fixtures. Preserve current shared pipeline and
   qualified editorial/essay/repair/incident scenarios; reject deliberate
   broken behavior and keep late script/console errors observable.
   Since November 11 all eighteen oracles have an authored reference page
   with deliberate faults, checked in Chromium and WebKit, and the row helper
   that made two oracles reject every page is corrected. A second pass the
   same day made the oracles detect the defects the first pass had found
   undetected, where the brief requires the behaviour, and accept the correct
   pages they rejected (262 faults and 85 accepted variants in all). Still
   open: the shared-helper limits, the correct pages still rejected and the
   behaviours still unverified, listed in
   [the Design test guide](tests/docs/design.md#interaction-oracle-qualification);
   and moving the helpers the scenarios now duplicate into the shared layer.
   Resolve the shared-helper limits before generated projects are graded.
2. Generate **at least two projects per system: 18 projects** using
   [the frozen briefs](tests/fixtures/design_pack_projects.json), included
   models and recorded identities. No excluded image/video workers or human
   edits to benchmark output.
3. Independently audit original immutable exports: actual controls, filters,
   forms/radio buttons/dialogs, item-specific state, Back/undo/persistence;
   standalone offline and the real opaque preview iframe without weakening CSP.
4. Complete Chromium/WebKit, both themes, 320/390/768/1440 widths and 200% text.
   Inspect desktop/mobile screenshots separately from geometry, rendered
   contrast, overflow/overlap/focus and accessibility checks.
5. Reproduce the retained generated-workshop/radio-label defects and regenerate
   through the native Design runtime after any correction. Preserve every
   incomplete/timeout/failed output and record generation/teardown separately.
6. Complete final desktop and final-build qualification. Unstarted projects stay
   in the denominator of 18; static previews and a model critique cannot pass them.

Acceptance: 18 actual generated, independently functional and visually reviewed
projects across the nine distinct systems. No manual benchmark-output repair.

<a id="p9"></a>
## P9 — Complete six-agent comparisons

Status: TO_DO for the new complete campaign; fifty fixtures and historical
comparisons already exist.

Compare clean upstream ds4-agent, direct patched DStudio Agent, the same Agent
with Task Graph/check, Pi, OpenCode and Codex CLI. The historical Native
baseline uses DStudio patches; it is not clean upstream.

1. Implement actual Codex invocation and Responses proxy validation in
   [the existing runner](extension/task-graph/bench/run-cli-competitors.mjs).
   Since November 11 the runner has a Codex harness (isolated configuration,
   sandboxed non-interactive run, event parsing, the same grading path) and
   `make test-codex-protocol` drives the installed Codex CLI 0.167.0 through
   26 cases against a scripted Responses server
   ([what it proves](extension/task-graph/bench/README.md)). Still open: no
   real-model Codex run exists; whether the CLI's 25 KB base request fits the
   benchmark context is unmeasured; the publication scripts still read Pi and
   OpenCode only.
   Inspect the installed CLI/API at implementation time; exercise tool-call →
   file/command effect → tool-result → answer, reasoning/events, partial and
   Unicode frames, IDs, stop, cache/continuation and resume. Verify native
   parameters/model pins; no final-text-only shim or inherited private config.
2. Prove protocol behavior with a controlled server first, then a real model.
   Model/protocol fixtures do not count as agent quality.
3. Keep two lanes: equivalent model/settings/tools/format/backend/cache versus
   complete product with available configurations. Missing/nonrepresentable
   equivalence is BLOCKED/not comparable. No competitor LLM download.
4. Preserve fifty fixtures and add **at least twenty held-out cases**, plus long/
   recovery: dirty workspaces, failed tools, partial patches, steering, Stop/
   resume and multiple sessions. Freeze independent external oracles.
5. Use isolated identical workspaces, counterbalanced/seeded order and at least
   three repetitions: **70 × 6 × 3 = 1,260 attempts per complete lane**, plus
   long/recovery cases. Retain unavailable rows and exact reasons.
6. Check files/tests/answers outside the Agent, false completions, regressions,
   duplicate tools and recovery. Measure time to verified result, phase timings,
   memory/context/cache/tokens/cost where actually exposed.
7. Verify every adapter's JSONL fragmentation/order/tool identity, steering ACK
   and terminal outcome. Complete PLD off/strict/batch ablations where supported,
   preserving effects/state after rejection, cancellation and replay; MTP/
   DSpark/DFlash remain separately identified compatible experiments.

Acceptance: immutable evidence, independently graded outcomes, real six-agent/
two-lane scope and comparable settings; speed comparisons use correct matched
pairs while still displaying the full failure denominator.

<a id="p10"></a>
## P10 — Profile and retain justified optimizations

Status: TO_DO after correctness and comparable baselines.

Profile the reproduced phase: cold loading, preparation/prefill, cache work,
tools/I/O/parsing/retries, stream consumption, verification, warm reuse and
shutdown. Measure preparation, owner-queue wait, lock wait/hold, commit,
interactive latency, throughput and RAM/GPU/SSD separately.

Use deterministic barriers and visit counters: blocked preparation cannot block
control; lock hold cannot grow with bulk preparation; work scales with active
requests/changed records. Reduce duplicate work and algorithmic cost first.
Any pool/cache needs documented ownership, complete revision identity, lifetime,
limits, cancellation, invalidation/eviction and semantically equivalent fallback.

Keep only improvements passing all affected gates. Preserve context, precision,
reasoning, result bytes/effects, journal/fsync and recovery. No altered system
limits, unrelated process termination, inflated benchmark deadlines or invented
speedup/peak/universal-superiority claims.

<a id="p11"></a>
## P11 — Qualify the final build and reviewed publication

Status: TO_DO for release qualification. Earlier source/checkpoint publication
is complete; it is not a new outstanding source-push task.

1. Recheck applicable upstream deltas and invalidate/rebuild/retest affected
   evidence. Freeze DStudio content/diff plus engine/base/patch/binary/weight/
   encoder identities; HEAD alone cannot qualify dirty content.
2. Complete all applicable admission gates and critical final desktop paths.
   Do not transfer an old PASS to changed inference, encoder, parser or adapter.
3. Update documentation/notices and the macOS model/configuration matrix from
   verified outcomes, retaining actual unsupported combinations and failures.
4. Publish reviewed aggregate JSON/CSV, Matplotlib scripts and inspected PNGs
   for the completed campaign, generated projects, comparisons and measured
   before/after cases. Include units, sample counts, failures, provenance and
   cold/warm settings; keep private raw evidence ignored.
5. Attach fresh/upgrade, four-mode, vision/isolation, desktop, project and
   six-agent/two-lane coverage, with exact blocked prerequisites and procedures.
   Final commits/push, app installation and restart require their applicable
   user authorization; this document cleanup performs none of them.

<a id="p12"></a>
## P12 — Remove unnecessary complexity and prove nothing regressed

Status: TO_DO. Added November 10, 2026 at the owner's request as the last step:
remove all unnecessary complexity and the tests that are really useless,
without degrading or regressing the application's quality or functionality,
proved by tests over every way the app is used.

1. Build the usage-case matrix before removing anything. It lists every way
   the app is used: Chat, Agent, Cowork, Design and Learn; Search/Research;
   PDF, images and vision; model download, selection, loading and switching;
   settings; saved conversations, sessions and reopening; Stop, steering,
   Goals and resume; pi/OpenCode harnesses; Task Graph; Blueprint; LAN, remote
   and cloud endpoints; first launch, installation, upgrade and recovery. Each
   entry has its normal, boundary, failure and recovery cases and the
   behavioral test that executes it through production code. A usage case
   without such a test gets one first; a simulated-model test is labeled as
   simulated and does not stand in for a real-model case.
2. Record a reference execution of the whole matrix on the unchanged build:
   outputs, tool effects, persisted data, wire messages and errors.
3. List the removal candidates with their evidence: code no production path
   reaches, settings and flags nothing sets, duplicate implementations,
   indirection with a single consumer, handling kept only for retired engines
   or old installations, endpoints and assets nothing calls, unused
   dependencies. Establish reachability by execution, coverage and a search of
   every consumer and bundle, never by a name search alone.
4. Remove in small tranches that can be reviewed and tested on their own; do
   not mix mass moves or renames with behavioral changes. After each tranche,
   compare the matrix with the reference execution and rerun the affected
   gates. A difference is a regression until proved to be an intended removal.
5. Remove only tests that are really useless: tests that execute no production
   behavior (assertions on source text, names, comments or CSS declarations),
   exact duplicates of another test's inputs and assertions, and tests of code
   removed in this step. A slow, flaky or failing test is not useless: repair
   it or keep it with its failure. Keep the behavioral coverage of a mixed
   test. Record each removed test, the reason, and the test that still covers
   the behavior.
6. Remove no supported capability, model, mode, error path, recovery path,
   confinement check or durable format. Lower no baseline, deadline or
   denominator, and keep every failed receipt.
7. Rebuild and rerun whatever this step changes in the build qualified by P11;
   an earlier PASS does not transfer to changed code.

Recorded on November 11, 2026, when the matrix was first written
(`tests/fixtures/usage_matrix.json`; `node tests/support/usage_matrix.mjs`
prints its coverage). It lists 628 usage cases in sixteen areas: 574 have at
least one test, **54 have none**, and 243 are covered only by tests with
authored model replies. Coverage was confirmed by reading the guides and the
test files; it is a first complete pass, not yet reviewed row by row. Before
anything is removed, the following inputs from that pass must be resolved:

- The 54 uncovered cases each get a behavioral test, or an explicit recorded
  reason why the case cannot be exercised on the maintainer's Mac.
- Tests that execute only test-support code and no production behavior:
  `research_http_cancel_test.mjs`, `roadmap_request_test.mjs`,
  `http_deadline_test.mjs`, `rsa_collectors_matrix_test.mjs`,
  `design_control_probe_test.mjs`, `design_resume_checkpoint_test.mjs`,
  `design_pages_release_gate_test.mjs`, `lumen_disclosure_contract_test.mjs`.
  Some check a grader or harness that other tests depend on; decide per file
  whether that is its stated purpose (then say so in its guide) or whether it
  is removed under item 5.
- Assertions that could not fail, corrected on November 11: the "did not stop
  its own worker" checks in `http_lan_test.sh` now observe the worker for a
  bounded time; the Learn test's rejected-claim pattern now matches the
  rejected text and the repaired practice is required; the harness live test
  no longer passes its outside-workspace case when no read is attempted (not
  yet rerun on real weights); two assertions in `engine_acceptance.mjs` on a
  field nothing set are removed. Still open:
  `ui_live_vision_playwright_test.mjs` attaches no image and grades no reply.
- Guide statements wider than what runs, to correct in the guides or by
  extending the test: case counts that drifted (`test-launch-preflight`,
  `test-agent-spawn`, `test-design-build-freshness`, `test-engine-sources`,
  first launch, stream scenarios, `test-llama-resident-live`); suites
  described as Chromium and WebKit that `check-fast` runs in Chromium only
  (`ui_agent_design`, `ui_model_picker`, `ui_think_max_context`, plan mode,
  `ui_gsa`, `ui_rsa`); `test-setup-live` and `test-engine-acceptance` described
  for four engines; Qwen branches described for `test-agent-compaction` and
  `test-agent-continuation`; patch-migration base counts;
  `test-ui-lan-cowork` described as the same flow as its HTTP test; the 64 MiB
  and 64-caller history limits that no test executes.

Acceptance: the usage-case matrix passes before and after; every removal has a
recorded reason and passing differential evidence; the reduction (files, lines,
build time, binary size) is reported as measured; no requirement, failure or
capability disappeared.

<a id="p13"></a>
## P13 — Rewrite the README and re-record every GIF and screenshot

Status: TO_DO. Added November 11, 2026 at the owner's request, to be done once
P0–P12 are finished.

1. Rewrite `README.md` in full from the verified outcomes of the finished
   campaign: what the app does, what was measured, on which models and
   configurations, and what is still unsupported or blocked. No claim without
   its receipt; retained failures stay visible.
2. Re-record every GIF and screenshot used by the README and the documentation
   with headless Playwright and ffmpeg, from committed recording scripts, so
   that each one can be regenerated. They must be presentable: zoom into the
   part that matters, a camera that follows the caret while text is typed, and
   smooth animated transitions between steps.
3. Record the production page. Where a recording uses authored model replies
   instead of a real engine, say so next to it; never present a simulated
   reply as model output. No private documents, prompts, paths or
   conversations in any frame.
4. Inspect the rendered frames and the final files, not only the script's exit
   status: legible text at the published size, both themes where relevant,
   sensible duration and file size, no leftover debug overlay.
5. Replace the old media, update every reference, and remove files nothing
   links any more.

Acceptance: every image and GIF in the README and documentation comes from a
committed script and was inspected after rendering; the README states only
verified outcomes; no dead link or orphaned media file remains.

<a id="closure"></a>
## Closure

Every P0–P13 row remains open until its remaining implementation and exact
acceptance evidence are complete. A completed scoped fix is removed from the
implementation backlog while its invalidated or missing acceptance checks stay.
Missing authority, credentials, permissions, compatible reference or Mac
resources must have an explicit blocker/procedure. Other platforms are excluded,
not blockers and not inferred successes.

The final deliverable requires current source/patch provenance, all applicable
numerical and quality cases, real four-mode and desktop results, vision/text
isolation, fresh/upgrade recovery, 18 audited Design projects, complete agent
comparisons, justified profiling, reviewed final-build publication and the
final simplification with its passing usage-case matrix.

<a id="proposals"></a>
## Proposed modules and improvements (outside P0–P13)

Added October 25, 2026; proposal 13 added November 4. None is implemented or scheduled: these are candidates,
not acceptance requirements of P0–P13, and starting one is the owner's decision.
Each statement about the current code was checked against the source. Effort is
a rough estimate (S/M/L), not a measurement.

1. **Guards for the pi and OpenCode harnesses.** pi starts with `--no-approve
   --no-session` and the workspace guard; OpenCode allows every tool except
   question, webfetch, websearch, external_directory and doom_loop
   ([the bridge](src/harness/bridge/dstudio-harness.mjs)). Paths are already
   confined. Missing: a duplicate-call breaker on canonical arguments with
   no-progress detection, deterministic gates for destructive actions, a Plan
   mode enforced as read-only (including mutating shell commands), mid-turn
   steering forwarded to the harness, and an honest executed/blocked summary
   when the breaker stops a turn. Effort S–M.
2. **Disk KV slots for llama.cpp, and an MLX prefix cache.** The bundled
   llama-server supports `--slot-save-path` and `/slots` save/restore;
   `src/dstudio_resident.c` does not use them. This is a route for P3.2's open
   KV item, not new scope. The key must cover model digest, quantization,
   engine/patch revision, context, chat template and prefix hash; a mismatch
   falls back to normal prefill; the UI reports a restore separately from a
   fresh prefill; the store has a byte cap and eviction and is deleted with its
   chat. Confirm save/restore for the Qwen hybrid recurrent layers first.
   Effort M.
3. **Pre-action reasoning budget with a clarifying pause.** Design accepts a
   thinking-token setting (`src/harness/design/ds4_design.c`); Cowork has none.
   Counted in processed tokens, never elapsed time, with a large default, a
   one-click extension that keeps the computed prefix, and a structured pause
   (what is clear, what blocks, options). Targets the P6.6 `ambiguous-edit`
   loop; the risk is interrupting legitimate reasoning. Effort M.
4. **Constrained JSON for structured internal steps.** Neither
   `src/dstudio_model_rpc.c` nor `extension/search/runtime.js` passes
   `json_schema`, `response_format` or a grammar; Search, PDF planning and
   roadmap blocks rely on prompts and post-hoc parsing. Enable it per engine
   capability (llama.cpp supports it; ds4 and MLX to verify), only on the final
   output after `<think>` or on non-thinking steps, and reject it explicitly
   where unsupported. Effort S–M.
5. **Local state audit in Doctor.** `api_doctor()` in `src/dstudio.c` checks
   first-launch prerequisites only. Add an on-demand, read-only report:
   abandoned partial downloads, orphaned DStudio-owned leases or engine
   processes, Task Graph `state.json` diverging from `events.jsonl` (reported,
   never rewritten), Blueprint citations to missing files and cache sizes.
   Bounded scan outside shared locks; each action needs user confirmation;
   never touches weights, chats or foreign processes. Effort S.
6. **Independent edit receipts and restore for Office files in Cowork.**
   `src/harness/cowork/office_tool.py` returns the writer's receipt and states
   that it is not an independent readback. Missing: before/after SHA-256, an
   independent structural diff (cells and formulas, paragraphs and tables,
   slides), refusal to report success on an empty or off-target diff, bounded
   snapshots, and restore only while the file still matches its recorded
   after-hash. Effort M.
7. **Stream integrity check.** No detector for repetition collapse,
   unrequested script/language drift or leaked template tokens exists. Start
   report-only in turn metadata; stopping a generation requires measured
   false-positive rates on code, tables and multilingual text. Bounded
   per-request memory; no automatic retry of non-idempotent actions.
   Effort S–M.
8. **Mastery ledger in Learn.** Roadmap topics carry `practice` and
   `assessment`, and `roadmapStudyThreads` keeps per-topic transcripts
   (`web/index.html`); there is no per-topic status. Missing: status per topic,
   an assessment graded against explicit criteria on the learner's actual
   answer (a model self-assessment cannot mark mastery), a cross-roadmap gap
   summary and a local Markdown export. Effort S–M.
9. **Open Blueprint structural index and JSON Canvas export.** Blueprint
   already checks each cited quote against the file bytes (verified, moved,
   unverified, missing; `verifySource()` in `web/index.html`). Missing: a
   bounded, deterministic import/include index presented as static structure
   rather than a call graph, and export to the open JSON Canvas `.canvas`
   format. Effort S–M.
10. **PDF ↔ web claim agreement matrix.** `compareResearchQuantities()` in
    `extension/search/runtime.js` compares numeric quantities across web pages,
    and PDF evidence verifies citations and pages. Missing: per-claim
    supports/contradicts/not attested across attached PDFs and web sources,
    deterministic rejection of citation tags outside the retrieved evidence,
    and export as a Cowork table. Effort M.
11. **Conversation branches.** Regenerate removes the previous assistant
    message (`Store.removeMessage` in the regenerate path of `web/index.html`).
    Missing: sibling branches with a parent and active leaf, editing an earlier
    user message as a new branch, migration of flat chats, late streams
    confined to their own branch, LAN mirror consistency and shared attachments
    by reference. Effort M.
12. **Watched drop folder for Cowork.** No filesystem watcher exists in the
    host. Missing: an opt-in watcher on one workspace subfolder
    (FSEvents/kqueue), waiting for writes to settle, symlink confinement,
    bounded preparation (digest, extraction) outside locks, and no model run
    until the user confirms. Effort M.
13. **Base Chat prompt review.** The current ordinary Chat request combines a
    custom system prompt with explanation, mathematical typesetting and
    file/image/video routing protocols in `extension/search/runtime.js`.
    Proposed, not implemented: simplify general style and case-specific ASCII
    instructions, retain explicit uncertainty and action-result discipline,
    derive available media capabilities from the selected runtime, and preserve
    the existing output contracts. Compare the current and candidate prompts
    on held-out short answers, teaching, math, code, attachment and media-intent
    cases with independently checked outputs; preserve every failed attempt.
    No rewrite, quality improvement or performance gain is claimed. Effort S–M.
