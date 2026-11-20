#!/usr/bin/env python3
"""私有云 / Docker / 本机长驻 Worker 入口（Phase 2 预留；Phase 1 仅占位）。

背景（见 ``docs/AIGC_STUDIO_STANDALONE_PLAN.md`` §二「worker/」）：

Kaggle 与 Colab 的临时会话由 ``worker/daemon.py`` 承担——它用 ntfy 发布会合信息、
用 cloudflared 建公网隧道，Host 靠隧道地址回调。私有服务器 / Docker / 本机 GPU 等
长驻环境不需要这两层：服务本来就有固定地址，直接监听 HTTP 即可。Phase 2 计划新增
本入口复用 daemon 的传输层与任务执行层，但去掉「会合 + 隧道」这两件事。

Phase 1 不实现上述能力，本文件只保留可运行的占位：

- 不依赖 ntfy / cloudflared，也不启动任何后台线程；
- 不会加载模型、不会对外监听端口；
- 只解析参数并明确提示「Phase 2 未实现」，以退出码 2 结束，避免被误当成可用服务拉起。

Phase 2 计划（草案，实现时以当时规格为准）：

- ``--host`` / ``--port``：直接监听地址与端口（``--port 0`` 由系统分配）；
- ``--contract``：本地契约 JSON 路径，替代 Host 注入的 ``config.contract``；
- 鉴权仍用 Bearer token：从环境变量读取（不落盘、不进日志），与 daemon 的
  ``/health``、``/generate``、``/job`` 协议字段保持同形。

用法::

    python worker/worker_server.py --help          # 查看参数（Phase 1 可用）
    python worker/worker_server.py --port 8765     # Phase 1：提示未实现并退出 2
"""

from __future__ import annotations

import argparse
import sys

# 与其它 CLI 约定保持一致：未实现的功能用 2 退出，便于脚本区分「参数错误（argparse 也用 2）」与
# 「正常但不可用」。Phase 2 实现后这里改成 0 并真正启动服务。
EXIT_NOT_IMPLEMENTED = 2


def build_parser() -> argparse.ArgumentParser:
    """构造参数解析器；参数名与 Phase 2 的目标形态一致，避免后续改动命令行契约。"""
    parser = argparse.ArgumentParser(
        prog="worker_server.py",
        description="长驻 Worker 入口（Phase 2 预留；Phase 1 仅占位，不会启动服务）",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="监听地址（Phase 2 使用，默认 127.0.0.1；长驻部署按需改成内网地址）",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="监听端口（Phase 2 使用；0 = 由系统分配，默认 0）",
    )
    parser.add_argument(
        "--contract",
        default=None,
        help="契约 JSON 路径（Phase 2 使用；缺省读取随包分发的 worker/contract.json）",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    options = build_parser().parse_args(argv)
    print(
        "worker_server.py 是 Phase 2 预留入口，当前版本未实现：\n"
        f"  已解析参数：host={options.host} port={options.port} "
        f"contract={options.contract or '（默认）'}\n"
        "  Kaggle / Colab 临时会话请使用 worker/daemon.py；"
        "长驻 Worker 的 HTTP 服务、Bearer 鉴权与任务接口将在 Phase 2 补齐。",
        file=sys.stderr,
    )
    return EXIT_NOT_IMPLEMENTED


if __name__ == "__main__":
    raise SystemExit(main())
