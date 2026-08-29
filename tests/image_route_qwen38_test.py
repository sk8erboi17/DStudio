#!/usr/bin/env python3
"""Regression tests for Qwen3.8 image routing/caption validation."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "image-route-qwen38.py"


def load_runner():
    spec = importlib.util.spec_from_file_location("dstudio_image_route_qwen38", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def expect_route_error(runner, function, fragment: str) -> None:
    try:
        function()
    except runner.RouteError as exc:
        assert fragment in str(exc), str(exc)
    else:
        raise AssertionError(f"expected RouteError containing {fragment!r}")


def main() -> None:
    runner = load_runner()

    # JSON member order is not semantic: reordered but exact schemas pass and
    # are serialized into the canonical provider order.
    decision = runner.canonical_exact_object(
        {"reason": "No source pixels are required.", "mode": "generate"},
        ("mode", "reason"),
        "routing decision",
    )
    assert tuple(decision) == ("mode", "reason")

    caption = runner.canonical_caption({
        "compositional_deconstruction": {
            "elements": [{
                "desc": "A brushed aluminium pendulum mechanism.",
                "bbox": [120, 180, 880, 820],
                "type": "obj",
            }],
            "background": "A pale concrete gallery wall under even museum lighting.",
        },
        "high_level_description": "A kinetic sculpture centered inside a quiet museum gallery.",
        "aspect_ratio": "16:9",
    }, "16:9")
    assert tuple(caption) == (
        "aspect_ratio", "high_level_description", "compositional_deconstruction"
    )
    composition = caption["compositional_deconstruction"]
    assert tuple(composition) == ("background", "elements")
    assert tuple(composition["elements"][0]) == ("type", "bbox", "desc")

    expect_route_error(
        runner,
        lambda: runner.canonical_exact_object(
            {"mode": "generate"}, ("mode", "reason"), "routing decision"
        ),
        "missing 'reason'",
    )
    expect_route_error(
        runner,
        lambda: runner.canonical_exact_object(
            {"mode": "generate", "reason": "valid", "fallback": "edit"},
            ("mode", "reason"),
            "routing decision",
        ),
        "unexpected 'fallback'",
    )
    expect_route_error(
        runner,
        lambda: runner.parse_object(
            '{"mode":"generate","mode":"edit","reason":"duplicate"}',
            "routing decision",
        ),
        "repeats JSON key 'mode'",
    )
    expect_route_error(
        runner,
        lambda: runner.canonical_caption({
            "aspect_ratio": "4:3",
            "high_level_description": "A valid description.",
            "compositional_deconstruction": {
                "background": "A valid background.", "elements": []
            },
        }, "16:9"),
        "changed the requested aspect ratio",
    )

    with tempfile.TemporaryDirectory(prefix="dstudio-qwen-route-") as temp:
        route_path = Path(temp) / "route.json"
        raw = "<think>diagnostic reasoning</think>\n{\"reason\":\"ok\",\"mode\":\"generate\"}"
        artifact = runner.preserve_model_response(route_path, "routing", raw)
        assert artifact.name == "qwen-routing-response.txt"
        assert artifact.read_text(encoding="utf-8") == raw + "\n"
        assert not list(artifact.parent.glob("*.tmp"))

    print("Qwen3.8 image route schema regression: OK")


if __name__ == "__main__":
    main()
