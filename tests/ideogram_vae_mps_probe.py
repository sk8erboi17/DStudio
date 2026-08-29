#!/usr/bin/env python3
"""Real Metal regression probe for Ideogram's full-resolution VAE decode.

This intentionally loads only the pinned Flux 2 VAE, never the text encoder or
diffusion models.  It proves that the production 2048px tiled decoder completes
on MPS, then compares overlapped tiling with a safe monolithic reference decode
from identical deterministic latents.
"""

from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image
from safetensors.torch import save_file
import torch


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path.home() / ".dstudio" / "ideogram4"
COMFY = RUNTIME / "comfyui"
PYTHON = RUNTIME / "venv" / "bin" / "python"


def load_runner():
    path = ROOT / "scripts" / "ideogram4-run.py"
    spec = importlib.util.spec_from_file_location("dstudio_ideogram4_probe_runner", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_json(url: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(url, data=data, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=20) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not isinstance(result, dict):
        raise RuntimeError("ComfyUI returned a non-object response")
    return result


def wait_for_server(base_url: str, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"ComfyUI exited during startup ({process.returncode})")
        try:
            http_json(base_url + "/system_stats")
            return
        except (HTTPError, URLError, TimeoutError, RuntimeError):
            time.sleep(1)
    raise RuntimeError("ComfyUI did not become ready within 180 seconds")


def terminal_error(history: dict) -> str | None:
    status = history.get("status")
    if not isinstance(status, dict) or status.get("status_str") != "error":
        return None
    messages = status.get("messages")
    if isinstance(messages, list):
        for event in reversed(messages):
            if (isinstance(event, list) and len(event) == 2 and
                    event[0] == "execution_error" and isinstance(event[1], dict)):
                detail = event[1]
                return f"{detail.get('node_type')}: {detail.get('exception_message')}"
    return "ComfyUI workflow failed"


def run_graph(base_url: str, graph: dict, output_nodes: tuple[str, ...]) -> dict:
    queued = http_json(base_url + "/prompt", {
        "prompt": graph,
        "client_id": f"dstudio-vae-probe-{time.time_ns()}",
    })
    prompt_id = queued.get("prompt_id")
    if not isinstance(prompt_id, str) or not prompt_id:
        raise RuntimeError(f"ComfyUI rejected probe graph: {queued}")
    while True:
        histories = http_json(base_url + f"/history/{prompt_id}")
        history = histories.get(prompt_id)
        if isinstance(history, dict):
            error = terminal_error(history)
            if error:
                raise RuntimeError(error)
            outputs = history.get("outputs")
            if isinstance(outputs, dict) and all(node in outputs for node in output_nodes):
                return history
        time.sleep(1)


def write_latent(path: Path, width: int, height: int, seed: int) -> None:
    generator = torch.Generator(device="cpu").manual_seed(seed)
    latent = torch.randn((1, 128, height // 16, width // 16), generator=generator)
    save_file({
        "latent_tensor": latent.contiguous(),
        "latent_format_version_0": torch.tensor([]),
    }, str(path))


def image_path(history: dict, node: str, output: Path) -> Path:
    info = history["outputs"][node]["images"][0]
    candidate = (output / str(info.get("subfolder", "")) / info["filename"]).resolve()
    if output.resolve() not in candidate.parents or not candidate.is_file():
        raise RuntimeError(f"unsafe or missing probe output: {candidate}")
    return candidate


def decode_graph(latent: str, *, tiled: bool, prefix: str, runner) -> dict:
    decoder = {
        "class_type": "VAEDecodeTiled" if tiled else "VAEDecode",
        "inputs": {"samples": ["1", 0], "vae": ["2", 0]},
    }
    if tiled:
        decoder["inputs"].update({
            "tile_size": runner.VAE_TILE_SIZE,
            "overlap": runner.VAE_TILE_OVERLAP,
            "temporal_size": 64,
            "temporal_overlap": 8,
        })
    return {
        "1": {"class_type": "LoadLatent", "inputs": {"latent": latent}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": runner.VAE}},
        "3": decoder,
        "4": {"class_type": "SaveImage", "inputs": {
            "images": ["3", 0], "filename_prefix": prefix}},
    }


def quality_graph(latent: str, runner) -> dict:
    return {
        "1": {"class_type": "LoadLatent", "inputs": {"latent": latent}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": runner.VAE}},
        "3": {"class_type": "VAEDecode", "inputs": {
            "samples": ["1", 0], "vae": ["2", 0]}},
        "4": {"class_type": "VAEDecodeTiled", "inputs": {
            "samples": ["1", 0], "vae": ["2", 0],
            "tile_size": 512, "overlap": 128,
            "temporal_size": 64, "temporal_overlap": 8}},
        "5": {"class_type": "SaveImage", "inputs": {
            "images": ["3", 0], "filename_prefix": "probe-reference"}},
        "6": {"class_type": "SaveImage", "inputs": {
            "images": ["4", 0], "filename_prefix": "probe-tiled"}},
    }


def compare(reference: Path, tiled: Path) -> dict[str, float]:
    with Image.open(reference) as image:
        first = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    with Image.open(tiled) as image:
        second = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    if first.shape != second.shape:
        raise RuntimeError(f"decoder output shapes differ: {first.shape} != {second.shape}")
    difference = first - second
    mse = float(np.mean(np.square(difference)))
    mae = float(np.mean(np.abs(difference)))
    psnr = float("inf") if mse == 0 else 10.0 * math.log10(1.0 / mse)
    return {"mae": mae, "mse": mse, "psnrDb": psnr}


def stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=45)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main() -> int:
    runner = load_runner()
    if not PYTHON.is_file() or not (COMFY / "main.py").is_file():
        raise RuntimeError("pinned Ideogram runtime is unavailable")
    if not torch.backends.mps.is_available():
        raise RuntimeError("the Ideogram VAE Metal probe requires MPS")

    with tempfile.TemporaryDirectory(prefix="dstudio-ideogram-vae-probe-") as temporary:
        root = Path(temporary)
        input_dir = root / "input"
        output_dir = root / "output"
        input_dir.mkdir()
        output_dir.mkdir()
        full_name = "full-2048x1536.latent"
        compare_name = "compare-768x512.latent"
        write_latent(input_dir / full_name, 2048, 1536, 20260825)
        write_latent(input_dir / compare_name, 768, 512, 20260826)

        port = free_port()
        base_url = f"http://127.0.0.1:{port}"
        log_path = root / "comfy.log"
        with log_path.open("wb") as log:
            process = subprocess.Popen([
                str(PYTHON), str(COMFY / "main.py"),
                "--listen", "127.0.0.1", "--port", str(port),
                "--input-directory", str(input_dir),
                "--output-directory", str(output_dir),
                "--disable-auto-launch", "--preview-method", "none",
                "--cache-none", "--disable-metadata",
            ], cwd=COMFY, stdout=log, stderr=subprocess.STDOUT,
               start_new_session=True)
            try:
                wait_for_server(base_url, process)
                started = time.monotonic()
                full = run_graph(
                    base_url,
                    decode_graph(full_name, tiled=True, prefix="probe-full", runner=runner),
                    ("4",),
                )
                full_path = image_path(full, "4", output_dir)
                full_validation = runner.inspect_output(full_path, (2048, 1536))
                full_seconds = time.monotonic() - started

                quality = run_graph(base_url, quality_graph(compare_name, runner), ("5", "6"))
                reference_path = image_path(quality, "5", output_dir)
                tiled_path = image_path(quality, "6", output_dir)
                metrics = compare(reference_path, tiled_path)
            finally:
                stop(process)

        log_text = log_path.read_text(encoding="utf-8", errors="replace")
        if "MPSGraph does not support tensor dims larger than INT_MAX" in log_text:
            raise RuntimeError("the MPS INT_MAX decoder regression reappeared")
        if not math.isfinite(metrics["psnrDb"]) and metrics["mse"] != 0:
            raise RuntimeError(f"non-finite decoder comparison: {metrics}")
        # Tiled VAE decoding changes boundary context slightly.  This generous
        # guard rejects visible/global divergence while remaining stable across
        # PyTorch Metal kernels and PNG quantization.
        if metrics["mae"] > 0.035 or metrics["psnrDb"] < 24.0:
            raise RuntimeError(f"tiled VAE quality regression: {metrics}")

        print(json.dumps({
            "result": "pass",
            "device": "mps",
            "fullResolution": full_validation,
            "fullDecodeSeconds": round(full_seconds, 3),
            "comparison": metrics,
            "policy": runner.VAE_DECODE_POLICY,
            "tileSize": runner.VAE_TILE_SIZE,
            "overlap": runner.VAE_TILE_OVERLAP,
        }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
