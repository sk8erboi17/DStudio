#!/usr/bin/env python3
"""Fail-closed deterministic preservation gate for source-dependent image edits."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageFilter, ImageStat


THRESHOLDS = {
    "maximumAspectDelta": 0.01,
    "maximumLumaMeanDelta": 0.06,
    "maximumRgbMeanDelta": 0.08,
    "minimumLumaCorrelation": 0.80,
    "minimumEdgeCorrelation": 0.65,
    "minimumHistogramIntersection": 0.82,
    "minimumNormalizedMae": 0.002,
    "maximumNormalizedMae": 0.22,
}


def correlation(left: list[int], right: list[int]) -> float:
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    numerator = sum(
        (left_value - left_mean) * (right_value - right_mean)
        for left_value, right_value in zip(left, right)
    )
    left_energy = sum((value - left_mean) ** 2 for value in left)
    right_energy = sum((value - right_mean) ** 2 for value in right)
    denominator = math.sqrt(left_energy * right_energy)
    return numerator / denominator if denominator else 0.0


def normalized_histogram(image: Image.Image) -> list[float]:
    histogram = image.histogram()
    total = sum(histogram)
    return [value / total for value in histogram]


def inspect(path: Path) -> tuple[Image.Image, dict[str, object]]:
    with Image.open(path) as opened:
        opened.load()
        metadata = {
            "format": opened.format,
            "mode": opened.mode,
            "width": opened.width,
            "height": opened.height,
            "aspect": opened.width / opened.height,
        }
        image = opened.convert("RGB")
    if metadata["format"] != "PNG" or min(image.size) < 256:
        raise ValueError(f"invalid comparison image: {path} ({metadata})")
    return image, metadata


def compare(source_path: Path, candidate_path: Path) -> dict[str, object]:
    source, source_metadata = inspect(source_path)
    candidate, candidate_metadata = inspect(candidate_path)
    comparison_size = (384, max(64, round(384 / source_metadata["aspect"])))
    source = source.resize(comparison_size, Image.Resampling.LANCZOS)
    candidate = candidate.resize(comparison_size, Image.Resampling.LANCZOS)

    source_gray = source.convert("L")
    candidate_gray = candidate.convert("L")
    source_luma = list(source_gray.getdata())
    candidate_luma = list(candidate_gray.getdata())
    source_edges = list(source_gray.filter(ImageFilter.FIND_EDGES).getdata())
    candidate_edges = list(candidate_gray.filter(ImageFilter.FIND_EDGES).getdata())
    source_rgb_mean = [value / 255 for value in ImageStat.Stat(source).mean]
    candidate_rgb_mean = [value / 255 for value in ImageStat.Stat(candidate).mean]
    source_histogram = normalized_histogram(source_gray)
    candidate_histogram = normalized_histogram(candidate_gray)

    metrics = {
        "aspectDelta": abs(source_metadata["aspect"] - candidate_metadata["aspect"]),
        "lumaMeanDelta": abs(
            sum(source_luma) / len(source_luma) - sum(candidate_luma) / len(candidate_luma)
        ) / 255,
        "rgbMeanDelta": max(
            abs(left - right) for left, right in zip(source_rgb_mean, candidate_rgb_mean)
        ),
        "lumaCorrelation": correlation(source_luma, candidate_luma),
        "edgeCorrelation": correlation(source_edges, candidate_edges),
        "histogramIntersection": sum(
            min(left, right) for left, right in zip(source_histogram, candidate_histogram)
        ),
        "normalizedMae": sum(
            abs(left - right) for left, right in zip(source_luma, candidate_luma)
        ) / (255 * len(source_luma)),
    }
    checks = {
        "aspectPreserved": metrics["aspectDelta"] <= THRESHOLDS["maximumAspectDelta"],
        "lumaMeanPreserved": metrics["lumaMeanDelta"] <= THRESHOLDS["maximumLumaMeanDelta"],
        "rgbMeanPreserved": metrics["rgbMeanDelta"] <= THRESHOLDS["maximumRgbMeanDelta"],
        "lumaStructurePreserved": metrics["lumaCorrelation"] >= THRESHOLDS["minimumLumaCorrelation"],
        "edgeStructurePreserved": metrics["edgeCorrelation"] >= THRESHOLDS["minimumEdgeCorrelation"],
        "tonalDistributionPreserved": metrics["histogramIntersection"] >= THRESHOLDS["minimumHistogramIntersection"],
        "editIsNotPixelIdentical": metrics["normalizedMae"] >= THRESHOLDS["minimumNormalizedMae"],
        "editIsLocalized": metrics["normalizedMae"] <= THRESHOLDS["maximumNormalizedMae"],
    }
    return {
        "ok": all(checks.values()),
        "policy": "source-preservation gate; semantic repair requires native DeepSeek/GLM vision",
        "source": {"path": str(source_path), **source_metadata},
        "candidate": {"path": str(candidate_path), **candidate_metadata},
        "comparisonSize": list(comparison_size),
        "thresholds": THRESHOLDS,
        "metrics": {name: round(value, 8) for name, value in metrics.items()},
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = compare(args.source.resolve(), args.candidate.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 5


if __name__ == "__main__":
    raise SystemExit(main())
