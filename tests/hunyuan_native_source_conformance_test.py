#!/usr/bin/env python3
"""Prove production Hunyuan source is a deterministic official composition."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil
import tempfile


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path.home() / ".dstudio" / "hunyuan-image"
MODEL = RUNTIME / "models" / "HunyuanImage-3-Instruct-NF4-v2"
COMMUNITY = RUNTIME / "source" / (
    "community-98fda5c508c05f5407f036bca413149ca92c143b"
)
OFFICIAL = RUNTIME / "source" / (
    "tencent-2ec2c78bee7d4b94157341fba86c4c2c7b1858b2"
) / "modeling_hunyuan_image_3.py"
PATCH_PATH = ROOT / "scripts" / "hunyuan-image3-mps-patch.py"
RUNNER_PATH = ROOT / "scripts" / "hunyuan-image3-edit.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


patch = load_module("dstudio_hunyuan_source_patch", PATCH_PATH)
runner_source = RUNNER_PATH.read_text(encoding="utf-8")
for retired in (
    "memory_efficient_moe_forward",
    "slot_major_expert_route",
    "install_memory_efficient_moe",
    "install_mps_allocator_warmup_guard",
    "install_vision_input_device_guard",
):
    assert retired not in runner_source, f"retired runtime override remains: {retired}"

required = (
    MODEL / "modeling_hunyuan_image_3.py",
    MODEL / "hunyuan_image_3_pipeline.py",
    MODEL / "autoencoder_kl_3d.py",
    MODEL / ".dstudio-inference-conformance-v4",
    COMMUNITY / "modeling_hunyuan_image_3.py",
    COMMUNITY / "hunyuan_image_3_pipeline.py",
    COMMUNITY / "autoencoder_kl_3d.py",
    OFFICIAL,
)
missing = [str(path) for path in required if not path.is_file()]
assert not missing, "missing pinned source files: " + ", ".join(missing)

# Rebuild from immutable upstream inputs in an empty directory. Byte-for-byte
# equality proves production contains no stale local edit or hidden numerical
# implementation beyond the declared deterministic portability transform.
with tempfile.TemporaryDirectory(prefix="dstudio-hunyuan-native-source-") as temporary:
    rebuilt = Path(temporary)
    for name in patch.REPLACEMENTS:
        shutil.copy2(COMMUNITY / name, rebuilt / name)
    patch.sync_official_moe_block(rebuilt / "modeling_hunyuan_image_3.py", OFFICIAL)
    for name, replacements in patch.REPLACEMENTS.items():
        patch.patch_file(rebuilt / name, replacements)
        assert (rebuilt / name).read_bytes() == (MODEL / name).read_bytes(), name

model_source = (MODEL / "modeling_hunyuan_image_3.py").read_text(encoding="utf-8")
for fragment in patch.REQUIRED_OFFICIAL_FRAGMENTS["modeling_hunyuan_image_3.py"]:
    assert fragment in model_source
assert "value.to(device=images.device)" in model_source
assert "torch.cuda.set_device(hidden_states.device.index)" in model_source
assert "if hidden_states.device.type == \"cuda\"" in model_source
assert "contextlib.nullcontext()" in model_source

marker = (MODEL / ".dstudio-inference-conformance-v4").read_text(encoding="ascii")
for feature in (
    "tencent-official-eager-moe",
    "transformers-upstream-mps-warmup-backport",
    "vision-input-colocation",
    "native-context-reasoning",
    "finite-diffusion-guard",
):
    assert feature in marker

print("Hunyuan official native source conformance: OK")
