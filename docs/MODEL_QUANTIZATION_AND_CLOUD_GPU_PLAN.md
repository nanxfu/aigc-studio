# 重型模型预量化瘦身与低成本云算力演进方案（v3 决策收敛版，2026-11-25）

> **本轮迭代目的**：把上一版工程需求进一步按 **ROI 与用户钱包门槛** 收敛，去掉性价比与 `$10` 充值门槛均不占优的 RunPod 接入优先级，并把执行顺序改为**“先最小真机探针，再铺资产契约与 UI”**。
> **结论先行**：
> 1. **Diffusers 0.43 不能直接加载 GGUF 管线**，只能把 GGUF 权重装进单个 Model 类，再手动组装 Pipeline；现成 GGUF 仓库基本只含 DiT 主干。
> 2. **量化主力路线**：`z-image-turbo` 先走 Diffusers GGUF 主干 + BF16 Text Encoder（约 `11.23 GiB`）；探针优先验证 `Qwen/Qwen3-4B-FP8`（约 `4.83 GiB`，合计约 `8.6 GiB`），若 4-bit TE 可被 Diffusers 接受再冲 `~6–7 GiB`。`qwen-image-2.1` / `flux2-klein-9b` 先做 `stable-diffusion.cpp` 单卡门禁 G1（约 `9.2–10.1 GiB`），并严格守住 **默认 `aigc-worker` 压缩镜像体积上限（≤ `3.5 GB`）**。
> 3. **RunPod / Vast 专用 Provider 均暂缓**：RunPod 的充值门槛与单价优势不足；Vast 的两次真机实验暴露出按 GB 计费的下载开销，低频用户反复冷启很难摊销。高下载带宽只能缩短等待，不能消除流量费用。产品优先沿用现有 `Colab` / `private-worker` / `local-gpu` / `cloud-api`；Vast 仅保留工程实验及用户自备端点的接入路径。
> 4. **先探针后建大架构**：第 1 周前两天先做 `Z-Image` 最小加载探针与 `G1 sd.cpp` 能力/画质门禁，拿到实测成本和效果再落地 `variants[]` 契约与 UI。任何量化版必须显式可选、显式标识、失败不静默回退 30GB 满血。
> 5. **2026-11-26 真机结论**：Z-Image Diffusers GGUF + BF16 TE 通过；FP8 TE 被 torch 2.6 的 FP8 kernel/storage 阻塞；Qwen sd.cpp 的 t2i/单参考编辑/RGBA 通过、多参考第二张图未生效；Flux2 9B 的 t2i/多参考通过。Vast 实测下载费 `$1.512`（38.7GB × `$0.039/GB`）占单实例成本 81%，下一轮选机必须加 `inet_down_cost` 上限。
> 6. **低频用户成本决策（2026-11-26，覆盖此前的 Vast 优先级）**：H3 视频实测下载费 `$0.157`，六条视频的生成费用估算合计约 `$0.110`；即使较低的流量单价仍会使小批任务的首次下载成为主要成本。详见 [H3_VIDEO_GPU_LIVE_20261126.md](H3_VIDEO_GPU_LIVE_20261126.md)。本轮不开发自动租机的 Vast Provider，也不以长期租模型卷作为用户默认前提；下面 V-01～V-06 留作历史方案，不进入实施队列。

---

## 1. 原方案复核：哪些前提需要修正

| 原方案前提 | 代码 / 生态复核结果 | 本轮迭代决策 |
| :--- | :--- | :--- |
| “复用并打通 `quant_accel.py` 即可支持文生图量化” | [`worker/inference/quant_accel.py`](../worker/inference/quant_accel.py) 是视频/DiT 的**策略规划器**，`build_diffusers_quant_config()` 目前只生成配置对象；没有文生图 loader 调用它。`gguf` 分支返回的 `GGUFQuantizationConfig` 也不能直接传给 `from_pretrained()`。 | 新增**文生图量化组件加载**，不要把视频策略器当加载器复用；`quant_accel` 保持视频边界。 |
| “镜像已有 `torchao`，可做在线量化” | [`worker/pipeline_loader.py`](../worker/pipeline_loader.py) 明确在安装依赖前**卸载 `torchao`**（与新版 diffusers 冲突）；[`worker/requirements-gpu.txt`](../worker/requirements-gpu.txt) 也没有 `gguf`。 | 不在生产镜像恢复 `torchao`；按需新增并锁定 `gguf`。在线量化仍不解决冷启动下载，继续排除。 |
| “HuggingFace 已有双组件预量化仓库，直接拉即可” | 实测三款 Unsloth GGUF 仓库都只有**扩散主干单文件**；`unsloth/Qwen-Image-2.1-FP8` 虽含 FP8/INT8 文本编码器，但它是文件包而非可直接 `from_pretrained` 的 Diffusers 仓库，且需要自定义 W8A8 内核。 | 资产契约必须能描述**多仓库、多文件、逐组件精度**；不能假设“一个 repo + 一个 ggufFile”就够。 |
| “Salad 会根据量化版自动选卡/选盘” | [`server/providers/salad.js`](../server/providers/salad.js) 的 `requiredVramGbOf()` / `saladResourcesFor()` 目前只读模型顶层的满血 `peakVramMb` / `pipeline.downloadGb`。 | 选卡、磁盘、内存、下载预检都必须按**被选中的 variant** 计算，而不是模型顶层字段。 |
| “30GB+ 压到 8–16GB 就能解决 Salad 冷启” | `10–20 MB/s` 下，`16GB` 仍需约 `13–27 分钟`；只有压到 `6–10GB` 才接近 `5–15 分钟` 的可用区间。 | 量化目标拆成“可接受”（≤`14 GiB`）与“甜点”（≤`10 GiB`）；不能只看体积，必须看实际下载耗时与单次总费用。 |
| “量化版可以悄悄替换满血版” | 当前模型资产没有 variant 概念，Host 直接把 `preset.pipeline` 下发给 Worker；产物 meta 也没有精度字段。 | 新增 variant 契约与产物精度标识；显式选择，失败不静默回退。 |

---

## 2. 目标、非目标与验收口径

### 2.1 目标

- **降低重模型冷启**：让 `z-image-turbo` / `qwen-image-2.1` / `flux2-klein-9b` 在 Salad 或 `12–16GB` 消费卡上有可用的轻量档。
- **降低显存门槛**：轻量档在 `16GB` 卡上可加载、可出图；若只能跑 `24GB` 档，要明确标注。
- **不牺牲透明度**：用户能看到本次使用的模型、精度档、下载体积与运行来源。
- **不把可用性押在单一路径**：量化不通过的模型通过 `Vast.ai` / `Colab` / `private-worker` / `local-gpu` / `cloud-api` 承接满血版或商业 API。
- **可扩展**：新增一个量化资产只改 `models/*.json` + 必要的 loader，不在 Host 写死模型名。

