# DStudio upstream patches

This directory contains DStudio's explicit adaptations for managed runtimes
and separately identified engine candidates.

The Qwen3.6 and Qwen3.8-27B engines are the bundled, unmodified llama.cpp
`b11836` (`f5027fb`); DStudio applies no patch to it. The earlier q27, q36 and
vagrillo/ds4 Qwen3.6 patch sets (`q27-metal-delta`, `q36-*`, `ds4-qwen35-*`)
were retired with those engines on October 3, 2026. Git history and
`docs/history/` retain them; no current installer or test applies them.

The third-party harnesses have their own versioned patches, applied by
`scripts/install-harness.py` after `git apply --check`:
[`harness-pi-ds4`](harness-pi-ds4/README.md) (use a host-owned ds4-server
instead of cloning, building and starting one) and
[`harness-opencode`](harness-opencode/README.md) (the workspace, not the
enclosing git repository, is the file boundary and the workspace root the
model is told about). `make test-harness-patches` exercises apply, repeat,
reverse and drift.

The bundled MLX runtime for Qwen3.6 on Apple Silicon (unmodified PyPI wheels in
`src/engines/mlx/`) has three patches, applied in this order by
`scripts/install-mlx.py` to the installed `mlx_lm/server.py`:
[`mlx-lm-single-model`](mlx-lm-single-model/README.md) (the server serves only
the model DStudio admitted and reports readiness only after it has loaded),
[`mlx-lm-reasoning-content`](mlx-lm-reasoning-content/README.md) (reasoning is
sent as `reasoning_content`, the field every DStudio client reads) and
[`mlx-lm-tool-streaming`](mlx-lm-tool-streaming/README.md) (Qwen tool calls
stream while they are generated, exactly as the upstream parser would return
them). Each is inactive unless DStudio sets its environment variable.
`make test-mlx-install-unit` exercises apply, repeat, reverse and drift on the
wheel's own `server.py`.

[`ds4-v41-vision-pairing`](ds4-v41-vision-pairing/README.md) (antirez/ds4 PR
#1225: a V4.1 vision sidecar pairs with the language GGUF by
`general.source.revision` rather than one hard-coded checkpoint; applied by
`scripts/apply-ds4-v41-vision-pairing.sh` after the vision-streaming patch and
a no-op once upstream has the change).

Agent/Cowork patch **92** and `ds4-server-pld/` share
[prompt lookup](ds4-agent-jsonl/PLD.md), with ordinary
generation as the default reference path and an explicitly experimental Metal
batch verifier. The normal ds4 engine/server objects remain untouched.
Chat launches the derived `ds4-server-pld` on supported source revisions; its
temporary source is removed after compilation, including on failure. Older
server ABIs retain the native server. The prefix-conditioning object is linked when supplied by upstream; older
Laguna builds retain their original Agent loop and lack that separate module.

[Agent/Cowork](ds4-agent-jsonl/README.md) now uses complete `.patch` variants,
with exact base revisions and migration hashes in
[`bases.json`](ds4-agent-jsonl/bases.json). Its previous 154 `.find`/`.replace`
files were removed after native-output parity and real compile/tool checks.
[Web helpers](ds4-web-runtime/README.md) and [Chat PLD](ds4-server-pld/README.md)
also use complete `.patch` deltas with pinned bases and frozen-output checks.
The native host no longer loads ordered `.find`/`.replace` edits or treats a
marker as proof that a web patch is complete. Other native extensions use
unified patches through dedicated scripts. Missing or drifted inputs fail explicitly.

Every patch set now carries only the variants for the engine revisions DStudio
bundles: ds4 main `0aaea5a` and Laguna `448d569`. Variants for earlier main
revisions (`c0a6119`/`f62ca29`, `f4d03f6`, V4.1 `bd66c40`, the unified-main
`9139e2a` server and runtime layouts) and for the retired Qwen Next fork
(`b4c3550`, `ff4f0ff`, `bd9cfbc`) were removed on October 27, 2026, together
with the fork-only `ds4-qwen38-inspect` and `ds4-qwen38-snapshot` sets and
their historical source fixtures; Git history keeps them. An installed checkout
at another revision is refused with a drift error instead of being patched:
reinstall the bundled engine. Patch 87 preserved the version-86 adaptations,
including native vision-capability gating, file-tool contracts and
exact-versus-opportunistic speculative sampling. Chat PLD patch 3 preserves
version 2's GLM/DSML parser identity and speculative boundary handling. Patch
89 fixes reasoning-event rendering when upstream captures output without a
worker. The old migration oracle is still checked after reversing only that
documented correction. Version 92 adds the explicit
[empty-candidate core API](ds4-qwen38-prepare/README.md) for responsive Qwen3.8
reset cancellation between GPU layers, without changing live-sync semantics.
See [the variant notes and prerequisites](ds4-agent-jsonl/README.md)
and [the Qwen checkpoint](../docs/QWEN_CHECKPOINT.md) for focused real-model
results, retained failures and the still-open desktop/quality qualification.

