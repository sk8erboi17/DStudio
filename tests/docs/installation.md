# Offline installation, inference boundaries and cleanup

[All test guides](../README.md). Run commands from the repository root.
Each section retains its original scope, prerequisites, results and limitations;
a historical pass is not a pass on a newer runtime.

## Clean installation and real inference

```sh
make test-setup-live                  # Bundled sources + real builds: main, Laguna, llama.cpp
make test-first-launch-e2e            # Headless .app + real WebKit UI + fresh offline engine installation
make test-inference-live              # Real resident Metal: installed DeepSeek + Laguna
make test-inference-live ENGINES=qwen  # Requires the pinned single-file Qwen3.8-Flash-Next-Q4.gguf
make test-engine-acceptance           # Fresh builds AND real inference: main and Laguna by default
make test-qwen-chat-live              # Actual DStudio launch + Chat HTTP proxy, real Qwen
make benchmark-qwen-decode            # Native generation tok/s, three exact-output checks
```

The setup gate calls DStudio's production headless installer, using the same
bundled-source installer and runtime builders as app setup. It starts with no engine
directory, verifies/copies pinned local sources, builds the executables,
executes their help command (`--version` for `llama-server`, which must report
the pinned build), and checks that Laguna shares the main model store. By
default it installs main, Laguna and llama.cpp; MLX is not installed by this
gate. The installer copies the bundled sources, not a GitHub download, but this
gate does not deny the network: the offline proof is `test-first-launch-e2e`
(the runner's own log line still calls the step a "network download").
By default `test-engine-acceptance` adds real inference for main and Laguna;
`ENGINES=qwen` selects Qwen3.8-Flash-Next on a fresh main build, and the runner
refuses llama.cpp inference, which `make test-llama-resident-live` covers.
It does **not** simulate a browser onboarding click. Existing user
checkouts, models, preferences and running processes are not replaced or stopped.

`test-first-launch-e2e` instead relocates the signed `.app`, starts its real
binary from `/` with an empty `DS4UI_DATA_DIR`, and uses headless WebKit to
operate the first-run installation controls. `DS4UI_TEST_MODE` is **not** set.
It clicks Install, chooses the optional models, and checks real setup responses,
pinned revisions, compiled executable startup, automatic checkout selection,
shared model storage and discovery after reload. It also reverses/reapplies the
eight native main adaptations listed in `tests/support/native_patch_roundtrip.mjs`
(visible downloads, media memory, server metrics, GLM runtime, the composed M2
port, vision streaming, V4.1 vision pairing and Qwen prepare) on a private
source copy and requires exact file
preservation. This is not the complete Agent/server-PLD/web patch stack. The
same focused check is `make test-native-patch-roundtrip`; it uses the production
M2 build-hunk selector and metrics integrity checks. An existing engine-port listener (or a test-owned sentinel)
must survive installation and test shutdown.

Only `/api/model/download` is intentionally refused at the browser boundary,
**after** actual optional-engine setup; weights are not downloaded and inference
is not counted as tested by this gate. Model-start attempts are also blocked.
No setup/build/catalog response is simulated. This is headless application/UI
coverage, not Finder double-click, native title-bar, or native file-picker QA.
Evidence and screenshots are retained in `tests/.artifacts/first-launch-*/`.

To follow a successful setup with real loading of every supported installed GGUF:

```sh
node tests/live/installed_models_e2e.mjs tests/.artifacts/first-launch-<successful-run> ds4/gguf
```

This heavyweight gate requires the existing inference engine to be stopped
explicitly. It uses the freshly built runtimes and links their empty task-owned
GGUF directory to existing weights, without copying or moving them. Models are
loaded **one at a time**, with 8k context, DSpark off, resident Laguna and
Qwen3.8-Flash-Next (its embedded BF16 n-grams read from SSD; a separate PLE
file is listed as auxiliary and not loaded) and SSD expert streaming for main
DeepSeek/GLM models. As written, the runner also requests SSD streaming for the
Qwen3.6 files, which now run on llama.cpp; `make test-launch-preflight` shows
that the host refuses that combination, so those rows are not qualified by this
runner until it is corrected (read from the runner, not rerun). Each model must
become ready, return exact arithmetic and JSON extraction
answers through DStudio, then answer a checked prompt through the real Chat UI,
including completed SSE and visible rendered text. No response is mocked.
Auxiliary GGUFs and unsupported models are listed separately; missing weights,
timeouts, truncated answers and failed checks are not passes. This does not
qualify all quantizations, maximum context, vision, Agent or Cowork behavior.

The inference gate starts a real `ds4-server`, waits for its live model catalog,
and checks arithmetic, structured extraction, ordering, Unicode, multi-turn
recall, longer-context lookup, code reasoning, malformed-request recovery and
actual SSE completion. Expected answers are independently checked, not supplied
by a model judge. Missing weights, a failed build, truncation and wrong answers
fail the run. No nonempty-answer-only pass criteria.
The tool check requires a real model-generated function call and correct use of
a controlled tool result; it does not claim autonomous execution of an Agent.

The Qwen Chat gate uses an isolated DStudio data directory, invokes the actual
launch API, rejects reuse of an unrelated engine, and sends the same checked
tasks through DStudio's Chat proxy. It does not simulate a browser click.

Each unique run retains requests, responses, failures, exact install receipts,
binary SHA-256, model path/size/mtime, load time and response time under
`tests/.artifacts/engine-acceptance/`. No model content is committed. Timings
describe this run, not a universal speed benchmark. The acceptance checks are
not full-logit comparisons against BF16/CPU, and do not establish general model
quality, tool-use quality, CUDA parity or exhaustive context-boundary correctness.

Qwen3.8 has experimental **Chat, Agent and Cowork** integration on macOS Metal
with the new engine pin. Its Design adapter is not implemented. The pinned
Qwen3.8-Flash-Next GGUFs are single files with embedded BF16 n-grams: the gates
above pass no separate PLE file. Qwen3.6 and Qwen3.8-27B run on the bundled
llama.cpp engine; see [Qwen3.6 and Qwen3.8-27B on llama.cpp](engines-and-harnesses.md#qwen36-and-qwen38-27b-on-llamacpp).

The Qwen3.6 sections that followed here (fresh `ds4-qwen35` setup, its
September 7 11/12 native baseline in `engine-acceptance/run-m8zF5Z/`, and the
`ds4-qwen35-catalog` patch) described the retired fork. Their receipts are
retained under ignored `tests/.artifacts/`; the commands were removed with the
fork and are no longer runnable.


## Bundled offline engine sources (September 30, 2026)

`make test-engine-sources` executes the production verifier, source copy and
exclusive publisher with real files. Its cases (19 on November 11, 2026, as
`unittest` reports) cover byte/mode integrity,
missing/extra/altered inputs, linked files and parents (including a deterministic
parent-switch barrier), source/manifest and target races, owner-lease replacement,
independent preparations overlapping at a deterministic barrier,
retained-candidate limits and interrupted durability acknowledgement. It also
copies/verifies all three active source snapshots (main, Laguna, llama.cpp),
rejects copying or installing the retired Qwen Next source and, in a Git
checkout, requires Git to track exactly the shipped engine and harness snapshot
files with the manifest's modes and exactly the manifest's MLX wheels.
`make test-macos-bundle`
checks that the relocated app materializes exactly those three snapshots with pins
matching its native metadata. No inference is claimed by these cases.

`make test-engine-updates` exercises the actual native HTTP endpoints with a
fixture checkout and Git peer. Update checks must not invoke Git, and stale
`ds4-latest` requests must fail before changing sources or executing commands.
The original failing receipt is retained separately from the passing run.

`make test-first-launch-e2e` uses a relocated signed app, an empty profile and
real WebKit controls. External outbound connections are denied by macOS for
the app and all its compiler/installer children; loopback UI requests remain
allowed. Main and Laguna compile from the bundled snapshots, and llama.cpp is
built through the app's `--install-engine llama` CLI, with no weights or model
inference. Packaging and source installation are separate
from the operator's full model-quality rerun. See
[provenance, source omissions and refresh workflow](../../docs/BUNDLED_ENGINES.md).

## Upgrade, interruption and recovery (November 11, 2026)

```sh
make test-install-recovery      # check-fast: simulated toolchains, about two minutes, no model
make test-llama-upgrade-real    # explicit: real offline CMake build over an earlier install (minutes of CPU)
make test-mlx-upgrade-real      # explicit: real venv + bundled wheels over an earlier patch set
```

`test-install-recovery` runs the production installers
(`scripts/install-llama.py`, `scripts/install-mlx.py`,
`scripts/bundled_engine_sources.py`), the host's `--install-engine`,
`--prepare-launch` worker and `--resident-guard`, and the HTTP host, as real
processes with outbound network denied by `sandbox-exec`, in task-owned
profiles whose paths contain spaces. Each profile holds settings, a project,
saved sessions, stand-in model files and a model-keyed KV file; every case
checks they are byte-identical afterwards. **Simulated:** `cmake` (a shell
stand-in whose build step runs in a child "make", as the real one does) and
the stand-in `llama-server` it emits; CPython 3.14 for MLX (venv, a pip that
enforces the required hashes and unpacks the real bundled mlx-lm wheel, so the
real patches are applied by real `git apply`, and the Metal probe); `make` for
main, which records any call and fails; the weight downloader. Nothing is
compiled and no model or MLX code is loaded. Receipts:
`tests/.artifacts/{engine-source-recovery,llama-install-recovery,mlx-install-recovery,install-recovery-host}/`.

The earlier installations are produced by the production installers driven at
the earlier identity: llama.cpp b11371 (`99b9548`, the receipt build identity
real b11371 installs carry, over a small fixture snapshot), MLX with the patch
set before tool streaming and a relabelled mlx-lm wheel, and main `0aaea5a`
taken from this repository's history. Deterministic points are reached through
the stand-ins' barriers and one failpoint,
`DSTUDIO_INSTALL_FAILPOINT=<name>[,<name>...]:<directory>`
(`scripts/bundled_engine_sources.py`: `source-copy`, `source-publish`,
`wheels`, `publish`, `published`), inert unless that variable is set.

November 11 results on an M2 Max (macOS 26): `engine_source_recovery_test`
9/9, `llama_install_recovery_test` 47/47, `mlx_install_recovery_test` 45/45,
`install_recovery_host_test` 6/6. Failing receipts retained from before the
fixes: `llama-install-recovery/run-vv203g6b` (28/46), `mlx-install-recovery/run-5huhx4jp`
(33/45), `install-recovery-host/run-4RqjcD` and `run-kIKlKc` (the host-death
case). `test-llama-upgrade-real` passed 3/3 once (`llama-upgrade-real/run-dakjc0mv`,
129 s build, killed first after 25 compiled objects), before the final rebase
and stand-in change; `test-mlx-upgrade-real` has **not been run**.

Coverage by PLAN.MD P5 item (`ESR` engine_source_recovery_test, `LIR`
llama_install_recovery_test, `MIR` mlx_install_recovery_test, `IRH`
install_recovery_host_test; "none" means no test exercises it):

| P5 item | main | Laguna | llama.cpp | MLX |
| --- | --- | --- | --- | --- |
| 1 bundled sources, empty profile, network denied, no remote fallback | `test-first-launch-e2e` (relocated app, real build); `test-engine-sources` missing/extra/altered; ESR copy/publish cases (spaces) | same as main | `test-first-launch-e2e` (`--install-engine llama`); LIR "bundled source truncated/altered/missing/extra" | `test-mlx-install` (real, no spaces); MIR "bundled wheel altered/truncated/missing/extra"; final relocated bundle: none |
| 2 model stores reused, launched identity bound | `test-setup-live` (Laguna shares the main store); `test-first-launch-e2e` (shared store after reload) | same as main | LIR "upgrade ...", "launch worker: the identity it reports is the upgraded binary the guard starts"; IRH "the next request completes the upgrade ..." (downloaded is not selected or running) | MIR "upgrade ...", "launch worker: ... interpreter the guard starts"; component/settings binding: not mapped here |
| 4 upgrade from an earlier install, user bytes kept | ESR "an installation of the earlier pin is refused as drift before any build" (documented: no in-place upgrade) | none (no earlier Laguna pin) | LIR "upgrade from the b11371 installation ..."; IRH; `test-llama-upgrade-real` | MIR "upgrade from the earlier wheel and patch set ..."; `test-mlx-upgrade-real` (not run) |
| 5 interruption, corrupt state, missing tools, failures, concurrency, owner death, cancellation, reopen | ESR killed while copying / terminated before publication / two installers / bounded candidates; build interruption, missing make, owner death of the build: none | same as main | LIR: SIGKILL and group SIGTERM at six points, failures at each step, missing CMake/python3, state cases, stale lease, two installers, launch-worker owner death; IRH: Stop, host death, reopen, update check and status answered beside a parked installation | MIR: SIGKILL and SIGTERM at six points incl. wheel verification, failures at each step, missing Python/git, patch drift, no Metal, a tool slow to stop, state cases, two installers, owner death; reopen through HTTP: none |
| 6 bounded staging, revalidation, single publication, durable commit | `test-engine-sources` (target/parent races, lease replacement, durability acknowledgement); ESR | same as main | LIR "failed builds keep only their log, at most two", "a lease replaced ... cannot publish", "an installation directory replaced ... is preserved", "one leader publishes once"; crash durability: none | MIR same cases; crash durability: none |

Not covered, and why: the final relocated bundle for MLX and the repeat of
these cases against the final build (P5 items 1 and 6); real compiler
cancellation (only SIGKILL of the whole group runs in the real build);
Linux/Windows (macOS only); power-loss durability; main/Laguna build
interruption and owner death (the host builds those checkouts in place, with
no stage). Retained defect: a main checkout at an earlier pin is refused, but
the four managed adaptations that precede the refusing one stay applied (ESR
records them; their `restore` returns the checkout byte for byte).

## Test cleanup (October 25, 2026)

Tests that existed but no target ran are now wired, each verified on this Mac:

- `make test-design-quality-gates` (in `test-design-runtime`): the creativity
  and rendered font-diversity graders used by `real_design_quality_test.mjs`,
  on authored positive/negative pages. Font diversity needs headless Chrome.
- `make test-pdf-benchmark-tools` (in `check-fast`): the PDF benchmark HTTP
  client, report builder and published Matplotlib charts; no model or network.
- `make test-ui-insecure-origin` (in `test-ui-browser`): the UI opened from a
  LAN device over plain http, without `crypto.randomUUID` or
  `navigator.clipboard`, in WebKit and Chromium; generation is simulated.
- `make test-gsa-cloud-live`: the real GSA loop against the DeepSeek API through
  a running launcher. Explicit and billed, needs `DEEPSEEK_API_KEY`, not part
  of `check-real`. It moved from `tests/unit/` to `tests/live/`.

Removed: a shell wrapper that duplicated `make test-design-build-freshness`; a
roadmap-audit stress script that sent its own copy of the auditor prompt to the
engine instead of exercising the production roadmap flow; an image-edit gate
and prompt fixture that nothing referenced; and the name-specific checks for the
retired `q36` and `ds4-qwen35` engines, replaced by receipt-based cases in
`test-launch-preflight` and `test-engine-startup` (see
[BUNDLED_ENGINES](../../docs/BUNDLED_ENGINES.md#retired-qwen-side-engines)).

October 27, 2026: `qwen35_download_test.py` went with the merged Qwen3.6
downloader (its cases run in `qwen27_download_test.py` on the one
downloader). `qwen38_inspect_patch_test.mjs`,
`qwen38_snapshot_patch_test.mjs`, their Make targets and the compressed fork
sources in `tests/fixtures/retired-qwen-next/` went with the retired Qwen Next
fork's patches. The M2 Max, native round-trip, Agent/runtime migration,
native build and Chat PLD builder tests now cover only the bundled main and
Laguna; the M2 Max lifecycle test runs on a copy of `src/engines/ds4` instead of
reconstructed fragments of three older layouts. No backward compatibility is
kept: the M2 Max test checks that the previously shipped port is refused as
drift, the Design builder test that an edited residency delta is refused, and
the preflight/setup units that a leftover checkout is refused only by its
receipt (the name-based `ds4-qwen38` and old Qwen Next format cases are gone).
