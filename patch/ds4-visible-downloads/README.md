# Visible downloads, with native V4.1 and Qwen verification retained

[`main-qwen.patch`](main-qwen.patch) targets MIT-licensed `antirez/ds4` at
`890898cfb437ed256be58ebcf7c58a6dfa8f2f53`, the only supported main revision
(the deltas for earlier revisions were removed on October 27, 2026).
`scripts/apply-ds4-visible-downloads.sh` applies the complete delta by exact
forward/reverse applicability and rejects drift/partial edits.

Legacy DeepSeek V4/GLM downloads retain visible `.gguf.part` files. V4.1 keeps
the official Hugging Face/Xet downloader, native size/SHA-256 checks and split
Q4 assembly. Its model source is pinned to
`9dcee51692e6540f697141fc98b097e3c96492a3`, with one download worker; it does not
reuse the legacy curl path or mistake intermediate cache bytes for completion.
Cached-transfer reuse depends on the installed Hugging Face/Xet version.

At `890898c` upstream's `ds41f-q2` names the 1017 checkpoint
(`DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf`), which the earlier
`dd8a266f` pin does not contain. The new pin is the revision DStudio's own
[1017 downloader](../../scripts/download-ds41-1017.sh) already uses. On
November 3, 2026 its Hugging Face LFS SHA-256 identities matched upstream's
expected digests for the 1017 Q2 and the first MXFP4 shard, and were identical to
`dd8a266f` for the Q4 parts and the Vision sidecar. DStudio itself still routes
`ds41f-q2` to its pinned downloader; this pin covers direct use of the script and
the Q4/Vision targets.

Qwen Next's single-file Q2/Q4 downloads use the upstream BF16 n-gram releases,
pinned to `d600fe1a43d2e1cdcadb85144ce3142f66f9eefe`, also with one worker and
native size/SHA-256 verification. The old base-plus-PLE downloader is retired.
The executable downloader regression uses tiny independently hashed files and
simulated transport; it is not a full model transfer or inference test.

This is the first of the seven native main adaptations: visible downloads → media
memory → server metrics → GLM runtime → M2 kernels → vision mapping → private
Qwen preparation. Restore in
reverse order. Agent/Cowork private-source and server PLD builds are separate.

The real empty-profile first-launch test downloads the pinned archive, applies
the stack and builds the installed runtimes. The native round-trip test reverses
and reapplies all seven without losing unrelated edits. Model-download unit tests
execute progress and Stop behavior with actual temporary partial files; they do
not validate downloaded weights. Real V4.1 weights require complete verification
and inference independently of these installation checks.
