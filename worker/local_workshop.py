"""本机 CUDA 工坊子进程：stdin JSON，stdout 逐行 JSON 事件。

PBR 沿用本地 Marigold 双管线（CPU offload 压显存）；深度 / IC-Light 直接复用
``worker/inference/game_ops.py`` 中已由云端真机验证的实现，保证本机与云端的
深度方向、OpenGL 法线约定和通道编码同源。
"""

from __future__ import annotations

import gc
import json
import os
import sys
from pathlib import Path

WORKER_ROOT = Path(__file__).resolve().parent
REPO_ROOT = WORKER_ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def emit(event, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


def _pbr_channels():
    return ("albedo", "normal", "roughness", "metallic")


def _depth_channels():
    return ("depth", "normal")


def _relight_channels():
    return ("relit",)


def run_pbr(rgb, spec):
    from diffusers import MarigoldIntrinsicsPipeline, MarigoldNormalsPipeline
    import torch

    def load(pipeline_cls, repo_key, revision_key):
        emit("stage", stage="loading")
        pipeline = pipeline_cls.from_pretrained(
            spec[repo_key],
            revision=spec[revision_key],
            variant="fp16",
            torch_dtype=torch.float16,
            cache_dir=spec["modelDir"],
        )
        pipeline.enable_model_cpu_offload(gpu_id=int(spec["gpuIndex"]))
        return pipeline

    iid = load(MarigoldIntrinsicsPipeline, "intrinsicsRepo", "intrinsicsRevision")
    try:
        emit("stage", stage="inferring")
        prediction = iid(rgb, num_inference_steps=max(1, int(spec.get("steps") or 4)))
        images = iid.image_processor.visualize_intrinsics(prediction.prediction, iid.target_properties)[0]
        produced = {
            "albedo": images["albedo"],
            "roughness": images["roughness"],
            "metallic": images.get("metallicity") if images.get("metallicity") is not None else images["metallic"],
        }
        del images, prediction
    finally:
        del iid
        gc.collect()
        torch.cuda.empty_cache()

    normals = load(MarigoldNormalsPipeline, "normalsRepo", "normalsRevision")
    try:
        emit("stage", stage="inferring")
        prediction = normals(rgb, num_inference_steps=max(1, int(spec.get("steps") or 4)))
        produced["normal"] = normals.image_processor.visualize_normals(prediction.prediction)[0]
        del prediction
    finally:
        del normals
        gc.collect()
        torch.cuda.empty_cache()
    return produced


def run_depth(image, spec):
    from inference.game_ops import estimate_depth

    emit("stage", stage="inferring")
    return estimate_depth(
        image,
        repo_id=str(spec.get("modelRepo") or "depth-anything/DA3MONO-LARGE"),
        device=f"cuda:{int(spec['gpuIndex'])}",
    )


def run_relight(image, spec):
    from inference.game_ops import run_ic_light

    options = spec.get("options") if isinstance(spec.get("options"), dict) else {}
    emit("stage", stage="inferring")
    return {
        "relit": run_ic_light(
            image,
            prompt=str(options.get("prompt") or ""),
            steps=max(1, int(spec.get("steps") or 16)),
            guidance=float(options.get("cfg") if options.get("cfg") is not None else 2.0),
            seed=int(options.get("seed") if options.get("seed") is not None else 12345),
            output_edge=int(spec.get("outputEdge") or 768),
            device=f"cuda:{int(spec['gpuIndex'])}",
        )
    }


def main():
    import torch

    if "--probe" in sys.argv:
        import addict  # noqa: F401
        import cv2  # noqa: F401
        import einops  # noqa: F401
        import huggingface_hub  # noqa: F401
        import omegaconf  # noqa: F401
        import scipy  # noqa: F401
        from diffusers import MarigoldIntrinsicsPipeline, MarigoldNormalsPipeline  # noqa: F401
        from inference import game_ops  # noqa: F401

        emit("result", cuda=torch.cuda.is_available())
        return

    from PIL import Image

    spec = json.load(sys.stdin)
    if not torch.cuda.is_available():
        raise RuntimeError("本机 CUDA 不可用，请切换云端。")
    gpu_index = int(spec["gpuIndex"])
    torch.cuda.set_device(gpu_index)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    source_path = Path(spec["sourcePath"])
    output_dir = Path(spec["outputDir"])
    tool = str(spec.get("tool") or "")

    with Image.open(source_path) as source:
        image = source.convert("RGBA" if tool == "relight" else "RGB")
    try:
        if tool == "pbr":
            produced = run_pbr(image, spec)
            channels = _pbr_channels()
        elif tool == "depth":
            produced = run_depth(image, spec)
            channels = _depth_channels()
        elif tool == "relight":
            produced = run_relight(image, spec)
            channels = _relight_channels()
        else:
            raise ValueError(f"不支持的工坊算子：{tool}")

        results = []
        for channel in channels:
            value = produced.get(channel) if isinstance(produced, dict) else None
            if value is None:
                raise RuntimeError(f"{tool} 模型没有返回 {channel} 通道")
            image_out = value if hasattr(value, "save") else Image.fromarray(value)
            path = output_dir / f"{channel}.png"
            image_out.save(path, format="PNG")
            results.append({
                "channel": channel,
                "path": str(path),
                "width": image_out.width,
                "height": image_out.height,
            })
        emit("result", results=results)
    finally:
        image.close()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error)
        code = "oom" if "out of memory" in message.lower() else "load_failed"
        emit("error", code=code, message=message[:800])
        sys.exit(1)
