# Qwen3.6-35B-A3B on ds4-server: native routing vs expansion with decay

> **First run, small samples.** This is an initial evaluation: 32 MMLU, 30
> HumanEval and 16 MMLU-Pro questions per configuration. The numbers are
> directional only — 1-2 questions separate the configurations on each suite.
> A much larger MMLU-Pro round (14 subjects x 15 questions per configuration)
> is scheduled to confirm.

Evalscope 1.10.0 against the local ds4-server OpenAI API
(`http://127.0.0.1:8000/v1`), Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf, Apple M4 Pro
48 GB, thinking mode on, `temperature 0`, `max_tokens 4096`, 0-shot. Identical
questions and order for all runs; only the server's `--q35*` flags change.

## Configurations compared

| Run | Server flags | Routed experts/token | Decode speed |
|---|---|---|---|
| **with decay** | `--q35-experts 20 --q35-expert-threshold 0.8` | ~15.5 avg (cap 20, threshold cut) | 18.5 t/s |
| **native** | *(none)* | 8 (model default) | 22.9 t/s |

The "with decay" configuration expands the routed experts to a maximum of 20
with the 0.8 threshold cut; every rank above the model's native 8 gets the
linear influence decay (99% -> 50%, active since commit ffa14fb).

## Results

| Benchmark | with decay | native |
|---|---|---|
| MMLU, 8 subjects x 4 (n=32) | **96.9%** (31/32) | 93.8% (30/32) |
| HumanEval pass@1, first 30 (n=30) | 96.7% (29/30) | 96.7% (29/30) |
| MMLU-Pro, 8 subjects x 2 (n=16) | **81.3%** (13/16) | 75.0% (12/16) |

## Where the differences come from

- **MMLU**: with decay solves `abstract_algebra` 4/4 where native gets 3/4;
  everything else is identical.
- **MMLU-Pro**: the only mover is `psychology` — 2/2 with decay, 1/2 native.
  The hard subjects (math, law, philosophy) sit at 1/2 for both.
- **HumanEval**: identical 29/30; code generation is saturated at this
  sample size.

## Reading

1. **Expansion with decay was never below native routing** on any suite
   (+2 correct answers over 78 samples in this run). A weak positive signal,
   consistent across two of three suites.
2. **The cost is real**: ~15.5 experts/token decode at 18.5 t/s vs 22.9 t/s
   native (-19%). Expansion with decay is a quality-leaning setting for
   single-shot work, not a throughput setting.
3. The specific contribution of the decay (expansion with vs without decay)
   is isolated in [`comparison_decay.md`](comparison_decay.md): the decay
   variant scored higher there as well (MMLU 96.9 vs 90.6, MMLU-Pro 81.3 vs
   75.0) at identical speed.

## Wall-clock (per phase, single-slot server)

| Phase | with decay | native |
|---|---|---|
| MMLU 32 q | 57 min | 56 min |
| HumanEval 30 q | 59 min | 53 min |
| MMLU-Pro 16 q | 36 min | 35 min |

## Artifacts

- Per-sample predictions: `run*/predictions/<model-id>/*.jsonl`
- Per-run reports (JSON + HTML): `run*/reports/`
- Server logs per phase: `run*/server*-phase.log`
- Chain scripts: `bench.sh` (MMLU), `bench_humaneval.sh`, `bench_mmlupro.sh`
- Ablation data (expansion without decay, third configuration) kept in
  `runC-experts20-thr08-nodecay/`, summarized in `comparison_decay.md`
- HumanEval dataset: `openai/openai_humaneval` (the adapter's default
  `opencompass/humaneval` no longer exists on the Hub)

Generated 2026-08-24 by evalscope 1.10.0, thinking mode, 0-shot, temperature 0.
