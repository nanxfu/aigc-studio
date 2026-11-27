# 工坊强本机 GPU 混合调度与云/本地智能推荐方案

> **定位**：M4.2f 专项规划。基于既有 `hardwareProbe`、`shared/workshop-compute.js`、独立 `uv` PyTorch/CUDA 运行时（`server/local-pbr.js`）与 `JobQueue` 统一串行队列，在**不增加重复架构、不打断用户当前工作流**的前提下，为工坊所有算子建立「端侧 ONNX → 本机 CUDA → 云端 GPU」三层算力分级、状态徽章与双向非侵入式切换推荐机制。
> **关联基准**：[`WORKSHOP_COMPUTE.md`](WORKSHOP_COMPUTE.md)（PBR 本地/云端基线）、[`LOCAL_INFERENCE_AND_MODELS_PLAN.md`](LOCAL_INFERENCE_AND_MODELS_PLAN.md)（端侧 WebGPU/WASM ONNX 管线）、[`WORKSHOP_DEPTH_AND_LIGHTING_PLAN.md`](WORKSHOP_DEPTH_AND_LIGHTING_PLAN.md)（M4.2e 深度与打光模型清单）。

---

## 1. 第一性原理与问题拆解

当前生图与工坊链路的用户硬件呈明显两极分化：

1. **轻端 / 核显 / macOS 设备**：没有桌面级 NVIDIA 独显或显存不足 8 GB，高精深度模型（`MoGe-2 ViT-L` / `DA3-Large`）、`IC-Light` AI 重打光与 `Marigold` PBR 必须由云端 GPU（Kaggle / Colab / SaladCloud / 私有 Worker）承接；本地仅运行亚秒级/数秒级轻量化 ONNX（`DA3-Small` / `RMBG-1.4` / `MobileCLIP`）。
2. **强本机 NVIDIA GPU 设备（如 RTX 3060 12GB / 4070 / 4080 / 4090）**：这类用户往往为了主生图使用云端大模型（或临时切在 Kaggle/Colab 上做生图测试），但**当进入工坊做 PBR 拆解、高精度深度图或 IC-Light 重打光时，如果一律跟随全局云端 Provider 排队上云，每次请求都要承担网络传输 + 隧道探测 + 云卡排队/冷启动成本，还会无谓消耗云卡配额**；反过来，若用户本机算力明显不足以跑某高精挡位，却强行本机排队推理，只会导致长时间卡死或 OOM。

因此，最短路径不是为每一个工坊新模型单独发明一套后端，而是把已在 PBR 上验证成功的本地隔离链路泛化为通用规则：

- **硬件判定统一**：复用 `server/hardware-probe.js` 的只读探测输出（NVIDIA CUDA `vramMb` / `vramFreeMb` / `driverVersion`、系统内存与模型盘余量），严禁把 WMI 32 位截断值当高显存。
- **能力矩阵统一**：把 `shared/workshop-compute.js` 从只服务 `LOCAL_PBR` 演进为覆盖工坊全部模型/挡位的统一评估器。
- **隔离运行环境统一**：复用应用数据目录下现有 `runtime/local-pbr/`（Python 3.11 + PyTorch 2.6 + CUDA 固定 `uv` 环境），拓展子命令跑 `DA3Mono-Large` / `DA3-Large` / `MoGe-2 ViT-L` / `IC-Light`，避免用户重复下载多个 2–3 GB 的 PyTorch CUDA 栈。
- **队列互斥统一**：所有本机 CUDA 与云端工坊任务继续共用 `server/jobs/queue.js`（`JobQueue`）串行槽位，防止本地多任务同时申请显存互相挤爆。

---

## 2. 工坊模型三层算力分级矩阵

所有工坊算子与模型按计算特性划分为三层，每一层对「默认运行位置」「是否允许用户覆盖」「UI 状态标识」都有明确边界：

