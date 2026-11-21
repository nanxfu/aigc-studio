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

### D13. `<img>` 图片鉴权：同源 HttpOnly Session Cookie（主）+ 主进程头注入（兜底）

**问题**：所有 `/api/*` 都要求 `Authorization: Bearer`，但浏览器接管 `<img src>` 的资源请求无法由 JS
附加请求头 → 工作区一旦有图，页面就会裂图（Phase 1 验收时工作区为空，测试没暴露）。

**方案**：
1. 本地服务启动时生成独立的 `sessionToken`；返回 `index.html` 时下发
   `Set-Cookie: aigc_session=<hex>; HttpOnly; SameSite=Strict; Path=/`。
2. `/api/*` 鉴权分两级：
   - Bearer 匹配 → 放行全部接口（JSON API 仍只认 Bearer）；
   - Cookie 匹配 **且** 请求为 `GET/HEAD /api/file` **且** 通过「同源被动读取」校验
     （`Sec-Fetch-Site: same-origin`，或 `Origin`/`Referer` 的 host 与监听地址一致）→ 放行。
     三个头都不存在时（curl 等非浏览器调用）拒绝 Cookie 鉴权，必须用 Bearer。
   - Token 比较用 `timingSafeEqual`。
3. Electron 主进程额外用 `session.defaultSession.webRequest.onBeforeSendHeaders` 给
   **仅当前服务 origin** 的请求补 `Authorization: Bearer`（已存在则不覆盖），作为 Cookie 不可用时的兜底；
   每次请求读最新 Token，服务重启后自动生效（不把 Token 发给其它本地端口或外部站点）。

### D14. 产物图片 URL 改为相对路径

`server/output.js` 的 `fileUrl()` 由「绝对 origin + /api/file」改为工作区相对路径
`/api/file?path=...`。原因：

- Electron 生产态窗口与本地服务同源，相对路径直接命中；
- 浏览器开发态（Vite 5173）相对路径经 Vite 代理注入 Bearer，图片可用；
  而绝对 origin 会让 `<img>` 直连 `127.0.0.1:<服务端口>` 且不带 Token → 开发态必裂图；
- 历史/任务/Agent 文案里的 URL 因此与部署地址解耦。

### D15. `/api/file` 支持 HTTP Range（规划 §五.2）

改为 `fs.createReadStream` 流式响应：`Accept-Ranges: bytes` 恒返回；`Range: bytes=start-end / start- / -suffix`
合法时 206 + `Content-Range`，越界/非法 416 + `Content-Range: bytes */size`；无 Range 或无意义 Range 返回 200。
不再把整个文件读进内存，也不再返回 `Access-Control-Allow-Origin: *`（媒体只允许同源读取）。
这是 Phase 2 视频（MP4 拖动进度条）与 3D 资产（`.glb` 二进制流）读取的底层通道。

### D16. 工作区热切换：前端全量重置 + 服务端设置路径动态解析

- 前端 `useWorkLibrary` 监听 `state.workspace.current` 变化：清空历史分页 / 收藏 / 选中作品 /
  版本树缓存 / 草稿态与乐观收藏，重新拉取第 0 页历史与收藏，避免切换后残留旧工作区的图（裂图/误删风险）；
- 服务端 `createSettingsStore` 不再在构造时固定 `settings.json` 路径，改为每次按当前工作区解析，
  并提供 `await reload()`；`POST /api/workspace` 切换成功后立即 reload，`/api/settings` 与 `/api/state`
  马上反映新工作区的算力偏好；
- `update-check` 缓存路径仍在构造时解析（`updateCheck` 默认关闭，Phase 2 再接 GitHub Releases 时一并改为动态）。

### D17. 「带真实图片」的桌面冒烟（防测试盲区）

新增 `test/smoke-image.mjs` 并纳入 host 组：在临时工作区 `outputs/<stamp>-<jobId>/` 造一条真实产物
（运行期用 zlib 生成 64×64 PNG + 与 `saveJobOutput` 同形的 `meta.json`），启动 Electron 生产形态并开启
`AIGC_STUDIO_SMOKE_REQUIRE_IMAGE=1`。主进程 SMOKE 模式会等图片加载后校验：

