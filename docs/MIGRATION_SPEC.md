# AIGC Studio 迁移执行规范（Phase 1 施工契约）

> 上位文档：`docs/AIGC_STUDIO_STANDALONE_PLAN.md`（架构与路线图，本规范只补充**执行期的硬约定**）。
> 源仓库：`D:\document\development\our-free-imagen`（**只读参考，禁止任何写入**）。
> 目标仓库：`D:\document\development\aigc-studio`（本仓库，已完成初版目录拷贝）。
> 本规范由 Lead 维护；任何与规范冲突的实现先发消息给 Lead，不要自行改约定。

---

## 0. 总原则

1. **零重写搬运**：业务逻辑（任务队列、会话状态机、Kaggle/Colab 驱动、产物落盘、纯逻辑层、UI 组件）
   从源仓库原样搬过来，只改**边界**：宿主接口、路径常量、API 前缀、入口装配。
2. **一次只换一个变量**：Phase 1 不引入 pi-ai / pi-agent-core 等外部 Agent 依赖，不重写 Python 推理端，
   不改模型资产格式，不改前端视觉与交互逻辑。
3. **不顺手重构**：不要为了“更漂亮”改函数签名、拆文件、改命名。源文件里 DSH 字样属于历史注释，
   非必要不改；只在明确列为“必须改”的地方动手。
4. **每个文件改完必须能跑**：`node --check <file>` / `vite build` / pytest 至少一种验证通过再交给 Lead。

---

## 1. 目录与模块规范

### 1.1 已完成的目录拷贝（Lead 已完成，勿重复搬）

| 源（只读） | 目标 | 说明 |
| :--- | :--- | :--- |
| `lib/**` | `server/**` | 文件名与子目录结构保持不变 |
| `src/**` | `web/**` | 文件名与子目录结构保持不变（`.jsx` 保留） |
| `shared/**` | `shared/**` | 原样 |
| `models/**` | `models/**` | 原样 |
| `remote/**` | `worker/**` | Python 包，需改包名（见 §8） |
| `test/**` | `test/**` | 保留结构，需改导入路径（见 §7） |
| `docs/**` | `docs/**` | 原样拷贝，后续统一改路径引用（Lead 负责） |
| `tools/**`（除 `.preview`） | `tools/**` | 保留 |
| `index.js` | `server/app.js` | 需改成工厂函数（见 §3.4） |
| `build.mjs` | `tools/build-web-test-bundle.mjs` | 需改成打 `web/test-entry.js`（见 §7.2） |

不迁移：根目录 `client.js`、`dist/`、`site/`、`locale/`、`scripts/package.mjs`、`.github/`、`bench*/`。

### 1.2 模块规范

- 根 `package.json` 已是 `"type": "module"`。**服务端、共享层、Web 全部 ESM，统一 `.js` 扩展名**
  （Plan 文档里 `.mjs` 只是示意；统一 `.js` 可以让 server 内部相对导入零改动）。
- `web/` 下 React 组件保留 `.jsx`；入口用 `main.jsx`。
- `electron/` 下按 Plan 命名：`main.mjs`、`tray.mjs`、`server-host.mjs`、`native-bridge.mjs`（ESM），
  `preload.cjs` 必须是 CommonJS（Electron preload 的硬要求）。
- 所有相对导入必须带扩展名（`.js` / `.jsx`）。

---

## 2. 本地服务（`server/standalone.js`）—— Web 与 Electron 的唯一后端

### 2.1 启动方式与输入

```
node server/standalone.js          # 开发/测试直接跑
```

Electron 主进程以子进程方式拉起（`ELECTRON_RUN_AS_NODE=1`，见 §6）。输入全部来自环境变量：

