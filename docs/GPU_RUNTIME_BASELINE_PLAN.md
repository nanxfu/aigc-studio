# GPU 运行环境基线规划（RunPod / Vast 方向）

> 状态：**阶段 0 已完成（2026-11-22，CI 实测通过）**，待阶段 1 真机 MVP 验收；全程未启动任何 GPU 实例。
> 目标读者：负责 GPU 平台接入 / 镜像构建 / 模型运行环境的专员。
> 关联文档：[`GPU_PROVIDER_COMPARISON.md`](GPU_PROVIDER_COMPARISON.md)、[`AUTODL_WORKER_RESEARCH.md`](AUTODL_WORKER_RESEARCH.md)、[`M3_PRIVATE_WORKER_AND_MCP_PLAN.md`](M3_PRIVATE_WORKER_AND_MCP_PLAN.md)。

---

## 1. 背景与诉求

### 1.1 已经发生的事

- AutoDL Pro 已尝试接入，但该平台**不支持导入自定义 Docker 镜像**，只能保存私有快照；基础镜像 Python 3.8 / torch 2.0 与 Worker（要求 Python ≥3.10）不兼容。
- 误选了 `v-48g`（4090-48G）规格，实际单价 **¥30.30/小时**，68 分钟消耗 ¥35.5，环境仍未装完，0 产出；实例已释放。
- 结论：AutoDL 冻结，转向 **RunPod / Vast.ai** 这类容器原生平台。

### 1.2 我们的诉求与策略边界

1. **一次构建，长期复用（不依赖服务商模板 List）**：Worker 代码、Python 依赖、CUDA 运行库固化在自有 Docker 镜像里，不在每次开机时 `git clone` + `pip install`。服务商提供的 PyTorch 模板通常只包含 Python/torch（多为较大的 `devel` 镜像），仍需现场装 `diffusers`/`transformers` 且易受上游漂移与预装冲突（如 `torchao`）影响，不维护跨平台模板 List。
2. **模型与镜像分离**：模型放持久卷或本地卷，避免每次重下；镜像保持可维护的 6–10GB。
3. **不锁死平台与卡型，用数据收敛最佳方案**：同一镜像和 `private-worker` 协议可在 RunPod Pod、Vast.ai、自有 Docker 服务器之间自由切换；先跑通公约基线，再通过长期追踪不同显卡与 `cpuOffload` 开关的耗时/显存/单张成本，数据驱动地决定选型。
4. **成本可控**：先用 24GB 主流卡（A5000 / 4090）做 MVP 验收，不盲目开 48GB 高价卡；同时也不为了每小时差几毛钱去抠 12–16GB 小卡（算上慢推理与换卡冷启动往往更贵），重点对比「24GB + `cpuOffload`」与「32GB/48GB 关 `cpuOffload`」的单张成本。

### 1.3 非目标

- 本阶段不做 RunPod Serverless 的生产化适配（原因见 §8）。
- 不把非商用模型权重打进公开镜像。
- 不追求「所有 GPU 型号」兼容；只保证 Ampere 及更新（原生 bf16）、24GB 显存以上的主流卡。
- 不在跑通 MVP 前提前开发复杂的自动选卡路由或跨平台模板管理器。

---

## 2. 结论摘要（给审阅者的 TL;DR）

1. **公约环境建议（已落地）**：Python 3.11 + torch 2.6.0 + CUDA 12.4（cu124）+ diffusers 0.43.0 + transformers 5.23.0；驱动要求 **≥550**。[`worker/deploy/Dockerfile`](../worker/deploy/Dockerfile) 已切到该基线并加构建期断言，[`worker/requirements-gpu.txt`](../worker/requirements-gpu.txt) 已精确锁定，pip 不会覆盖镜像内 `torch 2.6+cu124`。
2. **公约 GPU 与分档策略**：**24GB Ampere/Ada**（A5000 / 3090 / 4090）是 MVP 最低公约数，可跑完 7 款模型（1024 分辨率实测峰值 ≤18.1GB）；针对 9B/Qwen，后续用实测数据对比「24GB 开 `cpuOffload`」与「32GB/48GB 关 `cpuOffload`」的单张综合成本，不提前把选型写死。
3. **基础镜像与权限（已落地）**：使用官方 `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime`（Python 3.11、torch 2.6.0、压缩约 3.3GB），不用 devel/NGC 大镜像；云端镜像**改为 root 运行**，消除旧 `USER worker`（UID 10001，无 `sudo`）与 RunPod `/workspace`（`root:root`）的权限死锁（此前会静默回退 `/tmp/hf` 写爆容器盘）。
4. **镜像分层与下载源**：镜像只放代码 + 依赖；模型放卷目录（RunPod `/workspace/hf` 或 Vast 本地盘）。RunPod/Vast 等海外节点**不要设置 `HF_ENDPOINT=https://hf-mirror.com`**，直接走 HuggingFace 官方 CDN；`upscale` 权重（67MB）位于 `<work_dir>/sr/`。
5. **平台优先级**：**Pod 优先**（A5000 约 $0.27/h，Vast 4090 中位约 $0.47/h）；协议与镜像保持平台中立，暂不绑定单家；Serverless 只留作后续公开多用户 API 选项。
6. **渐进式验证与长期追踪**：先花 ~¥1 跑通 2 模型 MVP（`sdxl-lightning` + `flux2-klein-4b`），再做 `flux2-klein-9b` 开/关 `cpuOffload` 跨卡压测，并逐步接入 Trace 账本长期追踪耗时、显存与单张成本。

