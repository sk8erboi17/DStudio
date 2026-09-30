#!/Users/agrilv/venv312/bin/python
"""Live status GPQA-MC: q35-default8-gpqa vs q35-exp20-thr08-gate27-39-gpqa.
198 questions (biology/physics/chemistry), 8K budget, serial decode.
Same sections as live_status_round4: paired score, win decomposition,
ties-only efficiency (aggregate + per-domain)."""
import ast, glob, json, os, re, sys, time

from gpqa_adapter_local import gold_map

DEF = ("gpqa-def8", "q35-default8-gpqa")
GATE = ("gpqa-gate39", "q35-exp20-thr08-gate27-39-gpqa")
HERE = os.path.dirname(os.path.abspath(__file__))


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
                qid, dom = int(md["question_id"]), md["domain"]
            except Exception:
                continue
            raw = str(r.get("model_output", ""))
            L = re.findall(r"ANSWER:\s*\(?([A-D])\b", raw, re.I)
            pred = L[-1].upper() if L else None
            sr = re.search(r"'stop_reason': '(\w+)'", raw)
            trunc = bool(sr and sr.group(1) in ("max_tokens", "length"))
            m = re.search(r"'output_tokens': (\d+)", raw)
            la = re.search(r"'latency': ([0-9.]+)", raw)
            if (dom, qid) in rows:
                continue
            rows[(dom, qid)] = (pred, trunc, int(m.group(1)) if m else 0,
                                float(la.group(1)) if la else 0.0)
    return rows


DEF_NAME = 'def8   "Qwen 3.6 35B A3B (reference implementation)"'
GATE_NAME = 'gate39 "Qwen 3.6 35B A3B->A4B+ (expert expansion)"'


