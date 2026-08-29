#!/usr/bin/env python3
"""Fail-closed quality-profile checks for the two local image backends.

Run this with the pinned Ideogram virtualenv so the test exercises Comfy's
actual scheduler implementation as well as Ideogram's official preset registry.
"""

from __future__ import annotations

import ast
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
IDEOGRAM_ROOT = Path.home() / ".dstudio" / "ideogram4"
HUNYUAN_MODEL = (
    Path.home()
    / ".dstudio"
    / "hunyuan-image"
    / "models"
    / "HunyuanImage-3-Instruct-NF4-v2"
)
HUNYUAN_PYTHON = Path.home() / ".dstudio" / "hunyuan-image" / "venv" / "bin" / "python"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def keyword_literal(call: ast.Call, name: str):
    for keyword in call.keywords:
        if keyword.arg == name:
            return ast.literal_eval(keyword.value)
    raise AssertionError(f"generate_image is missing {name}")


def ideogram_gate():
    comfy_root = IDEOGRAM_ROOT / "comfyui"
    sys.path.insert(0, str(comfy_root))
    from comfy.model_sampling import ModelSamplingDiscreteFlow
    from comfy_extras.nodes_ideogram4 import ideogram4_sigmas
    from ideogram4.sampler_configs import PRESETS

    runner = load_module("dstudio_ideogram4_runner", ROOT / "scripts" / "ideogram4-run.py")
    preset = PRESETS["V4_QUALITY_48"]
    assert runner.QUALITY_STEPS == preset.num_steps == 48
    assert runner.QUALITY_CFG == 7.0
    assert runner.QUALITY_POLISH_CFG == 3.0
    assert runner.QUALITY_POLISH_STEPS == 3
    assert runner.QUALITY_MU == preset.mu == 0.0
    assert runner.QUALITY_STD == preset.std == 1.5
    assert tuple(preset.guidance_schedule) == (3.0,) * 3 + (7.0,) * 45

    sampling = ModelSamplingDiscreteFlow()
    sampling.set_parameters(shift=1.0, multiplier=1.0)
    for aspect, (width, height) in runner.ASPECT_SIZES.items():
        assert width % 16 == height % 16 == 0, aspect
        assert 256 <= width <= 2048 and 256 <= height <= 2048, aspect
        graph = runner.workflow("{}", width, height, 0)
        assert graph["9"]["inputs"]["sampler_name"] == "euler"
        assert graph["10"]["inputs"] == {
            "steps": 48,
            "width": width,
            "height": height,
            "mu": 0.0,
            "std": 1.5,
        }
        assert graph["1"]["inputs"]["unet_name"] == runner.CONDITIONAL_MODEL
        assert graph["3"]["inputs"]["unet_name"] == runner.UNCONDITIONAL_MODEL
        assert graph["7"]["inputs"]["cfg"] == 7.0
        assert graph["14"]["class_type"] == "VAEDecodeTiled"
        assert graph["14"]["inputs"] == {
            "samples": ["12", 0],
            "vae": ["13", 0],
            "tile_size": runner.VAE_TILE_SIZE,
            "overlap": runner.VAE_TILE_OVERLAP,
            "temporal_size": 64,
            "temporal_overlap": 8,
        }
        assert runner.VAE_DECODE_POLICY == "overlapped-three-pass-tiled"
        assert runner.VAE_TILE_SIZE == 1024
        assert runner.VAE_TILE_OVERLAP == runner.VAE_TILE_SIZE // 4

        override = graph["2"]
        assert override["class_type"] == "CFGOverride"
        assert override["inputs"]["cfg"] == 3.0
        assert override["inputs"]["end_percent"] == 1.0

        threshold = sampling.percent_to_sigma(override["inputs"]["start_percent"])
        sigmas = ideogram4_sigmas(48, width, height, 0.0, 1.5).tolist()
        selected = [
            index
            for index, sigma in enumerate(sigmas[:-1])
            if 0.0 <= sigma <= threshold
        ]
        assert selected == [45, 46, 47], (aspect, threshold, selected)

    with tempfile.TemporaryDirectory(prefix="dstudio-ideogram-progress-") as temporary:
        progress_status = Path(temporary) / "status.json"
        runner.publish_inference_progress(
            progress_status, 7, 2048, 1152, time.monotonic() - 5,
            heartbeat=True,
        )
        live = json.loads(progress_status.read_text(encoding="utf-8"))
        assert live["stage"] == "sampling"
        assert live["step"] == 7 and live["steps"] == 48
        assert live["quality"] == "quality-48"
        assert live["width"] == 2048 and live["height"] == 1152
        assert live["heartbeat"] is True and live["elapsedSeconds"] >= 5

        runner.publish_inference_progress(
            progress_status, 48, 2048, 1152, time.monotonic()
        )
        decoding = json.loads(progress_status.read_text(encoding="utf-8"))
        assert decoding["stage"] == "decoding"
        assert decoding["quality"] == "quality-48"
        assert decoding["vaeDecode"] == runner.VAE_DECODE_POLICY

    # ComfyUI reports execution failures with completed=false.  The worker
    # must surface that terminal state instead of polling forever at 90%.
    failure = {
        "status": {
            "status_str": "error",
            "completed": False,
            "messages": [[
                "execution_error",
                {
                    "node_type": "VAEDecodeTiled",
                    "exception_type": "RuntimeError",
                    "exception_message": "synthetic decoder failure\n",
                    "current_inputs": {"large": "ignored"},
                },
            ]],
        }
    }
    assert runner.history_error(failure) == (
        "ComfyUI VAEDecodeTiled failed (RuntimeError): synthetic decoder failure"
    )
    assert runner.terminal_history_error(failure) == runner.history_error(failure)
    assert runner.terminal_history_error({
        "status": {"status_str": "running", "completed": False, "messages": []}
    }) is None
    assert runner.terminal_history_error({
        "status": {"status_str": "success", "completed": True, "messages": []}
    }) == "Ideogram 4 workflow did not produce an image"

    revisions = (IDEOGRAM_ROOT / ".runtime-revisions-v1").read_text(encoding="ascii")
    assert f"comfy={runner.COMFY_COMMIT}" in revisions
    assert f"fp8={runner.FP8_PLUGIN_COMMIT}" in revisions
    assert f"ideogram-node={runner.IDEOGRAM_NODE_COMMIT}" in revisions
    return runner


