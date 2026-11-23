# M4 专项规划：AI 视频部署、游戏素材 / UI 基础设施与渐进式演进

> **状态**：M4.0 底座算子、M4.1 硅基流动视频主链路、M4.2 前半（视频舞台 / 抽帧接力 / 双模式工作台）与 M4.2 后半（独立「工坊」页 + 复合资产包 + SOTA 本机算子）已完成（2026-11-23）；M4.3 量化视频与 M4.4 3D 闭环待实施。M4.2 的 GPU 后处理（抹除背景 / PBR）离线链路已通，**真机 GPU 验收点**见下文 M4.2b 行的「真机待验」。  
> **上位文档**：[`ROADMAP.md`](ROADMAP.md)、[`AIGC_STUDIO_STANDALONE_PLAN.md`](AIGC_STUDIO_STANDALONE_PLAN.md)  
> **前置基线**：[`CLOUD_API_AND_AGENT_EXPLORE_PLAN.md`](CLOUD_API_AND_AGENT_EXPLORE_PLAN.md)（M3.5 双轨算力）、[`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md)（24GB Ampere/Ada + `cu124` + `runtime` 无 `nvcc` 镜像）

---

## 1. 产品原则与已确认边界

1. **面向通用个人创作者**：视频、游戏/UI、3D 三条线均坚持 `aigc-studio` 一贯的「开箱即用、低认知负担、渐进式披露」调性，不把复杂节点图 JSON 暴露给终端用户。
2. **商业 API 以硅基流动（SiliconFlow）为主力**：协议设计兼容通用 OpenAI/fal 规范，但优先围绕硅基流动打通并实测（单一账号充值覆盖日常文生图与视频 API）；自建私有 Worker 与免费后端负责批量抽卡、量化视频、游戏后处理与隐私出图。
3. **游戏素材 / UI 走「轻量确定性路线（路线 A）」**：不引入重型且易碎的 ComfyUI `custom_nodes` 容器栈，而是将高频刚需沉淀为 **纯 CPU 确定性算子 + 轻量商用友好 GPU 模型 + 优雅的 Stage 动作坞交互**。
4. **先攻视频与游戏/UI 基础设施，3D 延后至 M4.4，并坚持「自部署为主（云端完整 PBR + 本机轻量几何）、商业 API 为辅」**：3D 完整 PBR 开源主力（TRELLIS.2 / Hunyuan3D 2.1）的贴图重投影/光栅化阶段强依赖重型 C++/CUDA 算子编译（`nvdiffrast`、`o-voxel`、`custom_rasterizer`），与当前 3.16 GB 无 `nvcc` 镜像冲突；因此延后至 M4.4 按**「独立 `aigc-worker-3d:devel` 云端自建全栈 PBR + 本机 6~8 GB 轻量几何白模（区分 CUDA/非 CUDA 边界）+ `cloud-api` 零等待补充」**三轨推进（详见 §4）。
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

## 3. 专题二：游戏素材 / UI 基础设施（路线 A：独立工坊 + 本机 SOTA 轻算子）

### 3.1 设计哲学与已拍板边界（2026-11-23）

1. **顶栏三段式分流（不把垂直工具塞爆 Stage）**：
   - 顶栏导航由 `[创作 | 作品库]` 扩展为 **`[创作 | 工坊 | 作品库]`**；
   - 主创作台 Stage 动作坞只保留所有创作者高频刚需的 **`抹除背景`** 与一个 **`进工坊 ↗`** 快捷入口（点一下直接带当前作品跳进「工坊」页）；
   - 工坊页支持快选最近作品与本地拖入，左侧选工具与实时调参、中间看实时交互画布（网格切割线 / 动画播放 / 2×2 平铺 / 棋盘格透明底 / PBR 通道切换），避免主舞台被专业参数污染。
   - **后续交互与感知演进（M4.2c）**：Phase 1a（L1 感知与溯源）与 Phase 1b（单行分栏顶栏 + 静默感知 + 控件优先）已完成；**Phase 1c（取消底栏改为应用即落盘 + 版本树 `workshop` 独立语义）待执行**，详见 [`WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md`](WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md) §6.5；L2 端侧 ONNX 与 L3 云端语义待推进。
2. **「抹除背景」默认选型与协议提示**：
   - 默认 **`RMBG-2.0`**（标签：**`质量优先`**，轻量协议角标：`非商用`）；
   - 可选切换 **`BiRefNet`**（标签：**`极速`**，轻量协议角标：`MIT`）；
   - 仅作标签提示，不弹窗阻断；走 GPU Worker 执行（避免百兆级模型打进桌面包或触发浏览器 WebGPU 大图 OOM）。
3. **轻量确定性算子跑在用户本机（纯 JS / WASM，`cloud-api` 亦可用）**：
   - 不强绑远端 Python Worker，采用现代开源 **SOTA JS / WASM** 方案，在渲染进程 Web Worker + `<canvas>` / Node Host 本地执行：
     - **SVG 矢量化**：优先 **`@visioncortex/vtracer`**（官方 Node/WASM）或 **`wasm-vtracer` / `vectortracer`**（浏览器 Web Worker），与 Worker 侧 `vtracer` 同源 Rust 曲线拟合，零 Python 依赖；
     - **像素对齐与量化（Pixel-Unslop）**：采用边缘周期/能量自动探测（参考 **`spritefusion-pixel-snapper`** / **`fast-pixelizer`**）识别 AI 像素画真实格距（同时支持手动指定 16/32/64 格）+ **Oklab** 感知色空间 K-Means++ 量化（替代 sRGB 避免暗部发灰）+ Alpha 硬边二值化；
     - **2×2 无缝平铺检查**：纯前端 `<canvas>` 0ms 实时拼图 + 接缝 MAE 评估（预览不写历史记录），需要修复时执行半格滚移 + 余弦渐变混边；
     - **序列帧切片与预览**：画布实时叠画网格线 + 逐帧动画播放预览，确认后落盘 `spritesheet.png + frames[] + atlas.json`。
4. **预览不写盘，应用即落盘进版本树**：调参实时预览仅在内存 `<canvas>` 运行，永不写盘；点击「应用 / 生成 / 运行」即统一直接落盘写入 `outputs/` 并继承 `sourceImage` / `rootImage` 进版本树（独立 `workshop` 版本语义），不再要求用户二次点击保存按钮。

| 能力模块 | 底层技术 / SOTA 选型 | 运行位置 | 产物形态与 UI 交互 |
| :--- | :--- | :--- | :--- |
| **1. 抹除背景** | **`RMBG-2.0`**（默认，`质量优先`·`非商用`）与 **`BiRefNet`**（可选，`极速`·`MIT`） | GPU Worker | 输出 RGBA PNG；Stage 默认棋盘格透明底预览，支持切深/浅底色检查白边 |
| **2. 无缝平铺与 PBR 材质包** | 前端 `<canvas>` 0ms 2×2 实时拼图 + 余弦混边；PBR 后处理 **`Ubisoft CHORD`**（`research-only`）与 **`Marigold`**（`diffusers` 原生） | 本机浏览器（预览/混边）+ GPU Worker（PBR） | PBR 输出复合资产包：`albedo` + `normal` + `roughness` + `metallic`；工坊/Stage 支持通道切换与接缝检查 |
| **3. UI 矢量导出（SVG）** | **`@visioncortex/vtracer`** / **`wasm-vtracer`**（官方 Rust→WASM） | **本机 Web Worker / Node**（0 GPU、0 Python） | 从扁平图标 / Logo / UI 控件一键生成 `.svg`（`spline`/`polygon`、`stacked`/`cutout` 滑块实时预览） |
| **4. 像素对齐与序列帧切片** | 边缘周期网格自动探测 + **Oklab** K-Means++ 量化；序列帧网格叠画 + 逐帧动画预览 | **本机 `<canvas>` + Web Worker**（0 GPU、0 Python） | 消除 AI 像素画歪斜网格与色偏，锁死 8/16/32 色；序列帧切分导出 `spritesheet.png` + `atlas.json` + `.zip` |

### 3.2 核心底层基建扩展

1. **复合资产包（Asset Bundle）契约**：
   - `outputs/<YYYYMMDD-HHmmss>-<jobId>/` 在主文件与 `meta.json` 之外，支持可选附属通道清单 `channels[]`（如 PBR 多贴图、SVG 矢量副本、`atlas.json` 图集描述与切帧集合）；画廊/胶片条仍只占 1 张卡片（带通道角标），舞台支持通道切换，并复用现有纯 JS `createZip` 一键导出 `.zip`；
   - `meta.json` 正式启用 `mediaType: 'image' | 'video' | 'mesh3d'`，旧数据缺省回落 `'image'`，与现有 `rootImage` 版本树完全兼容（图生图底图 → 抹除背景 / PBR 材质包 / 图生视频，全部挂在同一棵树下）。
2. **动态 LoRA 与项目级风格锁定（面向创作者预设）**：
   - 在现有 `flux2` `pipeline.lora` 基础之上，逐步将可选 LoRA（风格模型 + 权重系数）开放给创作面板的「风格预设」卡片，方便同一套游戏项目的图标、立绘、场景保持统一画风。
3. **MCP 工具同步延伸**：
   - 后续在 [`mcp/server.mjs`](../mcp/server.mjs) 暴露抹除背景、PBR 拆解、SVG 导出、像素对齐与视频生成工具，兼顾一般创作者（UI 点选）与独立开发者（AI IDE 联动）。

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

## 4. 专题三：3D 资产「云端自建 + 本机轻量化 + API 补充」部署架构（M4.4）

3D 资产生成在物理计算上分为**「第一段：图生几何白模（Shape / Mesh）」**与**「第二段：多视角贴图与 PBR 烘焙（Texture / Paint）」**两个完全不同的阶段：前者主要是标准 DiT / Rectified Flow + 等值面提取，显存与编译门槛远低于后者；真正导致显存飙升至 21~29 GB 并强绑 `nvdiffrast`、`custom_rasterizer`、`o-voxel` 等现场 CUDA C++ 编译的，是第二段的完整 PBR 贴图重投影。因此 M4.4 不走「全靠商业 API」的单一路线，而是按算力层分为三轨：

### 4.1 三轨部署矩阵与硬件边界

| 部署轨道 | 目标硬件与运行环境 | 选型模型与产物能力 | 显存 / 资源基线与约束 |
| :--- | :--- | :--- | :--- |
| **轨道 A：云端自建 GPU Worker（主力）** | RunPod / Vast.ai 等 **24 GB+ NVIDIA GPU**（4090 / A5000）+ 独立 **`aigc-worker-3d:devel`** Docker 镜像 | **`Hunyuan3D-2.1`**（Turbo / Offload）、**`TRELLIS.2`**；产出带完整 PBR 贴图的 `.glb` | 镜像内预装 `nvcc` 与预编译 `nvdiffrast` / `custom_rasterizer` / `o-voxel`（与 3.16 GB 轻量 2D/视频镜像隔离）；挂载持久卷缓存多 GB 权重；Hunyuan3D-2.1 全量约 29 GB，24 GB 卡需开 Turbo / 分阶段 Offload（Shape ~10 GB → Texture ~21 GB 分步释放） |
| **轨道 B：本机轻量化自部署（分硬件分级）** | **① 本机 8~12 GB+ NVIDIA 独显**（`local-gpu` CUDA）<br>**② 无 CUDA 核显本机**（如 AMD 880M，见 [`LOCAL_GPU_VULKAN_PLAN.md`](LOCAL_GPU_VULKAN_PLAN.md)） | **N 卡本机**：优先 **`TripoSG`**（1.5B，MIT）或 **`Hunyuan3D-2 mini`**（0.6B）生成高保真几何白模 `.glb`；12 GB+ 可低显存模式试跑 `TRELLIS.2`<br>**非 N 卡核显**：Vulkan `stable-diffusion.cpp` **不支持 3D Mesh 生成**；仅 Windows ROCm Python 环境下具备探索纯 PyTorch 几何白模（Shape-only）的可能性 | 本机主打**「6~8 GB 级几何白模快速原型」**（不强求在 8~12 GB 本机硬扛 29 GB PBR 全链路）；无 CUDA 核显本机明确不强推需要 `nvdiffrast` 编译的完整 PBR 贴图管线 |
| **轨道 C：商业生图/3D API（补充）** | 任意轻薄本 / 无独显环境（`cloud-api`） | Tripo / Meshy / Hunyuan3D / TRELLIS.2 云端托管 API | 零等待、无需维护 `devel` 镜像，服务于无 GPU 或急用成品 PBR 场景 |

### 4.2 协议、产物回传与前端统一预览

1. **统一产物链路**：无论来自云端自建 `aigc-worker-3d:devel`、本机轻量 Worker 还是 `cloud-api`，统一产出标准 **`.glb`**（可选附带 `channels[]` 贴图拆解包）；私有/本机 Worker 复用协议 v2 的 `/artifact` 二进制下载与 HTTP Range 206，不走大体积 JSON base64。
2. **统一前端预览与版本树**：新增 **`Mesh3DViewer.jsx`**（Three.js 轻量 `.glb` 交互预览 + 线框 / 法线 / PBR 通道切换），产物写入工作区并进版本树追溯（支持「2D 概念图 / 去背参考图 → 3D `.glb`」因果关联）。

---

## 5. 分阶段实施路线（优雅渐进式迭代）

| 子阶段 | 核心交付 | 依赖前提 | 验收标准 |
| :--- | :--- | :--- | :--- |
| **M4.0：底座算子与契约预备**（已完成，2026-11-23） | 1. [`worker/inference/quant_accel.py`](../worker/inference/quant_accel.py)：量化与视频加速策略/探测骨架；<br>2. [`worker/inference/game_ops.py`](../worker/inference/game_ops.py)：CPU 像素对齐/图集切片/无缝检测/VTracer + GPU `CircularPaddingPatch`/RMBG-2.0/BiRefNet/Marigold 接口；<br>3. [`test/worker/test_m4_infra.py`](../test/worker/test_m4_infra.py) 离线单测 | 无（不破坏现有 M1–M3 契约与镜像） | `python test/worker/run.py` 578 项通过、`npm run test:contract` 15/15 |
| **M4.1：硅基流动 `cloud-api` 接通（已完成，2026-11-23）** | `PROVIDERS['cloud-api']`（硅基流动优先 + OpenAI/fal 兼容适配），统一支持生图与 `/v1/video/submit` 异步视频任务、Key 加密存储、下载落盘 `outputs/`；视频目录见 [`shared/image-providers.js`](../shared/image-providers.js)，适配层见 [`server/video-api.js`](../server/video-api.js) | 用户提供硅基流动 API Key 做真机联调 | 填 Key 0 秒就绪；硅基流动文生图 + 文/图生视频 `.mp4` 正常落盘本地；`test/cloud-video.mjs` 6 项离线回归通过；真机（2026-11-23，MiniMax-H3 / 480p / 5s）：文生视频 389s → 864×480、首帧图生视频 76s → 640×640（画幅随参考图） |
| **M4.2 前半：多模态工作台与视频抽帧**（已完成，2026-11-23） | 1. 顶栏 `[生图 \| 视频]` 模式分流 + 模型卡保留厂商主 Tab 与次级模态筛选（双向联动）；<br>2. 视频专属左栏（`21:9` 画幅 / 首帧跟随锁定 / 直出视频规格 / 首尾帧角标与对调）+ 暗色导演取景框（`.ofs-frame--video`）；<br>3. 视频原生 `<video>` 播放 + Range 206 + 首尾帧 `<canvas>` 抽帧落成普通作品 | M4.0 + M4.1 | `npm run test:client` 22/22（含 `check-client-video.mjs` 4/4）；视频可播放、抽帧接力 I2V 与参数精度全部通过 |
| **M4.2a：独立「工坊」页 + 复合资产包 + 抹除背景 / 平铺 / SVG**（已完成，2026-11-23） | 1. [`shared/contract.js`](../shared/contract.js) 的 `WORKSHOP` 契约（六工具 / 通道白名单 / 体积与算子边界）+ Host 四条路由（保存 / 导出 / 矢量 / GPU 算子提交），ZIP 复用纯 JS `createZip`；<br>2. 顶栏 `[创作 \| 工坊 \| 作品库]` + 独立工坊页（[`web/studio/workshop/`](../web/studio/workshop/)）+ Stage 动作坞 **`抹除背景`**（`RMBG-2.0` 质量优先·非商用 / `BiRefNet` 极速·MIT）与 **`进工坊 ↗`**；<br>3. 棋盘格透明底预览 + 本机 `<canvas>` `2×2` 无缝平铺/混边 + Host 侧 **`@visioncortex/vtracer`**（Node WASM）SVG 导出 | M4.2 前半 | ✅ 无 GPU Worker 下本地 `2×2` 检查与 SVG 导出可用；工坊产物带 `channels[]` 进版本树，ZIP 导出 200 + PK 头；`host-workshop.mjs` 14 项、`check-client-workshop.mjs` 8 项、真实浏览器端到端 15/15 |
| **M4.2b：像素对齐、序列帧切片与 PBR 拆解**（已完成，2026-11-23） | 1. SOTA 像素对齐（[`web/logic/workshop.js`](../web/logic/workshop.js)：边缘周期网格探测 + **Oklab** 中位切分/K-Means + Alpha 硬边）；<br>2. 序列帧切片（网格叠加 + 逐帧动画 + `atlas.json` / `spritesheet`）；<br>3. `Marigold` / `Ubisoft CHORD` PBR 拆解与四通道切换条，GPU 侧走 `remove-bg` / `pbr` 串行任务（[`worker/daemon.py`](../worker/daemon.py)） | M4.2a | ✅ 离线全通过（`host-workshop-gpu.mjs` 9 项、`test_workshop.py` 36 项、worker 615 项）。**真机 GPU 已验**（2026-11-23 Kaggle Tesla T4，768×768，`result_mode=binary` + `/artifact` SHA-256 校验）：`BiRefNet` 12.1s（峰值 8889 MiB，前景实心更干净且免登录开箱即用）；带授权 `HF_TOKEN` 实测 `RMBG-2.0` 11.4s（峰值 10193 MiB，外缘收紧更干脆；无授权返回 `model_gated`）；`Marigold` PBR 四通道 35.2s（峰值 10837 MiB，`albedo/normal` 语义准确）；释放显存后复测文生图 3.52s 不 OOM |
| **M4.2c：工坊智能感知与极简引导（Phase 1a/1b 完成；Phase 1c 待执行）** | 1. **Phase 1a/1b（已完成）**：L1 感知层（`rootPrompt`/`rootPresetId` 溯源 + 256px 像素特征）与单行分栏顶栏 + 静默感知 + 控件优先参数卡；<br>2. **Phase 1c（待执行，见 [`WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md`](WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md) §6.5）**：移除 `.ofs-workshop-foot` 底栏（去掉「保存到作品库」与「导出 ZIP」）、统一「应用即落盘」+ 画布区接力，并在 `lineage.js` / `VersionPanel` 补齐独立 `workshop` 版本语义；<br>3. Phase 2（端侧 ONNX）待推进 | M4.2b | Phase 1a/1b：`test:client` 25/25、`test:contract` 3/3、`test:host` 37/37、`build` 全绿；Phase 1c 完成后需补充 `lineage.mjs` 与渲染测试并重截 `tools/preview` |
| **M4.3：自建视频 Worker 量化加速落地** | `worker` 接入 `LTX-2 Loader` / `WanVideoLoader`（基于 `quant_accel.py` 的 FP8/GGUF + TeaCache + SageAttention 探测）+ MP4 导出 + 可选独立视频镜像 Tag | 24GB Pod（4090 / A5000）真机压测 | 24GB 单卡跑通至少 1 款蒸馏/量化视频模型并记录耗时/峰值显存/单条成本 |
| **M4.4：3D 资产闭环（云端自建 + 本机轻量 + API 补充）** | 1. **云端自建主力**：拆分独立 `aigc-worker-3d:devel` 镜像（含 `nvcc`/预编译光栅化算子），跑通 `Hunyuan3D-2.1` / `TRELLIS.2` 完整 PBR `.glb`；<br>2. **本机轻量边界**：在 8 GB+ N 卡本机验证 `TripoSG` / `Hunyuan3D-2 mini` 几何白模生成（标明非 CUDA 核显边界）；<br>3. **`cloud-api` 补充 + 统一预览**：接入 Tripo / Hunyuan3D / TRELLIS.2 API，落地 `Mesh3DViewer.jsx`（Three.js `.glb` 预览与 PBR 通道查看） | M4.1–M4.2 稳定 | 「参考图 → `.glb` 3D 模型（至少打通 1 条自部署 + 1 条 API 链路）→ Three.js 预览 → 版本树追溯」闭环跑通 |