- 页面中 `/api/file` 图片数量 ≥ 1；
- 至少一张 `complete && naturalWidth > 0`；
- 不存在 `complete && naturalWidth === 0` 的图片（解码失败 = 401/404/坏字节）；
- `/api/state` 探针 200、截图非空。

这样「空工作区绿灯、有图就裂」的回归会直接让测试失败。无 Electron 二进制的环境自动 SKIP。

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
| 图片读取鉴权 | Cookie（HttpOnly/SameSite）vs Bearer vs 无凭证 | ✅ `test/standalone-server.mjs`：同源 Cookie 200；无凭证 / Cookie 跨源 / Cookie 无来源 401；Bearer 200；`document.cookie` 为空（HttpOnly 生效） |
| 图片流式/Range | `GET /api/file` + `Range: bytes=…` | ✅ 206 + `Content-Range`、10 字节；越界 416；HEAD 无 body |
| 有图工作区桌面冒烟 | `node test/smoke-image.mjs`（Electron + 真实 PNG） | ✅ `/api/file` 图 `complete && naturalWidth>0`、截图非白屏 |
| 全局设置 | `GET/POST /api/app-settings` | ✅ 语言/主题/LLM 保存生效，Key 不回传 |
| LLM 润色链路 | mock OpenAI SSE → `POST /api/enhance` | ✅ `source:"model"` 且返回 4 组建议 |
| Agent 对话 | mock LLM → `POST /api/agent/chat`（SSE） | ✅ `text` → `done` 事件流 |
| Electron 全链路 | `npx electron .` + `AIGC_STUDIO_SMOKE_CAPTURE` | ✅ 服务就绪 → 窗口加载 → 工作台完整渲染（截图见 `docs/assets/workbench.png`）→ 干净退出 |
| Electron 开发态 | `npm run dev`（Vite dev-server + 代理） | ✅ `/api.js` / `/api/resources.js` 模块不被代理误伤，`/api/state` 代理 200，截图非空白，退出无孤儿进程 |
| Electron 打包 | `npx electron-builder --dir` | ✅ `release/win-unpacked/AIGC Studio.exe`（约 235 MB），打包产物实测 SMOKE_OK |
| 打包产物有图冒烟 | 打包 exe + 临时工作区真实 PNG + `AIGC_STUDIO_SMOKE_REQUIRE_IMAGE=1` | ✅ `imagesLoaded=1`、`naturalWidth=64`、`imageFailures=0`、`/api/state` 200、截图 312 KB（见 `docs/assets/workbench-with-image.png`） |
| 离线回归 | `node test/run-all.mjs`（contract + client + host） | ✅ **42/42 步通过，exit 0**（契约 14/14 项 + 19/19；客户端 17 步；宿主 24 步，含新增 smoke-image） |
| GPU 执行端 | `python test/worker/run.py` | ✅ 525 tests OK |
| 模型资产 | `node tools/build-assets.mjs --check` | ✅ 7 个模型资产一致 |
| 三端契约 | `node tools/gen-contract-json.mjs --check` | ✅ `worker/contract.json` 与 `shared/contract.js` 一致 |
| Kernel 打包（本地） | `server/kernel.js` buildKernelFolder | ✅ 34 条目全 `worker/` 前缀，解包 `import worker.daemon` 成功 |

## 6. 已知限制与遗留项

> 下列条目是 Phase 1 收尾时的状态；M1.5 / M2 已闭环的项在条目内标注「已闭环」并保留原始记录。

1. **真实 Kaggle / Colab 真机未验证**（本机无可用凭据）。
   代码路径原样迁移；已用 `buildKernelFolder` + mock daemon 做离线验证。
   首次真机运行请按 `docs/TROUBLESHOOTING.md` 排查。
   → **M2 已闭环**：2026-11-21 用真实 Kaggle 账号完成凭据探测、CPU 探针调度链路与真实 GPU 验收，
   见 §9 与 [`LIVE_ACCEPTANCE.md`](LIVE_ACCEPTANCE.md)。
