#!/usr/bin/env python3
"""Plot reviewed common-100 aggregates, never raw user prompts or model text."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

HERE = Path(__file__).resolve().parent
# Captions describe one reviewed receipt each: model, machine, date and the
# engine state that produced it. A new run needs its own reviewed entry; the
# hash check prevents silently reusing another run's captions.
REVIEWED = {
    "a7f1afac56784076e53b6ab6823064155ffa11cfec234477aa6f636a3cad2cb1": {
        "results": "2026-09-09-qwen27-common100.json", "chart": "common-100.png",
        "name": "Qwen3.8-27B", "caption": "Qwen3.8-27B · Q6_K_XL · Apple M2 Max, 96 GiB · 9 September 2026",
        "footnote": "Original completed run, before the new segmented-F16 candidate. Failed cases are not replaced by retries."},
}
# The family overview compares reviewed runs graded by one corpus identity.
FAMILY = None
LABELS = {
    "arithmetic": "Arithmetic and units", "reasoning": "Reasoning",
    "code": "Writing code", "debugging": "Fixing bugs",
    "json": "JSON structure", "extraction": "Extracting facts",
    "instructions": "Following instructions", "language": "Italian and English",
    "long_context": "Long texts", "insufficient": "Recognising missing information",
}
USES = {"development-replay": "Development replay, not held-out evaluation",
        "first-exposure": "First run of this model on the corpus, not an audited held-out set",
        "held-out": "Held-out evaluation"}
PASSED, FAILED, NOT_RUN = "#3869c6", "#dee3eb", "#ffffff"


def validate(data, *, allow_not_run=False):
    if data.get("schema") != "dstudio.common-quality-public.v1":
        raise ValueError("Expected the privacy-filtered common-100 aggregate")
    review = REVIEWED.get(data.get("sourceReceiptSha256"))
    if review is None:
        raise ValueError("Review the new run and its captions before publishing it")
    summary, rows = data["summary"], data["categories"]
    if data.get("evaluationUse") not in USES:
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
    if summary["notRun"] and not allow_not_run:
        raise ValueError("This complete-run chart cannot hide unexecuted cases")
    if any(type(n) is not int or n < 0 for n in data["failures"].values()):
        raise ValueError("Invalid failure classification")
    # The aggregate classifies unexecuted cases as "not_run"; every other
    # class must account for exactly the failed cases.
    failures = dict(data["failures"])
    if failures.pop("not_run", 0) != summary["notRun"] or sum(failures.values()) != summary["failed"]:
        raise ValueError("Failure classifications disagree with the denominator")
    return review


def make_figure(data):
    review = validate(data)
    summary, rows = data["summary"], data["categories"]
    fig, ax = plt.subplots(figsize=(11.5, 7.5))
    fig.patch.set_facecolor("#ffffff")
    fig.subplots_adjust(left=.31, right=.89, top=.77, bottom=.15)
    fig.text(.035, .945, f"{summary['passed']} of 100 tasks passed", size=24, weight="bold", color="#17253c")
    fig.text(.035, .892, review["caption"], size=11, color="#455267")
    transport = data["failures"].get("transport_or_engine_error", 0)
    fig.text(.035, .846,
             f"{summary['failed'] - transport} answers failed checks · {transport} requests failed before a complete answer",
             size=12, color="#455267")
    positions = list(range(len(rows)))
    ax.barh(positions, [row["passed"] for row in rows], color=PASSED, height=.61, label="Passed")
    ax.barh(positions, [row["failed"] for row in rows], left=[row["passed"] for row in rows],
            color=FAILED, height=.61, label="Did not pass")
    for y, row in enumerate(rows):
        ax.text(row["cases"] + .25, y, f"{row['passed']} / {row['cases']}", va="center", size=11, color="#17253c")
    ax.set_yticks(positions, [LABELS[row["area"]] for row in rows], fontsize=11)
    ax.invert_yaxis(); ax.set_xlim(0, max(row["cases"] for row in rows) + 2)
    ax.set_xticks([0, 5, 10, 15]); ax.set_xlabel("Number of tasks · label shows passed / tested", fontsize=10)
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.spines["bottom"].set_color("#bec6d2"); ax.tick_params(axis="y", length=0, pad=10)
    ax.grid(axis="x", color="#e7ebf1", linewidth=.8); ax.set_axisbelow(True)
    ax.legend(handles=[Patch(color=PASSED, label="Passed"), Patch(color=FAILED, label="Did not pass")],
              loc="lower right", bbox_to_anchor=(1.1, 1.02), ncol=2, frameon=False, fontsize=10)
    fig.text(.035, .06, USES[data["evaluationUse"]] + ". Returned code is tested independently; this is not an Agent comparison.",
             size=10, color="#455267")
    fig.text(.035, .028, review["footnote"], size=10, color="#455267")
    return fig


def make_family_figure(runs, title, caption):
    """One bar per reviewed run: passed, did not pass and not run, out of 100."""
    if not runs:
        raise ValueError("No runs to compare")
    reviews = [validate(data, allow_not_run=True) for data in runs]
    if len({data["sourceReceiptSha256"] for data in runs}) != len(runs):
        raise ValueError("A run appears twice")
    if len({data["corpus"] for data in runs}) != 1:
        raise ValueError("Runs graded by different corpus identities cannot share one axis")
    height = 1.6 + .78 * len(runs)
    fig, ax = plt.subplots(figsize=(11.5, height + 2.2))
    fig.patch.set_facecolor("#ffffff")
    fig.subplots_adjust(left=.36, right=.93, top=1 - 1.55 / (height + 2.2), bottom=1.05 / (height + 2.2))
    fig.text(.035, 1 - .55 / (height + 2.2), title, size=20, weight="bold", color="#17253c")
    fig.text(.035, 1 - 1.0 / (height + 2.2), caption, size=11, color="#455267")
    positions = list(range(len(runs)))
    passed = [data["summary"]["passed"] for data in runs]
    failed = [data["summary"]["failed"] for data in runs]
    not_run = [data["summary"]["notRun"] for data in runs]
    ax.barh(positions, passed, color=PASSED, height=.58)
    ax.barh(positions, failed, left=passed, color=FAILED, height=.58)
    ax.barh(positions, not_run, left=[p + f for p, f in zip(passed, failed)], color=NOT_RUN,
            edgecolor="#8e99aa", hatch="///", linewidth=.6, height=.58)
    for y, data in enumerate(runs):
        extra = f" · {data['summary']['notRun']} not run" if data["summary"]["notRun"] else ""
        ax.text(101.5, y, f"{data['summary']['passed']} / 100{extra}", va="center", size=11, color="#17253c")
    ax.set_yticks(positions, [review["name"] for review in reviews], fontsize=11)
    ax.invert_yaxis(); ax.set_xlim(0, 100)
    ax.set_xticks([0, 25, 50, 75, 100]); ax.set_xlabel("Tasks out of 100 · one execution per task", fontsize=10)
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.spines["bottom"].set_color("#bec6d2"); ax.tick_params(axis="y", length=0, pad=10)
    ax.grid(axis="x", color="#e7ebf1", linewidth=.8); ax.set_axisbelow(True)
    ax.legend(handles=[Patch(color=PASSED, label="Passed"), Patch(color=FAILED, label="Did not pass"),
                       Patch(facecolor=NOT_RUN, edgecolor="#8e99aa", hatch="///", label="Not run")],
              loc="lower right", bbox_to_anchor=(1.0, 1.0), ncol=3, frameon=False, fontsize=10)
    return fig


def save(figure, out):
    figure.savefig(out, dpi=160, facecolor=figure.get_facecolor())
    plt.close(figure)


def main():
    argparse.ArgumentParser(description=__doc__ + " Regenerates every reviewed chart.").parse_args()
    for review in REVIEWED.values():
        if review.get("chart"):
            save(make_figure(json.loads((HERE / "results" / review["results"]).read_text())), HERE / review["chart"])
    if FAMILY:
        runs = [json.loads((HERE / "results" / name).read_text()) for name in FAMILY["results"]]
        save(make_family_figure(runs, FAMILY["title"], FAMILY["caption"]), HERE / FAMILY["chart"])


if __name__ == "__main__":
    main()
