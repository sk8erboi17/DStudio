#!/usr/bin/env python3
"""Plot the Cowork document-fidelity comparison from published run files.

Each input is LABEL=FILE.json[,FILE.json...] (files written by publish.mjs).
For every Cowork case, the chart shows how many runs produced the exact
expected file bytes, per variant, with the run count on each bar.

  python3 plot-cowork-fidelity.py OUTPUT.png "Before=a.json,b.json" "After=c.json"
"""
import json
import sys
from collections import defaultdict

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

CASES = [("cowork-copy", "Copy a text file\n(ends with a newline)"),
         ("cowork-edit", "Revise one value\n(ends with a newline)"),
         ("cowork-copy-nonl", "Copy a text file\n(no final newline)"),
         ("cowork-new", "Write a new\none-line file")]

if len(sys.argv) < 3:
    sys.exit(__doc__)
output, specs = sys.argv[1], sys.argv[2:]
variants, meta = [], {}
for spec in specs:
    label, files = spec.split("=", 1)
    counts = defaultdict(lambda: [0, 0])
    for file in files.split(","):
        report = json.load(open(file, encoding="utf-8"))
        meta.setdefault("model", report["model"]["file"])
        meta.setdefault("context", report["model"]["context"])
        meta.setdefault("host", report["method"].get("hostLabel", ""))
        for run in report["runs"]:
            case = run.get("caseId") or run.get("id") or run.get("case")
            counts[case][0] += 1 if run.get("correct") else 0
            counts[case][1] += 1
    variants.append((label, counts))

fig, ax = plt.subplots(figsize=(10, 5.2))
width = 0.8 / len(variants)
colors = ["#9aa5b1", "#2f6fdf", "#3a9d5d"]
for v, (label, counts) in enumerate(variants):
    xs, ys, notes = [], [], []
    for i, (case, _) in enumerate(CASES):
        passed, total = counts.get(case, (0, 0))
        xs.append(i + (v - (len(variants) - 1) / 2) * width)
        ys.append(passed / total * 100 if total else 0)
        notes.append(f"{passed}/{total}" if total else "not run")
    bars = ax.bar(xs, ys, width * 0.92, label=label, color=colors[v % len(colors)])
    for bar, note in zip(bars, notes):
        ax.annotate(note, (bar.get_x() + bar.get_width() / 2, bar.get_height()), xytext=(0, 3),
                    textcoords="offset points", ha="center", va="bottom", fontsize=9)
ax.set_xticks(range(len(CASES)))
ax.set_xticklabels([name for _, name in CASES], fontsize=9)
ax.set_ylim(0, 115)
ax.set_ylabel("Runs with the exact expected file (%)")
ax.set_title("Cowork: exact file bytes after copying or revising a text file", fontsize=12, pad=28)
model = meta.get("model", "").replace(".gguf", "")
model = "DeepSeek V4 Flash Vision-Exp IQ2XXS" if "Vision-Exp-IQ2XXS" in model else model
ax.text(0.5, -0.2, f"{model} · {meta.get('context', '')} tokens of context · real engine on an M2 Max\n"
        f"{meta.get('host', '')}. Counts are runs per case; descriptive, not a quality score.",
        transform=ax.transAxes, ha="center", va="top", fontsize=8, color="#555")
ax.legend(frameon=False, fontsize=9, loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=len(variants))
ax.spines[["top", "right"]].set_visible(False)
fig.tight_layout()
fig.savefig(output, dpi=160)
print(output)
