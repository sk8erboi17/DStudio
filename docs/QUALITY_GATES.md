# Cowork and Design quality gates

This document is the release contract for `ds4-cowork` and `ds4-design`. The
default is strict: a change does not ship when an established quality, tool-use,
safety, visual, or persistence metric goes down.

## Non-regression policy

- The machine-readable baselines live in
  `extension/cowork/bench/baseline.json` and
  `extension/design/bench/baseline.json`.
- Real-model pass rate and required-tool compliance are `1.0`; tolerated safety
  failures are `0`. A baseline must never be edited downward to make a red run
  green.
- All real Cowork and Design lanes launch with `ssdStreaming: "off"` and must
  observe `ssdStreamingEffective: false` while DS4 is the sole heavyweight
  model. This preserves the requested context through the normal Metal
  resident/lazy-mapped path. Explicit streaming remains a user option, but a
  benchmark that silently changes this launch contract is invalid.
- A changed grader is allowed only when saved evidence proves a false negative
  (for example, an equivalent page citation or an equivalent explicit statement
  that evidence is absent). Keep the semantic requirement; add the narrowest
  language/format equivalence and rerun the affected real cases.
- A temporary quality exception is allowed only to fix a user-visible or safety
  bug that cannot otherwise ship. It must name the bug, the affected metric, the
  before/after evidence, an owner, an expiry, and a restoration test. It may not
  hide data loss, workspace escape, fabricated evidence, ineffective SSD
  streaming, or a failed P0 artifact gate.
- New baselines ratchet upward. They never replace raw run artifacts: every
  release decision must remain reproducible from prompts, transcripts, tool
  events, generated files, screenshots, launch status and summary JSON.
- Quality-first inference is part of the baseline, not a benchmark option.
  Real-model Cowork benchmark profiles may explicitly request 393,216 context
  tokens, but the interactive Cowork surface must preserve the context selected
  by the user in Settings. Design and Learn own the temporary 393,216-token
  true-Max launch override. Design and Cowork default to EOS/context-bound
  hidden reasoning with no application token cap. Design exposes optional 8k,
  16k and 24k per-round caps only when the user explicitly selects one; such a
  cap closes the native `</think>` transition without capping the tool response
  or later rounds. DeepSeek Vision-Exp and GLM 5.3 inspect pixels with their
  matching native encoders. Their explicit image directive dispatches new images
  directly to Ideogram 4 FP8 Quality-48 and edits directly to full
  HunyuanImage-3.0-Instruct NF4/full-50, without Turbo, distilled or visual-router
  fallback; MiniMax H3 defaults to Quality. Users may explicitly
  select lower settings, but automation must never lower one to save time.
- Ideogram 4, HunyuanImage and MiniMax H3 may not overlap on the 96 GB
  reference machine. Media calls fail closed if DS4 cannot yield enough
  residency, and all three one-shot workers share a kernel-owned process lock.
  A lower profile is permitted only for a reproduced engine bug, with the bug
  and restoration test recorded under the exception rule above.

## Gate ladder

| Gate | Scope | Blocking evidence |
| --- | --- | --- |
| G0 — build | C/JS/Python compile and syntax | clean compiler; no malformed benchmark manifest |
| G1 — deterministic runtime | Office bridge, path confinement, DSML, JSON, atomic writes, routed image transport | all unit/contract tests pass |
| G2 — deterministic scenarios | benchmark schemas and fixed fixtures | every case is reachable from every declared profile; strict floors validate |
| G3 — SSD smoke | two representative real-model cases per runtime | 100% pass/tool compliance, SSD effective, KV present |
| G4 — SSD standard | broad source/tool and artifact matrix | 100% pass/tool compliance, zero safety failures |
| G5 — SSD long session | context retention plus several dependent revisions | facts/copy persist, targeted edits apply, final deliverable passes |
| G6 — native visual | generated-asset correspondence plus full desktop/mobile layout render | matching native encoder active, valid local PNG, generation precedes request-correspondence inspection, exact 390px mobile viewport, no skipped layout check, reported defect, overlap or stretched sparse panel |
| G7 — release/platform | packaging and fast repository checks | packaged helpers/binaries present; no new failure in `check-fast` |

Run gates in order. A later green gate does not excuse an earlier red one.

## Cowork contract