| 变量 | 默认 | 含义 |
| :--- | :--- | :--- |
| `AIGC_STUDIO_PORT` | `0` | 监听端口，`0` = 随机空闲端口 |
| `AIGC_STUDIO_TOKEN` | 随机生成 | 本地 API Bearer Token（32 字节 hex） |
| `AIGC_STUDIO_DATA_DIR` | 见 §4 | 应用全局数据目录 |
| `AIGC_STUDIO_WORKSPACE` | 见 §4 | 初始工作区目录（首次启动用） |
| `AIGC_STUDIO_WEB_DIST` | `dist/web` | 前端静态产物目录；不存在时只提供 API |
| `AIGC_STUDIO_DEV` | `0` | `1` 时放宽 Origin 校验（本地排障用） |

### 2.2 启动握手（Electron 依赖，必须逐字实现）

服务绑定成功后向 **stdout** 写一行 JSON，然后刷新：

```json
{"type":"ready","port":5130,"token":"<64位hex>","origin":"http://127.0.0.1:5130"}
```

- 这一行之前 stdout 不得输出任何内容（日志一律走 `stderr` 与文件日志）。
- 退出：收到 `SIGTERM`/`SIGINT`，或 stdin 关闭（父进程死亡），执行统一 `dispose()` 后 `process.exit(0)`；
  从收到信号到退出最多 10 秒（内部有超时兜底）。

### 2.3 HTTP 规则

- 只监听 `127.0.0.1`（禁止 `0.0.0.0`）。
- **API 前缀统一为 `/api/`**（原 `/imagen-api/` 全部替换）。所有 `/api/*` 必须校验
  `Authorization: Bearer <token>`，失败返回 `401 {"error":{"code":"unauthorized",...}}`。
- 同源校验：请求带 `Origin` 头且其 host 与监听地址不一致时返回 `403`（`AIGC_STUDIO_DEV=1` 时跳过）。
  不实现 CORS。
- 静态文件：`/`、`/index.html`、`/assets/*` 等免 Token；`index.html` 返回前在 `</head>` 前注入：

  ```html
  <script>window.__AIGC_STUDIO__={"apiBaseUrl":"","authToken":"<token>","platform":"win32","native":false}</script>
  ```

  （`native` 由 Electron preload 覆盖为 `true`；Vite 开发态不注入，`window.__AIGC_STUDIO__` 缺省由 `web/runtime.js` 兜底。）
- 路由表由 `server/route-kit.js` 的 `ctx.webServer.register({kind:'exact',path,handler})` 收集，
  本服务用一个 `Map<path, entry>` 精确分发（忽略查询串）；405/404 语义与 `lib/http.js` 保持一致。
- `ctx.webServer.getOrigin()` 返回 `http://127.0.0.1:<port>`（`server/output.js` 的 `fileUrl` 依赖它）。

