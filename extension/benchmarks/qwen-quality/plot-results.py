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
ROOT = HERE.parents[2]
CAMPAIGN = "docs/benchmarks/quality-multihardware"
M2 = "Apple M2 Max, 96 GiB"
# Captions describe one reviewed receipt each: model, machine, date and the
# engine state that produced it. A new run needs its own reviewed entry; the
# hash check prevents silently reusing another run's captions. "dir" is the
# repository directory that holds the run's results/ folder and its chart
# (this directory when absent).
REVIEWED = {
    "a7f1afac56784076e53b6ab6823064155ffa11cfec234477aa6f636a3cad2cb1": {
        "results": "2026-09-09-qwen27-common100.json", "chart": "common-100.png",
        "name": "Qwen3.8-27B", "caption": "Qwen3.8-27B · Q6_K_XL · Apple M2 Max, 96 GiB · 9 September 2026",
        "footnote": "Original completed run, before the new segmented-F16 candidate. Failed cases are not replaced by retries."},
    # November 2026 campaign (PLAN.MD): one run per selection, each model alone.
    "9f8e28fb7405fd5ab86dea4a7ddf00fe5697818acea8e69dbab88176c178f872": {
        "dir": CAMPAIGN, "results": "2026-11-10-qwen36-q6-llama.json", "chart": "qwen36-q6-llama.png",
        "name": "Qwen3.6-35B-A3B · UD-Q6_K_XL\nllama.cpp",
        "caption": f"Qwen3.6-35B-A3B · UD-Q6_K_XL · llama.cpp b11836 · {M2} · 10 November 2026",
        "footnote": "One run, thinking off. Failed cases are not retried or replaced."},
    "fb07f8fc0477599c4ab61b19c347fb0a6765011ad80c91c6742d6af64c57ea4c": {
        "dir": CAMPAIGN, "results": "2026-11-10-qwen36-mxfp8-mlx.json", "chart": "qwen36-mxfp8-mlx.png",
        "name": "Qwen3.6-35B-A3B · MXFP8\nMLX",
        "caption": f"Qwen3.6-35B-A3B · MXFP8 · MLX (mlx-lm 0.32.2) · {M2} · 10 November 2026",
        "footnote": "One run, thinking off. Failed cases are not retried or replaced."},
    "5ebf8d403faa85ac48ec851b2a60d03b814971d3035cfb15b1de062417b40838": {
        "dir": CAMPAIGN, "results": "2026-11-11-qwen27-q6-llama.json", "chart": "qwen27-q6-llama.png",
        "name": "Qwen3.8-27B · UD-Q6_K_XL\nllama.cpp",
        "caption": f"Qwen3.8-27B · UD-Q6_K_XL · llama.cpp b11836 · {M2} · 11 November 2026",
        "footnote": "One run, thinking off. Failed cases are not retried or replaced."},
    "1724191b533f9ae13d1ef44c51a21a13a17c8b1f30eea7188ee4d924491bb66e": {
        "dir": CAMPAIGN, "results": "2026-11-11-laguna-s21-q4.json", "chart": "laguna-s21-q4.png",
        "name": "Laguna S 2.1 · Q4_K_M\nds4 Laguna",
        "caption": f"Laguna S 2.1 · Q4_K_M · ds4 Laguna 448d569 · {M2} · 11 November 2026",
        "footnote": "The engine failed on the first long text; the twelve tasks after it were not run and stay in the denominator."},
    "765c3a25957c2618cb0394d0d5e7c87d588d92e9e72b4eff2af6950e74b850b6": {
        "dir": CAMPAIGN, "results": "2026-11-11-deepseek-v4-vision-exp-iq2xxs.json", "chart": "deepseek-v4-vision-exp-iq2xxs.png",
        "name": "DeepSeek V4 Flash Vision-Exp · IQ2XXS\nds4 main",
        "caption": f"DeepSeek V4 Flash Vision-Exp · IQ2XXS · ds4 main 890898c · {M2} · 11 November 2026",
        "footnote": "All fifteen programs came inside Markdown fences, which the tasks forbid. Failed cases are not retried or replaced."},
}
# The family overviews compare reviewed runs graded by one corpus identity.
FAMILIES = [{
    "dir": CAMPAIGN, "chart": "overview.png",
    "results": ["2026-11-11-qwen27-q6-llama.json", "2026-11-10-qwen36-mxfp8-mlx.json",
                "2026-11-10-qwen36-q6-llama.json", "2026-11-11-deepseek-v4-vision-exp-iq2xxs.json",
                "2026-11-11-laguna-s21-q4.json"],
    "title": "Tasks passed out of 100, by model selection",
    "caption": f"{M2} · one run each, thinking off · development replay · different quantizations: not a ranking",
}]
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


