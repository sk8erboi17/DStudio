# Headless installation and real-model checks — September 5, 2026

This report describes the earlier pinned revisions below. Main was subsequently
updated; see [the main update and before/after comparison](DS4_MAIN_UPDATE_2026-09-05.md)
for the new revision's separately executed checks.

## Result in plain language

**All four engine checkouts install from scratch. All nine supported chat
models installed on this Mac load and answer the checked questions.** The
application was run without a window; its actual Chat interface was operated
with headless WebKit. No model answer was simulated.

The nine-model sweep initially passed eight full Chat checks. Qwen3.8 returned
the correct streamed answer, but the test read the screen before WebKit painted
it. After correcting that test wait, a fresh Qwen3.8 loading/HTTP/Chat run passed
all three checks. The original failed report is retained, not rewritten as a
passing nine-model run.

## Installation from an empty profile

The test copies the signed `.app` to a new location, starts its bundled binary
from `/`, and gives it an empty data directory and browser profile. It uses the
actual installation buttons, real network downloads and real native builds.

| Engine | Pinned upstream revision | Download, build and executable startup |
| --- | --- | --- |
| Main: DeepSeek V4 / GLM 5.3 | `b0a147a7fba6d1a104d047d5a140e9bb4bfc13cd` | Passed |
| Laguna S 2.1 | `448d5695d1c86401a4e9447c440feb983b73e6de` | Passed |
| Qwen3.8 | `bd9cfbccc03a709a3f00b50e0ac1cc41c3fcf02d` | Passed |
| Qwen3.6-35B-A3B | `60fca11f0c8b16ca50c757324dddd717ba043098` | Passed |

Selecting an optional model installs and selects its matching engine. The test
also checks their shared model folder, discovery after browser reload and the
bundle signature after installation. Main and Laguna include the managed
Agent, Cowork and Design builds; Qwen uses its supported native runtimes.

All six main runtime patches are verified together: visible downloads, media
memory, server metrics, GLM streaming, M2 Max and vision mapping. On a private
copy of the installed source, the test removes and reapplies the complete stack
and requires exact file equality. Patches are bundled with DStudio and applied
where compatible; Qwen does not receive the DeepSeek structured-Agent patch.

The installation-only test deliberately refuses the later **model-weight
download** and inference boundaries. It does not claim that multi-gigabyte
weights were freshly downloaded. The following test uses actual existing weights.

## Real loading and Chat

Hardware: Apple M2 Max, 96 GiB unified memory. Models run one at a time using
the runtimes produced by the installation test, with **8192 context**, thinking
off and DSpark off. Main DeepSeek/GLM models use SSD expert streaming. Laguna
and Qwen use their normal resident-backbone path; Qwen3.8 retains its native
SSD-backed PLE.

For each model the test checks the selected file and engine, starts an owned
process through DStudio, waits for its real model endpoint, then requires:

1. `17 × 19` produces exactly `323` through DStudio HTTP.
2. A record is extracted as the exact JSON values `city: Torino`, `count: 7`.
3. The real Chat composer sends `19 + 23`; the model streams `42`, ends normally,
   and WebKit displays `42` in the completed assistant message.

| Installed chat model | Weight size, decimal GB | Real loading | Three answer/Chat checks |
| --- | ---: | --- | --- |
| Qwen3.6-35B-A3B Q6_K_XL | 31.8 | Passed | Passed |
| Laguna S 2.1 Q4_K_M | 68.2 | Passed | Passed |
| Qwen3.8-Flash-Next Q4K / MXFP4 | 73.4 + 32.0 PLE | Passed | Passed on corrected UI-wait rerun |
| DeepSeek V4 Flash Chat IQ2XXS | 86.7 | Passed | Passed |
| DeepSeek V4 Flash Abliterated Headroom128 | 86.7 | Passed | Passed |
| DeepSeek V4 Flash Vision-Exp IQ2XXS | 86.7 | Passed | Passed, text Chat only |
| GLM 5.3 Flash Q2 | 96.5 | Passed | Passed |
| DeepSeek V4 Flash mixed Q4K / IQ2XXS / Q2KDown | 97.6 | Passed | Passed |
| DeepSeek V4 Flash MXFP4 experts / Q8 attention | 156.0 | Passed | Passed |

Weights were linked from the existing model folder, not copied or moved. Each
test-owned engine was stopped before the next one. No test engine was left
running after completion.

### Limits

This is not a speed benchmark or proof of general model quality. It does not
test 128k/full context, all quantizations, maximum residency, image understanding,
video/image generation, Agent tools or Cowork tasks. Auxiliary encoder/draft/PLE
files are not counted as separate chat models. The installed GLM 5.2 file is
excluded because it is not an officially integrated DStudio chat model.

## Problems found and fixed

- Source installation no longer stops an unrelated process holding the engine
  port. A real listener/sentinel must survive the complete installation test.
- An explicit `DS4UI_DATA_DIR` now isolates the chat store too. Before this fix,
  a fresh test profile could import the host's old conversations. The default
  user storage path is unchanged. Regression tests execute real save/reload.
- Shutdown signals only owned engines; a child-process regression covers this.
- The Chat E2E waits for the actual displayed answer, not only a visible but
  still-empty Markdown container after the HTTP stream finishes.

`make check-fast` and the updated engine/setup unit tests passed.

## Reproduce and inspect

```sh
make test-first-launch-e2e
node tests/live/installed_models_e2e.mjs tests/.artifacts/first-launch-<successful-run> ds4/gguf
# Optional targeted rerun, still with real loading and Chat:
node tests/live/installed_models_e2e.mjs tests/.artifacts/first-launch-<successful-run> ds4/gguf Qwen3.8
```

Local ignored evidence: `first-launch-TxNHSH` (installation),
`installed-models-URjDda` (original nine-model sweep), and
`installed-models-8aPJcF` (Qwen3.8 rerun), all under `tests/.artifacts/`.
They retain setup results, model identities, configurations, binary hashes,
actual replies, raw Chat SSE, screenshots, failures and shutdown checks.
See [test scope and prerequisites](../tests/README.md).
