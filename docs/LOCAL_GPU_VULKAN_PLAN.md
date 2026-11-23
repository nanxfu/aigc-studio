# 本机 Vulkan（`stable-diffusion.cpp`）生图部署与资源平缓优化方案

> **定位**：面向消费级非 NVIDIA 硬件（核显 / 统一内存 APU / 跨厂商显卡）的本机生图验证与工程化方案；可直接作为工程专员的真机验证 Runbook 与后续 `local-gpu` 接入蓝图。
> **上位文档**：[`M3_PRIVATE_WORKER_AND_MCP_PLAN.md`](M3_PRIVATE_WORKER_AND_MCP_PLAN.md) §8（M3.4 本机 GPU）。
> **制定日期**：2026-11-23。

---

## 0. 核心结论与第一性原理边界

1. **为什么放弃 DirectML、优先选 Vulkan**：
   - 全局 Python 环境下的 `torch-directml`（依赖旧版 PyTorch，在 `torch 2.8.0+cpu` 上直接 `DLL load failed`）与 `onnxruntime-directml`（易被普通 `onnxruntime` 覆盖失效）维护极其脆弱，且对现代 DiT（FLUX.2 / Z-Image / Qwen-Image）算子与 BF16 支持差。
   - `leejet/stable-diffusion.cpp` 基于纯 C/C++ 与 `ggml-vulkan`，零 Python/CUDA 依赖、原生支持 **GGUF 量化**、内置 HTTP 服务 `sd-server`，并已覆盖 `SDXL`、`FLUX.2`、`Z-Image`、`Qwen-Image`、`Anima` 等主流架构。
2. **本机物理瓶颈判断**：
   - **容量充裕**：32 GB LPDDR5X-8000 统一内存 + Vulkan `DEVICE_LOCAL` 堆高达 13.26 GiB，配合 GGUF Q4/Q5/Q8 量化可以装下少步数模型。
   - **带宽受限**：共享内存理论带宽约 128 GB/s（远低于独立显卡）且存在单次 2 GiB Buffer 分配上限。因此必须坚持：**少步数蒸馏模型（2~10 步）+ GGUF 量化 + 阶段性 CPU 卸载 + VAE 分块/卸载**，核心目标是**“稳态不爆、桌面不卡、出图可接受”**，而不是硬拼峰值并发。

---

## 1. 本机实测硬件与环境基线（2026-11-23 实测）

| 项目 | 实测值 | 对部署的影响 |
| :--- | :--- | :--- |
| **机型** | MECHREVO XINGYAO Series | 轻薄本散热与功耗墙需考虑长驻温度 |
| **CPU** | AMD Ryzen AI 9 H 365（10 核 20 线程） | CPU Offload / CLIP / VAE 卸载算力充足 |
| **GPU** | AMD Radeon(TM) 880M Graphics（RDNA 3.5，`gfx1150`） | 驱动 `32.0.31019.2002` / Adrenalin `26.6.1 (LLPC)` |
| **NPU** | AMD XDNA 2（`PCI\VEN_1022&DEV_17F0`，驱动 `32.0.20101.3760`） | 仅作备用参考，**不作为通用生图主后端** |
| **物理内存** | 32 GB LPDDR5X-8000（4 通道 8000 MT/s） | Windows 可见约 **23.8 GiB**（BIOS 静态预留约 8 GB） |
| **Vulkan 能力** | Vulkan `1.4.349`，`shaderFloat16 = true` | 原生支持 FP16 计算着色器 |
| **Vulkan 内存堆** | `memoryHeaps[1]`（`DEVICE_LOCAL`）：**13.26 GiB**（预算 12.60 GiB）<br>`memoryHeaps[0]`（Host）：**6.63 GiB** | **注意**：`DEVICE_LOCAL` 堆反而大于 Host 堆，调优时勿盲目切换 Host 优先 |
| **Vulkan 分配上限** | `maxMemoryAllocationSize = 0x80000000`（**2 GiB**）<br>`maxBufferSize = 0x80000000`（**2 GiB**）<br>`maxStorageBufferRange = 4294967295`（~4 GiB） | **关键限制**：未量化的大权重单块容易撞 2 GiB 上限报错，必须优先采用 GGUF 量化拆分 |
| **磁盘余量** | `C:` 剩余 **51.60 GB** / `D:` 剩余 **67.80 GB** | **所有二进制、模型与缓存必须落盘 D 盘**，严禁占用 C 盘 |
| **本机可用工具** | `git`、`curl.exe`、`tar.exe`、`uv`、`Python 3.12.0` | **无 `cmake` / `cl.exe` / `7z`**；优先用官方预编译包而非源码编译 |

