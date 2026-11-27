# 出图挡位联动、通用 LoRA 资产化与推理管线升级规划

> **定位**：解决小参数蒸馏模型（如 `FLUX.2 Klein 4B`）写实人物油腻/塑料感问题，在不引入 ComfyUI 节点复杂度前提下，落地「极速 / 质量」挡位防断层联动、按算力来源适配量化精度、通用风格 LoRA 库（含 Agent 自动推荐）及本机 GPU（`sd-server`）LoRA 接入路径。
> **上位文档**：[`AIGC_STUDIO_STANDALONE_PLAN.md`](AIGC_STUDIO_STANDALONE_PLAN.md)、[`MODEL_ASSET_SPEC.md`](MODEL_ASSET_SPEC.md)、[`COMPUTE_AND_LOCAL_GPU_LOOP_PLAN.md`](COMPUTE_AND_LOCAL_GPU_LOOP_PLAN.md)（§Phase 4）。
> **制定日期**：2026-11-26。
> **状态（2026-11-28）**：本地文件 LoRA、HF Token 透传、SDXL / Z-Image 风格 LoRA 与舞台重绘继承、本机 FLUX.2 极速/质量 Q4/Q8 已完成代码、离线回归与浏览器验证；Worker 镜像已发布并通过真实 Diffusers/PEFT 的 CPU 检查。完整模型 GPU 出图效果仍待专项真机验证，不能将离线通过写成真机验收。
> **本轮边界**：不做远端本地文件上传、`recommendedLoras` 结构化配方联动或全面真机回归；工坊新特效、视频、3D、商业 API 与 Kaggle/Colab 扩展保持冻结。

---

## 一、立项背景：原有问题与三个断层（历史描述，落地状态见第五、六节）

1. **4 步蒸馏模式坍缩（“又油又假”的物理成因）**
   - 当前 [`models/flux2-klein-4b.json`](../models/flux2-klein-4b.json) 使用蒸馏版 `black-forest-labs/FLUX.2-klein-4B`（`steps: 4`、`cfg: 1.0`）。4 步内强行收敛使采样分布倾向训练均值里的“高对比、大面积硬高光、均质颗粒”，写实人像极易出现打蜡/抹油皮肤与结构僵硬。
   - 非蒸馏版 **`black-forest-labs/FLUX.2-klein-base-4B`**（Apache-2.0，同为 4B 参数、组件白名单体积同样约 16 GB）具备完整 CFG 与多步采样信号（官方推荐 `steps=50`、`guidance_scale=4.0`），但之前因耗时过长、未进入 `fast` 主力档而未接入。
   - 社区已有对应 GGUF 量化（如 `leejet/FLUX.2-klein-base-4B-GGUF`：`Q4_0` 2.46 GB / `Q8_0` 4.30 GB），可复用现有 `flux2-vae.safetensors` 与 `Qwen3-4B-Q4_K_M.gguf` 适配低显存云端与本机 `local-gpu`。

2. **单根步数滑块的交互冲突**
   - 蒸馏版锁定 `4 步`，非蒸馏 Base 版有效采样区间是 `20~50 步`（`<20` 步未收敛会出噪点图）。若把 `4` 与 `20~50` 塞在同一根滑块上，中间 `5~19` 是无效死区。
   - [`ParamsSection.jsx`](../web/studio/rail/ParamsSection.jsx) 与 [`models-guide.js`](../shared/models-guide.js) 已具备 `stepModeOf` 的 `'fixed'`（锁定）与 `'range'`（连续滑块 + `fast / balanced / fine` 三段刻度）双态能力，但 [`shared/variants.js`](../shared/variants.js) 目前只能替换 `pipeline`，**不能联动覆盖 `steps`、`cfg`、`stepRange` 与 `tier`**。

3. **LoRA 与配方能力断层**
   - [`shared/game-styles.js`](../shared/game-styles.js) 与 [`StyleSection.jsx`](../web/studio/rail/StyleSection.jsx) 已打通 `flux2` 动态 LoRA 挂载与表单锁，但目录仅限游戏像素风（`GAME_STYLE_LORAS`）；
   - [`shared/tool-specs.js`](../shared/tool-specs.js) 的 `imagen_generate` / `imagen_batch` 尚未暴露 `lora`（与 `variantId`）参数，Agent 无法主动选配 LoRA；
   - `STYLE_LORA_UNSUPPORTED_PROVIDERS` 将 `local-gpu` 标为不支持：实际已锁定在本机使用的 `sd-server`（`master-1133-52491bd`）原生支持 `--lora-model-dir` 与 `--lora-apply-mode auto`（含量化/offload 运行时挂载），缺的是本地 LoRA 校验下载与 [`bridge.js`](../server/local-gpu/bridge.js) 透传链路。

