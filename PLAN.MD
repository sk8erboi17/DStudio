# DStudio — remaining macOS completion work

Updated October 1, 2026. This document contains only unfinished implementation
and acceptance work. The full campaign remains incomplete and paused; this
documentation cleanup does not resume it. The owner reserves the complete
quality-suite rerun.

Completed tranches, superseded reconnaissance, original failures and exact
receipt identities are in the [archived plan](docs/history/plan-through-2026-10-01.md).
Use [the WIP](docs/WORK_IN_PROGRESS.md) for the shorter backlog,
[the Qwen checkpoint](docs/QWEN_CHECKPOINT.md) for model-specific work and
[engine admission](docs/ENGINE_UPSTREAM_ALIGNMENT.md) for release requirements.
Removing a completed task from this backlog does not qualify the entire model.

<a id="scope"></a>
## Scope and order

Every included selection requires real **Chat, Agent, Learn and Cowork**
workflows with the selected model, correct tools, verified results and reopened
outputs. Design is a separate fifth path. Only macOS on Apple Silicon/Metal is
in this campaign.

| Selection | Engine pin | Execution order |
| --- | --- | --- |
| DeepSeek V4 Flash Vision-Exp IQ2XXS | main 0aaea5a | First group |
| Laguna S 2.1 Q4_K_M | laguna 448d569 | First group |
| Qwen3.6-35B-A3B UD-Q6_K_XL | llama.cpp 99b9548 (b11371) | First group |
| Qwen3.8-27B UD-Q6_K_XL | llama.cpp 99b9548 (b11371) | First group |
| Qwen3.8-Flash-Next single-file Q4 | main 0aaea5a | First group |
| Qwen3.8-Flash-Next single-file Q2 | main 0aaea5a | First group; not qualified |
| DeepSeek V4.1 Flash Q2 | main 0aaea5a | Last, dedicated session |
| DeepSeek V4.1 Flash Q4 | main 0aaea5a | Last, dedicated session |
| GLM 5.3 Flash Q2 | main 0aaea5a | Last, dedicated session |

These are recorded pins, not a claim that remote tips were rechecked on
October 1. Exact revisions, patches and release targets live in
[engine-upstream.json](docs/engine-upstream.json); bundled-source provenance is
documented in [BUNDLED_ENGINES.md](docs/BUNDLED_ENGINES.md). The retired Qwen
Next fork is neither an installer target nor a bundled reference.

On October 3 the owner replaced the vagrillo/ds4 (`ds4-qwen35`) and Ninnix/q36
Qwen engines with the bundled llama.cpp; their earlier results are history.

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

Planned order: P0 → P1 → P2/P3/P4 → P5 → P6/P7/P8 → P9 → P10 → P11.
V4.1 Q2/Q4 and GLM stay in the denominator until their dedicated final session.
Source builds sharing a checkout and heavy inference sharing the GPU are
sequential. No model run, download, app restart or push is part of this cleanup.

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
3. Complete the case-level census of unit, integration, browser, live, upstream
   and publication suites, including prerequisites and exclusions. Correct any
   runner that still overwrites earlier results before running it.
4. Complete the coordinator using existing runners and the frozen
   [common corpus](tests/fixtures/common_model_quality_cases.py). The planned
   `tests/live/quality_multihardware.mjs` and public report directory
   `docs/benchmarks/quality-multihardware/` do not yet exist. A coordinator
   checks coverage, identities, exit states and denominators; it is not another
   inference implementation or application scheduler.
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
   [the matrix](docs/engine-upstream.json). On October 1 it declares nine macOS
   targets with 117 required gate slots and zero linked receipts. This is
   incomplete qualification, not 117 failed tests. Link existing evidence
   only when its exact engine/patch/model/binary identities and scope match.
