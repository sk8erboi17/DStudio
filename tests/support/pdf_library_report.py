"""Aggregate the explicit local-library benchmark; never publish source documents.

Run only after all question batches finish. Charts require matplotlib. A missing
case is an error, not a silently reduced denominator. Raw runs remain untouched.
"""
import csv
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys

def stats(values):
    values = sorted(v for v in values if isinstance(v, (int, float)))
    return dict(n=len(values), totalMs=sum(values), medianMs=statistics.median(values),
                p95Ms=values[math.ceil(.95 * len(values)) - 1], maxMs=max(values)) if values else None


def aggregate(run):
    inventory = json.loads((run / "inventory.json").read_text())
    reads = json.loads((run / "read.json").read_text())
    questions = json.loads((run / "questions.json").read_text())["cases"]
    labels = json.loads((run / "labels.json").read_text()) if (run / "labels.json").exists() else {}
    assert reads.get("finished"), "reading is not complete"
    assert len(reads["documents"]) == len(inventory["documents"]), "incomplete read coverage"
    cases, batches = {}, []
    for file in sorted(run.glob("retrieval-*/retrieval.json")):
        batch = json.loads(file.read_text())
        assert batch.get("finished"), f"batch still running: {file}"
        batches.append({"file": str(file.relative_to(run)), "wallMs": batch["wallMs"], "machine": batch.get("machine"),
                        "documentsTested": len(batch["documents"]),
                        "remainingEmbeddingIndexes": len(list((file.parent / "cache").glob("*.ragbin"))),
                        "remainingTextLayers": len(list((file.parent / "cache").glob("*.pdftxt"))),
                        "reader": batch["reader"], "embedding": batch["embedding"]})
        for doc in batch["documents"]:
            for case in doc["cases"]:
                assert case["id"] not in cases, f"duplicate case: {case['id']}"
                assert case["status"] != "running", f"unfinished case: {case['id']}"
                cases[case["id"]] = case
    assert set(cases) == {q["id"] for q in questions}, "missing or unexpected retrieval cases"
    for question in questions:
        for field in ("question", "quote", "document", "page"):
            assert cases[question["id"]][field] == question[field], f"ground truth changed after retrieval: {question['id']}"
    # Do not reinterpret an assertion error as a retrieval miss when the
    # independent page/quotation checks succeeded but highlighting failed.
    found = lambda c: c.get("pageRecall") is True and c.get("quoteRecall") is True
    text_cases = [c for c in cases.values() if c.get("groundTruth") != "rendered-page"]
    visual_cases = [c for c in cases.values() if c.get("groundTruth") == "rendered-page"]
    proofs = [c for c in cases.values() if "proof" in c]
    hits = [c for c in cases.values() if found(c)]
    evidence_hits = [c for c in proofs if c["proof"].get("status") == "matched" and c["proof"].get("boxes")]
    adjudications = []
    audit_file = run / "adjudications.json"
    if audit_file.exists():
        adjudications = json.loads(audit_file.read_text())["cases"]
        assert len({a["id"] for a in adjudications}) == len(adjudications), "duplicate manual review"
        for a in adjudications:
            assert a["id"] in cases and not found(cases[a["id"]]), "manual review must concern a strict miss"
            if a["decision"] == "answer_present_alternate_page":
                c = cases[a["id"]]
                text = " ".join(c["cold"]["result"]["text"].split())
                assert a["quotes"] and all(" ".join(q.split()) in text for q in a["quotes"]), "manual review quotation not in returned context"
                assert all(p in c["selectedPages"] for p in a["pages"]), "manual review page not returned"
    cold_first, index_reuse, identical = [], [], []
    timing_file = run / "timing_annotations.json"
    timing_annotations = json.loads(timing_file.read_text())["cases"] if timing_file.exists() else []
    excluded_cold = {a["id"] for a in timing_annotations if a.get("excludeColdFromIndependentTiming")}
    excluded_query = {a["id"] for a in timing_annotations if a.get("excludeQueryTimings")}
    table = []
    read_by_id = {d["id"]: d for d in reads["documents"]}
    originals_ok = []
    for doc in inventory["documents"]:
        src = Path(inventory["root"]) / doc["file"]
        digest = hashlib.sha256(src.read_bytes()).hexdigest()
        assert digest == doc["sha256"], f"original changed: {doc['id']}"
        originals_ok.append(doc["id"])
        read = read_by_id[doc["id"]]
        dc = [c for c in cases.values() if c["document"] == doc["id"]]
        if read.get("overview", {}).get("result", {}).get("documentId"):
            assert read["overview"]["result"]["documentId"] == doc["sha256"], "reader returned a different original"
        for c in dc:
            if c.get("cold", {}).get("httpStatus") == 200:
                assert c["cold"]["result"].get("documentId") == doc["sha256"], "retrieval returned a different original"
        first = dc[0].get("cold", {})
        truly_cold = (first.get("httpStatus") == 200 and first.get("result", {}).get("hybrid") is True
                       and first.get("result", {}).get("embeddingIndexCached") is not True)
        if truly_cold and dc[0]["id"] not in excluded_cold:
            cold_first.append(first["ms"])
        for c in dc:
            if c["id"] in excluded_query:
                continue
            if isinstance(c.get("warmMs"), (int, float)):
                identical.append(c["warmMs"])
            reuse = c.get("indexReuse", {})
            rr = reuse.get("result", {})
            if reuse.get("httpStatus") == 200 and rr.get("embeddingIndexCached") is True and rr.get("cached") is not True:
                index_reuse.append(reuse["ms"])
        # Read exact metadata again: older inventory used a whitespace regex
        # that could mistake the next metadata line for an empty title.
        info = (run / "reference" / f"{doc['id']}.info.txt").read_text()
        title = next((line.partition(":")[2].strip() for line in info.splitlines() if line.startswith("Title:")), "")
        dp = [c for c in dc if "proof" in c]
        table.append(dict(id=doc["id"], file=doc["file"], title=labels.get(doc["id"]) or title or f"PDF {doc['id']}",
                          pages=doc["pages"], sparsePages=len(doc["sparsePages"]), bytes=doc["bytes"],
                          referenceMs=doc["referenceExtractionMs"], readMs=read.get("firstReadMs"),
                          readStatus=read["status"], completeText=read.get("overview", {}).get("result", {}).get("completeText") is True,
                          indexedFirstMs=first.get("ms") if truly_cold else None,
                          coldTimingExcluded=dc[0]["id"] in excluded_cold,
                          retrieved=sum(found(c) for c in dc), questions=len(dc),
                          evidenceMatched=sum(c["proof"].get("status") == "matched" and bool(c["proof"].get("boxes")) for c in dp),
                          evidenceTested=len(dp)))
    summary = dict(schema="dstudio.pdf-library.summary.v1", inventory=inventory["summary"],
                   machine=inventory.get("machine") or next((b["machine"] for b in batches if b["machine"]), None),
                   referenceWallMs=inventory["referenceWallMs"],
                   readFirst=stats([d.get("firstReadMs") for d in reads["documents"]]),
                   readWarm=stats([w["ms"] for d in reads["documents"] for w in d.get("warm", [])]),
                   indexFirst=stats(cold_first), queryIndexReuse=stats(index_reuse), queryIdentical=stats(identical),
                   retrieval=dict(total=len(cases), found=len(hits), textTotal=len(text_cases), textFound=sum(found(c) for c in text_cases),
                                  visualTotal=len(visual_cases), visualFound=sum(found(c) for c in visual_cases),
                                  visualControls=[{k: c.get(k) for k in ("id", "document", "page", "referenceImage")} for c in visual_cases],
                                  missed=[c["id"] for c in cases.values() if not found(c)]),
                   evidence=dict(total=len(proofs), matched=len(evidence_hits), ambiguous=sum(c["proof"].get("status") == "ambiguous" for c in proofs),
                                 failed=[c["id"] for c in proofs if c not in evidence_hits]),
                   totalRetrievalBatchWallMs=sum(b["wallMs"] for b in batches),
                   fullTextEligible=sum(d["completeText"] for d in table),
                   originalsVerifiedSha256=len(originals_ok), batches=batches, documents=table)
    summary["timingAnnotations"] = timing_annotations
    summary["manualReview"] = dict(cases=adjudications,
                                 equivalentPassages=[a["id"] for a in adjudications if a["decision"] == "answer_present_alternate_page"],
                                 unreviewedStrictMisses=[c["id"] for c in cases.values() if not found(c)
                                                        and not any(a["id"] == c["id"] for a in adjudications)])
    summary["multipleQuestions"] = [dict(id=d["id"], title=d["title"], questions=[
        dict(id=c["id"], page=c["page"], requestMs=c.get("cold", {}).get("ms"), found=found(c),
             reusedIndex=c.get("cold", {}).get("result", {}).get("embeddingIndexCached") is True)
        for c in cases.values() if c["document"] == d["id"]]) for d in table if d["questions"] > 1]
    return summary, cases


