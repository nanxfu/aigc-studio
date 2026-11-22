# GPU 服务商选型：RunPod / Vast.ai / AutoDL（2026-11-22）

> 结论先行：**可以转向，而且容器原生平台比 AutoDL 更适合本项目。**
> 我们的私有 Worker 已经是「Docker 镜像 + HTTP API + Bearer Token」，RunPod / Vast 都支持
> 自定义镜像、端口暴露与 API 自动化；AutoDL 不支持导入自定义镜像，只能靠私有快照反复搭环境。
>
> **建议：RunPod Secure Cloud 主选（A5000 24G 约 $0.27/小时），Vast.ai 作为低价备选
> （4090 中位约 $0.47/小时）；AutoDL 冻结，不再投入。**

---

## 1. 对比

| 维度 | RunPod | Vast.ai | AutoDL（Pro） |
| :--- | :--- | :--- | :--- |
| 自定义 Docker 镜像 | ✅ Template 直接填 image | ✅ 租实例时指定 image | ❌ 官方明确不支持导入 |
| 环境复用 | 镜像 + Network Volume | 镜像 + 实例磁盘/卷 | 只能保存私有快照，构建慢 |
| HTTPS 入口 | ✅ `https://<pod>-<port>.proxy.runpod.net` | ❌ 直连 `http://host:port`，需 SSH 隧道/Caddy | ✅ 6006 自定义服务 |
| 长连接 / SSE | ⚠️ 代理 100 秒超时，SSE 会被切断 | ✅ SSH 隧道内可长连接 | ⚠️ 6006 代理可能缓冲 |
| 持久模型卷 | ✅ Network Volume（Secure Cloud） | ⚠️ 实例本地盘/卷，跨实例弱 | ✅ 系统盘/私有镜像 |
| RTX 4090 24G | Secure $0.89/小时；Community 更低 | 起价 $0.27，中位 $0.47/小时 | 约 ¥1.88/小时 |
| RTX A5000 24G | **$0.27/小时** | 起价 $0.16，中位 $0.22/小时 | 无对应规格 |
| 计费粒度 | 按秒 | 按秒 | 按秒 |
| API 自动化 | ✅ REST / GraphQL | ✅ REST / CLI / SDK | ✅ Pro API |
| 国内支付/访问 | 国际卡/加密货币，延迟较高 | 国际卡/加密货币，延迟较高 | 本地支付，访问快 |
| 稳定性 | 高（Secure Cloud） | 市场型，host 差异大 | 高 |

> 价格以官网现价为准；RunPod 的 Community Cloud 通常比 Secure 便宜，但网络卷只在 Secure 可用。

---

## 2. 为什么容器原生平台更适合我们

现有 Worker 的部署形态已经就是容器：

- `worker/deploy/Dockerfile`：CUDA runtime + Python 依赖 + Worker 代码；
- `worker/worker_server.py`：监听 `0.0.0.0:8765`，Bearer Token，`/healthz`、`/generate`、`/job`、`/artifact`、`/events`；
- Host 侧已经有 `private-worker` provider：只需要 **endpoint + token**，不关心背后是 Docker、K8s 还是云平台。

因此切换到 RunPod / Vast **不需要新增 provider**：把平台上的 Worker 当成一个普通私有 Worker，填地址和 Token 即可。

镜像里只放代码与依赖，**不放模型权重**；模型放持久卷或首次启动时下载：

```text
镜像：ghcr.io/<owner>/aigc-worker:<version>   （约 8–10GB，代码 + torch/diffusers）
卷：  /workspace/hf                            （HF_HOME，sdxl 6.78GB，flux2 16GB 按需）
```

---

## 3. 推荐部署方式

### 3.1 RunPod（主选）

1. 构建并推送镜像到 GHCR / Docker Hub（公开镜像即可，不含任何密钥）；
2. 创建 **Network Volume**（20–30GB，Secure Cloud，挂在 `/workspace`）；
3. 用镜像创建 Pod：
   - GPU：A5000 24G（$0.27/h，sdxl/放大/重绘足够）或 4090 24G（$0.89/h）；
   - Expose HTTP Ports：`8765`；
   - Env：`AIGC_WORKER_TOKEN=<32 字节随机 hex>`、`HF_HOME=/workspace/hf`、`HF_ENDPOINT=https://hf-mirror.com`；
   - Container Disk：20GB；Network Volume：20–30GB；
4. 启动后地址为 `https://<pod-id>-8765.proxy.runpod.net`，在 AIGC Studio「私有 Worker」里填该地址 + Token；
5. 首次生成会下载 sdxl（约 6.8GB），之后同一 Network Volume 复用。

**注意**：RunPod HTTP 代理经过 Cloudflare，**单连接 100 秒超时**。我们的 `/generate` 是异步的、`/job` 是短轮询，不受影响；`/events` SSE 会在 100 秒被切断。Host 已改为**从 `/job` 的 `progress.step/steps` 驱动步数进度**，所以 SSE 断了也不影响 UI；需要长连接时用 TCP 暴露 + SSH 隧道。

