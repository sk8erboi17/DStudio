# TODO — Loop guard per ds4-server (da implementare a fine benchmark GPQA)

## Contesto

Su GPQA diamond, il config gate39 (experts20 + threshold 0.8) va in vero loop di
reasoning su una frazione delle domande chemistry: 3/12 delle troncate a 30K
mostrano 5-36 frasi identiche ripetute nella coda del reasoning (es. ciclaggio
su "1-adamantanone vs 2-adamantanone" con ricalcolo infinito). def8 nello stesso
setting: 3% di loop. gate39 physics: 0%. Non è il kernel in sé: è l'interazione
gate39 × chemistry.

Un loop vera non converge a nessun budget (60K, 120K…): sprecare ore di decode
seriale è inutile. Serve un rilevatore in-engine che interrompe la generazione.

## Cosa implementare (ds4_server.c)

Guard nel decode loop (dopo riga ~12155, dove `text` cresce):

1. **Finestra scorrevole**: ogni 256 token generati, prendi gli ultimi ~2000
   caratteri di `text`. Normalizza (collassa spazi/newline).
2. **Confronto con le 2 finestre precedenti** (stesse posizioni -2000 e -4000):
   se similarità (es. ratio di trigrammi comuni o Levenshtein limitata) > soglia
   (~0.92) con ENTRAMBE, dichiara loop.
3. **Azione**: `finish = "stop"`, tronca il testo alla finestra pulita, log
   warning `"loop guard: interrupted after N tokens (similarity x.xx)"`.
4. **Flag**: attivabile via env `DS4_LOOP_GUARD=1` (default OFF per non toccare
   i benchmark già fatti e la compatibilità generale).
5. **Tracciabilità**: il campo finish_reason verso il client può restare
   "length", ma aggiungere nei metadata di risposta (o in un header) un flag
   `loop_interrupted: true` così l'export può etichettare il record.
6. **Test**: riprodurre su una domanda chemistry gate39 nota a loop (delle 3
   trovate; qid nel jsonl gate39 chemistry con 30720 tok e dupe-sent>=11) e
   verificare interruzione < 10K token; verificare che le 9 non-loop a 30K
   passino indenni (nessun falso positivo).

## Costo

O(1) ammortizzato per token (confronto ogni 256 token su 3 finestre da 2K char).
Nessun impatto percettibile su t/s.

## Aperti

- Similarità: trigrammi Jaccard è sufficiente e senza dipendenze? (sì in C,
  tabella 4096 bucket).
- Soglia: calibrare sulle 3 domande loop + campione non-loop.
- Applicare anche al batched path? (no per ora: benchmark seriali).

## Dopo l'implementazione

- Riverifica delle 12 troncate gate39 chemistry a 30K: i 3 loop veri devono
  essere interrotti presto; gli altri 9 devono completare come prima.
- Aggiornare export/livestat per separare `loop_interrupted` da `trunc`.
