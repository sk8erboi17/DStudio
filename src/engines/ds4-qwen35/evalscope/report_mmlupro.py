#!/usr/bin/env python3
"""Generate a markdown MMLU-Pro comparison from evalscope report dirs.
Usage: report_mmlupro.py OUT.md TITLE mid1 wd1 [mid2 wd2 ...]"""
import json, os, re, sys

out_path, title = sys.argv[1], sys.argv[2]
entries = [(sys.argv[i], sys.argv[i + 1]) for i in range(3, len(sys.argv), 2)]

rows = []
subset_names = []
for mid, wd in entries:
    p = os.path.join(wd, "reports", mid, "mmlu_pro.json")
    try:
        d = json.load(open(p))
        score, num = d["score"], d["num"]
        subs = {s["name"]: s["score"] for s in
                d["metrics"][0]["categories"][0]["subsets"]}
    except Exception:
        score, num, subs = None, 0, {}
    for s in subs:
        if s not in subset_names:
            subset_names.append(s)
    pace = ""
    lg = wd + ".log"
    if os.path.exists(lg):
        paces = re.findall(r"([0-9.]+)s/it", open(lg, errors="ignore").read())
        if paces:
            tail = [float(x) for x in paces[-20:]]
            pace = "%.0f" % (sum(tail) / len(tail))
    rows.append((mid, num, score, pace, subs))

lines = ["# " + title, "",
         "| config | n | MMLU-Pro | s/sample |",
         "|---|---|---|---|"]
for mid, num, score, pace, subs in rows:
    sc = "%.1f%%" % (100 * score) if score is not None else "FAILED"
    lines.append("| %s | %d | %s | %s |" % (mid, num, sc, pace or "-"))
if subset_names:
    lines += ["", "| subset | " + " | ".join(r[0] for r in rows) + " |",
              "|" + "---|" * (len(rows) + 1)]
    for s in subset_names:
        cells = []
        for r in rows:
            v = r[4].get(s)
            cells.append("%.0f%%" % (100 * v) if v is not None else "-")
        lines.append("| %s | %s |" % (s, " | ".join(cells)))
lines.append("")
open(out_path, "w").write("\n".join(lines))
print("wrote", out_path)
