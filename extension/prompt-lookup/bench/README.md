# Prompt lookup: real-engine benchmark

This suite starts the actual managed DS4 engine and loads real GGUF weights.
It compares PLD **off**, ordinary **strict** generation, and experimental
**batch** verification in Chat, Agent and Cowork. It is separate from the
model-free implementation tests and does not run under `check-fast`.

The question is simple: **does it complete the same task correctly, and does
it take less time?** Failed or different-output pairs are excluded from the
speedup calculation, never counted as a fast success. All failures remain in
the correctness totals and raw results. Nonzero actual verifier batch counts
are required to attribute any result to PLD batching.

## What is covered

Thirteen distinct fixtures, each repeated twice in each of three modes: 78
measured tasks. Chat copies text, preserves code during an edit, extracts a
document section with Unicode/escaping, streams output, computes a new answer,
stops on a string and generates a structured tool call. Agent writes a full
file, makes a surgical edit and creates a new function. Cowork copies a real
text document, revises one value and writes a newly computed result.

Copy-heavy cases intentionally test where prompt lookup is useful. New-answer
controls test where it may have no benefit. This is **not** representative of
every real workload. It does not evaluate NanoIndex retrieval, the Task Graph
wrapper, UI/browser interaction, sampled decoding, images, multiple sessions,
SSD streaming, very long contexts or all interruption/recovery paths.

## Measured results: 5 September 2026, Minecraft running

**Chat benefited in this run; Agent did not get an overall speedup.** All 78
measurements completed with the real managed engines, in about 66.7 minutes.
Minecraft/Lunar stayed open throughout the run: its process was recorded in
all 796 periodic samples, plus the startup check. A temporary macOS
`taskpolicy -b` background priority was applied to the game before measurement
and restored with `taskpolicy -B` afterwards. This is not a RAM allocation or
a hard CPU/GPU cap. No game restart or competing loaded inference engine was
used. The benchmark engines were shut down after their measurements.

M2 Max, 96 GiB system memory, DeepSeek V4 Flash IQ2XXS 0731 (80.76 GiB weights),
Metal, context 8192, power 70, greedy sampling, thinking off, SSD streaming off.
The engine reported 81.24 GiB planned for resident weights, KV and buffers.
Existing macOS swap was present; this is distinct from engine SSD streaming.

| Surface | Correct / measured, in **each** mode | Default vs off | Experimental vs off | Correct identical pairs used |
|---|---:|---:|---:|---:|
| Chat | 14/14 | 0.99× | 2.84× | 14 |
| Agent | 6/6 | 0.93× | 1.00× | 6 |
| Cowork | 2/6 | 1.01× | 1.03× | 2 |

These are medians of paired time ratios, not ratios of overall medians.
Values above 1 mean the task finished sooner. With Minecraft/desktop load
varying, the ratios describe this run; they do **not** isolate the causal PLD
gain or establish statistical significance. For example, `chat-new` ran zero
verification batches but still had different timings. Do not attribute that
control's change to accelerated verification.

Experimental mode executed **1,936 actual verification batches**: 922 Chat,
480 Agent and 534 Cowork. Twelve of fourteen Chat experimental attempts ran
batches; restricting Chat's paired ratio to those twelve gives 3.33×, still
subject to the shared-host limitation. Batches ran in all six Agent and all
six Cowork experimental attempts, including the failed Cowork tasks.

### What the individual tasks did

Times below are medians of two repetitions, in seconds. Failed rows are shown
for transparency but are **not** used as speed successes. This table compares
experimental batching with PLD disabled; the full data also include default
`strict` mode.

| Task | PLD disabled | Experimental | Correct in each mode |
|---|---:|---:|---:|
| Chat: copy existing text | 30.05 | 12.34 | 2/2 |
| Chat: preserve code while changing a version | 67.87 | 29.12 | 2/2 |
| Chat: extract a document section | 60.64 | 13.43 | 2/2 |
| Chat: stream the copied text | 44.29 | 13.26 | 2/2 |
| Chat: compute a new answer (zero batches) | 7.75 | 3.44 | 2/2 |
| Chat: stop before an unwanted suffix | 57.01 | 12.66 | 2/2 |
| Chat: supply exact tool arguments | 59.41 | 19.04 | 2/2 |
| Agent: read, copy and verify a code file | 85.99 | 74.96 | 2/2 |
| Agent: make a small edit | 36.74 | 36.67 | 2/2 |
| Agent: create a new function | 21.76 | 28.29 | 2/2 |
| Cowork: copy a text document | 108.15 | 68.50 | **0/2** |
| Cowork: revise one document value | 88.26 | 63.42 | **0/2** |
| Cowork: write a calculated result | 28.76 | 28.06 | 2/2 |

### Correctness findings

There were **66 passes and 12 failures**, with the same pass/fail outcome and
output artifact in all modes and both repetitions for every case. There were
no engine/transport errors, unexpected fixture modifications or competing
loaded models recorded. Exact initial input-token hashes matched across all
Agent/Cowork comparisons.

