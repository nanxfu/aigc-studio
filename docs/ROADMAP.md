# AIGC Studio 独立客户端演进路线图与待办清单（ROADMAP）

> **上位架构**：[`AIGC_STUDIO_STANDALONE_PLAN.md`](AIGC_STUDIO_STANDALONE_PLAN.md)
> **迁移记录**：[`MIGRATION_NOTES.md`](MIGRATION_NOTES.md)
> **历史插件路线图**：已归档至 [`archive/LEGACY_PLUGIN_ROADMAP.md`](archive/LEGACY_PLUGIN_ROADMAP.md)
> **当前基线**：Phase 1（`eeb43fd`）+ 修复轮（`4ba6dc7`）+ **M1.5 底座升级与桌面端交互打磨**已落地；下一步进入 **M2 真机出图回归与安装包交付**。

---

## 里程碑总览

| 阶段 | 主题 | 核心目标 | 状态 |
| :--- | :--- | :--- | :--- |
| **M1** | 独立客户端基线与链路修复 | 剥离 DSH 宿主；Electron + Vite + 本地服务 + Cookie/Bearer 双级鉴权 + HTTP Range + 多工作区 | ✅ 已完成 |
| **M1.5** | **`pi` 底座升级 & 桌面端交互打磨** | **接入 `pi-ai` / `pi-agent-core`；打通创作助手 Agent 闭环；重构顶栏入口、工作区精细切换、安全加固与原生桌面能力** | ✅ 已完成 |
| **M2** | 真机出图回归 & 安装包交付 | 真实 Kaggle/Colab 全链路真机出图 + `icon.icns`（macOS）+ NSIS 安装包干净机器验证 | ⏳ 待开始 |
| **M3** | 私有 GPU Worker + 协议流式升级 + MCP | 长驻 Linux/Docker Worker、二进制流回传、SSE 任务进度、标准 MCP Server、本机 GPU | ⏳ Phase 2 |
| **M4** | AI 视频生成与 3D 资产闭环 | 视频/3D 模型资产、MP4 舞台播放器、Three.js `.glb` 预览与统一版本树 | ⏳ Phase 3 |

---

## M1.5：`pi` 底座接入与桌面端产品级打磨（已完成）

> 解决 Phase 1 “只求迁移跑通、界面与 Agent 未收口”的遗留债，把桌面端交互与 AI 底座做扎实。

### 1. 接入 `pi` 底座并打通创作助手闭环
- [x] **替换自研 LLM 层为 `pi-ai`**：
  - 引入 `@earendil-works/pi-ai` 替代手写 `server/llm/providers/*` 与 SSE 解析器；
  - 保留 `createLlmService` 对外契约（`getSelection / stream / prepareCall / complete / describe` + `agentTarget / piStreamFn`），使 `/api/enhance`、`/api/intent` 无缝切换；
  - OpenAI 兼容 / Anthropic / 自定义端点直连 `pi-ai`；Ollama 默认对接 `/v1` OpenAI 兼容端点；
  - 保留基于本地 mock HTTP 服务的离线回归测试（`test/llm-client.mjs`）。
- [x] **替换自研 Agent 循环为 `pi-agent-core`**：
  - 引入 `@earendil-works/pi-agent-core`，沿用 `server/tools.js` 既有 JSON Schema 工具注册表重构 `server/agent/runtime.js` 与 `message-adapter.js`；
  - 废除“把工具调用折叠成连续 `user` 文本”的临时写法，使用原生 `tool_use` / `tool_result` 多轮协议、`convertToLlm` 与 `AbortSignal` 中断控制（`test/agent-runtime.mjs`）。
- [x] **打通前端 `ChatPanel` ↔ `/api/agent/chat`**：
  - 创作助手支持流式输出文本、停止中断、Agent/快卡模式切换与工具调用状态胶囊（`imagen_recipes` / `imagen_history` / `imagen_batch` / `imagen_upscale` 等）；
  - 未配置 LLM Key 时静默降级为原有本地意图卡片，不阻塞基础出图。

### 2. 桌面端交互与产品体验打磨
- [x] **顶栏信息架构与品牌收口**：
  - [x] 左上角品牌名从「生图工作台 STUDIO」统一为 **`AIGC Studio`**（中英文词典同步）；
  - [x] 将「设置」齿轮按钮（`.ofs-topbar-settings`）提至顶栏右侧常驻入口，不再隐藏在「云端未启动 ∨」下拉弹层底部；
  - [x] 结合顶栏常驻设置入口、画布 `GuidanceCard` 与助手静默降级，保障未配置 Key/云端凭据时无阻塞引导。
