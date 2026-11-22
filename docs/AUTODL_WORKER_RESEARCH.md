# 云 GPU 租用平台（AutoDL / Vast / RunPod）与 Trace 基准探索方案

> **状态**：调研与方案探索（M3.1-b Host 接入已落地，本方案用于指导 M3.1-c 真机实验及后续多平台扩展）  
> **上位文档**：[`M3_PRIVATE_WORKER_AND_MCP_PLAN.md`](M3_PRIVATE_WORKER_AND_MCP_PLAN.md) §5、[`worker/deploy/README.md`](../worker/deploy/README.md)  
> **目标**：针对按小时计费容器（**AutoDL / Vast.ai / RunPod Pods**）与按秒计费队列（**RunPod Serverless**），规划多平台三层解耦架构、部署与省钱策略、OpenAPI 防烧钱边界，以及跨平台推理耗时/费用 Trace 数据采集方案。

---

## 1. 核心原则与架构边界（先对齐，避免走偏）

1. **通用原语进 `worker/`，平台特性留给脚本**：
   - 继续复用 `private-worker` 通用连接器，**不**在 `server/providers/` 新增写死 AutoDL 平台 API 的第 5 个 Provider（除非后续实测证明通用模式存在无法绕开的硬阻塞）。
   - 核心 `worker_server.py` 只提供跨平台通用的机制（如 `--work-dir` 联动缓存盘、允许无卡准备期、可选本地空闲停机命令），不耦合具体云厂商字段。
2. **安全红线不退让**：
   - 不开放任何通过远程 HTTP 接口执行任意 shell 的口子；空闲自动关机命令只允许由服务端启动参数/容器内启动脚本定义；
   - Token 仍走 `Authorization: Bearer <token>` 请求头，不进 URL、日志与 `/health`。
3. **停止进程 ≠ 停止计费**：
   - Kaggle/Colab 退出进程即结束免费配额占用；AutoDL 等按小时计费平台**只有容器/实例关机才停计 GPU 费用**。所有设计必须区分「断开本地连接」「退出 Worker 进程」和「实例真正关机」。

---

## 2. 对照 `M3.1-a` 现状发现的 4 个实机差距

对照已落地的 `M3.1-a`（`01becb2`）代码，以下 4 点在无 N 卡环境靠 mock 无法验证，需要在 AutoDL 实机探索与补齐：

