#!/Users/agrilv/venv312/bin/python
"""Live status round-4: q35-default8-r4 vs q35-exp20-thr08-gate27-39-r4, per categoria.
504 domande nuove (slice 15-50 per materia), budget reasoning 8K, batching 4x."""
import ast, glob, json, os, re, sys, time


os.environ["HF_HUB_OFFLINE"] = "1"
DEF = ("runD4-def8", "q35-default8-r4")
GATE = ("runE4-gate39", "q35-exp20-thr08-gate27-39-r4")
HERE = os.path.dirname(os.path.abspath(__file__))
NEW_MIN, NEW_MAX = 15, 50


def gold_map():
    from datasets import load_dataset
    ds = load_dataset("TIGER-Lab/MMLU-Pro", split="test")
    return {r["question_id"]: r["answer"] for r in ds}


def load(wd, mid):
    rows = {}
    for f in glob.glob(os.path.join(HERE, wd, "predictions", mid, "*.jsonl")):
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
            try:
                qidx = int(r["index"])   # position within the subject subset
            except Exception:
                qidx = None
            raw = str(r.get("model_output", ""))
            L = re.findall(r"ANSWER:\s*\(?([A-J])\b", raw, re.I)
            pred = L[-1].upper() if L else None
            sr = re.search(r"'stop_reason': '(\w+)'", raw)
            trunc = bool(sr and sr.group(1) in ("max_tokens", "length"))
            m = re.search(r"'output_tokens': (\d+)", raw)
            la = re.search(r"'latency': ([0-9.]+)", raw)
            if (subj, qid) in rows:
                continue
            rows[(subj, qid)] = (pred, trunc, int(m.group(1)) if m else 0,
                                 float(la.group(1)) if la else 0.0, qidx)
    return rows


DEF_NAME = 'def8   "Qwen 3.6 35B A3B (reference implementation)"'
GATE_NAME = 'gate39 "Qwen 3.6 35B A3B->A4B+ (expert expansion)"'


