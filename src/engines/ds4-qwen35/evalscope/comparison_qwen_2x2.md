# MMLU-Pro Qwen3.6-35B matrice 2x2: routing (default8 vs experts20+thr0.8) x reasoning (on/off), 210/cfg (troncati rigenerati a 30K)

| config | n | MMLU-Pro | s/sample |
|---|---|---|---|
| q35-default8 | 213 | 79.8% | 2446 |
| q35-experts20-thr08-decay | 213 | 79.8% | 1275 |
| q35-default8-nothink | 219 | 76.3% | 377 |
| q35-experts20-thr08-nothink | 219 | 76.3% | 502 |

| subset | q35-default8 | q35-experts20-thr08-decay | q35-default8-nothink | q35-experts20-thr08-nothink |
|---|---|---|---|---|
| computer science | 87% | 87% | 75% | 75% |
| math | 93% | 93% | 93% | 87% |
| chemistry | 80% | 80% | 87% | 87% |
| engineering | 72% | 56% | 52% | 57% |
| law | 47% | 60% | 62% | 50% |
| biology | 87% | 93% | 88% | 88% |
| health | 87% | 87% | 80% | 80% |
| physics | 100% | 100% | 100% | 100% |
| business | 80% | 80% | 73% | 80% |
| philosophy | 80% | 80% | 67% | 80% |
| economics | 93% | 93% | 93% | 87% |
| other | 67% | 67% | 67% | 67% |
| psychology | 80% | 87% | 87% | 87% |
| history | 67% | 60% | 53% | 53% |
