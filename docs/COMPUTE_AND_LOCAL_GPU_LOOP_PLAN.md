# 算力闭环与本机推理架构收敛方案

> **定位**：打通「顶栏算力 Popover → 设置页算力配置 → 顶栏模型卡按需下载 → 本机/云端自适应推理」的完整产品闭环，消除运行态与配置态倒错、单模型硬绑定及跨显卡适配短板。
> **关联文档**：[`LOCAL_GPU_SETTINGS_SIMPLIFICATION_PLAN.md`](LOCAL_GPU_SETTINGS_SIMPLIFICATION_PLAN.md)、[`LOCAL_GPU_VULKAN_PLAN.md`](LOCAL_GPU_VULKAN_PLAN.md)、[`LOCAL_INFERENCE_AND_MODELS_PLAN.md`](LOCAL_INFERENCE_AND_MODELS_PLAN.md)。
> **制定日期**：2026-11-26。
> **状态**：✅ Phase 1–4 已落地（2026-11-26）。SANA-Sprint 1.6B 因暂无官方 1.6B GGUF，显式标记为本机不可下载。

---

## 1. 第一性原理与核心架构原则

回到创作者使用 `aigc-studio` 的真实心智模型，整个生图闭环只有两类正交概念：

1. **算力层（在哪里算）**：回答「用哪台设备 / 哪个云端账号算、环境是否连通、本地存储放哪」。
2. **模型层（用什么画）**：回答「选哪款绘画模型、当前算力能不能跑、本地缺权重时如何按需下载」。

基于这两条边界，确立四项不可违背的设计约束：

- **原则 1（算力与模型彻底解耦）**：所有算力来源（包括 `local-gpu`）在设置页只配置「算力环境与引擎」，**不绑定、不展示具体某一款绘画模型**；模型选择与权重按需下载统一收口到顶栏模型卡（[`ModelCardPicker.jsx`](../web/studio/ModelCardPicker.jsx)）。
- **原则 2（高频运行态与低频配置态隔离）**：顶栏算力 Popover（[`ComputePopover.jsx`](../web/studio/ComputePopover.jsx)）只服务创作期的「已配置算力快切 + 核心状态读数 + 启停」，不铺未配置来源矩阵，不暴露底层自检明文与环境变量。
- **原则 3（去工程术语化）**：界面中不泄露 `sd-server`、`serverPath`、`AIGC_STUDIO_LOCAL_GPU_*`、`GGUF`、`fp16-fix` 等底层实现词；明确区分 **「推理引擎（~30 MB，安装包内置）」** 与 **「绘画模型权重（按模型 2.6~6+ GB）」**。
- **原则 4（硬件自适应，不拿核显保底参数拖慢独显）**：根据真实探测显卡与显存动态下发 `sd-server` 启动参数与设备索引，兼顾核显防爆内存与独显高性能。

---

## 2. 现状问题诊断（对照当前代码）

| 界面 / 模块 | 现状问题 | 涉及文件 |
| :--- | :--- | :--- |
| **算力 Popover** | ① 顶部 2×3 网格把未配置算力全铺在高频弹层，误点即切到不可用状态；<br>② `local-gpu` 直接渲染「推理引擎 / 模型文件 / 显存预算」3 行底层检查，并把 `serverPath / AIGC_STUDIO_LOCAL_GPU_SERVER` 报错原文透出到界面；<br>③ 离线状态仍沿用「云端未启动」口径。 | [`web/studio/ComputePopover.jsx`](../web/studio/ComputePopover.jsx)<br>[`web/logic/status.js`](../web/logic/status.js)<br>[`server/local-gpu/config.js`](../server/local-gpu/config.js) |
| **设置页算力配置** | ① 「本机 GPU」住在名为「云端算力」的 Tab 下，名实不符；<br>② `setup.js` 与 `SettingsLocalGpuSection.jsx` 把「启用本机 GPU」与「下载并绑定 `realvisxl-lightning` 3.13 GB 权重」硬绑定；<br>③ 界面仍留有 `自定义模型文件 / 自定义 VAE / 推理引擎文件` 3 个路径框，且「检测本机显卡 / 查看硬件适配」与「本机模型」Tab 的 `LocalHardwarePanel` 职责重复；<br>④ Kaggle / Colab 通用运行参数（空闲关机、HF Token）未全部折叠收口。 | [`web/studio/SettingsDrawer.jsx`](../web/studio/SettingsDrawer.jsx)<br>[`web/studio/settings/SettingsForm.jsx`](../web/studio/settings/SettingsForm.jsx)<br>[`web/studio/settings/SettingsLocalGpuSection.jsx`](../web/studio/settings/SettingsLocalGpuSection.jsx)<br>[`web/studio/settings/SettingsLocalModelsSection.jsx`](../web/studio/settings/SettingsLocalModelsSection.jsx) |
| **本机模型与运行时** | ① `setup.js` 仅服务单一预设 `LOCAL_GPU_PRESET = 'realvisxl-lightning'`，无法在模型卡按需下载多模型；<br>② `runtime.js` 的 `buildServerArgs` 写死 `--params-backend disk` 与 `--vae-tiling`，未按独显显存优化，且未显式指定 Vulkan 设备索引（双显卡笔记本存在误用核显风险）；<br>③ 仅内置 Vulkan 引擎，N 卡独显未能发挥 CUDA 性能。 | [`shared/local-gpu-assets.js`](../shared/local-gpu-assets.js)<br>[`server/local-gpu/setup.js`](../server/local-gpu/setup.js)<br>[`server/local-gpu/runtime.js`](../server/local-gpu/runtime.js)<br>[`server/local-gpu/probe.js`](../server/local-gpu/probe.js)<br>[`shared/gpu-benchmark.js`](../shared/gpu-benchmark.js) |

