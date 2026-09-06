#!/usr/bin/env python3
"""Matplotlib chart of reviewed complete answers, including every failed case."""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "extension/search/bench/results"
OUTPUT = ROOT / "assets/README images/benchmarks/search-complete-pipeline.png"
IDS = ["http-retry-header", "python-versioned-suffix", "venus-rotation-orbit", "accessible-target-comparison"]
LABELS = ["HTTP rule\nSearch", "Python version\nSearch", "Venus periods\nDeep Research", "Accessible controls\nDeep Research"]


def make_chart(initial, replay, final):
    assert initial["variants"] == ["before", "after"] and replay["variants"] == final["variants"] == ["after"]
    assert len(initial["runs"]) == 8 and len(replay["runs"]) == len(final["runs"]) == 4
    series = []
    for data, variant, name, color in (
        (initial, "before", "Baseline", "#64748b"),
        (initial, "after", "First update", "#60a5fa"),
        (replay, "after", "Focused v1\n(rejected)", "#d97706"),
        (final, "after", "Focused v2\n(later replay)", "#166534"),
    ):
        rows = {r["id"]: r for r in data["runs"] if r["variant"] == variant}
        assert len(rows) == 4 and set(rows) == set(IDS)
        series.append((rows, name, color))
    fig, (quality, timing) = plt.subplots(1, 2, figsize=(14.4, 7.8), gridspec_kw={"width_ratios": [1, 1.8]})
    fig.subplots_adjust(left=.065, right=.98, top=.76, bottom=.28, wspace=.32)
    fig.suptitle("Can the complete answer be trusted?", fontsize=20, weight="bold", y=.97)
    fig.text(.5, .91, "Actual public web + local DeepSeek V4 Flash IQ2XXS · M2 Max, 96 GiB · 32k context · SSD streaming off",
             ha="center", fontsize=10)
    fig.text(.5, .86, "Four questions per version · Checked facts, source support, conflicting definitions and requested length",
             ha="center", fontsize=10)
    values = [sum(r["pass"] for r in rows.values()) for rows, _, _ in series]
    bars = quality.bar([name for _, name, _ in series], values, color=[c for _, _, c in series], width=.62)
    quality.bar_label(bars, labels=[f"{v}/4" for v in values], padding=8, weight="bold", fontsize=17)
    quality.set_ylim(0, 4.7)
    quality.set_yticks(range(5))
    quality.set_ylabel("Answers meeting all requirements")
    quality.set_title("Correctness before speed", pad=16)
    quality.grid(axis="y", alpha=.15)
    quality.set_axisbelow(True)
    width = .19
    for n, (rows, name, color) in enumerate(series):
        ordered = [rows[i] for i in IDS]
        bars = timing.bar([i + (n - 1.5) * width for i in range(4)],
                          [r["totalSeconds"] for r in ordered], width=width,
                          label=name.replace("\n", " "), color=color, edgecolor="#334155", linewidth=.4)
        for bar, row in zip(bars, ordered):
            if not row["pass"]:
                bar.set_hatch("///")
        timing.bar_label(bars, labels=[f'{r["totalSeconds"]:.0f}' for r in ordered], padding=3, fontsize=9)
    timing.set_xticks(range(4), LABELS)
    timing.set_ylim(0, max(r["totalSeconds"] for rows, _, _ in series for r in rows.values()) * 1.18)
    timing.set_ylabel("Seconds until the final answer (lower is faster)")
    timing.set_title("Every duration, including failed answers", pad=16)
    timing.grid(axis="y", alpha=.15)
    timing.set_axisbelow(True)
    for ax in (quality, timing):
        ax.spines[["top", "right"]].set_visible(False)
    fig.legend(handles=[Patch(facecolor=color, label=name.replace("\n", " ")) for _, name, color in series] +
               [Patch(facecolor="white", edgecolor="#334155", hatch="///", label="Failed answer: not a speed win")],
               loc="lower center", bbox_to_anchor=(.5, .13), ncol=3, frameon=False, fontsize=10)
    fig.text(.5, .06, "Baseline and first update: alternating paired run. Each focused version: a separate later replay of all four questions.\n"
             "One sample per case; live pages and shared-host load can change. Development evidence, not a general ranking.",
             ha="center", fontsize=10, color="#475569")
    return fig


if __name__ == "__main__":
    initial = json.loads((DATA / "2026-09-06-pipeline-initial.json").read_text())
    replay = json.loads((DATA / "2026-09-06-pipeline-focused.json").read_text())
    final = json.loads((DATA / "2026-09-06-pipeline-reviewed.json").read_text())
    fig = make_chart(initial, replay, final)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUTPUT, dpi=160, facecolor="white")
    plt.close(fig)
    print(OUTPUT.relative_to(ROOT))
