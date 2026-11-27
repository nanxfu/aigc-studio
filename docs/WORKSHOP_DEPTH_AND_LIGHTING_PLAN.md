# 工坊深度几何底座与光影空间特效规划（M4.2e）

> **状态**：M4.2e-1 / e-2 / e-3 工程闭环与离线验收完成（2026-11-27）；DA3-Small 端侧 ONNX 已实测，GPU 高质量深度与 IC-Light 真机云卡性能复测留作发布前复核。  
> **上位文档**：[`ROADMAP.md`](ROADMAP.md)、[`M4_VIDEO_AND_GAME_ASSET_PLAN.md`](M4_VIDEO_AND_GAME_ASSET_PLAN.md)  
> **相关底座**：[`LOCAL_INFERENCE_AND_MODELS_PLAN.md`](LOCAL_INFERENCE_AND_MODELS_PLAN.md)（端侧 ONNX Inference Web Worker）、[`WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md`](WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md)（工坊单行分栏与控件优先设计）  
> **后续升级方案**：[`WORKSHOP_RELIGHT_UPGRADE_PLAN.md`](WORKSHOP_RELIGHT_UPGRADE_PLAN.md)（实时打光局限诊断、WebGPU 阴影/Radiance Cascades、端侧 `MoGe-2` ONNX 与 AI 重打光甜点选型）

---

## 1. 第一性原理与定位：从「单一雾效」升级为「空间几何感知底座 + 多玩法后处理」

最初的需求是「给生成的图片加雾气以提升氛围感」，但从视觉物理本质来看：**图像加雾、景深虚化、大气透视、2.5D 视差乃至实时动态打光，共享同一套缺失的前置几何信息——像素到相机的距离（Depth）与表面朝向（Normal）**。

如果只为雾气单独接一次深度模型，ROI 很低；更好的架构是将 **`MoGe-2` 与 `Depth Anything 3 (DA3)` 确立为工坊的「空间与深度感知底座」**：

1. **一次推理，多玩法实时复用（0ms 交互调参）**：
   - 模型只负责把 2D 画面拆解成 `depth`（深度图）与可选的 `normal`（法线图），并按工坊复合资产规范缓存/写入 `channels[]`；
   - 后续的**雾效调节（颜色、预设、起雾深度、贴地高差、局部浓雾焦点/涂抹）**、**大气透视**、**光学景深对焦**、**2.5D 视差动态预览**全部在渲染进程 `<canvas>` / WebGL 上 **16ms 内实时预览**，无需每次微调滑块都重跑 GPU 推理；
   - 当版本树内的同一张作品已经带有 `depth` 通道时，切换其他空间玩法直接复用，免二次推理。
2. **「能端侧绝不逼用户等云端」的双轨执行**：
   - 沿用 [`LOCAL_INFERENCE_AND_MODELS_PLAN.md`](LOCAL_INFERENCE_AND_MODELS_PLAN.md) 建立的 `shared/local-models.js` + 浏览器 Inference Web Worker（`onnxruntime-web` WebGPU/WASM）体系：轻量 ONNX 深度模型（如 `DA3-Small` / `DA3-Base` / `MoGe-2 ViT-S`）可像 `RMBG-1.4` 一样本机秒出深度图；
   - 超高清、复杂植被边缘或生成式重打光（`MoGe-2 ViT-L` / `DA3Mono-Large` / `DA3-Large` / `IC-Light`）走现有 GPU Worker（`worker/daemon.py` 串行任务队列）。
3. **动态打光不硬套纯深度，采用「PBR + 深度物理实时打光」与「生成式重打光」分流**：
   - 深度 + 法线无法直接消除原图 RGB 里已“烤死”的阴影和高光；
   - 仓库 **M4.2d 刚刚跑通了 `Ubisoft CHORD` 与 `Marigold` PBR 四通道拆解**（已具备去高光的 `albedo` + 微表面 `normal` + `roughness` + `metallic`）。将 **PBR 材质通道 + 深度图** 送入 WebGL 实时着色器即可做到 **60fps 物理级动态打光**；
   - 若要将“白天街景重绘成赛博霓虹夜晚”这类涉及环境光替换与全局阴影重算的场景，再单独引入专用重打光扩散模型（如 **`IC-Light`**）。
