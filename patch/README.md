# DStudio upstream patches

This directory contains the patches that DStudio applies to the upstream DS4 checkout when building its managed runtimes.

Derived helper binaries use a `manifest` with ordered `NNN.find` / `NNN.replace` anchors. Small engine/server extensions use unified patches through dedicated scripts. Both paths fail explicitly when upstream anchors drift.

`ds4-server-metrics/usage-metrics.patch` exposes ds4's own measured decode rate in the OpenAI-compatible usage object. The UI never estimates token speed from character counts.

`ds4-glm53-runtime/streaming-memory.patch` is applied only to the pinned GLM 5.3 checkout. It fixes the active mapped-span calculation used by SSD streaming and removes the branch's fixed host-memory rejection; DStudio presents the model-size guidance as a non-blocking selection modal instead.

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