### 2.2 非目标

- 不做运行时在线量化（`torchao` / `bitsandbytes` 从 BF16 现场转换）；它只省显存，不省首次下载。
- 不把 `30GB+` 权重打进客户端安装包或 Worker 镜像。
- 不在本轮做量化训练、蒸馏或自研量化算法。
- 不承诺量化版与满血版逐像素一致；但必须通过同 Seed 画质/文字/能力验收。
- 不因量化而默认关闭参考图、局部重绘、透明背景等能力；支持不了的必须显式降级标注。
- 本轮不接入 **RunPod**（`$10` 起充门槛偏高且 `3090`/`4090` 单价不具明显优势，详见 §7.2 暂缓说明）。

### 2.3 验收口径

| 维度 | 轻量档门槛 | 说明 |
| :--- | :--- | :--- |
| 下载体积 | `z-image` ≤ `12 GiB`（FP8 TE 目标 ≤ `9 GiB`；4-bit TE 若可用再冲 `6–7 GiB`）；`qwen` / `flux2-9b` ≤ `10.5 GiB` | 以 HF 文件字节 / `1024³` 计，含 VAE、tokenizer、config |
| 镜像体积 | 默认 `aigc-worker` 压缩镜像 ≤ `3.5 GB` | 若 `sd.cpp` 编译产物会导致超限，必须拆独立镜像 Tag，不得拖慢 Salad 基础冷启 |
| 冷启 | Salad 真机从零缓存到首图 ≤ `15 min`；目标 ≤ `10 min` | 至少 3 次，记录中位数与 P90 |
| 显存 | `z-image` 在 `16GB` 卡可跑；`qwen` / `flux2-9b` 至少在 `24GB` 卡可跑 | 12GB 卡是否可跑由真机决定，不靠估算宣传 |
| 画质 | 同 Seed / 同尺寸 / 同步数对比满血：LPIPS ≤ `0.08`、SSIM ≥ `0.93`；文字排版无可见退化 | 文字模型额外做 OCR 与盲测 |
| 能力 | 文生图必须通过；参考图 / 局部重绘 / 负向词按 variant 声明逐项验收 | 不支持就让 UI 禁用，不继承满血能力位 |
| 成本 | 记录下载、加载、首图、热图、计费秒数与单次总费用 | 与满血 + `Vast.ai`（或既有平台）同口径对比 |
| 回退 | 显式选轻量档失败时返回明确错误，**不得**自动改下满血 30GB | 防止用户在不知情下多等 20 分钟 |

---

## 3. 模型侧可行路线

### 3.1 四条候选路线

| 路线 | 做法 | 适用模型 | 优点 | 主要阻塞 |
| :--- | :--- | :--- | :--- | :--- |
| **A. Diffusers GGUF 主干 + BF16 文本编码器** | `ModelClass.from_single_file(gguf, quantization_config=GGUFQuantizationConfig(...))`，再把 Model 对象传给 `from_pretrained(base, transformer=...)` | `z-image-turbo` 已可算通；`flux2-9b` 体积仍约 `20.7 GiB`，不够 | 复用现有 Diffusers 管线、能力位基本不变、改动最小 | Diffusers 不支持 GGUF Pipeline；只能逐组件装；文本编码器未压缩 |
| **B. `stable-diffusion.cpp` 云端运行时** | 在 Worker 镜像内构建 Linux CUDA 版 `sd-server`，用「GGUF 扩散主干 + GGUF/INT8 文本编码器 + VAE」三文件运行 | 三款都覆盖 | 体积最小（`6–10.5 GiB`）；天然支持双组件联合压缩；本机 `sd-server` 已有桥接经验 | 没有现成 Linux CUDA release，需要镜像内多阶段构建；需要 Worker 侧协议适配与逐能力验收 |
| **C. Diffusers 预量化文件包 + 自定义算子** | 用 Unsloth FP8/INT8 仓库的 transformer + text encoder 文件，自定义 W8A8 Linear 内核与加载器 | `qwen-image-2.1` 有完整文件包 | 保持 Diffusers 管线与编辑能力；Qwen 文本编码器有预量化版本 | 文件包不是 Diffusers 目录结构；需要自定义量化内核；总体积约 `16.1 GiB`，只适合 24GB |
| **D. 高带宽 / 本地环境跑满血 BF16** | `Vast.ai`（筛选 `inet_down ≥ 1000 Mbps` + SSH 隧道）或现有 `Colab` / `private-worker` / `local-gpu` / `cloud-api` | 三款都覆盖 | 零画质风险；Vast 起充 `$5` 且可选低价 3090/4090；冷启 `2–5 分钟` | Vast 需 SSH 隧道与销毁防残留；RunPod 因 `$10` 门槛及单价不占优暂缓 |

### 3.2 逐模型建议

| 模型 | 满血组件体积（HF 文件） | 轻量主干 | 轻量文本编码器 | 轻量总下载 | 首选路线 | 风险 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `z-image-turbo` | `30.58 GiB` | `unsloth/Z-Image-Turbo-GGUF` `Q4_K_M` `3.59 GiB` | 原仓 BF16 `7.49 GiB`；FP8 `Qwen/Qwen3-4B-FP8` `4.83 GiB` | **`11.23 GiB`**；FP8 TE 约 **`8.6 GiB`**；4-bit 才可能 `6–7 GiB` | **A：Diffusers** | 低；需在探针确认 `diffusers 0.43` 加载与 FP8 TE 兼容性 |
| `qwen-image-2.1` | `30.21 GiB` | `unsloth/Qwen-Image-2.1-Turbo-GGUF` `Q4_K_M` `3.91 GiB` | `Qwen/Qwen3-VL-8B-Instruct-GGUF` `Q4_K_M` `4.68 GiB` | **`9.22 GiB`** | **B：sd.cpp（过 G1 门禁才做）** | 高；编辑/多参考/透明背景能力需逐项验证，并复用 `local-gpu` 三文件口径 |
| `flux2-klein-9b` | `32.32 GiB` | `unsloth/FLUX.2-klein-9B-GGUF` `Q4_K_M` `5.28 GiB` | `Qwen/Qwen3-8B-GGUF` `Q4_K_M` `4.68 GiB` | **`10.12 GiB`** | **B：sd.cpp；否则 D** | 高；sd.cpp 能力与画质待验证；不过 G1 则走 Vast/Colab/私有 Worker 满血 |

> 体积口径：按 2026-11-25 HuggingFace 文件树的字节数 / `1024³` 计算，含 VAE 与配置；与模型资产里写的 `downloadGb` 可能因口径/版本略有差异。
>
> `qwen-image-2.1` 的 Unsloth FP8 文件包约 `16.1 GiB`（INT8 主干 + INT8 文本编码器 + VAE），作为路线 C 的备选，不作为 P0。