The twelve failures are Cowork copy/revision tasks losing only the final
newline, already with PLD off. Their `write_document` calls contain a `content`
argument missing that newline; the existing `.txt` writer encodes and writes
the supplied content without trimming it
([Office helper](../../cowork/office_tool.py)). This localizes the observed
loss before file persistence; it is not a demonstrated PLD regression or a
disk-write error. No checker was relaxed to turn these into passes.

The results do not establish improved reliability or full token/state
equivalence, and do not justify enabling experimental batching everywhere.
The standalone implementation suite also passed **27,885 checks**, patch/build
contracts and publication validators. ASan/UBSan passed with macOS leak
detection disabled because that option is unsupported on this platform.
Those are model-free implementation checks, separate from the 78 real tasks.

[Published measured data](results/2026-09-05-m2-max-minecraft-no-ssd.json) ·
[Matplotlib chart](../../../assets/README%20images/benchmarks/prompt-lookup-minecraft-real-engine.png)

## Method

- Same model, weights, greedy sampling, context and power for every mode.
- The model-visible session clock is fixed with `RUN_HEAVY=1`,
  `DS4UI_BENCHMARK_EPOCH=1788566400`, `TZ=UTC`. Wall-clock timing and the OS
  clock are not modified. Agent/Cowork input token hashes must match across
  modes and repetitions; a mismatch aborts the comparison.
- One engine at a time; a model-free llama.cpp router is allowed, a loaded
  competing model is not. Overlap is monitored and reported.
- Mode order is reversed on the second repetition to reduce order bias.
  This small sample is descriptive, not a statistical significance claim.
- Model startup and one warmup are reported separately and excluded from
  task timing. Task time includes prefill, tools, snapshot, verify and replay.
- Agent/Cowork use the same absolute working directory in every mode, with
  recreated synthetic files and a fresh conversation before each task.
  `DS4UI_SESSION_CACHE_DIR` isolates saved benchmark conversations without
  touching the user's cache or changing `HOME`.
- Cowork receives the actual `extension/cowork/COWORK.md` system instructions,
  matching the app's Office workflow. A preliminary transport-only pilot that
  omitted that file is not part of the published comparison.
- An exploratory run exposed upstream's per-session timestamp injection.
  Its changing prompt tokens made Agent/Cowork A/B attribution invalid, so
  that run was stopped and is excluded from the final fixed-clock results.
- File checks run outside the model. Unauthorized fixture changes fail the
  task. Copies/revisions compare every byte, including the final newline.
  New code has executable assertions. Chat text ignores trailing whitespace
  only; its JSON control checks the product and sorted array, and its tool
  case requires one named call with the exact body. API-generated random
  tool IDs are not output differences. Speed ratios require matching full
  output hashes in addition to passing these checks. Agent/Cowork hashes
  compare the resulting file, not the entire sequence of tool calls.
- Trace counters are recorded alongside raw outputs and model/binary/patch
  identities. A lookup hit is not treated as an executed verification batch.
- macOS swap is measured separately: disabling the engine's SSD-streaming
  feature does not guarantee that the operating system never swaps other
  memory. Interpret small timing differences cautiously under memory pressure.
  Process RSS is diagnostic only: it does not account for all Metal-mapped
  weights and must not be presented as the model's total memory footprint.
- A running Minecraft/Lunar game process or another process using at least
  50% CPU is rejected at startup. Such contention is monitored during the run
  too. `--allow-busy-host --host-label "Minecraft running"` explicitly permits
  a shared-host run. These results can be published/plotted only with
  `--shared-host`, with the workload visible in the chart and report. They
  describe use alongside other apps, **not isolated PLD speed gains**; varying
  CPU/GPU/memory contention can change the ratios. `--host-note` records any
  temporary priority adjustment. Monitoring is not a complete GPU profiler.

## Run

Build first, without loading weights:

```sh
make tests/.build/dstudio-server-test
./tests/.build/dstudio-server-test --build-jsonl ./ds4
./tests/.build/dstudio-server-test --build-server-pld ./ds4
```

Run the full measurement explicitly:

```sh
RUN_HEAVY=1 node extension/prompt-lookup/bench/run-real.mjs \
  --output tests/.artifacts/pld-real-my-run
```

Options: `--model`, `--engine`, `--ctx` (8192), `--power` (70),
`--repeats` (2), `--surfaces chat,agent,cowork`, `--modes off,strict,batch`,
`--cases chat-copy,...`, `--timeout-ms` (600000).
Existing output directories are never overwritten. Default model: local
DeepSeek V4 Flash IQ2XXS 0731. No model is downloaded. SSD streaming and DSpark
are not enabled by this benchmark.

Summarize and plot only actual collected results:

```sh
node extension/prompt-lookup/bench/summarize.mjs RUN/results.json
node extension/prompt-lookup/bench/publish.mjs RUN/results.json PUBLIC.json
python3 extension/prompt-lookup/bench/plot-results.py PUBLIC.json OUTPUT.png
```

For an explicitly shared-host run, append `--shared-host` to both publication
and plotting commands. Raw local runs, including interrupted pilots, are
preserved under the ignored `tests/.artifacts/` folder and are never merged.

`make test-pld` checks validators and patch/state handling without a model.
`make test-pld-real` is the explicit heavyweight target.