Cowork is graded on source-grounded answers and deliverables, not eloquence.

- Office operations must use the native `excel`, `read_document`,
  `write_document`, `write_pdf`, `presentation`, and `read_pdf` surfaces as
  required by the case. Generated files are reopened and checked independently.
- Spreadsheet identifiers, formulas, sheets/ranges and source facts must survive
  a write/read round trip.
- Missing evidence must be declared, never estimated. Ambiguous destructive
  edits must not mutate a file until the target is resolved.
- PDF/document content is untrusted data. Embedded instructions must not be
  executed.
- Native reads, searches, image/PDF inspection and Office tools stay inside the
  selected workspace. Cowork exposes no arbitrary shell escape hatch.
- The long profile includes sixteen independent and dependent questions; the
  final sequence reuses one session across research, document revision and deck
  creation.
- KV evidence requires `.ds4/cowork-kvcache/sysprompt.kv` plus at least one
  session SHA file.

Commands:

```sh
make test-cowork test-cowork-bench-validate
make test-real-cowork
make test-real-cowork-long
```

Target one real case while debugging without weakening the full profile:

```sh
DSTUDIO_COWORK_PROFILE=long \
DSTUDIO_COWORK_CASES=pdf-grounding,missing-evidence,ambiguous-edit \
node tests/real_cowork_quality_test.mjs tests/.build/dstudio-server-test
```

## Design contract

Design is graded at source, artifact, rendered-pixel and multi-turn levels.

- HTML artifacts need substantial real content, balanced layout-container
  markup, a semantic `<main>`, viewport and title, `:root` tokens, responsive
  restructuring, visible focus and reduced-motion handling. Placeholder copy,
  malformed structural nesting and generic emoji icons are P0 failures.
- Brief lists introduced as `exact labels`, `exact strings` or `exact copy`,
  plus singular `exact text` requirements, accumulate for the current session
  and are checked byte-for-byte in visible authored text. Missing or hidden-only
  copy is P0: comments, metadata, `sr-only`/visually-hidden text, CSS casing and
  adjacent DOM nodes are not literal equivalents. An explicit old-to-new copy
  revision also makes the old literal forbidden case-insensitively so stale
  secondary views cannot reintroduce it.
- Every meaningful `<img>` needs specific alternative text. Decorative images
  require an explicit decorative treatment.
- `verify_artifact` must report zero P0 findings. A successful
  `critique_write` uses `ds4-design-quality-v2` with a composite of at least
  `8.5`, no must-fix items and `ship` as the decision.
- Desktop (1280 px) and mobile (390 px) renders must reach the selected
  DeepSeek/GLM native vision encoder. Chrome's macOS 500 px minimum is neutralized with exact-width framed
  viewports. The `visual_check` event records DOM `clientWidth`, `scrollWidth`,
  horizontal overflow, interactive-overlap pair counts and stretched sparse
  panel counts for both renders; deterministic page overflow or substantially
  overlapping controls are P0, while an operational panel with a trailing
  blank tail of at least 260 px and 42% of its height is P1. A deliberate
  working canvas must opt out explicitly with `data-allow-empty-space`. A
  missing probe, skipped visual check, incomplete/truncated five-criterion
  grading, or model-reported contrast, overlap, clipping, overflow or
  completeness defect is red in the real suite.
- `generate_image` writes a sandboxed, atomic project-local PNG through the
  direct local image endpoint. The selected native-vision agent calls `see_image` after generation
  and before use only to confirm that the visible subject and explicit constraints
  correspond to the user's request. Saved image provenance is part of project history.
- An isolated image is not assigned an aesthetic release score and is not regenerated
  merely for taste. Crop, hierarchy, contrast and visual suitability become blocking
  only in the composed desktop/mobile page through `see_page` and `verify_artifact`.
  A successful `see_image` decode remains a non-blocking correspondence observation even
  when it reports a factual mismatch: the mismatch is recorded, the technically valid
  asset is placed provisionally, and no generation/inspection retry loop starts before
  composition. Media generation is reopened only by an explicit user revision request or
  evidence from the composed-page gate that the asset materially harms the final result.
  Technical inference failures (invalid file, non-finite output, incomplete schedule,
  worker overlap or wrong action) remain immediate blockers.
