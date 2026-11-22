# M4 专项规划：AI 视频部署、游戏素材 / UI 基础设施与渐进式演进

> **状态**：规划定稿 & 基础设施启动（2026-11-23）  
> **上位文档**：[`ROADMAP.md`](ROADMAP.md)、[`AIGC_STUDIO_STANDALONE_PLAN.md`](AIGC_STUDIO_STANDALONE_PLAN.md)  
> **前置基线**：[`CLOUD_API_AND_AGENT_EXPLORE_PLAN.md`](CLOUD_API_AND_AGENT_EXPLORE_PLAN.md)（M3.5 双轨算力）、[`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md)（24GB Ampere/Ada + `cu124` + `runtime` 无 `nvcc` 镜像）

---

## 1. 产品原则与已确认边界

1. **面向通用个人创作者**：视频、游戏/UI、3D 三条线均坚持 `aigc-studio` 一贯的「开箱即用、低认知负担、渐进式披露」调性，不把复杂节点图 JSON 暴露给终端用户。
2. **商业 API 以硅基流动（SiliconFlow）为主力**：协议设计兼容通用 OpenAI/fal 规范，但优先围绕硅基流动打通并实测（单一账号充值覆盖日常文生图与视频 API）；自建私有 Worker 与免费后端负责批量抽卡、量化视频、游戏后处理与隐私出图。
3. **游戏素材 / UI 走「轻量确定性路线（路线 A）」**：不引入重型且易碎的 ComfyUI `custom_nodes` 容器栈，而是将高频刚需沉淀为 **纯 CPU 确定性算子 + 轻量商用友好 GPU 模型 + 优雅的 Stage 动作坞交互**。
4. **先攻视频与游戏/UI 基础设施，3D 延后至 M4.4**：3D 开源主力（TRELLIS.2 / Hunyuan3D）强依赖重型 C++/CUDA 算子编译（`nvdiffrast`、`o-voxel`、`custom_rasterizer`），与当前 3.16 GB 无 `nvcc` 镜像冲突，留待视频与游戏/UI 基础设施稳固后按「API 优先 + 独立 `aigc-worker-3d:devel` 拆分镜像」推进。
5. **效果优先 + 协议显式标识（不因非商用限制舍弃更优模型）**：
   - 本软件主要服务个人创作者，**不因非商用 / 研究许可限制而剔除质量更优的模型**；
   - 沿用并扩展 [`MODEL_ASSET_SPEC.md`](MODEL_ASSET_SPEC.md) 的 `license` / `licenseKind`（如 `open` / `non-commercial` / `research`）机制，在界面模型卡片与工具提示中清晰标注授权属性（如「仅限个人/非商用」「研究许可」），由创作者自行知情选用：
     - **透明抠图**：优先接入 **`RMBG-2.0`（`briaai/RMBG-2.0`，标明 `non-commercial`）**，并与 **`BiRefNet`（MIT）** 共用 `AutoModelForImageSegmentation` 推理路径；
     - **PBR 材质拆解**：优先评估 **`Ubisoft CHORD`（`ubisoft/ubisoft-laforge-chord`，3A 级 SVBRDF 拆解，标明 `research-only`）**，同时保留 `diffusers` 原生 **`MarigoldIntrinsicsPipeline` / `MarigoldNormalsPipeline`** 作为零新增依赖基线；
     - **视频与 3D**：同样以真实画质与显存实测为准（如 **`HunyuanVideo` / `Hunyuan3D` / `LTX-2` / `Wan 2.2`**），按实际协议如实展示标签，不做人为封堵。

### 1.1 通用生图模型扩容候选（面向全场景通用创作）

除视频与游戏专项外，通用文生图目录同步纳入两款强模型作为主力候选，服务海报、商业摄影、插画、多语排版及 UI 等全场景创作：

| 通用模型 | 定位与核心优势 | 建议接入轨道 | 部署 / 硬件要点 |
| :--- | :--- | :--- | :--- |
| **`MOSS-Image`（`OpenMOSS-Team/MOSS-Image-SFT`）** | 5B DiT + Qwen3.5-9B（Apache 2.0）；96.3% 多语密集排版、4K token 长提示词、支持 JSON `bbox` 精确构图（可由 Agent 自动生成）；有 2–4 步蒸馏加速 LoRA | **自建私有 Worker**（新增 `MossImageLoader`）或兼容云 API | 原版 BF16 约 27–30 GB；24GB 卡需用量化版 `Qwen3.5-9B`（INT8/W4A8 5.4–9.2 GB）+ 4 步 LoRA，活跃显存约 16–18 GB |
| **`MiniMax-H3-Image`** | 20B–33B DiT + 32B 文本端；原生 4K（4–20 MP）、6 步蒸馏无需 CFG、最多 16 张参考图联合编辑（详见 [`MINIMAX_H3_IMAGE_SPEC.md`](MINIMAX_H3_IMAGE_SPEC.md)） | **优先硅基流动 `cloud-api`** | 自建 BF16 峰值约 65 GB，最小 GGUF 组合仍达 24.74 GB；极重，走商业 API 性价比最高 |

> **极速 / 质量挡位 UX 设计（供专员接入 `MOSS-Image` 及后续多挡模型）**：
> - `MOSS-Image-Base` 面向科研微调，**不放进普通创作者下拉框**；工作台只保留一张 **`MOSS-Image`** 卡片。
> - 现有的 `stepRange`（[`ParamsSection.jsx`](../web/studio/rail/ParamsSection.jsx) 的 `较快 / 均衡 / 精绘`）仅修改 `steps`，**不能直接用于需要同步切换蒸馏 LoRA 与 CFG 的模型**（例如 `MOSS-Image` 质量挡为 `SFT 50步 + cfg=3.0 + 无LoRA`，极速挡为 `4步 + cfg=1.0 + 4步蒸馏LoRA`）。
> - 建议在 `models/*.json` 扩展可选的 **`speedProfiles`**（如 `fast` 极速挡 / `quality` 质量挡），每个挡位声明 `{ steps, cfg, lora?, scheduler? }`，由创作面板渲染为一键「⚡ 极速 / ✨ 质量」挡位切换，自动联动步数、CFG 与远端 LoRA 热插拔。

---

## 2. 专题一：AI 视频生成双轨部署与量化加速方案

### 2.1 双轨算力策略

| 轨道 | 接入方式 | 首期目标模型 | 成本 / 延迟参考 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| **轨道 A：硅基流动 `cloud-api`** | 异步提交 `POST /v1/video/submit` → 状态轮询 → 本地落盘 `.mp4`（结果链接约 10 分钟过期，须即时下载） | **`MiniMaxAI/MiniMax-H3`**（支持文生视频 + 首帧/尾帧/首尾帧 I2V）及平台现役 Wan 系列 | ~\$0.21–\$0.29/条（5s，约 ¥1.5–¥2.1）；**0 秒冷启动** | 日常文/图生视频、首尾帧衔接、无需租卡快速验证产品闭环 |
| **轨道 B：自建 24GB 私有 Worker** | `worker_server` 协议 v2（`binary` + `/artifact` HTTP Range 206 + SSE） | **`LTX-2 / LTX-2.5` Distilled（FP8）**、**`Wan 2.2 TI2V-5B`（FP8 / GGUF）**、**`Wan 2.1 T2V-1.3B`** | 4090（24GB）：LTX-2 8 步 FP8 约 **7–11s**；Wan2.2 5B 优化后约 **2–4 分钟**；Wan2.1 1.3B 约 **1.5–2.5 分钟** | 隐私/无审查素材、连续批量 I2V 抽卡、与本地长视频接力工作流 |

> 注：硅基流动平台模型列表会随版本迭代下线旧权重（如部分 Wan2.2 早期托管端点已向 MiniMax-H3 过渡），因此 `cloud-api` 视频目录必须支持读取/配置模型 ID 与能力位，不得写死单一静态端点。

### 2.2 自建视频 Worker 的量化与加速矩阵（适配无 `nvcc` 镜像）

结合 [`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md) 的 `Python 3.11 + torch 2.6.0+cu124 + pytorch-runtime` 基线，采用**分层、可降级、零强编译耦合**的加速方案：

1. **权重量化（降显存防 OOM，让 14B/19B 进 24GB 卡）**：
   - **`torchao` 权重量化（`Float8WeightOnlyConfig` / `Int8WeightOnlyConfig`）**：通过 `diffusers.PipelineQuantizationConfig` + `TorchAoConfig` 对 DiT `transformer` 主干启用 FP8/INT8 权重压缩（显存减半）；Ada（4090/L40S，`sm_89`）兼享算力收益，Ampere（3090/A5000，`sm_80`）作防 OOM 手段，Turing（T4，`sm_75`）自动禁止 FP8。
   - **GGUF 单文件量化（`diffusers.GGUFQuantizationConfig` + 纯 Python `gguf`）**：支持 `Q4_K_M` / `Q5_K_M` / `Q8_0` 社区量化权重，免 CUDA 编译，配合 `compute_dtype=bfloat16` 在 16–24GB 卡稳态加载大模型。
2. **步间缓存加速（零重训练提速 1.5×–2×）**：
   - **TeaCache / First-Block Cache**：针对 20–50 步多步视频 DiT（如 Wan 系列常规档）在相邻时间步跳过冗余 Transformer Block；
   - **安全门控**：对于 4–8 步蒸馏模型（如 `LTX-2 Distilled` 8 步），自动禁用步间缓存，避免糊帧/崩坏（延续 [`INFERENCE_ACCELERATION_RESEARCH.md`](INFERENCE_ACCELERATION_RESEARCH.md) 实测纪律）。
3. **注意力内核（运行时探测 + 自动回退）**：
   - **SageAttention**（预编译 `cp311 + cu124 + torch2.6` wheel，仅 `sm_80+` 启用）→ 未安装或硬件不满足时静默回退 **PyTorch SDPA / FlashAttention-2**，绝不因缺算子导致 Worker 起不来。
4. **显存分层卸载（配合 32GB+ 系统内存）**：
   - **`t5CpuOffload`**：将动辄 10GB+ 的 T5/UMT5 文本编码器留在 CPU 算完即释放，避免挤压 DiT 空间；
   - **`enable_model_cpu_offload()` + `enable_vae_tiling()` + `enable_vae_slicing()`**：兜底防止高帧率视频末步 VAE 3D 解码峰值 OOM。

---

## 3. 专题二：游戏素材 / UI 基础设施（路线 A：轻量确定性）

### 3.1 设计哲学：隐形专业管线 + Stage 一键加工

沿用现有「Stage 动作坞（涂抹重绘 / 扩图 / 高清放大 / 设为参考图）」的直觉交互，不让普通创作者面对节点连线，而是提供 **4 个开箱即用的游戏/UI 基础设施能力**：

| 能力模块 | 底层技术 / 模型 | 运行位置 | 显存 / 耗时 | 产物形态与 UI 交互 |
| :--- | :--- | :--- | :--- | :--- |
| **1. 一键透明抠图** | **`RMBG-2.0`**（`briaai/RMBG-2.0`，标注 `non-commercial`）与 **`BiRefNet`**（MIT），共用 `transformers` | GPU Worker（支持 CPU 降级） | ~4–8 GB / < 1s | 输出真透明 RGBA PNG；Stage 支持棋盘格透明底预览，面板标明协议 |
| **2. 无缝平铺与 PBR 材质包** | 生成期 `Conv2d(padding_mode='circular')` 上下文补丁 + 后处理 **`Ubisoft CHORD`**（优先质量，标注 `research-only`）与 **`Marigold`**（`diffusers` 原生兜底） | GPU Worker + CPU 接缝检测 | ~8–16 GB | 输出复合资产包：`albedo` + `normal` + `roughness` + `metallic`；Stage 提供 **2×2 平铺预览**检查接缝 |
| **3. UI 矢量导出（SVG）** | **`VTracer`**（Rust 编译 Python wheel，MIT/Apache） | **纯 CPU**（本机或 Worker 皆可） | 0 VRAM / < 100ms | 从扁平图标 / Logo / UI 控件 PNG 一键生成可无限缩放的 `.svg`，提供颜色分层/平滑度简明滑块 |
| **4. 像素风对齐与序列帧切片** | 自研确定性算法（`Pillow` + `NumPy`）：最近邻网格降采样 + 调色盘量化 + Alpha 边界切片 | **纯 CPU** | 0 VRAM / < 50ms | 消除 AI 像素画伪影并锁死 8/16/32 色；序列帧一键切分输出 `spritesheet.png` + `atlas.json`（Godot/Phaser/Unity 通用） |

### 3.2 核心底层基建扩展

1. **复合资产包（Asset Bundle）契约**：
   - `outputs/<YYYYMMDD-HHmmss>-<jobId>/` 在主文件与 `meta.json` 之外，支持可选附属通道清单 `channels`（如 PBR 多贴图、SVG 矢量副本、`atlas.json` 图集描述）与导出 ZIP；
   - `meta.json` 正式启用 `mediaType: 'image' | 'video' | 'mesh3d'`，旧数据缺省回落 `'image'`，与现有 `rootImage` 版本树完全兼容（图生图底图 → 透明抠图 / PBR 材质包 / 图生视频，全部挂在同一棵树下）。
2. **动态 LoRA 与项目级风格锁定（面向创作者预设）**：
   - 在现有 `flux2` `pipeline.lora` 基础之上，逐步将可选 LoRA（风格模型 + 权重系数）开放给创作面板的「风格预设」卡片，方便同一套游戏项目的图标、立绘、场景保持统一画风。
3. **MCP 工具同步延伸**：
   - 后续在 [`mcp/server.mjs`](../mcp/server.mjs) 暴露透明抠图、PBR 拆解、SVG 导出、像素对齐与视频生成工具，兼顾一般创作者（UI 点选）与独立开发者（AI IDE 联动）。

---

### 3.3 游戏素材 / UI 专用生成模型与 LoRA 清单（供专员选型接入）

> **核心发现**：市面上极少有“从零训一个全新大模型只画道具或 Tilemap”的独立架构，主流开源方案绝大多数是 **「强通用底座（FLUX / SDXL / Qwen-Image）+ 领域专用 LoRA / Adapter + 后处理算子」**，少部分垂直场景（如像素序列帧、多视角三视图）有专用微调 Checkpoint 或商业 API。与 `aigc-studio` 现有 `Flux2Loader` / `SdxlLoraLoader` / `QwenImage21Loader` 契合度极高。

| 目标资产类型 | 开源专用模型 / LoRA / Adapter | 底座 / 接入路径 | 核心能力与适用场景 | 配合的 M4 基础设施 |
| :--- | :--- | :--- | :--- | :--- |
| **1. 游戏道具 / 装备 / 技能图标** | - `gokaygokay/Flux-2D-Game-Assets-LoRA`<br>- `strangerzonehf/Flux-Icon-Kit-LoRA`（触发词 `Icon Kit`） | FLUX LoRA（可通过 `pipeline.lora` 挂载，支持扩展至 `flux2`） | 纯白/干净背景下的 2D 武器、药水、装备、矢量风 UI 图标直出 | `RMBG-2.0` / `BiRefNet` 一键透明抠图 + `VTracer` 转矢量 SVG |
| **2. Tilemap / 地图块 / 像素场景** | - `crafiq/flux-2-klein-9b-game-asset-tiles-lora`（直接匹配现役 `flux2-klein-9b`）<br>- `nerijs/pixel-art-xl`（SDXL LoRA，触发词 `pixel art`）<br>- `SomeTile Tile-set`（Civitai SDXL LoRA）<br>- `TTPlanet/TTPLanet_SDXL_Controlnet_Tile_Realistic` | `Flux2Loader` / `SdxlLoraLoader` + 可选 ControlNet Tile / `Arrexel/pattern-diffusion` | 俯视角 RPG 地表、等距视角（Isometric）建筑块、像素风场景与建筑素材 | `CircularPaddingPatch` 无缝循环生成 + `2×2` 平铺检验 + `pixel_snap_and_quantize` 消除伪像素 |
| **3. 游戏人物 / 三视图 / 序列帧动画** | - **`huanngzh/mv-adapter`**（SDXL 插件式多视角适配器，~13–14GB VRAM）<br>- `Onodofthenorth/SD_PixelArt_SpriteSheet_Generator`<br>- `irotem98/Codex-Pets-Sprite-Sheet-Generator`（单参考图 → 11 行动作序列）<br>- `carlosuperb/lpc-4view-pixel-art-diffusion`<br>- `Qwen/Qwen-Image-Edit` / `FLUX.1-Kontext`（角色一致换装） | `MV-Adapter`（`diffusers` 原生支持 T2MV / I2MV）/ SD Checkpoint / 现役多图参考 `supportsReference` | 角色正面/侧面/背面三视图、LPC 4 方向行走图、待机/奔跑/跳跃序列帧、角色一致换装 | `RMBG-2.0` 批量去背 + `slice_sprite_sheet` 自动切分帧与导出 `atlas.json` |
| **4. 游戏场景 / 横版卷轴 / 视差背景** | - 通用强底座（`flux2-klein-9b`、`qwen-image-2.1`、`anima-turbo-v1.1` 二次元）<br>- **`Qwen/Qwen-Image-Layered`**（语义图层拆解模型） | 现役底座 + Outpaint 扩图 LoRA + `Qwen-Image-Layered` 算子 | 2D 横版关卡背景无限扩图、场景拆分为前景/中景/远景独立 RGBA 图层（视差滚动/PSD 导出） | 已有 `outpaint` 扩图链路 + 图层复合资产包（`channels[]`） |
| **5. 游戏 UI / HUD / 卡牌与面板** | - **复用通用强模型**：`MOSS-Image`（JSON `bbox` 精确坐标排版 + 多语文字）、`Qwen-Image` / `Qwen-Image-2.1`<br>- **专用拆解/矢量**：**`OmniSVG`**（直出结构化 SVG）、**`Qwen-Image-Layered`**（UI 稿拆出背景/边框/按钮/文字图层） | 通用模型目录（`MossImageLoader` / `QwenImage21Loader`）+ 后处理节点 | 血条 HUD、菜单边框、技能面板、带清晰中英文文字的 RPG 卡牌与精确坐标排版 UI、可编辑分层 UI | `Agent` 自动生成 JSON `bbox` 布局 + `RMBG-2.0` + `VTracer` / `OmniSVG` + 九宫格/图层导出 |

> **垂直商业 API 参考（仅供拓展对比，按需可选）**：像素风垂直领域的 **Retro Diffusion**（`rd-plus` / `rd-tile` 智能自动拼接 Autotile，Replicate API）与 **PixelLab**（骨骼绑骨像素动画 + 多方向转身）在纯像素工程化上成熟度最高，但属于独立闭源服务，优先以开源底座 + `LoRA` + `game_ops.py` 确定性后处理覆盖个人创作者 80% 以上高频需求。

---

## 4. 分阶段实施路线（优雅渐进式迭代）

| 子阶段 | 核心交付 | 依赖前提 | 验收标准 |
| :--- | :--- | :--- | :--- |
| **M4.0：底座算子与契约预备**（骨架已就绪，待专员续推） | 1. [`worker/inference/quant_accel.py`](../worker/inference/quant_accel.py)：量化与视频加速策略/探测骨架；<br>2. [`worker/inference/game_ops.py`](../worker/inference/game_ops.py)：CPU 像素对齐/图集切片/无缝检测/VTracer + GPU `CircularPaddingPatch`/RMBG-2.0/BiRefNet/Marigold 接口；<br>3. [`test/worker/test_m4_infra.py`](../test/worker/test_m4_infra.py) 离线单测 | 无（不破坏现有 M1–M3 契约与镜像） | `python test/worker/run.py` 与 `npm run test:contract` 全绿 |
| **M4.1：硅基流动 `cloud-api` 接通（承接 M3.5）** | `PROVIDERS['cloud-api']`（硅基流动优先 + OpenAI/fal 兼容适配），统一支持生图与 `/v1/video/submit` 异步视频任务、Key 加密存储、下载落盘 `outputs/` | 用户提供硅基流动 API Key 做真机联调 | 填 Key 0 秒就绪；硅基流动文生图 + 文/图生视频 `.mp4` 正常落盘本地 |
| **M4.2：多模态舞台与版本树（`VideoStage` + 复合资产）** | 1. `VideoStage.jsx`（复用 `/api/file` Range 206 流式播放、首尾帧抽取）；<br>2. `saveJobOutput` / `HistoryItem` 支持 `mediaType: 'video'` 与 `channels[]` 复合资产；<br>3. Stage 动作坞新增「游戏工具」入口（去背 / 2×2 平铺检查 / 导出 SVG / 像素对齐 / PBR 拆解） | M4.0 + M4.1 | 视频可播放与抽帧接力 I2V；游戏工具端到端可用且版本树追溯完整 |
| **M4.3：自建视频 Worker 量化加速落地** | `worker` 接入 `LTX2Loader` / `WanVideoLoader`（基于 `quant_accel.py` 的 FP8/GGUF + TeaCache + SageAttention 探测）+ MP4 导出 + 可选独立视频镜像 Tag | 24GB Pod（4090 / A5000）真机压测 | 24GB 单卡跑通至少 1 款蒸馏/量化视频模型并记录耗时/峰值显存/单条成本 |
| **M4.4：3D 资产闭环（延后）** | 1. `cloud-api` 接入 TRELLIS.2 / Hunyuan3D / Tripo API；<br>2. `Mesh3DViewer.jsx`（Three.js `.glb` 预览与 PBR 通道查看）；<br>3. 按需拆分 `aigc-worker-3d:devel` 镜像 | M4.1–M4.2 稳定 | 「参考图 → `.glb` 3D 模型 → Three.js 预览 → 版本树追溯」闭环跑通 |
