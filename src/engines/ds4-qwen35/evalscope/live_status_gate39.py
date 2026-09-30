#!/Users/agrilv/venv312/bin/python
"""Live status round 3: gate[27-39] vs default8, per categoria (fatte/15, %, paired)."""
import ast, glob, json, os, re, time


os.environ["HF_HUB_OFFLINE"] = "1"
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


def active_params_estimate(server_log="/Users/agrilv/AI/antirez/ds4/server.log"):
    """Stima parametri attivi/token. def8: 3.0B fissi. gate39: 3B scala con
    gli esperti medi/token misurati (i layer gated 27-39 salgono a ~17-18)."""
    try:
        last = [l for l in open(server_log, errors="replace")
                if "experts/token avg" in l][-1]
        parts = last.split("|")[0].split()
        per_layer = [float(p.split(":")[1]) for p in parts
                     if re.match(r"^\d+:", p)]
        mean = sum(per_layer) / len(per_layer)
    except Exception:
        mean = 8.0
    return 3.0, 3.0 * mean / 8.0


def main():
    gold = gold_map()
    g = load(*GATE)
    d = load(*DEF)
    # default8 ha tutte le 210: percentuali per categoria sul totale fisso 15
    d_all = {}
    for (s, qid), v in d.items():
        d_all.setdefault(s, []).append(v[0] == gold.get(qid))
    subjects = sorted({s for s, _ in set(g) | set(d)})
    print("Round 3 LIVE — gate[27-39] N20 thr0.8 vs default8 — %s" %
          time.strftime("%H:%M:%S"))
    print("")
    hdr = "%-16s %6s  %-13s %-13s %-13s %+6s %5s %5s  %9s %8s" % (
        "categoria", "fatte", "gate39", "def8(comun)", "def8(tot15)",
        "delta", "g-vin", "d-vin", "tok g/def", "s g/def")
    print(hdr)
    print("-" * len(hdr))
    tg = td = twg = twd = ng = 0
    Tg = Td = Lg = Ld = 0
    for s in subjects:
        gk = {k for k in g if k[0] == s}
        dk = {k for k in d if k[0] == s}
        common = gk & dk
        hg = sum(g[k][0] == gold.get(k[1]) for k in common)
        hd = sum(d[k][0] == gold.get(k[1]) for k in common)
        wg = sum(g[k][0] == gold.get(k[1]) and d[k][0] != gold.get(k[1]) for k in common)
        wd_ = sum(d[k][0] == gold.get(k[1]) and g[k][0] != gold.get(k[1]) for k in common)
        tg += hg; td += hd; twg += wg; twd += wd_; ng += len(common)
        gh = [g[k][2] for k in common if not g[k][1] and g[k][2]]
        dh2 = [d[k][2] for k in common if not d[k][1] and d[k][2]]
        gl = [g[k][3] for k in common if not g[k][1] and g[k][3]]
        dl = [d[k][3] for k in common if not d[k][1] and d[k][3]]
        Tg += sum(gh); Td += sum(dh2); Lg += sum(gl); Ld += sum(dl)
        dh = d_all.get(s, [])
        g_col = ("%d/%d %3.0f%%" % (hg, len(common),
                 100 * hg / len(common))) if common else "-"
        dc_col = ("%d/%d %3.0f%%" % (hd, len(common),
                  100 * hd / len(common))) if common else "-"
        dt_col = ("%d/15 %3.0f%%" % (sum(dh), 100 * sum(dh) / 15)) if dh else "-"
        tcol = "%d/%d" % (sum(gh) / len(gh), sum(dh2) / len(dh2)) if gh and dh2 else "-"
        lcol = "%d/%d" % (sum(gl) / len(gl), sum(dl) / len(dl)) if gl and dl else "-"
        print("%-16s %6s  %-13s %-13s %-13s %+5d  %5d %5d  %9s %8s" % (
            s, "%d/15" % len(gk), g_col, dc_col, dt_col, hg - hd, wg, wd_,
            tcol, lcol))
    print("-" * len(hdr))
    print("%-16s %6s  %-13s %-13s %-13s %+5d  %5d %5d  %9s %8s" % (
        "TOTALE", "%d/210" % len(g), "%d/%d" % (tg, ng),
        "%d/%d" % (td, ng), "169/210 80.5%", tg - td, twg, twd,
        "%+d%%" % (100 * (Tg - Td) / Td) if Td else "-",
        "%+d%%" % (100 * (Lg - Ld) / Ld) if Ld else "-"))
    print("(tok g/def = token medi gate39/default8 sulle comuni; s g/def = secondi medi; totale in delta %)")
    p_def, p_gate = active_params_estimate()
    print("parametri attivi/token: default8 = %.2fB (fissi, 8 esperti) | "
          "gate39 = %.2fB (misurati ora; 3B scala con esperti attivi, "
          "~17-18 nei layer gated 27-39)" % (p_def, p_gate))
    return 0


if __name__ == "__main__":
    main()
