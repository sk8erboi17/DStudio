#!/usr/bin/env python3
"""Regression tests for the pinned native h3.c manager (no engine launch)."""

from __future__ import annotations

import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace


REPO_ROOT = Path(__file__).resolve().parents[2]
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

    constrained_env: dict[str, str] = {}
    assert worker.configure_weight_residency(constrained_env, 64 * 2**30) == "transformer"
    assert constrained_env["H3_ZERO_COPY_WEIGHTS"] == "transformer"
    roomy_env: dict[str, str] = {}
    assert worker.configure_weight_residency(roomy_env, 96 * 2**30) == "native-default"
    assert "H3_ZERO_COPY_WEIGHTS" not in roomy_env
    override_env = {"H3_ZERO_COPY_WEIGHTS": "0"}
    assert worker.configure_weight_residency(override_env, 96 * 2**30) == "0"
    assert override_env["H3_ZERO_COPY_WEIGHTS"] == "0"
    mapped_env: dict[str, str] = {}
    assert worker.configure_dit_scheduling(mapped_env, "balanced", "transformer") == "1"
    assert mapped_env["H3_DIT_COMMAND_BLOCKS"] == "1"
    native_quality_env: dict[str, str] = {}
    assert worker.configure_dit_scheduling(
        native_quality_env, "quality", "native-default",
    ) == "1"
    assert native_quality_env["H3_DIT_COMMAND_BLOCKS"] == "1"
    native_balanced_env: dict[str, str] = {}
    assert worker.configure_dit_scheduling(
        native_balanced_env, "balanced", "native-default",
    ) == "native-default"
    assert "H3_DIT_COMMAND_BLOCKS" not in native_balanced_env
    scheduling_override = {"H3_DIT_COMMAND_BLOCKS": "4"}
    assert worker.configure_dit_scheduling(
        scheduling_override, "quality", "transformer",
    ) == "4"
    assert scheduling_override["H3_DIT_COMMAND_BLOCKS"] == "4"
    quality_metal_env: dict[str, str] = {}
    assert worker.configure_quality_metal_scheduling(
        quality_metal_env, "quality",
    ) == ("1", "8")
    assert quality_metal_env == {
        "H3_DIT_STAGE_SUBMITS": "1", "H3_SDPA_QUERY_CHUNK": "8",
    }
    balanced_metal_env: dict[str, str] = {}
    assert worker.configure_quality_metal_scheduling(
        balanced_metal_env, "balanced",
    ) == ("disabled", "disabled")
    metal_override = {
        "H3_DIT_STAGE_SUBMITS": "0", "H3_SDPA_QUERY_CHUNK": "1024",
    }
    assert worker.configure_quality_metal_scheduling(
        metal_override, "quality",
    ) == ("0", "1024")
    assert worker.metal_failure_from_log("ordinary H3 progress") is None
    assert worker.metal_failure_from_log(
        'Filtering using "kIOGPUCommandBufferCallbackError"'
    ) is None
    detected = worker.metal_failure_from_log(
        json.dumps({
            "eventMessage": (
                "IOGPU: "
                "kIOGPUCommandBufferCallbackErrorImpactingInteractivity"
            ),
            "processID": 123,
        })
    )
    assert detected and "ImpactingInteractivity" in detected

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
        stream = worker.H3ProgressStreamParser(quiet_seconds=0.1)
        assert stream.feed("\rdenoise                    0/20  ", 100.0) == ()
        assert stream.poll(100.05) == ()
        assert stream.poll(100.11) == (("denoise", 0, 20),)
        # The next CR delimitates the already published tail; it is not emitted
        # twice. The new total is deliberately split mid-number to prove that
        # the quiet commit cannot accept the transient `1/2` fragment.
        assert stream.feed("\rdenoise                    1/2", 101.0) == ()
        assert stream.poll(101.05) == ()
        assert stream.feed("0  ", 101.06) == ()
        assert stream.poll(101.17) == (("denoise", 1, 20),)
        assert stream.poll(102.0) == ()
        assert stream.feed("\rffmpeg                    1/1  ", 103.0) == ()
        assert stream.poll(103.0, force=True) == (("ffmpeg", 1, 1),)
        assert stream.poll(104.0, force=True) == ()

        # End-to-end regression for the real h3.c framing protocol. The fake
        # native child writes one carriage-return status without a newline and
        # stays alive. The worker must publish 1/20 before EOF; the old parser
        # could only publish that record after the following native update.
        fake_binary = base / "fake-h3"
        fake_binary.write_text(
            "#!/usr/bin/env python3\n"
            "import pathlib, sys, time\n"
            "output = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])\n"
            "release = pathlib.Path(__file__).with_name('fake-h3-release')\n"
            "sys.stderr.write('\\rdenoise                    1/20  ')\n"
            "sys.stderr.flush()\n"
            "while not release.exists():\n"
            "    time.sleep(0.02)\n"
            "output.write_bytes(b'fake-h3-video')\n",
            encoding="utf-8",
        )
        fake_binary.chmod(0o755)
        fake_release = base / "fake-h3-release"
        prompt_file = base / "prompt.txt"
        prompt_file.write_text("Animate the fixture.", encoding="utf-8")
        live_status = base / "live-status.json"
        original_monitor = worker.start_metal_log_monitor
        original_inspector = worker.inspect_video_output

        def fake_monitor(_process_id: int) -> subprocess.Popen[bytes]:
            return subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, start_new_session=True,
            )

        worker.start_metal_log_monitor = fake_monitor
        worker.inspect_video_output = lambda *_args: {
            "codec": "h264", "pixelFormat": "yuv420p", "width": 1344,
            "height": 768, "durationSeconds": 5.0, "hasAudio": False,
            "fullyDecoded": True,
        }
        generated: list[Path] = []
        generation_errors: list[BaseException] = []

        def run_fake_generation() -> None:
            try:
                generated.append(worker.generate(
                    SimpleNamespace(
                        outdir=str(base / "fake-job"),
                        prompt_file=str(prompt_file), duration=5,
                        aspect="16:9", profile="quality", seed=7,
                        first_frame="", reference_image=[],
                        status_file=live_status,
                    ),
                    base, fake_binary, base / "fake-model",
                ))
            except BaseException as exc:  # Preserve the worker-thread failure.
                generation_errors.append(exc)

        generation_thread = threading.Thread(target=run_fake_generation)
        try:
            generation_thread.start()
            observed_live_progress = False
            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline:
                if live_status.is_file():
                    current = json.loads(live_status.read_text(encoding="utf-8"))
                    if current.get("step") == 1 and current.get("totalSteps") == 20:
                        assert current.get("powerAssertion") == worker.POWER_ASSERTION_MODE
                        observed_live_progress = generation_thread.is_alive()
                        break
                time.sleep(0.02)
            assert observed_live_progress, (
                "undelimited H3 progress was not published while the native "
                "process was still running"
            )
            fake_release.write_text("release\n", encoding="ascii")
            generation_thread.join(timeout=8)
            assert not generation_thread.is_alive(), "fake H3 generation did not finish"
            assert not generation_errors, f"fake H3 generation failed: {generation_errors}"
            assert len(generated) == 1 and generated[0].is_file()
            assert worker.ACTIVE_POWER_ASSERTION is None
        finally:
            fake_release.touch(exist_ok=True)
            if generation_thread.is_alive():
                worker.terminate_active_process()
                generation_thread.join(timeout=8)
            worker.start_metal_log_monitor = original_monitor
            worker.inspect_video_output = original_inspector

        original_power_assertion = worker.start_power_assertion

        def failed_power_assertion(_process_id: int) -> subprocess.Popen[bytes]:
            return subprocess.Popen(
                [sys.executable, "-c", "pass"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )

        failed_job = base / "failed-power-job"
        fake_release.unlink(missing_ok=True)
        failed_power_release = threading.Timer(
            10.0, lambda: fake_release.touch(exist_ok=True),
        )
        failed_power_release.daemon = True
        failed_power_release.start()
        worker.start_metal_log_monitor = fake_monitor
        worker.start_power_assertion = failed_power_assertion
        worker.inspect_video_output = lambda *_args: {}
        try:
            try:
                worker.generate(
                    SimpleNamespace(
                        outdir=str(failed_job), prompt_file=str(prompt_file),
                        duration=5, aspect="16:9", profile="quality", seed=8,
                        first_frame="", reference_image=[],
                        status_file=failed_job / "status.json",
                    ),
                    base, fake_binary, base / "fake-model",
                )
                raise AssertionError("H3 accepted an expired power assertion")
            except worker.H3Error as exc:
                assert "idle-sleep protection failed" in str(exc)
            failure = json.loads(
                (failed_job / "h3-failure.json").read_text(encoding="utf-8")
            )
            assert failure["kind"] == "power-assertion"
            assert failure["powerAssertion"] == worker.POWER_ASSERTION_MODE
            assert worker.ACTIVE_PROCESS is None
            assert worker.ACTIVE_METAL_MONITOR is None
            assert worker.ACTIVE_POWER_ASSERTION is None
        finally:
            fake_release.touch(exist_ok=True)
            failed_power_release.cancel()
            failed_power_release.join(timeout=1)
            worker.terminate_active_process()
            worker.start_metal_log_monitor = original_monitor
            worker.start_power_assertion = original_power_assertion
            worker.inspect_video_output = original_inspector

        sampling = worker.progress_payload("denoise", 5, 20, time.monotonic() - 20)
        assert sampling["stage"] == "sampling"
        assert sampling["step"] == 5 and sampling["totalSteps"] == 20
        assert sampling["etaSeconds"] > 0
        conditioning = worker.progress_payload("text encoder", 10, 50)
        assert conditioning["stage"] == "conditioning"
        reference_encoding = worker.progress_payload("video VAE encoder", 36, 36)
        assert reference_encoding["stage"] == "conditioning"
        decoder_loading = worker.progress_payload("video VAE load", 36, 36)
        assert decoder_loading["stage"] == "decoder-load"
        decoding = worker.progress_payload("video VAE load", 18, 36, cycle=1)
        assert decoding["stage"] == "decoding"
        assert decoding["progress"] >= decoder_loading["progress"]

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
        floor = worker.publish_native_status(
            status,
            {"stage": "conditioning", "label": "Conditioning", "progress": 12,
             "nativePhase": "video VAE encoder", "step": 1, "totalSteps": 36},
            width=1344, height=768, profile="quality",
            weight_residency="transformer", command_blocks="1",
            stage_submits="1", sdpa_query_chunk="2048",
            started=time.monotonic() - 31, progress_floor=61, heartbeat=True,
        )
        payload = json.loads(status.read_text(encoding="utf-8"))
        assert floor == 61 and payload["progress"] == 61
        assert payload["heartbeat"] is True and payload["elapsedSeconds"] >= 30
        assert payload["commandBlocks"] == "1"
        assert payload["stageSubmits"] == "1"
        assert payload["sdpaQueryChunk"] == "2048"

        # A stop that wins the race before h3-run writes/loads anything must be
        # terminal and must not create even the test-mode MP4. This exercises
        # the same durable marker passed by the HTTP coordinator, without
        # checking out or loading the native model.
        cancelled_job = base / "cancelled-job"
        cancelled_job.mkdir()
        cancelled_prompt = cancelled_job / "prompt.txt"
        cancelled_prompt.write_text("This must never render.", encoding="utf-8")
        cancelled_status = cancelled_job / "status.json"
        cancelled_marker = cancelled_job / "cancel-requested"
        cancelled_marker.write_text("cancelled\n", encoding="ascii")
        cancelled_env = os.environ.copy()
        cancelled_env["DSTUDIO_VIDEO_TEST_MODE"] = "1"
        cancelled_env["DSTUDIO_H3_HOME"] = str(base / "cancelled-runtime")
        cancelled = subprocess.run([
            sys.executable, str(WORKER_PATH),
            "--prompt-file", str(cancelled_prompt),
            "--outdir", str(cancelled_job),
            "--status-file", str(cancelled_status),
            "--cancel-file", str(cancelled_marker),
            "--duration", "5", "--aspect", "16:9", "--profile", "quality",
        ], env=cancelled_env, check=False, capture_output=True, text=True)
        assert cancelled.returncode == 130, cancelled.stderr
        cancelled_payload = json.loads(cancelled_status.read_text(encoding="utf-8"))
        assert cancelled_payload["ok"] is False
        assert cancelled_payload["state"] == "error"
        assert cancelled_payload["stage"] == "cancelled"
        assert not list(cancelled_job.glob("*.mp4"))
        assert not (cancelled_job / "worker.pid").exists()

        if shutil.which("ffmpeg") and shutil.which("ffprobe"):
            media_file = base / "contract.mp4"
            media_file.write_bytes(base64.b64decode(worker.TEST_MP4_B64))
            media = worker.inspect_video_output(media_file, 16, 16, 0)
            assert media["fullyDecoded"] is True

    print("h3_checkout_test: ok")


if __name__ == "__main__":
    main()
