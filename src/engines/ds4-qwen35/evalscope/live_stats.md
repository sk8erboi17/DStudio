MMLU-Pro live preview — 2026-08-30 17:38:38

## Qwen3.6-35B

| config | n/210 | score | no-tronc | lat s | tok | ETA |
|---|---|---|---|---|---|---|
| qwen-default8 [think] | 210 | 81.0% (81.0%) | 0 | 155 | 2676 | - |
| qwen-experts20-thr08 [think] | 210 | 81.0% (81.3%) | 1 | 170 | 2319 | - |
| qwen-default8 [nothink] | 210 | 79.5% (79.5%) | 0 | 71 | 1229 | - |
| qwen-experts20-thr08 [nothink] | 210 | 80.0% (80.0%) | 0 | 85 | 1145 | - |

qwen-default8 [think]: biology:13/15  business:12/15  chemistry:12/15  computer:13/15  economics:14/15  engineeri:13/15  health:13/15  history:10/15  law:7/15  math:14/15  other:10/15  philosoph:12/15  physics:15/15  psycholog:12/15  (ultimo campione 955 min fa)
qwen-experts20-thr08 [think]: biology:14/15  business:12/15  chemistry:12/15  computer:13/15  economics:14/15  engineeri:10/15  health:13/15  history:9/15  law:9/15  math:14/15  other:10/15  philosoph:12/15  physics:15/15  psycholog:13/15  (ultimo campione 955 min fa)
qwen-default8 [nothink]: biology:14/15  business:11/15  chemistry:13/15  computer:12/15  economics:14/15  engineeri:11/15  health:12/15  history:8/15  law:10/15  math:14/15  other:10/15  philosoph:10/15  physics:15/15  psycholog:13/15  (ultimo campione 955 min fa)
qwen-experts20-thr08 [nothink]: biology:14/15  business:12/15  chemistry:13/15  computer:12/15  economics:13/15  engineeri:12/15  health:12/15  history:8/15  law:8/15  math:14/15  other:10/15  philosoph:12/15  physics:15/15  psycholog:13/15  (ultimo campione 955 min fa)

## Paragone reasoning: solo domande completate da entrambi

domande valutabili da entrambi: 209 (+1 escluse: troncate/senza risposta)

| config | score su 209 comuni |
|---|---|
| experts20+thr0.8 | 170/209 = 81.3% |
| default8 | 169/209 = 80.9% |

discordi: vince experts20+thr0.8 7, vince default8 6 (netto +1)

## Ornith-1.5-35B

| config | n/210 | score | no-tronc | lat s | tok | ETA |
|---|---|---|---|---|---|---|
| ornith-default8 | 210 | 68.1% (79.0%) | 29 | 118 | 2206 | - |
| ornith-experts20-thr08 | 210 | 66.2% (75.1%) | 25 | 124 | 1869 | - |

ornith-default8: biology:13/15  business:11/15  chemistry:12/15  computer:9/15  economics:12/15  engineeri:8/15  health:9/15  history:9/15  law:4/15  math:13/15  other:9/15  philosoph:10/15  physics:13/15  psycholog:11/15  (ultimo campione 955 min fa)
ornith-experts20-thr08: biology:14/15  business:9/15  chemistry:11/15  computer:10/15  economics:10/15  engineeri:8/15  health:10/15  history:10/15  law:4/15  math:13/15  other:8/15  philosoph:10/15  physics:10/15  psycholog:12/15  (ultimo campione 955 min fa)