### 2.4 新增路由（Phase 1 必须实现）

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/workspace` | 当前工作区 + 最近列表 + 是否可切换（有活跃任务时 `switchable:false`） |
| POST | `/api/workspace` | `{ "path": "D:\\AI-Projects\\x" }` 切换工作区（校验绝对路径、可创建、可写），成功后返回同 GET |
| GET | `/api/app-settings` | 全局应用设置脱敏视图（语言、主题、LLM 配置、最近工作区、版本） |
| POST | `/api/app-settings` | 合并保存白名单字段（`ui`, `llm`, `clearLlmApiKey`, `workspace`） |

`shared/contract.js` 的 `ROUTES` 里新增：

```js
workspace:      { method: 'GET',  path: '/api/workspace' },
workspaceSwitch:{ method: 'POST', path: '/api/workspace' },
appSettings:    { method: 'GET',  path: '/api/app-settings' },
appSettingsSave:{ method: 'POST', path: '/api/app-settings' },
```

其余既有路由只把 `/imagen-api/` 前缀改为 `/api/`，**路径末段一律不动**。

---

## 3. 宿主适配层（`server/host-context.js`）—— 剥离 DSH 的唯一改动点

目标：`server/**` 除 `app.js`、`standalone.js`、`host-context.js`、`workspace.js`、`llm/`、新增路由外，
**其余文件只允许改 import 路径与目录常量，不改逻辑**。

### 3.1 形状必须与测试替身一致

`test/helpers/fake-context.mjs` 已经是这个形状（测试复用它），实现必须对齐：

```js
ctx.get(name)          // 'workingDirectory' | 'llm' | 'agentDefaultModel' | 其余 undefined
ctx.effect(fn, label)  // fn() 返回 disposer；装配期立即执行，disposer 进 DisposableRegistry
ctx.webServer          // { register({kind,path,handler}) -> disposer, getOrigin() }
ctx.subprocess         // { spawn(opts), resolveExecutable(name) }
ctx.tools              // { register(tool) -> disposer }
```

### 3.2 `ctx.subprocess` 语义（必须读完三个调用方后实现）

调用方：`server/kaggle.js:88-100`、`server/net.js:129-131`、`server/routes/files.js:23-26`。需要支持：

- `resolveExecutable(name)` → `Promise<string>`（Windows 走 `where`，其它走 `which`；找不到 reject）；
- `spawn({ command | exe, args, cwd, env, stdin?, timeoutMs, maxBytes })` → 句柄：
  - 句柄至少暴露 `stdout`、`stderr`、`exitCode`、`wait()`（Promise<{code,signal}>）、`kill()`；
  - `maxBytes` 截断输出（保留首部 + 明确标记截断），`timeoutMs` 到期先 `SIGTERM`，超时宽限后强杀
    （Windows 用 `taskkill /pid <pid> /T /F`）；
  - 与源实现语义逐条对齐（先读 `docs/` 里相关说明与三个调用方，再落笔）。

### 3.3 `ctx.get` 的实现

- `workingDirectory` → `{ defaultDirectory: workspaceManager.current() }`（每次调用都取最新值，
  切换工作区后无需重建 ctx）；
- `llm` → `server/llm/service.js` 的单例（见 §5）；
- `agentDefaultModel` → `{ currentSelection: () => llmSelection }`；
- 其它名字 → `undefined`（不要抛错）。

### 3.4 `server/app.js` 改造（原 `index.js`）

把 `apply(ctx, config)` 改成等价工厂：

```js
export function createApp({ ctx, config = {}, extra = {} }) { ... }
// 返回 { routes, tools, statePayload, probes, dispose, settings, session, queue, updateChecker, kaggleLogin, colabLogin }
```

- 内部逻辑逐行保留（SessionManager / JobQueue / 各路由装配 / 启动补清理 / dispose 顺序）。
- `config` 的静态默认值从 `server/defaults.js` 取（新增文件），全局覆盖来自 app-config（§4.2）。
- `registerRoutes(ctx, [...])` 与 `registerTools(ctx, {...})` 调用方式不变。
- 新增 `...createWorkspaceRoutes({ workspaceManager, session, queue })`、
  `...createAppSettingsRoutes({ appConfig, llm })`。

---

## 4. 数据目录约定

### 4.1 常量集中（`server/paths.js`）

```js
export const OUTPUT_DIR = 'outputs'          // 新工作区产物目录
export const LEGACY_OUTPUT_DIR = 'imagen-output'  // 兼容旧工作区
export const META_DIR = '.aigc-studio'       // 工作区元数据目录（替代原 .imagen）
```

- `outputRoot(ctx)`：`<ws>/outputs` 已存在 → 用它；否则 `<ws>/imagen-output` 已存在 → 用它；否则 `<ws>/outputs`。
  其余模块（`output.js`、`library.js`、`ui-state.js`、`settings.js`、`session/**`、`routes/**`）一律从这里取目录名，
  **删除各自文件里的 `'.imagen'` / `'imagen-output'` 字面量**。
- `server/**` 里所有 `.imagen` 字面量替换为 `.aigc-studio`（设置、收藏、会话记录、ui-state、日志）。
- `server/tools.js`/`server/jobs/**` 若有固定扩展名判断（`.png`），Phase 1 保持不动；
  只在 `HistoryItem`/`meta.json` 补 `mediaType: 'image'` 归一化字段（Plan §五.1，最小实现：写 `image`、读时缺省 `image`）。

### 4.2 应用全局目录（`%APPDATA%\aigc-studio\`，`AIGC_STUDIO_DATA_DIR` 可覆盖）

```
app-config.json      # 全局配置（0600）
credentials/         # kaggle/colab/llm 凭据（0600）
logs/                # 桌面壳与本地服务滚动日志
```

`app-config.json` 结构（`server/app-config.js` 负责读写、校验、原子落盘）：

```jsonc
{
  "schema": 1,
  "workspace": { "current": "D:\\AI-Projects\\default", "recent": ["..."] },  // 最多 12 条
  "ui": { "lang": "zh", "theme": "system" },                                  // zh|en, light|dark|system
  "llm": { "provider": "openai", "baseUrl": "", "model": "", "apiKey": "", "reasoningEffort": "" },
  "compute": { /* 透传给 createApp 的 config 覆盖项：accelerator / idleTimeoutSec /
                  provider / colabGpu / kaggleTransport / hfToken / datasetSources /
                  localModels / pipConstraints / updateCheck 等 */ }
}
```

- `apiKey` 落盘在 `credentials/llm.json`（0600），`app-config.json` 里只存非敏感字段；
  对外视图只回 `hasApiKey` 与来源，**不回原文**。
- 首次启动无 `current` 时使用 `AIGC_STUDIO_WORKSPACE`，再退到 `<userData>/workspace`（由服务创建）。

---

## 5. LLM 客户端（零外部依赖）

**决定**：Phase 1 不引入 `pi-ai`；用 `fetch` 实现多后端流式客户端（后续可选替换，接口保持稳定）。

### 5.1 目录

```
server/llm/service.js       # 对外单例：currentSelection() / stream(opts) / prepareCall(...)
server/llm/config.js        # 读取 app-config.llm + credentials，校验与默认
server/llm/providers/openai.js      # OpenAI 兼容 /chat/completions（OpenAI、DeepSeek、OpenRouter、Ollama 兼容端点）
server/llm/providers/anthropic.js   # Anthropic /v1/messages
server/llm/providers/ollama.js      # Ollama /api/chat（原生流）
server/llm/sse.js           # SSE 解析工具
```

### 5.2 与既有调用方兼容（必须）

`server/llm.js`（拷贝自 lib/llm.js，**不改**）只要求 `ctx.get('llm')` 的服务具备：

- `stream({provider, model, messages, system, maxTokens, signal, purpose, sessionId, reasoningEffort})`
  → `AsyncIterable<Chunk>`，chunk 形如 `{type:'text-delta', text}` / `{type:'reasoning-delta', text}` / `{type:'finish', reason:{kind}}`；
- `prepareCall({provider,model,maxTokens}, signal, controlsFn)` → `{ config, stream(opts) }`（可返回 null）。

`currentSelection()`：未配置时返回 `null`（`server/llm.js` 会静默降级，不抛错）。

### 5.3 提示词润色/意图解析

`server/enhance.js`、`server/intent.js` 保持原样，只把 import 路径改到 `./llm.js`（本就如此）。
未配置 LLM 时行为与 DSH 里一致：返回空串或本地兜底。

---

## 6. Electron 壳层（`electron/`）

### 6.1 进程模型

Electron 主进程 → 子进程 `node server/standalone.js`（用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`），
端口与 Token 由主进程生成，经 env 传入；主进程解析 stdout 的 `ready` 行后创建窗口。