2. **未产出安装包**：`electron-builder` 需要下载平台工具链；Phase 1 只交付打包配置
   （`electron-builder.yml`）。首个可用安装包前需补 `build/icon.ico` / `icon.icns`（当前用 Electron 默认图标）。
   → **M2 已闭环**：Windows NSIS 安装包 + 便携版已产出并通过安装/卸载/冒烟验收；
   `build/icon.png`（1024）、`icon.ico`（16~256）、`icon.icns`（16~1024）由 `tools/build-icons.py` 生成。
   macOS `dmg` 仍需在 macOS 上打包（配置已就绪）。
3. **CSP**：本地服务未配置 `Content-Security-Policy`（Electron 开发态会打印安全警告）。
   上线前建议加 `default-src 'self'` + 允许内联样式/脚本的策略（工作台依赖注入的 `<style>` 与 bootstrap 脚本）。
   → **M1.5 已闭环**：`server/http-server.js` 已下发 CSP 响应头。
4. **Agent 未接入工作台对话 UI**：桌面端对话仍走本地意图解析 + `/api/enhance`；
   `/api/agent/chat` 已可用（SSE），供 Phase 2 的 MCP / 对话式创作使用。
   → **M1.5 已闭环**：`ChatPanel` 已接入 `/api/agent/chat` SSE，未配置 Key 时静默回退意图卡。
5. **`mcp/`、`worker/worker_server.py` 为 Phase 2 占位**；`server/providers/{private-worker,local-gpu}.js`
   为契约占位（抛出明确的 not_implemented 错误）。
6. **`docs/` 下的历史设计文档**已做路径替换（`lib/`→`server/`、`src/`→`web/`、`remote/`→`worker/`、
   `/imagen-api`→`/api`），但内容仍描述 DSH 插件时代的部分行为，阅读时以本文件与
   `MIGRATION_SPEC.md` 为准。
7. **单文件 bundle 体积**：`dist/web/assets/index-*.js` 约 760 KB（gzip 约 220 KB）。
   Phase 1 保持单 chunk（与旧 `client.js` 905 KB 相比已减小）；后续可用动态 import 按面板拆包。
8. **切换工作区后 update-check 缓存不跟随**：`settings.json`（算力偏好）已支持热切换（`settings.reload()`，
   见 D16）；仍固定按启动时工作区解析的只有 update-check 缓存文件。由于 `DEFAULT_CONFIG.updateCheck=false`
   （Phase 1 不联网检查），实际影响可忽略，Phase 2 接 GitHub Releases 时一并改为动态路径。
9. **静态服务不做 SPA 回退**：未知路径一律 404（工作台是单页应用，不需要路径路由）。
10. **Windows 退出语义**：`child.kill('SIGTERM')` 在 Windows 上是 TerminateProcess（不会执行 JS 处理器），
    因此 Electron 侧改走 stdin 关闭 / IPC 断开触发优雅退出（已验证）；Linux / macOS 仍走 SIGTERM。
11. **`/api/file` 只实现单段 Range**：多段 `Range`、非 `bytes` 单位、`If-Range`/ETag 按 RFC 忽略并回 200 全量；
    视频/3D 的拖动播放已够用，需要 multipart/byteranges 时在 Phase 2 补。
12. **Cookie 的安全边界**：`aigc_session` 是 HttpOnly（页面脚本读不到），但本机同用户进程可以读到
    index.html 的 `Set-Cookie` 响应头；其保密级别与 Phase 1 已把 Bearer Token 明文注入 index.html 的
    既有设计相同（图片读取的边界等价于「本机同用户可读文件」）。要更强边界需 Phase 2 改一次性 nonce + 短 TTL。

## 7. Phase 2 / 3 接入点（已预留）

