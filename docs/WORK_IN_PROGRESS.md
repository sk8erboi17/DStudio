# Remaining work — November 10, 2026

The macOS/Apple Silicon campaign is incomplete. On November 10 the owner
resumed it: complete every item below, then the final simplification step.
[PLAN.MD](../PLAN.MD) is the canonical detailed acceptance list; this page is
its short index. A documentation, download-integrity or simulated UI pass does
not close a model-quality gate.

## Remaining implementation

| Workstream | Detailed acceptance requirements |
| --- | --- |
| Campaign census, sources and build admission | [P0](../PLAN.MD#p0--complete-the-baseline-and-campaign-census), [P2](../PLAN.MD#p2--complete-engine-alignment-and-admission) |
| Startup, lifecycle, installation and crash recovery | [P1](../PLAN.MD#p1--finish-startup-and-lifecycle-acceptance), [P5](../PLAN.MD#p5--extend-installation-upgrade-and-recovery-coverage) |
| Model adapters, disk KV reuse and harness sessions | [P3](../PLAN.MD#p3--finish-adapters-and-per-model-mode-parity) |
| PDF, vision and negative text-model cases | [P4](../PLAN.MD#p4--complete-pdf-vision-and-text-model-isolation) |
| Answer quality, Learn/Tutor, long tasks and steering | [P6](../PLAN.MD#p6--complete-numerical-answer-and-product-quality) |
| Native desktop and generated Design projects | [P7](../PLAN.MD#p7--complete-the-real-desktop-matrix), [P8](../PLAN.MD#p8--finish-the-design-auditor-and-generated-project-matrix) |
| Agent comparisons, profiling and final publication | [P9](../PLAN.MD#p9--complete-six-agent-comparisons), [P10](../PLAN.MD#p10--profile-and-retain-justified-optimizations), [P11](../PLAN.MD#p11--qualify-the-final-build-and-reviewed-publication) |
| Final step: remove unnecessary complexity and really useless tests, with every usage case tested before and after | [P12](../PLAN.MD#p12--remove-unnecessary-complexity-and-prove-nothing-regressed) |
| After everything above: rewrite the README and re-record every GIF and screenshot with headless Playwright and ffmpeg | [P13](../PLAN.MD#p13--rewrite-the-readme-and-re-record-every-gif-and-screenshot) |

## Remaining verification and retained failures

The exact failures and rerun requirements stay in [the plan's quality gates](../PLAN.MD#p6--complete-numerical-answer-and-product-quality)
and its [startup regressions](../PLAN.MD#p1--finish-startup-and-lifecycle-acceptance). Model-specific results remain in the
[Qwen checkpoint](QWEN_CHECKPOINT.md) and [V4.1/GLM checkpoint](DS41_UPDATE_CHECKPOINT.md).
Historical scores qualify only their recorded engine/model/configuration;
changing a bundled pin does not transfer them. The [engine admission matrix](ENGINE_UPSTREAM_ALIGNMENT.md)
tracks missing release receipts separately from test outcomes.
The common-100 results reviewed so far are published, with their charts and
failures, in [the campaign report](benchmarks/quality-multihardware/README.md):
seven selections measured (every one that runs on this machine), none at
the required 100/100. That gate measures the models; it closes as a
documented FAIL unless a model passes it ([why](../PLAN.MD#closure)).

### Pinned Qwen variants: five representative checks (NOT RUN)

The required variants, IDs, download sizes and production-host gate are listed
in [PLAN.MD](../PLAN.MD#qwen-variants). These checks remain NOT RUN; downloadable
catalog entries and fixture passes are not real-weight verification. The
requirements and their full denominator are unchanged.

## DeepSeek V4.1 1017 Q2: back in the maintainer's plan, SSD streaming only

On November 10 the owner returned DeepSeek V4.1 Flash 1017 Q2, and only that
checkpoint, to the maintainer's execution plan, with expert SSD streaming
only. It is no longer BLOCKED and is not run yet. A result qualifies that
memory mode on that Mac only. The conditions are in
[PLAN.MD](../PLAN.MD#v41-ssd); no run was started.

## Contributor hardware wanted

GLM 5.3 and every other V4.1 configuration remain in scope with BLOCKED
contributor qualification. Hardware, effective memory/SSD settings, frozen
cases and the evidence contract are in
[PLAN.MD](../PLAN.MD#contributors). A result from another machine qualifies that
configuration, not an untested configuration on the maintainer's Mac.

## Proposed modules and improvements (not started)

The candidates are maintained in [PLAN.MD](../PLAN.MD#proposals). They are outside
the completion campaign; none was started by consolidating these documents.

## Scope and separate product roadmap

The included macOS Metal selections are defined in [the campaign scope](../PLAN.MD#scope).
Non-macOS hardware/backends remain outside that denominator and unqualified:
Linux/Windows, CUDA/ROCm/Vulkan, Windows pi/OpenCode and Linux/Windows OCR.
[Two-photo MiniMax H3](../README.md#local-video-generation-minimax-h3) still needs
actual end-to-end validation. The separate [quality roadmap](QUALITY_GATES.md#roadmap)
retains visual-diversity/independent review, latency baselines and signed
release-summary work. These roadmaps do not authorize new platform/media runs.

## Current sources and historical evidence

- [Bundled source pins and provenance](BUNDLED_ENGINES.md).
- [Engine admission](ENGINE_UPSTREAM_ALIGNMENT.md) and [test guides](../tests/README.md).
- [Dated reports and archived plans](history/README.md), including the
  [former README checkbox list](history/readme-checklist-2026-11-04.md).
- [November 4 implementation and scoped checks](changes/2026-11-04.md).
- [November 5 Learn audit and shared history corrections](changes/2026-11-05.md).
- [November 6 Learn evidence retrieval and final-project scope](changes/2026-11-06.md).
- [November 8 Learn graph edits, draft access and bounded recovery](changes/2026-11-08.md).
- [November 10 Learn workspace, messages during generation and resume](changes/2026-11-10.md).
- [November 10–11 campaign resumed: baseline, coordinator, first corpus results](changes/2026-11-11.md).

Private documents, prompts, transcripts, weights, personal paths and raw test
artifacts remain ignored. An unfinished, failed or blocked requirement cannot
disappear from its denominator when a summary is shortened.
