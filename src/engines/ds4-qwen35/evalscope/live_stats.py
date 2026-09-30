#!/Users/agrilv/venv312/bin/python
"""Preview intermedio del round-2 MMLU-Pro: segna le predizioni in cache
contro le gold del dataset. Sezioni separate per Qwen (con paragone
reasoning sulle sole domande completate da entrambe le config) e Ornith.
Uso:  ./evalscope/live_stats.py [--all]
(--all = un'unica tabella con ogni workdir con predizioni mmlu_pro)"""
import ast, glob, json, os, re, sys, time

os.environ["HF_HUB_OFFLINE"] = "1"

TOTAL = 210  # domande per config (14 materie x 15)

QWEN = [
    ("qwen-default8 [think]", "runB-pro-full", "q35-default8"),
    ("qwen-experts20-thr08 [think]", "runA-pro-full", "q35-experts20-thr08-decay"),
    ("qwen-default8 [nothink]", "runB-pro-nothink", "q35-default8-nothink"),
    ("qwen-experts20-thr08 [nothink]", "runA-pro-nothink", "q35-experts20-thr08-nothink"),
]
ORNITH = [
    ("ornith-default8", "ornithB-pro-full", "ornith-default8"),
    ("ornith-experts20-thr08", "ornithA-pro-full", "ornith-experts20-thr08"),
]

# paragone reasoning: (label, workdir, mid) esperti vs default
MATCH_A = ("experts20+thr0.8", "runA-pro-full", "q35-experts20-thr08-decay")
MATCH_B = ("default8", "runB-pro-full", "q35-default8")

HERE = os.path.dirname(os.path.abspath(__file__))


def gold_map():
    from datasets import load_dataset
    ds = load_dataset("TIGER-Lab/MMLU-Pro", split="test")
    return {r["question_id"]: r["answer"] for r in ds}


def active_phase():
    """(etichetta, mid, timestamp): mid serve per il tag [RUNNING],
    l'etichetta distingue run normale / retry 30K / retry nothink."""
    try:
        last = [l for l in open(os.path.join(HERE, "timeline.log"))
                if "R2-RUN" in l or "R2-RETRY32K" in l
                or "R2-NOTHINK-RETRY" in l][-1].strip()
    except Exception:
        return None, None, None
    m = re.search(r"R2-(RUN|RETRY32K|NOTHINK-RETRY) (\S+) (start|done)", last)
    t = re.match(r"=== (.*) R2-(?:RUN|RETRY32K|NOTHINK-RETRY)", last)
    if not m:
        return None, None, None
    kind = {"RUN": "", "RETRY32K": "RETRY-30K ",
            "NOTHINK-RETRY": "RETRY-30K-NOTHINK "}[m.group(1)]
    return (kind + m.group(2), m.group(2), t.group(1))


