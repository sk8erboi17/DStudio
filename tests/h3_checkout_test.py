#!/usr/bin/env python3
"""Regression test for an empty ComfyUI --no-checkout worktree."""

from __future__ import annotations

import importlib.util
import json
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
            assert profile["steps"] == worker.MIN_SAMPLER_STEPS
            for width, height in profile["aspects"].values():
                assert width % 32 == 0 and height % 32 == 0
        assert worker.RENDER_PROFILES["preview"]["aspects"]["16:9"] == (608, 352)

        assert worker.selected_diffusion_spec(
            "Apple M2 Max", 96 * 2**30,
        )["name"] == worker.DIFFUSION_BF16_NAME
        assert worker.selected_diffusion_spec(
            "Apple M2 Max", 64 * 2**30,
        )["name"] == worker.DIFFUSION_INT8_NAME
        assert worker.selected_diffusion_spec(
            "Apple M5 Max", 128 * 2**30,
        )["name"] == worker.DIFFUSION_INT8_NAME

        runtime = base / "runtime"
        runtime.mkdir()
        server_command = worker.comfy_server_command(
            runtime, checkout, Path("/managed/python"), 23456,
        )
        assert "--use-pytorch-cross-attention" in server_command
        assert "--mmap-torch-files" in server_command
        assert "--cache-none" not in server_command
        assert "--disable-smart-memory" not in server_command
        assert server_command[server_command.index("--port") + 1] == "23456"

        m2_env: dict[str, str] = {}
        m2_profile = worker.configure_apple_accelerator_env(m2_env, "Apple M2 Max")
        assert m2_profile.startswith("M2 H3 kernels")
        for variable in worker.M1_M4_DISABLED_ACCELERATOR_ENV:
            assert m2_env[variable] == "off", f"{variable} must stay off on the M2 H3 path"

        override_env = {"ASFP8_INT8_EXT": "1"}
        worker.configure_apple_accelerator_env(override_env, "Apple M3 Pro")
        assert override_env["ASFP8_INT8_EXT"] == "1", "explicit power-user overrides must win"

        m5_env: dict[str, str] = {}
        m5_profile = worker.configure_apple_accelerator_env(m5_env, "Apple M5 Max")
        assert m5_profile.startswith("M5 runtime-probed")
        assert not m5_env, "M5 must retain the accelerator's runtime capability probes"

        graph = worker.build_prompt(
            "Animate the generated opening frame.", 864, 480, 5, 123,
            worker.OFFICIAL_ENCODER_NAME, worker.DIFFUSION_BF16_NAME,
            "qwen-first-frame.png", steps=10, output_prefix="DStudio/test/MiniMax-H3",
        )
        assert graph["3"]["inputs"]["unet_name"] == worker.DIFFUSION_BF16_NAME
        assert graph["5"]["inputs"]["length"] == 124
        assert graph["0"]["inputs"]["image"] == "qwen-first-frame.png"
        assert graph["5"]["inputs"]["first_frame"] == ["0", 0]
        assert graph["8"]["inputs"]["steps"] == worker.MIN_SAMPLER_STEPS
        assert graph["13"]["inputs"]["bit_depth"] == 8
        assert graph["14"]["inputs"]["filename_prefix"] == "DStudio/test/MiniMax-H3"
        assert graph["14"]["inputs"]["codec"] == "h264"
        assert graph["14"]["inputs"]["codec.encoding"] == "auto"

        worker.server_state_write(runtime, 12345, 23456)
        current_state = worker.server_state_read(runtime)
        assert current_state and current_state["pid"] == 12345
        state_path = runtime / worker.SERVER_STATE_NAME
        stale_state = json.loads(state_path.read_text(encoding="utf-8"))
        stale_state["version"] = worker.SERVER_RUNTIME_VERSION - 1
        state_path.write_text(json.dumps(stale_state), encoding="utf-8")
        assert worker.server_state_read(runtime) is None
        assert worker.server_state_read(runtime, require_current=False)["pid"] == 12345
        worker.server_state_remove(runtime)

        frame = base / "first-frame.png"
        frame.write_bytes(b"fixture-png")
        multipart, boundary = worker.encode_multipart_image(frame)
        assert multipart.count(b'filename="first-frame.png"') == 1
        assert multipart.endswith(f"--{boundary}--\r\n".encode())
        assert multipart.count(f"--{boundary}--".encode()) == 1

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
        log.write_text(
            "got prompt\r 10%|#| 1/10 [05:12<46:48, 312.02s/it]",
            encoding="utf-8",
        )
        progress, sampling_started = worker.inference_status(log, 40.0, 500.0)
        assert progress["step"] == 1 and progress["totalSteps"] == 10
        assert progress["etaSeconds"] == 46 * 60 + 48
        assert progress["secondsPerStep"] == 312
        later, _ = worker.inference_status(log, sampling_started, 800.0)
        assert later["etaSeconds"] == progress["etaSeconds"], (
            "an in-flight step must not inflate tqdm's measured ETA"
        )
        log.write_text("got prompt\r100%|##########| 20/20 [10:00<00:00]", encoding="utf-8")
        progress, _ = worker.inference_status(log, sampling_started, 101.0)
        assert progress["stage"] == "decoding"

    print("h3_checkout_test: ok")


if __name__ == "__main__":
    main()
