# DStudio upstream patches

This directory contains DStudio's explicit adaptations for managed runtimes
and separately identified engine candidates.

The [q27 Metal candidate](q27-metal-delta/README.md) fixes the native DeltaNet
512-thread dispatch failure reproduced on M2 Max. Two independent column tiles
retain recurrence math and precision; native operators, a scalar oracle and
patch lifecycle are verified separately from still-unqualified model inference.
q27 is not yet a managed DStudio installation.

The [q36 candidate](q36-metal-runtime/README.md) has an explicit native CLI
installer and pinned model downloader. Its patch fixes Metal shape handling,
mixed-format CPU FFN preparation, model identity and the native vision operators.
Initial Qwen27B Chat/Agent/Cowork workflows are verified; broad quality,
long-context execution and full application-mode qualification remain open.
The separate [q36 terminal candidate](q36-agent-tty/README.md) addresses the
latest upstream CLI's macOS terminal lifetime and, in a layered owner patch,
responsive status/Stop during slow output with tested process lifetime. These
are native lifecycle fixes, not inference improvements; the candidate
has not yet been promoted into the managed installer.
The [bounded F16 attention candidate](q36-f16-attention/README.md) addresses
the identified long-context Metal command. It preserves the requested context
and precision, with separate operator/lifecycle and actual-model verification.
It is not yet a qualified installer update or a new common-100 result.

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

Patch 87 preserved the version-86 adaptations for main `c0a6119`/`f62ca29`, the previous September 5 main layout and the
pinned Laguna branch. It preserves native vision-capability gating, file-tool
contracts and exact-versus-opportunistic speculative sampling. Chat PLD patch 3
preserves version 2's GLM/DSML parser identity and speculative boundary handling.
Patch 89 fixes reasoning-event rendering when upstream captures output without
a worker. The old migration oracle is still checked after reversing only that
documented correction. The fourth full variant targets the isolated Qwen3.8
`b4c3550` candidate, preserving native tool syntax and adding Cowork schemas;
its literal-markup parser correction has native regression coverage. Version 90
adds Qwen3.6's native-tool adaptation and version 91 makes piped Qwen resets
cancelable while retaining the old context on failure. Both models now expose
experimental Agent/Cowork on Metal. Version 92 adds the explicit
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
tests cover current main, previous main and Laguna. See the timing/recovery limits
in the linked notes; this is not an end-to-end latency measurement.

[`ds4-qwen35-catalog/native-model-id.patch`](ds4-qwen35-catalog/README.md)
corrects model discovery on the pinned Qwen3.6 native server: `/v1/models`
publishes Qwen instead of DeepSeek aliases. Engine setup applies it before
building; it does not change native inference, templates or request aliases.

[`ds4-qwen38-inspect/metadata-only-ple.patch`](ds4-qwen38-inspect/README.md)
keeps native Qwen3.8 `--inspect` from requesting a full PLE prefetch. Setup
applies it before the native build. Normal inference and PLE requirements stay
unchanged; lifecycle and native OS-prefetch behavior have separate tests.
The complete delta supports checked repeat apply and restore, rejecting drift.

[`ds4-qwen38-snapshot`](ds4-qwen38-snapshot/README.md) follows inspection and
empty-candidate preparation. It prevents a failed lazy snapshot allocation from
being mistaken for a complete speculative state on retry; the native inference
math and existing fallback are retained. Actual native-helper failpoint tests
and patch lifecycle checks are distinct from real-weight quality evaluation.

[`ds4-glm53-runtime`](ds4-glm53-runtime/README.md) selects the V4.1 or older
complete delta for main, where GLM 5.3 lives. The new base's native non-routed
weight helper replaces the duplicate local helper; GLM's mapped-span correction
remains. V4.1 retains its own native memory planner and model ID.

[`ds4-glm53-m2max/native-decode.patch`](ds4-glm53-m2max/README.md) follows
that GLM patch on macOS. It carries the local top-8 cache-backed decode and
short-resume specialization, with exact M2 Max/GLM Q2/SSD runtime predicates.
The hook preflights the complete patch, refuses partial/drifted sources, and
reverses it before the older patches during updates. It never enables SSD or
MTP, changes context, or selects a model. See the linked QA report for the
unclosed live-model gates; this is not a new DeepSeek speed claim.

[`ds4-visible-downloads`](ds4-visible-downloads/README.md) uses visible resumable
`.part` files for legacy main models. V4.1 instead retains its native pinned
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
