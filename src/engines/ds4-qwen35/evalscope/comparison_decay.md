# Expansion influence decay: with vs without (evalscope, 2026-08-24)

Same setup as the main comparison (evalscope 1.10.0, local ds4-server OpenAI
API, Q6_K_XL, M4 Pro, thinking mode, 0-shot, temperature 0, identical
questions). The two configurations differ only in the decay switch:

- **with decay**: `--q35-experts 20 --q35-expert-threshold 0.8` — the extra
  ranks 9..20 get a linearly decaying influence factor (99% -> 50%)
- **without decay**: `--q35-experts 20 --q35-expert-threshold 0.8
  --q35-no-expert-decay` — every selected expert at full influence

| Benchmark | with decay | without decay | delta |
|---|---|---|---|
| MMLU, 8 subjects x 4 (n=32) | **96.9%** (31/32) | 90.6% (29/32) | +6.3 |
| HumanEval pass@1, 30 problems | 96.7% (29/30) | 96.7% (29/30) | 0 |
| MMLU-Pro, 8 subjects x 2 (n=16) | **81.3%** (13/16) | 75.0% (12/16) | +6.3 |
| Decode speed | 18.5 t/s | 18.5 t/s | 0 |
| Routed experts/token | ~15.5 | ~15.5 | 0 |

## Where the delta comes from

* MMLU: with decay solves `machine_learning` 4/4 (3/4 without) and
  `abstract_algebra` 4/4 (3/4 without); nothing regresses.
* MMLU-Pro: `psychology` 2/2 with decay, 1/2 without; nothing regresses.
* HumanEval: identical 29/30 — code generation is insensitive at this
  sample size.

## Interpretation

Decaying the expansion experts is free (same expert count, same speed —
the factor is a multiply inside the router kernel) and, in this run,
strictly non-negative: 3 extra correct answers over 78 samples, no suite
or subject worse. This is consistent with the design intuition: the router
never trained ranks 9+ to be full-strength contributors, so admitting
them at full weight injects noise, while admitting them with a fading
factor adds information without disturbing the native top-8 mix.

The sample is small (1-2 questions per suite separate the two), so this
is a directional signal, not a proof. A follow-up round with only the
native and with-decay configurations on math_500, gpqa_diamond and a
fuller MMLU-Pro run is scheduled to confirm (see `comparison_round2.md`).