---

## 3. 模型运行需求矩阵

数据来自 `models/*.json` 的 `measured` 字段（真机实测）与 `pipeline` 配置。

| 模型 | 参数量/体积 | 下载体积 | 1024 峰值显存 | dtype / offload | 单卡 24GB | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| SDXL Lightning | 3.5B + LoRA | 6.78GB | 10.3GB | auto / 无 | ✅ 宽裕 | 支持图生图、局部重绘 |
| SANA-Sprint 1.6B | 1.6B | 9.07GB | 10.3GB | bf16 / 无 | ✅ 宽裕 | 2 步出图 |
| Anima Turbo v1.1 | 2B | 5.25GB | 8.5GB | auto / 无 | ✅ 宽裕 | 二次元，非商用许可 |
| FLUX.2 Klein 4B | 3.88B | 16.0GB | 7.9GB | auto / balanced | ✅ 低风险（需实测确认） | JSON 标称 2 卡；代码 `_apply_device_map_kwarg` 在 `device_count==1` 时已自动跳过分片 |
| FLUX.2 Klein 9B | 9B | 34.7GB | 18.1GB | bf16 / cpuOffload | ⚠️ 余量 6GB | JSON 写死 `cpuOffload: true`（实测 130.9s）；需对比 32G/48G 关 offload 耗时；gated |
| Qwen-Image 2.1 | 7B + Qwen3-VL | 30.26GB | 16.8GB | bf16 / cpuOffload | ⚠️ 余量 7GB | JSON 写死 `cpuOffload: true`（实测 43.7s）；研究许可；建议后续测 32G 关 offload |
| Z-Image Turbo | 6B | 30.64GB | 12.2GB | bf16 / cpuOffload | ✅ 可用 | 30GB 权重，磁盘要够 |

**关键结论**：

- 按实测峰值，**24GB 显存可以跑完全部 7 款模型**（1024 分辨率）；9B/Qwen 余量只有 6–7GB，且由于默认开启 `cpuOffload: true` 耗时较长，需要对比 32GB/48GB 关闭 `cpuOffload` 后的真实单张成本。
- **`cpuOffload` 覆盖能力已补齐（阶段 0）**：[`models/flux2-klein-9b.json`](../models/flux2-klein-9b.json) 等文件写死 `"cpuOffload": true`，[`worker/inference/loaders/diffusers.py`](../worker/inference/loaders/diffusers.py) 会无条件启用 CPU offload；现在由 [`worker/inference/policy.py`](../worker/inference/policy.py) 在加载前按 `AIGC_WORKER_CPU_OFFLOAD`（`auto|on|off`，等价启动参数 `--cpu-offload`）覆写，模型资产默认值不变，`/health.cpu_offload` 上报本次实际值。
- `cpuOffload=True` 的模型（flux2-9b / qwen / z-image）需要 **32GB 以上系统内存**，否则 offload 会把内存打满（Vast 选机时需硬性过滤 RAM）。
- 全部模型下载合计约 **132.7GB**；MVP 先只测 `sdxl-lightning` + `flux2-klein-4b`（约 **22.8GB**），不建议首次验收直接拉全量 7 模型。
- **T4 / V100 不在支持范围**：bf16 模型需要 Ampere 及以上；T4 是 Turing、V100 是 Volta，均无原生 bf16。

---

## 4. 依赖版本：为什么是 Python 3.11 + torch 2.6 + CUDA 12.4

### 4.1 硬约束来自模型库，不是我们随便选的

