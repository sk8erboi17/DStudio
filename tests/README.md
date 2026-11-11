# Tests: what each result actually proves

Correctness before performance. No test is accepted merely because a function
name, comment, prompt phrase or CSS declaration occurs in application source.

This page is the test index. Detailed commands, prerequisites, original failures
and verification limits live in the topic guides below. Run commands from the
repository root; generated receipts stay in ignored `tests/.artifacts/`.

- `make check-fast` is the broad model-free gate, not a dependency-free check.
- `make check-real` runs real-model scenarios; `make check` includes both sets.
  Its three suites (ASCII diagrams, Search/Research, remote) start Chat on
  their own host with explicit weights: `DSTUDIO_REAL_GGUF`, else the
  installed DeepSeek V4 Flash Vision-Exp IQ2XXS; without either they stop as
  BLOCKED. Until November 11, 2026 they waited for the host to start a
  default model that a fresh profile no longer selects, and failed after 30
  minutes (`campaign/queue-logs/q5-real-*.log`, retained).
  Those heavy runs require the owner's scope and installed weights.
- Browser fixtures with simulated model replies verify UI behavior, not inference
  quality. Real extraction, native processes or Metal kernels are identified
  separately by each gate.
- Select focused checks for a change. A documentation reorganization does not
  require starting models, downloading weights or restarting the user's app.

The detailed unfinished acceptance requirements remain in [PLAN.MD](../PLAN.MD).
[Current admission](../docs/ENGINE_UPSTREAM_ALIGNMENT.md) and
[historical reports](../docs/history/README.md) keep their separate evidence.

## Suite census

`node tests/support/test_census.mjs` lists every test file and how it is
reached: by `check-fast`, by `check-real`, only by an explicit `make` target,
only by a hand-run command given in a guide, or by nothing. It executes no test
and judges no result (`make test-census` checks the census itself on a
synthetic tree). On November 11, 2026 it counted 283 files: 179 reached by
`check-fast`, 3 by `check-real`, 85 by an explicit target only and 16 by a
documented manual command only. Four of those sixteen are explicit diagnostics
that no target starts; their commands are here so that they are accounted for:

- `node tests/live/main_decode_comparison.mjs LABEL ENGINE COMMIT MODE OUTPUT`:
  real sequential native prefill/decode measurement of one engine revision;
  its metric parsing is checked by `make test-main-decode-metrics`.
- `node tests/live/heavy_media_benchmark.mjs --kind KIND --output DIR -- COMMAND`:
  wall time and memory of one media worker command. The Ideogram, Hunyuan and
  MiniMax workers are outside the macOS completion campaign.
- `python3 tests/live/hunyuan_first_step_probe.py` and
  `python3 tests/live/hunyuan_reasoning_finite_probe.py`: diagnostic-only
  probes that locate the first non-finite Hunyuan stage; they approve no output.

A file reached by nothing is not evidence of anything: wire it to a target,
give its command in a guide, or remove it in the final simplification step.

The census also lists, for each file, the prerequisites it can detect from
what the file and the recipe that runs it name (`--needs` prints them per
file): the browsers a recipe actually selects, the host test binary or the
app, Python modules outside the standard library, external tools such as
Poppler, CMake, ffmpeg or Git, and real weights for everything under
`tests/live/`. On November 11, 2026, of 283 files: 49 start a browser (8 in
Chromium only, 35 in Chromium and WebKit, 4 in WebKit only, 1 in all three,
1 not determined), 49 need the host test binary, 50 a real engine or weights
and 5 Matplotlib. Before eight suites gained their WebKit run that day, 16
ran in Chromium only.
This is a reading aid derived from the sources, not a guarantee: a suite that
lacks a prerequisite must still report itself as not run or blocked.

`node tests/support/gate_run.mjs check-fast` runs a gate one target at a time
(`--only TARGET,...` reruns some of them). Each invocation owns a new directory
in ignored `tests/.artifacts/gate-runs/` with one log per target and a
`results.json`: exit status, duration, the case lines each target printed as
passed or failed, and the lines in which it reported something as not run or
blocked. The verdict of a target is its exit status, never its printed lines.
A rerun does not replace an earlier run, so an intermittent failure stays on
record beside the rerun that passed. `make test-gate-run` checks the runner on
a synthetic Makefile.

