#!/usr/bin/env python3
"""Plot a reviewed common-100 aggregate, never raw user prompts or model text."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

HERE = Path(__file__).resolve().parent
REVIEWED_RECEIPT = "a7f1afac56784076e53b6ab6823064155ffa11cfec234477aa6f636a3cad2cb1"
LABELS = {
    "arithmetic": "Arithmetic and units", "reasoning": "Reasoning",
    "code": "Writing code", "debugging": "Fixing bugs",
    "json": "JSON structure", "extraction": "Extracting facts",
    "instructions": "Following instructions", "language": "Italian and English",
    "long_context": "Long texts", "insufficient": "Recognising missing information",
}


def make_figure(data):
    if data.get("schema") != "dstudio.common-quality-public.v1":
        raise ValueError("Expected the privacy-filtered common-100 aggregate")
    # Hardware/date/model captions describe this reviewed run only. Do not
    # silently reuse them for another model, machine or later candidate.
    if data.get("sourceReceiptSha256") != REVIEWED_RECEIPT:
        raise ValueError("Review the new run and its captions before publishing it")
    summary, rows = data["summary"], data["categories"]
    if data.get("evaluationUse") not in ("development-replay", "held-out"):
        raise ValueError("Simulated or unspecified evaluation cannot be published as model quality")
    if (summary.get("denominator") != 100 or summary.get("pending") != 0
            or len(rows) != 10 or {row["area"] for row in rows} != set(LABELS)):
        raise ValueError("Incomplete or duplicate common-100 denominator")
    for row in rows:
        if any(type(row[key]) is not int or row[key] < 0 for key in ("cases", "passed", "failed", "notRun")):
            raise ValueError("Invalid case counts")
        if row["passed"] + row["failed"] + row["notRun"] != row["cases"]:
            raise ValueError("Category counts do not add up")
    for field in ("passed", "failed", "notRun"):
        if sum(row[field] for row in rows) != summary[field]:
            raise ValueError("Category counts disagree with the terminal summary")
    if sum(summary[key] for key in ("passed", "failed", "notRun")) != 100:
        raise ValueError("Missing cases")
    if summary["notRun"]:
        raise ValueError("This complete-run chart cannot hide unexecuted cases")
    if any(type(n) is not int or n < 0 for n in data["failures"].values()):
        raise ValueError("Invalid failure classification")
    if sum(data["failures"].values()) != summary["failed"]:
        raise ValueError("Failure classifications disagree with the denominator")

    passed_color, failed_color = "#3869c6", "#dee3eb"
    fig, ax = plt.subplots(figsize=(11.5, 7.5))
    fig.patch.set_facecolor("#ffffff")
    fig.subplots_adjust(left=.31, right=.89, top=.77, bottom=.15)
    fig.text(.035, .945, f"{summary['passed']} of 100 tasks passed", size=24, weight="bold", color="#17253c")
    fig.text(.035, .892, "Qwen3.8-27B · Q6_K_XL · Apple M2 Max, 96 GiB · 9 September 2026", size=11, color="#455267")
    transport = data["failures"].get("transport_or_engine_error", 0)
    fig.text(.035, .846,
             f"{summary['failed'] - transport} answers failed checks · {transport} requests failed before a complete answer",
             size=12, color="#455267")
    positions = list(range(len(rows)))
    ax.barh(positions, [row["passed"] for row in rows], color=passed_color, height=.61, label="Passed")
    ax.barh(positions, [row["failed"] for row in rows], left=[row["passed"] for row in rows],
            color=failed_color, height=.61, label="Did not pass")
    for y, row in enumerate(rows):
        ax.text(row["cases"] + .25, y, f"{row['passed']} / {row['cases']}", va="center", size=11, color="#17253c")
    ax.set_yticks(positions, [LABELS[row["area"]] for row in rows], fontsize=11)
    ax.invert_yaxis(); ax.set_xlim(0, max(row["cases"] for row in rows) + 2)
    ax.set_xticks([0, 5, 10, 15]); ax.set_xlabel("Number of tasks · label shows passed / tested", fontsize=10)
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.spines["bottom"].set_color("#bec6d2"); ax.tick_params(axis="y", length=0, pad=10)
    ax.grid(axis="x", color="#e7ebf1", linewidth=.8); ax.set_axisbelow(True)
    ax.legend(handles=[Patch(color=passed_color, label="Passed"), Patch(color=failed_color, label="Did not pass")],
              loc="lower right", bbox_to_anchor=(1.1, 1.02), ncol=2, frameon=False, fontsize=10)
    use = "Development replay, not held-out evaluation" if data["evaluationUse"] == "development-replay" else "Held-out evaluation"
    fig.text(.035, .06, use + ". Returned code is tested independently; this is not an Agent comparison.", size=10, color="#455267")
    fig.text(.035, .028, "Original completed run, before the new segmented-F16 candidate. Failed cases are not replaced by retries.", size=10, color="#455267")
    return fig


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=HERE / "results/2026-09-09-qwen27-common100.json")
    parser.add_argument("--out", type=Path, default=HERE / "common-100.png")
    args = parser.parse_args()
    data = json.loads(args.results.read_text())
    figure = make_figure(data)
    figure.savefig(args.out, dpi=160, facecolor=figure.get_facecolor())
    plt.close(figure)


if __name__ == "__main__":
    main()
