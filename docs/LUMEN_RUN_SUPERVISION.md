# Lumen Observatory — diario di supervisione della run reale

Data: 24 agosto 2026
Run: `lumen-layout-real`
Workspace della run: `tests/.artifacts/lumen-layout-real/workspace`
Obiettivo: costruire e validare il sito completo Lumen Observatory con una sola
run DeepSeek Design Max, usando gli asset esistenti in modo provvisorio e
spostando il quality gate severo sul layout desktop/mobile composto.

Questo file registra soprattutto ciò che non funziona, ciò che rallenta il
flusso e ciò che può essere migliorato. Va aggiornato mentre la run prosegue.

## Stato osservato dopo circa 1 ora e 45 minuti

- `index.html` è ancora il seed originale: 13.602 byte, ultima modifica alle
  15:55:30. La generazione del nuovo layout non è ancora iniziata.
- DeepSeek V4 Flash è l'unico modello pesante residente.
- Configurazione reale: context 393.216, Think Max, reasoning cap per tool round
  16.384 token, SSD streaming attivo, power 90.
- RSS di `ds4-design`: circa 73,3 GB.
- Memoria libera di sistema osservata: circa 7%; swap usato: circa 11,6 GB.
- Il reasoning cap non è mai intervenuto: tutti i round hanno chiuso il
  reasoning spontaneamente prima del limite.
- Qwen3.8, Ideogram 4, HunyuanImage e H3 non sono attivi.
- I quattro PNG della run sono file validi e leggibili:
  - `blue-hour-observatory.png`: 1664×928, 1.844.731 byte;
  - `deep-archive.png`: 1560×1040, 2.204.884 byte;
  - `local-sheet.png`: 544×363, 225.142 byte;
  - `shared-lens.png`: 2016×1344, 72.369 byte.

## Problemi critici trovati

### 1. Il test isolava `HOME` ma perdeva il runtime Qwen reale

Il real test preservava esplicitamente i percorsi reali di Ideogram e Hunyuan,
ma non `DSTUDIO_QWEN38_VISION_HOME`. Il server cercava quindi Qwen nella home
temporanea del test e rispondeva:

```text
see_image error: Qwen3.8 vision is not installed; run vision setup once
```

Questo era un falso negativo: il modello era già scaricato correttamente.

Evidenze:

- snapshot Qwen reale presente nella cache Hugging Face: circa 28 GB;
- modello: `mlx-community/Qwen3.8-27B-8bit`;
- revisione: `815b83c0df8ffd1d1b5244cf75fd6ef14fca9ef9`;
- runtime MLX presente in `~/.dstudio/qwen38-vision`;
- dopo il collegamento alla home isolata, `/api/vision/status` ha restituito
  `installed: true` e `state: ready`.

Correzione già applicata:

- `tests/real_design_quality_test.mjs` ora inoltra
  `DSTUDIO_QWEN38_VISION_HOME`, usando il runtime della home reale se la
  variabile non è già esplicita.

Per mantenere viva la run corrente, i marker e il virtual environment reali
sono stati collegati nella home temporanea già avviata. Non è stato fatto un
nuovo download e non è stato caricato un secondo modello insieme a DeepSeek.

### 2. La correzione runtime non è comunicata alla generazione già in corso

Dopo il primo errore, il server è diventato `ready`, ma DeepSeek continua a
ragionare sulla vecchia risposta “not installed”. Non esiste un evento runtime
che informi il modello che la condizione è cambiata.

Conseguenza osservata: molti round e decine di minuti spesi a cercare un
comando `vision`, un installer o un package Python, anche se il servizio era già
pronto e sarebbe bastato ripetere `see_image`.

Miglioramento necessario:

- dopo un cambiamento di stato del provider, aggiungere al transcript un tool
  update verificabile, per esempio `vision runtime is now ready; retry the
  original call`;
- in alternativa, il tool fallito dovrebbe restituire un retry token/stato che
  il runtime possa risolvere e riaccodare senza chiedere al modello di
  indovinare il setup;
- il test dovrebbe controllare `/api/vision/status` prima di inviare il prompt,
  non dopo che il modello ha già ricevuto un errore.

### 3. Il workflow ha trasformato di nuovo l'ispezione asset in un blocco

Il flusso concordato diceva:

1. gate tecnico immediato;
2. asset provvisori se non hanno difetti macroscopici;
3. costruzione del sito;
4. giudizio severo solo nel layout reale.

La run ha invece mantenuto il primo todo “inspect the four PNG assets with
see_image” in `in_progress` e ha trattato l'assenza iniziale del provider come
un problema da risolvere prima di scrivere il sito.

Conseguenza: dopo circa 1h45 il layout non era ancora stato modificato.

Miglioramento necessario:

- il prompt deve dire esplicitamente che un errore del provider di ispezione
  non blocca il layout se PNG signature, dimensioni e decodifica sono validi;
- un todo di ispezione media deve poter diventare `completed_with_warning` o
  equivalente;
- il motore deve dare priorità al deliverable: dopo un solo errore operativo,
  registrare il warning e avanzare alla composizione;
- il controllo di corrispondenza può essere ripetuto nel gate finale, quando il
  modello è già necessario per desktop+mobile.

### 4. Il cap approvato non copre il tipo di lentezza osservato

Il cap da 16.384 token è correttamente limitato al reasoning nascosto di ogni
tool round. Non limita la risposta finale, i tool argument o i round successivi.

Questa run non si è bloccata in un singolo reasoning lungo. Ha prodotto molti
round brevi e coerenti, seguiti da tool call DSML molto lente. Il cap non è
intervenuto e non avrebbe dovuto farlo.

Il problema reale è quindi duplice:

- loop operativo tra round diversi sullo stesso prerequisito;
- decode lentissimo del blocco DSML, che resta invisibile finché non è chiuso.

Miglioramento necessario senza abbassare la qualità:

- rilevare la ripetizione semantica dello stesso obiettivo fallito tra round;
- distinguere `reasoning`, `tool-call building`, `tool running`, `model swap`
  e `restore` nello stato UI;
- non introdurre un limite di output arbitrario: intervenire solo quando c'è
  evidenza di errore/mancato avanzamento, oppure offrire uno steer esplicito;
- registrare token generati e token/secondo separatamente per reasoning, testo
  visibile e parametri tool.

### 5. Le tool call sono opache per diversi minuti

Il parser trattiene intenzionalmente tutto il DSML per non mostrare markup
grezzo. Durante la costruzione di una chiamata, il transcript può rimanere
identico per 5–10 minuti anche se il modello continua a decodificare.

Questo fa sembrare la run inceppata e impedisce di capire se sta preparando un
`read` di due righe oppure una riscrittura HTML da migliaia di token.

Miglioramento necessario:

- evento non sensibile `tool_call_building` appena il parser riconosce l'inizio
  DSML;
- nome tool appena disponibile, senza esporre il contenuto parziale;
- contatore dei token del parametro e throughput;
- heartbeat UI con tempo trascorso e ultimo progresso di decode;
- indicazione chiara che il contenuto è trattenuto fino alla chiusura valida.

### 6. SSD streaming e pressione memoria rendono il decode strutturale troppo lento

Il GGUF pesa circa 86,7 GB; il processo residente è circa 73,3 GB su una macchina
da 96 GB. Sono stati osservati solo ~7% di memoria libera e ~11,6 GB di swap già
in uso. Il sample del processo mostra lavoro attivo in
`metal_graph_eval_token_raw_swa` e caricamento degli esperti da SSD.

Quindi la lentezza non è un deadlock: è inferenza token-per-token con expert
streaming sotto forte pressione memoria.

Miglioramento necessario, senza cambiare modello o qualità:

- misurare cache-hit degli esperti, byte letti per token e token/secondo;
- evitare che altre cache/processi non necessari restino residenti;
- verificare che il KV del contesto 393.216 sia impegnato progressivamente e
  non provochi pressione anticipata inutile;
- profilare separatamente prefill, reasoning, DSML e restore;
- valutare prefetch/readahead degli esperti scelti e riuso tra token;
- mostrare all'utente il costo reale del profilo “true Max + 393k”.

### 7. Quattro `see_image` separati sono inefficienti

La prima chiamata DSML ha richiesto quattro tool `see_image` distinti, uno per
PNG. Con worker Qwen one-shot questo rischia quattro cicli completi di:

```text
DeepSeek off → Qwen load → inferenza → Qwen exit → DeepSeek restore
```

Il backend HTTP supporta già richieste multi-image fino a quattro immagini, ma
lo schema Design esposto al modello usa un singolo `path`.

Miglioramento necessario:

- aggiungere `paths[]` a `see_image`, oppure un tool `see_images`;
- per quattro asset di una stessa pagina, fare un'unica inferenza Qwen con
  risposta numerata;
- mantenere la domanda esclusivamente sulla corrispondenza alla richiesta, non
  su estetica o quality score.

### 8. Documentazione media troppo densa per il compito corrente

`MEDIA_AND_MODELS.md` elenca insieme Qwen, Ideogram, Hunyuan e H3. DeepSeek ha
associato il footprint di 29,5 GB alla procedura Vision, ma quel valore riguarda
il pacchetto Ideogram 4, non Qwen3.8.

Miglioramento necessario:

- aggiungere in testa uno stato operativo sintetico per provider: installed,
  revision, disk footprint e comando/API corretti;
- separare chiaramente “vision inspection” da “new image generation”;
- nel profilo layout, non caricare dettagli di Ideogram/Hunyuan/H3 finché non
  servono davvero.

### 9. La modalità unbounded elimina anche il rilevamento di stallo

Nel real harness, `DSTUDIO_DESIGN_UNBOUNDED=1` rende infiniti sia il timeout del
turno sia lo stall timeout. Questo è coerente con “nessun limite di qualità”, ma
confonde assenza di budget creativo e assenza di diagnostica operativa.

Miglioramento necessario:

- mantenere l'inferenza senza deadline;
- conservare comunque heartbeat, rilevamento di processo morto, nessun byte
  decodificato, memoria non più allocabile e tool parser senza avanzamento;
- un errore verificabile deve produrre diagnosi/steer, non downgrade o fallback.

### 10. Un'analisi cromatica non sostituisce la verifica semantica

Dopo avere rinunciato a cercare l'installer, DeepSeek ha formulato due volte
consecutive la stessa idea: prima «inspect pixel content programmatically / check
dominant colors», poi «lightweight pixel-level check / compute average colors and
brightness». Sono due richieste testuali nello stesso passaggio di ragionamento,
ma una sola operazione concettuale ripetuta. L'analisi cromatica è stata eseguita
zero volte; l'unico controllo Python concluso riguardava signature e dimensioni.

Il controllo cromatico può confermare che una scena è prevalentemente blu o
che contiene zone calde, ma non può stabilire che l'immagine mostri davvero un
osservatorio, un riflettore, un rifrattore o Saturno. Rischia quindi di spendere
altro tempo senza soddisfare la richiesta di corrispondenza.

Miglioramento necessario:

- non introdurre surrogate visual QA quando `see_image` fallisce;
- dopo il gate tecnico, usare provvisoriamente l'asset e passare al layout;
- ripetere più tardi una sola chiamata Qwen multi-image quando il provider è
  pronto;
- le statistiche pixel sono ammesse solo se una richiesta esplicita riguarda
  colore, gamma o esposizione, non il soggetto raffigurato.

## Misure locali utili

### Qwen3.8 Max

Benchmark reale già presente:

- start: `2026-08-23T18:01:01.697Z`;
- finish: `2026-08-23T18:05:49.737Z`;
- elapsed: **288,04 secondi (4 minuti e 48 secondi)**;
- compito: lettura congiunta del layout Lumen desktop+mobile.

Una chiamata Qwen reale è quindi nell'ordine di cinque minuti. Il ciclo completo
può richiedere di più per evacuare e ripristinare DeepSeek, ma l'ora e mezza
osservata in questa run non è inferenza Qwen.

### DeepSeek Design

- Il processo è rimasto vivo e attivo durante le pause.
- I sample mostrano compute Metal e caricamento expert-cache, non attesa morta.
- Le tool call semplici hanno impiegato diversi minuti di decode prima di
  apparire complete.
- Il live transcript non mostra il contenuto DSML parziale per design.

## Problemi già visibili nel sito seed

Il seed ha una direzione editoriale/cinematica valida, ma non è ancora il sito
completo richiesto. Mancano o sono insufficienti:

- skip link;
- menu mobile accessibile;
- programme realmente image-led con i tre asset dedicati;
- timeline narrativa e visivamente curata della serata;
- informazioni pratiche complete per la visita;
- form di prenotazione vero e onesto nei suoi stati;
- FAQ;
- disclaimer chiaro che si tratta di uno studio fittizio;
- verifica completa di focus, Escape, aria-live, error/success state;
- crop desktop/mobile valutati nel layout reale.

## Aggiornamento 25 agosto 2026 — problemi emersi durante la correzione del motore

### 11. Il test visuale continuava a validare il vecchio compositing a slice

Il renderer è stato corretto per fotografare ogni sezione tramite selettore in
un pannello indipendente, ma il test deterministico controllava ancora pixel a
quota 500/1500 come se il file fosse una cucitura di slice lontane. Il codice
nuovo era corretto mentre la regressione era diventata falsa.

Correzione applicata: il test ora richiede contact sheet 1280×3600 e 390×3600,
verifica che il prompt vieti inferenze geometriche tra pannelli diversi e non
interpreta più il bordo fra due sezioni come un overlap reale.

### 12. Il verdetto contraddittorio non era esposto come campo strutturato

La stringa `DS4 VERDICT CONSISTENCY: FAIL` bloccava già il gate, ma l'evento
`visual_check` non esponeva il motivo in modo machine-readable. Il test non
poteva distinguere un fail geometrico da una contraddizione del revisore.

Correzione applicata: l'evento include `verdictConsistency:false`. Il grader
usa record tipizzati `GRADE|...` e `FINDING|...`: un finding `FAIL` associato a
un grade `PASS` resta un P0 e impedisce edit/sign-off finché `inspect_layout`
non misura il DOM. Il runtime non cerca più parole o misure prese da una
fixture specifica.

### 13. La regressione responsive deve tollerare differenze sotto soglia

Nel fixture volutamente rotto, una delle immagini 340×320 differiva dal rapporto
intrinseco quadrato del 6,25%, sotto la soglia di distorsione dell'8%; le altre
due erano correttamente segnalate. Aspettarsi tre errori avrebbe trasformato la
soglia calibrata in un falso positivo.

Il test ora dimostra entrambe le cose: la pagina sana con attributi HTML
`width/height` più `height:auto` ha zero difetti; la pagina rotta produce
misallineamento desktop e due distorsioni mobili verificabili, con dimensioni
intrinseche, rettangoli renderizzati e CSS calcolato inclusi nel report.

### 14. Il reasoning libero non deve essere classificato con liste di parole

Il runtime può bloccare deterministicamente un edit dopo un finding geometrico,
perché vede l'output strutturato di `see_page`. Non può invece contare in modo
affidabile «ipotesi causali» dentro reasoning libero senza un protocollo
esplicito. Il precedente rilevatore di parole inglesi è stato rimosso dal core:
non generalizzava a lingue o formulazioni diverse e poteva interrompere analisi
valide. L'enforcement resta sullo stato verificabile: dopo un finding geometrico
gli strumenti di mutazione/sign-off sono bloccati finché non viene chiamato
`inspect_layout` sul relativo entry point.

### 15. Un test contrattuale completo non prova da solo la qualità dei pesi reali

La regressione deterministica ora percorre Ideogram → Qwen → Hunyuan → Qwen →
H3, controlla ordine, payload, pixel esatti, profilo Quality e file finali. È
necessaria per scoprire bug di routing senza caricare centinaia di GB, ma non
misura qualità o memoria dell'inferenza reale.

Per questo è stato aggiunto un profilo separato `creative-full-stack` con tre
siti reali. Ogni caso richiede due immagini, due review Qwen, un MP4 H3,
`inspect_layout`, `see_page` e i gate finali. Il report deve indicare
esplicitamente se media e video erano reali o fixture; non sono equivalenti.

### 16. H3 rende il costo del benchmark molto maggiore del solo sito

Lo snapshot ufficiale H3 dichiarato dal runtime è circa 144 GB, più circa 66 GB
per Ref2VA opzionale. Su 96 GB di memoria unificata non è accettabile tenere H3,
DS4, Qwen, Ideogram o Hunyuan residenti insieme. Il percorso Design sospende
quindi DS4 prima di ogni worker pesante e lo ripristina soltanto dopo l'uscita
del worker; le tool call sono seriali.

Rischio residuo: tre siti con H3 reale significano tre inferenze video Quality,
quindi il tempo totale può essere di molte ore. Non va mascherato come tempo di
«generazione HTML»: il README finale registra il tempo end-to-end di ogni sito
e il tipo di backend usato.

### 17. La creatività non può essere certificata soltanto dal prompt

Dire a DS4 «puoi cambiare font» non impedisce che riusi lo stesso hero, la
stessa sequenza di sezioni e la stessa griglia con copy diverso. È stato quindi
aggiunto un gate pairwise su n-grammi DOM, classi semantiche, top-level del main,
schema hero, font stack, type scale, primitive layout, densità e palette.

Limite noto: è un rilevatore di clone, non un critico d'arte. Può dimostrare che
tre output non sono lo stesso template, ma il giudizio estetico resta nel gate
del layout composto. La soglia iniziale (0,82) va ricalibrata sui risultati
reali senza abbassarla per far passare una regressione.

### 18. Deploy e copia Desktop restano fasi finali, non prove di qualità

I percorsi assoluti, gli screenshot, i transcript, i PNG generati/modificati,
gli MP4, il report anti-clone, hardware e tempi sono ora prodotti dal real
harness. La pubblicazione GitHub Pages e la copia sul Desktop vanno eseguite
solo dopo che tutti i siti hanno passato il gate, per evitare di distribuire
un benchmark incompleto o un artefatto precedente.

Dal benchmark Qwen precedente sul seed sono inoltre emersi:

- navigazione mobile assente senza menu alternativo;
- hero statico che potrebbe beneficiare di motion molto sottile e rispettoso di
  `prefers-reduced-motion`;
- card programma troppo testuali;
- timeline ridotta a una riga invece di una sequenza leggibile.

## Vincoli che non devono regredire

- Un solo modello pesante alla volta.
- Nessun fallback a modelli più piccoli.
- DeepSeek e Qwen in Max; Ideogram Quality-48; Hunyuan full-50; H3 alta qualità.
- Nessun quality gate estetico sugli asset isolati.
- Qwen sugli asset verifica solo la corrispondenza alla richiesta.
- Quality gate severo sul layout completo desktop/mobile.
- Media nuove o editate solo se richieste o se il layout composto dimostra un
  blocker concreto.
- Nessun downgrade per velocità; modifiche al profilo solo per correggere bug.
- Risultato finale completo sul Desktop.

## Correzioni già applicate durante la supervisione

1. Reasoning Design predefinito illimitato (`0`) con Think Max; cap opzionali
   8k/16k/24k restano selezionabili dall'utente. Nessun cap viene applicato
   implicitamente dal runtime.
2. Context true Max mantenuto a 393.216.
3. Test e documentazione aggiornati; deterministic suite passata prima della
   run reale.
4. `DSTUDIO_QWEN38_VISION_HOME` propagato dal real harness.
5. Runtime Qwen collegato alla home isolata della run corrente; status `ready`.
6. Nota tecnica inserita in `.ds4-design/vision-runtime-ready.md` per registrare
   la correzione senza modificare il deliverable.
7. SIGINT separato da SIGTERM: l'interrupt ora chiude soltanto il turno,
   interrompe prefill/decode/tool, conserva processo e sessione, emette
   `turn_interrupted` e torna a `+DWARFSTAR_WAITING`. Il test invia poi una
   seconda richiesta allo stesso PID e verifica la risposta.
8. `see_image` ora accetta `path` oppure un array JSON `paths` da 1 a 4 asset,
   così una famiglia di immagini usa una sola inferenza Qwen. Le risposte HTTP
   `see_image error` diventano veri `Tool error`, non risultati riusciti.
9. Un errore di ispezione asset dice esplicitamente che il flusso è
   non-bloccante dopo la validazione tecnica. Il prompt vieta ricerca di
   installer e surrogate cromatiche; dopo il secondo identico errore operativo
   il runtime emette anche uno steer deterministico contro il retry invariato.
10. Il caso Lumen parte subito da todo/read e composizione. Non richiede più
    `see_image` prima del layout; il solo giudizio estetico è il render
    desktop/mobile composto, riusato dalla cache tra `see_page`,
    `verify_artifact` e `artifact` finché il file non cambia.
11. Durante DSML trattenuto il runtime emette `tool_call_building` e
    `tool_call_progress` con nome e byte, senza mostrare argomenti parziali. La
    UI ricompone correttamente anche eventi spezzati tra due poll.
12. La modalità unbounded conserva inferenza senza deadline ma registra un
    heartbeat diagnostico ogni minuto dopo la soglia di silenzio e fallisce
    subito se il processo risulta realmente morto, anche durante startup,
    reset o attesa della sessione.
13. Il grader non può più dichiarare eseguito Qwen in assenza di un vero evento
    `visual_check`; richiede esito positivo e nessun P1 visuale. Un seed
    immutato non passa più per sito prodotto e non genera screenshot di
    evidenza fuorvianti.
14. Prima del prompt il real harness interroga `/api/vision/status` e richiede
    Qwen3.8 installato ma non caricato (`state: ready`, PID 0). Sul computer il
    runtime è presente con revisione
    `815b83c0df8ffd1d1b5244cf75fd6ef14fca9ef9`: circa 589 MB di ambiente e
    28 GB di snapshot Q8.
15. DeepSeek come unico modello pesante parte con expert SSD streaming
    esplicitamente `off`. Il contesto richiesto resta 393.216: se il lancio non
    entra interamente nel budget Metal usa il normale percorso lazy mmap,
    senza abbassare il contesto. `on` resta selezionabile manualmente.
16. La documentazione del seed ha ora una tabella operativa sintetica che
    separa Vision, generazione, editing e video con footprint e regola di
    caricamento; DeepSeek non deve leggere procedure di setup durante il
    layout.
17. Due test browser (Roadmap e H3) simulavano preferenze esplicite ma senza il
    marcatore `qualityDefaultsVersion`; la migrazione one-shot portava quindi
    correttamente `thinkLevel`/`videoProfile` ai nuovi default Max/Quality e i
    test lo scambiavano per una mutazione. I fixture ora dichiarano la
    migrazione già applicata, senza cambiare il comportamento del prodotto.
18. Rimossi dai commenti e dal manifest benchmark i riferimenti obsoleti a un
    contesto 65k e a SSD streaming obbligatorio: la run Lumen richiede 393.216
    token e, con il solo DS4 pesante, streaming esplicitamente `off`.