| 包 | 版本 | 硬约束 | 依据 |
| :--- | :--- | :--- | :--- |
| diffusers | **0.43.0** | Python ≥3.11；torch ≥2.6（torch extra） | PyPI 元数据；QwenImage21Pipeline / Flux2KleinPipeline / ZImagePipeline 需要 0.43 |
| transformers | **5.23.0** | Python ≥3.11；torch ≥2.6 | PyPI 元数据；Qwen-Image 2.1 需要 5.23 |
| accelerate | 1.15.0 | torch ≥2.0 | LKGR 已验证 |
| peft | 0.21.3 | torch ≥1.13 | LKGR 已验证 |
| huggingface-hub | 1.33.0 | diffusers 要求 ≥1.32、<3 | LKGR 已验证 |
| torch | **2.6.0+cu124** | 满足 diffusers/transformers 的 ≥2.6 | PyTorch 官方 cu124 轮子 |
| torchvision | 0.21.0 | 与 torch 2.6 配套 | PyTorch 版本矩阵 |
| Python | **3.11** | diffusers 0.43 / transformers 5.x 的下限 | PyPI `requires_python` |

> 仓库里已有的 LKGR（`docs/TROUBLESHOOTING.md` §8）验证组合是：
> diffusers 0.43.0 / transformers 5.22.2 或 5.23.0 / accelerate 1.15.0 / peft 0.21.2 或 0.21.3 /
> huggingface-hub 1.33.0，运行在 Kaggle 2×T4、torch 2.11 + Python 3.13 上。
> 本方案把 torch 降到 2.6、Python 降到 3.11，是为了扩大平台/驱动兼容性；**需要一次真机复验**。

### 4.2 CUDA 12.4 与驱动

- torch 2.6.0 提供 **cu124** 与 cu126 两种轮子；选 **cu124**，因为驱动门槛更低（≥550），覆盖更多 RunPod/Vast host。
- CUDA 12.4 要求 NVIDIA 驱动 **≥550**；Vast 选 host 时必须筛驱动版本，RunPod Secure 一般满足。
- 不选 CUDA 12.1：torch 2.6 没有 cu121 轮子；降到 torch 2.5 又会被 diffusers 0.43 的 `torch>=2.6` 拒绝。
- 不选 CUDA 13.x：驱动门槛更高（≥580），host 覆盖反而变窄。

### 4.3 不建议的替代方案

| 方案 | 为什么不选 |
| :--- | :--- |
| Python 3.10 | diffusers 0.43 / transformers 5.x 要求 ≥3.11，装不上 |
| torch 2.4 / 2.5 | diffusers 0.43 的 torch extra 要求 ≥2.6；Qwen/Flux2 可能直接 import 失败 |
| CUDA 12.1 | 没有 torch 2.6 轮子；只能配 torch 2.5，回到上一条 |
| CUDA 12.6 | 驱动门槛 ≥560，host 覆盖变窄；对现有模型没有收益 |
| T4 / V100 | 无 bf16，flux2-9b / qwen / z-image 跑不了或精度不对 |

---

## 5. GPU 公约数与分档思路（不锁死）

| 档位 | 代表卡 | 显存 | 适用 | 结论 |
| :--- | :--- | :--- | :--- | :--- |
| 入门（24G 性价比） | A5000 / 3090 | 24GB | sdxl / sana / anima / flux2-4b / z-image；9B/Qwen 可兜底跑但偏慢 | **MVP 最低公约数**，RunPod $0.27/h、Vast 中位 $0.22/h |
| 主力（24G 高算力） | 4090 | 24GB | 同上，推理速度通常是 A5000 的 2–3 倍 | RunPod $0.89/h、Vast 中位 $0.47/h（单张电费常与 A5000 接近） |
| 大模型档（待 A/B 测） | 5090 | 32GB | 9B / Qwen 尝试关闭 `cpuOffload`、高分辨率 | RunPod $1.39/h、Vast 中位 $0.65/h |
| 大显存（仅必要时） | A6000 / A40 / L40S | 48GB | 32G 仍不足或需关闭 `cpuOffload` 批量跑 9B | 按 A/B 测后的单张成本决定是否采用 |

- **为什么不刻意选 12–16GB 更便宜的小卡（如 A4000 / 4060Ti）**：与 24GB（A5000/3090）每小时只差约 ¥0.4–0.6，但算力更慢且容易在切模型时 OOM，导致换卡重拉镜像/重新冷启动，综合成本反而更高。
- **核心选型问题留给数据回答**：不提前锁死「一定用哪张卡」，而是通过后续 §10 的开/关 `cpuOffload` 实测，计算各卡型在 **单张稳态成本** 与 **含冷启动短会话成本** 下的真实胜者。
- **系统内存**：24GB 卡建议配 **32GB 以上 RAM**；`cpuOffload` 模型在 16GB RAM 的 Pod 上可能 OOM。
- **磁盘**：MVP 验证（sdxl + flux2-4b）用 40–50GB 够；全部 7 模型约 150GB 卷。

---

## 6. 平台镜像模板调研

