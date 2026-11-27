# 工坊实时动态打光（`relight`）升级规划与技术选型方案

> **状态**：方案调研与路线汇总草案（2026-11-27），待分批实验筛选甜点方案  
> **上位文档**：[`ROADMAP.md`](ROADMAP.md)、[`WORKSHOP_DEPTH_AND_LIGHTING_PLAN.md`](WORKSHOP_DEPTH_AND_LIGHTING_PLAN.md)（M4.2e）、[`WORKSHOP_HYBRID_COMPUTE_PLAN.md`](WORKSHOP_HYBRID_COMPUTE_PLAN.md)（M4.2f）  
> **相关代码**：[`web/logic/relightWebGL.js`](../web/logic/relightWebGL.js)、[`web/logic/relight.js`](../web/logic/relight.js)、[`web/logic/depthFx.js`](../web/logic/depthFx.js)、[`web/logic/localDepth.js`](../web/logic/localDepth.js)、[`web/logic/localInference.js`](../web/logic/localInference.js)、[`worker/inference/game_ops.py`](../worker/inference/game_ops.py)

---

## 1. 现状诊断：为什么当前 M4.2e-3 的实时打光还不够理想？

当前工坊「动态打光（`relight`）」虽然已跑通**物理实时光**与 **AI 环境光重绘（`IC-Light`）**双轨闭环，但在实际体验上仍有明显局限。从第一性原理拆解，问题来自**「单图信息上限」**与**「当前实现偏保守/简化」**两个层面：

### 1.1 单图物理信息瓶颈（无额外拆解时很难绕开）
1. **缺少去光底色（Albedo），原图旧光影被“烤死”**：
   - 未预先运行 `PBR` 四通道拆解时，[`Workshop.jsx`](../web/studio/workshop/Workshop.jsx) 与 [`relight.js`](../web/logic/relight.js) 会退化为「原图 RGB = Albedo、深度梯度 = Normal、粗糙度/金属度取固定常数」。
   - 原图已存在的暗部死阴影无法靠乘法提亮，已存在的高光叠光后易过曝，感官上接近“盖了一层局部亮度滤镜”。
2. **仅有 2.5D 表面，缺少完整 3D 背面几何与环境反射**：
   - 单图无法还原被遮挡区域、环境 HDRI 镜面反射、皮肤次表面散射等全局光效。

### 1.2 当前实时算法与交互约束（工程与图形学可大幅改进）
1. **缺少投射阴影（Cast Shadow）与环境光遮蔽（SSAO）**：
   - 当前 [`relightWebGL.js`](../web/logic/relightWebGL.js) 与 [`relight.js`](../web/logic/relight.js) 虽已持有完整 `depth` 通道，但仅将其用于距离衰减与悬崖阻尼，**未做屏幕空间深度光线步进（Raymarching）阴影与 SSAO**。画面缺少“物体挡光投下影子”的纵深与空间关系。
2. **边缘防伪影策略压低了立体感与高光冲击力**：
   - [`depthFx.js`](../web/logic/depthFx.js) 的 `normalPixelsFromDepth()` 对梯度做了 `maxSlope = 0.65` 软钳位与悬崖阻尼（`cliffDamp`）；
   - 无 PBR 法线时，着色器又将高光增益 `specGain` 与轮廓光 `rimScale` 压至 **35%**（`0.35`）。叠加上端侧 `DA3-Small`（固定 `504×378` WASM 推理）本身较平滑的深度场，成片质感容易偏“肉”。
3. **关键控光自由度被写死**：
   - 光源深度 `lightZ` 硬编码为 `0.72`（UI 未暴露），无法将光源拉至正侧面或背光侧做戏剧性逆光；
   - `pointFalloff` 衰减曲线与张角固定，不支持窄束聚光灯（Spot）或平行太阳光（Directional）；
   - 仅支持单盏主光，缺少冷暖双色补光/轮廓光组合。
