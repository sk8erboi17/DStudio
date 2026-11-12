#!/usr/bin/env python3
"""Render the public DStudio, Pi and OpenCode reliability comparison, or the six-agent lane comparison."""

from __future__ import annotations

import json
import textwrap
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


# ---------------------------------------------------------------- six agents, two lanes
# Input: the output of `publish-cli-comparison.mjs --lanes`. Every cell of the
# correctness grid shows completed/planned attempts with the failures that
# stay in that denominator; BLOCKED and NOT COMPARABLE cells are drawn as
# such, with no rate. The time figure compares agents only on the cells every
# measured agent completed and says how many of the group's cells that is.
LANE_COLORS = {
    "upstream-agent": SLATE,
    "native-agent": BLUE,
    "task-graph": TEAL,
    "pi": PURPLE,
    "opencode": ORANGE,
    "codex": "#DB2777",
}
BLOCKED_FILL = "#CBD5E1"
NOT_COMPARABLE_FILL = "#E2E8F0"
SYNTHETIC_COLOR = "#B91C1C"


def stamp_synthetic(fig, label: str | None) -> None:
    if not label:
        return
    fig.text(0.5, 0.5, "SYNTHETIC TEST DATA\nNOT A MEASUREMENT", ha="center", va="center", rotation=28,
             fontsize=54, color=SYNTHETIC_COLOR, alpha=0.22, weight="bold", zorder=100)
    fig.text(0.5, 0.005, f"Synthetic receipt: {label}", ha="center", va="bottom", color=SYNTHETIC_COLOR, fontsize=10)


def lane_cell_text(cell: dict) -> tuple[str, str]:
    if cell["state"] == "blocked":
        return "BLOCKED", f"{cell['blocked']} rows"
    if cell["state"] == "not-comparable":
        return "NOT\nCOMPARABLE", f"{cell['notComparable']} rows"
    if cell["state"] == "absent":
        return "not in\nthis run", ""
    parts = [f"{cell[key]} {name}" for key, name in (
        ("failed", "failed"), ("inconclusive", "inconcl."), ("harnessError", "harness err."), ("notRun", "not run"),
    ) if cell[key]]
    if cell["blocked"]:
        parts.append(f"+{cell['blocked']} blocked")
    if cell["notComparable"]:
        parts.append(f"+{cell['notComparable']} n/c")
    return f"{cell['completed']}/{cell['planned']}", "\n".join(" · ".join(parts[index:index + 2]) for index in range(0, len(parts), 2))


def plot_lane_correctness(result: dict, output: Path) -> None:
    from matplotlib.patches import Rectangle

    agents = result["agents"]
    groups = result["groups"]
    lanes = list(result["lanes"].items())
    cmap = plt.get_cmap("YlGn")
    height = 5.6 * len(lanes) + 2.9
    fig, axes = plt.subplots(len(lanes), 1, figsize=(14.5, height))
    axes = np.atleast_1d(axes)
    # Fixed inches for the header and footer, whatever the number of lanes.
    fig.subplots_adjust(left=0.14, right=0.98, top=1 - 2.5 / height, bottom=1.1 / height, hspace=0.55)
    model = result.get("model") or {}
    fig.suptitle("Six agents, two lanes: tasks verified complete", fontsize=18, weight="bold", y=1 - 0.3 / height)
    fig.text(0.5, 1 - 0.75 / height, f"{model.get('file', 'unknown model')} · {(result.get('hardware') or {}).get('chip', 'unknown machine')} · "
             "cell = completed / planned attempts (failures, inconclusive, harness errors and not-run attempts stay in the denominator)",
             ha="center", color=SLATE, fontsize=10)
    for axis, (lane_id, lane) in zip(axes, lanes):
        axis.set_xlim(0, len(groups))
        axis.set_ylim(len(agents), 0)
        axis.set_xticks(np.arange(len(groups)) + 0.5, [group["label"].replace(": ", ":\n") for group in groups])
        axis.set_yticks(np.arange(len(agents)) + 0.5, [agent["label"] for agent in agents])
        axis.tick_params(axis="x", bottom=False, top=True, labelbottom=False, labeltop=True, length=0)
        axis.tick_params(axis="y", length=0)
        axis.grid(False)
        for spine in axis.spines.values():
            spine.set_visible(False)
        if not lane.get("published"):
            axis.set_title(f"{lane['label']} lane: not run ({lane['reason']})", fontsize=13, weight="bold", loc="left", pad=34)
            axis.add_patch(Rectangle((0, 0), len(groups), len(agents), facecolor=NOT_COMPARABLE_FILL, edgecolor="white"))
            axis.text(len(groups) / 2, len(agents) / 2, "NOT RUN", ha="center", va="center", fontsize=20, color=SLATE, weight="bold")
            continue
        status = "complete" if lane["complete"] else "INCOMPLETE: some planned attempts were not run"
        repetitions = ", ".join(f"{run['set']} x{run['repetitions']}" for run in lane["runs"])
        axis.set_title(f"{lane['label']} lane · case sets and repetitions: {repetitions}\n{status}", fontsize=13, weight="bold", loc="left", pad=34)
        for row, agent in enumerate(agents):
            for column, group in enumerate(groups):
                cell = lane["cells"][agent["id"]][group["id"]]
                if cell["state"] == "measured":
                    rate = cell["completionRatePercent"] / 100
                    face, hatch, ink = cmap(0.15 + 0.75 * rate), None, ("white" if rate > 0.62 else INK)
                elif cell["state"] == "blocked":
                    face, hatch, ink = BLOCKED_FILL, "//", INK
                elif cell["state"] == "not-comparable":
                    face, hatch, ink = NOT_COMPARABLE_FILL, "..", INK
                else:
                    face, hatch, ink = "white", None, SLATE
                axis.add_patch(Rectangle((column, row), 1, 1, facecolor=face, edgecolor="white", linewidth=2, hatch=hatch))
                head, detail = lane_cell_text(cell)
                axis.text(column + 0.5, row + (0.4 if detail else 0.5), head, ha="center", va="center", color=ink,
                          weight="bold", fontsize=12 if cell["state"] == "measured" else 9.5,
                          bbox=None if cell["state"] == "measured" else dict(facecolor="white", edgecolor="none", alpha=0.8, pad=1.5))
                if detail:
                    axis.text(column + 0.5, row + 0.75, detail, ha="center", va="center", color=ink, fontsize=8)
    fig.text(0.5, 0.35 / height, "BLOCKED: the runner cannot run these rows on this machine or has no proven driver for them. "
             "NOT COMPARABLE: the agent's interface cannot represent the mechanic or lane.\nNeither is an attempt and neither "
             "enters a rate; the reasons are in the published JSON. Development, held-out and recovery cases are never totalled together.",
             ha="center", color=SLATE, fontsize=9)
    stamp_synthetic(fig, result.get("synthetic"))
    fig.savefig(output / "agent-lane-correctness.png", dpi=150)
    plt.close(fig)


