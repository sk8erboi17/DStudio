# Prove reali di installazione e inferenza — 5 settembre 2026

**Qwen: 26,44 token/s durante la generazione e 12 controlli su 12 superati attraverso DStudio.**
Misurato su Apple M2 Max con 96 GB di memoria e Minecraft/Lunar Client acceso.
Non è una promessa di velocità per ogni conversazione.

## Cosa funziona, in parole semplici

| Prova | DS4 / DeepSeek Flash | Laguna S 2.1 | Qwen3.8-Flash-Next |
| --- | --- | --- | --- |
| Scaricare davvero i sorgenti in una cartella vuota, compilarli e avviare gli eseguibili | Passata | Passata | Passata |
| Rispondere a domande con risposta attesa e rispettare il protocollo | 11/12 | 10/12 | 12/12 |
| Percorso della prova con modello | Motore nativo | Motore nativo | Avvio da DStudio e proxy Chat |

I pesi DeepSeek e Laguna erano già installati: sono stati caricati realmente,
non riscaricati inutilmente. Per Qwen sono stati scaricati **entrambi i file**:
73,4 GB di modello principale e 32,0 GB di PLE, verificati integralmente con SHA-256.

I 12 controlli comprendono calcoli, numeri negativi, estrazione JSON, ordinamento
con duplicati, testo Unicode, memoria fra turni, ricerca in 90 righe, ragionamento
su codice Python, rifiuto di una richiesta malformata, recupero dopo l'errore,
chiamata a un tool con uso del risultato e risposta in streaming completa.

Il test del tool usa una risposta controllata di inventario: verifica una
chiamata generata dal modello e il successivo utilizzo del risultato, non
l'esecuzione autonoma di un intero Agent. Qwen è integrato in **Chat/native**;
Agent, Cowork e Design vengono rifiutati esplicitamente finché manca l'adattatore.

### Correzione successiva: Qwen e l'impostazione SSD salvata

Il test con il modello richiedeva esplicitamente SSD streaming **Off**: non
copriva l'avvio dall'interfaccia con **On** rimasto salvato per DeepSeek.
Quel caso poteva bloccare Qwen prima del caricamento. Ora l'interfaccia applica
Off a Qwen, lasciando il PLE su SSD e conservando la preferenza per gli altri
modelli. I test browser verificano avvio iniziale con On/Auto/Off, cambio
DeepSeek → Qwen → DeepSeek e riavvio dopo una modifica del contesto.
Queste regressioni usano risposte del motore simulate: verificano le richieste
dell'interfaccia, **non aggiungono risultati di inferenza** al 12/12 sopra.

## Errori rimasti visibili

- DeepSeek restituisce `:16` invece di `16` nel caso Python: risultato numerico
  corretto, ma formato richiesto non rispettato.
- Laguna recupera `197` invece di `203` dalla lista: risposta sbagliata.
- Laguna calcola `16` nel caso Python, ma aggiunge una spiegazione quando era
  richiesto soltanto il numero: errore di formato.

Le due run terminano quindi con esito complessivo negativo. I controlli non
sono stati allentati per nascondere questi errori. Non abbiamo isolato se
dipendano dal modello, dalla quantizzazione o dal motore: servirebbe un confronto
numerico con un'implementazione di riferimento. Qwen passa questa piccola batteria;
**non significa che sia infallibile o migliore in ogni attività**.

## Quanto va veloce Qwen

Tre processi nativi consecutivi hanno ricopiato lo stesso CSV di 32 righe.
Il testo prodotto è stato confrontato integralmente con l'originale: **3/3 esatti**.

| Esecuzione | Generazione riportata dal motore | Tempo totale del processo |
| --- | --- | --- |
| 1 | 27,15 token/s | 35,10 s |
| 2 | 26,44 token/s | 33,17 s |
| 3 | 25,98 token/s | 32,49 s |

Il valore centrale è **26,44 token/s**. I token sono frammenti di testo, non
necessariamente parole. Questa misura esclude caricamento e lettura iniziale
del prompt; il tempo totale include anche queste fasi. È la misura del CLI
nativo su un compito di copia, **non una misura della velocità dell'Agent o della
Chat completa**, né un confronto equo con le altre due run.

Configurazione: Metal, contesto 8.192, prompt elaborato in blocchi da 512,
ragionamento disattivato, generazione deterministica, senza PLD/MTP né streaming
degli esperti. Il modello principale è residente; il PLE viene letto da SSD per
architettura. Durante queste tre misure non giravano altri modelli, download o
compilazioni avviati dalla sessione di benchmark; Minecraft rimaneva acceso.
Non è stata misurata la variabilità su altre macchine o carichi.

## Difetti trovati e corretti grazie alle prove

- La revisione DS4 usata dal download iniziale non era compatibile con le patch
  correnti: aggiornato il riferimento alla revisione verificata.
- La compilazione Design su Laguna richiedeva API di visione assenti: ora le
  capacità vengono verificate compilando un piccolo programma, e le opzioni
  non supportate producono un errore esplicito.
- Un collegamento della cartella modelli poteva puntare al posto sbagliato:
  ora viene verificata l'identità della cartella condivisa, preservando i dati.
- L'avvio headless poteva applicare patch DeepSeek al checkout Qwen: ora un
  modello e un motore incompatibili vengono fermati prima delle modifiche.
  La prova Chat finale verifica anche che i sorgenti Qwen rimangano invariati.
- Il menu poteva trattare il PLE come un modello indipendente o offrire Qwen
  senza il PLE: ora distingue i componenti e consente di completare il download.

## Riprodurre e verificare

```sh
./download-model.sh qwen38-q4k
make test-setup-live
make test-inference-live
make test-qwen-chat-live
make benchmark-qwen-decode
```

Eseguire le prove pesanti una alla volta. Le risposte sbagliate, i pesi mancanti,
i timeout e le dipendenze assenti non diventano successi. `make check-fast`
verifica separatamente funzioni, HTTP e browser senza caricare un grande modello.

[Dati pubblicati: richieste, risposte, errori, revisioni, hash e misure](benchmarks/engine-acceptance-2026-09-05.json).
I log completi restano in `tests/.artifacts/engine-acceptance/` e
`tests/.artifacts/qwen-decode/`, ignorati da Git. Questi sono controlli osservabili
di funzionamento: non dimostrano equivalenza dei logits, correttezza su ogni
input, supporto multimodale Qwen o parità fra Metal, CPU e CUDA.
