#!/usr/bin/env python3
"""Real MPS probe for Hunyuan's pinned native PyTorch attention runtime."""

from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNNER_PATH = ROOT / "scripts" / "hunyuan-image3-edit.py"


def load_runner():
    spec = importlib.util.spec_from_file_location("dstudio_hunyuan_sdpa_runner", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {RUNNER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_close_to_cpu(torch, observed, query, key, value, mask, rows, *, enable_gqa=False):
    functional = torch.nn.functional
    cpu_query = query.cpu().float().index_select(-2, rows)
    cpu_key = key.cpu().float()
    cpu_value = value.cpu().float()
    cpu_mask = None if mask is None else mask.cpu().index_select(-2, rows)
    reference = functional.scaled_dot_product_attention(
        cpu_query,
        cpu_key,
        cpu_value,
        attn_mask=cpu_mask,
        dropout_p=0.0,
        enable_gqa=enable_gqa,
    )
    selected = observed.cpu().float().index_select(-2, rows)
    error = (selected - reference).abs()
    mean_error = error.mean().item()
    max_error = error.max().item()
    if mean_error > 0.001 or max_error > 0.01:
        raise AssertionError(
            "native MPS attention diverged from its float32 definition: "
            f"mae={mean_error}, max={max_error}"
        )
    return mean_error, max_error


def main() -> int:
    import torch
    import torch.nn.functional as functional

    if not torch.backends.mps.is_available():
        print("Hunyuan native MPS SDPA probe: NOT RUN (MPS unavailable)")
        return 1

    runner = load_runner()
    profile = runner.validate_mps_runtime(torch)
    if profile["customAttentionKernel"] is not False or profile["nativeSdpa"] is not True:
        raise AssertionError(f"unexpected Hunyuan MPS runtime profile: {profile}")

    torch.manual_seed(7)
    query_length = key_length = 1300
    query = torch.randn((1, 2, query_length, 64), device="mps", dtype=torch.bfloat16)
    key = torch.randn((1, 2, key_length, 64), device="mps", dtype=torch.bfloat16)
    value = torch.randn((1, 2, key_length, 64), device="mps", dtype=torch.bfloat16)
    attention_mask = torch.full(
        (1, 1, query_length, key_length),
        float("-inf"),
        device="mps",
        dtype=torch.float32,
    ).triu(diagonal=1)
    first = functional.scaled_dot_product_attention(
        query, key, value, attn_mask=attention_mask, dropout_p=0.0
    )
    second = functional.scaled_dot_product_attention(
        query, key, value, attn_mask=attention_mask, dropout_p=0.0
    )

    # Cover the exact 1,024-token GQA boundary from the upstream MPS
    # corruption report as well as Hunyuan's long square prefill regime.
    gqa_query = torch.randn((1, 32, 1, 128), device="mps", dtype=torch.bfloat16)
    gqa_key = torch.randn((1, 2, 1024, 128), device="mps", dtype=torch.bfloat16)
    gqa_value = torch.randn((1, 2, 1024, 128), device="mps", dtype=torch.bfloat16)
    gqa_first = functional.scaled_dot_product_attention(
        gqa_query, gqa_key, gqa_value, dropout_p=0.0, enable_gqa=True
    )
    gqa_second = functional.scaled_dot_product_attention(
        gqa_query, gqa_key, gqa_value, dropout_p=0.0, enable_gqa=True
    )
    torch.mps.synchronize()
    tensors = (first, second, gqa_first, gqa_second)
    if not all(bool(torch.isfinite(item).all().item()) for item in tensors):
        raise FloatingPointError("native MPS attention returned a non-finite tensor")

    rows = torch.tensor([0, 511, 1022, 1023, 1299])
    mean_error, max_error = assert_close_to_cpu(
        torch, first, query, key, value, attention_mask, rows
    )
    gqa_mean, gqa_max = assert_close_to_cpu(
        torch,
        gqa_first,
        gqa_query,
        gqa_key,
        gqa_value,
        None,
        torch.tensor([0]),
        enable_gqa=True,
    )
    repeat_error = max(
        (first.float() - second.float()).abs().max().item(),
        (gqa_first.float() - gqa_second.float()).abs().max().item(),
    )
    if repeat_error != 0.0:
        raise AssertionError(f"native MPS attention is nondeterministic: {repeat_error}")
    print(
        "Hunyuan native MPS SDPA probe: pass "
        f"mae={mean_error:.8f} max={max_error:.8f} "
        f"gqa_mae={gqa_mean:.8f} gqa_max={gqa_max:.8f} "
        f"repeat={repeat_error:.8f} profile={profile}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