def plot_lane_time(result: dict, output: Path) -> None:
    agents = {agent["id"]: agent["label"] for agent in result["agents"]}
    groups = {group["id"]: group["label"] for group in result["groups"]}
    lanes = list(result["lanes"].items())
    timed = ["development", "held-out"]
    height = 4.6 * len(lanes) + 2.0
    fig, axes = plt.subplots(len(lanes), len(timed), figsize=(13.5, height), squeeze=False)
    fig.subplots_adjust(left=0.13, right=0.97, top=1 - 1.7 / height, bottom=0.9 / height, hspace=0.75, wspace=0.42)
    fig.suptitle("Time to a verified result, on matched cases only", fontsize=18, weight="bold", y=1 - 0.3 / height)
    fig.text(0.5, 1 - 0.75 / height, "Median seconds from the prompt to the end of a completed attempt, over the (repetition, case) cells "
             "that every measured agent completed · lower is better", ha="center", color=SLATE, fontsize=10)
    for row, (lane_id, lane) in enumerate(lanes):
        for column, group in enumerate(timed):
            axis = axes[row][column]
            axis.grid(axis="y", visible=False)
            axis.spines[["top", "right"]].set_visible(False)
            if not lane.get("published"):
                axis.set_title(f"{lane['label']} · {groups[group]}: lane not run", fontsize=11, weight="bold", loc="left")
                axis.set_axis_off()
                continue
            time = lane["time"][group]
            excluded = ", ".join(agents[agent] for agent in time["excluded"])
            axis.set_title(f"{lane['label']} · {groups[group]}\nmatched on {time['matchedCells']} of {time['cells']} cells",
                           fontsize=11, weight="bold", loc="left")
            if not time["agents"] or not time["matchedCells"]:
                axis.set_axis_off()
                message = ("Every agent is BLOCKED or NOT COMPARABLE in this group:\nnothing to time." if not time["agents"]
                           else "No cell was completed by every measured agent:\nno matched time comparison.")
                axis.text(0.5, 0.5, message, ha="center", va="center", transform=axis.transAxes, color=SLATE, fontsize=11)
            else:
                names = time["agents"]
                seconds = [time["medianMs"][agent] / 1000 for agent in names]
                y = np.arange(len(names))
                bars = axis.barh(y, seconds, color=[LANE_COLORS[agent] for agent in names], height=0.62)
                axis.set_yticks(y, [agents[agent] for agent in names])
                axis.invert_yaxis()
                axis.set_xlabel("Median seconds (matched cells)")
                axis.set_xlim(0, max(seconds) * 2.0)
                for bar, value, agent in zip(bars, seconds, names):
                    cell = lane["cells"][agent][group]
                    axis.text(bar.get_width() + max(seconds) * 0.02, bar.get_y() + bar.get_height() / 2,
                              f"{value:.1f} s · {cell['completed']}/{cell['planned']} completed in all", va="center", fontsize=8.5, weight="bold")
            if excluded and time["agents"]:
                axis.text(0, -0.32, textwrap.fill(f"Not measured here (BLOCKED or NOT COMPARABLE): {excluded}", 80),
                          transform=axis.transAxes, fontsize=8, color=SLATE, va="top")
    stamp_synthetic(fig, result.get("synthetic"))
    fig.savefig(output / "agent-lane-time.png", dpi=150)
    plt.close(fig)


def main() -> None:
    result_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_RESULT
    output = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else DEFAULT_OUTPUT
    result = json.loads(result_path.read_text(encoding="utf-8"))
    if result.get("benchmark") == "dstudio-agent-lane-comparison":
        # Synthetic receipts exist to test this script; they never reach the published figures.
        if result.get("synthetic") and output == DEFAULT_OUTPUT.resolve():
            sys.exit("refusing to write figures of a synthetic receipt into the published benchmark images")
        output.mkdir(parents=True, exist_ok=True)
        setup_style()
        plot_lane_correctness(result, output)
        plot_lane_time(result, output)
        print(f"agent_lane_plots: wrote 2 figures to {output}{' (SYNTHETIC)' if result.get('synthetic') else ''}")
        return
    output.mkdir(parents=True, exist_ok=True)
    setup_style()
    plot_overall(result, output)
    plot_by_task(result, output)
    print(f"task_graph_cli_comparison_plots: wrote 2 figures to {output}")


if __name__ == "__main__":
    main()
