# 私有 GPU Worker 镜像（Docker / RunPod / Vast.ai / 自有 Linux 服务器）
#
# 阶段 0 基线（docs/GPU_RUNTIME_BASELINE_PLAN.md §2 / §10）：
# - 基础镜像 `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime`：Python 3.11 + torch 2.6.0 + CUDA 12.4，
#   runtime 层不含 nvcc（压缩约 3.3GB），比 devel 小一半且不需要编译自定义算子；
# - 依赖在 `worker/requirements-gpu.txt` 精确锁定，pip 不得重装或升级 torch；
# - 容器**以 root 运行**：RunPod Network Volume 挂到 /workspace 后属主是 root:root，
#   镜像内的非 root 用户写不进去会静默回退 /tmp/hf（不持久 + 写爆 20GB 容器盘），
#   见规划 §7「挂载卷权限死锁」；Vast SSH 模式同样以 root 进容器。
#
# 构建（仓库根目录）：
#   docker build -f worker/deploy/Dockerfile -t ghcr.io/<owner>/aigc-worker:0.15.0 .
#
# 固定 digest（推荐；CI 用 --build-arg 覆盖，不把不可核验的 digest 写死在这里）：
#   docker build \
#     --build-arg BASE_IMAGE=pytorch/pytorch@sha256:<digest> \
#     -f worker/deploy/Dockerfile -t ghcr.io/<owner>/aigc-worker:0.15.0 .
#
# 镜像只含代码与 Python 依赖，**不含任何模型权重**（非商用许可的权重不能进公开镜像）；
# 权重由运行时按需下载到 HF_HOME（RunPod 卷 /workspace/hf 或 Vast 本地盘）。
#
# 云端环境变量约定：
#   AIGC_WORKER_TOKEN=<32 字节随机 hex>   （入口脚本落成 0600 临时文件，不进进程参数）
#   HF_HOME=/workspace/hf                 （海外节点不要设 HF_ENDPOINT=hf-mirror.com）
#   AIGC_WORKER_CPU_OFFLOAD=auto|on|off   （可选，压测 A/B 用；默认 auto 跟随模型资产）

ARG BASE_IMAGE=pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.title="aigc-worker" \
      org.opencontainers.image.description="AIGC Studio private GPU worker (protocol v2, no model weights)" \
      org.opencontainers.image.source="https://github.com/nanxfu/aigc-studio" \
      org.opencontainers.image.licenses="MIT"

# apt 非交互：用 ARG 而不是 ENV，避免把 DEBIAN_FRONTEND 带进运行期环境。
ARG DEBIAN_FRONTEND=noninteractive

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf \
    HF_HUB_CACHE=/models/hf/hub \
    HF_XET_HIGH_PERFORMANCE=1 \
    AIGC_WORKER_ARTIFACT_DIR=/tmp/aigc-artifacts

# 构建期断言解释器版本：基础层被替换成 3.10/3.12 时立刻失败，而不是运行期才报
# diffusers 0.43 的 requires-python 冲突。conda 环境里 python3 指向 /opt/conda/bin/python。
RUN python3 -c "import sys; assert sys.version_info[:2] == (3, 11), 'need Python 3.11, got %s' % sys.version" \
    && python3 -m pip --version

# 只补 healthcheck 需要的 curl；基础镜像已带 ca-certificates。
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只拷依赖清单，利用层缓存：改业务代码不必重装 torch。
# 不升级 pip：conda 镜像自带版本足够解析锁定清单，升级 pip 只会引入新的漂移面。
COPY worker/requirements-gpu.txt /app/worker/requirements-gpu.txt
RUN python3 -m pip install -r /app/worker/requirements-gpu.txt

# 依赖对齐断言（阶段 0 验收项）：版本与 CUDA 轮子任一不符就让构建失败。
# 同时验证推理栈可导入——这比只看 pip 退出码更能挡住"解析成功但 import 失败"的组合。
RUN python3 -c "\
import torch, torchvision, diffusers, transformers, accelerate, peft, huggingface_hub; \
assert torch.__version__.startswith('2.6.0'), torch.__version__; \
assert torch.version.cuda == '12.4', torch.version.cuda; \
assert torchvision.__version__.startswith('0.21.0'), torchvision.__version__; \
assert diffusers.__version__ == '0.43.0', diffusers.__version__; \
assert transformers.__version__ == '5.23.0', transformers.__version__; \
assert accelerate.__version__ == '1.15.0', accelerate.__version__; \
assert peft.__version__ == '0.21.3', peft.__version__; \
assert huggingface_hub.__version__ == '1.33.0', huggingface_hub.__version__; \
print('deps ok:', torch.__version__, torchvision.__version__, diffusers.__version__, transformers.__version__)"

# Worker 只依赖仓库根的 worker/ 包；shared/、前端与测试不需要进镜像（见 .dockerignore）。
COPY worker /app/worker

# 模型缓存与产物目录：作为 root 预建，挂载卷由平台负责；产物目录权限由
# worker/jobs/artifacts.py 在运行时按 0700 收紧（这里只是给它一个落点）。
RUN mkdir -p /models/hf/hub /tmp/aigc-artifacts

# 入口脚本负责：AIGC_WORKER_TOKEN → 0600 临时文件、HF_HOME 不可写时回退 /tmp（兜底，
# root 运行下通常不触发）、转发 --host/--port/--no-install。
COPY worker/deploy/docker-entrypoint.sh /usr/local/bin/aigc-worker-entrypoint
RUN chmod 755 /usr/local/bin/aigc-worker-entrypoint

EXPOSE 8765

# /healthz 免鉴权、只回 {"ok":true}；详细 /health 仍需 Bearer。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8765/healthz || exit 1

# 容器内默认 auto 绑定 :: 双栈（同时承接 SaladCloud IPv6 网关与容器内 127.0.0.1 健康检查），
# 若宿主机内核禁用了 IPv6 则自动回退 0.0.0.0；宿主机侧仍只映射 127.0.0.1（见 compose）。
ENTRYPOINT ["/usr/local/bin/aigc-worker-entrypoint"]
CMD []
