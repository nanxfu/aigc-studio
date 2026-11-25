# 工坊场景化引导与「类 Jev（System One）」智能感知规划

> **状态**：Phase 1a（L1 感知引擎 + Host 溯源）、Phase 1b（UI/UX 收束重构）、Phase 1c（取消底栏・应用即落盘 + 独立 `workshop` 版本语义）、Phase 1d（切图状态隔离・手动参数优先・旧作品先验兜底）与 Phase 2（端侧 L2 ONNX 视觉感知）均已落地（2026-11-25，见 §6.3 / §6.4 / §6.5 / §6.6 / §6.7）；**Phase 2.5（感知打标持久化与切图零跳动收口）**已规划待实施（见 §6.8）；Phase 3（云端语义增强）仍待推进
> **承接**：[`M4_VIDEO_AND_GAME_ASSET_PLAN.md`](M4_VIDEO_AND_GAME_ASSET_PLAN.md) M4.2a/b 已落地的独立工坊底座  
> **目标读者**：前端 / 架构开发专员  
> **核心问题**：  
> 1. 初版工坊平铺全部 6 个工具并默认落在 `pixel-snap`，缺乏按用途的领域组织与默认落焦；  
> 2. Phase 1a 初版 UI 把“防迷宫”做成了三层顶部卡片（大标题副标题 + 折叠开关混排胶囊 + 6 枚偏游戏细碎场景标签通栏白卡）与默认展开的说明书式参数卡，严重挤压光桌画布并偏离产品黑白灰极简调性；  
> 3. 需要通过 **System One（类 Jev）静默感知层** + **按工具领域分类的单行顶栏** + **控件优先参数卡**，在 `<10ms` 内完成智能聚焦而不把后台分类器摊在用户面前。

---

## 1. 设计原则与核心结论（First Principles）

1. **按「工具类型 / 加工领域」分栏全部平铺，不隐藏工具，也不按偏游戏的图片微标签切碎**：
   - 将工坊工具按领域清晰归组（目前为 **`平面与提取`** 与 **`游戏与 3D`**，后续可并列加入 **`人像与修复`** 等分组）。
   - 顶栏采用**「单行分栏全平铺」**：按领域分栏（轻组名 + 细竖线隔开）把全部工具直接摊平在顶栏上，**不做折叠开关、不做下拉菜单、也无需先点大类再点工具——所有工具一次点达**；同时给各工具配备专属 `<Icon>` 与流畅的滑动选中/切组动效，保证生动有质感。
2. **后台静默感知，前台克制退让（不暴露 6 选 1 场景纠偏墙）**：
   - System One 感知层在后台默默完成特征判定并自动落焦到最推荐的工具（仅在首推工具旁亮起极轻的推荐小圆点）。
   - **取消整行通栏的「识别场景」6 枚标签卡**——用户来到工坊是选工具加工图片，不需要先面对 6 个偏游戏的作品分类做选择题。
   - **给“误入工坊”的完整画作用户轻量出口**：全站 `TopBar` 已有 `[创作 | 工坊 | 作品库]` 常驻切换，**工坊头部不再放置冗余的「返回创作」按钮**；当感知到当前图是完整摄影/插画时，仅在**画布顶部边缘飘一条极轻、可关闭的半透明行内提示**（带文字链接 `返回创作台精修 ›`），不新起通栏卡片，也不抢主按钮权重。
3. **「类 Jev（System One）」感知范式的本地化落地**：
   - TypeSafe AI 的 **Jev** 本身是闭源云端 API（无公开权重，不能本地运行），但其核心思想——**不生成自然语言，输入状态 + 闭合问题原语（`Choice` / `Score` / `Noul`），百毫秒内返回带校准概率的结构化决策**——非常适合作为工坊路由层范式。
   - 由于工坊支持**本地上传图片**（`source === 'import'`，无 `prompt` 与 `presetId`），且 AI 生图常出现“prompt 与成图结构不一致”，感知层**不能只看文本 prompt**，必须采用 **「多模态信号融合」**：
     - **Phase 1（必做基线，0 模型 / `<10ms`）**：`presetId` 元数据 + `prompt` 规则权重 + `<canvas>` 像素统计与周期/接缝探测；
     - **Phase 2（已落地，端侧视觉分类）**：MobileCLIP-S0 FP16 视觉编码 + 预计算文本锚点，Host 侧 CPU 单线程推理，与生图 GPU 零显存冲突；见 §3.3 与 §6.7。
     - **Phase 3（可选增强）**：已配置云端 LLM / Ollama / Jev API 的用户可按需开启高阶语义建议（如自动猜测序列帧 `rows × cols`）。

---

## 2. 工坊信息架构与引导交互设计（UX Spec · 2026-11-24 收束版）

### 2.1 按工具领域分类（不改动 `WORKSHOP.tools` 底层契约）

保持 [`shared/contract.js`](../shared/contract.js) 中 `WORKSHOP.tools` 的 6 个工具 ID 与保存契约不变，仅在 UI 呈现层按「工具领域」分栏直接平铺：

| 领域大类 | 工具 ID | 面向用户的通俗任务标题 | 一句话适用说明 |
| :--- | :--- | :--- | :--- |
| **平面与提取** | `cutout` | **抹除背景** | 分离人物、道具或商品，导出透明底 PNG |
| **平面与提取** | `vectorize` | **SVG 矢量** | 适合 Logo、扁平图标与简笔画，无限放大不糊 |
| **平面与提取** | `tile` | **无缝平铺** | 检查并修复纹理/壁纸四边接缝，铺满画面无断层 |
| **游戏与 3D** | `pixel-snap` | **像素对齐** | 修复 AI 像素画歪斜的伪像素格，并收敛为标准调色板 |
| **游戏与 3D** | `sprite-slice` | **序列帧切片** | 把多格角色动作图切成单帧并生成动画与 `atlas.json` |
| **游戏与 3D** | `pbr` | **PBR 材质拆解** | 生成法线、粗糙度、金属度贴图包，用于 3D 渲染引擎 |

### 2.2 四处关键界面收束改造（对应 `Workshop` 骨架）

1. **单行轻量工具顶栏（`.ofs-workshop-head`，压至单行 ~46px，去掉大标题/副标题与「返回创作」按钮）**：
   - **去掉标题简介块与返回按钮**：全局 `TopBar` 已高亮「工坊」并自带 `创作 | 工坊 | 作品库` 切换，头部不再重复写「资产工坊 + 两行工具复读副标题」，也**去掉 `.ofs-workshop-back` 返回按钮**。
   - **按领域分栏、各成一枚胶囊**：`平面与提取` 与 `游戏与 3D` 各自是一枚独立的胶囊（组名在胶囊最左、与工具按钮之间一条 hairline），两枚胶囊之间用留白分隔，而不是「一条长轨 + 竖线 + 组名」，**不隐藏、不折叠、一次点击直达任意工具**（窄屏时工具栏可横向顺滑滚动）。
   - **图标与切换动效**：每个工具按钮配备专属 `<Icon>` 与紧凑推荐小圆点；选中项是**墨色实心胶囊**（深色主题自动反相），切换工具时滑块按 `--ofs-ease-spring` 滑动，左侧参数卡配轻量切入过渡（支持 `prefers-reduced-motion`）。

2. **取消通栏场景卡，改为「静默感知 + 画布边缘轻提示」**：
   - **移除 `.ofs-workshop-scene` 通栏卡片与 6 枚场景切换胶囊**：L1 感知只在后台驱动首屏默认工具落点与推荐亮点，不再让用户面对 6 个细碎游戏术语标签手动纠偏。
   - **完整画作轻量出口**：当判定为 `scene = 'illustration_or_photo'` 且 `professionalScore < 0.45` 时，仅在画布顶部边缘（`.ofs-workshop-canvas-stage` 内浮层）飘一条**极轻、可关闭（`✕`）的胶囊条**：「如需局部重绘、扩图或高清放大，可回创作台精修」+ 纯文字链接 **`返回创作台 ›`**（调用 `actions.closeWorkshop()`）。