Patch 82 adds Cowork's general-purpose `document_table` tool to the native
DSML, GLM and Laguna schemas and Office bridge. It checks source hashes and
literal excerpts, preserves conflicts/missing fields, and exports revisioned
HTML/XLSX comparisons. It adds no finance-specific fields and changes no
inference defaults. Matching evidence is not a guarantee of semantic accuracy.

`ds4-agent-jsonl/` now builds Agent/Cowork and its web helper from private
source copies; it never rewrites `ds4_agent.c` or `ds4_web.c`. Failed links do
not overwrite working runtime binaries. Separate native engine patches still
apply to their documented engine files, and upstream core objects are built
in the engine directory. Full dependency signatures, coordinated publication
of the runtime pair and verified recovery of pre-existing legacy source edits
remain separate work; this is not a general transactional installer claim.
Patch version 78 links the mandatory upstream `ds4_prompt_prefix` module so conversation-prefix conditioning is preserved in both managed runtimes. Native DeepSeek Vision-Exp and GLM 5.3 sessions expose `view_image` through their own encoders; Laguna S 2.1 is deliberately fail-closed and text-only, including PDF extraction. Text-only tool results stay on the normal chat-message path so an empty image list cannot be mistaken for a full context window during compaction.

[`ds4-server-metrics/usage-metrics.patch`](ds4-server-metrics/README.md) exposes
ds4's native decode-pass timing in the OpenAI-compatible usage object. The UI
never estimates token speed from character counts. Complete-delta preflight
rejects partial/drifted patches without mutation; lifecycle and compiled JSON/SSE
tests cover the bundled main and Laguna. See the timing/recovery limits
in the linked notes; this is not an end-to-end latency measurement.

[`ds4-glm53-runtime`](ds4-glm53-runtime/README.md) applies one complete delta
to the bundled main, where GLM 5.3 lives. The new base's native non-routed
weight helper replaces the duplicate local helper; GLM's mapped-span correction
remains. V4.1 retains its own native memory planner and model ID.

[`ds4-glm53-m2max/native-decode-main-qwen.patch`](ds4-glm53-m2max/README.md)
follows that GLM patch on macOS, composed with its build and hot-list hunks. It carries the local top-8 cache-backed decode and
short-resume specialization, with exact M2 Max/GLM Q2/SSD runtime predicates.
The hook preflights the complete patch and refuses partial/drifted sources. It never enables SSD or
MTP, changes context, or selects a model. See the linked QA report for the
unclosed live-model gates; this is not a new DeepSeek speed claim.

[`ds4-visible-downloads`](ds4-visible-downloads/README.md) uses visible resumable
`.part` files for the main downloader's models. V4.1 instead retains its native pinned
Hugging Face/Xet download, full verification and split assembly. Its progress
counts matching cache artifacts only; intermediate bytes are not readiness.

`ds4-media-memory/residency-lease.patch` adds a reversible residency lease used
only by the direct Ideogram, Hunyuan and MiniMax H3 workers. It does not install
or select a vision model and never changes the user's persistent SSD-streaming
preference.

`h3-metal-watchdog/stage-command-submits.patch` adds opt-in, arithmetic-preserving
Metal submit boundaries between the native MiniMax-H3 DiT stages and partitions
non-causal attention by independent query rows while retaining the complete
key/value sequence. The managed H3 builder applies it to the pinned upstream
checkout only while compiling, restores the exact upstream files afterward,
and rejects any unknown source delta instead of editing or replacing upstream
files in place. The patch is rebased directly on upstream commit
`8974cc055ea9c02fcd14cc27dfda3e1027c05153`; its SHA-256 is
`5845dce1d8b4fb02bb55c4006b686e97a6fb738aed61cb7a35e67093507d6600`.
The M2 Max quality policy uses eight query rows per partition. That setting
completed a full 50-layer 1344x768 DiT step with the complete K/V sequence,
zero Metal errors, and no SSD streaming. Larger 1024- and 256-query partitions
hit the macOS interactivity watchdog during real multi-layer runs. A CPU-yield
experiment also failed the full-depth gate and was removed rather than retained
as dead scheduling code.