## Quality gate deterministico dopo le correzioni

Superati senza caricare modelli pesanti:

- manifest/baseline Design e Cowork;
- compilazione launcher/unit test memoria (`lan_unit`);
- compilazione e self-test `ds4-design`;
- test di interrupt e ripresa nello stesso processo;
- test Qwen/Ideogram bridge con singola e multi-image, render desktop/mobile e
  progress DSML;
- contratto UI, incluso default SSD off e visualizzazione tool-call building.

La successiva esecuzione completa di `make check-fast` è passata integralmente,
inclusi Roadmap, H3 video, Plan 5/5, GSA, RSA e i contratti di inferenza. Il
router `llama-server` può restare in ascolto senza modelli precaricati; al
preflight occupava meno di 1 MB RSS e non rappresentava un modello pesante
residente.

Il seed riutilizzabile è stato spostato in
`tests/fixtures/lumen-site-seed`. Le vecchie directory
`tests/.artifacts/lumen-layout-real` e
`tests/.artifacts/lumen-max-build` (147 file, circa 17 MB complessivi) sono
state spostate nel Cestino e restano recuperabili. Nessun altro benchmark è
stato cancellato.

## Esito della prima run reale

La run non è più attiva. È terminata dopo **7.124.491 ms**, cioè
**1 h 58 min 44,491 s**, con `passRate: 0` e `toolCompliance: 0`.

Evidenze finali:

- nessun processo DeepSeek, Qwen, Ideogram, Hunyuan o H3 è rimasto attivo;
- `index.html` è ancora il seed da 13.602 byte, con timestamp
  `2026-08-24 15:55:30`;
- DeepSeek non ha chiamato `edit`, `see_page`, `verify_artifact`,
  `critique_write` o `artifact`;
- non esiste una sessione KV salvata (`hasSession: false`);
- il test ha fallito 25 controlli, inclusi tutti i gate essenziali del layout;
- le immagini desktop/mobile negli artifact sono catture automatiche del seed,
  non evidenza di un sito nuovo o approvato.

### Regressione del contratto di interrupt

Per interrompere il loop di pre-analisi e inviare una prosecuzione nella stessa
sessione è stato chiamato `/api/agent/interrupt`. L'API ha risposto come se
l'engine dovesse tornare disponibile, ma `ds4-design` è invece terminato con
codice 0. Il log registra:

`engine: pid 60959 terminated — engine exited (code 0)`

La prosecuzione non ha quindi potuto essere inviata e la run non è recuperabile:
il KV della sessione non è stato scritto. Questo è un bug, non una bocciatura
estetica, e giustifica una nuova run solo dopo avere corretto e verificato il
percorso SIGINT/ritorno allo stato di attesa.

## Prossimi controlli nella nuova run

- Verificare che il prossimo avanzamento concreto sia `todo_write`/`write`/`edit`
  sul layout, non un'altra ricerca del setup Vision.
- Registrare l'ora e la dimensione della prima modifica a `index.html`.
- Controllare che Qwen non si sovrapponga a DeepSeek quando partirà il gate.
- Controllare una sola lettura congiunta desktop/mobile nel gate finale.
- Verificare menu, Escape, skip link, focus, form e stati tramite browser reale.
- Annotare ogni bocciatura del layout e la correzione concreta associata.
- Copiare sul Desktop soltanto il sito che supera il gate finale.

## Seconda run pulita — evidenze live

- Avvio confermato con DeepSeek Max, contesto 393.216, SSD streaming persistente
  `off` ed effettivo `false` finché DS4 era l'unico modello pesante.
- La prima scrittura reale di `index.html` è avvenuta alle 20:11:47: il seed è
  passato da 13.602 a 40.507 byte. Prima della scrittura DS4 ha eseguito una
  sola validazione tecnica congiunta dei quattro PNG, senza `see_image`, analisi
  cromatica o rigenerazioni.
- Il primo gate Qwen del layout ha fatto cedere la residenza pesante a DS4
  (circa 9 MB RSS durante Vision); Qwen è rimasto l'unico modello pesante e, al
  termine, la memoria libera è risalita all'83%. L'impostazione persistente SSD
  non è stata mutata.
- Il render iniziale desktop 1280/mobile 390 ha passato contrasto, overlap,
  clipping, overflow e completezza del primo viewport. Il controllo
  deterministico ha trovato 0 P0 e due P1 reali da correggere: copertura
  esplicita degli stati del form e 18 riferimenti al token accent.
- Limite scoperto nel gate: `see_page` inquadra il primo viewport, perciò ha
  dichiarato esplicitamente che strumenti, timeline e form erano sotto la
  piega. Prima della consegna queste sezioni richiedono una verifica visuale
  indipendente o un'estensione del renderer a più slice/full-page; il solo
  PASS dell'hero non basta a provare l'intero layout.

## Seconda run pulita — esito e difetti emersi

La run generativa è terminata dopo **5.806.916 ms**, cioè
**1 h 36 min 46,916 s**. Ha prodotto `index.html` da 41.324 byte, registrato
come artifact v2 con hash coerente, quality score **9,0/10** e gate finale
**0 P0 / 0 P1 / 0 P2**. Le catture desktop/mobile sono valide e il probe
esterno non ha trovato pulsanti inerti (`Reserve a telescope` e `Clear`
producono entrambi un cambiamento DOM). Al termine non risultano residenti
DeepSeek, Qwen, Ideogram, Hunyuan o H3.

La run ha avuto due soli cicli di warning prima del PASS:

1. stati del form non abbastanza espliciti per il gate e 18 riferimenti al
   token accent;
2. 10 riferimenti al token accent e un falso positivo visuale: la frase
   positiva `No truncated, merged, or overlapping glyphs detected` veniva
   interpretata come difetto perché il negatore si trovava prima di una lista
   separata da virgole.

Correzioni applicate dopo la run:

- il parser visuale conserva ora la negazione attraverso liste coordinate
  (`no …, …, or overlapping`) ma non attraverso una vera clausola avversativa
  (`no clipping issue, but controls are overlapping`); self-test e test Qwen
  deterministico passano;
- `see_page` invia ora nella stessa singola richiesta Qwen quattro render:
  top desktop/mobile e panoramiche desktop/mobile composte da una slice
  centrale e una finale. Il responsive viewport reale resta invariato, quindi
  `vh` e media query non vengono falsati. Il test verifica pixel distinti nelle
  sezioni top/middle/lower e passa ripetutamente;
- il matcher del disclaimer valuta soltanto testo pubblico visibile, non
  commenti/CSS/script, e accetta sia `no real reservation is created` sia
  l'equivalente già presente `no reservation is created`. La ri-verifica
  dell'artifact salvato passa senza modificarne l'hash;
- i launcher Chrome headless usano `--password-store=basic` e
  `--use-mock-keychain`, evitando il dialogo macOS relativo a un Portachiavi
  mancante nei profili temporanei dei test.

Aspetti ancora migliorabili o da non confondere con una consegna finale:

- il file attuale è il risultato della fase **layout** con hero PNG statico;
  il pass finale con H3/video e la pubblicazione Desktop/GitHub Pages non sono
  ancora stati eseguiti;
- prima della correzione multi-slice, anche una domanda esplicita sulle sezioni
  inferiori non poteva farle vedere a Qwen: il modello lo dichiarava
  correttamente, mentre DS4 tendeva comunque a inferire che il gate coprisse
  tutta la pagina;
- dopo il primo PASS tecnico DS4 ha continuato a ragionare manualmente sui
  controlli e ha aggiunto piccoli ritocchi a11y; il probe esterno era più adatto
  a confermare il comportamento. In futuro il flusso deve chiudere prima la
  parte generativa e lasciare interazioni e render estesi ai gate dedicati;
- il wrapper del benchmark originale conserva onestamente `passRate: 0` perché
  era già terminato prima della correzione del matcher. La ri-verifica
  deterministica post-fix passa; non è stata avviata una seconda inferenza DS4
  di 96 minuti per ricontrollare una sola equivalenza testuale.

## Revisione visuale post-run: difetti sfuggiti al gate

La revisione nel browser dell'intera pagina ha evidenziato tre difetti reali che
invalidano il precedente voto estetico 9,0/10:

- i tre strumenti avevano un ritmo verticale incoerente. Il secondo pannello
  riceveva deliberatamente un `margin-top` etichettato come `controlled
  asymmetry`, mentre il formato delle immagini era imposto soltanto al tag
  `img` e non al contenitore media;
- timeline e relativo testo erano limitati rispettivamente a 52rem e 46rem,
  lasciando inutilizzata gran parte della larghezza desktop;
- anche la lista FAQ era limitata a 46rem e impilata sotto il titolo, con un
  grande vuoto non intenzionale sulla destra.

Qwen non ha omesso questi problemi dopo averli visti: non ha ricevuto quei
pixel. Il suo responso dichiarava esplicitamente che programma, timeline, form
e FAQ si trovavano sotto entrambi i viewport e non potevano essere confermati.
L'errore è stato del flusso: DS4 ha promosso il PASS affidandosi a metriche DOM
che misuravano overflow/overlap ma non l'equilibrio compositivo, e la
supervisione ha accettato quell'inferenza non dimostrata. Il renderer
multi-slice è stato introdotto solo dopo questa run.

Correzioni applicate prima del prossimo gate reale:

- pannelli strumenti allineati, iso-altezza e con contenitore media 3:2
  vincolante; l'asimmetria rimane affidata ai crop, non alla geometria;
- timeline desktop trasformata in una composizione a due colonne, con
  introduzione a sinistra e sequenza a destra, senza `max-width` sul rail;
- FAQ desktop trasformata in una composizione a due colonne, titolo a sinistra
  e accordion fluido a destra;
- sotto 860px entrambe le sezioni tornano a una colonna con spaziatura mobile
  esplicita.

Il precedente 9,0/10 va quindi considerato storico e non più rappresentativo.
Il nuovo layout non deve essere promosso finché il gate Qwen multi-slice non ha
esaminato realmente tutte le sezioni e il controllo umano non ha verificato i
crop desktop/mobile nel browser.
## 19. Collaudo creativo: loop pre-tool su una scelta reversibile

- Durante il primo collaudo `creative-full-stack`, DS4 ha caricato correttamente il modello e interpretato l'intera pipeline, ma ha confrontato ripetutamente `brutalist` e `swiss` senza emettere il `design_system` già scelto.
- La run è stata interrotta prima di qualsiasi generazione reale: nessun asset Ideogram, Hunyuan o H3 era in corso e non è stato sprecato un ciclo multimediale.
- La precedente regola delle due ipotesi era formulata soprattutto per diagnosi di difetti e geometria; non impediva con sufficiente chiarezza un loop decisionale prima del primo tool.
- Miglioria applicata: la regola generale `DECISION DISCIPLINE` limita a un solo confronto fra massimo due opzioni ogni scelta reversibile. Dopo che DS4 dichiara una scelta o un piano con un tool successivo, la chiamata deve essere l'azione immediatamente seguente; la decisione può essere riaperta solo in presenza di nuova evidenza ottenuta da un tool.
- Regressione aggiunta al contratto statico del motore, così la regola non può essere rimossa accidentalmente.
- Il solo prompt non era sufficiente: una seconda prova ha ripetuto la decisione nonostante l'istruzione. È stato quindi aggiunto un rilevatore runtime conservativo che non riduce Think Max né il budget ordinario; chiude il canale di reasoning soltanto dopo una scelta esplicitamente fissata e due riaperture. La terza prova ha emesso `reasoning_loop_break` a 960 token e ha chiamato autonomamente `design_system("brutalist")`.

## 20. Fixture multimediale troppo piccola per un collaudo agente

- La pipeline seriale è arrivata correttamente a Ideogram e Qwen, ma la modalità test restituiva il vecchio PNG di trasporto 1×1 da 68 byte.
- Qwen simulato dichiarava corrispondenza, ma DS4 ha notato che 68 byte non possono rappresentare una fotografia editoriale e ha richiesto una verifica tecnica. Questo comportamento è corretto: proseguire avrebbe premiato un falso positivo.
- Le fixture Ideogram e Hunyuan producono ora un PNG deterministico 640×360, decodificabile, da 5.564 byte. Rimangono leggere e non caricano modelli, ma hanno proporzioni e dimensioni coerenti con una pipeline visuale.
- Il test di conformità inferenza immagini passa dopo la modifica. La run completa va rilanciata pulita; nessuna generazione reale è stata interrotta.

## 21. Prima run completa del contratto creativo

- `fullstack-kinetic-museum` è terminato in **3.006.807 ms**
  (**50 min 6,807 s**) usando in ordine seriale DS4, Ideogram, Qwen,
  Hunyuan, Qwen, MiniMax H3, `inspect_layout`, `see_page`,
  `verify_artifact` e `critique_write`.
- Questa era intenzionalmente una run di contratto: tutti i tool e i relativi
  passaggi sono stati realmente esercitati, mentre immagine, edit, visione e
  video provenivano da fixture deterministiche e non caricavano insieme i
  modelli pesanti.
- DS4 ha prodotto autonomamente una direzione brutalista/kinetic-poster,
  diversa dal precedente Lumen editoriale. Il gate finale ha misurato zero
  overflow, overlap, clipping, pannelli stirati, media disallineati o
  deformati a 1280 e 390 px; la critica composta è **8,7/10**.
- Il fixture H3 non è più un frammento 16×16 di 0,2 secondi: con `ffmpeg`
  disponibile produce un MP4 valido 1344×768 di 5 secondi a partire
  esattamente dal frame Hunyuan. Il frammento minimale resta soltanto come
  fallback di portabilità del test.

## 22. Bug trovati dalla supervisione dopo la prima run

- Il risultato testuale di `generate_video` veniva formato dentro un buffer
  da 64 byte e risultava troncato dopo `quality profile (`. Il file MP4 era
  valido, ma il transcript perdeva byte, durata e aspect ratio. Il messaggio
  viene ora composto dinamicamente e il contratto richiede esplicitamente la
  riga completa `(N bytes, 5 seconds, 16:9)`.
- `inspect_layout` leggeva `naturalWidth/naturalHeight` soltanto per `img`.
  Prima che Chrome decodificasse i metadati di un `video`, un box 16:9 reso
  come 340×768 poteva quindi apparire non deformato. Il probe usa ora, in
  ordine, dimensioni decodificate dell'immagine, `videoWidth/videoHeight` e
  infine gli attributi HTML `width/height`; espone anche la fonte intrinseca.
- Due media diretti misti, per esempio video e poster fallback, potevano finire
  in righe separate e azzerare artificialmente le differenze geometriche.
  Ora vengono confrontati come un solo gruppo; un fallback impilato sotto al
  video fallisce il gate. Un crop estremo con `object-fit:cover` fallisce salvo
  opt-out intenzionale `data-allow-crop`.
- Il precedente `reasoning_loop_break` basato su parole come
  `actually/wait/perhaps` è stato successivamente rimosso: era una topologia
  di fixture dentro il core, non una prova strutturale di stallo.

## 23. Diversità tipografica anti-clone

- Il gate statico richiede, sulle tre run creative, tre stack primari, tre
  stack display e tre coppie primaria/display distinte; cambiare soltanto
  palette o copy non basta.
- Un secondo gate apre ogni sito in Chrome e usa
  `CSS.getPlatformFontsForNode` per misurare il font di piattaforma realmente
  usato per corpo, titolo, navigazione e metadati. Questo intercetta stack CSS
  diversi che sul computer ricadono comunque sullo stesso fallback.
- La run multipla fallisce se non risultano tre font primari effettivi, tre
  display font effettivi e tre sistemi tipografici renderizzati distinti.

## 24. Quarto benchmark: il font scelto dall'utente è un contratto

- La matrice creativa passa da tre a quattro siti. Il nuovo caso
  `fullstack-user-font-tide-signal` simula una richiesta tipografica esplicita:
  l'utente sceglie **American Typewriter** e DS4 deve usarlo sia per il corpo
  sia per tutti i titoli, senza sostituirlo con una propria direzione estetica.
- La semplice presenza del nome nel CSS non vale come prova. Il gate statico
  controlla gli stack dichiarati; il gate renderizzato apre il risultato in
  Chrome e usa `CSS.getPlatformFontsForNode` per verificare il font di
  piattaforma realmente usato. Un fallback silenzioso è un fallimento.
- Anche il quarto benchmark deve attraversare l'intera pipeline seriale:
  Ideogram 4 Quality-48, Qwen3.8-27B Max per corrispondenza, edit
  HunyuanImage-3.0-Instruct, seconda verifica Qwen, MiniMax H3 quality,
  integrazione, `inspect_layout`, `see_page`, verifica artefatto e critica.
- Le soglie anti-clone sono state portate a quattro stack primari, quattro
  stack display e quattro sistemi tipografici distinti, sia dichiarati sia
  realmente renderizzati.

## 25. Diagnostica overflow insufficiente nella matrice multipla

- Nella prima prova a quattro siti DS4 ha misurato correttamente un overflow
  mobile di 19 px, ma tre chiamate `inspect_layout` focalizzate mostravano
  soltanto box apparentemente entro il viewport. Il motore non indicava quale
  nodo producesse lo `scrollWidth`, quindi DS4 ha iniziato a riaprire ipotesi
  non dimostrate invece di correggere il difetto.
- La run è stata interrotta prima del gate visuale: lasciare il modello a
  indovinare il selettore avrebbe misurato la perseveranza, non la qualità del
  design.
- `inspect_layout` ora restituisce `overflowingElements`, ordinando prima i
  nodi che escono realmente dal viewport. Per ciascuno riporta selettore CSS,
  rettangolo, `clientWidth`, `scrollWidth`, `overflow-x`, `white-space`,
  `overflow-wrap`, posizione, testo breve ed entità dello sforamento. Include
  anche gli antenati con overflow interno, utile per pseudo-elementi.
- Un opt-out intenzionale richiede `data-allow-overflow`; non è possibile
  nascondere un difetto soltanto scegliendo un selettore più stretto nella
  chiamata. La lista degli offender viene sempre calcolata sull'intera pagina.
- Una regressione dedicata crea un singolo `div` troppo largo a 390 px e
  richiede che il report restituisca proprio quel nodo. Self-test, gate font e
  contratto DS4/Qwen passano dopo la correzione.

## 26. Falsi positivi del gate stati durante la run a quattro siti

- Dopo aver corretto autonomamente l'overflow mobile di `kinetic-museum`, DS4
  aveva implementato stati reali di caricamento, vuoto, errore, successo e
  limite temporale. Il gate continuava però a emettere lo stesso P1 perché
  cercava soltanto tre parole letterali nel sorgente e non esponeva quale
  stato ritenesse assente. La run è stata interrotta: reiterare modifiche
  semantiche alla cieca non avrebbe misurato la qualità del modello.
- Il gate ora elenca esattamente gli stati mancanti fra `loading`, `empty`,
  `error`, `populated` ed `edge` e riconosce evidenze semantiche come
  `aria-busy`, `aria-invalid`, gestione dell'evento `error`, messaggi di
  successo e vincoli `maxlength`/`minlength`.
- Un attributo legittimo come `placeholder="e.g. A. Kovac"` non viene più
  confuso con copy provvisorio. Rimangono bloccati valori realmente irrisolti
  come `placeholder="placeholder text"`.
- Attributi tecnici quali `data-allow-crop` o `data-allow-asymmetry` non fanno
  più scattare da soli il gate di una data application. La copertura degli
  stati viene richiesta soltanto in presenza di form, dashboard, stato UI
  dichiarato, griglia interattiva o accesso dati.
- Nel tentativo di interpretare un P1 opaco DS4 aveva anche sostituito alcuni
  separatori tipografici senza necessità. Questo viene registrato come
  comportamento negativo: un gate deve fornire evidenza mirata, così il
  modello non è incentivato a fare modifiche collaterali per tentativi.
- Build, self-test C, regressione DS4/Qwen, schema benchmark, gate creativo e
  gate dei font renderizzati risultano verdi dopo la correzione.

## 27. Prima run rilanciata: work card omessa e tipografia non risolta

- `fullstack-kinetic-museum` ha completato l'intera pipeline in 3.722.503 ms
  (circa 62 minuti) e ha superato media, geometria, Qwen, artefatto e critica,
  ma il runner lo ha correttamente bocciato perché DS4 non aveva mai chiamato
  `todo_write`. La matrice è stata interrotta prima del secondo caso: proseguire
  avrebbe prodotto una suite già non conforme alla richiesta di usare tutti i
  tool.
- `todo_write` con almeno un passo è ora un prerequisito runtime per `write`,
  `edit`, generazione immagine/video, verifica, critica e registrazione. Pack e
  strumenti di sola lettura restano disponibili prima della work card. Ogni
  nuova run azzera il contatore e riattiva il gate; un array vuoto non lo
  soddisfa.
- Nel primo layout DS4 aveva inoltre usato `--display` e `--display-lg` senza
  dichiararli. Le regole CSS risultavano invalide e i titoli ereditavano 16 px.
  La sola geometria dei box ha permesso di scoprirlo, ma dopo troppi cicli di
  ragionamento e due fix inefficaci.