| 分级 | 典型算子 / 模型 | 运行引擎 | 推荐本地硬件门槛 | 预期下载体量（未缓存时） | 调度与覆盖策略 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1：纯端侧轻量** | `DA3-Small`（`da3-small-int8`）、`RMBG-1.4`、`MobileCLIP-S0` | WebGPU FP16 / WASM INT8 ONNX（零 Python 依赖） | 任意现代 CPU / 核显浏览器环境 | 约 35–180 MB（单模型一次性缓存） | **始终本机端侧运行**，不上云、不入远程队列；标为 `端侧秒算`。 |
| **Tier 2a：本机 CUDA 友好** | `Marigold` PBR（已有）、`DA3Mono-Large`、`DA3-Large` | 隔离 `uv` Python + PyTorch CUDA（FP16 + CPU Offload）或云端 GPU Worker | Windows / Linux x64，单张 NVIDIA CUDA、`>= 8 GB` 级显卡、`>= 5 GiB` 空闲显存、`>= 16 GB` 级内存（空闲 `>= 4 GiB`） | 环境约 2.5–3 GB（首次全工坊共享一次）；单深度模型约 1.4–1.8 GB（Marigold ~5.16 GB） | 达标时推荐 `本机 GPU 可跑`，否则自动推荐 `建议上云` 并默认提交云端队列；已安装前可提示下载体量。 |
| **Tier 2b：中重度 CUDA（需更高空闲显存）** | `MoGe-2 ViT-L`、`IC-Light`（SD1.5 重打光）、后续可选 `BiRefNet` | 同上（共享 `uv` PyTorch CUDA 环境，复用 `worker/inference/game_ops.py` 算法核心） | Windows / Linux x64，单张 NVIDIA CUDA、`>= 10–12 GB` 推荐（8 GB 需空闲 `>= 6 GiB`）、系统内存空闲 `>= 4 GiB`、首次准备磁盘 `>= 12 GiB` | 共享 CUDA 环境 + 单模型约 1.5–6.5 GB（权重缓存后磁盘仅需 `>= 1 GiB` 运行余量） | 空闲显存充足时允许一键切本机免排队；若只有 8 GB 紧俏显存或正在运行其他重任务，标 `建议上云`。 |
| **Tier 3：仅限云端** | 重型 CUDA 编译扩展、24 GB+ 视频/3D 模型（如后续 M4.3 `LTX-2` / `Wan 2.2`、M4.4 `Hunyuan3D` / `TRELLIS.2`） | 仅云端 GPU Worker | 本机不满足最低运行契约或缺乏 Linux/WSL 编译算子支持 | 云端自管理 | 本机入口禁止选中本地，标 `仅云端` 并展示明确硬件/架构门槛说明。 |

> [!IMPORTANT]
> **绝不静默后台下载 GB 级依赖**：Tier 2 的 `uv` Python 环境或模型权重绝不在用户打开工坊时偷偷下载；仅当用户**显式确认切换并提交任务**（或点击环境准备）时才开始下载，且 UI 必须事前写明本次新增下载体量与缓存状态。

---

## 3. 统一能力评估器设计（Host & Shared）

将 `shared/workshop-compute.js` 中现有的 `LOCAL_PBR` 与 `evaluateLocalPbr(hardware, options)` 升级为面向所有工坊算子的统一规则表与评估函数（保留 `evaluateLocalPbr` 作为向后兼容导出，内部委托新接口）。

### 3.1 模型档位声明表（`WORKSHOP_COMPUTE_PROFILES`）

每个可切换计算位置的工坊模型在 `shared/workshop-compute.js` 中声明一条轻量配置（数值均与真机实测对齐并留保守余量）：

- `id`：如 `'pbr:marigold'`、`'depth:da3mono-large'`、`'depth:da3-large'`、`'depth:moge2-vitl'`、`'relight:ic-light'`
- `tier`：`'edge-onnx' | 'hybrid-cuda' | 'cloud-only'`
- `minTotalVramMb` / `minFreeVramMb`：总显存与提交时所需最小空闲显存
- `minTotalRamMb` / `minFreeRamMb`：系统内存门槛
- `firstTimeDiskBytes` / `cachedDiskBytes`：未缓存模型时所需磁盘余量 vs 已缓存后最小运行余量
- `estimatedDownloadText`：供前端轻提示展示的可读体量（例如 `~1.6 GB`）

### 3.2 统一评估输出（`evaluateWorkshopCompute`）

输入：`hardware`（来自 `hardwareProbe`）+ `{ op, model, arch, envCached, modelCached }`

输出字段：

1. `tier`：`'edge-onnx' | 'hybrid-cuda' | 'cloud-only'`
2. `localEligible`：`boolean` — 本机硬件（OS、单卡 NVIDIA CUDA、空闲显存、内存、模型盘空间）是否全部通过保守校验
3. `recommended`：`'local' | 'cloud'` — 基于本机算力推荐的默认/最优执行位置
4. `badge`：`'edge-fast' | 'local-ready' | 'cloud-recommended' | 'cloud-only'`
5. `reasonCode` & `reason`：可读中文原因（如 `'insufficient-vram-free'` → `当前空闲显存 3.8 GiB，低于 MoGe-2 所需的 6 GiB，建议上云`；`'local-ample'` → `检测到本机 RTX 4070（空闲显存 9.4 GiB），可免排队本机运行`）
6. `needsDownload`：`boolean` — 是否尚未在本地完成 `uv` 环境或目标权重缓存