### 3.3 决策门 G1：sd.cpp 是否值得接

在写 Worker 运行时前，先做一次**单卡 4090 / 3090 的技术门禁**。能力验证优先用 `sd-cli`（`-r` 可重复、能直接验多参考），通过后再验 `sd-server` 的服务化：

1. 在 Linux CUDA 环境构建 `stable-diffusion.cpp`，先用 `sd-cli` 跑通 `qwen-image-2.1` 与 `flux2-klein-9b` 的 `Q4_K_M` 三文件组合；CLI 通过后再用 `sd-server` 验证同一组合的服务化启动；
2. 记录从零缓存下载、加载、首图、第二张热图、峰值显存；
3. 用同一 Seed / 尺寸 / 步数对比满血 BF16，重点看中英文字排、透明背景、参考图编辑、局部重绘；
4. 产出能力矩阵：`text2image / reference / inpaint / negative / RGBA / seed / batch` 哪些真正可用。

**通过条件**：至少文生图与两款模型的核心卖点（Qwen 编辑/排版、Flux 多参考）可用，画质达到 §2.3 门槛，且 `sd-server` 可在独立镜像或体积红线内被 Worker 稳定托管。
**不通过**：`qwen` / `flux2-9b` 轻量档直接放弃云端 `sd.cpp`（**不写整套 `sd-cpp` 运行时与协议映射**），仅走 Vast/Colab/私有 Worker/cloud-api 路线；`z-image` 继续走路线 A，不受影响。

---

## 4. 分阶段需求

### 4.0 阶段 0：前置最小真机探针（P0 最先执行，不改契约与 UI）

> 目的：用 1–2 天、最少代码直接拿到核心未知数的真机证据，避免在方案未证实前大铺 `variants[]` / UI / 多运行时代码。

- [x] **P-01 `Z-Image` 最小 GGUF 验证（单卡 4090 / 本机）**：运行 [`tools/probes/zimage_gguf_probe.py`](../tools/probes/zimage_gguf_probe.py)，验证 `diffusers 0.43` `ZImageTransformer2DModel.from_single_file` 能否正常加载 `Q4_K_M`；分别跑 `--te-mode base` 与 `--te-mode fp8`（`Qwen/Qwen3-4B-FP8`），记录总下载、加载、首图/热图、峰值显存与同 Seed 中文排字盲测。结果见 §9.5。
- [x] **P-02 G1 `sd.cpp` 单卡能力与画质门禁（单卡 4090 / 3090）**：运行 [`tools/probes/sdcpp_g1_probe.sh`](../tools/probes/sdcpp_g1_probe.sh)，先用 `sd-cli` 实测 `qwen-image-2.1`（编辑/排版/RGBA/多参考）和 `flux2-klein-9b`（多参考）的显存、耗时与可用能力。结果见 §9.5。
- [ ] **P-02b `sd-server` 服务化**：CLI 通过后单独验证三文件启动、HTTP 模式、独立镜像体积与 Host 协议映射；未通过前不进入资产。

### 4.1 阶段 1A：资产契约与透明选择（P0，探针通过后统一落盘）

- [x] **Q-01 资产 schema**：`models/*.json` 新增可选 `variants[]`，用于描述轻量档；顶层 `pipeline` / `measured` 继续代表满血档，保证既有资产逐字兼容。
- [x] **Q-02 公开视图**：`tools/build-assets.mjs` 生成 `precisionOptions`（含满血档）与 variant 的公开元数据；`pipeline` / `variants` 仍不下发客户端。
- [x] **Q-03 选择规则**：Host 新增 `resolveVariant(preset, requestedVariantId, provider)`；显式传 `'auto'` 时按 provider 自动选择（当前 Salad 重模型优先轻量，其它来源满血），未传则保留旧端兼容行为；产物记录实际选择。
- [x] **Q-04 产物元数据**：任务与图片 meta 增加 `variantId`、`precision`、`downloadGb`、`quantizationScheme`；画廊/结果卡显示角标。
- [x] **Q-05 不静默回退**：显式 variant 不可用、Worker 不支持、文件缺失时返回明确错误；不得自动改跑满血或另一档。

**验收**：`npm run models:check`、`node test/check-contract.mjs`、客户端逻辑测试通过；未声明 `variants` 的 5 款模型对外快照不变。

### 4.2 阶段 1B：Z-Image 轻量档（P0，首个可交付量化）

- [x] **Z-01 依赖**：Worker GPU 镜像新增锁定版 `gguf==0.19.0`（版本与 torch 2.6 / diffusers 0.43 组合验证）；不恢复 `torchao`，不默认启用远程 `kernels`。
- [x] **Z-02 加载器**：`ZImageLoader` 支持 `pipeline.quantization.scheme === "gguf"`，按组件加载 `ZImageTransformer2DModel.from_single_file()`，文本编码器/VAE/tokenizer 从原仓 BF16 组件加载。
- [x] **Z-03 多仓下载**：`pipeline.downloads[]` 支持多个 repo + 文件白名单；`required_download_gb`、预下载、磁盘预检、缓存 keep-set 全部按多仓计算。
- [x] **Z-04 资产**：`models/z-image-turbo.json` 增加 `compact-q4` variant，固定 GGUF repo revision 与文件名，写清 `downloadGb` / 预计显存（并在 [salad.js](../server/providers/salad.js) 中按 variant 资源与 `cpuOffload` 选卡）。
- [x] **Z-05 真机**：Salad `RTX 3090` / `RTX 3090 Ti` / `RTX 4090` 各跑一次冷启与热图，记录 §2.3 指标；4090 达标，3090 略超，3090 Ti 慢节点明显超时。
- [x] **Z-06 画质**：4090 同 Seed 对比满血 BF16；中英文文字均清晰，满血石阶纹理略细，未见文字退化。

**验收**：轻量档可显式选择、可出图、可标识；失败不下载满血；`16GB` 卡与 Salad 冷启在 ≤ `15 min` 内跑通（以真机为准）。

### 4.3 阶段 1C：Qwen / Flux2 轻量档（P1，仅在 P-02 G1 通过后实施）

- [ ] **G1-02** 新增 `sd-cpp` Worker 运行时（尽量与本机 `local-gpu` `sd-server` 协议及三文件配置对齐；严格遵守镜像体积闸门或使用独立镜像 Tag）；
- [ ] **G1-03** `models/qwen-image-2.1.json` / `models/flux2-klein-9b.json` 增加 `sd-cpp-q4` variant，逐项声明能力位；
- [ ] **G1-04** 若 P-02 未通过：两款模型不上线云端 `sd-cpp`，仅保留满血档（后续走 Vast / Colab / 私有 Worker / `cloud-api`）；Qwen FP8 路线 C 另立专项。