| 规划项 | 预留位置 |
| :--- | :--- |
| 私有 GPU Worker（Docker/SSH/直连） | `server/providers/private-worker.js` + `ComputeProvider` 契约注释 |
| 本机 GPU（`nvidia-smi` + `uv` 环境） | `server/providers/local-gpu.js`；长驻 Worker 入口 `worker/worker_server.py` |
| HTTP Range 媒体流 | ✅ 已实现（D15）：`server/routes/files.js` 用 `createReadStream` 支持单段 Range（206/416），
为视频/3D 大文件拖动播放铺好通道 |
| SSE 任务进度 | `server/routes/events.js`（未创建；Agent SSE 已提供 `/api/agent/chat` 可参考） |
| MCP Server | `mcp/README.md` + `server/agent/tools.js`（名称/描述/JSON Schema/执行函数已统一） |
| 视频与 3D 资产 | `mediaType` 字段、`models/*.json` 的 `mediaType` 扩展位、版本树（资产无关） |

---

## 8. M1.5：`pi` 底座升级与桌面端打磨记录

在 Phase 1（`eeb43fd`）与四项修复（`4ba6dc7`）基础上完成 M1.5，核心改动如下：

1. **LLM 与 Agent 底座接入 `@earendil-works/pi-ai@1.6.0` & `@earendil-works/pi-agent-core@1.6.0`**：
   - 替代原手写 `server/llm/providers/*`、`sse.js`、`request.js` 与基于连续 `user` 文本折叠的自研多轮循环；
   - 通过 `server/llm/service.js`（`pi-ai` OpenAI 兼容 / Anthropic / Ollama `/v1`）与 `server/agent/runtime.js`（`Agent` + `convertToLlm` + `AbortSignal` + `maxSteps`）实现原生 `tool_use` / `tool_result` 多轮推理；
   - `/api/agent/chat` 支持 `text-delta`、工具状态事件与结束帧附带 `images`，断连自动 `abort`。
2. **工作台与桌面原生能力收口**：
   - `ChatPanel` 接入 `/api/agent/chat` SSE（模式切换、工具执行胶囊、生成结果图网、停止中断），未配置模型 Key 时静默回退 `/api/intent` 快卡；
   - 顶栏品牌统一为 `AIGC Studio`，设置按钮（`.ofs-topbar-settings`）提至顶栏右侧常驻；
   - 工作区热切换（`rebaseWorkspace`）改为仅清理绑定旧目录的 `origin` / `references` / `form`・`tool`・`job` 卡与结果图，保留未提交提示词、画幅参数与纯文字对话；
   - 接通 `desktop().showItemInFolder`（舞台工具条）、后台成败 `desktop().notify` 与排队 `desktop().setBadge`；
   - 新增 `build/icon.png`（256×256）与多尺寸 `build/icon.ico`、`server/http-server.js` `Content-Security-Policy` 响应头、`safeStorage` + AES-256-GCM 凭据加密与明文自动迁移、Vite `vendor` 分包。
3. **验证结论**：
   - `npx vite build`（149 模块，含 `vendor` 分包）通过；
   - `node test/run-all.mjs` **43/43 步全过**（含 `llm-client.mjs`、`agent-runtime.mjs`、`check-client-chat.mjs` Agent 模式渲染、`smoke-image.mjs`）；
   - `python test/worker/run.py` **525 tests OK**；
   - `npm run pack` 产出 `release/win-unpacked/AIGC Studio.exe`，带真实 PNG 冒烟 `SMOKE_OK`（`imagesLoaded=1`、`imageFailures=0`，截图见 `docs/assets/workbench-m15.png`）。

---

## 9. M2：安装包交付与真机验收记录

在 M1.5 基线上完成 M2 的「安装包交付 + 云端真机接入」部分，2026-11-21 实测于
Windows 11 x64 / Node 24.19.0 / Electron 44.11.5 / electron-builder 26.18.0。

### 9.1 交付物

