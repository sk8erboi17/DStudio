# MMLU-Pro 210: qwen3.8-27b-nvfp4 (omlx, serial) vs q35-default8 vs gate39

| config | n | MMLU-Pro | s/sample |
|---|---|---|---|
| qwen38-27b-nvfp4 | 210 | 82.4% | 78 |
| q35-default8 | 213 | 79.8% | 2446 |
| q35-exp20-thr08-gate27-39 | 210 | 81.4% | 110 |

| subset | qwen38-27b-nvfp4 | q35-default8 | q35-exp20-thr08-gate27-39 |
|---|---|---|---|
| computer science | 87% | 87% | 87% |
| math | 93% | 93% | 93% |
| chemistry | 87% | 80% | 80% |
| engineering | 87% | 72% | 73% |
| law | 60% | 47% | 67% |
| biology | 93% | 87% | 93% |
| health | 73% | 87% | 87% |
| physics | 100% | 100% | 100% |
| business | 73% | 80% | 80% |
| philosophy | 80% | 80% | 80% |
| economics | 93% | 93% | 93% |
| other | 73% | 67% | 60% |
| psychology | 80% | 80% | 87% |
| history | 73% | 67% | 60% |
