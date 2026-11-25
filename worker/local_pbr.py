"""本地 PBR 子进程：stdin JSON 输入，stdout JSON 事件，贴图写入受控临时目录。"""
import json
import os
import sys
from pathlib import Path


def emit(event, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


def main():
    import torch
    if "--probe" in sys.argv:
        # 除 CUDA 外同时验证两条管线可导入，避免损坏环境命中就绪缓存。
        from diffusers import MarigoldIntrinsicsPipeline, MarigoldNormalsPipeline  # noqa: F401
        emit("result", cuda=torch.cuda.is_available())
        return

    from PIL import Image
    from diffusers import MarigoldIntrinsicsPipeline, MarigoldNormalsPipeline

    spec = json.load(sys.stdin)
    if not torch.cuda.is_available():
        raise RuntimeError("本地 CUDA 不可用，请切换云端。")
    gpu_index = int(spec["gpuIndex"])
    torch.cuda.set_device(gpu_index)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    source_path = Path(spec["sourcePath"])
    output_dir = Path(spec["outputDir"])
    results = []

    def save(channel, image):
        path = output_dir / f"{channel}.png"
        image.save(path, format="PNG")
        results.append({"channel": channel, "path": str(path), "width": image.width, "height": image.height})

    def load(pipeline_cls, repo_key, revision_key):
        emit("stage", stage="loading")
        pipeline = pipeline_cls.from_pretrained(
            spec[repo_key], revision=spec[revision_key], variant="fp16",
            torch_dtype=torch.float16, cache_dir=spec["modelDir"],
        )
        # 单卡顺序运行，两次推理之间释放模型；CPU offload 压低本机显存占用。
        pipeline.enable_model_cpu_offload(gpu_id=gpu_index)
        return pipeline

    with Image.open(source_path) as source:
        rgb = source.convert("RGB")
    try:
        iid = load(MarigoldIntrinsicsPipeline, "intrinsicsRepo", "intrinsicsRevision")
        emit("stage", stage="inferring")
        prediction = iid(rgb, num_inference_steps=int(spec["steps"]))
        images = iid.image_processor.visualize_intrinsics(prediction.prediction, iid.target_properties)[0]
        save("albedo", images["albedo"])
        save("roughness", images["roughness"])
        save("metallic", images["metallicity"] if "metallicity" in images else images["metallic"])
        del images, prediction, iid
        import gc
        gc.collect()
        torch.cuda.empty_cache()

        normals = load(MarigoldNormalsPipeline, "normalsRepo", "normalsRevision")
        emit("stage", stage="inferring")
        prediction = normals(rgb, num_inference_steps=int(spec["steps"]))
        save("normal", normals.image_processor.visualize_normals(prediction.prediction)[0])
        del prediction, normals
        emit("result", results=results)
    finally:
        rgb.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error)
        code = "oom" if "out of memory" in message.lower() else "load_failed"
        emit("error", code=code, message=message[:600])
        sys.exit(1)