- 子进程退出/崩溃：主进程记录日志并在窗口内提示，最多自动重启 3 次（间隔递增）；
- 主进程 `before-quit`：先向子进程发 `SIGTERM`（Windows 用 `taskkill /T`），最多等 10 秒；
  然后在云端会话仍活跃时按 §6.3 处理。

### 6.2 窗口与安全

- `BrowserWindow`：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、
  `webSecurity: true`；`preload: electron/preload.cjs`。
- 开发态加载 `process.env.VITE_DEV_SERVER_URL`（默认 `http://127.0.0.1:5173`）；
  生产态加载 `http://127.0.0.1:<port>/`。
- 单实例锁：第二个实例聚焦已有窗口。

### 6.3 托盘与防烧额度（Plan §三.3）

- 窗口 `close`：若服务报告云端会话处于 `ready/provisioning/running`（GET `/api/state`），
  则 `event.preventDefault()` → 隐藏窗口 + 托盘通知；否则真正退出。
- 托盘菜单：显示主窗口 / 当前算力状态（只读文案）/ 彻底退出。
- 「彻底退出」：阻塞最多 10 秒等待服务持久化并尽力关机，然后结束。

### 6.4 preload 暴露（`window.aigcStudio`）

```ts
{
  platform: NodeJS.Platform,
  isElectron: true,
  bootstrap: { apiBaseUrl: string, authToken: string },   // 由主进程传入，替代 HTML 注入
  pickDirectory(): Promise<string|null>,                  // dialog.showOpenDialog
  showItemInFolder(path: string): void,
  openExternal(url: string): void,
  notify(title: string, body: string): void,
  setBadge(text: string): void,
  quitApp(): void,
  minimizeToTray(): void,
  onServerEvent(cb): () => void,                          // 服务重启/退出通知
}
```