`node tests/support/gate_run.mjs --cases RUN_DIR` lists the case lines of a
finished run with their state (`--json` for every line): the case-level
census of what that run executed. It reads the retained logs and changes
nothing. The complete run of November 11 (`check-fast-h83qnj`) lists 2,414
passed and 2 failed case lines over 122 targets; targets that print no case
line per check are counted by their exit status only.

## Topic guides and section links

The anchors below retain existing links to this index. Project links point
directly to the corresponding guide and section.

### Browser and native-window UI

- <a id="aperture-startup-screen"></a>[Aperture startup screen](docs/ui.md#aperture-startup-screen)
- <a id="sidebar-and-native-macos-title-bar"></a>[Sidebar and native macOS title bar](docs/ui.md#sidebar-and-native-macos-title-bar)
- <a id="open-ide-agent-workspace-view"></a>[Open IDE (Agent workspace view)](docs/ui.md#open-ide-agent-workspace-view)
- <a id="blueprint-agent"></a>[Blueprint (Agent)](docs/ui.md#blueprint-agent)
- <a id="gsarsa-workflow-workspace"></a>[GSA/RSA workflow workspace](docs/ui.md#gsarsa-workflow-workspace)
- <a id="image-previews-under-the-native-http-policy"></a>[Image previews under the native HTTP policy](docs/ui.md#image-previews-under-the-native-http-policy)
- <a id="complete-simulated-ui-matrix"></a>[Complete simulated UI matrix](docs/ui.md#complete-simulated-ui-matrix)
- <a id="reasoning-markdown-spacing"></a>[Reasoning Markdown spacing](docs/ui.md#reasoning-markdown-spacing)

### Design systems, startup and provenance

- <a id="twenty-five-original-design-systems"></a>[Twenty-five original Design systems](docs/design.md#twenty-five-original-design-systems)
- <a id="design-startup-and-baseline-provenance"></a>[Design startup and baseline provenance](docs/design.md#design-startup-and-baseline-provenance)

### Model development checks and measured results

- <a id="qwen-next-on-unified-main"></a>[Qwen Next on unified main](docs/model-quality.md#qwen-next-on-unified-main)
- <a id="common-100-answer-quality"></a>[Common-100 answer quality](docs/model-quality.md#common-100-answer-quality)
- <a id="qwen-real-host-workflows"></a>[Qwen real host workflows](docs/model-quality.md#qwen-real-host-workflows)
- <a id="focused-gates-and-measured-results"></a>[Focused gates and measured results](docs/model-quality.md#focused-gates-and-measured-results)

### Runtime transport, Stop, Goals and steering

- <a id="host-relay-and-model-rpc"></a>[Host relay and model RPC](docs/runtime-control.md#host-relay-and-model-rpc)
- <a id="model-stream-integrity-and-stop"></a>[Model-stream integrity and Stop](docs/runtime-control.md#model-stream-integrity-and-stop)
- <a id="goal-and-context-during-execution"></a>[Goal and context during execution](docs/runtime-control.md#goal-and-context-during-execution)

### Native backends, model variants and harnesses

- <a id="native-backend-and-browser-gates"></a>[Native backend and browser gates](docs/engines-and-harnesses.md#native-backend-and-browser-gates)
- <a id="cowork-spreadsheet-read-scope-and-saved-file-receipts"></a>[Cowork spreadsheet read scope and saved-file receipts](docs/engines-and-harnesses.md#cowork-spreadsheet-read-scope-and-saved-file-receipts)
- <a id="qwen36-and-qwen38-27b-on-llamacpp"></a>[Qwen3.6 and Qwen3.8-27B on llama.cpp](docs/engines-and-harnesses.md#qwen36-and-qwen38-27b-on-llamacpp)
- <a id="disk-kv-snapshots-for-llamacpp-off-by-default"></a>[Disk KV snapshots for llama.cpp (off by default)](docs/engines-and-harnesses.md#disk-kv-snapshots-for-llamacpp-off-by-default)
- <a id="qwen36-on-mlx-apple-silicon"></a>[Qwen3.6 on MLX (Apple Silicon)](docs/engines-and-harnesses.md#qwen36-on-mlx-apple-silicon)
- <a id="every-pinned-qwen36-and-qwen38-27b-variant"></a>[Every pinned Qwen3.6 and Qwen3.8-27B variant](docs/engines-and-harnesses.md#every-pinned-qwen36-and-qwen38-27b-variant)
- <a id="streaming-and-live-tool-previews"></a>[Streaming and live tool previews](docs/engines-and-harnesses.md#streaming-and-live-tool-previews)
- <a id="app-binary-helper-modes"></a>[App-binary helper modes](docs/engines-and-harnesses.md#app-binary-helper-modes)
- <a id="harnesses-pi-and-opencode-as-the-agent-runtime"></a>[Harnesses: pi and OpenCode as the Agent runtime](docs/engines-and-harnesses.md#harnesses-pi-and-opencode-as-the-agent-runtime)
- <a id="engine-source-delta-review"></a>[Engine source-delta review](docs/engines-and-harnesses.md#engine-source-delta-review)
- <a id="codex-cli-responses-protocol-scripted-server"></a>[Codex CLI Responses protocol (scripted server)](docs/engines-and-harnesses.md#codex-cli-responses-protocol-scripted-server)

### Offline installation, inference boundaries and cleanup

- <a id="clean-installation-and-real-inference"></a>[Clean installation and real inference](docs/installation.md#clean-installation-and-real-inference)
- <a id="bundled-offline-engine-sources-september-30-2026"></a>[Bundled offline engine sources (September 30, 2026)](docs/installation.md#bundled-offline-engine-sources-september-30-2026)
- <a id="upgrade-interruption-and-recovery-november-11-2026"></a>[Upgrade, interruption and recovery (November 11, 2026)](docs/installation.md#upgrade-interruption-and-recovery-november-11-2026)
- <a id="test-cleanup-october-25-2026"></a>[Test cleanup (October 25, 2026)](docs/installation.md#test-cleanup-october-25-2026)

### Downloads, native regression gates, documents and LAN

- <a id="local-regression-suite"></a>[Local regression suite](docs/regression.md#local-regression-suite)
- <a id="deepseek-v41-http-download-and-resume"></a>[DeepSeek V4.1 HTTP download and resume](docs/regression.md#deepseek-v41-http-download-and-resume)
- <a id="automatic-matching-vision-downloads-host-fixtures"></a>[Automatic matching vision downloads (host fixtures)](docs/regression.md#automatic-matching-vision-downloads-host-fixtures)
- <a id="deepseek-v41-vision-sidecar-pairing-real-engine-no-weights"></a>[DeepSeek V4.1 vision sidecar pairing (real engine, no weights)](docs/regression.md#deepseek-v41-vision-sidecar-pairing-real-engine-no-weights)
- <a id="vision-encoder-with-ssd-streaming-real-metal"></a>[Vision encoder with SSD streaming (real Metal)](docs/regression.md#vision-encoder-with-ssd-streaming-real-metal)
- <a id="small-ssd-prefill-batches-real-metal-128k-context"></a>[Small SSD prefill batches (real Metal, 128k context)](docs/regression.md#small-ssd-prefill-batches-real-metal-128k-context)
- <a id="model-free-checks"></a>[Model-free checks](docs/regression.md#model-free-checks)
- <a id="frozen-vision-corpus"></a>[Frozen vision corpus (PDFs and images)](docs/regression.md#frozen-vision-corpus)
- <a id="vision-corpus-grader-and-run-loop"></a>[Vision corpus grader and run loop](docs/regression.md#vision-corpus-grader-and-run-loop)
- <a id="lan-sessions-ocr-and-cowork-limits-october-3-2026"></a>[LAN, sessions, OCR and Cowork limits (October 3, 2026)](docs/regression.md#lan-sessions-ocr-and-cowork-limits-october-3-2026)
