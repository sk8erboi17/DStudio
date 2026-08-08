#!/usr/bin/env python3
"""Run MiniMax H3 locally through stock ComfyUI on Apple Silicon.

This worker deliberately uses only open-weight checkpoints. It never calls a
MiniMax generation API. The one-time setup is large (about 54-73 GB depending
on the Mac's native quantized-kernel support), so every stage is written
atomically to a JSON status file consumed by DStudio's chat UI.
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
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


COMFY_REPOSITORY = "https://github.com/Comfy-Org/ComfyUI.git"
COMFY_COMMIT = "2f40b7131cb26c7255d48f6f6d821bd5fd56bedf"
COMFY_REQUIRED_FILES = (
    "requirements.txt",
    "main.py",
    "comfy_extras/nodes_minimax_h3.py",
)
MPS_ACCELERATOR_REPOSITORY = "https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8.git"
MPS_ACCELERATOR_COMMIT = "3cc65dd8d8b98f4ab69cf48b8912a831dc8ccff3"
MPS_ACCELERATOR_DIR = "ComfyUI-AppleSilicon-FP8"
MPS_ACCELERATOR_REQUIRED_FILES = (
    "__init__.py",
    "prestartup_script.py",
    "requirements.txt",
)
MODEL_REPOSITORY = "Comfy-Org/MiniMax-H3"
MODEL_REVISION = "eb8a16107c595128b3a578f82d2ce2f75920c355"
COMMUNITY_ENCODER_REPOSITORY = (
    "linjian257/qwen3vl_32b_minimax_h3_int8_convrot_uncensored-by-linjian257"
)
COMMUNITY_ENCODER_REVISION = "19a1c202af96b9c3d51dd346ecd0168c2720b0d3"
SERVER_RUNTIME_VERSION = 4
SERVER_STATE_NAME = "comfyui-server.json"
SERVER_PID_NAME = "comfyui-server.pid"
SERVER_LOG_NAME = "comfyui-server.log"

M1_M4_DISABLED_ACCELERATOR_ENV = (
    "ASFP8_INT8_EXT",
    "ASFP8_FP8_EXT",
    "ASFP8_FP8_NATIVE",
    "ASFP8_INT4_EXT",
    "ASFP8_CONV_IM2COL",
    "MTLFLASHATTN_SDPA",
    "MTLFLASHATTN_SHIM",
)

DIFFUSION_INT8_NAME = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
DIFFUSION_BF16_NAME = "minimax_h3_fl2va_pruned_bf16.safetensors"
VIDEO_VAE_NAME = "minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE_NAME = "minimax_h3_audio_vae_fp32.safetensors"
OFFICIAL_ENCODER_NAME = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"
COMMUNITY_ENCODER_NAME = (
    "qwen3vl_32b_minimax_h3_int8_convrot_uncensored-by-linjian257.safetensors"
)

MODEL_FILES = {
    "diffusion_int8": {
        "name": DIFFUSION_INT8_NAME,
        "subdir": "diffusion_models",
        "size": 20_970_379_616,
        "url": f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/diffusion_models/{DIFFUSION_INT8_NAME}",
    },
    "diffusion_bf16": {
        "name": DIFFUSION_BF16_NAME,
        "subdir": "diffusion_models",
        "size": 40_225_724_176,
        "url": f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/diffusion_models/{DIFFUSION_BF16_NAME}",
    },
    "video_vae": {
        "name": VIDEO_VAE_NAME,
        "subdir": "vae",
        "size": 5_207_808_496,
        "url": f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/vae/{VIDEO_VAE_NAME}",
    },
    "audio_vae": {
        "name": AUDIO_VAE_NAME,
        "subdir": "vae",
        "size": 605_254_808,
        "url": f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/vae/{AUDIO_VAE_NAME}",
    },
    "official_encoder": {
        "name": OFFICIAL_ENCODER_NAME,
        "subdir": "text_encoders",
        "size": 27_141_342_152,
        "url": f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/text_encoders/{OFFICIAL_ENCODER_NAME}",
    },
    "community_encoder": {
        "name": COMMUNITY_ENCODER_NAME,
        "subdir": "text_encoders",
        "size": 25_772_287_417,
        "url": (
            f"https://huggingface.co/{COMMUNITY_ENCODER_REPOSITORY}/resolve/"
            f"{COMMUNITY_ENCODER_REVISION}/{COMMUNITY_ENCODER_NAME}"
        ),
    },
}

BF16_DIFFUSION_MIN_MEMORY = 88 * 2**30
MIN_SAMPLER_STEPS = 20

RENDER_PROFILES = {
    # The smallest upstream-listed H3 canvas. Keep the full sampler schedule:
    # fewer than 20 steps leaves the AV flow latent visibly under-denoised.
    "preview": {
        "steps": MIN_SAMPLER_STEPS,
        "aspects": {
            "16:9": (608, 352),
            "9:16": (352, 608),
            "1:1": (448, 448),
            "4:3": (512, 384),
            "3:4": (384, 512),
        },
    },
    # Roughly 0.6 MP: the practical 5-second Apple-Silicon budget. This avoids
    # the superlinear 1.03 MP x 5 s cost of the upstream reference canvas.
    "balanced": {
        "steps": MIN_SAMPLER_STEPS,
        "aspects": {
            "16:9": (1024, 576),
            "9:16": (576, 1024),
            "1:1": (768, 768),
            "4:3": (896, 672),
            "3:4": (672, 896),
        },
    },
    # Upstream-size canvas retained as an explicit slow option.
    "quality": {
        "steps": MIN_SAMPLER_STEPS,
        "aspects": {
            "16:9": (1344, 768),
            "9:16": (768, 1344),
            "1:1": (1024, 1024),
            "4:3": (1152, 864),
            "3:4": (864, 1152),
        },
    },
}
ASPECTS = tuple(RENDER_PROFILES["balanced"]["aspects"])
SAMPLER_PROGRESS_RE = re.compile(r"(\d{1,3})%\|[^\r\n]*?\|\s*(\d+)\s*/\s*(\d+)")
SAMPLER_TIMING_RE = re.compile(
    r"(\d+)\s*/\s*(\d+)\s*\[(\d+:\d{2}(?::\d{2})?)<"
    r"(\d+:\d{2}(?::\d{2})?),\s*([0-9]+(?:\.[0-9]+)?)s/it\]"
)

# A tiny, valid fragmented H.264 MP4 for protocol/UI tests. Production never
# uses this path; it avoids downloading 54 GiB in the test suite.
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


def status_write(path: Path | None, state: str, stage: str, label: str, progress: int, **extra) -> None:
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
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def run(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    proc = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True)
    if proc.returncode:
        detail = (proc.stderr or proc.stdout or "command failed").strip()[-3000:]
        raise H3Error(f"{command[0]} failed: {detail}")


def require_command(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise H3Error(f"{name} is required. Install it and retry.")
    return found


def runtime_root() -> Path:
    configured = os.environ.get("DSTUDIO_H3_HOME", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".dstudio" / "minimax-h3").resolve()


def physical_memory_bytes() -> int:
    try:
        return int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
    except (OSError, ValueError):
        return 0


def apple_chip_generation(chip_name: str | None = None) -> int | None:
    name = chip_name if chip_name is not None else apple_chip_name()
    match = re.search(r"\bApple M(\d+)\b", name or "")
    return int(match.group(1)) if match else None


def selected_diffusion_spec(chip_name: str | None = None,
                            memory_bytes: int | None = None) -> dict:
    """Choose throughput, never lower quality, for the current Apple GPU.

    M5 has the pinned node's native W8A8 cooperative-matrix path. M1-M4 do not;
    on a high-memory Mac the official BF16 checkpoint is both the higher-fidelity
    representation and avoids re-dequantizing/un-rotating every INT8 Linear on
    every sampler step. Lower-memory machines retain the compact INT8 checkpoint.
    ``DSTUDIO_H3_DIFFUSION`` provides an explicit escape hatch.
    """
    requested = os.environ.get("DSTUDIO_H3_DIFFUSION", "").strip().lower()
    if requested in {"bf16", "bfloat16"}:
        return MODEL_FILES["diffusion_bf16"]
    if requested in {"int8", "quantized"}:
        return MODEL_FILES["diffusion_int8"]
    generation = apple_chip_generation(chip_name)
    memory = physical_memory_bytes() if memory_bytes is None else memory_bytes
    if generation is not None and generation < 5 and memory >= BF16_DIFFUSION_MIN_MEMORY:
        return MODEL_FILES["diffusion_bf16"]
    return MODEL_FILES["diffusion_int8"]


def selected_files(encoder: str, chip_name: str | None = None,
                   memory_bytes: int | None = None) -> list[dict]:
    encoder_key = "community_encoder" if encoder == "community" else "official_encoder"
    return [
        selected_diffusion_spec(chip_name, memory_bytes), MODEL_FILES[encoder_key],
        MODEL_FILES["video_vae"], MODEL_FILES["audio_vae"],
    ]


def model_path(comfy: Path, spec: dict) -> Path:
    return comfy / "models" / spec["subdir"] / spec["name"]


def ensure_pinned_checkout(checkout: Path, git: str, commit: str,
                           required_files: tuple[str, ...], label: str) -> None:
    """Materialize and verify a pinned managed Git worktree.

    A ``git clone --no-checkout`` can already report the pinned revision as
    HEAD while leaving every tracked file absent.  Checking only HEAD would
    therefore pass and make the later ``uv pip -r requirements.txt`` call
    fail.  Treat the checkout as ready only when both the revision and its
    runtime sentinel files are present.
    """
    head = ""
    with contextlib.suppress(Exception):
        head = subprocess.check_output(
            [git, "rev-parse", "HEAD"], cwd=checkout, text=True
        ).strip()

    commit_exists = subprocess.run(
        [git, "cat-file", "-e", f"{commit}^{{commit}}"],
        cwd=checkout,
        text=True,
        capture_output=True,
    ).returncode == 0
    if not commit_exists:
        run([git, "fetch", "--depth=1", "origin", commit], cwd=checkout)

    checkout_ready = all((checkout / relative).is_file() for relative in required_files)
    if head != commit or not checkout_ready:
        run([git, "checkout", "--force", "--detach", commit], cwd=checkout)

    missing = [relative for relative in required_files if not (checkout / relative).is_file()]
    if missing:
        raise H3Error(
            f"The managed {label} checkout is incomplete after repair: " + ", ".join(missing)
        )


def ensure_comfy_checkout(comfy: Path, git: str) -> None:
    ensure_pinned_checkout(comfy, git, COMFY_COMMIT, COMFY_REQUIRED_FILES, "ComfyUI")


def ensure_mps_accelerator_checkout(comfy: Path, git: str) -> Path:
    custom_nodes = comfy / "custom_nodes"
    custom_nodes.mkdir(parents=True, exist_ok=True)
    accelerator = custom_nodes / MPS_ACCELERATOR_DIR
    if accelerator.exists() and not (accelerator / ".git").is_dir():
        backup = accelerator.with_name(f"{accelerator.name}.previous-{int(time.time())}")
        accelerator.rename(backup)
    if not (accelerator / ".git").is_dir():
        run([
            git, "clone", "--filter=blob:none", "--no-checkout",
            MPS_ACCELERATOR_REPOSITORY, str(accelerator),
        ])
    ensure_pinned_checkout(
        accelerator, git, MPS_ACCELERATOR_COMMIT,
        MPS_ACCELERATOR_REQUIRED_FILES, "Apple-Silicon Metal accelerator",
    )
    return accelerator


def python_modules_available(python: Path, *modules: str) -> bool:
    code = (
        "import importlib.util,sys;"
        f"sys.exit(0 if all(importlib.util.find_spec(x) for x in {modules!r}) else 1)"
    )
    return subprocess.run(
        [str(python), "-c", code], text=True, capture_output=True,
    ).returncode == 0


def setup_comfy(root: Path, status: Path | None) -> tuple[Path, Path]:
    git = require_command("git")
    uv = require_command("uv")
    comfy = root / "ComfyUI"
    status_write(status, "running", "runtime", "Preparing the local ComfyUI/MPS runtime…", 3)
    if not (comfy / ".git").is_dir():
        root.mkdir(parents=True, exist_ok=True)
        run([git, "clone", "--filter=blob:none", "--no-checkout", COMFY_REPOSITORY, str(comfy)])
    ensure_comfy_checkout(comfy, git)
    accelerator = ensure_mps_accelerator_checkout(comfy, git)

    venv = root / ".venv"
    python = venv / "bin" / "python"
    python_missing = not python.is_file()
    comfy_marker = root / ".comfy-runtime-revision"
    comfy_marker_value = comfy_marker.read_text(encoding="utf-8").strip() if comfy_marker.is_file() else ""
    if python_missing:
        status_write(status, "running", "dependencies", "Installing the local H3 runtime dependencies…", 7)
        run([uv, "venv", str(venv), "--python", "3.12"])
    if python_missing or comfy_marker_value != COMFY_COMMIT:
        status_write(status, "running", "dependencies", "Installing the pinned ComfyUI runtime…", 7)
        run([uv, "pip", "install", "--python", str(python), "-r", str(comfy / "requirements.txt")])
        comfy_marker.write_text(COMFY_COMMIT + "\n", encoding="utf-8")

    accelerator_marker = root / ".apple-silicon-fp8-revision"
    accelerator_marker_value = (
        accelerator_marker.read_text(encoding="utf-8").strip()
        if accelerator_marker.is_file() else ""
    )
    accelerator_ready = not python_missing and python_modules_available(python, "mtlflashattn", "ninja")
    if accelerator_marker_value != MPS_ACCELERATOR_COMMIT or not accelerator_ready:
        status_write(
            status, "running", "dependencies",
            "Installing the pinned Apple Metal accelerator…", 8,
        )
        run([
            uv, "pip", "install", "--python", str(python),
            "-r", str(accelerator / "requirements.txt"),
        ])
        accelerator_marker.write_text(MPS_ACCELERATOR_COMMIT + "\n", encoding="utf-8")
    return comfy, python


def download_one(spec: dict, destination: Path, status: Path | None,
                 done_before: int, total: int) -> None:
    expected = int(spec["size"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    current = destination.stat().st_size if destination.is_file() else 0
    if current == expected:
        return
    if current > expected:
        raise H3Error(f"{destination.name} has an unexpected size; move it aside and retry.")
    curl = require_command("curl")
    command = [
        curl, "--fail", "--location", "--silent", "--show-error",
        "--retry", "4", "--retry-delay", "2", "--continue-at", "-",
        "--output", str(destination), spec["url"],
    ]
    proc = subprocess.Popen(command)
    try:
        while proc.poll() is None:
            current = destination.stat().st_size if destination.is_file() else 0
            aggregate = done_before + min(current, expected)
            pct = 10 + round(47 * aggregate / max(1, total))
            status_write(
                status, "running", "download",
                f"Downloading {destination.name} · {current / 2**30:.1f} / {expected / 2**30:.1f} GiB…",
                pct, downloadedBytes=aggregate, totalBytes=total,
            )
            time.sleep(1)
    except BaseException:
        proc.terminate()
        with contextlib.suppress(Exception):
            proc.wait(timeout=5)
        raise
    if proc.returncode:
        raise H3Error(f"Download failed for {destination.name} (curl exit {proc.returncode}).")
    current = destination.stat().st_size if destination.is_file() else 0
    if current != expected:
        raise H3Error(
            f"Download of {destination.name} is incomplete ({current} of {expected} bytes). Retry to resume it."
        )


def ensure_models(comfy: Path, encoder: str, status: Path | None) -> tuple[str, str]:
    files = selected_files(encoder)
    diffusion = files[0]
    total = sum(int(spec["size"]) for spec in files)
    present = sum(min(model_path(comfy, spec).stat().st_size, int(spec["size"]))
                  for spec in files if model_path(comfy, spec).is_file())
    missing = total - present
    free = shutil.disk_usage(comfy).free
    if missing > 0 and free < missing + 8 * 2**30:
        raise H3Error(
            f"Not enough free disk space: H3 needs {missing / 2**30:.1f} GiB more plus 8 GiB working space."
        )
    done = 0
    for spec in files:
        destination = model_path(comfy, spec)
        download_one(spec, destination, status, done, total)
        done += int(spec["size"])
    status_write(
        status, "running", "model-ready",
        "MiniMax H3 open weights are ready on this Mac.", 58,
        downloadedBytes=total, totalBytes=total,
        diffusion=diffusion["name"],
        diffusionPrecision="bf16" if diffusion["name"] == DIFFUSION_BF16_NAME else "int8",
    )
    encoder_name = COMMUNITY_ENCODER_NAME if encoder == "community" else OFFICIAL_ENCODER_NAME
    return encoder_name, str(diffusion["name"])


def setup_runtime(root: Path, encoder: str,
                  status: Path | None) -> tuple[Path, Path, str, str]:
    comfy, python = setup_comfy(root, status)
    encoder_name, diffusion_name = ensure_models(comfy, encoder, status)
    return comfy, python, encoder_name, diffusion_name


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def process_alive(pid: int) -> bool:
    if pid <= 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def server_state_read(root: Path, *, require_current: bool = True) -> dict | None:
    path = root / SERVER_STATE_NAME
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(state, dict):
        return None
    try:
        pid = int(state.get("pid", 0))
        port = int(state.get("port", 0))
        version = int(state.get("version", 0))
    except (TypeError, ValueError):
        return None
    if pid <= 1 or not (1 <= port <= 65535):
        return None
    if require_current and (
        version != SERVER_RUNTIME_VERSION
        or state.get("comfyCommit") != COMFY_COMMIT
        or state.get("acceleratorCommit") != MPS_ACCELERATOR_COMMIT
    ):
        return None
    return {**state, "pid": pid, "port": port, "version": version}


def server_state_write(root: Path, pid: int, port: int) -> None:
    state = {
        "version": SERVER_RUNTIME_VERSION,
        "pid": pid,
        "port": port,
        "comfyCommit": COMFY_COMMIT,
        "acceleratorCommit": MPS_ACCELERATOR_COMMIT,
        "startedAt": int(time.time() * 1000),
    }
    path = root / SERVER_STATE_NAME
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state), encoding="utf-8")
    os.replace(tmp, path)
    (root / SERVER_PID_NAME).write_text(f"{pid}\n", encoding="ascii")


def server_state_remove(root: Path) -> None:
    (root / SERVER_STATE_NAME).unlink(missing_ok=True)
    (root / SERVER_PID_NAME).unlink(missing_ok=True)


def http_json(url: str, payload: dict | None = None, timeout: float = 30) -> dict:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"} if body is not None else {},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
        return json.loads(raw.decode("utf-8")) if raw else {}


def verify_comfy_runtime(info: dict, log_path: Path) -> None:
    required = {"MiniMaxH3ImageToVideo", "SaveVideo", "CreateVideo", "VAEDecodeAudio"}
    missing = sorted(required.difference(info))
    if missing:
        raise H3Error(f"The pinned ComfyUI runtime is missing nodes: {', '.join(missing)}")
    log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.is_file() else ""
    accelerator_markers = (
        "[AppleSilicon-FP8/int_mm]",
        "[AppleSilicon-FP8/te_device]",
        "[AppleSilicon-FP8/flash]",
    )
    absent = [marker for marker in accelerator_markers if marker not in log]
    if absent:
        raise H3Error(
            "The Apple Metal H3 accelerator did not activate. Run Prepare local H3 "
            "again instead of falling back to CPU inference."
        )


def wait_for_comfy(base: str, pid: int, log_path: Path) -> dict:
    deadline = time.monotonic() + 420
    last_error = ""
    while time.monotonic() < deadline:
        if not process_alive(pid):
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-5000:] if log_path.is_file() else ""
            raise H3Error(f"ComfyUI stopped during startup. {tail.strip()}")
        try:
            info = http_json(base + "/object_info", timeout=5)
            verify_comfy_runtime(info, log_path)
            return info
        except H3Error:
            raise
        except Exception as exc:
            last_error = str(exc)
            time.sleep(1)
    raise H3Error(f"ComfyUI did not become ready in 7 minutes. {last_error}")


def stop_comfy_server(root: Path, state: dict | None = None) -> None:
    state = state or server_state_read(root, require_current=False)
    if not state:
        server_state_remove(root)
        return
    pid = int(state["pid"])
    base = f"http://127.0.0.1:{int(state['port'])}"
    with contextlib.suppress(Exception):
        http_json(base + "/interrupt", {}, timeout=3)
    if process_alive(pid):
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 20
        while process_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.2)
        if process_alive(pid):
            with contextlib.suppress(ProcessLookupError):
                os.kill(pid, signal.SIGKILL)
    server_state_remove(root)


def comfy_server_command(root: Path, comfy: Path, python: Path, port: int) -> list[str]:
    output_dir = root / "comfy-output"
    output_dir.mkdir(parents=True, exist_ok=True)
    total_gib = physical_memory_bytes() / 2**30
    reserve_gib = max(6, min(10, round(total_gib * 0.08)))
    return [
        str(python), str(comfy / "main.py"), "--listen", "127.0.0.1",
        "--port", str(port), "--disable-auto-launch",
        "--disable-all-custom-nodes", "--whitelist-custom-nodes", MPS_ACCELERATOR_DIR,
        "--disable-api-nodes", "--use-pytorch-cross-attention", "--mmap-torch-files",
        "--reserve-vram", str(reserve_gib),
        "--output-directory", str(output_dir),
    ]


def apple_chip_name() -> str | None:
    """Return Apple's public chip name without depending on System Profiler.

    ``machdep.cpu.brand_string`` is cheap, stable across app/terminal launches and
    reports values such as ``Apple M2 Max``. An unknown value deliberately falls
    back to the accelerator's runtime probes instead of guessing.
    """
    if sys.platform != "darwin":
        return None
    try:
        value = subprocess.check_output(
            ["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"],
            text=True, stderr=subprocess.DEVNULL, timeout=2,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return value or None


def configure_apple_accelerator_env(env: dict[str, str],
                                    chip_name: str | None = None) -> str:
    """Select only kernels that are native to the detected Apple GPU.

    The pinned accelerator's cooperative ``matmul2d`` probe is intentionally a
    coarse software-capability check. New SDKs can compile that Metal-4 surface
    on an M1-M4 even though the M5 tensor hardware is absent, making the emulated
    path dramatically slower. On M1-M4 we therefore disable only the documented
    M5-only extensions. The generic mtlflashattn fast tier is also disabled on
    M1-M4: an H3 A/B run on M2 measured 137 s/step through that reroute versus
    about 80 s/step through PyTorch SDPA at the same 608x352 BF16 workload.
    Fused norms, RoPE and the remaining correctness fixes stay active. This
    changes no H3 weights, frames, sampler schedule or codec.

    Explicit power-user environment values win through ``setdefault``.
    """
    generation = apple_chip_generation(chip_name)
    if generation is not None and generation < 5:
        for variable in M1_M4_DISABLED_ACCELERATOR_ENV:
            env.setdefault(variable, "off")
        return f"M{generation} H3 kernels (M5-only matmul and mtlflashattn disabled)"
    if generation is not None:
        return f"M{generation} runtime-probed native kernels"
    return "runtime-probed native kernels (chip generation unknown)"


def start_comfy_server(root: Path, comfy: Path, python: Path,
                       status: Path | None) -> tuple[str, int, Path]:
    previous_state = server_state_read(root, require_current=False)
    state = server_state_read(root)
    log_path = root / SERVER_LOG_NAME
    if state and process_alive(int(state["pid"])):
        base = f"http://127.0.0.1:{int(state['port'])}"
        try:
            info = http_json(base + "/object_info", timeout=5)
            verify_comfy_runtime(info, log_path)
            status_write(status, "running", "runtime-ready", "Reusing the accelerated H3 runtime…", 62)
            return base, int(state["pid"]), log_path
        except Exception:
            stop_comfy_server(root, state)
    elif previous_state and process_alive(int(previous_state["pid"])):
        # A pinned runtime/config upgrade must not orphan the previous detached
        # Comfy process merely because its state is no longer current.
        stop_comfy_server(root, previous_state)
    elif previous_state:
        server_state_remove(root)

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = os.environ.copy()
    env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    env.setdefault("PYTORCH_MPS_PREFER_METAL", "1")
    accelerator_profile = configure_apple_accelerator_env(env)
    command = comfy_server_command(root, comfy, python, port)
    status_write(status, "running", "runtime-start", "Starting accelerated MiniMax H3 on Apple Metal…", 61)
    with log_path.open("w", encoding="utf-8") as log:
        log.write(f"[DStudio] Apple accelerator profile: {accelerator_profile}\n")
        log.flush()
        process = subprocess.Popen(
            command, cwd=comfy, env=env, stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT, close_fds=True,
            start_new_session=True,
        )
    server_state_write(root, process.pid, port)
    try:
        wait_for_comfy(base, process.pid, log_path)
    except Exception:
        stop_comfy_server(root, server_state_read(root))
        raise
    return base, process.pid, log_path


def release_comfy_models(base: str) -> None:
    """Free H3 tensors while retaining the initialized Metal/Comfy process."""
    with contextlib.suppress(Exception):
        http_json(base + "/history", {"clear": True}, timeout=10)
    with contextlib.suppress(Exception):
        http_json(base + "/free", {"unload_models": True, "free_memory": True}, timeout=10)
    # The Comfy worker consumes /free asynchronously. Give it a brief turn so
    # DStudio can restore the chat model without racing H3's MPS allocations.
    time.sleep(1)


def encode_multipart_image(path: Path) -> tuple[bytes, str]:
    boundary = "----DStudioH3" + uuid.uuid4().hex
    filename = path.name.replace('"', "")
    mime = "image/png"
    if path.suffix.lower() in {".jpg", ".jpeg"}:
        mime = "image/jpeg"
    elif path.suffix.lower() == ".webp":
        mime = "image/webp"
    parts = [
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        path.read_bytes(),
        f"\r\n--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue',
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    return b"".join(parts), boundary


def upload_image(base: str, path: Path) -> str:
    body, boundary = encode_multipart_image(path)
    request = urllib.request.Request(
        base + "/upload/image", data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        data = json.loads(response.read().decode("utf-8"))
    name = str(data.get("name") or "")
    if not name:
        raise H3Error("ComfyUI did not accept the first-frame image.")
    return name


def aligned_frame_count(seconds: int) -> int:
    frames = max(5, round(seconds * 24))
    return frames + (5 - (frames % 17)) % 17


def build_prompt(prompt: str, width: int, height: int, seconds: int,
                 seed: int, encoder_name: str, diffusion_name: str,
                 first_frame_name: str = "",
                 steps: int = 20, output_prefix: str = "DStudio/MiniMax-H3") -> dict:
    steps = max(MIN_SAMPLER_STEPS, int(steps))
    graph: dict[str, dict] = {
        "1": {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE_NAME}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": AUDIO_VAE_NAME}},
        "3": {"class_type": "UNETLoader", "inputs": {"unet_name": diffusion_name, "weight_dtype": "default"}},
        "4": {"class_type": "CLIPLoader", "inputs": {"clip_name": encoder_name, "type": "minimax", "device": "default"}},
        "5": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["4", 0], "vae": ["1", 0], "prompt": prompt,
            "width": width, "height": height, "length": aligned_frame_count(seconds),
        }},
        "6": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "7": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "8": {"class_type": "BasicScheduler", "inputs": {"model": ["3", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0}},
        "9": {"class_type": "BasicGuider", "inputs": {"model": ["3", 0], "conditioning": ["5", 0]}},
        "10": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["6", 0], "guider": ["9", 0], "sampler": ["7", 0],
            "sigmas": ["8", 0], "latent_image": ["5", 1],
        }},
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["1", 0]}},
        "12": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["10", 0], "vae": ["2", 0]}},
        "13": {"class_type": "CreateVideo", "inputs": {"images": ["11", 0], "fps": 24.0, "audio": ["12", 0], "bit_depth": 8}},
        "14": {"class_type": "SaveVideo", "inputs": {
            "video": ["13", 0], "filename_prefix": output_prefix,
            # ComfyUI v3 dynamic-combo inputs use flattened API keys. The
            # runtime rebuilds these as {codec: "h264", encoding: {...}}.
            "format": "auto", "codec": "h264", "codec.encoding": "auto",
        }},
    }
    if first_frame_name:
        graph["0"] = {"class_type": "LoadImage", "inputs": {"image": first_frame_name}}
        graph["5"]["inputs"]["first_frame"] = ["0", 0]
    return graph


def find_video_metadata(value) -> dict | None:
    if isinstance(value, dict):
        filename = str(value.get("filename") or "")
        if filename.lower().endswith((".mp4", ".mov", ".webm", ".mkv")):
            return value
        for child in value.values():
            found = find_video_metadata(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_video_metadata(child)
            if found:
                return found
    return None


def inference_status(log_path: Path, sampling_started: float | None,
                     now: float | None = None, log_offset: int = 0) -> tuple[dict, float | None]:
    """Translate ComfyUI's real sampler output into stable UI progress.

    ComfyUI writes tqdm records with carriage returns (``3/20``, ``4/20``, …)
    to the managed log.  Using those records avoids the old elapsed-time bar
    that could claim 94% while the first diffusion step was still running.
    """
    now = time.monotonic() if now is None else now
    log = ""
    if log_path.is_file():
        with log_path.open("rb") as source:
            source.seek(max(0, log_offset))
            log = source.read().decode("utf-8", errors="replace")
    matches = list(SAMPLER_PROGRESS_RE.finditer(log))
    if matches:
        match = matches[-1]
        step = int(match.group(2))
        total = max(1, int(match.group(3)))
        if sampling_started is None:
            sampling_started = now
        if step >= total:
            return ({
                "stage": "decoding",
                "label": "Sampling complete · decoding video and stereo audio…",
                "progress": 96,
                "step": total,
                "totalSteps": total,
            }, sampling_started)

        progress = 70 + round(24 * step / total)
        status = {
            "stage": "sampling",
            "label": (
                f"Sampling H3 on Apple Metal · {step}/{total} steps complete…"
                if step else f"Sampling H3 on Apple Metal · starting step 1 of {total}…"
            ),
            "progress": min(94, progress),
            "step": step,
            "totalSteps": total,
        }
        if step > 0:
            timing_matches = list(SAMPLER_TIMING_RE.finditer(log))
            timing = timing_matches[-1] if timing_matches else None
            if timing and int(timing.group(1)) == step and int(timing.group(2)) == total:
                parts = [int(part) for part in timing.group(4).split(":")]
                eta_seconds = 0
                for part in parts:
                    eta_seconds = eta_seconds * 60 + part
                status["etaSeconds"] = eta_seconds
                status["secondsPerStep"] = max(1, round(float(timing.group(5))))
            else:
                # Older tqdm variants may omit the timing suffix. Retain a
                # conservative fallback, but prefer tqdm's completed-step
                # average so an in-flight step cannot inflate the ETA.
                elapsed = max(0.0, now - sampling_started)
                status["etaSeconds"] = max(0, round((elapsed / step) * (total - step)))
                status["secondsPerStep"] = max(1, round(elapsed / step))
        return status, sampling_started

    if "got prompt" in log:
        return ({
            "stage": "conditioning",
            "label": "Encoding the prompt and preparing H3 on Apple Metal…",
            "progress": 68,
        }, sampling_started)
    return ({
        "stage": "model-load",
        "label": "Loading the H3 open weights into unified memory…",
        "progress": 65,
    }, sampling_started)


def generate(args, root: Path, comfy: Path, python: Path,
             encoder_name: str, diffusion_name: str) -> Path:
    output_dir = Path(args.outdir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    base, server_pid, log_path = start_comfy_server(root, comfy, python, args.status_file)
    log_offset = log_path.stat().st_size if log_path.is_file() else 0
    prompt_id = ""
    completed = False
    try:
        status_write(args.status_file, "running", "model-load", "Loading the H3 open weights into unified memory…", 65)
        first_frame_name = ""
        if args.first_frame:
            first_frame_name = upload_image(base, Path(args.first_frame).resolve())
        profile = RENDER_PROFILES[args.profile]
        width, height = profile["aspects"][args.aspect]
        steps = int(profile["steps"])
        graph = build_prompt(
            Path(args.prompt_file).read_text(encoding="utf-8").strip(),
            width, height, args.duration, args.seed, encoder_name, diffusion_name,
            first_frame_name,
            steps, f"DStudio/{re.sub(r'[^A-Za-z0-9_-]+', '-', output_dir.name)}/MiniMax-H3",
        )
        response = http_json(base + "/prompt", {"prompt": graph, "client_id": uuid.uuid4().hex}, timeout=60)
        prompt_id = str(response.get("prompt_id") or "")
        if not prompt_id:
            raise H3Error(f"ComfyUI rejected the H3 workflow: {response.get('error') or response}")
        sampling_started = None
        while True:
            if not process_alive(server_pid):
                tail = log_path.read_text(encoding="utf-8", errors="replace")[-5000:] if log_path.is_file() else ""
                raise H3Error(f"H3 stopped before producing a video. {tail.strip()}")
            history = http_json(base + f"/history/{urllib.parse.quote(prompt_id)}", timeout=20)
            item = history.get(prompt_id)
            if item:
                status = item.get("status") or {}
                if status.get("status_str") == "error" or status.get("completed") is False:
                    messages = status.get("messages") or []
                    raise H3Error(f"H3 workflow failed: {json.dumps(messages, ensure_ascii=False)[-3500:]}")
                metadata = find_video_metadata(item.get("outputs") or {})
                if metadata:
                    subfolder = str(metadata.get("subfolder") or "")
                    filename = str(metadata["filename"])
                    source = root / "comfy-output" / subfolder / filename
                    if not source.is_file():
                        raise H3Error("ComfyUI reported a video file that is not present on disk.")
                    suffix = source.suffix.lower() if source.suffix else ".mp4"
                    destination = output_dir / f"minimax-h3-{int(time.time())}{suffix}"
                    shutil.copy2(source, destination)
                    completed = True
                    status_write(args.status_file, "complete", "complete", "Video H3 ready — generated locally with synchronized audio.", 100)
                    return destination
            actual, sampling_started = inference_status(
                log_path, sampling_started, log_offset=log_offset,
            )
            status_write(
                args.status_file, "running", actual.pop("stage"),
                actual.pop("label"), actual.pop("progress"),
                width=width, height=height, profile=args.profile, **actual,
            )
            time.sleep(3)
    finally:
        if not completed and prompt_id and process_alive(server_pid):
            with contextlib.suppress(Exception):
                http_json(base + "/interrupt", {"prompt_id": prompt_id}, timeout=5)
        if process_alive(server_pid):
            release_comfy_models(base)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file")
    parser.add_argument("--outdir")
    parser.add_argument("--status-file", type=Path)
    parser.add_argument("--duration", type=int, default=5, choices=range(5, 16))
    parser.add_argument("--aspect", default="16:9", choices=ASPECTS)
    parser.add_argument("--profile", default="balanced", choices=RENDER_PROFILES)
    parser.add_argument("--encoder", default="official", choices=("official", "community"))
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
        status_write(args.status_file, "running", "queued", "Waiting for the local H3 runtime…", 1)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if args.stop_runtime:
            stop_comfy_server(root)
            status_write(args.status_file, "complete", "complete", "MiniMax H3 runtime stopped.", 100)
            print(json.dumps({"ok": True, "running": False}))
            return 0
        if os.environ.get("DSTUDIO_VIDEO_TEST_MODE") == "1":
            if args.setup_only:
                status_write(args.status_file, "complete", "complete", "MiniMax H3 test runtime ready.", 100)
                print(json.dumps({"ok": True, "test": True}))
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
            raise H3Error("The managed MiniMax H3 runtime currently requires an Apple Silicon Mac.")
        comfy, python, encoder_name, diffusion_name = setup_runtime(
            root, args.encoder, args.status_file,
        )
        if args.setup_only:
            status_write(args.status_file, "complete", "complete", "MiniMax H3 open weights are ready.", 100)
            print(json.dumps({
                "ok": True, "encoder": args.encoder, "model": "MiniMaxAI/MiniMax-H3",
                "diffusion": diffusion_name,
            }))
            return 0
        if not args.prompt_file or not args.outdir:
            raise H3Error("prompt and output directory are required")
        output = generate(args, root, comfy, python, encoder_name, diffusion_name)
        print(output)
        return 0


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda _sig, _frame: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as exc:
        # Status writes are best-effort even if argument parsing/setup failed.
        status_path = None
        with contextlib.suppress(Exception):
            status_path = parse_args().status_file
        status_write(status_path, "error", "error", str(exc), 100)
        print(f"MiniMax H3: {exc}", file=sys.stderr)
        raise SystemExit(1)