| 项 | 内容 |
| :--- | :--- |
| NSIS 安装包 | `release/aigc-studio-0.14.0-x64.exe`（约 124 MB，可选安装目录、创建快捷方式、per-user 安装） |
| 便携版 | `release/aigc-studio-0.14.0-portable.exe`（约 107 MB，自解压运行，不写安装目录） |
| 免安装目录 | `release/win-unpacked/`（`npm run pack` 亦可产出，用于快速验证） |
| 图标资产 | `build/icon.png`（1024²）、`build/icon.ico`（16/24/32/48/64/128/256）、`build/icon.icns`（16~1024） |
| 真机报告 | `bench-results/gpu-live/<时间戳>/report.json` + 样张（本地保留，已加入 `.gitignore`） |

### 9.2 新增工具与脚本

- `tools/build-icons.py`：参数化矢量方式在 4× 超采样下重绘原 256² 图标，产出 1024 PNG、
  多尺寸 ICO 与 ICNS；`--check` 校验尺寸与多尺寸表。设计参数沿用原图量取值（对角渐变
  `#4C49E4 → #08B2D4`、磁贴圆角 20.6%、取景框内缩 19.2% / 描边 5.8%、圆环外径 12.7% / 内径 6.0%、
  圆心 `#2563EB`）。`npm run icons:build` / `icons:check`。
- `tools/probe-kaggle.mjs`：只读 Kaggle 环境探测（鉴权 + 配额），与客户端 `/api/state` 走同一条
  `probeKaggle` 代码路径；`--json` 便于脚本判定，退出码 0/2/1 区分正常 / 鉴权失败 / 异常。
  `npm run kaggle:probe`。
- `test/smoke-packaged.mjs`：直接启动**打包后的可执行文件**的「带真实图片」冒烟
  （打包布局、应用版本、`/api/state` 探针、图片解码、截图、残留进程），适用于 win-unpacked /
  安装目录 / 便携版。`npm run test:packaged`。
- `test/smoke-installer.mjs`：NSIS 静默安装 → 目录与 Windows 版本资源校验 → 安装形态冒烟 →
  静默卸载 → 残留检查。`npm run test:installer`。
- `test/helpers/image-fixture.mjs`：把 `smoke-image.mjs` 里的真实 PNG 夹具抽出，供两套冒烟共用。
- `package.json` 新增脚本：`icons:build` / `icons:check` / `kaggle:probe` / `test:packaged` / `test:installer`。

### 9.3 验收结果

| 项 | 命令 | 结果 |
| :--- | :--- | :--- |
| Kaggle 环境探测 | `npm run kaggle:probe` | ✅ 直连鉴权正常（账号 mogudd），GPU 配额 30h 未使用 |
| 调度链路（CPU 探针） | `node test/kaggle-live.mjs` | ✅ push → 排队 → cloudflared 隧道 → 握手 → `/generate`（1×1 PNG）→ 关机，exit 0 |
| 安装包构建 | `npm run dist` | ✅ NSIS 124 MB + 便携版 107 MB |
| win-unpacked 冒烟 | `npm run test:packaged` | ✅ 10/10 |
| 安装 → 冒烟 → 卸载 | `npm run test:installer` | ✅ 9/9（含 ProductName / FileVersion、卸载清理） |
| 便携版冒烟 | `npm run test:packaged -- --exe …-portable.exe` | ✅ 8/8 |
| 离线回归 | `npm test` | ✅ 43/43 步（重构夹具后复跑） |
| 真机 GPU 文生图 / 局部重绘 / 高清放大 / 扩图 / 参考生图 | `node test/gpu-live.mjs`（各模式） | ✅ 全部 exit 0（2026-11-21，2×Tesla T4），见 §9.4 |

### 9.4 真机 GPU 验收

