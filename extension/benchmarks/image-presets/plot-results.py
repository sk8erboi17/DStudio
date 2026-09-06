#!/usr/bin/env python3
"""Plot public, reviewed local inference receipts. No inference or image retouching."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

HERE = Path(__file__).resolve().parent
PRESETS = ("low", "medium", "high", "max")
COLORS = ("#7d94ca", "#517fe4", "#335cbd", "#243973")


def public_results(raw_dir: Path, review_path: Path, destination: Path):
    """Copy only reviewed benchmark images and a bounded public receipt schema."""
    raw_dir = raw_dir.resolve()
    raw = json.loads((raw_dir / "results.json").read_text())
    reviews = json.loads(review_path.read_text())
    by_hash = {review["outputSha256"]: review for review in reviews["reviews"]}
    if raw.get("realInference") is not True:
        raise ValueError("simulated results must not enter the live benchmark")
    rows = []
    images = destination / "images"
    images.mkdir(parents=True, exist_ok=True)
    for entry in raw["runs"]:
        if entry["preset"] not in PRESETS or entry["case"] not in (
            "hermes-hero", "hermes-portrait", "hermes-hero-art", "hermes-portrait-art"
        ):
            raise ValueError("unknown image case or preset")
        row = {key: entry[key] for key in (
            "case", "preset", "state", "elapsedSeconds", "exitCode", "expectedSize",
            "captionSha256", "outputSha256", "outputValidation", "provenance"
        ) if key in entry}
        if entry["state"] == "generated":
            digest = entry["outputSha256"]
            review = by_hash.get(digest)
            if not review or (review["case"], review["preset"]) != (entry["case"], entry["preset"]):
                raise ValueError(f"visual review missing for {entry['case']}/{entry['preset']}")
            source = (raw_dir / entry["image"]).resolve()
            if raw_dir not in source.parents or hashlib.sha256(source.read_bytes()).hexdigest() != digest:
                raise ValueError("image path or digest does not match the receipt")
            target = images / f"{entry['case']}-{entry['preset']}.png"
            if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise ValueError("refusing to replace an earlier published image")
            shutil.copyfile(source, target)
            row["image"] = str(target.relative_to(destination))
            row["review"] = review
        rows.append(row)
    result = {key: raw[key] for key in (
        "schemaVersion", "realInference", "scope", "reference", "referenceUse",
        "seed", "perImageDeadlineSeconds", "startedAt", "finishedAt", "hardware",
        "memoryBytes", "operatingSystem", "sharedHost", "plan"
    ) if key in raw}
    result.update(runs=rows, visualReviewMethod=reviews["method"])
    (destination / "results.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def timing_figure(data):
    cases = list(dict.fromkeys(entry["case"] for entry in data["plan"]))
    fig, axes = plt.subplots(1, len(cases), figsize=(6 * len(cases), 5.2), squeeze=False, sharey=True)
    by_key = {(row["case"], row["preset"]): row for row in data["runs"]}
    maximum_minutes = 1
    for ax, case in zip(axes[0], cases):
        timed = []
        for index, preset in enumerate(PRESETS):
            row = by_key.get((case, preset), {})
            seconds = row.get("elapsedSeconds")
            if seconds is not None and (not math.isfinite(seconds) or seconds < 0):
                raise ValueError("invalid measured duration")
            if row.get("state") == "generated" and seconds is not None:
                minutes = seconds / 60
                timed.append(minutes)
                passed = row.get("review", {}).get("promptAdherencePass") is True
                ax.bar(index, minutes, color=COLORS[index], width=.65,
                       hatch=None if passed else "//", edgecolor="#18263b")
                display_minutes, display_seconds = divmod(round(seconds), 60)
                ax.text(index, minutes, f"{display_minutes}m {display_seconds:02d}s",
                        ha="center", va="bottom", fontsize=10)
            else:
                ax.text(index, 0, row.get("state", "not run").replace("_", " "),
                        ha="center", va="bottom", fontsize=9, color="#78616b")
        ax.set_xticks(range(4), [p.upper() if p == "max" else p.title() for p in PRESETS])
        ax.set_xlim(-.6, 3.6)
        maximum_minutes = max(maximum_minutes, max(timed, default=0))
        ax.set_title("Messenger bust · 16:9" if "hero" in case else "Headphone portrait · 3:4", fontsize=13)
        ax.set_ylabel("Minutes to the finished image (lower is faster)")
        ax.spines[["top", "right"]].set_visible(False)
        ax.grid(axis="y", alpha=.15)
        ax.set_axisbelow(True)
    axes[0][0].set_ylim(0, maximum_minutes * 1.22)
    completed = sum(row["state"] == "generated" for row in data["runs"])
    total = len(data["plan"])
    fig.suptitle(f"Local image generation time · {completed}/{total} planned images generated", fontsize=16)
    fig.legend(handles=[Patch(facecolor="#517fe4", hatch="//", edgecolor="#18263b",
                              label="Render completed, but a visual requirement failed")],
               loc="lower center", bbox_to_anchor=(.5, .065), frameon=False)
    memory = data.get("memoryBytes")
    memory_label = f"{memory / 2**30:g} GiB" if type(memory) is int and memory > 0 else "RAM not recorded"
    sharing = {True: "shared host", False: "dedicated host"}.get(data.get("sharedHost"), "host sharing not recorded")
    fig.text(.5, .015,
             f"{data.get('hardware', 'Hardware not recorded')} · {memory_label} · {sharing} · 1 image per subject/preset\n"
             "Includes fresh worker + model loading + generation + decode + shutdown. MAX has 4× the pixels.",
             ha="center", fontsize=9, color="#505b69")
    fig.tight_layout(rect=(0, .15, 1, .93))
    return fig


def gallery_figure(data, directory):
    cases = list(dict.fromkeys(entry["case"] for entry in data["plan"]))
    ratios = [9 / 16 if "hero" in case else 4 / 3 for case in cases]
    fig, axes = plt.subplots(len(cases), 4, figsize=(16, 1.2 + 4 * sum(ratios)),
                             squeeze=False, gridspec_kw={"height_ratios": ratios})
    rows = {(row["case"], row["preset"]): row for row in data["runs"]}
    for case, axes_row in zip(cases, axes):
        for preset, ax in zip(PRESETS, axes_row):
            row = rows.get((case, preset), {})
            if row.get("state") == "generated":
                ax.imshow(plt.imread(directory / row["image"]))
                passed = row.get("review", {}).get("promptAdherencePass") is True
                width, height = row["expectedSize"]
                label = f"{preset.upper()} · {width} × {height}\n" + (
                    "Prompt checks passed" if passed else "Visual requirement failed")
            else:
                label = f"{preset.upper()} · {row.get('state', 'not run')}"
            ax.set_title(label, fontsize=12)
            ax.axis("off")
    fig.suptitle("Original model outputs · no retouching", fontsize=20)
    fig.text(.5, .015, "Preview scaling only. Open the linked original PNGs to inspect full-resolution detail.",
             ha="center", fontsize=11)
    # Reserve a real gutter for the two-line portrait titles. tight_layout can
    # place them over the landscape pixels when both rows keep equal aspect.
    fig.subplots_adjust(left=.02, right=.98, bottom=.06, top=.90, hspace=.22, wspace=.10)
    return fig


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish-from", type=Path)
    parser.add_argument("--reviews", type=Path, default=HERE / "reviews.json")
    parser.add_argument("--output", type=Path, default=HERE)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    data = (public_results(args.publish_from, args.reviews, args.output) if args.publish_from else
            json.loads((args.output / "results.json").read_text()))
    for name, figure in [("timings.png", timing_figure(data)),
                         ("gallery.png", gallery_figure(data, args.output))]:
        figure.savefig(args.output / name, dpi=160, facecolor="white")
        plt.close(figure)


if __name__ == "__main__":
    main()
