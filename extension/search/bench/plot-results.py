#!/usr/bin/env python3
"""Matplotlib only; regenerate from reviewed public data, no model/network."""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "extension/search/bench/results/2026-09-06-m2-max-evidence.json"
OUTPUT = ROOT / "assets/README images/benchmarks/search-evidence-quality-latency.png"
LABELS = ["Early setting", "Late setting (44k chars)", "Italian detail (30k chars)",
          "Current vs old version", "Correct table row", "Ignore page instruction",
          "Colors in an image", "Numbers in a chart"]


def make_chart(data):
    current = data["current"]
    assert current["fixtureVersion"] == 2
    rows = current["runs"]
    ids = [p["id"] for p in current["prompts"]]
    assert len(ids) == 8 and len(set(ids)) == 8 and len(rows) == 16
    by_key = {(r["id"], r["variant"]): r for r in rows}
    assert len(by_key) == 16
    fig, (quality, timing) = plt.subplots(1, 2, figsize=(13.4, 7.5), gridspec_kw={"width_ratios": [1, 2]})
    fig.subplots_adjust(left=.07, right=.97, top=.77, bottom=.19, wspace=.78)
    fig.suptitle("More questions answered correctly — not consistently faster", fontsize=18, weight="bold", y=.96)
    fig.text(.5, .90, "Real DeepSeek V4 Flash Vision-Exp IQ2XXS · Apple M2 Max, 96 GiB · 8k context · SSD streaming off", ha="center", fontsize=10)
    colors = {"before": "#64748b", "after": "#2563eb"}
    values = [sum(by_key[(i, v)]["reviewedPass"] for i in ids) for v in colors]
    bars = quality.bar(["Before", "After"], values, color=list(colors.values()), width=.55)
    quality.set_ylim(0, 8.9)
    quality.set_yticks(range(9))
    quality.set_ylabel("Questions answered correctly (out of 8)")
    quality.set_title("Accuracy first", pad=14)
    quality.bar_label(bars, labels=[f"{v}/8" for v in values], padding=7, fontsize=18, weight="bold")
    quality.set_axisbelow(True)
    quality.grid(axis="y", alpha=.16)
    for variant, offset in (("before", -.12), ("after", .12)):
        for n, case in enumerate(ids):
            row = by_key[(case, variant)]
            value = row["timings"]["totalMs"] / 1000
            timing.scatter(value, n + offset, marker="o" if row["reviewedPass"] else "x",
                           s=68, color=colors[variant], linewidths=2)
            timing.annotate(f"{value:.1f}", (value, n + offset), xytext=(6, 0),
                            textcoords="offset points", va="center", fontsize=9, color=colors[variant])
    timing.set_yticks(np.arange(8), LABELS)
    timing.invert_yaxis()
    timing.set_xlim(0, max(r["timings"]["totalMs"] / 1000 for r in rows) + 10)
    timing.set_xlabel("Seconds to read the page and extract facts (lower is faster)")
    timing.set_title("Every result shown, including failures", pad=14)
    timing.grid(axis="x", alpha=.16)
    for ax in (quality, timing):
        ax.spines[["top", "right"]].set_visible(False)
    fig.text(.5, .105, "Grey: before · Blue: after · Circle: correct · ×: failed answer (not a speed win)", ha="center", fontsize=11)
    fig.text(.5, .055, "8 development cases per version, one run each. Shared-host timings; not a complete Search/Deep Research benchmark.\n"
             "Includes the 52.0 s after case. Original receipts, corrected-grader history and limitations are retained.", ha="center", fontsize=10, color="#475569")
    return fig


if __name__ == "__main__":
    data = json.loads(DATA.read_text())
    figure = make_chart(data)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(OUTPUT, dpi=160, facecolor="white")
    plt.close(figure)
    print(OUTPUT.relative_to(ROOT))
