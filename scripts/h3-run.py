#!/usr/bin/env python3
"""Run MiniMax H3 locally through stock ComfyUI on Apple Silicon.

This worker deliberately uses only open-weight checkpoints. It never calls a
MiniMax generation API. The one-time setup is large (~54 GiB), so every stage
is written atomically to a JSON status file consumed by DStudio's chat UI.
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
MODEL_REPOSITORY = "Comfy-Org/MiniMax-H3"
MODEL_REVISION = "eb8a16107c595128b3a578f82d2ce2f75920c355"
COMMUNITY_ENCODER_REPOSITORY = (
    "linjian257/qwen3vl_32b_minimax_h3_int8_convrot_uncensored-by-linjian257"
)
COMMUNITY_ENCODER_REVISION = "19a1c202af96b9c3d51dd346ecd0168c2720b0d3"

DIFFUSION_NAME = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
VIDEO_VAE_NAME = "minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE_NAME = "minimax_h3_audio_vae_fp32.safetensors"
OFFICIAL_ENCODER_NAME = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"
COMMUNITY_ENCODER_NAME = (
    "qwen3vl_32b_minimax_h3_int8_convrot_uncensored-by-linjian257.safetensors"
)

MODEL_FILES = {
    "diffusion": {
        "name": DIFFUSION_NAME,
        "subdir": "diffusion_models",
        "size": 20_970_379_616,
        "url": f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/diffusion_models/{DIFFUSION_NAME}",
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

ASPECTS = {
    "16:9": (1344, 768),
    "9:16": (768, 1344),
    "1:1": (768, 768),
    "4:3": (1024, 768),
    "3:4": (768, 1024),
}

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


def selected_files(encoder: str) -> list[dict]:
    encoder_key = "community_encoder" if encoder == "community" else "official_encoder"
    return [MODEL_FILES["diffusion"], MODEL_FILES[encoder_key], MODEL_FILES["video_vae"], MODEL_FILES["audio_vae"]]


def model_path(comfy: Path, spec: dict) -> Path:
    return comfy / "models" / spec["subdir"] / spec["name"]


def ensure_comfy_checkout(comfy: Path, git: str) -> None:
    """Materialize and verify the pinned ComfyUI worktree.

    A ``git clone --no-checkout`` can already report the pinned revision as
    HEAD while leaving every tracked file absent.  Checking only HEAD would
    therefore pass and make the later ``uv pip -r requirements.txt`` call
    fail.  Treat the checkout as ready only when both the revision and its
    runtime sentinel files are present.
    """
    head = ""
    with contextlib.suppress(Exception):
        head = subprocess.check_output(
            [git, "rev-parse", "HEAD"], cwd=comfy, text=True
        ).strip()

    commit_exists = subprocess.run(
        [git, "cat-file", "-e", f"{COMFY_COMMIT}^{{commit}}"],
        cwd=comfy,
        text=True,
        capture_output=True,
    ).returncode == 0
    if not commit_exists:
        run([git, "fetch", "--depth=1", "origin", COMFY_COMMIT], cwd=comfy)

    checkout_ready = all((comfy / relative).is_file() for relative in COMFY_REQUIRED_FILES)
    if head != COMFY_COMMIT or not checkout_ready:
        run([git, "checkout", "--force", "--detach", COMFY_COMMIT], cwd=comfy)

    missing = [relative for relative in COMFY_REQUIRED_FILES if not (comfy / relative).is_file()]
    if missing:
        raise H3Error(
            "The managed ComfyUI checkout is incomplete after repair: " + ", ".join(missing)
        )


def setup_comfy(root: Path, status: Path | None) -> tuple[Path, Path]:
    git = require_command("git")
    uv = require_command("uv")
    comfy = root / "ComfyUI"
    status_write(status, "running", "runtime", "Preparing the local ComfyUI/MPS runtime…", 3)
    if not (comfy / ".git").is_dir():
        root.mkdir(parents=True, exist_ok=True)
        run([git, "clone", "--filter=blob:none", "--no-checkout", COMFY_REPOSITORY, str(comfy)])
    ensure_comfy_checkout(comfy, git)

    venv = root / ".venv"
    python = venv / "bin" / "python"
    marker = root / ".comfy-runtime-revision"
    marker_value = marker.read_text(encoding="utf-8").strip() if marker.is_file() else ""
    if not python.is_file() or marker_value != COMFY_COMMIT:
        status_write(status, "running", "dependencies", "Installing the local H3 runtime dependencies…", 7)
        if not python.is_file():
            run([uv, "venv", str(venv), "--python", "3.12"])
        run([uv, "pip", "install", "--python", str(python), "-r", str(comfy / "requirements.txt")])
        marker.write_text(COMFY_COMMIT + "\n", encoding="utf-8")
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


def ensure_models(comfy: Path, encoder: str, status: Path | None) -> str:
    files = selected_files(encoder)
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
    )
    return COMMUNITY_ENCODER_NAME if encoder == "community" else OFFICIAL_ENCODER_NAME


def setup_runtime(root: Path, encoder: str, status: Path | None) -> tuple[Path, Path, str]:
    comfy, python = setup_comfy(root, status)
    encoder_name = ensure_models(comfy, encoder, status)
    return comfy, python, encoder_name


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_json(url: str, payload: dict | None = None, timeout: float = 30) -> dict:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"} if body is not None else {},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_comfy(base: str, process: subprocess.Popen, log_path: Path) -> dict:
    deadline = time.monotonic() + 420
    last_error = ""
    while time.monotonic() < deadline:
        if process.poll() is not None:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-5000:] if log_path.is_file() else ""
            raise H3Error(f"ComfyUI stopped during startup. {tail.strip()}")
        try:
            info = http_json(base + "/object_info", timeout=5)
            required = {"MiniMaxH3ImageToVideo", "SaveVideo", "CreateVideo", "VAEDecodeAudio"}
            missing = sorted(required.difference(info))
            if missing:
                raise H3Error(f"The pinned ComfyUI runtime is missing nodes: {', '.join(missing)}")
            return info
        except H3Error:
            raise
        except Exception as exc:
            last_error = str(exc)
            time.sleep(1)
    raise H3Error(f"ComfyUI did not become ready in 7 minutes. {last_error}")


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
                 seed: int, encoder_name: str, first_frame_name: str = "") -> dict:
    graph: dict[str, dict] = {
        "1": {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE_NAME}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": AUDIO_VAE_NAME}},
        "3": {"class_type": "UNETLoader", "inputs": {"unet_name": DIFFUSION_NAME, "weight_dtype": "default"}},
        "4": {"class_type": "CLIPLoader", "inputs": {"clip_name": encoder_name, "type": "minimax", "device": "default"}},
        "5": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["4", 0], "vae": ["1", 0], "prompt": prompt,
            "width": width, "height": height, "length": aligned_frame_count(seconds),
        }},
        "6": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "7": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "8": {"class_type": "BasicScheduler", "inputs": {"model": ["3", 0], "scheduler": "simple", "steps": 20, "denoise": 1.0}},
        "9": {"class_type": "BasicGuider", "inputs": {"model": ["3", 0], "conditioning": ["5", 0]}},
        "10": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["6", 0], "guider": ["9", 0], "sampler": ["7", 0],
            "sigmas": ["8", 0], "latent_image": ["5", 1],
        }},
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["1", 0]}},
        "12": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["10", 0], "vae": ["2", 0]}},
        "13": {"class_type": "CreateVideo", "inputs": {"images": ["11", 0], "fps": 24.0, "audio": ["12", 0], "bit_depth": 8}},
        "14": {"class_type": "SaveVideo", "inputs": {
            "video": ["13", 0], "filename_prefix": "DStudio/MiniMax-H3",
            "format": "auto", "codec": {"codec": "h264", "encoding": {"encoding": "auto"}},
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


def generate(args, comfy: Path, python: Path, encoder_name: str) -> Path:
    output_dir = Path(args.outdir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    log_path = output_dir / "comfyui.log"
    env = os.environ.copy()
    env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    command = [
        str(python), str(comfy / "main.py"), "--listen", "127.0.0.1",
        "--port", str(port), "--disable-auto-launch", "--disable-all-custom-nodes",
        "--disable-api-nodes",
        "--output-directory", str(output_dir / "comfy-output"),
    ]
    status_write(args.status_file, "running", "runtime-start", "Starting MiniMax H3 on Apple Metal…", 61)
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, cwd=comfy, env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        wait_for_comfy(base, process, log_path)
        status_write(args.status_file, "running", "model-load", "Loading the H3 open weights into unified memory…", 65)
        first_frame_name = ""
        if args.first_frame:
            first_frame_name = upload_image(base, Path(args.first_frame).resolve())
        width, height = ASPECTS[args.aspect]
        graph = build_prompt(
            Path(args.prompt_file).read_text(encoding="utf-8").strip(),
            width, height, args.duration, args.seed, encoder_name, first_frame_name,
        )
        response = http_json(base + "/prompt", {"prompt": graph, "client_id": uuid.uuid4().hex}, timeout=60)
        prompt_id = str(response.get("prompt_id") or "")
        if not prompt_id:
            raise H3Error(f"ComfyUI rejected the H3 workflow: {response.get('error') or response}")
        started = time.monotonic()
        while True:
            if process.poll() is not None:
                tail = log_path.read_text(encoding="utf-8", errors="replace")[-5000:]
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
                    source = output_dir / "comfy-output" / subfolder / filename
                    if not source.is_file():
                        raise H3Error("ComfyUI reported a video file that is not present on disk.")
                    suffix = source.suffix.lower() if source.suffix else ".mp4"
                    destination = output_dir / f"minimax-h3-{int(time.time())}{suffix}"
                    shutil.copy2(source, destination)
                    status_write(args.status_file, "complete", "complete", "Video H3 ready — generated locally with synchronized audio.", 100)
                    return destination
            elapsed = time.monotonic() - started
            pct = min(94, 68 + int(elapsed / 30))
            label = "Sampling video and synchronized audio locally with H3…"
            if pct >= 90:
                label = "Decoding the H3 video and audio…"
            status_write(args.status_file, "running", "inference", label, pct)
            time.sleep(3)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file")
    parser.add_argument("--outdir")
    parser.add_argument("--status-file", type=Path)
    parser.add_argument("--duration", type=int, default=5, choices=range(5, 16))
    parser.add_argument("--aspect", default="16:9", choices=ASPECTS)
    parser.add_argument("--encoder", default="official", choices=("official", "community"))
    parser.add_argument("--first-frame", default="")
    parser.add_argument("--seed", type=int, default=-1)
    parser.add_argument("--setup-only", action="store_true")
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
        comfy, python, encoder_name = setup_runtime(root, args.encoder, args.status_file)
        if args.setup_only:
            status_write(args.status_file, "complete", "complete", "MiniMax H3 open weights are ready.", 100)
            print(json.dumps({"ok": True, "encoder": args.encoder, "model": "MiniMaxAI/MiniMax-H3"}))
            return 0
        if not args.prompt_file or not args.outdir:
            raise H3Error("prompt and output directory are required")
        output = generate(args, comfy, python, encoder_name)
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