| 差距点 | 现状（代码事实） | 租用容器真机风险 |
| :--- | :--- | :--- |
| **部署形态** | [`worker/deploy/README.md`](../worker/deploy/README.md) 主推 Docker Compose 与 `systemd` | AutoDL 本身是已运行容器：无法 Docker-in-Docker，也没有 `systemd`（PID 1 非 systemd） |
| **磁盘与缓存** | [`worker/config.py`](../worker/config.py#L228-L236) 的 `--work-dir` 只切 `os.chdir()`，未接管 `HF_HOME` 与临时产物目录 | AutoDL 系统盘通常约 30 GB，数据盘在 `/root/autodl-tmp`；未重设环境变量会把系统盘直接写爆 |
| **依赖清单** | [`worker/requirements-gpu.txt`](../worker/requirements-gpu.txt) 仅列基础 9 个包且默认装 Cu124 `torch` | 容器已预装 `torch` 无需重下 3 GB；但干净镜像可能缺 `sentencepiece` / `protobuf` 等 Tokenizer 硬依赖 |
| **受限模型与镜像** | [`worker/worker_server.py`](../worker/worker_server.py#L127-L144) 未接收 `hf_token`；默认未配 `HF_ENDPOINT` | 长驻模式下 Host 不下发 `daemonConfig`，不配 `HF_TOKEN` / `hf-mirror` 会导致国内拉取受限模型失败 |

---

## 3. 待探索的 4 个技术专题

### 专题 A：部署环境与存储隔离（轻量容器脚本）

- **目标**：一套脚本同时适配 AutoDL、恒源云、RunPod 等预装 PyTorch 的租用容器。
- **待探索与改造项**：
  1. **`--work-dir` 联动默认缓存与产物目录**：在 `worker/worker_server.py` 启动早期（早于任何 `huggingface_hub` / `transformers` 导入），若指定了 `--work-dir` 且未显式设置 `HF_HOME` / `AIGC_WORKER_ARTIFACT_DIR`，自动默认落到 `<work_dir>/hf` 与 `<work_dir>/artifacts`，彻底避免撑爆小系统盘。
  2. **通用容器启动脚本 `worker/deploy/start-container.sh`**：
     - 自动识别常见数据盘挂载点（优先 `/root/autodl-tmp` → `/workspace` → 当前目录）；
     - 探测当前环境是否已有可用 `torch`（`python3 -c "import torch; assert torch.cuda.is_available()"`）：有则跳过重装 `torch`，仅增量安装缺失的 `diffusers` / `transformers` / `accelerate` / `peft` / `sentencepiece` / `protobuf` 等；
     - 统一处理 Token 生成/读取、日志重定向、端口参数（支持 AutoDL 常用的 `6006` 或 `8765`）与后台守护（`tmux` / `nohup`）。

### 专题 B：启动与节省余额策略（两段式 + 容器自停）

- **核心思路**：把「最耗时的配环境 + 下十几 GB 模型」移到极低价的无卡/低配阶段完成，把高价 GPU 时间留给纯出图。
- **待探索项**：
  1. **「无卡模式准备」入口（`--prepare-only` 或独立准备脚本）**：
     - 现状 [`worker/runtime.py`](../worker/runtime.py#L61-L67) 检测到无 CUDA 会直接报 `gpu_unavailable`；
     - 探索提供 `--prepare-only`（只检/装 Python 依赖 + 按 `--preload <preset>` 预拉权重到数据盘，不检 CUDA、不启 HTTP 服务），让用户在 AutoDL **无卡模式（几分钱/小时）** 把环境与 7 个模型权重下好，再关机切有卡开机秒级就绪。
  2. **容器侧空闲关机钩子（`--idle-shutdown-cmd`）vs 客户端文案提示**：
     - 探索在 `worker_server.py` 增加仅由本地 CLI 参数传入的 `--idle-shutdown-cmd`（例如在独占 AutoDL 容器里配合 `--idle-timeout 1800 --idle-shutdown-cmd "shutdown -h now"`），由 `worker_server.py` 在空闲超时、完成清理后执行；
     - **实机必验项**：确认 AutoDL 容器内执行 `shutdown -h now`（或 `/usr/bin/shutdown` / 平台关机命令）是否真能让实例进入「已关机、停止计费」状态，还是只杀容器主进程（若无效则及时止损改回文档提醒）。
  3. **按需加载 vs 预加载（`--preload`）的开机时间账**：
     - 实测 3090 / 4090 上懒加载（启动 2 秒 ready，首图加载 10~20 秒）与预加载的体验差异。

### 专题 C：网络环境实测对比（出站加速 + 入站连接）

- **出站（服务器下载依赖与权重）**：
  - 对比 `HF_ENDPOINT=https://hf-mirror.com`、AutoDL 自带学术加速（`source /etc/network_turbo`）与直连 HuggingFace 的下载速度及断线重试表现；验证 `HF_TOKEN` 在 `hf-mirror` 上的受限模型拉取兼容性。
- **入站（本地桌面端连远程 Worker）**：
  对比 AutoDL 提供的两种现成通道，用真实 **M3.1-b Host** 和 **M3.2 binary/SSE** 实测判定主推方案：

  | 方案 | 接入方式 | 重点实测指标 |
  | :--- | :--- | :--- |
  | **方案 1：SSH 隧道**（基准推荐） | `ssh -CNg -L 8765:127.0.0.1:8765 root@... -p <port>`，桌面端连 `http://127.0.0.1:8765` | 断线重连体验、`/events` SSE 延迟、`/artifact` 大图下载速度、与 `worker-url.js` 回环策略天然兼容 |
  | **方案 2：AutoDL 自定义服务 6006 代理** | 容器监听 `6006`，桌面端直连平台给的 `https://*.seetacloud.com:8443` | 网关是否对 `/events` SSE 做响应缓冲、长耗时请求是否 60s/120s 超时、是否要求浏览器 Cookie 鉴权 |

- **局域网直连策略复核**：
  - 实测结束后顺带评估 [server/providers/worker-url.js](../server/providers/worker-url.js#L49-L54) 是否维持「非回环强制 HTTPS（局域网/无域名机器统一建议走 SSH 隧道）」，还是增加明确确认的内网私有网段（RFC1918 / Tailscale `100.64.0.0/10`）策略。

### 专题 D：7 模型与全工具真机基线

- 在真实 AutoDL GPU 容器（推荐 RTX 4090 24GB 或 RTX 3090 24GB，按量计费实测 1~2 小时）上完整验证：
  1. `worker/requirements-gpu.txt` 在干净 CUDA 镜像/容器上装完是否缺包（重点核对 `sentencepiece`、`protobuf`、`einops` 等）；
  2. 文生图、局部重绘（`--inpaint`）、高清放大（`--upscale`）、多图参考（`--reference`）四类工具全部走通；
  3. 重点补测此前 Kaggle T4 跑不了或受限的大模型：`flux2-klein-9b`、`qwen-image-2.1`、`anima-turbo-v1.1`、`z-image-turbo`、`sana-sprint-1.6b`，记录真实冷启动耗时、单张耗时与 `/health.hardware` / 显存峰值。

---

## 4. 多平台对比与三层解耦演进（AutoDL / Vast / RunPod Serverless）

### 4.1 两类算力模型的本质差异

后续拟接入的平台分为**两种完全不同的运行与计费语义**，不能强行塞进同一种连接方式：

| 类别 | 代表平台 | 生命周期与计费 | 怎么连、怎么省钱 | Provider 演进方式 |
| :--- | :--- | :--- | :--- | :--- |
| **交互式租用容器** | **AutoDL**、**Vast.ai**、**RunPod GPU Pods** | 有固定容器、SSH / 端口、按小时全价计费；**停进程不等于停计费，关机（`power_off`）才停计 GPU 费** | 100% 复用 `worker_server.py`；省钱靠**数据盘/私有镜像固化权重**、**无卡模式预下载**与**空闲关机 API** | 近期统一走 `private-worker` 手动开机；需要一键自动启停时再按平台建托管 Provider（底层复用 `private-worker` 连接逻辑） |
| **按秒计费队列** | **RunPod Serverless**（及同类 Serverless） | 无固定端口/SSH 给你长连；平台自动扩缩容到 0，**空闲不花钱，按实际推理秒数计费** | 无法复用 `worker_server.py` 长连接与 SSE；需封装 Serverless handler 镜像 + Network Volume 挂权重；适合碎片化低频出图 | 未来独立建 `runpod-serverless` Provider（任务型：提交 `/run` → 轮询 `/status` → 拉取产物，无持续会话） |

### 4.2 三层解耦架构

1. **推理核心层（`worker/inference/`、`worker/jobs/`）**：100% 全平台共用同一套模型加载与出图工具。
2. **环境部署层（`worker/deploy/`）**：按平台形态维护轻模板/脚本（自有 Docker/systemd、租用容器 `start-container.sh`、未来的 `serverless_handler.py`）。
3. **控制面 Provider（`server/providers/`）**：先把 `private-worker` 在 AutoDL 实机跑穿，验证完部署和省钱瓶颈后再按需扩展各平台控制面；绝不在 1 个真机都没跑通前同时开发 3 套平台 API。

---

## 5. 专题 E：云平台 OpenAPI 自动化启停与防烧钱边界

以 **AutoDL 开放平台**（`https://api.autodl.com`，开发者 Token 放 `Authorization` 请求头）为例：个人实名可用**容器实例 Pro API**（`POST /api/v1/dev/instance/pro/create`、`list`、`power_off`、`release`），企业可用弹性部署 API（`POST /api/v1/dev/deployment`）。

**关键安全与成本红线：绝不能把开发者 Token 直接交给大模型让 Agent 自由调用租卡。**

1. **Token 隔离**：开发者 Token 与 LLM Key 一样加密存在 Host `safeStorage`，不进模型上下文，Agent 无权自由拼 HTTP 请求。
2. **消费白名单预设**：用户必须在设置页预先钉死允许的 `gpu_spec_uuid`（如单卡 4090）、已含环境与权重的**私有镜像 `image_uuid`**（避免每次从零开机重下 20 GB 模型）以及最长空闲关机时间。
3. **AGUI 二次确认后才花钱**：Agent 最多通过提案卡建议「开启已预置的 AutoDL 实例并生成」，用户点击确认后才由确定性的 Host 代码调 API 开机，空闲超时后强制调 `power_off`（只关机保留数据盘，不 `release`）。

---

## 6. 专题 F：跨平台推理性能与费用 Trace 账本（自用作为真实数据源）

为长期积累不同平台（Kaggle / Colab / AutoDL / Vast / RunPod）、不同卡型、不同传输方式与 7 套模型的真实耗时与成本数据，设计极轻量的本地 Trace 账本（可在 M3.1-c 之后或 M3.2 顺手接入）：

1. **存储路径与格式**：
   - 全局追加写 `%APPDATA%\aigc-studio\traces\runs.jsonl`（脱离单个工作区，跨项目自然聚合日常使用数据；单文件超过上限按月/按大小滚动）。
   - **严格脱敏**：**不记录** `prompt` / `negativePrompt` 正文（只记 `promptLen`）、不记录 Token、不记录完整外网 URL 与本地绝对路径。
2. **核心字段设计**（尽量复用现有 `meta.json` 与 `/health` 字段）：
   - **环境维度**：`provider`、`platformTag`（用户可选备注标签，如 `autodl-4090` / `vast-3090`）、`device`、`vramTotalMb`、`transport`（`ssh-tunnel | https-proxy | ntfy-cloudflared | direct`）、`resultMode`（`inline | binary`）
   - **任务维度**：`tool`、`presetId`、`modelId`、`width`、`height`、`steps`、`count`、`coldStart`（是否本会话首次加载该模型）
   - **分段耗时（ms）**：`provisionMs`、`queueWaitMs`、`modelLoadMs`、`inferMs`、`downloadMs`、`totalMs`、`peakVramMb`
   - **结果与参考费用**：`status`（`done | failed | canceled`）、`errorCode`、`hourlyRate`（可选配置的平台参考单价）与按耗时折算的 `estCost`（明确标记为估算值）。
3. **消费出口**：
   - 新增离线汇总脚本（如 `tools/summarize-traces.mjs`），按 `platformTag × device × presetId` 统计 P50/P95 耗时、冷启动开销、失败率与单张均价，输出 Markdown 表格直接回填各模型的 `models/*.json`（`measured` 字段）与对比选型文档。

---

## 7. 建议推进节奏与实验记录模板

1. **先决条件（已满足）**：**M3.1-b**（Host 侧 `private-worker` + 凭据存储 + 设置抽屉 UI + 连接/断开）已落地，可直接开 AutoDL 实机用桌面端完整联调，而不是只用 `curl` 测接口。
2. **M3.1-b/c 衔接已补齐的小项**：`--work-dir` 会联动 `HF_HOME` / `HF_HUB_CACHE` / `AIGC_WORKER_ARTIFACT_DIR`（显式环境变量优先）；`worker/requirements-gpu.txt` 补了 `sentencepiece` / `protobuf` / `einops`；`worker/worker_server.py` 支持 `--hf-token` 与 `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` 环境变量透传（值不落日志）。
3. **真机实测结果记录表**（跑完后直接回填到本节与 [`worker/deploy/README.md`](../worker/deploy/README.md)）：

```text
实验日期：YYYY-MM-DD
平台与实例：AutoDL（实例区域 / GPU 型号 / 系统镜像 / CUDA 版本 / 系统盘与数据盘）
出站下载：HF_ENDPOINT=... / 学术加速，7 模型下载耗时与失败重试情况
无卡预备：是否验证无卡模式拉依赖与权重，切有卡后 ready 耗时
入站对比：
  - SSH 隧道（http://127.0.0.1:8765）：/health、/generate、/artifact、/events 实测结果
  - 自定义服务（6006 HTTPS）：是否通畅、SSE 是否缓冲、超时阈值
空闲停机：容器内 shutdown 命令是否停止平台计费（是 / 否 / 替代方案）
模型实测：sdxl-lightning / flux2-klein-4b / flux2-klein-9b / qwen-image-2.1 / anima-turbo-v1.1 / z-image-turbo / sana-sprint-1.6b 耗时与显存
结论与回流改动：哪些经验固化进脚本 / 文档，哪些确认不采纳
```

### 7.1 本轮实测记录（2026-11-22）

```text
实验日期：2026-11-22
平台与实例：AutoDL Pro API，规格 4090-48G（gpu_spec_uuid=v-48g），单价 ¥30.30/小时
            公共镜像 base-image-l2t43iu6uk（Python 3.8 / torch 2.0.0 / CUDA 11.8），系统盘扩容 50GB
实例：      创建成功 pro-7953c5c4412e；18:33 开机，19:41 关机止损（约 68 分钟）
余额：      86.20 → 50.70（消耗 ¥35.50，与 ¥30.30/小时 × 1.17 小时吻合）
进度：      0 产出。基础镜像 Python 3.8 与 Worker（要求 ≥3.10）不兼容；
            新建 Python 3.11 + torch 2.4 环境，nvidia 依赖约 2.5GB，源速 1.7–2.5MB/s，
            68 分钟内未装完；未进入模型下载与出图。
处置：      已 power_off，GPU 计费停止（余额不再变化）；磁盘保留，未 release。
结论：      v-48g 单价是 4090 24G 的约 16 倍，不适合做环境搭建；
            必须改用「4090 24G + 私有镜像」方案，见 §8。
```

**本轮实测结论（2026-11-22）**：认证完成后已成功创建 `v-48g`（4090-48G）实例，但该规格实际单价 **¥30.30/小时**（不是早期估计的 ¥3/小时），68 分钟消耗 ¥35.50；同时基础镜像 Python 3.8 + torch 2.0 与 Worker 代码不兼容，现场安装 Python 3.11 + torch 2.4 在低速源上耗时过长，最终 **0 产出**。实例已关机止损，磁盘保留。后续不要再用 `v-48g` 做环境搭建，改用 §8 的「私有镜像 + 4090 24G」方案。

**下一次执行清单（按 §8 方案）**：

1. 用 4090 24G（`gpu_spec_uuid` 以控制台为准，约 ¥1.88/小时）创建实例，镜像先用 `base-image-l2t43iu6uk` 或更新的公共镜像；
2. 装好 Python 3.11 + torch 2.4 + diffusers，上传 `worker/`，把 `HF_HOME` 指到系统盘（如 `/root/hf`）；
3. 用 `--prepare-only --preload-json` 预拉 sdxl-lightning（6.78GB）；
4. 关机后 `POST /api/v1/dev/instance/pro/image/save` 保存私有镜像，轮询 `image/private/list` 到 `finished`；
5. 释放实例（镜像保留，存储约 ¥0.01/GB/日）；
6. 以后创建实例只传该 `image_uuid` + 4090，开机 1~2 分钟即可接单；详见 §8。


---

## 8. 镜像复用方案调研（2026-11-22，未启动任何实例）

### 8.1 结论

**可行，而且这是 AutoDL 上唯一正确的复用方式。** AutoDL 官方文档明确「当前 AutoDL 不支持导入自定义镜像」，所以不能用 Docker Hub / 自建镜像；但支持把实例**系统盘保存为私有镜像**，以后创建实例时用同一个 `image_uuid` 恢复整个系统盘。等价于「一次构建，长期复用」：

- 镜像里放：Python 3.11 + torch 2.4 + diffusers/transformers/accelerate/peft + Worker 代码 + sdxl-lightning 权重；
- 以后每次创建实例：`image_uuid=<私有镜像>` + `gpu_spec_uuid=4090`，开机 1~2 分钟即可接单；
- 模型已在镜像内时连下载都省了；未预置的模型（flux2/qwen）再用 `HF_ENDPOINT=https://hf-mirror.com` 按需拉取。

### 8.2 价格事实（避免再次选错规格）

| 规格 | 显存 | 按量单价 | 适用 |
| :--- | :--- | :--- | :--- |
| **4090-48G（`v-48g`）** | 48GB | **¥30.30/小时** | 本次误选；比 4090 贵约 16 倍，不适合做环境搭建 |
| **RTX 4090** | 24GB | **¥1.88/小时** | sdxl / 放大 / 重绘；flux2-klein-4b 峰值 7.9GB 也够 |
| **RTX 5090** | 32GB | **¥2.78/小时** | flux2-klein-9b / qwen 更稳 |
| **PRO 6000** | 96GB | **¥8.36/小时** | 仅 9B+ 大模型或需要更大显存时 |
| **无卡模式** | - | **约 ¥0.10/小时** | 只装环境/下权重；**仅网页控制台可开，Pro API 不支持** |

> 4090D 与 4090 同档（约 ¥1.88–1.98/小时，以控制台现价为准）。本次 `v-48g` 是特殊 vGPU 规格，价格与 24G 卡完全不是一个量级。

### 8.3 镜像与磁盘计费

- **镜像存储**：¥0.01/GB/日，**30GB 以下免费**；按所有镜像总容量计费。
- 账号现有 2 个私有镜像：`image-f5a92f7f01`（9.97GB）、`image-058bf6cfd2`（9.77GB），合计约 19.7GB，剩余免费额度约 10GB。
- 新镜像预估 15GB（环境约 8GB + sdxl 6.8GB）→ 总约 35GB → 超出 5GB ≈ **¥0.05/日**。
- **系统盘**：Pro 只有系统盘，30GB 基础 ¥0.1/日，扩容另计；实例释放后停止，镜像保留。
- 结论：镜像存储成本可以忽略，真正的成本是 GPU 开机时长。

### 8.4 推荐镜像内容

```text
/root/miniconda3/envs/aigc/      Python 3.11 + torch 2.4 + diffusers 全家桶
/root/aigc-worker/               worker/ 源码 + deploy/start-container.sh
/root/hf/                        HF_HOME（系统盘，必须，不能放 /root/autodl-tmp 以外的不确定路径）
/root/aigc-worker/start.sh       固定启动脚本（PYTHON_BIN/HF_HOME/HF_ENDPOINT + --no-install）
```

要点：

1. **HF_HOME 必须放系统盘**（如 `/root/hf`），否则保存镜像时权重不会进镜像；`/root/autodl-tmp` 虽然跨重置保留，但不要依赖它做镜像内容。
2. 首版只预置 **sdxl-lightning**（6.78GB），镜像小、构建快；flux2-klein-4b（16GB）等需要参考生图时再加第二个镜像或按需下载。
3. Worker 代码与 `start-container.sh` 一起进镜像，开机不需要再上传文件。
4. Token **不要**固化进镜像（镜像可能共享/复用）；由启动脚本在 `/root/autodl-tmp/worker-token` 生成，SSH 读取。

### 8.5 构建步骤（待确认后执行，本轮未启动）

1. 用 **4090 24G** 创建实例（不要用 `v-48g`），镜像用 `base-image-l2t43iu6uk` 或控制台里更新的 PyTorch 2.4+/Python 3.10+ 镜像；
2. 上传 `worker/` 到 `/root/aigc-worker`，创建 Python 3.11 conda 环境，装 torch 2.4 + diffusers 全家桶；
3. `export HF_HOME=/root/hf`，用 `worker_server.py --prepare-only --preload-json @sdxl-pipeline.json` 预拉 sdxl；
4. 写 `/root/aigc-worker/start.sh`（固定 `PYTHON_BIN`、`HF_HOME`、`HF_ENDPOINT`，调 `start-container.sh --no-install --port 8765`）；
5. 关机（`power_off`），确认 `shutdown`；
6. `POST /api/v1/dev/instance/pro/image/save` `{instance_uuid, image_name:"aigc-worker-sdxl-v1"}`；
7. 轮询 `POST /api/v1/dev/instance/pro/image/private/list` 到 `status=finished`，记录 `image_uuid`；
8. 释放实例（`release`），停止系统盘日费；镜像保留。

预计：4090 上 30–40 分钟 ≈ **¥1.2**；镜像存储 ≈ **¥0.05/日**。

### 8.6 未来创建参数

```json
{
  "req_gpu_amount": 1,
  "expand_system_disk_by_gb": 0,
  "gpu_spec_uuid": "4090D",
  "image_uuid": "image-xxxxxxxxxx",
  "cuda_v_from": 118,
  "instance_name": "aigc-worker",
  "start_command": "bash /root/aigc-worker/start.sh"
}
```

- `expand_system_disk_by_gb: 0` 表示用 30GB 基础盘；镜像 15GB 足够。若镜像 >30GB 再扩。
- `start_command` 开机即拉起 Worker；Token 从 `/root/autodl-tmp/worker-token` 读。
- 4090 24G 跑 sdxl/放大/重绘足够；flux2-klein-4b 峰值 7.9GB 也够；9B/qwen 再换 5090/PRO6000。

### 8.7 成本对比

| 方案 | 一次性成本 | 每次验收成本 | 结果 |
| :--- | :--- | :--- | :--- |
| 旧：v-48g + 现场装环境 | 0 | ¥35.5（68 分钟，0 产出） | 已止损 |
| 新：私有镜像 + 4090 | 约 ¥1.2（构建） | 15–20 分钟 ≈ ¥0.5–0.7 | 开机即用 |

### 8.8 待确认项

1. **现有两个私有镜像的内容**：`image-f5a92f7f01` / `image-058bf6cfd2` 创建于 2024-05/06，若其中已有 Python 3.10+ 与 torch 2.x，可能直接可用；花 ¥0.2 用 4090 开 5 分钟检查 `python -V` / `pip show torch` 即可确认。
2. **是否有更新的公共镜像 UUID**：控制台「租用新实例 → 基础镜像」里若有 PyTorch 2.4+/Python 3.10+，把 `image_uuid` 记下来可跳过 torch 安装（当前 API 文档附录只列了 torch 2.0 的老镜像）。
3. **私有镜像跨地区/跨 GPU 规格**：预期可以（镜像与 GPU 规格独立），需一次实测确认。
4. **30GB 系统盘是否够**：仅 sdxl 镜像约 15GB，够；若把 flux2（16GB）也烤进去，需要扩容到 50GB。

> 本轮只做了只读调研（文档、前端资源、私有镜像列表、价格页），**没有创建、开机或释放任何实例**。

---

## 9. 决策：暂不接入 AutoDL（2026-11-22）

**用户决定：AutoDL 暂时不接入，M3.1-c 真机验收冻结。** 原因：

- `v-48g` 单价误判（实际 ¥30.30/小时），一次试错消耗 ¥35.5、0 产出；
- 基础镜像 Python 3.8 与 Worker（≥3.10）不兼容，现场装环境在低速源上不可控；
- 私有镜像方案虽然可行（§8），但需要一次构建与长期维护，当前优先级不足。

当前资源：实例 `pro-7953c5c4412e` 已 `shutdown`，GPU 计费停止；系统盘仍保留（少量日费）。**建议 release**，待用户确认后执行。

### 9.1 社区镜像（AutoDL Art）评估

AutoDL Art（`codewithgpu.com` / `autodl.art`）允许把 AutoDL 上保存的 Docker image 发布到社区，供其他用户一键运行；镜像是「能运行 GitHub 上某一项目代码的环境」，发布入口是站点头部 `+`。它是**分发渠道**，不是环境复用机制——环境复用仍然靠私有镜像。

对 AIGC Studio 的适配障碍：

1. **交互形态不匹配**：社区镜像面向 WebUI / API 应用（通常 6006 端口）。我们的 Worker 是 Bearer 鉴权的纯 API，普通社区用户没有桌面客户端，打开实例后看不到任何界面；要发布就得额外做一层 WebUI，或把桌面 Web 构建托管到 Worker。
2. **模型许可证**：FLUX.2 Klein 9B（FLUX 非商用）、Qwen-Image 2.1（Qwen Research License）、Anima Turbo（非商用）不适合随公共镜像分发；可公开分发的只有 SDXL Lightning（OpenRAIL++）、SANA-Sprint（Apache-2.0）、Z-Image Turbo（Apache-2.0）。混合镜像会把非商用权重一起打包，风险高。
3. **体积与维护**：15–40GB 镜像，发布/审核/版本更新成本高；社区镜像与 AutoDL 容器实例绑定，和 Pro API 的私有 Worker 路径不同。
4. **安全**：快照会包含 `/root` 下的 Worker Token、HF Token、SSH key、shell 历史与缓存，必须彻底清理；一旦发布很难撤回。

**结论：暂不发布社区镜像。** 如果未来要做「一键体验」，优先做 Docker Compose + 通用 GPU 服务器指南（RunPod / Vast / 自建），比绑定 AutoDL 社区更可移植；AutoDL 社区镜像可以作为后续可选渠道，但不是现在。

> 本轮只做只读调研与文档记录，未创建、开机或释放任何实例。
