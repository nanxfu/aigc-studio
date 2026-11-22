# AIGC Studio 独立客户端演进路线图与待办清单（ROADMAP）

> **上位架构**：[`AIGC_STUDIO_STANDALONE_PLAN.md`](AIGC_STUDIO_STANDALONE_PLAN.md)
> **专项规划**：[`LLM_CAPABILITY_AND_AGUI_PLAN.md`](LLM_CAPABILITY_AND_AGUI_PLAN.md)（生图 Agent / AGUI / Provider 接入规划）、[`AUTO_UPDATE_PLAN.md`](AUTO_UPDATE_PLAN.md)（发布流水线与自动更新架构）
> **迁移记录**：[`MIGRATION_NOTES.md`](MIGRATION_NOTES.md)
> **历史插件路线图**：已归档至 [`archive/LEGACY_PLUGIN_ROADMAP.md`](archive/LEGACY_PLUGIN_ROADMAP.md)
> **当前基线**：Phase 1（`eeb43fd`）+ 修复轮（`4ba6dc7`）+ M1.5（`1d4a1db`）+ **M2 安装包交付与真机验收（进行中）** + **M2.6 导入图焦点隔离（已完成）** + **M2.7 助手显式参考图与多后端调度（已完成）** + **M2.8 发布通道与应用内更新（A/B 代码已落地，真实升级演练待版本收口）** + **M3.0 协议与 Provider 底座（已完成，2026-11-22）** + **M3.1-a Worker 服务 / M3.1-b Host 接入与设置 UI（已完成，2026-11-22）**。
>
> **规划迭代（2026-11-22）**：M2.8 拆为「发布通道 → 应用内更新」两段（[`M2_8_RELEASE_AND_UPDATER_SPEC.md`](M2_8_RELEASE_AND_UPDATER_SPEC.md)）；M3 拆为 4 个可独立验收的子阶段（[`M3_PRIVATE_WORKER_AND_MCP_PLAN.md`](M3_PRIVATE_WORKER_AND_MCP_PLAN.md)）。

---

## 里程碑总览

