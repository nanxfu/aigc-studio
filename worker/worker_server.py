#!/usr/bin/env python3
"""长驻 GPU Worker 入口：私有服务器 / Docker / SSH 隧道 / 本机托管共用。

与 ``daemon.py`` 的差别只在「怎么活」：daemon 是 Kaggle/Colab 的临时容器，需要 ntfy 会合、
cloudflared 隧道、claim 看门狗与空闲退出；长驻 Worker **本来就有固定地址**，只需要：

1. 监听 HTTP（默认 ``127.0.0.1:8765``；Docker 里用 ``--host 0.0.0.0``）；
2. Bearer 鉴权（Token 从 ``--token-file`` 或 ``AIGC_WORKER_TOKEN`` 读，不落日志）；
3. 后台 ``runtime_boot``（GPU 探测 → 装依赖 → 可选预加载）；
4. ``/shutdown`` 默认关闭，显式 ``--allow-shutdown`` 才允许（本机托管 / 单用户）；
5. stdout 只输出**一行** ready JSON，其余日志全部走 stderr（供 Supervisor / 本机 GPU
   进程托管解析端口与协议版本）。

任务执行、``/health``、``/generate``、``/job``、``/artifact``、``/events``、``/logs`` 全部复用
``daemon.py`` 的装配（同一套协议与任务实现），本文件不复制任何推理或队列逻辑。

用法::

    # Docker / 服务器（Token 文件 0600）
    python worker/worker_server.py --host 0.0.0.0 --port 8765 --token-file /run/secrets/worker-token

    # 本机（只监听回环，允许关机）
    python worker/worker_server.py --port 8765 --token-file ./worker-token --allow-shutdown

    # 本地调试（不开鉴权，仅回环）
    python worker/worker_server.py --allow-no-auth
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import stat
import sys
import threading
import time
from pathlib import Path

# 两种运行方式都要能 import：`python worker/worker_server.py`（sys.path[0]=worker/）
# 与 `python -m worker.worker_server`（仓库根进 sys.path）。daemon 内部用扁平导入
# （`from log_ring import log`）与包导入（`from worker.jobs...`）并存，两个目录都要在。
_WORKER_DIR = Path(__file__).resolve().parent
_ROOT_DIR = _WORKER_DIR.parent
for _path in (str(_WORKER_DIR), str(_ROOT_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import log_ring  # noqa: E402
import worker.daemon as d  # noqa: E402
from worker.config import apply_config, build_config  # noqa: E402
from worker.runtime import runtime_boot  # noqa: E402

DEFAULT_PORT = 8765
TOKEN_ENV = "AIGC_WORKER_TOKEN"
TOKEN_MIN_CHARS = 32
EXIT_CONFIG = 2
EXIT_AUTH = 4
EXIT_PORT = 3


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="worker_server.py",
        description="长驻 GPU Worker（固定地址、Bearer 鉴权、协议 v2）",
    )
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（Docker 用 0.0.0.0）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口（0 = 系统分配）")
    parser.add_argument(
        "--contract",
        default=str(_WORKER_DIR / "contract.json"),
        help="契约 JSON 路径（默认随包 worker/contract.json）",
    )
    parser.add_argument("--token-file", default=None, help="Bearer Token 文件（0600）；也可用环境变量")
    parser.add_argument("--no-install", action="store_true", help="跳过 pip 依赖安装（镜像已预装）")
    parser.add_argument(
        "--idle-timeout",
        type=int,
        default=0,
        help="空闲退出秒数（0 = 常驻不退出；共享 Worker 建议保持 0）",
    )
    parser.add_argument(
        "--allow-shutdown",
        action="store_true",
        help="允许 POST /shutdown（仅本机托管 / 单用户；共享 Worker 不要打开）",
    )
    parser.add_argument(
        "--allow-no-auth",
        action="store_true",
        help="本地调试：允许无 Token（只应配合回环地址）",
    )
    parser.add_argument("--work-dir", default="", help="工作目录（模型缓存 / 临时产物所在盘）")
    parser.add_argument("--log-level", default="info", help="日志级别（当前只影响注入配置记录）")
    return parser


def _read_token(path: str | None) -> str:
    """按 --token-file > AIGC_WORKER_TOKEN 的顺序取 Token；不把值写进任何日志。"""
    if path:
        token_path = Path(path).expanduser()
        try:
            mode = token_path.stat().st_mode
            if mode & (stat.S_IRGRP | stat.S_IROTH):
                print(f"[token] 警告：{token_path} 权限过于宽松，建议 chmod 600", file=sys.stderr)
        except OSError:
            pass
        try:
            return token_path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise SystemExit(f"读取 Token 文件失败：{exc}") from None
    return str(os.environ.get(TOKEN_ENV) or "").strip()


def _load_contract(path: str) -> dict:
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        raise SystemExit(f"读取契约失败：{exc}") from None
    except json.JSONDecodeError as exc:
        raise SystemExit(f"契约不是合法 JSON：{exc}") from None
    if not isinstance(doc, dict) or not isinstance(doc.get("limits"), dict):
        raise SystemExit("契约缺少 limits 对象")
    return doc


def _configure(options, contract: dict, token: str) -> None:
    """把命令行参数写成 daemon 的注入配置（原地更新单例，保持协作者引用不变）。"""
    cfg = {
        "auth_token": token,
        "port": int(options.port),
        # 长驻服务不做 claim 看门狗（Host 可以几小时后才第一次连上）。
        "claim_timeout_sec": 0,
        "idle_timeout_sec": max(0, int(options.idle_timeout)),
        "preload": None,
        "preset_id": None,
        "log_level": options.log_level,
        "version": str(contract.get("version") or ""),
        "contract": contract,
        "allow_no_auth": bool(options.allow_no_auth),
        "allow_shutdown": bool(options.allow_shutdown),
        "work_dir": options.work_dir or "",
    }
    apply_config(d.CONFIG, build_config(cfg))


def _install_signal_handlers(stop: threading.Event) -> None:
    def _bye(signum, _frame):  # noqa: ANN001
        log_ring.log(f"[signal] 收到信号 {signum}，准备退出")
        stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _bye)
        except Exception:
            pass


def _wait_for_job(gen_lock, timeout: float = 10.0) -> None:
    """等当前 job 合作式结束（最多 timeout 秒）；拿不到锁也继续退出，避免挂死容器。"""
    acquired = False
    try:
        acquired = gen_lock.acquire(timeout=timeout)
    except Exception:
        return
    finally:
        if acquired:
            try:
                gen_lock.release()
            except RuntimeError:
                pass


def _idle_expired(config, state, state_lock, store) -> bool:  # noqa: ANN001
    timeout = int(getattr(config, "idle_timeout_sec", 0) or 0)
    if timeout <= 0:
        return False
    with state_lock:
        last_active = float(getattr(state, "last_active", 0) or 0)
        phase = str(getattr(state, "phase", "") or "")
    if phase in ("booting", "installing", "loading"):
        return False
    if store.active_count() > 0:
        return False
    return (time.time() - last_active) >= timeout


def run(options) -> int:  # noqa: ANN001
    # stdout 只留给 ready JSON：日志与第三方库的 print 一律改道 stderr。
    # log_ring 在 import 时捕获了真实 stdout，这里把它重绑到 stderr，再替换 sys.stdout。
    log_ring.reset_log_ring(stdout=sys.stderr)
    sys.stdout = sys.stderr
    ready_stream = sys.__stdout__

    contract = _load_contract(options.contract)
    token = _read_token(options.token_file)
    # 无鉴权只允许回环：0.0.0.0 + allow-no-auth 等于把出图能力开放给整个网络。
    if options.allow_no_auth and options.host not in ("127.0.0.1", "::1", "localhost"):
        print("--allow-no-auth 只能配合回环地址使用（127.0.0.1 / ::1）", file=sys.stderr)
        return EXIT_AUTH
    if not token and not options.allow_no_auth:
        print(
            f"未配置 Token：请用 --token-file 或环境变量 {TOKEN_ENV} 提供；"
            "本地调试可显式加 --allow-no-auth",
            file=sys.stderr,
        )
        return EXIT_AUTH
    if token and len(token) < TOKEN_MIN_CHARS:
        print(
            f"[token] 警告：Token 长度 {len(token)} < {TOKEN_MIN_CHARS}，建议用 32 字节随机 hex",
            file=sys.stderr,
        )

    _configure(options, contract, token)
    log_ring.log("=" * 72)
    log_ring.log(
        f"AIGC 私有 Worker 启动：protocol={contract.get('version') or 'unknown'} "
        f"host={options.host} port={options.port} pid={os.getpid()}"
    )

    stop = d.BOOT.stop_event
    _install_signal_handlers(stop)

    with d.STATE_LOCK:
        d.STATE.started_at = time.time()
        d.STATE.last_active = d.STATE.started_at

    # HTTP 必须先起来：Host 靠 /health 判断 phase，模型加载慢不影响可观测性。
    try:
        server = d.start_http_server(d.CONFIG.port, host=options.host)
    except OSError as exc:
        print(f"端口监听失败（{options.host}:{d.CONFIG.port}）：{exc}", file=sys.stderr)
        return EXIT_PORT
    actual_port = int(server.server_address[1])

    # 任务 worker 与运行时启动各自后台跑；主线程只做空闲看门狗与退出收尾。
    d.start_job_worker()
    boot = threading.Thread(
        target=lambda: runtime_boot(
            config=d.CONFIG,
            state=d.STATE,
            state_lock=d.STATE_LOCK,
            gen_lock=d.GEN_LOCK,
            install_dependencies=(lambda: None) if options.no_install else (lambda: d.install_dependencies()),
            ensure_pipeline=lambda spec: d.ensure_pipeline(spec),
            classify_failure=lambda exc, default="load_failed": d.classify_failure(exc, default=default),
            free_cuda_cache=lambda: d.free_cuda_cache(),
            fail_boot=lambda code, message: d.fail_boot(code, message),
            set_phase=lambda phase, detail=None: d.set_phase(phase, detail),
            log_fn=log_ring.log,
            short_fn=d.short,
        ),
        name="runtime-boot",
        daemon=True,
    )
    boot.start()

    payload = {
        "type": "ready",
        "port": actual_port,
        "pid": os.getpid(),
        "protocol_version": contract.get("version") or "",
        "capabilities": d.capabilities_payload(
            loaders=d.SUPPORTED_LOADERS,
            reference_loaders=d.SUPPORTED_REFERENCE_LOADERS,
            inpaint_loaders=d.SUPPORTED_INPAINT_LOADERS,
        ),
    }
    try:
        ready_stream.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        ready_stream.flush()
    except Exception:
        pass

    try:
        while not stop.wait(2.0):
            if _idle_expired(d.CONFIG, d.STATE, d.STATE_LOCK, d.JOB_STORE):
                log_ring.log(f"[idle] 空闲超过 {d.CONFIG.idle_timeout_sec}s，退出进程释放显存")
                break
    finally:
        with d.STATE_LOCK:
            d.STATE.shutting_down = True
        stop.set()
        d.JOB_STORE.notify()
        # 先给当前 job 最多 10 秒合作式收尾，再关 HTTP 与清产物。
        _wait_for_job(d.GEN_LOCK, timeout=10.0)
        d._cleanup_before_exit()  # noqa: SLF001 - 与 daemon 共用同一套幂等清理
    log_ring.log("[shutdown] Worker 已退出")
    return 0


def main(argv: list[str] | None = None) -> int:
    options = build_parser().parse_args(argv)
    try:
        return run(options)
    except SystemExit as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_CONFIG


if __name__ == "__main__":
    raise SystemExit(main())
