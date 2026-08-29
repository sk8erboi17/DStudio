#!/usr/bin/env python3
"""Manage DStudio's native MiniMax H3 backend on Apple Silicon.

The inference engine is the pinned antirez/h3.c executable, not ComfyUI or a
Python ML stack.  This small standard-library manager only checks out/builds
that executable, downloads the official FL2VA snapshot and optional Ref2VA
reference transformer, translates DStudio's stable worker arguments to the
native CLI and mirrors real native progress to the UI.  Setup compiles the
executable but never loads model weights.
"""

from __future__ import annotations

import argparse
import atexit
import base64
import contextlib
import fcntl
import hashlib
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
H3_COMMIT = "8974cc055ea9c02fcd14cc27dfda3e1027c05153"
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
DSTUDIO_ROOT = Path(__file__).resolve().parents[1]
H3_PATCH_SCRIPT = DSTUDIO_ROOT / "scripts" / "apply-h3-metal-watchdog.sh"
H3_PATCH_FILE = (
    DSTUDIO_ROOT / "patch" / "h3-metal-watchdog" /
    "stage-command-submits.patch"
)

MODEL_REPOSITORY = "MiniMaxAI/MiniMax-H3"
MODEL_REVISION = "9ac0dd7aabc2c651fcf0ace4c00b2bffd9c8c8a6"
MODEL_RUNTIME_MARKER = ".model-revision"
REFERENCE_MODEL_RUNTIME_MARKER = ".ref2va-model-revision"

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

# Ref2VA uses the same Qwen encoder, tokenizer and VAEs as FL2VA.  Only its
# transformer is a distinct checkpoint (about 61.7 GiB); the shared files are
# exposed under Ref2VA with local symlinks so setup never duplicates another
# ~72 GiB of identical weights.
REFERENCE_TRANSFORMER_FILES = (
    {"path": "Ref2VA/transformer/config.json", "size": 604},
    *(
        {
            "path": f"Ref2VA/transformer/model-{index:05d}-of-00013.safetensors",
            "size": size,
        }
        for index, size in enumerate(TRANSFORMER_SHARD_SIZES, 1)
    ),
    {"path": "Ref2VA/transformer/model.safetensors.index.json", "size": 38_323},
)
REFERENCE_MODEL_TOTAL_BYTES = 66_280_524_863
if sum(int(spec["size"]) for spec in REFERENCE_TRANSFORMER_FILES) != REFERENCE_MODEL_TOTAL_BYTES:
    raise RuntimeError("MiniMax H3 pinned Ref2VA manifest total is inconsistent")
REFERENCE_SHARED_FILES = tuple(
    (
        str(spec["path"]),
        str(spec["path"]).replace("FL2VA/", "Ref2VA/", 1),
        int(spec["size"]),
    )
    for spec in MODEL_FILES
    if not str(spec["path"]).startswith("FL2VA/transformer/")
)
DOWNLOAD_HEADROOM_BYTES = 8 * 2**30
# h3.c releases the Qwen encoder before loading the DiT, so residency is sized
# against the largest transformer phase rather than the complete 144 GB model
# snapshot. Keep enough unified memory for Metal activations, macOS and the
# encoder/decoder handoff. Machines below this bound retain the byte-identical
# file-backed path; machines at or above it use h3.c's native device policy.
TRANSFORMER_COPY_HEADROOM_BYTES = 24 * 2**30
TRANSFORMER_COPY_MINIMUM_MEMORY_BYTES = (
    REFERENCE_MODEL_TOTAL_BYTES + TRANSFORMER_COPY_HEADROOM_BYTES
)
NATIVE_STATUS_HEARTBEAT_SECONDS = 30.0
# h3.c renders CLI progress with a leading carriage return and no trailing
# delimiter. Wait for a short quiet period before accepting the current tail so
# a pipe read split in the middle of a number cannot publish a partial value.
NATIVE_PROGRESS_QUIET_SECONDS = 0.1
POWER_ASSERTION_MODE = "caffeinate-idle-system-sleep"
BOUNDED_DIT_COMMAND_BLOCKS = "1"
QUALITY_DIT_STAGE_SUBMITS = "1"
# Eight query rows keeps the complete K/V sequence and selects the bounded
# MPSGraph path that completed a full 50-layer 1344x768 DiT step on M2 Max.
QUALITY_SDPA_QUERY_CHUNK = "8"
METAL_FAILURE_SIGNATURES = (
    "kIOGPUCommandBufferCallbackError",
    "GPUCommandBufferCallbackError",
    "Command Buffer execution failed",
)

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
ACTIVE_METAL_MONITOR: subprocess.Popen[bytes] | None = None
ACTIVE_POWER_ASSERTION: subprocess.Popen[bytes] | None = None