| 基础镜像 | 压缩体积 | Python | torch | CUDA | 评价 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime`** | **约 3.3GB** | **3.11（待构建时确认）** | **2.6.0** | **12.4** | **推荐**：runtime 不含 nvcc，体积小；平台中立；torch/CUDA 已配好 |
| `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel` | 更大 | 3.11 | 2.6.0 | 12.4 | 不推荐：带 nvcc/编译工具，我们用不到 |
| `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel` | 7.4GB | 3.11 | 2.4.0 | 12.4 | 不推荐：torch 2.4 低于 diffusers 0.43 的 2.6 要求；devel 体积大 |
| `runpod/base` 新系列 | 2.7–10GB | 3.12+ | 无/可选 | 12.8–13.2 | 不推荐：驱动门槛高、版本跳得太快 |
| `vastai/base-image:cuda-12.4.1-auto` | 6.0GB | 3.10–3.14 变体 | 无 | 12.4 | 备选：只有 CUDA/Python，还要自己装 torch；体积比官方 PyTorch 大 |
| NGC `nvcr.io/nvidia/pytorch:*` | 10GB+ | 3.10–3.12 | 2.3–2.6 | 12.4–12.8 | 不推荐：devel 体积大、版本随 NGC 月度更新，不可控 |

**结论**：不要依赖平台「PyTorch 模板」List（它们只管 CUDA/Python，仍要每次开机拉代码和 pip 装 diffusers/transformers，且存在预装包冲突风险）；用官方 PyTorch runtime 镜像做唯一 base 构建自有镜像，RunPod / Vast / 自有机器共用同一份确定性镜像。

> 注：两项现行代码差异已在阶段 0 解决：
> 1. ~~现行 [`worker/deploy/Dockerfile`](../worker/deploy/Dockerfile) 基于 Ubuntu 22.04（apt `python3` 为 3.10）~~ → 已替换为 `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime`（Python 3.11 在 `/opt/conda/bin/python`），并加构建期解释器断言；
> 2. ~~[`worker/requirements-gpu.txt`](../worker/requirements-gpu.txt) 必须锁定版本~~ → 已精确锁定 `torch==2.6.0+cu124` / `torchvision==0.21.0+cu124` / `diffusers==0.43.0` 等，Dockerfile 再断言一次，pip 不会重装或升级 torch。

---

## 7. 分层架构与镜像/存储注意事项

| 层 | 内容 | 存放位置 | 更新频率 |
| :--- | :--- | :--- | :--- |
| 基础镜像 | CUDA runtime + Python 3.11 + torch 2.6 + diffusers/transformers 等 | GHCR / Docker Hub | 依赖升级时 |
| Worker 层 | `worker/` 代码 + 入口脚本 | 同一镜像（COPY） | 每次发版 |
| 模型层 | sdxl / flux2 / qwen / …（+ `<work_dir>/sr/` 下的 67MB upscale 权重） | RunPod 卷 `/workspace/hf`；Vast 本地盘 | 按需 |
| 配置层 | Token、HF Token、端口、空闲超时 | 平台环境变量 | 每次创建 |

**必须解决的 3 个云端落地细节**：

1. **挂载卷权限死锁（已在阶段 0 解决）**：旧 `Dockerfile` 使用无 `sudo` 的非 root 用户 `USER worker`（UID 10001），而 RunPod Network Volume `/workspace` 挂载后属主为 `root:root`，会导致 [`docker-entrypoint.sh`](../worker/deploy/docker-entrypoint.sh) 静默回退到 `/tmp/hf`，既无法持久化，又会撑爆默认 20GB 的容器盘。云镜像现已改为 root 运行，`/workspace` 直接可写。
2. **国内镜像源仅限国内节点**：RunPod / Vast 机器主要位于欧美机房，**不要设置 `HF_ENDPOINT=https://hf-mirror.com`**（与 [`GPU_PROVIDER_COMPARISON.md`](GPU_PROVIDER_COMPARISON.md) 旧示例区分），否则会跨太平洋回源拉权重导致降速或限流；只有国内机器（如 AutoDL）才需要设 `hf-mirror`。
3. **GitHub Actions 构建空间（已实测）**：基础镜像自带 torch/CUDA，pip 只补 diffusers 等推理包（新增层约 78MB 压缩），最终镜像 **压缩 3.16GB / 未压缩 6.07GB**——比本文早期估计的 6–8GB / 8–10GB 更小，原因是基础层已含 torch 2.6.0+cu124，pip 未重下 PyTorch。即便如此，GitHub 托管 runner 默认仅约 14GB 可用空间，workflow 仍必须先清理预装的大体积工具链（`.NET`、Android SDK、GHC、CodeQL），否则构建报 `no space left on device`。

**模型卷预算**：

