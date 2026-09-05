#!/usr/bin/env python3
"""Locate the first non-finite stage in Hunyuan's exact Max reasoning prefill."""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import types


ROOT = Path(__file__).resolve().parents[2]
RUNNER_PATH = ROOT / "scripts" / "hunyuan-image3-edit.py"


def load_runner():
    spec = importlib.util.spec_from_file_location("dstudio_hunyuan_reasoning_probe", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {RUNNER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tensor_leaves(torch, value, prefix: str = "output", seen=None):
    """Yield tensors from nested Transformers outputs without invoking methods."""
    if seen is None:
        seen = set()
    if isinstance(value, torch.Tensor):
        yield prefix, value
        return
    value_id = id(value)
    if value_id in seen:
        return
    seen.add(value_id)
    if isinstance(value, dict):
        for name, item in value.items():
            yield from tensor_leaves(torch, item, f"{prefix}.{name}", seen)
        return
    if isinstance(value, (tuple, list)):
        for index, item in enumerate(value):
            yield from tensor_leaves(torch, item, f"{prefix}.{index}", seen)
        return
    # ModelOutput subclasses expose an ordered mapping. This avoids walking the
    # entire module graph through arbitrary object attributes.
    items = getattr(value, "items", None)
    if callable(items):
        try:
            for name, item in items():
                yield from tensor_leaves(torch, item, f"{prefix}.{name}", seen)
        except (AttributeError, TypeError):
            pass


class FirstNonFinite(RuntimeError):
    pass


class FiniteLogitsCaptured(RuntimeError):
    pass


class FinitePrefillCaptured(RuntimeError):
    pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument(
        "--model-dir",
        type=Path,
        help="pinned model directory; defaults to the production runtime",
    )
    parser.add_argument(
        "--vae-autocast",
        choices=("checkpoint", "bfloat16"),
        default="checkpoint",
        help="diagnostic-only VAE activation precision override",
    )
    parser.add_argument(
        "--trace-vae",
        action="store_true",
        help="synchronize and report each VAE encoder block",
    )
    parser.add_argument(
        "--through-logits",
        action="store_true",
        help="run the complete first decoder prefill and stop at finite logits",
    )
    parser.add_argument(
        "--trace-transformer",
        action="store_true",
        help="synchronize and report every decoder substage",
    )
    args = parser.parse_args()

    runner = load_runner()
    import torch
    from transformers import AutoModelForCausalLM

    if not torch.backends.mps.is_available():
        raise RuntimeError("probe requires MPS")
    runner.validate_mps_runtime(torch)
    model_dir = (
        args.model_dir.expanduser().resolve()
        if args.model_dir is not None
        else runner.runtime_root() / "models" / "HunyuanImage-3-Instruct-NF4-v2"
    )
    model = AutoModelForCausalLM.from_pretrained(
        str(model_dir),
        device_map={"": "mps"},
        trust_remote_code=True,
        dtype=torch.bfloat16,
        attn_implementation="sdpa",
        low_cpu_mem_usage=True,
        moe_impl="eager",
    )
    runner.validate_checkpoint_quantization(model)
    model.load_tokenizer(str(model_dir))
    native_moe_layers = runner.validate_native_model_runtime(model)
    print(f"Tencent official eager MoE layers={native_moe_layers}", flush=True)
    if args.vae_autocast == "bfloat16":
        model.vae_autocast_dtype = torch.bfloat16
    print(
        f"VAE diagnostic autocast={model.vae_autocast_dtype} "
        f"parameter_dtype={next(model.vae.parameters()).dtype}",
        flush=True,
    )
    model.generation_config.max_new_tokens = None
    model.generation_config.max_length = int(model.config.max_position_embeddings)

    def check(label: str, output, stop: bool = False):
        found = False
        for suffix, tensor in tensor_leaves(torch, output):
            found = True
            tensor_label = label if suffix == "output" else f"{label}:{suffix}"
            try:
                finite = bool(torch.isfinite(tensor).all().item())
            except Exception as exc:
                raise FirstNonFinite(
                    f"{tensor_label}: accelerator error while synchronizing: {exc}"
                ) from exc
            print(
                f"{'finite' if finite else 'NONFINITE'} {tensor_label} "
                f"shape={tuple(tensor.shape)} dtype={tensor.dtype} device={tensor.device}",
                flush=True,
            )
            if not finite:
                raise FirstNonFinite(tensor_label)
        if found and stop:
            raise FiniteLogitsCaptured(label)

    def wrap_stage_method(name: str):
        upstream = getattr(model, name)

        def checked(self, *method_args, **method_kwargs):
            result = upstream(*method_args, **method_kwargs)
            check(name, result)
            return result

        setattr(model, name, types.MethodType(checked, model))

    # These wrappers bracket every in-place fusion step. In particular, the
    # word-embedding tensor is mutated by scatter_, so checking only layer 0
    # cannot distinguish which image branch introduced a bad value.
    for stage_name in (
        "vae_encode",
        "_encode_cond_image",
        "instantiate_vae_image_tokens",
        "_forward_vision_encoder",
        "instantiate_vit_image_tokens",
        "instantiate_continuous_tokens",
    ):
        wrap_stage_method(stage_name)

    handles = []
    if args.trace_vae:
        vae_encoder = model.vae.encoder
        handles.append(vae_encoder.conv_in.register_forward_hook(
            lambda _module, _args, output: check("vae.encoder.conv_in", output)
        ))
        for level_index, level in enumerate(vae_encoder.down):
            for block_index, block in enumerate(level.block):
                handles.append(block.register_forward_hook(
                    lambda _module, _args, output, level_idx=level_index, block_idx=block_index: check(
                        f"vae.encoder.down.{level_idx}.block.{block_idx}", output
                    )
                ))
            if hasattr(level, "downsample"):
                handles.append(level.downsample.register_forward_hook(
                    lambda _module, _args, output, level_idx=level_index: check(
                        f"vae.encoder.down.{level_idx}.downsample", output
                    )
                ))
        handles.append(vae_encoder.mid.block_1.register_forward_hook(
            lambda _module, _args, output: check("vae.encoder.mid.block_1", output)
        ))
        handles.append(vae_encoder.mid.attn_1.register_forward_hook(
            lambda _module, _args, output: check("vae.encoder.mid.attn_1", output)
        ))
        handles.append(vae_encoder.mid.block_2.register_forward_hook(
            lambda _module, _args, output: check("vae.encoder.mid.block_2", output)
        ))
        handles.append(vae_encoder.norm_out.register_forward_hook(
            lambda _module, _args, output: check("vae.encoder.norm_out", output)
        ))
        handles.append(vae_encoder.conv_out.register_forward_hook(
            lambda _module, _args, output: check("vae.encoder.conv_out", output)
        ))
    handles.append(model.model.wte.register_forward_hook(
        lambda _module, _args, output: check("word_embedding", output)
    ))
    handles.append(model.time_embed.register_forward_hook(
        lambda _module, _args, output: check("time_embedding", output)
    ))
    handles.append(model.patch_embed.register_forward_hook(
        lambda _module, _args, output: check("patch_embedding", output)
    ))
    handles.append(model.vision_model.register_forward_hook(
        lambda _module, _args, _kwargs, output: check("vision_model", output),
        with_kwargs=True,
    ))
    handles.append(model.vision_aligner.register_forward_hook(
        lambda _module, _args, output: check("vision_aligner", output)
    ))

    def capture_decoder_input(_module, _args, kwargs):
        check("decoder_input", kwargs.get("inputs_embeds"))
        if not args.through_logits:
            raise FinitePrefillCaptured("decoder_input")

    handles.append(model.model.register_forward_pre_hook(
        capture_decoder_input,
        with_kwargs=True,
    ))
    if args.trace_transformer:
        for index, layer in enumerate(model.model.layers):
            handles.append(layer.register_forward_pre_hook(
                lambda _module, layer_args, idx=index: check(f"layer.{idx}.input", layer_args)
            ))
            handles.append(layer.self_attn.qkv_proj.register_forward_hook(
                lambda _module, _args, output, idx=index: check(
                    f"layer.{idx}.attention.qkv_proj", output
                )
            ))
            handles.append(layer.self_attn.query_layernorm.register_forward_hook(
                lambda _module, _args, output, idx=index: check(
                    f"layer.{idx}.attention.query_norm", output
                )
            ))
            handles.append(layer.self_attn.key_layernorm.register_forward_hook(
                lambda _module, _args, output, idx=index: check(
                    f"layer.{idx}.attention.key_norm", output
                )
            ))
            handles.append(layer.self_attn.o_proj.register_forward_pre_hook(
                lambda _module, layer_args, idx=index: check(
                    f"layer.{idx}.attention.o_proj_input", layer_args
                )
            ))
            handles.append(layer.self_attn.o_proj.register_forward_hook(
                lambda _module, _args, output, idx=index: check(
                    f"layer.{idx}.attention.o_proj_output", output
                )
            ))
            handles.append(layer.self_attn.register_forward_hook(
                lambda _module, _args, _kwargs, output, idx=index: check(
                    f"layer.{idx}.attention", output
                ),
                with_kwargs=True,
            ))
            handles.append(layer.mlp.register_forward_hook(
                lambda _module, _args, output, idx=index: check(f"layer.{idx}.moe", output)
            ))
            handles.append(layer.register_forward_hook(
                lambda _module, _args, _kwargs, output, idx=index: check(
                    f"layer.{idx}.output", output
                ),
                with_kwargs=True,
            ))
    handles.append(model.lm_head.register_forward_hook(
        lambda _module, _args, output: check("lm_head", output, stop=True)
    ))

    prompt = args.prompt_file.resolve().read_text(encoding="utf-8").strip()
    try:
        model.generate_image(
            prompt=prompt,
            image=[str(args.source.resolve())],
            seed=0,
            image_size="auto",
            use_system_prompt="en_unified",
            bot_task="think_recaption",
            infer_align_image_size=True,
            verbose=0,
        )
    except FinitePrefillCaptured:
        print(
            "Hunyuan multimodal prefill reached the decoder with finite inputs",
            flush=True,
        )
        return 0
    except FiniteLogitsCaptured:
        print("Hunyuan first reasoning logits are finite", flush=True)
        return 0
    except FirstNonFinite as exc:
        print(
            f"Hunyuan reasoning first non-finite stage: {exc}",
            flush=True,
        )
        return 4
    raise RuntimeError("reasoning probe entered decoding without capturing the prefill input")


if __name__ == "__main__":
    raise SystemExit(main())
