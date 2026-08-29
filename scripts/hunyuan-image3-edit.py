#!/usr/bin/env python3
"""Phased HunyuanImage-3.0-Instruct NF4 full-quality image editor."""

from __future__ import annotations

import argparse
import atexit
import hashlib
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import re
import struct
import sys
import threading
import time
import traceback
import types
import zlib


MODEL_ID = "EricRollei/HunyuanImage-3.0-Instruct-NF4-v2"
MODEL_REVISION = "98fda5c508c05f5407f036bca413149ca92c143b"
BASE_MODEL_ID = "tencent/HunyuanImage-3.0-Instruct"
BASE_MODEL_REVISION = "2ec2c78bee7d4b94157341fba86c4c2c7b1858b2"
QUANTIZATION = "NF4-v2 full Instruct; critical attention/VAE/embedding layers retained in BF16"
MAX_IMAGES = 4
QUALITY_STEPS = 50
REQUIRED_BF16_SKIP_MODULES = frozenset({
    "vae", "vision_model", "vision_aligner", "patch_embed", "final_layer",
    "time_embed", "attn.q_proj", "attn.k_proj", "attn.v_proj", "attn.o_proj",
    "self_attn", "cross_attn", "shared_mlp", "lm_head", "model.wte",
})


def build_test_png(width: int = 640, height: int = 360) -> bytes:
    """Create a deterministic edited frame distinct from the generator fixture."""
    scanlines = bytearray()
    for y in range(height):
        scanlines.append(0)
        for x in range(width):
            concrete = 52 + ((x * 3 + y * 7) % 24)
            r = g = b = concrete
            # The edited fixture keeps the broad subject geometry but adds a
            # cleaner machined highlight and a narrower corrected signal part.
            if width // 5 < x < width * 4 // 5 and height // 5 < y < height * 4 // 5:
                metal = 124 + ((x * 11 + y * 5) % 84)
                r, g, b = metal, min(255, metal + 7), min(255, metal + 11)
            if width * 13 // 20 < x < width * 27 // 40 and height // 3 < y < height * 3 // 4:
                r, g, b = 205, 34, 38
            if width * 9 // 20 < x < width * 11 // 20 and height * 9 // 20 < y < height * 11 // 20:
                r, g, b = 224, 228, 230
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


def test_fixture_size(input_path: str) -> tuple[int, int]:
    """Preserve PNG source geometry in test mode without loading image libraries."""
    try:
        header = Path(input_path).read_bytes()[:24]
    except OSError:
        return 640, 360
    if len(header) >= 24 and header[:8] == b"\x89PNG\r\n\x1a\n" and header[12:16] == b"IHDR":
        width, height = struct.unpack(">II", header[16:24])
        if 1 <= width <= 4096 and 1 <= height <= 4096:
            return width, height
    return 640, 360
MPS_ALLOCATOR_WARMUP_POLICY = (
    "Transformers 4.57.1 with the upstream MPS warm-up skip backported at install; "
    "no runtime monkeypatch"
)
VISION_INPUT_DEVICE_POLICY = (
    "pinned Tencent model source co-locates SigLIP auxiliary tensors with pixels"
)
NATIVE_MOE_POLICY = (
    "Tencent official DeepSeek eager MoE; no DStudio numerical forward override"
)
PHASE_CACHE_POLICY = (
    "release completed reasoning KV cache before allocating diffusion inputs on MPS"
)
FINITE_GUARD_POLICY = "fail immediately on non-finite diffusion latents or VAE output"
TORCH_VERSION = "2.15.0.dev20260821"
TORCH_GIT_REVISION = "cef373b344057d8ed91bcf05d7921b2ca1d0d13c"
TORCHVISION_VERSION = "0.30.0.dev20260825"
TRANSFORMERS_VERSION = "4.57.1"
MPS_RUNTIME_POLICY = (
    "pinned post-2026-06-23 PyTorch MPS runtime with native SDPA, the upstream "
    "Transformers MPS warm-up skip in source, and Tencent official eager MoE"
)
RESUMED_REASONING_POLICY = (
    "reuse a complete hashed Max think/recaption transcript in a fresh diffusion process"
)


class EditError(RuntimeError):
    pass