- [x] **精细化工作区热切换（`rebaseWorkspace`）**：
  - [x] 切换工作区时**保留未提交的纯文本提示词、模型预设与画幅设置**，仅清理绑定旧工作区路径的 `origin`、`references` 和草稿表；
  - [x] 聊天记录过滤绑定旧工作区的 `form` / `tool` / `job` 卡与结果图，保留纯文字对话与意图卡，避免“切个目录把刚写的灵感全抹掉”。
- [x] **接通已封装的 Electron 原生能力**（`window.aigcStudio`）：
  - [x] **单图文件夹定位**：舞台工具条（`Stage.jsx`）增加「在文件夹中显示」，调用 `desktop().showItemInFolder(image.absolute)` 高亮对应产物；
  - [x] **后台出图桌面通知**：窗口隐藏/非前台时出图完成或失败，调用 `desktop().notify(...)` 提醒用户；
  - [x] **任务栏角标**：队列排队/运行中调用 `desktop().setBadge(...)`，清零后自动移除。
- [x] **安全与桌面资源收尾**：
  - [x] 应用图标 & 托盘图标替换（已生成 `build/icon.png` 256×256 与多尺寸 `build/icon.ico` 并接入打包与托盘；macOS `build/icon.icns` 留待 M2 macOS 打包补齐）；
  - [x] LLM API Key 优先通过 Electron `safeStorage` + AES-256-GCM 加密存储（支持环境变量主密钥与旧明文自动迁移，兜底 `0600` 保护）；
  - [x] 为本地 HTTP 服务补充 `Content-Security-Policy` 响应头；
  - [x] 构建层通过 Vite `manualChunks` 拆分 `vendor` chunk（11.99 kB）；面板级 `React.lazy` 拆分因客户端测试以 `react-test-renderer` 同步挂载暂留待后续引入异步挂载再做。

---

## M2：真机出图回归 & 安装包交付

- [ ] **真实 Kaggle / Colab 真机全链路验收**：
  - [ ] 凭据登录 → 云端唤醒 → 文生图 / 局部重绘 / 扩图 / 多图参考 → 切换工作区；
  - [ ] 验证「会话活跃时点 × 转托盘通知保活」与托盘「彻底退出」远端关机及 `session.json` 清理。
- [ ] **正式安装包构建与干净环境验证**：
  - [ ] 执行 `npm run dist` 产出 Windows NSIS 安装包与便携版；
  - [ ] 干净路径安装启动并复核 `test/smoke-image.mjs`。

---

## M3：私有 GPU Worker + 协议流式升级 + MCP（Phase 2）

- [ ] **私有远程 Worker（`private-worker` + `worker/worker_server.py`）**：
  - [ ] 支持 Docker / SSH 隧道 / 局域网直连自有 Linux GPU 节点（无 `ntfy`/`cloudflared` 依赖）；
  - [ ] 推理产物改用 **HTTP 二进制流 / multipart** 回传，摆脱 base64 JSON 内存上限；
  - [ ] 新增 `GET /api/events` SSE 推送模型加载、推理步数与下载进度。
- [ ] **标准 `mcp/server.mjs`**：
  - [ ] 复用 M1.5 的 TypeBox 工具注册表，通过已鉴权的本地 `/api/*` 向 DSH / Cursor / Claude Desktop 暴露工作室能力（支持 `stdio` 与本地 HTTP/SSE）。
- [ ] **本机 GPU 运行时（`local-gpu`）**：
  - [ ] `nvidia-smi` 显存/架构探测 + `uv` 隔离 Python 运行环境管理。

---

## M4：AI 视频生成与 3D 资产闭环（Phase 3）

- [ ] **模型资产与推理扩展**：`models/*.json` 扩充 `mediaType: 'video' | 'mesh3d'`，补充视频与 3D 生成 Loader。
- [ ] **多模态舞台分发（`Stage.jsx`）**：
  - [ ] `VideoStage.jsx`：MP4 播放器（复用已有 HTTP Range 206 流）、首尾帧抽取与片段拼接；
  - [ ] `Mesh3DViewer.jsx`：基于 Three.js 的 `.glb` 实时 3D 预览器（旋转/线框/灯光）；
  - [ ] **统一版本树**：支持「文生图底图 → 一键图生视频 / 图生 3D」，派生作品挂在同一棵 `rootImage` 谱系下追溯与导出。