def main():
    gold = gold_map()
    d = load(*DEF)
    g = load(*GATE)
    print("LIVE GPQA-DIAMOND — 35B native vs 35B expanded — 198 questions, "
          "8K budget, serial decode — %s" % time.strftime("%H:%M:%S"))
    print("")
    print("Legend:")
    print("  " + DEF_NAME)
    print("  " + GATE_NAME)
    print("")
    hdr = "%-12s %-18s %-18s" % ("domain", "35B native", "35B expanded")
    print(hdr)
    print("-" * len(hdr))
    Td = Tg = 0
    nq = 0
    for s in sorted({k[0] for k in set(d) | set(g)}):
        common = {k for k in set(d) & set(g) if k[0] == s}
        if not common:
            continue
        hd = sum(d[k][0] == gold.get(k[1]) for k in common)
        hg = sum(g[k][0] == gold.get(k[1]) for k in common)
        Td += hd; Tg += hg; nq += len(common)
        print("%-12s %-18s %-18s" % (
            s, "%d/%d" % (hd, len(common)), "%d/%d" % (hg, len(common))))
    print("-" * len(hdr))
    if nq:
        print("%-12s %-18s %-18s" % ("TOTAL", "%d/%d" % (Td, nq), "%d/%d" % (Tg, nq)))
        print("%-12s %-18.3f %-18.3f" % ("SCORE", Td / nq, Tg / nq))
    print("(common questions answered: %d of 198 | def8 rows: %d | gate39 rows: %d)"
          % (nq, len(d), len(g)))

    # --- paired win decomposition ---
    wins_native = wins_genuine = wins_budget = wins_noans = 0
    losses_genuine = losses_budget = losses_noans = ties = 0
    for k in set(d) & set(g):
        pd_, td_ = d[k][0], d[k][1]
        pg, tgg = g[k][0], g[k][1]
        cd = pd_ == gold.get(k[1])
        cg = pg == gold.get(k[1])
        if cd and cg:
            ties += 1
        elif cg and not cd:
            wins_native += 1
            if td_:
                wins_budget += 1
            elif pd_ is None:
                wins_noans += 1
            else:
                wins_genuine += 1
        elif cd and not cg:
            losses_genuine += 1
            if tgg:
                losses_budget += 1
            elif pg is None:
                losses_noans += 1
    print("")
    print("Paired win decomposition (common questions):")
    print("  expanded wins over native: %d = genuine %d + native-truncated %d "
          "+ native-no-answer %d" % (
              wins_native, wins_genuine, wins_budget, wins_noans))
    print("  native wins over expanded: %d = genuine %d (+ expanded-truncated %d, "
          "expanded-no-answer %d)" % (
              losses_genuine, losses_genuine - losses_budget - losses_noans,
              losses_budget, losses_noans))
    print("")
    print(">>> BOTH CORRECT (ties): %d of %d common (%.1f%%) <<<" % (
        ties, nq, 100.0 * ties / nq if nq else 0.0))

    # --- ties-only efficiency ---
    acc = {}
    tk_d = tk_g = 0
    lat_d = lat_g = 0.0
    n_ties = 0
    for k in sorted(set(d) & set(g)):
        pd_, td_, tkd_, ld_ = d[k][:4]
        pg, tg, tkg, lg = g[k][:4]
        if pd_ is None or pg is None:
            continue
        if not (pd_ == gold.get(k[1]) and pg == gold.get(k[1])):
            continue
        if td_ or tg or tkd_ == 0 or tkg == 0:
            continue
        tk_d += tkd_; tk_g += tkg
        lat_d += ld_; lat_g += lg
        n_ties += 1
        a = acc.setdefault(k[0], [0, 0, 0.0, 0.0, 0])
        a[0] += tkd_; a[1] += tkg; a[2] += ld_; a[3] += lg; a[4] += 1
    if n_ties:
        print("")
        print("Ties-only efficiency (both correct, non-truncated, %d questions):" % n_ties)
        print("  native:   %6d tot tok  (%.0f mean)" % (tk_d, tk_d / n_ties))
        print("  expanded: %6d tot tok  (%.0f mean)  (%+.1f%% token saving)" % (
            tk_g, tk_g / n_ties, 100.0 * (tk_d - tk_g) / tk_d if tk_d else 0.0))
        if lat_d:
            print("  latency:  %.0fs vs %.0fs tot  (%+.1f%% time saving)" % (
                lat_d, lat_g, 100.0 * (lat_d - lat_g) / lat_d if lat_d else 0.0))
        print("")
        print("Ties-only efficiency by domain (both correct, non-truncated):")
        hdr2 = "%-12s %6s %10s %10s %12s %12s %9s" % (
            "domain", "n", "nat tok", "exp tok", "nat lat s", "exp lat s", "tok saving")
        print(hdr2)
        print("-" * len(hdr2))
        T = [0, 0, 0.0, 0.0, 0]
        for s in sorted(acc):
            v = acc[s]
            n_ = v[4]
            mt_d, mt_g = v[0] / n_, v[1] / n_
            sv = 100.0 * (mt_d - mt_g) / mt_d if mt_d else 0.0
            print("%-12s %6d %10.0f %10.0f %12.0f %12.0f %8.1f%%" % (
                s, n_, mt_d, mt_g, v[2] / n_, v[3] / n_, sv))
            for i in range(5):
                T[i] += v[i]
        print("-" * len(hdr2))
        print("%-12s %6d %10.0f %10.0f %12.0f %12.0f %8.1f%%" % (
            "TOTAL", T[4], T[0] / T[4], T[1] / T[4], T[2] / T[4], T[3] / T[4],
            100.0 * (T[0] - T[1]) / T[0] if T[0] else 0.0))

    # --- own-row stats ---
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
        # pair enters if EITHER side spent > thr tokens (non-truncated)
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
        ok = [v for v in rows.values() if v[2] > 0 and not v[1] and v[3] > 0]
        if not ok:
            return 0.0
        return sum(v[2] for v in ok) / sum(v[3] for v in ok)

    wd_, wg_ = wtps(d), wtps(g)
    print("")
    print("Weighted throughput (sum tok / sum latency, non-truncated):")
    for name, w in (("35B native", wd_), ("35B expanded", wg_)):
        print("%-18s %12.1f tok/s" % (name, w))

    # --- per-domain mean tokens/latency on ALL own answered rows ---
    def dom_cost(rows):
        acc = {}
        for k, v in rows.items():
            if v[1] or v[2] == 0:
                continue
            a = acc.setdefault(k[0], [0, 0.0, 0])
            a[0] += v[2]; a[1] += v[3]; a[2] += 1
        return acc

    ad, ag = dom_cost(d), dom_cost(g)
    doms = sorted(set(ad) | set(ag))
    if doms:
        print("")
        print("Mean tokens/latency by domain (own rows, non-truncated):")
        hdr3 = "%-12s %14s %20s %20s" % (
            "domain", "n (nat/exp)", "native tok / lat s", "expanded tok / lat s")
        print(hdr3)
        print("-" * len(hdr3))
        for s in doms:
            vd, vg = ad.get(s), ag.get(s)
            ndd = vd[2] if vd else 0
            ngg = vg[2] if vg else 0
            dt = "%d / %.0f" % (vd[0] / ndd, vd[1] / ndd) if vd else "–"
            gt = "%d / %.0f" % (vg[0] / ngg, vg[1] / ngg) if vg else "–"
            print("%-12s %7d/%-6d %20s %20s" % (s, ndd, ngg, dt, gt))
    return 0


if __name__ == "__main__":
    sys.path.insert(0, HERE)
    sys.exit(main())