---

## 2. 执行阶段一：D 盘零污染真机基线验收（Runbook）

> **目标**：在不改动 `aigc-studio` 业务代码、不污染全局 Python 的前提下，于 D 盘跑通 880M Vulkan 真机出图，并测出内存/耗时基线。

### 2.1 目录规划（严格隔离）

```text
D:\aigc-local\
├─ bin\          # 解压后的 sd-cli.exe / sd-server.exe 及动态库
├─ models\       # GGUF 模型权重（按子目录区分：sdxl / z-image / flux2）
├─ outputs\      # 基线验收出图产物
└─ logs\         # 每次运行的耗时、显存/内存峰值、报错日志
```

### 2.2 获取预编译 Vulkan 二进制

1. 从 `https://github.com/leejet/stable-diffusion.cpp/releases` 获取最新 tag 的 Windows Vulkan 预编译包，命名通常为：
   `sd-<TAG>-bin-win-vulkan-x64.zip`
2. 使用 PowerShell + 系统自带 `curl.exe` 与 `tar.exe` 下载并解压至 `D:\aigc-local\bin\`（若网络需代理则按本机环境配置）。
3. 校验 `D:\aigc-local\bin\sd-cli.exe --help` 与 `sd-server.exe --help` 正常输出，并确认能识别 `Vulkan0`（AMD Radeon(TM) 880M Graphics）。

### 2.3 模型与权重选择顺序（由稳到重）

> **硬性约束**：下载 GGUF 权重时，优先选择 `leejet` 官方或明确标注兼容 `stable-diffusion.cpp` 的转换版本；避免混用部分第三方 ComfyUI 专属格式的 GGUF（易触发 `new_sd_ctx_t failed`）。

| 验证顺位 | 对应仓内模型 | 推荐量化与组件组合 | 预估磁盘占用 | 预期定位 |
| :--- | :--- | :--- | :--- | :--- |
| **P0（冒烟首发）** | [`sdxl-lightning`](../models/sdxl-lightning.json) | SDXL Base/Lightning GGUF `Q4_K_M` 或 `Q5_K_M`（4 步，CFG 1.0/0） | ~2.5~4 GB | 架构最成熟，验证 Vulkan 管线、VAE 解码与基础速度基线 |
| **P1（主力验证）** | [`z-image-turbo`](../models/z-image-turbo.json) | DiT `Q4_K_M` + Text Encoder `Qwen3-4B Q4_K_M` + 配套 VAE（8~9 步） | ~6~7 GB | 本仓核心主力，验证现代 DiT + LLM Text Encoder 在 880M 上的表现 |
| **P2（多模扩展）** | [`flux2-klein-4b`](../models/flux2-klein-4b.json) | DiT `Q4_K` + 配套 Text Encoder `Q4_K` + VAE（4 步） | ~5~6 GB | 验证 4 步极少步数模型在低带宽核显上的吞吐优势 |
| **P3（高压边界）** | [`qwen-image-2.1`](../models/qwen-image-2.1.json) / [`flux2-klein-9b`](../models/flux2-klein-9b.json) | 双端严格 `Q4` 量化 + 必须配合 §3 全部 CPU 卸载策略 | ~10~14 GB | 压测 23.8 GiB OS 内存上限；未调小 BIOS UMA 前不作首发 |

*(注：[`sana-sprint-1.6b`](../models/sana-sprint-1.6b.json) 与 [`anima-turbo-v1.1`](../models/anima-turbo-v1.1.json) 在启动前需先核对当前所下载 `sd-cli` release 版本是否已完整合入对应 loader 与 Gemma-2/Qwen3-0.6B 编码器支持。)*

### 2.4 分层验收基线矩阵（专员需实测并回填）

建议对 P0 与 P1 至少跑通 `512×512` 与 `1024×1024` 两档，记录以下数据到 `D:\aigc-local\logs\benchmark.md`：

1. **冷启动耗时**（从命令启动到第 1 步开始计算）与 **稳态出图耗时**（`sd-server` 常驻后第 2 张出图时间）。
2. **资源峰值**：任务管理器 / 性能计数器中的「专用 GPU 内存」「共享 GPU 内存」「系统提交内存（Commit）」峰值。
3. **桌面流畅度**：出图过程中鼠标移动、浏览器滚动、IDE 输入是否明显卡顿或出现驱动黑屏恢复（TDR）。
4. **图像质量校验**：目视确认无全黑图、花屏、块状伪影（如有，按 §3.3 排查 `--diffusion-fa` 与精度开关）。

---

## 3. 全链路“资源占用平缓”优化手段清单

以下手段按**从底层到上层、从高收益到兜底**排列，专员测试时按需逐级叠加。

### 3.1 系统与 BIOS 层（消除隐藏内存天花板）

1. **调整 BIOS UMA 静态预留（建议：`4 GB` 或 `Auto`）**
   - **现状问题**：当前 32 GB 物理内存中约 8 GB 被静态划走，Windows 仅剩 23.8 GiB。运行带 4B~8B 文本编码器的模型并开启 CPU Offload 时，OS 侧内存更容易先吃紧。
   - **预期收益**：调小静态预留至 `4 GB` 或 `Auto` 后，Windows 可按需向核显动态共享，同时把约 4 GB 系统内存还给 Text Encoder 与桌面应用，整体内存曲线更平缓。
2. **电源模式与散热控制**
   - 插电测试时确保系统处于「平衡」或「最佳性能」（核显带宽与频率吃 TDP）；若希望静音/低温长跑，可在 Windows 电源设置中限制最高处理器状态或利用笔记本自带模式平滑功耗，避免瞬间撞温度墙降频导致步速抖动。

### 3.2 加载期削峰（防止启动瞬间内存飙升与卡死）

1. **保持 `--mmap` 内存映射加载（默认开启）**
   - 让操作系统按需从 NVMe SSD 缺页加载权重，避免启动瞬间一次性 `malloc` 完整体积导致系统假死。
   - **前提**：模型务必放在 NVMe SSD（D 盘本地磁盘），不要放在移动硬盘或高延迟网盘。
2. **切勿同时常驻多套模型**
   - 在 `sd-server` 模式下一次只加载一个活跃模型；切换模型前彻底释放旧上下文，避免 23.8 GiB 空间内出现双模型叠加。

### 3.3 推理期削峰填谷（核心参数组合）

核显推理最易崩溃的两个时刻是：**① 文本编码器与 DiT 抢显存池；② 最后一步高分辨率 VAE 解码触发瞬时峰值导致 `VK_ERROR_DEVICE_LOST`。**

| 参数 / 策略 | 作用机制 | 平缓收益 | 建议启用策略 |
| :--- | :--- | :--- | :--- |
| **`--offload-to-cpu`** | 按计算阶段动态将暂不使用的权重保留在 CPU/RAM，仅将当前活跃块放入 Vulkan 设备缓冲 | **大幅降低 GPU 内存峰值**，防止驱动内存碎片化崩溃 | **默认开启**（P1/P2/P3 必开） |
| **`--clip-on-cpu`** | 强制 Text Encoder（CLIP / T5 / Qwen）在 CPU 执行 | 文本编码每张图只跑 1 次（数秒），不与 DiT 争抢 12.6 GiB Vulkan 预算 | **建议开启**（尤其是 4B+ 文本编码器模型） |
| **`--vae-tiling`** | 将潜空间分块送入 VAE 解码 | **削平出图最后一步的内存尖峰**，防 1024²/1152² 爆显存 | **默认开启** |
| **`--vae-on-cpu`** | 将 VAE 编解码完全移回 CPU | **几乎 100% 消除解码阶段 Vulkan 驱动崩溃**；代价是多花数秒 | 若开了 `--vae-tiling` 仍闪退，立即切换此项 |
| **`--diffusion-fa`** | 为扩散模型启用 Flash Attention | 降低高分辨率长序列注意力矩阵的中间显存峰值并提速 | **试开**；若 AMD Vulkan 下出现花屏/报错，立刻改为关闭 |
| **进程优先级 & 线程限流** | PowerShell 启动时设 `BelowNormal` 优先级，并限制线程数（如 `-t 8`，本机共 20 逻辑线程） | 防止 CPU/GPU 调度占满导致 Windows DWM 桌面掉帧、鼠标卡顿 | **长期运行必配** |

**推荐起步参数基线（以 `z-image-turbo` / `flux2` 等大模型 1024×1024 为例）：**

```powershell
# 示例骨架（具体模型文件名以实际下载的 GGUF 为准）
sd-cli.exe `
  --diffusion-model D:\aigc-local\models\z-image\z-image-turbo-Q4_K_M.gguf `
  --llm D:\aigc-local\models\z-image\qwen3-4b-Q4_K_M.gguf `
  --vae D:\aigc-local\models\z-image\ae.safetensors `
  -p "your prompt here" `
  -W 1024 -H 1024 --steps 8 --cfg-scale 1.0 `
  -t 8 --offload-to-cpu --clip-on-cpu --vae-tiling `
  -o D:\aigc-local\outputs\test.png
```