def hunyuan_gate():
    runner_path = ROOT / "scripts" / "hunyuan-image3-edit.py"
    runner_source = runner_path.read_text(encoding="utf-8")
    runner = load_module("dstudio_hunyuan_runner", runner_path)
    config = json.loads((HUNYUAN_MODEL / "config.json").read_text(encoding="utf-8"))
    generation = json.loads(
        (HUNYUAN_MODEL / "generation_config.json").read_text(encoding="utf-8")
    )
    model_source = (HUNYUAN_MODEL / "modeling_hunyuan_image_3.py").read_text(
        encoding="utf-8"
    )
    pipeline_source = (HUNYUAN_MODEL / "hunyuan_image_3_pipeline.py").read_text(
        encoding="utf-8"
    )

    assert runner.MODEL_REVISION == (
        HUNYUAN_MODEL / ".dstudio-model-revision"
    ).read_text(encoding="ascii").strip()
    assert config["architectures"] == ["HunyuanImage3ForCausalMM"]
    assert config["cfg_distilled"] is False
    assert config["use_meanflow"] is False
    assert config["moe_drop_tokens"] is False
    assert config["num_hidden_layers"] == 32
    assert config["num_experts"] == 64
    assert config["max_position_embeddings"] == generation["max_length"] == 22800
    assert generation["bot_task"] == "think_recaption"
    assert generation["use_system_prompt"] == "en_unified"
    assert generation["diff_infer_steps"] == runner.QUALITY_STEPS == 50
    assert generation["diff_guidance_scale"] == 2.5
    assert generation["flow_shift"] == 3.0
    assert generation["do_sample"] is True
    assert generation["temperature"] == 0.6
    assert generation["top_p"] == 0.95
    assert generation["top_k"] == 1024
    assert generation["drop_think"] is False

    quantization = config["quantization_config"]
    assert quantization["load_in_4bit"] is True
    assert quantization["bnb_4bit_quant_type"] == "nf4"
    assert quantization["bnb_4bit_use_double_quant"] is True
    assert quantization["bnb_4bit_compute_dtype"] == "bfloat16"
    assert runner.REQUIRED_BF16_SKIP_MODULES <= set(
        quantization["llm_int8_skip_modules"]
    )

    # Max means no hidden 2,048-token ceiling. EOS and the native 22,800-token
    # context are the only termination bounds for reasoning.
    assert 'kwargs.pop("max_new_tokens", 2048)' not in model_source
    assert 'kwargs.pop("max_new_tokens", None)' in model_source
    assert "if max_new_tokens is not None else self.generation_config.max_length" in model_source
    assert "model.generation_config.max_new_tokens = None" in runner_source
    assert "model.generation_config.max_length = int(model.config.max_position_embeddings)" in runner_source
    assert "model.generation_config.diff_infer_steps = QUALITY_STEPS" in runner_source
    assert runner.MPS_ALLOCATOR_WARMUP_POLICY == (
        "Transformers 4.57.1 with the upstream MPS warm-up skip backported at install; "
        "no runtime monkeypatch"
    )
    assert runner.VISION_INPUT_DEVICE_POLICY == (
        "pinned Tencent model source co-locates SigLIP auxiliary tensors with pixels"
    )
    assert runner.NATIVE_MOE_POLICY == (
        "Tencent official DeepSeek eager MoE; no DStudio numerical forward override"
    )
    assert runner.PHASE_CACHE_POLICY == (
        "release completed reasoning KV cache before allocating diffusion inputs on MPS"
    )
    assert runner.FINITE_GUARD_POLICY == (
        "fail immediately on non-finite diffusion latents or VAE output"
    )
    assert runner.TORCH_VERSION == "2.15.0.dev20260821"
    assert runner.TORCH_GIT_REVISION == "cef373b344057d8ed91bcf05d7921b2ca1d0d13c"
    assert runner.TORCHVISION_VERSION == "0.30.0.dev20260825"
    assert runner.TRANSFORMERS_VERSION == "4.57.1"
    assert runner.MPS_RUNTIME_POLICY == (
        "pinned post-2026-06-23 PyTorch MPS runtime with native SDPA, the upstream "
        "Transformers MPS warm-up skip in source, and Tencent official eager MoE"
    )
    assert runner.expected_mps_runtime_profile() == {
        "policy": runner.MPS_RUNTIME_POLICY,
        "torch": runner.TORCH_VERSION,
        "torchGitRevision": runner.TORCH_GIT_REVISION,
        "torchvision": runner.TORCHVISION_VERSION,
        "transformers": runner.TRANSFORMERS_VERSION,
        "nativeSdpa": True,
        "sourceMpsAllocatorWarmupSkip": True,
        "runtimeMonkeypatch": False,
        "officialEagerMoe": True,
        "customAttentionKernel": False,
        "customMoeKernel": False,
        "officialModelCodeRevision": runner.BASE_MODEL_REVISION,
    }
    assert runner.RESUMED_REASONING_POLICY == (
        "reuse a complete hashed Max think/recaption transcript in a fresh diffusion process"
    )
    assert "install_mps_sdpa_query_guard" not in runner_source
    assert "mps_blockwise_attention" not in runner_source
    assert "install_mps_allocator_warmup_guard" not in runner_source
    assert "install_vision_input_device_guard" not in runner_source
    assert "install_memory_efficient_moe" not in runner_source
    assert "memory_efficient_moe_forward" not in runner_source
    assert "slot_major_expert_route" not in runner_source
    assert "mps_runtime = validate_mps_runtime(torch)" in runner_source
    assert '"mpsRuntime": mps_runtime' in runner_source
    assert 'device_map={"": "mps"}' in runner_source
    assert "dtype=torch.bfloat16" in runner_source
    assert "native_moe_layers = validate_native_model_runtime(model)" in runner_source
    assert 'tokenizer_class != "HunyuanImage3TokenizerFast"' in runner_source
    marker = (HUNYUAN_MODEL / ".dstudio-inference-conformance-v4").read_text(
        encoding="ascii"
    )
    assert "native-context-reasoning" in marker
    assert "mps-phase-cache-reclaim" in marker
    assert "finite-diffusion-guard" in marker
    assert "vision-input-colocation" in marker
    assert "tencent-official-eager-moe" in marker
    assert "transformers-upstream-mps-warmup-backport" in marker
    assert "# DeepSeekMoE implementation" in model_source
    assert "gate_and_up_proj.chunk(2, dim=-1)" in model_source
    assert "hidden_states_flat.repeat_interleave(self.moe_topk, dim=0)" in model_source
    assert "expert_outputs[expert_mask] = expert_output" in model_source
    reclaim = model_source.index('if self.device.type == "mps" and "model_inputs" in locals():')
    diffusion = model_source.index("# Generate image", reclaim)
    assert model_source.index("del model_inputs", reclaim, diffusion) < diffusion
    assert model_source.index("gc.collect()", reclaim, diffusion) < diffusion
    assert model_source.index("torch.mps.synchronize()", reclaim, diffusion) < diffusion
    assert model_source.index("torch.mps.empty_cache()", reclaim, diffusion) < diffusion
    assert "non-finite diffusion latents at step" in pipeline_source
    assert "non-finite VAE decode output" in pipeline_source

    # The SigLIP fix lives in the pinned model source and changes device only.
    vision_start = model_source.index("    def _forward_vision_encoder(")
    vision_end = model_source.index("\n    def ", vision_start + 8)
    vision_source = model_source[vision_start:vision_end]
    assert "value.to(device=images.device)" in vision_source
    assert ".to(dtype=" not in vision_source
    assert "self.vision_model(images, **image_kwargs).last_hidden_state" in vision_source

    # Validate the actual Hunyuan environment, not the Ideogram test venv. The
    # warm-up fix is installed source and the runner must report no monkeypatch.
    assert HUNYUAN_PYTHON.is_file()
    runtime_check = subprocess.run(
        [
            str(HUNYUAN_PYTHON),
            "-c",
            (
                "import importlib.util, pathlib, torch; "
                f"p=pathlib.Path({str(runner_path)!r}); "
                "s=importlib.util.spec_from_file_location('hunyuan_runtime_check',p); "
                "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                "profile=m.validate_mps_runtime(torch); "
                "assert profile['runtimeMonkeypatch'] is False; "
                "assert profile['sourceMpsAllocatorWarmupSkip'] is True"
            ),
        ],
        text=True,
        capture_output=True,
        timeout=30,
    )
    assert runtime_check.returncode == 0, runtime_check.stderr or runtime_check.stdout

    with tempfile.TemporaryDirectory(prefix="dstudio-hunyuan-heartbeat-") as temporary:
        status = Path(temporary) / "status.json"
        with runner.ReasoningHeartbeat(status, 22800, interval_seconds=0.01):
            time.sleep(0.035)
        heartbeat = json.loads(status.read_text(encoding="utf-8"))
        assert heartbeat["state"] == "running"
        assert heartbeat["stage"] == "reasoning"
        assert heartbeat["reasoning"] == "think_recaption"
        assert heartbeat["quality"] == "full-50"
        assert heartbeat["nativeContext"] == 22800
        assert heartbeat["heartbeat"] is True
        assert heartbeat["workerPid"] > 0
        assert heartbeat["elapsedSeconds"] >= 0

        progress = runner.DiffusionProgress(
            50, status, "captured-think-recaption", 22800, "a" * 64
        )
        progress.__enter__()
        progress.update(7)
        sampling = json.loads(status.read_text(encoding="utf-8"))
        assert sampling["stage"] == "sampling"
        assert sampling["step"] == 7 and sampling["steps"] == 50
        assert sampling["quality"] == "full-50"
        assert sampling["nativeContext"] == 22800
        assert sampling["reasoningSha256"] == "a" * 64
        progress.__exit__(None, None, None)
        decoding = json.loads(status.read_text(encoding="utf-8"))
        assert decoding["stage"] == "decoding"
        assert decoding["quality"] == "full-50"
        assert decoding["reasoningSha256"] == "a" * 64

    tree = ast.parse(runner_source)
    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "generate_image"
    ]
    assert len(calls) == 3
    normal_calls = [call for call in calls if keyword_literal(call, "bot_task") == "think_recaption"]
    resumed_calls = [call for call in calls if keyword_literal(call, "bot_task") == "auto"]
    assert len(normal_calls) == 2
    assert len(resumed_calls) == 1
    resumed_call = resumed_calls[0]
    for normal_call in normal_calls:
        assert keyword_literal(normal_call, "image_size") == "auto"
        assert keyword_literal(normal_call, "use_system_prompt") == "en_unified"
        assert keyword_literal(normal_call, "infer_align_image_size") is True
    resumed_size = next(k.value for k in resumed_call.keywords if k.arg == "image_size")
    resumed_cot = next(k.value for k in resumed_call.keywords if k.arg == "cot_text")
    assert isinstance(resumed_size, ast.Name) and resumed_size.id == "resumed_image_size"
    assert isinstance(resumed_cot, ast.Name) and resumed_cot.id == "resumed_reasoning"
    assert keyword_literal(resumed_call, "use_system_prompt") == "en_unified"
    assert keyword_literal(resumed_call, "infer_align_image_size") is True
    for call in calls:
        assert all(keyword.arg != "max_new_tokens" for keyword in call.keywords)
        assert all(keyword.arg != "use_taylor_cache" for keyword in call.keywords)
        assert all(keyword.arg != "diff_infer_steps" for keyword in call.keywords)

    with tempfile.TemporaryDirectory(prefix="dstudio-reasoning-resume-") as temporary:
        log = Path(temporary) / "max.log"
        transcript = "<think>complete analysis</think><recaption>complete prompt</recaption>"
        log.write_text(f"Assistant: {transcript}<answer>\n", encoding="utf-8")
        loaded, digest = runner.load_completed_reasoning(log)
        assert loaded == transcript
        assert len(digest) == 64
        assert runner.parse_resume_image_size("832x1216") == (832, 1216)
        for invalid in ("", "1216", "12x1216", "832X1216", "832x99999"):
            try:
                runner.parse_resume_image_size(invalid)
            except runner.EditError:
                pass
            else:
                raise AssertionError(f"invalid resume size was accepted: {invalid!r}")

        prompt = Path(temporary) / "prompt.txt"
        source = Path(temporary) / "source.png"
        artifact = Path(temporary) / "reasoning.json"
        prompt.write_text("edit the supplied source", encoding="utf-8")
        source.write_bytes(b"bound-source-bytes")
        artifact_digest = runner.write_reasoning_artifact(
            artifact, transcript, (832, 1216), prompt, [str(source)], 7, 22800, 12.5
        )
        artifact_payload = json.loads(artifact.read_text(encoding="utf-8"))
        assert artifact_payload["schemaVersion"] == 4
        assert artifact_payload["quality"]["mpsRuntime"] == (
            runner.expected_mps_runtime_profile()
        )
        artifact_reasoning, loaded_digest, loaded_size = runner.load_reasoning_artifact(
            artifact, prompt, [str(source)], 7
        )
        assert artifact_reasoning == transcript
        assert loaded_digest == artifact_digest
        assert loaded_size == (832, 1216)
        prompt.write_text("different prompt", encoding="utf-8")
        try:
            runner.load_reasoning_artifact(artifact, prompt, [str(source)], 7)
        except runner.EditError:
            pass
        else:
            raise AssertionError("reasoning artifact bypassed its prompt/source/seed binding")

        class FakeModel:
            def prepare_model_inputs(self, *args, **kwargs):
                return {"args": args, "kwargs": kwargs}

        fake = FakeModel()
        runner.install_reasoning_capture(fake)
        delegated = fake.prepare_model_inputs("text", mode="gen_text")
        assert delegated["kwargs"]["mode"] == "gen_text"
        try:
            fake.prepare_model_inputs(
                mode="gen_image", cot_text=[transcript], image_size=(832, 1216)
            )
        except runner.ReasoningCaptured as captured:
            assert captured.reasoning == transcript
            assert captured.image_size == (832, 1216)
        else:
            raise AssertionError("reasoning phase did not stop before diffusion allocation")
    return runner