`web/runtime.js` 负责：存在 `window.aigcStudio.bootstrap` 时优先使用它，否则回退到
`window.__AIGC_STUDIO__`（服务注入）或开发态空值（Vite 代理注入 Token）。

### 6.5 打包

- `electron-builder.yml`：`appId: com.nanxfu.aigcstudio`、`productName: AIGC Studio`、
  `asar: false`（Phase 1 简化：server 子进程与 worker/ 需要真实路径）、
  `files` 白名单（`electron/**`、`server/**`、`shared/**`、`models/**`、`worker/**`、`dist/web/**`、`package.json`）。
- 图标：Phase 1 允许沿用 Electron 默认图标，在 `docs/MIGRATION_NOTES.md` 标注待补 `build/icon.*`。

---

## 7. Web 迁移（`web/`）

### 7.1 入口与运行时

- 删除 `web/index.js`（DSH slots/locale 入口）、`web/theme.js`、`web/components/StatusChip.js`；
  清理所有对它们的引用（`StudioIcon.jsx` 若仅用于 DSH 侧栏可保留不动，不再挂载）。
- 新增 `web/main.jsx`：`createRoot(document.getElementById('root')).render(<Studio {...bootProps} />)`，
  在挂载前完成主题/语言初始化（读 `runtime.js` 的 bootstrap + `/api/app-settings`）。
- `web/runtime.js`：保留原有 `React`/`h` 导出；新增 `desktop()`（返回 `window.aigcStudio` 或空实现）
  与 `bootstrap()`（合并 §6.4 与 HTML 注入）。
- `web/api.js`：`request()` 增加 `Authorization: Bearer <token>`（有 token 时）；
  `apiUrl()` 基于 `bootstrap().apiBaseUrl || document.baseURI`。
- `web/i18n.js`：去掉对 `document.documentElement.lang` 的隐式依赖，改为
  `translator(props)` 优先 props.t，否则用运行时语言（来自 bootstrap / app-settings），
  并提供 `setLanguage(lang)` 供设置抽屉调用。

### 7.2 测试入口

- `web/test-entry.js`：删掉 `theme`、`StatusChip` 出口，其余聚合出口保持不变（测试依赖这些名字）。
- `tools/build-web-test-bundle.mjs`：由 `build.mjs` 改写 —— 入口 `web/test-entry.js`，
  产物 `test/.build/web.test.js`，CSS 用 esbuild `text` loader，platform 共享模块只保留 `react`/`react/jsx-runtime`。

