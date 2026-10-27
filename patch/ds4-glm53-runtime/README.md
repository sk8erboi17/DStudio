# Native GLM memory adaptation for the bundled main

[`main-latest.patch`](main-latest.patch) targets MIT-licensed `antirez/ds4` at
`0aaea5a238fb41a35106a551e73c8409dfb751ac`. Upstream now owns the GLM model
aliases, so this newest delta keeps only DStudio's mapped-span calculation and
GLM host-memory-guard policy. It is the only variant: the deltas for earlier
main revisions were removed on October 27, 2026 (Git history keeps them).
`scripts/apply-ds4-glm53-runtime.sh` applies the whole exact-context delta and
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
