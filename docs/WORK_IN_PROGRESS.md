# Remaining work — October 25, 2026

The full macOS/Apple Silicon campaign is incomplete and paused. This backlog
contains unfinished work only; completed tranches and their original failed
attempts are retained in [the archived WIP](history/wip-through-2026-09-30.md).
Updating these documents does not resume implementation or the owner-controlled
complete quality rerun.

## Remaining implementation

| Area | Work still required |
| --- | --- |
| Qwen Design | Design runs on the llama.cpp Qwen3.6/27B and the MLX Qwen3.6 with structured tool calls (development checks only, October 3). Implement and qualify the independent adapter for Qwen3.8-Flash-Next and qualify Design on every Qwen path. Keep unsupported launches explicit. |
| Disk sessions | Done October 3: Agent, Cowork and Design on llama.cpp/MLX save their transcript and restore it after a restart (`make test-remote-session`; the server prefills it again). Still open: bounded KV snapshot reuse across engine restarts (candidate route: llama-server slot save/restore, [proposal 2](../PLAN.MD#proposals)), and pi/OpenCode sessions on these models. |
| Agent/Cowork builds | Complete dependency signatures, coordinated crash-safe runtime-pair publication and verified legacy-source recovery. |
| llama.cpp / MLX Qwen | Common-100, long context, Learn/Tutor and PDF on llama.cpp `f5027fb` (`b11836` since October 23: Qwen3.6 passed the six development checks again, Qwen3.8-27B not yet rerun) and on the MLX Qwen3.6 (implemented October 3: native Agent/Cowork/Design/Chat 6/6, pi/OpenCode 6/6; a quality comparison with the GGUF is not done); untested non-macOS backends. |
| Design auditor | Qualify the remaining fourteen domain scenarios with independent positive/negative fixtures. |
| Agent comparisons | Implement the actual Codex/Responses runner and parameter/protocol validation. |
| Campaign coordination | Finish current-build/path/case inventory and the complete matrix coordinator/public report. |

## Remaining verification and retained failures

| Area | Work still required |
| --- | --- |
| 27B / 3.6 | Common-100 and the original long-context checks on llama.cpp and on MLX, with model/quant-specific numerical references. The published 61/100 and 63/100 and the online-attention/batched-prefill overlays belonged to the retired engines; reruns remain owner-controlled. |
| Qwen Next | Complete Learn/Tutor, PDF/vision and native-desktop qualification; qualify Q2 independently. Recheck the retained Learn incident with the intended effective reasoning request. The Q4 100-case and eight long-context cases are already recorded in the current-main baseline. |
| Agent / Goals / Cowork | Real selected-model long tasks, steering, pause/resume, durable recovery, exactly-once effects and independently reopened exports across all selections. Revalidate the retained 3.6 timeout/partial-summary failure on current code. Cowork on DeepSeek V4 Flash Vision-Exp IQ2XXS: resume profile 2/2. Long profile 10/11 so far: `ambiguous-edit` failed in a reasoning loop; a second sample was stopped. Five long cases have not run. Rerun them on runtime v106, which no longer declares the refused shell tools; a reasoning-budget pause is [proposal 3](../PLAN.MD#proposals). |
| PDFs / vision | At least thirty PDFs and twenty images per vision checkpoint, independently graded answers, actual pixel paths and negative text-model/history/cache tests in all four modes. |
| Desktop | Ten selections × Chat/Agent/Learn/Cowork: at least forty complete native-model workflows, plus Design, switching, errors, cancellation and final-build regressions. |
| Design projects | Generate and independently audit all eighteen frozen projects for the original nine systems in Chromium/WebKit, both themes, four widths, 200% text, offline exports and the opaque preview. Preserve and regenerate failed model outputs through the runtime. |
| Install / upgrade | Extend verified bundled/offline installation (main, Laguna, llama.cpp builds; MLX from its bundled wheels) to full current engine/mode/failure/recovery coverage and the final bundle. The retired q36 upgrade evidence does not carry over. |
| Engine admission | Complete applicable source reviews and bind exact qualifying receipts. The nine-target matrix currently has 107 required gate slots (117 before the Qwen targets moved to llama.cpp) and zero linked receipts; these are unfilled evidence requirements, not 107 failed tests. MLX, the tenth selection, has no target yet. |
| Search / Research | Held-out source-grounded answer evaluation beyond development questions, actual vision-model webpage checks and real validation of the retained writer incident after the software corrections. |
| V4.1 / GLM | Not in the maintainer's execution plan: on the maintainer's M2 Max (96 GB) they run only with SSD streaming and only limited runs exist. Kept in scope as BLOCKED; a contributor with suitable hardware can take them on ([how](../PLAN.MD#contributors)). Since October 22 the Q2 selection is the official 1017 checkpoint with its own vision sidecar; the original Q2's retained format failure stays FAIL for that file and does not transfer. Complete 1017 Q2 and Q4 mode/quality/vision/SSD-Engram qualification; GLM's matching 100 continuations, vision and complete product qualification. |
| Comparisons / profiling / release | Six agents/two lanes, at least seventy cases and three repetitions; correct matched baselines, phase profiling, final build admission and reviewed Matplotlib publication. |

### Pinned Qwen variants: five representative checks (NOT RUN)

Since October 25 every standard published quantization of Qwen3.6-35B-A3B and
Qwen3.8-27B is downloadable: 63 variants on llama.cpp and MLX, pinned in
[scripts/qwen-variants.json](../scripts/qwen-variants.json)
([details](../PLAN.MD#qwen-variants)). Q6_K_XL and MXFP8 stay the campaign's
qualification selections. The other variants share the engine, tokenizer, chat
template and tool format of a checked variant but use other quantization
kernels (and the split BF16 another loading path and about 69 GB of memory), so
they are downloadable but not individually verified. Their fixture-based checks
(`make test-qwen-variants`) cover download, recognition, routing and refusals,
not inference.

The verification plan is five real-weight checks with the production-host
development gate (`make test-llama-resident-live DSTUDIO_LLAMA_MODELS=<id>`),
run one at a time, about 98 GB of downloads in total instead of one check per
other variant (60 checks, about 1.4 TB). All five are required:

| # | Variant (id) | Download | Represents | Status |
| --- | --- | ---: | --- | --- |
| 1 | Qwen3.6-35B-A3B UD-Q4_K_M GGUF (`qwen36-q4_k_m`), downloaded through the new generic downloader | 22.1 GB | K-quant kernels on the new download path | NOT RUN |
| 2 | Qwen3.6-35B-A3B UD-IQ4_XS GGUF (`qwen36-iq4_xs`) | 17.7 GB | i-quant kernels | NOT RUN |
| 3 | Qwen3.6-35B-A3B MXFP4_MOE GGUF (`qwen36-mxfp4_moe`) | 21.7 GB | MXFP4 MoE kernels | NOT RUN |
| 4 | Qwen3.6-35B-A3B MLX nvfp4 (`qwen36-mlx-nvfp4`) | 20.4 GB | MLX nvfp4 mode | NOT RUN |
| 5 | Qwen3.8-27B MLX 4bit (`qwen27-mlx-4bit`) | 16.1 GB | the new 27B-on-MLX combination (affine mode, text only); the gate also checks that an image request is refused | NOT RUN |

They are NOT RUN. Disk space no longer blocks them (about 586 GiB free on
October 25), but no weights have been downloaded for them yet. No variant other
than the defaults has run on real weights; none of these results exists yet,
and a pass will cover only its own variant.

One earlier WebKit Design gallery-filter clearing failure is unresolved: it did
not reproduce in unchanged focused or later complete simulated matrices, so
there is no established causal fix. Retain the failed receipt and reproduce
before changing production or weakening the test. The final simulated UI
matrix is documented in [tests/README.md](../tests/README.md); it does not
substitute for native-model desktop qualification.

The catalog now includes 25 systems. The 16 added systems need their own future
generated-project briefs/oracles and model qualification; the frozen 18-project
corpus does not cover them. Their authored browser checks are separate.

## Contributor hardware wanted

The maintainer (Giuseppe Perrotta) runs the campaign on an Apple M2 Max with
96 GB. These selections run there only with SSD expert streaming and only
limited runs exist, so their complete qualification is outside the
maintainer's execution plan; they remain open and BLOCKED, not passed:

| Selection | Size on SSD | Remaining work |
| --- | ---: | --- |
| DeepSeek V4.1 Flash 1017 Q2 | 365.7 GB + 0.97 GB vision | Modes, 100-case corpus, vision, memory/SSD/Engram, install/recovery, desktop |
| DeepSeek V4.1 Flash Q4 | 518.6 GB + 0.97 GB vision | The same, independently of Q2 |
| GLM 5.3 Flash Q2 | 96.5 GB + 1.1 GB vision | 100 continuations, answers, vision, product matrix, desktop |

A contributor with an Apple Silicon Mac that can run them is welcome to; the
pins, evidence contract and reporting rules are in
[PLAN.MD](../PLAN.MD#contributors).

## Proposed modules and improvements (not started)

Added October 25. These are candidates outside the campaign; starting one is
the owner's decision. What exists today and what is missing for each is in
[PLAN.MD](../PLAN.MD#proposals).

| # | Proposal | Mode |
| --- | --- | --- |
| 1 | Guards for pi/OpenCode: duplicate-call breaker, read-only Plan, mid-turn steering | Agent |
| 2 | Disk KV slots for llama.cpp, MLX prefix cache | All on Qwen |
| 3 | Pre-action reasoning budget with a clarifying pause | Cowork, Design, Agent |
| 4 | Constrained JSON for structured internal steps, per engine | Search, PDF, Learn |
| 5 | Read-only local state audit in Doctor | All |
| 6 | Independent edit receipts and restore for Office files | Cowork |
| 7 | Stream integrity check, report-only first | Chat, Search, Learn, Cowork |
| 8 | Mastery ledger and graded assessments | Learn |
| 9 | Blueprint import/include index and JSON Canvas export | Agent |
| 10 | PDF ↔ web claim agreement matrix | Search, Cowork |
| 11 | Conversation branches instead of destructive Regenerate | Chat, Learn |
| 12 | Opt-in watched drop folder | Cowork |

## Scope and separate product roadmap

The ten included macOS Metal selections and exact acceptance criteria are in
[PLAN.MD](../PLAN.MD). Only Vision-Exp remains among the old DeepSeek V4 Flash
variants. V4.1 Q2/Q4 and GLM are left to contributors: they are not in the maintainer's
execution plan and stay in every denominator as BLOCKED.
Since October 25 the MLX Qwen3.6 MXFP8 path is the tenth selection; its results
do not qualify the GGUF, nor the reverse.
Non-macOS hardware/backends are excluded, not blockers or inferred passes.

Outside this campaign, [two-photo MiniMax H3](../README.md#local-video-generation-minimax-h3)
still needs actual end-to-end validation. The separate
[quality roadmap](QUALITY_GATES.md#roadmap) retains visual-diversity/independent-
review work, latency baselines and signed release-summary automation.
Those items do not authorize media runs or a new platform campaign.

## Current sources and historical evidence

- [Qwen remaining work and retained corpus receipts](QWEN_CHECKPOINT.md).
- [Engine/V4.1 remaining work](DS41_UPDATE_CHECKPOINT.md).
- [Engine release admission](ENGINE_UPSTREAM_ALIGNMENT.md) and
  [bundled-source provenance](BUNDLED_ENGINES.md).
- [Complete remaining plan](../PLAN.MD) and
  [archived plan/evidence](history/plan-through-2026-10-01.md).
- [Test commands, prerequisites and final simulated UI receipt](../tests/README.md).

Private documents, prompts, transcripts, weights, personal paths and raw test
artifacts remain ignored. A removed completed task retains its evidence; an
unfinished, failed or blocked requirement cannot disappear from its denominator.