| 项 | 结果 |
| :--- | :--- |
| 文生图（`node test/gpu-live.mjs`） | ✅ 2026-11-21 exit 0：Kernel `mogudd/imagen-d806c4ff`，2×Tesla T4；首次排队约 10 分钟、自动换新实例 2 次后拿到 GPU；冷启动预下载 35.3s + 加载 53.3s；1024² / 4 步 / CFG 0 / seed 42 出图 **9.69s**、PNG 1.21 MB；关机 `absent`。报告：`bench-results/gpu-live/2026-11-21T11-45-45/` |
| 局部重绘（`node test/gpu-live.mjs --inpaint`） | ✅ 2026-11-21 exit 0：同会话先文生图（12.77s）再以中心 40% 矩形蒙版（覆盖率 16.03%、羽化 8px、strength 0.6）重绘，**9.02s**；`from_pipe` 复用底座（重绘加载 0s、allocated 7000→7000 MiB、max_allocated 10233 MiB 不变、reserved +4 MiB）；未涂抹区逐像素保留；关机 `absent`。报告：`bench-results/gpu-live/2026-11-21T11-49-20/` |
| 高清放大（`node test/gpu-live.mjs --upscale`） | ✅ 2026-11-21 exit 0：先文生图 1024²（11.46s），再放大到 2048²；放大推理 1.39s、加载 2.17s、PNG 4.01 MB、`outputMatchesSource=true`；reserved 显存 -3746 MiB；关机 `absent`。报告：`bench-results/gpu-live/2026-11-21T12-09-12/` |
| 扩图（`node test/gpu-live.mjs --outpaint-lora`） | ✅ 2026-11-21 exit 0：`flux2-klein-4b` + `fal/flux-2-klein-4B-outpaint-lora`（scale 1.1），864² 内容居中扩到 1536×864；输出尺寸严格匹配、绿边残留 0、接缝比 1.15/1.14、内容区平均差 12.87、颜色漂移 max 3.47；LoRA 加载 34.4s + 推理 20.7s，对比 sdxl-inpaint 历史中位 35.42s 提速 1.71×；关机 `absent`。报告：`bench-results/gpu-live/2026-11-21T12-24-34/` |
| 参考生图（`node test/gpu-live.mjs --preset flux2-klein-4b --reference`） | ✅ 2026-11-21 exit 0：1 参考图 23.72s / 25.48s（两轮逐像素一致，确定性 MAE 0）、2 参考图 50.92s、1280×720 画幅保持；`referenceEffectMae=7.71`、`oneVsTwoRefsMae=1.99`；复用管线加载 0s、显存全程 7680/7928 MiB 无增长；关机 `absent`。报告：`bench-results/gpu-live/2026-11-21T12-40-47/` |

远端依赖版本（当次 `/health`）：Python 3.13.16 / torch 2.11.0+cu130 / diffusers 0.43.0 /
transformers 5.23.0 / accelerate 1.16.0 / peft 0.22.0 / huggingface_hub 1.33.0 / pillow 13.0.0。

### 9.5 决策补记

- **D18. 图标改为脚本化重绘，不再直接使用 256² 原始 PNG**：原资产只有 256²，macOS 打包需要
  ≥512²，直接放大会有锯齿。改用 `tools/build-icons.py` 按量取参数重绘（4× 超采样后 LANCZOS 降采样），
  与原图 256² 逐像素平均差约 6/255（差异集中在原图生成时的不对称边缘），视觉一致但边缘更干净；
  `--check` 纳入构建校验，避免资产被手工替换后尺寸表丢失。
- **D19. 便携版自检结果落文件**：portable 版是 NSIS 自解压外壳，窗口进程由外壳另行拉起，
  stdout 不再指向调用方管道，`SMOKE_OK` / `SMOKE_DIAG` 全部丢失。`electron/main.mjs` 新增
  `writeSmokeResultFile`，成功 / 失败都把结果写到 `<capture>.json`；`test/smoke-packaged.mjs`
  优先读 stdout，读不到时回退结果文件。安装包验收因此不依赖控制台重定向，也便于 CI 读取。
- **D20. `bench-results/` 纳入 `.gitignore`**：`PRE_RELEASE_SPEC.md` 早已约定真机报告与样张
  仅本地保留，迁移时漏掉了这一条；M2 补回，避免大体积样张误入仓库。
- **D21. 验收脚本不进默认回归分组**：`test:packaged` / `test:installer` 依赖已构建的安装包
  （耗时且需要 Electron 二进制），`test/kaggle-live.mjs` / `gpu-live.mjs` 消耗真实配额；
  均保留为独立命令，由 `docs/LIVE_ACCEPTANCE.md` 串成发布验收清单。