### 3.2 Vast.ai（低价备选）

1. 搜索 on-demand 实例：4090 24G（中位 $0.47/h）或 A5000 24G（中位 $0.22/h）；
2. 镜像填同一个 GHCR 镜像，端口映射 `-p 8765:8765`；
3. 环境变量同上；本地盘通常够放 sdxl，flux2 建议选 50GB+ 磁盘；
4. **Vast 会替换镜像入口点**（SSH/Jupyter 模式），必须用 `onstart` 启动 Worker：
   ```bash
   python3 /app/worker/worker_server.py --host 0.0.0.0 --port 8765 --no-install
   ```
   或直接执行 `/usr/local/bin/aigc-worker-entrypoint`；Token 通过 `AIGC_WORKER_TOKEN` 环境变量传入；
5. 选 host 时确认驱动版本 **>= 550**（镜像基于 CUDA 12.4）；驱动更旧时改用 cu121 基础镜像重构建；
6. 启动后用 SSH 隧道把端口映射到本机：
   ```bash
   ssh -CNg -L 8765:127.0.0.1:8765 -p <ssh_port> root@<host>
   ```
7. AIGC Studio 填 `http://127.0.0.1:8765` + Token（回环地址允许明文 HTTP）。

Vast 是市场型平台，host 质量参差；优先选 verified、on-demand、磁盘充足的实例，不要用 interruptible 跑长任务。

---

## 4. 需要适配的三个点（已完成两项）

| 问题 | 处理 | 状态 |
| :--- | :--- | :--- |
| 平台只给环境变量，没有 `/run/secrets/worker-token` | 新增 `worker/deploy/docker-entrypoint.sh`：`AIGC_WORKER_TOKEN` → `/tmp/aigc-worker-token`（0600），再传给 `worker_server` | ✅ 已完成 |
| 网络卷/容器盘常为 root 所有，镜像默认 `USER worker` 写不进去 | 入口脚本检测 `HF_HOME` 不可写时回退 `/tmp/hf`；要持久化则在平台侧以 root 运行或先 chown 卷 | ✅ 已兜底，持久化需平台配置 |
| RunPod 代理 100 秒切断 SSE | Host `onProgress` 改为同时读取 `/job` 的 `progress.step/steps`，轮询即可驱动步数 | ✅ 已完成 |

---

## 5. 成本估算

| 场景 | 成本 |
| :--- | :--- |
| RunPod A5000 24G 跑 30 分钟验收 | ≈ $0.14（约 ¥1.0） |
| RunPod 4090 24G 跑 30 分钟 | ≈ $0.45（约 ¥3.2） |
| Vast 4090 中位价跑 30 分钟 | ≈ $0.24（约 ¥1.7） |
| RunPod Network Volume 20GB | $1.4/月 |
| 对比：AutoDL `v-48g` 68 分钟 | ¥35.5（已发生，0 产出） |

结论：即使按 RunPod Secure 4090 算，一次完整验收也只要几元人民币；A5000 更便宜。**不再需要为了省环境搭建时间而选高价卡。**

---

## 6. 风险与边界

- **支付/注册**：RunPod / Vast 主要支持国际信用卡/加密货币，国内用户可能需要外卡；这是接入前的前置条件。
- **网络延迟**：美区/欧区到国内 150–250ms，API 轮询与图片下载可接受；SSE 建议走 SSH 隧道。
- **市场型稳定性**：Vast 的 host 可能重启/迁移；长任务用 on-demand + 断点续跑，重要任务优先 RunPod Secure。
- **模型许可证**：公开镜像不要打包 FLUX.2 Klein 9B、Qwen-Image 2.1、Anima 等非商用/研究许可权重；让用户首次启动自行下载。可公开的只有 SDXL Lightning、SANA-Sprint、Z-Image Turbo。
- **安全**：镜像不含 Token；Token 只通过环境变量注入；不要打开 `--allow-shutdown`；公网入口必须 Bearer 鉴权。

---

## 7. 下一步（待确认）