4. **着色模型简陋且停留在 WebGL 1 + sRGB 直算**：
   - 光照方程为简化的 Wrap Diffuse + Blinn-Phong，且直接在 sRGB 编码值上做乘加（未做 `sRGB -> Linear` 解码与 ACES/Filmic 色调映射），暗部容易发灰、高光色彩偏闷；
   - 预览链路通过 `webglCanvas.toDataURL('image/png')` 回传，拖动时存在额外 PNG 编码开销；项目 [`localInference.js`](../web/logic/localInference.js) 已具备 WebGPU 探测与 `ort.webgpu.bundle.min.mjs`，但打光渲染尚未用上 WebGPU Compute Shader 等现代能力。

### 1.3 AI 重打光轨道（`IC-Light`）的现状局限
- [`worker/inference/game_ops.py`](../worker/inference/game_ops.py) 目前接入的是 SD1.5 前景条件版 `iclight_sd15_fc`（`output_edge = 768`），仅接收文字 `prompt`，**尚未将画布上拖拽的光球坐标 `(lightX, lightY)` / 色温转为光照引导图传入模型**，导致画布拖灯体验与 AI 轨割裂，且 SD1.5 重绘会轻微改写原图高频细节。

---

## 2. 核心设计原则：PBR 拆解与端侧快捷打光如何解耦与协同

**结论：复用 PBR 材质拆解并不会破坏「端侧快捷打光」，两者在运行时完全解耦。**

1. **「材质预处理（低频一次）」与「实时着色渲染（高频 60fps）」分离**：
   - PBR 拆解（`Marigold` ~5.2 GB / `Ubisoft CHORD`）仅在用户主动需要去光底色时按需跑一次，结果作为 `albedo / normal / roughness / metallic` 写入作品 `channels[]`；
   - 只要通道在版本树里就绪，后续所有调灯、改色温、加阴影、移动光球都在浏览器端 GPU（WebGPU / WebGL）内 **16ms 以内完成**，零模型等待。
2. **分级渐进增强（Progressive Enhancement）**：
   - **L0（端侧零下载 / 零重模型）**：WebGPU 深度投影 + 高频微法线 + 线性空间 PBR 着色，保证任何设备打开即拖即用；
   - **L1（端侧轻量几何 ONNX）**：用 WebGPU ONNX 跑支持原生法线的轻量几何模型（如 `MoGe-2 ViT-S`），端侧直接获得真表面法线；
   - **L2（云端 / 独显高精材质）**：当作品带有 `PBR` 四通道时自动无缝升级为「去光 Albedo + 微表面材质」；
   - **L3（生成式全局重绘）**：彻底改写白天/黑夜/环境反射时走 `IC-Light` 或新一代重打光模型。

---

## 3. 升级候选方案全景矩阵（2025–2026 技术路线）

### 3.1 轨道 A：端侧 WebGPU 实时渲染管线升级（纯图形学，零模型下载）

| 编号 | 候选技术 | 核心作用 | 工程复杂度 | 预期效果提升 | 兼容与回退 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A1** | **线性空间 GGX PBR + ACES 色调映射 + Detail Bump** | `sRGB -> Linear` 光照计算；结合原图亮度高频梯度合成微观凹凸法线（Detail Normal），挽回脸部/布料/砖石细节 | 低 | ⭐⭐⭐ 显著消除发灰感与“橡皮泥”平滑感 | WebGL1 / CPU 均可同步支持 |
| **A2** | **Screen-Space Shadows（深度光线步进阴影）+ SSAO** | 用 `depth` 沿光线方向步进（可配 Hi-Z 加速）生成**物体投射阴影**与**接触阴影**，叠加深度凹槽遮蔽 | 中 | ⭐⭐⭐⭐⭐ 解决“缺影子、像手电筒贴片”的最大痛点 | WebGPU Compute / 片段均可，无 WebGPU 时可降采样 |
| **A3** | **2.5D Radiance Cascades（辐射级联）与 SSGI** | 2024–2026 成熟的 2.5D 实时全局光照方案；用 WebGPU Compute Shader + Storage Texture 计算多反弹间接光与色溢（Color Bleeding） | 中高 | ⭐⭐⭐⭐⭐ 接近 3D 渲染器的空间光影融合感，且耗时恒定 | 强依赖 **WebGPU**，不支持时回退 A1+A2 |
| **A4** | **光源系统扩展 + 显存直出预览** | 暴露 `lightZ`（支持侧逆光/背光）、光源类型（点光 / 聚光灯张角 / 平行光）、双色灯（主光+冷暖补光）；WebGPU/WebGL Canvas 直绘阶段舞台，跳过拖动中每帧 `toDataURL` | 低~中 | ⭐⭐⭐⭐ 创作自由度与跟手性大幅提升 | 全端可用 |