**验收**：通过则轻量档在 `24GB` 卡跑通核心能力；不通过则彻底关掉入口，不留半成品。

### 4.4 Vast.ai 专用 Provider（2026-11-26 暂缓，历史方案）

以下配置与工作项仅保留为调研记录。低频用户的首次下载、环境准备和存储费用尚未达到产品成本目标，不新增 `vast` 的契约、设置或自动租机入口。用户已有长期 GPU 环境时可继续通过平台通用的 `private-worker` 连接；重新评估须基于完整任务账单，不能只按 GPU 小时价与带宽决定。

> **为什么选 Vast.ai 而暂缓 RunPod**：实查 RunPod 最低充值 `$10`（且启动须够 1 小时额度），Community `3090` `$0.22/hr` 起、`4090` `$0.34/hr` 起、另加磁盘费，与 Salad 相比既无单价优势又提高充值门槛；Vast.ai 最低充值 **`$5`**（门禁减半），`3090` 起价 `$0.09–$0.16/hr`、`4090` 起价 `$0.07–$0.36/hr`，且 API 支持硬过滤 `inet_down ≥ 1000 Mbps` 保证 `30GB+` 几分钟下完。

- [ ] **V-01** Provider 契约与设置；`shared/contract.js` 新增 `vast`（与现有云端算力同组，不新增 `runpod`）。
- [ ] **V-02** 选机过滤：`inet_down ≥ 1000 Mbps`、**`inet_down_cost ≤ $0.002/GB`（优先 `$0`）**、`RAM ≥ 32GB`、驱动 ≥ `550`、CUDA ≥ `12.4`、磁盘足够、可靠性阈值与价格上限。
- [ ] **V-03** SSH 隧道（首选）：Host 生成本机临时 Ed25519 密钥，创建实例时注入；`ssh -N -L 127.0.0.1:<port>:127.0.0.1:8765` 子进程守卫 + 断线重拉 + 端口释放。
- [ ] **V-04** 备选通道：容器内 `cloudflared` 临时隧道；从 Vast Logs API 取 URL，不走 `ntfy.sh`；保留 100s 超时下的异步轮询。
- [ ] **V-05** 销毁：`DELETE /instances/{id}/` 并验证状态；启动补清理；防止“只 stop 不 destroy”持续计费。
- [ ] **V-06** 安全：只允许 `https://` 或 `127.0.0.1` HTTP；SSH/隧道参数不得 shell 拼接；日志不落 Token。

**验收**：离线 mock 测试覆盖选机、隧道参数、重连、清理、日志解析；真机跑通一款 `30GB+` 模型并核对账单（冷启总时长 ≤ `8 min`，退出无残留实例）。

---

## 5. 资产契约（建议实现）

### 5.1 `variants[]` 结构

顶层 `pipeline` / `measured` 继续代表满血档；轻量档写在可选 `variants[]` 中，**不改变未声明模型的现有快照**。

```json
{
  "id": "z-image-turbo",
  "pipeline": {
    "loader": "zimage",
    "base": "Tongyi-MAI/Z-Image-Turbo",
    "dtype": "bf16",
    "downloadGb": 30.58,
    "allowPatterns": ["model_index.json", "scheduler/**", "text_encoder/**", "tokenizer/**", "transformer/**", "vae/**"]
  },
  "measured": { "peakVramMb": 12232, "loadSeconds": 131.7, "steadySeconds": 30.66, "downloadGb": 30.58 },
  "variants": [
    {
      "id": "compact-q4",
      "label": { "zh": "轻量 Q4", "en": "Compact Q4" },
      "precision": "GGUF Q4_K_M",
      "runtime": "diffusers",
      "downloadGb": 11.23,
      "peakVramMb": null,
      "providers": ["salad", "private-worker", "colab"],
      "pipeline": {
        "loader": "zimage",
        "base": "Tongyi-MAI/Z-Image-Turbo",
        "dtype": "bf16",
        "cpuOffload": true,
        "downloadGb": 11.23,
        "downloads": [
          {
            "repo": "Tongyi-MAI/Z-Image-Turbo",
            "revision": "<pin-to-commit>",
            "allowPatterns": ["model_index.json", "scheduler/**", "text_encoder/**", "tokenizer/**", "vae/**", "transformer/config.json"]
          },
          {
            "repo": "unsloth/Z-Image-Turbo-GGUF",
            "revision": "<pin-to-commit>",
            "files": ["z-image-turbo-Q4_K_M.gguf"]
          }
        ],
        "quantization": {
          "scheme": "gguf",
          "computeDtype": "bf16",
          "components": {
            "transformer": {
              "repo": "unsloth/Z-Image-Turbo-GGUF",
              "file": "z-image-turbo-Q4_K_M.gguf",
              "modelClass": "ZImageTransformer2DModel",
              "configRepo": "Tongyi-MAI/Z-Image-Turbo",
              "configSubfolder": "transformer"
            },
            "textEncoder": { "mode": "base", "repo": "Tongyi-MAI/Z-Image-Turbo", "subfolder": "text_encoder" },
            "vae": { "mode": "base", "repo": "Tongyi-MAI/Z-Image-Turbo", "subfolder": "vae" }
          }
        }
      },
      "measured": { "peakVramMb": null, "loadSeconds": null, "steadySeconds": null, "downloadGb": 11.23 }
    }
  ]
}
```

### 5.2 字段规则

| 字段 | 规则 |
| :--- | :--- |
| `variants` | 可选数组；存在时必须非空；`id` 唯一且不得为 `full`（`full` 保留给顶层）；每项必须有 `id` / `label.zh` / `label.en` / `precision` / `pipeline` |
| `variant.runtime` | `diffusers` / `sd-cpp`；缺省 `diffusers`。与顶层 runtime 不同时，必须显式声明 `capabilities` |
| `variant.providers` | 可选；缺省继承模型顶层 `providers`；显式给出时按同一套白名单校验 |
| `variant.capabilities` | 可选对象；`supportsImg2Img` / `supportsInpaint` / `supportsReference` / `supportsNegative`。跨运行时不得静默继承 |
| `variant.downloadGb` | 必填正数；与 `measured.downloadGb` 非空时必须一致 |
| `variant.peakVramMb` | 可为 `null`（未实测）；非空时用于选卡，不得沿用满血值冒充 |
| `pipeline.downloads[]` | 多仓下载描述；每项 `repo` + `allowPatterns` 或 `files`；生产固定 `revision` |
| `pipeline.quantization.components` | 逐组件描述 `transformer` / `textEncoder` / `vae` 的来源与精度；`mode: "base"` 表示沿用原仓 |
| `pipeline.sdCpp` | 路线 B 的本地文件映射与启动参数：`modelPath` / `llmPath` / `vaePath`，编辑能力可选 `llmVisionPath`；名称尽量与本机 `local-gpu` 的 `modelPath` / `vaePath` 口径一致，不得把 prompt 拼进 shell |

