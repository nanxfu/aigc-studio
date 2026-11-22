"""视频与 DiT 模型量化及推理加速策略（M4.0 基础设施底座）。

设计约束（延续 ``policy.py`` 与 ``docs/GPU_RUNTIME_BASELINE_PLAN.md``）：

1. **顶层零重库导入**：不把 ``torch`` / ``torchao`` / ``diffusers`` / ``sageattention``
   放进模块顶层，保证无卡环境单测与 ``/health`` 探测秒级返回。
2. **硬件架构门控**：遵循 ``docs/INFERENCE_ACCELERATION_RESEARCH.md`` 的真机纪律——
   Turing（``sm_75`` 如 Tesla T4）无原生 BF16 / FP8 Tensor Core 与 FlashAttention-2，
   ``auto`` 模式下自动禁开 FP8 计算量化与 SageAttention；Ampere（``sm_80/86``）与
   Ada/Hopper（``sm_89/90``）按可用包能力渐进开启。
3. **优雅降级**：任一可选加速包（``torchao`` / ``gguf`` / ``sageattention``）未安装时，
   自动回落到安全基线（PyTorch SDPA / BF16 / CPU Offload）并记录明确原因，
   绝不因缺少可选加速库阻塞容器启动。
"""

from __future__ import annotations

import importlib.util
from dataclasses import asdict, dataclass

QUANT_MODES = ("auto", "none", "torchao_fp8", "torchao_int8", "gguf")
ATTN_MODES = ("auto", "sage", "flash2", "sdpa")
STEP_CACHE_MODES = ("auto", "none", "teacache", "first_block")

# 超过此步数阈值才考虑步间缓存（4~8 步蒸馏模型强制禁用，避免糊图/崩帧）。
MIN_STEPS_FOR_CACHE = 12
# 24GB 及以下单卡阈值（MB），触发视频显存自动保护（VAE 分块 + T5 CPU 卸载）。
LOW_VRAM_VIDEO_THRESHOLD_MB = 25000


