# 重型模型预量化瘦身与低成本云算力演进方案（2026-11-25）

> **背景**：M3.6 已完成 SaladCloud 接入与多卡真机压测（见 [`ROADMAP.md`](ROADMAP.md) M3.6），实测证明 `5–16 GB` 模型（`anima-turbo-v1.1` / `sdxl-lightning` / `flux2-klein-4b`）可在 Salad 按秒低价跑通，但 `30GB+` 原版 BF16 模型（`z-image-turbo` `30.64GB`、`qwen-image-2.1` `30.26GB`、`flux2-klein-9b` `34.7GB`）在消费级节点 `10–20 MB/s` 下行下冷启下载超过 `20min`。  
> **核心目标**：按第一性原理将“等待与成本”降到最低，分两步解决重模型可用性：
> 1. **阶段 1（当前优先）**：引入**双组件预量化权重（Transformer + Text Encoder）**，让单模型支持「满血版 / 量化轻量版」分流，先把下载体积和显存压回 `8–16 GB` 甜点区（Salad 与本机 12–16GB 卡均受益）；
> 2. **阶段 2（按需补齐）**：引入 **RunPod Community Cloud / Vast.ai** 作为高带宽机房无持久卷 Provider，供要求原版 BF16 无损画质的场景按秒使用。

---

## 1. 阶段 1：重型模型预量化方案（让同一模型兼顾满血与轻量）

### 1.1 为什么必须用「预量化文件 + 双组件联合压缩」

结合 [`INFERENCE_ACCELERATION_RESEARCH.md`](INFERENCE_ACCELERATION_RESEARCH.md) §4.4.3 结论与 M3.6 实测，做模型量化瘦身有两条铁律：

1. **不能靠运行时在线量化（如 `TorchAO` 对原版动态转 FP8）**  
   在线量化启动时仍然要先从 HuggingFace 拉完整 `30GB+` BF16 文件到本地，只省显存、**不省冷启下载时间**，无法解决 Salad / 低带宽平台超时问题。必须直接拉取 HF 上**已经预先量化打包好的文件**（GGUF / 预打包 FP8 / 4-bit）。
2. **必须 Transformer 与 Text Encoder 联合压缩**  
   现代 DiT 大模型体积与显存的真正大头往往在文本编码器（例如 §4.4.3 核算 `flux2-klein-9b` 的 `8B Qwen3` 文本编码器 FP16 单独达 `15.26 GB`；`qwen-image-2.1` 配 `Qwen3-VL-8B`；`z-image-turbo` 配 `Qwen3-4B`）。仅压 DiT 主干仍会有 `20GB+` 下载与显存压力，必须连同 Text Encoder 一起选型量化版本（例如 Q4_K_M / Q8_0 GGUF 或 FP8+INT4 组合）。

### 1.2 HuggingFace 现成预量化生态盘点（三款 `30GB+` 模型）

已检索确认三款主力大模型均已有现成官方/高赞社区量化仓库（具体子文件大小与兼容性需在接入阶段逐一实测核验）：

| 模型 | 原版 BF16 体积 | 现成 FP8 仓库 | 现成 GGUF 仓库 | 联合量化目标体积 |
| :--- | :--- | :--- | :--- | :--- |
| `flux2-klein-9b` | `34.7 GB` | `black-forest-labs/FLUX.2-klein-9b-fp8`（官方） | `unsloth/FLUX.2-klein-9B-GGUF`、`leejet/FLUX.2-klein-9B-GGUF` | ≤ 12–16 GB |
| `z-image-turbo` | `30.64 GB` | `drbaph/Z-Image-Turbo-FP8`、`tsqn/Z-Image-Turbo_fp8_comfyui` | `unsloth/Z-Image-Turbo-GGUF`、`jayn7/Z-Image-Turbo-GGUF` | ≤ 10–14 GB |
| `qwen-image-2.1` | `30.26 GB` | `unsloth/Qwen-Image-2.1-FP8`（含预转 FP8 Text Encoder copy） | `unsloth/Qwen-Image-2.1-Turbo-GGUF`、`unsloth/Qwen-Image-2.1-GGUF`、`AlperKTS/Qwen-Image-2.1-GGUF` | ≤ 12–16 GB |

### 1.3 Worker 与模型资产双版本设计思路

1. **复用并打通 `quant_accel.py`**：  
   [`worker/inference/quant_accel.py`](../worker/inference/quant_accel.py) 已具备 `QUANT_MODES`（`auto / none / torchao_fp8 / torchao_int8 / gguf`）、硬件算力门控（`sm_89+` 原生 FP8、`sm_75/80/86` 降级处理）及 `ggufFile` 字段设计。后续重点是将该规划接入 [`worker/inference/loaders/diffusers.py`](../worker/inference/loaders/diffusers.py) 的文生图管线（支持独立指定已量化 `transformer` / `text_encoder` GGUF 单文件或量化子仓库），并验证依赖包（`gguf` / `diffusers.GGUFQuantizationConfig` 等）在瘦镜像里的兼容与镜像增量大小。