def folder(review):
    return ROOT / review["dir"] if review.get("dir") else HERE


def validate(data):
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
    not_run = f" · {summary['notRun']} tasks not run" if summary["notRun"] else ""
    answers = summary["failed"] - transport
    fig.text(.035, .846,
             f"{answers} answer{'' if answers == 1 else 's'} failed checks · "
             f"{transport} request{'' if transport == 1 else 's'} failed before a complete answer{not_run}",
             size=12, color="#455267")
    positions = list(range(len(rows)))
    ax.barh(positions, [row["passed"] for row in rows], color=PASSED, height=.61, label="Passed")
    ax.barh(positions, [row["failed"] for row in rows], left=[row["passed"] for row in rows],
            color=FAILED, height=.61, label="Did not pass")
    # Unexecuted tasks stay in the denominator and on the chart.
    missing = [(y, row) for y, row in enumerate(rows) if row["notRun"]]
    if missing:
        ax.barh([y for y, _ in missing], [row["notRun"] for _, row in missing],
                left=[row["passed"] + row["failed"] for _, row in missing],
                color=NOT_RUN, edgecolor="#8e99aa", hatch="///", linewidth=.6, height=.61, label="Not run")
    for y, row in enumerate(rows):
        extra = f" · {row['notRun']} not run" if row["notRun"] else ""
        ax.text(row["cases"] + .25, y, f"{row['passed']} / {row['cases']}{extra}", va="center", size=11, color="#17253c")
    ax.set_yticks(positions, [LABELS[row["area"]] for row in rows], fontsize=11)
    ax.invert_yaxis(); ax.set_xlim(0, max(row["cases"] for row in rows) + 2)
    ax.set_xticks([0, 5, 10, 15]); ax.set_xlabel("Number of tasks · label shows passed / tested", fontsize=10)
    ax.spines[["top", "right", "left"]].set_visible(False)
    ax.spines["bottom"].set_color("#bec6d2"); ax.tick_params(axis="y", length=0, pad=10)
    ax.grid(axis="x", color="#e7ebf1", linewidth=.8); ax.set_axisbelow(True)
    handles = [Patch(color=PASSED, label="Passed"), Patch(color=FAILED, label="Did not pass")]
    if summary["notRun"]:
        handles.append(Patch(facecolor=NOT_RUN, edgecolor="#8e99aa", hatch="///", label="Not run"))
    ax.legend(handles=handles, loc="lower right", bbox_to_anchor=(1.1, 1.02), ncol=len(handles), frameon=False, fontsize=10)
    fig.text(.035, .06, USES[data["evaluationUse"]] + ". Returned code is tested independently; this is not an Agent comparison.",
             size=10, color="#455267")
    fig.text(.035, .028, review["footnote"], size=10, color="#455267")
    return fig


def make_family_figure(runs, title, caption):
    """One bar per reviewed run: passed, did not pass and not run, out of 100."""
    if not runs:
        raise ValueError("No runs to compare")
    reviews = [validate(data) for data in runs]
    if len({data["sourceReceiptSha256"] for data in runs}) != len(runs):
        raise ValueError("A run appears twice")
    if len({data["corpus"] for data in runs}) != 1:
        raise ValueError("Runs graded by different corpus identities cannot share one axis")
    height = 1.6 + .78 * len(runs)
    fig, ax = plt.subplots(figsize=(11.5, height + 2.2))
    fig.patch.set_facecolor("#ffffff")
    # Room on the right for "NN / 100 · NN not run".
    fig.subplots_adjust(left=.36, right=.80, top=1 - 1.55 / (height + 2.2), bottom=1.05 / (height + 2.2))
    fig.text(.035, 1 - .55 / (height + 2.2), title, size=20, weight="bold", color="#17253c")
    fig.text(.035, 1 - 1.0 / (height + 2.2), caption, size=11, color="#455267")
    positions = list(range(len(runs)))
    passed = [data["summary"]["passed"] for data in runs]
    failed = [data["summary"]["failed"] for data in runs]
    not_run = [data["summary"]["notRun"] for data in runs]
    ax.barh(positions, passed, color=PASSED, height=.58)
    ax.barh(positions, failed, left=passed, color=FAILED, height=.58)
    missing = [y for y in positions if not_run[y]]
    ax.barh(missing, [not_run[y] for y in missing], left=[passed[y] + failed[y] for y in missing], color=NOT_RUN,
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
            save(make_figure(json.loads((folder(review) / "results" / review["results"]).read_text())), folder(review) / review["chart"])
    for family in FAMILIES:
        runs = [json.loads((folder(family) / "results" / name).read_text()) for name in family["results"]]
        save(make_family_figure(runs, family["title"], family["caption"]), folder(family) / family["chart"])


if __name__ == "__main__":
    main()
