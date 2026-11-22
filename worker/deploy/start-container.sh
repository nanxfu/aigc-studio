#!/usr/bin/env bash
# 通用容器启动脚本：AutoDL / 恒源云 / RunPod 等「已运行容器、无 systemd、不能 Docker-in-Docker」
# 的租用 GPU 环境。自有服务器 / Docker 仍推荐 worker/deploy/Dockerfile。
#
# 做什么：
#   1. 自动挑选数据盘（优先 /root/autodl-tmp → /workspace → 当前目录），把 HF 缓存与产物
#      指到该盘，避免写爆 30GB 系统盘；
#   2. 检测预装 torch：有则按锁定清单增量安装其余依赖（不重下 3GB torch，版本仍单源）；
#   3. 生成/复用 0600 Token，后台启动 worker_server.py，日志写 <data>/worker.log；
#   4. 可选无卡准备：--prepare-only 只装依赖 + 预拉权重，不启动 HTTP。
#
# 用法：
#   bash worker/deploy/start-container.sh                     # 后台启动（默认 8765）
#   bash worker/deploy/start-container.sh --port 6006         # AutoDL 自定义服务端口
#   bash worker/deploy/start-container.sh --prepare-only \
#        --preload-json @/root/aigc-tmp/pipeline.json         # 无卡模式准备
#   bash worker/deploy/start-container.sh --fg                # 前台运行（调试）
#
# 安全：默认只监听 127.0.0.1；对外访问请用 SSH 隧道或平台 HTTPS 代理（6006）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PORT=8765
# 解释器：AutoDL 等镜像的 python 常在 conda 环境里，可用 PYTHON_BIN 覆盖。
PYTHON_BIN="${PYTHON_BIN:-python3}"
WORK_DIR=""
TOKEN_FILE=""
PREPARE_ONLY=0
PRELOAD_JSON=""
NO_INSTALL=0
HF_TOKEN_ARG=""
FOREGROUND=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --work-dir) WORK_DIR="$2"; shift 2 ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --prepare-only) PREPARE_ONLY=1; shift ;;
    --preload-json) PRELOAD_JSON="$2"; shift 2 ;;
    --no-install) NO_INSTALL=1; shift ;;
    --hf-token) HF_TOKEN_ARG="$2"; shift 2 ;;
    --fg|--foreground) FOREGROUND=1; shift ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

log() { echo "[start-container] $*" >&2; }

# ---- 1) 数据盘 ------------------------------------------------------------
if [[ -z "$WORK_DIR" ]]; then
  for candidate in /root/autodl-tmp /workspace "$HOME/aigc-worker" "$PWD/aigc-worker"; do
    if [[ -d "$candidate" ]] || mkdir -p "$candidate" 2>/dev/null; then
      WORK_DIR="$candidate"
      break
    fi
  done
fi
mkdir -p "$WORK_DIR"
DATA_DIR="$WORK_DIR"
log "数据目录：$DATA_DIR"

# ---- 2) Token -------------------------------------------------------------
if [[ -z "$TOKEN_FILE" ]]; then
  TOKEN_FILE="$DATA_DIR/worker-token"
fi
if [[ ! -s "$TOKEN_FILE" ]]; then
  "$PYTHON_BIN" -c "import secrets; print(secrets.token_hex(32))" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  log "已生成 Token：$TOKEN_FILE（复制到客户端设置页；不要提交到仓库）"
else
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
  log "复用已有 Token：$TOKEN_FILE"
fi

export HF_HOME="${HF_HOME:-$DATA_DIR/hf}"
export HF_HUB_CACHE="${HF_HUB_CACHE:-$HF_HOME/hub}"
export AIGC_WORKER_ARTIFACT_DIR="${AIGC_WORKER_ARTIFACT_DIR:-$DATA_DIR/artifacts}"
mkdir -p "$HF_HOME" "$AIGC_WORKER_ARTIFACT_DIR"
log "HF_HOME=$HF_HOME"
log "ARTIFACT_DIR=$AIGC_WORKER_ARTIFACT_DIR"

# 下载源：默认走 HuggingFace 官方 CDN。海外节点（RunPod / Vast）**不要**设国内镜像，
# 否则跨太平洋回源会被限速；国内机器可显式 `HF_ENDPOINT=https://hf-mirror.com` 开启加速。
if [[ -n "${HF_ENDPOINT:-}" ]]; then
  log "HF_ENDPOINT=$HF_ENDPOINT（显式设置）"
else
  log "HF_ENDPOINT 未设置：直连 HuggingFace 官方 CDN"
fi

