#!/usr/bin/env python3
"""Regression tests for the pinned native h3.c manager (no engine launch)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKER_PATH = REPO_ROOT / "scripts" / "h3-run.py"


def command(*args: str, cwd: Path) -> str:
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def main() -> None:
    git = shutil.which("git")
    assert git, "git is required for the H3 checkout regression test"

    spec = importlib.util.spec_from_file_location("dstudio_h3_run", WORKER_PATH)
    assert spec and spec.loader
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)

    assert worker.H3_REPOSITORY == "https://github.com/antirez/h3.c.git"
    assert len(worker.H3_COMMIT) == 40
    assert worker.MODEL_REPOSITORY == "MiniMaxAI/MiniMax-H3"
    assert len(worker.MODEL_REVISION) == 40
    assert len(worker.MODEL_FILES) == 36
    assert worker.MODEL_TOTAL_BYTES == 144_023_550_851

    with tempfile.TemporaryDirectory(prefix="dstudio-h3-native-checkout-") as temporary:
        base = Path(temporary)
        source = base / "source"
        checkout = base / "checkout"
        source.mkdir()
        subprocess.run([git, "init", "--quiet"], cwd=source, check=True)
        subprocess.run([git, "config", "user.name", "DStudio test"], cwd=source, check=True)
        subprocess.run([git, "config", "user.email", "test@dstudio.local"], cwd=source, check=True)

        for relative in worker.H3_REQUIRED_FILES:
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"fixture for {relative}\n", encoding="utf-8")
        subprocess.run([git, "add", "."], cwd=source, check=True)
        subprocess.run([git, "commit", "--quiet", "-m", "fixture"], cwd=source, check=True)
        revision = command(git, "rev-parse", "HEAD", cwd=source)

        subprocess.run([git, "clone", "--quiet", "--no-checkout", str(source), str(checkout)], check=True)
        assert command(git, "rev-parse", "HEAD", cwd=checkout) == revision
        assert not (checkout / "Makefile").exists(), (
            "the fixture must reproduce HEAD-at-revision with an empty worktree"
        )

        worker.H3_COMMIT = revision
        worker.ensure_h3_checkout(checkout, git)
        for relative in worker.H3_REQUIRED_FILES:
            assert (checkout / relative).is_file(), f"checkout repair did not restore {relative}"

        for profile in worker.RENDER_PROFILES.values():
            assert profile["steps"] == worker.MIN_SAMPLER_STEPS
            assert 1 <= profile["reuse"] <= 3
            assert 1 <= profile["layers"] <= 50
            for aspect, (width, height) in profile["aspects"].items():
                assert width % 32 == 0 and height % 32 == 0
                assert width * height <= 768 * 1344
                render = profile.get("render_aspects", {}).get(aspect)
                if render:
                    render_width, render_height = render
                    assert render_width % 32 == 0 and render_height % 32 == 0
                    assert render_width * height == render_height * width
                    assert render_width <= width and render_height <= height

        binary = Path("/managed/h3.c/h3")
        model = Path("/managed/MiniMax-H3")
        output = Path("/job/video.mp4")
        preview = worker.native_command(
            binary, model, "Animate the opening frame.", output,
            5, "16:9", "preview", 123, "/job/opening.png",
        )
        assert preview[:7] == [
            str(binary), "-d", str(model), "-p", "Animate the opening frame.", "-o", str(output),
        ]
        assert preview[preview.index("--steps") + 1] == "20"
        assert preview[preview.index("--layers") + 1] == "40"
        assert preview[preview.index("--reuse") + 1] == "3"
        assert preview[preview.index("--render-width") + 1] == "448"
        assert preview[preview.index("--render-height") + 1] == "256"
        assert preview[preview.index("--first-frame") + 1] == "/job/opening.png"

        balanced = worker.native_command(
            binary, model, "A fox.", output, 8, "1:1", "balanced", 42,
        )
        assert balanced[balanced.index("--layers") + 1] == "45"
        assert balanced[balanced.index("--reuse") + 1] == "2"
        assert "--render-width" not in balanced

        quality = worker.native_command(
            binary, model, "A fox.", output, 15, "4:3", "quality", 42,
        )
        assert quality[quality.index("--width") + 1] == "1024"
        assert quality[quality.index("--height") + 1] == "768"
        assert quality[quality.index("--layers") + 1] == "50"
        assert quality[quality.index("--reuse") + 1] == "1"

        assert worker.parse_progress_fragment("denoise                    5/20  ") == (
            "denoise", 5, 20,
        )
        assert worker.parse_progress_fragment("not progress") is None
        sampling = worker.progress_payload("denoise", 5, 20, time.monotonic() - 20)
        assert sampling["stage"] == "sampling"
        assert sampling["step"] == 5 and sampling["totalSteps"] == 20
        assert sampling["etaSeconds"] > 0
        conditioning = worker.progress_payload("text encoder", 10, 50)
        assert conditioning["stage"] == "conditioning"
        decoding = worker.progress_payload("video VAE load", 36, 36)
        assert decoding["stage"] == "decoding"

        model_dir = base / "model"
        for file_spec in worker.MODEL_FILES:
            target = worker.model_destination(model_dir, file_spec)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as handle:
                handle.truncate(int(file_spec["size"]))
        marker = base / "model-revision"
        marker.write_text(worker.MODEL_REVISION + "\n", encoding="ascii")
        assert worker.model_ready(model_dir, marker)
        assert worker.downloaded_bytes(model_dir) == worker.MODEL_TOTAL_BYTES
        assert f"/{worker.MODEL_REVISION}/" in worker.download_url("FL2VA/transformer/config.json")

        status = base / "status.json"
        worker.status_write(
            status, "running", "sampling", "Native denoise", 61,
            step=5, totalSteps=20,
        )
        payload = json.loads(status.read_text(encoding="utf-8"))
        assert payload["stage"] == "sampling" and payload["step"] == 5

    print("h3_checkout_test: ok")


if __name__ == "__main__":
    main()
