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