def main():
    gold = gold_map()
    d = load(*DEF)
    g = load(*GATE)
    print("LIVE ROUND-4 — 35B native vs 35B expanded — 714 questions (51/subject, "
          "incl. the 210 re-done at 8K), 8K budget, serial decode — %s" % time.strftime("%H:%M:%S"))
    print("")
    print("Legend:")
    print("  " + DEF_NAME)
    print("  " + GATE_NAME)
    print("")
    hdr = "%-16s %-18s %-18s" % ("subject", "35B native", "35B expanded")
    print(hdr)
    print("-" * len(hdr))
    Td = Tg = 0
    nq = 0
    nd_new = ng_new = 0
    subjects = sorted({s for s, _ in set(d) | set(g)})
    for s in subjects:
        dk = {k for k in d if k[0] == s}
        gk = {k for k in g if k[0] == s}
        common = dk & gk
        if not common:
            continue
        hd = sum(d[k][0] == gold.get(k[1]) for k in common)
        hg = sum(g[k][0] == gold.get(k[1]) for k in common)
        Td += hd; Tg += hg; nq += len(common)
        nd_new += sum(1 for k in common
                      if d[k][4] is not None and NEW_MIN <= d[k][4] <= NEW_MAX)
        print("%-16s %-18s %-18s" % (
            s,
            "%d/%d" % (hd, len(common)),
            "%d/%d" % (hg, len(common))))
    print("-" * len(hdr))
    if nq:
        print("%-16s %-18s %-18s" % (
            "TOTAL",
            "%d/%d" % (Td, nq),
            "%d/%d" % (Tg, nq)))
        print("%-16s %-18.3f %-18.3f" % ("SCORE", Td / nq, Tg / nq))
    print("(common questions answered: %d of 714 (of which %d in the new 15-50 slice) "
          "| def8 rows: %d | gate39 rows: %d)" % (nq, nd_new, len(d), len(g)))

    # --- paired win decomposition: are expanded's wins genuine or budget-driven? ---
    wins_native = wins_genuine = wins_budget = wins_noans = 0
    losses_genuine = losses_budget = losses_noans = ties = 0
    for k in set(d) & set(g):
        pd_, tg_ = d[k][0], d[k][1]
        pg_, tgg = g[k][0], g[k][1]
        cd = pd_ == gold.get(k[1])
        cg = pg_ == gold.get(k[1])
        if cd and cg:
            ties += 1
        elif cg and not cd:
            wins_native += 1
            # why did native lose: truncated, or answered but wrong?
            if tg_:
                wins_budget += 1
            elif pd_ is None:
                wins_noans += 1
            else:
                wins_genuine += 1
        elif cd and not cg:
            losses_genuine += 1
            if tgg:
                losses_budget += 1
            elif pg_ is None:
                losses_noans += 1
    print("")
    print("Paired win decomposition (common questions):")
    print("  expanded wins over native: %d = genuine (both in budget, only expanded right) %d "
          "+ native-truncated %d + native-no-answer %d" % (
              wins_native, wins_genuine, wins_budget, wins_noans))
    print("  native wins over expanded: %d = genuine %d (+ expanded-truncated %d, "
          "expanded-no-answer %d)" % (losses_genuine, losses_genuine - losses_budget - losses_noans,
                                      losses_budget, losses_noans))
    print("")
    print(">>> BOTH CORRECT (ties): %d of %d common (%.1f%%) — both models right, "
          "efficiency compared on these below" % (
              ties, nq, 100.0 * ties / nq if nq else 0.0) + " <<<")
    print("")

    # --- token savings on ties (both correct): efficiency isolated from correctness ---
    tk_d, tk_g, lat_d, lat_g = [], [], [], []
    for k in set(d) & set(g):
        if d[k][0] is None or g[k][0] is None:
            continue
        if not (d[k][0] == gold.get(k[1]) and g[k][0] == gold.get(k[1])):
            continue
        if d[k][1] or g[k][1] or d[k][2] == 0 or g[k][2] == 0:
            continue
        tk_d.append(d[k][2]); tk_g.append(g[k][2])
        if d[k][3] > 0 and g[k][3] > 0:
            lat_d.append(d[k][3]); lat_g.append(g[k][3])
    if tk_d:
        md_ = sum(tk_d) / len(tk_d)
        mg_ = sum(tk_g) / len(tk_g)
        save = 100.0 * (md_ - mg_) / md_
        print("")
        print("Ties-only efficiency (both correct, non-truncated, %d questions):" % len(tk_d))
        print("  native:   %6.0f mean tok" % md_)
        print("  expanded: %6.0f mean tok  (%+.1f%% token saving)" % (mg_, save))
        paired = [(a, b) for a, b in zip(lat_d, lat_g) if a > 0 and b > 0]
        if lat_d:
            ld_ = sum(lat_d) / len(lat_d)
            lg_ = sum(lat_g) / len(lat_g)
            print("  latency:  %.0fs vs %.0fs  (%+.1f%% time saving)" % (
                ld_, lg_, 100.0 * (ld_ - lg_) / ld_))
        wins_tok = sum(1 for a, b in zip(tk_d, tk_g) if b < a)
        print("  expanded cheaper on %d/%d ties (%.0f%%)" % (
            wins_tok, len(tk_d), 100.0 * wins_tok / len(tk_d)))

        # --- per-subject ties table: mean tokens / latency for both configs ---
        acc = {}
        for k in set(d) & set(g):
            pd_, td_, tkd_, ld_ = d[k][:4]
            pg, tg, tkg, lg = g[k][:4]
            if pd_ is None or pg is None:
                continue
            if not (pd_ == gold.get(k[1]) and pg == gold.get(k[1])):
                continue
            if td_ or tg or tkd_ == 0 or tkg == 0:
                continue
            a = acc.setdefault(k[0], [0, 0, 0.0, 0.0, 0])
            a[0] += tkd_; a[1] += tkg; a[2] += ld_; a[3] += lg; a[4] += 1
        print("")
        print("Ties-only efficiency by subject (both correct, non-truncated):")
        hdr2 = "%-16s %6s %10s %10s %12s %12s %9s" % (
            "subject", "n", "nat tok", "exp tok", "nat lat s", "exp lat s", "tok saving")
        print(hdr2)
        print("-" * len(hdr2))
        for s in sorted(acc):
            v = acc[s]
            n_ = v[4]
            mt_d, mt_g = v[0] / n_, v[1] / n_
            ml_d, ml_g = v[2] / n_, v[3] / n_
            sv = 100.0 * (mt_d - mt_g) / mt_d if mt_d else 0.0
            print("%-16s %6d %10.0f %10.0f %12.0f %12.0f %8.1f%%" % (
                s, n_, mt_d, mt_g, ml_d, ml_g, sv))
        if acc:
            T = [sum(v[i] for v in acc.values()) for i in range(5)]
            tmd, tmg = T[0] / T[4], T[1] / T[4]
            print("-" * len(hdr2))
            print("%-16s %6d %10.0f %10.0f %12.0f %12.0f %8.1f%%" % (
                "TOTAL", T[4], tmd, tmg, T[2] / T[4], T[3] / T[4],
                100.0 * (tmd - tmg) / tmd if tmd else 0.0))

    # --- per-config stats on ALL their own rows (not just the common pair) ---
    def all_row_stats(rows):
        corr = sum(1 for k, v in rows.items() if v[0] == gold.get(k[1]))
        trunc = sum(1 for v in rows.values() if v[1])
        noans = sum(1 for v in rows.values() if not v[1] and v[0] is None)
        return corr, trunc, noans

    print("")
    print("ALL questions answered by each config (own rows, not paired):")
    print("%-18s %8s %8s %10s %10s %8s" % ("config", "n", "correct", "score", "trunc", "no-ans"))
    for name, rows in (("35B native", d), ("35B expanded", g)):
        if not rows:
            continue
        corr, trunc, noans = all_row_stats(rows)
        print("%-18s %8d %8d %9.3f %10d %8d" % (
            name, len(rows), corr, corr / len(rows), trunc, noans))

    def cost_stats(rows):
        ok = [v for v in rows.values() if v[2] > 0 and not v[1]]
        toks = [v[2] for v in ok]
        lats = [v[3] for v in ok]
        return (sum(toks) / len(toks) if toks else 0.0,
                sum(lats) / len(lats) if lats else 0.0, len(ok))

    sd, ld_s, nd_ = cost_stats(d)
    sg, lg_s, ng_ = cost_stats(g)
    print("")
    print("Mean cost per answer (non-truncated only):")
    print("%-18s %12s %12s %8s" % ("config", "mean tok", "latency s", "n"))
    for name, t, l, n in (("35B native", sd, ld_s, nd_),
                          ("35B expanded", sg, lg_s, ng_)):
        print("%-18s %12.0f %12.0f %8d" % (name, t, l, n))

    def heavy_paired(rows_a, rows_b, thr=2000):
        # pair = question answered by both, non-truncated; enters if EITHER
        # side spent > thr tokens, then both sides' tokens join their mean
        ok = lambda rows: {k: v[2] for k, v in rows.items()
                           if not v[1] and v[2] > 0}
        oa, ob = ok(rows_a), ok(rows_b)
        keys = set(oa) & set(ob)
        heavy = [k for k in keys if oa[k] > thr or ob[k] > thr]
        ma = sum(oa[k] for k in heavy) / len(heavy) if heavy else 0.0
        mb = sum(ob[k] for k in heavy) / len(heavy) if heavy else 0.0
        return ma, mb, len(heavy), len(keys)

    htd, htg, hnp, hnc = heavy_paired(d, g)
    print("")
    print("Mean tokens on paired heavy questions (pair counted if EITHER side "
          "> 2000 tok, non-truncated):")
    print("%-18s %12s %10s %14s" % ("config", "mean tok", "pairs", "of common"))
    for name, t in (("35B native", htd), ("35B expanded", htg)):
        pct = 100.0 * hnp / hnc if hnc else 0.0
        print("%-18s %12.0f %10d %13.1f%%" % (name, t, hnp, pct))

    def wtps(rows):
        # weighted tok/s: sum(tokens) / sum(latency) over non-truncated answered
        ok = [v for v in rows.values() if v[2] > 0 and not v[1] and v[3] > 0]
        if not ok:
            return 0.0
        return sum(v[2] for v in ok) / sum(v[3] for v in ok)

    wd_, wg_ = wtps(d), wtps(g)
    print("")
    print("Weighted throughput (sum tok / sum latency, non-truncated):")
    for name, w in (("35B native", wd_), ("35B expanded", wg_)):
        print("%-18s %12.1f tok/s" % (name, w))
    return 0


if __name__ == "__main__":
    sys.exit(main())