class ReasoningCaptured(RuntimeError):
    def __init__(self, reasoning: str, image_size: tuple[int, int]):
        super().__init__("maximum-depth reasoning captured")
        self.reasoning = reasoning
        self.image_size = image_size


def expected_mps_runtime_profile() -> dict[str, object]:
    """Return the exact native runtime proven by the real multimodal probe."""
    return {
        "policy": MPS_RUNTIME_POLICY,
        "torch": TORCH_VERSION,
        "torchGitRevision": TORCH_GIT_REVISION,
        "torchvision": TORCHVISION_VERSION,
        "transformers": TRANSFORMERS_VERSION,
        "nativeSdpa": True,
        "sourceMpsAllocatorWarmupSkip": True,
        "runtimeMonkeypatch": False,
        "officialEagerMoe": True,
        "customAttentionKernel": False,
        "customMoeKernel": False,
        "officialModelCodeRevision": BASE_MODEL_REVISION,
    }


def validate_mps_runtime(torch) -> dict[str, object]:
    """Fail closed rather than running on an allocator-corrupt MPS build."""
    import transformers.modeling_utils as modeling_utils

    warmup_source = inspect.getsource(modeling_utils.caching_allocator_warmup)
    native_mps_warmup = (
        'elif device.type == "mps"' in warmup_source
        and "continue" in warmup_source[warmup_source.index('elif device.type == "mps"'):]
    )
    actual = {
        "policy": MPS_RUNTIME_POLICY,
        "torch": str(torch.__version__).split("+", 1)[0],
        "torchGitRevision": str(torch.version.git_version or ""),
        "torchvision": importlib.metadata.version("torchvision").split("+", 1)[0],
        "transformers": importlib.metadata.version("transformers").split("+", 1)[0],
        "nativeSdpa": True,
        "sourceMpsAllocatorWarmupSkip": native_mps_warmup,
        "runtimeMonkeypatch": False,
        "officialEagerMoe": True,
        "customAttentionKernel": False,
        "customMoeKernel": False,
        "officialModelCodeRevision": BASE_MODEL_REVISION,
    }
    expected = expected_mps_runtime_profile()
    if actual != expected:
        differences = [
            f"{key}={actual.get(key)!r} (expected {value!r})"
            for key, value in expected.items()
            if actual.get(key) != value
        ]
        raise EditError("Hunyuan MPS runtime is not the validated build: " + "; ".join(differences))
    return actual


