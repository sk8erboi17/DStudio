# README checklist snapshot — November 4, 2026

> Snapshot at `d02b342f`, retained with its original checked and unchecked items. It is historical evidence, not the current acceptance list. See [PLAN.MD](../../PLAN.MD) and the [short WIP](../WORK_IN_PROGRESS.md).

## WIP checklist — November 4, 2026

The macOS/Apple Silicon campaign is **incomplete**. Checked items mean the
stated implementation or scoped verification is complete; they do not qualify
every model or a release. Exact acceptance criteria and retained failures are in
[the remaining WIP](../WORK_IN_PROGRESS.md) and [PLAN.MD](../../PLAN.MD).
Reconciled against the current source pins and evidence on November 4. The
complete model-quality campaign remains paused; historical results keep their
original revisions and are not passes on a newer engine.

### Completed implementation and scoped checks

- [x] Bundle pinned engine sources with provenance and versioned adaptations;
  build/install from an empty offline profile without fetching sources.
  [Sources and verification](../BUNDLED_ENGINES.md).
- [x] Replace the Qwen side engines with bundled llama.cpp for Qwen3.6 and
  Qwen3.8-27B, with a guarded resident owner; real 6/6 on each model,
  including Design, on llama.cpp `b11371`. On current `b11836`, Qwen3.6
  passed 6/6 again; Qwen3.8-27B has not been rerun.
  [Retirement record](../BUNDLED_ENGINES.md#retired-qwen-side-engines).
- [x] Add MLX for Qwen3.6 on Apple Silicon: offline wheels, pinned weight
  download, readiness check; real 6/6 with retained earlier failures.
- [x] Run Design on llama.cpp/MLX models with structured tool calls.
- [x] Add pi and OpenCode as Agent harnesses with pi-ds4 for DeepSeek, versioned
  patches, workspace confinement and a Settings pane; real 24/24 across four
  models. [Harness results](../HARNESSES.md).
- [x] Stream files being written (live tool-call previews) in Agent, Cowork,
  Design, pi and OpenCode on llama.cpp, MLX and ds4; real write-streaming checks
  pass on every path. [Results](../../tests/docs/engines-and-harnesses.md#streaming-and-live-tool-previews).
- [x] Fix llama.cpp/MLX starts in the desktop app (the server guard was not
  dispatched by the app binary); the bundle smoke now runs the guard test on it.
- [x] Prepare Linux/Windows llama.cpp builds (dynamic backends, Job Object,
  parent-death signal); cross-compiled, and the dynamic layout built and run on
  macOS.
- [x] Move Qwen Next onto unified main and record the Q4 baseline on main
  `0aaea5a`: 75/100 corpus answers and 8/8 long-context cases. These retained
  results do not qualify the current `890898c` pin.
  [Qwen evidence](../QWEN_CHECKPOINT.md).
- [x] Remove automatic elapsed-work cutoffs from model preparation, inference,
  PDF planning and Research, keeping Stop, count/byte/concurrency bounds and
  explicit Task Graph budgets.
- [x] Correct Research progress, streamed writer output and visible incomplete
  outcomes. [Remaining real-answer checks](../SEARCH_AGENT_QUALITY_PLAN.md).
- [x] Share transcript selection/scroll handling across modes and fix image,
  native-window and Learn/Tutor regressions; the simulated UI matrix passes
  54/54. [Coverage](../../tests/docs/ui.md#complete-simulated-ui-matrix).
- [x] Ship 25 offline Design systems with guides and recipes; 402/402 authored
  preview checks pass in Chromium/WebKit (no model ran).
  [Catalog](../DESIGN_SYSTEMS.md).
- [x] Offer DeepSeek V4.1 Flash 1017 Q2 (the official file) with its vision
  sidecar; each V4.1 checkpoint opens only with its own sidecar, and the
  original Q2 stays resumable. `make test-v41-vision-pairing-live` checks the
  real engine on published headers (no weights read, no inference).
- [x] Offer only the publishers' official weights; modified derivatives are
  refused and left untouched on disk.
- [x] Offer every published standard quantization of Qwen3.6-35B-A3B and
  Qwen3.8-27B on llama.cpp and MLX (63 variants) from one pinned catalog, with
  per-file size/SHA-256 verification; 27B on MLX is text only. Fixture-based
  checks only (`make test-qwen-variants`); no variant other than the defaults
  has run on real weights.
- [x] Update the bundled MLX to mlx 0.32.4 and mlx-lm 0.32.2: real offline
  install reaching Metal, and real Qwen3.6 MXFP8 tool-call streaming in Agent,
  Cowork and Design. Two earlier Design attempts failed on the test client's
  start limit; their receipts are kept.
- [x] Download every Qwen variant, the three original ones included, through
  one verified downloader (`scripts/download-qwen-variant.py`). Remove host
  routes and UI code that nothing called.
- [x] Keep patches only for the bundled engine revisions (ds4 main `890898c`,
  Laguna `448d569`): the variants for earlier main revisions and the retired
  Qwen Next fork, with its fixtures and tests, are deleted (about 19,000 lines).
  The patch stack applies and restores byte for byte on the bundled sources.
  [Patch notes](../../patch/README.md).
- [x] Restore Agent, Cowork and Design sessions on llama.cpp/MLX (and a LAN
  host) after a restart: the transcript is saved after every turn and `/switch`
  rebuilds it; old tool calls can never run again. Real runtimes across a
  restart with simulated model frames: `make test-remote-session`.
- [x] Refuse SSRF to the host's loopback from LAN devices, DNS rebinding and
  cross-site CORS; bound and protect LAN chat mirrors.
  `make test-http-lan` (real host, requests from the LAN address).
- [x] Read scanned PDF pages with local OCR on macOS; labelled pages, bounded
  work per read, cached readings, OCR line evidence. `make test-pdf-ocr`.
  Linux/Windows OCR: not implemented.
- [x] Raise Cowork comparison-table limits (5,000 rows, 128 columns, 100,000
  cells, 512 sources) with a content-addressed extraction cache.
  `make test-document-table-scale`.
- [x] Fix Cowork text-copy fidelity (a lost final newline); real A/B on
  DeepSeek V4 Flash Vision-Exp. [Results](../../extension/prompt-lookup/bench/README.md#follow-up-the-lost-final-newline-3-october-2026).
- [x] Cowork from a LAN browser through an explicitly shared, paired session.
  `make test-http-lan`, `tests/browser/ui_lan_cowork_playwright_test.mjs`.
- [x] Resume the pinned V4.1 Q2 and 1017 vision files over HTTP without Xet.
  Fourteen loopback HTTP checks pass; one real 365,713,686,528-byte 1017 Q2
  transfer resumed its existing partial and passed the pinned SHA-256. Model
  quality and the separate vision component remain independent requirements.
  [Evidence scope](../changes/2026-11-04.md).
- [x] **Breaking (October 27, 2026):** no backward compatibility with older
  installations. An engine at another revision, an older DStudio patch state
  (the former M2 Max batch-limit upgrade and Design label normalization), a
  leftover `ds4-qwen38`/`ds4-glm5.3` folder without a DStudio receipt or the old
  Qwen Next base + PLE files get no special handling or upgrade: they fail as
  drift or are treated like any other folder or file. Half-finished Qwen
  downloads from before this change do not resume (their staging folder is now
  `.dstudio-qwen-downloads`); partial files are left on disk. Reinstall the
  bundled engines and restart those downloads.

### Still required

- [ ] KV snapshots for llama.cpp/MLX sessions (a restored session is prefilled
  again), and saved sessions for pi/OpenCode on these models.
- [ ] Run the five representative real-weight checks of the newly downloadable
  Qwen variants (Qwen3.6 UD-Q4_K_M, UD-IQ4_XS and MXFP4_MOE GGUFs, Qwen3.6 MLX
  NVFP4, Qwen3.8-27B MLX 4-bit; about 98 GB) with the production-host gate,
  one at a time. **NOT RUN** yet (no weights downloaded for them).
  [Plan](../WORK_IN_PROGRESS.md).
- [ ] Rerun the 100-task corpus and the long requests on llama.cpp and MLX
  (published Qwen3.6/27B scores come from retired engines). Revalidate Next on
  current main `890898c`; its Q4 baseline belongs to `0aaea5a`, and Q2 needs
  independent qualification.
- [ ] Run pi/OpenCode with GLM, Laguna, Qwen3.8-Flash-Next, DeepSeek V4.1 and a
  cloud endpoint, and qualify Plan/GSA/RSA with them.
- [ ] Complete Agent/Cowork dependency signatures, crash-safe runtime-pair
  publication and verified legacy-source recovery.
- [ ] Complete Learn/Tutor, including on the llama.cpp/MLX models, and the
  retained Next reasoning-setting incident.
- [ ] Complete selected-model Agent/Goals/Cowork long tasks, steering,
  pause/resume, durable recovery, exactly-once effects and reopened exports.
- [ ] Independently qualify native PDF/vision inputs (at least 30 PDFs and 20
  images per vision checkpoint, negative text-model cases) across all modes.
- [ ] Complete the native-model desktop workflows (each model × Chat, Agent,
  Learn, Cowork, Design), switching, cancellation and final-build regressions.
- [ ] Qualify the remaining Design domain auditors and generate, operate and
  review the frozen projects; add generated-project qualification for the
  sixteen newer Design systems.
- [ ] Complete installation/upgrade/failure/recovery coverage and final engine
  admission with qualifying receipts for every required gate.
- [ ] Complete held-out Search/Research evaluation and native-vision webpage
  checks.
- [ ] Qualify DeepSeek V4.1 1017 Q2, V4.1 Q4 and GLM 5.3 across modes, vision,
  memory and SSD settings. The original Q2's retained format failure does not
  transfer to the 1017 file. **Contributor hardware wanted:** on the maintainer's
  M2 Max (96 GB) they run only with SSD streaming and their complete
  qualification is left to contributors; they stay BLOCKED, not passed.
  [How to help](../../PLAN.MD#contributors).
- [ ] Complete the six-agent/two-lane comparison with held-out cases, phase
  profiling, matched baselines and reviewed Matplotlib publication.

### Separate platform and media roadmap

These items are outside the macOS/Apple Silicon language-model campaign and do
not enter its acceptance denominator. They remain open and are not qualified
by macOS builds or the existing model checks.

- [ ] Run Linux, Windows, CUDA, ROCm and Vulkan for real; make pi/OpenCode
  available on Windows. Linux/Windows OCR remains unimplemented.
- [ ] Validate the two-photo MiniMax H3 path end to end.

### Proposed modules and improvements (not started)

Candidates added October 25, outside the campaign; what exists today and what
is missing for each is in [PLAN.MD](../../PLAN.MD#proposals).
The base Chat prompt review was added as a proposal on November 4; its rewrite
and real-model comparison have not started.

- [ ] Guards for the pi/OpenCode harnesses: duplicate-call breaker, read-only
  Plan mode and mid-turn steering.
- [ ] Disk KV slots for llama.cpp and an MLX prefix cache.
- [ ] A pre-action reasoning budget that pauses with a clarifying question.
- [ ] Constrained JSON for structured internal steps, per engine.
- [ ] A read-only local state audit in Doctor.
- [ ] Independent edit receipts and restore for Office files in Cowork.
- [ ] A stream integrity check, report-only first.
- [ ] A mastery ledger with graded assessments in Learn.
- [ ] An import/include index and JSON Canvas export for Open Blueprint.
- [ ] A PDF ↔ web claim agreement matrix in Search.
- [ ] Conversation branches instead of a destructive Regenerate.
- [ ] An opt-in watched drop folder for Cowork.
- [ ] Simplify the base Chat prompts and compare them on held-out tasks while
  preserving math, file and media contracts and effective model capabilities.

Private prompts, documents, transcripts, weights and raw receipts remain
ignored. Publishing this checkpoint does not qualify any unchecked requirement.