- `inspect_layout` ora include per ogni target la tipografia calcolata dal
  browser: `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `writingMode`
  e `textAlign`, oltre a display, posizione e rettangolo. Un fallback o un
  token irrisolto diventa quindi evidenza immediata e non un'ipotesi.
- Le regressioni verificano sia la work card obbligatoria sia i valori
  tipografici calcolati. Build, self-test, contratto DS4/Qwen, schema della
  matrice, gate creativo e gate font sono tutti verdi prima del nuovo rilancio.

## 28. Seconda run rilanciata: falso completamento con todo aperti

- Il nuovo prerequisito ha funzionato: DS4 ha creato e aggiornato la work card,
  completato in ordine la pipeline media e segnato `Build kinetic-museum.html`
  come `in_progress`. Subito dopo, però, il modello ha emesso EOS senza una
  chiamata `write`; il runtime registrava erroneamente `run_done` con stato
  `ok` e fase `building`.
- Una risposta terminale non è più accettata mentre la work card contiene
  elementi `pending`, `in_progress` o `stopped`. Runtime locale e remoto
  reinseriscono fino a quattro volte un messaggio operativo che richiede la
  prossima chiamata DSML concreta. Se il modello continua a fermarsi, la run
  termina esplicitamente con stato `incomplete_todos`, mai con un falso esito
  positivo.
- Anche `artifact` rifiuta ora qualunque stato incompleto, non soltanto
  `in_progress`. La memoria e lo stato persistito distinguono
  `todosHaveUnfinished` da `todosHaveInProgress`.
- Il self-test copre work card aperta, work card interamente completata, steer
  automatico e reset fra run. Build, self-test, regressione DS4/Qwen, schema
  dei 16 casi, gate creativo e gate dei font renderizzati sono verdi prima del
  terzo rilancio pulito.

## 29. Terza run: il budget del terminal guard era cumulativo

- Sul primo sito il guard ha impedito due falsi arresti e DS4 ha prodotto un
  HTML da 27.577 byte, misurato un overflow di 6 px, applicato due edit e
  riconfermato zero overflow a 1280, 768 e 390 px. Il gate visuale desktop e
  mobile è passato; `verify_artifact` ha poi bloccato correttamente un P0 e due
  P1 ancora da correggere.
- La supervisione ha però mostrato che i quattro reinvii disponibili venivano
  contati cumulativamente per tutta la run. Anche dopo `write`, `edit` e nuove
  misurazioni riuscite, il contatore rimaneva consumato: una run lunga ma
  produttiva poteva quindi fallire come se avesse emesso quattro EOS
  consecutivi senza fare nulla.
- Il tentativo è stato interrotto prima degli altri tre casi. Il budget misura
  ora soltanto arresti **consecutivi**: ogni chiamata tool concreta e
  correttamente parsata azzera il contatore e registra
  `incomplete_todo_progress_reset`. Errori DSML malformati non lo azzerano e
  restano coperti dal guard separato sugli errori ripetuti.
- Il self-test verifica esplicitamente il reset dopo progresso; la matrice viene
  rilanciata da una directory ricreata, senza riusare l'HTML interrotto.

## 30. Quarta run: falso negativo delle stringhe dopo un elemento HTML void

- DS4 ha scritto una nuova variante Swiss del museo (24.555 byte, 729 righe),
  ma il gate post-write dichiarava assenti tutte e cinque le stringhe esatte.
  Un probe sul sorgente ha mostrato che erano presenti in nodi visibili; non era
  quindi autorizzata una modifica estetica per soddisfare il messaggio.
- La causa era un `<img hidden>` usato come fallback del video. Il parser
  trattava ogni tag nascosto come contenitore e cercava il relativo tag di
  chiusura; `img` è invece un elemento void e non possiede `</img>`. Di
  conseguenza tutto il testo successivo veniva classificato falsamente come
  nascosto.
- Il riconoscimento della visibilità gestisce ora tutti gli elementi void HTML:
  `area`, `base`, `br`, `col`, `embed`, `hr`, `img`, `input`, `link`, `meta`,
  `param`, `source`, `track` e `wbr`. Un elemento void nascosto non può
  nascondere i fratelli successivi.
- La regressione mette sia `<img hidden>` sia `<input type="hidden">` prima di
  quattro stringhe obbligatorie e richiede che tutte risultino visibili. La run
  è stata interrotta prima che DS4 alterasse un sito corretto per inseguire il
  falso positivo.
## 31. Fixture di editing indistinguibile dalla generazione

Durante il benchmark `fullstack-kinetic-museum`, DS4 ha confrontato gli hash
di `kinetic-source.png` e `kinetic-final.png`: il fixture Hunyuan restituiva lo
stesso identico PNG del fixture Ideogram. Questo produceva un falso errore di
inferenza, un retry inutile e poteva incoraggiare un fallback non ammesso nella
run reale. Inoltre il fixture Ideogram era sempre 16:9 anche quando il prompt e
il tool richiedevano 4:3.

Correzione:

- il fixture Ideogram ora conserva il rapporto richiesto con dimensioni ridotte;
- il fixture Hunyuan conserva le dimensioni della sorgente ma genera pixel
  deterministici distinti, simulando un editing effettivo;
- il test di conformità verifica sia la geometria 4:3 sia la differenza tra
  sorgente ed edit.

La run reale resta fail-closed: nessun asset sorgente viene accettato come
fallback quando Hunyuan non produce un editing valido.

## 32. Stati visibili ma non verificabili semanticamente

Sia il benchmark con font scelto dall'utente sia `fullstack-kinetic-museum`
hanno costruito correttamente feedback visivi di caricamento, errore e successo,
ma il primo `verify_artifact` non poteva distinguere con certezza gli stati
`loading`, `empty` e `populated`. Il testo descrittivo esisteva; mancavano
marcatori DOM espliciti come `data-state` e `aria-busy`.

Il runtime continua a segnalare il problema come P1 e DS4 lo corregge, ma il
retry era evitabile. Le istruzioni generali ora richiedono già nella prima
scrittura `data-state=loading/empty/error/populated/edge`, `aria-busy`,
`aria-invalid` e vincoli reali `maxlength`/`minlength`/`min`/`max` quando
applicabili. Il testo visibile da solo non viene considerato prova sufficiente.

## 33. Qwen Max attivo ma status apparentemente fermo

Nella prima pipeline media reale, il router Qwen3.8-27B Q8 ha lavorato per più
di otto minuti con attività CPU/Metal continua, memoria coerente e lock
pesante correttamente posseduto, mentre `status.json` è rimasto invariato a
`captioning`/12%. Il processo non era bloccato: lo status viene aggiornato solo
al cambio di fase e non durante la generazione Max che termina su EOS.

Questo è un difetto di osservabilità: dall'interfaccia una generazione lunga e
un deadlock appaiono uguali. Il runtime dovrebbe aggiungere un heartbeat
temporale che riporti almeno tempo trascorso, PID ancora vivo e memoria/attività
del worker senza introdurre un limite di token o interrompere Max. Il benchmark
continua a distinguere lo stato reale controllando processo, lock e output di
fase; nessun progresso viene dichiarato prima della comparsa di
`image-route.json`.

## 34. Costo reale di Ideogram 4 FP8 Quality-48 su MPS

La prima generazione reale 4:3 ha confermato che la lentezza non proviene dal
layout: Qwen3.8-27B Max ha impiegato 1.057,71 secondi per routing e caption
strutturata, poi Ideogram ha iniziato il preset completo da 48 step. I primi
due step hanno richiesto rispettivamente 224,44 e circa 244 secondi, per una
media iniziale vicina a 234 secondi/step e una proiezione di circa tre ore per
la sola diffusione.

Il modello ufficiale non pubblica pesi BF16 originali: il model zoo offre FP8
e NF4, mentre il repository Comfy aggiunge altre quantizzazioni derivate.
Convertire FP8 a BF16 non recupererebbe informazione e NF4/INT8 sarebbe una
retrocessione rispetto al profilo richiesto. La run conserva quindi FP8,
Quality-48 e il rapporto 4:3; il tempo viene attribuito esplicitamente alla
fase di inferenza e non al sito o a retry estetici.

## 35. Audit evidence-first del layout e degli screenshot utente

Il primo contact sheet per sezioni aveva ancora una debolezza: Chrome poteva
scrivere un PNG valido prima che tutti gli iframe selettore fossero pronti. Il
wrapper inoltre controllava troppo presto il `contentDocument` iniziale
`about:blank`; questo poteva segnare zero sezioni come completate e trasformare
uno screenshot vuoto in falsa evidenza. Ora ogni pannello registra il proprio
esito, il renderer accetta il contact sheet soltanto quando
`ready == sectionCount`, `failed == 0` e almeno una sezione è presente, e
l'avvio anticipato è ammesso solo se l'URL realmente caricato coincide con la
sorgente richiesta. La regressione verifica con pixel distinti hero, sezione
intermedia e sezione finale, sia a 1280 sia a 390 px.

`inspect_layout` esponeva già bounding box, dimensioni intrinseche/renderizzate,
allineamenti e gap orizzontali, ma dopo il collasso responsive a una colonna i
gap verticali restavano impliciti. Ogni gruppo ripetuto include ora
`horizontalGaps`, `verticalGaps`, `computedRowGap` e `computedColumnGap`; il
test con attributi HTML `width`/`height` e CSS responsive richiede 20 px esatti
su desktop e mobile e continua a distinguere la variante deformata.

Il precedente guard che cercava formule come “maybe/perhaps/actually/wait” è
stato eliminato. Ora il core non interpreta linguisticamente il reasoning:
mantiene lo stato `layout_evidence_required` derivato da record del grader e
misure DOM, e rifiuta deterministicamente edit, write, bash, nuovi media e
sign-off finché `inspect_layout` non soddisfa l'evidenza richiesta.

Infine drag-and-drop e incolla salvavano già gli screenshot utente byte per
byte nel workspace, ma il normale input file Agent/Design poteva ancora usare
il vecchio flusso Chat. Tutti e tre i percorsi passano ora dal medesimo
`[USER_SCREENSHOT path="..."]`; un test HTTP verifica bytes e path esatti e il
contratto UI verifica che il marker resti nel prompt runtime inviato a DS4.

Verifiche verdi dopo l'audit: build C, self-test, integrazione DS4/Qwen/Chrome,
contratto UI, endpoint HTTP, interrupt, control probe, contratto Qwen3.8,
conformità immagine, schema dei 16 benchmark, creatività, diversità font e
`git diff --check`.

## 36. Audit anti-hardcoding del core — 25 agosto 2026

La revisione ha confermato due meccanismi non accettabili nel codice di
produzione:

- il parser cercava una lista di frasi inglesi nelle osservazioni libere di
  Qwen per decidere se un `PASS` fosse contraddittorio;
- il decoder cercava frasi come `maybe`, `perhaps`, `actually` e nomi di design
  system nel reasoning nascosto per forzare la chiusura del blocco Think.

Entrambi sono stati rimossi. Il grader del sito emette ora dieci record
`GRADE|VIEWPORT|CRITERION|STATE|evidence` e opzionali record
`FINDING|VIEWPORT|CRITERION|FAIL|evidence`. Il core interpreta esclusivamente
i campi tipizzati; il testo dell'evidenza è opaco e può essere scritto in
qualunque lingua. Una risposta incompleta, duplicata o contraddittoria non può
passare.

La geometria resta indipendente dal modello: Chrome restituisce box, overflow,
dimensioni intrinseche, crop, tipografia e gap a 1280/768/390 px. La ricerca di
pannelli vuoti non dipende più da nomi di classe quali `rail`, `activity` o
`sidebar`, ma da semantica DOM e proprietà visuali calcolate. Le tolleranze sono
raccolte in una policy nominata e non contengono valori del sito Lumen o dei
benchmark.

Il valore «370 px» rimane soltanto nella fixture esterna che dimostra una
contraddizione; non è una costante decisionale del runtime. Nel core non sono
presenti nomi o copy di Lumen, Saturno, Tide Signal o degli altri siti di prova.

Verifiche eseguite dopo il refactor:

- compilazione `ds4-design` senza warning;
- self-test C;
- integrazione DS4/Qwen/Chrome completa;
- contratto UI;
- validazione dei 16 benchmark strict;
- gate creatività e diversità font;
- `git diff --check`.

La run reale `design-creative-real-tide` era già partita con il vecchio binario
e `--think-tokens 16384`. Non verrà considerata la run finale. Per non perdere
l'inferenza Ideogram già avanzata, l'asset viene lasciato completare; la fase
finale DS4 verrà eseguita con il binario aggiornato, Think Max e reasoning
illimitato.

## 37. Crash Ideogram VAE su MPS e stato terminale — 25 agosto 2026

La prima inferenza Ideogram 4 ha completato tutti i 48 step a 2048×1536, ma il
decode full-frame di `flux2-vae.safetensors` è terminato in
`MPSGraph does not support tensor dims larger than INT_MAX`. Non era un OOM:
il blocco di self-attention spaziale del VAE superava il limite di indicizzazione
signed-32-bit del grafo Metal. Poiché ComfyUI registra `execution_error` con
`status_str=error` e `completed=false`, il worker controllava soltanto il flag
`completed` e restava erroneamente fermo al 90%.

Correzioni di produzione:

- il VAE usa il decoder tiled nativo di ComfyUI con tile 1024, overlap 256 e
  blending a tre orientamenti, mantenendo risoluzione 2048, Quality-48, sampler,
  CFG e seed invariati;
- il polling tratta immediatamente `status_str=error` come terminale e conserva
  tipo, nodo e messaggio dell'eccezione senza serializzare l'enorme dump tensor;
- lo step 48 espone lo stato reale `decoding`, non un ambiguo sampling al 90%;
- il backend C non sovrascrive più l'errore specifico del worker con il generico
  `Local image inference failed` e per uno stato di errore emette `ok:false`.

Verifica MPS reale, eseguita caricando soltanto il VAE pinned:

- decode tiled 2048×1536 completato in 59,127 secondi;
- PNG RGB valido, 2048×1536, entropia luminanza 6,4436;
- confronto dallo stesso latent tra decode monolitico e tiled: MAE 0,0024498,
  MSE 0,0000117838, PSNR 49,287 dB;
- nessuna ricomparsa dell'errore `INT_MAX`.

Regressioni verdi dopo il fix: conformance Ideogram/Hunyuan, probe MPS reale,
unit test C dello stato, Qwen3.8, UI contract e l'intera `make check-fast`,
inclusi DS4/Qwen/Chrome, 16 benchmark strict, browser UI, video/H3, HTTP e LAN.
La prima `check-fast` era stata uccisa per contesa con la vecchia run fallita,
che aveva riavviato Qwen 27B; dopo aver chiuso quel gruppo orfano, lo stesso test
isolato e la suite completa sono passati. La run finale riparte pulita con un
solo modello pesante alla volta, SSD streaming disattivato durante DS4-only,
context 393.216, Think Max e reasoning cap 0.

## 38. Run finale illimitata: latenza prima azione e ritmo reale

La run pulita `design-creative-real-tide` conferma due costi operativi che non
sono errori di inferenza, ma che vanno resi più leggibili nell'interfaccia:

- con context 393.216, Think Max e cap 0, DS4 ha impiegato **95 minuti e 22
  secondi** fra `run_started` e la prima chiamata `todo_write`; il transcript è
  cresciuto in modo continuo e non ripetitivo, ma fino alla prima tool call non
  esisteva ancora alcun asset;
- Qwen3.8-27B Q8 Max ha completato routing e caption Ideogram in **873,449
  secondi** (14 minuti e 33,449 secondi), con `thinkingBudget: null` e context
  nativo 262.144;
- Ideogram 4 è partito solo dopo l'uscita di Qwen. Il passaggio dallo step 1 allo
  step 2 ha richiesto **253,040 secondi**, coerente con la precedente misura di
  circa 224–244 secondi per step e con una durata prossima a tre ore per i 48
  step Quality.

La pipeline rispetta quindi la serializzazione richiesta: DS4 resta sospeso e
scaricato mentre lavorano Qwen o Ideogram; Qwen termina prima del caricamento di
Ideogram; Hunyuan e H3 non sono ancora residenti. La memoria libera misurata
durante i primi step Ideogram resta superiore al 70%.

Miglioramento utile, senza introdurre limiti o scorciatoie: mostrare nel client
un heartbeat di fase con durata, timestamp dell'ultimo avanzamento e velocità
media per step. Le percentuali discrete (`12%` durante tutta la caption Qwen e
`22%` allo step Ideogram 0) sono corrette ma, da sole, fanno apparire ferma una
run Max che sta realmente lavorando. Non va derivato alcun timeout da queste
stime e non va ridotta la qualità.

Checkpoint reale della stessa run: Ideogram ha raggiunto lo step **8/48** in
**31 minuti e 50 secondi**. La media progressiva è scesa a **230,05
secondi/step**, con una stima residua di **2 ore, 33 minuti e 21 secondi**. Il
worker non ha emesso errori, NaN o retry e la memoria libera di sistema era il
74%; Qwen, Hunyuan e H3 non risultavano residenti.

Al checkpoint **16/48**, la diffusione aveva impiegato **1 ora, 3 minuti e 53
secondi**, con media progressiva **238,60 secondi/step** e stima residua **2
ore, 7 minuti e 15 secondi**. La memoria libera era il 72%; il log continuava a
non mostrare errori, NaN o retry e nessun altro modello pesante risultava
attivo.

A metà diffusione, **24/48**, il tempo cumulativo era **1 ora, 37 minuti e 31
secondi**, la media progressiva **253,80 secondi/step** e la stima residua **1
ora, 41 minuti e 31 secondi**. Memoria libera ancora al 72%, senza errori, NaN,
retry o modelli pesanti concorrenti.

Al checkpoint **32/48**, il tempo cumulativo era **2 ore, 9 minuti e 20
secondi**, la media progressiva **238,20 secondi/step** e la stima residua **1
ora, 3 minuti e 31 secondi**. Memoria libera al 69%; ancora nessun errore, NaN,
retry o modello pesante concorrente.

Al checkpoint **40/48**, il tempo cumulativo era **2 ore, 41 minuti e 37
secondi**, la media progressiva **244,23 secondi/step** e la stima residua **32
minuti e 33 secondi**. La memoria libera era risalita al 76%; il worker restava
privo di errori, NaN e retry e non risultavano modelli pesanti concorrenti.

La stessa inferenza ha poi completato **48/48** step in **3 ore, 15 minuti e 9
secondi**; il prompt ComfyUI completo, incluso il decode, è terminato in **3
ore, 15 minuti e 59 secondi**. Il nuovo decode tiled è quindi riuscito nella
run end-to-end reale senza l'errore `INT_MAX`, senza NaN e senza retry. Il
worker è passato correttamente da `running / decoding / 92%` a `complete /
complete / 100%`.

L'asset consegnato a DS4 è un PNG RGB 8-bit valido da **2048×1536**, grande
**4.240.496 byte**, con entropia luminanza **7,5768**. Il file del job e
`workspace/assets/tide-source.png` hanno lo stesso SHA-256:
`4f0246e0b92d060af566f55a03eaa2798196f9d218c540058f3ba53b16a1ac54`.
La provenance conferma `V4_QUALITY_48`, 48 step, Euler, CFG 7, polish CFG 3 e
decode tiled 1024/256. Subito dopo l'uscita di Ideogram è stato avviato soltanto
Qwen3.8-27B Q8 Max per il controllo di corrispondenza richiesto; Hunyuan, H3 e
DS4 non erano residenti in concorrenza.

Il primo `see_image` Qwen Max è terminato in **8 minuti e 12 secondi**. Ha
confermato la corrispondenza visibile (un solo indicatore vermiglio, asta in
ottone, pontile, estuario nebbioso, assenza di testo o marchi leggibili) e ha
segnalato correttamente come non deducibili dalla sola immagine attributi quali
«costruito a mano» e la funzione esatta della bandierina. Non ha applicato un
gate estetico né richiesto una rigenerazione. DS4 ha usato le piccole incisioni
inventate sull'asta come requisito dell'edit già previsto e ha quindi avviato
la seconda `generate_image` con `source_path=assets/tide-source.png`, senza
modificare manualmente l'asset.

## 39. Hunyuan: NaN MPS prima del decoder e runtime nativo corretto

La prima fase Hunyuan è fallita durante il prefill Max con
`probability tensor contains either inf, nan or element < 0`. La prima sonda
sincronizzata sul decoder ha dimostrato che il layer 0 riceveva già un tensore
non finito; una seconda sonda, posta sui rami di input, ha localizzato il primo
valore non finito nel latente prodotto dal VAE della sorgente, prima di
`patch_embed`, SigLIP e transformer. Non era quindi corretto attribuire il
problema al reasoning, al sampler o al layout.

Il difetto si è rivelato dipendente dallo stato dell'allocatore MPS: due
processi puliti con PyTorch 2.13 hanno prodotto un latente VAE non finito,
mentre la stessa elaborazione, resa sincrona dai probe per-blocco, è risultata
interamente finita. Questo coincide con il difetto upstream documentato per
PyTorch 2.7–2.13, nel quale la disposizione dei buffer dopo grandi allocazioni
può causare risultati Metal errati; le nightly successive al 23 giugno 2026
incorporano il nuovo bucketing dell'allocatore e risultano empiricamente
pulite.

È stata scartata la prima ipotesi di sostituire SDPA con un'attenzione custom a
blocchi. Il runtime ora usa esclusivamente SDPA nativo e fallisce chiuso se non
trova la build validata:

- PyTorch `2.15.0.dev20260821`, commit
  `cef373b344057d8ed91bcf05d7921b2ca1d0d13c`;
- torchvision `0.30.0.dev20260825`;
- nessun kernel di attenzione custom e nessun troncamento di token;
- invariati NF4-v2, moduli critici BF16, sampling 0,6 / top-p 0,95 /
  top-k 1024, context nativo 22.800 e 50 step.

Evidenza ottenuta prima della promozione del runtime:

- SDPA BF16 nativo lungo, confrontato con definizione CPU FP32: MAE
  `0,00004623`, errore massimo `0,00044923`, ripetibilità bit-identica;
- caso GQA esatto al confine di 1.024 token: MAE `0,00008991`, massimo
  `0,00062568`, ripetibilità bit-identica;
- prefill reale dell'edit: latente VAE, 3.072 token VAE, 1.024 token SigLIP e
  input decoder da 5.454×4.096 tutti finiti;
- tutti i 32 layer completati e logits finali 5.454×133.120 finiti;
- conformance immagini, self-test DS4 e contratto Qwen3.8 verdi.

Il backend C ora conserva inoltre l'errore concreto restituito dal worker
immagine invece di trasformare un JSON `error` privo di `id` nel messaggio
fuorviante «JSON response is missing field id».

La vecchia run DS4 non è recuperabile: era stata sospesa mentre il worker
fallito veniva terminato e, dopo oltre un'ora senza poter chiudere la tool call,
è uscita senza salvare il KV cache. L'asset Ideogram resta integro e viene usato
per la prova Hunyuan reale standalone; una successiva run completa dovrà
partire con il runtime corretto, senza sospensioni manuali del processo DS4.

## 40. Prova Hunyuan reale full-50 e audit del percorso MoE

Il primo reasoning standalone terminato dopo il fix numerico è stato fermato
prima della diffusione: il suo recaption chiedeva erroneamente di rimuovere la
crosta salina, in contrasto con l'istruzione. L'artefatto respinto è conservato
come `hunyuan-max-reasoning-rejected-salt.json`; non ha consumato alcuno dei 50
step. Il prompt è stato chiarito senza aggiungere regole al core: deve
preservare e recuperare crosta, macchie saline, fibra del legno e patina
dell'ottone, rimuovendo soltanto testo inventato, hardware duplicato o
fisicamente impossibile e il ghosting al livello dell'acqua.

Il secondo reasoning Max, senza `max_new_tokens` e senza timeout, ha completato
in **1.106,857 secondi**. Il recaption risultante preserva esplicitamente
texture, sale, ottone, paesaggio e bandierina e limita le rimozioni agli
elementi richiesti. Il transcript è legato a prompt, sorgente e seed con
SHA-256 `64379947c530584be78fda1785443c0bc2e9e80c3155b752400901a9d48280d1`.

La diffusione in un processo fresco ha completato **50/50 step** e decode in
**3.582,122 secondi** complessivi; il solo sampler ha dichiarato 3.522,69
secondi. Non sono comparsi NaN, errori MPS, retry o modelli pesanti concorrenti.
Il risultato è un PNG RGB 1024x768 da 1.091.553 byte con SHA-256
`db4934c2a8f9c6ea949e3833f859efc171a4ad2714a0bd46a9feb311d0862cc4`.
Il controllo visivo conferma la rimozione delle scale inventate, la continuità
fisica dell'asta nell'acqua, l'assenza del riflesso duplicato e la conservazione
di legno, sale, patina, bandierina, estuario e luce. La validazione automatica
ha misurato entropia luminanza 7,5784 e il 98,5453% di pixel in bin di luminanza
significativi.

Dopo la run sono risultati verdi il probe SDPA MPS nativo, la conformance delle
inferenze immagine, il contratto Qwen3.8 e il self-test DS4. L'audit successivo
ha però rilevato che il runner sostituisce ancora il `forward` MoE per evitare
la matrice di dispatch densa della vecchia copia del codice modello. La logica
è generale e coperta da equivalenza, non contiene dati del benchmark, ma resta
un percorso numerico custom e quindi non è accettata come stato finale. La
revisione ufficiale Tencent `2ec2c78bee7d4b94157341fba86c4c2c7b1858b2`
include già il percorso eager DeepSeek memory-efficient; Transformers 5.15.1
salta inoltre il warm-up MPS nativamente. Il prossimo intervento elimina le due
sostituzioni runtime e il benchmark finale partirà soltanto dopo un prefill
reale finito sul percorso ufficiale.

## 41. Eliminazione del motore MoE custom e prove native di produzione

Il percorso numerico custom segnalato nella sezione precedente è stato
eliminato. Il runner non contiene più `memory_efficient_moe_forward`, routing
slot-major, sostituzioni di `forward`, guard runtime dell'allocator o wrapper
runtime per SigLIP. Il runtime viene ricostruito a ogni setup da file upstream
immutabili e verificati per SHA-256: il checkpoint NF4 fornisce pesi,
pipeline e VAE compatibili, mentre il blocco coerente `HunyuanMLP` / gate /
`HunyuanMoE` proviene dalla revisione Tencent
`2ec2c78bee7d4b94157341fba86c4c2c7b1858b2`. Le sole trasformazioni locali
rimaste sono correzioni di portabilità MPS fail-closed e guard di finitezza;
attenzione e MoE restano le implementazioni numeriche ufficiali Tencent.

Sono state valutate anche due alternative più recenti prima di scegliere il
runtime definitivo:

- Transformers 5.15.1 include il fix MPS upstream, ma il caricamento reale del
  checkpoint ha raggiunto soltanto 148 tensori su 5.161 dopo 12 minuti e 25
  secondi, con proiezione superiore a sette ore: regressione del loader, run
  interrotta senza inferenza;
- Transformers 5.12.1 ha caricato tutti i 5.161 tensori in 63–71 secondi, ma il
  nuovo contratto del processor SigLIP2 Fast restituisce una lista dove il
  modello Hunyuan pin-nato richiede un tensore (`list` priva di `squeeze`):
  incompatibilità di preprocessing e rischio di regressione visiva.

È stato quindi mantenuto Transformers 4.57.1, versione compatibile con il
preprocessing del checkpoint, applicando nel file installato esclusivamente il
successivo skip MPS ufficiale di `caching_allocator_warmup`. Non esiste alcuna
monkeypatch a runtime. PyTorch resta la nightly validata
`2.15.0.dev20260821` (`cef373b…`) e l'attenzione resta SDPA nativa.

Evidenze sul runtime di produzione, non sul candidato:

- ricostruzione byte-per-byte delle tre sorgenti runtime a partire dagli input
  upstream pin-nati: PASS;
- conformance Ideogram/Hunyuan e contratto Qwen3.8/lock pesanti: PASS;
- SDPA BF16 e GQA MPS contro riferimento FP32: stessi errori contenuti della
  sezione 39 e ripetibilità bit-identica;
- prefill multimodale reale fino a `lm_head`: **127,339 secondi**, 32 layer MoE
  ufficiali, input decoder 5.489×4.096 e logits 5.489×133.120 tutti finiti;
- primo aggiornamento reale della schedulazione **Quality-50**: **272,720
  secondi**, 129 probe, tutti i 32 layer di attenzione/MoE/output e il final
  layer 2×32×48×64 finiti;
- nessuna sovrapposizione di modelli in entrambe le prove; crescita swap
  rispettivamente −0,109 GiB e −0,094 GiB.

I report riproducibili sono in
`tests/.artifacts/hunyuan-native-production-prefill-v4/` e
`tests/.artifacts/hunyuan-native-production-first-step-v4/`.

Aspetti ancora migliorabili, senza cambiare qualità o numerica:

- `load_tokenizer` emette un avviso upstream perché il metadato iniziale è
  `PreTrainedTokenizerFast`; subito dopo il caricamento il tipo effettivo viene
  verificato come `HunyuanImage3TokenizerFast`. È rumore di log, non un fallback
  né un errore di tokenizzazione, ma può essere eliminato a monte in futuro;
- il picco di memory footprint del primo step è 63,710 GiB e il campionatore
  `vm_stat` osserva per brevi istanti pochissime pagine libere. Non si è avuta
  crescita swap o errore, ma questo conferma che la serializzazione stretta dei
  modelli è un requisito, non soltanto un'ottimizzazione;
- il benchmark finale dovrà produrre un nuovo artefatto reasoning schema v4.
  Il primo-step diagnostico qui riusa il transcript schema v3 precedente solo
  dopo verifica di hash e binding a prompt/sorgente/seed; non lo presenta come
  reasoning generato dal nuovo runtime.

## 42. Benchmark creativo completo v4 — osservazioni in corso

La run pulita dei quattro casi è partita da
`tests/.artifacts/design-creative-real-all-v4/` con DS4 a contesto 393.216,
Think Max senza cap e SSD streaming disattivato. Il preflight ha confermato
Qwen installato ma non residente; durante il primo reasoning risulta attivo
soltanto DS4.

Prima osservazione migliorabile, rilevata senza interrompere la run: il prompt
di sistema elenca integralmente un catalogo molto ampio di design system e
DS4 dedica i primi minuti a reinterpretare più volte il limite delle skill e
la serializzazione degli strumenti, già espliciti nel brief. Il ragionamento
continua ad avanzare verso una tesi visiva e non mostra ancora un loop
identico, quindi non è un bug né autorizza un cap. In una futura revisione del
core conviene fornire al modello una ricerca del catalogo o un sottoinsieme
pertinente, conservando gli stessi strumenti e la stessa libertà creativa:
ridurrebbe tempo e rumore contestuale senza abbassare qualità o thinking.

Il controllo anti-loop a circa 13 minuti dall'avvio ha misurato un transcript
in crescita continua (21.410 byte) e una frequenza massima pari a 2 per le
sequenze contigue di 16 token lessicali. Le code campionate passano dalla
struttura editoriale ai dettagli di form, stati, tipografia e prompt media:
non c'è quindi evidenza di ragionamento inceppato. In questa fase la memoria
libera di sistema è scesa al 2%, ma lo swap non cresce monotonamente e il solo
processo modello presente resta DS4. La condizione è compatibile con il modello
mappato a contesto 393.216, ma impone di verificare l'evacuazione completa
prima della prima chiamata Qwen o Ideogram.

A circa 19 minuti il transcript ha raggiunto 32.730 byte, con crescita di
1.811 byte in 50 secondi e frequenza massima ancora 2 per sequenze di 18 token.
Il modello sta ora specificando fallback statico, controllo pausa/riproduzione
e comportamento `prefers-reduced-motion`: progresso semantico concreto. Il log
server contiene soltanto il `POST /api/agent/send`, `engineError` è vuoto e non
risultano processi media concorrenti. Lo swap di sistema è però passato da
15.360 MiB totali/14.329 MiB usati a 16.384 MiB/15.828 MiB durante la crescita
del KV cache. Prima del passaggio al primo modello media va quindi verificato
non solo il lock logico, ma anche l'effettivo rilascio della memoria Metal.

Il processo del benchmark è stato ispezionato direttamente con `ps eww`:
`DSTUDIO_DESIGN_UNBOUNDED=1`, profilo `creative-full-stack` e flag reali per
image, video e vision sono tutti presenti. Non esiste dunque un timeout del
harness mascherato dalla configurazione del server. A circa 22 minuti il
transcript è arrivato a 37.813 byte e continua a tradurre il brief in decisioni
responsive concrete (indice sfalsato mediante indentazione progressiva e
regole esposte), senza ancora emettere la prima tool call.

L'audit dei maggiori processi non trova altri runtime Qwen, Ideogram, Hunyuan
o H3. Sono però presenti più processi Java dell'utente con heap dichiarati da
6 GiB e attività CPU sostenuta, oltre a un server Java con heap massimo 1,5
GiB. Non vengono terminati perché sono esterni allo scope del benchmark e non
sono modelli caricati da DStudio; possono comunque contribuire alla pressione
di memoria e alla durata osservata. Questo fattore dovrà comparire nel report
hardware/ambiente per non attribuire tutto il tempo al solo decoder DS4.

La dimensione del problema catalogo è stata misurata sull'argv reale del
processo, senza inferenze: l'argomento `-sys` occupa 15.132 caratteri nella
rappresentazione di `ps`, contiene 183 newline codificate e 156 voci con
metadati `[cat=…]`. È abbastanza grande da produrre rumore decisionale, ma
resta una frazione piccola del contesto 393.216; non può da solo spiegare i
tempi del reasoning Max. Un eventuale `design_system_search` dovrà quindi
dimostrare con benchmark di preservare varietà/qualità prima di sostituire il
catalogo completo.

### Interruzione giustificata: conflitto tipografico nel core

A 29 minuti, prima di qualunque tool call o asset costoso, DS4 ha incontrato
una contraddizione letterale nel prompt di produzione: «ALL-CAPS needs
letter-spacing 0.06-0.1em» e «display >=48px needs -0.02 to -0.03em» erano
imposte nella stessa frase senza precedenza. Il primo benchmark usa proprio un
titolo ALL-CAPS sopra 48px; il modello ha dovuto scegliere autonomamente quale
regola violare. Questa non è una preferenza estetica né una toppa del caso, ma
un bug generale del contratto tipografico.

Il turno è stato quindi interrotto tramite `/api/agent/interrupt` con stato
`incomplete`; il runtime ha emesso `reasoning_end`, `turn_interrupted` e ha
confermato di restare pronto. Il runner, che corre tutti i casi in sequenza,
stava correttamente iniziando una nuova sessione: è stato fermato con SIGINT
prima dell'invio del caso successivo. Tutti i processi DStudio/modello sono
usciti e nessun PNG/MP4/HTML era stato creato.

La regola corretta distingue ora label/metadata ALL-CAPS sotto 48px dal display
e rende esplicita la precedenza del display. Sopra 48px il mixed-case mantiene
il range stretto negativo; l'ALL-CAPS può usare da -0,02 a +0,04em secondo il
font, con collisioni e gap verificati sul render. Un self-test vieta la vecchia
frase ambigua. I fatti diagnostici sono conservati in questa sezione; la
directory incompleta viene eliminata, come richiesto per i vecchi benchmark, e
la prova valida riparte sul nuovo binario in una directory pulita.

Build e regressioni dopo il fix: `git diff --check`, self-test Design, control
probe, disclosure, interrupt, contratto DS4/Qwen/Chrome e validazione dei 16
benchmark sono tutti PASS. La vecchia directory con 13 file è stata spostata
nel Cestino in modo recuperabile; nessun altro artefatto è stato toccato.

La run pulita è ripartita nello stesso percorso v4 sul nuovo binario. Startup:
DS4 PID 60043, HTTP 58258, contesto 393.216, power 90, Think Max, think cap 0,
SSD streaming richiesto `off` ed effettivo `false`; Qwen3.8 preflight pronto ma
PID 0. Dopo il prefill iniziale il prompt è stato inviato e il nuovo transcript
ha emesso `reasoning_start`; il solo modello residente è DS4.

### Seconda interruzione giustificata: exact copy contro divieto dei dash

Nei primi 9.102 byte della run corretta DS4 ha rilevato un'altra
contraddizione nel prompt di produzione. Il literal-copy contract obbliga a
preservare byte-per-byte dashes e punteggiatura imposti dall'utente, mentre una
regola successiva vietava senza eccezioni `—` e `–` nel testo visibile. Il caso
attuale richiede `14—15 NOVEMBER`; altri casi già presenti richiedono
`18 October — 19:30` e `Subscribe — €48 / year`. Non era quindi un difetto
costruito per il nuovo benchmark.

Anche questa run è stata interrotta prima della prima tool call e il runner è
stato fermato prima di inviare il caso seguente. La regola ora riguarda solo la
prosa inventata dal modello: suggerisce punteggiatura più semplice ma dichiara
esplicitamente che brand text e exact-copy literals mantengono la loro
punteggiatura byte-per-byte. Un nuovo self-test vieta il vecchio divieto
assoluto. Dopo build/regressioni la directory incompleta viene nuovamente
rimossa e la run valida riparte pulita.

Anche dopo questo secondo fix risultano PASS build, self-test, control probe,
disclosure, interrupt, contratto DS4/Qwen/Chrome e 16 benchmark strict. I 13
file incompleti sono stati spostati nel Cestino. La terza run pulita è partita
con HTTP 60384 e DS4 PID 91778, mantenendo 393.216/Max/cap 0/SSD off; Qwen è
pronto ma non residente. Dopo il prefill il nuovo reasoning è cresciuto di
2.075 byte in 50 secondi senza citare né reinterpretare le due vecchie regole
contraddittorie.

### Terza interruzione giustificata: Qwen extra sul video H3

Prima di qualsiasi tool call, DS4 ha pianificato di estrarre con `ffmpeg` un
frame del video H3 e chiamare ancora `see_image` per controllare warping e
cuts. Il tool limita già la risposta del vision model alla corrispondenza e
nega un gate estetico isolato, ma il prompt non vietava espressamente un gate
frame-video aggiuntivo; inoltre il benchmark richiedeva almeno due
`see_image`, non esattamente i due previsti. La chiamata avrebbe quindi
caricato Qwen una terza volta per ogni sito senza essere bocciata, in contrasto
con il flusso concordato: Qwen solo sulla generazione e sull'edit, video e
qualità soltanto dentro il layout composto.

Il turno e il runner sono stati fermati prima dei media. Il prompt di
produzione ora vieta l'estrazione/ispezione di frame MiniMax H3 salvo richiesta
esplicita dell'utente e rimanda l'integrazione del video a `see_page`. Il
validator richiede esattamente due `see_image`; il grader reale controlla sia
il conteggio esatto sia che entrambe precedano `generate_video`. Self-test e
contratto DS4/Qwen verificano la nuova regola. Dopo le regressioni la quarta
run ripartirà pulita.

Le regressioni successive sono tutte PASS: sintassi dei due file JavaScript,
`git diff --check`, build/self-test, control probe, disclosure, interrupt,
contratto Qwen/Chrome e 16 benchmark strict. I 13 file incompleti della terza
run sono stati spostati nel Cestino; non risultavano PNG, MP4 o HTML.

La quarta run pulita è partita con HTTP 63678 e DS4 PID 25067, ancora
393.216/Max/cap 0/SSD off e Qwen PID 0. Dopo il prefill il reasoning è cresciuto
di 1.995 byte in 50 secondi. La sequenza pianificata contiene i due soli
`see_image` richiesti (source ed edit) prima di H3; non compaiono `ffmpeg`,
estrazione di frame o ispezioni video isolate.

### Quarta interruzione giustificata: scheletro universale da otto sezioni

Prima dei tool, DS4 ha iniziato a progettare esplicitamente «8 sections, >=4
layout families» perché il prompt di produzione lo imponeva come hard rule a
ogni sito. Questo vincolo spiega una parte concreta della somiglianza osservata
dall'utente: anche con palette, font e hero diversi, tutti gli artefatti vengono
spinti verso la stessa lunghezza e lo stesso numero di blocchi.

La run è stata fermata prima dei media. Il core ora dichiara che il numero di
sezioni segue il contenuto e vieta di riempire fino a un conteggio fisso; la
varietà scala proporzionalmente (almeno 2 famiglie per 3–4 sezioni, 3 per 5–7,
4 da 8 in su). Il self-test e il contratto Qwen vietano la vecchia frase. Il
creativity gate registra i conteggi e, nel profilo dei quattro siti, richiede
almeno due conteggi distinti oltre ai controlli già presenti su DOM, classi,
layout, hero, palette e quattro sistemi tipografici differenti. Un test
dedicato prova sia il rifiuto del conteggio unico sia il PASS di strutture
variate.

La prima esecuzione delle regressioni ha correttamente fallito per un difetto
nel nuovo test statico: cercava la vecchia frase in tutto il sorgente C e la
trovava dentro il self-test che ne controlla l'assenza dal prompt runtime. Non
era una regressione di produzione. Il controllo ridondante è stato rimosso;
restano il self-test sul valore compilato e l'asserzione positiva sul nuovo
contratto. Alla seconda esecuzione sono PASS: creativity unit, sintassi/JSON,
`git diff --check`, build/self-test, controls, disclosure, interrupt,
DS4/Qwen/Chrome e 16 benchmark strict. I 9 file incompleti sono stati spostati
nel Cestino.

La quinta run pulita è partita con HTTP 51145 e DS4 PID 63199. Dopo il prefill,
il nuovo reasoning è cresciuto di 2.133 byte in 50 secondi senza menzionare
otto sezioni, conteggi fissi, `ffmpeg` o frame H3. La pianificazione mantiene
due controlli Qwen e lascia che il numero di sezioni emerga dal contenuto.

### Quinta run: latenza pre-azione con Max illimitato

Dopo circa 13 minuti dal prefill, DS4 è ancora l'unico modello residente e non
ha ancora effettuato la prima tool call. Il reasoning è però cresciuto in modo
continuo da circa 7 a oltre 20 KiB ed è passato dalla lettura del contratto alla
struttura concreta di hero, navigazione, programma e RSVP. Un controllo sui
12-, 18- e 22-grammi trova al massimo due occorrenze, riconducibili al prompt
dell'asset, quindi non prova un loop o uno stallo semantico.

Questo resta un punto negativo misurabile: il profilo Max senza cap può avere
una lunga latenza prima del primo risultato visibile anche quando l'inferenza è
corretta. Non viene modificato durante il benchmark, perché l'utente ha chiesto
esplicitamente Max e nessun limite; va tuttavia riportato nei tempi finali e
distinto dalla durata di Ideogram, Hunyuan e H3.

### Quinta interruzione giustificata: budget tipografico assoluto

Tra circa 28 e 36 KiB di reasoning, DS4 ha ricalcolato almeno cinque volte la
stessa tensione: il brief richiede titolo, sottotitolo e frammenti verticali
oversize, mentre la hard rule universale imponeva `<=3 above the fold`. Il
modello continuava a fondere, separare e riallineare i ruoli per rispettare il
conteggio, fino a rileggere testualmente la regola. Non era più soltanto Max
thinking lento: il contratto stava inducendo un loop decisionale e appiattiva
direzioni tipografiche esplicitamente richieste.

La run è stata interrotta prima di qualsiasi tool/media e il runner è stato
fermato. Nel core, sei taglie per file e tre sopra la piega restano il budget
predefinito di coerenza, ma non un limite assoluto: una direzione utente o di
brand può superarlo del minimo necessario, deve riusare coerentemente il nuovo
ruolo e verificarne gerarchia e collisioni nel rendering. È inoltre vietato
fondere ruoli tipografici distinti soltanto per soddisfare un conteggio. Il
self-test runtime e il contratto statico coprono la nuova formulazione.

Dopo il fix sono PASS `git diff --check`, JSON/sintassi, creativity gate,
build e self-test, controls, disclosure, interrupt, DS4/Qwen/Chrome e tutti i
16 benchmark strict. La quinta directory incompleta viene quindi spostata nel
Cestino e il benchmark può ripartire da uno stato pulito.

La sesta run è partita su HTTP 56813 con DS4 PID 22788, ancora
393.216/Max/cap 0 e SSD streaming effettivamente disabilitato. Qwen è risultato
pronto ma non residente. La nuova regola tipografica ha eliminato la precedente
riprogettazione ciclica: entro circa 20 KiB DS4 aveva scelto uno stack condensed,
un titolo verticale, il video a destra e un programma asimmetrico senza più
citare il vecchio limite.

### Sesta interruzione giustificata: loading finto nei form locali

Durante la progettazione dell'RSVP locale, DS4 ha rilevato che un salvataggio
sincrono in pagina non possiede una fase di caricamento reale, ma il core e il
lint obbligavano ogni `<form>` a mostrare tutti e cinque gli stati. Per passare
stava quindi valutando un `setTimeout` di 700 ms con «Recording…»: feedback
artificialmente rallentato, in conflitto diretto con la richiesta di feedback
veritiero.

La run è stata fermata prima dei media. Il contratto ora distingue vere
operazioni remote/asincrone e data console, che continuano a richiedere
loading/empty/error/populated/edge, dai form locali sincroni, che richiedono
empty/initial, validation error, success/populated ed edge senza inventare
spinner, skeleton, `aria-busy` o latenza. Il lint applica la stessa distinzione.
Nuovi fixture provano sia il PASS locale senza loading sia il P1 per un vero
`fetch()` che omette lo stato loading.

La prima esecuzione della suite ha trovato una sola asserzione statica ancora
legata alla frase rimossa; il self-test runtime e tutti i test precedenti erano
già verdi. L'asserzione è stata aggiornata alla distinzione remota/locale e la
seconda esecuzione è interamente PASS: creativity, build/self-test, controls,
disclosure, interrupt, DS4/Qwen/Chrome e 16 benchmark strict.

### Settima run pulita: primo media reale avviato

La settima run è partita su HTTP 61396 con DS4 PID 59498, contesto 393.216,
Max, cap 0 e SSD streaming effettivamente disabilitato. Il reasoning è iniziato
alle 02:27:11 e la prima tool call (`design_system("swiss")`) è arrivata alle
02:55:08: circa 28 minuti di reasoning, circa 32 includendo prefill e startup.
Non sono ricomparsi né il budget tipografico assoluto né il loading finto; DS4
ha scritto esplicitamente `No fake loading` per l'RSVP locale.

Dopo design system, accessibility/layout craft e todo, DS4 ha chiamato
`generate_image` senza sorgente. DS4 è stato evacuato prima del router. Qwen
`mlx-community/Qwen3.8-27B-8bit` revision
`815b83c0df8ffd1d1b5244cf75fd6ef14fca9ef9` ha scelto correttamente `generate`,
ha preservato aspetto 16:9 e tutti i vincoli della richiesta nella caption.
Provenance: reasoning Max, thinking attivo, budget nullo, contesto nativo
262.144 e durata 1.228,41 secondi (20m28s). `lsof` conferma `libmlx`,
`mlx.metallib` e il driver Apple AGX Metal: il `%CPU` osservato è lavoro host,
non un fallback dell'inferenza tensoriale.

Qwen è uscito prima dell'avvio di Ideogram. Ideogram 4 FP8 Quality-48 ha
caricato su MPS il text encoder completo (~10,1 GB) e il modello completo
(~8,85 GB), senza NaN/errori. I log confermano backend MPS, mixed precision e
kernel AppleSilicon-FP8; dopo il warm-up il sampling procede a circa 150–160
secondi per step. Questo tempo è registrato separatamente dalla caption Qwen.

Ideogram ha concluso tutti i 48 step in circa 2h05 di sampling e ha poi
decodificato un PNG RGB valido da 2048×1152, 3.227.033 byte. ComfyUI e il
runner Ideogram sono usciti prima del successivo caricamento di Qwen; nello
stesso momento DS4 era ancora evacuato a circa 7,5 MB RSS, quindi non vi era
sovrapposizione di modelli pesanti.

Il primo asset non è però conforme a un vincolo esplicito della caption:
contiene una grande scritta pseudo-testuale al centro nonostante `no text,
logo, watermark`. Questo è un difetto di corrispondenza alla richiesta, non un
quality gate estetico. La richiesta `see_image` passata a Qwen cita
esplicitamente il soggetto, il dettaglio rosso, il formato 16:9 e l'assenza di
testo/logo/watermark; la decisione resta quindi al controllo Qwen Max previsto
dal flusso. L'asset non viene accettato silenziosamente né giudicato fuori dal
contesto per preferenze estetiche.

Qwen ha effettivamente trascritto la scritta spuria e DS4 ha riconosciuto la
violazione del vincolo `no text` senza trasformarla in una valutazione
estetica. L'edit successivo usa il PNG come `source_path` e chiede di preservare
scultura, sala, luce e dettaglio rosso, rimuovendo testo/bloom e correggendo la
coerenza meccanica. Il router Qwen Max ha scelto `edit` in 80,329 secondi,
senza budget di thinking e senza scrivere una caption Ideogram.

Qwen è uscito prima dell'avvio dell'editor. HunyuanImage-3.0-Instruct è
partito con runtime nativo, reasoning `think_recaption` e qualità `full-50`;
lo stato iniziale dichiara il caricamento NF4 su Metal. DS4 resta evacuato e
Ideogram/ComfyUI non sono residenti.

Nota negativa di osservabilità: gli heartbeat della fase reasoning omettono il
campo `quality`, che quindi appare `null` pur non modificando la configurazione.
Il runner conferma `QUALITY_STEPS = 50`, assegna
`generation_config.diff_infer_steps = 50` e avvia reasoning e diffusione in
due processi seriali. Il difetto va corretto dopo la run, perché il secondo
processo rileggerà lo script e non è opportuno mutarlo durante l'inferenza.

La fase autoregressiva `think_recaption` ha superato un'ora prima dell'EOS.
Gli heartbeat continuano ad aggiornarsi, il tempo CPU cresce, MPS/AGX Metal è
caricato e la memoria disponibile è rimasta generalmente sopra il 60%, quindi
non vi è evidenza di deadlock o pressione RAM. Resta tuttavia una latenza molto
alta e va riportata come costo del reasoning Max senza cap, separata dai 50
step di diffusione che non sono ancora iniziati.

Il reasoning è terminato nativamente dopo 4.668,17 secondi. L'artefatto contiene
2.009 caratteri/323 parole, un solo blocco think/recaption e nessuna ripetizione
di n-grammi da 8, 12 o 18 parole. Il contenuto identifica correttamente testo,
bloom, cavi, pivot, contrappeso e dettaglio rosso, quindi la lentezza non era un
loop semantico. Prompt, sorgente e seed sono legati con SHA-256; il secondo
processo fresco ha validato il binding e ha avviato la diffusione full-50 a
1280×720 su MPS.

Seconda lacuna di osservabilità: nello status del processo di diffusione sono
omessi `reasoningSha256` e `nativeContext`, pur essendo presenti e validati
nell'artefatto di reasoning. Va corretta insieme alla persistenza del campo
`quality` dopo il completamento di questa run.

Hunyuan ha completato 50/50 step, decodifica e validazione senza NaN/errori.
Output: PNG RGB 1280×720, 1.325.935 byte. Provenance: profilo
`full-instruct-50`, 32 layer MoE eager nativi Tencent, nessun kernel MoE custom,
nessun token routed scartato, moduli critici BF16 e guardie finite superate. La
fase reasoning è durata 4.668,17 s; il processo fresco di diffusione/decodifica
4.533,51 s; l'intera pipeline immagine, incluso routing e transizioni seriali,
9.300,932 s. Qwen ha poi confermato la corrispondenza dell'edit: testo rimosso,
bloom assente, meccanica plausibile, dettaglio rosso e 16:9 preservati.

Solo dopo l'uscita di Qwen è partito MiniMax H3 dal frame finale. Configurazione
osservata: profilo `quality`, encoder ufficiale, 1344×768, 5 secondi, 20 step,
50 layer, seed registrato e first-frame locale; DS4 è evacuato a circa 7,3 MB
RSS e Ideogram/Qwen/Hunyuan sono spenti.

H3 ha impiegato circa dieci minuti per caricare il transformer core nativo; il
primo step di denoise ha richiesto 553,9 secondi (9m14s). A cadenza invariata i
19 step rimanenti valgono circa 2h55, oltre a VAE/encoding. È una latenza reale
del profilo qualità 1344×768/20-step/50-layer, non un blocco: status, tempo CPU
e driver Metal avanzano e la memoria disponibile resta sufficiente. Non viene
applicata alcuna riduzione di qualità.

Il secondo step ha richiesto 544,6 secondi (9m05s), confermando una cadenza
stabile di circa nove minuti per step. A 2/20 restano quindi circa 2h43 di
denoise, oltre a VAE/encoding; nessun errore o NaN è stato riportato.

Gli step dal terzo al nono hanno mantenuto lo stesso profilo, rispettivamente
circa 535,6, 554,2, 548,8, 536,3, 523,4, 537,8 e 541,9 secondi. A 9/20 lo
status dichiara ancora `quality`, 1344x768, 20 step e 50 layer, con media
stimata di 542 secondi/step e circa 5.958 secondi residui per il denoise.
Processo nativo, tempo CPU e heartbeat continuano ad avanzare; non compaiono
errori, NaN o sovrapposizioni con altri modelli pesanti. DS4 resta evacuato a
circa 8 MB RSS. Il primo benchmark creativo non viene contato come superato
finché video, pagina e gate composto desktop/mobile non sono conclusi.

Lo step 10 ha mantenuto la media a circa 542 secondi e porta il denoise a metà.
Durante l'attesa è stata identificata la causa generale di una parte delle
lacune di stato: dopo il successo, `src/dstudio_image.c` e
`src/dstudio_video.c` riscrivono il JSON terminale ricco prodotto dal worker
con un payload generico. Gli artefatti di provenance conservano provider,
qualità, dimensioni, hash e runtime, quindi non vi è perdita di evidenza né
regressione dell'inferenza; l'API di progresso perde però quei campi dopo il
completamento. Il fix deve preservare lo stato terminale validato del worker,
in modo generale per tutti i backend, e non aggiungere eccezioni per Hunyuan o
H3. Restano inoltre da rendere persistenti `quality` negli heartbeat Hunyuan e
hash/contesto nella seconda fase. La modifica verrà applicata dopo la run
attiva e coperta da test di stato live e terminale.

La parte endpoint è già corretta nel sorgente senza toccare il processo H3
attivo: immagine e video accettano il successo solo se il worker ha pubblicato
uno stato terminale `complete`, e non lo sovrascrivono. In caso di exit zero
senza quella prova falliscono chiusi. Il server di test ricompila senza warning
e `http_lan_test` passa con nuove asserzioni sui metadati terminali Ideogram,
Hunyuan e H3; tali asserzioni falliscono sul vecchio comportamento generico.

Due ulteriori difetti UI generali sono stati corretti durante il denoise, senza
modificare il worker attivo. Il messaggio di fase H3 non promette più sempre
audio stereo prima che `ffprobe` abbia stabilito se esiste una traccia audio;
descrive invece frame e MP4. Inoltre un errore del preflight visivo Qwen non
cade più sul normale assistente non visuale: conserva il retry esplicito della
prima lettura e, se Qwen fallisce ancora, pubblica un errore terminale senza
fallback. `ui_contract_test` e il test Playwright reale del flusso sono PASS;
quest'ultimo conta esplicitamente zero chiamate Chat dopo il fallimento Qwen.

H3 ha nel frattempo raggiunto 13/20 step. La media osservata è circa 559
secondi/step, con circa 3.911 secondi residui stimati per il denoise; nessun
errore, NaN o processo pesante concorrente è comparso.

Un ulteriore difetto UI generale è emerso confrontando i due poller: il video
inoltrava al placeholder anche uno status terminale `state: error`, mentre il
poller immagini lo scartava perché `ok` era falso. Di conseguenza l'errore del
worker poteva restare invisibile fino alla risposta POST. Il poller immagini
ora accetta esplicitamente `progress.ok || progress.state === 'error'` e
`ui_contract_test` contiene una regressione dedicata; il test è PASS.

Il primo processo H3 si è chiuso dopo lo step 13 e non ha prodotto un MP4; il
benchmark non lo conta quindi come superato. Non è intervenuto un timeout del
runner: la modalità real è unbounded e né `h3-run.py` né l'endpoint impongono
un limite di inferenza. I log di sistema mostrano però, dalle 10:34:23, una
raffica di terminazioni Jetsam per pressione memoria e la chiusura del processo
H3 poco dopo, alle 10:35:24. Questa è una correlazione forte ma non una prova
che Jetsam abbia selezionato direttamente H3, perché il vecchio server ha
sovrascritto il dettaglio terminale del worker con il messaggio generico
`MiniMax H3 generation failed`. DS4 ha reagito con un singolo retry identico,
senza fallback e senza abbassare qualità: nuovo job ancora a 1344x768,
Quality-20 e 50 layer. Il retry è in caricamento con tutti gli altri modelli
pesanti spenti; la memoria e gli eventi Jetsam restano sotto supervisione.

Il retry ancora in fase di caricamento è stato arrestato tramite l'endpoint
pubblico `/api/video/stop` prima di consumare un altro ciclo di denoise. Il
runner H3 ora applica una policy hardware generale: sotto 128 GiB imposta la
modalità h3.c `H3_ZERO_COPY_WEIGHTS=transformer`, salvo override esplicito.
Sul M2 Max da 96 GiB i circa 37 GiB di pesi transformer restano così mappati
dal checkpoint, file-backed e reclamabili/streamabili da SSD, anziché essere
copiati in memoria anonima. Step, 50 layer, reuse-1, risoluzione e aritmetica
non cambiano. `h3_checkout_test` e `py_compile` sono PASS; lo status espone
`weightResidency: transformer`. DS4 ha poi emesso il terzo tentativo tramite
il normale `generate_video`, preservando l'evacuazione seriale degli altri
modelli. La correzione non sarà dichiarata validata end-to-end finché la run
non avrà superato almeno lo step 13 del precedente fallimento.

Le lacune di osservabilità Hunyuan annotate sopra sono state corrette. Gli
heartbeat reasoning riportano ora `quality: full-50`; sampling e decoding
mantengono qualità, `nativeContext` e `reasoningSha256`; lo stato terminale
conserva gli stessi campi insieme al provider. I test nell'ambiente Ideogram/
Hunyuan reale riportano `image inference conformance: pass` e
`Hunyuan official native source conformance: OK`. Nessun modello immagine è
stato caricato durante questi test di contratto.

È stata eliminata anche la lacuna di osservabilità Ideogram: gli step
Quality-48 possono durare minuti, ma prima lo status cambiava solo al passaggio
di step e ometteva il profilo. Il runner usa ora un unico publisher per
encoding, sampling e decoding, con heartbeat ogni 30 secondi, `quality`,
dimensioni e tempo trascorso. Lo status di errore conserva anch'esso il profilo.
La regressione esercita sampling e VAE decoding senza caricare i pesi;
`image inference conformance`, il contratto Qwen/heavy-memory, `py_compile` e
`git diff --check` sono PASS. Il grafo corrente contiene una sola chiave nodo
`13` per il `VAELoader`; la duplicazione sospettata non è presente e quindi non
è stata aggiunta alcuna toppa inutile.

Il fallimento H3 ha inoltre rivelato un errore nel tool core DS4: a differenza
di `generate_image`, `generate_video` tentava di estrarre `id` anche quando il
server aveva restituito `{ok:false,error:...}`. Il risultato era il messaggio
fuorviante `JSON response is missing field id`, che nascondeva il vero errore
nativo e induceva DS4 a correggere parametri già validi. Il parser degli errori
è ora condiviso da entrambi i media tool e viene eseguito prima dei campi di
successo. Build senza warning, `ds4-design --self-test` e l'intero
`ds4_design_qwen_test` con media/layout mock sono PASS; il self-test verifica
esplicitamente che un errore Metal H3 sopravviva integralmente. Il parser
combina il messaggio sintetico `error` con l'eventuale campo `log`, perché
l'endpoint H3 conserva nel secondo il tail nativo (status di uscita, errore
Metal e fase); il dettaglio non viene quindi perso una seconda volta.

Il terzo tentativo H3 con pesi transformer file-backed ha completato il primo
step reale di denoise mantenendo Quality-20, 50 layer, reuse-1 e 1344x768. Una
misura `vmmap` durante il secondo step riporta circa 55,9 GiB di physical
footprint corrente e 36 GiB di checkpoint mappato da file; `memory_pressure`
riporta zero pagine throttled e 45% di memoria libera. Il disco leggeva circa
300 MB/s nello stesso campione. La policy evita quindi per ora la precedente
pressione distruttiva, ma introduce un costo di paging osservabile: il primo
step ha richiesto circa 529 secondi. Non si riducono step, layer, risoluzione o
reuse per accelerare. Il fix resta candidato e non viene contato come validato
finché non supera lo step 13 e produce un MP4 interamente decodificabile.

Lo status viene riscritto anche mentre il contatore resta sullo stesso step,
ma il payload non espone ancora un campo esplicito di heartbeat/elapsed e la
mappatura tratta ogni fase contenente `VAE` come decoding finale: il first-frame
VAE encoder può quindi far avanzare prematuramente la percentuale per poi farla
retrocedere al denoise. Dopo la run attiva il runner dovrà conservare l'ultima
fase, emettere heartbeat monotoni e distinguere encoding iniziale da decoding
finale, con regressioni dedicate.

Il job file-backed ha completato 2/20 step, ma il gate tecnico ha rilevato un
problema più forte della sola lentezza: Unified Logging registrava
`kIOGPUCommandBufferCallbackErrorImpactingInteractivity` circa ogni dieci
secondi per l'intera esecuzione, insieme alla terminazione Jetsam di numerosi
servizi di sistema inattivi. Il processo H3 non era ancora terminato e il suo
footprint restava pressoché stabile (56,9 GiB contro 55,9 GiB al passo
precedente), quindi non c'era evidenza di leak per-step; tuttavia non è
accettabile approvare un'inferenza che genera abort Metal ripetuti. Il job 27 è
stato fermato tramite `/api/video/stop` prima del terzo passo.

La causa è la combinazione tra checkpoint file-backed e lo scheduling h3.c
predefinito per GPU pre-M5: i primi 30 blocchi DiT vengono inseriti in un unico
command buffer che, con page fault SSD, resta attivo per minuti. h3.c espone già
`H3_DIT_COMMAND_BLOCKS` e documenta che lo split modifica soltanto i confini di
submission, preservando ordine delle operazioni e byte prodotti. Il manager ora
imposta un blocco DiT per command buffer quando la residency è file-backed,
salvo override esplicito; profilo, 20 step, 50 layer, reuse-1, risoluzione e
aritmetica restano invariati. Status e provenance espongono `commandBlocks`.

Sono state completate anche le correzioni di osservabilità H3: heartbeat reale
ogni 30 secondi con elapsed, percentuale monotona, distinzione tra VAE encoder
iniziale, caricamento decoder e decoding finale, riconoscimento dei cicli del
decoder. Il gate terminale non si limita più a `ffprobe`: esegue la decodifica
integrale di video e audio con `ffmpeg -xerror` e pubblica
`media.fullyDecoded=true` solo in caso di successo. `py_compile`,
`h3_checkout_test`, `video_open_weight_contract_test` e `git diff --check` sono
PASS.

Il benchmark attivo usava ancora il vecchio binario DS4, perciò dopo lo stop
riceveva `JSON response is missing field id` e stava procedendo con un fallback
statico privo dell'MP4 richiesto. La run sarebbe stata inevitabilmente non
conforme; è stata interrotta completamente e la RAM è tornata al 92% libera.
Si riparte puliti con il parser media corretto e il nuovo scheduling H3: questo
riavvio è dovuto a bug e non a una riduzione del quality gate.

### Ottava run pulita: validazione del nuovo scheduling H3

Prima del riavvio sono risultate PASS anche le suite complete del browser
(`ui_loading`, Agent/Design, gear, attachment, Roadmap e video), il contratto
UI, il contratto HTTP/LAN e la conformance reale delle sorgenti
Ideogram/Hunyuan. Un timeout intermittente del test Roadmap non si è
riprodotto né isolatamente né nella suite completa; non è stato quindi
classificato come bug di produzione. Il test conserva ora un diagnostico del
DOM e delle richieste modello, così un'eventuale ricorrenza sarà attribuibile
senza indebolire il gate.

La nuova esecuzione è partita nello stesso percorso
`tests/.artifacts/design-creative-real-all-v4/`; il harness ha eliminato solo
gli artefatti incompleti di quel benchmark. Startup verificato: contesto
393.216, Think Max, reasoning cap 0, SSD streaming richiesto `off`, profilo
`creative-full-stack`, immagini/video/visione reali. Al primo campione DS4 è
l'unico modello residente e la pressione memoria riporta il 94% disponibile;
Qwen, Ideogram, Hunyuan e H3 sono spenti. Il fix H3 non verrà contato come
chiuso finché una generazione reale non produrrà un MP4 completamente
decodificabile senza errori Metal nel log di sistema.

Nei primi dieci minuti del primo caso, il transcript è cresciuto da 4,4 a
17,8 KiB con frequenza massima `2/2/1` per n-grammi di 12/18/24 token: nessuna
evidenza di loop testuale. DS4 ha definito correttamente la pipeline seriale e
sta verificando quale condensed neo-grotesk locale soddisfi il brief senza
font remoti o fallback generici. La riflessione è semanticamente utile ma
molto costosa; un futuro tool read-only che esponga al modello l'inventario dei
font realmente disponibili potrebbe evitare congetture ripetute, senza
imporre un font né ridurre il reasoning Max.

Su richiesta dell'utente, il piano è stato ridotto durante questa esecuzione
da quattro benchmark a un solo caso: `fullstack-kinetic-museum`. Il caso già
attivo non viene scartato né rigenerato; al termine il runner sarà fermato
prima di inviare un secondo brief e report/README/desktop verranno costruiti
soltanto sul sito completato. GitHub Pages resta un deliverable finale già
richiesto.

A circa 45 minuti dall'avvio, DS4 è ancora nel reasoning pre-tool. Ha però
prodotto una specifica completa e crescente di HTML, CSS, stati RSVP,
responsive e media, senza errori runtime o modelli pesanti concorrenti. Il
costo maggiore del profilo Max illimitato è quindi ormai la latenza prima
della prima azione, non la generazione media. Non viene imposto un cap né
ridotta la qualità; questa misura va riportata separatamente nel README.

### Stop dell'ottava run: validatore JSON dipendente dall'ordine

Dopo circa 58 minuti DS4 ha iniziato correttamente la pipeline richiesta con
`generate_image`. La serializzazione della memoria ha funzionato: DS4 è stato
evacuato, Qwen3.8-27B Q8 Max è rimasto l'unico modello pesante attivo e Metal
MLX risultava effettivamente in uso. Qwen ha completato routing e captioning,
ma il worker ha terminato con `Ideogram caption has an invalid schema or key
order` prima di avviare Ideogram.

La causa era nel router DStudio, non nell'inferenza: confrontava
`tuple(caption)` con una sequenza fissa. In JSON l'ordine dei membri di un
oggetto non fa parte della semantica, quindi una caption con tutti e soli i
campi richiesti poteva essere respinta soltanto perché serializzata in ordine
diverso. La risposta grezza non veniva inoltre conservata, rendendo impossibile
distinguere a posteriori una permutazione valida da campi realmente errati.

Il router ora:

- confronta esattamente insiemi di chiavi, continuando a rifiutare campi
  mancanti, extra o duplicati;
- valida tipi, aspect ratio e struttura `background`/`elements`;
- canonizza l'ordine ufficiale anche negli elementi prima di passare la
  caption a Ideogram;
- conserva separatamente le risposte locali di routing e captioning nel job;
- usa una fixture di generazione completa, incluso `aspect_ratio`.

La nuova regressione copre permutazioni top-level e annidate, chiavi mancanti,
extra e duplicate, aspect ratio errato e persistenza atomica del diagnostico.
Sono PASS `image_route_qwen38_test`, il contratto Qwen/heavy-memory, tutti i
gate DS4/Qwen, la conformance Ideogram/Hunyuan, il contratto UI e HTTP/LAN.
L'ottava run è stata interrotta prima di una ripetizione costosa identica. Il
prossimo avvio seleziona esplicitamente soltanto
`fullstack-kinetic-museum`, come richiesto dall'utente.

### Nona run: unico benchmark reale

I vecchi artefatti `tests/.artifacts/design-*` sono stati spostati in modo
recuperabile nel Cestino, in
`DStudio-design-benchmarks-before-single-run-20260826`. Il nuovo risultato usa
la directory distinta `design-creative-real-one-v1` e seleziona esplicitamente
`DSTUDIO_DESIGN_CASES=fullstack-kinetic-museum`; il runner non potrà quindi
passare agli altri tre brief del profilo.

Un primo tentativo di startup è terminato prima del benchmark perché una
istanza FlashStudy occupava la porta 28000. È stato chiuso soltanto il relativo
processo `ds4-server`, lasciando l'app aperta; nessun modello del benchmark era
stato caricato e questo non viene contato come run di inferenza. Il riavvio
effettivo mostra contesto 393.216, Think Max, reasoning cap 0, SSD streaming
richiesto `off` ed effettivo `false` con motivazione DS4-only.

Il prefill e il primo reasoning DS4 hanno richiesto circa 58 minuti. Il
transcript è cresciuto in modo coerente, con frequenza massima `3/2/1` per
n-grammi di 12/18/24 parole; non c'è evidenza di loop. Prima dei tool DS4 ha
individuato autonomamente rischi di overflow del masthead, dead space, contrasto
focus e sovraccarico dell'accento, scegliendo quattro famiglie di layout invece
del precedente schema uniforme a card.

La prima pipeline immagine sta verificando la correzione del router:

- Qwen3.8-27B Q8 Max ha scelto `generate` e ha completato routing e caption in
  759,028 secondi, senza thinking budget e al contesto nativo 262.144;
- le risposte complete sono state preservate in
  `qwen-routing-response.txt` e `qwen-caption-response.txt`;
- la caption è stata accettata, canonizzata e consegnata a Ideogram: il bug
  dipendente dall'ordine non si è riprodotto;
- Qwen è uscito prima del caricamento Ideogram e DS4 è rimasto evacuato;
- Ideogram è partito a 2048×1152, Quality-48, MPS, senza fallback; i primi due
  step hanno richiesto circa 127 e 152 secondi. La stima iniziale della sola
  diffusione è circa 1 ora e 45 minuti e non giustifica una riduzione di
  qualità.

Ideogram ha poi completato tutti i 48 step e la decodifica senza NaN, fallback
o errori Metal. Il risultato `assets/kinetic-source.png` è un PNG RGB valido da
2048×1152 e 3.232.099 byte. Il controllo Qwen successivo ha confermato soggetto,
sala, illuminazione radente, ombre, formato e assenza di testo; ha inoltre
segnalato in modo strettamente fattuale due dettagli rossi invece dell'unico
richiesto. Non è stato eseguito alcun quality gate estetico sull'asset.

DS4 ha quindi richiesto l'edit previsto, usando esattamente il PNG sorgente e
chiedendo a Hunyuan di preservare inquadratura e contenuto, consolidare il rosso
sul solo contrappeso, rimuovere il bloom e rendere pivot/cavo/cuscinetto
meccanicamente plausibili. Qwen3.8 Max ha scelto `edit` in 84,766 secondi ed è
uscito prima del caricamento dell'editor. HunyuanImage-3.0-Instruct è ora
l'unico modello pesante attivo: fase `think_recaption`, qualità `full-50`,
contesto nativo 22.800, heartbeat ogni 30 secondi. A 19 minuti il transcript non
era ancora concluso, ma CPU e heartbeat avanzavano e non vi era evidenza di
stallo o sovrapposizione con Ideogram/Qwen/H3.

Durante l'attesa è emersa un'incoerenza documentale generale: runtime, UI e
README usano correttamente `think-tokens=0` come default raccomandato, mentre
`docs/QUALITY_GATES.md` e il vecchio disclosure fixture Lumen dichiaravano
ancora un cap obbligatorio di 16.384 token. Entrambi ora descrivono Max
EOS/context-bound senza cap applicativo e distinguono i cap 8k/16k/24k come
sola scelta esplicita dell'utente. `ui_contract_test` impedisce la ricomparsa
della vecchia contraddizione ed è PASS insieme a `git diff --check`; il worker
Hunyuan attivo non è stato modificato.

Nello stesso contratto era rimasto anche un conteggio obsoleto di «tre» worker
one-shot, pur elencando Qwen, Ideogram, Hunyuan e H3. La documentazione ora
dichiara esplicitamente quattro processi modello serializzati e la stessa
regressione ne verifica sia la forma corretta sia l'assenza della vecchia frase.

Il reasoning Hunyuan della nona run è terminato nativamente dopo **2.781,125
secondi**. L'artefatto schema v4 contiene 2.024 caratteri/316 parole, delimitatori
completi, `maxNewTokens: null`, contesto 22.800 e runtime MPS nativo senza
monkeypatch o kernel attention/MoE custom. L'hash SHA-256 ricalcolato sul
transcript coincide con quello registrato; la massima ripetizione degli
8/12/18-grammi è 1, quindi non vi è loop testuale. Prompt, PNG sorgente e seed
sono legati da hash. Solo dopo questa validazione il primo processo è uscito e
un processo fresco ha caricato lo stesso artefatto per la diffusione 1280×720,
`full-50`. Il primo step, comprensivo del caricamento iniziale, ha richiesto
circa 236 secondi; gli step 2 e 3 hanno richiesto circa 95 e 106 secondi. A
3/50 la cadenza utile è quindi circa 100 secondi per step, con proiezione di
circa 79 minuti per il denoise residuo oltre alla decodifica. Non compaiono
errori Metal o NaN; le pagine throttled restano zero. Alcuni processi Java
esterni al benchmark producono pressione/swap intermittente, ma non vengono
terminati perché fuori scope e non si sovrappongono come modelli DStudio.

A 10/50, i nove intervalli successivi al primo step hanno una media di circa
92,7 secondi; la nuova proiezione è circa 62 minuti per i 40 step residui.
Qualità `full-50`, contesto e hash restano presenti in ogni status. La memoria
libera oscilla ma torna sopra il 50% e non sono comparsi throttling, NaN o
errori Metal.

A 20/50 la cadenza resta nello stesso intervallo, circa 91–93 secondi per
step; la proiezione residua è circa 46 minuti più decodifica. Nessun retry,
cambio di risoluzione o abbassamento degli step è intervenuto.

Hunyuan ha raggiunto 25/50, metà del denoise, con memoria libera al 57% nel
checkpoint e ultimo step da circa 85 secondi. Restano circa 38 minuti alla
cadenza osservata, più decodifica.

Tra gli step 27 e 30 la cadenza è migliorata a circa 81–86 secondi; a 30/50 la
memoria libera è 66% e la proiezione dei 20 step residui è circa 27–31 minuti,
più decodifica. Il profilo non è cambiato.

A 40/50 gli ultimi step restano circa 80–92 secondi, la memoria libera è 61%
e la proiezione residua è circa 14–15 minuti più decodifica. Lo status continua
a essere monotono e conserva `full-50`, contesto e hash.

Hunyuan ha completato 50/50 step, decodifica e validazione terminale. Output:
PNG RGB 1280×720, circa 1,3 MiB, hash
`868b1ed411bb82060a112ad718f35c2a9561c6bb7b50361f212f27deca4f5f97`,
identico tra job e `assets/kinetic-final.png`. La provenance conferma 32 layer
MoE eager Tencent, nessun kernel custom, nessun routed token scartato, moduli
critici BF16 e guardie di finitezza. Reasoning: 2.781,125 s; secondo processo
full-50/decoder: 4.782,788 s; pipeline completa incluso router e transizioni:
7.658,222 s (**2 h 07 min 38 s**). Solo dopo l'uscita di Hunyuan è partito
Qwen3.8 per il secondo e ultimo controllo di corrispondenza.
## Nona run — correzione del loop di corrispondenza pre-layout

Il secondo controllo Qwen dell'asset Hunyuan ha confermato sala, scultura,
meccanica del contrappeso, unico dettaglio rosso, formato e assenza di testo,
ma ha rilevato che il piccolo starburst della lampada era ancora presente.
DS4 ha interpretato questa singola mancata corrispondenza come autorizzazione
per una terza `generate_image`, benché il flusso concordato richieda di
accettare provvisoriamente gli asset tecnicamente validi e spostare il gate
severo sul layout composto. La chiamata è stata interrotta dopo cinque secondi,
prima della diffusione; nessun asset valido è stato sovrascritto.

La causa è generale nel contratto core: vietava la rigenerazione «per gusto»,
ma non dichiarava esplicitamente non bloccante una mancata corrispondenza
fattuale. Ora sia il prompt di sistema sia il risultato di `see_image`
stabiliscono che un decode riuscito produce una sola osservazione informativa:
la discrepanza viene registrata, l'asset tecnicamente valido viene collocato
provvisoriamente e non nasce un loop generate/inspect prima della composizione.
Solo una revisione esplicita dell'utente o un difetto che danneggia il layout
finale può riaprire la generazione media. Una regressione core verifica entrambe
le istruzioni; non è stata aggiunta una toppa specifica per PHASE / SHIFT.

La regressione `test-design-qwen` è PASS, inclusi self-test core, interrupt,
probe layout, disclosure, corrispondenza Qwen e il nuovo checkpoint resume. La
ripresa accetta solo un manifest `ds4.design.resume.v1` destinato all'unico caso
selezionato, tronca la trascrizione su uno specifico `tool_result` numerato,
rifiuta path fuori workspace e verifica dimensione e SHA-256 di ogni asset
preservato. Il checkpoint effettivo termina al secondo `see_image`; conserva
20.454.000 ms di tempo e i PNG con hash
`d8769e6f138f41c3fcafb0f29437be9c7c5aec2d4be772cf3c4b18121bd69484`
e `868b1ed411bb82060a112ad718f35c2a9561c6bb7b50361f212f27deca4f5f97`.
La continuazione è stata avviata con contesto 393.216, Think Max, reasoning cap
0 e SSD streaming effettivamente spento; il prossimo tool pesante ammesso è
soltanto MiniMax H3.

Dopo oltre quindici minuti il turno di continuazione non ha ancora emesso H3,
pur avendo identificato correttamente quel tool come prossima azione. Sta
anticipando font, hero, programma, artisti, accessibilità e stati RSVP. Il
reasoning è semanticamente crescente e il controllo anti-loop misura massimi
`3/2/1` sui n-grammi da 12/18/24 parole, quindi non è inceppato; resta però una
latenza pre-tool evitabile. Non viene applicato alcun cap, coerentemente con la
richiesta Max illimitata. Un miglioramento futuro può rendere più vincolante la
decision discipline quando il prossimo tool seriale è già determinato, senza
ridurre profondità o qualità del ragionamento successivo sul layout.

### Nona run — errore Metal H3 rilevato e correzione core

La continuazione ha infine invocato MiniMax H3 una sola volta con il PNG
Hunyuan verificato come first frame, profilo `quality`, 1344×768, 20 denoise
step, 50 blocchi transformer e reuse 1. Il passaggio seriale della memoria ha
funzionato: DS4 è stato evacuato, nessun altro modello pesante era attivo e la
memoria libera era circa il 90%. Tuttavia il manager selezionava
`H3_ZERO_COPY_WEIGHTS=transformer` e `H3_DIT_COMMAND_BLOCKS=1` perché il Mac ha
meno di 128 GiB. Sul Mac effettivo — M2 Max, 38 core GPU, 96 GiB — questa scelta
era contraria alla policy nativa h3.c: su hardware pre-M5 i buffer copiati sono
il percorso più rapido, mentre il mapping è destinato alle configurazioni che
non riescono a mantenere residente la fase transformer.

Unified Logging ha registrato per il PID H3 121 abort Metal osservati tra le
19:48:28 e le 20:02:16, con
`kIOGPUCommandBufferCallbackErrorImpactingInteractivity` ogni circa 6–8
secondi. Il processo nativo avanzava comunque fino a pubblicare 1/20 perché gli
errori dei command buffer figli MPSGraph non venivano propagati in modo
affidabile allo stato del root buffer. Accettare quel risultato avrebbe quindi
violato il gate di correttezza anche se il file finale fosse risultato
decodificabile. Il job è stato cancellato, poi il turno DS4 è stato interrotto
prima di qualsiasi retry; non esiste un MP4 approvato e i PNG non sono cambiati.

La correzione è generale e non modifica il benchmark né la qualità:

- la residency viene ora dimensionata sulla maggiore fase simultaneamente
  viva, il transformer Ref2VA da 66.280.524.863 byte, più 24 GiB di margine per
  Metal, macOS e handoff; 96 GiB selezionano quindi la policy nativa residente,
  mentre le macchine sotto soglia mantengono il mapping byte-identico;
- il forcing a un blocco per command buffer resta associato esclusivamente al
  percorso file-backed;
- ogni inferenza reale H3 avvia un monitor Unified Log legato al PID; qualunque
  errore command-buffer Metal ferma subito il processo e rende la run non
  approvabile, e anche l'uscita prematura del monitor fallisce in modo chiuso;
- la provenance di un MP4 accettato deve dichiarare il monitor macOS e zero
  errori command-buffer.

`h3_checkout_test`, `video_open_weight_contract_test`, la compilazione Python
e `git diff --check` verificano soglia, override espliciti, mapping sulle
macchine piccole, selezione `native-default` a 96 GiB, firma dell'errore Metal
e presenza del gate in provenance. Un probe reale ha inoltre confermato che
`log stream` resta agganciato al PID sorvegliato. Il probe ha anche rivelato
che il banner iniziale di `log stream` ripete letteralmente il predicato e
quindi le firme ricercate: il parser ora ignora ogni riga non NDJSON e valuta
soltanto `eventMessage`/`composedMessage` dei record reali, con una regressione
che impedisce il falso positivo. La prossima continuazione usa
lo stesso transcript troncato al secondo `see_image`: il fallimento H3 non
entra nel prefisso e nessuna immagine viene rigenerata.

## Nona run — patch H3 versionata e isolamento del watchdog SDPA

L'audit richiesto sul motore H3 ha confrontato il vecchio checkout gestito
`03cb1339825feb19bcafcc60685680cb9ec6e2fe` con il remoto reale. I due commit
successivi dell'upstream sono dedicati allo streaming SSD e non contengono una
correzione del watchdog Metal osservato sul M2 Max. La patch DStudio è stata
quindi ribasata in un worktree temporaneo sull'attuale `origin/HEAD`,
`8974cc055ea9c02fcd14cc27dfda3e1027c05153`, e DStudio ora fissa esattamente
quel commit. La combinazione upstream più patch compila con tutte le warning
flag native e mantiene la CLI attesa dal worker.

Una nuova interrogazione diretta di `origin` durante il retry conferma che
`refs/heads/main` e `HEAD` sono ancora entrambi
`8974cc055ea9c02fcd14cc27dfda3e1027c05153`: non esiste quindi un delta remoto
più recente da incorporare. Il checkout installato sullo stesso commit resta
pulito mentre l'inferenza è attiva.

Ogni delta H3 è stato rimosso dal checkout installato e consolidato nella
patch versionata
`patch/h3-metal-watchdog/stage-command-submits.patch`, SHA-256
`5845dce1d8b4fb02bb55c4006b686e97a6fb738aed61cb7a35e67093507d6600`.
La patch modifica soltanto `h3_dit.c` e `h3_gpu.m`: aggiunge submit
arithmetic-preserving fra gli stadi DiT e suddivide la self-attention non
causale per righe query indipendenti; ogni chunk continua a leggere l'intera
sequenza key/value invariata.

Il launcher applica la patch soltanto come input transitorio della build e usa
un blocco `finally` per ripristinare i sorgenti upstream anche quando la build
fallisce. Una patch già applicata è riconosciuta in modo idempotente; un delta
sconosciuto in uno qualsiasi dei due file viene rifiutato sia in apply sia in
restore. È stato scoperto e corretto un bug nello script iniziale, che
proteggeva `h3_dit.c` ma non `h3_gpu.m`. Il checkout gestito è ora pulito dopo
setup e inferenza, mentre il marker del binario lega commit e hash della patch.

Evidenze di validazione:

- il diff applicato ha SHA-256 identico al file `.patch`;
- seconda applicazione idempotente e ripristino byte-per-byte pulito;
- build `clang` completa con tutte le warning flag upstream;
- un delta artificiale confinato a `h3_gpu.m` è stato preservato e rifiutato
  con exit 1, senza sovrascrittura;
- `video_open_weight_contract_test`, `h3_checkout_test`, `py_compile`, sintassi
  shell e `git diff --check` sono PASS.

La prima prova reale con chunk da 2.048 query ha riprodotto il watchdog dentro
il primo SDPA DiT da 39.859 righe: errore
`kIOGPUCommandBufferCallbackErrorImpactingInteractivity` prima dello stadio
attention-output, picco circa 40,7 GiB. Il valore era quindi ancora troppo
grande e non è stato promosso.

La seconda prova reale, identica salvo chunk da 512 query, ha completato un
intero layer DiT: input, QKV, tutti i 78 chunk attention, projection,
MLP-conditioning, MLP e residual; ha poi iniziato il layer seguente senza
alcun errore Metal. Una calibrazione da 1.024 query ha completato a sua volta
un layer intero e iniziato il successivo, riducendo il tempo osservato da circa
90 a circa 30 secondi per layer. Quella verifica era però insufficiente: nella
successiva generazione reale Quality, 1.024 ha superato più layer ma ha poi
prodotto `kIOGPUCommandBufferCallbackErrorImpactingInteractivity` durante il
primo step di denoise, dopo circa 264 secondi. Il benchmark è stato interrotto
prima che DS4 potesse riprovare e il risultato non è stato accettato.

La nuova regola di validazione è quindi un intero step con tutti i 50 layer,
non un solo layer isolato. Anche 256 query è stato bocciato: quattro layer
completi, errore entrando nel quinto, dopo 234,666 secondi GPU cumulativi. Il
tempo simile al fallimento da 1.024 indica che ridurre soltanto il numero di
query non accorcia la key dimension da 39.834 elementi elaborata da ogni
MPSGraph SDPA. Un secondo probe con 256 query e 50.000 µs di CPU yield dopo
ogni command buffer ha completato cinque layer ma è fallito nel sesto, a
277,843 secondi GPU. Il pacing non è quindi stabile ed è stato rimosso dalla
patch invece di lasciare codice morto o un workaround AGX non documentato.

Il candidato con query chunk 8 senza yield ha superato il gate completo: tutti
i 50 layer del primo step DiT a 1344×768 sono terminati, è stato emesso
`denoise 1/2` e il monitor unificato ha registrato zero errori GPU/Metal. Il
processo è stato interrotto intenzionalmente appena iniziato il secondo step,
perché la CLI impone almeno due step mentre il probe doveva validare esattamente
una profondità completa. Ogni chunk ha mantenuto l'intera sequenza K/V; il test
numerico dedicato ha inoltre confrontato il percorso non chunked con chunk
1/2/7/8/22 ottenendo zero mismatch BF16. Il default Quality viene quindi
promosso a 8 senza yield, variabili AGX non documentate o SSD streaming. Pesi,
20 step finali, 50 layer, reuse 1, risoluzione 1344×768, seed e first frame
restano invariati. Il checkout H3 installato è pulito: le sole modifiche native
restano nella patch versionata applicata transitoriamente in build. Le evidenze
della prova riuscita sono in
`tests/.artifacts/h3-metal-diagnostic-query-chunk-8-full-step-20260826`; le
evidenze delle calibrazioni precedenti restano in
`tests/.artifacts/h3-metal-diagnostic-query-chunk-20260826-6` e
`tests/.artifacts/h3-metal-diagnostic-query-chunk-20260826-7` e
`tests/.artifacts/h3-metal-diagnostic-query-chunk-20260826-8`; l'errore
multi-layer è conservato in
`~/.dstudio/minimax-h3/jobs/design-video-21933-54/h3-failure.json`, mentre il
probe da 256 è in
`tests/.artifacts/h3-metal-diagnostic-query-chunk-256-full-step-20260826`; il
probe con yield fallito è in
`tests/.artifacts/h3-metal-diagnostic-query-chunk-256-yield-50000-full-step-20260826`.

### Continuazione dopo la validazione H3 — latenza pre-tool

Il checkpoint è stato avanzato in modo verificato fino al terzo `todo_write`,
immediatamente precedente alla vecchia chiamata H3 fallita. Conserva quindi il
design system, i craft, i due PNG validati, la lista asset e il piano con H3
già `in_progress`, ma esclude completamente chiamata, risultato e diagnostica
del video fallito. La continuazione reale parte con 393.216 token, Think Max,
cap 0 e SSD streaming spento.

È emersa una nuova inefficienza generale: nonostante il prossimo tool sia già
determinato dal checkpoint e dal prompt, DS4 ha superato un'ora di reasoning
prima di emetterlo, ricostruendo in anticipo markup, responsive, copy, contrasto
e interazioni. Il contenuto resta utile — il controllo sul solo suffisso nuovo
misura massimi 2/2/1 per n-grammi da 12/18/24 parole e ha individuato anche un
overflow P0 prima della scrittura — quindi non è un loop e la run non viene
interrotta. Resta però un candidato concreto per una futura disciplina core di
action ordering: quando un tool seriale obbligatorio è già in corso, eseguirlo
prima e rinviare il reasoning indipendente alla fase successiva, senza ridurre
Think Max né introdurre un cap.

### Run reale H3 — costo e telemetria

La generazione reale del benchmark `fullstack-kinetic-museum` usa il profilo
Quality completo: 1344×768, 5 secondi, 20 step, 50 layer, reuse 1, first frame
Hunyuan e query chunk 8. Il primo step completo ha richiesto circa 1 ora e 24
minuti. Se il costo resta lineare, il solo denoise H3 richiede circa 27–28 ore;
questo è il prezzo osservato del percorso Metal che supera il watchdog senza
ridurre risoluzione, profondità, step o qualità. In quel momento la run non era
stata riavviata; l'interruzione successiva e il retry sono documentati sotto.

La supervisione ha inoltre trovato un difetto soltanto nella telemetria: h3.c
scrive ogni aggiornamento CLI con un carriage return iniziale ma senza
delimitatore finale, mentre il worker pubblicava soltanto i frammenti già
delimitati. `status.json` risultava quindi indietro di uno step anche se il log
nativo e l'inferenza erano corretti. Un parser di stream core ora accetta anche
il frammento corrente dopo 100 ms di quiete, evita duplicati e forza l'ultimo
aggiornamento all'uscita. Il ritardo breve protegge dalle letture pipe spezzate
a metà numero. Il test riproduce un record con solo `\r`, una lettura spezzata
fra `1/2` e `0`, la successiva delimitazione dello stesso record e il flush a
EOF. Un secondo test end-to-end avvia un processo nativo fittizio che scrive
`denoise 1/20` senza newline e resta vivo: `status.json` deve riportare 1/20
prima dell'EOF, condizione impossibile col vecchio parser. `h3_checkout_test`,
`video_open_weight_contract_test`, `py_compile`, tutti i contratti DS4/Qwen
(fixture), i 16 benchmark contract, i test UI/browser e HTTP sono PASS. Il
primo processo già attivo conservava il vecchio parser in memoria, perciò per
quel tentativo il log nativo era la fonte autorevole. Il retry successivo usa
invece il parser corretto e pubblica anche il frammento corrente senza newline.

Un controllo AGX durante il secondo step ha misurato `Device Utilization 98%`,
renderer/tiler all'80% e `recoveryCount 0`; il sistema riportava inoltre il 64%
di memoria libera. Il lungo intervallo senza nuove righe nel log è quindi
calcolo GPU attivo, non un processo inceppato o pressione RAM.

L'audit della durata ha verificato che runner unbounded e trasporto `curl` non
impongono deadline alla chiamata H3. Il `SO_SNDTIMEO` server da 24 ore limita
soltanto una singola `send()` bloccata e non è una scadenza assoluta della
connessione. È emerso invece un rischio reale: il worker non possedeva una sua
asserzione macOS contro lo sleep e dipendeva incidentalmente da display o
audio. La run attiva è stata immediatamente legata al proprio PID tramite
`caffeinate -i -w 93255`; `pmset` conferma
`PreventUserIdleSystemSleep` creato per quel processo.

Il core ora avvia e possiede la stessa asserzione per ogni futuro processo H3,
la termina con il figlio, la include in status e provenance e fallisce chiuso
se non può acquisirla o se termina prematuramente. Il test positivo verifica
che l'asserzione sia presente durante il progresso senza newline e sia sparita
dopo l'uscita. Il test negativo fa terminare deliberatamente l'asserzione:
l'inferenza fittizia viene fermata, il risultato rifiutato e
`h3-failure.json` registra `kind: power-assertion`. Entrambi i percorsi, il
contratto video, `py_compile` e `git diff --check` sono PASS; nessun modello o
GPU viene caricato da questi test.

### Interruzione cross-server e retry automatico H3

Durante una verifica separata del marker installato, l'arresto di un secondo
server DStudio ha eseguito il teardown globale presente nel vecchio binario e
ha terminato anche il worker H3 appartenente al benchmark. Il primo job reale,
`design-video-71906-66`, aveva completato `denoise 1/20` e stava calcolando lo
step successivo da circa due ore; il log non contiene errori Metal. Non è
quindi un fallimento d'inferenza né una bocciatura estetica: è un bug di
ownership del coordinatore scoperto dalla verifica stessa. Stato, log, prompt,
first frame e hash sono conservati in
`tests/.artifacts/design-creative-real-one-v1/diagnostics/h3-job-66-cross-server-interrupt`.

Il core ora crea un token per istanza prima dell'apertura del listener, lo
eredita nei request worker e reclama ogni directory job con creazione atomica
esclusiva (`O_EXCL` su POSIX, `CREATE_NEW` su Windows). Il teardown considera
soltanto le directory il cui `server-owner` coincide esattamente con il token
dell'istanza. Il test HTTP avvia due server sullo stesso H3 home, verifica che
job distinti abbiano owner distinti, invia contemporaneamente lo stesso job ID
ai due server ottenendo esattamente un `200` e un `409`, quindi prova che
anche due richieste `/api/video/stop` incrociate ricevano `409` senza terminare
il worker estraneo; infine prova che spegnere ciascun server termini il proprio
worker fittizio e lasci vivo quello dell'altro. Build con warning flag,
contratto video, test HTTP e `git diff --check` sono PASS.

Il claim non è idempotente: un owner già presente produce sempre `409`, anche
quando appartiene alla stessa istanza. Questo impedisce che due richieste con
lo stesso job ID condividano prompt, status e output directory o accodino due
worker sul medesimo asset. La regressione ripete deliberatamente un job ID sullo
stesso server e verifica il rifiuto senza sovrascrittura.

Lo status C di coordinamento aveva inoltre un'incoerenza riprodotta
dall'incidente: serializzava sempre `ok:true`, anche insieme a `state:error` o
allo stage `cancelled`. Ora `error` e `cancelled` sono terminalmente
`ok:false`. Il test avvia un worker posseduto, rifiuta prima gli stop
cross-server, accetta poi lo stop dall'owner, verifica il payload
`false/error/cancelled` e infine ri-arma separatamente il fixture usato per il
teardown. Il consumer UI continua a mostrare esplicitamente gli errori tramite
`state:error`, quindi la correzione rende il contratto coerente senza nascondere
il messaggio.

DS4 ha ricevuto l'errore del primo job e ha richiamato H3 senza riavviare il
benchmark. Il retry `design-video-71906-72` mantiene Quality 1344×768, 5
secondi, 20 step, 50 layer, reuse 1, query chunk 8 e lo stesso first frame; usa
il parser nuovo e possiede una `caffeinate -i -w` verificata da `pmset`. Durante
questa inferenza non vengono avviati né arrestati altri server sul runtime H3
condiviso. Questo secondo tentativo è ammesso dalla policy della run perché
segue esclusivamente un bug riprodotto e corretto, non un quality gate sugli
asset.

Il transcript registra due chiamate `generate_video`: la prima interrotta dal
bug e il retry in corso. Il gate richiede almeno una chiamata H3 ma accetta
retry motivati da bug; richiede invece esattamente due sole revisioni Qwen
(source ed edit) e una prova H3 terminale riuscita. Sul transcript live i
conteggi sono `generate_image=2`, `see_image=2`, `generate_video=2` e il
prefisso seriale obbligatorio occupa le posizioni `5,6,7,8,13`, quindi il retry
non retrocede né aggira il contratto di qualità.

### Lifecycle di interruzione media — correzione completa

L'audit successivo all'incidente ha trovato altre due varianti dello stesso
difetto generale. Prima, un'interruzione DS4 chiudeva il trasporto `curl` ma
non garantiva l'arresto del job media già accettato. Seconda, il percorso Chat
diretto possedeva già `/api/video/stop`, ma per le immagini abortiva soltanto
la `fetch`: Ideogram o Hunyuan potevano quindi continuare senza più un
consumer. Non erano difetti dell'inferenza dei modelli, ma del lifecycle del
coordinatore.

DS4 assegna ora un ID non ambiguo prima di ogni POST immagine/video e, quando
il turno viene interrotto, invia una richiesta di cleanup indipendente dal
segnale già cancellato allo stop endpoint corrispondente. Il limite breve del
solo `curl` di cleanup non introduce alcun cap sull'inferenza: le POST di
Qwen, Ideogram, Hunyuan e H3 restano senza deadline applicativa. La UI usa la
stessa regola tramite una routine media comune con allowlist `image|video` e
arresta l'ID esatto anche se la connessione cade prima di ricevere il risultato
terminale, non soltanto quando viene premuto Stop.

Entrambi i coordinatori persistono `cancel-requested` prima di cercare
`worker.pid`. Questo chiude la race precedente all'avvio del worker: se il PID
non esiste ancora, il marker viene osservato dal runner prima del caricamento
dei pesi; se il PID compare nel frattempo, lo stop lo termina. Il runner
immagini scrive il proprio PID prima del primo controllo, avvia ogni processo
modello in un nuovo process group e termina l'intero gruppo, impedendo che un
figlio Ideogram/Hunyuan resti orfano. Ownership, duplicati e shutdown sono ora
simmetrici per immagini e H3: ogni server può cancellare esclusivamente i job
che possiede.

Le regressioni DS4 verificano interrupt, singolo stop sull'ID esatto, assenza
di PNG/MP4 parziali, ritorno a `WAITING` e ripresa del turno. Il test browser
interrompe realmente il primo frame Ideogram della pipeline immagine→H3,
controlla che H3 non parta, che non appaia una card video parziale e che Chat
riprenda. Il fixture browser è stato isolato in una chat nuova: la prima
versione riutilizzava deliberatamente la cronologia con immagini e attivava
correttamente il preflight Qwen, rendendo il caso di cancellazione non
deterministico. I test HTTP a due server coprono inoltre stop incrociati,
cancellazione in coda, stati terminali e teardown selettivo per entrambi i
tipi media.

Al 27 agosto 2026 `make check-fast` è completamente PASS: build con
`-Wall -Wextra`, DS4 self/control/disclosure, interrupt base/immagine/video,
resume checkpoint, 16 benchmark contract, Qwen3.8 routing, process-group
immagini, conformance Ideogram/Hunyuan, tutti i browser UI, H3 checkout e
contratto open-weight, HTTP LAN multi-server e controlli sintattici. La suite
non carica altri modelli pesanti e non ha disturbato il job H3 reale. Il
checkout upstream `h3.c` resta pulito; il comportamento nativo continua a
provenire soltanto dalla patch versionata applicata transitoriamente.

### Release gate guidato dal benchmark

Il gate di pubblicazione storico era specifico per LUMEN: nomi file, copy e
asset erano codificati per l'osservatorio, quindi non poteva certificare il
nuovo unico benchmark PHASE / SHIFT. Il nuovo
`tests/design_site_release_gate.mjs` legge invece il caso full-stack dal
catalogo autorevole `extension/design/bench/cases.json` e valida la directory
che verrà realmente pubblicata. Non contiene eccezioni estetiche per il museo
cinetico e resta riutilizzabile per qualunque caso full-stack catalogato.

Il gate richiede `index.html`, documentazione, `.nojekyll`, PNG sorgente/edit e
MP4 previsti dal caso; verifica limite GitHub, hash, copy esatta, provenance dei
quattro modelli, hardware, tempo misurato, contesto 393.216, Max senza cap, SSD
streaming off e URL Pages. Per i media esegue decode PNG, `ffprobe` e decode
completo di tutti i frame H.264 con `ffmpeg`, non soltanto controllo del
contenitore. In browser serve la copia locale e verifica desktop 1280 e mobile
390, overflow, dipendenze, console, target da 44 px, skip/focus, form locale,
reduced motion e ogni pulsante visibile tramite il probe di interazione; salva
screenshot e report JSON fuori dalla directory pubblicabile.

Il probe condiviso ha inoltre corretto un proprio falso negativo: prima
cliccava i submit lasciando vuoti i campi `required`, così la validazione HTML
impediva legittimamente l'evento e il pulsante veniva classificato come
inerte. Ora inserisce valori validi e genera `input/change` prima del click,
continuando a fallire se il submit non produce alcun cambiamento DOM. La
regressione positiva crea un release fixture completo; quella negativa
inserisce una dipendenza remota e prova il rifiuto. `test-design-controls` e
`test-design-release` sono PASS e il nuovo gate fa parte di `check-fast`.

L'handoff usa inoltre `scripts/package-design-release.mjs`, anch'esso guidato
dal caso e non dal copy PHASE / SHIFT. Prima di creare qualsiasi directory
richiede un unico caso selezionato, `passRate=1`, tool compliance 100%, zero
safety failure, Think Max unbounded, contesto 393.216, cap 0, SSD off e modalità
reali Qwen/H3; confronta anche il quality JSON e il transcript per provare i
risultati Ideogram Quality-48, Hunyuan Instruct e H3 Quality. Se la destinazione
esiste rifiuta l'overwrite. Copia prima in uno staging dedicato, genera README,
provenance, hash ed evidenze, quindi rinomina atomicamente lo staging soltanto
dopo tutti i controlli. La regressione prova pacchetto positivo, rifiuto di un
vecchio FAIL e rifiuto di overwrite; nessun output parziale rimane nei casi
negativi.

L'audit requisito-per-requisito successivo ha chiuso due lacune nel pacchetto
di prova. Il packager ora rifiuta hardware incompleto invece di pubblicare
valori `unknown`, e richiede coerenza tra profilo full-stack, image/video/vision
mode reali, GGUF DeepSeek V4, launch context/Max/cap/SSD e summary. Sul trace
media prova i risultati, non solo i nomi delle call: esattamente due immagini,
due risultati Qwen e l'ordine seriale Ideogram→Qwen→Hunyuan→Qwen→H3. Deve
esistere un solo H3 riuscito; è ammesso al massimo un secondo tentativo e il
risultato aggiuntivo deve essere un errore esplicito, così un retry per bug non
viene confuso con una rigenerazione estetica.

Il packager risolve inoltre commit engine, revisione modello e SHA H3 dalle
costanti runtime, ricalcola lo SHA-256 dei byte della patch versionata e fallisce
se differiscono. Questi dati, l'hardware, la configurazione Max e il trace
seriale vengono salvati in `evidence/inference-provenance.json`, incluso negli
hash di `RELEASE_MANIFEST.json` e collegato dal README. Il release gate rilegge
semanticamente il sidecar, lo confronta di nuovo con sorgente e patch locali e
richiede che README/MEDIA_AND_MODELS riportino commit, revisione e SHA esatti.
Le regressioni positive/negative coprono ora anche hardware assente e una
seconda generazione H3 riuscita; `make test-design-release` è PASS.

Il runner Node reale era già residente quando la label `imageMode` è stata
rinominata: il suo summary finale conserverà quindi la vecchia stringa
`real-qwen`, mentre gli eventi della stessa run provano esplicitamente
Ideogram 4 Quality-48, HunyuanImage-3.0-Instruct e i due risultati Qwen3.8. Il
summary non viene alterato a posteriori. Il packager accetta quella sola label
legacy esclusivamente insieme al trace completo appena descritto, pubblica nel
sidecar il mode canonico `real-qwen38-router-ideogram4-hunyuan3` e conserva la
label originale in `sourceLabels`. Qualunque altro mode o un trace incompleto
fallisce. Questa è una normalizzazione di metadata di una run già avviata, non
un fallback di inferenza; i test coprono anche questo percorso.

La provenance H3 è stata infine collegata ai byte effettivi, non soltanto alle
costanti del checkout. Al packaging viene calcolato lo SHA-256 dell'MP4 del
sito e cercato un unico output identico in `DSTUDIO_H3_HOME/jobs`; il relativo
`h3-provenance.json` deve provare provider/modello/revisioni, Quality 20×50,
reuse 1, residency nativa, command blocks 1, stage submits 1, SDPA chunk 8,
zero errori Metal, power assertion, 1344×768 H.264/yuv420p, cinque secondi e
decode completo. Il log dello stesso job deve arrivare a denoise 20/20 e non
contenere firme fatali. Provenance e log nativi vengono copiati in `evidence/`,
hashati nel sidecar e poi nel release manifest. Una regressione altera i byte
del solo output job e prova che il packager trovi zero match e non lasci output
parziale; i test release restano PASS.

Un audit successivo ha rilevato che il solo campo nativo
`firstFrame: first-frame.png` non provava ancora quali pixel fossero stati
passati a H3. Il packager ora apre il file reale dentro il job che corrisponde
all'MP4, rifiuta symlink o file mancanti e confronta byte count e SHA-256 con
`assets/kinetic-final.png`, l'edit Hunyuan incluso nel sito. Lo SHA verificato
viene scritto anche nel sidecar e il gate locale lo ricontrolla sui byte del
release. La regressione altera soltanto il first frame del job, richiede un
rifiuto prima dello staging finale e poi ripristina il fixture; il test
packager e i controlli sintattici sono PASS. Questo rafforzamento non modifica
né ricarica il processo H3 attivo.

È stato aggiunto anche `tests/design_pages_release_gate.mjs` per la verifica
post-deploy. Dopo la creazione di GitHub Pages attende il manifest firmato con
cache busting, rifiuta redirect fuori origin, confronta il manifest remoto con
quello Desktop e scarica ogni file tracciato verificandone byte count e SHA-256.
Poi apre davvero l'URL pubblico a 1280 e 390 px, controlla HTTP 200, risorse
confinate allo stesso path Pages, console/request errors, overflow e copy
obbligatoria, salvando screenshot e `pages-release-gate.json`. Il test usa un
server Pages simulato separato e prova sia il deploy identico sia un asset
remoto alterato. Il target `test-design-release` esegue ora packager, gate
locale e gate Pages: tutti e tre PASS.

Per evitare che la provenance immagini dipenda soltanto da un riassunto del
packager, il rilascio include ora anche
`evidence/benchmark-events.json`, copia byte-identica degli eventi originali
della run. Il suo SHA e quello del quality report sono inseriti nel sidecar e
nel manifest. Il gate rilegge gli eventi e ricostruisce autonomamente due call
immagine, due correspondence Qwen, provider Ideogram/Hunyuan, uno solo H3
riuscito, eventuale singolo errore precedente e ordine seriale completo. In
questo modo la dichiarazione dei backend è verificabile nel sito pubblicato e
non viene accettata sulla sola parola della documentazione. I tre release gate
restano PASS dopo l'estensione.

La ricostruzione ora verifica anche gli argomenti, non soltanto nome e ordine
dei tool: la prima immagine deve scrivere il source senza `source_path`, la
seconda deve scrivere l'edit leggendo esattamente quel source, e i due
`see_image` devono puntare rispettivamente ai due PNG. Ogni eventuale tentativo
H3 deve usare l'MP4 del caso, l'edit Hunyuan come `first_frame`, durata 5,
aspect 16:9, licenza esplicita e un prompt di movimento sostanziale; la
provenance nativa deve inoltre escludere reference image aggiuntive. Una
regressione sostituisce il source dell'edit con un path diverso e prova il
rifiuto senza output parziale. Il primo run integrato ha correttamente respinto
il vecchio fixture del release gate, che conteneva nomi dei tool ma non i loro
input e non poteva quindi provare il nuovo contratto. Il fixture è stato
aggiornato con path, routing e first frame reali, senza rilassare il codice di
produzione. La ripetizione completa di `make test-design-release` termina con
`DESIGN_RELEASE_EXIT=0`: packager, gate Desktop e Pages simulato sono tutti
PASS.

L'audit degli artifact ha infine confermato una sola run Design attiva
(`design-creative-real-one-v1`, un solo caso) e una sola vecchia directory
Design sostituita. `tests/.artifacts/lumen-layout-real` (9,2 MB) non aveva file
aperti ed è stata spostata in modo recuperabile in
`/Users/giuseppeperrotta/.Trash/DStudio-lumen-layout-real-20260827-0733`.
Gli artifact Cowork, le diagnostiche H3 che provano i fix e la run corrente non
sono stati toccati.

Una prima esecuzione completa dopo l'aggiunta del gate ha osservato un solo
timeout nel test Roadmap: il form di aggiunta blocco risultava connesso ma non
in generazione e il mock non aveva ricevuto richieste. Il fenomeno non si è
riprodotto in cinque run isolate, tre sequenze release→Roadmap né nella
successiva `check-fast` completa, tutte PASS. Non è stata quindi introdotta una
modifica core priva di causa dimostrata. La diagnostica permanente del test ora
registra anche valori dei campi e constraint invalidi, così un'eventuale
ricorrenza distinguerà perdita del draft, validazione browser e stale stream
senza affidarsi a ipotesi.

### Audit core successivo alla correzione lifecycle

L'audit statico del 27 agosto 2026 ha cercato nel runtime nomi del benchmark,
percorsi dell'artifact, soglie geometriche tratte dagli screenshot e rami
speciali PHASE / SHIFT o LUMEN. Questi valori compaiono esclusivamente nel
catalogo dei casi e nei fixture dei test: non sono presenti in `src/`, nella UI
o nel coordinatore DS4. Le regole core restano quindi guidate da job ID,
ownership del server, tipo media e misure DOM effettive, non dal sito usato per
validarle.

Le implementazioni image/video conservano intenzionalmente endpoint e status
specifici del provider, ma applicano la stessa macchina di lifecycle:
inizializzazione del token nel processo server prima dei fork, claim atomico
con creazione esclusiva, marker durevole prima del PID, rifiuto cross-server,
stato terminale coerente e shutdown limitato ai job posseduti. I test HTTP a
due server dimostrano entrambe le direzioni e i test interrupt coprono sia la
race prima del worker sia l'arresto del process group. Non è stato introdotto
un refactor puramente cosmetico durante la run H3 attiva: avrebbe aumentato il
rischio senza correggere un'invariante non coperta.

Dopo l'audit sono stati rieseguiti `test-design-release`, i contratti Qwen3.8 e
il probe `test-design-controls`: tutti PASS. Un primo comando di supervisione
ha usato per errore un nome Make inesistente (`test-design-control-probe`);
nessun test di prodotto è fallito e il probe corretto è stato eseguito
direttamente con esito PASS.

Alle 07:13 CEST è stata poi rieseguita anche l'intera `make check-fast` sullo
stato corrente: exit code 0. Sono passati build/unità, Cowork, DS4 self-test,
controlli e interrupt, tutti i 16 benchmark contract, release gate, routing
Qwen3.8, conformance immagini, browser UI (incluso Roadmap), H3 checkout e
open-weight, HTTP LAN multi-server e controlli sintattici. Le righe
`sleep Terminated: 15` emesse dal test LAN sono i worker fixture che il test
deve arrestare e sono seguite da `http_lan_test: ok`. Subito dopo la suite il
job H3 reale conservava heartbeat, sampling attivo e utilizzo GPU al 96%,
quindi l'isolamento tra fixture e inferenza reale è dimostrato anche in questa
run.

Alle 07:50 CEST la suite è stata ripetuta una seconda volta con output
raccolto in un log separato e codice d'uscita stampato esplicitamente, per non
affidarsi all'output troncato della sessione precedente. Anche questa
esecuzione è terminata con `CHECK_FAST_EXIT=0`. In particolare sono passati di
nuovo i tre interrupt Design, il flusso browser DS4/Qwen, i 16 contract con
baseline strette, i tre gate di release (packager, copia Desktop simulata e
Pages simulato), routing e memoria Qwen3.8, conformance Ideogram/Hunyuan,
l'intera matrice UI, H3 checkout, HTTP/LAN e parsing JavaScript. Nessun modello
pesante aggiuntivo è stato avviato: i test di conformance ispezionano runtime e
sorgenti, mentre le inferenze dei contract sono fixture deterministiche. H3 è
rimasto sul medesimo PID e con heartbeat attivo durante tutta la ripetizione.

L'ispezione diretta del job attivo ha rilevato che `design-video-71906-72` non
contiene `server-owner`. Non è una cancellazione del marker né una regressione
del sorgente corrente: il listener della run è partito alle 01:21:16 e il child
handler che ha accettato il job alle 04:48:36; entrambi usano l'inode
eseguibile legacy `90025152`. Il fix ownership è stato salvato alle 05:51:35 e
il nuovo test server, inode `90584467`, è stato ricostruito alle 06:15:02. Il
job era quindi già in volo sul binario precedente.
Non è stato inventato o scritto a mano un owner token non recuperabile: questo
avrebbe falsificato l'ownership. I server correnti provano invece il marker e
il rifiuto cross-server nella suite HTTP completa.

La verifica dei socket elimina anche l'ipotesi di due server concorrenti sulla
stessa porta: PID 71744 è l'unico `LISTEN` su `127.0.0.1:57345`; PID 27722 è il
child handler con la connessione già `ESTABLISHED` verso il curl DS4 PID 27712.
Il body terminale del job tornerà quindi sul canale originale al processo
Design, senza listener alternativo o polling fuori banda.

Questa differenza non cambia i pesi, il profilo Quality o i pixel del video e
non giustifica perdere il denoise già eseguito. Significa però che la run reale
non viene usata come prova del nuovo interrupt lifecycle; quella proprietà è
provata dai test freschi. Il processo DS4 della run è anch'esso precedente alla
ricompilazione delle ultime correzioni interrupt, ma il suo comando e transcript
mostrano già il contratto Design con `inspect_layout`, creatività, font e gate
responsive. Le modifiche successive riguardano l'interruzione/cleanup e sono
coperte separatamente dalla suite exit 0.

Il log nativo del job reale è stato inoltre ispezionato, non soltanto lo status:
tokenizer, video VAE encoder 28/28, Qwen vision 27/27, text encoder 50/50,
refine text, AdaLN 50/50 e caricamento core 50/50 sono completi; il denoise ha
raggiunto 2/20. Non compaiono NaN/Inf, OOM, fallback, recovery, eccezioni o
errori Metal e non esiste alcun marker `cancel-requested`.

Alle 08:10:12 CEST il medesimo processo ha raggiunto 3/20. La telemetria AGX
immediatamente precedente misurava 84–88% di utilizzo device, 78–80% renderer
e `recoveryCount=0`; un sample nativo mostrava lavoro Metal/MPSGraph in SDPA,
non un thread bloccato. Il flag `heartbeat=false` scritto nello status insieme
al nuovo step era la scrittura di progresso non-heartbeat ed è tornato `true`
al tick successivo delle 08:11:10. La media nativa aggiornata è 4.003 secondi
per step, con ETA denoise di 68.045 secondi; il profilo e tutti i parametri
Quality sono invariati.

Alle 09:45 CEST lo stesso processo nativo, senza riavvii, ha raggiunto 4/20.
Lo status riporta `heartbeat=true`, 17.808,6 secondi trascorsi, 4.257 secondi
per step ed ETA denoise di 68.117 secondi (circa 18 ore e 55 minuti). Restano
invariati 1344×768, 5 secondi, 20 step, 50 layer, `commandBlocks=1`,
`stageSubmits=1` e chunk SDPA 8. Il log continua a non contenere NaN, OOM,
errori Metal, recovery o cancellazioni e il file MP4, correttamente, non è
ancora stato scritto. La suite eseguita nel frattempo non ha riavviato H3 né
caricato altri modelli pesanti.

Alle 10:11 CEST è stata verificata anche la continuità del handoff lungo: il
`curl` di DS4 e il worker HTTP conservano una connessione `ESTABLISHED`, le
pipe runner→server→DS4 e worker→H3 sono ancora aperte e il listener originale
resta attivo sulla porta 57345. Il transcript non cambia perché DS4 è in attesa
sincrona del risultato, non perché la sessione sia persa. La macchina dispone
di 103.079.215.104 byte di RAM fisica; `memory_pressure -Q` segnala 72% libero,
zero pagine throttled e 1,7 TiB disponibili sul volume dati. Lo swap corrente
è 6,5/8 GiB, ma la bassa pressione e l'assenza di throttling non indicano un
OOM imminente. Il solo modello H3 occupa 134 GiB su disco; nessun altro modello
pesante è caricato.

Infine, il transcript vivo termina sulla seconda chiamata `generate_video` e
il runner segnala `lastEvent=tool_call`, `working=true`: la prima chiamata è il
fallimento lifecycle già archiviato, la seconda è il solo retry per bug ora in
sampling. Dopo il retry non risultano altri tool media, scritture HTML,
`inspect_layout` o gate visuali. DS4 sta quindi realmente aspettando H3 e non è
entrato in un loop di reasoning né sta costruendo il sito in parallelo.

Un audit mirato ha ricontrollato anche i difetti originari delle schermate
LUMEN. Il wrapper browser misura per ogni gruppo ripetuto top/bottom delle card,
altezza/bottom dei media, gap orizzontali e verticali, ratio intrinseco/render,
`object-fit` e breakpoint 1280/768/390. Il test end-to-end contiene un fixture
con delta di 370 px e prova che diventi un FAIL deterministico; contiene inoltre
media responsive puliti/rotti e un video H3 non ancora decodificato, per cui le
dimensioni HTML 1344×768 devono essere usate senza nascondere crop estremi.
Pannelli molto alti con una grande coda vuota sono classificati come stretched
sparse panel, mentre rail stretti o spazio morto compositivo restano nel gate
visuale e obbligano una successiva misura `inspect_layout`. Il report espone
anche `fontFamily`, size, weight, line-height e writing mode calcolati dal
browser. Questa copertura usa geometria DOM e non nomi, copy o valori del sito;
non sono state aggiunte nuove soglie ad hoc dopo l'audit.

### Timeout cumulativo e lifecycle dei renderer Chrome

La prima ripetizione di `check-fast` dopo l'estensione della provenance non ha
prodotto un falso verde: `ds4_design_qwen_test` è stato terminato con `SIGKILL`
durante l'ultimo `inspect_layout`. Una seconda esecuzione isolata ha riprodotto
lo stesso punto e la stessa durata, 180,59 secondi. RAM libera e stack
escludevano OOM e deadlock: il test imponeva una deadline cumulativa fissa di
180 secondi a un contratto che esegue 34 render bounded (sei probe a tre
viewport e quattro controlli visuali a quattro viste). Il processo stava ancora
producendo catture quando il timer del harness lo uccideva.

Il timeout totale è stato sostituito da un watchdog di inattività rinnovato
soltanto da output reale, mantenendo un tetto assoluto separato. La copertura
non è stata ridotta: l'esecuzione successiva ha completato tutte le stesse
catture in 241,36 secondi. Il timeout invia ora `SIGTERM` e usa `SIGKILL` solo
dopo una grace period; un timeout viene inoltre asserito esplicitamente, perché
il cleanup ordinato termina con exit code 0 e non deve essere scambiato per un
PASS funzionale.

Le due terminazioni precedenti hanno esposto anche un bug di prodotto: Chrome
era sincrono ma il cleanup `SIGTERM` di DS4 possedeva soltanto i job shell, così
due renderer headless con profili isolati erano rimasti orfani. Il core ora
registra il leader del solo process group renderer attivo, blocca `SIGTERM`
nella finestra `fork`→pubblicazione del PID e termina quel gruppo nel medesimo
handler generale. Se il segnale arriva durante un render, il core completa da
contesto normale la sequenza kill, wait e rimozione ricorsiva del profilo prima
di uscire; non lascia quindi né processi né directory Chrome parziali. La
proprietà vale anche nel self-test, che usa lo stesso renderer. Non dipende da
nomi del benchmark, entry HTML, viewport o profilo.

`design_chrome_termination_test` usa un eseguibile Chrome fixture che resta
volontariamente bloccato con un processo figlio: invia `SIGTERM` a DS4 e
richiede che processo, gruppo renderer e un profilo annidato contenente file
scompaiano. La regressione è inclusa in `test-design-interrupt` ed è PASS. Dopo
la correzione,
`TEST_DESIGN_QWEN_EXIT=0`, nessun processo con profilo
`ds4-design-chrome-*` è rimasto vivo e la successiva suite completa termina con
`CHECK_FAST_FINAL_EXIT=0`. Sono passati nuovamente tutti i 16 benchmark Design,
release Desktop/Pages, Qwen3.8, conformance Ideogram/Hunyuan, UI/browser,
open-weight H3 e HTTP/LAN. Il job H3 reale è rimasto sullo stesso PID, con
heartbeat attivo, durante l'intera diagnosi e verifica. L'audit post-suite ha
infine spostato nel Cestino, quindi in modo recuperabile, 77 profili storici e
8 wrapper viewport lasciati dalle vecchie terminazioni; nell'area temporanea ne
restano zero.

### Provenienza nativa immagini e correspondence Qwen nel release

L'audit del packager ha trovato un'ulteriore lacuna di evidenza: il conteggio
delle due chiamate `see_image` non provava che Qwen avesse restituito due
revisioni riuscite e sostanziali, mentre i file nativi Ideogram/Hunyuan erano
rimasti nella home temporanea del vecchio runner e non sarebbero entrati nel
release finale. I due job originali sono stati quindi preservati, senza
ricostruirne o riscriverne la provenance, sotto
`diagnostics/image-native-evidence`. I byte degli output coincidono con gli
asset del workspace: SHA-256
`d8769e6f138f41c3fcafb0f29437be9c7c5aec2d4be772cf3c4b18121bd69484`
per `kinetic-source.png` e
`868b1ed411bb82060a112ad718f35c2a9561c6bb7b50361f212f27deca4f5f97`
per `kinetic-final.png`; anche `source.png` del job Hunyuan coincide con
l'output Ideogram.

Il packager e il gate indipendente ora richiedono e ricalcolano, dai file
originali, modello e revisione Qwen3.8-27B-8bit, one-shot preflight, Max
thinking senza budget, serializzazione e decisioni `generate`/`edit`. Per
Ideogram verificano revisione nativa, `V4_QUALITY_48`, 48 step, Euler e tre
passaggi di polish. Per Hunyuan verificano il modello Instruct NF4 e la base,
50 step, assenza di `maxNewTokens`, 32 layer MoE eager, SDPA nativa, nessun
custom kernel, monkeypatch o token routed scartato, oltre al legame fra hash
del reasoning Max, prompt e immagine sorgente. Il release conserva i sette JSON
di provenance originali, li include nel manifest e li collega agli hash degli
asset e al first frame H3 nel sidecar d'inferenza.

Le due risposte Qwen devono inoltre essere entrambe non-error, associate al
percorso esatto dell'immagine richiesta e contenere una valutazione
sostanziale; il semplice evento di chiamata non basta più. Le regressioni
negative coprono risposta Qwen fallita, edit con sorgente errata, Ideogram a 47
step, first frame H3 diverso e MP4 alterato. La ripetizione integrata del 27
agosto termina con `DESIGN_RELEASE_EXIT=0`: `package_design_release_test`,
`design_site_release_gate_test` e `design_pages_release_gate_test` sono tutti
PASS. Questa suite usa fixture e browser locali e non ha avviato né modificato
il job H3 reale.

### Race dei test H3 e copertura numerica della patch

Un nuovo audit sotto il carico della run reale ha riprodotto una flakiness che
la precedente esecuzione singola non dimostrava: `h3_checkout_test` attendeva
al massimo 2,5 secondi la pubblicazione di un record nativo senza newline,
mentre il fake H3 restava vivo soltanto 3 secondi. Una schedulazione lenta
poteva quindi far fallire il test pur con il parser corretto. Il fake resta ora
in vita fino a un file di rilascio esplicito scritto dal test dopo aver
osservato `step=1/20`; la proprietà verificata è realmente “status pubblicato
prima dell'EOF” e non dipende più dalla velocità della macchina.

La ripetizione iniziale ha fatto emergere una seconda race: la prova successiva
dell'asserzione energetica scaduta riutilizzava lo stesso fake e poteva trovare
ancora il file di rilascio, terminando prima che il supervisore osservasse la
scadenza. Ora il marker viene rimosso prima della prova e un timer daemon di
dieci secondi funge esclusivamente da fail-safe anti-hang; il percorso corretto
continua a rilevare il processo `caffeinate` terminato e a rifiutare
l'inferenza. Dopo le correzioni, 20 esecuzioni consecutive di
`h3_checkout_test` sotto H3 reale hanno prodotto 20 PASS e zero fallimenti.

L'audit ha inoltre scoperto che
`tests/h3_sdpa_query_chunk_equivalence.c` esisteva ma non era collegato ad
alcun target, quindi la suite non provava numericamente la segmentazione SDPA
usata dal profilo Quality. Il nuovo runner clona localmente il commit H3 pinned
in una directory temporanea, vi applica
`patch/h3-metal-watchdog/stage-command-submits.patch`, compila il test senza
scrivere nel checkout gestito e confronta BF16 bit per bit. I chunk 1, 2, 7,
8 e 22 producono zero mismatch e `max_abs=0` rispetto al percorso baseline;
anche il numero di dispatch coincide con quello atteso. Il runner è ora parte
di `test-video-open-weight` e quindi di `check-fast`.

La suite completa successiva, archiviata in
`/tmp/dstudio-check-fast-h3-race-fix-20260827.log`, è terminata con exit 0:
include core, Cowork/Office, interrupt e cleanup Chrome, i 34 render
DS4/Qwen, 16 benchmark strict, release Desktop/Pages, Qwen3.8,
Ideogram/Hunyuan, UI/Playwright, Plan/GSA/RSA, markdown/math, H3 (compreso il
nuovo confronto numerico) e HTTP/LAN. L'audit post-suite rileva zero Chrome o
fake H3 orfani, zero directory temporanee residue e checkout H3 pulito. Il job
reale è rimasto sul PID 27736, con heartbeat attivo e 4/20 step, durante tutta
la verifica.

### Provenienza del tempo di generazione e resume

L'audit del README finale ha trovato una lacuna distinta dall'inferenza: il
packager richiedeva soltanto `elapsedMs > 0`, quindi non provava che il tempo
stampato coincidesse con il quality report né che includesse davvero il tratto
pre-interruzione dichiarato. La run corrente usa correttamente
`priorElapsedMs=22.747.000` al checkpoint verificato e somma l'intera sessione
attiva; comprende quindi sia il job H3 `design-video-71906-66` fallito per il
bug cross-server sia il retry `design-video-71906-72`. Esclude il suffisso
successivo al checkpoint di una vecchia esecuzione, evitando di contare due
volte lavoro ripetuto.

Il release packager ora richiede uguaglianza esatta fra tempo e resume del
summary, del quality report e di `resume.json`; verifica schema, case ID,
confine del checkpoint, byte e SHA-256 di ogni file preservato e richiede che
il totale sia maggiore del tempo precedente. Pubblica un sidecar sanificato
`evidence/resume-provenance.json`, senza il path assoluto del manifest locale,
lo collega per hash all'inference sidecar e al release manifest e lo elenca nel
README. Il gate indipendente ripete le stesse verifiche sui file del sito.
Le regressioni positive dei tre gate release sono PASS; quelle negative
rifiutano sia un `priorElapsedMs` incoerente prima del packaging sia un sidecar
resume alterato dopo il packaging, senza lasciare output parziali.

Il controllo indipendente non si limita più alla presenza nominale delle
sezioni README: ricalcola la durata umana e i millisecondi dal release
manifest e richiede corrispondenza esatta di piattaforma, architettura, SoC,
core logici, RAM e chipset GPU con l'inference sidecar. Una regressione
riscrive il tempo nel README, aggiorna regolarmente il manifest dei file e
prova comunque che il gate semantico lo rifiuti. Dopo questa estensione
`package_design_release_test`, `design_site_release_gate_test` e
`design_pages_release_gate_test` restano tutti PASS.

La modifica è stata infine verificata dentro una nuova `make check-fast`
completa, non soltanto nei tre target release. Il log
`/tmp/dstudio-check-fast-release-resume-evidence-20260827.log` termina con exit
0 e copre nuovamente core, Cowork, Design/Qwen, 16 baseline strict, immagini,
UI/browser, H3 numerico e HTTP/LAN. L'audit successivo rileva zero processi
Chrome/fake H3, zero directory renderer/test residue e checkout H3 pulito; la
run reale conserva lo stesso PID e heartbeat a 4/20.

### Verifica live del presunto blocco H3

Alle 10:39 CEST il job reale `design-video-71906-72` conserva lo stesso PID
27736 e la stessa catena HTTP aperta fra DS4, `curl`, server e worker. Lo
status è `running/sampling`, heartbeat vero, 4/20 step completi, 21.059,6
secondi trascorsi nel tentativo corrente e nessun errore Metal, NaN, OOM o
marker di cancellazione. Un sample indipendente di un secondo non mostra un
thread fermo in attesa applicativa: 817 campioni sono dentro
`encode_forward`/`-[MTLCommandBuffer waitUntilCompleted]`, con frame
`MPSGraph`, `MPSNDArrayScaledDotProductAttention`, `EncodeSDPA` e driver
`AGXMetalG14X`. La CPU sta quindi attendendo il command buffer Metal che sta
eseguendo lo step; non è un reasoning DS4 inceppato e non è una falsa attesa
del coordinatore.

La lettura AGX delle 10:52 conferma la stessa conclusione con una misura
indipendente: device 92%, renderer 85%, tiler 85% e `recoveryCount=0`. La
ricerca nel log unificato dei dieci minuti precedenti restituisce zero record
per command-buffer failure, GPU callback error, OOM o NaN. Anche
`git diff --check` e la validazione delle 16 baseline Design risultano PASS
senza caricare un altro modello.

Alle 11:01:40 lo stesso processo ha pubblicato `denoise 5/20`; il log nativo è
passato a 7.783 byte con mtime 11:01:37. La media misurata dalla sola fase
denoise è ora 4.459 secondi per step e l'ETA nativa 66.878 secondi, circa 18
ore e 35 minuti. Come previsto dal protocollo, la scrittura di avanzamento ha
impostato temporaneamente `heartbeat=false`; il tick delle 11:02:12 lo ha
riportato a `true` senza cambio PID, restart o recovery.

L'audit statico parallelo del cleanup Chrome ha trovato un bug di ownership
distinto: `design_chrome_profile_signal` dichiarava di confrontare l'argomento
`--user-data-dir` esatto, ma usava `strstr`. Un processo estraneo con un path
che iniziava con il profilo temporaneo posseduto, per esempio
`--user-data-dir=<profilo>-decoy`, poteva quindi ricevere SIGTERM/SIGKILL. Il
core ora richiede confini di argomento whitespace/NUL a sinistra e destra del
match; non si tratta di una allowlist specifica del benchmark.

La regressione avvia intenzionalmente un decoy con quel prefisso, termina
DS4 durante il render e prova insieme che il renderer posseduto muoia, il suo
profilo venga rimosso e il decoy resti vivo. `make test-design-interrupt`
termina con `TEST_DESIGN_INTERRUPT_EXIT=0`: self-test, interrupt modello,
Chrome, immagine e video sono tutti PASS. L'audit successivo trova zero decoy,
fake Chrome o profili temporanei orfani e `git diff --check` è pulito. Build e
test non hanno cambiato il processo H3 reale, rimasto sul PID 27736 a 5/20 con
heartbeat attivo.

La correzione è stata poi verificata nell'intera `make check-fast`, non solo
nel test mirato. Il log
`/tmp/dstudio-check-fast-chrome-exact-profile-20260827.log` termina con
`CHECK_FAST_EXACT_PROFILE_EXIT=0` e include core, Cowork/Office, interrupt e
cleanup, 34 render DS4/Qwen, 16 baseline Design strette, i tre gate release,
Qwen3.8, conformance Ideogram/Hunyuan, UI/Playwright, Plan/GSA/RSA,
markdown/math, H3 open-weight con equivalenza numerica dei chunk e HTTP/LAN.
L'audit post-suite trova zero decoy, Chrome/fake-H3 o directory temporanee
residue; il checkout H3 è pulito e il job reale conserva PID, monitor Metal,
asserzione energetica e heartbeat a 5/20.

Resta una limitazione di osservabilità reale: h3.c pubblica il contatore solo
quando termina un intero step, che su questo canvas Quality richiede in media
circa 4.459 secondi. Per questo `5/20` può restare invariato per oltre un'ora.
Il core mostra già elapsed aggiornato, barra animata, heartbeat, contatore
nativo ed ETA; inventare percentuali intermedie sarebbe fuorviante. Una
granularità più fine richiederebbe in futuro callback nativi interni allo step,
da introdurre tramite patch versionata e con equivalenza numerica provata, non
durante questa inferenza attiva.

### Audit di completamento corrente

| Requisito finale | Stato al 27 agosto, 11:02 CEST | Evidenza autorevole |
|---|---|---|
| Un solo benchmark Design reale | provato | `summary.json` seleziona soltanto `fullstack-kinetic-museum`; sul disco esiste una sola directory artifact Design attiva |
| DeepSeek V4 Design Max, senza cap, contesto esteso | provato | processo `ds4-design` con `-c 393216 --think-max --think-tokens 0`; `launch.json` e `startup.json` concordano |
| SSD streaming spento quando resta solo DS4 | provato | `ssdStreaming=off`, `ssdStreamingEffective=false`, motivazione DS4-only nello startup |
| Qwen3.8-27B Q8 unico router/revisore, Max senza budget | provato | preflight one-shot e provenance con revisione pinned, `thinkingBudget=null`; contratto Qwen3.8 PASS |
| Ideogram 4 FP8 Quality-48 e HunyuanImage 3 Instruct full-50 seriali | provato | due PNG hash-verificati, provenance native preservata e gate release PASS |
| MiniMax H3 Quality 1344×768, 5 s, 20 step, 50 layer | in corso | PID 27736, heartbeat attivo, 5/20; nessun MP4 è ancora disponibile |
| Sito completo scritto da DS4 Design | non raggiunto | `kinetic-museum.html` non esiste ancora; DS4 è correttamente sospeso sul tool H3 |
| Quality gate composto layout/design desktop e mobile | non raggiunto | nessun `inspect_layout`, `see_page`, render finale o artifact della run corrente |
| Correzioni estetiche effettuate da DS4, non manualmente | non ancora applicabile | dipende dal primo layout reale e dai finding del gate composto |
| README reale con hardware, tempo e provenance | infrastruttura provata, artifact reale mancante | packager e tre gate fixture PASS; il README reale nasce soltanto dopo il PASS del benchmark |
| Copia completa sul Desktop | non raggiunto | destinazione finale non viene creata prima del PASS |
| GitHub Pages pubblicato e verificato byte per byte | non raggiunto | repository finale non viene creato prima del PASS; gate Pages è provato soltanto con fixture |

Questa matrice è fail-closed: i test dell'infrastruttura non vengono usati come
surrogato del sito reale. Le ultime cinque righe potranno passare soltanto con
MP4 decodificato, HTML scritto da DS4, screenshot e misure reali, release
Desktop e contenuto Pages identico per hash.

### Handoff finale ancora da eseguire

Il runner produce HTML, media, screenshot, report, hardware e tempo totale
nell'artifact, ma non copia né pubblica autonomamente il risultato. Dopo un
PASS reale restano quindi tre operazioni di consegna, da non anticipare su un
artifact incompleto: copiare il sito verificato in
`~/Desktop/phase-shift-kinetic-museum`, duplicare l'entry verificata come
`index.html` mantenendo percorsi asset relativi, quindi pubblicare quel solo
contenuto in un nuovo repository pubblico
`sk8erboi17/phase-shift-kinetic-museum` (la verifica `gh repo view` del 27
agosto restituisce ancora `not found`) e abilitare GitHub Pages dalla root di
`main`. Il repository non va creato prima del PASS reale, per evitare una
pubblicazione vuota o parziale. Il README finale deve sostituire il placeholder
locale con l'URL Pages reale e conservare hardware, configurazione Max, tempo
cumulativo di resume e path delle evidenze. Prima del push vanno ripetuti
decode MP4, hash PNG, controllo dipendenze remote, render desktop/mobile e
link/interazioni dalla copia Desktop; un FAIL del benchmark non è
pubblicabile.

Il preflight delle 10:35 CEST conferma `gh` 2.96 autenticato come
`sk8erboi17`, protocollo Git HTTPS, scope `repo`, identità Git configurata,
destinazione Desktop assente e repository remoto ancora inesistente. La
[documentazione REST GitHub Pages corrente](https://docs.github.com/en/rest/pages/pages)
usa l'API version `2026-03-10`: dopo il push di `main`, il sito verrà creato
con `POST /repos/sk8erboi17/phase-shift-kinetic-museum/pages` e
`{"source":{"branch":"main","path":"/"}}`. Solo dopo lo stato pubblicato
verrà eseguito `design_pages_release_gate`, che confronta il manifest Desktop
con quello remoto e scarica/hash-verifica ogni file elencato.
