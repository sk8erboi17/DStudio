# Reproducible Chat prompt-lookup patch

Version 3 replaces the ordered edit manifest with complete
[current-main](main-current.patch) and [previous-main](main-previous.patch)
deltas. [bases.json](bases.json) pins both upstream revisions, source/output
hashes and the optional server-metrics prerequisite. Each delta works before
and after that metrics patch, preserving its output exactly. The derived C
source is byte-identical to the previous version-2 transformer.

Inference behavior is unchanged: native GLM/DSML state tracking, token boundaries,
cancellation and prompt-lookup transaction handling remain intact. The shared
implementation and experimental-versus-reference modes are documented in
[PLD.md](../ds4-agent-jsonl/PLD.md). Unsupported ABIs retain the native server;
this patch does not add PLD to Laguna or either Qwen family.

Builds use the existing checkout lease and a private `.ds4ui-server-build-*`
directory. The derived source, adapter object and linker output stay private.
The host rejects changed server source and missing, empty, linked or non-executable
output before replacing the previous runtime with one same-filesystem rename.
A failed compiler cannot overwrite that runtime. The success stamp is removed
before preparation and written only after publication. A killed build may leave
its private directory; automatic cleanup of historical directories is not claimed.
Upstream source, server object and native server executable are not replaced.
Core object compilation and separate engine patches retain their own lifecycle.
The temporary directory descriptor is retained from creation. Replacement with
another directory or symlink rejects publication; cleanup uses that descriptor,
never follows symlinks or recurses, and visits at most 128 entries. Unexpected
or renamed directories may remain for diagnosis without touching a replacement.

This is not a complete transactional installer: mtime/version checks do not cover
the full toolchain/header/shader dependency identity, and arbitrary external
builders or user edits are not serialized by the DStudio build lease. There is no
cross-file durable release transaction with Agent/Cowork.

## Verification

- `make test-runtime-patch-migration`: four pinned server inputs, frozen output
  parity, independent Git apply/reversal, unrelated edits, CRLF and rejection
  of repeated, partial or drifted inputs.
- `make test-pld-build`: actual host builder and files with a **simulated compiler**;
  cache, Metal-only invalidation, failed-link preservation, invalid outputs,
  source changes during compilation, cleanup, paths with spaces and unsupported ABI.
- `make test-agent-native-build`: source-only macOS builds of Agent/Cowork plus
  the actual main Chat PLD executable and its CLI; Laguna's PLD rejection is
  checked separately. No model weights, token generation or numerical parity.

Original failures and subsequent successful runs remain in ignored test artifacts.
Real-weight inference and other hardware qualification are separate gates.