### 7.3 工作台新增 UI（最小可用，不重做视觉）

- `TopBar.jsx`：显示当前工作区（末尾两段路径，title 全路径），点击弹出切换菜单/按钮；
  切换调用 `runtime.desktop().pickDirectory()`（Electron）或 `prompt()`（浏览器），
  再 POST `/api/workspace`，成功后刷新状态。
- `SettingsDrawer.jsx`：新增「创作助手模型」区块：provider 下拉（openai/anthropic/ollama/custom）、
  Base URL、Model、API Key（密码输入 + 已配置提示 + 清除按钮）、保存按钮；
  数据走 `/api/app-settings`。再加「界面」区块：语言（zh/en）、主题（light/dark/system）。
- 以上新文案同时在 `web/dict/zh.js`、`web/dict/en.js` 补齐，键名统一 `settings.llm.*` / `topbar.workspace.*`。

---

## 8. Python 执行端（`worker/`）

- 包名 `remote` → `worker`：所有 `from remote.` / `import remote.` 改为 `worker`；
  文档字符串里的 `remote/` 路径说明改成 `worker/`（注释可保留原意）。
- 连带修改（**跨文件，按此表执行，不要漏**）：
  - `server/bundle.js`：`REMOTE_DIR → WORKER_DIR = join(PLUGIN_ROOT,'worker')`，归档前缀 `'worker'`；
  - `server/kernel.js`：`entryModule` 默认值 `'remote.daemon' → 'worker.daemon'`，模板路径改 `worker/_entry.py`；
  - `tools/gen-contract-json.mjs`：`remote/contract.json → worker/contract.json`；
  - `tools/verify-model.mjs`：若有 `remote/` 路径改 `worker/`；
  - `test/worker/**`（原 `test/remote/**`）：`run.py`、`mock-daemon.py` 的 import 与路径；
  - `worker/_entry.py` 模板若含 `remote` 字样一并改。
- `models/*.json` 不动；`shared/models.generated.js` 由 `tools/build-assets.mjs` 生成，不动格式。
- 验证：`python test/worker/run.py` 全绿；`node tools/gen-contract-json.mjs --check`；`node tools/build-assets.mjs --check`。

---

## 9. 测试迁移（`test/`）

### 9.1 机械替换（脚本化，逐文件核对）

| 旧 | 新 |
| :--- | :--- |
| `../lib/` / `lib/` 导入 | `../server/` / `server/` |
| `../src/` / `src/` 导入 | `../web/` / `web/` |
| `'/imagen-api/` 字面量 | `'/api/` |
| `imagen-api/`（客户端相对路径） | `api/` |
| `dsh-our-imagen` | `aigc-studio` |
| `.imagen/`（测试夹具） | `.aigc-studio/` |
| `imagen-output`（夹具） | **保留**（输出目录自动探测，旧夹具继续有效） |
| `../build.mjs` 导入 `bundle/TEST_ARTIFACT` | `../tools/build-web-test-bundle.mjs` |

### 9.2 必须删除或改写的测试

- 依赖 DSH slots/locale/theme/StatusChip 的条目（`check-client-shell.mjs` 里相关断言改为断言
  `main.jsx` 契约或直接移除该断言）；
- `host-e2e.mjs` 等挂在 `createFakeContext` 上的仍保留（fake-context 形状不变）；
- 新增：
  - `test/standalone-server.mjs`：真进程拉起 `server/standalone.js`（临时 DATA_DIR/workspace），
    断言 ready 行、401（无 Token）、200（带 Token）、`/api/workspace` 切换、index.html 注入 Token、静态资源 200；
  - `test/llm-client.mjs`：本地 mock HTTP 服务模拟 OpenAI/Anthropic SSE，断言 `server/llm/service.js`
    的流式分片与 `server/llm.js` 的收集结果。

