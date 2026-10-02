# Qwen3.8 metadata inspection without PLE preloading

**Historical fork only.** Qwen Next now uses antirez/ds4 main (merged at
`9139e2a`, pinned at `0aaea5a`) and
single-file BF16 n-grams. This patch is retained for archived regressions, not
applied by an active engine installer. [Migration](../../docs/QWEN_NEXT_MAIN_MIGRATION.md).

Base: [`ivanfioravanti/ds4-metal`](https://github.com/ivanfioravanti/ds4-metal/tree/bd9cfbccc03a709a3f00b50e0ac1cc41c3fcf02d),
revision `bd9cfbccc03a709a3f00b50e0ac1cc41c3fcf02d`, branch `qwen3.8-flash-next`.
The original source is MIT-licensed; retain its notices. Model terms are separate.
The original patch also applies to `66b0e3fc3bf0f548db1ec0c0dd19f4e43567a7f8`;
its apply/repeat/check/restore, unrelated-edit, drift, symlink and ABI cases were
rerun on a private copy of the actual fresh installation. The historical native
prefetch measurements below belong to the original base, not a new inference run.

The last separate-engine pin was `ff4f0ff4fdff70d6b7c3941ef437b91dde960e14`.
The same complete delta applies to the preceding `2dda88e` snapshot.
[`metadata-current.patch`](metadata-current.patch) applies the inspection guard
to its newer headroom-based full-prefault decision. Upstream already maps PLE
without an unconditional hint, but `DS4_QWEN4_PLE_PREFETCH_FULL=1` could still
prefault the entire file during inspection. The production script selects one
complete old/current delta by exact applicability, never by a marker alone.
The September 12 native test uses that override to reproduce the original
prefault, then proves the patched metadata is identical with no prefetch hint,
using the real GGUF and PLE. Normal startup still requests its main-weight
prefetch. Apply, repeat, restore, unrelated edits, drift, symlink and ABI tests
also pass. No language-model generation is claimed by this inspection test.

The native `--inspect` path suppresses prefetch of the main weights but previously
requested `POSIX_MADV_WILLNEED` for the entire separately stored PLE. This could
block an inspection on tens of gigabytes of SSD reads. The one-line patch applies
the existing `inspect_only` decision to the PLE mapping too. Metadata parsing,
shape validation and normal inference prefetch are unchanged. The PLE remains
required for this split checkpoint; this does not enable expert streaming.

The retired fork installer applied this patch before building Qwen3.8, followed
by the matching [private-reset preparation patch](../ds4-qwen38-prepare/README.md) and
[snapshot allocation correction](../ds4-qwen38-snapshot/README.md) before native
runtime builds. For an explicitly selected checkout:

```sh
DS4_DIR=/path/to/ds4-qwen38 sh scripts/apply-ds4-qwen38-inspect.sh check
DS4_DIR=/path/to/ds4-qwen38 sh scripts/apply-ds4-qwen38-inspect.sh apply
DS4_DIR=/path/to/ds4-qwen38 sh scripts/apply-ds4-qwen38-inspect.sh restore
```

Verification:

```sh
make test-qwen38-inspect
node tests/integration/qwen38_inspect_patch_test.mjs /path/to/archived-qwen-next --native ds4/gguf
```

The first command verifies and expands the exact
[historical source fixtures](../../tests/fixtures/retired-qwen-next/) into a
private directory for patch lifecycle tests, without an installed fork.
`QWEN38_DIR=/path/to/archived-qwen-next` selects a full historical source tree.
The second command requires that explicit full tree, builds the native CLI,
uses existing real model/PLE metadata, and on macOS
interposes the OS prefetch call. It proves the original inspection asks to
prefetch the full PLE and the patched inspection does not, with identical output.
It then runs without interposition and checks all reported tensor counts. A
separate controlled startup exits at the first normal CPU prefetch, before
inference. No weights are downloaded and no GPU or numerical quality is tested.
An existing engine holding the instance lock is not stopped by this test.
