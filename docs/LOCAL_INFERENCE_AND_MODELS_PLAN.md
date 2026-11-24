# 本机端侧模型统一管理与现代推理管线方案

> **定位**：将分散在各业务模块中的本机端侧模型（工坊 L2 视觉感知 `MobileCLIP-S0`、工坊本机背景抠图 `RMBG-1.4` 等）收口为「**单源注册表 + Host 统一磁盘托管 + 渲染进程 Web Worker 现代推理管线 + 设置页统一可视化管理**」，为后续更多端侧小模型与本机重型生图（[`LOCAL_GPU_VULKAN_PLAN.md`](LOCAL_GPU_VULKAN_PLAN.md)）建立清晰的分层基线。  
> **制定日期**：2026-11-25。

---

## 1. 背景与第一性原理边界

### 1.1 现存问题
1. **工坊 L2（M4.2c Phase 2）的局限**：[`server/workshop-vision.js`](../server/workshop-vision.js) 虽然以静态锚点（14 KB）和单飞下载把包体积压到了极致，但模型下载、校验与缓存硬编码在单模块内、存放在 `<workspace>/.aigc-studio/models/`（切换工作区会重复下载），且在 Node 单线程 WASM 下推理约 `235 ms`，界面没有任何可见入口、清理手段或关闭开关。
2. **背景抠图的体验断层**：原 `cutout`（`remove-bg`）强绑远端 GPU Worker，用户仅为抠一张图也要经历 3 分钟云端开机与排队；此外实测发现远端旧链路还存在 `birefnet` 触发默认 7.8 GiB SDXL 预加载、缺 `kornia`/`timm` 报错等问题。
3. **本机能力碎片化**：纯 JS `<canvas>`、Node `@visioncortex/vtracer` WASM、Node `onnxruntime-web`（MobileCLIP）、渲染进程 `onnxruntime-web` WebGPU（抠图）各自运行，且主线程执行推理会阻塞 UI 动效。

### 1.2 两层收敛架构（按计算物理边界划分）

| 层级 | 覆盖模型与体积 | 运行引擎与位置 | 加速策略 | 为什么这样分层 |
| :--- | :--- | :--- | :--- | :--- |
| **第一层：端侧轻量视觉 / 感知 / 后处理** | `MobileCLIP-S0`（22.9 MB）、`RMBG-1.4`（44–88 MB）、及后续深度/局部分割/轻量超分（10–300 MB，单次前向） | **Electron 渲染进程专用 Inference Web Worker**（`onnxruntime-web@1.22.0`） | **按模型宣告执行后端**：`WebGPU (FP16)` 优先，失败或无硬件时自动降级 `WASM SIMD (INT8)` | 零 Python、零 C++ 原生编译（保持 `npmRebuild: false`）；推理脱离 UI 主线程与 Node HTTP 主进程，不卡界面动画 |
| **第二层：本机重型扩散生成 / 3D 白模** | `SDXL` / `Z-Image` / `FLUX.2` 等（2–14 GB，多步迭代） | **`stable-diffusion.cpp` (`sd-server`)** 独立子进程 | **Vulkan (`ggml-vulkan`) / CUDA + GGUF 量化**（见 [`LOCAL_GPU_VULKAN_PLAN.md`](LOCAL_GPU_VULKAN_PLAN.md)） | WebGPU 有单 Buffer 上限且缺少针对扩散大模型的 GGUF 融合反量化内核；由 `sd-server` 独立承接再并入 `JobQueue` |

---

## 2. 本机实测基线（Electron 44 · AMD Radeon 880M RDNA3）

以下数据来自本机真机实测（`onnxruntime-web@1.22.0`）：

| 模型 | 规格 / 体积 | 协议 | WebGPU 实测 | WASM 实测 | 结论与选型 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `onnx-community/BiRefNet_lite-ONNX` | FP16（114 MB，1024²） | MIT | 推理抛 WASM C++ 异常 `130215248` | 推理抛异常 `309897984` | **放弃 FP16**：其 `config.json` 已标 `dtype=fp32`，ORT-Web 下不可用 |
| **`briaai/RMBG-1.4`** | **FP16（88.2 MB，1024²）** | 非商用 | **create 3.5s · 冷首帧 1.28s · 稳态 0.54s**（透明占比 47.1%，对齐 BiRefNet 47.08%） | 9.6–11.3s | **WebGPU 主力**：速度与边缘质量极佳 |
| **`briaai/RMBG-1.4`** | **INT8（44.4 MB，1024²）** | 非商用 | 6.7–7.5s（量化节点回退） | **create 0.18s · 5.75s** | **无 WebGPU 设备自动兜底** |
| `Xenova/modnet` | FP32（25.9 MB，512²） | Apache-2.0 | 0.14s（稳态） | 1.12s | 仅专精人像，不适合游戏道具/场景通用抠图 |
| **`Xenova/mobileclip_s0`** | **FP16（22.9 MB，256²）** | Apple ML-MobileCLIP | Worker 内抛 `57086912` | **Worker 内 create 0.20s · 稳态 0.34s** | **固定 `wasm` EP 在 Worker 后台执行**，不与 WebGPU 抠图抢设备，且避免 UI 卡顿 |

