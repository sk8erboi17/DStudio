# Real installation and inference checks — September 5, 2026

**Qwen: 26.44 tokens/s during generation and 12 of 12 checks passed through DStudio.**
Measured on an Apple M2 Max with 96 GB of memory while Minecraft/Lunar Client
was running. This is not a speed promise for every conversation.

This is a historical run, not the current support matrix. See the
[current models and limitations](../README.md#supported-models-and-limitations)
and [work-in-progress status](WORK_IN_PROGRESS.md) for later integrations.

## What worked, in plain language

| Check | DS4 / DeepSeek Flash | Laguna S 2.1 | Qwen3.8-Flash-Next |
| --- | --- | --- | --- |
| Download sources into an empty directory, build them and start the executables | Passed | Passed | Passed |
| Answer questions with independently specified answers and follow the protocol | 11/12 | 10/12 | 12/12 |
| Real-model test path | Native engine | Native engine | DStudio startup and Chat proxy |

The DeepSeek and Laguna weights were already installed: the tests actually
loaded them without downloading them again. For Qwen, **both files** were
downloaded: 73.4 GB of main weights and 32.0 GB of PLE, fully verified with SHA-256.

The 12 checks cover arithmetic, negative numbers, JSON extraction, sorting with
duplicates, Unicode text, memory across turns, retrieval from 90 lines, reasoning
about Python code, rejection of a malformed request, recovery after that error,
a tool call followed by use of its result, and a complete streaming answer.

The tool test supplies a controlled inventory response: it checks a model-generated
call and subsequent use of the result, not an autonomous end-to-end Agent task.
At the time of this run, Qwen was integrated in **Chat/native**; Agent, Cowork
and Design were explicitly rejected because their adapter was not yet available.

### Later fix: Qwen and the saved SSD setting

The real-model test explicitly requested SSD streaming **Off**. It did not cover
starting from the UI with **On** still saved for DeepSeek. That case could block
Qwen before loading. The UI now applies Off to Qwen, keeps PLE on SSD and preserves
the preference for other models. Browser regressions check initial startup with
On/Auto/Off, DeepSeek → Qwen → DeepSeek switching, and restarting after a context
setting change. These regressions use simulated engine responses: they verify
UI requests and **do not add inference results** to the 12/12 above.

## Failures remain visible

- DeepSeek returns `:16` instead of `16` in the Python case: the numeric result
  is correct, but the requested format is not respected.
- Laguna retrieves `197` instead of `203` from the list: an incorrect answer.
- Laguna calculates `16` in the Python case but adds an explanation when only
  the number was requested: a format failure.

Those two runs therefore fail overall. Assertions were not weakened to hide
the failures. Their cause has not been isolated to the model, quantization or
engine; that requires numerical comparison with a reference implementation.
Qwen passes this small suite; **that does not make it infallible or better at
every task**.

## How fast Qwen generated text

Three consecutive native processes copied the same 32-row CSV. Each complete
output was compared with the original: **3/3 exact matches**.

| Run | Engine-reported generation speed | Total process time |
| --- | --- | --- |
| 1 | 27.15 tokens/s | 35.10 s |
| 2 | 26.44 tokens/s | 33.17 s |
| 3 | 25.98 tokens/s | 32.49 s |

The median is **26.44 tokens/s**. Tokens are text fragments, not necessarily
words. This generation metric excludes loading and initial prompt processing;
total process time includes those phases. It measures the native CLI on a copy
task, **not Agent speed or complete Chat latency**, and is not a matched comparison
with the other two models' runs.

Settings: Metal, 8,192-token context, prompt processing in blocks of 512,
reasoning off, deterministic generation, no PLD/MTP or expert streaming.
Main weights are resident; PLE is read from SSD as part of the architecture.
During these three measurements, the benchmark session ran no other models,
downloads or builds; Minecraft remained open. Variability across other machines
or workloads was not measured.

## Bugs found and fixed by these tests

- The DS4 revision used for first-run download was incompatible with the current
  patches: its pin was updated to the verified revision.
- The Design build on Laguna required unavailable vision APIs: capabilities are
  now checked by compiling a small program, and unsupported options return an
  explicit error.
- A shared model-directory link could point to the wrong location: directory
  identity is now checked while preserving user data.
- Headless startup could apply DeepSeek patches to a Qwen checkout: incompatible
  model/engine combinations are now rejected before mutation. The final Chat run
  also checks that Qwen sources remain unchanged.
- The picker could treat PLE as a separate model or offer Qwen without PLE:
  it now distinguishes the components and lets the user complete the download.

## Reproduce and verify

```sh
./download-model.sh qwen38-q4k
make test-setup-live
make test-inference-live
make test-qwen-chat-live
make benchmark-qwen-decode
```

Run heavy tests one at a time. Incorrect answers, missing weights, timeouts and
missing dependencies do not count as successes. `make check-fast` separately
checks functions, HTTP and browser behavior without loading a large model.

[Published data: requests, answers, failures, revisions, hashes and measurements](benchmarks/engine-acceptance-2026-09-05.json).
Full logs remain in the Git-ignored `tests/.artifacts/engine-acceptance/` and
`tests/.artifacts/qwen-decode/` directories. These are observable workflow checks,
not proof of logit equivalence, correctness on every input, Qwen multimodal
support or parity across Metal, CPU and CUDA.
