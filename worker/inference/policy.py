"""显存策略覆写：``cpuOffload`` 的运行时开关（阶段 0 压测 A/B 用）。

为什么需要它：``models/*.json`` 把 ``pipeline.cpuOffload`` 写死（``flux2-klein-9b`` /
``qwen-image-2.1`` / ``z-image-turbo`` 都是 ``true``），加载器会无条件
``enable_model_cpu_offload()``。阶段 2 要在 24GB（开 offload）与 32GB/48GB（关 offload）
上对比 ``load_seconds`` / ``infer_seconds`` / ``max_allocated_mb`` 与单张成本，就必须有
一个「不改模型资产、不改 Host 协议、只改本次运行」的开关。

三种模式（``AIGC_WORKER_CPU_OFFLOAD`` 或 ``--cpu-offload``）：

- ``auto``（默认）：原样返回 spec，**行为与改造前逐字一致**（连对象身份都不变）；
- ``on``：强制 ``cpuOffload: true``，对没写 offload 的小模型也能统一压测口径；
- ``off``：强制 ``cpuOffload: false``，让 ``deviceMap`` / ``.to("cuda")`` 路径重新生效；
  显存不够会 OOM，这是压测的预期结果而不是 bug。

**覆写必须在管线缓存键之前完成**（见 ``daemon.ensure_pipeline``）：否则切换开关会命中
上一次的管线，A/B 会拿到旧的加载耗时与显存峰值——数据看起来正常，结论却是错的。

本模块只做纯数据变换，不 import torch / diffusers：单测可以在没有 GPU 的环境跑，
``/health`` 也能安全调用 :func:`cpu_offload_payload`。
"""

from __future__ import annotations

import os

from log_ring import log

# 环境变量名与启动参数同名，便于容器平台（RunPod / Vast）只配环境变量。
CPU_OFFLOAD_ENV = "AIGC_WORKER_CPU_OFFLOAD"
CPU_OFFLOAD_MODES = ("auto", "on", "off")
DEFAULT_MODE = "auto"
SPEC_KEY = "cpuOffload"

# shell / docker compose 里常见的写法：接受 true/false/1/0/yes/no，避免"配了但不生效"。
_ALIASES = {
    "auto": "auto",
    "on": "on",
    "off": "off",
    "true": "on",
    "yes": "on",
    "1": "on",
    "false": "off",
    "no": "off",
    "0": "off",
}

# CLI（--cpu-offload）优先于环境变量；启动时由 worker_server 登记一次。
_cli_mode: str | None = None
# 进程内解析结果缓存：/health 会被频繁轮询，重复读 env 与重复告警都没有意义。
_resolved: tuple[str, str] | None = None


def parse_mode(raw) -> str | None:  # noqa: ANN001
    """把外部输入归一成 ``auto`` / ``on`` / ``off``；无法识别返回 None（不猜）。"""
    if raw is None:
        return None
    text = str(raw).strip().lower()
    if not text:
        return None
    return _ALIASES.get(text)


def set_cli_mode(raw, *, log_fn=log) -> str | None:  # noqa: ANN001
    """登记 ``--cpu-offload`` 的取值；非法值告警并退回未设置（继续读环境变量）。"""
    global _cli_mode, _resolved
    parsed = parse_mode(raw)
    if raw is not None and str(raw).strip() and parsed is None:
        log_fn(
            f"[policy] WARN --cpu-offload={raw!r} 无法识别，已忽略"
            f"（可选 {' / '.join(CPU_OFFLOAD_MODES)}）"
        )
    _cli_mode = parsed
    _resolved = None
    return _cli_mode


def resolve_mode(*, refresh: bool = False) -> tuple[str, str]:
    """返回 ``(mode, source)``：CLI > 环境变量 > ``auto``；source 用于 /health 归因。

    非法环境变量值回落 ``auto`` 并告警一次（不阻断启动：压测开关不该让 Worker 起不来）。
    """
    global _resolved
    if _resolved is not None and not refresh:
        return _resolved
    if _cli_mode:
        _resolved = (_cli_mode, "cli")
        return _resolved
    raw = os.environ.get(CPU_OFFLOAD_ENV)
    parsed = parse_mode(raw)
    if parsed is None and raw is not None and str(raw).strip():
        log(
            f"[policy] WARN {CPU_OFFLOAD_ENV}={raw!r} 无法识别，回落 auto"
            f"（可选 {' / '.join(CPU_OFFLOAD_MODES)}）"
        )
    _resolved = (parsed or DEFAULT_MODE, "env" if parsed else "default")
    return _resolved


def reset_cache() -> None:
    """清空进程内解析缓存（单测与 ``--cpu-offload`` 重登记使用）。"""
    global _resolved
    _resolved = None


def apply(spec, *, mode: str | None = None) -> tuple[dict, dict]:  # noqa: ANN001
    """按模式覆写 ``pipeline.cpuOffload``，返回 ``(spec, info)``。

    ``auto`` 时返回**同一个对象**（不做浅拷贝），保证缓存键与旧行为逐字节一致；
    ``on`` / ``off`` 时返回浅拷贝，不修改调用方（请求体）持有的 dict。

    ``info`` 字段：``mode`` / ``source`` / ``requested``（模型资产原值，可能为 None）/
    ``effective``（本次生效的布尔）/ ``overridden``（是否与资产原值不同）。
    """
    resolved_mode, source = resolve_mode() if mode is None else (mode, "explicit")
    requested = spec.get(SPEC_KEY)
    requested_bool = requested if isinstance(requested, bool) else None
    info = {
        "mode": resolved_mode,
        "source": source,
        "requested": requested_bool,
        "effective": requested_bool,
        "overridden": False,
    }
    if resolved_mode == DEFAULT_MODE:
        return spec, info
    effective = resolved_mode == "on"
    info["effective"] = effective
    if requested_bool is effective:
        # 资产已经等于目标值：同样不做拷贝，避免无意义地改变缓存键。
        return spec, info
    patched = dict(spec)
    patched[SPEC_KEY] = effective
    info["overridden"] = True
    return patched, info


def describe(info: dict) -> str:
    """一行人类可读说明（日志 / 排障用），不参与协议。"""

    def text(value):  # noqa: ANN001, ANN202
        return "未声明" if value is None else ("开" if value else "关")

    return (
        f"cpuOffload={text(info.get('effective'))}（模式 {info.get('mode')} / "
        f"来源 {info.get('source')} / 资产原值 {text(info.get('requested'))}）"
    )


def cpu_offload_payload(*, effective=None) -> dict:  # noqa: ANN001
    """``/health.cpu_offload``：模式 + 来源 + 当前已加载管线的实际值（未加载为 null）。

    压测账本按这三个字段就能区分「本次跑的是开还是关」，不必回看容器启动参数。
    """
    mode, source = resolve_mode()
    return {
        "mode": mode,
        "source": source,
        "effective": effective if isinstance(effective, bool) else None,
    }