---

## 3. 分阶段设计闭环方案（Coding 专员执行指南）

> **执行建议**：按 Phase 1 → Phase 2 → Phase 3 → Phase 4 顺序推进。Phase 1 与 Phase 2 先把界面心智与职责边界收口干净；Phase 3 完成模型卡按需下载多模型闭环；Phase 4 补齐 N 卡 / 多型号 A 卡自适应与管线提速。

### Phase 1：算力 Popover 极简闭环

**目标文件**：[`web/studio/ComputePopover.jsx`](../web/studio/ComputePopover.jsx)、[`web/logic/status.js`](../web/logic/status.js)、[`web/dict/zh.js`](../web/dict/zh.js)、[`web/dict/en.js`](../web/dict/en.js)。

1. **切换区只展示「已配置 / 可用」的算力来源**：
   - 使用 `configuredProviderSet`（来自 `compute.configuredProviders` 与各端配置状态）过滤 `SETTINGS.providers`。
   - **仅 1 个已配置来源时**：不渲染 2×3 网格，只保留顶部当前来源状态标题 + 底部轻量的「切换 / 添加算力」入口跳转设置。
   - **≥2 个已配置来源时**：渲染紧凑的胶囊切换行（单排/双排自适应），**未配置的来源不出现在 Popover 切换区**，改为底部一条 `+ 管理或添加算力` 次级入口进设置页。
2. **彻底清除 `local-gpu` 底层检查与报错透传**：
   - 删除 `ComputePopover.jsx` 中 `isLocalGpu` 分支里的 `serverLabel`（推理引擎）、`modelLabel`（模型文件）、`vramBudget`（显存预算）三行明文检查，以及 `localGpu?.errors[0]` 的英文/环境变量报错展示。
   - **本机 GPU 未准备就绪时**：仅展示 1 句人话说明（例如：`本机显卡支持离线生图，需在设置中完成环境准备`）+ 1 个主按钮 `配置本机 GPU`（跳转设置 `compute` 页签并定位 `local-gpu`）。
   - **本机 GPU 引擎已就绪时**：摘要区仅展示 `显卡短名（如 Radeon 880M / RTX 4060）` + 若当前所选模型未下载，提示一句 `当前模型尚未下载，请在模型卡中下载后使用`；主按钮按运行状态显示 `启动本机引擎` / `停止本机引擎`。
3. **修复 `local-gpu` 状态文案错位**：
   - 在 `computeStatusOf` / `providerCopyKeyOf`（[`web/logic/status.js`](../web/logic/status.js)）为 `local-gpu` 补齐语义化文案变体（如 `absent` 对应 `本机待机` / `未启动`，`starting` 对应 `正在启动引擎`，不再出现「本机 GPU · 云端未启动」）。

---

### Phase 2：设置页「算力 vs 本机模型」职责收口

**目标文件**：[`web/studio/settings/SettingsForm.jsx`](../web/studio/settings/SettingsForm.jsx)、[`web/studio/settings/SettingsLocalGpuSection.jsx`](../web/studio/settings/SettingsLocalGpuSection.jsx)、[`web/studio/settings/SettingsLocalModelsSection.jsx`](../web/studio/settings/SettingsLocalModelsSection.jsx)、[`web/studio/SettingsDrawer.jsx`](../web/studio/SettingsDrawer.jsx)、[`server/local-gpu/config.js`](../server/local-gpu/config.js)。