def charts(run, s):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11,
                         "axes.spines.top": False, "axes.spines.right": False})
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.8), layout="constrained")
    docs = s["documents"]
    axes[0].scatter([d["pages"] for d in docs], [d["readMs"] / 1000 for d in docs], color="#3765db", alpha=.8)
    axes[0].set(title="Estrarre il testo disponibile", xlabel="Pagine del PDF", ylabel="Secondi (prima lettura)")
    indexed = [d for d in docs if d["indexedFirstMs"] is not None and not d["coldTimingExcluded"]]
    axes[1].scatter([d["pages"] for d in indexed], [d["indexedFirstMs"] / 1000 for d in indexed], color="#3765db", alpha=.8)
    excluded = [d for d in docs if d["indexedFirstMs"] is not None and d["coldTimingExcluded"]]
    if excluded:
        axes[1].scatter([d["pages"] for d in excluded], [d["indexedFirstMs"] / 1000 for d in excluded],
                        color="#777777", marker="x", label="Escluso: sovrapposizione o testo assente")
        axes[1].legend(fontsize=8, loc="upper left")
    axes[1].set(title="Preparare la prima ricerca", xlabel="Pagine del PDF", ylabel="Secondi (indice + ricerca)")
    for ax in axes:
        ax.grid(alpha=.18)
        ax.set_ylim(bottom=0)
    fig.suptitle(f"DStudio · {len(docs)} PDF reali · ogni punto è un file", fontsize=15)
    fig.savefig(run / "tempi.png", dpi=170)
    plt.close(fig)

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5), layout="constrained")
    r, e = s["retrieval"], s["evidence"]
    alternate = len(s["manualReview"]["equivalentPassages"])
    values = [[r["found"], alternate, r["total"] - r["found"] - alternate], [e["matched"], e["total"] - e["matched"]]]
    labels = [["Fonte attesa", "Equivalente\n(revisione manuale)", "Non confermato"], ["Riuscito", "Non riuscito"]]
    colors = [["#2e9b62", "#3765db", "#ce654f"], ["#2e9b62", "#ce654f"]]
    for ax, counts, names, palette, title in zip(axes, values, labels, colors, ("Passaggi recuperati", "Citazione localizzata nel PDF")):
        bars = ax.bar(names, counts, color=palette)
        ax.bar_label(bars, padding=4, fontsize=14)
        ax.set(title=title, ylabel="Domande", ylim=(0, max(counts) * 1.18 + 1))
        ax.grid(axis="y", alpha=.18)
    fig.suptitle("Prima run · ricerca e citazioni sono verifiche diverse", fontsize=15)
    fig.supxlabel(f"Ricerca: {r['total']} domande, incluso il controllo senza testo · evidenze: {e['total']} citazioni restituite", fontsize=10)
    fig.savefig(run / "qualita.png", dpi=170)
    plt.close(fig)