2. **多版本分流与透明标识**（不在底层悄悄降画质）：
   - 模型资产层可按需定义**轻量量化变体**（例如 `pipeline.quantized` 覆写描述：独立 `downloadGb`、quant `repo` / `ggufFile`、`peakVramMb`）或由 `provider` 能力决定优先使用量化版还是满血版（如 `salad` / 12–16GB 低显存卡优先加载量化版，`private-worker` 48GB 卡 / `colab` A100 默认跑满血 BF16）；
   - **UI 显式透出**：当会话命中量化版时，在模型来源角标或设备摘要中明确标注「量化版（如 FP8 / GGUF Q4_K_M）」，不让用户误以为满血输出。
3. **强制验收门禁（沿用 [`INFERENCE_ACCELERATION_RESEARCH.md`](INFERENCE_ACCELERATION_RESEARCH.md) §4.1）**：  
   - **同 Seed Blind Check**：尤其针对 `Qwen-Image 2.1` 与 `Z-Image-Turbo` 的中英文文字排版、边缘清晰度与局部重绘融合，需与原版 BF16 并排对比达标后才准许正式开启；
   - **冷启/成本账本**：在 Salad `RTX 3090` / `RTX 4090` 真机复测“拉取总耗时 + 首图耗时 + 峰值显存 + 单次总费用”。

---

## 2. 阶段 2：高带宽按需租卡调研（RunPod Community Cloud vs Vast.ai）

> 目标：在**零存储月租**前提下跑通 **原版满血 30GB+ 模型**，将“按小时算力费 + 冷启等待损耗”压至最低。

### 2.1 什么是 RunPod Community Cloud（以及为什么适合费用优先场景）

RunPod 将机房分为两档资源池：
- **Secure Cloud**：Tier-3/4 合规认证机房，高 SLA 隔离、支持挂载持久 Network Volume，但卡价偏高（见 [`GPU_PROVIDER_COMPARISON.md`](GPU_PROVIDER_COMPARISON.md) 参考：`A5000` 约 `$0.27/hr`、`4090` 约 `$0.89/hr`）。
- **Community Cloud**：由经 RunPod 审核接入的中小托管商与合作机房提供（定位介于 Secure Cloud 与 Vast.ai 之间）：
  1. **卡价显著更低**：同类 24GB/48GB 卡通常比 Secure Cloud 便宜约 30%–50%；
  2. **仍保留机房网络与统一网关**：下行带宽普遍远高于 Salad 消费级家庭宽带（可支撑 1–3 分钟内拉完 `30GB+` 权重），且**原生提供 `https://<pod-id>-8765.proxy.runpod.net` 公网 HTTPS 入口**；
  3. **代价是不支持 Network Volume**，数据隐私隔离弱于 Secure Cloud——但对于**无持久卷 + `hf_xet` 现场拉取**的个人创作按秒/按分钟会话而言，这反而正中下怀（彻底省掉 `$7–$10+/月` 的 100GB 网络卷固定租金）。

### 2.2 关键成本算术：为什么个人按需场景不必买持久网络卷