---

## 二、核心设计：正交双轴挡位 + 防断层联动交互

将用户关注的**出图模式**与适配算力的**推理精度**拆为两条正交轴，避免产生“极速-BF16 / 极速-Q4 / 质量-BF16 / 质量-Q4”笛卡尔积下拉框：

### 2.1 轴 1：出图挡位（`fast` 极速 vs `quality` 质量）与防断层联动

| 维度 | 极速挡（`fast`，默认） | 质量挡（`quality`） |
| :--- | :--- | :--- |
| **底层权重** | 蒸馏版（如 `FLUX.2-klein-4B`） | 非蒸馏 Base 版（如 `FLUX.2-klein-base-4B`） |
| **步数控件形态** | `stepMode = 'fixed'`（锁定，滑块不可拖） | `stepMode = 'range'`（连续区间 **`20 ~ 50`**） |
| **默认参数** | `steps: 4`、`cfg: 1.0` | `steps: 32`（均衡）、`cfg: 4.0` |
| **快捷刻度** | 无（显示 `4 步 · 极速锁定`） | `较快 25` ｜ `均衡 32` ｜ `精绘 50` |
| **参数记忆** | 独立记忆 | 切到「极速」再切回「质量」时，保留用户此前微调的 `steps` 与 `cfg` |
| **预期提示** | 极速出图 | 提示可能触发底座重载（首次约需下载/冷启提示） |

> **关键设计**：绝不在界面渲染 `5~19` 步的断层无效区间；两挡位通过切换生效 `variant` / 预设参数自动切换 `stepMode`（`'fixed'` ↔ `'range'`）。

### 2.2 轴 2：推理精度 / 量化挡位（`auto` / `full` / `q8` / `q4`）与多 Provider 路由

继续复用并扩展 [`shared/variants.js`](../shared/variants.js) 与 [`ParamsSection.jsx`](../web/studio/rail/ParamsSection.jsx) 既有的 `precisionOptions` 控件，默认选中 **`自动（auto）`**：

- **云端**：`auto` 只在 Salad 的重模型（满血下载量 ≥24 GB）且存在可用轻量档时选轻量；其它情况保持模型默认精度。Klein 4B 极速挡显式为 FP16，`quality` 显式为 BF16。
- **本机 `local-gpu`**：Klein 4B 的 `auto` / 旧 `full` / 未传档位解析为极速 `local-q4`；显式支持 `local-q8`、`quality-q4` 与 `quality-q8`。质量挡默认 32 步 / CFG 4，核显和资源紧俏设备只给耗时/内存提示，不按估算强制禁用。

### 2.3 契约向后兼容方式（不破坏 `variantId` 协议）

- `models/*.json` 的 `variants[]` 新增可选字段：
  - `mode`: `'fast' | 'quality'`（缺省为 `'fast'` 或跟随主预设，用于标记该变体属于极速还是质量挡）；
  - `precisionTier`: `'full' | 'q8' | 'q4'`（便于 `auto` 按算力路由）；
  - `tier` / `steps` / `cfg` / `stepRange`（可选覆盖项：当选中质量挡变体时，`resolveVariant()` 与客户端有效预设合并逻辑自动覆盖默认 `steps`、`cfg`、`stepRange` 与 `tier`）。
- 请求线上（`/api/generate`、`/api/session/start`、`meta.json`）继续使用单一 `variantId` 字段；云端旧客户端不传时保持原 `full` 行为，本机 Klein 4B 记录实际解析的量化挡位。

---

## 三、通用风格 LoRA 库、Agent 推荐与 `local-gpu` 打通

### 3.1 通用风格 LoRA 目录（向后兼容 `shared/game-styles.js`）

- 保留原有 `GAME_STYLE_LORAS`、`gameStyleById` 等导出名保证现有测试与调用方零破坏，同时抽象出通用分类体系（`STYLE_LORA_CATEGORIES`：`photography` / `game` / `illustration` / `custom`）：
  - 每条 LoRA 增加 `category`、`tags`、`compatibleModes`（如 `['fast', 'quality']`）、`description`（双语说明）；
  - **严格门禁**：任何新增的内置写实摄影/去油腻 LoRA 必须经过 HF 仓库核实（免 gated、文件名与规模可控、真机实测不过度畸变）后才写入内置清单；未实测前先提供“自定义 HF LoRA”入口与写实摄影配方引导。
- 前端 [`StyleSection.jsx`](../web/studio/rail/StyleSection.jsx) 文案从“游戏风格”升级为通用“风格 LoRA”，保留一键「锁定」与触发词自动前置（且不污染编辑态 `prompt`）。

### 3.2 Agent 工具与写实配方闭环

