# AIGC Studio 迁移说明（Phase 1）

> 目标文档：[`AIGC_STUDIO_STANDALONE_PLAN.md`](AIGC_STUDIO_STANDALONE_PLAN.md)（架构与路线图）
> 施工契约：[`MIGRATION_SPEC.md`](MIGRATION_SPEC.md)（执行期硬约定）
> 源码基线：`dsh-our-imagen` 0.14.0（`lib/` 14,190 行、`src/` 27,817 行、`remote/` 8,489 行、
> `shared/` 2,252 行、`test/` 约 7.7 万行）

本文记录**实际落地时与规划不一致的地方、原因与替换路径**，以及 Phase 1 的验收记录与遗留项。

---

## 1. 交付概览

| 模块 | 状态 | 说明 |
| :--- | :--- | :--- |
| `server/`（本地控制面） | ✅ 完成 | 原 `lib/` 全量迁移 + 宿主适配层 + standalone HTTP 服务 + 工作区/全局设置 + LLM 客户端 + Agent 工具循环 || `web/`（React 工作台） | ✅ 完成 | 原 `src/` 全量迁移，Vite 构建；移除 DSH slots/locale/theme 依赖；新增工作区切换、LLM/语言/主题设置 |
| `electron/`（桌面壳层） | ✅ 完成 | 主进程、preload、托盘、子进程托管、退出保护、原生桥、打包配置、无人值守自检 |
| `worker/`（GPU 执行端） | ✅ 完成（改名） | Python 包 `remote` → `worker`；推理/会话/隧道逻辑零改动 |
| `shared/`、`models/`、`tools/` | ✅ 完成 | 契约前缀统一 `/api`；模型资产校验与 worker 契约生成通过 |
| `test/` | ✅ 完成（见 §5） | contract / client / host 三组离线回归 + worker Python 测试 |
| `mcp/` | ⏳ Phase 2 占位 | 只有规划说明；工具定义已统一在 `server/agent/tools.js`，Phase 2 直接映射 |
| AI 视频 / 3D | ⏳ Phase 3 | 未开始；`mediaType` 与版本树边界已按规划预留 |

---

## 2. 决策日志（与规划不一致之处及原因）

### D1. LLM 与 Agent：不引入 `pi-ai` / `pi-agent-core`，改为零依赖自研

- **规划**：`server/llm.mjs` 基于 `pi-ai`，`server/agent/` 基于 `pi-agent-core`。
- **实际**：`server/llm/`（service + OpenAI 兼容 / Anthropic / Ollama 三个 provider + SSE 解析）
  与 `server/agent/{runtime,tools,message-adapter}.js` 全部自研，仅依赖内置 `fetch` 与 Web Streams。
- **原因**：
  1. Phase 1 只需「流式文本 + 工具调用」两类能力，自研约 900 行即可覆盖三类后端；
  2. 不引入额外依赖体积与版本约束（Electron 打包、离线环境更稳）；
  3. 可以用本地 mock HTTP 服务做**离线回归**（真实 API Key 不可用环境下这是唯一可验证的路径）；
  4. `server/llm.js`（原 `lib/llm.js`）一行未改即可复用：新服务实现了
     `ctx.get('llm')` / `ctx.get('agentDefaultModel')` 期望的 `prepareCall` / `stream` / `currentSelection` 形状。
- **替换路径**：若后续要换成 `pi-ai`，只需替换 `server/llm/service.js` 的内部实现并保持
  `stream / prepareCall / complete / getSelection / describe` 五个方法不变。
- **Agent 的已知简化**：工具调用结果以**文本消息回填**（不依赖各家原生 tool 消息协议），
  因此多轮工具链在 OpenAI / Anthropic / Ollama 上行为一致；代价是模型侧看不到结构化的
  `tool_calls` 历史。Phase 2 若要更严格的多轮工具协议，只需在 providers 层补结构化消息，
  循环与事件契约不用改。

### D2. 服务端模块统一 `.js`（规划里写的是 `.mjs`）

根 `package.json` 是 `"type": "module"`，全部 ESM。统一 `.js` 让原 `lib/**` 的相对导入零改动
（仍带显式扩展名）；`electron/main.mjs` 等按规划保留 `.mjs`，`preload.cjs` 必须是 CommonJS。

### D3. API 前缀 `/imagen-api` → `/api`

`shared/contract.js` 的 `ROUTES` 全量改前缀，并新增
`workspace` / `workspaceSwitch` / `appSettings` / `appSettingsSave` / `agentChat`。
其余路径末段不变，前端仍通过 `clientPath()` 取请求路径。