def status_write(path: Path | None, state: str, stage: str, label: str,
                 progress: int, **extra: object) -> None:
    if path is None:
        return
    payload = {
        "ok": state not in {"error", "cancelled"},
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


def h3_patch_sha256() -> str:
    try:
        return hashlib.sha256(H3_PATCH_FILE.read_bytes()).hexdigest()
    except OSError as exc:
        raise H3Error(f"The managed H3 patch is unavailable: {H3_PATCH_FILE}") from exc


def h3_runtime_revision() -> str:
    return f"{H3_COMMIT}+{h3_patch_sha256()}"


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


def apply_h3_runtime_patch(checkout: Path) -> None:
    require_command("git")
    if not H3_PATCH_SCRIPT.is_file() or not os.access(H3_PATCH_SCRIPT, os.X_OK):
        raise H3Error(f"The managed H3 patch launcher is unavailable: {H3_PATCH_SCRIPT}")
    env = os.environ.copy()
    env["H3_DIR"] = str(checkout)
    run([str(H3_PATCH_SCRIPT), "apply"], env=env)


def restore_h3_runtime_patch(checkout: Path) -> None:
    require_command("git")
    if not H3_PATCH_SCRIPT.is_file() or not os.access(H3_PATCH_SCRIPT, os.X_OK):
        raise H3Error(f"The managed H3 patch launcher is unavailable: {H3_PATCH_SCRIPT}")
    env = os.environ.copy()
    env["H3_DIR"] = str(checkout)
    run([str(H3_PATCH_SCRIPT), "restore"], env=env)


def ensure_native_runtime(root: Path, status: Path | None) -> tuple[Path, Path]:
    git = require_command("git")
    make = require_command("make", "Install Xcode Command Line Tools and retry.")
    require_command("clang", "Install Xcode Command Line Tools and retry.")
    checkout = root / "h3.c"
    status_write(status, "running", "runtime", "Preparing pinned native h3.c/Metal sources…", 3)
    ensure_h3_checkout(checkout, git)
    # Normalize an exactly applied managed patch after an interrupted build,
    # while refusing any unknown upstream-source delta. The installed checkout
    # remains byte-for-byte pinned; the versioned patch is transient build input.
    restore_h3_runtime_patch(checkout)
    binary = checkout / H3_BINARY
    marker = root / H3_RUNTIME_MARKER
    runtime_revision = h3_runtime_revision()
    if (not binary.is_file() or not os.access(binary, os.X_OK) or
            not marker_matches(marker, runtime_revision)):
        status_write(status, "running", "build", "Compiling the native h3.c/Metal engine…", 6)
        jobs = max(1, min(8, os.cpu_count() or 1))
        apply_h3_runtime_patch(checkout)
        try:
            run([make, f"-j{jobs}", H3_BINARY], cwd=checkout)
        finally:
            restore_h3_runtime_patch(checkout)
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise H3Error("h3.c finished building but did not produce an executable")
        marker.write_text(runtime_revision + "\n", encoding="ascii")
    return checkout, binary


def model_destination(model_dir: Path, spec: dict[str, object]) -> Path:
    return model_dir / str(spec["path"])


def file_bytes(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def downloaded_bytes_for(model_dir: Path, files: tuple[dict[str, object], ...]) -> int:
    total = 0
    for spec in files:
        expected = int(spec["size"])
        destination = model_destination(model_dir, spec)
        if file_bytes(destination) == expected:
            total += expected
        else:
            total += min(file_bytes(destination.with_name(destination.name + ".part")), expected)
    return total


def downloaded_bytes(model_dir: Path) -> int:
    return downloaded_bytes_for(model_dir, MODEL_FILES)


def reference_downloaded_bytes(model_dir: Path) -> int:
    return downloaded_bytes_for(model_dir, REFERENCE_TRANSFORMER_FILES)


def model_ready(model_dir: Path, marker: Path | None = None) -> bool:
    if marker is not None and not marker_matches(marker, MODEL_REVISION):
        return False
    return all(file_bytes(model_destination(model_dir, spec)) == int(spec["size"])
               for spec in MODEL_FILES)


def ensure_reference_links(model_dir: Path) -> None:
    for source_relative, destination_relative, expected in REFERENCE_SHARED_FILES:
        source = model_dir / source_relative
        destination = model_dir / destination_relative
        if file_bytes(source) != expected:
            raise H3Error(f"Shared FL2VA file is missing or incomplete: {source_relative}")
        if file_bytes(destination) == expected:
            continue
        if destination.is_symlink():
            destination.unlink()
        elif destination.exists():
            raise H3Error(
                f"Ref2VA shared path exists but is incomplete: {destination_relative}"
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.symlink_to(os.path.relpath(source, destination.parent))


def reference_model_ready(model_dir: Path, marker: Path | None = None) -> bool:
    if marker is not None and not marker_matches(marker, MODEL_REVISION):
        return False
    transformer_ready = all(
        file_bytes(model_destination(model_dir, spec)) == int(spec["size"])
        for spec in REFERENCE_TRANSFORMER_FILES
    )
    shared_ready = all(
        file_bytes(model_dir / destination) == expected
        for _, destination, expected in REFERENCE_SHARED_FILES
    )
    return transformer_ready and shared_ready


def download_url(relative: str) -> str:
    quoted = "/".join(part.replace(" ", "%20") for part in relative.split("/"))
    return f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/{quoted}"


def download_one(curl: str, model_dir: Path, spec: dict[str, object],
                 status: Path | None, *, files: tuple[dict[str, object], ...] = MODEL_FILES,
                 total_bytes: int = MODEL_TOTAL_BYTES,
                 label: str = "official FL2VA weights") -> None:
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
        have = downloaded_bytes_for(model_dir, files)
        progress = 10 + int(84 * have / max(1, total_bytes))
        status_write(
            status, "running", "download",
            f"Downloading {label} · {destination.name}", progress,
            downloadedBytes=have, totalBytes=total_bytes,
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


def ensure_reference_models(root: Path, status: Path | None, model_dir: Path) -> None:
    marker = root / REFERENCE_MODEL_RUNTIME_MARKER
    ensure_reference_links(model_dir)
    if reference_model_ready(model_dir, marker):
        return
    curl = require_command("curl")
    have = reference_downloaded_bytes(model_dir)
    missing = REFERENCE_MODEL_TOTAL_BYTES - have
    free = shutil.disk_usage(root).free
    if free < missing + DOWNLOAD_HEADROOM_BYTES:
        need_gib = (missing + DOWNLOAD_HEADROOM_BYTES - free) / 2**30
        raise H3Error(
            f"The official Ref2VA reference checkpoint needs about {need_gib:.1f} GiB more free disk space"
        )
    for spec in REFERENCE_TRANSFORMER_FILES:
        download_one(
            curl, model_dir, spec, status,
            files=REFERENCE_TRANSFORMER_FILES,
            total_bytes=REFERENCE_MODEL_TOTAL_BYTES,
            label="official Ref2VA reference weights",
        )
    ensure_reference_links(model_dir)
    if not reference_model_ready(model_dir):
        raise H3Error("The pinned MiniMax H3 Ref2VA snapshot is incomplete after download")
    marker.write_text(MODEL_REVISION + "\n", encoding="ascii")


def setup_runtime(root: Path, status: Path | None,
                  include_references: bool = False) -> tuple[Path, Path, Path, Path]:
    checkout, binary = ensure_native_runtime(root, status)
    require_command("ffmpeg", "Install FFmpeg (for example: brew install ffmpeg) and retry.")
    require_command("ffprobe", "Install FFmpeg (for example: brew install ffmpeg) and retry.")
    model_dir = ensure_models(root, status)
    if include_references:
        ensure_reference_models(root, status, model_dir)
    return checkout, binary, model_dir, root / MODEL_RUNTIME_MARKER


def native_command(binary: Path, model_dir: Path, prompt: str, output: Path,
                   duration: int, aspect: str, profile_name: str, seed: int,
                   first_frame: str = "",
                   reference_images: tuple[str, ...] | list[str] = ()) -> list[str]:
    if first_frame and reference_images:
        raise H3Error("Frame anchors cannot be combined with ordered Ref2VA references")
    if len(reference_images) > 2:
        raise H3Error("DStudio accepts at most two H3 image references")
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
    for reference_image in reference_images:
        command.extend(["--ref-image", reference_image])
    return command


def inspect_video_output(output: Path, width: int, height: int,
                         duration: int) -> dict[str, object]:
    ffprobe = require_command("ffprobe")
    result = subprocess.run([
        ffprobe, "-v", "error", "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height,pix_fmt",
        "-of", "json", str(output),
    ], text=True, capture_output=True)
    if result.returncode:
        raise H3Error(f"ffprobe rejected the H3 output: {result.stderr.strip()[-1000:]}")
    try:
        payload = json.loads(result.stdout)
        streams = payload.get("streams", [])
        video = next(item for item in streams if item.get("codec_type") == "video")
        measured_duration = float(payload.get("format", {}).get("duration", 0))
    except (json.JSONDecodeError, StopIteration, TypeError, ValueError) as exc:
        raise H3Error("ffprobe returned incomplete H3 output metadata") from exc
    if video.get("codec_name") != "h264":
        raise H3Error(f"H3 output codec is {video.get('codec_name')!r}, expected H.264")
    if int(video.get("width", 0)) != width or int(video.get("height", 0)) != height:
        raise H3Error(
            f"H3 output is {video.get('width')}x{video.get('height')}, expected {width}x{height}"
        )
    if video.get("pix_fmt") != "yuv420p":
        raise H3Error(f"H3 output pixel format is {video.get('pix_fmt')!r}, expected yuv420p")
    if not max(0.0, duration - 0.75) <= measured_duration <= duration + 0.75:
        raise H3Error(
            f"H3 output duration is {measured_duration:.3f}s, expected about {duration}s"
        )
    ffmpeg = require_command("ffmpeg")
    decoded = subprocess.run([
        ffmpeg, "-v", "error", "-xerror", "-i", str(output),
        "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if decoded.returncode:
        raise H3Error(
            "ffmpeg could not decode the complete H3 output: "
            f"{decoded.stderr.strip()[-1000:]}"
        )
    return {
        "codec": "h264",
        "pixelFormat": "yuv420p",
        "width": width,
        "height": height,
        "durationSeconds": round(measured_duration, 3),
        "hasAudio": any(item.get("codec_type") == "audio" for item in streams),
        "fullyDecoded": True,
    }


def progress_payload(phase: str, completed: int, total: int,
                     started: float | None = None,
                     cycle: int = 0) -> dict[str, object]:
    total = max(1, total)
    ratio = max(0.0, min(1.0, completed / total))
    normalized = phase.strip().lower()
    extra: dict[str, object] = {
        "nativePhase": phase, "nativeCycle": max(0, cycle),
        "step": completed, "totalSteps": total,
    }
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
    if normalized in {"audio vae encoder", "video vae encoder"}:
        return {
            "stage": "conditioning", "label": f"Native h3.c · {phase}…",
            "progress": 10 + int(14 * ratio), **extra,
        }
    if normalized == "preview vae load":
        return {
            "stage": "model-load", "label": f"Native h3.c · {phase}…",
            "progress": 42 + int(6 * ratio), **extra,
        }
    if normalized == "audio vae":
        return {
            "stage": "decoding", "label": f"Native h3.c · {phase}…",
            "progress": 82 + int(4 * ratio), **extra,
        }
    if normalized == "video vae load":
        if cycle <= 0:
            return {
                "stage": "decoder-load", "label": "Native h3.c · loading video decoder…",
                "progress": 86 + int(3 * ratio), **extra,
            }
        return {
            "stage": "decoding", "label": "Native h3.c · decoding video frames…",
            "progress": 89 + int(7 * ratio), **extra,
        }
    if normalized == "ffmpeg":
        return {
            "stage": "decoding", "label": f"Native h3.c · {phase}…",
            "progress": min(99, 96 + int(3 * ratio)), **extra,
        }
    if "vae" in normalized:
        return {
            "stage": "decoding", "label": f"Native h3.c · {phase}…",
            "progress": 82 + int(7 * ratio), **extra,
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


class H3ProgressStreamParser:
    """Frame h3.c progress records written with leading carriage returns.

    The native CLI does not terminate its current status with a newline. A
    short quiet interval commits that tail, while a forced poll preserves the
    final record at EOF. Already committed records are not emitted again when
    the next leading carriage return later turns them into delimited records.
    """

    def __init__(self, quiet_seconds: float = NATIVE_PROGRESS_QUIET_SECONDS):
        self.quiet_seconds = max(0.0, quiet_seconds)
        self.fragment = ""
        self.last_data_at = 0.0
        self.last_emitted: tuple[str, int, int] | None = None

    def _emit(
        self, parsed: tuple[str, int, int] | None,
    ) -> tuple[tuple[str, int, int], ...]:
        if parsed is None or parsed == self.last_emitted:
            return ()
        self.last_emitted = parsed
        return (parsed,)

    def feed(
        self, text: str, now: float,
    ) -> tuple[tuple[str, int, int], ...]:
        fragments = re.split(r"[\r\n]", self.fragment + text)
        self.fragment = fragments.pop()
        self.last_data_at = now
        emitted: list[tuple[str, int, int]] = []
        for item in fragments:
            emitted.extend(self._emit(parse_progress_fragment(item)))
        return tuple(emitted)

    def poll(
        self, now: float, *, force: bool = False,
    ) -> tuple[tuple[str, int, int], ...]:
        if not force and now - self.last_data_at < self.quiet_seconds:
            return ()
        return self._emit(parse_progress_fragment(self.fragment))


def physical_memory_bytes() -> int | None:
    """Return installed physical memory without invoking another process."""
    try:
        pages = int(os.sysconf("SC_PHYS_PAGES"))
        page_size = int(os.sysconf("SC_PAGE_SIZE"))
    except (AttributeError, OSError, TypeError, ValueError):
        return None
    total = pages * page_size
    return total if total > 0 else None


def configure_weight_residency(
    env: dict[str, str], total_memory_bytes: int | None = None,
) -> str:
    """Select full-quality transformer residency from the largest live phase.

    h3.c's file-backed Metal buffers preserve the exact checkpoint bytes and
    arithmetic, but page faults inside a long MPSGraph segment can trip the
    macOS GPU interactivity watchdog on pre-M5 hardware. h3.c deliberately
    uses copied buffers on those Macs. Preserve that native policy whenever
    the transformer plus a conservative unified-memory headroom fits; use the
    reclaimable mapping only on smaller machines. An explicit operator
    override always wins.
    """
    configured = env.get("H3_ZERO_COPY_WEIGHTS")
    if configured is not None:
        return configured or "native-default"
    installed = physical_memory_bytes() if total_memory_bytes is None else total_memory_bytes
    if (installed is not None and
            installed < TRANSFORMER_COPY_MINIMUM_MEMORY_BYTES):
        env["H3_ZERO_COPY_WEIGHTS"] = "transformer"
        return "transformer"
    return "native-default"


def metal_failure_from_log(text: str) -> str | None:
    """Return the first GPU failure from complete Unified Log NDJSON records."""
    for line in text.splitlines():
        try:
            record = json.loads(line)
        except (TypeError, ValueError):
            # `log stream` writes a human-readable filter banner before its
            # NDJSON records. The banner contains every searched signature and
            # must never be mistaken for a Metal event.
            continue
        if not isinstance(record, dict):
            continue
        message = str(record.get("eventMessage") or
                      record.get("composedMessage") or "")
        if any(signature.lower() in message.lower()
               for signature in METAL_FAILURE_SIGNATURES):
            return re.sub(r"\s+", " ", message).strip()[-2000:]
    return None


def start_metal_log_monitor(process_id: int) -> subprocess.Popen[bytes] | None:
    """Stream fatal Metal diagnostics for one native H3 process on macOS."""
    if sys.platform != "darwin" or process_id <= 0:
        return None
    log_binary = find_command("log")
    if not log_binary:
        return None
    signatures = " OR ".join(
        f'composedMessage CONTAINS[c] "{signature}"'
        for signature in METAL_FAILURE_SIGNATURES
    )
    predicate = f"processIdentifier == {process_id} AND ({signatures})"
    return subprocess.Popen(
        [
            log_binary, "stream", "--style", "ndjson", "--level", "debug",
            "--predicate", predicate,
        ],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, start_new_session=True,
    )


def start_power_assertion(process_id: int) -> subprocess.Popen[bytes] | None:
    """Prevent idle system sleep for exactly the lifetime of native H3."""
    if sys.platform != "darwin" or process_id <= 0:
        return None
    caffeinate = find_command("caffeinate")
    if not caffeinate:
        return None
    return subprocess.Popen(
        [caffeinate, "-i", "-w", str(process_id)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True,
    )


def configure_dit_scheduling(env: dict[str, str], profile: str,
                             weight_residency: str) -> str:
    """Bound Metal command buffers for quality or file-backed inference.

    h3.c documents command-buffer splitting as byte-identical: it changes only
    submission boundaries, not operation order or arithmetic. A single
    30-block command buffer can exceed the macOS interactivity watchdog at the
    full quality canvas even with resident weights; file-backed weights make
    each submission slower still. One DiT block per buffer keeps both paths
    bounded while retaining the complete sampler, layer count and resolution.
    Explicit operator overrides always win.
    """
    configured = env.get("H3_DIT_COMMAND_BLOCKS")
    if configured is not None:
        return configured or "native-default"
    if profile == "quality" or weight_residency in {"1", "transformer"}:
        env["H3_DIT_COMMAND_BLOCKS"] = BOUNDED_DIT_COMMAND_BLOCKS
        return BOUNDED_DIT_COMMAND_BLOCKS
    return "native-default"


def configure_quality_metal_scheduling(
    env: dict[str, str], profile: str,
) -> tuple[str, str]:
    """Keep full-quality pre-M5 MPSGraph work below the macOS watchdog.

    Query rows in non-causal self-attention are mathematically independent:
    each query still attends to the complete, unchanged key/value sequence.
    The managed h3.c patch also submits between the unchanged DiT stages.
    Neither control changes weights, sampler steps, blocks or output canvas.
    Explicit operator overrides always win.
    """
    stage_submits = env.get("H3_DIT_STAGE_SUBMITS")
    query_chunk = env.get("H3_SDPA_QUERY_CHUNK")
    if profile == "quality":
        if stage_submits is None:
            stage_submits = QUALITY_DIT_STAGE_SUBMITS
            env["H3_DIT_STAGE_SUBMITS"] = stage_submits
        if query_chunk is None:
            query_chunk = QUALITY_SDPA_QUERY_CHUNK
            env["H3_SDPA_QUERY_CHUNK"] = query_chunk
    return stage_submits or "disabled", query_chunk or "disabled"


def publish_native_status(
    path: Path | None, payload: dict[str, object], *, width: int, height: int,
    profile: str, weight_residency: str, command_blocks: str,
    stage_submits: str, sdpa_query_chunk: str,
    started: float, progress_floor: int = 0, heartbeat: bool = False,
) -> int:
    """Publish one truthful, monotonic native progress snapshot."""
    fields = dict(payload)
    stage = str(fields.pop("stage"))
    label = str(fields.pop("label"))
    progress = max(progress_floor, int(fields.pop("progress")))
    status_write(
        path, "running", stage, label, progress,
        width=width, height=height, profile=profile,
        weightResidency=weight_residency, commandBlocks=command_blocks,
        stageSubmits=stage_submits, sdpaQueryChunk=sdpa_query_chunk,
        powerAssertion=POWER_ASSERTION_MODE,
        elapsedSeconds=round(max(0.0, time.monotonic() - started), 1),
        heartbeat=heartbeat, **fields,
    )
    return progress


def terminate_active_process() -> None:
    global ACTIVE_PROCESS, ACTIVE_METAL_MONITOR, ACTIVE_POWER_ASSERTION
    for process in (ACTIVE_PROCESS, ACTIVE_METAL_MONITOR, ACTIVE_POWER_ASSERTION):
        if process is None or process.poll() is not None:
            continue
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)


def generate(args: argparse.Namespace, checkout: Path, binary: Path,
             model_dir: Path) -> Path:
    global ACTIVE_PROCESS, ACTIVE_METAL_MONITOR, ACTIVE_POWER_ASSERTION
    started = time.monotonic()
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
        tuple(str(Path(item).resolve()) for item in args.reference_image),
    )
    env = os.environ.copy()
    env["H3_FFMPEG"] = require_command("ffmpeg")
    env["H3_FFPROBE"] = require_command("ffprobe")
    weight_residency = configure_weight_residency(env)
    command_blocks = configure_dit_scheduling(
        env, args.profile, weight_residency,
    )
    stage_submits, sdpa_query_chunk = configure_quality_metal_scheduling(
        env, args.profile,
    )
    profile = RENDER_PROFILES[args.profile]
    width, height = profile["aspects"][args.aspect]
    status_write(
        args.status_file, "running", "model-load",
        "Loading official H3 weights with the native Metal engine…", 25,
        width=width, height=height, profile=args.profile,
        weightResidency=weight_residency, commandBlocks=command_blocks,
        stageSubmits=stage_submits, sdpaQueryChunk=sdpa_query_chunk,
        powerAssertion="pending", elapsedSeconds=0.0, heartbeat=False,
    )
    ACTIVE_PROCESS = subprocess.Popen(
        command, cwd=checkout, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    assert ACTIVE_PROCESS.stdout is not None
    ACTIVE_METAL_MONITOR = start_metal_log_monitor(ACTIVE_PROCESS.pid)
    if ACTIVE_METAL_MONITOR is None or ACTIVE_METAL_MONITOR.stdout is None:
        terminate_active_process()
        ACTIVE_PROCESS = None
        ACTIVE_METAL_MONITOR = None
        raise H3Error(
            "cannot start the required macOS Metal error monitor; "
            "H3 inference was not accepted"
        )
    ACTIVE_POWER_ASSERTION = start_power_assertion(ACTIVE_PROCESS.pid)
    if ACTIVE_POWER_ASSERTION is None:
        terminate_active_process()
        ACTIVE_PROCESS = None
        ACTIVE_METAL_MONITOR = None
        ACTIVE_POWER_ASSERTION = None
        raise H3Error(
            "cannot acquire the required macOS idle-sleep assertion; "
            "H3 inference was not accepted"
        )
    selector = selectors.DefaultSelector()
    selector.register(ACTIVE_PROCESS.stdout, selectors.EVENT_READ, "native")
    selector.register(ACTIVE_METAL_MONITOR.stdout, selectors.EVENT_READ, "metal")
    native_log_path = output_dir / "h3-native.log"
    native_log_handle = native_log_path.open("wb")
    progress_parser = H3ProgressStreamParser()
    log_tail = ""
    metal_log_tail = ""
    metal_failure = ""
    power_failure = ""
    denoise_started: float | None = None
    progress_floor = 25
    current_payload: dict[str, object] = {
        "stage": "model-load",
        "label": "Loading official H3 weights with the native Metal engine…",
        "progress": 25,
        "nativePhase": "startup",
        "nativeCycle": 0,
        "step": 0,
        "totalSteps": 0,
    }
    phase_completed: dict[str, int] = {}
    phase_cycles: dict[str, int] = {}
    last_status_at = time.monotonic()

    def accept_progress(parsed: tuple[str, int, int] | None) -> None:
        nonlocal denoise_started, current_payload, progress_floor
        nonlocal last_status_at
        if parsed is None:
            return
        phase, completed, total = parsed
        if "denoise" in phase.lower() and denoise_started is None:
            denoise_started = time.monotonic()
        phase_key = phase.strip().lower()
        previous_completed = phase_completed.get(phase_key)
        if previous_completed is not None and completed < previous_completed:
            phase_cycles[phase_key] = phase_cycles.get(phase_key, 0) + 1
        phase_completed[phase_key] = completed
        current_payload = progress_payload(
            phase, completed, total, denoise_started,
            phase_cycles.get(phase_key, 0),
        )
        progress_floor = publish_native_status(
            args.status_file, current_payload,
            width=width, height=height, profile=args.profile,
            weight_residency=weight_residency,
            command_blocks=command_blocks,
            stage_submits=stage_submits,
            sdpa_query_chunk=sdpa_query_chunk, started=started,
            progress_floor=progress_floor,
        )
        last_status_at = time.monotonic()

    while True:
        events = selector.select(timeout=1)
        for key, _ in events:
            chunk = os.read(key.fileobj.fileno(), 8192)
            if not chunk:
                with contextlib.suppress(Exception):
                    selector.unregister(key.fileobj)
                continue
            text = chunk.decode("utf-8", "replace")
            if key.data == "metal":
                metal_log_tail = (metal_log_tail + text)[-65536:]
                detected = metal_failure_from_log(metal_log_tail)
                if detected and not metal_failure:
                    metal_failure = detected
                    if ACTIVE_PROCESS.poll() is None:
                        with contextlib.suppress(ProcessLookupError):
                            os.killpg(ACTIVE_PROCESS.pid, signal.SIGTERM)
                continue
            native_log_handle.write(chunk)
            native_log_handle.flush()
            log_tail = (log_tail + text)[-65536:]
            for parsed in progress_parser.feed(text, time.monotonic()):
                accept_progress(parsed)
        now = time.monotonic()
        for parsed in progress_parser.poll(now):
            accept_progress(parsed)
        if now - last_status_at >= NATIVE_STATUS_HEARTBEAT_SECONDS:
            progress_floor = publish_native_status(
                args.status_file, current_payload,
                width=width, height=height, profile=args.profile,
                weight_residency=weight_residency,
                command_blocks=command_blocks,
                stage_submits=stage_submits,
                sdpa_query_chunk=sdpa_query_chunk, started=started,
                progress_floor=progress_floor, heartbeat=True,
            )
            last_status_at = now
        if (ACTIVE_METAL_MONITOR.poll() is not None and
                ACTIVE_PROCESS.poll() is None and not metal_failure):
            metal_failure = (
                "the macOS Metal error monitor exited before native H3; "
                "inference correctness could not be verified"
            )
            with contextlib.suppress(ProcessLookupError):
                os.killpg(ACTIVE_PROCESS.pid, signal.SIGTERM)
        if (ACTIVE_POWER_ASSERTION.poll() is not None and
                ACTIVE_PROCESS.poll() is None and not power_failure):
            power_failure = (
                "the macOS idle-sleep assertion exited before native H3; "
                "uninterrupted inference could not be guaranteed"
            )
            with contextlib.suppress(ProcessLookupError):
                os.killpg(ACTIVE_PROCESS.pid, signal.SIGTERM)
        if ACTIVE_PROCESS.poll() is not None and not selector.get_map():
            break
        if ACTIVE_PROCESS.poll() is not None:
            native_registered = any(
                registered.data == "native"
                for registered in selector.get_map().values()
            )
            if not native_registered:
                if ACTIVE_METAL_MONITOR.poll() is None:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(ACTIVE_METAL_MONITOR.pid, signal.SIGTERM)
                with contextlib.suppress(Exception):
                    ACTIVE_METAL_MONITOR.wait(timeout=2)
                with contextlib.suppress(Exception):
                    selector.unregister(ACTIVE_METAL_MONITOR.stdout)
    # Preserve the final progress update even when h3.c exits immediately after
    # writing its last carriage-return status.
    for parsed in progress_parser.poll(time.monotonic(), force=True):
        accept_progress(parsed)
    returncode = ACTIVE_PROCESS.wait()
    ACTIVE_PROCESS = None
    if ACTIVE_METAL_MONITOR.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(ACTIVE_METAL_MONITOR.pid, signal.SIGTERM)
    with contextlib.suppress(Exception):
        ACTIVE_METAL_MONITOR.wait(timeout=2)
    ACTIVE_METAL_MONITOR = None
    if ACTIVE_POWER_ASSERTION.poll() is None:
        try:
            ACTIVE_POWER_ASSERTION.wait(timeout=2)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(ACTIVE_POWER_ASSERTION.pid, signal.SIGTERM)
            with contextlib.suppress(Exception):
                ACTIVE_POWER_ASSERTION.wait(timeout=2)
    ACTIVE_POWER_ASSERTION = None
    selector.close()
    native_log_handle.close()
    if metal_failure:
        detail = re.sub(r"[\r\n]+", " ", metal_log_tail).strip()[-5000:]
        native_detail = re.sub(r"[\r\n]+", " ", log_tail).strip()[-5000:]
        failure = {
            "schema": "dstudio.h3.failure.v1",
            "kind": "metal-command-buffer",
            "profile": args.profile,
            "width": width,
            "height": height,
            "weightResidency": weight_residency,
            "commandBlocks": command_blocks,
            "stageSubmits": stage_submits,
            "sdpaQueryChunk": sdpa_query_chunk,
            "elapsedSeconds": round(time.monotonic() - started, 3),
            "lastProgress": current_payload,
            "metalFailure": metal_failure,
            "nativeLog": native_log_path.name,
            "nativeTail": native_detail,
        }
        (output_dir / "h3-failure.json").write_text(
            json.dumps(failure, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        raise H3Error(
            "macOS reported a Metal command-buffer failure during native H3: "
            f"{metal_failure}; native phase: {native_detail}; log: {detail}"
        )
    if power_failure:
        native_detail = re.sub(r"[\r\n]+", " ", log_tail).strip()[-5000:]
        failure = {
            "schema": "dstudio.h3.failure.v1",
            "kind": "power-assertion",
            "profile": args.profile,
            "width": width,
            "height": height,
            "powerAssertion": POWER_ASSERTION_MODE,
            "elapsedSeconds": round(time.monotonic() - started, 3),
            "lastProgress": current_payload,
            "powerFailure": power_failure,
            "nativeLog": native_log_path.name,
            "nativeTail": native_detail,
        }
        (output_dir / "h3-failure.json").write_text(
            json.dumps(failure, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        raise H3Error(
            f"macOS idle-sleep protection failed during native H3: "
            f"{power_failure}; native phase: {native_detail}"
        )
    if returncode:
        detail = re.sub(r"[\r\n]+", " ", log_tail).strip()[-5000:]
        raise H3Error(f"native h3.c exited with status {returncode}: {detail}")
    if not output.is_file() or output.stat().st_size <= 0:
        raise H3Error("native h3.c completed without producing an MP4")
    status_write(
        args.status_file, "running", "validation",
        "Validating every decoded H3 video frame and audio sample…", 99,
        width=width, height=height, profile=args.profile,
        weightResidency=weight_residency, commandBlocks=command_blocks,
        stageSubmits=stage_submits, sdpaQueryChunk=sdpa_query_chunk,
        powerAssertion=POWER_ASSERTION_MODE,
        elapsedSeconds=round(time.monotonic() - started, 1), heartbeat=False,
    )
    media = inspect_video_output(output, width, height, args.duration)
    provenance = {
        "provider": "minimax-h3-native",
        "model": MODEL_REPOSITORY,
        "revision": MODEL_REVISION,
        "engine": {
            "repository": H3_REPOSITORY,
            "revision": H3_COMMIT,
            "patchSha256": h3_patch_sha256(),
        },
        "quality": {
            "profile": args.profile,
            "steps": profile["steps"],
            "transformerBlocks": profile["layers"],
            "denoiserReuse": profile["reuse"],
        },
        "weightResidency": weight_residency,
        "commandBlocks": command_blocks,
        "stageSubmits": stage_submits,
        "sdpaQueryChunk": sdpa_query_chunk,
        "metalErrorMonitor": "macOS-unified-log",
        "metalCommandBufferErrors": 0,
        "powerAssertion": POWER_ASSERTION_MODE,
        "nativeLog": native_log_path.name,
        "media": media,
        "durationRequestedSeconds": args.duration,
        "aspect": args.aspect,
        "seed": args.seed,
        "firstFrame": Path(args.first_frame).name if args.first_frame else None,
        "referenceImages": [Path(item).name for item in args.reference_image],
        "elapsedSeconds": round(time.monotonic() - started, 3),
    }
    (output_dir / "h3-provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    status_write(
        args.status_file, "complete", "complete",
        "Video H3 ready — generated locally by native h3.c/Metal.", 100,
        width=width, height=height, profile=args.profile,
        weightResidency=weight_residency,
        commandBlocks=command_blocks, stageSubmits=stage_submits,
        sdpaQueryChunk=sdpa_query_chunk,
        powerAssertion=POWER_ASSERTION_MODE, media=media,
        elapsedSeconds=round(time.monotonic() - started, 1), heartbeat=False,
    )
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file")
    parser.add_argument("--outdir")
    parser.add_argument("--status-file", type=Path)
    parser.add_argument("--cancel-file", type=Path)
    parser.add_argument("--duration", type=int, default=5, choices=range(5, 16))
    parser.add_argument("--aspect", default="16:9", choices=ASPECTS)
    parser.add_argument("--profile", default="quality", choices=RENDER_PROFILES)
    parser.add_argument("--encoder", default="official", choices=("official",))
    parser.add_argument("--first-frame", default="")
    parser.add_argument("--reference-image", action="append", default=[])
    parser.add_argument("--seed", type=int, default=-1)
    parser.add_argument("--setup-only", action="store_true")
    parser.add_argument("--include-references", action="store_true")
    parser.add_argument("--stop-runtime", action="store_true")
    return parser.parse_args()


def write_test_video(destination: Path, args: argparse.Namespace) -> bool:
    """Write a realistic-duration contract MP4 when ffmpeg is available.

    The embedded 16px/0.2s file remains a portability fallback, but it is too
    small to stand in for a requested five-second H3 result during an agent
    benchmark.  Using the exact supplied first-frame path also exercises the
    frame handoff without loading a heavyweight model.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        destination.write_bytes(base64.b64decode(TEST_MP4_B64))
        return False
    width, height = RENDER_PROFILES[args.profile]["aspects"][args.aspect]
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    source = Path(args.first_frame).resolve() if args.first_frame else None
    if source and source.is_file():
        command.extend(["-loop", "1", "-framerate", "12", "-i", str(source)])
    else:
        command.extend([
            "-f", "lavfi", "-i",
            f"color=c=0x303033:s={width}x{height}:r=6:d={args.duration}",
        ])
    command.extend([
        "-vf",
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x18181a",
        "-t", str(args.duration), "-an", "-c:v", "libx264",
        "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(destination),
    ])
    result = subprocess.run(command, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, text=True, check=False)
    if result.returncode == 0 and destination.is_file() and destination.stat().st_size > 4096:
        inspect_video_output(destination, width, height, args.duration)
        return True
    destination.write_bytes(base64.b64decode(TEST_MP4_B64))
    return False


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
    if args.cancel_file is not None and args.cancel_file.is_file():
        status_write(args.status_file, "error", "cancelled",
                     "Video generation cancelled before worker startup.", 100)
        return 130
    lock_path = root / "worker.lock"
    with lock_path.open("a+") as lock:
        status_write(args.status_file, "running", "queued", "Waiting for native h3.c/Metal…", 1)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if args.cancel_file is not None and args.cancel_file.is_file():
            status_write(args.status_file, "error", "cancelled",
                         "Video generation cancelled before model loading.", 100)
            return 130
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
            realistic = write_test_video(destination, args)
            status_write(
                args.status_file, "complete", "complete", "Video H3 ready (test mode).", 100,
                fixture="first-frame-5s" if realistic else "portable-fragment",
            )
            print(destination.resolve())
            return 0
        if sys.platform != "darwin" or os.uname().machine != "arm64":
            raise H3Error("The managed native MiniMax H3 runtime requires an Apple Silicon Mac.")
        include_references = bool(args.include_references or args.reference_image)
        checkout, binary, model_dir, _ = setup_runtime(
            root, args.status_file, include_references=include_references,
        )
        if args.setup_only:
            ready_label = (
                "Official MiniMax H3 FL2VA and Ref2VA weights are ready."
                if include_references else
                "Official MiniMax H3 FL2VA weights are ready."
            )
            ready_bytes = REFERENCE_MODEL_TOTAL_BYTES if include_references else MODEL_TOTAL_BYTES
            status_write(
                args.status_file, "complete", "complete",
                ready_label, 100,
                downloadedBytes=ready_bytes, totalBytes=ready_bytes,
            )
            print(json.dumps({
                "ok": True, "encoder": "official", "model": MODEL_REPOSITORY,
                "modelRevision": MODEL_REVISION, "engineCommit": H3_COMMIT,
                "enginePatchSha256": h3_patch_sha256(),
                "runtime": "h3.c/Metal", "references": include_references,
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
