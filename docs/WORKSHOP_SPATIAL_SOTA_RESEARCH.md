# 工坊空间能力后续调研：端侧分层、轻量感知与单图新视角

> **调研日期**：2026-11-27；只纳入截至该日已公开的资料。<br>
> **状态**：第一轮模型/软分层实验见 §8；2026-11-28 第二轮实际客户端预处理、原推理 Worker 与自适应参考实验见 §9。已修复正式空间滤镜换图缓存碰撞；研究原型和 ZipDepth 尚未替换产品默认管线。<br>
> **接续**：[`WORKSHOP_DEPTH_AND_LIGHTING_PLAN.md` §8](WORKSHOP_DEPTH_AND_LIGHTING_PLAN.md#8-空间滤镜-gpu-管线升级与-25d-视差收口记录2026-11-27)、[`WORKSHOP_RELIGHT_UPGRADE_PLAN.md`](WORKSHOP_RELIGHT_UPGRADE_PLAN.md)、[`WORKSHOP_HYBRID_COMPUTE_PLAN.md`](WORKSHOP_HYBRID_COMPUTE_PLAN.md)。<br>
> **路线图归属**：[`ROADMAP.md`](ROADMAP.md) **M4.2h 空间滤镜成熟化与轻量端侧感知**；2026-11-28 本轮收口，后续未完成项保留在该条目。

## 1. 结论与推进顺序

下一阶段优先把现有空间玩法做成可持续复用的客户端能力：**先验证软 Alpha 分层、前景颜色恢复和二维遮挡补全，再评估更轻的感知模型，最后开放生成式高质量档。**

| 顺序 | 研究任务 | 给用户的实际收益 | 本轮判断 |
| --- | --- | --- | --- |
| P0 | 固定视差评测集；补齐深度精度、像素对齐和预览/保存一致性约束 | 切换作品、保存重开、改变运动方向后仍保持一致 | 先建立基线，避免用模型指标掩盖资产链路损失 |
| P1 | Soft-LDI / 深度网格 + Alpha matting + 前景颜色恢复 + 深度约束的二维 Pull-Push | 发丝、衣肩、栅栏和斜向运动减少黑边、裂缝、条纹 | 两层原型在柔边/发丝合成图有收益，在复杂场景失效；继续研究自适应层与结构补全，不替换默认 |
| P1 | ZipDepth 对照 DA3-Small | 减少模型等待与设备开销，探索视频感知基础 | FP32 已通过四图浏览器数值检查且速度优势明显；部分几何画质退步，保留候选，默认仍为 DA3-Small |
| P2 | 浏览器 LaMa 补全适配；ShadeNet 近似去光/法线实验 | 更大的可用视差范围、无需云端的近似打光底色 | 都有运行时门槛；ShadeNet 当前 WebGPU 数值检查不通过 |
| P3 | Qwen-Image-Layered / SHARP / UniSHARP | 可编辑图层、高质量空间照片与小幅新视角 | 用独立高质量任务产生资产，客户端负责交互渲染 |
| 储备 | Marigold V2 / LiveLight / FusionRelight / NeoMap | 高质量几何、视频重打光与大幅运镜 | 按具体任务、硬件与已发布代码筛选，不作为当前浏览器默认 |

这里的 SOTA 分属轻量深度、近视角合成、图层拆解和视频打光等不同任务。论文各自的领先结果不能直接排列成同一张“工坊画质排行榜”。

2026-11-27 已按该顺序完成第一批可复现实验，详见 §8 与 [`tools/spatial/README.md`](../tools/spatial/README.md)。这批给出了路线取舍依据，尚不等于端侧画质升级已经交付。

## 2. 源码核对：现有基线与优先处理的缺口

### 2.1 已有能力应当复用

- [`depthFxWebGPU.js`](../web/logic/depthFxWebGPU.js) / [`depthFxWebGL.js`](../web/logic/depthFxWebGL.js) 已有 GPU 常驻纹理、预处理缓存、景深与空间滤镜管线。视差已经是前景/补全背景的 **L0 + L1 双层高度场**，不是完全没有分层；但其像素归属仍依赖硬锐化和跳变阈值，尚无独立的连续透明度表示。
- [`Workshop.jsx`](../web/studio/workshop/Workshop.jsx) 的空间滤镜预览已经向 [`WorkshopStage.jsx`](../web/studio/workshop/WorkshopStage.jsx) 传 `type: 'canvas'`，可以直接复用该展示接口。
- 打光已经有 GGX、屏幕空间阴影、AO 与可开关的间接反弹光。当前 [`relightWebGPU.js`](../web/logic/relightWebGPU.js) 的 GI 是 **12 方向 × 6 环的屏幕空间采样近似**，并非完整 Radiance Cascades，也不等同于多反弹物理全局光照。
- [`localInference.js`](../web/logic/localInference.js) / [`localInference.worker.js`](../web/logic/localInference.worker.js) 已提供模型下载、串行推理与 Session 缓存；新增模型继续依托这一套基础设施。

### 2.2 优先验证的工程问题

下表保留 2026-11-27 初次源码核对的基线。收口时复核：物理打光的逐帧 PNG 编码已由另一条界面任务在 `3590b0b` 中改成 Canvas 直绘与最新预览调度，此项不再列为后续待办；本任务的正式缓存修复另见 §9.4。

| 发现 | 证据 | 对后续方案的影响 |
| --- | --- | --- |
| **保存深度仍是 8-bit** | `depthFx.js::pixelsFromDepth()` 写 `Uint8ClampedArray`，灰度仅 256 级；读回经 Canvas RGBA 解码 | `r32float` GPU 上传与 WebGL 16-bit 打包不会恢复保存时丢失的精度。高精度通道必须端到端保留 |
| **视差生成新主图后附带的是原视角深度/法线** | `Workshop.jsx` 应用分支保存 `rendered` 主图，同时调用 `pixelsFromDepth(fullDepth)` 与原 `normalPixels` | 下一次加工可能出现通道与 RGB 像素错位；需重投影几何/有效性，或明确只绑定源视角，不能把旧通道当作新视角几何 |
| **运动状态缺少完整保存语义** | 应用时零偏移会被改为 `shiftX=0.25`；保存元信息含 `amplitude`，未含该分支实际使用的 `shiftX/shiftY`；预览叠加呼吸相位 | 建立共享 `cameraState`，明确“保存当前帧 / 固定姿态 / 循环视频”的含义，预览与导出共用 |
| **动画更新约 24Hz** | `WORKSHOP.depthFx.parallax.frameMs = 42`；RAF 中按此间隔更新相位 | GPU 单帧低于 16ms 不能据此宣称交互 60fps，必须测输入到舞台显示的耗时 |
| **初版打光逐帧编码 PNG（已由 `3590b0b` 处理）** | 初次核对时物理打光分支调用 `canvas.toDataURL('image/png')`；收口时已复核为 Canvas 帧接口 | 此项已完成，后续性能评测按最新管线执行 |
| **多模式资源一并分配** | WebGPU `ensureSurfaceResources()` 同时创建背景、元数据、CoC、前后景散景等全幅纹理 | 在加图层前先测纹理预算，按模式延迟分配并释放。不能只按权重大小判断设备负担 |
| **推理接口当前是单输入/单输出 Float32** | Worker 构造一个输入 Tensor 并选一个输出 | ShadeNet 合并版单输出能适配；LaMa 的 image+mask 需要多输入契约。ViTMatte 需核对具体导出的 RGB+trimap 组织（可为合并四通道）；多输出模型也要明确处理 |

当前 GPU 预览长边限制在 `1600px`；应用分支将源图尺寸传给渲染器，并没有相同的统一 `1600px` 上限。大图导出的设备纹理上限、内存与分块策略需单独验收。

## 3. 默认端侧路线：软分层与可控补全

### 3.1 为什么已有双层高度场仍然出边缘问题

观察像素满足 `I = αF + (1−α)B`：发丝、抗锯齿轮廓和透明区域常同时混合前景与背景。深度边缘锐化不能同时求出 Alpha、干净前景颜色和被挡住的背景。把混合后的 `I` 直接贴在移动前景上，即使几何位置正确，也会带走原背景颜色。

[SLIDE（ICCV 2021）][S1] 正是针对硬分层难以处理 matting 细节提出软分层与深度感知补全；[3D Photo Inpainting（CVPR 2020）][S2] 则给出多层 RGB-D 和遮挡补全的成熟参考。这些基础工作比本轮新模型更早，但与当前缺陷直接对应。

### 3.2 建议原型结构

1. **输入与分层**：读取对齐的源 RGB、原始高精度深度及其变换元信息。按遮挡不连续与连通区域建立 2–4 个自适应层，保留层内连续深度，避免把所有表面切成几张平板。
2. **估计 Alpha**：先构造确定前景/背景与不确定边界带；用 RGB 引导局部求解建立零新增模型基线，再与 ViTMatte 类 trimap 引导方案对照。不能把简单羽化深度阈值称为已解决 matting。
3. **恢复前景颜色**：在不确定边界估计 `F/B` 并做正则化，参考 [PyMatting 的 foreground estimation][S3]。`α` 很小时直接除法会放大噪声，需透明区保护与颜色外扩。
4. **补全颜色和深度**：从有效、同层且深度兼容的背景样本构建加权 Pull-Push 金字塔，存储颜色和有效权重；深度单独补全并维持层顺序。最后保留原有已知像素，只在未知区混合补全。
5. **渲染对照**：比较连续深度网格（遮挡边界断开三角形）与少层 MPI 重投影；在线性空间用预乘 Alpha 合成。二者对斜面、发丝和薄结构的表现必须用同图实验决定。
6. **一次预处理、连续运动复用**：按源图内容、几何来源、Alpha 来源、分层参数和算法版本缓存。若补洞范围取决于运动幅度，缓存键必须包含相应包络，幅度扩大时重新准备资产。

**Pull-Push 的作用范围**：改善二维小洞、低频延拓和水平条纹。它不能重建被人挡住的门牌、棋盘格或文字；大洞会模糊、结构可能断裂。应与 PatchMatch/LaMa 的一次性补全比较，并根据补全可信度限制可用运动范围。

现有去背结果可以作主体先验，但 RMBG / BiRefNet 的显著主体掩膜不等于全场景深度分层。多人物、栅栏、屋檐和地面仍需单独处理。

### 3.3 自适应运动边界

按每个方向的预测露底宽度、有效背景余量和补全可信度建立运动包络，并检查整个循环轨迹。低可信区域允许局部减弱位移，必要时轻裁切；保留可对比的原始强度，不能仅靠降低幅度宣称算法画质提升。

WebGPU 与 WebGL 共用图层准备和相机语义，先统一资产、采样方向、边界、颜色空间与预乘约定，再实现不同后端。CPU 回退可降分辨率，但必须明确与 GPU 的差异。

## 4. 2025–2026 候选核查

### 4.1 轻量感知与端侧补全

| 候选 | 第一方证据 | 运行与授权判断 | 本项目选择 |
| --- | --- | --- | --- |
| **ZipDepth，ECCV 2026** | [官方仓库][S4]：融合后约 **6.1M 参数**，有标准与免 unfold 的 NPU 版本，提供 ONNX 导出；输出为 affine-invariant inverse depth | 仓库 MIT；不把 CoreML / TensorRT 的速度直接折算成 ORT-Web 速度。需记录权重来源与导出产物哈希 | **轻量深度首测候选**。与 DA3-Small 同图比较轮廓、天空、薄结构、动漫泛化和端到端延迟；注意逆深度方向和尺度 |
| **ShadeNet-5-35M，2026-11** | [作者模型卡][S5]：单次前向估计 albedo / relative depth / normal；合并 refiner ONNX **35,061,482 B** | 作者标 Apache-2.0；448²，七通道输出。仅 23 张验证图及 Marigold V2 伪标签，不具备通用 SOTA 证据 | **只列实验候选**。本轮 CPU/WASM 跑通，但 ORT-Web 1.22 WebGPU 数值检查失败，详见 §5 |
| **ViTMatte，2023–2024** | [官方仓库][S6]：trimap 引导 matting，已有预训练权重和 Transformers 生态 | 代码 MIT；下载具体权重时另记其模型卡条款。ONNX 导出与 WebGPU 算子覆盖待验证 | 作 Alpha 质量对照，不默认新增 SAM 全家桶，也不误称 2026 新 SOTA |
| **LaMa WebGPU 图改写，2026-11 镜像** | [模型卡及转换脚本][S7]：DFT 常量折叠、Einsum→MatMul、反向 Slice→Gather；固定 512² image+mask，文件 **209,033,286 B** | 社区导出、Apache-2.0；作者称浏览器 WebGPU 约 1.7–2.2s，非本机数据。原生 Fourier 图有已报告的 WebGPU 不兼容 | 候选一次性背景补全器。先核验改写与 CPU 数值等价性，再测本项目 ORT 1.22；不能仅凭 ONNX 扩展名就标“WebGPU 支持” |

ZipDepth 的优先级来自模型规模、算子与任务契合度，尚无本项目画质胜出的结论。ShadeNet 的 albedo / normal 若有收益，也可与 DA3 几何组合，不必整体替换深度底座。

### 4.2 高质量分层与单图新视角

| 候选 | 能力与已发布内容 | 接入边界 |
| --- | --- | --- |
| **SHARP，2025-12 / ICLR 2026** | [官方代码][S8]、[模型][S9]：单图前馈生成 metric 3D Gaussians，导出 `.ply`；论文报告相对所比较方法 LPIPS 改善 25–34%、DISTS 改善 21–43%，标准 GPU 小于一秒 | **科研比较对象**。代码和模型分开授权；模型为 Apple ML Research License，明确把 product development 排除在 Research Purposes 外。当前按隔离科研实验记录。约 2.81GB 权重；可在网页查看 `.ply` 不代表浏览器可运行网络 |
| **UniSHARP，2026-06** | [官方仓库][S10]：透视、广角、鱼眼、全景相机，ray-distance 双层 Gaussian；已给出推理脚本与 checkpoint 链接 | 仓库 CC BY-NC 4.0，权重及 UniK3D/3DGEER 等依赖分别核对。优先级低于当前普通照片视差，不为用新模型强加全景流程 |
| **Qwen-Image-Layered，2025-12 / CVPR 2026** | [官方仓库][S11]、[权重卡][S12]：图像分解为多张 RGBA；官方示例 640px、4 层、50 步 | Apache-2.0。适合 GPU 一次拆层后客户端实时合成。输出是语义图层，**不是带正确相机与深度的 LDI**；还要处理图层顺序、各层深度和重合一致性；生成细节可能偏离输入 |
| **Stable Layers，2026-05** | [官方仓库][S13]：Qwen-Image-Layered 的 LoRA；建议 640px、4 层、50 步 Heun | Stability Community License，存在收入门槛；不能沿用底模 Apache 标签。官方称 bf16 底模约 40GB，80GB 卡更从容，暂作对照储备 |
| **NeoMap，ECCV 2026** | [官方仓库][S14]：VGGT + Wan2.2-I2V-A14B，通过迭代投影生成新视角视频；已有个人图像入口 | CC BY-NC-SA 4.0；官方冒烟环境为 H200，干净环境与完整发布评测尚有待办。属于生成式视频任务，不能替代交互式浏览器着色器 |

Gaussian 空间照片与游戏网格模型也需要区分：带烘焙外观的 Gaussian 不是可自动更换材质和灯光的 PBR mesh，不直接复用 `mesh3d` 的 `.glb` 资产语义。只有确定接入时才扩展新的产物契约。

### 4.3 几何/打光研究补充

- **Marigold V2（2026-09 发布，SIGGRAPH Asia 2026 待于 12 月报告）**：[官方仓库][S15] 与[权重卡][S16]显示它使用 Qwen-Image-Edit-2509 底座，已是**单步** dense prediction。分别发布 depth / normals / albedo 等 checkpoint，1024² 官方约需 17GB、2048² 约 29GB 显存；Apache-2.0。可作边缘质量参考或高质量 GPU 档，不以“多步去噪”否决，也不能把单步理解为端侧轻量。See-through depth 针对玻璃后几何，不等于任意遮挡物背后的完整场景。
- **LiveLight（TOG 2026）**：[官方代码][S17]已发布，支持三维点光源控制与流式视频打光。作者报告四步、15.78 FPS、0.253s 延迟。代码 MIT，ModelScope 权重与底模授权仍须分别核对；当前是 CUDA 扩散运行环境，没有本项目浏览器部署证据。
- **FusionRelight（2026-08）**：[NVIDIA 官方发布][S18]给出人像 512² 下 RTX 2060 11.89ms / RTX 4090 1.82ms。此次核查该页面仅发现论文与演示链接，未核实可下载的官方推理权重，因此先记录为论文观察项，不推定其权重条款或端侧可运行性。
- **Parallax Portrait Matting（ECCV 2026）**：[论文][S19]需要轻微变视角的**两帧输入**，不能作为单张已有图片 matting 的直接替换。

## 5. 本轮新增实测：ShadeNet-5 的运行时与输出检查

### 5.1 固定资产与方法

- 模型：`singam96/ShadeNet-5-35M`，revision `6f3c1b617ef052ba45453a6287771166f5e6ac59`。
- 文件：`onnx/shadenet5_mix_refined.onnx`，`35,061,482 B`；下载后 SHA-256 实算通过：`f273b36084478f6294f9acb7ec6bae50aacf973b4881e97aabdc35ed32ce2b3d`。
- 实际接口：输入 `input_rgb: float32 [1,3,448,448]`，RGB `[-1,1]`；合并版输出名实际为 **`refined`**，形状 `[1,7,448,448]`。模型卡示例中的 `maps` 名称不能直接照搬。
- 预处理依照作者 framing：等比缩放、对称镜像补边、推理后裁去补边；法线约定 `x` 向右、`y` 向上、`z` 朝观察者。
- 四图：仓库的渔夫人像、动漫、微缩拉面摊、书店街景。全部属于冒烟样张，无真实 intrinsic ground truth；不足以评定算法优劣。
- Python：本机 Windows、AMD CPU，ONNX Runtime **1.27.0 CPU**，8 线程；每图 4 次前向，第一次数值独立记录，后 3 次取中位数。
- 浏览器：已安装 **Chrome 158.0.8127.88 headless / AMD WebGPU**，使用仓库现有 `onnxruntime-web@1.22.0` 与 `tools/promo` 的 `playwright-core`；同一份预处理张量，与 Python CPU 原始七通道输出逐值比较。WASM 按项目设置单线程。

### 5.2 结果

| 路径 | 建 Session | 单次前向 | 输出检查 |
| --- | ---: | ---: | --- |
| Python CPU / 8 threads | 1.05s | 四图暖机中位数分别 **1.53 / 1.65 / 1.61 / 1.55s** | 四图形状正确、全有限值，法线长度约 1 |
| ORT-Web WASM / 1 thread，人像 | 2.14s | **8.38 / 8.05 / 8.40s** | 相对 Python 输出全通道 MAE **0.00211**、最大误差 0.0398（值域 `[-1,1]`）；仅为本图数值接近证据 |
| ORT-Web WebGPU，人像 | 1.75s | 首次 **3.37s**，后续 **1.32 / 1.21s** | 调用成功、形状正常且全有限值，但相对 CPU MAE **0.48369**、最大误差 1.68，**不通过数值一致性检查** |
| 独立重启浏览器后的 WebGPU 复测 | 1.73s | **2.40 / 1.55 / 1.40s** | MAE **0.48366**，七个通道均有明显偏离，问题复现 |

**结论**：不能以 Session 创建成功、前向不报错、输出有变化作为模型可用的判据。本轮未定位到具体算子，不能断言与旧 DA3 `MatMulNBits` 问题同源，也未证明更新 ORT 即可修复。当前不登记为可用默认模型。

视觉检查中，Python 结果的人像底色确有去光变化，但街景、动漫和微缩物的细节/边缘有软化，部分原光影仍保留。该观察仅用于设计下一轮 A/B，尚无“替代 CHORD / Marigold”的质量证据。若继续研究，先用 DA3 深度搭配 ShadeNet albedo / normal 隔离变量，再比较不同精度导出或隔离的新版 ORT；不要直接修改全局运行时。

本地完整报告、输入张量、输出张量、拼图及探针脚本位于 `.tmp/workshop-spatial-research-2026-11-27/`（按仓库约定不入库）；关键指标保留于本节。浏览器脚本已 `node --check` 后执行。无云卡调用。

LaMa 候选另外核对了发布元信息，尚未下载或推理：revision `2c110d2944f119e2ee3f1ed9893ac78b36b81df7`，`lama_webgpu.onnx`，`209,033,286 B`，发布 LFS SHA-256 为 `75ddeeb344ca4603b261b09fce0e9323e17872042907f5ee205c9875464c8e3b`。这是上游声明的哈希，未称为本机文件校验通过。

## 6. 下一轮实验与验收

### 6.1 先隔离变量，再决定合入

| 实验 | 固定项与对照项 | 交付/退出条件 |
| --- | --- | --- |
| E0 评测基线 | 冻结现有两后端；记录源图、深度、Alpha、分辨率、实际位移、运动轨迹与设备 | 16 张固定场景 + 已知 F/B/Alpha/Depth 的合成集，保留当前问题图；人工裁切位置固定 |
| E1 表示与合成 | 固定 DA3-Small，比较当前高度场、软分层、加入颜色恢复、再加入 Pull-Push 的逐项消融 | 同等运动幅度下减少边缘错误；棋盘格、斜线与门框不能用大面积模糊掩盖；保留失败例 |
| E2 感知模型 | 同一渲染器、同一相机，对照 DA3-Small 与 ZipDepth FP32/FP16 ONNX | 浏览器数值核对先通过，再测场景画质、冷启动、暖机、内存与取消；未胜出继续保留 DA3 |
| E3 智能补洞/去光 | 相同洞掩膜对照 Pull-Push 与 LaMa；相同灯位对照有/无 ShadeNet 辅助 | 未处理区域保持，检查接缝与语义幻觉；明确模型等待和质量收益，不把推理放进每帧路径 |
| E4 输出闭环 | 同一 `cameraState` 驱动预览、保存静帧、可选固定帧率循环视频 | 姿态一致，保存重开后几何正确，任务可取消，版本树元数据足以复现 |

16 张场景建议覆盖人像发丝、毛发、树枝/栅栏、多层遮挡、斜地面/建筑、强文字/棋盘纹理、天空、动漫、薄透明材质；先标定现有失败区域，不用随机漂亮样张代替。

### 6.2 评测口径

- **有真值的合成集**：零位移重建误差、Alpha MAE/梯度误差、轮廓带颜色误差、露底区误差和薄结构保留率；已知区域与补全区域分别统计。
- **真实图片**：固定 200% 边缘裁切、八方向等幅位移与整段循环；记录暗边、接缝、前景残影、纹理拖伸及运动闪烁。没有真实目标视图时，不伪造 PSNR/LPIPS 的质量结论。
- **后端一致性**：同一资产/姿态下分别检查前景内部、Alpha 边界、补洞区。允许已说明的精度误差，不只比较全图平均值。
- **性能目标（待测，不是承诺）**：1024px 交互 p95 ≤33ms，支持设备争取 ≤16.7ms；单独记录预处理、模型、GPU dispatch、舞台显示和导出耗时。测冷帧及持续运行，不以 `queue.submit()` 返回时间当 GPU 时间。
- **设备预算**：至少本机 AMD 核显 WebGPU、WebGL 强制回退、无 GPU 三档；记录峰值内存/纹理估算、设备丢失、切图后释放和失败重试。大图应用另测，不能从 640px 着色器耗时推算原图导出。

### 6.3 复合资产约束

先定义内部研究资产，不立即扩大公共 API。推荐包含源视角标识、几何编码/尺度/方向、相机、各层 `color + alpha + depth + validity`、补全来源与运动安全包络。

- 颜色/Alpha PNG 可用于查看，但深度应有 `uint16` 或 float32 的可逆路径和明确的归一化元信息；普通浏览器 Canvas 解码 16-bit PNG 仍会降为 8-bit，必须有专门解码器。
- 持久化缓存按工作区和内容哈希隔离；分层/颜色恢复/补全算法版本变化须失效。预览缓存与长期资产分开设置预算。
- 当前 `WORKSHOP.channels` 最多 8 项、格式只有 png/svg/json，总保存预算 40MB；多层不能直接无约束塞入该数组。确定实验胜出后再选容器与修改契约。
- 可复用源视角 depth 的雾效/打光，与改变视角的 parallax 分开处理几何绑定；从生成的新帧继续加工时必须有对齐的几何或重新推理。

## 7. 来源与核查说明

以上区分了作者/论文报告、本轮源码推断与本机实测。GitHub/Hugging Face 页面会更新；正式实验需固定代码 revision、模型 revision、导出参数与文件哈希。

1. [SLIDE，Google Research / ICCV 2021][S1]
2. [3D Photography using Context-aware Layered Depth Inpainting，CVPR 2020][S2]
3. [PyMatting foreground estimation][S3]
4. [ZipDepth 官方代码、checkpoint 与 ONNX 导出][S4]；本轮读取的 README 最近提交为 `91f3fd21e131641f51e8d35736d1958350180e3a`。
5. [ShadeNet-5 作者模型卡][S5]、[固定 revision 的 config.json](https://huggingface.co/singam96/ShadeNet-5-35M/blob/6f3c1b617ef052ba45453a6287771166f5e6ac59/config.json)。网页检索工具无法直接读取该模型卡时，本轮通过 Hugging Face API 与 HTTPS 正文核对，未以第三方摘要代替。
6. [ViTMatte 官方代码][S6]
7. [LaMa WebGPU 社区导出与转换脚本][S7]、[LaMa 原项目](https://github.com/advimman/lama)
8. [SHARP 官方代码][S8]、[模型卡][S9]、[单独模型授权原文](https://github.com/apple-aiml-research/ml-sharp/blob/main/LICENSE_MODEL)
9. [UniSHARP 官方代码与 checkpoint 链接][S10]、[许可证](https://github.com/Insta360-Research-Team/UniSHARP/blob/main/LICENSE)
10. [Qwen-Image-Layered 官方代码][S11]、[权重卡][S12]
11. [Stable Layers 官方代码与资源/授权说明][S13]
12. [NeoMap 官方代码与部署边界][S14]
13. [Marigold V2 官方代码][S15]、[权重卡][S16]
14. [LiveLight 官方代码][S17]
15. [FusionRelight，NVIDIA 官方发布][S18]
16. [Parallax Portrait Matting，论文摘要与输入要求][S19]

[S1]: https://research.google/pubs/slide-single-image-3d-photography-with-soft-layering-and-depth-aware-inpainting/
[S2]: https://shihmengli.github.io/3D-Photo-Inpainting/
[S3]: https://pymatting.github.io/foreground.html
[S4]: https://github.com/fabiotosi92/ZipDepth
[S5]: https://huggingface.co/singam96/ShadeNet-5-35M
[S6]: https://github.com/hustvl/ViTMatte
[S7]: https://huggingface.co/toolsmonk/lama-webgpu
[S8]: https://github.com/apple-aiml-research/ml-sharp
[S9]: https://huggingface.co/apple/Sharp
[S10]: https://github.com/Insta360-Research-Team/UniSHARP
[S11]: https://github.com/QwenLM/Qwen-Image-Layered
[S12]: https://huggingface.co/Qwen/Qwen-Image-Layered
[S13]: https://github.com/Stability-AI/Stable-Layers
[S14]: https://github.com/vLAR-group/NeoMap
[S15]: https://github.com/huawei-bayerlab/marigold-v2
[S16]: https://huggingface.co/huawei-bayerlab/marigold-v2-0
[S17]: https://github.com/mayuelala/LiveLight
[S18]: https://research.nvidia.com/publication/2026-08_fusionrelight-relighting-portraits-real-time-hybrid-domain-knowledge-fusion
[S19]: https://arxiv.org/abs/2607.11205

## 8. E0 / E1 / E2 第一轮实测与取舍（2026-11-27）

### 8.1 已完成交付与实验范围

- [`tools/spatial/fixtures.mjs`](../tools/spatial/fixtures.mjs)：固定 **16 张仓库真实样图**，另有 **4 类独立解析场景 × 8 个等幅运动方向**（柔边圆盘、发丝、栅栏、斜边）。解析目标视角由连续 F/B/Alpha 函数超采样得到，原型不读取目标视图或真值 Alpha；`oracle-alpha` 仅用于诊断上限。
- [`prepare.mjs`](../tools/spatial/prepare.mjs)：保存输入 SHA-256 与三份现行渲染器副本，冻结基线。WebGPU / WebGL 在新页面执行，防止原有六点采样缓存指纹碰撞影响换图比较。
- [`soft-ldi.mjs`](../tools/spatial/soft-ldi.mjs)：隔离的两层研究原型，使用深度聚类、RGB 颜色直线估计 Alpha、正则化前景颜色恢复、二维加权 Pull-Push、预乘 Alpha 合成及层内连续深度反向映射。可分别关闭颜色恢复/背景补洞，尚未实现自适应多层或深度兼容邻域限制，不把它称为完整 matting/LDI 实现。
- [`export-zipdepth.py`](../tools/spatial/export-zipdepth.py) / [`model-probe.py`](../tools/spatial/model-probe.py)：固定 ZipDepth 源码/权重导出，16 图 CPU 前向及四图 PyTorch→ONNX 核对，额外导出 FP16。
- [`bench.mjs`](../tools/spatial/bench.mjs)：真实 Chrome 158 / AMD WebGPU / 项目 ORT-Web 1.22，分别检查模型数值、两后端解析图、16 图渲染对照、固定现行 WebGPU 渲染器下 DA3 与 ZipDepth 深度替换。
- [`report.py`](../tools/spatial/report.py)：输出逐图 PNG、四张拼图、统计摘要与独立 HTML。产物位于 `.tmp/spatial-e0-e2-2026-11-27/index.html`，模型/参考张量/大图按仓库约定不入库。

这是**受控算法实验**：真实图统一等比补边，渲染使用 Python CPU 生成的浮点深度；DA3 参考没有完全复刻客户端的预缩放采样，且 CPU 与客户端 WASM 输出存在下述差异。因此该轮不代表产品完整体验，也不以真实图无真值的主观观察宣称模型准确率胜出。

### 8.2 ZipDepth：速度验证通过，整体替换条件未满足

官方固定代码 revision：`91f3fd21e131641f51e8d35736d1958350180e3a`；checkpoint `zipdepth_base_npu.pth`，SHA-256 实算 `627c04fda584133ead4310074884a4a037061b4c01ba86e73e492ea30fab570d`。

**导出发现**：官方 `scripts/export.py::export_onnx()` 把 `GlobalContextBlock` 的 learned softmax 加权上下文替换为平均池化。本机最初导出与原 fused PyTorch 在四张人像/动漫图上的 `MAE / 输出标准差` 达 `2.45%–17.89%`。改为直接导出原 fused forward 后，四图误差降为 `4.68e-7–1.85e-6`。后续全部使用保留原图的导出，未更改上游源码。

| 路径 | 本轮大小 | 四图前向暖机中位数 | 对同一导出 CPU 参考的最大相对 MAE | 结论 |
| --- | ---: | ---: | ---: | --- |
| DA3-Small INT8 / WASM | 37,027,601 B | 复测 **2.41s** | **12.13%** | 存在跨运行时偏差，单列调查，不能当模型画质输赢 |
| ZipDepth FP32 / WASM | 24,604,748 B | **285.2ms** | `1.54e-6` | 数值检查通过 |
| ZipDepth FP32 / WebGPU | 24,604,748 B | **30.7ms** | `1.68e-6` | 数值检查通过，速度优势明显 |
| ZipDepth FP16 / WASM | 12,332,909 B | **310.7ms** | `1.59e-6` | 数值检查通过，未比 FP32 更快 |
| ZipDepth FP16 / WebGPU | 12,332,909 B | **27.1ms** | **1.54%** | 微缩图超过预设 1% 门槛，暂不采用 |

时间为四图各三次前向中的后两次合并取中位数，不含下载、解码、输入构建和渲染。不同模型使用自身固定输入尺寸：DA3 为 504×378，ZipDepth 为 384²，不能把加速归因于架构单一因素。CPU 1.27 / 8 线程下，16 图暖机中位数为 DA3 `287.9ms`、ZipDepth FP32 `41.0ms`、FP16 `45.7ms`。

FP32 导出 SHA-256：`89ae418e491455210ffe867e9788a0d4a1331144109bf72e4acc35facef74ca5`；FP16：`e360174426be8355d40eae0cb1e0ab29d4449c303ca6dd511fb4f9d8082a54b6`。CPU FP16 对 CPU FP32 的 16 图相对 MAE 为 `0.059%–0.927%`，与 WebGPU 的额外偏差分开记录。

**视觉结论**：四类深度拼图和 16 图同渲染器对照中，ZipDepth 可形成主体轮廓且部分背景更平滑，但书店门窗的内部几何更平，渔夫头肩出现不同的轮廓拉伸，微缩场景也有地面/主体接缝。当前证据支持把它列为可运行的轻量候选，**不支持整体替换 DA3 默认**。后续评估以设备预算分档与客户端实际预处理对照为先。

### 8.3 两层软 Alpha：局部有效，复杂场景拒绝合入

以下为解析图八方向平均，RGB 绝对误差取 0..255，固定 amplitude=24、方向归一化、裁去 30px 画框边缘；两方案运动一致，没有通过减小运动提高结果。

| 场景 | 现行 WebGPU：全图 / 轮廓 MAE | 两层软 Alpha 完整原型：全图 / 轮廓 MAE | 观察 |
| --- | --- | --- | --- |
| 柔边圆盘 | `1.109 / 14.823` | **`0.512 / 6.840`** | 消除部分轮廓弧线与锯齿，轮廓误差约下降 54% |
| 发丝 | `1.390 / 16.022` | **`0.797 / 12.873`** | 细线更连续，轮廓误差约下降 20% |
| 栅栏 + 棋盘背景 | `42.936 / 57.700` | `40.222 / 51.058` | 全局数字略好，但露底 MAE 从 **23.151 恶化到 47.097**，棋盘被低频补洞破坏 |
| 斜边 + 棋盘背景 | `13.266 / 25.381` | `12.283 / 31.149` | 全图误差略降而轮廓明显退步，不能按单一全图分数判赢 |

逐项对照也表明：在有补洞的条件下，前景颜色恢复把圆盘轮廓 MAE 从 `10.26` 降到 `6.84`、发丝从 `13.62` 降到 `12.87`；栅栏几乎无收益。没有背景补全时，只有软 Alpha/颜色恢复的露底区仍有前景残影；单靠“羽化 + 去污染”不足以解决遮挡。

真实图中，渔夫背景整体较连贯，但动漫图的 Alpha 将霓虹/发丝混入错误层，书店门窗产生结构拉伸，微缩场景低频区域仍出现接缝。CPU 参考实现的 512px 内样图预处理为 **136–213ms**，每帧为 **68–110ms**，还未达到交互预算，也没有借此宣称 GPU 实时性能。

**决定**：保留研究模块和失败样例，当前产品继续使用原管线。下一轮首先解决 **连通区域/遮挡边界驱动的自适应层、弱颜色对比下的 Alpha 约束、结构纹理补洞**，再考虑把胜出的准备阶段移到 Worker/GPU；先不将简单双层原型推广到全场景。

### 8.4 DA3 数值基线调查

同一输入下，现有 DA3 INT8 的 ORT-Web 1.22 WASM 与 Python ORT 1.27 CPU 输出相对误差为 `1.86%–12.13%`。复测值不变，说明不是一次性随机抖动。

[`audit-da3.py`](../tools/spatial/audit-da3.py) 进一步用隔离的 Python ORT 1.22 / 1.27，分别关闭和启用图优化：即便 CPU 1.22 与 WASM 1.22 版本相同，仍未全部通过 1% 门槛，优化设置也会改变偏差。尚未定位具体量化算子或证明哪一路更接近原始未量化模型；**不能把这件事当作 DA3 画质错误或 ZipDepth 更准确的证据**。后续以未量化模型为参考调查，当前默认不变。

### 8.5 验证与剩余工作

- `node test/spatial-research.mjs`：已知像素不可变、无有效样本、零位移字节一致、Alpha 合成图准确性、运动单位与输入对齐校验通过。
- `node test/check-client-depth-fx.mjs`：现有 **13/13** 回归通过。
- Python 脚本经 `py_compile`，Node/浏览器脚本经 `node --check`；模型 SHA-256、PyTorch/CPU/浏览器输出与固定集检查已完成。
- 浏览器全部 16 真实场景与解析八方向完成，无运行错误；FP16、DA3 数值门槛失败作为研究发现保留。
- 本轮新增实验工具与文档，未修改产品渲染器、模型注册表或网站，也没有调用云卡。
- 仍待完成：客户端实际预处理/端到端输入延迟与内存基准、自适应多层和语义/结构补全、1024px GPU 原型、持久化高精度深度及相机/几何对齐闭环。这些不能由本轮 512px CPU 参考或模型前向结果代替。

## 9. 第二轮：实际客户端预处理、原 Worker 与补洞参考（2026-11-28）

### 9.1 实施与可复现入口

新增 [`continue-bench.mjs`](../tools/spatial/continue-bench.mjs)、[`adaptive-ldi.mjs`](../tools/spatial/adaptive-ldi.mjs)、[`worker-probe.mjs`](../tools/spatial/worker-probe.mjs) 与 [`followup-report.py`](../tools/spatial/followup-report.py)。默认报告位于 `.tmp/spatial-followup-2026-11-28/index.html`；第一轮报告仍保留。

本轮使用 esbuild 打包当前真实 `runLocalDepth()`，注入本地已校验模型，实际执行其预缩放、输入构建、补边、推理、裁切和分位归一化；ZipDepth 候选复用相同预处理函数，但维持模型所需的 RGB 0..1 与逆深度方向。该探针没有新增产品模型配置。随后直接使用**未修改的 `localInference.worker.js`**，在固定 16 张真实图上复测。

### 9.2 ZipDepth 的速度收益在原 Worker 中复现

两模型共 32 个 Worker 结果均为有限值；归一化后与本轮直接执行参考逐值一致，MAE 为 0。下表统计首张后的 15 图中位数，单次/图，非重复稳态或跨设备基准：

| 路径 | 预处理 + 推理 Worker 往返 + 归一化 | 其中 Worker 往返 | 首张总耗时 |
| --- | ---: | ---: | ---: |
| 当前 DA3-Small INT8 / WASM 单线程 | **3804ms** | 3700ms | 5438ms |
| ZipDepth FP32 / WebGPU | **141ms** | 58ms | 1750ms |

使用 Chrome 158 / 本机 AMD GPU、项目 ORT-Web 1.22；首张含 Session 初始化，本地模型字节读取走回环 HTTP。全部时间均**不含模型网络下载、图片解码和后续滤镜渲染**，不能称为完整用户操作到最终画面延迟。主线程直接调用的 ZipDepth 同口径约 142ms，说明本轮收益并非绕过现有 Worker 才获得。

16 图采用同一幅度/姿态及原 WebGPU 渲染器的视觉对照后，ZipDepth 的部分背景更平，但渔夫头顶/肩部残影和微缩底边局部失真仍在。已有速度与执行兼容性证据，尚无整体画质胜出的依据，继续保留为轻量分档候选。后续如接入可选档，还需要下载产物托管、Worker 冷启动/取消及设备覆盖，不能由此自动登记为默认。

### 9.3 第二版分层和样例块补洞的收益与退步

本轮原型增加 2–4 类深度聚类、局部大深度跨度处的 RGB 颜色归属、仅向被近层遮挡区扩展的后层、可见上下文评分的样例块复制与稳定随机候选。保留层内连续深度，对有足够平坦内部样本的层抑制轮廓深度斜坡；已知背景样本不被补洞修改。

它尚未实现按对象/连通区域拆分同深度层，局部颜色判断仍可能把纹理误当轮廓。不能把本轮“多层 + 样例补洞”称为完整对象级 LDI、全局 PatchMatch 或语义补全。

解析图仍使用原固定八方向、amplitude=24、同一评测窗口。各值为 0..255 RGB 八方向平均：

| 场景 | 原 WebGPU 全图 / 轮廓 / 露底 MAE | 第二版样例补洞全图 / 轮廓 / 露底 MAE | 结论 |
| --- | --- | --- | --- |
| 柔边圆盘 | `1.109 / 14.823 / 1.221` | `1.228 / 7.492 / 5.220` | 轮廓优于原管线，但露底退步，第一版软分层更好 |
| 发丝 | `1.390 / 16.022 / 2.923` | `1.294 / 13.293 / 2.483` | 小幅收益，仍有轮廓残影，第一版仍占优 |
| 栅栏 | `42.936 / 57.700 / 23.151` | `36.323 / 45.245 / 63.676` | 总体数字降低，但露底严重恶化，不通过 |
| 斜边 | `13.266 / 25.381 / 73.422` | `9.580 / 21.653 / 72.816` | 三项均改善；结构重建仍不完整 |

斜边案例验证了用可见上下文选样例块的局部收益。栅栏则再次说明：深度模糊将窄杆估成更远的厚表面，改进后处理补洞仍不能修正错误几何。真实图中，门窗纹理/动漫前景也存在重复、破碎；512px 内 16 图 CPU 原型预处理中位数约 **954ms**，单帧 **204ms**。画质和性能均未达全场景替换条件，原型继续隔离。

### 9.4 已进入正式代码：空间滤镜缓存身份修复

原 `depthFxWebGPU.js` / `depthFxWebGL.js` 仅抽取数组的若干位置生成上传缓存指纹。同尺寸不同图、或不同深度场如果这些值相同，整张新纹理会被当作旧缓存跳过，连带背景预处理缓存也可能错误复用。

新增 [`renderBufferKey.js`](../web/logic/renderBufferKey.js)，改为 WeakMap 数组身份 + 长度 + 外层 `revision`。新的像素/深度快照必定刷新，同一不可变快照仍零扫描复用；对同一数组原地编辑时，调用方需递增 `revision`。当前工坊的图像/推理深度以替换快照传入。

真实 Chrome 分别检查 WebGPU/WebGL：构造旧抽样点完全相同的新图和新深度场，换图后目标像素分别发生预期变化；原地修改并递增 revision 后也正确更新。两后端目标红通道差值均为 `195 / 168 / 115`（新源图 / 新深度 / 新 revision）。相关离线检查并入 `check-client-depth-fx.mjs`，空间滤镜回归 **14/14** 通过。

此修复未替换渲染算法或默认模型，也没有把研究原型导入产品入口。后续新冻结评测的 `prepare.mjs` 会同时复制该公共缓存模块，历史基线不受影响。

### 9.5 下一步依据

- 继续按 **几何/Alpha/补洞分别对照**：优先引入可靠的边界约束（matting / 交互 trimap）或对象连通分层，避免继续靠全局深度聚类猜薄结构归属。
- 样例块补洞只在可见背景有可匹配结构时有把握；大洞/复杂门窗应与 LaMa 等一次性补全比较，并保存置信区域，不能把复制纹理当作重建真值。
- ZipDepth 后续可考虑可选轻量档，而非整体替换默认；仍需固定权重托管、注册表、设备分级与真实交互测量。
- 持久化高精度深度、相机状态与改变视角后的几何绑定仍未实施；当前实验结果没有消除这些约束。

### 9.6 本轮收口与验证（2026-11-28）

本轮交付分为正式缓存修复、可复现实验工具与研究记录；研究模块没有被产品入口导入，默认模型没有切换。后续工作已列入 ROADMAP M4.2h，当前仅完成研究与缓存修复部分。

- `node test/check-client-depth-fx.mjs`：**14/14**；`node test/spatial-research.mjs`：已知像素保留、有限值、零位移、Alpha、对齐和坐标检查通过。
- `npm run test:client`：最终复跑 **31/31 步通过**；`npm run build:web` 通过。浏览器真实验证 WebGPU/WebGL 缓存刷新，以及原推理 Worker 的 16 图输出一致性。
- 模型权重、完整输入/输出张量、逐图渲染与 HTML 报告留在 `.tmp/`，不随源码提交；关键数值、哈希、失败场景和复现命令保留于文档与 `tools/spatial/`。
- 下次从 M4.2h 的边界/补全质量门槛继续，先处理薄结构与可靠 Alpha，再评估轻量模型可选档和空间资产闭环。
