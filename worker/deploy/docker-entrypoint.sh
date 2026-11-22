#!/bin/sh
# 容器入口：把「云厂商注入的环境变量」翻译成 worker_server 的参数。
#
# 为什么需要它（RunPod / Vast 等容器平台）：
#  - 平台通常只给环境变量，不保证能挂载 /run/secrets/worker-token；
#  - 网络卷/容器盘的挂载点经常是 root 所有，镜像里的非 root 用户可能写不进去；
#  - 启动命令应保持一条：`docker run -e AIGC_WORKER_TOKEN=... image`。
#
# 兼容旧用法：显式传 `--token-file /path` 时优先用参数；Docker Compose 的
# `/run/secrets/worker-token` 仍然有效。
set -eu

TOKEN_FILE="${AIGC_WORKER_TOKEN_FILE:-/run/secrets/worker-token}"
if [ ! -s "$TOKEN_FILE" ] && [ -n "${AIGC_WORKER_TOKEN:-}" ]; then
  # 平台只给环境变量：落到容器内 0600 临时文件，避免出现在进程参数里。
  TOKEN_FILE="/tmp/aigc-worker-token"
  umask 077
  printf '%s' "$AIGC_WORKER_TOKEN" > "$TOKEN_FILE"
fi

# 模型缓存目录：网络卷可能 root 所有，非 root 用户写不进去时回退到 /tmp（不持久）。
if [ -n "${HF_HOME:-}" ]; then
  if ! mkdir -p "$HF_HOME" 2>/dev/null || [ ! -w "$HF_HOME" ]; then
    echo "[entrypoint] HF_HOME=$HF_HOME 不可写，回退到 /tmp/hf（本次不持久）" >&2
    HF_HOME=/tmp/hf
    export HF_HOME
    mkdir -p "$HF_HOME"
  fi
fi

set -- --host "${AIGC_WORKER_HOST:-0.0.0.0}" --port "${AIGC_WORKER_PORT:-8765}" --no-install "$@"
if [ -s "$TOKEN_FILE" ]; then
  set -- "$@" --token-file "$TOKEN_FILE"
fi
exec python3 /app/worker/worker_server.py "$@"