def validate_native_model_runtime(model) -> int:
    """Require the pinned Tencent eager MoE and source-level vision fix.

    This validator never replaces model methods.  It rejects stale checkpoint
    code or instance-level forward overrides so production cannot silently
    fall back to a DStudio numerical implementation.
    """
    if getattr(model.config, "moe_impl", None) != "eager":
        raise EditError("Hunyuan model is not using Tencent's official eager MoE")
    moe_layers = [module for module in model.modules() if type(module).__name__ == "HunyuanMoE"]
    if len(moe_layers) != int(model.config.num_hidden_layers):
        raise EditError(
            f"Hunyuan official MoE layer count mismatch: {len(moe_layers)} "
            f"(expected {model.config.num_hidden_layers})"
        )
    for module in moe_layers:
        if getattr(module.forward, "__func__", None) is not type(module).forward:
            raise EditError("Hunyuan MoE forward has an instance-level override")
    moe_source = inspect.getsource(type(moe_layers[0]).forward)
    if "DeepSeekMoE implementation" not in moe_source or "repeat_interleave" not in moe_source:
        raise EditError("Hunyuan checkpoint is missing Tencent's official eager MoE")
    vision_source = inspect.getsource(type(model)._forward_vision_encoder)
    if "value.to(device=images.device)" not in vision_source:
        raise EditError("Hunyuan checkpoint is missing the source-level vision device fix")
    return len(moe_layers)


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
    temporary = path.with_name(
        f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


class ReasoningHeartbeat:
    """Expose liveness for uncapped reasoning without imposing any deadline."""

    def __init__(self, status_path: Path | None, native_context: int,
                 interval_seconds: float = 30.0):
        self.status_path = status_path
        self.native_context = native_context
        self.interval_seconds = interval_seconds
        self.started = time.monotonic()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(
            target=self._run,
            name="hunyuan-reasoning-heartbeat",
            daemon=True,
        )

    def _run(self) -> None:
        while not self.stop_event.wait(self.interval_seconds):
            elapsed = int(time.monotonic() - self.started)
            minutes, seconds = divmod(elapsed, 60)
            status_write(
                self.status_path,
                "running",
                "reasoning",
                f"HunyuanImage Max reasoning active · {minutes:02d}:{seconds:02d} elapsed…",
                24,
                reasoning="think_recaption",
                quality="full-50",
                nativeContext=self.native_context,
                elapsedSeconds=elapsed,
                workerPid=os.getpid(),
                heartbeat=True,
            )

    def __enter__(self):
        if self.status_path is not None:
            self.thread.start()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.stop_event.set()
        if self.thread.is_alive():
            self.thread.join(timeout=max(1.0, self.interval_seconds + 1.0))


def runtime_root() -> Path:
    configured = os.environ.get("DSTUDIO_HUNYUAN_IMAGE3_HOME", "").strip()
    return Path(configured).expanduser().resolve() if configured else (
        Path.home() / ".dstudio" / "hunyuan-image"
    ).resolve()


def validate_inputs(values: list[str]) -> list[str]:
    if not 1 <= len(values) <= MAX_IMAGES:
        raise EditError(f"editing requires 1-{MAX_IMAGES} source images")
    supported = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    result: list[str] = []
    for raw in values:
        path = Path(raw).expanduser().resolve()
        if not path.is_file() or path.suffix.lower() not in supported:
            raise EditError(f"unsupported or missing source image: {path}")
        if path.stat().st_size <= 0 or path.stat().st_size > 64 * 1024 * 1024:
            raise EditError(f"source image is empty or exceeds 64 MiB: {path.name}")
        result.append(str(path))
    return result


def load_completed_reasoning(path: Path) -> tuple[str, str]:
    """Load only a complete Max think/recaption transcript from a prior run log."""
    if not path.is_file():
        raise EditError(f"reasoning log is missing: {path}")
    text = path.read_text(encoding="utf-8")
    matches = re.findall(r"Assistant: (<think>.*?</recaption>)<answer>", text, flags=re.DOTALL)
    if not matches:
        raise EditError(f"reasoning log has no complete think/recaption block: {path.name}")
    reasoning = matches[-1]
    if not reasoning.startswith("<think>") or not reasoning.endswith("</recaption>"):
        raise EditError(f"reasoning transcript is incomplete: {path.name}")
    return reasoning, hashlib.sha256(reasoning.encode("utf-8")).hexdigest()


def parse_resume_image_size(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"([1-9][0-9]{2,3})x([1-9][0-9]{2,3})", value.strip())
    if not match:
        raise EditError("resume image size must be HEIGHTxWIDTH, for example 832x1216")
    height, width = (int(item) for item in match.groups())
    if min(height, width) < 256 or max(height, width) > 4096:
        raise EditError("resume image size is outside the supported 256-4096 range")
    return height, width


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_reasoning(value: object) -> str:
    if isinstance(value, list) and len(value) == 1:
        value = value[0]
    if not isinstance(value, str):
        raise EditError("Hunyuan returned no complete reasoning transcript")
    reasoning = value.strip()
    if not reasoning.startswith("<think>") or not reasoning.endswith("</recaption>"):
        raise EditError("Hunyuan returned an incomplete think/recaption transcript")
    return reasoning


def install_reasoning_capture(model) -> None:
    """Stop after Max reasoning, immediately before diffusion inputs are built."""
    upstream = model.prepare_model_inputs

    def capture_before_diffusion(self, *args, **kwargs):
        if kwargs.get("mode") == "gen_image":
            reasoning = normalize_reasoning(kwargs.get("cot_text"))
            image_size = kwargs.get("image_size")
            if not isinstance(image_size, (tuple, list)) or len(image_size) != 2:
                raise EditError("Hunyuan did not select a valid diffusion image size")
            height, width = (int(item) for item in image_size)
            raise ReasoningCaptured(reasoning, (height, width))
        return upstream(*args, **kwargs)

    model.prepare_model_inputs = types.MethodType(capture_before_diffusion, model)


def reasoning_binding(prompt_path: Path, input_paths: list[str], seed: int) -> dict[str, object]:
    return {
        "prompt": {
            "name": prompt_path.name,
            "sha256": file_sha256(prompt_path),
        },
        "sourceImages": [
            {"name": Path(value).name, "sha256": file_sha256(Path(value))}
            for value in input_paths
        ],
        "seed": seed,
    }


def write_reasoning_artifact(
    path: Path,
    reasoning: str,
    image_size: tuple[int, int],
    prompt_path: Path,
    input_paths: list[str],
    seed: int,
    native_context: int,
    elapsed_seconds: float,
    mps_runtime: dict[str, object] | None = None,
) -> str:
    reasoning_sha256 = hashlib.sha256(reasoning.encode("utf-8")).hexdigest()
    payload = {
        "schemaVersion": 4,
        "provider": "hunyuan-image3-instruct-nf4",
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "baseModel": BASE_MODEL_ID,
        "baseRevision": BASE_MODEL_REVISION,
        "quality": {
            "systemPrompt": "en_unified",
            "reasoning": "think_recaption",
            "maxNewTokens": None,
            "nativeContext": native_context,
            "mpsRuntime": dict(mps_runtime or expected_mps_runtime_profile()),
        },
        "binding": reasoning_binding(prompt_path, input_paths, seed),
        "reasoning": reasoning,
        "reasoningSha256": reasoning_sha256,
        "imageSize": {"height": image_size[0], "width": image_size[1]},
        "elapsedSeconds": round(elapsed_seconds, 3),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    return reasoning_sha256


def load_reasoning_artifact(
    path: Path,
    prompt_path: Path,
    input_paths: list[str],
    seed: int,
) -> tuple[str, str, tuple[int, int]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EditError(f"reasoning artifact is missing or invalid: {path}") from exc
    expected_identity = {
        "schemaVersion": 4,
        "provider": "hunyuan-image3-instruct-nf4",
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "baseModel": BASE_MODEL_ID,
        "baseRevision": BASE_MODEL_REVISION,
    }
    for key, expected in expected_identity.items():
        if payload.get(key) != expected:
            raise EditError(f"reasoning artifact {key} does not match the pinned runtime")
    quality = payload.get("quality")
    if not isinstance(quality, dict) or quality.get("reasoning") != "think_recaption" or \
            quality.get("maxNewTokens", "missing") is not None:
        raise EditError("reasoning artifact is not an uncapped think_recaption run")
    mps_runtime = quality.get("mpsRuntime") if isinstance(quality, dict) else None
    if mps_runtime != expected_mps_runtime_profile():
        raise EditError("reasoning artifact did not use the pinned native MPS runtime")
    if payload.get("binding") != reasoning_binding(prompt_path, input_paths, seed):
        raise EditError("reasoning artifact does not match the prompt, sources, or seed")
    reasoning = normalize_reasoning(payload.get("reasoning"))
    reasoning_sha256 = hashlib.sha256(reasoning.encode("utf-8")).hexdigest()
    if payload.get("reasoningSha256") != reasoning_sha256:
        raise EditError("reasoning artifact transcript hash mismatch")
    image_size = payload.get("imageSize")
    if not isinstance(image_size, dict):
        raise EditError("reasoning artifact has no selected image size")
    height = image_size.get("height")
    width = image_size.get("width")
    if not isinstance(height, int) or not isinstance(width, int):
        raise EditError("reasoning artifact image size is invalid")
    if min(height, width) < 256 or max(height, width) > 4096:
        raise EditError("reasoning artifact image size is outside the supported range")
    return reasoning, reasoning_sha256, (height, width)


def validate_checkpoint_quantization(model) -> list[str]:
    """Fail closed unless the pinned checkpoint retains its quality-critical BF16 path."""
    config = model.config.quantization_config

    def value(name: str):
        if isinstance(config, dict):
            return config.get(name)
        return getattr(config, name, None)

    compute_dtype = str(value("bnb_4bit_compute_dtype")).removeprefix("torch.")
    if (value("load_in_4bit") is not True or value("bnb_4bit_quant_type") != "nf4" or
            value("bnb_4bit_use_double_quant") is not True or compute_dtype != "bfloat16"):
        raise EditError("Hunyuan checkpoint quantization is not the pinned NF4/BF16 profile")
    protected = set(value("llm_int8_skip_modules") or ())
    missing = sorted(REQUIRED_BF16_SKIP_MODULES - protected)
    if missing:
        raise EditError(
            "Hunyuan checkpoint no longer protects critical BF16 modules: " + ", ".join(missing)
        )
    return sorted(REQUIRED_BF16_SKIP_MODULES)


def inspect_output(path: Path) -> dict[str, object]:
    """Reject corrupt or degenerate editor output before reporting success."""
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
        raise EditError(f"Hunyuan output is not a valid decodable image: {exc}") from exc
    if image_format != "PNG" or min(size) < 256 or max(size) > 4096:
        raise EditError(
            f"Hunyuan output metadata mismatch: format={image_format}, size={size}"
        )
    if (extrema[1] - extrema[0] < 8 or histogram_bins < 8 or
            (entropy < 0.5 and significant_fraction < 0.002)):
        raise EditError("Hunyuan output is visually degenerate (flat/blank image)")
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


class DiffusionProgress:
    def __init__(self, total: int, status_path: Path | None, reasoning: str,
                 native_context: int, reasoning_sha256: str | None):
        self.total = total
        self.current = 0
        self.status_path = status_path
        self.reasoning = reasoning
        self.native_context = native_context
        self.reasoning_sha256 = reasoning_sha256

    def metadata(self) -> dict[str, object]:
        return {
            "reasoning": self.reasoning,
            "reasoningSha256": self.reasoning_sha256,
            "nativeContext": self.native_context,
            "quality": "full-50",
        }

    def __enter__(self):
        status_write(self.status_path, "running", "sampling",
                     f"HunyuanImage full quality: diffusion step 0/{self.total}…", 30,
                     step=0, steps=self.total, **self.metadata())
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            status_write(self.status_path, "running", "decoding",
                         "Decoding the edited image at source-aligned resolution…", 93,
                         steps=self.total, **self.metadata())
        return False

    def update(self, amount: int = 1) -> None:
        self.current = min(self.total, self.current + amount)
        status_write(
            self.status_path, "running", "sampling",
            f"HunyuanImage full quality: diffusion step {self.current}/{self.total}…",
            30 + round(62 * self.current / max(1, self.total)),
            step=self.current, steps=self.total, **self.metadata(),
        )

    def set_description(self, *args, **kwargs) -> None:
        return None

    def close(self) -> None:
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--status-file")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--reasoning-log")
    parser.add_argument("--reasoning-file")
    parser.add_argument("--reasoning-output")
    parser.add_argument("--resume-image-size")
    parser.add_argument("inputs", nargs="*")
    args = parser.parse_args()

    prompt_path = Path(args.prompt_file).resolve()
    outdir = Path(args.outdir).resolve()
    status_path = Path(args.status_file).resolve() if args.status_file else None
    outdir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    root = runtime_root()
    pid_file = root / ".editor.pid"
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
            raise EditError("editing instruction is empty")
        input_paths = validate_inputs(args.inputs)
        reasoning_log = Path(args.reasoning_log).resolve() if args.reasoning_log else None
        reasoning_file = Path(args.reasoning_file).resolve() if args.reasoning_file else None
        reasoning_output = Path(args.reasoning_output).resolve() if args.reasoning_output else None
        if sum(value is not None for value in (reasoning_log, reasoning_file, reasoning_output)) > 1:
            raise EditError(
                "--reasoning-log, --reasoning-file, and --reasoning-output are mutually exclusive"
            )
        if bool(reasoning_log) != bool(args.resume_image_size):
            raise EditError("--reasoning-log and --resume-image-size must be supplied together")
        if reasoning_log is None and args.resume_image_size:
            raise EditError("--resume-image-size is valid only with --reasoning-log")
        resumed_reasoning = None
        resumed_reasoning_sha256 = None
        resumed_image_size = None
        resumed_reasoning_source = None
        if reasoning_log is not None:
            resumed_reasoning, resumed_reasoning_sha256 = load_completed_reasoning(reasoning_log)
            resumed_image_size = parse_resume_image_size(args.resume_image_size)
            resumed_reasoning_source = {"type": "diagnostic-log", "name": reasoning_log.name}
        elif reasoning_file is not None:
            resumed_reasoning, resumed_reasoning_sha256, resumed_image_size = load_reasoning_artifact(
                reasoning_file, prompt_path, input_paths, args.seed
            )
            resumed_reasoning_source = {"type": "bound-artifact", "name": reasoning_file.name}
        if os.environ.get("DSTUDIO_HUNYUAN_IMAGE3_TEST_MODE") == "1":
            destination = outdir / "hunyuan-image3-test.png"
            destination.write_bytes(build_test_png(*test_fixture_size(input_paths[0])))
            status_write(status_path, "complete", "complete", "Edited image ready.", 100,
                         provider="hunyuan-image3-instruct-nf4", quality="full-50")
            print(destination)
            return 0

        import torch
        from transformers import AutoModelForCausalLM

        if not torch.backends.mps.is_available():
            raise EditError("HunyuanImage-3.0-Instruct requires Apple Metal on this runtime")
        mps_runtime = validate_mps_runtime(torch)
        model_dir = root / "models" / "HunyuanImage-3-Instruct-NF4-v2"
        if not (model_dir / ".dstudio-inference-conformance-v4").is_file():
            raise EditError("HunyuanImage native inference-conformance source is missing")
        status_write(status_path, "running", "loading_editor",
                     "Loading full HunyuanImage-3.0-Instruct NF4 into Metal…", 18,
                     reasoning="think_recaption", quality="full-50")
        model = AutoModelForCausalLM.from_pretrained(
            str(model_dir),
            device_map={"": "mps"},
            trust_remote_code=True,
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
            low_cpu_mem_usage=True,
            moe_impl="eager",
        )
        bf16_protected = validate_checkpoint_quantization(model)
        if bool(model.config.moe_drop_tokens):
            raise EditError("Hunyuan checkpoint unexpectedly enables routed-token dropping")
        model.load_tokenizer(str(model_dir))
        tokenizer_class = type(model.tokenizer).__name__
        if tokenizer_class != "HunyuanImage3TokenizerFast":
            raise EditError(f"Hunyuan custom multimodal tokenizer was not loaded: {tokenizer_class}")
        native_moe_layers = validate_native_model_runtime(model)
        model.generation_config.max_new_tokens = None
        model.generation_config.max_length = int(model.config.max_position_embeddings)
        model.generation_config.diff_infer_steps = QUALITY_STEPS
        progress_reasoning = (
            "captured-think-recaption" if resumed_reasoning is not None else "think_recaption"
        )
        model.pipeline.progress_bar = lambda total: DiffusionProgress(
            total, status_path, progress_reasoning,
            int(model.config.max_position_embeddings), resumed_reasoning_sha256,
        )
        if resumed_reasoning is None:
            status_write(status_path, "running", "reasoning",
                         "HunyuanImage is reasoning over the source at maximum depth…", 24,
                         reasoning="think_recaption", quality="full-50",
                         nativeContext=model.config.max_position_embeddings)
        else:
            status_write(status_path, "running", "diffusion",
                         "Loading the completed Max reasoning into a fresh 50-step diffusion process…", 24,
                         reasoning="captured-think-recaption", quality="full-50",
                         reasoningSha256=resumed_reasoning_sha256,
                         nativeContext=model.config.max_position_embeddings)

        # No max_new_tokens or thinking budget is supplied. The model stops on
        # its own task tokens, bounded only by its native context window.
        if reasoning_output is not None:
            install_reasoning_capture(model)
            try:
                with ReasoningHeartbeat(
                    status_path, int(model.config.max_position_embeddings)
                ):
                    model.generate_image(
                        prompt=prompt,
                        image=input_paths,
                        seed=args.seed,
                        image_size="auto",
                        use_system_prompt="en_unified",
                        bot_task="think_recaption",
                        infer_align_image_size=True,
                        verbose=2,
                    )
            except ReasoningCaptured as captured:
                reasoning_sha256 = write_reasoning_artifact(
                    reasoning_output,
                    captured.reasoning,
                    captured.image_size,
                    prompt_path,
                    input_paths,
                    args.seed,
                    int(model.config.max_position_embeddings),
                    time.monotonic() - started,
                    mps_runtime,
                )
                status_write(
                    status_path, "running", "reasoning_complete",
                    "Maximum-depth reasoning complete; unloading before diffusion…", 29,
                    reasoning="think_recaption", quality="full-50",
                    reasoningSha256=reasoning_sha256,
                    nativeContext=model.config.max_position_embeddings,
                )
                print(reasoning_output, flush=True)
                remove_pid()
                sys.stdout.flush()
                sys.stderr.flush()
                os._exit(0)
            raise EditError("Hunyuan entered diffusion without yielding its reasoning artifact")
        elif resumed_reasoning is not None:
            _private_reasoning, samples = model.generate_image(
                prompt=prompt,
                image=input_paths,
                cot_text=resumed_reasoning,
                seed=args.seed,
                image_size=resumed_image_size,
                use_system_prompt="en_unified",
                bot_task="auto",
                infer_align_image_size=True,
                verbose=2,
            )
        else:
            with ReasoningHeartbeat(
                status_path, int(model.config.max_position_embeddings)
            ):
                _private_reasoning, samples = model.generate_image(
                    prompt=prompt,
                    image=input_paths,
                    seed=args.seed,
                    image_size="auto",
                    use_system_prompt="en_unified",
                    bot_task="think_recaption",
                    infer_align_image_size=True,
                    verbose=2,
                )
        if not samples:
            raise EditError("HunyuanImage returned no edited image")
        destination = outdir / f"hunyuan-image3-{int(time.time())}-{args.seed}.png"
        samples[0].save(destination, format="PNG", optimize=True)
        output_validation = inspect_output(destination)
        provenance = {
            "provider": "hunyuan-image3-instruct-nf4",
            "model": MODEL_ID,
            "revision": MODEL_REVISION,
            "baseModel": BASE_MODEL_ID,
            "baseRevision": BASE_MODEL_REVISION,
            "quantization": QUANTIZATION,
            "quality": {
                "profile": "full-instruct-50",
                "steps": QUALITY_STEPS,
                "systemPrompt": "en_unified",
                "reasoning": (
                    "captured-think-recaption" if resumed_reasoning is not None
                    else "think_recaption"
                ),
                "reasoningPhase": (
                    {
                        "policy": RESUMED_REASONING_POLICY,
                        "source": resumed_reasoning_source,
                        "sha256": resumed_reasoning_sha256,
                        "characters": len(resumed_reasoning),
                        "imageSize": {
                            "height": resumed_image_size[0],
                            "width": resumed_image_size[1],
                        },
                    }
                    if resumed_reasoning is not None else {"policy": "same-process uncapped Max"}
                ),
                "inferenceAlignImageSize": True,
                "maxNewTokens": None,
                "nativeContext": int(model.config.max_position_embeddings),
                "nativeEagerMoELayers": native_moe_layers,
                "nativeMoe": NATIVE_MOE_POLICY,
                "customMoeKernel": False,
                "dropsRoutedTokens": bool(model.config.moe_drop_tokens),
                "bf16ProtectedModules": bf16_protected,
                "allocatorWarmup": MPS_ALLOCATOR_WARMUP_POLICY,
                "visionInputs": VISION_INPUT_DEVICE_POLICY,
                "phaseCache": PHASE_CACHE_POLICY,
                "finiteGuard": FINITE_GUARD_POLICY,
                "mpsRuntime": mps_runtime,
                "tokenizerClass": tokenizer_class,
            },
            "sourceImages": [Path(value).name for value in input_paths],
            "outputValidation": output_validation,
            "seed": args.seed,
            "elapsedSeconds": round(time.monotonic() - started, 3),
        }
        (outdir / "hunyuan-image3-provenance.json").write_text(
            json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        status_write(status_path, "complete", "complete", "Edited image ready.", 100,
                     provider="hunyuan-image3-instruct-nf4", quality="full-50",
                     reasoning=progress_reasoning,
                     reasoningSha256=resumed_reasoning_sha256,
                     nativeContext=int(model.config.max_position_embeddings))
        print(destination, flush=True)
        remove_pid()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)
    except (EditError, OSError, ValueError) as exc:
        status_write(status_path, "error", "error", str(exc), 100)
        print(f"HunyuanImage editing failed: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:
        status_write(status_path, "error", "error", f"HunyuanImage editing failed: {exc}", 100)
        traceback.print_exc()
        print(f"HunyuanImage editing failed: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
