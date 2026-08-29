#!/usr/bin/env python3
"""Route image work with Qwen3.8-27B Q8 Max, without a smaller fallback.

Qwen first makes the authoritative edit-vs-generate decision. For a generation
it then writes Ideogram 4's official structured caption while the same Q8 model
is still resident. The process exits before the selected image model starts.
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
from pathlib import Path
import re
import sys
import threading
import time


MODEL_ID = "mlx-community/Qwen3.8-27B-8bit"
MODEL_REVISION = "815b83c0df8ffd1d1b5244cf75fd6ef14fca9ef9"
MAX_IMAGES = 4
SUPPORTED_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
FENCE_RE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.I | re.S)

ROUTER_SYSTEM = """You are the sole authoritative router for a local image pipeline.
Decide whether the user's requested result is an EDIT of supplied source imagery or a NEW GENERATION.

Choose edit when the requested output depends on changing, preserving, extending, restoring, recoloring, restyling, combining, or replacing something in one or more attached source images. Choose generate when the user asks for a wholly new image that does not depend on source pixels. A source image can be present merely as conversational context; judge the actual instruction. With no source image, generate is the only valid choice.

Return exactly one minified JSON object and nothing else, with keys in this order:
{"mode":"edit","reason":"one concise factual sentence"}
or
{"mode":"generate","reason":"one concise factual sentence"}
Never choose based on model availability. Never add markdown."""


class RouteError(RuntimeError):
    pass


def atomic_write_text(path: Path, value: str, encoding: str = "utf-8") -> None:
    """Durably replace one diagnostic/output file without exposing partial text."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(
        f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    temporary.write_text(value, encoding=encoding)
    os.replace(temporary, path)


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
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False))


class InferenceHeartbeat:
    """Report uncapped Qwen liveness without adding a token or time budget."""

    def __init__(self, status_path: Path | None, stage: str, label: str,
                 progress: int, interval_seconds: float = 30.0, **extra: object):
        self.status_path = status_path
        self.stage = stage
        self.label = label
        self.progress = progress
        self.interval_seconds = interval_seconds
        self.extra = extra
        self.started = time.monotonic()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(
            target=self._run,
            name=f"qwen38-route-{stage}-heartbeat",
            daemon=True,
        )

    def _run(self) -> None:
        while not self.stop_event.wait(self.interval_seconds):
            elapsed = int(time.monotonic() - self.started)
            minutes, seconds = divmod(elapsed, 60)
            status_write(
                self.status_path,
                "running",
                self.stage,
                f"{self.label} · {minutes:02d}:{seconds:02d} elapsed…",
                self.progress,
                elapsedSeconds=elapsed,
                workerPid=os.getpid(),
                heartbeat=True,
                **self.extra,
            )

    def __enter__(self):
        if self.status_path is not None:
            self.thread.start()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.stop_event.set()
        if self.thread.is_alive():
            self.thread.join(timeout=max(1.0, self.interval_seconds + 1.0))


def pinned_snapshot() -> str:
    from huggingface_hub import snapshot_download
    return snapshot_download(repo_id=MODEL_ID, revision=MODEL_REVISION, local_files_only=True)


def final_text(text: str) -> str:
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1]
    text = text.strip()
    fenced = FENCE_RE.match(text)
    return fenced.group(1).strip() if fenced else text