def load_rows(wd, mid):
    """{(subject, qid): (pred|None, troncata, latency, output_tokens)}.
    Dedup per domanda: ultima riga vince. troncata = max_tokens o senza ANSWER."""
    rows = {}
    newest = 0.0
    for f in glob.glob(os.path.join(wd, "predictions", mid, "*.jsonl")):
        for line in open(f, errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            md = r.get("metadata")
            if isinstance(md, str):
                try:
                    md = ast.literal_eval(md)
                except Exception:
                    continue
            try:
                qid, subj = int(md["question_id"]), md["subject"]
            except Exception:
                continue
            raw = r.get("model_output", "")
            if not isinstance(raw, str):
                raw = str(raw)
            letters = re.findall(r"ANSWER:\s*\(?([A-J])\b", raw, re.IGNORECASE)
            pred = letters[-1].upper() if letters else None
            sr = re.search(r"'stop_reason': '(\w+)'", raw)
            stopped = sr.group(1) if sr else "?"
            m = re.search(r"'latency': ([0-9.]+)", raw)
            t = re.search(r"'output_tokens': (\d+)", raw)
            rows[(subj, qid)] = (pred,
                                 stopped == "max_tokens" or pred is None,
                                 float(m.group(1)) if m else None,
                                 int(t.group(1)) if t else None)
            newest = max(newest, os.path.getmtime(f))
    return rows, newest


def stats_for(wd, mid, gold):
    rows, newest = load_rows(wd, mid)
    hit = n = trunc = noans = 0
    lat, tok, per = [], [], {}
    for (subj, qid), (pred, is_trunc, la, tk) in rows.items():
        ok = pred == gold.get(qid)
        n += 1
        hit += ok
        trunc += is_trunc
        noans += pred is None
        s = per.setdefault(subj, [0, 0])
        s[0] += ok
        s[1] += 1
        if la:
            lat.append(la)
        if tk:
            tok.append(tk)
    return dict(n=n, hit=hit, trunc=trunc, noans=noans, per=per, rows=rows,
                avg_lat=sum(lat) / len(lat) if lat else 0,
                avg_tok=sum(tok) / len(tok) if tok else 0,
                newest=newest)


def table_lines(configs, gold, act_mid):
    out = ["| config | n/%d | score | no-tronc | lat s | tok | ETA |" % TOTAL,
           "|---|---|---|---|---|---|---|"]
    lines_sub = []
    for label, wd_name, mid in configs:
        wd = os.path.join(HERE, wd_name)
        run = " [RUNNING]" if mid == act_mid else ""
        if not glob.glob(os.path.join(wd, "predictions", mid, "*.jsonl")):
            out.append("| %s%s | 0 | - | - | - | - | in coda |" % (label, run))
            continue
        s = stats_for(wd, mid, gold)
        notr = s["n"] - s["trunc"]
        sc = "%.1f%%" % (100 * s["hit"] / s["n"]) if s["n"] else "-"
        snt = "%.1f%%" % (100 * s["hit"] / notr) if notr else "-"
        eta = "-"
        if s["avg_lat"] and s["n"] < TOTAL:
            rem_h = (TOTAL - s["n"]) * s["avg_lat"] / 3600.0
            eta = "~%.1fh" % rem_h if mid == act_mid else "dopo coda"
        out.append("| %s%s | %d | %s (%s) | %d | %.0f | %.0f | %s |" % (
            label, run, s["n"], sc, snt, s["trunc"], s["avg_lat"],
            s["avg_tok"], eta))
        if s["per"]:
            subs = "  ".join("%s:%d/%d" % (k.split()[0][:9], h, t)
                             for k, (h, t) in sorted(s["per"].items()))
            age = ""
            if s["newest"]:
                age = "  (ultimo campione %.0f min fa)" % (
                    (time.time() - s["newest"]) / 60)
            lines_sub.append("%s: %s%s" % (label, subs, age))
    return out, lines_sub


def matched_reasoning(gold):
    """Score del paragone think calcolato SOLO sulle domande completate
    (non troncate, con risposta) da entrambe le config."""
    ra, _ = load_rows(os.path.join(HERE, MATCH_A[1]), MATCH_A[2])
    rb, _ = load_rows(os.path.join(HERE, MATCH_B[1]), MATCH_B[2])
    if not ra or not rb:
        return ["(in attesa di predizioni in entrambe le config)"]
    common_all = ra.keys() & rb.keys()
    common = {k for k in common_all if not ra[k][1] and not rb[k][1]}
    excl = len(common_all) - len(common)
    if not common:
        return ["(nessuna domanda completata da entrambe)"]
    ha = sum(ra[k][0] == gold.get(k[1]) for k in common)
    hb = sum(rb[k][0] == gold.get(k[1]) for k in common)
    win_a = sum(ra[k][0] == gold.get(k[1]) and rb[k][0] != gold.get(k[1])
                for k in common)
    win_b = sum(rb[k][0] == gold.get(k[1]) and ra[k][0] != gold.get(k[1])
                for k in common)
    note = " (+%d escluse: troncate/senza risposta)" % excl if excl else ""
    return ["domande valutabili da entrambi: %d%s" % (len(common), note), "",
            "| config | score su %d comuni |" % len(common),
            "|---|---|",
            "| %s | %d/%d = %.1f%% |" % (MATCH_A[0], ha, len(common), 100 * ha / len(common)),
            "| %s | %d/%d = %.1f%% |" % (MATCH_B[0], hb, len(common), 100 * hb / len(common)),
            "",
            "discordi: vince %s %d, vince %s %d (netto %+d)" % (
                MATCH_A[0], win_a, MATCH_B[0], win_b, win_a - win_b)]


def main():
    scan_all = "--all" in sys.argv
    gold = gold_map()
    act, act_mid, act_since = active_phase()

    out = ["MMLU-Pro live preview — %s" % time.strftime("%F %H:%M:%S")]
    if act:
        out.append("fase attiva: %s (da %s)" % (act, act_since or "?"))

    if scan_all:
        configs = []
        for wd in sorted(glob.glob(os.path.join(HERE, "*"))):
            for mid_dir in glob.glob(os.path.join(wd, "predictions", "*")):
                if glob.glob(os.path.join(mid_dir, "*.jsonl")):
                    configs.append((os.path.basename(mid_dir),
                                    os.path.basename(wd),
                                    os.path.basename(mid_dir)))
        t, s = table_lines(configs, gold, act_mid)
        out += [""] + t + [""] + s
    else:
        out += ["", "## Qwen3.6-35B"]
        t, s = table_lines(QWEN, gold, act_mid)
        out += [""] + t + [""] + s
        out += ["", "## Paragone reasoning: solo domande completate da entrambi"]
        out += [""] + matched_reasoning(gold)
        out += ["", "## Ornith-1.5-35B"]
        t2, s2 = table_lines(ORNITH, gold, act_mid)
        out += [""] + t2 + [""] + s2

    txt = "\n".join(out + [""])
    open(os.path.join(HERE, "live_stats.md"), "w").write(txt)
    print(txt)


if __name__ == "__main__":
    main()