def report(run, s, cases):
    sec = lambda ms: f"{ms/1000:.2f}".replace(".", ",")
    r, e, i = s["retrieval"], s["evidence"], s["inventory"]
    total_seconds = round(s["totalRetrievalBatchWallMs"] / 1000)
    total_duration = f"{total_seconds//3600} h {(total_seconds%3600)//60} min {total_seconds%60} s"
    machine = s.get("machine") or {}
    hardware = f"{machine.get('cpus', 'Mac locale')}, {machine.get('memoryBytes', 0)/2**30:.0f} GiB RAM, {machine.get('arch', '')}"
    visual_notes = []
    for c in r["visualControls"]:
        d = next(d for d in s["documents"] if d["id"] == c["document"])
        visual_notes.append(f"Il documento **{d['id']}** ha {d['sparsePages']} pagine su {d['pages']} senza testo utile. "
                            f"La pagina {c['page']} è stata controllata visivamente, ma non è ricercabile con la sola "
                            f"estrazione testuale. OCR non attivato. [Pagina di riferimento]({c['referenceImage']}).")
    lines = ["# Benchmark della libreria PDF — DStudio", "",
             f"Tutti i **{i['files']} PDF** della cartella indicata: **{i['pages']:,} pagine**, {i['bytes']/1e9:.2f} GB. "
             f"**{r['total']} domande** preparate dalle fonti prima della ricerca. Nessun file originale modificato "
             f"(SHA-256 ricontrollato su {s['originalsVerifiedSha256']} file).", "",
             f"Mac della prova: **{hardware}**. Solo il piccolo modello di embedding residente su Metal; nessun modello generativo in SSD streaming.", "",
             "## Risultato in parole semplici", "",
             f"- DStudio ha recuperato **la pagina e il passaggio attesi in {r['found']}/{r['total']} domande**. "
             f"Nei casi con testo estraibile: **{r['textFound']}/{r['textTotal']}**.",
             f"- In **altri {len(s['manualReview']['equivalentPassages'])} casi**, la revisione manuale ha verificato "
             "un passaggio equivalente in una pagina diversa. Questi non sono trasformati retroattivamente in successi del criterio automatico.",
             f"- Il matcher ha localizzato la citazione con coordinate univoche in **{e['matched']}/{e['total']} tentativi**. "
             "Trovare il testo non garantisce che la citazione possa essere evidenziata. Non è un test della modale grafica.",
             f"- Estrarre il testo e ottenere l'anteprima dei {i['files']} file ha richiesto **{sec(s['readFirst']['totalMs'])} secondi** "
             "sommando le prime richieste. Non significa che un LLM abbia letto e compreso tutti i libri.",
             f"- La run completa di **prima indicizzazione e {r['total']} domande ha impiegato {total_duration}** "
             "sommando i tre batch, incluse le verifiche e le ricerche ripetute. Le ripetizioni diagnostiche successive "
             "sono separate. Non è il tempo di una singola risposta né di un caricamento simultaneo in chat.", "",
             "| Operazione | Mediana | 95% dei casi entro | Misure |", "|---|---:|---:|---:|"]
    for key, label in [("readFirst", "Prima estrazione + anteprima"), ("readWarm", "Riapertura dell'anteprima"),
                       ("indexFirst", "Primo indice + prima ricerca per PDF"), ("queryIndexReuse", "Ricerca con indice pronto, senza cache della risposta"),
                       ("queryIdentical", "Stessa domanda ripetuta, risposta in cache")]:
        st = s[key]
        if st:
            lines.append(f"| {label} | {sec(st['medianMs'])} s | {sec(st['p95Ms'])} s | {st['n']} |")
    lines += ["", "![Tempi per documento](tempi.png)", "", "![Qualità](qualita.png)", "",
              "## Che cosa è stato effettivamente testato", "",
              "- Endpoint nativi DStudio `/api/pdf/describe` e `/api/pdf/evidence` (matching e coordinate, senza rendering della modale), Poppler reale e modello "
              "**Qwen3-Embedding-0.6B Q8_0** caricato realmente con llama.cpp/Metal. Nessun embedding simulato.",
              "- Ogni ricerca considera tutte le pagine testuali del proprio PDF. Il contesto restituito seleziona "
              f"fino a sei pagine, entro 20 KiB. **Non è una ricerca unica incrociata sui {i['files']} libri**.",
              "- Domande parafrasate da pagine fisiche note; verifica separata della pagina e di una citazione "
              "contenuta nel contesto. Il numero di domande per ciascun documento è riportato nella tabella finale.",
              "- La prima indicizzazione usa cache DStudio nuove. La cache disco di macOS non è stata svuotata. "
              "Richieste inviate in sequenza; la sovrapposizione dopo il timeout del caso 039 è segnalata e il tempo del caso 040 "
              "è escluso dalle statistiche a freddo. Nessun modello generativo DS4/Qwen caricato per produrre risposte.",
              "- Riapertura: tre ripetizioni per file. Domanda identica: una ripetizione per domanda. "
              "Riuso dell'indice: stessa intenzione con prefisso diverso, non una seconda domanda indipendente. "
              "Quest'ultima misura può avere un campione più piccolo: non era presente nei primi 12 casi della run del 5 settembre 2026.",
              "- Tempi via percorso locale: includono elaborazione e HTTP, non upload dal browser, pianificazione "
              "con LLM, generazione della risposta, download del modello o interazione grafica della modale.",
              "- Percentile 95 calcolato con rango intero superiore; mediana esatta. Una run su questo Mac, "
              "non una garanzia di prestazioni su altri sistemi.", "",
              "## Limiti e problemi da non nascondere", "",
              "\n\n".join(visual_notes), "",
              f"**Documenti restituiti integralmente: {s['fullTextEligible']}/{i['files']}**. "
              "Negli altri casi servono ricerca o lettura per intervalli; l'anteprima è dichiaratamente parziale. "
              "Senza un confronto con la versione precedente non si misura un'accelerazione del nuovo percorso per PDF corti.", "",
              "I primi 12 casi usavano un'asserzione unica anche per il matcher delle citazioni: alcuni raw report "
              "dicono `error` pur avendo `pageRecall=true` e `quoteRecall=true`. Le statistiche sopra separano "
              "queste verifiche senza modificare i risultati originali. Nei batch successivi i due esiti sono separati.", "",
              f"Domande senza entrambi i riscontri attesi: **{', '.join(r['missed']) or 'nessuna'}**.", "",
              f"Citazioni non evidenziate: **{', '.join(e['failed']) or 'nessuna'}**.", "",
              "Le citazioni sono state scelte manualmente dalle fonti, non generate da un LLM: il risultato non è una "
              "stima del tasso di errore delle citazioni prodotte durante l'uso normale. Una citazione abbreviata senza la punteggiatura finale può fallire il matching sui confini delle "
              "parole Poppler; impaginazione, sillabazione e colonne richiedono verifiche distinte. "
              "Non tutti i `not_found` vengono attribuiti automaticamente alla punteggiatura.", "",
              "Questa prova non misura la correttezza delle risposte di un LLM, il ragionamento sulle formule, "
              "il confronto tra più libri o l'astensione quando una risposta non esiste. Una domanda per libro "
              "copre l'accesso al documento, non tutti i suoi argomenti.", "", "## Tutti i file", "",
              "Pagine = pagine fisiche del PDF. Le etichette leggibili sono locali e descrittive, non modifiche ai nomi dei PDF. "
              "Domande e risultati completi restano locali nella stessa cartella ignorata da Git.", "",
              "| ID | Titolo | Pagine | Prima lettura | Primo indice + ricerca | Passaggi trovati | Evidenze |", "|---|---|---:|---:|---:|---:|---:|"]
    for d in s["documents"]:
        idx = sec(d["indexedFirstMs"]) + " s" if d["indexedFirstMs"] is not None else "non disponibile"
        title = d["title"].replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {d['id']} | {title} | {d['pages']} | {sec(d['readMs'])} s | {idx} | {d['retrieved']}/{d['questions']} | {d['evidenceMatched']}/{d['evidenceTested']} |")
    if s["multipleQuestions"]:
        lines += ["", "## Domande diverse sullo stesso libro", "",
                  "Queste sono domande su argomenti diversi, non ripetizioni della stessa richiesta. "
                  "La prima costruisce l'indice; le successive lo riutilizzano. Non sono tempi della risposta di un LLM.", "",
                  "| Libro | Domanda / pagina attesa | Tempo ricerca | Fonte esatta trovata | Indice riusato |",
                  "|---|---|---:|---|---|"]
        for d in s["multipleQuestions"]:
            for c in d["questions"]:
                elapsed = sec(c["requestMs"]) + " s" if c["requestMs"] is not None else "errore"
                lines.append(f"| {d['title']} | {c['id']} / p. {c['page']} | {elapsed} | {'Sì' if c['found'] else 'No'} | {'Sì' if c['reusedIndex'] else 'No'} |")
    lines += ["", "## Evidenza e riproducibilità", "", "- [Inventario originale](inventory.json)",
              "- [Domande e passaggi attesi](questions.json)", "- [Letture a freddo e ripetute](read.json)",
              "- [Riepilogo machine-readable](summary.json)", "- [Tabella CSV](documents.csv)"]
    for batch in s["batches"]:
        lines.append(f"- [Batch di retrieval]({batch['file']}) — richieste, contesti, tempi, errori, identità di binario/modello.")
    pruned = [b for b in s["batches"] if 0 < b["remainingEmbeddingIndexes"] < b["documentsTested"]]
    if pruned:
        lines += ["", "## Persistenza degli indici", "",
                  "Il riuso immediato non garantisce che tutta la libreria rimanga pronta dopo molte altre letture. "
                  "Conteggio effettivo dei file indice conservati alla fine dei batch:", ""]
        for b in pruned:
            lines.append(f"- `{b['file']}`: **{b['remainingEmbeddingIndexes']} indici rimasti per {b['documentsTested']} documenti testati**.")
        lines += ["", "Il codice limita la cache degli indici a 32 file. Tornare a un documento il cui indice "
                  "è stato espulso può richiedere una nuova indicizzazione; il tempo di questo ritorno tardivo "
                  "non è misurato qui. I batch usano cache separate, non un unico indice dell'intera libreria."]
    if s["manualReview"]["cases"]:
        lines += ["", "## Revisione manuale dei mancati riscontri esatti", "",
                  "Una pagina diversa può contenere la stessa risposta. Questi controlli sono successivi alla run: "
                  "**non modificano il punteggio automatico né le domande**. Le citazioni della revisione sono "
                  "verificate nel contesto realmente restituito. [Dettagli](adjudications.json).", ""]
        for a in s["manualReview"]["cases"]:
            label = {"answer_present_alternate_page":"Informazione trovata in un'altra pagina",
                     "answer_absent":"Passaggio non trovato", "partial_context":"Contesto soltanto parziale",
                     "source_text_unavailable":"PDF senza testo ricercabile",
                     "transport_error_backend_completed":"Errore del client; indice completato"}.get(a["decision"],a["decision"])
            lines.append(f"- **{a['id']} — {label}**: {a.get('reasonItalian',a['reason'])}")
    if s["timingAnnotations"]:
        lines += ["", "## Errori del banco di prova e tempi esclusi", "",
                  "Il client iniziale aveva un timeout degli header HTTP di cinque minuti, indipendente dalla "
                  "scadenza più lunga richiesta. Il trasporto del benchmark è stato corretto dal batch 049. "
                  "I primi errori restano nei risultati; eventuali retry sono separati. "
                  "Le seguenti misure non entrano nelle statistiche indicate nelle annotazioni:", ""]
        for a in s["timingAnnotations"]:
            lines.append(f"- **{a['id']}**: {a.get('reasonItalian',a['reason'])}")
    retries = sorted(run.glob("retry-*/retrieval.json"))
    if retries:
        lines += ["", "## Ripetizioni diagnostiche, senza sostituire la prima run", ""]
        for file in retries:
            trial = json.loads(file.read_text())
            for d in trial["documents"]:
                for c in d["cases"]:
                    ms = c.get("cold", {}).get("ms")
                    timing = sec(ms) + " s" if ms is not None else "non disponibile"
                    outcome = "fonte attesa recuperata" if c.get("pageRecall") and c.get("quoteRecall") else c["status"]
                    lines.append(f"- **{c['id']}**: {outcome}, prima richiesta {timing}; "
                                 f"citazione: `{c.get('proof',{}).get('status','non verificata')}`. [Ricevuta]({file.relative_to(run)}).")
    audits = sorted(run.glob("evidence-audit-*/audit.json"))
    if audits:
        lines += ["", "## Diagnosi separata del matcher delle citazioni", "",
                  "Il controllo seguente riprova le citazioni fallite aggiungendo soltanto punteggiatura. "
                  "È una diagnosi, non un modo per sostituire i risultati falliti della run principale.", ""]
        for audit in audits:
            data = json.loads(audit.read_text())
            fixed = [c["id"] for c in data["cases"] if any(v["suffix"] and v["result"].get("status") == "matched" for v in c["variants"])]
            unavailable = sum(any(v["httpStatus"] == 410 for v in c["variants"]) for c in data["cases"])
            lines.append(f"- [Audit {data['batch']}]({audit.relative_to(run)}): {len(fixed)}/{len(data['cases'])} "
                         f"citazioni localizzate dopo l'aggiunta della punteggiatura ({', '.join(fixed)}). "
                         f"Copie originali non più in cache al momento dell'audit: {unavailable}.")
    lines += ["", "Tutti questi artefatti sono in `tests/.artifacts/`, esclusa da Git. Non caricare PDF, "
              "estratti, titoli privati o risposte sui servizi esterni per pubblicare il benchmark.", ""]
    (run / "REPORT.md").write_text("\n".join(lines))


if __name__ == "__main__":
    root = Path(sys.argv[1]).resolve()
    summary, cases = aggregate(root)
    charts(root, summary)
    (root / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    with (root / "documents.csv").open("w") as output:
        writer = csv.DictWriter(output, fieldnames=summary["documents"][0].keys())
        writer.writeheader()
        writer.writerows(summary["documents"])
    report(root, summary, cases)
    print(json.dumps({k: v for k, v in summary.items() if k not in ("documents", "batches")}, indent=2))
    print(root / "REPORT.md")
