# DS4 alignment WIP — 2026-08-27

No push or release was performed.

## Repository state

- DStudio `main`: `a0c47c92dd8bf14909e4b887065e52b8222741f4`, identical to `origin/main`.
- Managed DS4 `main`: `c1d4597a80e300b803dc642519718f2c999589da`, identical to `origin/main`.
- Managed DS4 has no modified or deleted tracked files after builds and tests.
- Existing untracked DS4 binaries, model-related files, and backups were preserved.

## Compatibility work

- Removed DStudio agent edits 058 and 059 from the JSONL patch manifest. Their old argmax speculative-decoding path is superseded by DS4's native full speculative-decoding implementation in `c1d4597`.
- Kept the remaining DStudio integration anchors compatible with the updated DS4 source: 66/66 pass.
- Added a DS4 source/build signature for `ds4-design`, so an executable compiled against an older DS4 commit is no longer incorrectly accepted as fresh.
- Made the Design build apply and restore the Qwen hot-memory patch transactionally. A clean DS4 checkout now builds successfully and remains clean afterward.
- Added a regression test covering commit changes, tracked source changes, missing stamps, patch cleanup, and caller-owned pre-applied patches.

## Verification results

- `make check-fast`: pass.
- DStudio core, Cowork, Design, Qwen, Hunyuan, H3, UI/Playwright, HTTP/LAN, packaging, release gates, and 16 Design contract cases: pass.
- `ds4-design --self-test`: pass.
- Qwen hot-memory and server-metrics patches apply in dry-run against `c1d4597`: pass.
- DS4 upstream Q4_K, MXFP4, extractor, agent, layer-pack, multi-GPU placement, GPU argument/CLI, sampling, and server tests: pass.
- Full upstream model-dependent DS4 tests were not run because their default fixture `ds4flash.gguf` is absent from the checkout.

## Known upstream Metal result

`ds4_test --metal-kernels` reports 29 failures on this Apple M2 Max. The same 29 failures reproduce in clean checkouts of both the previous `84cc882` commit and the new `c1d4597` commit. They are therefore not introduced by this alignment or by DStudio. No workaround or direct DS4 core modification was added.

Logs from this verification are under `/tmp`:

- `dstudio-check-fast-ds4-c1d4597-20260827.log`
- `ds4-upstream-c1d4597-test-20260827.log`
- `ds4-upstream-c1d4597-model-independent-20260827.log`
- `ds4-c1d4597-clean-metal-kernels-20260827.log`
- `ds4-84cc882-clean-metal-kernels-20260827.log`
