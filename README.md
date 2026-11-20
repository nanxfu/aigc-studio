# AIGC Studio

独立的桌面 AIGC 工作台：**Electron + Vite (React) + 本地 Node.js 控制面 + 可插拔 GPU 执行节点**。

首期（Phase 1）目标是把原 DSH 插件 `dsh-our-imagen` 的图片生成能力原样剥离成独立客户端：

- 不依赖 DSH 即可双击启动；
- 本地 Node 服务（`127.0.0.1` + 启动期随机 Token）托管业务逻辑与 API；
- 算力后端沿用 **Kaggle Kernel / Colab** 临时 GPU 会话，跑通文生图 / 图生图 / 局部重绘 / 高清放大 / 扩图全链路；
- 工作区可切换、产物本地归档，后续按同一架构接入私有 GPU Worker、AI 视频与 3D 资产。

架构决策与路线图见 [`docs/AIGC_STUDIO_STANDALONE_PLAN.md`](docs/AIGC_STUDIO_STANDALONE_PLAN.md)，
执行期硬约定见 [`docs/MIGRATION_SPEC.md`](docs/MIGRATION_SPEC.md)，
迁移决策与验收记录见 [`docs/MIGRATION_NOTES.md`](docs/MIGRATION_NOTES.md)。

![工作台](docs/assets/workbench.png)

> 上图是打包后的独立客户端（`release/win-unpacked/AIGC Studio.exe`）首次启动的真实截图：
> 顶栏可切换工作区、查看云端算力状态与模型，左侧创作设置，右侧画面预览，底部作品条。

## 架构

```
┌──────────────────────────── Electron ────────────────────────────┐
│  electron/main.mjs        窗口 / 单实例 / 托盘 / 退出保护          │
│  electron/server-host.mjs 以 ELECTRON_RUN_AS_NODE 子进程托管 server │
│  electron/preload.cjs     contextBridge：选目录 / 通知 / 打开文件    │
└───────────────┬──────────────────────────────────────────────────┘
                │ HTTP + Bearer Token（仅 127.0.0.1）
┌───────────────▼───────────────┐        ┌──────────────────────────┐
│  server/  （本地控制面）        │        │  web/  （Vite + React）   │
│  standalone.js  入口/鉴权/静态  │◀───────│  工作台 UI（原 src/ 迁移） │
│  host-context.js 宿主适配层     │  同源   │  dev 时 Vite 代理 /api    │
│  app.js         业务装配        │        └──────────────────────────┘
│  session/ jobs/ providers/     │
│  routes/  llm/  agent/         │
└───────────────┬───────────────┘
                │ HTTPS（Cloudflare 隧道 / ntfy 会合）
┌───────────────▼───────────────┐
│  worker/ （GPU 执行端，Python） │
│  Kaggle / Colab 临时会话；后续： │
│  私有 Linux GPU Worker、本机 GPU │
└───────────────────────────────┘
```

## 目录

| 目录 | 职责 |
| :--- | :--- |
| `electron/` | 桌面壳层（极薄：OS 原生能力 + 子进程托管 + 托盘） |
| `server/` | 本地控制面（会话状态机、任务队列、路由、LLM 客户端、工作区与设置） |
| `web/` | React 工作台前端（Vite 构建，支持按需分包） |
| `shared/` | 前后端共享契约（路由、限制、错误码、模型能力） |
| `models/` | 模型资产声明（JSON，可由 `tools/build-assets.mjs` 校验生成） |
| `worker/` | GPU 执行端 Python 包（Kaggle/Colab 守护进程 + 推理引擎） |
| `tools/` | 构建校验、契约生成、模型验证、开发启动器 |
| `test/` | 离线测试套件（contract / client / host / worker） + live 真机脚本 |
| `docs/` | 架构、契约、模型资产规范、排障手册 |
| `mcp/` | *Phase 2*：把工作台能力导出为 MCP Server |

## 快速开始

