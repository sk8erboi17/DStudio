#!/usr/bin/env python3
"""Apply narrowly-scoped MPS and Max-inference fixes to pinned Tencent source.

The official model code hard-codes CUDA for autocast, NVTX, VAE scratch state,
and device selection. Its helper also imposes a hidden 2,048-token reasoning
ceiling even when callers omit ``max_new_tokens`` and retains the completed
text KV cache while allocating the diffusion inputs. Each portability change is
exact and fails closed if the pinned source changes. Numerical attention and
MoE forwards remain the official Tencent implementations.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys


REPLACEMENTS: dict[str, tuple[tuple[str, str], ...]] = {
    "modeling_hunyuan_image_3.py": (
        ("import math\nimport random\n", "import contextlib\nimport math\nimport random\n"),
        (
            "        torch.cuda.set_device(hidden_states.device.index)\n",
            "        if hidden_states.device.type == \"cuda\":\n"
            "            torch.cuda.set_device(hidden_states.device.index)\n",
        ),
        (
            "        with nvtx.range(\"MoE\"):\n",
            "        with (nvtx.range(\"MoE\") if hidden_states.device.type == \"cuda\" "
            "else contextlib.nullcontext()):\n",
        ),
        (
            "                with torch.autocast('cuda', enabled=False):\n",
            "                with torch.autocast(device_type=hidden_states.device.type, enabled=False):\n",
        ),
        (
            "    def _forward_vision_encoder(self, images, **image_kwargs):\n"
            "        image_embeds = self.vision_model(images, **image_kwargs).last_hidden_state\n",
            "    def _forward_vision_encoder(self, images, **image_kwargs):\n"
            "        # Keep SigLIP masks and spatial shapes on the same accelerator as pixels.\n"
            "        # This is a device-only transfer: values, shapes and dtypes are unchanged.\n"
            "        image_kwargs = {\n"
            "            name: value.to(device=images.device) if isinstance(value, torch.Tensor) else value\n"
            "            for name, value in image_kwargs.items()\n"
            "        }\n"
            "        image_embeds = self.vision_model(images, **image_kwargs).last_hidden_state\n",
        ),
        (
            "                device_type=\"cuda\", dtype=self.vae_autocast_dtype,  # noqa\n",
            "                device_type=self.device.type, dtype=self.vae_autocast_dtype,  # noqa\n",
        ),
        (
            "            with torch.autocast(device_type=\"cuda\", dtype=self.dtype, enabled=self.dtype != torch.float32):\n",
            "            with torch.autocast(device_type=self.device.type, dtype=self.dtype, enabled=self.dtype != torch.float32):\n",
        ),
        (
            "        max_new_tokens = kwargs.pop(\"max_new_tokens\", 2048)\n",
            "        max_new_tokens = kwargs.pop(\"max_new_tokens\", None)\n",
        ),
        (
            "            max_cache_len = output.tokens.shape[1] + default(max_new_tokens, self.generation_config.max_length)\n",
            "            max_cache_len = (\n"
            "                output.tokens.shape[1] + max_new_tokens\n"
            "                if max_new_tokens is not None else self.generation_config.max_length\n"
            "            )\n",
        ),
        (
            "        # Generate image\n"
            "        self.use_taylor_cache = use_taylor_cache\n"
            "        model_inputs = self.prepare_model_inputs(\n",
            "        # The completed text-generation inputs retain their dynamic KV cache.\n"
            "        # Delete that dead cache before constructing diffusion inputs; otherwise\n"
            "        # long, uncapped reasoning makes both allocations coexist and can drive\n"
            "        # MPS into swap/NaN. Emptying only unoccupied allocator blocks does not\n"
            "        # change model values, sampling, precision, or the generated recaption.\n"
            "        if self.device.type == \"mps\" and \"model_inputs\" in locals():\n"
            "            del model_inputs\n"
            "            import gc\n"
            "            gc.collect()\n"
            "            torch.mps.synchronize()\n"
            "            torch.mps.empty_cache()\n"
            "\n"
            "        # Generate image\n"
            "        self.use_taylor_cache = use_taylor_cache\n"
            "        model_inputs = self.prepare_model_inputs(\n",
        ),
    ),
    "hunyuan_image_3_pipeline.py": (
        (
            "                with torch.autocast(device_type=\"cuda\", dtype=torch.bfloat16, enabled=True):\n",
            "                with torch.autocast(device_type=self.device.type, dtype=torch.bfloat16, enabled=True):\n",
        ),
        (
            "        with torch.autocast(device_type=\"cuda\", dtype=torch.float16, enabled=True):\n",
            "        with torch.autocast(device_type=self.device.type, dtype=torch.float16, enabled=True):\n",
        ),
        (
            "                latents = self.scheduler.step(pred, t, latents, **_scheduler_step_extra_kwargs, return_dict=False)[0]\n",
            "                latents = self.scheduler.step(pred, t, latents, **_scheduler_step_extra_kwargs, return_dict=False)[0]\n"
            "                if not torch.isfinite(latents).all().item():\n"
            "                    raise FloatingPointError(\n"
            "                        f\"non-finite diffusion latents at step {i + 1}/{len(timesteps)}\"\n"
            "                    )\n",
        ),
        (
            "        do_denormalize = [True] * image.shape[0]\n"
            "        image = self.image_processor.postprocess(image, output_type=output_type, do_denormalize=do_denormalize)\n",
            "        if not torch.isfinite(image).all().item():\n"
            "            raise FloatingPointError(\"non-finite VAE decode output\")\n"
            "        do_denormalize = [True] * image.shape[0]\n"
            "        image = self.image_processor.postprocess(image, output_type=output_type, do_denormalize=do_denormalize)\n",
        ),
    ),
    "autoencoder_kl_3d.py": (
        (
            "        self.empty_cache = torch.empty(0, device=\"cuda\")\n",
            "        self.empty_cache = torch.empty(0)\n",
        ),
    ),
}


REQUIRED_OFFICIAL_FRAGMENTS: dict[str, tuple[str, ...]] = {
    "modeling_hunyuan_image_3.py": (
        "gate_and_up_proj.chunk(2, dim=-1)",
        "# DeepSeekMoE implementation",
        "hidden_states_flat.repeat_interleave(self.moe_topk, dim=0)",
        "expert_outputs[expert_mask] = expert_output",
    ),
}


def patch_file(path: Path, replacements: tuple[tuple[str, str], ...]) -> None:
    text = path.read_text(encoding="utf-8")
    original = text
    for old, new in replacements:
        old_count = text.count(old)
        new_count = text.count(new)
        # Some patched replacements intentionally contain the complete old
        # fragment (for example adding an import directly before it), so an
        # already-patched file can report old=1 and new=1. Prefer the complete
        # patched form when it is present.
        if new_count == 1:
            continue
        if old_count == 1:
            text = text.replace(old, new, 1)
        else:
            raise RuntimeError(
                f"unexpected pinned source in {path.name}: old={old_count}, patched={new_count}"
            )
    if text != original:
        temporary = path.with_name(path.name + ".dstudio.tmp")
        temporary.write_text(text, encoding="utf-8")
        temporary.replace(path)


def validate_official_source(path: Path, fragments: tuple[str, ...]) -> None:
    text = path.read_text(encoding="utf-8")
    missing = [fragment for fragment in fragments if fragment not in text]
    if missing:
        raise RuntimeError(
            f"{path.name} is not the pinned Tencent eager-MoE source: "
            + ", ".join(repr(fragment) for fragment in missing)
        )


def sync_official_moe_block(target_path: Path, official_path: Path) -> None:
    """Copy Tencent's coherent MLP/gate/MoE block into the NF4 source."""
    target = target_path.read_text(encoding="utf-8")
    official = official_path.read_text(encoding="utf-8")
    start_marker = "class HunyuanMLP(nn.Module):"
    end_marker = "\n\nclass HunyuanImage3SDPAAttention(nn.Module):"

    def block(text: str, label: str) -> tuple[int, int, str]:
        try:
            start = text.index(start_marker)
            end = text.index(end_marker, start)
        except ValueError as exc:
            raise RuntimeError(f"{label} has no unambiguous Hunyuan MLP/MoE block") from exc
        return start, end, text[start:end]

    target_start, target_end, target_block = block(target, target_path.name)
    _official_start, _official_end, official_block = block(official, official_path.name)
    if "# DeepSeekMoE implementation" not in official_block:
        raise RuntimeError("pinned Tencent source has no coherent official eager MoE block")
    if target_block == official_block:
        return
    merged = target[:target_start] + official_block + target[target_end:]
    temporary = target_path.with_name(target_path.name + ".official-moe.tmp")
    temporary.write_text(merged, encoding="utf-8")
    temporary.replace(target_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_dir")
    parser.add_argument("--official-modeling", required=True)
    args = parser.parse_args()
    model_dir = Path(args.model_dir).expanduser().resolve()
    official_modeling = Path(args.official_modeling).expanduser().resolve()
    try:
        if not official_modeling.is_file():
            raise RuntimeError(f"pinned Tencent model source is missing: {official_modeling}")
        sync_official_moe_block(model_dir / "modeling_hunyuan_image_3.py", official_modeling)
        for name, replacements in REPLACEMENTS.items():
            path = model_dir / name
            if not path.is_file():
                raise RuntimeError(f"pinned checkpoint is missing {name}")
            patch_file(path, replacements)
            if name in REQUIRED_OFFICIAL_FRAGMENTS:
                validate_official_source(path, REQUIRED_OFFICIAL_FRAGMENTS[name])
        marker = model_dir / ".dstudio-inference-conformance-v4"
        marker.write_text(
            "cuda-autocast,nvtx,device-select,vae-scratch,native-context-reasoning,"
            "mps-phase-cache-reclaim,finite-diffusion-guard,vision-input-colocation,"
            "tencent-official-eager-moe,transformers-upstream-mps-warmup-backport\n",
            encoding="ascii",
        )
        return 0
    except (OSError, RuntimeError) as exc:
        print(f"HunyuanImage MPS patch failed: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