- [`shared/recipes.js`](../shared/recipes.js)：
  - 强化 `photo-portrait` 等写实配方模板与 `notes`，明确写出“禁用 `hyperdetailed / 8k` 等引发塑料高光的词，改用 `dry matte skin, soft overcast diffused light, Kodak Portra 400` 正面视觉描述”；
  - `recommendedLoras` 结构化推荐仍未实现，本轮明确暂缓；现有配方只提供可见文字说明。
- [`shared/tool-specs.js`](../shared/tool-specs.js) 与 [`server/tools.js`](../server/tools.js)：
  - 为 `imagen_generate` 与 `imagen_batch` 增加 `lora`（内置 id 或 `{ repo, weight, scale, trigger }`）和 `variantId` 参数；
  - 执行器直接透传给 `queue.submit()`，校验仍走 [`server/jobs/validator.js`](../server/jobs/validator.js) 与 [`server/jobs/queue.js`](../server/jobs/queue.js) 单源防线。

### 3.3 `local-gpu`（`sd-server`）LoRA 接入路径

已通过 `D:\aigc-local\bin\sd-server.exe --help` 实测确认，仓内锁定的 `master-1133-52491bd` 版本已支持 `--lora-model-dir <string>` 与 `--lora-apply-mode auto`（在量化、CPU offload 或 row-split 权重上自动走运行时 LoRA 应用）：

1. **资产管理**：HF LoRA 由 [`server/local-gpu/loras.js`](../server/local-gpu/loras.js) 按需下载，内置校验信息来自 `shared/game-styles.js`；本地 `.safetensors` 文件导入应用托管目录，以 SHA-256 资产 ID 引用，运行前复制/校验到引擎 `loraDir`。原文件移动不破坏已导入资产；本地文件本轮只用于 `local-gpu`；
2. **启动参数**：在 [`server/local-gpu/runtime.js`](../server/local-gpu/runtime.js) 的 `buildServerArgs` 为 `sd-server` 传入 `--lora-model-dir` 与 `--lora-apply-mode auto`；
3. **请求桥接**：`buildSdRequest` 将 `pipeline.styleLora`（兼容旧 `pipeline.lora`）转为结构化数组 `[{ path, multiplier }]`；用户草稿与图像元数据不写 `<lora:...>`；
4. **门禁现状**：`local-gpu` 已按用户确认开放；底座家族、具体预设和出图模式分别校验。内置 FLUX.2 LoRA 不随 SDXL / Z-Image loader 放开而混用；真实出图质量仍待验收。

---

## 四、云端与本地推理管线长期演进（对接 `COMPUTE_AND_LOCAL_GPU_LOOP_PLAN` §Phase 4）

| 方向 | 对应挡位痛点 | 落地方案 |
| :--- | :--- | :--- |
| **步间特征缓存（TeaCache / FBCache）** | 质量档 25~50 步耗时偏高 | 仅对非蒸馏多步质量档启用（4 步蒸馏继续禁用），在尽量不损皮肤微纹理前提下压低 30%~45% 步数耗时 |
| **Multi-LoRA 热缓存（LRU）** | 用户/Agent 频繁切换风格 LoRA 时重载过慢 | Python Worker（及后续 SGLang Diffusion / vLLM-Omni 评估）保持底座常驻显存，按适配器名称动态切换/驱逐 LoRA |
| **Attention / SVDQuant 加速** | 云端高分辨质量档吞吐低 | N 卡云端评估 `--sage-attn` / `SageAttention` 与 `Nunchaku (SVDQuant W4A4/FP4)`；跨卡/核显本地保留 GGUF |
| **TAESD 渐进缩略预览** | `local-gpu` 质量档等待 30~120s 焦虑 | `sd-server` 已内置 `--taesd` 与 `--taesd-preview-only`（终图仍走完整 VAE），后续接入 SSE 步进预览图 |

---

## 五、分阶段实施与验收清单