4. **协议展示沿用现有静默标签政策**：
   - 不因非商用限制舍弃更优模型，也**不弹模态警告窗口阻断流程**；
   - 完全复用 `shared/contract.js` 的 `license` / `licenseKind`（`open` / `non-commercial` / `research`）在 `ModelTierField` 旁以轻量标签与小字默默提示。

---

## 2. 几何底座与打光模型选型矩阵

### 2.1 深度与空间几何引擎：`MoGe-2` vs `Depth Anything 3 (DA3)`

| 模型 | 许可协议 & UI 标签 | 核心输出 | 运行轨道建议 | 定位与适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| **`MoGe-2 ViT-S / ViT-B`**（Microsoft） | **MIT**（部分 DINOv2 模块 Apache-2.0）· `open · 可商用` | 真实尺度深度（Metric Depth）、3D 点云、相机 FOV、**表面法线（Normal）** | **默认端侧 ONNX / 云端基线**（社区已有 `moge-2-*-onnx` 导出；ViT-B 仅 ~104M） | 一石二鸟：**同时拿到高精度深度 + 表面法线**，法线可直接辅助「贴地低雾方向判别」与简单受光面计算 |
| **`MoGe-2 ViT-L`** | **MIT** · `open · 可商用` | 同上（更高几何细节） | GPU Worker（高质量档） | 大尺寸精修场景、建筑/室内锐利边缘与 3D 视差 |
| **`DA3-Small / DA3-Base`**（ByteDance Seed） | **Apache-2.0** · `open · 可商用` | 极强鲁棒性相对深度、支持多视角几何一致 | **端侧 ONNX 候选**（已有 `Depth-Anything-3-Onnx` 社区导出） | 复杂自然风光、密集树叶/毛发前景分离，不易出现空洞 |
| **`DA3Mono-Large / DA3Metric-Large`** | **Apache-2.0** · `open · 可商用` | 单目高精相对/绝对尺度深度 | GPU Worker（商用高质量档） | 商业项目的精细景深与大场景大气透视 |
| **`DA3-Large / DA3-Giant`** | **CC BY-NC 4.0** · `non-commercial · 仅非商用` | 旗舰多视角/视频级一致性几何深度 | GPU Worker（高阶可选档） | 个人极致细节创作，及未来连接视频逐帧深度滤镜；UI 模型选择行旁静默展示 `非商用` 标签 |

> 说明：**Marigold V2（Depth）** 虽然也能出深度，但相比 `MoGe-2` / `DA3` 体积与推理开销更大（多步去噪、高显存），且已有商用友好的前馈端到端模型 `MoGe-2` / `DA3` 替代，因此深度底座不再引入 Marigold Depth（仅保留现有 `Marigold` PBR 职责）。

### 2.2 动态打光专用模型选型：为什么不只靠深度底座？

| 方案轨道 | 底层模型 / 技术 | 许可协议 & UI 标签 | 能力特征与优劣 | 建议落地优先级 |
| :--- | :--- | :--- | :--- | :--- |
| **轨道 1：物理级实时动态打光（零新增重模型）** | 复用 M4.2d 已落地的 **`Ubisoft CHORD`（`research`） / `Marigold`（`Apache-2.0`）PBR 四通道** + **`MoGe-2 / DA3` 深度** → WebGL Cook-Torrance 着色器 | 沿用现有 PBR 模型的 `licenseKind` 标签 | 去除了原图 baked shadow（靠 `albedo`），搭配微表面 `normal` / `roughness` / `metallic` 与深度 SSAO，**可在画布上 60fps 拖放 3D 光源球、改色温、加轮廓逆光（Rim Light）** | **Phase 2 优先落地**（工程增量最小，交互最惊艳） |
| **轨道 2：AI 生成式氛围重打光** | **`IC-Light`**（`lllyasviel/IC-Light`，SD1.5 版轻量快速；Flux 版质量更高） | 代码 Apache-2.0；权重 **`non-commercial · 仅非商用`** | 专精「前景去背 + 环境光描述/背景图引导重打光」，能真实重写全局色温、皮肤散射、环境反射与全新投射阴影 | **Phase 3 接入 GPU Worker**（可一键串联现有 `RMBG-1.4`/`BiRefNet` 抠图结果） |
| **轨道 3：前沿精确光源扩散研究** | **`LightLab`**（SIGGRAPH 研究项目）等参数化光源扩散模型 | 学术研究 / `CC BY-SA 4.0` · `research` | 支持精确 3D 点光源位置与强度参数控制的扩散生成；当前显存与生态适配较新，先作技术储备 | **观察与储备** |

