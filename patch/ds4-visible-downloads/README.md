# Visible downloads, with native V4.1 verification retained

[`main-v41.patch`](main-v41.patch) targets MIT-licensed `antirez/ds4` at
`bd66c402070042bf0a79ad6ece8242de4c93680c`. The legacy
[`visible-partials.patch`](visible-partials.patch) remains for older supported
main sources. `scripts/apply-ds4-visible-downloads.sh` selects one complete
delta by exact forward/reverse applicability and rejects drift/partial edits.

Legacy DeepSeek V4/GLM downloads retain visible `.gguf.part` files. V4.1 keeps
the official Hugging Face/Xet downloader, native size/SHA-256 checks and split
Q4 assembly. Its model source is pinned to
`dd8a266f7145edc19e2334b46e19b6821f221dc7`, with one download worker; it does not
reuse the legacy curl path or mistake intermediate cache bytes for completion.
Cached-transfer reuse depends on the installed Hugging Face/Xet version.

This is the first of the six native main adaptations: visible downloads → media
memory → server metrics → GLM runtime → M2 kernels → vision mapping. Restore in
reverse order. Agent/Cowork private-source and server PLD builds are separate.

The real empty-profile first-launch test downloads the pinned archive, applies
the stack and builds the installed runtimes. The native round-trip test reverses
and reapplies all six without losing unrelated edits. Model-download unit tests
execute progress and Stop behavior with actual temporary partial files; they do
not validate downloaded weights. Real V4.1 weights require complete verification
and inference independently of these installation checks.