- MVP 验证（`sdxl-lightning` + `flux2-klein-4b`）：约 **22.8GB**（前期建议直接用 Pod 本地 Volume Disk 40–50GB，不急着建 Network Volume，避免被锁定在单个数据中心导致低价卡缺货）；
- 全量 7 模型：约 **133GB**；长期固定区域使用 RunPod Network Volume（$0.07/GB/月）时，50GB 约 $3.5/月，150GB 约 $10.5/月。

---

## 8. Pod vs Serverless：为什么优先 Pod

| 维度 | Pod | Serverless |
| :--- | :--- | :--- |
| 计费 | 按秒；A5000 $0.27/h、4090 $0.89/h | 按秒；A5000 $0.00019/s ≈ $0.684/h、4090 $0.00031/s ≈ $1.116/h |
| 空闲 | 关机即停；需显式停止 | 缩容到 0 即停；idle timeout 内仍计费 |
| 冷启动 | 容器拉取 + 模型加载 | 同样有冷启动，且冷启动计费 |
| 状态 | 单进程，`JobStore`/产物在本地 | 多 worker 不共享状态；`/job` 可能 404 |
| 适配 | 现有 `private-worker` 直接可用 | Queue-based 要写 handler；Load balancing 要 max workers=1 |
| 适合 | 桌面端间歇使用、单用户 | 公开多用户 API、突发流量 |

**结论**：

- **桌面端优先 Pod**：现有 Host 的 `private-worker` 只认 endpoint + token，Pod 的 HTTPS/SSH 隧道地址直接填；成本也比 Serverless 低。
- **Serverless 暂不作为首选**：Load balancing 虽可直接跑 HTTP 服务，但多 worker 会把 `/generate`、`/job`、`/artifact` 分发到不同进程，导致状态不一致；除非 max workers=1，或把 JobStore/产物外置到 Redis/S3。Queue-based 则需要 handler 适配，工作量大。
- **注意**：当前 Host 的「断开」只断开本地连接，**不会停止 Pod**；需要在平台控制台/API 关机，或后续增加 RunPod provider 的 teardown。

---

## 9. 成本模型与最优方案衡量口径

### 9.1 固定成本与单次验收参考价

| 场景 | 成本 |
| :--- | :--- |
| RunPod A5000 24G，15–30 分钟 MVP 验收 | ≈ $0.07–0.14（约 ¥0.5–1.0） |
| RunPod 4090 24G，30 分钟验收 | ≈ $0.45（约 ¥3.2） |
| Vast 4090 中位价，30 分钟 | ≈ $0.24（约 ¥1.7） |
| RunPod Network Volume 50GB（可选，后期长期用） | ≈ $3.5/月 |
| 镜像存储（GHCR 公开） | 免费（公开镜像）；私有 registry 按平台计费 |
| 对比：AutoDL v-48g 68 分钟 | ¥35.5（已发生，0 产出） |

### 9.2 比较不同显卡与 `cpuOffload` 策略的算账口径

不能只比「每小时单价」，建议统一记录两项指标来决定最佳部署方案：

1. **稳态单张成本**（批量/连续出图）：`(小时单价 / 3600) * 稳态出图秒数`
   - 例：`flux2-klein-9b` 在开 `cpuOffload` 时单张约 130.87s；若在 32GB/48GB 卡上关闭 `cpuOffload` 后降至 15–20s，即使小时单价翻倍，单张综合成本反而可能显著下降。
2. **含冷启动短会话成本**（零星开机画 N 张）：`(小时单价 / 3600) * (加载秒数 + N * 稳态秒数)`

---

## 10. 渐进式验证计划与长期追踪方案

> 原则：先花最小成本跑通 2 模型端到端 MVP，不一次性拉全量 133GB 权重；平台与卡型保持开放，通过 Trace 数据收敛最优组合。

### 阶段 0：镜像与压测准备（不烧 GPU）— ✅ 已完成并 CI 实测（2026-11-22）

