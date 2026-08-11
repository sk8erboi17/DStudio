#!/usr/bin/env python3
"""Manage DStudio's native MiniMax H3 backend on Apple Silicon.

The inference engine is the pinned antirez/h3.c executable, not ComfyUI or a
Python ML stack.  This small standard-library manager only checks out/builds
that executable, downloads the official FL2VA snapshot, translates DStudio's
stable worker arguments to the native CLI and mirrors real native progress to
the UI.  Setup compiles the executable but never loads model weights.
"""

from __future__ import annotations

import argparse
import atexit
import base64
import contextlib
import fcntl
import json
import os
from pathlib import Path
import random
import re
import selectors
import shutil
import signal
import subprocess
import sys
import time


H3_REPOSITORY = "https://github.com/antirez/h3.c.git"
H3_COMMIT = "03cb1339825feb19bcafcc60685680cb9ec6e2fe"
H3_REQUIRED_FILES = (
    "Makefile",
    "main.c",
    "h3.c",
    "h3.h",
    "h3_cli.c",
    "h3_gpu.m",
    "h3_metal.m",
    "h3_shaders.metal",
)
H3_BINARY = "h3"
H3_RUNTIME_MARKER = ".h3c-runtime-revision"

MODEL_REPOSITORY = "MiniMaxAI/MiniMax-H3"
MODEL_REVISION = "9ac0dd7aabc2c651fcf0ace4c00b2bffd9c8c8a6"
MODEL_RUNTIME_MARKER = ".model-revision"

TEXT_ENCODER_SHARD_SIZES = (
    4_932_328_944,
    4_875_990_528,
    4_875_990_552,
    4_875_990_584,
    4_875_990_584,
    4_875_990_584,
    4_875_990_584,
    4_875_990_584,
    4_875_990_584,
    4_875_990_584,
    4_875_990_584,
    4_875_990_584,
    4_875_990_584,
    3_270_697_008,
)
TRANSFORMER_SHARD_SIZES = (
    5_227_812_968,
    5_164_578_856,
    5_164_578_872,
    5_164_578_896,
    5_164_578_896,
    5_164_578_896,
    5_164_578_896,
    5_164_578_896,
    5_164_578_896,
    5_164_578_896,
    5_164_578_896,
    5_164_578_896,
    4_242_305_176,
)

MODEL_FILES = (
    {"path": "FL2VA/audio_vae/config.json", "size": 1_973},
    {"path": "FL2VA/audio_vae/model.safetensors", "size": 605_429_308},
    {"path": "FL2VA/text_encoder/config.json", "size": 1_474},
    *(
        {
            "path": f"FL2VA/text_encoder/model-{index:05d}-of-00014.safetensors",
            "size": size,
        }
        for index, size in enumerate(TEXT_ENCODER_SHARD_SIZES, 1)
    ),
    {"path": "FL2VA/text_encoder/model.safetensors.index.json", "size": 97_831},
    {"path": "FL2VA/tokenizer/tokenizer.json", "size": 7_032_403},
    {"path": "FL2VA/transformer/config.json", "size": 604},
    *(
        {
            "path": f"FL2VA/transformer/model-{index:05d}-of-00013.safetensors",
            "size": size,
        }
        for index, size in enumerate(TRANSFORMER_SHARD_SIZES, 1)
    ),
    {"path": "FL2VA/transformer/model.safetensors.index.json", "size": 38_323},
    {"path": "FL2VA/video_vae/config.json", "size": 1_807},
    {"path": "FL2VA/video_vae/source/model.safetensors", "size": 10_415_548_320},
)
MODEL_TOTAL_BYTES = 144_023_550_851
if sum(int(spec["size"]) for spec in MODEL_FILES) != MODEL_TOTAL_BYTES:
    raise RuntimeError("MiniMax H3 pinned model manifest total is inconsistent")
DOWNLOAD_HEADROOM_BYTES = 8 * 2**30

