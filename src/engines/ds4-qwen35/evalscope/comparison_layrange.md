# Espansione esperti limitata a range di layer — esperimento 2026-08-28

Ipotesi: il danno dell'espansione (exp20+thr0.8+decay99-50) potrebbe concentrarsi
in una precisa profondità della rete; limitarla a un terzo dei 40 layer potrebbe
salvaguardare le domande frontier dove il native8 vince.

**Metodo** (nessuna modifica al repo): 3 varianti di `metal/qwen35.metal` via
`DS4_METAL_QWEN35_SOURCE` — dentro il range: threshold+espansione+decay normali;
fuori dal range: esatto native top-8 (k_ref=8, nessun expansion loop, nessun
decay, prima della renormalizzazione). Terzi: first=0-13, mid=14-26, last=27-39.
Verifica gate dalle stats per-layer (8.0 esatti fuori banda). Thinking, temp 0,
Qwen3.6-35B Q6_K_XL. Baseline note da round 2 e test precedenti.

## 1) Griglia sui terzi — qid 11294 (engineering, gold J)

| config | layer con espansione | pred | esito | token |
|---|---|---|---|---|
| native8 | nessuno | J | ✓ | 13,299 |
| exp20 full (baseline round 2) | 0-39 | A | ✗ | 6,131 |
| **last terzo** | 27-39 | **J** | **✓** | **5,905** |
| first terzo | 0-13 | A | ✗ | 8,972 |
| mid terzo | 14-26 | H | ✗ | 8,931 |

## 2) Last terzo sulle 5 domande engineering decisive

Selezione: le 3 dove native batte exp20 full (11294/11296/11297) + le 2 che
native stesso fallisce (11289/11298). Le altre 10 engineering sono OK per
entrambe le config round 2.

| qid | gold | native8 | exp20 full | last terzo | token last |
|---|---|---|---|---|---|
| 11294 | J | J ✓ | A ✗ | **J ✓** | 5,905 |
| 11289 | G | I ✗ | I ✗ | I ✗ | 4,803 |
| 11296 | I | I ✓ | A ✗ | troncata 30K ✗ | 30,000 |
| 11297 | J | J ✓ | troncata ✗ | troncata 30K ✗ | 30,000 |
| 11298 | H | C ✗ | E ✗ | troncata 30K ✗ | 30,000 |

Proiezione engineering su 15 domande (le 10 facili condivise + queste 5):
**native8 = 13/15, last terzo (thr0.8) = 11/15, exp20 full = 10/15.**

## 3) Last terzo + thr 0.9, cap = 2× token native8 (2026-08-28)

Stessa gate "last terzo", soglia alzata a 0.90 (~13-14 esperti/token nei layer
27-39 invece di ~18), budget per domanda = doppio di quello usato da native8:
11289→5,214 / 11297→12,980 / 11298→16,910 / 11294→26,598 / 11296→48,262.

| qid | gold | native8 | last thr0.8 (cap 30K) | last thr0.9 (cap 2×) | tok thr0.9 |
|---|---|---|---|---|---|
| 11294 | J | J ✓ | **J ✓** 5,905 | A ✗ | 7,399 (stop) |
| 11296 | I | I ✓ 24,131 | troncata 30K ✗ | **I ✓** | 28,128 (stop) |
| 11297 | J | J ✓ 6,490 | troncata 30K ✗ | troncata ✗ | 12,980 (length) |
| 11289 | G | I ✗ | I ✗ | I ✗ | 2,837 (stop) |
| 11298 | H | C ✗ | troncata 30K ✗ | troncata ✗ | 16,910 (length) |

Proiezione engineering: native8 13/15 · last-thr0.8 11/15 · last-thr0.9 11/15.

## Verdetto

1. **Il criterio "last terzo raggiunge default8 su engineering" NON è
   soddisfatto** (entrambe le varianti: 11/15 vs 13/15) → il run delle 210
   domande NON è stato lanciato.
2. I due set di risultati (thr0.8 e thr0.9) sono **complementari, non
   gerarchici**: thr0.8-last recupera 11294 (in metà token native) ma perde
   11296; thr0.9-last recupera 11296 (con budget 2×) ma perde 11294. Ogni
   combinazione (N, T, range di layer, budget) crea una traiettoria diversa
   sulle domande al frontier — nessuna domina native8.
3. Il budget è un fattore reale, non solo la traiettoria: 11296 passa da
   "troncata" a I✓ con cap 48K a 28,128 token (native 24,131). Parte del
   fallimento di round 2 era cap, parte perturbazione.
4. 11297 resta irraggiungibile da ogni espansione in tutte le condizioni
   provate (4 config, cap fino a 2×) — il caso più netto di "solo la
   traiettoria esatta native la risolve".
5. Direzione futura (se si vuole proseguire): (a) test last-quarto 30-39 e
   solo-top 36-39 con thr0.8 sul canarino 11294 per localizzare più fine;
   (b) last-metà 20-39 come variante larga; (c) accettare che per engineering
   native8 resta il config e valutare l'espansione per le sole materie
   knowledge-heavy.

## 4) Mappa fine della finestra di recupero — canarino 11294 (2026-08-28 sera)

10 configurazioni testate (cap 26,598 = 2× native per tutte):