环境要求：**Node.js ≥ 20**（开发机实测 24.x）；跑 worker 测试需要 **Python 3.10+**；
真机出图需要本地已登录 Kaggle CLI（`~/.kaggle/kaggle.json`）或 Colab 授权。

```powershell
npm install
Copy-Item .env.example .env      # 开发期配置（端口 / dev token / 放宽同源校验），.env 不进仓库

# 方式一：完整桌面客户端（Electron 窗口 + 本地服务，一条命令）
npm run dev

# 方式二：浏览器调试（推荐改前端时用）
npm run dev:server          # 终端 1：本地服务 127.0.0.1:5130（读取 .env 的 dev token）
npm run dev:web             # 终端 2：Vite 5173，自动代理 /api 并注入 token
# 打开 http://127.0.0.1:5173

# 生产构建 / 打包
npm run build:web           # 产物 dist/web，由本地服务托管；`npm start` 可直接以浏览器模式跑
npm run dist                # electron-builder 打安装包（输出 release/）
npm run pack                # 只打免安装目录（输出 release/win-unpacked/，用于快速验证）
```

> 浏览器调试时 Vite 的 Origin（5173）与本地服务端口（5130）不同源，`AIGC_STUDIO_DEV=1`
> 会放宽这一项校验（.env.example 已默认开启；Electron 生产模式保持严格同源校验）。


首次启动后在右上角「设置」里：

1. 选择或切换**工作区目录**（产物归档到 `<工作区>/outputs/`，元数据在 `<工作区>/.aigc-studio/`）；
2. 配置**创作助手模型**（OpenAI / Anthropic / 兼容端点 / Ollama 的 Base URL、Model、API Key），用于提示词润色与意图解析；
3. 选择算力来源（Kaggle / Colab）并启动云端会话。

没有配置 LLM 时工作台仍可用：润色/意图解析自动回落本地规则。

## 配置与数据

- **应用全局目录**（`%APPDATA%\aigc-studio\`，可用 `AIGC_STUDIO_DATA_DIR` 覆盖）：
  `app-config.json`（工作区历史、界面语言/主题、LLM 配置、算力默认值）、`credentials/`（0600）、`logs/`。
- **工作区目录**（用户自选）：
  `outputs/<YYYYMMDD-HHmmss>-<jobId>/` 产物与 `meta.json`；
  旧工作区的 `imagen-output/` 会被自动识别并继续使用（迁移期兼容），新建工作区使用 `outputs/`；
  `.aigc-studio/` 存放该工作区的设置、收藏、会话记录与界面状态。

## 安全模型

- 本地服务只监听 `127.0.0.1`，每次启动生成 256-bit 随机 Token；所有 `/api/*` 必须携带 Bearer Token；
  浏览器开发态由 Vite 代理注入，生产态由本地服务在 index.html 注入。
- Electron 窗口 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，渲染进程只通过 preload 白名单访问原生能力。
- 云端会话活跃时关闭窗口默认**最小化到托盘**，避免误关导致 Kaggle/Colab 额度空烧；托盘「彻底退出」会等待会话状态持久化。

## 测试

```powershell
npm test                          # contract + client + host 离线回归
node test/run-all.mjs --group client
python test/worker/run.py         # GPU 执行端离线测试
node tools/build-assets.mjs --check
node tools/gen-contract-json.mjs --check
```

需要真实 Kaggle/Colab 凭据的 live 用例（`test/kaggle-live.mjs`、`test/gpu-live.mjs`）不在默认分组内。

## 与 DSH 插件的关系

原插件仓库 `dsh-our-imagen` 维持在图片工作台维护态（0.14.x）。本仓库是其独立客户端，
业务逻辑（会话状态机、任务队列、产物落盘、前端纯逻辑与组件）直接迁移复用，
只重写了宿主边界：`ctx.webServer / subprocess / workingDirectory / llm / tools / effect` 六个 DSH 接口
由 `server/host-context.js` 提供轻量实现。

Phase 2/3 规划（私有 Worker、HTTP Range 媒体流、MCP Server、视频与 3D 资产）见架构文档。

## 许可

MIT