### 5.3 选择规则

Host 统一实现 `resolveVariant()`，客户端只传可选 `variantId`：

1. 请求显式 `variantId`（非 `'auto'` 且非空）：必须精确命中；未知 id → `invalid_request`，**在下发任务/创建付费实例前拒绝**。
2. `requestedVariantId === 'auto'` 时由 `resolveVariant()` 自动路由：
   - `provider === "salad"` 且满血 `downloadGb ≥ 24` 且有轻量档 → 默认轻量；
   - `colab` / `private-worker` / 其它来源 → 满血（本轮没有稳定的远端显存 / 带宽读数，
     不按猜测自动降档）；
   - `local-gpu` → 走本机独立配置，不参与云端 variant 选择；
   - Vast 专用 Provider 暂缓，不定义其“默认满血”选档规则；用户自备 Vast 端点按普通 `private-worker` 的显式模型选择处理；
   - 其它来源或无 variant → 满血。
3. 兼容旧客户端：请求完全未传 `variantId` 时按满血 `full` 处理（新 UI 默认下发 `'auto'`）。
4. 结果写入任务：`variantId` / `precision` / `downloadGb` / `provider`；任务执行期间不得再改档。
5. Worker `/health.capabilities` 不支持该精度/运行时时，Host 应在预检阶段拒绝，而不是等远端加载失败。

### 5.4 产物与 UI

- 结果卡与画廊角标：`满血 BF16` / `轻量 Q4_K_M` / `轻量 INT8`，不能只写“量化”。
- 首次选择轻量档时提示：画质略低、文字/细节可能退化、可切回满血。
- 预估卡展示：下载体积、预计冷启（按 provider 带宽档）、所需显存。
- 导出/分享 meta 保留 `variantId` 与 `precision`，便于复现与排障。

---

## 6. Worker 加载与缓存需求

### 6.1 路线 A（Z-Image）

- 新增 `gguf` 依赖并锁定版本；在 GPU 镜像构建期安装，运行时不 pip。
- `ZImageLoader.construct()` 检测 `pipeline.quantization.scheme`：
  1. 解析本地 GGUF 文件路径（预挂载优先）；
  2. `ZImageTransformer2DModel.from_single_file(path, config=configRepo, subfolder="transformer", quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16), torch_dtype=torch.bfloat16)`；
  3. 用 `ZImagePipeline.from_pretrained(base, transformer=quantized, text_encoder=..., vae=..., tokenizer=..., torch_dtype=bf16)` 组装；
  4. 不把 `GGUFQuantizationConfig` 传给 `from_pretrained()`。
- 若当前 diffusers 0.43 的 `ZImageTransformer2DModel` 不支持 GGUF，则先升级/验证 diffusers 版本；**不得**用 `torchao` 在线量化绕过。
- `gguf` 的动态反量化默认走 CPU/PyTorch 路径；远程 `kernels` 加速需要 `DIFFUSERS_TRUST_REMOTE_KERNELS=true`，本轮默认关闭。
- 失败分类：
  - `quantization_unsupported`：Worker 版本/架构不支持；
  - `model_file_missing`：GGUF 或组件缺失；
  - `download_failed`：网络/鉴权；
  - `oom`：显存不足。
  以上都不得自动改跑满血。

### 6.2 多仓下载与缓存

[`worker/cache_ops.py`](../worker/cache_ops.py) 当前以单 `base` + `allowPatterns` 预下载；需要扩展：

- `pipeline.downloads[]` 逐项 `snapshot_download` / `hf_hub_download`；
- `required_download_gb()` 优先读显式 `downloadGb`，缺失时按 `downloads[]` 估算；
- 磁盘预检、LRU 清理、keep-set 同时覆盖多个 repo；
- `resolve_local_weight()` 能解析 `repo + file` 到本地缓存路径；
- 切换满血/轻量/其它模型时，缓存键必须区分，避免误复用；
- 下载失败只影响当前 variant，不污染满血缓存。

### 6.3 路线 B（sd.cpp）

- **默认 `aigc-worker` 镜像保持 ≤ `3.5 GB`（压缩）**；`sd.cpp` 编译产物不得塞进基础镜像。若 G1 通过，单独构建 `aigc-worker-sdcpp` Tag（多阶段构建，固定 commit/SHA256，最终只保留二进制、动态库与 license），Salad 仅在选择轻量 sd.cpp 档时拉该 Tag。
- `pipeline.sdCpp` 尽量复用本机 `local-gpu` 的字段口径：`modelPath`（扩散主干）、`llmPath`（文本编码器）、`vaePath`（VAE），编辑能力再加可选 `llmVisionPath`（mmproj）；映射到 `--diffusion-model` / `--llm` / `--vae` / `--llm_vision`。
- Worker 内以子进程托管 `sd-server`，Python 侧只做 HTTP 客户端与协议映射；一次只加载一个活跃模型，切模型先释放。
- 启动参数至少覆盖：`--diffusion-model`、`--llm`、`--vae`、`--params-backend disk`、`--vae-tiling`、线程数。
- 参考图、蒙版、负向词、RGBA、seed、宽高必须逐项验证；不支持的能力在 `/health.capabilities` 不虚标。
- `/health` 增加 `quantization` / `runtimes` 能力位；Host 预检据此决定是否允许轻量档。
- 进程退出、请求超时、显存不足要有明确错误码；不得把 sd-server 的 stderr 原样回传用户（可能含路径/Token）。

---

## 7. Provider 需求

### 7.1 通用

- 本轮不新增 `vast` / `runpod` Provider，沿用现有来源；工程实验和用户自备远程环境继续复用 `private-worker`。
- Provider 必须上报 `protocol_version` / `capabilities` / `hardware`；Host 只对支持对应 variant 的 Worker 下发。
- 创建实例前先落**待清理租约**；应用异常退出后启动补清理；删除/销毁必须验证，不能只看本地状态。
- 所有公网访问走 HTTPS；只有 `127.0.0.1` / `::1` / `localhost` 允许明文 HTTP（沿用 `worker-url.js`）。
- 凭据加密落盘，日志脱敏；错误文案区分“未配置 / 鉴权失败 / 无卡 / 镜像拉取失败 / 启动超时”。

### 7.2 RunPod Community（已评估暂缓）

> **暂缓决策（2026-11-25）**：经核价与产品门槛评估，RunPod 最低充值 `$10`（且开启 Pod 要求余额 ≥ 1 小时配置租金），Community Cloud 参考起价为 `A5000 $0.16/hr`、`3090 $0.22/hr`、`4090 $0.34/hr`（另加磁盘计费），对比 Salad `medium`（`3090 $0.163/hr`、`4090 $0.347/hr`）无明显价格优势却大幅提高用户入场门槛。因此不纳入本轮开发；仅作技术调研留档。