3. **参数卡说明与示意图（[`WorkshopParams.jsx`](../web/studio/workshop/WorkshopParams.jsx)）**：
   - **说明默认展开、可收起**：参数卡标题栏右侧一枚轻量的 **`?` 图标按钮** 控制当前工具的一句话说明 + **Before / After SVG 示意图**；无本地偏好时展开，点 `?` 收起并记入 `localStorage`。同时修复 [`samples.jsx`](../web/studio/workshop/samples.jsx#L37-L44) 中 `<Arrow x="56" />` 字符串拼接导致箭头消失的 Bug，并修正 `CutoutSample` 椭圆主体被棋盘格透出像马赛克的层次。
   - **客观探测白话单行保留**：`pixel-snap` 的 `detectPixelGridSafe`、`tile` 的 `seamMaeSafe`、`sprite-slice` 的帧尺寸读数保留为参数区顶部**单行轻提示**，不废话、不占多行高度。
   - **模型许可与上下文警告收敛**：`ModelSelect` 不再在下拉框下方单起一整条灰色协议条——将简短许可（如 `MIT · 免登录可用`）放在「模型」标签行右侧；像 `RMBG-2.0` 的非商用及 HuggingFace Token 提醒，**仅在用户实际选中该非免登录模型时才以紧凑警告块出现**，选默认 `BiRefNet` 时保持极简干净。

4. **取消独立底栏，应用即落盘 + 画布内原位接力（Workflow Handoff）**：
   - **移除 `.ofs-workshop-foot`（含「保存到作品库」与「导出 ZIP」按钮）**：调参只更新前端实时预览（永不写盘）；点参数区 **`应用`** / **`生成 SVG`** 后直接自动调用 `saveWorkshopAsset` 落盘进作品库并切换焦点至新产物，与 GPU 算子（`运行抹除背景` / `运行材质拆解`）的「执行即入库」心智完全统一（后端 `GET /api/workshop/export` 接口保留契约，不在工坊占底栏按钮）。
   - **原位接力移至画布操作区**：操作完成并入库后，在画布右下角 `.ofs-workshop-canvas-actions` 同排（或左栏主按钮下方）给出 **1 个最匹配的轻量接力胶囊**（如 `继续：拆解 PBR 材质 ›`、`继续：切分序列帧 ›`、`继续：转为 SVG 矢量 ›`），因当前产物已自动落盘，点击直接带着新作品条目切换目标工具，既可追溯版本树又无二次保存弹窗/延迟。

---

## 3. 「类 Jev（System One）」智能感知引擎设计

### 3.1 统一契约（System One 提问原语）

无论底层走 L1 规则像素探测、L2 本地 ONNX 视觉模型，还是 L3 可选 API，向上层 UI 暴露同一份确定性输出结构（建议放在 `web/logic/workshopPerception.js` 或由主进程/前端共享）：

```ts
type WorkshopSceneId =
  | 'illustration_or_photo' // 完整插画 / 人物 / 风景摄影（普通用户最常见）
  | 'isolated_prop'         // 孤立物体 / 游戏道具 / 白底或纯色底立绘
  | 'pixel_art'             // 像素画 / 复古点阵资产
  | 'sprite_sheet'          // 多格序列帧 / 动作表
  | 'seamless_texture'      // 材质贴图 / 平铺纹理（石墙、草地、木纹等）
  | 'flat_icon_logo'        // 扁平图标 / UI 徽章 / Logo

interface WorkshopPerceptionResult {
  source: 'l1-heuristic' | 'l2-onnx-vision' | 'l3-llm'
  latencyMs: number
  // Choice 原语：6 类场景的概率分布（和为 1）与最高命中场景
  scene: WorkshopSceneId
  sceneProbs: Record<WorkshopSceneId, number>
  // Noul 原语（0~1）：针对具体工作流动作的布尔概率
  noul: {
    needsCutout: number      // 背景单调/主体孤立且尚未透明，建议先抠图
    isGridSprite: number     // 呈行列多格排布，适合序列帧切片
    isPixelGrid: number      // 存在周期性像素网格，适合 pixel-snap
    isTileable: number       // 适合无缝平铺/纹理检查
    isVectorFriendly: number // 色彩少且边缘锐利，适合 SVG 矢量化
    wantsPbr: number         // 具有明显材质/道具立体质感，适合 PBR 拆解
  }
  // Score 原语（0~1）：专业资产倾向度（< 0.45 视为普通通用图，收起专业分组并展示返回创作台提示）
  professionalScore: number
  // 推荐结果（已排序）
  recommendedTools: string[] // 1~3 个 toolId，第一项即为默认自动焦点
  showStudioReturnHint: boolean
  reasonText: string         // 一句话面向用户的白话解释（i18n）
}
```

### 3.1.1 原生图（`rootImage`）Prompt 溯源与「三合一 State」输入约束

> **现网数据坑**：当前 [`saveWorkshopAsset`](../server/workshop.js#L272-L312) 保存工坊产物时会将 `presetId` 置为 `null`、并将 `params.prompt` 覆写为 `name || tool`（例如 `"cutout"`）；[`submitWorkshopOp`](../server/workshop.js#L628-L640)（抹除背景 / PBR）及 `upscale` 也以单图入队，不携带原生 `prompt`；`inpaint` 则往往只记录局部修改词。因此**不能只看当前作品 `item.prompt`**，必须向感知层传入「三合一 State」：

1. **原生根图先验（Root Context，`rootPrompt` + `rootPresetId`）**：
   - 沿版本树 `item.rootImage` 追溯至第一代文生图作品，提取原生 `prompt` 与 `presetId` 作为**强场景先验**（如 `"isometric healing potion, game item, white background"`）；
   - **推荐工程落地**：在 [`server/output.js`](../server/output.js) 的 `readHistoryItem` 解析或 [`server/workshop.js`](../server/workshop.js) / 衍生任务落盘时，顺手继承或回溯填充可选只读字段 `rootPrompt` 与 `rootPresetId`（仅作只读溯源语义，不影响 `params.prompt` 原有重现逻辑），保证前端单次读取就能拿到原生图意图，无需跨历史分页反查；
   - **严禁单一依赖**：本地导入图（`source === 'import'`）无 `rootImage` 与 `rootPrompt`，且生成结果可能与 prompt 偏差（如写了 `4x4` 却画成单图），因此 `rootPrompt` 仅作先验权重，不能一票否决图像客观特征。
2. **当前衍生状态（Lineage State）**：
   - 传入 `item.source`（`'ai' | 'import'`）、`item.workshopTool`、`item.channels` 列表，防止对**已经抠完背景或已做过像素对齐**的派生图重复推荐同一工具（例如 `rootPrompt` 写了 `white background`，但当前图已是 `cutout` 透明底时，应将 `needsCutout` 压低并把 `pbr` / `sprite-slice` / `vectorize` 推至首位）。
3. **当前图像客观信号（Visual / Pixel Truth）**：
   - 当前图的透明通道占比、边缘纯色度、网格周期置信度、接缝 MAE（L1）或端侧视觉特征向量 / Visual Jev 图像输入（L2/L3），作为最终纠偏依据。

### 3.2 L1 基线引擎（Phase 1 立即实施：0 模型，`<10ms`）

利用 [`Workshop.jsx`](../web/studio/workshop/Workshop.jsx) 已经拿到的 `selected.item`（[`server/output.js`](../server/output.js#L571-L608)）与 `sourcePixels`（Canvas RGBA 像素数组），融合三路信号打分并经过 Softmax/Sigmoid 归一化：

1. **信号 A：模型出身（优先 `item.rootPresetId || item.presetId` + 模型元数据可选字段 `sceneTags`）**
   - 后续在 `models/*.json`（及 LoRA 预设）中允许声明可选字段 `"sceneTags": ["prop", "pixel", "texture", "icon"]`；
   - 命中专用游戏资产模型/LoRA 时直接给对应场景强加权（`+0.45`），`professionalScore` 同步拉高。
2. **信号 B：原生提示词语义规则（优先 `item.rootPrompt`，退回 AI 原图 `item.prompt`；本地上传图跳过）**
   - 因为 [`server/intent.js`](../server/intent.js) 已将用户输入规范为英文 prompt，可用轻量词组权重表匹配：
     - `pixel_art`: `pixel art`, `8-bit`, `16-bit`, `pixelated`, `sprite`（非 sheet）
     - `sprite_sheet`: `sprite sheet`, `spritesheet`, `animation frames`, `walk cycle`, `4x4`, `turnaround`, `character sheet`
     - `seamless_texture`: `seamless`, `tileable`, `texture`, `pbr`, `material`, `brick`, `wood grain`, `cobblestone`, `grass texture`
     - `flat_icon_logo`: `icon`, `logo`, `badge`, `emblem`, `flat design`, `minimalist vector`, `ui button`
     - `isolated_prop`: `isolated on white`, `game asset`, `game item`, `potion`, `sword`, `treasure chest`, `isometric prop`, `white background`
3. **信号 C：纯前端 Canvas 视觉像素特征（同时覆盖 AI 图与无 Prompt 本地上传图！）**
   - 仅采样缩略分辨率（如长边 `<= 256px`，计算耗时 `<5ms`），提取 5 个零依赖确定性特征：
     - **透明通道检测（`alphaRatio`）**：是否已包含有效透明像素（`alpha < 250` 占比）；若已抠图完成，`needsCutout` 概率直接归零。
     - **边缘纯色占比（`borderUniformity`）**：取图像最外圈 4px 像素，统计与四角色均值颜色差 `< 12` 的比例；高纯色外框 + 中心高方差 → 强触发 `needsCutout` 与 `isolated_prop` / `flat_icon_logo`。
     - **网格周期探测（复用 `detectPixelGrid`）**：直接在载入源图时跑一次轻量探测；`cell > 1 && confidence >= 0.55` → 强触发 `pixel_art` + `isPixelGrid`。
     - **接缝与全图纹理分布（复用 `seamMae` + 四象限方差均匀度）**：边缘差异小且图像能量分布均匀（非中心单主体构图）→ 触发 `seamless_texture`。
     - **颜色直方图浓缩度（量化采样后 Top-16 色覆盖率）**：极少颜色即可覆盖 `>90%` 像素且边缘锐利 → 触发 `flat_icon_logo` + `isVectorFriendly`；同时辅以内部空白十字分割线检测（行列投影谷值）探测 `isGridSprite`（序列帧网格）。

> **冷启动与默认焦点规则**：
> - 当工坊首次带着一张作品进入（且用户尚未手动点击过工具、`initialTool` 未显式指定）时，等待 L1 感知结果（`<10ms`）后自动把初始焦点落到 `recommendedTools[0]`，**不再无脑停在 `pixel-snap`**；
> - 若用户手动点击了某个工具按钮，记录 `userPinnedTool = true`（切换作品前不强行覆盖用户的手动选择，只更新推荐小圆点）。

### 3.3 L2 端侧轻量视觉模型（Phase 2，已落地）

为提升**无 Prompt 本地上传图**与复杂语义的准确率，引入端侧 System One 视觉分类。它是 L1 的可选增量，不是替代品：
- **模型与推理**：`Xenova/mobileclip_s0` 固定 revision
  `757d59c9c6870a76a4b0306f05f5061bca15c39f`，运行时只加载
  `onnx/vision_model_fp16.onnx`（22,876,479 B，SHA-256 `22b1d36e…1cc59dc`）。Host 用
  `onnxruntime-web` 单线程 WASM 跑一次图像编码，输出 512 维嵌入；文本侧六类场景与六个 Noul
  的锚点在开发期量化成静态数据（[`shared/workshop-vision-anchors.generated.js`](../shared/workshop-vision-anchors.generated.js)，约 14 KB），运行时不再加载 85 MB 文本编码器，也不生成任何文字。
- **运行位置**：Electron Host 的 [`server/workshop-vision.js`](../server/workshop-vision.js)，首次使用才下载权重到
  `<workspace>/.aigc-studio/models/mobileclip-s0/`，校验字节数与 SHA-256 后复用 Session；CPU 推理串行，不与生图 / 抠图 GPU 抢显存。客户端只上传 256×256 RGB，不传作品路径或元数据。
- **与 L1 的关系**：L2 输出同一份 `scene / sceneProbs / confidence / noul / professionalScore /
  recommendedTools` 结构。客户端 [`mergeWorkshopPerception()`](../web/logic/workshopPerception.js)
  只在 L2 置信度足够高、且不推翻 Alpha 通道 / 像素格 / 序列帧格线 / 接缝等确定性证据时覆盖语义场景；
  Noul 也按各自证据门槛有限接纳。普通照片不会被 CLIP 误判成专业资产。
- **限制**：FP16 单次前向在本机 Node 约 235 ms，远高于 L1 的 `<10ms`，因此只做异步微调；真实素材
  场景回归约 31/51、Noul 精选标签 27/27，后者样本覆盖有限，不应作为普适准确率宣传。权重受
  **Apple ML-MobileCLIP License** 约束，当前不宣称可商用。

### 3.4 L3 可选云端 / 现有 LLM 增强（Phase 3 可选）

- 对已配置 [`server/llm/`](../server/llm/index.js)（包括本地 Ollama 或云端视觉模型）或愿意自行填入 **TypeSafe Jev API** Key 的高阶用户，可在设置中提供可选开关「工坊智能参数推理」，用于在后台异步补全更细粒度建议（例如：`sprite-slice` 自动估算 `rows × cols`、提示是否需要先做 `cutout`）。
- **刚性约束**：绝不强制联网、绝不阻塞工坊打开速度；任何 L2/L3 超时或失败都必须静默回退到 L1。

---

## 4. 涉及文件与分步实施清单（供专员拆解执行）

### Phase 1：工坊引导重构 + L1 System One 感知引擎（优先实施）

1. **新增纯逻辑与感知模块**：
   - 新增 `web/logic/workshopPerception.js`：实现 L1 Canvas 特征提取（外框纯色度、透明比例、Top-K 色彩集中度、行列空白分割探测）+ `rootPresetId`/`rootPrompt` 规则打分 + 衍生状态去重（`channels` / `workshopTool`）+ `perceiveWorkshopWork({ pixels, item, rootItem, gridDetected, seam })` 输出标准 `WorkshopPerceptionResult`。
   - 保持纯函数无 DOM 依赖，便于 Node 单测覆盖。
2. **原生图上下文溯源与模型元信息（后端轻量对齐）**：
   - [`server/output.js`](../server/output.js) / [`server/workshop.js`](../server/workshop.js)：派生图在读取或保存时可随带只读 `rootPrompt` / `rootPresetId`（沿 `rootImage` 溯源，缺失或旧数据按 `null` 处理，不破坏既有契约）；前端亦先在当前已加载 `works` 中按 `rootImage` 做即时兜底查找。
   - 在 `models/*.json` 与 [`shared/models-guide.js`](../shared/models-guide.js) 中允许可选 `sceneTags` 字段（未填则按空数组处理，向后兼容）。
3. **工坊主控与状态流改造**：
   - [`web/studio/workshop/Workshop.jsx`](../web/studio/workshop/Workshop.jsx)：
     - 取消“无条件默认 `WORKSHOP.tools[0]`”的硬编码，接入 `perceiveWorkshopWork` 在未指定 `initialTool` 时决定首屏推荐工具；
     - 顶栏收束为**单行分栏工具栏**（去掉大标题副标题块与冗余的「返回创作」按钮），按 `平面与提取` / `游戏与 3D` 分栏全部平铺工具（带专属 Icon、轻量推荐点及滑动/切入动效，不做折叠隐藏）；
     - 移除通栏 `.ofs-workshop-scene` 场景芯片条，改为画布顶部边缘可关闭的轻量回流浮条（`illustration_or_photo` 场景复用 `actions.closeWorkshop`）；
     - 工作流接力直接原位嵌入底栏 `.ofs-workshop-foot` 右侧，先保存再切工具。
   - [`web/studio/workshop/WorkshopParams.jsx`](../web/studio/workshop/WorkshopParams.jsx) & [`samples.jsx`](../web/studio/workshop/samples.jsx)：
     - 顶部改为参数区标题旁 `?` 按钮控制说明（默认展开、可收起并记忆 `localStorage`），修复 `samples.jsx` 中 `<Arrow x={56} />` 数值传参 Bug 与 `CutoutSample` 主体半透明被棋盘格穿透问题；
     - 探测结果以单行白话呈现；`ModelSelect` 许可信息移至标签行右侧，非商用/Token 警告仅在选中受限模型（如 `RMBG-2.0`）时渲染。
   - [`web/styles/workshop.css`](../web/styles/workshop.css)：
     - 遵循现有 `tokens.css` 变量体系实现单行大类+工具顶栏、大类切换动效（遵守动效减退）、`?` 折叠说明卡、画布边缘轻提示与底栏接力胶囊样式（注意深浅色主题及窄屏适配）。
   - `web/dict/zh.js` & `web/dict/en.js`：补齐新增文案键。
4. **静态示意图资源**：
   - 在前端静态资源目录新增 6 组轻量化 Before/After 示例缩略图（建议使用极简内联 SVG 或小体积 WebP，单张 `<10KB`）。

### Phase 2：L2 端侧轻量化 ONNX 视觉感知（已完成，2026-11-25）

1. Host 侧新增可选 `POST /api/workshop/perceive`，只接受客户端缩放好的 256×256 RGB base64，权重按固定 URL / 字节数 / SHA-256 懒下载；
2. 用 MobileCLIP-S0 FP16 图像嵌入匹配静态场景 / Noul 锚点，输出与 L1 同口径的 `WorkshopPerceptionResult`；
3. 前端 L1 先出首屏态，L2 就绪后最多自动微调一次；用户已手动操作、已换图或结果置信度不足时保持 L1，任何失败静默降级。

---

## 5. 验收与测试要求

1. **单测覆盖（Node 纯逻辑）**：
   - 为 `workshopPerception.js` 新增测试（覆盖 6 类场景构造样本：白底道具图、像素网格图、4×4 序列帧图、无缝砖墙图、少色矢量图标、普通风景照，**无 `prompt` 本地导入图**的降级场景，以及**`cutout` 派生图结合 `rootPrompt` 跳过重复抠图、改推下一步工具**的联合判定），并接入 [`test/check-client-workshop-logic.mjs`](../test/check-client-workshop-logic.mjs) 或同组测试。
2. **组件渲染测试**：
   - 更新 [`test/check-client-workshop.mjs`](../test/check-client-workshop.mjs)，验证：
     - 顶栏按工具领域分栏（`平面与提取` / `游戏与 3D`）全部平铺可见，无折叠开关、无冗余「返回创作」按钮与通栏场景芯片条；
     - 完整插画自动落到 `cutout` 并在画布边缘给出可关闭的轻回流提示；
      - 像素画 / 道具图能自动高亮并落焦对应工具，参数卡示意图默认展开且可点 `?` 收起，工作流接力在画布操作区出现；
     - 无 DOM / 无 Canvas 的 Node 测试环境不报错。
3. **回归命令**：
   - `npm run test:client`
   - `npm run build`
   - 如有跨端/契约改动，同步执行 `npm run test:contract` 与 `npm run contract:check`。

---

## 6. 实施记录（Phase 1，2026-11-24）

Phase 1 已按 §4 落地，涉及文件与关键实现如下。后续阶段（L2 端侧 ONNX / L3 云端语义）尚未开始，接口与 UI 已按「L1 先出首屏态、后续就绪再异步微调」预留。

### 6.1 落地清单

| 层 | 文件 | 内容 |
| :--- | :--- | :--- |
| 契约 | [`shared/contract.js`](../shared/contract.js) | `WORKSHOP.scenes`（六类场景白名单）与 `WORKSHOP.professionalThreshold`（0.45）；二者不参与落盘、不改工具 id |
| 感知 | [`web/logic/workshopPerception.js`](../web/logic/workshopPerception.js) | L1 纯逻辑引擎：`samplePixels` / `extractPixelFeatures` / `scorePromptSignal` / `perceiveWorkshopWork` / `nextToolSuggestions` / `workshopToolGroups` / `derivedToolsOf` |
| 溯源 | [`server/output.js`](../server/output.js) | `readHistoryItem` 追加只读 `rootPrompt` / `rootPresetId`：沿 `rootImage` 读根作品 meta，`memo.contexts` 缓存，导入图与无上级根一律 null；`ROOT_PROMPT_MAX_CHARS=600` 截断 |
| 模型资产 | [`tools/build-assets.mjs`](../tools/build-assets.mjs)、[`shared/models-guide.js`](../shared/models-guide.js) | 允许 `models/*.json` 声明可选 `sceneTags`（按 `WORKSHOP.scenes` 校验、去重、非空数组），投影透传；新增 `presetSceneTags(preset)` 归一化读取。首个使用者：`anima-turbo-v1.1` → `["illustration_or_photo"]` |
| 工坊页 | [`web/studio/workshop/Workshop.jsx`](../web/studio/workshop/Workshop.jsx) | 分层工具条 + 推荐角标、场景引导条与手动覆盖、返回创作台守卫、工作流接力条、感知驱动的首屏工具落点 |
| 参数区 | [`web/studio/workshop/WorkshopParams.jsx`](../web/studio/workshop/WorkshopParams.jsx)、[`samples.jsx`](../web/studio/workshop/samples.jsx) | 可折叠工具说明卡 + 六张内联 SVG Before/After + 探测结果白话解读（折叠偏好存 `localStorage`） |
| 样式 | [`web/styles/workshop.css`](../web/styles/workshop.css)、[`responsive.css`](../web/styles/responsive.css) | 分组 / 角标 / 引导条 / 说明卡 / 接力条；980 与 520 两档窄屏适配 |
| 文案 | [`web/dict/zh.js`](../web/dict/zh.js)、[`en.js`](../web/dict/en.js) | 新增 76 个键（场景标签与理由、接力、说明卡、置信度分档） |
| 测试 | [`test/check-client-workshop-perception.mjs`](../test/check-client-workshop-perception.mjs)、[`test/helpers/workshop-samples.mjs`](../test/helpers/workshop-samples.mjs)、[`test/check-client-workshop.mjs`](../test/check-client-workshop.mjs)、[`test/host-workshop.mjs`](../test/host-workshop.mjs) | 感知 18 项、渲染 14 项、Host 15 项 |

### 6.2 与规划稿的差异（均为实施期的收敛决定）

1. **`reasonText` → `reasonKey` + `reasonParams`**：规划稿的接口把一句话解释直接写成 `reasonText`。感知层是纯逻辑模块，不该内嵌任何语言的文案，所以改为返回词典键与参数，由 UI 调 `formatText(t(key), params)` 渲染。
2. **场景标签 6 枚而非 5 枚**：规划 §2.2 的「像素与序列帧」是一个合并标签，但 `WorkshopSceneId` 本身把 `pixel_art` 与 `sprite_sheet` 分成两类；合并会让「点击后推荐什么」变得不确定。改为与 `WorkshopSceneId` 一一对应的 6 枚标签。
3. **专业度阈值统一取 0.45**：规划 §2.2 写 `< 0.4`、§3.1 接口注释写 `< 0.45`。以 §3.1 与 `WORKSHOP.professionalThreshold` 为唯一口径（§2.2 的 0.4 属早期草稿值）。
4. **提示词与模型标签只做加法**：规划 §3.2 把 `sceneTags` / 关键词并进打分表，实施时改为「图像证据归一化到 0~1 后再叠加提示词（≤0.5）与标签（0.45）」的加法模型。原因是直接并表会在**没有 prompt 的本地导入图**上系统性压低所有场景分，而这类图恰恰是最需要按像素特征判定的。
5. **网格探测分两套口径**：感知层在 256px 采样副本上探测（格距 × 采样步长换算回原图尺度，仅服务「是不是像素画」），`pixel-snap` 工具自身的格距自动填充仍走全分辨率（用户要的是可直接用的参数）。把全分辨率探测搬进感知会让 1024px 图的单次感知从 ~10ms 涨到 30ms 以上。
6. **空白图不算「少色扁平图标」**：量化后 ≤2 个色桶且几乎全平的图不携带场景信息，此时图像证据整体让位给提示词 / 模型标签；一点信号都没有时 `professionalScore` 直接为 0，且不给「返回创作台」提示（首屏像素未到位时劝退只会造成误判与闪烁）。
7. **接力先保存再切焦点**：规划 §2.2「提示保存或直接把 result 作为下一步输入」二选一，实施取前者——直接把 dataURL 当输入等于绕开作品库再存一份中间产物，先落盘再接力既有版本树可追溯，也不会丢结果。
8. **首屏默认工具改为「常用轻处理」首个**（`cutout`）而不是契约里的 `tools[0]`：像素读数到位后再按感知首推改写；用户手动点过 Tab 则不再覆盖。

### 6.3 验收结果（2026-11-24）

Phase 1a（感知底座与溯源）：

- `npm run test:client`：25/25 步通过（感知 18 项、渲染 14 项）。
- `npm run test:contract`：3/3 步通过；`npm run contract:check` 与 `npm run models:check` 均与生成物一致。
- `npm run test:host`：37/37 步通过（含工坊溯源项）。
- `npm run build`：构建通过。

Phase 1b（UI/UX 收束，2026-11-24）：

- `npm run test:client`：25/25 步通过（感知 17 项、渲染 15 项）。
- `npm run test:contract`：3/3 步通过；`npm run contract:check` / `npm run models:check` 与生成物一致。
- `npm run test:host`：37/37 步通过。
- `npm run build`：构建通过。
- 真实浏览器预览（`node tools/preview.mjs --shot --scenario=workshop-tools|workshop-dark`）：单行顶栏、分栏平铺、
  画布顶边轻提示、控件优先的参数卡在浅 / 深色两套主题下版式正常；六张 Before/After 示意图逐张核对，
  箭头头部完整、抠图后的主体不再透出棋盘格。

### 6.4 UI/UX 收束重构（Phase 1b，2026-11-24 评审修订，已完成）

Phase 1a 的 `workshopPerception.js`（L1 纯逻辑引擎）、`server/output.js`（`rootPrompt`/`rootPresetId` 溯源）、`models/*.json` 的 `sceneTags` 及接力“先落盘再切焦点”策略验收通过并保留；Phase 1a 的界面布局经评审存在顶部三层堆叠、工具被折叠隐藏、6 枚游戏向场景标签过度细碎、参数卡默认被说明占据等问题，**Phase 1b 已按 [`DESIGN.md`](DESIGN.md) §16.1 与本文 §2.2 完成重构**：

1. **顶栏瘦身与分栏全平铺**（已完成）：
   - 工具分组口径由「常用轻处理 / 游戏与 3D 专项（可折叠）」改为**按工具领域分栏全部平铺**：`平面与提取`（`cutout` / `vectorize` / `tile`）与 `游戏与 3D`（`pixel-snap` / `sprite-slice` / `pbr`），组间以轻组名与细竖线分隔，**无折叠、无下拉、无二级切换**；`workshopPerception.js` 的 `workshopToolGroups()` 同步导出 `{ plane, game3d }`；
   - 顶栏压到单行（约 46px）：移除 `.ofs-workshop-heading`（标题 + 两行副标题）与 `.ofs-workshop-back`（返回按钮，由全局 `TopBar` 承担），词典里的 `studio.workshop.title` / `subtitle` / `back` 一并删除；
   - **图标与动效**：六个工具均带 `<Icon>`，首推工具旁一枚轻量推荐点；切换工具时复用顶栏同源的 `useSlidingThumb` 滑动高亮（`--ofs-time-slide` / `--ofs-ease-spring`），左侧参数卡按 `key={tool}` 重新挂载并播一次 `--ofs-time-feedback` 切入过渡；`prefers-reduced-motion` 由 `base.css` 的全局规则降到 0.01ms，无需逐个另写。
2. **移除通栏 `.ofs-workshop-scene` 场景卡片**（已完成）：
   - 删除 6 枚场景芯片条与「手动覆盖 / 恢复自动识别」控制条，`perceiveWorkshopWork` 同步去掉 `sceneOverride` 入参与 `overridden` 出参——分类器只做内部实现，前台不再提供纠偏选择题；
   - 完整画作 / 摄影时，仅在 `.ofs-workshop-canvas-stage` 顶部边缘渲染一条半透明、可关闭（`✕`）的行内提示，带纯文字链接 `返回创作台精修 ›`，不放实心主按钮；关闭状态在换作品时复位。
3. **参数卡控件优先与 SVG 修复**（已完成）：
   - 说明改为标题行右侧 `?` 按钮开关，`readGuideOpen()` **无本地记录时默认展开**，只记忆用户显式选择；展开后依次是「一句话说明 → Before/After 示意 → 识别场景解读（`{label} · {reason}`）」，场景解读在前台第一次有落点；
   - 修复 `samples.jsx` 的 `<Arrow x="56" />` 字符串传参（`x + 5.6` 变成 `"565.6"`，箭头头部飞出画布），改为 `x={56}`，并在渲染测试里加断言防止回潮；`CutoutSample` 在棋盘格一侧先垫 `<ellipse class="ofs-ws-sample-subject-backing">` 实心底色，主体不再透出格子；
   - `ModelSelect` 许可改为标签行右侧的极小字（`{grade} · {license}`，如 `免登录 · 极速 · MIT`），去掉灰色通栏协议块；`RMBG-2.0` / `Ubisoft CHORD` 这类受限模型的提醒只在**选中它时**以紧凑警告出现（`studio.workshop.cutoutHint` / `pbrHint` 随之删除）。
4. **底栏原位接力**（已完成）：
   - 删除独立 `.ofs-workshop-handoff` 卡片行，底栏状态行右侧只放 **1 个**最匹配的接力胶囊（`继续：拆解 PBR 材质 ›`），`title` 里带「为什么推荐」与「会先保存」；点击仍走「先落盘 → 再切焦点」。
5. **第二次打磨**（2026-11-24 评审追加，已完成）：
   - **顶栏选中态与分栏**：选中项由「白底胶囊落在浅灰轨道上」（明度差约 3%，几乎看不出）改为**墨色实心胶囊 + 反白文字**，深色主题自动反相成浅色胶囊；两个领域**不再共用一条轨道**，各自一枚独立胶囊（组名在胶囊最左、与按钮之间一条 hairline），胶囊之间用留白分隔——分类一眼可辨，选中项也成为整页唯一的强焦点。
   - **以滑块承接选中态**：`useSlidingThumb` 增加「容器里没有当前项时收起滑块」的分支，两枚胶囊各持一个滑块实例；选中前的兜底样式（`.is-on` 自带墨色底）保证首帧未测量时也不会出现白字压在浅底上。
   - **最近作品高度封顶**：缩略图网格 `max-height: clamp(96px, 26vh, 208px)` + 内部滚动（允许最后一行露半格，常显细滚动条）；`本地上传` 收进该卡标题行，再省约 52px。左栏工具参数在 900px 视口下不再需要滚动。
6. **同步清理与回归**（已完成）：
   - 词典由 1298 键精简到 1277 键（删 21 个冗余键：场景芯片 / 折叠开关 / 说明标题 / 协议长文等），`workshop.css` 重写为单行顶栏 + 控件优先版式（旧的分组开关、场景卡、接力卡样式全部移除），`responsive.css` 同步收口；
   - [`test/check-client-workshop.mjs`](../test/check-client-workshop.mjs) 重写为 15 项（两枚胶囊结构、静默感知、轻提示可关闭、`?` 展开与箭头断言、底栏接力、模型许可占位符）；[`test/check-client-workshop-perception.mjs`](../test/check-client-workshop-perception.mjs) 调整 17 项（分组名改为 `plane` / `game3d`，并断言外部 `sceneOverride` 被忽略）；
   - `test:client` / `test:contract` / `test:host` / `build` 全绿，`tools/preview` 浅深色对比图重新截取。

### 6.5 底栏精简（应用即落盘）与工坊版本语义补齐（Phase 1c，2026-11-24 评审追加，已完成）

在 Phase 1b 验收基础上，进一步消除「本地应用 vs GPU 自动入库」的两套操作心智割裂，并补齐工坊产物在版本树中的独立语义（此前 `lineage.js` 会把有 `sourceImage` 的工坊产物误归类为 `img2img` 整图重绘）。

1. **移除 `.ofs-workshop-foot` 底栏，统一「预览不写盘，应用即落盘」（[`Workshop.jsx`](../web/studio/workshop/Workshop.jsx)、[`workshop.css`](../web/styles/workshop.css)）**：
   - 删除 `.ofs-workshop-foot` 整行底栏（移除「保存到作品库」与「导出 ZIP」按钮；后端 `GET /api/workshop/export` 接口保留契约不动）；
   - 本机确定性算子（`pixel-snap` / `sprite-slice` / `tile`）点「应用」后直接执行计算并调用 `saveWorkshopAsset` 落盘进作品库（调用 `actions.workshopSaved(entry)` 并选中新条目 + 全局 Toast 提示；若保存失败则保留当前预览并提示重试，不丢失结果）；
   - `vectorize` 点「生成 SVG」后同样在取回 SVG 后直接完成 `saveWorkshopAsset` 落盘（使 SVG 通道立即可切并进作品库）；
   - GPU 算子（`cutout` / `pbr`）继续提交任务并在完成后由 Host 自动落盘；排队进度或报错信息放到左栏参数操作区下方极轻单行提示或全局 Toast。
2. **工作流接力迁入画布操作区**：
   - 将原底栏唯一的 `.ofs-workshop-continue` 接力胶囊迁至画布右下角 `.ofs-workshop-canvas-actions` 同排左侧（或左栏参数主按钮下方，产出结果且有匹配下一步时才出现，最多 1 个）；
   - 由于「应用 / 运行」已经自动落盘，接力直接带着当前已保存的新作品条目切至目标工具（若来自老数据/测试注入的未保存 `result`，兜底沿用先落盘再切焦点逻辑）。
3. **补齐版本树 `workshop` 独立版本语义（[`web/logic/lineage.js`](../web/logic/lineage.js)、[`web/studio/filmstrip/VersionPanel.jsx`](../web/studio/filmstrip/VersionPanel.jsx)、[`web/studio/Filmstrip.jsx`](../web/studio/Filmstrip.jsx)）**：
   - **保留版本树归属**：工坊产物继续通过 `sourceImage` / `rootImage` 挂在来源作品的版本树下，避免同源资产散落把画廊/胶片条炸碎；
   - **`lineage.js` 独立判别**：`LINEAGE_KINDS` 增加 `'workshop'`；`buildLineage` 的 `kind` 判定顺序改为 `upscale → outpaint → inpaint → workshop (item.workshop === true || Boolean(item.workshopTool)) → (parentPath ? img2img : text)`，并在节点透传 `workshopTool` 与 `channelCount`；`pendingKindOf` 对 `job.tool === 'remove-bg' || job.tool === 'pbr'` 也返回 `'workshop'`（并附 `workshopTool`），让在途 GPU 后处理任务在版本面板幽灵行也能正确标为工坊加工；
   - **`VersionPanel.jsx` 正确展示**：新增 `workshop` 类型图标（按 `row.workshopTool` 映射或回落 `'frame'`）与中文标签（优先显示具体工具名如 `抹除背景` / `PBR 材质拆解` / `像素对齐` / `SVG 矢量` / `无缝平铺` / `序列帧切片`，缺省回落 `工坊加工`）；版本行摘要避免直接把 `"cutout"` 这类英文 slug 当作生成提示词展示，可显示工具摘要或通道数（如 `2 通道` / `4 通道`）。
4. **测试与回归同步**：
   - 更新 [`test/lineage.mjs`](../test/lineage.mjs)：覆盖 `workshop` 已完成节点（区分于 `img2img`）与 `remove-bg`/`pbr` 在途幽灵节点判定；
   - 更新 [`test/check-client-workshop.mjs`](../test/check-client-workshop.mjs)：验证无 `.ofs-workshop-foot`、应用即保存与新位置接力胶囊；
   - 补齐 `web/dict/zh.js` / `en.js` 词典键（删去失效的保存/导出按钮文案如不再使用，补齐 `studio.filmstrip.versionKind.workshop` 等），复跑 `npm run test:client`、`npm run test:contract`、`npm run test:host`、`npm test`、`npm run build` 并重截 `tools/preview` 浅深色图。

#### 6.5.1 实施记录（Phase 1c，2026-11-24）

1. **底栏移除与应用即落盘**（[`Workshop.jsx`](../web/studio/workshop/Workshop.jsx)、[`WorkshopParams.jsx`](../web/studio/workshop/WorkshopParams.jsx)、[`WorkshopStage.jsx`](../web/studio/workshop/WorkshopStage.jsx)、[`workshop.css`](../web/styles/workshop.css)）：
   - `.ofs-workshop-foot` 整行删除，保存 / 导出按钮与状态行一并移除；后端 `GET /api/workshop/export` 与 `web/api/workshop.js` 的 ZIP 下载函数保留，不在工坊界面占位。页面回到「单行顶栏 + 两栏主体」，画布与操作区吃满全高。
   - 新增 `commitResult(nextResult, toastKey)` 作为唯一落盘入口：`payloadOf(result)` 现场拼请求体（不再依赖一次 setState 往返），成功后 `setSavedResult` → `setSelected(newEntry)` → `actions.workshopSaved(entry)` → 全局 Toast（`appliedSaved` / `vectorizedSaved`），失败保留结果、在参数按钮下方留一行 `saveFailed：原因`。落盘前后用 `keepResultRef` / `keepToolOnNextWorkRef` / `selfSavedPathRef` 保住当前结果与工具：`workshopSaved` 会把宿主的 `actions.workshopEntry` 更新成新作品（分页刷新后再回灌成新的 `initialPath`），这一轮必须只同步焦点，不能把刚算出来的结果与接力一并清掉。
   - `vectorize` 的按钮文案改为 **`生成 SVG`**（`vectorizeRun` / `vectorizeBusy`），取回 SVG 后立即以 PNG 主图 + `svg` 通道落盘，通道条随即出现。
   - GPU 算子提交成功不再写提示行（排队进度由 `opRunning` 单行读数接上），失败写一行 `opFailed`；任务完成改走全局 Toast，保留「打开最新作品」兜底按钮。
2. **接力胶囊迁入画布操作区**：`.ofs-workshop-continue` 成为 `.ofs-workshop-canvas-actions` 的第一个子节点（播放 / 平铺按钮左侧），只在有结果且有匹配下一步时出现；应用即落盘后 `data-needs-save="false"`，点击不重复保存；测试注入的未落盘结果仍走「先落盘再切焦点」。
3. **版本树 `workshop` 语义**（[`lineage.js`](../web/logic/lineage.js)、[`VersionPanel.jsx`](../web/studio/filmstrip/VersionPanel.jsx)、[`Filmstrip.jsx`](../web/studio/Filmstrip.jsx)）：`LINEAGE_KINDS` 增加 `workshop`，`kind` 判定按 `upscale → outpaint → inpaint → workshop → img2img/text`；节点透传 `workshopTool` / `channelCount`；新增 `workshopToolOfJob()`（`remove-bg → cutout`、`pbr → pbr`）同时供 `pendingKindOf` 与幽灵节点使用。版本行按 `workshopTool` 选图标（`focus` / `cube` / `frame` / `film` / `images` / `sparkles`），标签优先具体工具名、缺省回落「工坊加工」，行摘要显示「工具名 · N 通道」，不再出现 `cutout` 这类英文 slug。
4. **两处体验缺陷修复**：
   - **胶囊滑动时文字与底色错位**：原实现是「墨色滑块 + 选中项文字立即反白」，滑块按 `--ofs-ease-spring` 用约 80~260ms 追上目标，这段时间新标签是白字压在浅色轨道上（滑块还会压住途经的其它标签）。改为滑块 `background: #fff` + `mix-blend-mode: difference`、胶囊 `isolation: isolate`：**文字不随选中态换色**，滑块滑到哪、哪段文字才被就地反相；浅色主题得到近黑胶囊 + 近白文字，深色主题自动反成近白胶囊 + 近黑文字。同时 `useSlidingThumb` 在「容器里没有当前项」时停用过渡，焦点换回另一枚胶囊时滑块直接落定，不再从上次的旧坐标滑进来。
   - **最近作品缩略图挤在一起**：4 列在 302px 侧栏里只剩 59px 且 `max-height` + 内部滚动会让最后一行露半格。改为 **3 列 × 2 行、最多 6 张**（`MAX_RECENT_WORKS`），行高随列宽保持方形，卡片高度恒定、不再裁切；第 7 张起提示行改为「只列最近 6 张；更多在作品库」。
5. **文案与测试**：删除 14 个失效键（保存 / 保存中 / 需先应用 / 导出四个 / 得导出提示 / 状态三键 / 未命名作品 / 应用完成 / 矢量完成），新增 `appliedSaved` / `vectorizedSaved` / `sideHintMore` / `filmstrip.versionKind.workshop` / `filmstrip.workshopChannels`，`生成 SVG` 双语文案同步，zh/en 1268 键严格同构。`test/lineage.mjs` 19 项（新增工坊节点与在途幽灵），`test/check-client-workshop.mjs` 19 项（应用即落盘成功 / 失败、SVG 落盘、GPU 参数、新位置接力、版本面板工坊行与幽灵行），`check-client-logic` 新增「底栏键已清理」断言，渲染测试新增可选的 canvas 替身（`createTestClient({ canvas: true })`）以覆盖真实编码路径。

### 6.6 切图与手动参数稳定性收口（Phase 1d，2026-11-24，已完成）

本轮继续收口 L1 基线的交互边界。原实现换图后会先用「新作品元数据 + 上一张图像素」算一次推荐，并提前标记为已完成像素落焦，导致新图真正加载后无法纠正工具；像素工具每次重新进入也会覆盖用户手动填写的格距。

1. **图像状态绑定来源**（[`Workshop.jsx`](../web/studio/workshop/Workshop.jsx)）：将源像素与作品标识、URL 一起保存，渲染时只使用与当前作品匹配的读数。切换作品与载入源图时清空格距 / 接缝 / 序列帧读数，未加载完成时收起上一张图的照片提示与像素预览；异步读图仍通过 effect 清理忽略已离开作品的返回结果。新图像素到位后可以完成自己的自动落焦，等待期间用户手选工具则保持手选结果，只更新推荐点。
2. **手动格距优先**：当前作品上编辑格距后，切换工具或迟到的像素检测均保持用户值；「自动探测」是显式重新采用检测值的入口，换作品后允许重新自动检测。自动采用格距要求 `cell > 1 && confidence >= 0.55`，普通照片建筑线条的弱周期只显示低置信度提示，避免自动把画面缩成粗格像素预览。
3. **旧作品的先验兜底**（[`workshopPerception.js`](../web/logic/workshopPerception.js)）：新增纯函数 `resolveWorkshopRootContext(item, works)`，Host 已提供的非空 `rootPrompt` / `rootPresetId` 逐字段优先；缺失字段按已加载图库里精确匹配的 `rootImage` 补齐，首屏同步推荐与后续 L1 重算共用该上下文。根图尚未加载时安全降级，导入根图与工坊保存的作品名不作为语义意图，也不修改作品记录。
4. **验收当前工作区版式**：承接现有画布上方提示 / 下方操作区、作品区与参数区独立滚动布局，在真实 Chromium 中核对浅色 `1440×900` 的 86 张作品场景、浅色最小窗口与深色 `900×560` 的六工具。深色六工具说明展开时，提交区底边均在约 `539px`，画面高度约 `292–327px`，整页无横向溢出；真实浏览器中将格距改为 `7`，切到平铺再切回，仍保留 `7`。

验证结果：

- `node test/check-client-workshop.mjs`：**24/24**，新增切图等待 / 手选优先 / 格距跨工具及迟到检测 / 显式探测及换图重置 / 根作品先验 / 低置信度建议回归。
- `node test/check-client-workshop-perception.mjs`：**19/19**，新增 Host 优先、根图缺失 / 导入 / 工坊作品名降级与无数据修改断言。
- `node test/check-client-workshop-logic.mjs`：**13/13**；`npm run test:client`：**26/26 步**全组通过，随后新增低置信度边界再次通过工坊专项回归。
- `npm run build:web`：通过；已有的大 bundle 体积提示仍保留。

### 6.7 端侧 L2 视觉感知（Phase 2，2026-11-25，已完成）

Phase 2 的目标不是把工坊变成「会说话的视觉模型」，而是在不拖慢首屏、不改变工具链的前提下，为无 prompt 的导入图和复杂语义补一层异步证据。实现严格保留 L1 的首屏地位，并允许 L2 在任何环节失败时完全消失。

1. **契约与数据面**（[`shared/contract.js`](../shared/contract.js)、[`shared/workshop-scenes.js`](../shared/workshop-scenes.js)）：
   - 新增 `ROUTES.workshopPerceive` 与 `WORKSHOP.vision`：固定模型 `mobileclip-s0-fp16`、revision、下载 URL、字节数、SHA-256、输入 256、`maxBodyBytes=384 KiB`、场景置信度 `0.5`、margin `0.12`、Noul 可信间隔 `0.66`、下载超时与失败冷却。
   - 新增 `vision_unavailable`（Host 503）：只表示可选 L2 不可用，不进入任何工具失败路径。
   - `shared/workshop-scenes.js` 统一场景 → 工具 / 专业度 / Noul / 推荐排序，避免客户端 L1、Host L2 和测试各写一套。
2. **客户端输入**（[`web/studio/workshop/pixels.js`](../web/studio/workshop/pixels.js)、[`web/api/workshop.js`](../web/api/workshop.js)）：
   - `workshopVisionPixels()` 把 RGBA 透明像素合成白底，短边缩到 256、长边中心裁切，使用双线性采样，输出 256×256×3 的裸 base64；不携带 dataURL、作品路径、prompt 或版本树。
   - 请求失败返回普通错误对象，由工坊静默丢弃；请求体严格限制在 `WORKSHOP.vision.maxBodyBytes`。
3. **Host 推理**（[`server/workshop-vision.js`](../server/workshop-vision.js)、[`server/routes/workshop.js`](../server/routes/workshop.js)）：
   - 只接受并解码 256×256 RGB；`decodeWorkshopVisionPixels()` 校验尺寸、base64 字符集与精确字节数，`workshopVisionTensor()` 转 NCHW float32 / 255。
   - 视觉模型是 MobileCLIP-S0 FP16 ONNX；首次按固定 URL 下载，校验字节数与 SHA-256 后原子落盘到 `<workspace>/.aigc-studio/models/mobileclip-s0/`，Session 复用、CPU 推理串行，失败后 60 秒冷却。
   - 文本编码器不在运行时加载；六类场景与六个 Noul 的正 / 负文本锚点在开发期生成、int8 量化并固化为 [`shared/workshop-vision-anchors.generated.js`](../shared/workshop-vision-anchors.generated.js)（约 14 KB）。输出强制 512 维，锚点缺失 / 维度不符即失败。
   - 环境变量：`AIGC_STUDIO_WORKSHOP_VISION=0` 完全关闭；`AIGC_STUDIO_WORKSHOP_VISION_MODEL=<path>` 覆盖本地模型。安装包不携带权重；`onnxruntime-web@1.22.0` 的 Node ESM 入口与单线程 WASM 已在 [`electron-builder.yml`](../electron-builder.yml) 白名单中随包分发（`asar: false`）。
4. **渐进融合与交互保护**（[`web/logic/workshopPerception.js`](../web/logic/workshopPerception.js)、[`Workshop.jsx`](../web/studio/workshop/Workshop.jsx)）：
   - L1 同步先落焦；L2 effect 以 `sourcePixels + selectedKey + sourceUrl` 键控，换图立即 abort，响应回来时再以像素对象身份确认，旧结果不会串到新图。
   - 用户手动点过工具后，迟到 L2 整体丢弃（连推荐点也不更新）；相同作品只允许一次 L2 自动落焦（`l2:<作品键>`），展开说明 / 其它重渲染不会再改工具。
   - 场景覆盖要求 `top1 ≥ 0.5`、`top1-top2 ≥ 0.12`，且不推翻 L1 的确定性证据；已经确认像素画、像素格、序列帧格线、透明通道、接缝或白底主体时保持 L1。Noul 只在各自证据门槛内加分，已抠图 / 已 PBR 的派生状态仍优先去重。
   - 任何失败都不写参数区状态、不弹 Toast、不影响工具链；客户端展示仍完全可用。
5. **验收**：
   - `node test/host-workshop-vision.mjs`：**10/10**，覆盖输入校验 / NCHW、512 维分类、固定模型缓存、单飞下载、SHA / 字节数失败与冷却、开关、HTTP 路由成功 / 400 / 503，以及本机存在真实模型时的一次 FP16 前向（默认 CI 不下载）。
   - `node test/check-client-workshop.mjs`：**29/29**，新增 L1 先落焦、L2 单次微调、用户手选后忽略、换图丢弃旧响应、失败静默保留 L1；`node test/check-client-workshop-perception.mjs`：**25/25**，新增 6 项融合 / 输入边界。
   - 真实素材评估：场景回归约 **31/51**，Noul 精选标签 **27/27**；后者来自有限的精选样本，不能外推为通用准确率。
   - 全组回归：`npm run test:client` **26/26 步**、`npm run test:contract` **15/15 步**、`npm run build` 通过；`npm run test:host` **37/38 步**，工坊相关 `host-workshop` **15/15**、`host-workshop-gpu` **9/9**、`host-workshop-vision` **10/10**。唯一失败为 `smoke-image` 的单实例锁：本机已有 AIGC Studio 在运行，冒烟进程按设计输出 `SMOKE_FAIL another-instance-running`，与 Phase 2 无关。
   - 安装形态：`electron-builder --dir` 在独立输出目录成功生成 Windows 解包版，确认 `server/workshop-vision.js`、ORT ESM 入口 / WASM 及其 `onnxruntime-common` 依赖均在包内；默认输出目录因旧安装树被占用（`EBUSY`）未覆盖，不影响本次校验。
6. **模型限制与边界**：
   - FP16 单次前向在本机 Node 约 **235 ms**，因此只做异步视觉补证，不参与首屏同步决策。
   - 权重受 **Apple ML-MobileCLIP License** 约束；契约标记 `license.kind: "other"`、`commercial: "unverified"`，文档与界面不得宣称可商用。
   - Host 不认识作品目录、不会读原图；隐私边界是「当前画面的 256×256 RGB」。是否允许首次联网下载模型由用户环境 / 镜像配置决定，失败即保持纯 L1。

### 6.8 感知打标持久化与切图零跳动收口（Phase 2.5，待实施）

#### 6.8.1 问题与第一性原理诊断

1. **切图重复计算开销**：目前每次在工坊切换「最近作品」都会完整重跑 `pixelsOfUrl` 全图解码 + L1 特征提取，并清空 `vision` 重跑一遍 Web Worker `MobileCLIP-S0`（约 200–350ms）。哪怕来回对比刚刚看过的两张图，也会重复解码与推理。
2. **无像素阶段纯 prompt 先验的数学失衡**：[`perceiveWorkshopWork()`](../web/logic/workshopPerception.js) 在有像素时给普通图（`illustration_or_photo`）约 `0.85` 的图像基础分，单个提示词关键词只加 `+0.14`，不足以翻盘；但当 `pixels === null`（图片尚未解码完成）时，`evidence` 为空 `{}`（6 类场景基础分全为 `0`），只要提示词中出现 1 个模糊词（如海报提示词中的 `"paper grain texture"` 命中 `'texture'`、或 `"brick wall"` 命中 `'brick'`），经 `SCENE_TEMPERATURE = 0.12` softmax 放大就会得到 `professionalScore ≈ 0.654`（越过 `0.45` 阈值），在首屏/切图瞬间把工具或推荐点先切到 `tile`，几毫秒后像素解码完成再回调回 `cutout`——造成「抹除背景 ↔ 无缝平铺」快速来回跳动。
   > **原则**：不能靠逐个删改 `PROMPT_TERMS` 词表做“打地鼠式”补丁（已临时收窄 `'texture'` 的特判应在本阶段架构落地后还原，改由下面的权重模型与持久化机制根治）。

#### 6.8.2 核心设计原则

1. **已打标作品 0ms 一次落焦**：将轻量感知结果持久化到作品自己的 `meta.json` 并配前端内存缓存，切换作品首帧直接读取已定型结论，跳过 `null → L1 → L2` 多阶段跃迁与重复 ONNX 推理。
2. **冷启动不靠纯文本抢跑**：对尚未打标的历史旧图或刚生成的新图，在像素未就绪前仅采信确定性硬先验（`doneTools` / `preset.sceneTags`），**禁止单靠纯 prompt 关键词把无像素阶段拉过 `professionalThreshold`**；等真实像素 + L2 算完后一次性落定并写盘。
3. **版本可控、失效自动重算**：标签必须携带版本签名（`version`），后续调优 L1 阈值或更换 L2 模型/锚点时自动失效重算并覆写，不留陈旧结论。
4. **隐私与增量不变**：L2 推理仍完全在渲染进程 Web Worker 内完成（不回传原图或 512 维向量），仅回写几百字节的纯局部标签摘要到本机 `meta.json`。

#### 6.8.3 持久化契约与数据模型（`shared/contract.js`、`server/output.js`）

1. **版本常量**：在 [`shared/contract.js`](../shared/contract.js) 的 `WORKSHOP.vision`（或新增 `WORKSHOP.perception`）登记 `tagVersion`（正整数，初始 `1`；任何 L1/L2 判定口径或静态锚点变更时递增）。
2. **`meta.json` 轻量字段 `workshopPerception`**（仅存最终决策摘要，禁止存入像素直方图或 512 维 embedding）：

   ```ts
   interface WorkshopPerceptionTag {
     version: number            // 必须等于 WORKSHOP.perception.tagVersion
     source: 'l1-heuristic' | 'l1+l2'
     model: string | null       // L2 已融合时记 model id（如 'mobileclip-s0-fp16'），纯 L1 为 null
     scene: WorkshopSceneId
     professionalScore: number  // [0, 1]
     recommendedTools: WorkshopToolId[] // 1~3 项，均在 WORKSHOP.tools 内
     showStudioReturnHint: boolean
     noul: {
       needsCutout: number
       isGridSprite: number
       isPixelGrid: number
       isTileable: number
       isVectorFriendly: number
       wantsPbr: number
     }
     updatedAt: string          // ISO 时间戳
   }
   ```

3. **读取透传（[`server/output.js`](../server/output.js) `readHistoryItem`）**：
   - 从 `meta.workshopPerception` 读取并按契约白名单归一化；
   - 缺失、格式非法、或 `version !== WORKSHOP.perception.tagVersion` 时统一返回 `null`（触发客户端按冷启动重算刷新）；
   - [`server/workshop.js`](../server/workshop.js) 的 `saveWorkshopAsset` 创建工坊新产物时不继承父图 `workshopPerception`（加工后图像特征已改变）。

#### 6.8.4 Host 持久化路由（`shared/contract.js`、`server/routes/workshop.js`、`server/workshop.js`）

1. **新增路由**：`ROUTES.workshopTag` → `POST /api/workshop/tags`，请求体 `{ path: string, tag: WorkshopPerceptionTag }`。
2. **安全与幂等逻辑**：
   - `path` 经 `resolveOutputPath(ctx, path)` 校验必须位于 `outputs/` 内，并定位所属目录的 `meta.json`；
   - 服务端按契约白名单校验 `tag`（`version` 必须匹配当前 `tagVersion`、`scene` 命中 `WORKSHOP.scenes`、`recommendedTools` 过滤非法项、`noul` 数值夹在 `[0, 1]`、忽略未知字段防膨胀）；
   - 读取现有 `meta.json`：若已有同 `version` 且 `source === 'l1+l2'` 的标签而新请求只是 `'l1-heuristic'`，直接返回 `200` 不降级覆盖；
   - 仅更新 `meta.workshopPerception`，通过 `writeFileAtomic` 原子写回，绝不修改 `createdAt`、`params`、`images` 等既有字段。
3. **静默容错**：写盘失败时客户端静默忽略，仅记录 warn 日志，不影响工坊编辑与保存主流程。

#### 6.8.5 客户端感知权重与缓存调度（`workshopPerception.js`、`Workshop.jsx`、`pixels.js`）

1. **修复无像素纯 prompt 权重失衡（[`web/logic/workshopPerception.js`](../web/logic/workshopPerception.js)）**：
   - 当 `pixels === null` 且无 `preset.sceneTags`、无 `doneTools` 时，不得因单一/普通 prompt 命中就压过默认基线并越过 `professionalThreshold`（可为无像素无硬标签场景保留 `illustration_or_photo` 基础先验，使单一 `+0.14` 提示词仅作微调而不足以反客为主）；
   - 同步还原此前在 `PROMPT_TERMS` 里针对 `'texture'` 的临时词表特判，验证 `"paper grain texture"`、`"brick wall"`、`"sword"` 等含常规关键词的普通画面在无像素时均不会抢切工具。
2. **两级缓存与静默回填（[`web/studio/workshop/Workshop.jsx`](../web/studio/workshop/Workshop.jsx)、[`pixels.js`](../web/studio/workshop/pixels.js)）**：
   - **持久化命中**：切图时优先读取 `selected.item.workshopPerception`（`version` 有效）或前端内存 `perceptionCache`：
     - 命中 `l1+l2` → **0ms 直接定型** `recommendedTools`、`showStudioReturnHint` 与默认工具（未手选锁定且非接力时），**不再触发 L2 Worker 推理**；
     - 命中 `l1-heuristic`（且本机 L2 可用）→ 首帧直接用它落焦不闪烁，同时异步补跑一次 L2；若 L2 改写了结论再静默升级并回写 `l1+l2`；
   - **未命中（冷启动）**：`sourcePixels === null` 期间保持现有安全态（不按未核验 prompt 闪切推荐点或工具），等 `pixelsOfUrl` + L1 + L2 算完后一次性落定，写入内存 `perceptionCache` 并异步调用 `POST /api/workshop/tags` 持久化（同时刷新当前条目的内存缓存引用，确保当前会话切走再切回立刻 0ms 命中）；
   - **像素级缓存**：为 `pixelsOfUrl` 增加小容量内存 LRU（如最近 6~8 张作品或按字节上限控制），服务 `pixel-snap` 自动探测、`tile` 接缝 MAE 与 `sprite-slice` 切帧，避免同一张图来回切换时反复解码 `<canvas>`。

#### 6.8.6 验收与回归要求

1. `test/check-client-workshop-perception.mjs`：
   - 还原词表特判后，验证 `pixels: null` 下仅含单个弱关键词（`"paper grain texture"` / `"brick wall"` / `"gold sword"`）的提示词不会越过 `professionalThreshold` 切走默认工具；而同时带 `sceneTags` 或 `doneTools` 的先验仍生效；
   - 验证持久化 `workshopPerception` 的版本不匹配降级与归一化边界。
2. `test/host-workshop.mjs`：
   - 覆盖 `POST /api/workshop/tags`：合法写入 + `readHistoryItem` 读回、跨目录/越界 `path` 拒绝、非法字段/过期 `version` 拒绝、不降级覆盖已有 `l1+l2`、不破坏既有 `meta.json` 字段。
3. `test/check-client-workshop.mjs`：
   - 覆盖已有有效 `workshopPerception` 的作品切换时 0ms 直接落焦且不发起重复 L2 推理；
   - 覆盖未打标作品冷启动不闪切、算完后异步触发 `POST /api/workshop/tags`、再切回直接命中缓存；
   - 全量执行 `npm run test:contract`、`npm run test:client`、`npm run test:host` 与 `npm run build`。

### 6.9 后续阶段（未开始）

- **Phase 3**：已配置 LLM / Ollama / Jev API 的用户可选开启高阶语义建议（如自动估算序列帧 `rows × cols`），任何超时或失败静默回退 L1；不改变 Phase 2 / 2.5 的本地默认路径。
