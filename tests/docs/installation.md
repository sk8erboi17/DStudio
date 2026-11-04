# Offline installation, inference boundaries and cleanup

[All test guides](../README.md). Run commands from the repository root.
Each section retains its original scope, prerequisites, results and limitations;
a historical pass is not a pass on a newer runtime.

## Clean installation and real inference

```sh
make test-setup-live                  # Real GitHub downloads + builds: main, Laguna, Qwen3.8, Qwen3.6
make test-first-launch-e2e            # Headless .app + real WebKit UI + fresh offline engine installation
make test-inference-live              # Real resident Metal: installed DeepSeek + Laguna
make test-inference-live ENGINES=qwen  # Requires downloaded Qwen base + PLE
make test-engine-acceptance           # Fresh builds AND real inference for all four engines
make test-qwen-chat-live              # Actual DStudio launch + Chat HTTP proxy, real Qwen
make benchmark-qwen-decode            # Native generation tok/s, three exact-output checks
```

The setup gate calls DStudio's production headless installer, using the same
bundled-source installer and runtime builders as app setup. It starts with no engine
directory, verifies/copies pinned local sources, builds the executables,
executes their help command, and checks that optional engines share the model
store. It does **not** simulate a browser onboarding click. Existing user
checkouts, models, preferences and running processes are not replaced or stopped.

`test-first-launch-e2e` instead relocates the signed `.app`, starts its real
binary from `/` with an empty `DS4UI_DATA_DIR`, and uses headless WebKit to
operate the first-run installation controls. `DS4UI_TEST_MODE` is **not** set.
It clicks Install, chooses the optional models, and checks real setup responses,
pinned revisions, compiled executable startup, automatic checkout selection,
shared model storage and discovery after reload. It also reverses/reapplies six
native main adaptations on a private source copy and requires exact file
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
loaded **one at a time**, with 8k context, DSpark off, resident Qwen/Laguna and
SSD expert streaming for main DeepSeek/GLM models. Qwen3.8 keeps its native SSD
PLE. Each model must become ready, return exact arithmetic and JSON extraction
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
with the new engine pin. Its Design adapter is not implemented. Only Qwen3.8
needs the SSD-backed PLE file. Qwen3.6 and Qwen3.8-27B run on the bundled
llama.cpp engine; see [Qwen3.6 and Qwen3.8-27B on llama.cpp](engines-and-harnesses.md#qwen36-and-qwen38-27b-on-llamacpp).

The Qwen3.6 sections that followed here (fresh `ds4-qwen35` setup, its
September 7 11/12 native baseline in `engine-acceptance/run-m8zF5Z/`, and the
`ds4-qwen35-catalog` patch) described the retired fork. Their receipts are
retained under ignored `tests/.artifacts/`; the commands were removed with the
fork and are no longer runnable.


## Bundled offline engine sources (September 30, 2026)

`make test-engine-sources` executes the production verifier, source copy and
exclusive publisher with real files. Its 18 cases cover byte/mode integrity,
missing/extra/altered inputs, linked files and parents (including a deterministic
parent-switch barrier), source/manifest and target races, owner-lease replacement,
independent preparations overlapping at a deterministic barrier,
retained-candidate limits and interrupted durability acknowledgement. It also
copies/verifies all three active source snapshots (main, Laguna, llama.cpp) and
rejects copying or installing the retired Qwen Next source. `make test-macos-bundle`
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
