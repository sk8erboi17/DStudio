#!/usr/bin/env python3
"""One-shot Qwen3.8-27B Q8 vision inference for DStudio.

Input is the OpenAI-shaped JSON body assembled by dstudio_vision.c.  The model
is resolved only from the pinned local Hugging Face snapshot, loaded once,
used for the complete multi-image request, and then released by process exit.
"""

from __future__ import annotations

import argparse
import atexit
import base64
import binascii
import json
import os
from pathlib import Path
import re
import sys
import tempfile


MODEL_ID = "mlx-community/Qwen3.8-27B-8bit"
MODEL_REVISION = "815b83c0df8ffd1d1b5244cf75fd6ef14fca9ef9"
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 64 * 1024 * 1024
DATA_URI = re.compile(r"^data:(image/(?:png|jpeg|webp|gif|bmp));base64,(.+)$", re.I | re.S)


def fail(message: str, code: int = 2) -> int:
    print(json.dumps({"error": message}, ensure_ascii=False), flush=True)
    return code


def pinned_snapshot() -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(
        repo_id=MODEL_ID,
        revision=MODEL_REVISION,
        local_files_only=True,
    )


def request_parts(body: dict) -> tuple[str, list[str], str]:
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("request has no messages")
    text_parts: list[str] = []
    images: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str):
            text_parts.append(content)
            continue
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                text_parts.append(part["text"])
            elif part.get("type") == "image_url":
                image_url = part.get("image_url")
                url = image_url.get("url") if isinstance(image_url, dict) else None
                if isinstance(url, str):
                    images.append(url)
    if not text_parts:
        raise ValueError("request has no text prompt")
    if not 1 <= len(images) <= MAX_IMAGES:
        raise ValueError(f"request must contain 1-{MAX_IMAGES} images")
    reasoning_effort = str(body.get("reasoning_effort", "max")).lower()
    if reasoning_effort not in {"off", "high", "max"}:
        raise ValueError("reasoning_effort must be off, high or max")
    return "\n\n".join(text_parts), images, reasoning_effort


def write_images(urls: list[str], directory: Path) -> list[str]:
    paths: list[str] = []
    extensions = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/bmp": ".bmp",
    }
    for index, url in enumerate(urls, 1):
        match = DATA_URI.match(url)
        if not match:
            raise ValueError("vision accepts inline image data only")
        encoded = match.group(2)
        if len(encoded) > (MAX_IMAGE_BYTES * 4 // 3) + 8:
            raise ValueError("image exceeds the 64 MiB limit")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("invalid base64 image") from exc
        if not raw or len(raw) > MAX_IMAGE_BYTES:
            raise ValueError("image is empty or exceeds the 64 MiB limit")
        path = directory / f"image-{index}{extensions[match.group(1).lower()]}"
        path.write_bytes(raw)
        paths.append(str(path))
    return paths


def final_text(text: str) -> str:
    # Downstream tools need the answer, never a private scratchpad. Keep this
    # defensive strip for requests produced by older runtimes.
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1]
    return text.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    runtime_root = Path(os.environ.get("DSTUDIO_QWEN38_VISION_HOME", Path.home() / ".dstudio/qwen38-vision"))
    runtime_root.mkdir(parents=True, exist_ok=True)
    pid_file = runtime_root / ".runner.pid"
    pid_file.write_text(f"{os.getpid()}\n", encoding="ascii")

    def remove_pid() -> None:
        try:
            if pid_file.read_text(encoding="ascii").strip() == str(os.getpid()):
                pid_file.unlink(missing_ok=True)
        except OSError:
            pass

    atexit.register(remove_pid)
    try:
        body = json.loads(Path(args.request).read_text(encoding="utf-8"))
        if not isinstance(body, dict):
            raise ValueError("request must be a JSON object")
        prompt, image_urls, reasoning_effort = request_parts(body)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return fail(str(exc))

    if os.environ.get("DSTUDIO_VISION_TEST_MODE") == "1":
        fixture = os.environ.get(
            "DSTUDIO_VISION_TEST_TEXT",
            "Qwen3.8 vision test fixture: images are readable and the layout is intact.",
        )
        print(json.dumps({
            "choices": [{"message": {"content": fixture}, "finish_reason": "stop"}],
            "model": MODEL_ID,
            "peak_memory_gb": 0,
        }, ensure_ascii=False), flush=True)
        return 0

    try:
        from mlx_vlm import generate, load
        from mlx_vlm.prompt_utils import apply_chat_template
        from mlx_vlm.utils import load_config

        snapshot = pinned_snapshot()
        with tempfile.TemporaryDirectory(prefix="dstudio-qwen38-") as temp:
            image_paths = write_images(image_urls, Path(temp))
            model, processor = load(snapshot, lazy=False, strict=True)
            config = load_config(snapshot)
            thinking = reasoning_effort != "off"
            formatted = apply_chat_template(
                processor,
                config,
                prompt,
                num_images=len(image_paths),
                enable_thinking=thinking,
            )
            # Qwen3.8 Max is the official xhigh-style path: thinking remains
            # unbudgeted and generation stops on the model's own EOS. mlx-vlm
            # needs a numeric loop boundary, so use only the model's native
            # 262,144-token context ceiling—not a DStudio output limit.
            text_config = config.get("text_config", config) if isinstance(config, dict) else config.text_config
            native_context = int(
                text_config.get("max_position_embeddings", 262144)
                if isinstance(text_config, dict)
                else getattr(text_config, "max_position_embeddings", 262144)
            )
            generation = dict(
                image=image_paths,
                verbose=False,
                max_tokens=native_context,
                temperature=1.0 if thinking else 0.7,
                top_p=0.95 if thinking else 0.80,
                top_k=20,
                min_p=0.0,
                presence_penalty=0.0 if thinking else 1.5,
                repetition_penalty=1.0,
                seed=0,
                enable_thinking=thinking,
            )
            # The optional High profile is intentionally the only bounded
            # reasoning choice. Max never supplies thinking_budget.
            if reasoning_effort == "high":
                generation["thinking_budget"] = 4096
            result = generate(model, processor, formatted, **generation)
        text = final_text(result.text)
        if not text:
            return fail("Qwen3.8 returned no final answer", 3)
        finish_reason = str(getattr(result, "finish_reason", None) or "stop")
        print(json.dumps({
            "choices": [{"message": {"content": text}, "finish_reason": finish_reason}],
            "model": MODEL_ID,
            "peak_memory_gb": getattr(result, "peak_memory", None),
        }, ensure_ascii=False), flush=True)
        # mlx 0.32.1 can segfault in CompileCache TLS destruction after a
        # successful one-shot run on macOS 26. The answer is already complete;
        # bypass only that buggy interpreter teardown (not inference), while
        # removing the status marker explicitly. Process exit also releases
        # the kernel-held heavyweight lock and every Metal allocation.
        remove_pid()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)
    except Exception as exc:  # surfaced to the C endpoint as a structured failure
        return fail(f"Qwen3.8 vision failed: {exc}", 3)


if __name__ == "__main__":
    raise SystemExit(main())