def output_sanity_gate(ideogram, hunyuan) -> None:
    from PIL import Image, ImageDraw

    with tempfile.TemporaryDirectory(prefix="dstudio-image-conformance-") as temporary:
        root = Path(temporary)
        valid = root / "gradient.png"
        flat = root / "flat.png"
        sparse = root / "sparse-astronomy.png"
        gradient = Image.new("RGB", (512, 512))
        gradient.putdata(
            [(x % 256, x % 256, x % 256) for _y in range(512) for x in range(512)]
        )
        gradient.save(valid, format="PNG")
        Image.new("RGB", (512, 512), (0, 0, 0)).save(flat, format="PNG")
        night = Image.new("RGB", (512, 512), (0, 0, 0))
        draw = ImageDraw.Draw(night)
        draw.ellipse((235, 242, 277, 270), fill=(185, 160, 118))
        draw.ellipse((220, 250, 292, 262), outline=(110, 98, 82), width=3)
        for x, y, value in ((31, 40, 92), (440, 73, 155), (90, 401, 76), (381, 339, 120)):
            draw.point((x, y), fill=(value, value, value))
        night.save(sparse, format="PNG")
        assert ideogram.inspect_output(valid, (512, 512))["lumaEntropy"] >= 0.5
        assert hunyuan.inspect_output(valid)["lumaEntropy"] >= 0.5
        ideogram_sparse = ideogram.inspect_output(sparse, (512, 512))
        hunyuan_sparse = hunyuan.inspect_output(sparse)
        assert ideogram_sparse["lumaEntropy"] < 0.5
        assert ideogram_sparse["significantLumaFraction"] >= 0.002
        assert hunyuan_sparse["significantLumaFraction"] >= 0.002
        for inspect, args in (
            (ideogram.inspect_output, (flat, (512, 512))),
            (hunyuan.inspect_output, (flat,)),
        ):
            try:
                inspect(*args)
            except (ideogram.IdeogramError, hunyuan.EditError):
                pass
            else:
                raise AssertionError("flat image bypassed output sanity gate")


def fixture_geometry_gate(ideogram, hunyuan) -> None:
    """Contract generation and editing must be realistic but distinguishable."""
    assert ideogram.TEST_ASPECT_SIZES["16:9"] == (640, 360)
    assert ideogram.TEST_ASPECT_SIZES["4:3"] == (640, 480)
    source = ideogram.build_test_png(*ideogram.TEST_ASPECT_SIZES["4:3"])
    edited = hunyuan.build_test_png(*ideogram.TEST_ASPECT_SIZES["4:3"])
    assert source != edited
    with tempfile.TemporaryDirectory(prefix="dstudio-image-fixture-") as temporary:
        path = Path(temporary) / "source.png"
        path.write_bytes(source)
        assert hunyuan.test_fixture_size(str(path)) == (640, 480)


if __name__ == "__main__":
    ideogram = ideogram_gate()
    hunyuan = hunyuan_gate()
    output_sanity_gate(ideogram, hunyuan)
    fixture_geometry_gate(ideogram, hunyuan)
    print("image inference conformance: pass")