### 3.2 轨道 B：端侧轻量 AI 几何 / 本征模型升级（WebGPU ONNX）

| 编号 | 模型 / 方案 | 能力与体量 | 协议 | 运行位置 | 定位与边界 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **B1** | **`MoGe-2 ViT-S / ViT-B`（ONNX）** | 微软开源单目几何，输出真实尺度深度 + 原生表面法线 | **MIT** · `open` | 浏览器 **WebGPU** | **❌ 实测不作默认**：WebGPU 耗时 `0.68–1.53s`，但单图重打光易在发丝/虚化边缘出“剪纸光晕”，综合观感不如 `DA3-Small` |
| **B2** | **DA3 端侧模型 Scaling 评估** | `DA3-Base`（376 MB, FP32, 518²）与 `DA3Mono-Large Q4F16`（336 MB） | **Apache-2.0** · `open` | 浏览器 **WebGPU / WASM** | **❌ 实测不替换 `DA3-Small`**：`DA3-Base` 虽跑出 `1.35–1.72s` 但打光画质几乎持平且缺天空头；`Q4F16` 在 `ORT 1.22` WebGPU 存在 `MatMulNBits` 静默饱和缺陷 |
| **B3** | **轻量端侧去阴影 / Albedo CNN（ONNX FP16）** | 小型 U-Net / MobileNet 编码器估算近似去光底色 | 视具体权重而定 | 浏览器 **WebGPU** | **谨慎评估**：通用插画/二次元泛化明显弱于云端扩散模型，仅作可选辅助实验 |

### 3.3 轨道 C：本地独显 / 云端 AI 模型升级（高质量几何与生成式重打光）

| 编号 | 模型 / 方案 | 能力特点 | 显存 / 运行环境 | 协议 | 适用定位 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **C1** | **现有 `IC-Light` 方向图桥接** | 将画布拖动的光球 `(lightX, lightY, lightZ, color)` 生成渐变光照条件图，注入现有 `run_ic_light` 管线 | 现有 T4 / ≥8 GB CUDA | 代码 Apache-2.0；权重 `non-commercial` | **改造最小**：打通物理光球与 AI 重绘的方向一致性 |
| **C2** | **`Lotus`（ICLR 2025）** | **单步（1-step）扩散**高精度深度与法线预测 | 本地 CUDA / 云端 GPU | 开源研究协议（随具体权重核对） | 适合本地独显或云端极速出高细节法线 |
| **C3** | **`LightLab`（SIGGRAPH 2025）** | Google & TAU 提出的参数化精准控光扩散模型，直接控制单个/多个光源位置、强度与色温 | 云端 GPU | **CC BY-SA 4.0** · `research` | 最贴合画布交互式控灯语义的扩散重绘备选 |
| **C4** | **`IC-Light-v2`（FLUX 版）** | 基于 FLUX 的前景/背景一致重打光，结构保持显著优于 SD1.5 版 | 16–24 GB+ GPU | 权重 **仅非商用** | 高画质云端重打光备选 |
| **C5** | **`FusionRelight`（NVIDIA，2026）** | 混合域知识蒸馏实现实时 AI 重打光（RTX 4090 `512×512` 约 `1.82 ms` / RTX 2060 约 `11.89 ms`） | 本地/云端 NVIDIA GPU | 研究/非商用限制（需核查具体发布条款） | **人像专用**高速重打光甜点（通用场景不适用） |
| **C6** | **`DiffusionRenderer` / `UniRelight`（NVIDIA，2025–2026）** | 视频/单图级联合逆渲染（Albedo/Normal/Roughness/Metallic）与高保真重打光（支持透明/反射/次表面散射） | 16 GB 极限卸载，推荐 **48 GB+ VRAM** | NVIDIA 研究/非商用（如 OneWay Noncommercial） | 高配云端旗舰储备（高显存成本，不适合端侧） |
| **C7** | **`LumiNet`（CVPR 2025）** | 潜空间本征特征驱动的室内场景重打光 | 云端 GPU | **CC BY-NC-SA 4.0** · `non-commercial` | 室内建筑/空间重打光专项储备 |