*(注：具体 LLM/Text Encoder 参数名如 `--llm` / `--qwen2vl` / `--t5xxl` 请以所下载版本 `sd-cli.exe --help` 实际输出为准。)*

### 3.4 AMD Windows Vulkan 专属兜底环境变量

**不要默认全开，仅在命中对应报错时按表启用：**

| 环境变量 | 触发症状 | 机制与本机注意事项 |
| :--- | :--- | :--- |
| `GGML_VK_FORCE_MAX_ALLOCATION_SIZE=4294967295` | 加载时报单缓冲区超限 / `ErrorOutOfDeviceMemory`（总预算够但单块被卡） | 覆盖驱动上报的 `2 GiB`（`0x80000000`）单块分配限制；若仍受驱动 `maxBufferSize` 硬限制，应优先改用更高压缩比 GGUF（如 `Q4_K_S`） |
| `GGML_VK_PREFER_HOST_MEMORY=1` | 报 `DEVICE_LOCAL` 耗尽或 `VK_ERROR_DEVICE_LOST` | 反转分配优先级为先用 Host 堆。**注意**：本机当前 `DEVICE_LOCAL`（13.26 GiB）大于 Host（6.63 GiB），默认勿开；仅在调小 BIOS UMA 或验证溢出时使用 |
| `GGML_VK_DISABLE_F16=1` | 出图全黑、严重噪点或数值 NaN 异常 | 禁用 Vulkan FP16 计算回退到 FP32，以牺牲速度换取数值正确性 |