> **实施记录**：
>
> 1. **基础镜像**：[`worker/deploy/Dockerfile`](../worker/deploy/Dockerfile) 改为
>    `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime`（经 `ARG BASE_IMAGE` 传入，CI 可覆盖成
>    `@sha256:<digest>`），构建期断言 `sys.version_info[:2] == (3, 11)`、`torch 2.6.0`、
>    `torch.version.cuda == '12.4'` 以及 torchvision / diffusers / transformers / accelerate /
>    peft / huggingface_hub 六个包的确切版本——任一不符即构建失败，不再等到真机才暴露。
> 2. **依赖锁定**：[`worker/requirements-gpu.txt`](../worker/requirements-gpu.txt) 全部精确锁定
>    （`torch==2.6.0+cu124` / `torchvision==0.21.0+cu124` / `diffusers==0.43.0` /
>    `transformers==5.23.0` / `accelerate==1.15.0` / `peft==0.21.3` /
>    `huggingface_hub==1.33.0` / `safetensors==0.8.0` / `pillow==13.0.0`），并注明"改版本必须同步改
>    Dockerfile 断言 + 真机验收"。`sentencepiece / protobuf / einops` 保持不锁：它们是传递依赖，
>    锁死会把解析器卡在旧组合上。
> 3. **容器权限**：镜像不再创建 `worker` 用户、不再 `USER worker`，改为 root 运行，
>    `/workspace`（`root:root`）可直接写；入口脚本的 `/tmp/hf` 回退只作为显式 `--user` 覆盖时的
>    安全网，并会打印告警。同时入口脚本多打一行 `cpu_offload` / `hf_home`，压测时按容器日志即可
>    确认本次跑的是开还是关。
> 4. **`cpuOffload` 覆写**：新增 [`worker/inference/policy.py`](../worker/inference/policy.py)
>    （`auto` / `on` / `off` 纯函数），在 `daemon.ensure_pipeline` 计算缓存键**之前**应用，也在
>    `build_pipeline` 里幂等应用一次；`worker_server.py` 新增 `--cpu-offload`，环境变量
>    `AIGC_WORKER_CPU_OFFLOAD` 等价；`/health.cpu_offload` 上报
>    `{mode, source, effective}`。默认 `auto` 时返回原对象，缓存键与改造前逐字节一致。
> 5. **CI 构建**：新增 [`.github/workflows/worker-image.yml`](../.github/workflows/worker-image.yml)
>    ——清理 runner 预装工具链（dotnet / Android / GHC / CodeQL）释放磁盘 → 离线基线校验 →
>    buildx 构建（GHA 层缓存）→ **体积闸门**（压缩 ≤8GB / 未压缩 ≤10GB）→ **无卡冒烟**（在镜像内
>    断言协议版本、Python 3.11、torch 2.6.0+cu124、diffusers 0.43.0、transformers 5.23.0、
>    `cpu_offload=off` 生效、Token 不出现在 `/health`、无卡时 `gpu_unavailable`）→ 推送 GHCR。
>    Tag 规则：`main` → `edge` / `sha-<7位>`；`worker-v*` → `<版本>` / `latest`；PR 只构建不推送。
> 6. **离线校验**：新增 [`tools/check-worker-image.py`](../tools/check-worker-image.py)
>    （`npm run worker:check`）交叉校验 base tag、root 运行、requirements 锁定、Dockerfile 断言、
>    入口脚本 Token/`--no-install`、`.dockerignore` 与"海外节点不得设 hf-mirror"。
> 7. **CI 实测（2026-11-22，闭环依据）**：`worker-image` 在 GitHub 托管 runner 上构建通过
>    （[run 45028811155](https://github.com/nanxfu/aigc-studio/actions/runs/45028811155) /
>    [run 45030026313](https://github.com/nanxfu/aigc-studio/actions/runs/45030026313)）：
>    **压缩 3.16GB**（15 层，registry manifest）、**未压缩 6.07GB**（容器内 `du -skx /`），
>    均低于 8GB / 10GB 闸门；无卡冒烟通过（协议 `2.0.0`、Python 3.11、torch `2.6.0+cu124`、
>    diffusers `0.43.0`、transformers `5.23.0`、`cpu_offload=off` 生效、Token 不进 `/health`、
>    无卡时 `gpu_unavailable`）。
>    镜像：`ghcr.io/nanxfu/aigc-worker:edge` / `:sha-e316532`（当次构建 digest
>    `sha256:0963c3aadbf376652c3e1a13bf114e4e8b6781efd9259babfa7a64242b72005f`，按 digest
>    可复现拉取），已用匿名 token 验证可公开拉取（manifest HTTP 200）。
>    **口径修正**：首轮把 `docker image inspect .Size`（对拉取镜像等于压缩层之和，3.17GB）
>    当成"未压缩"，与压缩值几乎相同；已改为容器内 `du -skx /` 实测，两个口径分开报告。
> 8. **本机验证**：开发机没有 Docker，镜像体积与启动由 CI 承担；本机跑了离线校验与
>    Python 单测（`python test/worker/run.py` 566 项通过，含新增
>    `test/worker/test_policy.py` 17 项），并用替身 `python3` 模拟入口脚本，确认
>    `AIGC_WORKER_TOKEN` → `--token-file` 转发与 `--host/--port/--no-install` 拼接正确。

原计划项与状态：

- [x] 更新 [`worker/deploy/Dockerfile`](../worker/deploy/Dockerfile) 到 `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime`（Python 3.11），并锁定 [`worker/requirements-gpu.txt`](../worker/requirements-gpu.txt) 依赖版本，防止重装新版 PyTorch；
- [x] 解决云容器内非 root 用户 `USER worker` 对挂载卷 `/workspace`（`root:root`）的写入权限死锁；
- [x] 增加 `cpuOffload` 显式覆写能力（用于后续压测脚本做开/关 A/B 对比，不改变默认模型定义）；
- [x] 增加 GitHub Actions 构建 workflow（先清理 runner 预装大体积工具链释放磁盘，再构建推送至 GHCR）；
- [x] **本地验证 Python 3.11 / 依赖对齐 / 镜像体积 ≤8GB（未压缩 ≤10GB）/ `AIGC_WORKER_TOKEN` 启动**：
      开发机无 Docker，前三项由 CI 构建期断言与体积闸门承担；2026-11-22 CI 实测
      **压缩 3.16GB / 未压缩 6.07GB**（均达标），无卡冒烟在镜像内验证了 Python 3.11、
      torch `2.6.0+cu124`、diffusers `0.43.0`、transformers `5.23.0` 与 `AIGC_WORKER_TOKEN`
      启动链路；本机另用替身 `python3` 模拟入口脚本确认参数转发。

### 阶段 1：MVP 端到端验收（单卡 24GB，约 ¥1 / 15–20 分钟）

- 先开一台 **RunPod A5000 24G（或 Vast 4090）**，**暂不建 Network Volume**（直接用 40–50GB Pod Volume Disk，避免锁定单一数据中心），**不设 `HF_ENDPOINT=hf-mirror.com`**；
- 通过 AIGC Studio 的 `private-worker` 连接后，只验证 **2 个代表性模型**（约 22.8GB）：
  1. `sdxl-lightning`（6.78GB）：验证文生图、图生图、局部重绘、Real-ESRGAN 放大、binary 下载、`/job` 步数轮询、取消与断线重连；
  2. `flux2-klein-4b`（16.0GB）：验证 `torch 2.6 + diffusers 0.43` 新架构兼容、原生 `bf16`、单卡自动跳过 `device_map` 以及参考生图/扩图；
- 验收标准：2 模型 + 四大工具全链路走通；Token 不进日志；Pod 关机后确认计费归零。

### 阶段 2：全模型补齐与 `cpuOffload` 跨卡 A/B 压测

- 在阶段 1 闭环后，补测 `sana-sprint`、`anima-turbo-v1.1`、`z-image-turbo`、`qwen-image-2.1`、`flux2-klein-9b`；
- **重点对比**：在 24GB（4090/A5000，开 `cpuOffload`）与 32GB/48GB（5090/A6000，开 vs 关 `cpuOffload`）上，分别测 `flux2-klein-9b` 和 `qwen-image-2.1` 的 `load_seconds`、`infer_seconds`、`max_allocated_mb` 与单张成本，确定是否拆成「24GB 日常档 + 32/48GB 大模型档」。

### 阶段 3：长期性能与费用追踪（演进路线，不提前过度设计）

1. **压测账本（Phase 1）**：使用轻量压测脚本调用 `/generate` + `/health`，将 `{date, provider, gpu_name, vram_total_mb, hourly_rate, model_id, cpu_offload, load_seconds, infer_seconds, max_allocated_mb, est_cost}` 追加到本地 JSONL / Markdown 对比表。
2. **Host 被动采集（Phase 2）**：复用 [`AUTODL_WORKER_RESEARCH.md`](AUTODL_WORKER_RESEARCH.md) §6 的 Trace 账本方案，在日常出图结束时顺手将 `seconds`、`/health.hardware` 与 `/health.gpu_memory.max_allocated_mb` 写入 `%APPDATA%\aigc-studio\traces\runs.jsonl`。
3. **自适应策略（Phase 3）**：待积累出明确的显存安全阈值后，再为 Worker 引入 `cpuOffload: "auto"`，按启动时探测到的 `vram_total_mb` 自动选择全卡进显存或 CPU offload。

---

## 11. 风险与未决问题

| 风险/问题 | 影响 | 建议 |
| :--- | :--- | :--- |
| 现行 `Dockerfile` 是 Ubuntu 22.04（Python 3.10）且未锁 `requirements-gpu.txt` | 直接构建会装不上 `diffusers 0.43` 或重下新版 torch | ✅ 阶段 0 已切到 `pytorch:2.6.0-cuda12.4-cudnn9-runtime` 并锁版本，构建期断言兜底 |
| `USER worker`（无 `sudo`）与 RunPod `/workspace`（`root:root`）权限死锁 | 静默回退 `/tmp/hf`，持久化失效且撑爆 20GB 容器盘 | ✅ 阶段 0 改为 root 运行，入口脚本回退路径只作 `--user` 覆盖时的安全网 |
| GitHub 托管 runner 仅约 14GB 可用空间 | 构建 8–10GB 镜像容易报 `no space left on device` | 构建 workflow 先清理 dotnet/Android/GHC 等预装包 |
| 海外节点误配 `HF_ENDPOINT=hf-mirror.com` | RunPod/Vast 跨太平洋回源拉权重变慢或被限流 | 海外平台部署示例一律移除 `HF_ENDPOINT` |
| `models/*.json` 写死 `cpuOffload: true` | 32G/48G 卡无法直接测关闭 offload 的真实速度 | ✅ 阶段 0 已加 `AIGC_WORKER_CPU_OFFLOAD` / `--cpu-offload`（auto/on/off），不改默认值 |
| torch 2.6 + diffusers 0.43 组合未在真机复验 | 可能 import/运行失败 | 阶段 1 重点验证 `flux2-klein-4b`；保留 LKGR 的 torch 2.11 作为参考回退 |
| 9B/Qwen 在 24GB 余量仅 6–7GB，且 `cpuOffload` 吃系统内存 | 高分辨率/并发易 OOM；16GB RAM 主机可能被杀进程 | Vast 选机硬过滤 `RAM ≥ 32GB`；按阶段 2 实测决定是否改推 32/48G |
| Vast host 驱动 <550 | CUDA 12.4 无法启用 | 创建时筛选驱动 ≥550 |
| 模型许可证 | 公开镜像不能带非商用权重 | 镜像只放代码；模型由运行时按需下载 |
| Pod 断开不自动关机 | 持续计费 | 手动停止；后续视需要再补控制台/API teardown |

---

## 12. 已确认决策记录（2026-11-22）

1. **基线环境**：仅维护 **Python 3.11 + torch 2.6.0 + CUDA 12.4** 单基线（驱动 ≥550），不维护 cu121 回退镜像。
2. **容器权限**：云端镜像**直接以 root 运行**，兼容 RunPod `/workspace` 挂载卷（`root:root`）与 Vast SSH 模式，消除权限死锁。
3. **基础镜像与仓库**：采用 `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime`（固定 digest）作为唯一基础层，发布到 **GHCR 公开镜像**（仅含代码与 Python 依赖，不含任何模型权重）。
4. **阶段 1 MVP 范围**：首次 24GB 本地卷只测 `sdxl-lightning` + `flux2-klein-4b`（约 22.8GB），先跑通全部工具与传输链路，再扩展至全量 7 模型与 32GB/48GB 对比。
5. **`cpuOffload` 压测开关**：在**阶段 0** 顺手补齐请求/环境变量覆写 `cpuOffload` 的支持（不改默认模型配置），便于阶段 2 在同机对比 `flux2-klein-9b` 等开/关 offload 的真实耗时与单张成本。
6. **平台开放与优先级**：继续保持 `private-worker` 平台中立 + **Pod 优先**，不做 Serverless，等阶段 2 实测数据出来后再定型主力平台与卡型。

> **落地状态（2026-11-22）**：决策 1–5 已在阶段 0 落地（基线镜像 + 依赖锁定 + root 运行 +
> `cpuOffload` 运行时开关 + CI 构建/体积闸门/无卡冒烟）；决策 6 保持开放，等阶段 1/2 的真机数据。

---

## 13. 参考依据

- 模型实测数据：`models/*.json` 的 `measured` 字段。
- 已验证依赖组合：`docs/TROUBLESHOOTING.md` §8（LKGR）。
- 模型加载器与 `device_map` / `cpuOffload` 实现：`worker/inference/loaders/diffusers.py`、`worker/daemon.py`（`ensure_pipeline` / `reset_peak_memory_stats`）。
- 显存与硬件快照实现：`worker/observability/health.py`、`worker/inference/upscale.py`。
- 现行容器构建与入口：`worker/deploy/Dockerfile`、`worker/deploy/docker-entrypoint.sh`、`worker/requirements-gpu.txt`。
- PyTorch 官方镜像：Docker Hub `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime`（Python 3.11，压缩约 3.31GB）。
- RunPod / Vast 价格与对比：`docs/GPU_PROVIDER_COMPARISON.md`。
- Trace 账本前期设计：`docs/AUTODL_WORKER_RESEARCH.md` §6。

> 阶段 0 已按本文落地并由 CI 实测（镜像压缩 3.16GB / 未压缩 6.07GB，公开镜像
> `ghcr.io/nanxfu/aigc-worker:edge`）；阶段 1 起的真机验收尚未执行，全程未启动任何 GPU 实例。