---

## 4. 推荐的「甜点方案」实验路线（按性价比排序）

为了避免一上来引入过重模型或大改工程，建议按以下 **4 个甜点组合** 依次做小步对比实验（A/B 实测后再决定正式合入哪些组合）：

### 甜点 1：纯端侧「零模型」画质跃迁（**最高性价比 · 优先试验**）
- **组合**：`A1`（线性空间 PBR + ACES + 高频微法线）+ `A2`（深度 Raymarching 投射阴影 + SSAO）+ `A4`（开放 `lightZ`、聚光张角、双色补光）。
- **为什么是甜点**：不增加任何下载体积（0 MB）、100% 商用安全、WebGPU / WebGL 均可本地 60fps 运行，直击当前最明显的“缺影子、缺逆光、立体感发肉”三大问题。

### 甜点 2：端侧深度模型 Scaling / 换型对照（**❌ 实测淘汰，保留 `DA3-Small`**）
- **实测组合**：`MoGe-2 ViT-S` WebGPU ONNX、`DA3-Base`（376 MB FP32 WebGPU）、`DA3Mono-Large Q4F16`（336 MB）。
- **结论**：经人像 / 二次元 / 微缩场景同图直比，`MoGe-2` 边缘易出现剪纸光晕，而 `DA3-Base` 相比 37 MB `DA3-Small` 对单图打光画质提升微弱；端侧默认继续保留 `DA3-Small`（37 MB），把渲染质量跃迁交给甜点 1 与甜点 3。

### 甜点 3：WebGPU 2.5D 全局光影实验（**✅ 已合入为高画质 GI 开关**）
- **组合**：`A3`（WebGPU Compute Shader 2.5D 间接漫反射反弹）+ 甜点 1。
- **结论**：在 AMD RDNA 3 WebGPU 上单帧 `8.2–10.8 ms`（90+ FPS），夜景与高饱和插画暗部层次提升显著，已作为可开关的「2.5D 环境反弹光 (GI)」合入正式工坊。

### 甜点 4：AI 轨「指哪打哪」低成本闭环
- **组合**：`C1`（现有 `IC-Light` 接入光球坐标/颜色生成的引导条件图，并在已存在 PBR 通道时提示复用）。
- **为什么是甜点**：无需更换 16–48 GB 重型模型，把物理轨的交互直觉延续到 AI 环境重绘轨上；后续如云端显存与授权条件匹配，再按需实验 `LightLab`（C3）或 `IC-Light-v2`（C4）。

---

## 5. 实验验证标准（如何挑选最终保留的甜点）

每次试验新方案时，建议用固定 **4 类典型样张** 做同图对照验收：
1. **强原图阴影人像**（检验背光提亮能力、面部法线连续性、皮肤不发灰）；
2. **二次元 / 扁平插画**（检验无黑边伪影、轮廓光自然度、高频微法线是否产生脏点）；
3. **纵深室内 / 建筑街景**（检验深度 Raymarching 投射阴影准确性、空间透视感）；
4. **游戏道具 / 金属材质资产**（检验有/无 PBR 四通道接入时的高光质感与金属度表现）。

量化与门禁参考指标：
- **端侧预处理耗时**：WebGPU ONNX 单图几何推理目标 `≤ 1.5s`（CPU 兜底需明确标注并可取消）；
- **拖动交互帧率**：`640px` 以上预览画布拖动光球保持流畅（目标 `≥ 30~60 fps`）；
- **向下兼容**：无 WebGPU 环境（旧浏览器 / 禁用 GPU）必须无报错平滑回退到现有 WebGL 1 / CPU 路径；
- **协议透明**：任何新增非商用/研究模型继续沿用 `shared/contract.js` / `shared/local-models.js` 的静默协议标签机制。

