#!/usr/bin/env python3
import argparse
import json
import os
import struct
import time
import zlib
from pathlib import Path
from types import SimpleNamespace


def write_status(path, state: str, stage: str, label: str, progress: int) -> None:
    if path is None:
        return
    payload = {
        "ok": True,
        "state": state,
        "stage": stage,
        "label": label,
        "progress": max(0, min(100, int(progress))),
        "updatedAt": int(time.time() * 1000),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def mock_png(path: Path) -> None:
    width, height = 96, 96
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            row.extend((35 + x * 2, 70 + y, 190, 255))
        rows.append(bytes(row))
    raw = b"".join(rows)
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--prompt-file", required=True)
    p.add_argument("--outdir", required=True)
    p.add_argument("--status-file")
    p.add_argument("--aspect", default="16:9")
    args = p.parse_args()
    prompt = Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if not prompt:
        raise SystemExit("empty image prompt")
    outdir = Path(args.outdir)
    status_file = Path(args.status_file) if args.status_file else None
    outdir.mkdir(parents=True, exist_ok=True)
    if os.environ.get("DSTUDIO_IMAGE_TEST_MODE") == "1":
        write_status(status_file, "running", "inference", "Generating image (test mode)…", 75)
        output = outdir / "generated-test.png"
        mock_png(output)
        write_status(status_file, "complete", "complete", "Image ready.", 100)
        print(output.resolve())
        return 0

    write_status(status_file, "running", "preparing", "Preparing the local Qwen Image runtime…", 5)
    from qwen_image_mps.cli import generate_image
    write_status(status_file, "running", "model", "Downloading or loading Qwen Image model weights…", 12)
    ns = SimpleNamespace(
        prompt=prompt, negative_prompt=None, steps=50, fast=False,
        ultra_fast=True, seed=None, num_images=1, aspect=args.aspect,
        lora=None, cfg_scale=None, output_dir=str(outdir), output_path=None,
        batman=False, quantization=None, event_callback=None,
    )
    event_status = {
        "init": ("model", "Initializing Qwen Image…", 10),
        "loading_model": ("model", "Downloading or loading Qwen Image model weights…", 12),
        "model_loaded": ("model-ready", "Qwen Image model loaded.", 48),
        "loading_custom_lora": ("adapter", "Loading image adapter…", 52),
        "loading_ultra_fast_lora": ("adapter", "Loading the 4-step Lightning adapter…", 54),
        "loading_fast_lora": ("adapter", "Loading the 8-step Lightning adapter…", 54),
        "lora_loaded": ("adapter-ready", "Image adapter ready.", 62),
        "preparing_generation": ("preparing-image", "Preparing image tensors…", 68),
        "inference_start": ("inference", "Generating pixels with Qwen Image…", 74),
        "inference_complete": ("inference-complete", "Image inference complete.", 92),
        "saving_image": ("saving", "Saving the generated image…", 96),
        "image_saved": ("saved", "Generated image saved.", 99),
        "complete": ("complete", "Image ready.", 100),
        "error": ("error", "Qwen Image generation failed.", 100),
    }
    saved = []
    for event in generate_image(ns):
        if isinstance(event, list):
            saved = event
        elif hasattr(event, "value"):
            stage, label, progress = event_status.get(
                str(event.value), ("working", "Qwen Image is working…", 50)
            )
            write_status(
                status_file,
                "error" if str(event.value) == "error" else "complete" if str(event.value) == "complete" else "running",
                stage,
                label,
                progress,
            )
            print(f"step:{event.value}", flush=True)
    if not saved:
        write_status(status_file, "error", "error", "Qwen Image returned no output.", 100)
        raise SystemExit("Qwen image pipeline returned no output")
    write_status(status_file, "complete", "complete", "Image ready.", 100)
    print(saved[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