### D4. 产物目录 `outputs/`，自动兼容旧 `imagen-output/`

`server/paths.js` 的 `outputRoot(ctx)` 按「`outputs` 已存在 → 用它；否则 `imagen-output` 已存在 →
用它；都没有 → `outputs`」自动探测，因此：

- 新建工作区使用 `outputs/`；
- 从 DSH 插件时代延续下来的工作区继续读写 `imagen-output/`（不强制搬迁、不复制数据）；
- 测试夹具大量使用 `imagen-output/`，因此仍然有效。

### D5. 工作区元数据目录 `.aigc-studio/`

替代原 `.imagen/`：`settings.json`、`library.json`、`session.json`、`ui-state.json`、日志。
`.imagen` 只作为 `saveTo` 保留目录判定（防止把产物写进历史遗留目录）。

### D6. Electron 打包 `asar: false`

本地服务以 `ELECTRON_RUN_AS_NODE=1` 子进程运行，`worker/` 下的 Python 源码需要真实文件路径
（打 ZIP 上传 Kaggle），asar 内的文件无法被 `child_process` 直接读取，因此 Phase 1 关闭 asar。
后续若需要收拢，可把 `server/` + `worker/` 放进 `asarUnpack`。

### D7. 样式仍走「CSS 字符串 + `<style>` 注入」

原插件用 esbuild 的 text loader 把每个 `.css` 打成字符串（`web/styles.js` 汇总后由
`Studio.jsx` 注入）。为不改动业务源码，`vite.config.js` 里写了 `cssAsText` 插件，把
JS/JSX 中的 `import './x.css'` 改写成 Vite 的 `?inline` 导入，行为与原来一致；
测试用的 esbuild 打包保留 text loader。

### D8. Vite 的 JSX 变换必须是 `automatic`

原插件 esbuild 构建配置为 `jsx: 'automatic'`；Vite 默认对 `.jsx` 用 classic 变换
（编译成 `React.createElement`）。`web/studio/icons.jsx` 这类纯 JSX 片段不 import React，
classic 变换会在运行时报 `React is not defined`（首次 Electron 自检白屏即此原因）。
修复：`vite.config.js` 增加 `esbuild: { jsx: 'automatic', jsxImportSource: 'react' }`；
`tools/build-web-test-bundle.mjs` 也必须保持同一设置。

### D9. 资产类型边界（规划 §五.1）的最小实现

`meta.json` / `HistoryItem` 增加归一化字段 `mediaType`（写入固定 `image`，读取缺省回落 `image`）。
Phase 1 不扩展视频/3D 产物路径；HTTP Range 流式读取与 `Stage` 按 `mediaType` 分发留到 Phase 2/3。

### D10. Electron 窗口加载判定与 Windows 退出语义

- 加载判定：打包 → production（本地服务托管 `dist/web`）；未打包且显式设置 `VITE_DEV_SERVER_URL`
  → dev-server；未打包但 `dist/web/index.html` 存在 → production（这也让 `npx electron .` 可以直接做
  生产形态自检）；其余回退 dev-server（5173）。
- Windows 上 `child.kill('SIGTERM')` 等价 `TerminateProcess`，会跳过服务的 `dispose()`；
  因此 `server-host` 的停止顺序改为 **stdin EOF → 3s 宽限 → `taskkill /T /F`**（总预算 10 秒），
  POSIX 仍是 stdin.end + SIGTERM。
- 服务重启时 Token 策略：显式 `AIGC_STUDIO_TOKEN`（开发态，Vite 代理依赖）保持不变；
  未设置时每次启动/重启随机生成，窗口经 `additionalArguments` 更新 bootstrap 并重建。
- 新增 `electron/logger.mjs`：壳层日志写 `<dataDir>/logs/electron.log`（5MB 轮转），
  对应规划 §4.2 的「桌面壳全局日志」。
- 无人值守自检（CI/验收用）：`AIGC_STUDIO_SMOKE_CAPTURE=<png>` 时窗口加载后截图、
  打印 `SMOKE_OK {url,title,capturePath}` / `SMOKE_DIAG {...}` 并退出；本仓库的截图即由此产出。

### D11. 开发态 Vite 代理的两个坑（已修）

1. 代理键必须是 `'/api/'`（带尾斜杠）：写成 `'/api'` 会把模块请求 `/api.js` 也代理走；
2. 仍需 `bypass`：`web/api/resources.js` 在 dev 下的模块 URL 是 `/api/resources.js`，
   同样以 `/api/` 开头，会被代理并 404，导致模块图中断、页面白屏。
   带静态扩展名的请求交还 Vite，真正的接口路径（无扩展名）才代理。
