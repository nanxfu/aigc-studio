#!/usr/bin/env python3
"""P-01：Z-Image Diffusers GGUF 最小加载 / 出图 / 显存探针。

在**单卡 4090（建议）或 3090** 上运行，不依赖 Host / Worker 协议：

  pip install "gguf>=0.10.0"
  export HF_HOME=/workspace/hf
  python tools/probes/zimage_gguf_probe.py --te-mode base
  python tools/probes/zimage_gguf_probe.py --te-mode fp8

``base`` 用原仓 BF16 Text Encoder（约 7.49 GiB）；
``fp8`` 用 ``Qwen/Qwen3-4B-FP8``（约 4.83 GiB）替换 Text Encoder。
两次输出分别保存，便于同 Seed 画质/中文排字盲测。

脚本只读 HuggingFace 缓存，不写模型仓库；输出目录由 ``--output-dir`` 控制。
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import sys
import time
from pathlib import Path


DEFAULT_BASE = "Tongyi-MAI/Z-Image-Turbo"
DEFAULT_GGUF_REPO = "unsloth/Z-Image-Turbo-GGUF"
DEFAULT_GGUF_FILE = "z-image-turbo-Q4_K_M.gguf"
DEFAULT_TE_REPO = "Qwen/Qwen3-4B-FP8"
DEFAULT_PROMPT = (
    'A minimalist travel poster with the Chinese headline "山城夜色" and the English '
    'subtitle "NIGHT CITY", layered neon reflections on wet stone stairs, cinematic '
    'lighting, crisp typography, high detail'
)


def now() -> float:
    return time.perf_counter()


def elapsed(started: float) -> float:
    return round(now() - started, 2)


def gb_of(path: Path) -> float:
    return round(path.stat().st_size / (1024**3), 2)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Z-Image GGUF + Text Encoder probe")
    parser.add_argument("--base", default=DEFAULT_BASE, help="原始 Diffusers 仓库")
    parser.add_argument("--gguf-repo", default=DEFAULT_GGUF_REPO)
    parser.add_argument("--gguf-file", default=DEFAULT_GGUF_FILE)
    parser.add_argument("--gguf-path", default="", help="本地 GGUF 文件；给出时跳过下载")
    parser.add_argument(
        "--te-mode",
        choices=("base", "fp8"),
        default="base",
        help="base=原仓 BF16 Text Encoder；fp8=Qwen3-4B-FP8",
    )
    parser.add_argument("--te-repo", default=DEFAULT_TE_REPO)
    parser.add_argument("--output-dir", default=".tmp/probes/zimage")
    parser.add_argument("--steps", type=int, default=9)
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--cpu-offload", action="store_true", help="启用 model cpu offload")
    parser.add_argument("--skip-warm", action="store_true", help="只跑冷启一张")
    parser.add_argument("--json", default="", help="额外写一份 JSON 摘要")
    return parser.parse_args()


def require_runtime() -> dict:
    try:
        import diffusers
        import torch
        import transformers
    except Exception as exc:  # noqa: BLE001 - 依赖缺失时给出可操作错误
        raise SystemExit(
            "缺少 torch / diffusers / transformers：请在 Worker GPU 镜像或已安装依赖的 4090 环境运行"
        ) from exc

    try:
        import gguf
    except Exception as exc:  # noqa: BLE001
        raise SystemExit('缺少 gguf：先执行 `pip install "gguf>=0.10.0"`') from exc

    if not torch.cuda.is_available():
        raise SystemExit("当前环境没有 CUDA GPU；本探针需要单卡 4090 / 3090")

    capability = torch.cuda.get_device_capability(0)
    return {
        "torch": torch.__version__,
        "diffusers": diffusers.__version__,
        "transformers": transformers.__version__,
        "gguf": getattr(gguf, "__version__", "unknown"),
        "gpu": torch.cuda.get_device_name(0),
        "compute_capability": f"{capability[0]}.{capability[1]}",
        "vram_total_mb": round(torch.cuda.get_device_properties(0).total_memory / (1024**2)),
    }


def resolve_gguf(args: argparse.Namespace) -> tuple[Path, float]:
    if args.gguf_path:
        path = Path(args.gguf_path).expanduser().resolve()
        if not path.is_file():
            raise SystemExit(f"GGUF 文件不存在：{path}")
        return path, 0.0

    from huggingface_hub import hf_hub_download

    started = now()
    path = Path(
        hf_hub_download(
            repo_id=args.gguf_repo,
            filename=args.gguf_file,
            token=os.environ.get("HF_TOKEN") or None,
        )
    )
    return path, elapsed(started)


def load_quantized_transformer(args: argparse.Namespace, gguf_path: Path):
    import torch
    from diffusers import GGUFQuantizationConfig, ZImageTransformer2DModel

    kwargs = {
        "config": args.base,
        "subfolder": "transformer",
        "quantization_config": GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
    }
    signature = inspect.signature(ZImageTransformer2DModel.from_single_file)
    if "dtype" in signature.parameters:
        kwargs["dtype"] = torch.bfloat16
    else:
        kwargs["torch_dtype"] = torch.bfloat16
    return ZImageTransformer2DModel.from_single_file(str(gguf_path), **kwargs)


def load_fp8_text_encoder(args: argparse.Namespace):
    """加载 Qwen3-4B-FP8，并把 base model 交给 ZImagePipeline。

    Qwen3-4B-FP8 是 ``Qwen3ForCausalLM`` 格式；Z-Image 需要的是其中的
    ``Qwen3Model`` 主干。保留 CausalLM 对象直到出图结束，避免 lm_head 提前释放
    造成引用悬空。
    """
    from transformers import Qwen3ForCausalLM

    # torch 2.6 无法直接用 float8_e4m3fn storage 反序列化该仓库；
    # transformers 的 "auto" 会按 quantization_config 选择可运行的 FP8/BF16 混合路径。
    kwargs = {
        "dtype": "auto",
        "device_map": "cuda",
        "token": os.environ.get("HF_TOKEN") or None,
    }
    try:
        causal = Qwen3ForCausalLM.from_pretrained(args.te_repo, **kwargs)
    except TypeError:
        kwargs.pop("dtype", None)
        kwargs["torch_dtype"] = "auto"
        causal = Qwen3ForCausalLM.from_pretrained(args.te_repo, **kwargs)
    return causal.model, causal


def build_pipeline(args: argparse.Namespace, gguf_path: Path):
    import torch
    from diffusers import ZImagePipeline

    transformer = load_quantized_transformer(args, gguf_path)
    te_owner = None
    text_encoder = None
    if args.te_mode == "fp8":
        text_encoder, te_owner = load_fp8_text_encoder(args)

    kwargs = {"torch_dtype": torch.bfloat16}
    if text_encoder is not None:
        kwargs["text_encoder"] = text_encoder
    try:
        pipe = ZImagePipeline.from_pretrained(args.base, transformer=transformer, **kwargs)
    except TypeError:
        # diffusers 新版把 torch_dtype 改名为 dtype 时仍能探针运行。
        kwargs.pop("torch_dtype", None)
        kwargs["dtype"] = torch.bfloat16
        pipe = ZImagePipeline.from_pretrained(args.base, transformer=transformer, **kwargs)

    pipe._probe_te_owner = te_owner  # 保持 CausalLM 引用存活
    if args.cpu_offload:
        pipe.enable_model_cpu_offload()
    else:
        pipe.to("cuda")
    return pipe


def generate_once(pipe, args: argparse.Namespace, output: Path, seed: int) -> dict:
    import torch

    output.parent.mkdir(parents=True, exist_ok=True)
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    kwargs = {
        "prompt": args.prompt,
        "width": args.width,
        "height": args.height,
        "num_inference_steps": args.steps,
        "generator": torch.Generator(device="cuda").manual_seed(seed),
    }
    signature = inspect.signature(pipe.__call__)
    if "guidance_scale" in signature.parameters:
        kwargs["guidance_scale"] = 0.0

    started = now()
    result = pipe(**kwargs)
    seconds = elapsed(started)
    image = result.images[0]
    image.save(output)
    return {
        "seconds": seconds,
        "peak_vram_mb": round(torch.cuda.max_memory_allocated() / (1024**2)),
        "output": str(output),
        "bytes": output.stat().st_size,
        "width": image.width,
        "height": image.height,
    }


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    summary_path = Path(args.json).expanduser().resolve() if args.json else output_dir / "summary.json"

    runtime = require_runtime()
    capability = tuple(int(part) for part in runtime["compute_capability"].split("."))
    if args.te_mode == "fp8" and capability < (8, 9):
        raise SystemExit(
            f"FP8 Text Encoder 需要 sm_89+；当前 {runtime['gpu']} 是 {runtime['compute_capability']}"
        )

    gguf_path, gguf_download_seconds = resolve_gguf(args)
    summary: dict = {
        "probe": "P-01",
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "runtime": runtime,
        "args": vars(args),
        "gguf": {
            "repo": args.gguf_repo,
            "file": args.gguf_file,
            "path": str(gguf_path),
            "size_gib": gb_of(gguf_path),
            "download_seconds": gguf_download_seconds,
        },
        "text_encoder": {
            "mode": args.te_mode,
            "repo": args.base if args.te_mode == "base" else args.te_repo,
        },
    }

    exit_code = 0
    try:
        load_started = now()
        pipe = build_pipeline(args, gguf_path)
        summary["load_seconds"] = elapsed(load_started)
        summary["text_encoder"]["class"] = type(getattr(pipe, "text_encoder", None)).__name__
        summary["text_encoder"]["dtype"] = str(getattr(getattr(pipe, "text_encoder", None), "dtype", None))

        cold = generate_once(pipe, args, output_dir / "cold.png", args.seed)
        summary["cold"] = cold
        if not args.skip_warm:
            warm = generate_once(pipe, args, output_dir / "warm.png", args.seed + 1)
            summary["warm"] = warm
    except Exception as exc:  # noqa: BLE001 - 探针要记录负面结果，而不是只留 traceback
        exit_code = 1
        summary["error"] = {"type": type(exc).__name__, "message": str(exc)}

    summary["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"\n[P-01] summary: {summary_path}", file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
