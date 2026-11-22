# 私有 GPU Worker 镜像（Docker / 自有 Linux 服务器）
#
# 设计取舍：
# - 基础镜像用 CUDA runtime（不是 devel）：不需要编译自定义算子，体积小一半；
# - torch 走 PyTorch 官方 cu124 索引，和宿主机驱动 >= 550 匹配；
# - 依赖在构建期装好，容器启动用 --no-install，重建容器不会重新下载几个 GB；
# - 模型缓存放 /models/hf 卷，容器可随意重建；产物放 /tmp（进程退出即清）；
# - Token 只从 /run/secrets/worker-token 或环境变量读，绝不打进镜像。

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models/hf \
    AIGC_WORKER_ARTIFACT_DIR=/tmp/aigc-artifacts

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只拷依赖清单，利用层缓存：改业务代码不必重装 torch。
COPY worker/requirements-gpu.txt /app/worker/requirements-gpu.txt
RUN python3 -m pip install --no-cache-dir --upgrade pip \
    && python3 -m pip install --no-cache-dir -r /app/worker/requirements-gpu.txt

# Worker 只依赖仓库根的 worker/ 包；shared/、前端与测试不需要进镜像。
COPY worker /app/worker

# 非 root 运行；模型缓存与临时目录交给该用户。
RUN useradd --create-home --uid 10001 worker \
    && mkdir -p /models/hf /tmp/aigc-artifacts \
    && chown -R worker:worker /app /models /tmp/aigc-artifacts
# 入口脚本负责：AIGC_WORKER_TOKEN → 0600 临时文件、HF_HOME 不可写时回退 /tmp。
COPY worker/deploy/docker-entrypoint.sh /usr/local/bin/aigc-worker-entrypoint
RUN chmod 755 /usr/local/bin/aigc-worker-entrypoint
USER worker

EXPOSE 8765

# /healthz 免鉴权、只回 {"ok":true}；详细 /health 仍需 Bearer。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8765/healthz || exit 1

# 容器内监听 0.0.0.0 才能被端口映射；宿主机侧只绑定 127.0.0.1（见 compose），
# 公网访问请走 Caddy/Nginx 终止 TLS 或 SSH 隧道。
#
# 云平台（RunPod / Vast 等）用法：
#   docker run -e AIGC_WORKER_TOKEN=<token> -e HF_HOME=/workspace/hf -p 8765:8765 <image>
# 入口脚本会写 /tmp/aigc-worker-token（0600）并补 --host/--port/--no-install。
ENTRYPOINT ["/usr/local/bin/aigc-worker-entrypoint"]
CMD []