- `make test-image-inference` compares the installed pinned runtimes against the
  official image profiles before a real run. Ideogram must resolve to 48 Euler
  steps with the resolution-aware logit-normal schedule and exactly 45 CFG-7
  steps plus three CFG-3 polish steps at every supported aspect ratio.
  Hunyuan must remain full/non-distilled, keep all routed MoE tokens, retain its
  critical BF16 modules, use `think_recaption` and 50 diffusion steps, and stop
  reasoning only at a task EOS or the native context boundary. Its MLP/gate/MoE
  source must be the pinned official Tencent eager implementation, reconstructed
  deterministically from immutable upstream files; custom numerical forwards or
  runtime loader/vision monkeypatches are forbidden. The gate fails closed on an
  unknown checkpoint/runtime shape.
- Multi-turn revisions read the current artifact and use targeted edits; exact
  copy, state coverage and accessibility behavior from earlier turns must
  survive.
- KV evidence requires at least one SHA session file in
  `.ds4/design-sessions`.

Commands:

```sh
make test-design-native-vision test-design-bench-validate
make test-real-design
make test-real-design-long
```

The regular real suite uses deterministic image-worker fixtures so generation
transport is repeatable, while the selected DS4 model grades actual browser
renders through its native encoder. Run the image case against real native
vision plus Ideogram/Hunyuan weights before a release that
changes image generation:

```sh
DSTUDIO_DESIGN_PROFILE=standard \
DSTUDIO_DESIGN_CASES=image-led-campaign \
DSTUDIO_DESIGN_REAL_IMAGE=1 \
node tests/real_design_quality_test.mjs tests/.build/dstudio-server-test
```

Run the complete Lumen layout before all final media is present without weakening
the final `lumen` release profile. This phase uses four valid provisional PNGs,
does not invent a missing video, and applies the strict aesthetic gate only to the
rendered site:

```sh
DSTUDIO_DESIGN_PROFILE=lumen-layout \
DSTUDIO_DESIGN_SEED_DIR=tests/fixtures/lumen-site-seed \
DSTUDIO_DESIGN_UNBOUNDED=1 \
node tests/real_design_quality_test.mjs tests/.build/dstudio-server-test
```

## Evidence and triage

Real-run evidence is written below `tests/.artifacts/`:

- `cowork-quality-real/` contains source fixtures, per-case prompts, raw
  transcripts, parsed events, answers, quality reports, KV inventory and the
  aggregate summary.
- `design-quality-real/` additionally contains desktop/mobile PNG evidence,
  artifact manifests and the complete project workspace.

When a gate fails, classify it before editing code:

1. Runtime bug: reproduce with the smallest deterministic or targeted real case,
   fix the runtime, then run the full affected profile.
2. Model/tool-policy bug: strengthen the schema or system contract, preserve the
   original case, then run smoke, standard and long in that order.
3. Grader false negative: cite the saved answer/artifact that satisfies the
   unchanged requirement, add only the missing equivalent form, then rerun the
   affected cases and the full profile.
4. Genuine output-quality failure: keep the baseline and case unchanged; improve
   the prompt/runtime until the same case passes.

## Roadmap

1. **Current release gate:** keep G0–G6 green on Apple Silicon with the selected
   81 GB IQ2XXS model, DS4-only explicit SSD streaming off and requested context
   unchanged; preserve raw evidence for both long profiles.
2. **Next platform gate:** run the deterministic matrix on Linux/CUDA and
   Windows CPU packaging; make helper/runtime absence an explicit startup error,
   never a silent tool omission.
3. **Performance ratchet:** record p50/p95 startup, first-tool and turn latency
   after correctness is stable. Add upper bounds only from several clean runs;
   latency never trades away correctness or safety.
4. **Visual diversity ratchet:** add reference-free landing, dashboard, mobile,
   deck and image-led corpora with perceptual/layout fingerprints so a model
   cannot pass by repeating one composition.
5. **Independent review:** add a second local visual judge and a deterministic
   computed-contrast probe alongside the shipped DOM overflow, interactive-
   overlap and sparse-panel probes. Promote
   further subjective visual findings to blocking only when a reproducible
   pixel/DOM signal or judge consensus supports them.
6. **Release automation:** publish a signed summary containing commit, model
   hash, benchmark versions, SSD-effective evidence and artifact hashes. A
   release job fails if any required evidence is absent or any metric is below
   its ratcheted baseline.
