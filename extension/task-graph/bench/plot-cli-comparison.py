#!/usr/bin/env python3
"""Render the public DStudio, Pi and OpenCode reliability comparison."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RESULT = Path(__file__).with_name("results") / "2026-09-04-m2-max-diverse-agent-comparison-no-ssd.json"
DEFAULT_OUTPUT = ROOT / "assets" / "README images" / "benchmarks"

BLUE = "#2563EB"
TEAL = "#0F766E"
PURPLE = "#7C3AED"
ORANGE = "#F59E0B"
SLATE = "#64748B"
INK = "#172033"
GRID = "#D9E0EA"

VARIANTS = [
    ("nativeAgent", "Native Agent", BLUE),
    ("taskGraph", "DStudio checked", TEAL),
    ("pi", "Pi", PURPLE),
    ("opencode", "OpenCode", ORANGE),
]


def setup_style() -> None:
    plt.rcParams.update(
        {
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "axes.edgecolor": GRID,
            "axes.labelcolor": INK,
            "axes.titlecolor": INK,
            "xtick.color": INK,
            "ytick.color": INK,
            "text.color": INK,
            "font.family": "DejaVu Sans",
            "font.size": 11,
            "axes.grid": True,
            "grid.color": GRID,
            "grid.linewidth": 0.8,
            "axes.axisbelow": True,
        }
    )


def plot_overall(result: dict, output: Path) -> None:
    comparison = result["comparison"]
    values = [comparison[key]["completionRatePercent"] for key, _label, _color in VARIANTS]
    counts = [comparison[key]["tasksCompleted"] for key, _label, _color in VARIANTS]
    seconds = [comparison[key]["medianTaskMs"] / 1000 for key, _label, _color in VARIANTS]
    labels = [label for _key, label, _color in VARIANTS]
    colors = [color for _key, _label, color in VARIANTS]
    x = np.arange(len(VARIANTS))

    fig, (axis, latency_axis) = plt.subplots(1, 2, figsize=(13.2, 5.8))
    fig.subplots_adjust(left=0.07, right=0.98, bottom=0.2, top=0.72, wspace=0.25)
    fig.suptitle("50 diverse tasks, four agent paths", fontsize=18, weight="bold", y=0.96)
    fig.text(0.5, 0.86, "Ten balanced task families · full local model · correctness is the primary result",
             ha="center", color=SLATE)
    bars = axis.bar(x, values, width=0.62, color=colors)
    for bar, completed, percent in zip(bars, counts, values):
        axis.text(bar.get_x() + bar.get_width() / 2, percent + 2,
                  f"{completed}/50", ha="center", va="bottom", weight="bold", fontsize=12)
    axis.set_ylabel("Tasks completed (%)")
    axis.set_title("Correctness · higher is better", fontsize=12, weight="bold", pad=12)
    axis.set_xticks(x, labels)
    axis.set_ylim(0, 112)
    axis.set_yticks(np.arange(0, 101, 20))
    axis.grid(axis="y")
    axis.grid(axis="x", visible=False)
    axis.spines[["top", "right"]].set_visible(False)

    latency_bars = latency_axis.bar(x, seconds, width=0.62, color=colors)
    for bar, value in zip(latency_bars, seconds):
        latency_axis.text(bar.get_x() + bar.get_width() / 2, value + max(seconds) * 0.025,
                          f"{value:.2f} s", ha="center", va="bottom", weight="bold", fontsize=10)
    latency_axis.set_ylabel("Median task time (seconds)")
    latency_axis.set_title("Latency · lower is better", fontsize=12, weight="bold", pad=12)
    latency_axis.set_xticks(x, labels)
    latency_axis.set_ylim(0, max(seconds) * 1.2)
    latency_axis.grid(axis="y")
    latency_axis.grid(axis="x", visible=False)
    latency_axis.spines[["top", "right"]].set_visible(False)
    fig.savefig(output / "agent-harness-diverse-comparison.png", dpi=180, bbox_inches="tight")
    plt.close(fig)


def plot_by_task(result: dict, output: Path) -> None:
    comparison = result["comparison"]
    task_ids = [item["id"] for item in result["fixture"]["taskTypes"]]
    labels = [comparison["nativeAgent"]["byTask"][task_id]["label"] for task_id in task_ids]
    values = np.array([
        [comparison[key]["byTask"][task_id]["completionRatePercent"]
         for key, _label, _color in VARIANTS]
        for task_id in task_ids
    ])

    fig, axis = plt.subplots(figsize=(10.5, 8.2))
    fig.subplots_adjust(left=0.28, right=0.9, bottom=0.12, top=0.78)
    fig.suptitle("Correctness across ten task families", fontsize=18, weight="bold", y=0.97)
    fig.text(0.5, 0.9, "Five different fixtures per family · independent answer, file and test checks",
             ha="center", color=SLATE)
    image = axis.imshow(values, cmap="YlGn", vmin=0, vmax=100, aspect="auto")
    axis.set_xticks(np.arange(len(VARIANTS)), [label for _key, label, _color in VARIANTS])
    axis.set_yticks(np.arange(len(task_ids)), labels)
    axis.tick_params(axis="x", bottom=False, top=True, labelbottom=False, labeltop=True, pad=8)
    axis.tick_params(axis="y", length=0, pad=8)
    axis.grid(False)
    for row, task_id in enumerate(task_ids):
        for column, (key, _label, _color) in enumerate(VARIANTS):
            item = comparison[key]["byTask"][task_id]
            color = "white" if values[row, column] < 55 else INK
            axis.text(column, row, f"{item['completed']}/{item['runs']}", ha="center",
                      va="center", color=color, weight="bold", fontsize=11)
    colorbar = fig.colorbar(image, ax=axis, fraction=0.035, pad=0.04)
    colorbar.set_label("Tasks completed (%)")
    fig.savefig(output / "agent-harness-diverse-by-capability.png", dpi=180, bbox_inches="tight")
    plt.close(fig)


def main() -> None:
    result_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_RESULT
    output = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else DEFAULT_OUTPUT
    output.mkdir(parents=True, exist_ok=True)
    result = json.loads(result_path.read_text(encoding="utf-8"))
    setup_style()
    plot_overall(result, output)
    plot_by_task(result, output)
    print(f"task_graph_cli_comparison_plots: wrote 2 figures to {output}")


if __name__ == "__main__":
    main()