---

## 3. 工坊信息架构设计（不膨胀现有单行工具栏）

依据 [`WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md`](WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md) 的设计纪律，工坊顶栏是**「单行分栏全平铺，压至 ~46px」**。若把「雾效、透视、景深、视差、打光」全部拆成独立顶栏按钮，会让顶栏膨胀到 11 个按钮。

**推荐方案**：在现有的 `平面与提取`、`游戏与 3D` 两个胶囊组之后，平铺新增第 3 个领域分组 **`光影与空间`（`atmosphere` / `spatial`）**，只设 **2 个聚合工具**：

1. **`depth-fx`（空间滤镜 / 深度光影）**：
   - 工具内部顶部采用工坊标准分段控件 `.ofs-seg` 切换四大子模式（共享同一份 `depth` 缓存，可组合叠加）：
     - **`雾效`（Fog）**：环境雾 / 贴地晨雾 / 局部聚雾（核心详细设计见 §4）；
     - **`透视`（Atmosphere）**：随距离渐变的空气感去饱和、色温偏移（远处偏冷青或暖霾）与反差衰减，迅速拯救“前景背景糊在一起、缺乏空气纵深”的平面感画面；
     - **`景深`（DoF）**：点击画布任意物体自动读取该点深度作为**焦平面 $z_{\text{focus}}$**，滑动控制光圈散景半径（Bokeh Blur），支持「自然对焦 / 移轴微缩模型（Tilt-Shift）」；
     - **`视差`（Parallax）**：利用深度图在 WebGL 内做实时 2.5D 镜头微移与景别呼吸预览，支持导出循环微动 `.mp4` / `.webm` 或带位移的静帧，无缝喂给工作台视频链。
2. **`relight`（动态打光）**：
   - 第一 Tab：**`实时物理光`（WebGL PBR + Depth）**——若当前作品在版本树中已有 PBR 四通道（来自 M4.2b/d 的 `pbr` 工具）与深度图，直接实时打光；否则一键在后台按序补齐 PBR 与深度；
   - 第二 Tab：**`AI 环境光重绘`（`IC-Light` GPU Worker）**——输入光源方位预设（顶光 / 左逆光 / 赛博双色霓虹 / 夕阳黄金时刻）与提示词，生成全新全局光影融合图。

> **感知层协同（`workshopPerception.js`）**：对于 `scene === 'illustration_or_photo'` 的完整风景/摄影/插画作品，现有引导会把用户“劝回创作台”；引入 `光影与空间` 后，这类完整画作在工坊也有了高价值的一键加工去向（加晨雾、拉景深、加逆光），`recommendedTools` 可在识别为风景/人像完整画作时亮起 `depth-fx` / `relight` 的推荐小圆点。

---

## 4. 深入设计：参数化、预设与「局部空间控雾」（回答用户核心诉求）

为了让雾效真正具备专业导演感而不是“整张图糊一层灰色渐变”，将雾效引擎设计为**「三轴叠加场 + 预设胶囊 + 0ms 实时预览」**：

### 4.1 光学参数与一键预设（Presets）

参照 `WorkshopParams.jsx` 现有的 `VECTOR_PRESETS` 样式，参数区顶部提供常用氛围预设胶囊，选中后自动填充并允许继续微调：