### 3.3 提交前二次复核与自动排队路由

- 在 `server/jobs/queue.js` 真正执行 `compute: 'local'` 的工坊任务前，再次执行一次只读 `hardwareProbe`（耗时毫秒级）：
  - 若当时因用户另开了游戏/渲染器导致 `vramFreeMb` 跌破阈值，立即中止本地拉起，返回结构化可恢复提示（`推荐切换云端重试`），绝不硬着头皮 OOM 崩溃；
  - 若选择或判定走 `'cloud'`，沿用既有 `workshopCloudProvider(provider)` 逻辑把任务稳妥排入云端 GPU 队列，商业生图 API / Vulkan 模式下默认借道既有云卡配置（不修改用户主生图设置）。

---

## 4. 通用工坊 `local-cuda` Runner 架构

目前 `server/local-pbr.js` + `worker/local_pbr.py` 已经跑通了「应用数据目录隔离 Python 3.11 + PyTorch 2.6 + CUDA + `uv` 缓存校验 + JSON stdout 进度协议 + `JobQueue` 取消信号清理」。后续拓展遵循最小改动原则：

1. **运行时共享复用**：
   - 将 `runtime/local-pbr/` 保留为共享虚拟环境路径（或新增版本号标记向后兼容检测），在同一环境按需补齐轻量依赖（避免与已有 PBR 安装冲突），所有本地 CUDA 工坊算子共用一套 PyTorch CUDA。
   - 若未来拆分更重依赖，严格在 `UV_ASSETS` 白名单内做版本锁定与校验。
2. **Runner 与推理源码去重**：
   - 将 `server/local-pbr.js` 中的 `uv` 安装、`runProcess` 进程看门狗、stdout JSON 行事件解析抽为通用 `server/local-cuda-runner.js`，PBR / 深度 / 重打光统一调用该执行器，并在 `server/local-pbr.js` 保留薄兼容层。
   - Python 侧 `worker/local_workshop.py` 直接按子任务分发并复用 `worker/inference/game_ops.py` 经过云端实测验证的函数（`_depth_estimate_via_da3`、`_depth_estimate_via_moge`、`run_ic_light`、`depth_to_normal`），**保证本机与云端输出的深度范围、法线坐标系（OpenGL `+X/+Y/+Z`）及量化行为 100% 一致**。
3. **取消与驻留清理防呆（避免“幽灵中断/一直运行”）**：
   - 绑定 `AbortSignal` 与进程组/子进程树强制终止（Windows `taskkill /T /F` 或等价信号处理），确保用户点击取消或关闭客户端时本地 Python/CUDA 进程秒级释放显存。
   - 所有工坊本地推理均采用「任务完成或闲置后可控释放进程」策略，不在后台偷偷挂常驻守护进程阻塞退出或占用空闲显存。

---

## 5. 前端 UI 状态标识与双向智能提示策略

### 5.1 模型 / 挡位状态徽章

在工坊各玩法的模型选择控件及「本地 / 云端」执行胶囊旁，统一显示简洁徽章：

- `端侧秒算`（绿/中性标签）：`DA3-Small` / `RMBG-1.4` 等，立即可用。
- `本机 GPU 可跑`（蓝色/强调标签）：当前机器满足 Tier 2 条件；若权重未缓存，附小字提示 `首次需约 X GB`。
- `建议上云`（琥珀色温和标签）：本机不具备足额 N 卡 / 显存 / 磁盘条件，自动默认选中「云端」并把任务提交给云端 GPU 队列；附 `hover`/副文案说明具体瓶颈（如 `本机无 NVIDIA CUDA` 或 `空闲显存不足`）。
- `仅云端`（灰色锁定标签）：Tier 3 重模型，禁止切本地。

### 5.2 双向智能轻提示（核心交互约束）

