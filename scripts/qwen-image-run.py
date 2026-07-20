#!/usr/bin/env python3
import argparse
import os
import struct
import zlib
from pathlib import Path
from types import SimpleNamespace


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
    p.add_argument("--aspect", default="16:9")
    args = p.parse_args()
    prompt = Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if not prompt:
        raise SystemExit("empty image prompt")
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    if os.environ.get("DSTUDIO_IMAGE_TEST_MODE") == "1":
        output = outdir / "generated-test.png"
        mock_png(output)
        print(output.resolve())
        return 0

    from qwen_image_mps.cli import generate_image
    ns = SimpleNamespace(
        prompt=prompt, negative_prompt=None, steps=50, fast=False,
        ultra_fast=True, seed=None, num_images=1, aspect=args.aspect,
        lora=None, cfg_scale=None, output_dir=str(outdir), output_path=None,
        batman=False, quantization=None, event_callback=None,
    )
    saved = []
    for event in generate_image(ns):
        if isinstance(event, list):
            saved = event
        elif hasattr(event, "value"):
            print(f"step:{event.value}", flush=True)
    if not saved:
        raise SystemExit("Qwen image pipeline returned no output")
    print(saved[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
