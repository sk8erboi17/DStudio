#!/usr/bin/env python3
"""Render the public DStudio, Pi and OpenCode reliability comparison."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RESULT = Path(__file__).with_name("results") / "2026-09-04-m2-max-agent-comparison-no-ssd.json"
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
    labels = [label for _key, label, _color in VARIANTS]
    colors = [color for _key, _label, color in VARIANTS]
    x = np.arange(len(VARIANTS))

    fig, axis = plt.subplots(figsize=(10.8, 5.8))
    fig.subplots_adjust(left=0.09, right=0.97, bottom=0.2, top=0.72)
    fig.suptitle("Same 50 tasks, four agent paths", fontsize=18, weight="bold", y=0.96)
    fig.text(0.5, 0.86, "Tasks actually completed · higher is better · full local model",
             ha="center", color=SLATE)
    bars = axis.bar(x, values, width=0.62, color=colors)
    for bar, completed, percent in zip(bars, counts, values):
        axis.text(bar.get_x() + bar.get_width() / 2, percent + 2,
                  f"{completed}/50", ha="center", va="bottom", weight="bold", fontsize=12)
    axis.set_ylabel("Tasks completed (%)")
    axis.set_xticks(x, labels)
    axis.set_ylim(0, 112)
    axis.set_yticks(np.arange(0, 101, 20))
    axis.grid(axis="y")
    axis.grid(axis="x", visible=False)
    axis.spines[["top", "right"]].set_visible(False)
    fig.savefig(output / "agent-harness-comparison.png", dpi=180, bbox_inches="tight")
    plt.close(fig)


def plot_by_task(result: dict, output: Path) -> None:
    comparison = result["comparison"]
    task_ids = ["read-fact", "write-file", "repair-code"]
    labels = [comparison["nativeAgent"]["byTask"][task_id]["label"] for task_id in task_ids]
    x = np.arange(len(task_ids))
    width = 0.19

    fig, axis = plt.subplots(figsize=(11, 5.9))
    fig.subplots_adjust(left=0.09, right=0.97, bottom=0.2, top=0.70)
    fig.suptitle("Where each agent path completed the task", fontsize=18, weight="bold", y=0.96)
    fig.text(0.5, 0.86, "Independent file and Python checks · higher is better",
             ha="center", color=SLATE)
    handles = []
    for index, (key, label, color) in enumerate(VARIANTS):
        variant = comparison[key]
        values = [variant["byTask"][task_id]["completionRatePercent"] for task_id in task_ids]
        counts = [variant["byTask"][task_id]["completed"] for task_id in task_ids]
        totals = [variant["byTask"][task_id]["runs"] for task_id in task_ids]
        offset = (index - 1.5) * width
        bars = axis.bar(x + offset, values, width, color=color, label=label)
        handles.append(bars)
        for bar, completed, total in zip(bars, counts, totals):
            axis.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 1.6,
                      f"{completed}/{total}", ha="center", va="bottom", fontsize=8.5,
                      rotation=0, weight="bold")
    axis.set_ylabel("Tasks completed (%)")
    axis.set_xticks(x, labels)
    axis.set_ylim(0, 114)
    axis.set_yticks(np.arange(0, 101, 20))
    fig.legend([handle[0] for handle in handles], [label for _key, label, _color in VARIANTS],
               frameon=False, ncols=4, loc="upper center", bbox_to_anchor=(0.5, 0.79))
    axis.grid(axis="y")
    axis.grid(axis="x", visible=False)
    axis.spines[["top", "right"]].set_visible(False)
    fig.savefig(output / "agent-harness-by-task.png", dpi=180, bbox_inches="tight")
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
