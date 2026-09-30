# MMLU-Pro Qwen3.6-35B reasoning OFF: default8 vs experts20+thr0.8 (210/cfg; 4096 + retry 30K sui troncati)

| config | n | MMLU-Pro | s/sample |
|---|---|---|---|
| q35-default8-nothink | 219 | 76.3% | 377 |
| q35-experts20-thr08-nothink | 219 | 76.3% | 502 |

| subset | q35-default8-nothink | q35-experts20-thr08-nothink |
|---|---|---|
| computer science | 75% | 75% |
| math | 93% | 87% |
| chemistry | 87% | 87% |
| engineering | 52% | 57% |
| law | 62% | 50% |
| biology | 88% | 88% |
| health | 80% | 80% |
| physics | 100% | 100% |
| business | 73% | 80% |
| philosophy | 67% | 80% |
| economics | 93% | 87% |
| other | 67% | 67% |
| psychology | 87% | 87% |
| history | 53% | 53% |
