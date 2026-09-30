#!/Users/agrilv/venv312/bin/python
"""Live status comparativo: qwen27b vs gate[27-39] vs default8, per categoria."""
import ast, glob, json, os, re, time


os.environ["HF_HUB_OFFLINE"] = "1"
Q27 = ("runH-qwen27b-pro", "qwen38-27b-nvfp4")
GATE = ("runG-gate39-pro", "q35-exp20-thr08-gate27-39")
DEF = ("runB-pro-full", "q35-default8")
HERE = os.path.dirname(os.path.abspath(__file__))


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
            raw = str(r.get("model_output", ""))
            L = re.findall(r"ANSWER:\s*\(?([A-J])\b", raw, re.I)
            pred = L[-1].upper() if L else None
            sr = re.search(r"'stop_reason': '(\w+)'", raw)
            trunc = bool(sr and sr.group(1) in ("max_tokens", "length"))
            m = re.search(r"'output_tokens': (\d+)", raw)
            la = re.search(r"'latency': ([0-9.]+)", raw)
            rows[(subj, qid)] = (pred, trunc, int(m.group(1)) if m else 0,
                                 float(la.group(1)) if la else 0.0)
    return rows


Q27_NAME = 'q27b   "Qwen 3.8 27B nvfp4 (reference implementation)"'
GATE_NAME = 'gate39 "Qwen 3.6 35B A3B->A4B+ (expert expansion)"'
DEF_NAME = 'def8   "Qwen 3.6 35B A3B (reference implementation)"'


def main():
    gold = gold_map()
    q = load(*Q27)
    g = load(*GATE)
    d = load(*DEF)
    print("LIVE — 27B nvfp4 dense vs 35B expanded vs 35B native — %s" %
          time.strftime("%H:%M:%S"))
    print("")
    print("Legend:")
    print("  " + Q27_NAME)
    print("  " + GATE_NAME)
    print("  " + DEF_NAME)
    print("")
    hdr = "%-16s %-18s %-18s %-18s" % (
        "subject", "27B nvfp4 dense", "35B expanded", "35B native")
    print(hdr)
    print("-" * len(hdr))
    TQ = Tg = Td = 0
    nq = 0
    subjects = sorted({s for s, _ in set(q) | set(g) | set(d)})
    for s in subjects:
        qk = {k for k in q if k[0] == s}
        gk = {k for k in g if k[0] == s}
        dk = {k for k in d if k[0] == s}
        common = qk & dk          # domande fatte da q27b (def8 ha tutto)
        hq = sum(q[k][0] == gold.get(k[1]) for k in common)
        hg = sum(g[k][0] == gold.get(k[1]) for k in common)
        hd = sum(d[k][0] == gold.get(k[1]) for k in common)
        TQ += hq; Tg += hg; Td += hd
        nq += len(common)
        if common:
            print("%-16s %-18s %-18s %-18s" % (
                s,
                "%d/%d" % (hq, len(common)),
                "%d/%d" % (hg, len(common)),
                "%d/%d" % (hd, len(common))))
    print("-" * len(hdr))
    print("%-16s %-18s %-18s %-18s" % (
        "TOTAL",
        "%d/%d" % (TQ, nq) if nq else "-",
        "%d/%d" % (Tg, nq) if nq else "-",
        "%d/%d" % (Td, nq) if nq else "-"))
    if nq:
        print("%-16s %-18.3f %-18.3f %-18.3f" % (
            "SCORE", TQ / nq, Tg / nq, Td / nq))
    print("(all columns on the same %d questions completed by both the 27B "
          "and 35B native; 27B total done: %d/210)" % (nq, len(q)))

    # Cost summary: mean tokens and latency over non-truncated answers only
    def cost_stats(rows):
        ok = [v for v in rows.values() if v[2] > 0 and not v[1]]
        toks = [v[2] for v in ok]
        lats = [v[3] for v in ok]
        return (sum(toks) / len(toks) if toks else 0.0,
                sum(lats) / len(lats) if lats else 0.0, len(ok))

    sq, lq_s, nq_ = cost_stats(q)
    sg, lg_s, ng_ = cost_stats(g)
    sd, ld_s, nd_ = cost_stats(d)
    worst_tok = max(sq, sg, sd)
    worst_lat = max(lq_s, lg_s, ld_s)
    print("")
    print("Mean cost per answer (non-truncated only; savings vs worst):")
    print("%-18s %16s %18s %8s" % ("config", "mean tok", "latency s", "n"))
    for name, t, l, n in (("27B nvfp4 dense", sq, lq_s, nq_),
                          ("35B expanded", sg, lg_s, ng_),
                          ("35B native", sd, ld_s, nd_)):
        print("%-18s %10.0f (%+3.0f%%) %9.0f (%+3.0f%%) %5d" % (
            name, t, 100 * (t - worst_tok) / worst_tok,
            l, 100 * (l - worst_lat) / worst_lat, n))
    return 0


if __name__ == "__main__":
    main()