以每月仅使用若干次、每次单会话跑数张至数十张图为例：
- **挂载 120GB 持久网络卷（存 3 个 30GB+ 模型）**：按 [`GPU_PROVIDER_COMPARISON.md`](GPU_PROVIDER_COMPARISON.md#L105) 基准（20GB `$1.4/月`），约 **`$8.4/月` 固定支出**（闲置也扣，且锁定单一数据中心导致高性价比卡经常缺货）；
- **高带宽无持久卷 + `hf_xet` 现场拉取**：机房 `1–3 Gbps` 下行拉 `30 GB` 耗时约 `1.5–4 分钟`，按 `$0.22–$0.35/hr` 卡价折算，每次开机拉权重仅多耗 **`$0.006–$0.02`**。在每月冷启 **400 次以下** 时，无持久卷总费用明显更低，且可跨机房全池抢最低价卡。

### 2.3 Vast.ai 的网络接入：SSH 本地隧道 vs 容器内置 Cloudflared 临时隧道

对照仓库安全基线 [`server/providers/worker-url.js`](../server/providers/worker-url.js#L4-L54)：
- Host 侧**强制拒绝公网明文 `http://`**（防止 Bearer Token 与生成图明文泄露）；
- **仅本机回环地址 `127.0.0.1` / `::1` / `localhost` 允许走 `http://`**。

> **决策记录（2026-11-25）**：暂不采用自有腾讯云公网服务器中转方案（避免个人公网服务器出站流量被快速消耗殆尽）。Vast.ai 不买域名且不占用自有服务器流量的接入方案聚焦以下两条纯点对点 / 免费隧道路径（**RunPod Community Cloud 则直接使用平台自带 `proxy.runpod.net` HTTPS，无需二选一**）：

| 方案 | 链路拓扑与握手方式 | Host 访问地址 | 核心优点 | 主要坑点与工程处理 |
| :--- | :--- | :--- | :--- | :--- |
| **1. 本机 SSH 隧道直连（Vast 首选）** | Vast API 创建前自动挂载本机自动生成的临时/专用 Ed25519 公钥 → 容器内监听 `127.0.0.1:8765` → Host 拉起 `ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:8765` | `http://127.0.0.1:<localPort>`（走本机回环，符合安全基线） | ① **全程端到端加密直连**，零第三方限流与流量上限；<br>② **不受 100s 网关超时切断影响**，支持大文件直传与 SSE；<br>③ **不要求 Vast 实例开放任意 HTTP 映射端口**，可筛选的最便宜卡池更大；<br>④ Windows 10/11 / macOS / Linux 均原生自带 `ssh`，用户零手动配置 | ① `ssh` 断线需由 Host 子进程守卫自动重拉；<br>② 国内部分用户如开启本机 HTTP/SOCKS 代理才能直连海外冷门 IP，需为 `ssh` 配代理参数（如 `-o ProxyCommand`）或在直连失败时切换备选通道 |
| **2. 容器内置 `cloudflared` 临时隧道（零 SSH 依赖备选）** | 容器启动后复用现有 [`worker/app.py`](../worker/app.py) / [`worker/daemon.py`](../worker/daemon.py) 的 `cloudflared` 隧道能力申请 `*.trycloudflare.com`；Host 直接通过 Vast Logs API 拉取该 URL（**不经公共 `ntfy.sh`**） | `https://<random>.trycloudflare.com` | ① **100% 复用 `server/net.js`（fetch/curl 自动走系统代理）**，无 SSH 代理适配问题；<br>② NAT 穿透能力强，仓库已有 `cloudflared` 版本锁定、SHA256 校验与 stderr 线程持续排空实现（见 [`worker/daemon.py`](../worker/daemon.py)） | ① Cloudflare Quick Tunnel **无 SLA、偶发限流/断连**，需在容器内保留退出自动重拉；<br>② 受 Cloudflare **100s 连接超时**制约，只可用异步 `/generate` + `/job` 轮询（Host 侧已兼容）；<br>③ 每次开机额外消耗数秒拉取/建隧道，国内部分直连网络下偶发波动 |

### 2.4 两条平台接入顺位建议

1. **若优先低研发成本、最快上线满血原版跑通 30GB+**：优先补 **RunPod（默认选 Community Cloud，无持久卷 + `hf_xet`）**——可最大程度复用现有 HTTPS 轮询与环境变量机制，工程量接近 `salad.js`，且完全免去隧道管理与自建中转。
2. **若优先极致小时单价与强制筛带宽（`inet_down >= 1000 Mbps`）**：接入 **Vast.ai API**，默认采用 **本机 SSH 隧道**（自动管理密钥与端口转发），将 **容器内置 `cloudflared`（经 Vast API 读日志获取地址，不依赖 `ntfy`）** 作为兼容代理网络的备选通道；实例清理必须调用销毁 `DELETE` 而非只 `stop`，避免残留磁盘小时计费。

### 2.5 跨 Provider 网络拓扑共识汇总

按各平台实际沙箱权限选最短、最稳的传输层与会合层，不强行统一：

| Provider | 沙箱网络权限 | 数据通道（传请求 / 图片） | 会合方式（获取接入地址） |
| :--- | :--- | :--- | :--- |
| **SaladCloud / RunPod** | 平台原生分配公网网关 | 平台自带 HTTPS Gateway / Proxy | 轮询平台 API 直接拿地址 |
| **Vast.ai** | 独立机房容器，多数开放 SSH 端口 | **本机 `ssh -L` 端口转发（首选）**，代理/弱网备选 `cloudflared` | Vast API 返回 `ssh_host:ssh_port`（或日志抓 URL），不用 `ntfy.sh` |
| **Google Colab** | 有 Jupyter WebSocket 控制面，无直连 IP | 容器内置 `cloudflared` | 直接读 Jupyter 输出/文件（见 [`COLAB_BACKEND_RESEARCH.md`](COLAB_BACKEND_RESEARCH.md) §3），不用 `ntfy.sh` |
| **Kaggle** | 封闭沙箱，只出不进、无交互控制面 | 容器内置 `cloudflared` | 走 `ntfy.sh` 秒级会合（避开平台日志延迟） |

---

## 3. 执行顺序建议

1. **当前第一步**：验证并打通 **阶段 1（预量化双组件权重加载 + 同 Seed 画质/耗时真机验收）**，重点先拿 `z-image-turbo` 与 `flux2-klein-9b` 在 `RTX 3090 / 4090` 跑出对比数字。
2. **后续扩展**：若画质验收表明部分场景仍必需原版 BF16 无损权重，再启动 **阶段 2（RunPod Community Cloud / Vast.ai Provider）**，并用同一套 Trace/费用账本对比各平台性价比。