def _has_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def parse_compute_capability(raw) -> tuple[int, int] | None:  # noqa: ANN001
    """解析 GPU compute capability，支持 ``(8, 9)``、``'8.9'``、``89`` 等写法。"""
    if raw is None:
        return None
    if isinstance(raw, (tuple, list)) and len(raw) >= 2:
        try:
            return (int(raw[0]), int(raw[1]))
        except (TypeError, ValueError):
            return None
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        text = str(raw)
        if "." in text:
            major, minor = text.split(".", 1)
            return (int(major), int(minor[0] if minor else 0))
        num = int(raw)
        if num >= 10:
            return (num // 10, num % 10)
        return None
    text = str(raw).strip().lower()
    if text.startswith("sm_"):
        text = text[3:]
    if "." in text:
        parts = text.split(".", 1)
        try:
            return (int(parts[0]), int(parts[1]))
        except ValueError:
            return None
    if text.isdigit() and len(text) >= 2:
        return (int(text[:-1]), int(text[-1]))
    return None


def probe_accel_capabilities(
    *,
    gpu_cc: tuple[int, int] | str | None = None,
    vram_mb: int | None = None,
    module_probe=None,  # noqa: ANN001 - 单测注入用
) -> dict:
    """探测当前运行环境的量化、注意力与多媒体后处理能力。"""
    has_pkg = module_probe or _has_module
    cc = parse_compute_capability(gpu_cc)

    # 若未显式传入且本机装了 torch + cuda，尝试读取首卡算力与显存。
    if (cc is None or vram_mb is None) and module_probe is None and has_pkg("torch"):
        try:
            import torch

            if torch.cuda.is_available():
                if cc is None:
                    cc = torch.cuda.get_device_capability(0)
                if vram_mb is None:
                    props = torch.cuda.get_device_properties(0)
                    vram_mb = int(props.total_memory // (1024 * 1024))
        except Exception:  # noqa: BLE001 - 探测失败按未知卡处理
            pass

    supports_bf16 = cc is not None and cc >= (8, 0)
    supports_fp8 = cc is not None and cc >= (8, 9)
    supports_fa2 = cc is not None and cc >= (8, 0)
    supports_sage = cc is not None and cc >= (8, 0)

    return {
        "gpu_cc": list(cc) if cc is not None else None,
        "vram_mb": int(vram_mb) if vram_mb is not None else None,
        "hardware": {
            "bf16": supports_bf16,
            "fp8_tensor_core": supports_fp8,
            "flash_attn_2": supports_fa2,
            "sage_attn": supports_sage,
        },
        "packages": {
            "torchao": bool(has_pkg("torchao")),
            "gguf": bool(has_pkg("gguf")),
            "sageattention": bool(has_pkg("sageattention")),
            "flash_attn": bool(has_pkg("flash_attn")),
            "imageio_ffmpeg": bool(has_pkg("imageio_ffmpeg")),
            "av": bool(has_pkg("av")),
            "vtracer": bool(has_pkg("vtracer")),
            "transformers": bool(has_pkg("transformers")),
            "diffusers": bool(has_pkg("diffusers")),
        },
    }


@dataclass(frozen=True)
class VideoAccelPlan:
    """经过硬件门控与降级后的视频/DiT 推理执行计划。"""

    quantization: str
    attention: str
    step_cache: str
    vae_tiling: bool
    vae_slicing: bool
    t5_cpu_offload: bool
    model_cpu_offload: bool
    reasons: tuple[str, ...]

    def to_dict(self) -> dict:
        data = asdict(self)
        data["reasons"] = list(self.reasons)
        return data


def _norm_choice(raw, allowed: tuple[str, ...], default: str) -> str:  # noqa: ANN001
    if raw is None:
        return default
    text = str(raw).strip().lower()
    return text if text in allowed else default


def resolve_video_plan(
    spec: dict | None,
    *,
    capabilities: dict | None = None,
    gpu_cc: tuple[int, int] | str | None = None,
    vram_mb: int | None = None,
) -> VideoAccelPlan:
    """根据模型资产 ``pipeline`` 描述与硬件能力，生成安全的加速执行计划。

    ``spec`` 可包含：
    - ``quantization``: ``auto | none | torchao_fp8 | torchao_int8 | gguf``
    - ``attention``: ``auto | sage | flash2 | sdpa``
    - ``stepCache``: ``auto | none | teacache | first_block``
    - ``distilled``: bool（少步蒸馏模型强制关闭步间缓存）
    - ``steps``: int（<= 12 时禁止步间缓存）
    - ``ggufFile``: str（存在时 ``auto`` 优先选 gguf）
    - ``vaeTiling`` / ``vaeSlicing`` / ``t5CpuOffload`` / ``cpuOffload``: bool
    """
    cfg = spec if isinstance(spec, dict) else {}
    caps = capabilities or probe_accel_capabilities(gpu_cc=gpu_cc, vram_mb=vram_mb)
    hw = caps.get("hardware", {})
    pkgs = caps.get("packages", {})
    eff_vram = vram_mb if vram_mb is not None else caps.get("vram_mb")

    reasons: list[str] = []

    # 1. 权重量化决策
    req_quant = _norm_choice(cfg.get("quantization"), QUANT_MODES, "auto")
    has_gguf_file = bool(str(cfg.get("ggufFile") or "").strip())
    if req_quant == "auto":
        if has_gguf_file and pkgs.get("gguf"):
            quant = "gguf"
            reasons.append("quant:auto->gguf")
        elif pkgs.get("torchao") and hw.get("fp8_tensor_core"):
            quant = "torchao_fp8"
            reasons.append("quant:auto->torchao_fp8(sm89+)")
        elif pkgs.get("torchao") and eff_vram is not None and eff_vram <= LOW_VRAM_VIDEO_THRESHOLD_MB:
            quant = "torchao_int8"
            reasons.append("quant:auto->torchao_int8(low_vram)")
        else:
            quant = "none"
    elif req_quant == "gguf":
        if pkgs.get("gguf"):
            quant = "gguf"
        else:
            quant = "none"
            reasons.append("quant:gguf_unavailable->none")
    elif req_quant in ("torchao_fp8", "torchao_int8"):
        if not pkgs.get("torchao"):
            quant = "none"
            reasons.append(f"quant:{req_quant}_no_torchao->none")
        elif req_quant == "torchao_fp8" and not hw.get("bf16"):
            # Turing (sm_75) 等老卡缺乏原生 FP8/BF16 支持，强开容易数值异常或更慢
            quant = "none"
            reasons.append("quant:fp8_unsupported_arch->none")
        else:
            quant = req_quant
    else:
        quant = "none"

    # 2. 注意力内核决策（带自动回退 sdpa）
    req_attn = _norm_choice(cfg.get("attention"), ATTN_MODES, "auto")
    if req_attn == "auto":
        if pkgs.get("sageattention") and hw.get("sage_attn"):
            attn = "sage"
            reasons.append("attn:auto->sage")
        elif pkgs.get("flash_attn") and hw.get("flash_attn_2"):
            attn = "flash2"
            reasons.append("attn:auto->flash2")
        else:
            attn = "sdpa"
    elif req_attn == "sage":
        if pkgs.get("sageattention") and hw.get("sage_attn"):
            attn = "sage"
        else:
            attn = "sdpa"
            reasons.append("attn:sage_unavailable->sdpa")
    elif req_attn == "flash2":
        if pkgs.get("flash_attn") and hw.get("flash_attn_2"):
            attn = "flash2"
        else:
            attn = "sdpa"
            reasons.append("attn:flash2_unavailable->sdpa")
    else:
        attn = "sdpa"

    # 3. 步间缓存加速决策（蒸馏 / 少步模型强门控关闭）
    req_cache = _norm_choice(cfg.get("stepCache"), STEP_CACHE_MODES, "auto")
    distilled = bool(cfg.get("distilled"))
    raw_steps = cfg.get("steps")
    steps = int(raw_steps) if isinstance(raw_steps, (int, float)) and not isinstance(raw_steps, bool) else None
    low_steps = distilled or (steps is not None and steps < MIN_STEPS_FOR_CACHE)

    if low_steps:
        step_cache = "none"
        if req_cache != "none":
            reasons.append("cache:disabled_for_distilled_or_low_steps")
    elif req_cache == "auto":
        step_cache = "teacache"
        reasons.append("cache:auto->teacache")
    else:
        step_cache = req_cache

    # 4. 显存分层保护（24GB 默认开启 VAE 分块与 T5 卸载）
    low_vram = eff_vram is not None and eff_vram <= LOW_VRAM_VIDEO_THRESHOLD_MB
    vae_tiling = bool(cfg.get("vaeTiling")) if cfg.get("vaeTiling") is not None else low_vram
    vae_slicing = bool(cfg.get("vaeSlicing")) if cfg.get("vaeSlicing") is not None else low_vram
    t5_cpu_offload = bool(cfg.get("t5CpuOffload")) if cfg.get("t5CpuOffload") is not None else low_vram
    model_cpu_offload = bool(cfg.get("cpuOffload")) if cfg.get("cpuOffload") is not None else low_vram

    return VideoAccelPlan(
        quantization=quant,
        attention=attn,
        step_cache=step_cache,
        vae_tiling=vae_tiling,
        vae_slicing=vae_slicing,
        t5_cpu_offload=t5_cpu_offload,
        model_cpu_offload=model_cpu_offload,
        reasons=tuple(reasons),
    )


def build_diffusers_quant_config(plan: VideoAccelPlan, *, compute_dtype=None):  # noqa: ANN001, ANN201
    """根据 ``VideoAccelPlan`` 构建 diffusers 所需的量化配置对象（无量化返回 None）。"""
    if plan.quantization in ("torchao_fp8", "torchao_int8"):
        from diffusers import PipelineQuantizationConfig, TorchAoConfig
        from torchao.quantization import Float8WeightOnlyConfig, Int8WeightOnlyConfig

        ao_cfg = (
            Float8WeightOnlyConfig()
            if plan.quantization == "torchao_fp8"
            else Int8WeightOnlyConfig()
        )
        return PipelineQuantizationConfig(quant_mapping={"transformer": TorchAoConfig(ao_cfg)})

    if plan.quantization == "gguf":
        import torch
        from diffusers import GGUFQuantizationConfig

        dtype = compute_dtype if compute_dtype is not None else torch.bfloat16
        return GGUFQuantizationConfig(compute_dtype=dtype)

    return None


def apply_video_runtime_opts(pipe, plan: VideoAccelPlan, *, log=print):  # noqa: ANN001, ANN201
    """将注意力后端与 VAE/CPU 卸载策略安全应用到已加载的管线实例。"""
    if plan.attention in ("sage", "flash2"):
        transformer = getattr(pipe, "transformer", None)
        if transformer is not None and hasattr(transformer, "set_attention_backend"):
            backend_name = "sage" if plan.attention == "sage" else "flash"
            try:
                transformer.set_attention_backend(backend_name)
                log(f"[quant_accel] 注意力后端已启用：{backend_name}")
            except Exception as exc:  # noqa: BLE001 - 运行时异常不阻断生图
                log(f"[quant_accel] WARN 注意力后端 {backend_name} 启用失败，保持默认 SDPA：{exc}")

    if plan.vae_tiling and hasattr(pipe, "enable_vae_tiling"):
        pipe.enable_vae_tiling()
    if plan.vae_slicing and hasattr(pipe, "enable_vae_slicing"):
        pipe.enable_vae_slicing()
    if plan.model_cpu_offload and hasattr(pipe, "enable_model_cpu_offload"):
        pipe.enable_model_cpu_offload()
    return pipe
