# Visible downloads, with native V4.1 and Qwen verification retained

[`main-qwen.patch`](main-qwen.patch) targets MIT-licensed `antirez/ds4` at
`0aaea5a238fb41a35106a551e73c8409dfb751ac`. The preceding
[`main-v41.patch`](main-v41.patch) covers `bd66c402070042bf0a79ad6ece8242de4c93680c`; the legacy
[`visible-partials.patch`](visible-partials.patch) remains for older supported
main sources. `scripts/apply-ds4-visible-downloads.sh` selects one complete
delta by exact forward/reverse applicability and rejects drift/partial edits.

Legacy DeepSeek V4/GLM downloads retain visible `.gguf.part` files. V4.1 keeps
the official Hugging Face/Xet downloader, native size/SHA-256 checks and split
Q4 assembly. Its model source is pinned to
`dd8a266f7145edc19e2334b46e19b6821f221dc7`, with one download worker; it does not
reuse the legacy curl path or mistake intermediate cache bytes for completion.
Cached-transfer reuse depends on the installed Hugging Face/Xet version.

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