# 显存策略：auto 跟随模型资产；压测 A/B 时设 on / off（子进程直接继承该环境变量）。
log "CPU_OFFLOAD=${AIGC_WORKER_CPU_OFFLOAD:-auto}"

# ---- 3) 依赖 --------------------------------------------------------------
if [[ "$NO_INSTALL" -eq 0 ]]; then
  if "$PYTHON_BIN" -c "import torch" >/dev/null 2>&1; then
    # 预装 torch 时只增量安装其余依赖，但**版本仍以 requirements-gpu.txt 为单源**：
    # 逐条重写包名会与锁定版本漂移（例如预装 torch 2.0 时悄悄装回最新 diffusers）。
    log "检测到预装 torch，按锁定清单增量安装（跳过 torch / torchvision）"
    REQUIREMENTS_TMP="$DATA_DIR/requirements-no-torch.txt"
    grep -vE '^(torch|torchvision|--)' "$REPO_ROOT/worker/requirements-gpu.txt" > "$REQUIREMENTS_TMP"
    "$PYTHON_BIN" -m pip install --no-cache-dir -r "$REQUIREMENTS_TMP"
    "$PYTHON_BIN" -c "import torch; print('[deps] 预装 torch 版本：' + torch.__version__)" \
      || log "WARN 预装 torch 无法导入，建议重装为 2.6.0+cu124"
  else
    log "未检测到 torch，按 requirements-gpu.txt 安装（cu124，约 3GB）"
    "$PYTHON_BIN" -m pip install --no-cache-dir -r "$REPO_ROOT/worker/requirements-gpu.txt"
  fi
else
  log "--no-install：跳过依赖安装"
fi

# ---- 4) 无卡准备 ----------------------------------------------------------
if [[ "$PREPARE_ONLY" -eq 1 ]]; then
  ARGS=(--prepare-only --work-dir "$DATA_DIR")
  [[ -n "$PRELOAD_JSON" ]] && ARGS+=(--preload-json "$PRELOAD_JSON")
  [[ -n "$HF_TOKEN_ARG" ]] && ARGS+=(--hf-token "$HF_TOKEN_ARG")
  [[ "$NO_INSTALL" -eq 1 ]] && ARGS+=(--no-install)
  log "无卡准备模式：$PYTHON_BIN worker/worker_server.py ${ARGS[*]}"
  exec "$PYTHON_BIN" "$REPO_ROOT/worker/worker_server.py" "${ARGS[@]}"
fi

# ---- 5) 启动 Worker -------------------------------------------------------
LOG_FILE="$DATA_DIR/worker.log"
ARGS=(
  --host 127.0.0.1
  --port "$PORT"
  --token-file "$TOKEN_FILE"
  --work-dir "$DATA_DIR"
  --no-install
)
[[ -n "$HF_TOKEN_ARG" ]] && ARGS+=(--hf-token "$HF_TOKEN_ARG")

if [[ "$FOREGROUND" -eq 1 ]]; then
  log "前台运行：$PYTHON_BIN worker/worker_server.py ${ARGS[*]}"
  exec "$PYTHON_BIN" "$REPO_ROOT/worker/worker_server.py" "${ARGS[@]}"
fi

log "后台启动 Worker（日志：$LOG_FILE）"
nohup "$PYTHON_BIN" "$REPO_ROOT/worker/worker_server.py" "${ARGS[@]}" >"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$DATA_DIR/worker.pid"

# 等 /healthz 就绪（免鉴权，最多 60 秒；首次安装依赖时可能更久）。
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$PID" >/dev/null 2>&1; then
    log "Worker 进程已退出，最后 40 行日志："
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  log "60 秒内 /healthz 未就绪；查看日志：tail -f $LOG_FILE"
  exit 1
fi

TOKEN_VALUE="$(cat "$TOKEN_FILE")"
log "Worker 已就绪：pid=$PID port=$PORT"
echo ""
echo "============================================================"
echo " 客户端设置 → 算力来源 → 私有 Worker"
echo "   地址：http://127.0.0.1:${PORT}（需先建立 SSH 隧道）"
if [[ "$PORT" == "6006" ]]; then
  echo "   或使用平台「自定义服务」的 HTTPS 地址（控制台复制）"
fi
echo "   Token：${TOKEN_VALUE}"
echo ""
echo " SSH 隧道（在你自己的电脑上执行）："
echo "   ssh -CNg -L ${PORT}:127.0.0.1:${PORT} root@<实例地址> -p <SSH端口>"
echo ""
echo " 停止：kill \$(cat $DATA_DIR/worker.pid)"
echo " 日志：tail -f $LOG_FILE"
echo "============================================================"