3. 端口/Token 优先级：进程环境变量（`npm run dev` 由 `dev.mjs` 注入）> `.env` > 默认值。

### D12. 版本号沿用源码基线 `0.14.0`

`test/check-contract.mjs` 有硬约束「`package.json.version === shared/contract.js` 的 `VERSION`」，
且 `VERSION` 同时是远端 daemon 协议版本（`worker/daemon.py`、`worker/contract.json` 必须一致）。
独立客户端首个版本沿用代码基线 `0.14.0`，保证版本单源约束不破；产品自身的 1.0 里程碑在 Phase 2/3
再统一升版（届时同步改 `shared/contract.js`、`worker/daemon.py`、`test/mock-daemon.py` 并重新生成契约）。

---

## 3. 运行形态

```
Electron 主进程
  ├─ 生成随机 Token + 空闲端口
  ├─ spawn(process.execPath, [server/standalone.js], ELECTRON_RUN_AS_NODE=1, stdio 含 ipc)
  ├─ 解析 stdout 唯一一行 {"type":"ready",port,token,origin}
  ├─ BrowserWindow 加载 http://127.0.0.1:<port>/（生产）或 Vite 5173（开发）
  │    └─ preload 注入 window.aigcStudio（bootstrap/apiBaseUrl/token/选目录/通知/托盘…）
  └─ before-quit：stdin EOF → SIGTERM → taskkill /T /F（总预算 10 秒）
```

- `server/standalone.js` 只监听 `127.0.0.1`，`/api/*` 强制 Bearer Token；
  静态资源免 Token，但 `index.html` 返回前注入 `window.__AIGC_STUDIO__`（含 Token）。
- stdin EOF / IPC 断开只在**确实被父进程托管**时作为退出信号（`process.send` 存在或
  `AIGC_STUDIO_HOSTED=1`），避免 `Start-Job`、CI、`< nul` 等场景误判为父进程死亡。
- 浏览器开发态：`npm run dev:server` + `npm run dev:web`，Vite 代理 `/api` 并注入 dev token。

## 4. 数据与配置

```
%APPDATA%\aigc-studio\            （AIGC_STUDIO_DATA_DIR 可覆盖）
├─ app-config.json                工作区历史 / 界面语言主题 / LLM 非敏感配置 / 算力默认值
├─ credentials\llm.json           LLM API Key（0600）
├─ credentials\colab-credentials.json
├─ logs\{electron,server}.log
└─ workspace\                     默认工作区（首次启动兜底）

<工作区>\
├─ outputs\<YYYYMMDD-HHmmss>-<jobId>\   产物 + meta.json（旧工作区自动沿用 imagen-output\）
└─ .aigc-studio\                   settings / library / session / ui-state / 日志
```

LLM 设置接口：`GET/POST /api/app-settings`（`llm` 只回 `hasApiKey` / `apiKeySource`，不回原文；
`clearLlmApiKey` 清除）。工作区接口：`GET/POST /api/workspace`（活跃任务时拒绝切换，返回 409
`workspace_busy`）。

---

## 5. 验收记录（Phase 1）

| 项 | 命令 | 结果 |
| :--- | :--- | :--- |
| 前端构建 | `npx vite build` | ✅ 通过（141+ 模块，产物 `dist/web/`） |
| 服务启动握手 | `node server/standalone.js` | ✅ 输出唯一 ready 行，SIGTERM 正常退出 |
| 本地鉴权 | 无 Token / 有 Token 请求 `/api/state` | ✅ 401 / 200 |
| 工作区切换 | `POST /api/workspace` | ✅ `current` 变更、`recent` 更新、`state.workspace` 同步 |
| 全局设置 | `GET/POST /api/app-settings` | ✅ 语言/主题/LLM 保存生效，Key 不回传 |
| LLM 润色链路 | mock OpenAI SSE → `POST /api/enhance` | ✅ `source:"model"` 且返回 4 组建议 |
| Agent 对话 | mock LLM → `POST /api/agent/chat`（SSE） | ✅ `text` → `done` 事件流 |
| Electron 全链路 | `npx electron .` + `AIGC_STUDIO_SMOKE_CAPTURE` | ✅ 服务就绪 → 窗口加载 → 工作台完整渲染（截图见 `docs/assets/workbench.png`）→ 干净退出 |
| Electron 开发态 | `npm run dev`（Vite dev-server + 代理） | ✅ `/api.js` / `/api/resources.js` 模块不被代理误伤，`/api/state` 代理 200，截图非空白，退出无孤儿进程 |
| Electron 打包 | `npx electron-builder --dir` | ✅ `release/win-unpacked/AIGC Studio.exe`（约 235 MB），打包产物实测 SMOKE_OK |
| GitHub 无需联网的 skill/逻辑回归 | `node test/run-all.mjs`（contract + client + host） | ✅ **41/41 步通过，exit 0**（契约 14/14 项 + 19/19；客户端 17 步；宿主 23 步） |
| GPU 执行端 | `python test/worker/run.py` | ✅ 525 tests OK |
| 模型资产 | `node tools/build-assets.mjs --check` | ✅ 7 个模型资产一致 |
| 三端契约 | `node tools/gen-contract-json.mjs --check` | ✅ `worker/contract.json` 与 `shared/contract.js` 一致 |
| Kernel 打包（本地） | `server/kernel.js` buildKernelFolder | ✅ 34 条目全 `worker/` 前缀，解包 `import worker.daemon` 成功 |