MIN_SAMPLER_STEPS = 20
RENDER_PROFILES = {
    # The output stays useful while the expensive native canvas is reduced.
    # This is h3.c's documented aggressive combination: no token reduction is
    # added because upstream validation found that combination unstable.
    "preview": {
        "steps": MIN_SAMPLER_STEPS,
        "layers": 40,
        "reuse": 3,
        "aspects": {
            "16:9": (672, 384),
            "9:16": (384, 672),
            "1:1": (512, 512),
            "4:3": (640, 480),
            "3:4": (480, 640),
        },
        "render_aspects": {
            "16:9": (448, 256),
            "9:16": (256, 448),
            "1:1": (320, 320),
            "4:3": (384, 288),
            "3:4": (288, 384),
        },
    },
    # Native upstream's validated balanced controls at roughly 512-class area.
    "balanced": {
        "steps": MIN_SAMPLER_STEPS,
        "layers": 45,
        "reuse": 2,
        "aspects": {
            "16:9": (672, 384),
            "9:16": (384, 672),
            "1:1": (512, 512),
            "4:3": (640, 480),
            "3:4": (480, 640),
        },
    },
    # Full native model path at documented 768p-class dimensions.
    "quality": {
        "steps": MIN_SAMPLER_STEPS,
        "layers": 50,
        "reuse": 1,
        "aspects": {
            "16:9": (1344, 768),
            "9:16": (768, 1344),
            "1:1": (768, 768),
            "4:3": (1024, 768),
            "3:4": (768, 1024),
        },
    },
}
ASPECTS = tuple(RENDER_PROFILES["balanced"]["aspects"])
H3_PROGRESS_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9 ]*?)\s+(\d+)\s*/\s*(\d+)\s*$")

# A tiny, valid fragmented H.264 MP4 for protocol/UI tests. Production never
# uses this path; it lets contract tests exercise the local protocol without
# checking out h3.c or loading MiniMax weights.
TEST_MP4_B64 = (
    "AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC7W1vb3YAAABsbXZo"
    "ZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAA"
    "AQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAHvdHJh"
    "awAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAA"
    "AAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAABi21kaWEAAAAgbWRo"
    "ZAAAAAAAAAAAAAAAAAAAKAAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAA"
    "AAAAVmlkZW9IYW5kbGVyAAAAATZtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAA"
    "ABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAD2c3RibAAAAKpzdHNkAAAAAAAAAAEAAACa"
    "YXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAARVMYXZjNjIu"
    "MjguMTAyIGxpYngyNjQAAAAAAAAAAAAAABj//wAAADRhdmNDAWQACv/hABdnZAAKrNlewEQA"
    "AAMABAAAAwAoPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAEHN0dHMAAAAA"
    "AAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAA"
    "AAAAAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYnVkdGEAAABa"
    "bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWp"
    "dG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDIAAABwbW9vZgAAABBtZmhkAAAAAAAA"
    "AAEAAABYdHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAADEQAACAAAAALJAQEAAAAAABR0ZmR0"
    "AQAAAAAAAAAAAAAAAAAAGHRydW4AAAAFAAAAAQAAAHgCAAAAAAAC0W1kYXQAAAKtBgX//6nc"
    "Rem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9N"
    "UEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRl"
    "b2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6"
    "MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAw"
    "OjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4"
    "OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zm"
    "c2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAg"
    "bnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWlu"
    "ZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRp"
    "cmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWlu"
    "dF9taW49NSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJj"
    "PWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBz"
    "dGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAABRliIQAP//+5nX4FMvGOkpuhg3S"
    "vwAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAAAAAAAAAAAADEQEBAQAA"
    "ABBtZnJvAAAAAAAAAEM="
)


class H3Error(RuntimeError):
    pass


ACTIVE_PROCESS: subprocess.Popen[bytes] | None = None


def status_write(path: Path | None, state: str, stage: str, label: str,
                 progress: int, **extra: object) -> None:
    if path is None:
        return
    payload = {
        "ok": state != "error",
        "state": state,
        "stage": stage,
        "label": label,
        "progress": max(0, min(100, int(progress))),
        "updatedAt": int(time.time() * 1000),
        **extra,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def run(command: list[str], *, cwd: Path | None = None,
        env: dict[str, str] | None = None) -> None:
    process = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True)
    if process.returncode:
        detail = (process.stderr or process.stdout or "command failed").strip()[-4000:]
        raise H3Error(f"{command[0]} failed: {detail}")


