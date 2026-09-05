# DStudio upstream patches

This directory contains the patches that DStudio applies to the upstream DS4 checkout when building its managed runtimes.

Agent/Cowork patch **82** and `ds4-server-pld/` share
[prompt lookup](ds4-agent-jsonl/PLD.md), with ordinary
generation as the default reference path and an explicitly experimental Metal
batch verifier. The normal ds4 engine/server objects remain untouched.
Chat launches the derived `ds4-server-pld` on supported source revisions; its
temporary source is removed after compilation, including on failure. Older
server ABIs retain the native server. The prefix-conditioning object is linked when supplied by upstream; older
Laguna builds retain their original Agent loop and lack that separate module.

Derived helper binaries use a `manifest` with ordered `NNN.find` / `NNN.replace` anchors. Small engine/server extensions use unified patches through dedicated scripts. Both paths fail explicitly when upstream anchors drift.

Patch 82 adds Cowork's general-purpose `document_table` tool to the native
DSML, GLM and Laguna schemas and Office bridge. It checks source hashes and
literal excerpts, preserves conflicts/missing fields, and exports revisioned
HTML/XLSX comparisons. It adds no finance-specific fields and changes no
inference defaults. Matching evidence is not a guarantee of semantic accuracy.

`ds4-agent-jsonl/` builds the structured Agent and Cowork runtime without editing the selected upstream checkout in place. Patch version 78 links the mandatory upstream `ds4_prompt_prefix` module so conversation-prefix conditioning is preserved in both managed runtimes. Native DeepSeek Vision-Exp and GLM 5.3 sessions expose `view_image` through their own encoders; Laguna S 2.1 is deliberately fail-closed and text-only, including PDF extraction. Text-only tool results stay on the normal chat-message path so an empty image list cannot be mistaken for a full context window during compaction.

`ds4-server-metrics/usage-metrics.patch` exposes ds4's own measured decode rate in the OpenAI-compatible usage object. The UI never estimates token speed from character counts.

`ds4-glm53-runtime/streaming-memory.patch` is applied to the pinned upstream `main`, where GLM 5.3 now lives. It fixes the active mapped-span calculation used by SSD streaming and removes the fixed host-memory rejection; DStudio presents the model-size guidance as a non-blocking selection modal instead. The hook skips older/non-GLM checkouts.

[`ds4-glm53-m2max/native-decode.patch`](ds4-glm53-m2max/README.md) follows
that GLM patch on macOS. It carries the local top-8 cache-backed decode and
short-resume specialization, with exact M2 Max/GLM Q2/SSD runtime predicates.
The hook preflights the complete patch, refuses partial/drifted sources, and
reverses it before the older patches during updates. It never enables SSD or
MTP, changes context, or selects a model. See the linked QA report for the
unclosed live-model gates; this is not a new DeepSeek speed claim.

`ds4-visible-downloads/visible-partials.patch` replaces the main checkout's
opaque Hugging Face local-dir cache path with resumable `curl` transfers. Every
incomplete model is written as a stable `<filename>.part` directly beside the
final GGUF. DStudio applies the patch idempotently when it installs, starts with
or selects a compatible engine checkout; older optional branches are skipped.

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
