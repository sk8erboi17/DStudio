#!/usr/bin/env python3
"""One-shot local Ideogram 4 FP8 Quality-48 worker for Apple Silicon."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import struct
from statistics import NormalDist
import subprocess
import sys
import time
import zlib
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MODEL_REPOSITORY = "Comfy-Org/Ideogram-4"
MODEL_REVISION = "bbee2ab2b14b2b5223448d12d6e31e5f9cec0546"
COMFY_COMMIT = "b78cec879b9460d5cb25228a83a942fb78d2cd24"
FP8_PLUGIN_COMMIT = "911294ca35093eef56f7f2695414ff8810e88e50"
IDEOGRAM_NODE_COMMIT = "c05545d71e61b7ce47534a972eaeefd958a3719f"
CONDITIONAL_MODEL = "ideogram4_fp8_scaled.safetensors"
UNCONDITIONAL_MODEL = "ideogram4_unconditional_fp8_scaled.safetensors"
TEXT_ENCODER = "qwen3vl_8b_fp8_scaled.safetensors"
VAE = "flux2-vae.safetensors"

# The Flux 2 VAE has a full-frame spatial attention block.  At Ideogram's
# native 2048px output sizes, the Metal/MPS implementation can exceed its
# signed 32-bit graph-index limit even when plenty of unified memory remains.
# ComfyUI's overlapping tiled decoder evaluates the same VAE weights in three
# complementary tile orientations and blends their overlap, preserving the
# requested output resolution without a lower-quality resize or CPU fallback.
VAE_DECODE_POLICY = "overlapped-three-pass-tiled"
VAE_TILE_SIZE = 1024
VAE_TILE_OVERLAP = 256

# Official highest-quality sampler profile. No Turbo/preview fallback exists.
QUALITY_STEPS = 48
QUALITY_CFG = 7.0
QUALITY_POLISH_CFG = 3.0
QUALITY_POLISH_STEPS = 3
QUALITY_MU = 0.0
QUALITY_STD = 1.5

# Maximum supported edge (2048), preserving common aspect ratios exactly.
ASPECT_SIZES = {
    "16:9": (2048, 1152),
    "9:16": (1152, 2048),
    "3:2": (2016, 1344),
    "2:3": (1344, 2016),
    "4:3": (2048, 1536),
    "3:4": (1536, 2048),
    "1:1": (2048, 2048),
}
# Contract fixtures stay cheap while preserving the requested output geometry.
# This matters because responsive media gates must see the same aspect ratio
# that a real Ideogram render would have produced.
TEST_ASPECT_SIZES = {
    "16:9": (640, 360),
    "9:16": (360, 640),
    "3:2": (600, 400),
    "2:3": (400, 600),
    "4:3": (640, 480),
    "3:4": (480, 640),
    "1:1": (512, 512),
}
PROGRESS_RE = re.compile(r"(?<!\d)(\d{1,3})\s*/\s*(48)(?!\d)")


def build_test_png(width: int = 640, height: int = 360) -> bytes:
    """Create a deterministic, decodable 16:9 contract frame.

    A 1x1 PNG proves transport integrity but is semantically impossible for a
    requested editorial image. The realistic dimensions keep agent-level
    correspondence checks honest while test mode still avoids model loading.
    """
    scanlines = bytearray()
    for y in range(height):
        scanlines.append(0)
        for x in range(width):
            concrete = 50 + ((x * 5 + y * 3) % 28)
            r = g = b = concrete
            if width // 5 < x < width * 4 // 5 and height // 5 < y < height * 4 // 5:
                metal = 118 + ((x * 7 + y * 11) % 92)
                r, g, b = metal, min(255, metal + 5), min(255, metal + 8)
            if width * 13 // 20 < x < width * 7 // 10 and height // 3 < y < height * 3 // 4:
                r, g, b = 212, 30, 35
            scanlines.extend((r, g, b))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(scanlines), 9))
        + chunk(b"IEND", b"")
    )


TEST_PNG = build_test_png()


class IdeogramError(RuntimeError):
    pass


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


def publish_inference_progress(path: Path | None, step: int, width: int,
                               height: int, started: float,
                               heartbeat: bool = False) -> None:
    common = {
        "quality": "quality-48",
        "width": width,
        "height": height,
        "elapsedSeconds": round(max(0.0, time.monotonic() - started), 3),
        "heartbeat": heartbeat,
    }
    if step >= QUALITY_STEPS:
        status_write(path, "running", "decoding",
                     "Diffusion complete; decoding the full-resolution image…", 92,
                     step=step, steps=QUALITY_STEPS,
                     vaeDecode=VAE_DECODE_POLICY, **common)
    elif step >= 0:
        status_write(path, "running", "sampling",
                     f"Ideogram 4 Quality: diffusion step {step}/{QUALITY_STEPS}…",
                     22 + round(68 * step / QUALITY_STEPS),
                     step=step, steps=QUALITY_STEPS, **common)
    else:
        status_write(path, "running", "encoding",
                     "Encoding the verified structured caption…", 18,
                     steps=QUALITY_STEPS, **common)


def runtime_root() -> Path:
    configured = os.environ.get("DSTUDIO_IDEOGRAM4_HOME", "").strip()
    return Path(configured).expanduser().resolve() if configured else (
        Path.home() / ".dstudio" / "ideogram4"
    ).resolve()


def verify_caption(raw: str) -> str:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise IdeogramError(f"Ideogram 4 requires a structured JSON caption: {exc}") from exc
    if not isinstance(parsed, dict):
        raise IdeogramError("Ideogram 4 caption must be one JSON object")
    if "mode" in parsed or "caption" in parsed:
        raise IdeogramError("Ideogram 4 accepts the structured caption directly, not a routing envelope")
    parsed.pop("aspect_ratio", None)
    # Bounding boxes are useful for the captioner but the official local magic
    # prompt strips them before inference to avoid brittle placement artifacts.
    elements = parsed.get("compositional_deconstruction", {}).get("elements", [])
    if isinstance(elements, list):
        for element in elements:
            if isinstance(element, dict):
                element.pop("bbox", None)
    canonical = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
    try:
        from ideogram4.caption_verifier import CaptionVerifier
        issues = CaptionVerifier().verify_raw(canonical)
    except ImportError as exc:
        raise IdeogramError("Pinned Ideogram 4 caption verifier is unavailable") from exc
    if issues:
        raise IdeogramError("Ideogram caption failed verification: " + "; ".join(issues))
    return canonical


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_json(url: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise IdeogramError(f"ComfyUI request failed: {exc}") from exc
    if not isinstance(result, dict):
        raise IdeogramError("ComfyUI returned a non-object response")
    return result


def wait_for_server(base_url: str, process: subprocess.Popen[bytes]) -> None:
    while True:
        if process.poll() is not None:
            raise IdeogramError(f"ComfyUI exited during startup with code {process.returncode}")
        try:
            http_json(base_url + "/system_stats")
            return
        except IdeogramError:
            time.sleep(1)


def quality_polish_start(width: int, height: int) -> float:
    """Return a sigma-percent boundary that selects exactly three final steps.

    Ideogram's official V4_QUALITY_48 registry specifies 45 sampling steps at
    CFG 7 followed by three polish steps at CFG 3.  Comfy's reference graph
    uses a fixed 0.7 CFGOverride boundary; because the Ideogram scheduler is
    resolution-aware, that fixed value selects four polish steps at several
    non-square resolutions.  Place the boundary halfway between the last main
    step and the first polish step instead.  Ideogram's pinned FLOW sampling
    config has shift=1, so Comfy maps percent to sigma as 1-percent.
    """
    first_polish_index = QUALITY_STEPS - QUALITY_POLISH_STEPS
    preceding_index = first_polish_index - 1
    mean = QUALITY_MU + 0.5 * math.log((width * height) / (512 * 512))
    normal = NormalDist()

    def sigma_at(index: int) -> float:
        # ideogram4_sigmas reverses an inclusive 0..1 probit schedule.
        quantile = (QUALITY_STEPS - index) / QUALITY_STEPS
        logit = mean + QUALITY_STD * normal.inv_cdf(quantile)
        return 1.0 / (1.0 + math.exp(-logit))

    boundary_sigma = (sigma_at(preceding_index) + sigma_at(first_polish_index)) / 2.0
    return 1.0 - boundary_sigma


def workflow(caption: str, width: int, height: int, seed: int) -> dict:
    polish_start = quality_polish_start(width, height)
    return {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": CONDITIONAL_MODEL, "weight_dtype": "default"}},
        "2": {"class_type": "CFGOverride", "inputs": {
            "model": ["1", 0], "cfg": QUALITY_POLISH_CFG,
            "start_percent": polish_start, "end_percent": 1.0}},
        "3": {"class_type": "UNETLoader", "inputs": {
            "unet_name": UNCONDITIONAL_MODEL, "weight_dtype": "default"}},
        "4": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": TEXT_ENCODER, "type": "ideogram4", "device": "default"}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {
            "text": caption, "clip": ["4", 0]}},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {
            "conditioning": ["5", 0]}},
        "7": {"class_type": "DualModelGuider", "inputs": {
            "model": ["2", 0], "positive": ["5", 0],
            "model_negative": ["3", 0], "negative": ["6", 0], "cfg": QUALITY_CFG}},
        "8": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "10": {"class_type": "Ideogram4Scheduler", "inputs": {
            "steps": QUALITY_STEPS, "width": width, "height": height,
            "mu": QUALITY_MU, "std": QUALITY_STD}},
        "11": {"class_type": "EmptyFlux2LatentImage", "inputs": {
            "width": width, "height": height, "batch_size": 1}},
        "12": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["8", 0], "guider": ["7", 0], "sampler": ["9", 0],
            "sigmas": ["10", 0], "latent_image": ["11", 0]}},
        "13": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "14": {"class_type": "VAEDecodeTiled", "inputs": {
            "samples": ["12", 0], "vae": ["13", 0],
            "tile_size": VAE_TILE_SIZE, "overlap": VAE_TILE_OVERLAP,
            "temporal_size": 64, "temporal_overlap": 8}},
        "15": {"class_type": "SaveImage", "inputs": {
            "images": ["14", 0], "filename_prefix": "dstudio-ideogram4"}},
    }


def history_error(history: dict) -> str:
    status = history.get("status")
    messages = status.get("messages") if isinstance(status, dict) else None
    if isinstance(messages, list) and messages:
        for event in reversed(messages):
            if not (isinstance(event, list) and len(event) == 2 and
                    event[0] == "execution_error" and isinstance(event[1], dict)):
                continue
            detail = event[1]
            node = detail.get("node_type")
            error_type = detail.get("exception_type")
            message = str(detail.get("exception_message", "")).strip()
            prefix = "ComfyUI"
            if isinstance(node, str) and node:
                prefix += f" {node}"
            prefix += " failed"
            if isinstance(error_type, str) and error_type:
                prefix += f" ({error_type})"
            return f"{prefix}: {message}" if message else prefix
        return json.dumps(messages[-3:], ensure_ascii=False)[-4000:]
    return "Ideogram 4 workflow did not produce an image"


def terminal_history_error(history: dict) -> str | None:
    """Return a terminal Comfy failure even when completed is false.

    ComfyUI deliberately records execution_error with status_str=error and
    completed=false.  Treat both an explicit error and a completed graph with
    no output as terminal; an executing or queued history remains nonterminal.
    """
    status = history.get("status")
    if not isinstance(status, dict):
        return None
    if status.get("status_str") == "error" or status.get("completed") is True:
        return history_error(history)
    return None


def inspect_output(path: Path, expected_size: tuple[int, int]) -> dict[str, object]:
    """Reject corrupt or degenerate renders before they can be reported ready."""
    try:
        from PIL import Image, ImageStat
        with Image.open(path) as image:
            image.load()
            image_format = image.format
            size = image.size
            mode = image.mode
            rgb = image.convert("RGB")
            rgb.thumbnail((256, 256), Image.Resampling.LANCZOS)
            gray = rgb.convert("L")
            histogram = gray.histogram()
            histogram_bins = sum(1 for count in histogram if count)
            significant_fraction = sum(histogram[8:]) / max(1, sum(histogram))
            extrema = gray.getextrema()
            entropy = float(gray.entropy())
            mean = float(ImageStat.Stat(gray).mean[0])
    except (OSError, ValueError) as exc:
        raise IdeogramError(f"Ideogram output is not a valid decodable image: {exc}") from exc
    if image_format != "PNG" or size != expected_size:
        raise IdeogramError(
            f"Ideogram output metadata mismatch: format={image_format}, size={size}"
        )
    # Sparse astronomical photographs can legitimately have low global
    # entropy while retaining a real planet and stars.  Reject low entropy
    # only when fewer than 0.2% of the thumbnail pixels carry meaningful
    # luminance; a genuinely uniform/black decode still fails this and the
    # independent range/bin checks.
    if (extrema[1] - extrema[0] < 8 or histogram_bins < 8 or
            (entropy < 0.5 and significant_fraction < 0.002)):
        raise IdeogramError("Ideogram output is visually degenerate (flat/blank image)")
    return {
        "format": image_format,
        "mode": mode,
        "width": size[0],
        "height": size[1],
        "lumaMin": extrema[0],
        "lumaMax": extrema[1],
        "lumaMean": round(mean, 4),
        "lumaEntropy": round(entropy, 4),
        "occupiedLumaBins": histogram_bins,
        "significantLumaFraction": round(significant_fraction, 6),
    }


def stop_server(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=45)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--status-file")
    parser.add_argument("--aspect", choices=tuple(ASPECT_SIZES), default="16:9")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    prompt_path = Path(args.prompt_file).resolve()
    outdir = Path(args.outdir).resolve()
    status_path = Path(args.status_file).resolve() if args.status_file else None
    outdir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()

    if os.environ.get("DSTUDIO_IDEOGRAM4_TEST_MODE") == "1":
        destination = outdir / "ideogram4-test.png"
        destination.write_bytes(build_test_png(*TEST_ASPECT_SIZES[args.aspect]))
        status_write(status_path, "complete", "complete", "Image ready.", 100,
                     provider="ideogram4-fp8", quality="quality-48")
        print(destination)
        return 0

    try:
        raw_caption = prompt_path.read_text(encoding="utf-8").strip()
        caption = verify_caption(raw_caption)
        width, height = ASPECT_SIZES[args.aspect]
        root = runtime_root()
        comfy = root / "comfyui"
        python = root / "venv" / "bin" / "python"
        if not python.is_file() or not (comfy / "main.py").is_file():
            raise IdeogramError("Pinned Ideogram 4 runtime is incomplete")

        status_write(status_path, "running", "runtime",
                     "Starting the pinned Ideogram 4 FP8 Metal runtime…", 4,
                     quality="quality-48", width=width, height=height)
        port = free_port()
        server_log = outdir / "ideogram4-comfy.log"
        log_handle = server_log.open("wb")
        environment = os.environ.copy()
        environment.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        command = [
            str(python), str(comfy / "main.py"), "--listen", "127.0.0.1",
            "--port", str(port), "--disable-auto-launch", "--preview-method", "none",
            "--cache-none", "--disable-metadata",
        ]
        process = subprocess.Popen(
            command, cwd=comfy, env=environment, stdout=log_handle,
            stderr=subprocess.STDOUT, start_new_session=True,
        )
        try:
            base_url = f"http://127.0.0.1:{port}"
            wait_for_server(base_url, process)
            status_write(status_path, "running", "loading_model",
                         "Loading Ideogram 4 FP8 and its internal text encoder into Metal…", 10,
                         quality="quality-48", width=width, height=height)
            client_id = f"dstudio-{os.getpid()}-{int(time.time())}"
            queued = http_json(base_url + "/prompt", {
                "prompt": workflow(caption, width, height, args.seed),
                "client_id": client_id,
            })
            prompt_id = queued.get("prompt_id")
            if not isinstance(prompt_id, str) or not prompt_id:
                raise IdeogramError(f"ComfyUI rejected the workflow: {queued}")

            last_step = -1
            last_status_at = 0.0
            while True:
                if process.poll() is not None:
                    raise IdeogramError(f"ComfyUI exited during generation with code {process.returncode}")
                histories = http_json(base_url + f"/history/{prompt_id}")
                history = histories.get(prompt_id)
                if isinstance(history, dict):
                    outputs = history.get("outputs")
                    node_output = outputs.get("15") if isinstance(outputs, dict) else None
                    images = node_output.get("images") if isinstance(node_output, dict) else None
                    if isinstance(images, list) and images:
                        image_info = images[0]
                        filename = image_info.get("filename") if isinstance(image_info, dict) else None
                        subfolder = image_info.get("subfolder", "") if isinstance(image_info, dict) else ""
                        if not isinstance(filename, str) or not filename:
                            raise IdeogramError("ComfyUI returned an unsafe image result")
                        source = (comfy / "output" / str(subfolder) / filename).resolve()
                        if (comfy / "output").resolve() not in source.parents or not source.is_file():
                            raise IdeogramError("ComfyUI image result is missing or outside its output directory")
                        destination = outdir / f"ideogram4-{int(time.time())}-{args.seed}.png"
                        shutil.copy2(source, destination)
                        output_validation = inspect_output(destination, (width, height))
                        polish_start = quality_polish_start(width, height)
                        provenance = {
                            "provider": "ideogram4-fp8",
                            "model": MODEL_REPOSITORY,
                            "revision": MODEL_REVISION,
                            "runtime": {"comfy": COMFY_COMMIT, "fp8Plugin": FP8_PLUGIN_COMMIT,
                                        "ideogramNode": IDEOGRAM_NODE_COMMIT},
                            "quality": {"profile": "V4_QUALITY_48", "steps": QUALITY_STEPS,
                                        "sampler": "euler", "cfg": QUALITY_CFG,
                                        "polishCfg": QUALITY_POLISH_CFG,
                                        "polishSteps": QUALITY_POLISH_STEPS,
                                        "polishStart": polish_start,
                                        "mu": QUALITY_MU, "std": QUALITY_STD,
                                        "vaeDecode": VAE_DECODE_POLICY,
                                        "vaeTileSize": VAE_TILE_SIZE,
                                        "vaeTileOverlap": VAE_TILE_OVERLAP},
                            "size": {"width": width, "height": height, "aspect": args.aspect},
                            "outputValidation": output_validation,
                            "seed": args.seed,
                            "elapsedSeconds": round(time.monotonic() - started, 3),
                            "caption": json.loads(caption),
                        }
                        (outdir / "ideogram4-provenance.json").write_text(
                            json.dumps(provenance, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8",
                        )
                        status_write(status_path, "complete", "complete", "Image ready.", 100,
                                     provider="ideogram4-fp8", quality="quality-48",
                                     width=width, height=height)
                        print(destination)
                        return 0
                    failure = terminal_history_error(history)
                    if failure:
                        raise IdeogramError(failure)

                try:
                    log_handle.flush()
                    tail = server_log.read_bytes()[-200000:].decode("utf-8", "replace")
                    matches = list(PROGRESS_RE.finditer(tail))
                    step = int(matches[-1].group(1)) if matches else -1
                except OSError:
                    step = -1
                now = time.monotonic()
                if step > last_step:
                    last_step = step
                    publish_inference_progress(
                        status_path, last_step, width, height, started
                    )
                    last_status_at = now
                elif last_status_at == 0.0 or now - last_status_at >= 30.0:
                    publish_inference_progress(
                        status_path, last_step, width, height, started,
                        heartbeat=True,
                    )
                    last_status_at = now
                time.sleep(2)
        finally:
            stop_server(process)
            log_handle.close()
    except (IdeogramError, OSError, ValueError) as exc:
        status_write(status_path, "error", "error", str(exc), 100,
                     quality="quality-48")
        print(f"Ideogram 4 failed: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