| # | N | gate layer | thr | esito | tok | nota |
|---|---|---|---|---|---|---|
| 1 | 8 | — (native) | — | ✓ J | 13,299 | riferimento |
| 2 | 20 | 0-39 full | 0.8 | ✗ A | 6,131 | round 2 |
| 3 | 20 | 27-39 | 0.8 | **✓ J** | 5,905 | migliore (metà token native) |
| 4 | 20 | 0-13 | 0.8 | ✗ A | 8,972 | |
| 5 | 20 | 14-26 | 0.8 | ✗ H | 8,931 | |
| 6 | 20 | 30-39 | 0.8 | **✓ J** | 13,873 | conferma finestra |
| 7 | 20 | 36-39 | 0.8 | ✗ F | 7,561 | troppo stretta |
| 8 | 20 | 27-39 | 0.7 | **✓ J** | 12,243 | dose piena ok |
| 9 | 20 | 27-39 | 0.9 | ✗ A | 7,399 | dose ridotta no |
| 10 | 20 | 20-39 | 0.8 | ✗ H | 11,271 | troppo larga |
| 11 | 12 | 27-39 | 0.8 | ✗ E | 8,410 | N sotto |
| 12 | 14 | 30-39 | 0.8 | ✗ A | 6,294 | N sotto |

**Finestra di recupero: N=20 + thr ≤ 0.8 + gate [27-39] o [30-39], nient'altro.**
Bordi precisi: allargare a 20-39 (H✗), stringere a 36-39 (F✗), scendere a N=14/12
(A✗/E✗), alzare la soglia a 0.9 (A✗) — tutto fuori finestra. thr0.7 resta dentro
(la dose sul gate deve essere piena: ~18+ esp/tok effettivi nei layer gated).
Conferme successive (2026-08-29, cap 30K): accorciare il gate in fondo rompe la
finestra a qualunque dose — N12 gate 27-35 → A✗ (6,253 tok), N12 gate 25-35 → F✗
(8,979), N20 gate 25-35 → F✗ (6,392). I layer 36-39 sono parte essenziale della
finestra (inclusi, non esclusi): serve [27/30-39] completo.

**Esito candidato su 11296 a cap 48K, ctx 65K (2026-08-29 02:00)**: traiettoria
thr0.8-gate27-39 vagheggia oltre i 32K: 48,262 token esauriti SENZA risposta
(la variante thr0.9 concludeva I✓ a 28,128). Prima apparente chiusura a 32,223
tok era il muro del context server default 32K, non la traiettoria — riprovato
con `--ctx 65536`. Il candidato resta 1/5 sulle decisive (proiezione 11/15,
−2 vs default8): 11294✓, 11296✗, 11297✗, 11289/11298✗ (fallite anche native).

Caveat di metodo: la finestra è stimata su UNA domanda canarino estremamente
sensibile — serve come setaccio, non come verdetto. Ogni conferma richiede il
protocollo paired; e i 3 frontier richiedono cap ≥ 2× native (11296 I✓ a
28,128 solo con cap 48K nel test thr0.9).

## Artefatti

- Kernel varianti: `/tmp/qwen35_lay_{first,mid,last}.metal` (ricreabili con la
  patch documentata: `lay_in_range` su k_ref, guardie su threshold/expansion
  loop/decay — vedi transcript). Server log: `/tmp/server_lay_*.log`,
  `/tmp/server_eng4_last.log`, `/tmp/server_eng6_last_thr090_2x.log`.
- Prompt engineering completi: `/tmp/eng4_prompts.json`; runner:
  `/tmp/eng4_last_test.py` (thr0.8, cap 30K), `/tmp/eng6_last_thr090_2x.py`
  (thr0.9, cap 2× native), `/tmp/canary_11294.py` (N e cap parametrici).
- Kernel aggiuntivi sezione 4: `/tmp/qwen35_lay_{lastq,top,half,mid2,mid3,mid4}.metal`
  (mid2=27-35, mid3=25-35, mid4=25-35 N20); log: `/tmp/server_blk{A,B}_*.log`,
  `/tmp/server_blk{C,D,E}_*.log`, `/tmp/server_cand_11296_48k{,_v2}.log`.
- Server ripristinato a fine run: exp20+thr0.8, kernel originale
  (`02:03` 2026-08-29).

## 5. Round 3 FINALE — 210 domande, gate[27-39] N20 thr0.8 (2026-08-29)

Config: N=20, thr=0.8, decay 99→50, gate layer 27-39, cap 30K, ctx 65K.
Workdir `runG-gate39-pro`, mid `q35-exp20-thr08-gate27-39`. Include il pass
prioritario (33 domande sbagliate da default8 generate per prime e iniettate
in cache, 8 fixes: 3 law, biology 2807, engineering 11298, philosophy 10786,
psychology 1987).

**Verdetto paired FINALE (208 comuni non troncati)**:
gate39 171 (82.2%) vs default8 169 (81.2%) — **netto +2** (gate39 vince 8,
default8 vince 6). Token medi −12%, secondi medi −3%, parametri attivi
misurati ~4.0B/token vs 3.0B native.

Degradazione del netto durante il run: +9 (89 fatte) → +2 (210). Le wins si
concentrano in law +3, biology/philosophy/psychology/history +1; le loss in
engineering −2 (11296 ramble >30K, 11299 sbagliata a calcolo chiuso), più
875 (law), 10785 (philosophy), 11297 (engineering, mai risolta da expansion).

L'ipotesi del round 3 (gate[27-39] preserva il vantaggio knowledge-heavy
eliminando le perdite engineering) è confermata solo parzialmente: il netto
positivo regge (+2), ma 2 delle 6 loss restano engineering-frontier.

Report completo: `comparison_gate39.md`.
