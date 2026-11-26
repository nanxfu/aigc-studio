"""能力协商与硬件快照：``/health.capabilities`` / ``/health.hardware`` 的唯一组装点。

为什么单独成模块：Host 要用 capabilities 决定「能不能走 binary / SSE / 某个 loader」，
声明错会让 Host 发出注定失败的请求。这里只声明**真实可用**的能力——来源是 loader
注册表与当前进程已加载的 torch，不照抄契约。

``hardware`` 允许为 None（CPU 容器 / 驱动不可读）：Host 只把它用于 UI 与模型建议，
不做硬门槛；显存不足由任务执行期返回 ``gpu_unavailable`` / OOM。
"""

from __future__ import annotations

import sys

MIB = 1024 * 1024


def capabilities_payload(
    *,
    loaders=(),
    reference_loaders=(),
    inpaint_loaders=(),
    quantization=(),
    result_modes=("inline", "binary"),
    tools=("generate", "upscale"),
) -> dict:
    """按实际注册的 loader 生成能力位；未注册的能力不虚标。"""
    return {
        "result_modes": list(result_modes),
        "events": True,
        "artifact_range": True,
        "tools": list(tools),
        "loaders": list(loaders),
        "reference": bool(reference_loaders),
        "inpaint": bool(inpaint_loaders),
        "quantization": list(quantization),
    }


def quantization_payload() -> list[str]:
    """当前解释器真实可用的权重量化格式；不 import 重库。"""
    try:
        import importlib.util

        return ["gguf"] if importlib.util.find_spec("gguf") is not None else []
    except Exception:  # noqa: BLE001 - 探测失败只按不可用处理
        return []


def hardware_payload() -> dict | None:
    """只读 torch 的 GPU 信息；未加载 torch / 无 CUDA 时返回 None（不触发重库 import）。"""
    torch = sys.modules.get("torch")
    if torch is None:
        return None
    try:
        cuda = torch.cuda
        if not cuda.is_available():
            return None
        props = cuda.get_device_properties(0)
        total = int(getattr(props, "total_memory", 0) or 0)
        return {
            "gpu_name": str(getattr(props, "name", "") or "").strip() or None,
            "vram_total_mb": int(total // MIB) if total > 0 else None,
            "count": int(cuda.device_count()),
            "cuda": str(getattr(torch.version, "cuda", "") or "") or None,
            # 驱动版本不在 torch 里稳定可取：保留字段但允许 null，Host 只做展示。
            "driver": None,
        }
    except Exception:
        return None
