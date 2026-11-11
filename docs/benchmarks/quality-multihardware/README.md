# Common 100-task corpus on the maintainer's Mac

**Work in progress.** This page publishes the reviewed results of the November
2026 campaign ([plan](../../../PLAN.MD)) as they are completed. No model
selection passes the campaign's gate, which requires 100 of 100 tasks. Nothing
here qualifies a model, ranks one engine above another or measures speed.

![Tasks passed out of 100 by model selection; failed and unexecuted tasks stay visible](overview.png)

Each bar is **one run** of the same 100 tasks: one model started alone on an
Apple M2 Max with 96 GiB, thinking off. The selections use different
quantizations and engines, so the bars are not a ranking.

| Selection | Engine | Passed | Did not pass | Not run | Category chart |
| --- | --- | ---: | ---: | ---: | --- |
| Qwen3.8-27B UD-Q6_K_XL | llama.cpp `b11836` | 73 | 27 | 0 | [chart](qwen27-q6-llama.png) |
| Qwen3.6-35B-A3B MXFP8 | MLX (mlx-lm 0.32.2) | 68 | 32 | 0 | [chart](qwen36-mxfp8-mlx.png) |
| Qwen3.6-35B-A3B UD-Q6_K_XL | llama.cpp `b11836` | 67 | 33 | 0 | [chart](qwen36-q6-llama.png) |
| DeepSeek V4 Flash Vision-Exp IQ2XXS | ds4 main `890898c` | 51 | 49 | 0 | [chart](deepseek-v4-vision-exp-iq2xxs.png) |
| Laguna S 2.1 Q4_K_M | ds4 Laguna `448d569` | 51 | 37 | 12 | [chart](laguna-s21-q4.png) |

Selections of the campaign without a published result yet: Qwen3.8-Flash-Next
Q4, DeepSeek V4.1 Flash 1017 Q2 (expert SSD streaming only) and
Qwen3.8-Flash-Next Q2 (no weights on this machine: blocked). DeepSeek V4.1 Q4 and GLM 5.3 Flash are left to contributors with
suitable hardware.

## What failed

Passed tasks by category (passed / tasks):

| Category | Qwen3.8-27B | Qwen3.6 MXFP8 (MLX) | Qwen3.6 Q6 (llama.cpp) | DeepSeek V4 Vision-Exp | Laguna S 2.1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Arithmetic and units | 2 / 12 | 1 / 12 | 5 / 12 | 2 / 12 | 3 / 12 |
| Reasoning | 6 / 12 | 6 / 12 | 7 / 12 | 7 / 12 | 7 / 12 |
| Writing code | 12 / 15 | 13 / 15 | 7 / 15 | 0 / 15 | 6 / 15 |
| Fixing bugs | 5 / 10 | 4 / 10 | 5 / 10 | 1 / 10 | 1 / 10 |
| JSON structure | 9 / 10 | 9 / 10 | 8 / 10 | 8 / 10 | 9 / 10 |
| Extracting facts | 9 / 10 | 9 / 10 | 9 / 10 | 7 / 10 | 9 / 10 |
| Following instructions | 10 / 10 | 8 / 10 | 8 / 10 | 8 / 10 | 8 / 10 |
| Italian and English | 8 / 8 | 8 / 8 | 8 / 8 | 8 / 8 | 8 / 8 |
| Long texts | 7 / 8 | 5 / 8 | 5 / 8 | 6 / 8 | 0 / 8 (7 not run) |
| Recognising missing information | 5 / 5 | 5 / 5 | 5 / 5 | 4 / 5 | 0 / 5 (not run) |

Most failures are answers and formats, not transport: wrong arithmetic, a
correct value wrapped in a JSON object the task did not ask for, code inside
Markdown fences, and replies that are not the requested unified diff. A correct
value in the wrong container **stays failed** and receives no partial credit;
the aggregates count it separately (10 tasks for Qwen3.8-27B, 6 for Qwen3.6 on
MLX, 2 for Qwen3.6 on llama.cpp, 5 for DeepSeek V4, 6 for Laguna).

DeepSeek V4 Flash Vision-Exp returned all fifteen programs, and seven of its
ten patches, inside Markdown fences, although each task says to return only
the source or the diff. The grader runs what was returned, so every one of
those fails; the run says nothing about whether the code inside the fences was
correct. All eight of its long texts completed (about five minutes each).

The Laguna run is incomplete. On its first long text the engine answered
HTTP 500 (`metal Laguna prefill failed at token 32768`) and the twelve tasks
after it were not run; they stay in the denominator. That run had no engine
restart between tasks. The cause is **not established**: macOS ended a GPU
command batch while other jobs were using the machine, and whether the failure
also happens on an idle machine has not been checked yet.

## What this measures

A **development replay**: the corpus has been used during development, so this
is not a held-out evaluation. The frozen
[corpus](../../../tests/fixtures/common_model_quality_cases.py) and
[grader](../../../tests/support/common_model_quality.py) check returned
answers, programs and patches against independent expected results. There are
100 tasks in ten categories of unequal size and one execution per task: no
confidence interval is claimed, and a difference of a few tasks between two
bars is not evidence that one selection is better.

It does not run an Agent tool loop, compare agents, check PDF or image
understanding, or establish numerical equivalence with a reference
implementation.

Settings, identical for every run: context capacity 65,536 tokens, temperature
0, seed 20260909, thinking off, at most 2,048 output tokens. Deadlines: 180 s
for ordinary tasks, 240 s for code, 900 s for long texts. Failed tasks are
never retried. Capacity is not a claim that every request used 65,536 tokens.
The machine was shared with model-free test jobs during the runs; these results
must not be used to compare speed.

The two Qwen3.6 runs started from a source tree with uncommitted test-harness
files, which their aggregates record (`hostTreeDirty`); later runs use a clean
tree at a recorded commit.

## Data

Each file in [`results/`](results) is the public aggregate of one run: totals,
category counts, failure classes, settings, the SHA-256 of the weights (one
digest over the file list for an MLX model folder), of the engine binary or
install receipt and of the host binary, the upstream engine commit, and the
SHA-256 of the private receipt it was derived from. Requests, answers, logs and
local paths stay in ignored evidence on the maintainer's machine, so the
aggregates reproduce the charts but not the grading of each raw answer.

## Recreate the charts

Requires Python 3 with Matplotlib. No model, network or user document is used:

```sh
python3 extension/benchmarks/qwen-quality/plot-results.py
make test-qwen-quality-chart
```

A new run is published by creating its aggregate with
`node tests/support/common_quality_summary.mjs TERMINAL_RESULTS.json NEW_PUBLIC.json`
and adding a reviewed entry, keyed by the receipt's SHA-256, to the plotting
script. The script refuses an aggregate that has no reviewed entry.