| 预设名称 | 默认雾色 | 分布模式 | 核心参数倾向 | 适用画面 |
| :--- | :--- | :--- | :--- | :--- |
| **清晨微澜**（默认） | 暖乳白 `#EDE9DF` | 远景指数 + 轻贴地 | `density: 0.45`, `startDepth: 0.25`, `heightBias: 0.45`, `blend: screen` | 风景、建筑、户外人像 |
| **深林贴地岚** | 冷灰青 `#C7D6DF` | 强贴地低雾 | `density: 0.65`, `startDepth: 0.15`, `heightBias: 0.85`, `horizon: 0.60` | 森林、水面、古风、悬疑场景 |
| **水墨远山烟** | 宣纸白 `#F2F3F5` | 高前景保护 + 远山留白 | `density: 0.70`, `startDepth: 0.45`, `heightBias: 0.20`, `desaturate: 0.3` | 国风山水、插画、留白排版 |
| **赛博霓虹霾** | 青/洋红双色或 `#8A7FD8` | 全局柔和散射 | `density: 0.50`, `startDepth: 0.20`, `blend: screen`, `glow: 0.3` | 夜景街道、科幻概念、赛博人像 |

### 4.2 如何精准控制「什么地方什么位置的雾更浓」？（三轴场方程）

在拿到深度图 $z(x, y) \in [0, 1]$（`0` 为最近前景，`1` 为最远背景）后，像素 $(x, y)$ 的最终雾不透明度 $\alpha(x, y)$ 由 **深度权重 × 高度权重 × 局部空间权重** 共同决定：

$$\alpha(x, y) = \text{clamp}\Big(\text{density} \cdot W_{\text{depth}}(z(x, y)) \cdot W_{\text{height}}(y, N_y) \cdot W_{\text{spatial}}(x, y),\ 0,\ 1\Big)$$

1. **深度维度 $W_{\text{depth}}$（控制“多远才开始起雾”）**：
   - **`起雾距离 (startDepth)`**（`0.0 ~ 0.9`）：小于该深度值的前景（如镜头前的角色脸部、前景树枝）雾浓度为 0，做到清晰前景保护；
   - **`浓淡曲线 (falloff)`**：采用物理 Beer-Lambert 衰减 $1 - \exp(-\beta \cdot \max(0, z - z_{\text{start}}))$，比线性渐变更有空气层次。
2. **垂直高度维度 $W_{\text{height}}$（控制“地面/谷底浓，天空透”）**：
   - **`贴地低雾权重 (groundBias)`**（`0.0 ~ 1.0`）与 **`雾面高度线 (horizon)`**（`0.2 ~ 0.9`）：把画面自上而下按 `smoothstep` 衰减；
   - **法线辅助（`MoGe-2` 专属加成）**：当使用 `MoGe-2` 获得表面法线 $N_y$ 时，水平地表面（$N_y$ 朝上）自动保留更强雾气聚集，垂直墙面与立柱边缘自然穿透，贴地感远超纯 2D 垂直渐变。
3. **局部空间维度 $W_{\text{spatial}}(x, y)$（控制“画面的左/右/某个角落更浓或避让”）**：
   - **模式 A（零涂抹焦点模式，默认推荐）**：用户直接在画布上**点击/拖拽放置 1~2 个控雾锚点**：
     - **「聚雾中心 (+)」**：在某个山谷、门洞或地面积聚一团浓雾（高斯扩散半径 `radius` + 增强倍率可调）；
     - **「散雾避让 (-)」**：点在人物或主体身上，以柔边径向衰减挖空该区域雾气，确保主体通透锐利。
   - **模式 B（柔性画笔局部涂抹，按需展开）**：画布提供「增浓画笔 / 减淡橡皮」与笔刷大小/羽化滑块，在低分辨率权重画布（如长边 `512px`）上涂抹 $M(x, y) \in [0.0, 2.0]$，支持切换「叠加权重热图预览」与一键清空。

---

## 5. 契约、数据结构与端到端架构规划