### 3.5 服务化平缓（`sd-server` 空闲自动回收）

* 启动 `sd-server.exe` 作为本机常驻 HTTP 服务时，首张图冷启动加载完毕后，后续连续出图可省去模型重复加载开销，避免磁盘与内存反复剧烈波动。
* **空闲回收策略**：核显笔记本需兼顾 IDE / 浏览器多任务，建议在封装启动脚本或未来的 Host 托管逻辑中加入 **Idle Timeout（如 5 分钟无任务自动 `SIGTERM` / `/shutdown`）**，把占用的 6~12 GB 内存完整归还 Windows，下次生图时借助 `--mmap` 快速冷拉起。

---

## 4. 执行阶段二：后续接入 `aigc-studio` `local-gpu` 的演进建议

> **约束**：仅在阶段一（§2）真机基准验收通过、确认速度与稳定性符合预期后，再启动对仓库代码的改造。

### 4.1 仓库现况核对

* [`server/providers/local-gpu.js`](../server/providers/local-gpu.js) 目前仍为占位模块。
* [`server/providers/index.js`](../server/providers/index.js) 已将 `local-gpu` 路由至 `createPrivateWorkerProvider({ ..., id: 'local-gpu' })`（`owned = true`）。
* [`docs/M3_PRIVATE_WORKER_AND_MCP_PLAN.md`](M3_PRIVATE_WORKER_AND_MCP_PLAN.md) §8 原规划只涵盖 `nvidia-smi` + `uv` Python CUDA 环境。