## 6. 已知限制与遗留项

1. **真实 Kaggle / Colab 真机未验证**（本机无可用凭据）。
   代码路径原样迁移；已用 `buildKernelFolder` + mock daemon 做离线验证。
   首次真机运行请按 `docs/TROUBLESHOOTING.md` 排查。
2. **未产出安装包**：`electron-builder` 需要下载平台工具链；Phase 1 只交付打包配置
   （`electron-builder.yml`）。首个可用安装包前需补 `build/icon.ico` / `icon.icns`（当前用 Electron 默认图标）。
3. **CSP**：本地服务未配置 `Content-Security-Policy`（Electron 开发态会打印安全警告）。
   上线前建议加 `default-src 'self'` + 允许内联样式/脚本的策略（工作台依赖注入的 `<style>` 与 bootstrap 脚本）。
4. **Agent 未接入工作台对话 UI**：桌面端对话仍走本地意图解析 + `/api/enhance`；
   `/api/agent/chat` 已可用（SSE），供 Phase 2 的 MCP / 对话式创作使用。
5. **`mcp/`、`worker/worker_server.py` 为 Phase 2 占位**；`server/providers/{private-worker,local-gpu}.js`
   为契约占位（抛出明确的 not_implemented 错误）。
6. **`docs/` 下的历史设计文档**已做路径替换（`lib/`→`server/`、`src/`→`web/`、`remote/`→`worker/`、
   `/imagen-api`→`/api`），但内容仍描述 DSH 插件时代的部分行为，阅读时以本文件与
   `MIGRATION_SPEC.md` 为准。
7. **单文件 bundle 体积**：`dist/web/assets/index-*.js` 约 760 KB（gzip 约 220 KB）。
   Phase 1 保持单 chunk（与旧 `client.js` 905 KB 相比已减小）；后续可用动态 import 按面板拆包。
8. **切换工作区后部分设置不跟随**：`settings.json`（算力偏好）与 update-check 缓存在 App 构造时
   按当时工作区解析一次路径，切换工作区后仍读写旧工作区，**重启客户端后生效**；
   产物目录 / 历史 / 收藏 / 界面状态 / 日志目录则即时跟随。Phase 2 计划给 settings 加 `reload()`。
9. **静态服务不做 SPA 回退**：未知路径一律 404（工作台是单页应用，不需要路径路由）。
10. **Windows 退出语义**：`child.kill('SIGTERM')` 在 Windows 上是 TerminateProcess（不会执行 JS 处理器），
    因此 Electron 侧改走 stdin 关闭 / IPC 断开触发优雅退出（已验证）；Linux / macOS 仍走 SIGTERM。

## 7. Phase 2 / 3 接入点（已预留）

| 规划项 | 预留位置 |
| :--- | :--- |
| 私有 GPU Worker（Docker/SSH/直连） | `server/providers/private-worker.js` + `ComputeProvider` 契约注释 |
| 本机 GPU（`nvidia-smi` + `uv` 环境） | `server/providers/local-gpu.js`；长驻 Worker 入口 `worker/worker_server.py` |
| HTTP Range 媒体流 | `server/routes/files.js`（当前仍是整文件发送，接口已统一在 `resolveOutputPath` 之后） |
| SSE 任务进度 | `server/routes/events.js`（未创建；Agent SSE 已提供 `/api/agent/chat` 可参考） |
| MCP Server | `mcp/README.md` + `server/agent/tools.js`（名称/描述/JSON Schema/执行函数已统一） |
| 视频与 3D 资产 | `mediaType` 字段、`models/*.json` 的 `mediaType` 扩展位、版本树（资产无关） |
