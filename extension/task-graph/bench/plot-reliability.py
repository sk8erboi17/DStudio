#!/usr/bin/env python3
"""Render the public Native Agent vs Task Graph reliability figures."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RESULT = Path(__file__).with_name("results") / "2026-09-04-m2-max-reliability-no-ssd.json"
DEFAULT_OUTPUT = ROOT / "assets" / "README images" / "benchmarks"

BLUE = "#2563EB"
TEAL = "#0F766E"
ORANGE = "#F59E0B"
SLATE = "#64748B"
INK = "#172033"
GRID = "#D9E0EA"


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


def plot_completion(result: dict, output: Path) -> None:
    comparison = result["comparison"]
    native = comparison["nativeAgent"]
    graph = comparison["taskGraph"]
    task_ids = ["read-fact", "write-file", "repair-code"]
    labels = [native["byTask"][task_id]["label"] for task_id in task_ids] + ["All 50 tasks"]
    native_counts = [native["byTask"][task_id]["tasksCompleted"] if "tasksCompleted" in native["byTask"][task_id]
                     else native["byTask"][task_id]["completed"] for task_id in task_ids] + [native["tasksCompleted"]]
    graph_counts = [graph["byTask"][task_id]["tasksCompleted"] if "tasksCompleted" in graph["byTask"][task_id]
                    else graph["byTask"][task_id]["completed"] for task_id in task_ids] + [graph["tasksCompleted"]]
    totals = [native["byTask"][task_id]["runs"] for task_id in task_ids] + [native["tasksRun"]]
    native_values = np.asarray(native_counts) / np.asarray(totals) * 100
    graph_values = np.asarray(graph_counts) / np.asarray(totals) * 100
    x = np.arange(len(labels))
    width = 0.34

    fig, axis = plt.subplots(figsize=(11, 5.8))
    fig.subplots_adjust(left=0.09, right=0.97, bottom=0.2, top=0.70)
    fig.suptitle("50 real tasks: Native Agent vs automatic checks", fontsize=18, weight="bold", y=0.96)
    fig.text(0.5, 0.87, "Tasks actually completed · higher is better · SSD streaming off",
             ha="center", color=SLATE)
    native_bars = axis.bar(x - width / 2, native_values, width, color=BLUE, label="Native Agent")
    graph_bars = axis.bar(x + width / 2, graph_values, width, color=TEAL, label="Agent + automatic checks")
    for bars, counts in ((native_bars, native_counts), (graph_bars, graph_counts)):
        for bar, completed, total in zip(bars, counts, totals):
            axis.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 2,
                      f"{completed}/{total}", ha="center", va="bottom", weight="bold")
    axis.set_ylabel("Tasks completed (%)")
    axis.set_xticks(x, labels)
    axis.set_ylim(0, 112)
    axis.set_yticks(np.arange(0, 101, 20))
    fig.legend([native_bars, graph_bars], ["Native Agent", "Agent + automatic checks"],
               frameon=False, ncols=2, loc="upper center", bbox_to_anchor=(0.5, 0.81))
    axis.grid(axis="y")
    axis.grid(axis="x", visible=False)
    axis.spines[["top", "right"]].set_visible(False)
    fig.savefig(output / "native-agent-vs-task-graph.png", dpi=180, bbox_inches="tight")
    plt.close(fig)


def plot_paired(result: dict, output: Path) -> None:
    paired = result["comparison"]["paired"]
    labels = ["Both completed", "Automatic checks only", "Native Agent only", "Neither"]
    values = [paired["bothCompleted"], paired["taskGraphOnly"],
              paired["nativeAgentOnly"], paired["neitherCompleted"]]
    colors = [SLATE, TEAL, BLUE, ORANGE]
    y = np.arange(len(labels))

    fig, axis = plt.subplots(figsize=(10, 4.8))
    fig.subplots_adjust(left=0.22, right=0.95, bottom=0.18, top=0.75)
    fig.suptitle("What happened on the same 50 tasks", fontsize=18, weight="bold", y=0.96)
    fig.text(0.5, 0.85, "Same model and task; the checked route starts automatically", ha="center", color=SLATE)
    bars = axis.barh(y, values, height=0.54, color=colors)
    for bar, value in zip(bars, values):
        axis.text(value + 0.7, bar.get_y() + bar.get_height() / 2, str(value),
                  va="center", weight="bold", fontsize=12)
    axis.set_yticks(y, labels)
    axis.invert_yaxis()
    axis.set_xlabel("Number of matched tasks")
    axis.set_xlim(0, max(values) * 1.13)
    axis.grid(axis="x")
    axis.grid(axis="y", visible=False)
    axis.tick_params(axis="y", length=0)
    axis.spines[["top", "right", "left"]].set_visible(False)
    fig.savefig(output / "task-graph-reliability-paired.png", dpi=180, bbox_inches="tight")
    plt.close(fig)


def main() -> None:
    result_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_RESULT
    output = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else DEFAULT_OUTPUT
    output.mkdir(parents=True, exist_ok=True)
    result = json.loads(result_path.read_text(encoding="utf-8"))
    setup_style()
    plot_completion(result, output)
    plot_paired(result, output)
    print(f"task_graph_reliability_plots: wrote 2 figures to {output}")


if __name__ == "__main__":
    main()