> 运行环境的版本基线、GPU 公约数与镜像分层已单独整理为 [`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md)，供环境/平台专员审阅。

1. 增加一个 GitHub Actions workflow：tag 时构建并推送 `ghcr.io/<owner>/aigc-worker:<tag>`；
2. 在 RunPod 建 Template + Network Volume，按 §3.1 跑一次 sdxl 文生图 / 放大 / 局部重绘；
3. 在 AIGC Studio 用「私有 Worker」连接，验证 binary 产物与步数进度；
4. 若验证通过，再决定是否把 RunPod 做成可选 provider（一键创建/关机）；**当前不需要改 provider 代码**。

> 本文只做选型调研与容器入口适配，**没有启动任何 GPU 实例**。

---

## 8. RunPod Serverless：按秒计费，但不是 Pod 的替代品

### 8.1 计费

RunPod **不是按小时计时**：Pod 和 Serverless 都按秒计费。但 Serverless 的每秒单价明显高于 Pod：

| GPU | Serverless 每秒 | 折合每小时 | 对比 Pod（Secure） |
| :--- | :--- | :--- | :--- |
| L4 / A5000 / 3090 24G | $0.00019 | ≈ $0.684 | A5000 Pod $0.27/h |
| 4090 PRO 24G | $0.00031 | ≈ $1.116 | 4090 Pod $0.89/h |
| A6000 / A40 48G | $0.00034 | ≈ $1.224 | A6000 Pod $0.69/h |
| L40 / L40S / 6000 Ada 48G | $0.00053 | ≈ $1.908 | L40S Pod $1.09/h |
| A100 80G | $0.00076 | ≈ $2.736 | A100 Pod $2.09/h |

计费细节：

- **冷启动计费**：worker 从启动到 ready 的时间照常计费；
- **空闲等待计费**：最后一个请求结束后，worker 还会保留 `idle timeout`（默认 5 秒，可调）等待新请求，这段时间计费；
- **Active workers**：设为 1+ 可以消除冷启动，但会持续计费（即使没有请求）；
- 缩容到 0 后停止计费。

### 8.2 两种 Endpoint，适配成本不同

| 类型 | 工作方式 | 对我们的适配 |
| :--- | :--- | :--- |
| **Queue-based** | 必须写 `handler(job)` + `runpod.serverless.start`，RunPod 管理队列与重试 | 需要把 `worker_server` 的生成逻辑抽成 handler；`/artifact` 二进制端点不存在，结果要 base64 或传 S3；payload 限制 10MB/20MB |
| **Load balancing** | 直接跑任意 HTTP 服务（FastAPI/Flask），无需 handler，支持自定义路径与流式 | **最接近现有 Worker**，但有 5.5 分钟处理超时、30MB payload 限制 |

Load balancing 的关键限制：

- 无 worker 时请求 2 分钟超时，冷启动期间可能返回 “no workers available”；
- **单请求处理上限 5.5 分钟**：我们的 `/generate` 是异步的（立即返回 jobId），`/job` 与 `/artifact` 都是短请求，能过；`/events` 长连接会被切断，走轮询兜底；
- **多 worker 状态不共享**：我们的 `JobStore` 与产物文件在进程内存/本地盘，负载均衡会把 `/generate`、`/job`、`/artifact` 分发到不同 worker，导致 `job not found` 或产物 404。**必须把 max workers 设为 1**，或把任务状态与产物外置到 Redis/S3。

### 8.3 结论

- **桌面端间歇使用**：优先 **Pod**（A5000 $0.27/h，显式连接/断开），比 Serverless 便宜且没有状态分片问题；
- **公开多用户 API / 突发流量**：Serverless 更合适，但要先做两件事之一：
  1. Load balancing + `max workers=1`（简单，但无横向扩展）；
  2. Queue-based handler 适配 + 外置 JobStore/产物存储（工作量大，但可扩展）。
- 不建议把现有 Worker 直接丢进 Serverless 多 worker 负载均衡——`/job` 会随机 404。

---

## 9. 模型要不要烤进 Docker 镜像？

**技术上可以，但不建议默认这么做。** 正确做法是「镜像分层」：

| 层 | 内容 | 构建方式 | 大小 |
| :--- | :--- | :--- | :--- |
| 基础镜像 | CUDA runtime + Python + torch/diffusers + Worker 代码 | GitHub Actions / 本地 Docker | 约 8–10GB |
| 模型层 | sdxl 6.78GB / flux2 16GB / qwen 30GB | Network Volume 或首次启动下载 | 0（镜像外） |

为什么不把模型烤进 GitHub Actions 构建的镜像：

1. **GitHub 托管 runner 磁盘约 14GB**，CUDA 基础镜像 + torch + 模型很容易超过，构建会因 `no space left on device` 失败；要用更大/自托管 runner。
2. **镜像体积与拉取时间**：20–40GB 镜像在 RunPod 上拉取可能比 Network Volume 首次下载还慢，且容器盘要跟着扩容。
3. **许可证**：公开镜像会重新分发权重；FLUX.2 Klein 9B（非商用）、Qwen-Image 2.1（研究许可）、Anima（非商用）不适合公开镜像。私有镜像/私有 registry 才相对安全。
4. **迭代成本**：模型更新要重建并重推镜像；Network Volume 只需替换文件。

如果确实要「一个镜像包含所有东西」：

- 用**私有 registry**（GHCR private / Docker Hub private）；
- 在有 100GB+ 磁盘的机器上构建（不要用 GitHub 托管 runner）；
- 只烤可公开许可的模型（SDXL Lightning、SANA、Z-Image），非商用模型首次启动下载；
- Dockerfile 里把模型下载放在最后几层，代码改动不会触发模型层重下。

> 结论：**镜像负责「能跑」，卷负责「有模型」。** 这样 GitHub Actions 只构建 8–10GB 的基础镜像，RunPod Network Volume 预置一次模型，冷启动和成本都更可控。
