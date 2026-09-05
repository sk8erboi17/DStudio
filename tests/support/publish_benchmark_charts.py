#!/usr/bin/env python3
"""Publish reviewed aggregate receipts and render the September update charts.

No model runs or network access. Private PDF contents, paths, questions and
per-document records are deliberately excluded. With no receipt arguments,
regenerate all PNGs from the committed public JSON alone.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
BLUE, TEAL, GREY = "#2563eb", "#0f766e", "#64748b"
MAIN = "main-update-2026-09-05.json"
DESIGN = "design-development-2026-09-06.json"
PDF = "pdf-library-2026-09-05.json"


def count(value):
    if type(value) is not int or value < 0:
        raise ValueError("Expected a non-negative integer count")
    return value


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("Expected a SHA-256 digest")
    return value


def stats(value):
    result = {"n": count(value["n"])}
    for key in ("totalMs", "medianMs", "p95Ms", "maxMs"):
        number = value[key]
        if type(number) not in (int, float) or not math.isfinite(number) or number < 0:
            raise ValueError(f"Invalid timing: {key}")
        result[key] = number
    if not result["n"] or not result["medianMs"] <= result["p95Ms"] <= result["maxMs"]:
        raise ValueError("Inconsistent timing summary")
    return result


def design_public(source):
    """Export only metrics from the already validated paired comparison."""
    total = count(source["caseCount"])
    if total != 3 or len(source["results"]) != 2:
        raise ValueError("Expected the complete, frozen three-brief comparison")
    result = {"schema": "dstudio.design-development.public.v1", "caseCount": total,
              "auditorSha256": digest(source["auditorSha256"]), "results": []}
    for label, row in zip(("before-main", "after-main"), source["results"]):
        cases = row["cases"]
        if row["label"] != label or len(cases) != total or {c["id"] for c in cases} != {"archive", "repair", "workshop"}:
            raise ValueError("Missing, duplicate or mismatched Design cases")
        delivered = count(row["delivered"])
        passed = count(row["satisfyAuditedRequirements"])
        if delivered != sum(c["delivered"] is True for c in cases) or passed != sum(c["satisfiesAuditedRequirements"] is True for c in cases):
            raise ValueError("Design totals disagree with the per-case results")
        if not 0 <= passed <= delivered <= total:
            raise ValueError("Invalid Design success denominator")
        result["results"].append({
            "label": label, "delivered": delivered, "satisfyAuditedRequirements": passed,
            "binarySha256": digest(row["binarySha256"]),
            "designSourceSha256": digest(row["designSourceSha256"]),
            "cases": [{"id": c["id"], "delivered": c["delivered"] is True,
                       "satisfiesAuditedRequirements": c["satisfiesAuditedRequirements"] is True}
                      for c in cases],
        })
    return result


def pdf_public(source):
    """Allowlist aggregate numbers, never copy private nested records."""
    if source["schema"] != "dstudio.pdf-library.summary.v1":
        raise ValueError("Unsupported PDF receipt")
    result = {"schema": "dstudio.pdf-library.public.v1"}
    result["inventory"] = {k: count(source["inventory"][k]) for k in ("files", "pages", "bytes", "sparsePages")}
    result["retrieval"] = {k: count(source["retrieval"][k]) for k in ("total", "found", "textTotal", "textFound", "visualTotal", "visualFound")}
    result["evidence"] = {k: count(source["evidence"][k]) for k in ("total", "matched", "ambiguous")}
    for key in ("readFirst", "readWarm", "indexFirst", "queryIndexReuse", "queryIdentical"):
        result[key] = stats(source[key])
    for key in ("fullTextEligible", "originalsVerifiedSha256"):
        result[key] = count(source[key])
    wall = source["totalRetrievalBatchWallMs"]
    if type(wall) not in (int, float) or not math.isfinite(wall) or wall < 0:
        raise ValueError("Invalid total batch wall time")
    result["totalRetrievalBatchWallMs"] = wall
    result["manuallyReviewedAlternatePassages"] = len(source["manualReview"]["equivalentPassages"])
    result["coldTimingExclusions"] = sum(a.get("excludeColdFromIndependentTiming") is True for a in source["timingAnnotations"])
    result["queryTimingExclusions"] = sum(a.get("excludeQueryTimings") is True for a in source["timingAnnotations"])
    result["readerBinarySha256"] = sorted({digest(b["reader"]["sha256"]) for b in source["batches"]})
    result["embeddingBinarySha256"] = sorted({digest(b["embedding"]["sha256"]) for b in source["batches"]})
    r, e = result["retrieval"], result["evidence"]
    if not (r["found"] == r["textFound"] + r["visualFound"] <= r["total"] == r["textTotal"] + r["visualTotal"]
            and r["textFound"] <= r["textTotal"] and r["visualFound"] <= r["visualTotal"]
            and 0 <= e["matched"] <= e["total"] <= r["total"]
            and r["found"] + result["manuallyReviewedAlternatePassages"] <= r["total"]
            and result["readFirst"]["n"] == result["originalsVerifiedSha256"] == result["inventory"]["files"]):
        raise ValueError("Incomplete or inconsistent PDF counts")
    return result


def export_receipt(path, destination, project):
    raw = path.read_bytes()
    public = project(json.loads(raw))
    public["privateReceiptSha256"] = hashlib.sha256(raw).hexdigest()
    public["evidenceAvailability"] = "Aggregate data only. Original local receipts are not published; see the linked report for scope and limitations."
    destination.write_text(json.dumps(public, indent=2, ensure_ascii=False) + "\n")


def main_chart(plt, data, output):
    fig, axes = plt.subplots(2, 2, figsize=(12.8, 8.7))
    fig.subplots_adjust(left=.08, right=.98, top=.81, bottom=.14, hspace=.54, wspace=.22)
    fig.suptitle("Engine update: no clear speed gain in this run", fontsize=19, weight="bold", y=.97)
    fig.text(.5, .92, "Apple M2 Max · 96 GiB · 8k context · native Metal · before / after pinned main update", ha="center")
    keys = ("csv-copy", "numeric-sort", "record-extraction")
    labels = ("Copy a table", "Sort numbers", "Extract records")
    for row, model in enumerate(data["results"]):
        for column, (metric, title) in enumerate((("prefill", "Read the prompt"), ("decode", "Write the response"))):
            ax = axes[row, column]
            for offset, variant, color in ((-.18, "before", GREY), (.18, "after", BLUE)):
                values = [model["comparison"][k][variant] for k in keys]
                if not all(v["allCorrect"] is True for v in values):
                    raise ValueError("Cannot chart an unqualified speed comparison")
                med = [v[metric]["median"] for v in values]
                bars = ax.bar([i + offset for i in range(3)], med, .34, color=color,
                              label=variant.title(), yerr=[[m - v[metric]["min"] for m, v in zip(med, values)],
                              [v[metric]["max"] - m for m, v in zip(med, values)]], capsize=3)
                ax.bar_label(bars, labels=[f"{v:.2f}" for v in med], padding=10, fontsize=10)
            ax.set(title=f"{model['name']} · {title}", ylabel="Tokens / second", xticks=range(3), xticklabels=labels)
            ax.set_ylim(0, max(model["comparison"][k][v][metric]["max"] for k in keys for v in ("before", "after")) * 1.30)
            ax.grid(axis="y", alpha=.22)
    fig.legend(*axes[0, 0].get_legend_handles_labels(), frameon=False,
               loc="upper center", bbox_to_anchor=(.5, .90), ncols=2)
    fig.text(.5, .055, "Median of 3 repetitions; whiskers = observed min–max, not confidence intervals. Short prompts, not peak prefill.\n"
             "36/36 measured answers correct; 44/48 including auxiliary checks. Shared-host load was not controlled.", ha="center", fontsize=10)
    fig.savefig(output / "main-update-prefill-decode.png", dpi=180)
    plt.close(fig)


def design_chart(plt, data, output):
    fig, ax = plt.subplots(figsize=(10.5, 5.6))
    fig.subplots_adjust(left=.1, right=.97, top=.73, bottom=.23)
    fig.suptitle("Design: no overall win across these 3 briefs", fontsize=18, weight="bold", y=.96)
    fig.text(.5, .87, "Real native agent · same model/settings · one generation per brief and variant", ha="center")
    for offset, row, name, color in zip((-.18, .18), data["results"], ("Before", "Revised"), (GREY, BLUE)):
        bars = ax.bar([offset, 1 + offset], [row["delivered"], row["satisfyAuditedRequirements"]], .34, label=name, color=color)
        ax.bar_label(bars, labels=[f"{int(b.get_height())}/{data['caseCount']}" for b in bars], padding=5, fontsize=13)
    ax.set(xticks=(0, 1), xticklabels=("Project delivered", "Delivered + all independent checks"), ylabel="Projects", ylim=(0, 3.6), yticks=(0, 1, 2, 3))
    ax.grid(axis="y", alpha=.22)
    ax.legend(frameon=False, loc="upper right")
    fig.text(.5, .07, "Initial frozen comparison only: later targeted retries do not replace failures.\n"
             "Functional checks are not an aesthetic score; these are development briefs, not held-out tasks.", ha="center", fontsize=10)
    fig.savefig(output / "design-development-comparison.png", dpi=180)
    plt.close(fig)


def pdf_chart(plt, data, output):
    fig, axes = plt.subplots(1, 2, figsize=(13, 6.8))
    fig.subplots_adjust(left=.20, right=.91, top=.76, bottom=.26, wspace=1.25)
    inventory, r, e = data["inventory"], data["retrieval"], data["evidence"]
    fig.suptitle("PDF library: finding text is not the same as locating its citation", fontsize=17, weight="bold", y=.96)
    fig.text(.5, .89, f"{inventory['files']} private PDFs · {inventory['pages']:,} pages · {r['total']} questions · M2 Max, 96 GiB", ha="center")
    values = (r["found"], e["matched"])
    totals = (r["total"], e["total"])
    rates = [v / n * 100 for v, n in zip(values, totals)]
    ax = axes[0]
    bars = ax.barh((1, 0), rates, color=TEAL, height=.42)
    ax.barh((1, 0), [100 - p for p in rates], left=rates, color="#eadad5", height=.42)
    ax.bar_label(bars, labels=[f"{v}/{n}" for v, n in zip(values, totals)], label_type="center", color="white", weight="bold", fontsize=14)
    ax.set(yticks=(1, 0), yticklabels=("Expected page\nand quote found", "Citation located\nwith coordinates"), xlim=(0, 100), xticks=(0, 50, 100), xlabel="Successful checks (%)", title="Different checks, different denominators")
    ax = axes[1]
    keys = ("readFirst", "indexFirst", "queryIndexReuse", "queryIdentical")
    labels = ("Text + preview", "First index + search", "Search, index ready", "Identical query, cached")
    seconds = [data[k]["medianMs"] / 1000 for k in keys]
    ax.scatter(seconds, range(4), color=BLUE, s=50)
    for i, (value, key) in enumerate(zip(seconds, keys)):
        ax.annotate(f"{value:.3f} s · n={data[key]['n']}", (value, i), xytext=(7, 7), textcoords="offset points", fontsize=10)
    ax.set_xscale("log")
    ax.set(yticks=range(4), yticklabels=labels, ylim=(3.55, -.55), xlim=(.07, 1300), xlabel="Median seconds · logarithmic scale", title="Separate stages, not a speedup comparison")
    ax.grid(axis="x", alpha=.22)
    fig.text(.5, .07, f"{data['manuallyReviewedAlternatePassages']} additional alternate passages confirmed manually; not added to strict recall. No OCR or answer-generating LLM.\n"
             "Initial run including failures; fresh DStudio indexes, not a flushed OS cache. Timing samples/exclusions differ by stage.\n"
             "Real embeddings + Poppler coordinates; not a browser-modal test. Private raw documents/receipts are not published.", ha="center", fontsize=10)
    fig.savefig(output / "pdf-library-quality-latency.png", dpi=180)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--design-receipt", type=Path)
    parser.add_argument("--pdf-receipt", type=Path)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "docs/benchmarks")
    parser.add_argument("--output", type=Path, default=ROOT / "assets/README images/benchmarks")
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    if args.design_receipt:
        export_receipt(args.design_receipt, args.data_dir / DESIGN, design_public)
    if args.pdf_receipt:
        export_receipt(args.pdf_receipt, args.data_dir / PDF, pdf_public)
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11,
                         "axes.spines.top": False, "axes.spines.right": False,
                         "axes.axisbelow": True, "text.color": "#172033"})
    for filename, plot in ((MAIN, main_chart), (DESIGN, design_chart), (PDF, pdf_chart)):
        plot(plt, json.loads((args.data_dir / filename).read_text()), args.output)
    print(f"Rendered 3 Matplotlib charts in {args.output}")


if __name__ == "__main__":
    main()