### 7.3 Vast.ai（暂缓产品接入，保留实验与自备端点）

以下是将来重新评估时的技术参考。费用门槛需覆盖模型下载、运行时镜像、计费准备时间、空闲和销毁后的存储；“速度快”不能替代低频用户的单次总成本。持久缓存或批量生成可能摊薄成本，但不能要求所有用户承担这类长期投入。

| 项 | 要求 |
| :--- | :--- |
| 选机 | `inet_down ≥ 1000 Mbps`、**`inet_down_cost ≤ $0.002/GB`（优先 `$0`）**、`RAM ≥ 32GB`、驱动 ≥ `550`、CUDA ≥ `12.4`、磁盘足够、可靠性阈值；须再核对整次冷启动总费 |
| 首选通道 | 本机 `ssh -L` 隧道到容器 `127.0.0.1:8765`；自动生成/注入临时 Ed25519 公钥 |
| 隧道守卫 | 子进程退出自动重拉、指数退避、端口占用检测、断开时释放本地端口 |
| 备选通道 | 容器内 `cloudflared` 临时隧道；经 Vast Logs API 取 URL，不用 `ntfy.sh` |
| 销毁 | `DELETE /instances/{id}/` 并验证；不允许只 `stop` 造成残留计费 |
| 代理网络 | 国内用户需要时给 `ssh` 配 `ProxyCommand`，不把代理参数写进日志 |

### 7.4 成本账本

每次真机任务至少记录：

```json
{
  "provider": "vast",
  "gpuName": "RTX 4090",
  "hourlyUsd": 0.35,
  "variantId": "full",
  "downloadGiB": 32.3,
  "downloadSeconds": 180,
  "downloadUsd": 0,
  "loadSeconds": 99,
  "firstImageSeconds": 12,
  "steadyImageSeconds": 8.7,
  "billedSeconds": 420,
  "estimatedCostUsd": 0.041
}
```

---

## 8. UI / 交互需求

- 模型卡在存在 `precisionOptions` 时显示「精度」选择：`自动` / `满血 BF16` / 各轻量档；新 UI 默认下发 `variantId: "auto"`（走 `resolveVariant()`），旧客户端完全不传时 Host 才按满血 `full` 处理。
- 选中轻量档时，生成按钮旁展示下载体积与预计冷启；选中满血时展示“画质优先、下载更久”。
- 结果卡、画廊、会话设备摘要都必须显示实际精度角标；用户切换模型/Provider 后角标随实际执行结果更新。
- 轻量档能力位与满血不同时，参考图/蒙版/负向词入口按 variant 禁用并给原因，不显示“点了才报错”的入口。
- 文案使用具体精度（`Q4_K_M` / `INT8` / `BF16`），不用含糊的“高性能模式”。
- 中英文词典同步；新增文案必须有 `zh` / `en` 两套。

---

## 9. 验收矩阵

### 9.1 离线

- `npm run models:check`
- `node test/check-contract.mjs`
- `npm run test:worker`
- 新增：variant schema / 选择规则 / 多仓下载 / 缓存 keep-set / 产物 meta / Provider mock / 清理补扫
- 旧资产快照不变；新增字段只在声明 variant 的 3 款模型出现。

### 9.2 真机

| 场景 | 模型 | Provider | 档位 | 必须记录 |
| :--- | :--- | :--- | :--- | :--- |
| Z-Image 轻量 | `z-image-turbo` | Salad 3090 / 4090 | `compact-q4` | 下载、加载、首图、热图、峰值显存、费用 |
| Z-Image 满血对照 | `z-image-turbo` | 私有 4090 | `full` | 同 Seed 画质对比 |
| Qwen 轻量门禁 | `qwen-image-2.1` | 4090 / 3090 | `sd-cpp-q4` | 文生图、编辑、参考图、排版、显存 |
| Flux 轻量门禁 | `flux2-klein-9b` | 4090 / 3090 | `sd-cpp-q4` | 文生图、多参考、画质、显存 |
| Vast 满血（阶段 2） | 任一 30GB+ | Vast 3090 / 4090 | `full` | SSH 隧道、断线重拉、销毁、费用 |

### 9.3 画质

- 固定 8 条提示词 × 2 个 Seed × 同尺寸/同步数；
- 指标：LPIPS、SSIM、文字 OCR 准确率、人工盲测偏好；
- 重点场景：中英文字排、透明背景、局部重绘接缝、参考图身份保持；
- 不达标：该轻量档不得默认开启，只能标“实验”或不发布。

### 9.4 失败路径

- 轻量档 Worker 不支持 → 预检拒绝，不创建实例；
- GGUF 文件 404 / 鉴权失败 → 明确错误，不下载满血；
- 磁盘不足 → 先清 LRU，仍不足则失败；
- sd-server 崩溃 → 任务失败、进程回收、下一次可重试；
- 应用崩溃 → 启动补清理删除 Vast 实例 / Salad 容器组。

### 9.5 探针结果回填（P-01 / P-02）

> 真机：Vast.ai 单卡 `RTX 4090 24GB`，`pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel`，CUDA 12.4，驱动 `595.91.07`。
> 结果文件：[`bench-results/vast-20261126`](../bench-results/vast-20261126)。

| 探针 | 下载 GiB | 加载 s | 关键耗时 s | 峰值显存 MiB | 结论 |
| :--- | ---: | ---: | :--- | :--- | :--- |
| P-01 Z-Image + BF16 TE | `12.0`（HF 缓存） | `43.0` | cold `6.29` / warm `5.85` | `14,100` | **保留**：Diffusers 0.43 + GGUF Q4 + BF16 TE 可用，中英文字排清晰 |
| P-01 Z-Image + Qwen3-4B-FP8 | `8.6`（GGUF 3.59 + TE 4.83 + VAE 0.16） | `5.45` 后失败 | 无图 | — | **放弃（当前栈）**：`dtype=float8` 报 `Float8_e4m3fnStorage`；装 `kernels==0.18.2` 后报 `torch.float8_e8m0fnu` 缺失（torch 2.6） |
| P-02 Qwen t2i | `10.3` | 未单列 | `8.1` | `14,458` | **保留**：主标题中英文字排清晰；小字有幻觉 |
| P-02 Qwen edit | 复用 | — | `10.1` | `16,090` | **保留**：把「山城夜色」改为「QWEN IMAGE 2.1」，场景/版式保持 |
| P-02 Qwen RGBA | 复用 | — | `7.4` | `13,934` | **保留**：PNG colorType 6，alpha 0–255，透明像素约 `53.3%` |
| P-02 Qwen multi-ref | 复用 | — | `11.6` | `20,848` | **降级**：技术不报错，但第二张参考未生效；红方块最小测试复现，只用了第一张图 |
| P-02 Flux2 t2i | `10.3` | 未单列 | `5.3` | `10,480` | **保留**：产品照正常 |
| P-02 Flux2 multi-ref | 复用 | — | `11.3` | `12,914` | **保留**：红陶壶正确放入霓虹楼梯海报场景，多参考生效 |

