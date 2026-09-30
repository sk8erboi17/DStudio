# Native GLM memory adaptation across main revisions

[`main-latest.patch`](main-latest.patch) targets MIT-licensed `antirez/ds4` at
`0aaea5a238fb41a35106a551e73c8409dfb751ac`. Upstream now owns the GLM model
aliases, so this newest delta keeps only DStudio's mapped-span calculation and
GLM host-memory-guard policy. [`main-qwen.patch`](main-qwen.patch) remains the
historical unified-main variant for `9139e2ae58a41503968a500f36f75895c1ba63fc`;
[`main-v41.patch`](main-v41.patch) covers `bd66c402070042bf0a79ad6ece8242de4c93680c`.
[`streaming-memory.patch`](streaming-memory.patch) remains for older main.
`scripts/apply-ds4-glm53-runtime.sh` selects the whole exact-context delta and
rejects partial or drifted source; repeated application is idempotent.

The V4.1 base already owns `weights_streaming_non_routed_bytes`, so the new
variant explicitly retires DStudio's duplicate helper. It preserves the GLM
static-span/streaming-memory correction and existing model IDs while reporting
V4.1 as `deepseek-v4.1-flash`. V4.1's Engram/graph memory planner remains native;
it is not replaced with the older DeepSeek V4 or GLM estimate.

Apply after visible downloads, media memory and server metrics, before the M2
and vision adaptations. Reverse in the opposite order. The seven-patch managed
upgrade rehearsal and empty-profile first-launch test pass on the current base.
Native V4.1 Engram, GGUF, Metal operator and server/Agent fixtures also pass on
the fully patched source. Those are not real-weight inference qualification or
evidence for CUDA/ROCm.