> 以下为接入仓库时的标准契约对齐方案（尚未写入 `shared/contract.js`，实施时同步 `node test/check-contract.mjs`）：

1. **端侧模型注册表（`shared/local-models.js`）**：
   - `LocalModelTask` 扩展为 `'vision' | 'cutout' | 'depth'`；
   - 预登记端侧 ONNX 模型（如 `moge-2-vits-onnx` MIT / `da3-small-onnx` Apache-2.0），沿用 `preferredEps: ['webgpu', 'wasm']`、SHA-256 校验、自定义缓存目录与「设置 → 本机模型」统一开关。
2. **复合资产包通道与工坊契约（`shared/contract.js`）**：
   - `WORKSHOP.tools` 扩展新增 `'depth-fx'`、`'relight'`；
   - `WORKSHOP.channels.roles` 新增 `'depth'`（统一存放 16-bit 或高精度灰度深度图，以及可选 `'normal'` 通道）；
   - 新增 `WORKSHOP.depth` 与 `WORKSHOP.relight` 边界定义：登记可用模型（`moge-2-vitb` / `da3-base` / `da3mono-large` / `da3-large` 等）及 `license` / `licenseKind` / `runtime`（`local-onnx` vs `gpu-worker`），并登记预设与参数安全上下界。
3. **版本树与下游复用（`web/logic/lineage.js` & `server/workshop.js`）**：
   - `apply` 后落盘主图 `01.png`（带雾/景深/重打光成品图），并把推理出的 `depth`（和可选 `normal`）作为附属通道保存在同一作品目录的 `channels[]` 中；
   - 当用户从结果图点击画布右下角「接力胶囊」（如 `继续：调整景深对焦 ›` 或 `继续：物理动态打光 ›`）或同作品再次调参时，直接读取当前条目的 `depth` 通道，实现零模型等待二次加工。
4. **GPU Worker 扩展（`worker/inference/game_ops.py` & `worker/daemon.py`）**：
   - `REQUEST_TOOLS` 与 `validator.py` 扩展 `'depth'`（或 `'depth-fx'`）与 `'relight'` 算子；
   - 按 `game_ops.py` 现有显存守则执行：推理完成后 `del model; gc.collect(); torch.cuda.empty_cache()`，避免影响后续生图或 3D 任务。

---

## 6. 分阶段实施路线（已接入 ROADMAP M4.2e）

| 子阶段 | 核心交付 | 依赖前提 | 验收指标 |
| :--- | :--- | :--- | :--- |
| **M4.2e-1：深度几何底座（端侧 ONNX + 云端 Worker）**（已完成） | 1. `DA3-Small` INT8 ONNX 走统一端侧 Worker，GPU 高质量档登记 `MoGe-2 ViT-L` / `DA3Mono-Large` / `DA3-Large`；<br>2. `shared/contract.js` 注册 `depth` 通道、模型清单与许可证标签；<br>3. 深度任务把源画面保留为主图，`depth` / `normal` 写入 `channels[]` 供版本树复用。 | M4.2c/d 现有端侧 Worker 与 GPU 队列 | ✅ DA3-Small 37 MB 权重实测 SHA-256 / CPU 前向通过；完整离线链路与落盘测试通过。 |
| **M4.2e-2：工坊 `空间滤镜 (depth-fx)` 四合一交互**（已完成） | 1. 新增 `光影与空间` 分栏与 `depth-fx`；<br>2. 落地雾效（四套预设、起雾距离、贴地低雾、聚雾/散雾锚点、柔性画笔）、大气透视、点击对焦景深 / 移轴、2.5D 视差；<br>3. 预览在 384px（DoF 256px）工作副本实时重绘，应用按原分辨率落盘 `depthfx + depth + normal`。 | M4.2e-1 | ✅ 纯函数、状态机、渲染与落盘测试通过；无模态警告。 |
| **M4.2e-3：工坊 `动态打光 (relight)` 双轨闭环**（已完成） | 1. 轨道 1：WebGL shader 融合 PBR 四通道 + depth，拖动光球实时重打光，CPU 同方程兜底；<br>2. 轨道 2：GPU Worker 接入 `IC-Light`，支持 prompt / steps / cfg / seed / preset，非商用静默标签。 | M4.2d + M4.2e-1 | ✅ 离线队列与 UI 闭环通过；真机云卡性能复测留作发布前复核。 |