### 4.2 双后端扩展设计（兼容 NVIDIA CUDA 与 AMD/Intel Vulkan）

1. **硬件探测层扩展（`server/local-gpu/probe.js`）**：
   - 第一优先：探测 `nvidia-smi`（存在独显 N 卡则走原规划的 `uv` + PyTorch CUDA Worker）。
   - 第二优先（本机命中路径）：探测 `vulkaninfo --summary`（解析 `deviceName`、`deviceType`、`apiVersion` 与 `memoryHeaps` 预算）及 `os.totalmem()` / 空闲内存，识别出 `Radeon 880M` 等可用 Vulkan GPU，不再直接返回 `gpu_unavailable`。
2. **Vulkan 运行时与进程托管（`server/local-gpu/vulkan-runtime.js`）**：
   - 管理 `sd-server.exe` 的受控路径（默认指向用户配置目录或 D 盘目录）、只绑定 `127.0.0.1` 随机端口、注入进程优先级 `BelowNormal` 与 `Below` 空闲自动释放定时器。
   - 默认为核显机型注入平缓策略参数（`--offload-to-cpu`、`--clip-on-cpu`、`--vae-tiling`、`-t` 限流）。
3. **协议桥接（对齐 Worker v2 契约）**：
   - `sd-server.exe` 原生提供 `POST /v1/images/generations` 与 `/sdcpp/v1/...`，不直接具备 `aigc-studio` 的 `/health`、`protocolVersion`、任务状态轮询与产物端点。
   - **最小改动接法**：在 Node 侧（`local-gpu` Provider 或轻量本地桥接器）把 `sd-server` 的生成请求、异步状态与本地落盘图片直接映射为 `aigc-studio` 的 Provider 响应；模型资产目录上，通过 `models/*.json` 新增可选 `localVulkan` / `gguf` 映射档案，与现有 `colab` / `private-worker` 互不干扰。

---

## 5. 专员执行检查单（Checklist）

- [ ] **环境准备**：确认操作全部在 `D:\aigc-local\` 下进行，不修改全局 Python，不向 C 盘写入大模型。
- [ ] **获取二进制**：下载最新 `sd-*-bin-win-vulkan-x64.zip` 并解压至 `D:\aigc-local\bin\`，确认 `sd-cli.exe` 识别到 `AMD Radeon(TM) 880M Graphics`。
- [ ] **P0 冒烟验证**：拉取 `sdxl-lightning` 兼容 GGUF（Q4_K_M / Q5_K_M），完成 512² 与 1024² 出图，记录耗时与内存峰值。
- [ ] **P1 主力验证**：拉取 `z-image-turbo` 兼容 GGUF（DiT Q4_K_M + Qwen3-4B Q4_K_M + VAE），开启 `--offload-to-cpu --clip-on-cpu --vae-tiling -t 8`，验证 1024² 出图耗时、画质及桌面流畅度。
- [ ] **参数对照消融**：对比关闭/开启 `--diffusion-fa`、`--vae-tiling` vs `--vae-on-cpu`、`BelowNormal` 进程优先级对速度与稳定性的影响，回填基线报告。
- [ ] **BIOS 可选验证（如 23.8 GiB 吃紧）**：若后续测试 `flux2` / `qwen-image` 时出现 OS 内存不足，评估将 BIOS UMA 调为 `4 GB` / `Auto` 后重测内存余量。
- [ ] **服务化验收**：用 `sd-server.exe` 跑通连续 3 次生图（验证热复用加速）以及退出进程后的内存完全回收。
