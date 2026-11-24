<div align="center">

# AIGC Studio

<img src="docs/assets/banner.png" alt="banner" width="100%">

**界面留在本地，算力交给云端。**<br/>
独立的开源桌面端 AIGC 创作工作台（Electron + React + 本地 Node.js 控制面）。<br/>
免买大显存独显、免配 Python / ComfyUI，支持免费云端双卡 GPU、商业生图/视频 API、私有 Worker 与 6 项本地资产工坊。

[![Version](https://img.shields.io/badge/Version-0.16.0-blue?style=flat-square)](https://github.com/nanxfu/aigc-studio/releases)
[![Website](https://img.shields.io/badge/Website-aigc--studio--8rj.pages.dev-e6613e?style=flat-square)](https://aigc-studio-8rj.pages.dev)
[![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?style=flat-square)](https://www.electronjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-black?style=flat-square)](package.json)
[![GitHub Stars](https://img.shields.io/github/stars/nanxfu/aigc-studio?style=flat-square)](https://github.com/nanxfu/aigc-studio)
<a href="https://linux.do/"><img src="https://img.shields.io/badge/LINUX%20DO-社区友链-555?style=flat-square" alt="LINUX DO" /></a>

[官网与指南](#官网与使用指南) · [算力后端](#算力后端支持) · [核心功能](#核心功能) · [快速开始](#快速开始) · [常见问答](#常见问答) · [开发与测试](#开发与测试)

</div>

---

## 简介

**AIGC Studio** 是一个开箱即用的独立桌面创作工作台，把**本地交互界面与资产管理**和**云端推理算力**彻底解耦：

- **零本地硬件门槛**：无需购买 16GB/24GB 独显，也不用折腾 PyTorch、CUDA 和 ComfyUI 节点连线；
- **多轨算力自由切换**：日常可用**商业 API**（0 秒就绪、按张/按条计费，支持文生图与文生/图生视频），批量抽卡或局部重绘可接 **Kaggle 免费双卡（每周 30 小时）**、**Google Colab** 或 **私有远端 GPU Worker**；
- **作品 100% 留在本地硬盘**：本地运行轻量 Electron 客户端与 `127.0.0.1` Node.js 控制面，原图、视频、`meta.json` 参数元数据、版本树与工坊衍生通道全部保存在你指定的本地工作区 `outputs/` 目录。

<div align="center">
  <img src="docs/assets/workbench.png" alt="AIGC Studio 桌面工作台" width="92%" />
  <p><sub>独立桌面工作台：无边框自绘标题栏 + 左侧参数面板 + 舞台预览 + 底部作品条</sub></p>
</div>

---

## 官网与使用指南

在线查看 7 款开源模型同题 A/B 放大镜实测、6 项工坊交互演示与场景指南：

- **项目官网**：[aigc-studio-8rj.pages.dev](https://aigc-studio-8rj.pages.dev)（[模型实测](https://aigc-studio-8rj.pages.dev/models) · [资产工坊](https://aigc-studio-8rj.pages.dev/workshop) · [全部指南](https://aigc-studio-8rj.pages.dev/guides)）
- **场景指南**：
  - [无独立显卡运行开源生图模型指南](https://aigc-studio-8rj.pages.dev/guides/free-gpu-no-comfyui)
  - [AIGC Studio 与 ComfyUI 选型对照](https://aigc-studio-8rj.pages.dev/guides/aigc-studio-vs-comfyui)
  - [游戏像素画网格对齐与序列帧 Atlas 导出](https://aigc-studio-8rj.pages.dev/guides/ai-pixel-art-sprite)
  - [本机零显存将 AI 插画转换为可编辑 SVG](https://aigc-studio-8rj.pages.dev/guides/ai-image-to-svg)
  - [通过 MCP 让 Claude Desktop / Cursor 调用本地生图](https://aigc-studio-8rj.pages.dev/guides/mcp-claude-cursor-image)

---

## 算力后端支持

| 后端驱动 | 状态 | 算力规格 | 成本 / 门槛 | 说明 |
| :--- | :---: | :--- | :--- | :--- |
| **Kaggle GPU Driver** | **已内置（默认）** | 2×Nvidia Tesla T4（30G 显存） | **免费**（每周 30 小时额度） | 自动会话管理、隧道会合、协议 v2 步数回传与空闲关机 |
| **Google Colab Driver** | **已接入** | Nvidia T4（免费）/ L4、A100（Pro） | 免费 / 订阅 | 内置 OAuth 授权；支持 `Z-Image Turbo`、`Qwen-Image 2.1`、`FLUX.2 Klein 9B` |
| **商业 API（`cloud-api`）** | **已内置（M3.5 / M4.1）** | 硅基流动 / fal.ai / OpenAI / 自定义端点 | 按张 / 按条计费 | **0 秒就绪**、无冷启动；支持文生图与硅基流动视频（MiniMax H3 文生/首尾帧视频） |
| **私有远端 Worker** | **已内置（M3.1）** | 自建 Linux GPU / RunPod / Vast.ai | 按需计费 / 私有部署 | 长驻 HTTP 服务 + Bearer 鉴权；Docker 镜像 + binary 产物与 SSE 步数进度 |
| **本机直连 GPU** | **规划中（M3.4，可选）** | 本机独显 / Vulkan 核显 | 本地硬件 | 适合离线低延迟出图，不阻塞云端主流程 |

> **防误关保护**：当 Kaggle / Colab 云端 GPU 会话处于活跃状态时，关闭窗口默认**最小化到系统托盘**，避免误关窗口导致算力额度空烧；通过托盘「彻底退出」会安全完成远端关机与会话清理。

---

## 核心功能

### 1. 独立创作工作台（生图 / 视频双模式）

* **7 款内置开源生图模型 + 商业云端目录**：内置 7 款主流开源生图模型（详见[常见问答 · 模型列表](#常见问答)与 [`models/*.json`](models/)），切换至商业 API 时自动下发对应服务商的生图与视频预设。
* **自适应参数面板与参考图**：提示词、画幅、步数、引导强度与参考图入口随当前模型能力动态展示；支持中译英及光影、材质、构图、氛围快捷词缀，修改参数未提交时舞台同步显示取景分叉预览。
* **舞台就地二创与视频抽帧接力**：图片支持局部涂抹重绘（Inpaint）、整图重绘、高清放大（×2）与扩图（Outpaint LoRA）；视频支持原生播放与「取首帧 / 取尾帧」一键抽帧落盘为普通作品继续二次创作。
* **版本树与多工作区**：底部作品条按来源血缘折叠版本树并保留草稿；顶栏支持随时切换本地工作区。

<div align="center">
  <img src="docs/assets/studio-light.png" alt="浅色工作台界面" width="92%" />
  <p><sub>支持深色 / 浅色主题切换：参数面板 + 实时画布 + 版本胶卷</sub></p>
</div>

### 2. AI 创作助手、视觉回看与探索抽卡

* **单轨对话与结构化提案卡（AG-UI）**：根据自然语言自动润色英文提示词、匹配模型与算力来源；先输出可编辑提案卡（`ui_propose_generation`）或澄清卡（`ui_ask_clarify`），确认后支持一键跨模型、跨后端「切换并生成」；未配置 LLM Key 时自动回落本地规则引擎。
* **多模态视觉回看与预算探索（M3.5）**：支持 `imagen_inspect` 查看已生成成图并按四维规范针对性改词；提出探索方案卡（`ui_propose_explore`）并授权后，在**轮数与总张数硬预算**内自动多轮抽卡、实时展示进度并支持并排对比与选图变体回流。
* **11 家 LLM 服务商接入**：内置 DeepSeek、Kimi、通义千问、硅基流动、OpenCode Zen、OpenRouter、Google Gemini、OpenAI、Anthropic、Ollama 及自定义 OpenAI 兼容端点，支持一键拉取模型列表。

<div align="center">
  <img src="docs/assets/chat-tool.png" alt="创作助手与提案卡" width="92%" />
  <p><sub>创作助手单轨对话与可编辑提案卡</sub></p>
</div>

### 3. 内置资产工坊（6 项后处理 · 复合资产包）

出图后无需导出到外部软件折腾，顶栏直接切入「工坊」，本地静默识别作品类型并高亮推荐工具，结果以**复合资产包（主图 + 附属通道 + 版本树继承）**直接落盘，支持一键导出整包 ZIP：

| 工具 | 执行位置 | 核心能力与产出 |
| :--- | :---: | :--- |
| **SVG 矢量转换** | 本机直算（0 GPU） | 基于 `@visioncortex/vtracer`（Node WASM）离线将扁平插画 / Logo 转为可编辑 `.svg` 路径 |
| **像素对齐** | 本机直算（0 GPU） | 边缘周期网格自动探测 + **Oklab** 调色盘量化 + Alpha 硬边清理，修复 AI 像素画虚边与混色 |
| **序列帧切片** | 本机直算（0 GPU） | 自定义行列网格切片 + 逐帧动画实时预览 + 导出 `spritesheet` 与 `atlas.json` |
| **无缝平铺** | 本机直算（0 GPU） | 左右/上下边缘 MAE 接缝检测 + 余弦混边 + 2×2 实时贴图校验 |
| **抹除背景** | 云端 GPU | 默认 `BiRefNet`（MIT 免登录开箱即用），可选 `RMBG-2.0`（非商用，需 HF 授权），输出 RGBA 透明底 PNG |
| **PBR 材质拆解** | 云端 GPU | 基于 `Marigold`（Apache-2.0），一次性拆出 `albedo / normal / roughness / metallic` 四通道贴图 |

### 4. MCP 外部 Agent 接入

* **标准 MCP Server**：`mcp/server.mjs` 通过 stdio 暴露 7 个 `imagen_*` 工具（`imagen_generate` / `batch` / `upscale` / `history` / `cancel` / `session` / `recipes`），可接入 Claude Desktop、Cursor 等外部 Agent。
* **共享同一份本地状态**：通过 `runtime.json` 自动发现本机回环端口与 Token，与桌面端共享队列、算力会话和 `outputs/` 目录；运行 `npm run mcp:config` 可打印现成配置（详见 [`mcp/README.md`](mcp/README.md)）。

### 5. 作品画廊与本地安全模型

* **本地归档与画廊**：所有产物与参数 `meta.json` 按 `outputs/<YYYYMMDD-HHmmss>-<jobId>/` 落盘，支持按日期浏览、搜索、收藏与批量管理。
* **本地隔离与密钥安全**：控制面仅监听 `127.0.0.1`，每次启动生成 256-bit 随机 Bearer Token；LLM Key、商业 API Key 与 Worker Token 均通过 Electron `safeStorage` + AES-256-GCM 加密保存；`/api/file` 采用同源 `HttpOnly; SameSite=Strict` 会话 Cookie 与 HTTP Range 流式传输（支持视频拖动）；Electron 渲染进程开启 `contextIsolation` 与 `sandbox`。

<div align="center">
  <img src="docs/assets/gallery.png" alt="作品画廊" width="92%" />
  <p><sub>作品画廊：本地归档、收藏筛选与参数回溯</sub></p>
</div>

---

## 快速开始

### 方式 A：直接下载桌面安装包（Windows x64）

前往 [GitHub Releases](https://github.com/nanxfu/aigc-studio/releases/latest) 下载最新版本（macOS / Linux 当前请使用下方「方式 B」源码运行）：

* `aigc-studio-<version>-x64.exe`：**Windows 安装版**（支持创建桌面快捷方式与应用程序内差分更新检查）
* `aigc-studio-<version>-portable.exe`：**免安装便携版**（单文件即开即用，不写注册表，需手动下载新版替换）

### 方式 B：从源码运行（Windows / macOS / Linux）

**环境要求**：
* **Node.js ≥ 20**（推荐 22+）
* **Python 3.10+**（仅运行 GPU Worker 端或 Python 单测时需要）
* **算力凭据**（按需）：Kaggle 账号凭据（客户端支持内置 OAuth 登录或 `~/.kaggle/kaggle.json`）、Google Colab 授权，或硅基流动 / fal / OpenAI 的 API Key

```powershell
git clone https://github.com/nanxfu/aigc-studio.git
cd aigc-studio

npm install
Copy-Item .env.example .env
```

选择以下任一方式启动：

```powershell
# 方式一：完整桌面客户端（Electron 窗口 + 本地 Node 服务）
npm run dev

# 方式二：浏览器开发模式（适合前端热更新调试）
npm run dev:server          # 终端 1：启动本地服务（默认 127.0.0.1:5130）
npm run dev:web             # 终端 2：启动 Vite 前端（默认 http://127.0.0.1:5173）
```

### 首次配置与出图

1. 启动后点击右上角 **「设置」**：
   - 选择或新建本地 **工作区目录**；
   - （可选）配置 **创作助手模型**（11 家服务商选其一并填入 API Key，点击「获取模型」）；
   - 选择 **算力来源**：
     - **Kaggle / Colab**：完成授权后点击顶部 **开机 / 唤醒云端**（首次冷启动约 3~10 分钟分配 GPU 与加载权重）；
     - **商业 API**：选择硅基流动 / fal.ai / OpenAI / 自定义端点并填 Key，**0 秒就绪**直接生图或生成视频；
     - **私有 Worker**：填写 Worker 地址与 Bearer Token，测试连接即可使用。
2. 状态就绪后即可在左侧输入提示词或通过右侧创作助手生成图像/视频，生成后可在顶栏切换至 **「工坊」** 完成抠图、转 SVG、像素对齐或 PBR 拆解。

### 自行打包桌面安装包

```powershell
# 构建免安装目录（输出至 release/win-unpacked/）
npm run pack

# 构建 Windows 安装包与单文件便携版（输出至 release/）
npm run dist
```

### 应用内更新与手动校验

安装版（NSIS）开启「自动检查」后，会在启动 10 秒后检查一次新版本，之后每 6 小时复查；**只检查，不自动下载**，下载与安装都需要你确认。便携版、解压版与开发态只提示新版本并打开发布页。设置抽屉 →「版本与更新」可关闭自动检查或切换为自建 `https://` 更新镜像源。

| 情况 | 说明 |
| :--- | :--- |
| **SmartScreen 提示「未知发布者」** | 开源版本暂未购买商业代码签名证书，属预期行为；确认从本仓库 Releases 下载后点击「更多信息 → 仍要运行」。 |
| **手动校验安装包完整性** | Releases 随附 `SHA256SUMS.txt`：Windows 运行 `certutil -hashfile <exe> SHA256`，macOS/Linux 运行 `shasum -a 256 <exe>` 比对摘要。 |
| **有云端任务时能否安装更新** | 若存在活跃云端会话或排队任务，「立即重启安装」会被安全拦截以防 Kaggle/Colab 继续烧额度；可等待任务结束或选择「退出时安装」。 |
| **GitHub 直连较慢或失败** | 可在「版本与更新」填写自定义 `https://` 镜像地址，或先开启系统代理。 |

---

## 常见问答

<details>
<summary><b>Q1: 使用 AIGC Studio 要花钱吗？每周 30 小时免费 GPU 够用吗？</b></summary>

软件本身以 MIT 协议开源免费。默认算力接入 Kaggle 向已验证手机号用户每周免费提供的 **30 小时 GPU（2×Nvidia T4，30GB 显存）**，个人日常探索与创作完全够用。如希望 0 等待随时出图或生成视频，也可以按需切换为硅基流动等商业 API（按次计费）。
</details>

<details>
<summary><b>Q2: 我的电脑需要独立显卡吗？</b></summary>

不需要。模型加载和推理都在云端（Kaggle / Colab / 私有 Worker / 商业 API）执行，本地只负责桌面界面展示、LLM 路由、文件归档以及零显存的本机工坊后处理（SVG / 像素对齐 / 序列帧 / 平铺）。
</details>

<details>
<summary><b>Q3: 首次开机为什么需要等几分钟？</b></summary>

Kaggle / Colab 云端冷启动包含分配云端实例、检查运行环境与拉取模型权重三个步骤，通常需要 3~10 分钟。就绪后连续出图只需数秒；默认空闲 30 分钟自动关机，也可随时手动关机。若希望免去冷启动等待，可将算力来源切换为「商业 API」。
</details>

<details>
<summary><b>Q4: 图片和密钥会传到第三方图床吗？</b></summary>

不会。远端生成的图片仅通过当次会话的临时 Bearer Token 隧道加密传回本地服务（或由商业 API 直接下载回本机），立即保存到你指定的本地工作区 `outputs/` 目录；API Key 与 Worker Token 均加密存储在本地系统密钥库。
</details>

<details>
<summary><b>Q5: 目前内置了哪些开源生图模型？有统一评测参考吗？</b></summary>

模型配置声明在 [`models/*.json`](models/)，当前内置 7 款开源模型（[查看 9 维统一盲测提示词](docs/MODEL_BENCHMARK_PROMPTS.md) · [在线同题 A/B 实测对比](https://aigc-studio-8rj.pages.dev/models)）：

| 模型 | 定位 | 算力来源 | 许可 |
| :--- | :--- | :--- | :--- |
| `SDXL Lightning` | 默认主力；4 步极速出图，支持图生图 / 局部涂抹重绘 | Kaggle / Colab / 私有 Worker | OpenRAIL++ |
| `SANA-Sprint 1.6B` | 1.6B 线性 DiT，2 步约 4 秒出 1024px，适合快速构思 | Kaggle / Colab / 私有 Worker | Apache-2.0 |
| `FLUX.2 Klein 4B` | 4 步出图，原生中英双语 + 多图参考 + 扩图 LoRA | Kaggle / Colab / 私有 Worker | Apache-2.0 |
| `Anima Turbo v1.1` | 2B 二次元 DiT，支持自然语言与 Danbooru 标签 | Kaggle / Colab / 私有 Worker | CircleStone Labs 非商用 |
| `Z-Image Turbo` | 6B S3-DiT，写实摄影、中英双语招牌与局部重绘 | Colab / 私有 Worker | Apache-2.0 |
| `Qwen-Image 2.1` | 7B DiT + Qwen3-VL，强中文排版、多图参考（支持 RGBA） | Colab / 私有 Worker | Qwen Research License（非商用） |
| `FLUX.2 Klein 9B` | 9B 蒸馏模型，高精度静物材质与参考图编辑 | Colab / 私有 Worker（HF gated） | FLUX Non-Commercial |

切换至 **商业 API（`cloud-api`）** 时，还可使用硅基流动（`Qwen-Image` / `Kolors` / `FLUX.1 schnell & dev` / `MiniMax H3` 视频）、`fal.ai`（`FLUX.1` / `FLUX 1.1 Pro`）与 `OpenAI Images`（`GPT Image 1` / `DALL·E 3`）。
</details>

---

## 开发与测试

| 操作 | 命令 | 说明 |
| :--- | :--- | :--- |
| **运行全部离线测试** | `npm test` | 含 `contract` / `client` / `host` 与 Electron 有图冒烟 |
| **Worker 离线单测** | `python test/worker/run.py` | Python GPU 执行端离线测试 |
| **契约 / 模型 / 图标校验** | `npm run contract:check` / `models:check` / `icons:check` | 校验前后端契约、模型资产与图标完整度 |
| **打包产物冒烟测试** | `npm run test:packaged` / `test:installer` | 校验 `win-unpacked` 目录与 NSIS 静默安装/卸载（需先 `npm run dist`） |
| **Release 版本与产物校验** | `node tools/check-release-version.mjs` / `npm run release:verify` | 校验 Tag / `package.json` / 契约版本一致性与 `latest.yml` 摘要 |
| **Kaggle 环境只读探测** | `npm run kaggle:probe` | 检查本地 Kaggle 凭据与剩余 GPU 配额（不消耗配额） |
| **真机 GPU 验收** | `node test/gpu-live.mjs` | 真实云端 GPU 全链路验收（消耗配额） |

---

## 关注作者

作者抖音账号：**Lumen流明**（抖音号 `42906749348`）。打开抖音「扫一扫」关注：

<div align="center">
  <img src="docs/assets/social/douyin-lumen.webp" alt="抖音 Lumen流明 账号二维码" width="320" />
</div>

---

## 开源许可与致谢

- 本项目基于 **MIT License** 开源（见 [`package.json`](package.json)）。
- 感谢 Kaggle 与 Google Colab 为开发者提供云端 GPU 算力支持。
- 感谢 Hugging Face `diffusers`、`@visioncortex/vtracer`、[`pi-ai` / `pi-agent-core`](https://github.com/badlogic/pi-mono) 与各大开源模型团队。