3. Complete Agent/Cowork dependency signatures, coordinated crash-safe
   publication of the runtime pair and verified recovery of legacy patched
   source markers. Preserve originals, backups and unrelated checkout edits.
   See [the build limitations](patch/ds4-agent-jsonl/README.md#verification).
4. Complete current full-model multi-session coverage for the llama.cpp
   Qwen models (the q36 directory/parser item retired with that engine). Profile the relevant control and owner paths; do not claim
   multi-session quality from operator or single-owner fixtures.
5. For new changes, retain versioned external `.patch` files with exact bases/
   order. Exercise fresh/repeat/restore, partial/drift/wrong-order rejection,
   crash/failure and unrelated-edit preservation. Changing an actual dependency
   must invalidate and rebuild the consumed binary.

Acceptance: all relevant deltas classified or honestly unresolved, reproducible
patches, complete supported macOS admission evidence and no false alignment claim.

<a id="problems"></a>
<a id="p3"></a>
## P3 — Finish adapters and per-model mode parity

Status: IN_PROGRESS; Qwen Chat/Agent/Cowork integration exists.

1. Implement and qualify the independent Design adapter for Qwen3.6,
   Qwen3.8-27B and Qwen3.8-Flash-Next. Preserve current explicit rejection
   until the structured contract is implemented; keep DeepSeek/GLM/Laguna usable.
2. Implement complete disk-session checkpoint restoration for Qwen3.6 and
   Qwen27B, including every native recurrent/KV/session dependency. Saved
   conversation history alone is not resumption.
3. Complete Learn/Tutor on every selection: effective thinking/context,
   research → curriculum → audit → lesson/exercise/correction, actual references,
   progress and reopen. No hidden DeepSeek fallback or generic DeepSeek-only
   context policy imposed on Qwen.
4. Rerun the retained Next Learn incident with the intended effective reasoning
   request. Its diagnostic harness is corrected, but the real non-thinking
   loop/completion outcome is not established.
5. Revalidate the retained Qwen3.6 long-Agent timeout and partial-function
   overcount on the current adapter/prefill stack. Keep v102's failure
   historical; correct any reproducible summary/completion defect.
6. Complete native vision adapters/components where the checkpoint requires
   them, particularly the unqualified Qwen3.6/Next paths, through P4.
   Qualify Next Q2 independently of Q4.
7. For all nine selections verify tool call/result identity, parsing, reasoning,
   streamed events, cancel/reset/continuation, Goals/live input and reopened
   Cowork exports. Keep the existing DStudio tool loops and workspace confinement.
   A resident server has separate PID/lease/cancellation ownership from its
   lightweight Agent/Cowork client; never load a second unowned copy.

Acceptance: four complete modes with independently checked effects, selected
model identity and supported image/PDF semantics. Design receives its own gates.

<a id="p4"></a>
## P4 — Complete PDF, vision and text-model isolation

Status: IN_PROGRESS; extraction, evidence and browser foundations exist.

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
4. Run real answer checks with the actual selected model/component in all four
   modes. Retain source/page hashes, physical numbering, original bytes,
   payloads, expected results, outputs and failures.
5. Exercise protected/corrupt/oversized documents, missing pages/components,
   cancellation, exhaustion and a valid subsequent request. Keep explicit
   byte/page/resolution/context/memory budgets and honest omissions.
6. For verified text-only models, test observable rejection of pixels/vision
   tokens/visual embeddings through UI, API, history, tools and runtime. Preserve
   attachments; declared text extraction may still be used. A textless scan
   produces an honest limitation.
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
empty relocated profiles. The real q36 cross-version cache-preserving upgrade
was verified before q36 was retired and does not cover llama.cpp. Extend this evidence rather than scheduling those as new features.

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
September 29 receipts are complete: 27B **61/100**, corrected-Q6_K Qwen3.6
**63/100**, current-main single-file Next Q4 **75/100**, including **8/8**
long-context cases. They retain all failures. These are not scores for the
September 30 27B online-attention/3.6 batched-prefill overlays; details and
receipt identities are in [the Qwen checkpoint](docs/QWEN_CHECKPOINT.md).

1. Qualify the full 27B online-attention and 3.6 batched-prefill paths with
   compatible model/quant-specific numerical oracles and the original long
   requests. Operator checks are completed; full-model long-context/numerical
   evidence and any invalidated corpus reruns remain owner-controlled.
2. Complete current qualification of the other included selections, retaining
   development replays separately from first-exposure/held-out evaluations.
   Address software-caused failures and report answer/format failures honestly.
   Temperature-zero reruns of unchanged engines are not new evidence of a fix.
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
5. In the dedicated final session, run GLM's **100 continuations** on the
   matching final stack with NLL/first-token/greedy/logprob coverage and long
   contexts. This is not 100 answered questions. Verify scorer support for
   each architecture; no llama.cpp or unrelated-model oracle download.
6. Complete actual Chat, Agent, Learn/Tutor and Cowork quality, source-grounded
   facts, independently reopened DOCX/PDF/XLSX/PPTX content/formulas/revisions,
   interrupted tools, steering and resume without duplicated effects.
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

Nine selections require a minimum 900 text-case executions on their applicable
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
2. Complete all nine selections × four modes: **at least 36 workflows**.
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
The sixteen added systems require separate future generated-output qualification. Four interaction oracles are qualified; fourteen remain.

1. Qualify the remaining **14 domain interaction oracles** with independent
   positive/negative behavioral fixtures. Preserve current shared pipeline and
   qualified editorial/essay/repair/incident scenarios; reject deliberate
   broken behavior and keep late script/console errors observable.
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

<a id="closure"></a>
## Closure

Every P0–P11 row remains open until its remaining implementation and exact
acceptance evidence are complete. A completed scoped fix is removed from the
implementation backlog while its invalidated or missing acceptance checks stay.
Missing authority, credentials, permissions, compatible reference or Mac
resources must have an explicit blocker/procedure. Other platforms are excluded,
not blockers and not inferred successes.

The final deliverable requires current source/patch provenance, all applicable
numerical and quality cases, real four-mode and desktop results, vision/text
isolation, fresh/upgrade recovery, 18 audited Design projects, complete agent
comparisons, justified profiling and reviewed final-build publication.
