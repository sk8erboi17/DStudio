#!/usr/bin/env python3
"""Prove production Hunyuan source is a deterministic official composition."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil
import tempfile


ROOT = Path(__file__).resolve().parents[2]
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

print('Hunyuan patch reproducibility: generated files match installed bytes (no inference)')
