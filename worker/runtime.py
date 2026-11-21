"""运行时启动编排：GPU 探测 → 装依赖 →（可选）预加载 → ``phase=ready``。

为什么从 ``app.py`` 抽出来：Kaggle/Colab 的 ``DaemonApp`` 与长驻 ``WorkerServerApp``
需要**同一段**启动逻辑，但两者的外层生命周期完全不同（前者要发布会合点与空闲看门狗，
后者只需常驻监听）。把这段放在这里，两个入口各自负责「怎么活、怎么退」，不再复制一份
GPU/依赖/预加载分支——否则私有 Worker 与云端 daemon 的失败码迟早会漂移。

装配约定与 ``app.py`` 一致：协作者全部以参数传入，调用方传 lambda 以保留单测的
``mock.patch.object(daemon, ...)`` 生效点；本模块不 import daemon（避免成环）。
"""

from __future__ import annotations

from log_ring import log
from worker.text import short

# M3.3：Kaggle 未绑定手机号或未启用 GPU 加速器时会静默降级成 CPU 容器。这里必须立刻
# 给出可执行的下一步，而不是继续用 CPU 硬跑（那会表现为超时或模糊的 CUDA 报错）。
GPU_UNAVAILABLE_MESSAGE = (
    "未检测到可用 GPU（当前为 CPU 容器）。"
    "Kaggle：请确认账号已完成手机号验证并启用 GPU 加速器；"
    "Colab：请确认订阅有效且所选 GPU 型号仍有可用配额；"
    "私有 Worker：请确认容器以 --gpus all 启动、驱动与 CUDA 可用"
)


def runtime_boot(
    *,
    config,  # noqa: ANN001 - DaemonConfig（活对象）
    state,  # noqa: ANN001 - RuntimeState
    state_lock,  # noqa: ANN001
    gen_lock,  # noqa: ANN001
    install_dependencies,  # noqa: ANN001 - Callable[[], None]
    ensure_pipeline,  # noqa: ANN001 - Callable[[dict], tuple]
    classify_failure,  # noqa: ANN001 - Callable[..., tuple[str, str]]
    free_cuda_cache,  # noqa: ANN001 - Callable[[], None]
    fail_boot,  # noqa: ANN001 - Callable[[str, str], None]
    set_phase,  # noqa: ANN001 - Callable[[str, str | None], None]
    log_fn=log,  # noqa: ANN001
    short_fn=short,  # noqa: ANN001
) -> None:
    """后台线程入口：探测 GPU → 装依赖 →（可选）预加载模型 → ``phase=ready``。"""
    torch_error = ""
    device_name = None
    device_count = 0
    try:
        import torch

        if torch.cuda.is_available():
            device_name = torch.cuda.get_device_name(0)
            device_count = torch.cuda.device_count()
            log_fn(f"[cuda] {device_name} × {device_count}，torch={torch.__version__}，cuda={torch.version.cuda}")
    except Exception as exc:  # noqa: BLE001 - torch 缺失/驱动异常都只影响启动归因
        torch_error = short_fn(exc)
        log_fn(f"[cuda] 导入 torch 失败：{torch_error}")

    with state_lock:
        state.device = device_name
        state.device_count = device_count

    if not device_count:
        if torch_error:
            # torch 都没能导入时无法确认 GPU 状态，保留 load_failed 以免误导成账号问题。
            fail_boot("load_failed", f"无法确认 GPU 可用性：{torch_error}")
        else:
            fail_boot("gpu_unavailable", GPU_UNAVAILABLE_MESSAGE)
        return

    try:
        install_dependencies()
    except Exception as exc:  # noqa: BLE001 - 依赖安装失败由 fail_boot 归一
        fail_boot("load_failed", short_fn(exc))
        return

    preload = config.preload
    if preload:
        try:
            with gen_lock:
                ensure_pipeline(preload)
        except Exception as exc:  # noqa: BLE001 - 加载失败按 OOM / load_failed 分类
            free_cuda_cache()
            code, message = classify_failure(exc, default="load_failed")
            fail_boot(code, message)
            return

    with state_lock:
        state.booted = True
        need_ready = state.phase != "ready"
    if need_ready:
        set_phase("ready", "依赖已就绪，等待首个生成请求下发 pipeline")
    log_fn("[boot] 运行时就绪，可以接单")