| 阶段 | 主题 | 核心目标 | 状态 |
| :--- | :--- | :--- | :--- |
| **M1** | 独立客户端基线与链路修复 | 剥离 DSH 宿主；Electron + Vite + 本地服务 + Cookie/Bearer 双级鉴权 + HTTP Range + 多工作区 | ✅ 已完成 |
| **M1.5** | **`pi` 底座升级 & 桌面端交互打磨** | **接入 `pi-ai` / `pi-agent-core`；打通创作助手 Agent 闭环；重构顶栏入口、工作区精细切换、安全加固与原生桌面能力** | ✅ 已完成 |
| **M2** | 真机出图回归 & 安装包交付 | 真实 Kaggle/Colab 全链路真机出图 + NSIS/便携版安装包 + 干净环境安装验证 | ✅ 自动化部分完成；剩余人工托盘/页面联调 |
| **M2.5** | **LLM 能力扩容 & 助手单轨化（AGUI）** | **11 家 Provider 接入 + 模糊搜索 + 模型自动获取；废除快卡/Agent 双轨；提案卡 / 澄清卡 / 作业卡成为标准交互** | ✅ 已完成 |
| **M2.6** | **导入图焦点隔离与左栏锁定** | **移除 `is-unlinked` 临时分流条；裸导入图及其无参数放大产物锁定左栏表单/助手，仅保留舞台加工、「设为参考图」自动切新画布与「新建创作」出口（[`SPEC.md §5.23`](SPEC.md#523-第十九批交互补充无参数导入图焦点隔离与左栏锁定已完成)）** | ✅ 已完成 |
| **M2.7** | **助手显式参考图与多后端智能调度** | **助手输入区外露共用参考图槽；补全模型参考能力与多后端凭据/热机实时上下文（非僵化 Prompt）；支持提案卡跨模型与跨后端「切换并生成」一步到位（[`SPEC.md §5.24`](SPEC.md#524-第二十批交互补充助手显式参考图多后端上下文与一步到位调度已完成)）** | ✅ 已完成 |
| **M2.8** | **发布通道与应用内更新** | **阶段 A：打 Tag → GitHub Actions → Release 资产（`latest.yml` / `sha512` / `.blockmap`）；阶段 B：`electron-updater` NSIS 差分更新、无签名构建的完整性校验、防烧额度安装护栏、弱网/镜像源（[`M2_8_RELEASE_AND_UPDATER_SPEC.md`](M2_8_RELEASE_AND_UPDATER_SPEC.md)）** | 🚧 A/B 代码已落地；真实 Tag 升级演练待版本收口 |
| **M3.0** | **协议与 Provider 底座** | **产品版本 / 协议版本分离；Provider 注册表；会话记录 v1/v2 兼容；不动 Kaggle/Colab 行为** | ✅ 已完成 |
| **M3.1** | **私有 GPU Worker** | **长驻 `worker_server` + Docker/systemd；`private-worker` provider；原生 binary 产物 + SSE；Token 加密与连接探测** | 🚧 M3.1-a/b 已完成（Worker 服务 / 协议 v2 端点 / 部署 / Host 连接与设置 UI）；M3.1-c 真机验收待实施 |
| **M3.2** | **云端协议 v2** | **Kaggle/Colab daemon 跟进 binary/SSE；扩散步数进度；断流续传；旧 Host 兼容回退** | 📋 待实施 |
| **M3.3** | **MCP Server** | **stdio + `runtime.json` 发现；7 个工具映射本地 `/api/*`；打包与外部客户端验收** | 📋 待实施 |
| **M3.4** | **本机 GPU（可选）** | **`nvidia-smi` 探测 + `uv` 隔离环境 + 进程托管；不阻塞 M3 完成** | ⏳ 可选 |
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

## M2：真机出图回归 & 安装包交付（进行中）

> 可重复执行的验收步骤与判定标准见 [`LIVE_ACCEPTANCE.md`](LIVE_ACCEPTANCE.md)；
> 本轮（2026-11-21）实测记录见该文档 §8。

### 1. 真实 Kaggle / Colab 真机全链路验收
- [x] **凭据与配额探测**：`npm run kaggle:probe` 直连鉴权正常（账号 mogudd），GPU 配额 30h 未使用；
- [x] **调度链路真机**：`node test/kaggle-live.mjs` 走通
      push → 排队 → cloudflared 隧道 → 握手 → `/health` → `/generate` → 关机（CPU 探针 Kernel，不占 GPU 配额）；
- [x] **文生图真机**：`node test/gpu-live.mjs` 在 Kaggle 2×Tesla T4 上跑通
      （`sdxl-lightning` 冷启动 88.6s，1024² / 4 步出图 9.69s，关机 `absent`；报告落 `bench-results/`）；
- [x] **图片工具与参考生图真机**（2026-11-21 全部 exit 0，2×Tesla T4，详见 `LIVE_ACCEPTANCE.md` §8）：
  - [x] 局部重绘：`--inpaint`（`from_pipe` 零加载、重绘 9.02s、未涂抹区逐像素保留）；
  - [x] 高清放大：`--upscale`（1024²→2048²，推理 1.39s，`outputMatchesSource=true`）；
  - [x] 扩图：`--outpaint-lora`（`flux2-klein-4b` + 扩图 LoRA，1536×864，绿边残留 0，推理 20.7s，对 sdxl-inpaint 基线提速 1.71×）；
  - [x] 多图参考：`--reference`（1/2 张参考图、1280×720 画幅保持，确定性 MAE 0，显存零增长）；
- [ ] **页面级联调**：安装版内点「唤醒」→ 生成 → 切换工作区（真实会话 + 人工）；
- [ ] **托盘交互人工清单**：会话活跃时关窗转托盘保活、托盘「彻底退出」远端关机与 `session.json` 清理、
      后台通知、任务栏角标、文件夹定位（清单见 `LIVE_ACCEPTANCE.md` §7）。

### 2. 正式安装包构建与干净环境验证
- [x] `npm run dist` 产出 Windows NSIS 安装包与便携版（`release/aigc-studio-0.14.0-x64.exe` / `-portable.exe`）；
- [x] 图标资产补齐：`tools/build-icons.py` 生成 1024 PNG + 16~256 ICO + 16~1024 ICNS（含 macOS `icon.icns`）；
- [x] win-unpacked 形态「带真实图片」冒烟：`npm run test:packaged` **10/10**；
- [x] 静默安装 → 冒烟 → 静默卸载全链路：`npm run test:installer` **9/9**（安装目录、版本资源、卸载清理均通过）；
- [x] 便携版冒烟：`npm run test:packaged -- --exe release/aigc-studio-0.14.0-portable.exe` **8/8**；
- [ ] macOS 打包（`dmg` / 公证）需在 macOS 上执行；Windows 侧已完成 `icon.icns` 与打包配置，留给 macOS 机器验证。

---

## M2.5：LLM 能力扩容与助手单轨化 / AGUI（已完成）

> 对应专项规划 [`LLM_CAPABILITY_AND_AGUI_PLAN.md`](LLM_CAPABILITY_AND_AGUI_PLAN.md)，2026-11-21 一次性落地 A→D。

### 1. Provider 接入与配置零门槛
- [x] **单源 Provider 清单** `shared/llm-providers.js`：11 家（DeepSeek / Kimi / 千问 / 硅基流动 /
      OpenCode Zen / OpenRouter / Gemini / OpenAI / Anthropic / Ollama / 自定义），含分组、默认端点、
      是否需要 Key、推荐模型与中英文搜索别名；`/api/app-settings` 直接下发，前端不再硬编码白名单。
- [x] **4 条原生协议**：`openai-completions`、`openai-responses`、`anthropic-messages`、
      `google-generative-ai` 统一由 `piStreamFn` 分发；OpenCode 按模型读取内置目录的 `api` / `baseUrl`
      并补 `x-opencode-session` 会话头。
- [x] **`POST /api/llm/models`**：Host 代理厂商 `/models`（OpenAI 兼容 / Anthropic / Gemini / Ollama），
      失败或未填 Key 时降级 `pi-ai` 内置目录；噪音过滤、去重、能力标签补全与 400 条上限。
- [x] **设置抽屉**：可搜索 Provider 下拉（分组、↑↓/Enter/Esc）、标准预设折叠 Base URL、
      模型可搜索下拉 + 「获取模型」（填 Key 失焦自动拉取），并保留自由输入。

### 2. 助手单轨化与 AGUI
- [x] **废除 `intent` / `agent` 双模式开关**：前端统一走 `POST /api/agent/chat`；
      未配置模型时由服务端本地规则返回同一张提案卡（不再 503）。
- [x] **AGUI 工具**：`ui_propose_generation`（提案卡）、`ui_ask_clarify`（澄清卡，含草稿兜底）、
      `imagen_stage_context`（舞台焦点）；工具返回 `data.ui` 由运行时翻译成 `proposal` / `clarify` 事件，
      展示后本轮立即以 `awaiting-user` 结束，不再多跑一次 LLM。
- [x] **作业联动**：工具返回 `jobIds` 时发出 `job-bound`，前端追加真实任务气泡并沿用既有轮询进度。
- [x] **前端卡片**：提案卡复用确认卡（摘要 / 可编辑英文 Prompt / 模型胶囊 / 张数 / 种子）；
      多维度澄清卡支持单选即提交、多选累积后提交；「先按当前设置」有草稿时零请求还原提案卡；
      思考与工具步骤合并为可折叠时间线。

### 3. 提示词与舞台上下文
- [x] **三层注入**（`server/agent/prompt.js`）：角色与确认护栏 / 实时模型目录 + GPU 会话状态 + 舞台焦点 /
      领域规范（五要素、去空洞词、否定词防误译、防多轮粘连）。
- [x] 前端每次对话上报舞台选中图摘要（路径 / 模型 / 尺寸 / seed / 原 Prompt）。

### 4. 测试与兼容
- [x] `test/llm-models.mjs`（新增）：Provider 搜索、四类探测、目录兜底、路由 Key 复用；
      `test/llm-client.mjs` 扩展 Responses / Gemini / OpenCode 分发；
      `test/agent-runtime.mjs` 扩展提案 / 澄清 / 作业绑定 / 舞台上下文 / 无 Key 降级；
      客户端测试覆盖单轨状态流、步骤时间线与 Phase A 设置交互。
- [x] **`/api/intent` 保留为兼容端点**（旧客户端与 host-e2e 仍在使用），前端不再调用；
      `server/intent.js` 同时作为 Agent 无 Key 时的本地兜底解析器。

---

## M2.6：导入图焦点隔离与左栏锁定（已完成）

> 对应交互规格 [`SPEC.md §5.23`](SPEC.md#523-第十九批交互补充无参数导入图焦点隔离与左栏锁定已完成)；解决本地导入裸图后左栏输词弹出「纯文生图 + 设为参考图 / 整图重绘」补丁条带来的心智割裂。

- [x] **统一导入锁定判定（`web/logic/generate.js`）**：新增纯函数 `isImportLockedOf(entry, items)`，识别「裸导入图（`isBareImportOf`）及由其直接高清放大等仍无扩散参数的衍生版本」——沿 `sourceImage` 回溯，遇到重绘 / 涂抹 / 扩图（有提示词与扩散参数）即解锁；父链不在已加载分页或成环时保守解锁。自带 PNG `tEXt` 元数据的导入图与重绘/涂抹/扩图后的 `v2` 保持解锁回填。
- [x] **左栏表单与助手锁定（`Rail.jsx`、`ChatPanel.jsx`、`panel.css`）**：移除 `showStageLinkChip`（`.is-unlinked`）胶囊条及配套样式 / 文案；锁定态用原生 `inert` 包住表单主体、页脚与助手输入区并降饱和，**完整保留表单字段值与全局对话历史 `messages`**；顶部 / 坞内给出锁定引导与「新建创作」按钮；顶部「新建创作」、模式 Tab、作品切换、助手「停止生成」保持可用；`useStudio.generate` 再加一道兜底，锁定时不发请求。
- [x] **舞台「设为参考图」联动与顺序收口（`useStudio.js`、`Stage.jsx`）**：动作坞 4 项图片工具照常可用；锁定态点「设为参考图」时先 `library.newDraft()` + `form.detachOrigin()` 重置画布/旧绑定（目标图在重置之后入槽，不会被清掉）再 `form.addReference(target)`，解锁左栏并切回创作视图；「新建创作」后参考图槽「从作品选择」可直接选用已落盘导入图。放大产物在舞台沿用「导入」角标，并禁用没有原始提示词的「重新生成」。
- [x] **双语文案与测试更新**：`web/dict/zh.js` / `en.js` 删除 `studio.rail.pureTextMode` 等失效键、新增 `studio.lock.*` 四键严格同构（821 键）；`test/import-client.mjs` 改写原 `.is-unlinked` 断言并扩到 **22 项**（锁定表单 / 保留对话 / 新建创作解锁 / 参考图联动 / 放大保持锁定 / 重绘解锁），`check-client-logic` **97 项**新增锁定判定纯逻辑用例；`check-client-shell` / `check-client-chat` / `check-client-locale` 全部通过，`npm test` 仅 `smoke-image` 因本机已有客户端实例占用单实例锁未启动（环境项）。

---

## M2.7：助手显式参考图与多后端智能调度（已完成）

> 对应交互规格 [`SPEC.md §5.24`](SPEC.md#524-第二十批交互补充助手显式参考图多后端上下文与一步到位调度已完成)；打通助手页面参考图能力、丰富事实上下文（不写死僵化 Prompt），并支持跨后端推荐一步到位。

> 实施记录（2026-11-22）：`shared/models-guide.js` 为模型目录补齐「支持参考图 / 仅 X / 需 HF Token」标签并支持按已配置后端集合过滤；`/api/agent/chat` 接收真实 `references` 路径，Layer 2 分列舞台焦点、参考图槽、后端凭据账本（含 `hasLocalKaggleCredentials` 本地 Kaggle 凭据检查）与 HF Token 状态，Prompt 仅给决策目标（无固定话术）；助手输入区新增与表单同源的参考图条（本地选图 / 从作品 / 拖放 / 移除，锁定态随输入区 `inert`）；提案卡按钮按实时 `compute.provider` 计算，跨后端经 `POST /api/settings` → 切预设 → 提交原子流转，含在途任务拦截、gated 预检与失败中止；对话历史按工作区双层隔离持久化（`chatSnapshot.js` `sessionStorage` L1 + `GET/POST /api/chat` → `<workspace>/.aigc-studio/chat.json` L2 跨重启保留），Agent 直调产物路径回写上下文，聚焦视图打开涂抹工具后自动退出聚焦。测试：`check-client-logic` 98、`check-client-chat` 28、`chat-timeline` 10、`agent-runtime` 16、`check-contract` 14、`check-client-shell` 55 / `check-client-locale` 835 键保持通过。

- [x] **助手显式参考图（`ChatPanel.jsx`、`useStudio.js`）**：聊天输入区上方外露共用参考图条（与表单 `form.form.references` 同源，带轻角色标注防与舞台图混淆），支持 `+ 本地选图` / `从作品选择` / 拖放图片入槽与单张移除，消除表单与助手互相看不见参考图的状态割裂。
- [x] **模型能力与多后端实时上下文（`shared/models-guide.js`、`server/agent/prompt.js`、`server/routes/agent.js`）**：`modelUsageLine` 补齐 `supportsReference`、`providers` 与 `gated` 标签；`POST /api/agent/chat` 接收真实 `references` 路径列表，服务端注入各已配置后端凭据/热机/HF Token 状态、分清 `stage` 与 `references`，并跨已配置后端展示模型目录；`localProposal` 同步适配参考图；Prompt 只给事实与决策目标，不写死机械话术。
- [x] **同后端改选与跨后端「一步到位」（`ChatPanel.jsx`、`useChatThread.js`）**：提案卡按钮按实时 `compute.provider` 动态计算；同后端切模带参考图提交（清理无关旧固定种子残留）；跨后端时主按钮呈现「切换到 {后端} 并按此生成」（附热机关闭提醒 + `activeJob` 在途拦截 + `gated` Token 预检），按 `POST /api/settings` → 切预设 → 提交任务原子流转；跨后端点击「带入参数面板」做安全兜底不写入不可用预设。
- [x] **上下文连续性与持久化收口**：`agentMessagesFor` 将 Agent 直调工具生成的 `images` 路径写回 LLM 上下文；处理单图聚焦视图下触发舞台工具后的进度可见性；实现按工作区隔离的对话历史持久化与已删图片占位容错，并更新对应客户端与 Agent 离线测试。

---

## M2.8：发布通道与应用内更新（阶段 A/B 代码已落地）

> **执行规格**：[`M2_8_RELEASE_AND_UPDATER_SPEC.md`](M2_8_RELEASE_AND_UPDATER_SPEC.md)；设计取舍见 [`AUTO_UPDATE_PLAN.md`](AUTO_UPDATE_PLAN.md)。
>
> **拆成两段**：阶段 A 先把「打 Tag → CI 出包 → Release 资产」做成可复现链路；阶段 B 再接 `electron-updater`。A 不做完不进入 B。
>
> **约束前提**：不购买代码签名证书；部分用户直连 GitHub Releases 可能不通畅；暂不引入纯前端/模型热更新；Linux AppImage 与未签名 macOS 本阶段只读提示，不启用自动更新。
>
> **入口条件**：M2 剩余托盘/页面级人工验收完成；版本收口 `0.15.0`；`package.json` 补 `repository/homepage/bugs`；README/FAQ 写好 SmartScreen 与 SHA256 校验说明。
>
> **实施记录（2026-11-22）**：
> - 阶段 A 已落地配置、校验脚本与 workflow（`8f2c33c`）：`electron-builder.yml` 的 `publish` / `differentialPackage`、`tools/check-release-version.mjs`、`tools/verify-release.mjs`、`.github/workflows/release.yml`；
> - 阶段 B 本轮落地：`shared/update-state.js`（状态契约 / 安装护栏 / 错误分类）、`electron/updater/policy.mjs`（七种形态判定）、`electron/updater.mjs`（事件状态机 / 进度节流 / 源切换）、`electron/preload.cjs` 的 `updater` 桥、`main.mjs` 的 `shutdown → quitAndInstall` 顺序、`server/update-source.js`（latest.yml 解析）与只读检查器双源、`app-config.update` 独立配置段、`/api/update/check`、顶栏独立更新入口与设置「版本与更新」区；
> - 测试新增 `update-policy` 12 项、`updater-main` 10 项、`app-settings-update` 4 项、`check-client-update` 5 项，`update-check` 扩到 16 项；`test:contract` / `test:client` / `test:host` 全绿；
> - **仍未执行**：Gate 0 的真实版本收口（`0.15.0`）与「`0.15.0` → `0.15.1` 真实升级 E2E」，因此本轮不改 `package.json.version`、不打 Tag、不创建 Release。本地 UI 联调可用 `npm run update:mock` + `AIGC_STUDIO_UPDATE_DEV=1`。

### 阶段 A：发布通道
- [x] **构建与发布配置**：`electron-builder.yml` 增加 `publish`（GitHub `nanxfu/aigc-studio`、`releaseType: draft`）、`generateUpdatesFilesForAllChannels: false`（只做 stable）、`nsis.differentialPackage: true`；`package.json` 增加 `electron-updater` 与发布元信息。
- [x] **产物校验**：新增 `tools/check-release-version.mjs`（Tag = `package.json` = 契约版本）与 `tools/verify-release.mjs`（`latest.yml` 的文件名/版本/大小/`sha512`/`.blockmap` 全量比对，生成 `SHA256SUMS.txt`）。
- [x] **自动化发版**：新增 `.github/workflows/release.yml`（`v*` Tag 触发；`workflow_dispatch` 只做 dry-run；Windows runner + Node 20 + Python 3.11；`permissions: contents: write`），构建 NSIS + Portable 并发布 Draft Release；上传后用 `gh release download` 回拉资产跑校验，失败删除 Draft。
- [ ] **首次发布演练**：`0.15.0` 手动安装验收 → 发布 `0.15.1` → 用已安装的 `0.15.0` 做第一次真实升级（`0.14.0` 没有更新器，只能手动装 `0.15.0`）。

### 阶段 B：应用内更新
- [x] **运行形态与状态契约**：`electron/updater/policy.mjs`（NSIS / portable / unpacked / dev / mac-unsigned / linux-appimage 判定）+ `shared/update-state.js`（`UpdateState`、进度、错误码、`canInstallNow`）；NSIS 安装态由主进程独占，服务端只读检查器禁用，避免双源。
- [x] **主进程更新器**：`electron/updater.mjs`（`autoDownload=false`、`autoInstallOnAppQuit=false`、`allowPrerelease=false`）、`preload.cjs` 暴露 `updater` 命名空间、`main.mjs` 安装护栏。
- [x] **防烧额度安装顺序**：安装前强制刷新 `/api/state` → 活跃会话/排队/出图任务时禁止「立即安装」，只给「退出时安装」或「先断开算力」→ `shutdown()`（`ServerHost.stop()` 完整走完）→ `quitAndInstall()`。
- [x] **弱网/镜像**：`updateSource`（github/custom）+ `updateMirrorUrl`（仅 `https://`，禁 userinfo/query/fragment）；只读检查器解析自定义 `latest.yml`；错误分类 `offline/dns/timeout/http_*/checksum/signature/feed_invalid/disk_full/...`；不静默吞错。
- [x] **UI 与测试**：顶栏独立更新入口 + 设置抽屉「版本与更新」区；`useUpdate` 优先订阅桥接、回退轮询；补齐形态判定/安装护栏/双源解析/客户端状态流单测。
- [ ] **真实 Tag 升级 E2E**：等待 Gate 0（`0.15.0` 收口 + `0.15.1` 正式 Release）后执行；本地可用 `tools/mock-update-feed.mjs` 做 UI 联调。

---

## M3：私有 Worker、协议 v2 与 MCP（M3.0 / M3.1-a / M3.1-b 已完成，M3.1-c~M3.4 待实施）

> **专项规划**：[`M3_PRIVATE_WORKER_AND_MCP_PLAN.md`](M3_PRIVATE_WORKER_AND_MCP_PLAN.md)。
>
> **命名说明**：这里的 M3 指私有 Worker / 协议 v2 / MCP 阶段；历史文档中 0.12.0 的「M3 图生图」是旧编号，勿混淆。
>
> **四个决策**：① 拆成 M3.0~M3.3 四个可独立验收的子阶段；② 产品版本与协议版本分离；③ 私有 Worker 先作为协议 v2 参考实现，云端 daemon 再跟进；④ MCP 只做协议适配，通过本地 `/api/*` 调用，不复制队列/会话状态。本机 GPU 作为可选尾项，不阻塞 M3 完成。

### M3.0：协议与 Provider 底座（已完成）

> 实施记录（2026-11-22）：协议版本切到 `2.0.0`（产品版本仍 `0.15.0`，两者独立校验）；新增 `server/providers/index.js` 注册表与 `PROVIDERS` 能力位；会话记录支持 v1/v2；私有 Worker 的启动/断开/恢复/掉线路径由 `server/providers/fake-worker.js` + `test/session-worker.mjs` 离线回归覆盖（含地址 HTTPS 强制与协议握手）。Kaggle/Colab 全部既有套件零行为变化。

- [x] **版本分离**：`shared/contract.js` 新增 `APP_VERSION`（= `package.json`）与 `PROTOCOL_VERSION`（`2.0.0`），`VERSION` 保留为产品版本别名；`daemonContract().version` 与注入配置的 `version` 改为协议版本；`worker/daemon.py`、`worker/contract.json`、`test/mock-daemon.py`、`test/tunnel-probe.py` 同步；`check-contract` 拆成「产品版本」与「协议版本」两项校验，错误信息分别指出是哪一边不一致；`/api/state` 新增只读 `protocol`。
- [x] **Provider 注册表**：新增 `server/providers/index.js`（`createProvider / providerMetaOf / isWorkerProvider / instanceLostMessage`），能力位（`kind`、`reattach`、`pendingCleanup`、`remoteShutdown`、`idleTimeout`、`logs`、`binary`、`events`、`owned`）单源在契约 `PROVIDERS`；`server/session.js` 的 `providerFor / applyProviderSettings / provision` 不再写死 `kaggle/colab`，worker 型跳过 Kernel 目录、ntfy 会合、空闲关机与 dataset 挂载，掉线按固定地址重试而不是「回会合点」；地址安全策略（非回环强制 HTTPS、拒绝 URL 凭据/query）落在 `server/providers/worker-url.js`。
- [x] **会话记录 v1/v2**：Notebook 仍写 v1（旧客户端可读）；Worker 写 v2（`provider/endpointUrl/token/handle{workerId,protocolVersion}`，无 `kernelId/topic`）；读取同时接受 v1/v2，v2 未知来源整条判无效并清理，绝不猜成 Kaggle；恢复时按记录来源切换 provider，worker 不可达给出 `worker_unreachable` 并保留记录。
- [x] **设置与模型能力域**：`PROVIDERS` 登记 4 个来源，`SETTINGS.providers` 只取 `enabled` 的项（M3.0 时仍 `kaggle/colab`；M3.1-b 已加入 `private-worker`）；`models-guide` 的判定域改为全部已知来源，来源展示名与「仅 X」角标按 provider 名生成；设置合并/脱敏视图接受全部已知来源，保存补丁仍限制在当前可选集合。
- [x] **Agent 文案与错误码**：`server/tools.js` 的「Kaggle GPU / 拉起 Kernel」改为「当前算力来源 / 拉起会话」，会话摘要按 provider 类型输出 Kernel 或连接状态；`backendSummaries` 按当前可选来源生成；新增 `worker_unreachable / worker_unauthorized / protocol_mismatch / capability_missing / artifact_failed` 五个 Host 错误码与中英文案。
- [x] **验收**：`npm run test:contract`（15/15）、`npm run test:client`（19/19 步）、`npm run test:host`（30/30 步，含新增 `session-worker`）、`python test/worker/run.py`（528 项，24 skip）全部通过；fake worker 走通 `start / stop / restore`；协议主版本不一致与 Worker 不可达的错误文案可执行。

### M3.1：私有 GPU Worker（M3.1-a / M3.1-b 已完成，M3.1-c 真机验收待实施）

> 实施记录（M3.1-a，2026-11-22）：`worker/worker_server.py` 已成为可运行的常驻入口（默认 `127.0.0.1:8765`、Bearer 鉴权、stdout 只输出一行 ready JSON、SIGTERM 优雅退出）；运行时启动抽到 `worker/runtime.py` 与 `DaemonApp` 共用；HTTP 层新增 `/healthz`（免鉴权）、`/artifact`（单段 Range + ETag + sha256）、`/events`（SSE + 15 秒心跳 + `Last-Event-ID` 重放 + 4 条并发上限）；`/generate` 支持 `result_mode: inline|binary`，binary 结果落盘到临时目录并在任务淘汰/进程退出时清理；`/health` 补 `protocol_version / capabilities / hardware`；`/shutdown` 默认 403（`--allow-shutdown` 才生效）。部署文件与文档见 `worker/deploy/`。测试新增 18 项（`test/worker/test_protocol_v2.py`），Python 全套 546 项通过。

- [x] **服务端**：`worker/worker_server.py` 从占位改为可运行；抽取 `worker/runtime.py` 复用 GPU 探测/依赖/预加载；复用 `worker/transport/http_server.py` 与 `worker/jobs`；新增 `/artifact`（二进制 + Range）与 `/events`（SSE）；`/health` 增加 `protocol_version/capabilities/hardware`。
- [x] **部署**：`worker/deploy/Dockerfile` + `docker-compose.yml`（`--gpus all`、模型缓存卷、healthcheck）+ systemd 示例 + SSH 隧道 / 反代文档；默认不依赖 ntfy/cloudflared。
> 实施记录（M3.1-b，2026-11-22）：`private-worker` 已作为可选的算力来源开放。`server/providers/private-worker.js` 落地真实连接器（`/health` → 协议主版本 → phase 校验 → 句柄；共享 Worker `teardown` 只断开、不发 `/shutdown`）；连接判定抽到 `server/providers/worker-connection.js`，与 mock 替身、探针路由共用。地址写 app-config 的 `compute.privateWorker.endpointUrl`，Token 写 `credentials/workers.json`（AES-256-GCM，无主密钥时退回 0600 明文，与 LLM Key 同口径），公开视图只回 `tokenConfigured`；新增 `POST /api/worker/probe`（同地址才回落已保存 Token，绝不把 Token 发给陌生地址）。设置抽屉在私有 Worker 下只显示地址/Token/测试连接/协议与 GPU，隐藏空闲关机、HF Token、加速器与预挂载；顶栏显示「私有 Worker · 已连接（GPU）」与「连接/断开」，不显示 Kaggle/Colab 配额。三大 9B/大模型资产补 `private-worker` 来源；离线回归新增 `test/worker-host.mjs`（8 项）与 `test/check-client-worker.mjs`（5 项）。

- [x] **Host Provider**：`server/providers/private-worker.js` 实现 `provision/pollEndpoint/checkAlive/keepAlive/teardown/cleanupPending/readLogs`；共享 Worker 默认只断开不关机；Token 加密存储、非回环强制 HTTPS。
- [x] **设置与 UI**：设置抽屉按 provider 切换字段（地址/Token/测试连接/协议版本/GPU 型号）；新增 `POST /api/worker/probe`；顶栏显示「私有 Worker · 已连接/不可达/鉴权失败」；会话动作改为「连接/断开」。
- [ ] **M3.1-c 真机验收**：Docker 一条命令启动；生成/放大/参考生图/局部重绘四项通过；断开不杀共享 Worker；Token 不出现在响应/日志/状态快照；租用云 GPU 容器（AutoDL 等）部署/省钱/网络探索见 [`AUTODL_WORKER_RESEARCH.md`](AUTODL_WORKER_RESEARCH.md)。

### M3.2：云端协议 v2
- [ ] **daemon 跟进**：`result_mode=inline|binary`；binary 模式结果落临时目录；`/artifact` 单段 Range + ETag；`/events` SSE；diffusers 步数回调写入 `job.progress.step/steps`（1 秒节流）。
- [ ] **Host 跟进**：新增 `server/net-stream.js`（流式下载 + sha256 + Range 续传）；`remote.downloadArtifact()`；`jobs/queue` 先下载再 `saveJobOutput`（支持 `tempPath`）；`openEvents()` 订阅进度，断流回退轮询。
- [ ] **兼容**：旧 Host 对新 daemon 仍走 inline；新 Host 对旧 daemon 自动回退；`gpu-live.mjs --binary` 对比字节与峰值内存。
- [ ] **验收**：隧道抖动可续传；断流任务仍完成；任务卡显示「12/28 步」；Kaggle 真机回归全绿。

### M3.3：MCP Server
- [ ] **工具单源**：抽取 `shared/tool-specs.js`（名称/描述/JSON Schema），`server/tools.js` 只附加执行函数；MCP 复用同一份规格。
- [ ] **发现与进程**：本地服务启动后写 `<dataDir>/runtime.json`（0600，含 pid/port/token/origin/version/protocol）；`mcp/server.mjs` 只连回环、校验 pid、Bearer 调 `/api/*`；stdout 只走 JSON-RPC，日志走 stderr。
- [ ] **工具映射**：`imagen_generate / batch / upscale / history / cancel / session / recipes` 七个工具映射现有路由；默认返回文本 + 路径，`includeImage` 可选返回图片块。
- [ ] **打包与验收**：`electron-builder.yml` 的 `files` 加入 `mcp/**`，`@modelcontextprotocol/sdk` 进依赖；`--print-config` 输出 Claude Desktop/Cursor 配置；打包冒烟检查 `resources/app/mcp/server.mjs`；外部客户端完成「列工具 → 生成 → 查历史 → 取消」。

### M3.4：本机 GPU（可选）
- [ ] **探测与运行时**：`nvidia-smi` 型号/显存/驱动探测；`uv` 隔离环境、磁盘检查、PyTorch 索引选择；失败回滚，不污染全局 Python。
- [ ] **进程托管**：spawn `worker_server.py`（127.0.0.1 + 随机 Token）、解析 ready、崩溃最多重启 2 次、应用退出先 `/shutdown` 再杀进程树。
- [ ] **验收**：Windows + RTX 3060 12GB 跑通 `sdxl-lightning`；退出无残留；无 N 卡时保持「设计就绪、代码未实现」，不阻塞 M3。

---

## M4：AI 视频生成与 3D 资产闭环（Phase 3）

- [ ] **模型资产与推理扩展**：`models/*.json` 扩充 `mediaType: 'video' | 'mesh3d'`，补充视频与 3D 生成 Loader。
- [ ] **多模态舞台分发（`Stage.jsx`）**：
  - [ ] `VideoStage.jsx`：MP4 播放器（复用已有 HTTP Range 206 流）、首尾帧抽取与片段拼接；
  - [ ] `Mesh3DViewer.jsx`：基于 Three.js 的 `.glb` 实时 3D 预览器（旋转/线框/灯光）；
  - [ ] **统一版本树**：支持「文生图底图 → 一键图生视频 / 图生 3D」，派生作品挂在同一棵 `rootImage` 谱系下追溯与导出。
