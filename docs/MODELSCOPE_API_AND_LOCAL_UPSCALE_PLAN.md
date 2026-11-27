# ModelScope 在线能力扩展与本机端侧超分放大规划

> **定位**：承接 M3.5（ModelScope `API-Inference` 与 Hub 下载源首期接入）完成后的第二阶段增量能力，明确哪些工具适合走 **ModelScope 在线推理**、哪些能力转向 **本机端侧 ONNX 小模型**，以及哪些继续保留给 **自部署 GPU Worker**，为后续编码实施提供可直接落地的契约与边界。  
> **上位文档**：[`ROADMAP.md`](ROADMAP.md)、[`CLOUD_API_AND_AGENT_EXPLORE_PLAN.md`](CLOUD_API_AND_AGENT_EXPLORE_PLAN.md)、[`LOCAL_INFERENCE_AND_MODELS_PLAN.md`](LOCAL_INFERENCE_AND_MODELS_PLAN.md)  
> **制定日期**：2026-11-27。
>
> **实施状态（2026-11-27）**：S1 / S2 / S3 已全部落地。端侧权重采用 [`skillsafe-ai/realesrgan-x2plus`](https://huggingface.co/skillsafe-ai/realesrgan-x2plus) 的可复现 ONNX（FP16 33,771,615 B / FP32 67,076,136 B，SHA-256 已锁定）；固定 192px 瓦片、32px overlap 与 Hann 融合在 `web/logic/localUpscale.js`，结果经 `POST /api/local-upscale` 按标准 `upscale` 子版本落盘。AMD Radeon RDNA 3 无头 Chromium 实测 256×192 源图、2 块瓦片：WebGPU FP16 4.99s / WASM FP32 31.05s，均成功落盘且无可见接缝。

---

## 1. 实测调研基线（2026-11-27 实测结论）

针对 ModelScope `API-Inference`（`https://api-inference.modelscope.cn/v1`）及其 Hub 模型目录，使用真实 API Key 与公开 Hub 元数据 API 探测后的客观边界如下：

1. **API 形态唯一**：仅提供异步 `POST /v1/images/generations`（配合 `image_url` 支持 Base64 `data:` URI 数组、`loras` 支持字符串或权重字典）；`/v1/images/edits` 与 `/v1/images/variations` 均返回 `404`，请求中携带 `mask` 字段会被服务端忽略（仍按普通图生图执行）。
2. **专用小模型未上线 `API-Inference`**：`iic/cv_fft_inpainting_lama`、`black-forest-labs/FLUX.1-Fill-dev`、`DiffSynth-Studio/Qwen-Image-Blockwise-ControlNet-Inpaint`、`muse/RealESRGAN_*`、`iic/cv_rrdb_image-super-resolution`、`bilibili/cv_bilibili_image-super-resolution`、`briaai/RMBG-*`、`modelscope/BiRefNet` 的 `SupportInference` 均为空。
3. **可调用且实测通过的在线替代路径**：
   - **扩图（`outpaint`）**：`black-forest-labs/FLUX.2-klein-4B` + `loras: "fal/flux-2-klein-4B-outpaint-lora"`，与本项目 [`OUTPAINT_ENGINE`](../shared/contract.js#L290-L300) 的 `#00FF00` 绿边画布法完全同源；实测 `1024x1024`（`~9.9s`）与 **`1536x1024`（`~9.3s`）** 均直接 `SUCCEED`。备选 `Qwen/Qwen-Image-2.1` + `ausboss/Qwen-Image-2.1-Outpaint-LoRA`（`#808080` 灰边画布法）亦可 `SUCCEED`，但耗时 >73s。
   - **语义局部编辑（非像素 Mask 重绘）**：`Qwen/Qwen-Image-Edit` / `2509` / `2511`（可搭配 `lightx2v/Qwen-Image-Edit-2511-Lightning`）支持 `img2img`，`Qwen-Image-Edit-2511` 实测可在 `2048x2048` 下 `SUCCEED`（耗时 >75s）；适合自然语言改图，不能替代像素级冻结蒙版 `inpaint`。
   - **扩散清晰化（不建议平替超分）**：`MusePublic/FLUX.1-Kontext-Dev` + `DiffSynth-Studio/FLUX.1-Kontext-dev-lora-highresfix`（`1024x1024` 约 `29.6s`、`2048x2048` 超过 `45s` 未收敛）与 `Qwen-Image-Edit-2511` + `Upscale2K` LoRA 本质是扩散重采样，慢、耗魔粒额度且会轻微重绘五官与文字，**不适合替代确定性 `Real-ESRGAN` 超分**。
   - **背景抠图（不建议走在线扩散）**：`FLUX.2-klein-4B` + `fal/flux-2-klein-4B-background-remove-lora` 实测返回纯 RGB 图（PNG `colorType=2`，无 Alpha 透明通道）；本项目已有本机 `RMBG-1.4` ONNX（WebGPU 约 `0.5–1.3s`），无需云端替代。

---

## 2. 第一性原理能力矩阵：三轨收敛分工

| 能力 | 推荐执行路径 | 为什么不走其余路径 |
| :--- | :--- | :--- |
| **扩图 (`outpaint`)** | **ModelScope `API-Inference`**（零开机 ~9s）+ GPU Worker（兜底/无限额） | 与项目 `OUTPAINT_ENGINE` 方案同源，绿边画布 + `fal` LoRA 在线实测直接跑通 |
| **语义改图（文字指令修图）** | **ModelScope `API-Inference`**（`Qwen/Qwen-Image-Edit-2511` / `FLUX.2-klein-4B/9B`） | 通过 `referenceImages` + Prompt 发挥编辑大模型优势，不占用本地/云卡显存 |
| **画笔蒙版局部重绘 (`inpaint`)** | **GPU Worker**（`inpaint` 通道） | 在线接口无 `mask` 参数、无原生 Inpaint ControlNet，强行模拟会误改蒙版外像素 |
| **高清放大 (`upscale`)** | **本机端侧 ONNX 小模型（新增主力）** + GPU Worker `realesrgan-x2plus`（高分辨率大图/CUDA 极速路径） | `Real-ESRGAN` 仅几十 MB、单次前向确定性无幻觉，最适合按瓦片下沉到本机 WebGPU/CPU 运行 |
| **抠图 / 矢量化 / PBR** | 抠图走**本机 `RMBG-1.4`**（高质量选 Worker `BiRefNet`/`RMBG-2.0`）；矢量化走**本机 WASM**；PBR 留给 **GPU Worker** | 避免在线扩散破坏原图或拿不到 Alpha/多物理通道 |

---

## 3. 专题一：ModelScope 在线扩图（`outpaint`）

### 3.1 协议与服务端改动

1. **能力位扩展（[`shared/image-providers.js`](../shared/image-providers.js) + [`server/image-api.js`](../server/image-api.js)）**：
   - 在 `modelscope` 的 `black-forest-labs/FLUX.2-klein-4B` 上补充 `supportsOutpaint: true` 与默认扩图配置（或复用 `OUTPAINT_ENGINE.lora.repo = 'fal/flux-2-klein-4B-outpaint-lora'`）。
   - 注意调整/区分 `FLUX.2-klein-4B` 的画幅限制：常规参考图上限保持 `1024`，但**扩图模式实测可接受 `1536x1024`**（1.57 MP），需在校验层显式按像素总量（`<= 1_600_000`）与长边（`<= 1536`）放行扩图画布，对齐 [`OUTPAINT`](../shared/contract.js#L262-L281)。
   - `server/image-api.js` 的 `buildModelScopeRequest()` 支持透传可选 `loras` 字段（仅由受控的内部工具路径如 `outpaint` 或显式 `lora` 挂载注入，不暴露任意不可信 JSON 注入）。
2. **队列分流（[`server/jobs/queue.js`](../server/jobs/queue.js)）**：
   - 当 `provider.kind === 'cloud-api'` 且 `vendor === 'modelscope'` 且任务为 `tool === 'outpaint'` 时，不再一律以 `image_api_unsupported` 拒绝；改为自动切换/调用 `black-forest-labs/FLUX.2-klein-4B`（携带绿边图 `referenceImages[0]`、`loras: 'fal/flux-2-klein-4B-outpaint-lora'` 与 `OUTPAINT_ENGINE.prompt`）提交异步生成。
   - **可选像素回贴保真**：如后续实测发现 `API-Inference` 对 `outpaintContent` 原图区域存在轻微色偏/锐度损失，可在前端或 Host 落盘前根据 `outpaintContent`（`x, y, width, height`）把源图以 `4–8px` 边缘羽化回贴，确保原图区域零漂移（严格保持 Host 零 sharp/jimp 依赖原则：若做像素回贴则放在浏览器 `<canvas>` 完成）。

### 3.2 前端入口与交互

- 在舞台下方图像工具栏 `扩图`（[`web/logic/imageTool.js`](../web/logic/imageTool.js)）：当后端为 `cloud-api` 且厂商为 `modelscope` 时解锁可用，明确提示使用 `ModelScope · FLUX.2 Klein 4B Outpaint LoRA` 并消耗魔粒额度；非 `modelscope`（且无本机端侧能力）仍保持显式引导提示。

---

## 4. 专题二：ModelScope 语义编辑模型接入（`Qwen/Qwen-Image-Edit-2511`）

1. **目录登记（[`shared/image-providers.js`](../shared/image-providers.js)）**：
   - 新增 `Qwen/Qwen-Image-Edit-2511`（`supportsReference: true`、`supportsSteps: true`、`supportsNegative: true`、`maxEdge: 2048`、`steadySeconds` 按实测设置约 `60–75s` 提示，或评估配合 `lightx2v/Qwen-Image-Edit-2511-Lightning` 降步数）。
2. **语义定位与边界**：
   - 在模型描述与 UI 能力角标上明确区分**「语义编辑（支持参考图改图）」**与**「画笔蒙版局部重绘（需 GPU Worker）」**，不将其伪装为 `mask` inpaint，避免用户画涂抹蒙版后发现周围被微调。
   - 在 Agent Prompt 路由层告知创作助手：云端 `modelscope` 下做整图风格/物体替换优先选用 `Qwen-Image-Edit-2511` 或 `FLUX.2-klein-9B` 参考图编辑，不触发无蒙版的“强行 `imagen_inpaint`”。

---

## 5. 专题三：本机端侧超分放大（`local-upscale`，ONNX 小模型）

### 5.1 核心可行性结论（为什么小模型完全可以在本机运行）

- 本项目后端现用的 `RealESRGAN_x2plus` 仅有 **67 MB**（[`worker/inference/upscale.py`](../worker/inference/upscale.py) 实测精确大小 `67,061,725` 字节），本身就是单次前向、无迭代步数的纯卷积小模型（`RRDBNet`），**并不依赖重型扩散推理栈**。
- 与项目已落地的端侧抠图（`RMBG-1.4`，FP16 88 MB，AMD Radeon 880M WebGPU 下稳态 `0.54s`）同属第一层轻量单次前向模型，完全可以并入 **`shared/local-models.js` + `server/local-models.js` + `localInference.worker.js`（`onnxruntime-web`）** 体系，实现**零云端开机、零 Python 依赖、offline/cloud-api 模式下直接本地 2× 高清放大**。

### 5.2 与 `RMBG-1.4` 的关键工程差异（必须做 Tile 分块）

| 对比维度 | 端侧抠图（`RMBG-1.4`） | 端侧超分（`Real-ESRGAN` / 轻量超分 ONNX） |
| :--- | :--- | :--- |
| **输入方式** | 固定缩放到 `1024×1024` 一次前向，输出 Alpha 再双线性缩回原图 | **不能先缩小原图**，必须保留原始像素做 `2×` 超分 |
| **内存与显卡风险** | 固定 `1024²` 张量，显存可控 | 23 层 `RRDBNet`（64 通道）若整图送 `1280×720` 或 `1024×1024`，中间特征图会超浏览器 WebGPU `maxStorageBufferBindingSize` 并卡死 WASM CPU |
| **解法（必选）** | 单次全图推理 | **固定尺寸瓦片分块（Tiled Inference + Overlap Blending）** |

具体工程约束如下：
1. **固定瓦片网格与 Overlap 拼接**：
   - 将原图切分为固定大小的 Tile（推荐输入瓦片 `192×192` 或 `256×256`，四周带 `16px` reflect padding / overlap，经 `2×` 超分后裁去重合边缘或按线性/余弦权重做接缝融合）。
   - **固定静态 Shape 的红利**：`[1, 3, H_tile, W_tile]` 恒定不变，WebGPU只需编译一次计算图并复用缓冲，规避动态 Shape 编译抖动，且显存峰值可控在轻量核显安全线内。
   - **进度回报与可取消**：每完成一块 Tile 向 UI 回报真实进度百分比（`tile i / total`），且支持中途 `AbortSignal` 取消。
2. **ONNX 模型选型原则**：
   - **首选纯 CNN 超分家族（对 WebGPU / WASM 最友好）**：
     - 路线 1（质量对齐现有 Worker）：基于项目已锁 SHA-256 的 BSD-3-Clause `RealESRGAN_x2plus.pth`（或社区已验证如 `TheGuy444/Real-ESRGAN-ONNX` 等）导出 **FP16 ONNX（约 33 MB）+ FP32/INT8 兜底 ONNX**，锁定精确 `bytes` 与 `sha256` 后托管发布；
     - 路线 2（极速轻量化可选档）：`realesr-general-x4v3`（仅 ~5 MB 级别轻量卷积）或 `RealESRGAN_x4plus_anime_6B`（仅 6 个 RRDB 块，约 17 MB，适合二次元/像素插画低配 CPU 极速放大）。
   - **暂不首选 `Swin2SR` ONNX**：虽然 HuggingFace 存在 `Xenova/swin2SR-classical-sr-x2-64`、`onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr-ONNX`（Apache-2.0），但其基于 Shifted Window Attention，在 `onnxruntime-web` WASM 下算子开销显著高于纯卷积 `RRDBNet`，且对分块边界倍数较敏感。
3. **双轨协同与降级策略**：
   - **端侧优先，Worker 并发补位**：用户本地已下载/启用端侧超分 ONNX 且未停用时（遵循 `disabledLocalModels`），在 `cloud-api`、`local-gpu` 或尚未开机连 GPU Worker 的状态下点击「放大 2×」直接本地执行，不强制开机等待；
   - 若用户已开启高性能远程 CUDA GPU Worker（如 Kaggle 2×T4 / RunPod / 私有工作机），可按设置或大图阈值提供「远端 GPU / 本机端侧」明确指示；
   - 保持端侧分块放大上限与 [`UPSCALE`](../shared/contract.js#L244-L250) 口径一致（默认 `maxInputEdge: 1280` → `maxOutputEdge: 2560`，WASM 无 WebGPU 慢设备给出耗时预估提示）。

---

## 6. 建议实施顺序与编码验收清单

| 阶段 | 内容 | 核心涉及文件 | 验收标准 |
| :--- | :--- | :--- | :--- |
| **S1：ModelScope 在线扩图（已完成）** | `FLUX.2-klein-4B` `supportsOutpaint`、受控 `loras` 注入、扩图 `1536×1024` 放行、`JobQueue` 分流、舞台 `扩图` 解锁 | `shared/image-providers.js`、`server/image-api.js`、`server/jobs/queue.js`、`web/logic/imageTool.js`、`test/cloud-api.mjs` | 在 `cloud-api`（`modelscope`）选中作品可提交 `outpaint`，生成图按版本树落盘（`tool='outpaint'`、`outpaintContent` 完整）；离线单测全绿 |
| **S2：ModelScope 语义编辑补充（已完成）** | 登记 `Qwen/Qwen-Image-Edit-2511`，区分“语义编辑”与“Mask 局部重绘”能力提示及 Agent 选型规则 | `shared/image-providers.js`、`server/agent/prompt.js`、`web/studio/ModelCardPicker.jsx`、`web/dict/*.js` | 选择 `Qwen-Image-Edit-2511` 可提交参考图语义改图；模型卡显示“语义编辑 · 非蒙版” |
| **S3：本机端侧 ONNX 超分（已完成）** | `shared/local-models.js` 登记 FP16 / FP32 模型（锁 bytes & SHA-256）、`web/logic/localUpscale.js` 实现瓦片 / 融合 / 进度 / 取消、`POST /api/local-upscale` 标准落盘、舞台入口衔接 | `shared/local-models.js`、`server/routes/local-upscale.js`、`web/logic/localUpscale.js`、`web/studio/hooks/useImageTool.js`、`test/host-local-upscale.mjs` | 无远端 GPU Worker 时（含 `cloud-api` 模式）可完成本机 `2×` 无黑边融合并落盘子版本（`upscale: true`）；离线单测与构建通过 |
