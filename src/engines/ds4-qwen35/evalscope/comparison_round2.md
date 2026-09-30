# MMLU-Pro Round 2 Qwen3.6-35B: default8 vs experts20+thr0.8+decay (210/cfg; 8192 + retry 30K sui troncati)

| config | n | MMLU-Pro | s/sample |
|---|---|---|---|
| q35-default8 | 213 | 79.8% | 2446 |
| q35-experts20-thr08-decay | 213 | 79.8% | 1275 |

| subset | q35-default8 | q35-experts20-thr08-decay |
|---|---|---|
| computer science | 87% | 87% |
| math | 93% | 93% |
| chemistry | 80% | 80% |
| engineering | 72% | 56% |
| law | 47% | 60% |
| biology | 87% | 93% |
| health | 87% | 87% |
| physics | 100% | 100% |
| business | 80% | 80% |
| philosophy | 80% | 80% |
| economics | 93% | 93% |
| other | 67% | 67% |
| psychology | 80% | 87% |
| history | 67% | 60% |