**实测成本（必须纳入下一轮选机）**：

- 最终探针实例 `62609477` 计费 `$1.866`：GPU `$0.307` + 存储 `$0.036` + **下载 `$1.512`（38.7GB × `$0.039/GB`）**。
- 重建/SSH 排查的 4 个短实例合计 `$0.107`；本任务总计约 **`$1.97`**。
- 收尾二次核对：`GET /api/v1/instances/` 活跃实例 `0`，探针实例已彻底销毁，不是只 `stop`。
- 下载费占单实例成本约 **81%**；Vast 选机不能只筛 `inet_down >= 1000 MB/s`，还必须增加 **`inet_down_cost` 上限（建议 `≤ $0.002/GB`，优先 `$0`）**，否则一次 30GB 冷启的流量费会超过 GPU 时间费。
- P-02 端到端约 `25 min`，其中 CUDA 编译约 `15 min`；若做云端 sd.cpp，镜像必须预编译并独立 Tag，不能每次开机现编。

**Vast 只读库存（2026-11-26，零成本，仅 POST `/api/v0/bundles/`）**：

- 过滤：单卡、`inet_down >= 1000 Mbps`、`inet_down_cost <= $0.002/GB`、磁盘 `>= 50 GB`、
  on-demand、`dph_total <= $0.50`。
- 结果：共 **10 台**（RTX 3090 × 5、RTX 4090 × 5）；其中 **3 台**下载流量费为 `$0`。
- 价格：RTX 3090 最低 `$0.121/h`（中位 `$0.204/h`）；RTX 4090 最低 `$0.401/h`
  （中位 `$0.455/h`）。查询结果落盘在 `bench-results/vast-inventory-20261126/summary.json`。
- 结论：Vast 可以作为「高带宽满血 30GB+」的按需兜底，但当前库存偏薄（每档仅 5 台），
  4090 最低价也接近 `$0.50` 上限；**暂不正式立项 Vast Provider**，继续以 Colab /
  private-worker / Salad 为主，等需要稳定大显存档时再接。

**Salad 真机验收（2026-11-26，Worker 镜像 `manual-58e6674`）**：

| 节点 | Worker ready | compact 冷启总 | 加载 | 首图 | 热图 | 峰值显存 | 结论 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| RTX 3090（medium，默认区域） | `884.4s`（14.74min） | `984.9s`（16.41min） | `69.5s` | `27.41s` | `21.68s` | `7,876 MiB` | 功能通过；比 15min 门槛多约 1.4min，主要是镜像拉取 |
| RTX 3090 Ti（medium，不限区域，慢节点） | `804.6s`（13.4min） | `1790.5s`（29.8min） | `963.4s` | `18.75s` | `16.83s` | `7,876 MiB` | 最差样本；社区节点带宽不可控 |
| RTX 4090（medium） | `165.1s`（2.75min） | `329.1s`（5.48min） | `141.4s` | `17.21s` | `12.83s` | `7,876 MiB` | **通过**：冷启 ≤15min，热图稳定 |
| RTX 4090 满血 BF16（同容器） | 复用 | 同容器切换 `149.7s` | `119.4s` | `26.31s` | — | `12,233 MiB` | 同 Seed 对照：文字均清晰，满血石阶纹理略细 |

- 三次真机合计约 **`$0.18`**（3090 `$0.163/h` × ~16.9min + 3090 Ti `$0.180/h` × ~30min +
  4090 `$0.347/h` × ~8.3min），
  产物与 `summary.json` 在 `bench-results/salad-zimage-20261126/`。
- 4090 compact 与 Vast 4090 的 compact 图在同 prompt / seed 下视觉一致，说明 GGUF 主干加载稳定；
  3090 Ti 节点出的构图/光影不同，但中英文标题仍清晰，属于设备/卸载路径差异，不是文字退化。
- **结论**：`compact-q4` 保留；Salad 的 15min 门槛在 4090/fast node 上成立，精确 3090 默认区域
  为 `16.4min`（略超），3090 Ti 慢节点可到 `29.8min`。自动路由仍保留 Salad → compact，
  但产品文案不能写死“3090 也 ≤15min”，只能把 4090 作为硬门槛样本。

**路线结论**：

1. **Z-Image**：保留 Diffusers GGUF + BF16 TE（`11.23 GiB` 档）；不把 FP8 TE 作为本轮交付项。若要继续压缩，需先升级 torch 到支持 `float8_e8m0fnu` 的版本并重新跑兼容矩阵，或改走 sd.cpp。
2. **Qwen**：sd.cpp 的 t2i/edit/RGBA 可用；多参考第二张图未生效，因此 sd.cpp 轻量档必须暂时关闭 `supportsReference`（或只允许单参考编辑），不能宣称“多图参考”。
3. **Flux2 9B**：sd.cpp 的 t2i + multi-ref 均可用，是当前最有价值的云端轻量档候选；仍需补 `sd-server` 服务化验证后才能进 Worker。
4. **sd-server**：本轮只验 `sd-cli`；服务化未验证，不能直接按“已通过 G1”立项。

---

## 10. 风险与待决事项

