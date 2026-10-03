# Native media-memory lease

`residency-lease.patch` adds the explicit, nestable engine/GPU memory-pressure
handoff and the loopback server endpoints. It does not turn expert SSD streaming
on or off. Its source delta is unchanged by the Design builder migration: the
header hunk now anchors on the two adjacent SSD/GLM streaming declarations,
without depending on the unrelated tensor-matmul declaration found in Laguna.

Main since `9139e2a` gives the CUDA cache-budget setter a real implementation; the active `0aaea5a` pin retains it. The
patch now anchors only on its signature, not its former empty body; the
applied residency source is unchanged. Both the managed installer and Design
builder check the full delta before mutation. The installer no longer accepts
a marker or fuzzy partial application as a complete adaptation. Native Metal
builds, exact stack restoration and Design's 18 process/filesystem regressions
cover this rebase; they do not qualify CUDA execution.

For Design, `src/harness/design/build-design.sh` applies this patch only in its
private build snapshot and verifies the complete forward or reverse delta using
Git. It neither edits nor restores the original checkout. Existing setup/server
patch application remains a separate path.

`legacy-labels.patch` records a historical DStudio adaptation observed on
`laguna-s21/ds4` at base `448d5695d1c86401a4e9447c440feb983b73e6de`:
four log strings said “Qwen” and a header comment used the old description.
There is no numerical or lifecycle change. Only a complete exact match is
normalized, in the private snapshot; the complete residency patch must then pass
reverse verification. Partial legacy text, an incomplete implementation or
unrelated source drift does not become accepted merely because a marker exists.

The builder regressions preserve caller-owned already-applied patches and
unrelated edits. Real native build/tool gates are separate from simulated
compiler failures; neither establishes inference quality or GPU numerical
equivalence. CUDA/ROCm require their own hardware qualification.
