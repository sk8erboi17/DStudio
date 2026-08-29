#!/usr/bin/env python3
"""Process-group cancellation regression for the image coordinator."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time


ROOT = Path(__file__).resolve().parents[1]
PIPELINE = ROOT / "scripts" / "image-pipeline-run.py"


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def main() -> None:
    spec = importlib.util.spec_from_file_location("dstudio_image_pipeline", PIPELINE)
    assert spec and spec.loader
    pipeline = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pipeline)

    with tempfile.TemporaryDirectory(prefix="dstudio-image-interrupt-") as raw:
        temporary = Path(raw)
        grandchild_pid_path = temporary / "grandchild.pid"
        child_program = (
            "import pathlib, subprocess, sys, time\n"
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
            f"pathlib.Path({str(grandchild_pid_path)!r}).write_text(str(child.pid), encoding='ascii')\n"
            "time.sleep(60)\n"
        )
        failures: list[BaseException] = []

        def launch() -> None:
            try:
                pipeline.run([sys.executable, "-c", child_program])
            except BaseException as exc:
                failures.append(exc)

        thread = threading.Thread(target=launch)
        thread.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if pipeline.ACTIVE_PROCESS is not None and grandchild_pid_path.is_file():
                break
            time.sleep(0.02)
        assert pipeline.ACTIVE_PROCESS is not None, "image backend process did not start"
        assert grandchild_pid_path.is_file(), "image backend fixture did not spawn its child"
        parent_pid = pipeline.ACTIVE_PROCESS.pid
        grandchild_pid = int(grandchild_pid_path.read_text(encoding="ascii"))
        assert pid_alive(parent_pid) and pid_alive(grandchild_pid)

        pipeline.terminate_active_process()
        thread.join(timeout=8)
        assert not thread.is_alive(), "image pipeline run did not unwind after cancellation"
        assert failures and isinstance(failures[0], pipeline.PipelineError), failures

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and (
            pid_alive(parent_pid) or pid_alive(grandchild_pid)
        ):
            time.sleep(0.05)
        assert not pid_alive(parent_pid), "image backend parent survived process-group cancellation"
        assert not pid_alive(grandchild_pid), "image backend child survived process-group cancellation"
        assert pipeline.ACTIVE_PROCESS is None

    print("image_pipeline_interrupt_test: ok")


if __name__ == "__main__":
    main()