---

## 7. 实施记录（2026-11-27）

### 7.1 契约与端侧深度

- `WORKSHOP.tools` 扩展为 8 项（新增 `depth-fx` / `relight`），通道白名单新增 `depth / depthfx / relit`；`REQUEST_TOOLS` 与 daemon `requestTools` 新增 `depth / relight`。
- `shared/local-models.js` 登记 `da3-small-int8`：`ohaiibuzzle/DA3-ONNX` 固定 revision，`37,027,601 B`，SHA-256 `9194a0d5…`。
- 实际下载与该 SHA-256 校验通过；ONNX Runtime CPU 前向输入名 `image [1,3,378,504]`、输出 `depth [1,378,504]`，单次约 `187.5 ms`。浏览器端走同一 ONNX 的统一 Inference Web Worker。
- 端侧输出按 2% / 98% 分位拉伸成内部 `0=近 / 1=远` 深度场；由深度梯度生成法线通道，服务雾效与缺少 PBR 的物理打光。

### 7.2 空间滤镜

- `web/logic/depthFx.js` 提供深度归一、RGBA 缩放、法线生成与 `fog / atmosphere / dof / parallax` 四种纯函数渲染。
- 雾效由深度 Beer-Lambert 权重 × 贴地高度权重 × 局部空间权重（锚点 / 涂抹）组成；预设色板默认「清晨微澜」，并在画布上支持聚雾 / 散雾锚点与柔性画笔。
- 景深以点击位置读取焦平面深度，支持移轴模式；视差以机位呼吸预览，应用时落成当前机位静帧。
- 预览工作副本按参数长边 `384px`，DoF `256px`，最终应用按源图原分辨率重算，避免“预览与落盘不一致”。

### 7.3 双轨打光

- `web/logic/relight.js` 是 CPU 基准方程（反照率 × 漫反射 + 微表面高光 + 环境光 + 轮廓光）；`web/logic/relightWebGL.js` 是同一方程的 WebGL shader 预览。
- 有 PBR 四通道时直接复用 `albedo / normal / roughness / metallic`；没有时用源图作为 albedo、深度梯度作为 normal，界面明确提示近似路径。
- 画布交互层支持拖动 3D 光源球，并实时更新色温、主光强度、轮廓光和环境补光；应用后落盘 `relit + depth + normal`。
- AI 轨道经 `tool=relight` 提交 GPU Worker，`worker/inference/game_ops.py` 的 `run_ic_light()` 使用 SD1.5 8 通道 UNet 偏移权重；权重与底模在任务后释放显存。

### 7.4 验证

- `test/check-client-depth-fx.mjs` 8 项、`test/check-client-workshop.mjs` 42 项、`test/check-client-workshop-perception.mjs` 30 项、`test/host-workshop-gpu.mjs` 11 项、`test/worker/test_workshop.py` 43 项。
- `npm run build:web`、`npm run test:contract`、`python test/worker/run.py` 通过；DA3-Small 端侧模型已做真实权重下载与前向核对。
- 真实 Chromium：1440×960 与 390×844 下均为 3 个工具分栏 / 8 个工具；整页无横向溢出，窄屏工具栏按设计内部滚动；空间滤镜点击可放置聚雾锚点，动态打光可见可拖光球。
- 真实 Chromium 的 WebGL 1 shader 已编译并渲染非均匀打光结果，确认不是仅 CPU 兜底；浏览器禁用 / 丢失 WebGL 时自动回退 CPU。
- 未在本轮消耗云端 GPU 配额执行 DA3Mono-Large / DA3-Large / MoGe-2 ViT-L / IC-Light 真机压测；该复核不改变协议与 UI 闭环，发布前可在既有 Kaggle 2×T4 流程中补跑。