1. **页签命名修正**：
   - `settings.nav.compute` 文案由 `云端算力` 改为 `生图算力`（英文保持 `Compute`），消除「本机 GPU 住在云端算力页签」的违和感。
2. **拆解「本机 GPU」设置面板与模型绑定的耦合**：
   - **移除 UI 上的模型/VAE/引擎「自定义路径」3 个输入框**：桌面正式版不再向 UI 暴露 `modelPath`、`vaePath`、`serverPath` 表单（对应状态逻辑 [`web/logic/localGpu.js`](../web/logic/localGpu.js) 同步简化；极客调试与自带路径继续通过 `local-gpu.json` 与 `AIGC_STUDIO_LOCAL_GPU_*` 环境变量完全保留支持）。
   - **移除跨 Tab 跳转「查看硬件适配」**：检测显卡后直接在当前面板内给出一句直观结论（例如：`检测到 AMD Radeon 880M（建议分配显存 10 GB · 支持轻量与 4B 量化模型）` 或 `检测到 NVIDIA RTX 4060（8 GB · 支持全部轻量与主力模型）`）。
   - **设置页只做 3 件事**：
     1. **显卡与环境状态**：显示主显卡名称、引擎状态（`随包内置已就绪` / `需准备引擎 ~30 MB` / 开发态提示）。
     2. **显卡检测**：`检测本机显卡` 按钮。
     3. **模型存储目录（单源复用）**：直接复用或内联 `localModels` 的全局模型目录设置（[`GET/POST /api/local-models/dir`](../shared/contract.js#L96)），让用户清楚本机绘画模型与本机辅助模型（抠图/感知）存在同一处，不占用系统盘。
3. **「本机模型」Tab 职责收敛**：
   - [`SettingsLocalModelsSection.jsx`](../web/studio/settings/SettingsLocalModelsSection.jsx) 聚焦为 **「离线辅助组件与存储」**（存储目录 + 视觉感知/抠图 ONNX 组件 + 只读内置能力清单），不再承担「生图算力硬件天梯入口」或与 `SettingsLocalGpuSection` 互相跳转。
4. **顺手收口 Kaggle / Colab 次级表单**：
   - 将 [`SettingsForm.jsx`](../web/studio/settings/SettingsForm.jsx) 中仅对远程 Notebook 生效的 `空闲自动关机` 与 `HF Token` 一并收进 [`SettingsAdvancedSection.jsx`](../web/studio/settings/SettingsAdvancedSection.jsx) 的折叠高级区内，使选中任何算力来源时第一屏信息密度一致、不超过一屏。

---

### Phase 3：顶栏模型卡「本机多模型按需下载与热切换」

**目标文件**：[`shared/local-gpu-assets.js`](../shared/local-gpu-assets.js)、[`server/local-gpu/config.js`](../server/local-gpu/config.js)、[`server/local-gpu/setup.js`](../server/local-gpu/setup.js)、[`server/providers/local-gpu.js`](../server/providers/local-gpu.js)、[`web/studio/ModelCardPicker.jsx`](../web/studio/ModelCardPicker.jsx)、[`shared/contract.js`](../shared/contract.js)。

1. **判定边界重定义：`local-gpu` 是否「已配置」不再强依赖先下载某一个模型**：
   - 在 [`server/local-gpu/config.js`](../server/local-gpu/config.js) 中拆分两层就绪状态：
     - `engineReady`（显卡支持 Vulkan/CUDA + `sd-server` 可执行文件就绪，或 `useBundledEngine === true`）→ 决定 **`local-gpu` 作为算力来源已配置**，可在顶栏 Popover 与设置中选中；
     - `models[presetId]`（某个具体绘画模型及其 VAE/Text Encoder 文件存在且通过校验）→ 决定 **该模型在本地是否可直接出图**。
2. **多模型本地资产注册表（`shared/local-gpu-assets.js` 扩展）**：
   - 将当前仅针对 `realvisxl-lightning` 的单常量 `LOCAL_GPU_WEIGHTS`，升级为按 `presetId` 索引的多模型清单 `LOCAL_GPU_MODEL_ASSETS`（每个条目声明所需的主权重 GGUF、可选独立 VAE / Text Encoder、总字节数、SHA-256、兼容架构与最低显存门槛）。
   - 优先补齐仓内已有模型的本地 GGUF 资产定义（与 [`shared/gpu-benchmark.js`](../shared/gpu-benchmark.js) 及 `models/*.json` 对齐）：
     - `realvisxl-lightning`（~2.9 GB，4 步写实，全显卡兜底）
     - `flux2-klein-4b`（4 步开源主力，中英文支持）
     - `z-image-turbo`（高质量中文支持，中高显存/统一内存）
     - `sana-sprint-1.6b`（轻量极速）
3. **模型卡就地按需下载与进程热切换**：
   - 当 `provider === 'local-gpu'` 时，[`ModelCardPicker.jsx`](../web/studio/ModelCardPicker.jsx) 结合 `evaluatePresetLocalFit` 展示每个模型的本地状态标签：
     - **本地已就绪**（绿点）：直接选中开画；
     - **可下载（含体积，如 `需下载 2.9 GB`）**：点击选中或点行内下载按钮，调用参数化后的准备接口（如 `POST /api/local-gpu/setup` 传入 `{ presetId }`）就地显示下载进度条与取消按钮，下完自动写入 `local-gpu.json` 的 `models[presetId]`；
     - **超出当前显卡能力**（如 24GB 级大模型在 8GB 卡上）：标注「显存不足，建议切云端」，点击可一键切到已配置的云端算力或提示原因。
   - **模型切换重启托管**：当用户切到另一个已下载的本地模型提交生图或点启动时，[`LocalGpuRuntime`](../server/local-gpu/runtime.js) 检测到目标 `presetId` 与当前运行中进程加载的模型路径不一致时，自动平滑重启 `sd-server` 指向新模型路径（单进程串行，不叠加显存）。

---

### Phase 4：跨卡自适应（N 卡 / A 卡 / 双显卡）与推理管线升级

**目标文件**：[`server/hardware-probe.js`](../server/hardware-probe.js)、[`server/local-gpu/probe.js`](../server/local-gpu/probe.js)、[`server/local-gpu/runtime.js`](../server/local-gpu/runtime.js)、[`server/local-gpu/engine.js`](../server/local-gpu/engine.js)、[`shared/gpu-benchmark.js`](../shared/gpu-benchmark.js)。

1. **修复双显卡笔记本选错卡问题（设备索引对齐）**：
   - `probe.js` 解析 `sd-server --list-devices` 后，按「NVIDIA / AMD 独显优先于核显」选出最优设备（规避 `Vulkan0` 是核显、`Vulkan1` 才是独显时默认跑在核显上的问题），并在支持设备选择参数时透传给 `buildServerArgs`（需实测当前 `sd-server` 版本支持的 device 参数或环境变量如 `GGML_VK_VISIBLE_DEVICES`）。
2. **显存分层自适应启动参数（告别“一刀切核显保底参数”）**：
   - 在 `buildServerArgs`（[`server/local-gpu/runtime.js`](../server/local-gpu/runtime.js#L141)）中根据探测到的有效显存/内存档位决定参数，不再对所有机器写死 `--params-backend disk` 与 `--vae-tiling`：
     - **低显存 / 核显共享内存（< 8 GB 可用显存或统一内存空闲 RAM 紧张）**：保持 `--params-backend disk --vae-tiling`，确保不爆内存、桌面不卡；
     - **主流独显（8~12 GB 显存）**：启用 `--offload-to-cpu`（当系统内存充足时）或全显存加载轻量 Q4 模型，按画幅决定是否开 `--vae-tiling`，并评估开启 `--diffusion-fa`；
     - **大显存独显（≥ 16 GB 显存，如 RTX 3090/4080/4090、RX 7800/7900 XT）**：关闭磁盘换页与 VAE 分块（权重常驻显存），直接释放单卡峰值吞吐。
3. **N 卡 CUDA 引擎按需分流**：
   - 保持安装包内置轻量 `Vulkan` 包（~30 MB，覆盖 A 卡/核显/开箱即用零依赖），同时在检测到 NVIDIA 独显且用户启用本地引擎时，支持按需拉取 `leejet/stable-diffusion.cpp` 官方 `win-cu12-x64` 预编译包（CUDA 后端），并使 [`shared/gpu-benchmark.js`](../shared/gpu-benchmark.js) 展示的实际加速后端名称（`CUDA` vs `Vulkan`）与当前运行引擎保持真实一致。
4. **后续管线加速技术演进（本地 + 自建云端 Worker/Salad）**：
   - **本地体验提速**：评估接入 `TAESD` 中间步流式缩略预览（降低 20~60s 等待焦躁）、以及现代 DiT（`Z-Image` / `FLUX.2`）的 Text Encoder 独立 Q4 量化与编码后即卸策略。
   - **云端容器/Worker 加速**：评估将自建远端 Worker / Salad 镜像推理底座向 **SGLang Diffusion** / **vLLM-Omni**（针对 LLM Encoder + DiT 分阶段解耦）演进，并在管线中集成 **TeaCache / FirstBlockCache**（步间特征缓存跳过）与 **SageAttention** / **Nunchaku (SVDQuant W4A4/FP4)** 量化加速。

---

## 4. 验收与回归要求

Coding 专员在每个 Phase 实施后，需同步更新并跑通以下验证：

1. **契约与词典一致性**：
   - 修改 [`shared/contract.js`](../shared/contract.js) 或 [`web/dict/zh.js`](../web/dict/zh.js) / [`web/dict/en.js`](../web/dict/en.js) 后，确保中英词典键集合一致，运行 `node test/check-contract.mjs`。
2. **前端交互与局部单测**：
   - 更新并运行 [`test/check-client-local-gpu.mjs`](../test/check-client-local-gpu.mjs) 及顶部栏/弹层相关客户端校验（覆盖：Popover 仅显示已配置来源、不再出现底层 `sd-server` 报错文案、设置页不再暴露自定义路径框、模型卡按需下载与切换）。
3. **本机运行时与硬件探测测试**：
   - 涉及 `server/local-gpu/` 与 `server/hardware-probe.js` 改动时，补充多显卡设备选择、显存分档 `buildServerArgs` 纯函数单测（覆盖核显 880M 与 N 卡 8G/24G 模拟快照），并运行 `node test/local-gpu-runtime.mjs` 与全量 `npm test`。
4. **实机回归（Windows x64）**：
   - 若涉及 `sd-server` 参数变更或新模型资产上线，需分别在核显（如 880M Vulkan）与 N 卡独显环境跑通至少 1 次完整文生图冷启动与模型热切换验证。

---

## 5. 落地结果（2026-11-26）

- **算力 / 模型解耦**：`local-gpu` 的就绪条件改为引擎可执行文件可用；具体模型由 `models[presetId]` 判断。设置页不再绑定或展示绘画权重。
- **顶栏闭环**：Popover 只列已配置来源；单来源不渲染切换网格；本机 GPU 不再透出路径、环境变量或引擎错误原文。
- **设置页收口**：页签改为「生图算力」；本机 GPU 仅保留引擎状态、显卡检测结论与共享模型目录；空闲关机 / HF Token 移入折叠高级区。
- **多模型按需下载**：顶栏模型卡按 `evalPresetLocalFit` 展示已下载 / 需下载体积 / 下载进度 / 不可用；参数化 `POST /api/local-gpu/setup { action, presetId }`，完成后自动选中并刷新 `/state`。
- **资产注册表**：已登记 RealVisXL V5 Lightning、FLUX.2 Klein 4B、Z-Image Turbo 三套可校验 GGUF；SANA-Sprint 1.6B 因官方 1.6B GGUF 缺失显式标注不可用，不填伪造链接。
- **跨卡自适应**：`sd-server --list-devices` 解析后优先 NVIDIA / AMD 独显，`--backend` 显式绑定设备；启动参数按核显 / 8–14 GB 独显 / ≥14 GB 独显三档选择 `--params-backend`、`--offload-to-cpu` 与 `--vae-tiling`。
- **N 卡 CUDA**：检测到 NVIDIA 独显时按需准备 CUDA 引擎与 cudart；A 卡 / 核显继续使用随包 Vulkan。
- **自动化验证**：`node test/check-contract.mjs`、`node test/check-client-local-gpu.mjs`、`node test/local-gpu-runtime.mjs`、全量 `npm test`、`npm run build:web` 均通过。
- **Windows x64 实机验证**：AMD Radeon 880M（Vulkan）使用 RealVisXL V5 Lightning Q4_K + FP16 VAE 跑通 512² / 4 步冷启动与热复用，冷任务 **17.92 s**、热任务 **13.96 s**，产物为合法 PNG；模型与 VAE 均通过 SHA-256 校验，断开后进程已回收。N 卡 CUDA 真机仍需在 NVIDIA 设备上复核。