| 风险 | 影响 | 缓解 |
| :--- | :--- | :--- |
| Diffusers 0.43 对 `ZImageTransformer2DModel` GGUF 支持不完整 | 路线 A 可能需升级 diffusers 或改用手动 state dict | 阶段 0 `P-01` 先用单卡 4090 做 30 行最小加载验证；失败则不进 Schema 开发 |
| sd.cpp 无 Linux CUDA 预编译包 | Worker 镜像构建变重、CI 变慢 | 多阶段构建 + 固定 commit；若超 `3.5 GB` 体积闸门，独立拆出镜像 Tag |
| Qwen 编辑/多参考/透明能力在 sd.cpp 不一致 | 轻量档可能失去核心卖点 | `P-02` G1 门禁先测；不支持就放弃云端 `sd.cpp`，保留满血 |
| Qwen sd.cpp 多参考实际只使用第一张图 | 不能宣称多图编辑；用户会在不知情下得到错误结果 | 轻量档 `supportsReference` 先置 `false`，只开放单参考编辑；等上游修复/复核后再打开 |
| Q4 文本编码器损伤中英文字排 | Qwen/Flux 画质不达标 | 优先测试 Q8/INT8 文本编码器；必要时接受 `12–14 GiB` 体积换质量 |
| Vast 高带宽 offer 带 `$0.039/GB` 下载费 | 30GB 冷启流量费约 `$1.17`，可超过 GPU 时间费 | 选机必须过滤 `inet_down_cost`（建议 `≤ $0.002/GB`）；或使用可复用缓存/零入站费机器；成本账本必须单列下载费 |
| Windows / Clash fake-ip 会把 `ssh*.vast.ai` 解析成 `198.18.x.x` | SSH 连接被代理提前切断，实例已 Running 却无法登录 | 通过 DoH 取真实 IP 直连并保留 `HostKeyAlias`；Provider 侧优先使用 cloudflared 或显式直连地址 |
| Vast 自定义 SSH key 未稳定注入实例 | 创建后反复 `Permission denied`，持续计费 | 首次接入必须用 `vastai create ssh-key` 生成的默认 key；Provider 创建前做握手自检，失败立即销毁 |
| 第三方 GGUF 仓库漂移/下架 | 冷启失败、版本不可复现 | 生产固定 commit SHA；记录 license；必要时自建镜像仓 |
| HF gated 仓库无 Token | 组件下载 401 | 预检提示配置 HF Token；错误映射为 `model_gated` |
| 多仓下载/缓存改动影响满血路径 | 既有模型回归 | 未声明 `downloads[]` 时走旧单仓路径；快照/回归测试 |
| Salad 16GB 内存档 + `cpuOffload` 被 OOM kill | 轻量档仍失败 | 轻量档保留 `cpuOffload` 判断并按 `24GB` 内存档申请；真机验证系统内存峰值 |
| 旧 Worker 不认识 variant | Host 下发后远端报错或误跑 | `/health.capabilities` 能力协商；Host 预检拒绝 |

**待决事项（已对齐 / 待实测拍板）**：

1. **已收敛**：RunPod Community 暂缓（`$10` 起充 + 无价格优势），高带宽满血云算力候选聚焦 `Vast.ai`（`$5` 起充）；
2. **已收敛**：第 1 步先跑 `P-01 / P-02` 最小探针，不在未过门禁前大改 `variants[]`；
3. Qwen 轻量档已确认 **多参考第二张图不生效**；是否发布「t2i / 单参考编辑 / RGBA」三能力版，而不是宣传完整多图编辑，需产品拍板；
4. `Z-Image` FP8 TE 在 torch 2.6 上不可运行；本轮保留 BF16 TE（`11.23 GiB`）。是否升级 torch 换 `~8.6 GiB` 档，需另立兼容性专项，不在本轮强行升级。

---

## 11. 执行顺序建议（先探针、后架构）

```text
第 1 周前半（最小实测探针，零契约与 UI 改动）
  ├─ P-01 Z-Image GGUF 最小加载 + Qwen3-4B TE 缩容试探 + 同 Seed 画质对比（4090）
  └─ P-02 G1 sd.cpp 单卡门禁（qwen 编辑/排版/RGBA + flux2-9b 多参考）

第 1 周后半 ~ 第 2 周（基于探针结论落地）
  ├─ Q-01..Q-05 资产 variants[] 契约 + resolveVariant('auto') + 产物角标 + 不回退护栏
  ├─ Z-01..Z-04 gguf 依赖 + ZImageLoader + 多仓下载/缓存 + z-image 轻量资产
  └─ Z-05/Z-06 Salad RTX 3090 / 4090 真机冷启、画质与成本验收

第 3 周起
  ├─ 若 P-02 通过 → G1-02/03 云端 sd-cpp 运行时（独立镜像/体积闸门 + 复用 local-gpu 口径）+ Qwen/Flux variant
  ├─ 若 P-02 不通过 → 不上云端 sd-cpp，Qwen/Flux 仅保满血（Vast / Colab / 私有 Worker / cloud-api）
  └─ V-01..V-06 Vast.ai Provider（按需启动，配 SSH 隧道与销毁防残留）
```

**发布门槛**：至少完成 `z-image` 轻量档在 Salad 真机跑通（≤ `15 min` 冷启），且“显式选择、产物标识、失败不回退”三条通过，才把重模型轻量档转为默认可选。

**2026-11-26 探针后的优先级调整**：

1. `z-image` 保留 Diffusers GGUF + BF16 TE；FP8 TE 暂缓，等待 torch 升级后再验。
2. `flux2-9b` 的 sd.cpp 路线优先补 `sd-server` 服务化；多参考已实测可用。
3. `qwen` 的 sd.cpp 只先开放 t2i / 单参考编辑 / RGBA；`supportsReference` 先关闭。
4. Vast 选机增加下载费上限；否则“高带宽”会变成流量费陷阱。

**2026-11-26 第 1 批落地状态**：

- [x] **Q-01..Q-05**：`variants[]` / `precisionOptions` 资产契约、Host `resolveVariant()`、
  `auto` 路由、产物精度字段与画廊角标、Worker 能力协商与“不静默回退”护栏已落地；
  `node test/check-variants.mjs`、`test/jobs-wait.mjs`、`npm run test:worker` 覆盖。
- [x] **ZImage Diffusers GGUF**：`gguf==0.19.0` 依赖、多仓 `downloads[]`、GGUF DiT 加载、
  BF16 TE/VAE 组装与 `z-image-turbo` 轻量档已落地；Vast 4090 探针已验证加载/出图/画质。
- [x] **Salad 真机冷启验收**：新镜像 `manual-58e6674` 在 4090 达标（`5.48min`），
  3090 默认区域 `16.4min`（略超），3090 Ti 慢节点 `29.8min`；首图/热图、峰值显存与
  同 Seed 满血画质已记录，详见 §9.5。
- [x] **Qwen**：继续保满血；sd.cpp 版因多参考第二张图不生效、局部改字偏灰，不上线。
- [ ] **Flux2 9B sd.cpp**：G1 单卡已通过 t2i / 多参考，但上线前仍须补 `sd-server` HTTP
  模式、独立镜像体积闸门与 Salad 真机；未通过前不进入资产。

---

## 12. 与既有文档的关系

- 本文件是重型模型量化与算力演进的收口口径；2026-11-26 的成本修订暂缓 RunPod / Vast 专用 Provider。既有真机网络与费用数据保留，不再作为低频用户默认租卡推荐。
- 资产字段落地后，必须同步更新 [`MODEL_ASSET_SPEC.md`](MODEL_ASSET_SPEC.md) §2 的 `pipeline` / `variants` 说明与校验规则。
- Vast.ai 落地后，必须同步更新 [`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md) 中“Pod + 本地盘”与“无持久卷 + hf_xet”两种模式边界。
- 若新增 `M3.7`（轻量模型资产）/ `M3.8`（Vast.ai）里程碑，应同步更新 [`ROADMAP.md`](ROADMAP.md)。
