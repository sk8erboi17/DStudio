#!/usr/bin/env python3
"""Regression test for an empty ComfyUI --no-checkout worktree."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile


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

    with tempfile.TemporaryDirectory(prefix="dstudio-h3-checkout-") as temporary:
        base = Path(temporary)
        source = base / "source"
        checkout = base / "checkout"
        source.mkdir()
        subprocess.run([git, "init", "--quiet"], cwd=source, check=True)
        subprocess.run([git, "config", "user.name", "DStudio test"], cwd=source, check=True)
        subprocess.run([git, "config", "user.email", "test@dstudio.local"], cwd=source, check=True)

        for relative in worker.COMFY_REQUIRED_FILES:
            target = source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"fixture for {relative}\n", encoding="utf-8")
        subprocess.run([git, "add", "."], cwd=source, check=True)
        subprocess.run([git, "commit", "--quiet", "-m", "fixture"], cwd=source, check=True)
        revision = command(git, "rev-parse", "HEAD", cwd=source)

        subprocess.run([git, "clone", "--quiet", "--no-checkout", str(source), str(checkout)], check=True)
        assert command(git, "rev-parse", "HEAD", cwd=checkout) == revision
        assert not (checkout / "requirements.txt").exists(), (
            "the fixture must reproduce HEAD-at-revision with an empty worktree"
        )

        worker.COMFY_COMMIT = revision
        worker.ensure_comfy_checkout(checkout, git)
        for relative in worker.COMFY_REQUIRED_FILES:
            assert (checkout / relative).is_file(), f"checkout repair did not restore {relative}"

        accelerator_source = base / "accelerator-source"
        accelerator_checkout = checkout / "custom_nodes" / worker.MPS_ACCELERATOR_DIR
        accelerator_source.mkdir()
        subprocess.run([git, "init", "--quiet"], cwd=accelerator_source, check=True)
        subprocess.run([git, "config", "user.name", "DStudio test"], cwd=accelerator_source, check=True)
        subprocess.run([git, "config", "user.email", "test@dstudio.local"], cwd=accelerator_source, check=True)
        for relative in worker.MPS_ACCELERATOR_REQUIRED_FILES:
            target = accelerator_source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"fixture for {relative}\n", encoding="utf-8")
        subprocess.run([git, "add", "."], cwd=accelerator_source, check=True)
        subprocess.run([git, "commit", "--quiet", "-m", "accelerator fixture"], cwd=accelerator_source, check=True)
        accelerator_revision = command(git, "rev-parse", "HEAD", cwd=accelerator_source)
        accelerator_checkout.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            git, "clone", "--quiet", "--no-checkout",
            str(accelerator_source), str(accelerator_checkout),
        ], check=True)
        worker.MPS_ACCELERATOR_COMMIT = accelerator_revision
        worker.ensure_mps_accelerator_checkout(checkout, git)
        for relative in worker.MPS_ACCELERATOR_REQUIRED_FILES:
            assert (accelerator_checkout / relative).is_file(), (
                f"accelerator checkout repair did not restore {relative}"
            )

        for profile in worker.RENDER_PROFILES.values():
            assert profile["steps"] in (10, 20)
            for width, height in profile["aspects"].values():
                assert width % 32 == 0 and height % 32 == 0

        log = base / "comfyui.log"
        log.write_text("got prompt\n", encoding="utf-8")
        progress, sampling_started = worker.inference_status(log, None, 100.0)
        assert progress["stage"] == "conditioning"
        assert sampling_started is None
        log.write_text("got prompt\r 25%|##| 5/20 [01:00<03:00]", encoding="utf-8")
        progress, sampling_started = worker.inference_status(log, 40.0, 100.0)
        assert progress["stage"] == "sampling"
        assert progress["step"] == 5 and progress["totalSteps"] == 20
        assert progress["etaSeconds"] == 180
        log.write_text("got prompt\r100%|##########| 20/20 [10:00<00:00]", encoding="utf-8")
        progress, _ = worker.inference_status(log, sampling_started, 101.0)
        assert progress["stage"] == "decoding"

    print("h3_checkout_test: ok")


if __name__ == "__main__":
    main()