def parse_object(text: str, label: str) -> dict:
    def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict:
        value: dict[str, object] = {}
        for key, item in pairs:
            if key in value:
                raise RouteError(f"Qwen3.8 {label} repeats JSON key {key!r}")
            value[key] = item
        return value

    try:
        value = json.loads(final_text(text), object_pairs_hook=reject_duplicate_keys)
    except json.JSONDecodeError as exc:
        raise RouteError(f"Qwen3.8 returned invalid {label} JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise RouteError(f"Qwen3.8 {label} must be a JSON object")
    return value


def canonical_exact_object(value: dict, required: tuple[str, ...], label: str) -> dict:
    """Validate membership and return a stable order for a JSON object.

    JSON object order is not semantic. Missing and unexpected fields still
    fail closed; only their serialization order is normalized for the selected
    downstream provider.
    """

    missing = [key for key in required if key not in value]
    unexpected = [key for key in value if key not in required]
    if missing or unexpected:
        details: list[str] = []
        if missing:
            details.append("missing " + ", ".join(repr(key) for key in missing))
        if unexpected:
            details.append("unexpected " + ", ".join(repr(key) for key in unexpected))
        raise RouteError(f"Qwen3.8 {label} has an invalid schema ({'; '.join(details)})")
    return {key: value[key] for key in required}


def canonical_caption(value: dict, expected_aspect: str) -> dict:
    caption = canonical_exact_object(
        value,
        ("aspect_ratio", "high_level_description", "compositional_deconstruction"),
        "Ideogram caption",
    )
    if caption["aspect_ratio"] != expected_aspect:
        raise RouteError("Qwen3.8 Ideogram caption changed the requested aspect ratio")
    description = caption["high_level_description"]
    if not isinstance(description, str) or not description.strip():
        raise RouteError("Qwen3.8 Ideogram caption has an invalid high-level description")
    composition = caption["compositional_deconstruction"]
    if not isinstance(composition, dict):
        raise RouteError("Qwen3.8 Ideogram caption compositional deconstruction must be an object")
    composition = canonical_exact_object(
        composition, ("background", "elements"),
        "Ideogram caption compositional deconstruction",
    )
    if not isinstance(composition["background"], str) or not composition["background"].strip():
        raise RouteError("Qwen3.8 Ideogram caption background must be a non-empty string")
    elements = composition["elements"]
    if not isinstance(elements, list):
        raise RouteError("Qwen3.8 Ideogram caption elements must be an array")

    canonical_elements: list[dict] = []
    for index, element in enumerate(elements):
        label = f"Ideogram caption element {index}"
        if not isinstance(element, dict):
            raise RouteError(f"Qwen3.8 {label} must be an object")
        kind = element.get("type")
        if kind == "obj":
            required = ("type", "desc")
            allowed_order = ("type", "bbox", "desc", "color_palette")
        elif kind == "text":
            required = ("type", "text", "desc")
            allowed_order = ("type", "bbox", "text", "desc", "color_palette")
        else:
            raise RouteError(f"Qwen3.8 {label} has invalid type {kind!r}")
        missing = [key for key in required if key not in element]
        unexpected = [key for key in element if key not in allowed_order]
        if missing or unexpected:
            details: list[str] = []
            if missing:
                details.append("missing " + ", ".join(repr(key) for key in missing))
            if unexpected:
                details.append("unexpected " + ", ".join(repr(key) for key in unexpected))
            raise RouteError(f"Qwen3.8 {label} has an invalid schema ({'; '.join(details)})")
        if not isinstance(element["desc"], str) or not element["desc"].strip():
            raise RouteError(f"Qwen3.8 {label} description must be a non-empty string")
        if kind == "text" and not isinstance(element["text"], str):
            raise RouteError(f"Qwen3.8 {label} text must be a string")
        canonical_elements.append({
            key: element[key] for key in allowed_order if key in element
        })

    caption["high_level_description"] = description.strip()
    caption["compositional_deconstruction"] = {
        "background": composition["background"].strip(),
        "elements": canonical_elements,
    }
    return caption


def preserve_model_response(route_path: Path, stage: str, text: str) -> Path:
    """Keep the exact local response so a failed schema check is diagnosable."""

    path = route_path.parent / f"qwen-{stage}-response.txt"
    atomic_write_text(path, text if text.endswith("\n") else text + "\n")
    return path


def caption_prompt_file() -> Path:
    root = Path(os.environ.get("DSTUDIO_IDEOGRAM4_HOME", Path.home() / ".dstudio/ideogram4"))
    matches = sorted((root / "venv" / "lib").glob(
        "python*/site-packages/ideogram4/magic_prompt_system_prompts/v1.txt"
    ))
    if len(matches) != 1 or not matches[0].is_file():
        raise RouteError("Pinned Ideogram 4 caption specification is unavailable")
    return matches[0]


def caption_messages(prompt: str, aspect: str) -> list[dict[str, str]]:
    raw = caption_prompt_file().read_text(encoding="utf-8")
    sections: dict[str, str] = {}
    current: str | None = None
    lines: list[str] = []
    for line in raw.splitlines():
        marker = line.strip()
        if marker.startswith("[") and marker.endswith("]") and " " not in marker:
            if current is not None:
                sections[current] = "\n".join(lines).strip()
            current = marker[1:-1].lower()
            lines = []
        else:
            lines.append(line)
    if current is not None:
        sections[current] = "\n".join(lines).strip()
    if "system" not in sections:
        raise RouteError("Pinned Ideogram caption specification has no system section")
    user_template = sections.get(
        "user", "TARGET IMAGE ASPECT RATIO: {{aspect_ratio}} (width:height).\nUser idea: {{original_prompt}}"
    )
    user = user_template.replace("{{aspect_ratio}}", aspect).replace("{{original_prompt}}", prompt)
    return [
        {"role": "system", "content": sections["system"]},
        {"role": "user", "content": user},
    ]


def validate_inputs(paths: list[str]) -> list[str]:
    if len(paths) > MAX_IMAGES:
        raise RouteError(f"at most {MAX_IMAGES} source images are supported")
    resolved: list[str] = []
    for raw in paths:
        path = Path(raw).expanduser().resolve()
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_SUFFIXES:
            raise RouteError(f"unsupported or missing source image: {path}")
        if path.stat().st_size <= 0 or path.stat().st_size > 64 * 1024 * 1024:
            raise RouteError(f"source image is empty or exceeds 64 MiB: {path.name}")
        resolved.append(str(path))
    return resolved


def native_context(config: dict | object) -> int:
    text_config = config.get("text_config", config) if isinstance(config, dict) else config.text_config
    return int(
        text_config.get("max_position_embeddings", 262144)
        if isinstance(text_config, dict)
        else getattr(text_config, "max_position_embeddings", 262144)
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--route-file", required=True)
    parser.add_argument("--status-file")
    parser.add_argument("--aspect", default="16:9")
    parser.add_argument("--reasoning-effort", choices=("off", "high", "max"), default="max")
    parser.add_argument("--input", action="append", default=[])
    args = parser.parse_args()

    prompt_path = Path(args.prompt_file).resolve()
    route_path = Path(args.route_file).resolve()
    status_path = Path(args.status_file).resolve() if args.status_file else None
    started = time.monotonic()
    runtime_root = Path(os.environ.get(
        "DSTUDIO_QWEN38_VISION_HOME", Path.home() / ".dstudio/qwen38-vision"
    ))
    pid_file = runtime_root / ".image-router.pid"
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(f"{os.getpid()}\n", encoding="ascii")

    def remove_pid() -> None:
        try:
            if pid_file.read_text(encoding="ascii").strip() == str(os.getpid()):
                pid_file.unlink(missing_ok=True)
        except OSError:
            pass

    atexit.register(remove_pid)
    try:
        prompt = prompt_path.read_text(encoding="utf-8").strip()
        if not prompt:
            raise RouteError("image request is empty")
        image_paths = validate_inputs(args.input)
        reasoning_label = "Max" if args.reasoning_effort == "max" else args.reasoning_effort.capitalize()
        if os.environ.get("DSTUDIO_IMAGE_ROUTE_TEST_MODE") == "1":
            mode = os.environ.get("DSTUDIO_IMAGE_ROUTE_TEST_RESULT", "edit" if image_paths else "generate")
            if mode not in {"edit", "generate"}:
                raise RouteError("invalid test route")
            result: dict[str, object] = {"mode": mode, "reason": "deterministic route fixture"}
            if mode == "generate":
                result["caption"] = {
                    "aspect_ratio": args.aspect,
                    "high_level_description": prompt,
                    "compositional_deconstruction": {"background": "plain backdrop", "elements": []},
                }
            route_path.parent.mkdir(parents=True, exist_ok=True)
            route_path.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
            (route_path.parent / "image-route-provenance.json").write_text(
                json.dumps({
                    "router": MODEL_ID,
                    "revision": MODEL_REVISION,
                    "reasoning": args.reasoning_effort,
                    "decision": mode,
                    "sourceImages": [Path(value).name for value in image_paths],
                    "testMode": True,
                    "elapsedSeconds": round(time.monotonic() - started, 3),
                }, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            print(json.dumps(result, ensure_ascii=False), flush=True)
            return 0

        from mlx_vlm import generate, load
        from mlx_vlm.prompt_utils import apply_chat_template
        from mlx_vlm.utils import load_config

        status_write(status_path, "running", "routing",
                     f"Qwen3.8-27B {reasoning_label} is deciding whether to edit or generate…", 5,
                     router="qwen3.8-27b-q8", reasoning=args.reasoning_effort)
        snapshot = pinned_snapshot()
        model, processor = load(snapshot, lazy=False, strict=True)
        config = load_config(snapshot)
        context_limit = native_context(config)
        thinking = args.reasoning_effort != "off"
        generation = {
            # mlx-vlm requires a numeric loop boundary. This is only Qwen's
            # native context ceiling, never a DStudio output/thinking budget.
            "max_tokens": context_limit,
            "temperature": 1.0 if thinking else 0.7,
            "top_p": 0.95 if thinking else 0.80,
            "top_k": 20,
            "min_p": 0.0,
            "presence_penalty": 0.0 if thinking else 1.5,
            "repetition_penalty": 1.0,
            "seed": 0,
            "enable_thinking": thinking,
            "verbose": False,
        }
        # Max never gets a DStudio thinking budget. High is the explicit
        # user-selectable bounded profile; Off disables hidden reasoning.
        if args.reasoning_effort == "high":
            generation["thinking_budget"] = 4096
        route_messages = [
            {"role": "system", "content": ROUTER_SYSTEM},
            {"role": "user", "content": prompt},
        ]
        formatted = apply_chat_template(
            processor, config, route_messages, num_images=len(image_paths), enable_thinking=thinking,
        )
        route_label = (
            f"Qwen3.8-27B {reasoning_label} is deciding whether to edit or generate"
        )
        with InferenceHeartbeat(
            status_path,
            "routing",
            route_label,
            5,
            router="qwen3.8-27b-q8",
            reasoning=args.reasoning_effort,
            nativeContext=context_limit,
        ):
            decision_result = generate(
                model, processor, formatted, image=image_paths, **generation
            )
        response_artifacts = {
            "routing": preserve_model_response(
                route_path, "routing", decision_result.text
            ).name,
        }
        decision = parse_object(decision_result.text, "routing decision")
        decision = canonical_exact_object(
            decision, ("mode", "reason"), "routing decision"
        )
        mode = decision["mode"]
        reason = decision["reason"]
        if mode not in {"edit", "generate"} or not isinstance(reason, str) or not reason.strip():
            raise RouteError("Qwen3.8 routing decision has invalid values")
        if mode == "edit" and not image_paths:
            raise RouteError("Qwen3.8 selected editing without a source image")

        output: dict[str, object] = {"mode": mode, "reason": reason.strip()}
        if mode == "generate":
            status_write(status_path, "running", "captioning",
                         f"Qwen3.8-27B {reasoning_label} is writing Ideogram 4's structured caption…", 12,
                         router="qwen3.8-27b-q8", reasoning=args.reasoning_effort)
            messages = caption_messages(prompt, args.aspect)
            formatted_caption = apply_chat_template(
                processor, config, messages, num_images=0, enable_thinking=thinking,
            )
            caption_label = (
                f"Qwen3.8-27B {reasoning_label} is writing Ideogram 4's structured caption"
            )
            with InferenceHeartbeat(
                status_path,
                "captioning",
                caption_label,
                12,
                router="qwen3.8-27b-q8",
                reasoning=args.reasoning_effort,
                nativeContext=context_limit,
            ):
                caption_result = generate(
                    model, processor, formatted_caption, image=[], **generation
                )
            response_artifacts["caption"] = preserve_model_response(
                route_path, "caption", caption_result.text
            ).name
            caption = parse_object(caption_result.text, "Ideogram caption")
            caption = canonical_caption(caption, args.aspect)
            output["caption"] = caption

        route_path.parent.mkdir(parents=True, exist_ok=True)
        route_path.write_text(
            json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        (route_path.parent / "image-route-provenance.json").write_text(
            json.dumps({
                "router": MODEL_ID,
                "revision": MODEL_REVISION,
                "reasoning": args.reasoning_effort,
                "thinkingEnabled": thinking,
                "thinkingBudget": 4096 if args.reasoning_effort == "high" else None,
                "nativeContext": context_limit,
                "decision": mode,
                "reason": reason.strip(),
                "sourceImages": [Path(value).name for value in image_paths],
                "wroteIdeogramCaption": mode == "generate",
                "responseArtifacts": response_artifacts,
                "elapsedSeconds": round(time.monotonic() - started, 3),
            }, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        selected_label = "HunyuanImage editing" if mode == "edit" else "Ideogram generation"
        status_write(status_path, "running", "unloading_router",
                     f"Qwen3.8 chose {selected_label}; releasing the router before image inference…", 16,
                     route=mode, reasoning=args.reasoning_effort)
        print(json.dumps(output, ensure_ascii=False), flush=True)
        remove_pid()
        sys.stdout.flush()
        sys.stderr.flush()
        # MLX 0.32.1 may fault during CompileCache TLS destruction after a
        # successful run. Inference and durable route output are complete.
        os._exit(0)
    except (OSError, RouteError, ValueError, json.JSONDecodeError) as exc:
        status_write(status_path, "error", "routing_error", str(exc), 100)
        print(f"Qwen3.8 image routing failed: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:
        status_write(status_path, "error", "routing_error", f"Qwen3.8 routing failed: {exc}", 100)
        print(f"Qwen3.8 image routing failed: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
