#!/usr/bin/env python3
"""Render the publishable Task Graph benchmark figures from a result JSON."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RESULT = Path(__file__).with_name("results") / "2026-09-04-m2-max-native-ssd.json"
DEFAULT_OUTPUT = ROOT / "assets" / "README images" / "benchmarks"

BLUE = "#2563EB"
ORANGE = "#F59E0B"
TEAL = "#0F766E"
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
            "axes.titleweight": "bold",
            "axes.grid": True,
            "grid.color": GRID,
            "grid.linewidth": 0.8,
            "grid.alpha": 0.8,
            "axes.axisbelow": True,
        }
    )


def range_values(metric: dict) -> tuple[float, float, float]:
    return float(metric["median"]), float(metric["min"]), float(metric["max"])


def plot_user_comparison(result: dict, output: Path) -> None:
    native = result["nativeTaskGraph"]
    graph_values = np.asarray(native["graphMs"]["values"], dtype=float)
    representative = int(np.argsort(graph_values)[len(graph_values) // 2])
    agent_seconds = float(native["agentNodeMs"]["values"][representative]) / 1000
    graph_seconds = float(graph_values[representative]) / 1000
    added_seconds = graph_seconds - agent_seconds
    added_percent = added_seconds / agent_seconds * 100

    fig, axis = plt.subplots(figsize=(11, 4.8))
    fig.subplots_adjust(left=0.22, right=0.94, bottom=0.18, top=0.72)
    fig.suptitle("What Task Graph adds around the native Agent", fontsize=18, weight="bold", y=0.96)
    fig.text(
        0.5,
        0.84,
        "Representative median run · lower is faster",
        ha="center",
        color=SLATE,
    )
    y = np.arange(2)
    axis.barh(y, [agent_seconds, agent_seconds], height=0.46, color=BLUE, label="Native DS4 Agent work")
    axis.barh(1, added_seconds, left=agent_seconds, height=0.46, color=ORANGE,
              label="Task Graph steps + coordination")
    axis.set_yticks(y, ["Agent work only", "Complete Task Graph"])
    axis.invert_yaxis()
    axis.set_xlabel("Time (seconds)")
    axis.set_xlim(0, graph_seconds * 1.12)
    axis.text(agent_seconds - 1.2, 0, f"{agent_seconds:.1f} s", ha="right", va="center",
              color="white", weight="bold", fontsize=12)
    axis.text(graph_seconds + 0.8, 1, f"{graph_seconds:.1f} s", ha="left", va="center",
              weight="bold", fontsize=12)
    axis.annotate(
        f"+{added_seconds:.1f} s ({added_percent:.1f}%)",
        xy=(agent_seconds + added_seconds / 2, 1),
        xytext=(agent_seconds - 7, 1.7),
        arrowprops={"arrowstyle": "->", "color": ORANGE, "linewidth": 1.8},
        ha="center",
        color=ORANGE,
        weight="bold",
    )
    axis.legend(frameon=False, ncols=2, loc="lower left", bbox_to_anchor=(0, -0.42))
    axis.grid(axis="x")
    axis.grid(axis="y", visible=False)
    axis.tick_params(axis="y", length=0)
    axis.spines[["top", "right", "left"]].set_visible(False)
    fig.savefig(output / "native-agent-vs-task-graph.png", dpi=180, bbox_inches="tight")
    plt.close(fig)


def plot_native_breakdown(result: dict, output: Path) -> None:
    native = result["nativeTaskGraph"]
    graph = np.asarray(native["graphMs"]["values"], dtype=float) / 1000
    agent = np.asarray(native["agentNodeMs"]["values"], dtype=float) / 1000
    non_agent = np.asarray(native["sevenNonAgentNodesMs"]["values"], dtype=float) / 1000
    gaps = np.asarray(native["orchestrationGapMs"]["values"], dtype=float)
    labels = [f"Run {index}" for index in range(1, len(graph) + 1)]
    x = np.arange(len(labels))

    fig = plt.figure(figsize=(11, 7.2), layout="constrained")
    grid = fig.add_gridspec(2, 2, height_ratios=[1.65, 1])
    main = fig.add_subplot(grid[0, :])
    host = fig.add_subplot(grid[1, 0])
    journal = fig.add_subplot(grid[1, 1])
    fig.suptitle("Native DS4 Agent inside Task Graph — forced SSD streaming", fontsize=17, weight="bold")
    fig.text(
        0.5,
        0.94,
        "DeepSeek V4 Flash 86.72 GB · Apple M2 Max / 96 GB · 8 native nodes per run",
        ha="center",
        color=SLATE,
        fontsize=11,
    )

    main.bar(x, agent, width=0.62, color=BLUE, label="Real ds4-agent node")
    main.bar(x, non_agent, width=0.62, bottom=agent, color=ORANGE, label="7 non-Agent nodes")
    for index, total in enumerate(graph):
        main.text(index, total + 2.0, f"{total:.1f} s", ha="center", va="bottom", weight="bold")
    main.axhline(np.median(graph), color=SLATE, linestyle="--", linewidth=1.2,
                 label=f"Graph median {np.median(graph):.1f} s")
    main.set_xticks(x, labels)
    main.set_ylabel("End-to-end graph time (seconds)")
    main.set_ylim(0, max(graph) * 1.14)
    main.legend(frameon=False, ncols=3, loc="upper right")
    main.spines[["top", "right"]].set_visible(False)

    host.bar(x, non_agent, width=0.58, color=ORANGE)
    for index, value in enumerate(non_agent):
        host.text(index, value + 0.035, f"{value:.3f} s", ha="center", va="bottom", weight="bold")
    host.set_xticks(x, labels)
    host.set_ylabel("Seconds")
    host.set_title("Seven native nodes outside the LLM")
    host.set_ylim(0, max(non_agent) * 1.28)
    host.spines[["top", "right"]].set_visible(False)

    journal.bar(x, gaps, width=0.58, color=TEAL)
    for index, value in enumerate(gaps):
        journal.text(index, value + 0.6, f"{value:.0f} ms", ha="center", va="bottom", weight="bold")
    journal.set_xticks(x, labels)
    journal.set_ylabel("Milliseconds")
    journal.set_title("Scheduler + journal gap")
    journal.set_ylim(0, max(gaps) * 1.28)
    journal.spines[["top", "right"]].set_visible(False)

    fig.savefig(output / "task-graph-native-ssd-breakdown.png", dpi=180, bbox_inches="tight")
    plt.close(fig)


def plot_runtime_overhead(result: dict, output: Path) -> None:
    native = result["nativeTaskGraph"]
    core = result["coreMicrobenchmark"]
    durable_values = np.asarray(core["durableScheduleReplayBatchMs"], dtype=float) / float(
        core["durableEightNodeGraphsPerProcess"]
    )
    metrics = [
        ("Core parse + policy validate", core["medianParseValidateMicrosecondsPerGraph"] / 1000,
         min(core["parseValidateBatchMs"]) / 1000, max(core["parseValidateBatchMs"]) / 1000),
        ("HTTP validate", *range_values(native["validationApiMs"])),
        ("Create + fsynced initial journal", *range_values(native["createApiMs"])),
        ("Start + scheduler dispatch", *range_values(native["startApiMs"])),
        ("8-node durable schedule + replay", float(np.median(durable_values)),
         float(np.min(durable_values)), float(np.max(durable_values))),
    ]
    labels = [item[0] for item in metrics]
    medians = np.asarray([item[1] for item in metrics])
    lows = np.asarray([item[1] - item[2] for item in metrics])
    highs = np.asarray([item[3] - item[1] for item in metrics])
    y = np.arange(len(metrics))

    fig, axis = plt.subplots(figsize=(11, 5.6))
    fig.subplots_adjust(left=0.27, right=0.95, bottom=0.16, top=0.78)
    fig.suptitle("Task Graph control-plane latency", fontsize=17, weight="bold", y=0.97)
    fig.text(
        0.5,
        0.88,
        "Dots are medians; whiskers are observed min–max. Core batches: 5 processes.",
        ha="center",
        color=SLATE,
    )
    axis.errorbar(
        medians,
        y,
        xerr=np.vstack([lows, highs]),
        fmt="o",
        markersize=9,
        color=TEAL,
        ecolor=SLATE,
        elinewidth=2,
        capsize=5,
    )
    for index, value in enumerate(medians):
        label = f"{value * 1000:.2f} µs" if value < 0.1 else f"{value:.2f} ms"
        axis.annotate(label, (value, index), xytext=(10, 0), textcoords="offset points",
                      va="center", weight="bold")
    axis.set_xscale("log")
    axis.set_yticks(y, labels)
    axis.invert_yaxis()
    axis.set_xlabel("Latency (milliseconds, logarithmic scale) — lower is faster")
    axis.grid(axis="x")
    axis.grid(axis="y", visible=False)
    axis.tick_params(axis="y", length=0)
    axis.spines[["top", "right", "left"]].set_visible(False)
    fig.savefig(output / "task-graph-runtime-overhead.png", dpi=180, bbox_inches="tight")
    plt.close(fig)


def main() -> None:
    result_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_RESULT
    output = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else DEFAULT_OUTPUT
    output.mkdir(parents=True, exist_ok=True)
    result = json.loads(result_path.read_text(encoding="utf-8"))
    setup_style()
    plot_user_comparison(result, output)
    plot_native_breakdown(result, output)
    plot_runtime_overhead(result, output)
    print(f"task_graph_benchmark_plots: wrote 3 figures to {output}")


if __name__ == "__main__":
    main()
