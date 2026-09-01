#!/usr/bin/env python3
"""Run the image backend selected by the native model's explicit directive."""

from __future__ import annotations

import argparse
import atexit
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


class PipelineError(RuntimeError):
    pass


ACTIVE_PROCESS: subprocess.Popen[str] | None = None


def terminate_active_process() -> None:
    global ACTIVE_PROCESS
    process = ACTIVE_PROCESS
    if process is None or process.poll() is not None:
        ACTIVE_PROCESS = None
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
    ACTIVE_PROCESS = None


def handle_termination(_signum: int, _frame: object) -> None:
    terminate_active_process()
    raise KeyboardInterrupt


def status_write(path: Path, state: str, stage: str, label: str, progress: int) -> None:
    payload = {
        "ok": state != "error",
        "state": state,
        "stage": stage,
        "label": label,
        "progress": max(0, min(100, int(progress))),
        "updatedAt": int(time.time() * 1000),
    }
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def run(command: list[str]) -> None:
    global ACTIVE_PROCESS
    process = subprocess.Popen(
        command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL, start_new_session=True,
    )
    ACTIVE_PROCESS = process
    try:
        stdout, stderr = process.communicate()
    finally:
        ACTIVE_PROCESS = None
    if stdout:
        print(stdout, end="", flush=True)
    if stderr:
        print(stderr, end="", file=sys.stderr, flush=True)
    if process.returncode:
        detail = (stderr or stdout or "worker failed").strip()[-4000:]
        raise PipelineError(f"{Path(command[0]).name} failed ({process.returncode}): {detail}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--status-file", required=True)
    parser.add_argument("--cancel-file")
    parser.add_argument("--aspect", default="16:9")
    parser.add_argument("--action", choices=("generate", "edit"), required=True)
    parser.add_argument("--preserve", choices=("none", "face"), default="none")
    parser.add_argument("--input", action="append", default=[])
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    prompt_path = Path(args.prompt_file).resolve()
    outdir = Path(args.outdir).resolve()
    status_path = Path(args.status_file).resolve()
    cancel_path = Path(args.cancel_file).resolve() if args.cancel_file else None
    outdir.mkdir(parents=True, exist_ok=True)
    worker_pid = outdir / "worker.pid"
    worker_pid.write_text(f"{os.getpid()}\n", encoding="ascii")
    atexit.register(lambda: worker_pid.unlink(missing_ok=True))
    started = time.monotonic()
    try:
        if cancel_path is not None and cancel_path.is_file():
            status_write(status_path, "error", "cancelled",
                         "Image generation cancelled before worker startup.", 100)
            return 130
        source_paths = [str(Path(value).expanduser().resolve()) for value in args.input if value]
        mode = args.action

        if mode == "generate":
            prompt = prompt_path.read_text(encoding="utf-8").strip()
            if not prompt:
                raise PipelineError("image generation prompt is empty")
            # Ideogram's local worker accepts its official structured caption
            # schema. The native chat/design model has already authored the
            # complete visual direction and selected `generate`; preserve that
            # text byte-for-byte instead of asking a second VLM to reinterpret
            # or route it.
            caption = {
                "aspect_ratio": args.aspect,
                "high_level_description": prompt,
                "compositional_deconstruction": {
                    "background": (
                        "Use the setting, background, lighting and palette "
                        "specified in the high-level description."
                    ),
                    "elements": [{"type": "obj", "desc": prompt}],
                },
            }
            caption_path = outdir / "ideogram-caption.json"
            caption_path.write_text(
                json.dumps(caption, ensure_ascii=False, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )
            if cancel_path is not None and cancel_path.is_file():
                status_write(status_path, "error", "cancelled",
                             "Image generation cancelled before model loading.", 100)
                return 130
            run([
                str(script_dir / "ideogram4-generate.sh"), str(caption_path),
                str(outdir), str(status_path), args.aspect, "0",
            ])
            provider = "ideogram4-fp8"
        else:
            if not source_paths:
                raise PipelineError("image editing requires a source image")
            editor_prompt = prompt_path
            if args.preserve == "face":
                original = prompt_path.read_text(encoding="utf-8").strip()
                editor_prompt = outdir / "hunyuan-edit-instruction.txt"
                editor_prompt.write_text(
                    original + "\n\nRequired identity constraint: preserve the source person's facial identity, "
                    "facial structure, expression, skin detail, and recognizable features exactly unless the user "
                    "explicitly requested a facial change.\n",
                    encoding="utf-8",
                )
            if cancel_path is not None and cancel_path.is_file():
                status_write(status_path, "error", "cancelled",
                             "Image editing cancelled before model loading.", 100)
                return 130
            run([
                str(script_dir / "hunyuan-image3-edit.sh"), str(editor_prompt),
                str(outdir), str(status_path), *source_paths,
            ])
            provider = "hunyuan-image3-instruct-nf4"

        provenance = {
            "routing": {
                "source": "native-model-directive",
                "decision": mode,
                "secondaryVisionRouter": None,
            },
            "provider": provider,
            "serialized": True,
            "preserveRequest": args.preserve,
            "elapsedSeconds": round(time.monotonic() - started, 3),
        }
        (outdir / "image-pipeline-provenance.json").write_text(
            json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return 0
    except KeyboardInterrupt:
        status_write(status_path, "error", "cancelled",
                     "Image generation cancelled.", 100)
        return 130
    except (OSError, PipelineError, ValueError) as exc:
        status_write(status_path, "error", "error", str(exc), 100)
        print(f"Image pipeline failed: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, handle_termination)
    signal.signal(signal.SIGINT, handle_termination)
    raise SystemExit(main())
