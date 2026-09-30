# Q36 Quality Testing

This directory uses OpenRouter as the hosted Qwen3.6 reference and scores the
local Q36 GGUF with the native Vulkan runtime.

Hosted reference model:

```text
qwen/qwen3.6-35b-a3b
```

Local standard model:

```text
gguf/Qwen3.6-35B-A3B-AntirezExperts-IQ2XXS-gateup-Q2K-down-Q8rest.gguf
```

Do not put the API key in commands, scripts, or committed files:

```sh
export OPENROUTER_API_KEY=...
```

## OpenRouter Reference

Collect short hosted continuations and response metadata from OpenRouter. The
reference is pinned to Parasail FP8 without provider fallback:

```sh
make reference-openrouter
```

The default output is `gguf-tools/quality-testing/local/openrouter/`, which is
ignored by Git. Override `OPENROUTER_MODEL`, `OPENROUTER_OUT`, or
`OPENROUTER_COUNT` when needed.

The collector writes:

```text
gguf-tools/quality-testing/local/openrouter/manifest.tsv
gguf-tools/quality-testing/local/openrouter/prompts/case_*.txt
gguf-tools/quality-testing/local/openrouter/continuations/case_*.txt
gguf-tools/quality-testing/local/openrouter/responses/case_*.json
```

`manifest.tsv` is the input for local scoring. The prompt text is rendered
through the Q36 chat template inside the local scorer, and the OpenRouter
continuation is scored token by token with local logits.

## Local Q36 Score

Build the scorer:

```sh
make q36-quality-score
```

Score the mixed model with Vulkan and SSD streaming:

```sh
gguf-tools/quality-testing/score_openrouter \
  gguf/Qwen3.6-35B-A3B-AntirezExperts-IQ2XXS-gateup-Q2K-down-Q8rest.gguf \
  gguf-tools/quality-testing/data/qwen36-openrouter/manifest.tsv \
  gguf-tools/quality-testing/data/qwen36-standard.tsv \
  4096 \
  --vulkan \
  --ssd-streaming \
  --ssd-streaming-cache-experts 10GB \
  --threads 12
```

This path is for the mixed Q36 runtime. It avoids the full-RAM assumption by
using the runtime SSD-streaming mode and a bounded expert cache.

To compare two local score files:

```sh
python3 gguf-tools/quality-testing/compare_scores.py \
  gguf-tools/quality-testing/data/old.tsv \
  gguf-tools/quality-testing/data/new.tsv
```

Lower `avg_nll` is better. The scorer also reports local-vs-API target-logprob
error, top-logprob coverage and error, top-1 agreement, top-N recall, and
pairwise ordering agreement.

## Prompt Set

`prompts.jsonl` is the tracked 100-prompt quality corpus shared with DS4. Its
tool-format cases request a generic JSON schema.
Render it for manual generation checks:

```sh
python3 gguf-tools/quality-testing/render_q36_quality_prompts.py
```

These prompts are for quality checks. The imatrix workflow uses the larger
Q36 imatrix dataset under `gguf-tools/imatrix/dataset/`.

## Strict validation and rendered prompts

The scorer parses logprobs structurally and rejects missing, null, or non-finite
values. Local scoring also rejects any non-finite entry in the full vocabulary.
`--rendered-prompt` treats manifest prompts as already rendered chat text;
`--dump-first-logits FILE` writes the first scoring frontier using hexadecimal
float notation. `--max-cases N` requires at least N manifest cases.

Use `validate_scores.py --help` to validate complete score tables against an
explicit manifest before comparing scores. The validator checks coverage,
uniqueness, counts, finite values, and consistent aggregate rows.

`q36-bench --dump-frontier-logits-dir DIR` writes complete float32 logit vectors
at each prefill frontier. `compare_frontier_logits.py` requires explicit model,
backend, context, quantization, vocabulary, and frontier expectations and checks
every finite float32 bit. Pass directories containing only the frontier JSON
files; its verdict covers those frontiers, not generation quality.

Run the parser and validator regressions with `make test-quality`.