def find_command(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for directory in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"):
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def require_command(name: str, hint: str = "") -> str:
    found = find_command(name)
    if found:
        return found
    suffix = f" {hint}" if hint else " Install it and retry."
    raise H3Error(f"{name} is required.{suffix}")


def runtime_root() -> Path:
    configured = os.environ.get("DSTUDIO_H3_HOME", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".dstudio" / "minimax-h3").resolve()


def marker_matches(path: Path, expected: str) -> bool:
    try:
        return path.read_text(encoding="utf-8").strip() == expected
    except OSError:
        return False


def ensure_pinned_checkout(checkout: Path, git: str, commit: str,
                           required_files: tuple[str, ...], label: str) -> None:
    """Repair an empty/partial --no-checkout tree and select one immutable commit."""
    head = ""
    with contextlib.suppress(Exception):
        head = subprocess.check_output(
            [git, "rev-parse", "HEAD"], cwd=checkout, text=True,
        ).strip()
    commit_exists = subprocess.run(
        [git, "cat-file", "-e", f"{commit}^{{commit}}"], cwd=checkout,
        text=True, capture_output=True,
    ).returncode == 0
    if not commit_exists:
        run([git, "fetch", "--depth=1", "origin", commit], cwd=checkout)
    ready = all((checkout / relative).is_file() for relative in required_files)
    if head != commit or not ready:
        run([git, "checkout", "--force", "--detach", commit], cwd=checkout)
    missing = [relative for relative in required_files if not (checkout / relative).is_file()]
    if missing:
        raise H3Error(f"The managed {label} checkout is incomplete: {', '.join(missing)}")


def ensure_h3_checkout(checkout: Path, git: str) -> None:
    if checkout.exists() and not (checkout / ".git").is_dir():
        raise H3Error(f"{checkout} exists but is not the managed h3.c Git checkout")
    if not (checkout / ".git").is_dir():
        checkout.parent.mkdir(parents=True, exist_ok=True)
        run([
            git, "clone", "--filter=blob:none", "--no-checkout",
            H3_REPOSITORY, str(checkout),
        ])
    ensure_pinned_checkout(checkout, git, H3_COMMIT, H3_REQUIRED_FILES, "h3.c")


def ensure_native_runtime(root: Path, status: Path | None) -> tuple[Path, Path]:
    git = require_command("git")
    make = require_command("make", "Install Xcode Command Line Tools and retry.")
    require_command("clang", "Install Xcode Command Line Tools and retry.")
    checkout = root / "h3.c"
    status_write(status, "running", "runtime", "Preparing pinned native h3.c/Metal sources…", 3)
    ensure_h3_checkout(checkout, git)
    binary = checkout / H3_BINARY
    marker = root / H3_RUNTIME_MARKER
    if not binary.is_file() or not os.access(binary, os.X_OK) or not marker_matches(marker, H3_COMMIT):
        status_write(status, "running", "build", "Compiling the native h3.c/Metal engine…", 6)
        jobs = max(1, min(8, os.cpu_count() or 1))
        run([make, f"-j{jobs}", H3_BINARY], cwd=checkout)
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise H3Error("h3.c finished building but did not produce an executable")
        marker.write_text(H3_COMMIT + "\n", encoding="ascii")
    return checkout, binary


def model_destination(model_dir: Path, spec: dict[str, object]) -> Path:
    return model_dir / str(spec["path"])


def file_bytes(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def downloaded_bytes(model_dir: Path) -> int:
    total = 0
    for spec in MODEL_FILES:
        expected = int(spec["size"])
        destination = model_destination(model_dir, spec)
        if file_bytes(destination) == expected:
            total += expected
        else:
            total += min(file_bytes(destination.with_name(destination.name + ".part")), expected)
    return total


def model_ready(model_dir: Path, marker: Path | None = None) -> bool:
    if marker is not None and not marker_matches(marker, MODEL_REVISION):
        return False
    return all(file_bytes(model_destination(model_dir, spec)) == int(spec["size"])
               for spec in MODEL_FILES)


def download_url(relative: str) -> str:
    quoted = "/".join(part.replace(" ", "%20") for part in relative.split("/"))
    return f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/{quoted}"


def download_one(curl: str, model_dir: Path, spec: dict[str, object],
                 status: Path | None) -> None:
    destination = model_destination(model_dir, spec)
    expected = int(spec["size"])
    if file_bytes(destination) == expected:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    if file_bytes(partial) > expected:
        partial.unlink()
    command = [
        curl, "--fail", "--location", "--silent", "--show-error",
        "--retry", "5", "--retry-all-errors", "--continue-at", "-",
        "--output", str(partial), download_url(str(spec["path"])),
    ]
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    while process.poll() is None:
        have = downloaded_bytes(model_dir)
        progress = 10 + int(84 * have / max(1, MODEL_TOTAL_BYTES))
        status_write(
            status, "running", "download",
            f"Downloading official FL2VA weights · {destination.name}", progress,
            downloadedBytes=have, totalBytes=MODEL_TOTAL_BYTES,
        )
        time.sleep(1)
    _, stderr = process.communicate()
    if process.returncode:
        detail = stderr.decode("utf-8", "replace").strip()[-3000:]
        raise H3Error(f"Download failed for {spec['path']}: {detail}")
    actual = file_bytes(partial)
    if actual != expected:
        raise H3Error(f"Downloaded {spec['path']} has {actual} bytes; expected {expected}")
    os.replace(partial, destination)


def ensure_models(root: Path, status: Path | None) -> Path:
    model_dir = root / "MiniMax-H3"
    marker = root / MODEL_RUNTIME_MARKER
    if model_ready(model_dir, marker):
        return model_dir
    curl = require_command("curl")
    model_dir.mkdir(parents=True, exist_ok=True)
    have = downloaded_bytes(model_dir)
    missing = MODEL_TOTAL_BYTES - have
    free = shutil.disk_usage(root).free
    if free < missing + DOWNLOAD_HEADROOM_BYTES:
        need_gib = (missing + DOWNLOAD_HEADROOM_BYTES - free) / 2**30
        raise H3Error(
            f"The official native FL2VA snapshot needs about {need_gib:.1f} GiB more free disk space"
        )
    for spec in MODEL_FILES:
        download_one(curl, model_dir, spec, status)
    if not model_ready(model_dir):
        raise H3Error("The pinned MiniMax H3 FL2VA snapshot is incomplete after download")
    marker.write_text(MODEL_REVISION + "\n", encoding="ascii")
    return model_dir


def setup_runtime(root: Path, status: Path | None) -> tuple[Path, Path, Path, Path]:
    checkout, binary = ensure_native_runtime(root, status)
    require_command("ffmpeg", "Install FFmpeg (for example: brew install ffmpeg) and retry.")
    require_command("ffprobe", "Install FFmpeg (for example: brew install ffmpeg) and retry.")
    model_dir = ensure_models(root, status)
    return checkout, binary, model_dir, root / MODEL_RUNTIME_MARKER


def native_command(binary: Path, model_dir: Path, prompt: str, output: Path,
                   duration: int, aspect: str, profile_name: str, seed: int,
                   first_frame: str = "") -> list[str]:
    profile = RENDER_PROFILES[profile_name]
    width, height = profile["aspects"][aspect]
    command = [
        str(binary), "-d", str(model_dir), "-p", prompt, "-o", str(output),
        "--width", str(width), "--height", str(height),
        "--seconds", str(duration), "--steps", str(profile["steps"]),
        "--layers", str(profile["layers"]), "--reuse", str(profile["reuse"]),
        "--seed", str(seed),
    ]
    render_aspects = profile.get("render_aspects")
    if isinstance(render_aspects, dict):
        render_width, render_height = render_aspects[aspect]
        command.extend(["--render-width", str(render_width), "--render-height", str(render_height)])
    if first_frame:
        command.extend(["--first-frame", first_frame])
    return command


def progress_payload(phase: str, completed: int, total: int,
                     started: float | None = None) -> dict[str, object]:
    total = max(1, total)
    ratio = max(0.0, min(1.0, completed / total))
    normalized = phase.strip().lower()
    extra: dict[str, object] = {"nativePhase": phase, "step": completed, "totalSteps": total}
    if "denoise" in normalized:
        progress = 50 + int(32 * ratio)
        label = f"Native h3.c denoise · {completed}/{total} steps complete…"
        if started is not None and completed > 0 and completed < total:
            seconds_per_step = max(0.0, (time.monotonic() - started) / completed)
            extra["secondsPerStep"] = round(seconds_per_step)
            extra["etaSeconds"] = round(seconds_per_step * (total - completed))
        return {"stage": "sampling", "label": label, "progress": progress, **extra}
    if normalized in {"tokenizer", "text encoder", "qwen vision", "refine text"}:
        return {
            "stage": "conditioning", "label": f"Native h3.c · {phase}…",
            "progress": 8 + int(20 * ratio), **extra,
        }
    if normalized in {"load transformer core", "precompute adaln"}:
        return {
            "stage": "model-load", "label": f"Native h3.c · {phase}…",
            "progress": 28 + int(22 * ratio), **extra,
        }
    if "vae" in normalized or normalized == "ffmpeg":
        base = 82 if "audio" in normalized else 88
        if normalized == "ffmpeg":
            base = 96
        return {
            "stage": "decoding", "label": f"Native h3.c · {phase}…",
            "progress": min(99, base + int((100 - base) * ratio)), **extra,
        }
    return {
        "stage": "inference", "label": f"Native h3.c · {phase}…",
        "progress": 45, **extra,
    }


def parse_progress_fragment(fragment: str) -> tuple[str, int, int] | None:
    match = H3_PROGRESS_RE.match(fragment)
    if not match:
        return None
    return match.group(1).strip(), int(match.group(2)), int(match.group(3))


def terminate_active_process() -> None:
    global ACTIVE_PROCESS
    process = ACTIVE_PROCESS
    if process is None or process.poll() is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)


def generate(args: argparse.Namespace, checkout: Path, binary: Path,
             model_dir: Path) -> Path:
    global ACTIVE_PROCESS
    output_dir = Path(args.outdir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    prompt = Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if not prompt:
        raise H3Error("The H3 prompt is empty")
    output = output_dir / f"minimax-h3-{int(time.time())}.mp4"
    command = native_command(
        binary, model_dir, prompt, output, args.duration, args.aspect,
        args.profile, args.seed,
        str(Path(args.first_frame).resolve()) if args.first_frame else "",
    )
    env = os.environ.copy()
    env["H3_FFMPEG"] = require_command("ffmpeg")
    env["H3_FFPROBE"] = require_command("ffprobe")
    profile = RENDER_PROFILES[args.profile]
    width, height = profile["aspects"][args.aspect]
    status_write(
        args.status_file, "running", "model-load",
        "Loading official H3 weights with the native Metal engine…", 25,
        width=width, height=height, profile=args.profile,
    )
    ACTIVE_PROCESS = subprocess.Popen(
        command, cwd=checkout, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    assert ACTIVE_PROCESS.stdout is not None
    selector = selectors.DefaultSelector()
    selector.register(ACTIVE_PROCESS.stdout, selectors.EVENT_READ)
    fragment = ""
    log_tail = ""
    denoise_started: float | None = None
    while True:
        events = selector.select(timeout=1)
        for key, _ in events:
            chunk = os.read(key.fileobj.fileno(), 8192)
            if not chunk:
                with contextlib.suppress(Exception):
                    selector.unregister(key.fileobj)
                continue
            text = chunk.decode("utf-8", "replace")
            log_tail = (log_tail + text)[-65536:]
            fragments = re.split(r"[\r\n]", fragment + text)
            fragment = fragments.pop()
            for item in fragments:
                parsed = parse_progress_fragment(item)
                if not parsed:
                    continue
                phase, completed, total = parsed
                if "denoise" in phase.lower() and denoise_started is None:
                    denoise_started = time.monotonic()
                payload = progress_payload(phase, completed, total, denoise_started)
                status_write(
                    args.status_file, "running", str(payload.pop("stage")),
                    str(payload.pop("label")), int(payload.pop("progress")),
                    width=width, height=height, profile=args.profile, **payload,
                )
        if ACTIVE_PROCESS.poll() is not None and not selector.get_map():
            break
    returncode = ACTIVE_PROCESS.wait()
    ACTIVE_PROCESS = None
    selector.close()
    if returncode:
        detail = re.sub(r"[\r\n]+", " ", log_tail).strip()[-5000:]
        raise H3Error(f"native h3.c exited with status {returncode}: {detail}")
    if not output.is_file() or output.stat().st_size <= 0:
        raise H3Error("native h3.c completed without producing an MP4")
    status_write(
        args.status_file, "complete", "complete",
        "Video H3 ready — generated locally by native h3.c/Metal.", 100,
        width=width, height=height, profile=args.profile,
    )
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file")
    parser.add_argument("--outdir")
    parser.add_argument("--status-file", type=Path)
    parser.add_argument("--duration", type=int, default=5, choices=range(5, 16))
    parser.add_argument("--aspect", default="16:9", choices=ASPECTS)
    parser.add_argument("--profile", default="balanced", choices=RENDER_PROFILES)
    parser.add_argument("--encoder", default="official", choices=("official",))
    parser.add_argument("--first-frame", default="")
    parser.add_argument("--seed", type=int, default=-1)
    parser.add_argument("--setup-only", action="store_true")
    parser.add_argument("--stop-runtime", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.seed < 0:
        args.seed = random.SystemRandom().randrange(0, 2**53)
    root = runtime_root()
    root.mkdir(parents=True, exist_ok=True)
    worker_pid = Path(args.outdir).resolve() / "worker.pid" if args.outdir else None
    if worker_pid is not None:
        worker_pid.parent.mkdir(parents=True, exist_ok=True)
        worker_pid.write_text(f"{os.getpid()}\n", encoding="ascii")
        atexit.register(lambda: worker_pid.unlink(missing_ok=True))
    lock_path = root / "worker.lock"
    with lock_path.open("a+") as lock:
        status_write(args.status_file, "running", "queued", "Waiting for native h3.c/Metal…", 1)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if args.stop_runtime:
            # h3.c is one-shot: there is no detached server or resident model.
            status_write(args.status_file, "complete", "complete", "No persistent H3 runtime is active.", 100)
            print(json.dumps({"ok": True, "running": False, "runtime": "h3.c/Metal"}))
            return 0
        if os.environ.get("DSTUDIO_VIDEO_TEST_MODE") == "1":
            if args.setup_only:
                status_write(args.status_file, "complete", "complete", "Native H3 test runtime ready.", 100)
                print(json.dumps({"ok": True, "test": True, "runtime": "h3.c/Metal"}))
                return 0
            if not args.prompt_file or not args.outdir:
                raise H3Error("prompt and output directory are required")
            destination = Path(args.outdir) / "minimax-h3-test.mp4"
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(base64.b64decode(TEST_MP4_B64))
            status_write(args.status_file, "complete", "complete", "Video H3 ready (test mode).", 100)
            print(destination.resolve())
            return 0
        if sys.platform != "darwin" or os.uname().machine != "arm64":
            raise H3Error("The managed native MiniMax H3 runtime requires an Apple Silicon Mac.")
        checkout, binary, model_dir, _ = setup_runtime(root, args.status_file)
        if args.setup_only:
            status_write(
                args.status_file, "complete", "complete",
                "Official MiniMax H3 weights and native h3.c are ready.", 100,
                downloadedBytes=MODEL_TOTAL_BYTES, totalBytes=MODEL_TOTAL_BYTES,
            )
            print(json.dumps({
                "ok": True, "encoder": "official", "model": MODEL_REPOSITORY,
                "modelRevision": MODEL_REVISION, "engineCommit": H3_COMMIT,
                "runtime": "h3.c/Metal",
            }))
            return 0
        if not args.prompt_file or not args.outdir:
            raise H3Error("prompt and output directory are required")
        output = generate(args, checkout, binary, model_dir)
        print(output)
        return 0


def handle_termination(_signum: int, _frame: object) -> None:
    terminate_active_process()
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, handle_termination)
    signal.signal(signal.SIGINT, handle_termination)
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as exc:
        terminate_active_process()
        status_path = None
        with contextlib.suppress(Exception):
            status_path = parse_args().status_file
        status_write(status_path, "error", "error", str(exc), 100)
        print(f"MiniMax H3: {exc}", file=sys.stderr)
        raise SystemExit(1)
