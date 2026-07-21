#!/usr/bin/env python3
import argparse
import json
import os
import struct
import threading
import time
import zlib
from pathlib import Path
from types import SimpleNamespace


def detect_largest_face(image):
    """Return the largest frontal-face rectangle, or None when detection is unavailable."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        print("Pixel preservation skipped: OpenCV face detector is unavailable.", flush=True)
        return None
    gray = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2GRAY)
    cascade_path = str(Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml")
    cascade = cv2.CascadeClassifier(cascade_path)
    if cascade.empty():
        print("Pixel preservation skipped: face detector data is unavailable.", flush=True)
        return None
    minimum = max(24, min(image.size) // 12)
    faces = cascade.detectMultiScale(
        gray, scaleFactor=1.08, minNeighbors=5, minSize=(minimum, minimum)
    )
    if len(faces) == 0:
        print("Pixel preservation skipped: no face was detected in the source image.", flush=True)
        return None
    return max((tuple(map(int, face)) for face in faces), key=lambda face: face[2] * face[3])


def preserve_original_face(source_path: str, edited_path: str) -> bool:
    """Composite original head pixels over an edit, with a feathered boundary."""
    from PIL import Image, ImageDraw, ImageFilter

    source = Image.open(source_path).convert("RGB")
    face = detect_largest_face(source)
    if face is None:
        return False
    x, y, width, height = face
    # Haar detects the inner face. Expand upward and sideways to retain hair/head.
    left = max(0, int(x - width * 0.22))
    top = max(0, int(y - height * 0.48))
    right = min(source.width, int(x + width * 1.22))
    bottom = min(source.height, int(y + height * 1.18))
    if right - left < 8 or bottom - top < 8:
        return False

    edited = Image.open(edited_path).convert("RGB")
    if edited.size != source.size:
        edited = edited.resize(source.size, Image.Resampling.LANCZOS)

    mask = Image.new("L", source.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((left, top, right, bottom), fill=255)
    feather = max(3, int(min(right - left, bottom - top) * 0.055))
    mask = mask.filter(ImageFilter.GaussianBlur(feather))
    Image.composite(source, edited, mask).save(edited_path, format="PNG")
    print(
        f"Preserved original face/head pixels at {left},{top},{right},{bottom} "
        f"with a {feather}px feather.",
        flush=True,
    )
    return True


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


def huggingface_model_cache(model_name: str) -> Path:
    """Return the on-disk Hugging Face cache directory for a model."""
    explicit = os.environ.get("HF_HUB_CACHE")
    if explicit:
        hub = Path(explicit).expanduser()
    elif os.environ.get("HF_HOME"):
        hub = Path(os.environ["HF_HOME"]).expanduser() / "hub"
    elif os.environ.get("XDG_CACHE_HOME"):
        hub = Path(os.environ["XDG_CACHE_HOME"]).expanduser() / "huggingface" / "hub"
    else:
        hub = Path.home() / ".cache" / "huggingface" / "hub"
    return hub / f"models--{model_name.replace('/', '--')}"


def model_download_bytes(model_dir: Path):
    """Return downloaded/expected bytes using huggingface_hub tree metadata."""
    trees = model_dir / "trees"
    blobs = model_dir / "blobs"
    if not trees.is_dir() or not blobs.is_dir():
        return 0, 0
    metadata_files = sorted(trees.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not metadata_files:
        return 0, 0
    try:
        files = json.loads(metadata_files[0].read_text(encoding="utf-8")).get("files", {})
    except (OSError, ValueError, TypeError):
        return 0, 0
    expected = {}
    for entry in files.values():
        if not isinstance(entry, dict):
            continue
        key = entry.get("lfs_sha256") or entry.get("blob_id")
        size = entry.get("lfs_size") or entry.get("size")
        if key and isinstance(size, int):
            expected[str(key)] = max(expected.get(str(key), 0), size)
    downloaded = 0
    for key, size in expected.items():
        complete = blobs / key
        partial = blobs / f"{key}.incomplete"
        try:
            present = complete.stat().st_size
        except OSError:
            try:
                present = partial.stat().st_size
            except OSError:
                present = 0
        downloaded += min(size, present)
    total = sum(expected.values())
    # Snapshot metadata can list small optional files (README, attributes, etc.)
    # which the pipeline never requests. Once all weight transfers are closed,
    # treat a cache within 0.1% of the manifest as complete.
    if total and downloaded / total >= 0.999 and not any(blobs.glob("*.incomplete")):
        downloaded = total
    return downloaded, total


def report_edit_model_progress(status_file: Path, stop: threading.Event) -> None:
    """Publish truthful progress while upstream's synchronous edit loader runs."""
    model_dir = huggingface_model_cache("Qwen/Qwen-Image-Edit-2511")
    while not stop.is_set():
        try:
            downloaded, expected = model_download_bytes(model_dir)
            if expected and downloaded < expected:
                ratio = downloaded / expected
                current_gib = downloaded / (1024 ** 3)
                total_gib = expected / (1024 ** 3)
                write_status(
                    status_file,
                    "running",
                    "download",
                    f"Downloading Qwen Image Edit · {current_gib:.1f} / {total_gib:.1f} GiB…",
                    12 + round(36 * ratio),
                )
            elif expected:
                write_status(
                    status_file,
                    "running",
                    "model-load",
                    "Download complete · loading Qwen Image Edit into Metal…",
                    50,
                )
            else:
                write_status(
                    status_file,
                    "running",
                    "model",
                    "Downloading or loading Qwen Image Edit model weights…",
                    12,
                )
        except Exception as exc:
            # Progress reporting must never abort a valid image-edit operation.
            print(f"Qwen Image Edit progress probe skipped: {exc}", flush=True)
        stop.wait(1.0)


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
    p.add_argument("--action", choices=("generate", "edit"), default="generate")
    p.add_argument("--input", action="append", default=[])
    p.add_argument("--preserve", choices=("none", "face"), default="none")
    p.add_argument("--aspect", default="16:9")
    args = p.parse_args()
    prompt = Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if not prompt:
        raise SystemExit("empty image prompt")
    outdir = Path(args.outdir)
    status_file = Path(args.status_file) if args.status_file else None
    outdir.mkdir(parents=True, exist_ok=True)
    if args.action == "edit" and (not args.input or any(not Path(path).is_file() for path in args.input)):
        write_status(status_file, "error", "error", "The source image is unavailable.", 100)
        raise SystemExit("edit action requires an existing --input image")
    if os.environ.get("DSTUDIO_IMAGE_TEST_MODE") == "1":
        write_status(status_file, "running", "inference", f"Running image {args.action} (test mode)…", 75)
        output = outdir / "generated-test.png"
        mock_png(output)
        write_status(status_file, "complete", "complete", "Image ready.", 100)
        print(output.resolve())
        return 0

    write_status(status_file, "running", "preparing", "Preparing the local Qwen Image runtime…", 5)
    from qwen_image_mps.cli import edit_image, generate_image
    write_status(
        status_file,
        "running",
        "model",
        "Downloading or loading Qwen Image Edit model weights…" if args.action == "edit"
        else "Downloading or loading Qwen Image model weights…",
        12,
    )
    ns = SimpleNamespace(
        prompt=prompt, negative_prompt=None, steps=50, fast=False,
        ultra_fast=True, seed=None, num_images=1, aspect=args.aspect,
        lora=None, cfg_scale=None, output_dir=str(outdir), output_path=None,
        batman=False, quantization=None, event_callback=None,
    )
    if args.action == "edit":
        edit_ns = SimpleNamespace(
            prompt=(
                "Use input image 1 as the base image and preserve its subject, body, pose, and composition. "
                "Use input image 2 only as the face and identity reference. " + prompt
                if len(args.input) > 1 else prompt
            ),
            negative_prompt=None, steps=50, fast=False,
            ultra_fast=True, seed=None, input=args.input, output=None,
            output_dir=str(outdir), anime=False, lora=None, cfg_scale=None,
            batman=False, quantization=None,
        )
        write_status(status_file, "running", "model", "Loading Qwen Image Edit and the source image…", 12)
        progress_stop = threading.Event()
        progress_thread = threading.Thread(
            target=report_edit_model_progress,
            args=(status_file, progress_stop),
            name="qwen-edit-progress",
            daemon=True,
        )
        progress_thread.start()
        try:
            saved_path = edit_image(edit_ns)
        finally:
            progress_stop.set()
            progress_thread.join(timeout=2)
        if not saved_path or not Path(saved_path).is_file():
            write_status(status_file, "error", "error", "Qwen Image Edit returned no output.", 100)
            raise SystemExit("Qwen Image Edit returned no output")
        if args.preserve == "face":
            write_status(status_file, "running", "compositing", "Preserving the original face pixels…", 94)
            preserved = preserve_original_face(args.input[-1], saved_path)
            label = "Edited image ready; original face pixels preserved." if preserved else "Edited image ready; no source face was detected to preserve."
        else:
            label = "Edited image ready."
        write_status(status_file, "complete", "complete", label, 100)
        print(saved_path)
        return 0
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
