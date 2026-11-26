#!/usr/bin/env python3
# Derived from LakonLab demo/example_pih3_pipeline.py and demo/gradio_pih3.py.
# Copyright 2026 Hansheng Chen. Licensed under Apache-2.0.
# See ../../licenses/LakonLab-Apache-2.0.txt.
# Modified for headless local-snapshot benchmarking, CPU-first quantization,
# explicit encoder placement and separate load/warm-request measurements.
"""Headless pi-H3 benchmark using LakonLab's DWD pipeline and quantization.

plan prints the test recipe without ML imports or downloads.
run uses local model snapshots and a pinned LakonLab checkout on one/two GPUs.
The second GPU hosts prompt encoding; it does not shard the denoiser.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


LAKONLAB_REVISION = "2ee2b334374ec91b7cee371a85a524bf4ba644d3"
BASE_REVISION = "1a0ef5e65b639e84af81d883817968532180e9c7"
SHARED_REVISION = "12253298adb81e36757eabebb81d2ba1c0cc70cc"
ADAPTER_REVISION = "4a864589b0fac3d14768f932c930c4dcf1a17b56"
DEFAULT_PROMPT = (
    "integrated_multimodal_description: A red fox walks through a snowy pine forest at dawn. "
    "The camera tracks beside it, natural motion. overall_soundscape: Snow crunches under its paws, "
    "gentle wind and distant birds. non_diegetic_music: N/A"
)


def plan(args) -> dict:
    return {
        "model": f"Lakonik/pi-H3/pi_h3_{args.steps}step_dwd_adapter",
        "lakonlab_revision": LAKONLAB_REVISION,
        "base_revision": BASE_REVISION, "shared_revision": SHARED_REVISION,
        "adapter_revision": ADAPTER_REVISION,
        "geometry": {"width": args.width, "height": args.height, "frames": args.frames, "fps": 24},
        "quantization": args.quantization, "attention": args.attention,
        "gpus": args.gpus.split(","), "text_placement": args.text_placement,
        "steps": args.steps, "video_shift": 12.0, "audio_shift": 3.0,
        "max_raw_t": {2: 0.93, 4: 0.96}[args.steps], "final_step_size_scale": 0.6,
        "warmup_requests": 1, "timed_requests": args.repeat,
        "inference_completed": False,
        "limitations": [
            "Local snapshot contents must match the recorded revisions; this probe does not fetch weights",
            "Two GPUs separate encoder and denoiser; denoiser must fit its own GPU",
            "FP8 requires SM89+; INT8 ConvRot uses LakonLab's inference kernels",
            "The streamed text-encoder option is an unverified placement experiment",
            "This initial probe accepts text-to-audio-video only",
        ],
    }


def local_index(args, out: Path) -> Path:
    """Replace every remote component source with a named local snapshot."""
    base, shared = Path(args.base_dir).resolve(), Path(args.shared_dir).resolve()
    index = json.loads((base / "modular_model_index.json").read_text(encoding="utf-8"))
    for name, value in index.items():
        if name.startswith("_") or not isinstance(value, list) or len(value) < 3 or not isinstance(value[2], dict):
            continue
        spec = value[2]
        repo = spec.get("pretrained_model_name_or_path")
        if repo == "multimodalart/MiniMax-H3-Pruned":
            source = base
        elif repo == "MiniMaxAI/MiniMax-H3":
            source = shared
        else:
            raise ValueError(f"Unknown component source for {name}: {repo}")
        spec["pretrained_model_name_or_path"] = str(source)
        spec["revision"] = None
    resolved = out / "pipeline"
    resolved.mkdir()
    (resolved / "modular_model_index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    return resolved


def run(args, out: Path, report: dict) -> None:
    if not all((args.lakonlab_dir, args.base_dir, args.shared_dir, args.adapter_dir)):
        raise ValueError("run needs --lakonlab-dir, --base-dir, --shared-dir and --adapter-dir")
    checkout = Path(args.lakonlab_dir).resolve()
    head = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"], check=True,
                          capture_output=True, text=True).stdout.strip()
    if head != LAKONLAB_REVISION:
        raise ValueError(f"Expected LakonLab {LAKONLAB_REVISION}; got {head}")
    sys.path.insert(0, str(checkout))
    os.environ["CUDA_VISIBLE_DEVICES"] = args.gpus
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    # Heavy imports are confined to explicit GPU execution.
    import torch
    import diffusers
    import transformers
    from accelerate import cpu_offload
    from lakonlab.models.architectures import RGBColorEncoder
    from lakonlab.models.architectures.diffusers.attention import default_attention_backend, set_attention_backends
    from lakonlab.models.architectures.diffusers.minimax_h3 import MiniMaxH3SolAttnProcessor
    from lakonlab.models.diffusions.schedulers import FlowEulerODEScheduler
    from lakonlab.ops import quantize_frozen_linears
    from lakonlab.pipelines.pipeline_minimax_h3 import MiniMaxH3BlocksMod, MiniMaxH3DWDBlocks
    from lakonlab.pipelines.utils import load_lakonlab_adapter
    from lakonlab.utils.io_utils import FileClient, rgb_to_yuv420p, save_video_audio
    from h3_sdcpp_probe import validate_video

    count = len(args.gpus.split(","))
    if not torch.cuda.is_available() or torch.cuda.device_count() != count:
        raise ValueError("Selected CUDA devices are unavailable")
    capabilities = [torch.cuda.get_device_capability(i) for i in range(count)]
    if any(cc < (8, 0) for cc in capabilities):
        raise ValueError("This initial pi-H3 BF16 probe requires Ampere or newer; it is not a T4 recipe")
    if args.quantization == "fp8" and any(cc < (8, 9) for cc in capabilities):
        raise ValueError("LakonLab FP8 requires SM89+; on RTX 3090 use --quantization int8_convrot")
    if args.attention == "sol" and any(cc not in ((9, 0), (10, 0), (10, 3), (12, 0)) for cc in capabilities[:1]):
        raise ValueError("The pinned pi-H3 Sol processor supports Hopper/Blackwell; on 3090/4090 use dense")
    for i in range(count):
        torch.cuda.reset_peak_memory_stats(i)
    report["runtime"] = {"torch": torch.__version__, "diffusers": diffusers.__version__,
                         "transformers": transformers.__version__,
                         "gpus": [{"name": torch.cuda.get_device_name(i), "cc": capabilities[i],
                                   "total_gib": torch.cuda.get_device_properties(i).total_memory / 1024**3}
                                  for i in range(count)]}
    started = time.perf_counter()
    index_dir = local_index(args, out)
    blocks = MiniMaxH3DWDBlocks()
    pipe = blocks.init_pipeline(str(index_dir))
    # As in the official app, text encoding is a separate pipeline.
    pipe.load_components(names=["text_encoder", "tokenizer", "processor", "vae", "audio_vae", "transformer"],
                         dtype=torch.bfloat16, trust_remote_code=True, local_files_only=True)
    adapter_name = f"pi_h3_{args.steps}step_dwd_adapter"
    load_lakonlab_adapter(pipe, str(Path(args.adapter_dir).resolve()), subfolder=adapter_name,
                         local_files_only=True, use_safetensors=True)
    text_blocks = MiniMaxH3BlocksMod()
    text_blocks = MiniMaxH3BlocksMod.from_blocks_dict(
        {name: text_blocks.sub_blocks[name] for name in ("before_encode", "text_encoder")})
    text_pipe = text_blocks.init_pipeline(str(index_dir))
    text_pipe.update_components(text_encoder=pipe.text_encoder, tokenizer=pipe.tokenizer, processor=pipe.processor)
    # Drop text execution from the DWD blocks. The shared text module stays CPU until placed below.
    blocks.sub_blocks.pop("text_encoder")
    generation = blocks.init_pipeline(str(index_dir))
    generation.update_components(transformer=pipe.transformer, vae=pipe.vae, audio_vae=pipe.audio_vae)
    pipe.unload_components("text_encoder")
    generation.transformer.requires_grad_(False)
    # Quantize on CPU one layer at a time BEFORE putting the complete denoiser on GPU.
    quantize_frozen_linears(generation.transformer, type=args.quantization,
                           exclude_keys=["lora", "adaln_proj", "norm_out", "proj_out", "dwd_linear_head"])
    text_pipe.text_encoder.requires_grad_(False)
    quantize_frozen_linears(text_pipe.text_encoder, type=args.quantization, exclude_keys=["lm_head"])
    generation.transformer.to(device="cuda:0")
    generation.audio_vae.to(device="cuda:0")
    # Text-only DWD never encodes keyframes or decodes through the video VAE; keep it on CPU.
    text_device = "cuda:1" if count == 2 else "cuda:0"
    if args.text_placement == "streamed":
        cpu_offload(text_pipe.text_encoder, execution_device=torch.device(text_device))
    else:
        text_pipe.text_encoder.to(device=text_device)
    del pipe
    torch.cuda.empty_cache()
    dense = default_attention_backend("dense")
    set_attention_backends(generation.transformer, backend=dense,
                           overrides={"self.dwd_pixel_refiner": default_attention_backend("varlen")})
    if args.attention == "sol":
        for block in generation.transformer.transformer_blocks[2:]:
            block.attn.set_processor(MiniMaxH3SolAttnProcessor())
            block.attn.set_attention_backend(default_attention_backend("short"))
    max_t = {2: 0.93, 4: 0.96}[args.steps]
    generation.update_components(
        scheduler=FlowEulerODEScheduler(num_train_timesteps=1, shift=12.0, max_raw_t=max_t, final_step_size_scale=0.6),
        audio_scheduler=FlowEulerODEScheduler(num_train_timesteps=1, shift=3.0, max_raw_t=max_t, final_step_size_scale=0.6))
    color = RGBColorEncoder(use_affine_norm=True, mean=(-0.03, -0.088, -0.188), std=(0.458, 0.448, 0.45)).to("cuda:0")
    report["load_and_quantize_seconds"] = round(time.perf_counter() - started, 3)
    report["load_peak_allocated_mib"] = [torch.cuda.max_memory_allocated(i) / 1024**2 for i in range(count)]
    report["attention_backend"] = str(dense)
    report["runs"] = []
    with torch.inference_mode():
        for index in range(args.repeat + 1):
            for i in range(count):
                torch.cuda.reset_peak_memory_stats(i)
                torch.cuda.synchronize(i)
            begin = time.perf_counter()
            with torch.cuda.device(text_device):
                text = text_pipe(prompt=args.prompt, height=args.height, width=args.width, num_frames=args.frames,
                                 output=["prompt_embeds", "text_token_tags"])
            for i in range(count):
                torch.cuda.synchronize(i)
            encoded = time.perf_counter()
            result = generation(prompt_embeds=text["prompt_embeds"].to("cuda:0"),
                                text_token_tags=text["text_token_tags"], height=args.height, width=args.width,
                                num_frames=args.frames, num_inference_steps=args.steps,
                                generator=torch.Generator().manual_seed(args.seed),
                                output=["dwd_pixels", "audio", "sampling_rate"])
            video = color.decode(result.pop("dwd_pixels")).div_(2).add_(0.5).clamp_(0, 1).transpose(1, 2)
            torch.cuda.synchronize(0)
            predicted = time.perf_counter()
            file = out / ("warmup.mp4" if index == 0 else f"run-{index:02}.mp4")
            save_video_audio(rgb_to_yuv420p(video[0]).cpu().numpy(), result["audio"][0].float().cpu().numpy(),
                             str(file), FileClient.infer_client(uri=str(file)), 24, result["sampling_rate"],
                             pix_fmt="yuv420p", options={"preset": "veryfast", "crf": "18"})
            finished = time.perf_counter()
            report["runs"].append({"warmup": index == 0, "seed": args.seed,
                                   "text_seconds": round(encoded - begin, 3),
                                   "denoise_dwd_audio_seconds": round(predicted - encoded, 3),
                                   "mp4_seconds": round(finished - predicted, 3),
                                   "total_seconds": round(finished - begin, 3),
                                   "peak_allocated_mib": [torch.cuda.max_memory_allocated(i) / 1024**2 for i in range(count)],
                                   "peak_reserved_mib": [torch.cuda.max_memory_reserved(i) / 1024**2 for i in range(count)],
                                   "artifact": validate_video(file, args)})
            (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            del text, result, video
    report["warm_median_seconds"] = statistics.median(r["total_seconds"] for r in report["runs"] if not r["warmup"])
    report["inference_completed"] = True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "run"))
    parser.add_argument("--gpus", default="0,1")
    parser.add_argument("--steps", type=int, choices=(2, 4), default=4)
    parser.add_argument("--quantization", choices=("fp8", "int8_convrot"), default="fp8")
    parser.add_argument("--attention", choices=("dense", "sol"), default="dense")
    parser.add_argument("--text-placement", choices=("resident", "streamed"), default="resident")
    parser.add_argument("--width", type=int, default=832)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--frames", type=int, default=124)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--lakonlab-dir", default="")
    parser.add_argument("--base-dir", default="")
    parser.add_argument("--shared-dir", default="")
    parser.add_argument("--adapter-dir", default="")
    parser.add_argument("--output-dir", default=".tmp/probes/pih3")
    args = parser.parse_args()
    devices = args.gpus.split(",")
    if not 1 <= len(devices) <= 2 or len(set(devices)) != len(devices) or any(not d.strip() for d in devices):
        parser.error("Select one or two distinct devices with --gpus 0 or --gpus 0,1")
    if args.width < 32 or args.height < 32 or args.width % 32 or args.height % 32:
        parser.error("Canvas dimensions must be positive multiples of 32")
    if not 22 <= args.frames <= 362 or (args.frames - 5) % 17 or args.repeat < 1:
        parser.error("frames must follow 17n+5 between 22 and 362; repeat must be positive")
    report = plan(args)
    if args.action == "plan":
        print(json.dumps(report, indent=2))
        return 0
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    out = Path(args.output_dir).resolve() / f"{stamp}-{args.steps}step-{args.quantization}"
    out.mkdir(parents=True, exist_ok=False)
    report["status"] = "failed"
    try:
        run(args, out, report)
        report["status"] = "passed"
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
        print(f"Report: {out / 'report.json'}")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