---

## 3. 统一架构设计

### 3.1 单源模型注册表（`shared/local-models.js`）
- 集中登记所有按需下载的端侧模型：`id`、`task`（`vision` / `cutout`）、`label`、`grade`、`runtime`、`preferredEps`（如 `['webgpu', 'wasm']` 或 `['wasm']`）、`repo`、`revision`、`asset`、`url`、`sha256`、`bytes`、`file`、`legacyWorkspaceSubpath`、`license`、`input` 预处理规格、`optional`（是否允许用户关闭）。
- 随包内置能力（无需下载，例如 `@visioncortex/vtracer` SVG WASM、`<canvas>` 确定性图像算子）在文档与设置页中作为「随包内置引擎」只读展示，不混入下载队列。

### 3.2 Host 统一模型托管（`server/local-models.js` + `server/app-config.js`）
- **全局持久化目录**：`AIGC_STUDIO_LOCAL_MODELS_DIR` > `appConfig.getLocalModelsDir()`（可在设置页修改到非系统盘）> 默认 `<userData>/models/`，切换工作区不重复下载。
- **向下兼容**：若旧工作区 `<workspace>/.aigc-studio/models/<legacyWorkspaceSubpath>` 存在已通过校验的权重，直接命中复用。
- **下载与校验**：单飞并发锁 + 流式读取进度统计 + 字节数 & SHA-256 严格校验 + 原子落盘 + 失败冷却。
- **启用/禁用配置**：`appConfig` 持久化 `disabledLocalModels`（如用户可关闭 `mobileclip-s0-fp16` L2 视觉感知或禁用本机 `rmbg-1.4` 改用云端）；与环境变量（如 `AIGC_STUDIO_WORKSHOP_VISION=0`）共同生效。
- **统一管理 API**（[`server/routes/local-models.js`](../server/routes/local-models.js)）：
  - `GET /api/local-models`：目录信息、全局开关状态与全量模型列表/进度；
  - `POST /api/local-models/download` / `delete` / `dir` / `toggle`；
  - `GET /api/local-models/file?id=<id>`：按需下载校验并向渲染进程流式输出 `.onnx` 二进制。

### 3.3 统一浏览器 Inference Web Worker 管线（`web/logic/localInference.worker.js` + `localInference.js`）
- **单一持久化 Worker**：整个渲染进程共享一个专用 Inference Web Worker，按 `${modelId}:${ep}` 缓存 `InferenceSession`，用 `Transferable`（`ArrayBuffer`）零拷贝传递张量与掩膜，彻底避免主线程掉帧。
- **双任务统一承载**：
  - `cutout`：[`web/logic/localCutout.js`](../web/logic/localCutout.js) 采样原图 → 送入 Worker 推理（`rmbg-1.4-fp16` WebGPU 优先，失败自动回退 `rmbg-1.4-q8` WASM）→ 主线程 `<canvas>` 合成透明 PNG 并走 `/api/workshop/save` 落盘；
  - `vision`：[`web/logic/localVision.js`](../web/logic/localVision.js) 把 256×256 RGB 送入同一个 Worker 跑 `mobileclip-s0-fp16`（`wasm` EP），复用静态锚点 [`shared/workshop-vision-anchors.generated.js`](../shared/workshop-vision-anchors.generated.js) 与 [`shared/workshop-scenes.js`](../shared/workshop-scenes.js) 直接在前端完成 L2 分类，**不再需要每次切图把像素 POST 给 Node Host**（Node 端 `/api/workshop/perceive` 仍作为无 Worker 环境/兼容性兜底保留）。

### 3.4 设置页「本机模型」总览面板（`SettingsLocalModelsSection.jsx`）
1. **运行时硬件状态**：实时探测展示 WebGPU 适配器状态（就绪 / 设备架构 / 回退 WASM）与统一管线模式；
2. **模型目录管理**：查看占用空间、修改目录（支持 Electron 原生目录选择）或重置；
3. **可下载模型清单**：按任务展示 `MobileCLIP-S0`、`RMBG-1.4 (FP16)`、`RMBG-1.4 (INT8)` 的体积、加速后端、协议、就绪/下载进度条、**启用/停用开关**与**下载/清理**操作；
4. **随包内置引擎与本地生图规划态**：只读展示 `@visioncortex/vtracer`（SVG）、`<canvas>`（像素/切片/平铺）与预留的 `stable-diffusion.cpp`（Vulkan GGUF）。
