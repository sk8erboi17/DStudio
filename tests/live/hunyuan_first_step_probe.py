#!/usr/bin/env python3
"""Locate the first non-finite Hunyuan module using a captured Max recaption.

This is a diagnostic-only one-timestep probe. It reconstructs the exact image
context from a completed reasoning transcript so numerical bugs can be located
without rerunning uncapped text generation. It never saves or approves output.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
RUNNER_PATH = ROOT / "scripts" / "hunyuan-image3-edit.py"


def load_runner():
    spec = importlib.util.spec_from_file_location("dstudio_hunyuan_probe_runner", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {RUNNER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def captured_cot(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    matches = re.findall(r"Assistant: (<think>.*?</recaption>)<answer>", text, flags=re.DOTALL)
    if not matches:
        raise RuntimeError(f"no complete think/recaption block in {path}")
    return matches[-1]


def captured_artifact(runner, path: Path, prompt: Path, source: Path) -> tuple[str, tuple[int, int]]:
    """Validate a prior bound transcript for diagnostic diffusion reuse.

    The artifact may predate the current runtime schema, so this deliberately
    validates the immutable request binding and transcript hash rather than
    claiming that its reasoning phase used the runtime under test.
    """
    payload = json.loads(path.read_text(encoding="utf-8"))
    reasoning = runner.normalize_reasoning(payload.get("reasoning"))
    digest = hashlib.sha256(reasoning.encode("utf-8")).hexdigest()
    if payload.get("reasoningSha256") != digest:
        raise RuntimeError("reasoning artifact transcript hash mismatch")
    if payload.get("binding") != runner.reasoning_binding(prompt, [str(source)], 0):
        raise RuntimeError("reasoning artifact does not match prompt, source, and seed 0")
    size = payload.get("imageSize")
    if not isinstance(size, dict):
        raise RuntimeError("reasoning artifact has no image size")
    height, width = size.get("height"), size.get("width")
    if not isinstance(height, int) or not isinstance(width, int):
        raise RuntimeError("reasoning artifact image size is invalid")
    return reasoning, (height, width)


def tensor_from(output):
    if hasattr(output, "last_hidden_state"):
        return output.last_hidden_state
    if isinstance(output, (tuple, list)):
        return output[0]
    return output


class FirstStepComplete(RuntimeError):
    pass


class FiniteRecords:
    def __init__(self, torch):
        self.torch = torch
        self.forward_index = -1
        self.items = []

    def enqueue(self, label: str, output) -> None:
        tensor = tensor_from(output)
        if not isinstance(tensor, self.torch.Tensor):
            return
        self.items.append({
            "label": f"forward.{self.forward_index}.{label}",
            "shape": tuple(tensor.shape),
            "dtype": str(tensor.dtype),
            "finite": self.torch.isfinite(tensor).all(),
        })

    def layer_input(self, index: int, output) -> None:
        if index == 0:
            self.forward_index += 1
        self.enqueue(f"layer.{index}.input", output)

    def report(self) -> str | None:
        self.torch.mps.synchronize()
        first_nonfinite = None
        for item in self.items:
            finite = bool(item["finite"].item())
            state = "finite" if finite else "NONFINITE"
            print(
                f"{state} {item['label']}: shape={item['shape']} dtype={item['dtype']}",
                flush=True,
            )
            if not finite and first_nonfinite is None:
                first_nonfinite = item["label"]
        return first_nonfinite


class StopAfterFirstStep:
    def __init__(self, total: int):
        self.total = total

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def update(self, amount: int = 1) -> None:
        raise FirstStepComplete("exact first step of the 50-step schedule completed")

    def set_description(self, *args, **kwargs) -> None:
        return None

    def close(self) -> None:
        return None


def install_layer_probes(model, records: FiniteRecords) -> int:
    handles = []
    for index, layer in enumerate(model.model.layers):
        handles.append(layer.register_forward_pre_hook(
            lambda _module, args, idx=index: records.layer_input(idx, args[0])
        ))
        handles.append(layer.self_attn.register_forward_hook(
            lambda _module, _args, _kwargs, output, idx=index: records.enqueue(
                f"layer.{idx}.attention", output
            ),
            with_kwargs=True,
        ))
        handles.append(layer.mlp.register_forward_hook(
            lambda _module, _args, output, idx=index: records.enqueue(
                f"layer.{idx}.moe", output
            )
        ))
        handles.append(layer.register_forward_hook(
            lambda _module, _args, _kwargs, output, idx=index: records.enqueue(
                f"layer.{idx}.output", output
            ),
            with_kwargs=True,
        ))
    handles.append(model.final_layer.register_forward_hook(
        lambda _module, _args, output: records.enqueue("final_layer", output)
    ))
    model._dstudio_probe_handles = handles
    return len(handles)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", type=Path, required=True)
    reasoning = parser.add_mutually_exclusive_group(required=True)
    reasoning.add_argument("--reasoning-log", type=Path)
    reasoning.add_argument("--reasoning-artifact", type=Path)
    parser.add_argument(
        "--log-image-size",
        default="832x1216",
        help="HEIGHTxWIDTH used only with a legacy text reasoning log",
    )
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()

    runner = load_runner()
    import torch
    from transformers import AutoModelForCausalLM

    if not torch.backends.mps.is_available():
        raise RuntimeError("probe requires MPS")
    model_dir = runner.runtime_root() / "models" / "HunyuanImage-3-Instruct-NF4-v2"
    mps_runtime = runner.validate_mps_runtime(torch)
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
    tokenizer_class = type(model.tokenizer).__name__
    if tokenizer_class != "HunyuanImage3TokenizerFast":
        raise RuntimeError(f"unexpected tokenizer class: {tokenizer_class}")
    native_moe_layers = runner.validate_native_model_runtime(model)
    model.generation_config.max_new_tokens = None
    model.generation_config.max_length = int(model.config.max_position_embeddings)
    model.generation_config.diff_infer_steps = runner.QUALITY_STEPS
    model.pipeline.progress_bar = lambda total: StopAfterFirstStep(total)
    records = FiniteRecords(torch)
    probes = install_layer_probes(model, records)
    prompt_path = args.prompt_file.resolve()
    source_path = args.source.resolve()
    prompt = prompt_path.read_text(encoding="utf-8").strip()
    if args.reasoning_artifact is not None:
        cot_text, image_size = captured_artifact(
            runner, args.reasoning_artifact.resolve(), prompt_path, source_path
        )
        reasoning_source = args.reasoning_artifact.name
    else:
        cot_text = captured_cot(args.reasoning_log.resolve())
        image_size = runner.parse_resume_image_size(args.log_image_size)
        reasoning_source = args.reasoning_log.name
    print(
        f"installed_probes={probes} captured_cot_chars={len(cot_text)} "
        f"image_size={image_size} tokenizer={tokenizer_class} "
        f"reasoning_source={reasoning_source}",
        flush=True,
    )

    # Build the official 50-step schedule and stop only after its exact first
    # scheduler update. Device-side finite flags are collected asynchronously
    # and read once, so the probe itself does not serialize every submodule.
    run_error = None
    try:
        model.generate_image(
            prompt=prompt,
            image=[str(source_path)],
            cot_text=cot_text,
            seed=0,
            image_size=image_size,
            use_system_prompt="en_unified",
            bot_task="auto",
            infer_align_image_size=True,
            verbose=2,
        )
    except FirstStepComplete:
        pass
    except Exception as exc:  # report queued module flags before propagating
        run_error = exc
    first_nonfinite = records.report()
    if first_nonfinite is not None:
        raise FloatingPointError(f"first non-finite tensor: {first_nonfinite}") from run_error
    if run_error is not None:
        raise run_error
    print(
        "Hunyuan exact 50-step first-step diagnostic: finite "
        f"native_moe_layers={native_moe_layers} mps_runtime={mps_runtime}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
