#!/usr/bin/env python3
"""Full-question replays: independently reviewed answers, not model self-scores."""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "extension/search/bench/results"
OUTPUT = ROOT / "assets/README images/benchmarks/search-answer-review.png"
IDS = ["http-retry-header", "python-versioned-suffix", "venus-rotation-orbit", "accessible-target-comparison"]
LABELS = ["HTTP rule\nSearch", "Python version\nSearch", "Conflicting sources\nDeep Research", "Accessible controls\nDeep Research"]


def make_chart(previous, generic, parser_failure, unsupported_gap, definitions):
    series = []
    for data, label, color in (
        (previous, "Previous\nversion", "#64748b"),
        (generic, "First\nattempt", "#d97706"),
        (parser_failure, "Incomplete\nreport", "#7c3aed"),
        (unsupported_gap, "Unsupported\ndoubt", "#dc2626"),
        (definitions, "Latest\nversion", "#2563eb"),
    ):
        assert data["variants"] == ["after"] and len(data["runs"]) == 4
        rows = {row["id"]: row for row in data["runs"]}
        assert set(rows) == set(IDS)
        series.append((rows, label, color))
    fig, (quality, timing) = plt.subplots(1, 2, figsize=(17, 8), gridspec_kw={"width_ratios": [1.1, 1.65]})
    fig.subplots_adjust(left=.06, right=.98, bottom=.25, top=.78, wspace=.3)
    fig.suptitle("Does Research answer correctly and follow the request?", y=.97, weight="bold", fontsize=18)
    fig.text(.5, .91, "Two Search + two Deep Research questions per version · Real public web + local DeepSeek V4 Flash IQ2XXS",
             ha="center", fontsize=11)
    fig.text(.5, .86, "Facts, supporting sources, disclosed disagreements and requested length checked independently",
             ha="center", fontsize=10)
    scores = [sum(row["pass"] for row in rows.values()) for rows, _, _ in series]
    bars = quality.bar([label for _, label, _ in series], scores, color=[color for _, _, color in series], width=.6)
    quality.bar_label(bars, labels=[f"{score}/4" for score in scores], padding=7, fontsize=17, weight="bold")
    quality.set_ylim(0, 4.7); quality.set_yticks(range(5))
    quality.set_ylabel("Answers meeting every requirement")
    quality.set_title("Quality, not self-approval", pad=15)
    for index, (rows, label, color) in enumerate(series):
        ordered = [rows[key] for key in IDS]
        bars = timing.bar([i + (index - 2) * .17 for i in range(4)], [row["totalSeconds"] for row in ordered],
                          width=.17, color=color, edgecolor="#334155", linewidth=.4)
        for bar, row in zip(bars, ordered):
            if not row["pass"]: bar.set_hatch("///")
        timing.bar_label(bars, labels=[f'{row["totalSeconds"]:.0f}' for row in ordered], padding=4, fontsize=9)
    timing.set_xticks(range(4), LABELS)
    timing.set_ylim(0, max(row["totalSeconds"] for rows, _, _ in series for row in rows.values()) * 1.2)
    timing.set_ylabel("Seconds from question to final answer")
    timing.set_title("All durations, including failures", pad=15)
    for axis in (quality, timing):
        axis.spines[["top", "right"]].set_visible(False)
        axis.grid(axis="y", alpha=.15); axis.set_axisbelow(True)
    fig.legend(handles=[Patch(facecolor=color, label=label.replace("\n", " ")) for _, label, color in series] +
               [Patch(facecolor="white", edgecolor="#334155", hatch="///", label="Failed answer")],
               loc="lower center", bbox_to_anchor=(.5, .12), ncol=3, frameon=False, fontsize=9)
    fig.text(.5, .04, "M2 Max · 96 GiB · 32k context · SSD streaming off · One sample per question/version, separate development replays\n"
             "Shared-host load and live pages vary. Failures retained; this is not a general accuracy or speed guarantee.",
             ha="center", fontsize=10, color="#475569")
    return fig


if __name__ == "__main__":
    inputs = [json.loads((DATA / name).read_text()) for name in (
        "2026-09-06-pipeline-reviewed.json", "2026-09-06-review-generic.json",
        "2026-09-06-review-parser-failure.json", "2026-09-06-review-unsupported-gap.json",
        "2026-09-06-review-definitions.json")]
    fig = make_chart(*inputs)
    fig.savefig(OUTPUT, dpi=160, facecolor="white")
    plt.close(fig)
    print(OUTPUT.relative_to(ROOT))
