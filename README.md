# AIGC Studio

独立的桌面端 AIGC 创作工作台，基于 **Electron + React (Vite) + 本地 Node.js 控制面 + 云端/可插拔 GPU 执行节点** 构建。无需复杂本地显卡部署，即可通过 Kaggle / Colab 等云端 GPU 会话完成全链路图像创作与本地资产归档。

![AIGC Studio 工作台](docs/assets/workbench.png)

## 核心特性

- **全链路图像创作**：支持文生图、图生图 / 多图参考、局部重绘（Inpaint）、高清放大与智能扩图（Outpaint）。
- **多模型热切换**：内置 7 种主流开源生图模型配置，涵盖 **FLUX.2 Klein (4B / 9B)**、**Qwen-Image 2.1**、**SANA Sprint 1.6B**、**SDXL Lightning**、**Z-Image Turbo** 与 **Anima Turbo v1.1**，模型声明位于 `models/` 目录，支持校验与扩展。
- **AI 创作助手**：内置单轨对话式创作助手与可编辑参数提案卡，支持接入 DeepSeek、Kimi、千问、硅基流动、Gemini、OpenAI、Anthropic、OpenRouter、Ollama 及自定义 OpenAI 兼容接口（未配置 LLM 时自动回落本地规则引擎）。
- **云端算力调度**：原生支持 **Kaggle Kernel** 与 **Google Colab** 临时 GPU 会话，通过 Cloudflare 隧道 / ntfy 安全会合；云端会话活跃时关闭窗口默认最小化到系统托盘，避免误关导致算力额度空烧。
- **工作区与本地归档**：支持多工作区随时切换，生成产物与参数元数据（`outputs/<时间>-<jobId>/meta.json`）全量本地落盘，配合作品画廊与收藏管理。
- **安全隔离设计**：
  - 本地服务仅绑定 `127.0.0.1`，每次启动生成 256-bit 随机 Bearer Token；
  - 媒体流 `/api/file` 采用同源 `HttpOnly; SameSite=Strict` 会话 Cookie 校验与单段 HTTP Range 流式传输；
  - Electron 渲染进程启用 `contextIsolation` 与 `sandbox`，仅通过受控 `preload` 白名单访问原生能力。

## 界面一览

| 浅色工作台 | 创作助手与提案卡 | 作品画廊 |
| :---: | :---: | :---: |
| ![浅色工作台](docs/assets/studio-light.png) | ![创作助手](docs/assets/chat-tool.png) | ![作品画廊](docs/assets/gallery.png) |

## 快速开始

### 环境要求

- **Node.js ≥ 20**（推荐 22+）
- **Python 3.10+**（仅运行 GPU Worker 端或 Python 测试时需要）
- **云端算力凭据**（真机出图需要）：本地已配置 Kaggle CLI（`~/.kaggle/kaggle.json`）或 Google Colab 授权

### 安装与运行

```powershell
git clone https://github.com/nanxfu/aigc-studio.git
cd aigc-studio

npm install
Copy-Item .env.example .env
```

选择以下任一方式启动：

```powershell
# 方式一：完整桌面客户端（Electron 窗口 + 本地服务）
npm run dev

# 方式二：浏览器开发模式（适合前端热更新调试）
npm run dev:server          # 终端 1：启动本地服务（默认 127.0.0.1:5130）
npm run dev:web             # 终端 2：启动 Vite 前端（默认 http://127.0.0.1:5173）
```

### 首次配置

启动后点击右上角 **「设置」**：

1. **工作区目录**：选择用于归档生成图片与元数据的本地文件夹；
2. **创作助手模型**（可选）：选择服务商并填写 API Key，点击「获取模型」即可选用（标准预设无需手填 Base URL，支持自定义反代地址）；
3. **云端算力**：选择 Kaggle 或 Colab 并启动 GPU 会话，状态就绪后即可开始创作。

## 构建与打包

```powershell
# 仅构建前端资源（输出至 dist/web，可通过 npm start 以浏览器模式运行）
npm run build:web

# 生成免安装绿色目录（输出至 release/win-unpacked/）
npm run pack

# 打包 Windows 安装包与便携版（输出至 release/）
npm run dist
```

`npm run dist` 会在 `release/` 下生成：
- `aigc-studio-<version>-x64.exe`：Windows NSIS 安装包
- `aigc-studio-<version>-portable.exe`：免安装单文件便携版

> 注：安装包默认未做商业代码签名，Windows 首次运行时如出现「未知发布者」提示，选择「仍要运行」即可。

## 架构概览

```text
┌──────────────────────────── Electron ────────────────────────────┐
│  electron/main.mjs        窗口管理 / 单实例 / 系统托盘 / 退出保护  │
│  electron/server-host.mjs 子进程托管本地 Node.js 控制面          │
│  electron/preload.cjs     contextBridge 原生能力白名单           │
└───────────────┬──────────────────────────────────────────────────┘
                │ HTTP + Bearer Token（仅 127.0.0.1）
┌───────────────▼───────────────┐        ┌──────────────────────────┐
│  server/  （本地控制面）        │        │  web/  （Vite + React）   │
│  standalone.js  入口/鉴权/静态  │◀───────│  工作台 UI 与状态管理      │
│  app.js         业务装配        │  同源   │  dev 时 Vite 代理 /api    │
│  session/ jobs/ providers/     │        └──────────────────────────┘
│  routes/  llm/  agent/         │
└───────────────┬───────────────┘
                │ HTTPS（Cloudflare 隧道 / ntfy 会合）
┌───────────────▼───────────────┐
│  worker/ （GPU 执行端，Python） │
│  Kaggle / Colab 推理守护进程    │
└───────────────────────────────┘
```

### 目录结构

| 目录 | 说明 |
| :--- | :--- |
| `electron/` | Electron 桌面壳层（窗口、托盘、子进程托管与 `preload` 桥接） |
| `server/` | 本地 Node.js 控制面（会话状态机、任务队列、路由、LLM 网关、工作区管理） |
| `web/` | React + Vite 前端工作台（画布、工具栏、画廊、设置中心、创作助手） |
| `shared/` | 前后端共享契约（API 路由、参数限制、错误码、模型能力定义） |
| `models/` | 模型资产声明 JSON（由 `tools/build-assets.mjs` 校验与构建） |
| `worker/` | Python GPU 执行端（Kaggle / Colab 守护进程与推理引擎） |
| `tools/` | 开发启动器、图标生成、契约与模型校验、Kaggle 环境探测等工具脚本 |
| `test/` | 离线回归测试套件（`contract` / `client` / `host` / `worker`）与真机验收脚本 |
| `docs/` | 架构设计、协议契约、模型规范与验收文档 |

## 测试与校验

```powershell
# 运行全部离线回归测试（contract + client + host，含 Electron 冒烟）
npm test

# 运行 Python Worker 离线测试
python test/worker/run.py

# 模型、图标与前后端契约一致性校验
npm run models:check
npm run icons:check
npm run contract:check

# 打包产物冒烟测试（需先执行 npm run dist）
npm run test:packaged
npm run test:installer
```

真机 GPU 链路探测（需配置 Kaggle / Colab 凭据）：

```powershell
npm run kaggle:probe              # 只读环境与 GPU 配额探测（不消耗配额）
node test/gpu-live.mjs            # 真机 GPU 文生图验收
```

## 开源许可

[MIT](package.json)