### 9.3 分组与运行

`test/run-all.mjs` 分组：`contract`（契约+资产）、`client`（web 纯逻辑/渲染）、`host`（server 端到端）、
`worker`（python，用 `python test/worker/run.py`）。默认 `npm test` 跑 contract+client+host；
可传 `--group`。**允许的失败**：需要真实 Kaggle/Colab 凭据的 live 用例（`kaggle-live.mjs`/`gpu-live.mjs`，
不在 `run-all.mjs` 默认分组内）。

---

## 10. 分工与写入范围（避免互相覆盖）

| 成员 | 写入范围（不可越界） | 主要交付 |
| :--- | :--- | :--- |
| **lead** | 根目录配置（`package.json`/`vite.config.js`/`.gitignore`/`.env.example`）、`docs/**`、`README.md` | 脚手架、契约、集成与最终验收 |
| **server-core** | `server/**`、`shared/**` | host-context、http-server、standalone、app.js、workspace、app-config、llm/、新增路由、目录常量、`shared/contract.js` |
| **web-frontend** | `web/**`、`web/index.html` | Vite 入口、runtime/api/i18n、删除 DSH 入口、TopBar 工作区、设置抽屉 LLM/语言/主题 |
| **electron-shell** | `electron/**`、`electron-builder.yml`、`tools/dev.mjs` | 主进程、preload、托盘、server-host、原生桥、打包配置、开发启动器 |
| **worker-tools** | `worker/**`、`models/**`、`tools/**`（除 `build-web-test-bundle.mjs`、`dev.mjs`）、`test/worker/**` | Python 包改名、contract 生成、资产校验、pytest |
| **test-migration** | `test/**`（除 `test/worker/**`）、`tools/build-web-test-bundle.mjs` | 全量测试迁移、run-all、新增 standalone/llm 测试、跑绿离线组 |

规则：
- 跨范围修改先给 Lead 发消息，由对应 owner 改；**不要直接改别人的文件**。
- `shared/contract.js` 只有 server-core 改；web 需要的路由名已在本规范 §2.4 固定，按此编码。
- 完成后各自跑 §11 的验证命令，把结果（通过/失败项）回报 Lead。

---

## 11. 各成员验证命令

```powershell
# 通用语法检查（对所有改动过的 .js/.mjs 执行）
node --check <file>

# server-core
node server/standalone.js        # 应打印 ready JSON，Ctrl+C 正常退出
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/api/state
node --test  # 不用；用 test 组

# web-frontend
npx vite build                   # 必须成功
npx vite                         # 浏览器打开 http://127.0.0.1:5173 能渲染工作台（server 先跑在 5130）

# electron-shell
node -e "import('./electron/server-host.mjs')"   # 语法/加载检查
npm run dev                      # 有 Electron 二进制时验证窗口

# worker-tools
node tools/build-assets.mjs --check
node tools/gen-contract-json.mjs --check
python test/worker/run.py

# test-migration
node tools/build-web-test-bundle.mjs --test
node test/run-all.mjs --group contract
node test/run-all.mjs --group client
node test/run-all.mjs --group host
```

## 12. 验收标准（Phase 1 完成的定义）

1. `npm install && npx vite build` 成功；
2. `node server/standalone.js` 启动后：无 Token 401、带 Token 200、`/api/state` 返回完整状态；
3. 浏览器开发态可完成：选择工作区 → 配置 LLM → 提示词润色（有 Key 时）/本地兜底（无 Key 时）；
4. `npm run dev` 能拉起 Electron 窗口并加载工作台（有 Electron 二进制时；无则记录阻塞项）；
5. `npm test` 的 contract + client + host 组通过（live 用例除外），`python test/worker/run.py` 通过；
6. `docs/MIGRATION_NOTES.md` 记录：架构决策偏差（pi-ai → 自研 fetch 客户端等）、未完成项、下一步。