1. **规则一：用户主来源为云 GPU，且本机算力充裕时 → 非阻塞顶部轻提示条**
   - 触发条件（全部满足才显示）：
     - 用户当前激活的全局 GPU Provider 为云端源（`kaggle` / `colab` / `salad` / `private-worker`）；
     - 当前工坊面板所选工具/高质量模型经 `evaluateWorkshopCompute` 判定为 `localEligible === true` 且 `recommended === 'local'`；
     - 当前执行位置仍停留在 `'cloud'`，且用户未在偏好中关闭该算子的本机建议。
   - UI 呈现：在工坊工作区顶部提示条或参数卡执行区上方展示一条轻提示（**严禁用 modal 弹窗阻塞操作**）：
     > 检测到本机 **<GPU 名称>**（空闲显存 **<X> GiB**）算力充裕，当前工具可免排队本机运行。  
     > *（若未缓存则补充：首次启用预计下载运行环境/模型约 X GB）*  
     > **`[切换为本机运行]`** **`[继续用云端]`**
   - 状态记忆原则：
     - 用户点击 `[切换为本机运行]`：仅切换工坊对应工具的执行偏好为 `local`（**绝不篡改用户全局生图 Provider 设置**）。
     - 用户点击 `[继续用云端]` 或手动把胶囊拨回 `云端`：记录用户偏好（本机 localStorage 按工具/会话记住「用户显式偏好云端」），`hardwareProbe` 异步晚到时只补充默认空值，**绝不强行覆盖或反复弹窗**。
2. **规则二：本地算力不足却选中 Tier 2 高精度模型 → 自动默认云端**
   - 当 `localEligible === false` 时，默认位置自动切为 `cloud` 并将该模型挡位标记为 `建议上云`，提交时直接走云端任务队列；
   - 若设备具备 N 卡但仅是临时空闲显存/磁盘略低于保守线（非硬性无卡），保留用户确认后强行试跑本机的开关（旁注保守原因），无 N 卡则直接禁用本地开关避免无效报错。

---

## 6. 分阶段落地计划与验收标准

### Phase A：能力矩阵统一与 UI 徽章 / 双向轻提示（零大体积模型下载即可全测）

- [ ] 扩展 `shared/workshop-compute.js`：抽离 `WORKSHOP_COMPUTE_PROFILES` 与 `evaluateWorkshopCompute(hardware, options)`，覆盖 `marigold`、`da3mono-large`、`da3-large`、`moge2-vitl`、`ic-light`；保持 `evaluateLocalPbr` 兼容。
- [ ] 扩展 `/api/local-models/hardware`（或新增工坊就绪状态字段）：向前端返回 `runtime/local-pbr` 环境与各 Tier 2 模型目录缓存状态（`envCached`、`cachedModels`）。
- [ ] 升级 `WorkshopParams.jsx` / `Workshop.jsx`：
  - 将当前仅限 `pbr` 的「本地 / 云端」切换组件泛化为支持 `depth-fx`（高质量深度档）与 `relight`（AI 轨道）；
  - 为各模型/挡位渲染四态徽章（`端侧秒算` / `本机 GPU 可跑` / `建议上云` / `仅云端`）及首次下载体积提示；
  - 实现云端主 Provider + 本机充裕场景的非阻塞内联轻提示条与「继续用云端」防打扰记忆逻辑。
- [ ] 离线单测：扩展 `test/host-workshop-gpu.mjs` 与 `test/check-client-workshop.mjs`，覆盖无卡/8GB/12GB/空闲显存不足/缓存已存在/用户手选不覆盖等全部边界。

### Phase B：通用 `local-cuda` Runner 与工坊重模型本地执行

- [ ] 抽取 `server/local-cuda-runner.js`，统一管理 `uv` 环境检查、下载取消与 Windows/Linux 子进程树清理（重构 `server/local-pbr.js` 复用）。
- [ ] 新增 `worker/local_workshop.py`，直接复用 `worker/inference/game_ops.py` 中的 `DA3Mono-Large` / `DA3-Large` / `MoGe-2 ViT-L` / `IC-Light` 推理函数并保持同一通道格式与 OpenGL 法线约定。
- [ ] 在 `server/jobs/queue.js` 接入工坊本地 Depth / IC-Light 队列分发与执行前二次硬件复核；保证取消按钮可立即终止本地 Python 推理子进程与下载流。

### Phase C：真机 CUDA 验证与端到端回归

- [ ] 在真实 NVIDIA GPU 环境验证至少一套 8 GB 级与 12 GB+ 级设备上的 `DA3Mono-Large` / `MoGe-2 ViT-L` / `IC-Light` 实测耗时与峰值显存，反哺校准 `WORKSHOP_COMPUTE_PROFILES` 保守门槛。
- [ ] 在无 NVIDIA 显卡环境完成降级回归：所有 Tier 2 高质量模型准确显示 `建议上云`，任务稳妥排入云端 GPU 队列，全程无异常报错与残留后台任务。