- **Phase 1（框架、联动、Agent LoRA 与配方 — 已完成离线落地与回归）**
  - [x] 扩展 [`tools/build-assets.mjs`](../tools/build-assets.mjs)、[`shared/variants.js`](../shared/variants.js)、[`shared/models-guide.js`](../shared/models-guide.js) 与 [`server/jobs/queue.js`](../server/jobs/queue.js)：支持变体级 `mode` / `precisionTier` / `tier` / `steps` / `cfg` / `stepRange` 覆盖与 `auto` 多端路由，并为 `flux2-klein-4b` 接入质量挡位（`black-forest-labs/FLUX.2-klein-base-4B`）；
  - [x] 升级 [`web/logic/preset.js`](../web/logic/preset.js)、[`web/studio/hooks/useStudioForm.js`](../web/studio/hooks/useStudioForm.js) 与 [`web/studio/rail/ParamsSection.jsx`](../web/studio/rail/ParamsSection.jsx)：落地「极速 / 质量」挡位开关、步数防断层联动与质量挡参数记忆；
  - [x] 泛化 [`shared/game-styles.js`](../shared/game-styles.js) 为通用风格 LoRA 目录并同步 [`StyleSection.jsx`](../web/studio/rail/StyleSection.jsx) 与双语词典；
  - [x] 在 [`shared/recipes.js`](../shared/recipes.js)、[`shared/tool-specs.js`](../shared/tool-specs.js) 与 [`server/tools.js`](../server/tools.js) 打通写实去油腻配方优化与 Agent `lora` / `variantId` 调用；
  - [x] 补全单测并通过 `npm run models:check`、`node test/check-contract.mjs`、`node test/check-variants.mjs`、`node test/game-styles.mjs`、`node test/agent-batch.mjs`、`npm run test:client`（29/29）与 `npm run build:web`。
- **Phase 2（`FLUX.2-klein-base-4B` 资产真机验收 + 本地 GGUF 质量挡）**
  - [x] 本机极速 Q4_0 / Q8_0 与 Base 质量 Q4_0 / Q8_0 已接入；VAE 与 Qwen3 共享定义和磁盘路径，已校验组件不重复下载；
  - [ ] Base 完整模型真机出图与 `measured` 实测值仍缺；本轮未运行全面 GPU 验收；
  - [x] 已核实并纳入高频写实细节恢复 LoRA `realism-detail`（`xocialize/consistence-edit-FLUX.2-klein-4B-lora`，Apache-2.0）；待补充纯文生图真机对照。
- **Phase 3（`local-gpu` LoRA 通道 + 推理服务加速）**
  - [x] 已打通 `server/local-gpu/loras.js` + `runtime.js` (`--lora-model-dir` / `--lora-apply-mode auto`) + `bridge.js`（`/sdcpp/v1/models/refresh` 与结构化 `lora` 数组）并放开 `local-gpu` LoRA 限制（待在 `D:\aigc-local` 拉取 `flux2-klein-4b` 权重后真机出图复核）；
  - [x] 本地 `.safetensors` 导入、HF Token 透传、SDXL / Z-Image 风格挂载、SDXL-Lightning 加速/风格双适配器、舞台图生图/重绘参数继承与跨底座提示已落地；
  - [ ] 推进质量档 `TeaCache / FBCache`、Worker Multi-LoRA LRU 与 `sd-server` `--taesd-preview-only`。

## 六、本轮交付与验证（2026-11-28）

- **本地导入**：复用文件选择器或填写路径，Host 校验 safetensors 文件头/张量偏移、大小与 SHA-256；只在本机挂载，切到云端明确拦截。暂未实现远端二进制上传。
- **Token**：本机 HF 模型/LoRA 下载读取实时 `settings.current().hfToken`；Salad 创建容器时注入 `HF_TOKEN`，修改后需新建/重建容器。Token 不进入任务元数据、公开状态或日志。
- **重绘**：工具打开时快照继承 LoRA、`variantId` 和步数/CFG；跨底座/模式不兼容时展示提示，可仅为此次重绘移除 LoRA，左栏保持选择。Python 的 `pipeline.lora` 保留加速适配器，`pipeline.styleLora` 单独挂风格，SDXL-Lightning 同时激活两个命名适配器。
- **精度与时间预算**：极速 `dtype=fp16` 保持既有行为；质量 `dtype=bf16` 修正声明与加载不一致。修复空参数记忆被当作零值；本机质量生成预算至少 60 分钟，本机准备 LoRA/切模型的提交等待最多 35 分钟且计入总预算。
- **镜像**：Salad 默认锁定 `ghcr.io/nanxfu/aigc-worker@sha256:679870fa8e5c922f20f6661af9fae97029a0cde21deefa0dc2806dcd1be29f5a`（`manual-f310715`）。[CI 46033794905](https://github.com/nanxfu/aigc-studio/actions/runs/46033794905) 已通过构建、体积闸门、无 GPU 冒烟和真实 Diffusers/PEFT 微型 Z-Image 普通/量化权重 LoRA 前向及 img2img/inpaint 适配器继承；压缩 3.18 GiB、未压缩 6.12 GiB。旧私有 Worker 需更新镜像，`style_lora` 能力位用于前置报错。
- **验证**：`npm test` 85/85 步、Python 672 项、应用/官网构建、契约与模型一致性检查通过；真实 Chromium 核对导入、Q8 准备请求、中英文、深色和窄屏。未创建付费 GPU 容器，未进行完整模型真机出图；以上 CPU/离线结果不代表画质验收。