---

## 6. 隔离沙盒实测记录（2026-11-27 · AMD RDNA 3 WebGPU）

在不动主工作区任何业务源码的前提下，于独立沙盒对工作区 7 组真实样本（人像、CHORD PBR 盾牌、渔夫肖像、二次元霓虹夜景、微缩拉面摊）执行了 `640×640` 同图 A/B 实测：

1. **性能与高光过曝改善**：
   - **Baseline（现行 `relightWebGL.js`）**：单帧 `4.93–62.36 ms`，普遍出现高光过曝（`8.74%–27.07%` 像素截断）、无投影、暗部发灰或二次元色调偏移；
   - **甜点 1（WebGPU 线性 GGX PBR + 深度 Raymarching 阴影 + 7×7 双边去噪 + SSAO + Detail Bump + 双色光 + 自发光保护）**：单帧 **`2.53–3.44 ms`**（稳定 290+ FPS），高光过曝率降至 **`0.01%–3.02%`**；
   - **甜点 3（甜点 1 + WebGPU Compute 2.5D 间接反弹光 GI）**：单帧 **`8.18–10.78 ms`**（稳定 90+ FPS），在二次元霓虹夜景（`04-anime`）与暗部场景上明显增强色溢氛围与暗部层次。
2. **关键反直觉发现（决定选型）**：
   - **端侧 `MoGe-2 ViT-S` WebGPU ONNX 已实测跑通**（需传入 `0-D` 标量 `int64` `num_tokens`，实测耗时 **`675.9–1533.3 ms`**，快于 WASM 版 `DA3-Small` 的 `2192–3257 ms`）；
   - 端侧默认继续保留 `DA3-Small`（37 MB，边缘最干净），不引入 `MoGe-2 ViT-S` 或大体积 `DA3-Base` 作为默认端侧底座。
3. **本机 DA3 Scaling 实测补充（`DA3-Base` & `DA3Mono-Large Q4F16`）**：
   - **`DA3Mono-Large Q4F16`（336 MB）**：在 `onnxruntime-web@1.22.0` WebGPU 后端跑 `MatMulNBits` 会静默饱和在 `[0.98, 1.07]`；切回 WASM 才输出正常视差 `[0.00008, 2.71]`，但 `252×252` 耗时已达 `10.6s`，不适合端侧交互；
   - **`DA3-Base`（376 MB FP32, `518×518`）**：在 WebGPU 上以 `uint8` 原始像素输入顺利跑通，推理 **`1.35–1.72s`**（快于 WASM 版 `DA3-Small`）；但同图直比下，动漫与微缩模型打光效果几乎与 `DA3-Small` 持平，人像雾天天空还因裁剪了天空分支而出现轻微斑驳云块，投入产出比偏低。
4. **三条已验证的着色器避坑要点与正式合入（`324fec1`）**：
   - 深度纹理必须用 **`r32float` 浮点直传**，避免 8-bit 深度量化在 2.5D GI 中产生天空等高线波纹；
   - 阴影需配 **7×7 深度双边去噪（`stride ~ 2.2`）+ 远景天空衰减（`skyFade`）**，防止平滑墙面步进条纹与人物对天空投出幽灵阴影；
   - 对原图高亮度高饱和区域保留**自发光底座（Emissive Preservation）**，防止灯笼、霓虹灯牌等光源在重打光后“熄灭”；
   - 以上甜点 1（默认）+ 甜点 3（`2.5D 环境反弹光 GI` 开关）+ `lightZ` / 投射阴影 / 聚光收束控件已于 `324fec1` 正式合入 [`relightWebGPU.js`](../web/logic/relightWebGPU.js)、[`relightWebGL.js`](../web/logic/relightWebGL.js)、[`relight.js`](../web/logic/relight.js) 与工坊界面，并经 `test/check-client-depth-fx.mjs`（12/12）、`test/check-client-workshop.mjs`（48/48）、`test:client`（30/30）及真机 Chrome WebGPU 冒烟验证。
