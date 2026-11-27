# AIGC Studio 独立客户端演进路线图与待办清单（ROADMAP）

> **上位架构**：[`AIGC_STUDIO_STANDALONE_PLAN.md`](AIGC_STUDIO_STANDALONE_PLAN.md)
> **专项规划**：[`LLM_CAPABILITY_AND_AGUI_PLAN.md`](LLM_CAPABILITY_AND_AGUI_PLAN.md)（生图 Agent / AGUI / Provider 接入规划）、[`AUTO_UPDATE_PLAN.md`](AUTO_UPDATE_PLAN.md)（发布流水线与自动更新架构）、[`M3_PRIVATE_WORKER_AND_MCP_PLAN.md`](M3_PRIVATE_WORKER_AND_MCP_PLAN.md)（私有 Worker / 协议 v2 / MCP）、[`LOCAL_GPU_VULKAN_PLAN.md`](LOCAL_GPU_VULKAN_PLAN.md)（本机非 N 卡 / AMD 核显 Vulkan `stable-diffusion.cpp` 验证与资源平缓优化方案）、[`LOCAL_INFERENCE_AND_MODELS_PLAN.md`](LOCAL_INFERENCE_AND_MODELS_PLAN.md)（本机端侧 ONNX 统一托管与 WebGPU Worker 管线）、[`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md)（RunPod / Vast.ai 容器运行环境基线与分阶段验收）、[`CLOUD_API_AND_AGENT_EXPLORE_PLAN.md`](CLOUD_API_AND_AGENT_EXPLORE_PLAN.md)（商业生图 API 接入与 Agent 探索式批量抽卡）、[`MODELSCOPE_API_AND_LOCAL_UPSCALE_PLAN.md`](MODELSCOPE_API_AND_LOCAL_UPSCALE_PLAN.md)（ModelScope `API-Inference` 在线扩图/语义编辑扩展与本机端侧 ONNX 超分放大）、[`M4_VIDEO_AND_GAME_ASSET_PLAN.md`](M4_VIDEO_AND_GAME_ASSET_PLAN.md)（M4 视频量化部署与游戏素材/UI 基础设施）、[`M4_4_CLOUD_3D_PLAN.md`](M4_4_CLOUD_3D_PLAN.md)（M4.4 云端 GPU 3D 自部署闭环：轻量 `.glb` 探路 + 24GB `devel` PBR 容器 + Three.js 预览）、[`WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md`](WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md)（工坊场景化引导、防迷宫分层与类 Jev 智能感知）、[`WORKSHOP_DEPTH_AND_LIGHTING_PLAN.md`](WORKSHOP_DEPTH_AND_LIGHTING_PLAN.md)（M4.2e 工坊 `MoGe-2` / `DA3` 深度几何底座、雾效/透视/景深/视差与双轨动态打光）、[`WORKSHOP_RELIGHT_UPGRADE_PLAN.md`](WORKSHOP_RELIGHT_UPGRADE_PLAN.md)（工坊实时动态打光 WebGPU / 端侧几何 / SOTA 重打光升级选型与甜点试验规划）、[`WORKSHOP_HYBRID_COMPUTE_PLAN.md`](WORKSHOP_HYBRID_COMPUTE_PLAN.md)（M4.2f 工坊强本机 GPU 混合调度、三层算力分级与云/本地智能切换提示）、[`QUALITY_TIERS_AND_LORA_PIPELINE_PLAN.md`](QUALITY_TIERS_AND_LORA_PIPELINE_PLAN.md)（出图挡位联动、通用 LoRA 资产化与推理管线升级）、[`WEBSITE_SEO_GEO_PLAN.md`](WEBSITE_SEO_GEO_PLAN.md)（中文官网、宣传物料与 SEO / GEO 落地方案）
> **迁移记录**：[`MIGRATION_NOTES.md`](MIGRATION_NOTES.md)
> **历史插件路线图**：已归档至 [`archive/LEGACY_PLUGIN_ROADMAP.md`](archive/LEGACY_PLUGIN_ROADMAP.md)
> **当前基线**：Phase 1（`eeb43fd`）+ 修复轮（`4ba6dc7`）+ M1.5（`1d4a1db`）+ **M2 安装包交付与真机验收（进行中）** + **M2.6 导入图焦点隔离（已完成）** + **M2.7 助手显式参考图与多后端调度（已完成）** + **M2.8 发布通道与应用内更新（A/B 代码已落地，真实升级演练待版本收口）** + **M3.0 协议与 Provider 底座（已完成，2026-11-22）** + **M3.1-a Worker 服务 / M3.1-b Host 接入与设置 UI（已完成，2026-11-22）** + **M3.2 云端协议 v2 / M3.3 MCP Server（已完成，2026-11-22）** + **GPU 运行时基线阶段 0（镜像/依赖/权限/压测开关/CI 已完成并实测 3.16GB 压缩 / 6.07GB 未压缩，2026-11-22）** + **M3.4 本机 Vulkan 文生图闭环（AMD Radeon 880M 真机 + Host 接入已完成，2026-11-25）** + **M3.5 商业生图 API、Agent 探索抽卡与 Phase D 在线扩图 / 语义编辑 / 端侧超分全部完成（2026-11-27）** + **M4.0 底座算子 / M4.1 硅基流动视频主链路 / M4.2 多模态工作台与资产工坊（已完成，2026-11-23）** + **M4.2c 工坊引导与感知 Phase 1a/1b/1c/1d + Phase 2 端侧 L2（已完成，2026-11-25）** + **M4.2d 游戏 LoRA 风格锁定与 Ubisoft CHORD PBR（已完成并通过 Kaggle 2×T4 对比验收，2026-11-26）** + **M4.2e 深度几何 / 空间滤镜 / 双轨打光（工程闭环与离线验收完成，2026-11-27）**；M4.4 云端 GPU 3D 自部署规划已落地（[`M4_4_CLOUD_3D_PLAN.md`](M4_4_CLOUD_3D_PLAN.md)）。
>
> **规划迭代（2026-11-23）**：M2.8 拆为「发布通道 → 应用内更新」两段（[`M2_8_RELEASE_AND_UPDATER_SPEC.md`](M2_8_RELEASE_AND_UPDATER_SPEC.md)）；M3 拆为 4 个可独立验收的子阶段（[`M3_PRIVATE_WORKER_AND_MCP_PLAN.md`](M3_PRIVATE_WORKER_AND_MCP_PLAN.md)）；新增 **M3.5（商业生图 API 与 Agent 探索抽卡）**，确立「商业 API 日常主力 + Kaggle / 私有 Worker 批量兜底」的双轨方向。


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
| **M3.1** | **私有 GPU Worker** | **长驻 `worker_server` + Docker/systemd；`private-worker` provider；原生 binary 产物 + SSE；Token 加密与连接探测** | 🚧 M3.1-a/b 已完成；AutoDL 冻结，M3.1-c 转向 RunPod / Vast.ai（[`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md) **阶段 0 已完成**，待阶段 1 真机 MVP） |
| **M3.2** | **云端协议 v2** | **Kaggle/Colab daemon 跟进 binary/SSE；扩散步数进度；断流续传；旧 Host 兼容回退** | ✅ 已完成（2026-11-22） |
| **M3.3** | **MCP Server** | **stdio + `runtime.json` 发现；7 个工具映射本地 `/api/*`；打包与外部客户端验收** | ✅ 已完成（2026-11-22） |
| **M3.4** | **本机 GPU（可选）** | **非 N 卡 / 核显 Vulkan 文生图闭环（`stable-diffusion.cpp` + GGUF）；Host 托管进程、协议桥、模型卡与真机基线（见 [`LOCAL_GPU_VULKAN_PLAN.md`](LOCAL_GPU_VULKAN_PLAN.md)）；N 卡 CUDA 按需路径** | ✅ 多模型按需下载 + Vulkan/CUDA 引擎 + 设备/显存自适应（2026-11-26）；图生图待续 |
| **M3.5** | **商业生图 API 与 Agent 探索抽卡** | **`cloud-api` 算力接入（SiliconFlow / ModelScope / fal.ai / OpenAI 兼容）；Agent 多模态视觉回看与预算护栏批量变体；ModelScope 在线扩图 / 语义编辑与本机端侧超分（[`CLOUD_API_AND_AGENT_EXPLORE_PLAN.md`](CLOUD_API_AND_AGENT_EXPLORE_PLAN.md)、[`MODELSCOPE_API_AND_LOCAL_UPSCALE_PLAN.md`](MODELSCOPE_API_AND_LOCAL_UPSCALE_PLAN.md)）** | ✅ Phase A/B/C/D 全部完成（2026-11-27） |
| **M3.6** | **SaladCloud 按秒容器算力** | **零持久卷 `hf_xet` 现场拉取 + IPv6 双栈 Worker + 区域优选/慢节点 `reallocate` + 预算档位 UI（默认 `medium`、隐藏内部显卡选型）** | 🚧 正式 Provider / 设置 / 补清理已完成（2026-11-25）；扩展卡池压测待补 |
| **M4** | AI 视频、游戏/UI 基础设施与云端 3D 资产闭环 | 硅基流动/量化自建视频 + 轻量确定性游戏/UI 资产管线 + 云端 GPU `.glb` & Three.js 闭环（[`M4_VIDEO_AND_GAME_ASSET_PLAN.md`](M4_VIDEO_AND_GAME_ASSET_PLAN.md)、[`M4_4_CLOUD_3D_PLAN.md`](M4_4_CLOUD_3D_PLAN.md)） | 🚧 M4.1–M4.2f（含 Ubisoft CHORD / 深度空间 / 双轨打光 / 三层混合算力）已完成；M4.4 规划已定，M4.3 / M4.4 待实施 |
| **GTM** | **中文官网、宣传物料与 SEO / GEO** | **暗房光桌独立 Astro 静态官网 + 真机实测对比 + 滚动粘性叙事 + 长尾指南页与 Cloudflare Pages 部署（[`WEBSITE_SEO_GEO_PLAN.md`](WEBSITE_SEO_GEO_PLAN.md)）** | 🚧 官网加固、真机工坊对照、5 篇 SEO/GEO 指南、OG 图、统计埋点、README 大修与 `0.16.0` 收口完成；待发版验收与 Cloudflare Pages 上线后刷新最新截图/短片 |

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

## M3：私有 Worker、协议 v2 与 MCP（M3.0 / M3.1-a/b / M3.2 / M3.3 已完成，M3.1-c 待真机、M3.4 可选）

> **专项规划**：[`M3_PRIVATE_WORKER_AND_MCP_PLAN.md`](M3_PRIVATE_WORKER_AND_MCP_PLAN.md)、[`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md)（RunPod / Vast.ai 运行环境基线与阶段 0–3 验收）。
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

### M3.1：私有 GPU Worker（M3.1-a / M3.1-b 已完成，M3.1-c 转向 RunPod / Vast.ai 容器基线方案）

> 实施记录（M3.1-a，2026-11-22）：`worker/worker_server.py` 已成为可运行的常驻入口（默认 `127.0.0.1:8765`、Bearer 鉴权、stdout 只输出一行 ready JSON、SIGTERM 优雅退出）；运行时启动抽到 `worker/runtime.py` 与 `DaemonApp` 共用；HTTP 层新增 `/healthz`（免鉴权）、`/artifact`（单段 Range + ETag + sha256）、`/events`（SSE + 15 秒心跳 + `Last-Event-ID` 重放 + 4 条并发上限）；`/generate` 支持 `result_mode: inline|binary`，binary 结果落盘到临时目录并在任务淘汰/进程退出时清理；`/health` 补 `protocol_version / capabilities / hardware`；`/shutdown` 默认 403（`--allow-shutdown` 才生效）。部署文件与文档见 `worker/deploy/`。测试新增 18 项（`test/worker/test_protocol_v2.py`），Python 全套 546 项通过。

- [x] **服务端**：`worker/worker_server.py` 从占位改为可运行；抽取 `worker/runtime.py` 复用 GPU 探测/依赖/预加载；复用 `worker/transport/http_server.py` 与 `worker/jobs`；新增 `/artifact`（二进制 + Range）与 `/events`（SSE）；`/health` 增加 `protocol_version/capabilities/hardware`。
- [x] **部署**：`worker/deploy/Dockerfile` + `docker-compose.yml`（`--gpus all`、模型缓存卷、healthcheck）+ systemd 示例 + SSH 隧道 / 反代文档；默认不依赖 ntfy/cloudflared。
> 实施记录（M3.1-b，2026-11-22）：`private-worker` 已作为可选的算力来源开放。`server/providers/private-worker.js` 落地真实连接器（`/health` → 协议主版本 → phase 校验 → 句柄；共享 Worker `teardown` 只断开、不发 `/shutdown`）；连接判定抽到 `server/providers/worker-connection.js`，与 mock 替身、探针路由共用。地址写 app-config 的 `compute.privateWorker.endpointUrl`，Token 写 `credentials/workers.json`（AES-256-GCM，无主密钥时退回 0600 明文，与 LLM Key 同口径），公开视图只回 `tokenConfigured`；新增 `POST /api/worker/probe`（同地址才回落已保存 Token，绝不把 Token 发给陌生地址）。设置抽屉在私有 Worker 下只显示地址/Token/测试连接/协议与 GPU，隐藏空闲关机、HF Token、加速器与预挂载；顶栏显示「私有 Worker · 已连接（GPU）」与「连接/断开」，不显示 Kaggle/Colab 配额。三大 9B/大模型资产补 `private-worker` 来源；离线回归新增 `test/worker-host.mjs`（8 项）与 `test/check-client-worker.mjs`（5 项）。

- [x] **Host Provider**：`server/providers/private-worker.js` 实现 `provision/pollEndpoint/checkAlive/keepAlive/teardown/cleanupPending/readLogs`；共享 Worker 默认只断开不关机；Token 加密存储、非回环强制 HTTPS。
- [x] **设置与 UI**：设置抽屉按 provider 切换字段（地址/Token/测试连接/协议版本/GPU 型号）；新增 `POST /api/worker/probe`；顶栏显示「私有 Worker · 已连接/不可达/鉴权失败」；会话动作改为「连接/断开」。
- [ ] **M3.1-c 真机验收**：Docker 一条命令启动；生成/放大/参考生图/局部重绘四项通过；断开不杀共享 Worker；Token 不出现在响应/日志/状态快照；租用云 GPU 容器（AutoDL 等）部署/省钱/网络探索见 [`AUTODL_WORKER_RESEARCH.md`](AUTODL_WORKER_RESEARCH.md)。**2026-11-22 进展与决策**：AutoDL 实名后创建 `v-48g` 实例实测，因基础镜像 Python 3.8 不兼容及 `v-48g` 单价 ¥30.30/小时过高，68 分钟消耗 ¥35.5、0 产出并已关机止损；**AutoDL 接入冻结**，转向容器原生平台 **RunPod / Vast.ai**（不锁死单家）。选型对比见 [`GPU_PROVIDER_COMPARISON.md`](GPU_PROVIDER_COMPARISON.md)，运行环境基线见 [`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md)。
  - [x] **阶段 0：镜像与压测准备（不烧 GPU，2026-11-22 完成并 CI 实测）**：`worker/deploy/Dockerfile` 切到 `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime`（Python 3.11）并改为 root 运行；`worker/requirements-gpu.txt` 精确锁定 cu124 推理栈；新增 `worker/inference/policy.py`（`AIGC_WORKER_CPU_OFFLOAD` / `--cpu-offload` 的 auto/on/off 覆写，参与管线缓存键，`/health.cpu_offload` 上报）；新增 `.github/workflows/worker-image.yml`（清理 runner 磁盘 → 构建 → 体积闸门 ≤8GB/≤10GB → 无卡冒烟 → 推送 GHCR）与 `tools/check-worker-image.py`（`npm run worker:check`）；CI 实测**压缩 3.16GB / 未压缩 6.07GB**，镜像 `ghcr.io/nanxfu/aigc-worker:edge`（digest `sha256:0963c3aa…`，公开可拉取），Python 单测 566 项通过（新增 `test/worker/test_policy.py` 17 项）。
  - [ ] **阶段 1：MVP 端到端验收（待执行）**：RunPod A5000 24G（或 Vast 4090）+ 40–50GB Pod 卷，只验 `sdxl-lightning` + `flux2-klein-4b`（约 22.8GB）与四大工具、binary 下载、步数轮询、取消与断线重连；Token 不进日志；关机后计费归零。**配置清单与逐项验收见 [`RUNPOD_STAGE1_RUNBOOK.md`](RUNPOD_STAGE1_RUNBOOK.md)**。
  - [ ] **阶段 2：全模型补齐与 `cpuOffload` 跨卡 A/B（待执行）**：24GB 开 offload 对比 32GB/48GB 关 offload，记录 `load_seconds` / `infer_seconds` / `max_allocated_mb` 与单张成本。

### M3.2：云端协议 v2（已完成）

> 实施记录（2026-11-22）：Host 新增 `server/net-stream.js`（流式下载 + sha256 + Range 续传 + curl 兜底）、`remote.downloadArtifact()/openEvents()`；`JobQueue` 按 `provider` 能力位 + `/health.capabilities` 双重协商，binary 模式先下载到 `%TEMP%/aigc-studio/artifacts/<jobId>/` 再交给 `saveJobOutput`（支持 `tempPath`），哈希不一致删除半截文件重试 2 次，收尾统一清理临时目录；SSE 只更新 `job.progress.step/steps`，终态仍以 `/job` 为准，断流静默回退轮询。Worker 侧 `Job/JobStore` 增加步数，daemon 按 pipeline 签名注入 `callback_on_step_end`（旧管线回退 `callback`，1 秒节流、每张归零），`/job` 与 `/events` 同步下发。Kaggle/Colab 的 `binary/events` 能力位打开（仍以远端自报为准，旧 daemon 自动回退 inline）。前端任务卡显示「第 x/y 张 · 12/28 步」。测试：`test/remote-v2.mjs` 7 项、Python 全套 549 项。

- [x] **daemon 跟进**：`result_mode=inline|binary`；binary 模式结果落临时目录；`/artifact` 单段 Range + ETag；`/events` SSE；diffusers 步数回调写入 `job.progress.step/steps`（1 秒节流）。
- [x] **Host 跟进**：新增 `server/net-stream.js`（流式下载 + sha256 + Range 续传）；`remote.downloadArtifact()`；`jobs/queue` 先下载再 `saveJobOutput`（支持 `tempPath`）；`openEvents()` 订阅进度，断流回退轮询。
- [x] **兼容**：旧 Host 对新 daemon 仍走 inline；新 Host 对旧 daemon 自动回退；`gpu-live.mjs --binary` 对比字节与峰值内存。
- [x] **离线验收**：`test/remote-v2.mjs` 覆盖完整下载 / 206 续传 / 哈希不一致重试 / SSE 解析 / binary 落盘 / inline 兼容；任务卡显示「第 x/y 张 · 12/28 步」。
- [ ] **真机验收**：`gpu-live.mjs --binary` 与云端真机回归待按 [`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md) 转向 RunPod / Vast.ai 后一并执行（AutoDL 已冻结，见 `AUTODL_WORKER_RESEARCH.md` §7/§9）。

### M3.3：MCP Server（已完成）

> 实施记录（2026-11-22）：新增 `shared/tool-specs.js`（7 个工具的名称/描述/JSON Schema，纯数据），`server/tools.js` 只按名称取规格并附加 `execute`；新增 `server/runtime-file.js`，`server/standalone.js` 监听成功后原子写 `<dataDir>/runtime.json`（0600，含 pid/port/origin/token/version/protocol/workspace），正常退出删除；`mcp/server.mjs` 用 `@modelcontextprotocol/sdk` 的 stdio 传输实现 7 个工具，只连回环、每次调用重读 runtime.json、Token 只放请求头、stdout 只有 JSON-RPC，`--print-config` 输出客户端配置；`electron-builder.yml` 已含 `mcp/**` 与 `shared/**`，打包冒烟增加存在性检查。测试：`test/tool-specs.mjs` 5 项、`test/mcp-server.mjs` 9 项（真实 spawn + mock API）。

- [x] **工具单源**：抽取 `shared/tool-specs.js`（名称/描述/JSON Schema），`server/tools.js` 只附加执行函数；MCP 复用同一份规格。
- [x] **发现与进程**：本地服务启动后写 `<dataDir>/runtime.json`（0600，含 pid/port/token/origin/version/protocol）；`mcp/server.mjs` 只连回环、校验 pid、Bearer 调 `/api/*`；stdout 只走 JSON-RPC，日志走 stderr。
- [x] **工具映射**：`imagen_generate / batch / upscale / history / cancel / session / recipes` 七个工具映射现有路由；默认返回文本 + 路径，`includeImage` 可选返回图片块。
- [x] **打包与验收（离线）**：`electron-builder.yml` 的 `files` 加入 `mcp/**`，`@modelcontextprotocol/sdk` 进依赖；`--print-config` 输出 Claude Desktop/Cursor 配置；打包冒烟检查 `resources/app/mcp/server.mjs`；外部客户端完成「列工具 → 生成 → 查历史 → 取消」。

### M3.4：本机 GPU（可选）
> **专项方案（非 N 卡 / AMD 核显 Vulkan 路线，2026-11-23）**：[`LOCAL_GPU_VULKAN_PLAN.md`](LOCAL_GPU_VULKAN_PLAN.md)
> **实施记录（2026-11-25）**：AMD Radeon 880M（RDNA 3.5 / Vulkan 1.4）真机闭环完成。

- [x] **只读硬件探测与算力画像（前置落地）**：[`server/hardware-probe.js`](../server/hardware-probe.js) + [`shared/gpu-benchmark.js`](../shared/gpu-benchmark.js) 已实现 `nvidia-smi` / `vulkaninfo` / OS 显卡 / 磁盘余量四层离线探测，并在「设置 → 本机模型」及官网 `/hardware` 落地天梯评测。
- [x] **运行时与执行接入（Vulkan 路径）**：`stable-diffusion.cpp` `master-1127-79dc7ca` Windows Vulkan 预编译包 + RealVisXL V5 Lightning Q4_K（2.61 GB）+ FP16 VAE；零 Python / 零 CUDA 依赖。`probe.js` 校验二进制、模型、VAE、磁盘与 `Vulkan0` 设备；配置缺失 / 文件缺失在连接前明确报错。
- [x] **进程托管与资源平缓**：新增 `server/local-gpu/runtime.js`，spawn `sd-server.exe` 只绑定 `127.0.0.1` 随机端口；`BelowNormal` 优先级、`--params-backend disk`、`--vae-tiling`、`-t 8`、300 秒权重 TTL；异常退出最多重启 2 次；断开 / 应用重启按 `local-gpu-runtime.json` 回收进程树。
- [x] **Windows 一键准备**：Electron `beforePack` 预取锁定版本 Vulkan 引擎；首次使用先确认，再检查显卡与磁盘、断点下载并校验权重、支持取消与重启恢复，完成后配置本机 GPU 后端。
- [x] **协议桥与 Host 接线**：`server/local-gpu/bridge.js` 把 Host 的 `taskPayload` 翻译为 `/sdcpp/v1/img_gen`，再把任务状态映射回 `/job` 的 `running / done / failed`；Bearer Token 只在本进程内。`server/providers/local-gpu.js` 由占位改为真实 provider，`SessionManager` / `JobQueue` / 落盘 / 错误文案全部复用。模型卡新增 [`realvisxl-lightning`](../models/realvisxl-lightning.json)（仅 `local-gpu`）。
- [x] **Windows 一键准备（2026-11-25）**：Electron `beforePack` 锁定 Vulkan 引擎版本并解压到安装资源；首次设置确认后先预检真实 Vulkan 设备与系统盘/模型盘空间，再执行引擎/权重下载、SHA-256 校验、断点续传、取消及重启状态恢复，成功后配置后端并启动本机 GPU 会话。
- [x] **验收（AMD Radeon 880M）**：`sd-cli` 512² **10.48s**、1024² **48.45s**（采样 26.3s + VAE 19.6s，峰值工作集 2.94 GB）；`sd-server` 冷 52.88s / 热 43.76s（1024²）；Host 全链路 512² **23.14s** / 1024² **62.47s**、会话 2.99s 就绪；60 秒级任务期间 `/health` 未误判；断开后 `sd-server` 确定退出。`test/local-gpu-runtime.mjs` 离线全绿，`test/local-gpu-live.mjs` / `test/local-gpu-host.mjs` 真机通过。
- [ ] **后续**：N 卡 `uv` PyTorch CUDA 路径、设置页安装 / 路径选择器与模型切换热加载、图生图 / 局部重绘 / 参考图、macOS / Linux Vulkan 真机。

---

## M3.5：商业生图 API 与 Agent 探索式批量抽卡（Phase A / B / C / D 已完成）

> **专项规划**：[`CLOUD_API_AND_AGENT_EXPLORE_PLAN.md`](CLOUD_API_AND_AGENT_EXPLORE_PLAN.md)
>
> **背景与定位（2026-11-23）**：云容器运维（AutoDL 冻结 / RunPod 阶段 1 暂缓）在桌面端零散出图场景下成本与维护负担偏高，转为「**商业生图 API（日常主力，0 等待按张付费）+ 免费 Kaggle / 私有 Worker（批量抽卡、自研 LoRA 扩图与超分兜底）**」双轨架构；同时打通 Agent 视觉反馈，支持探索式多轮变体精修。
>
> **实施记录（Phase A，2026-11-23）**：
> - 共享清单 `shared/image-providers.js`：4 家服务商（硅基流动 / fal.ai / OpenAI / 自定义 OpenAI 兼容端点）与 10 个云端模型，声明负向词 / 步数 / 引导强度 / 种子 / 单次张数 / 预估单价；`presetById('cloud:<vendor>:<model>')` 可解析，`/api/state.presets` 在 `cloud-api` 下只下发当前服务商的云端模型。
> - 契约与错误：`PROVIDERS['cloud-api']`（`kind: 'cloud-api'`，无补清理 / 不关机 / 无日志），6 个 `image_api_*` 错误码与中英文案；本地预设的缺省可用来源改为「除 cloud-api 外的全部来源」，避免商业 API 下出现不可用模型。
> - Host 执行：`server/image-api.js`（OpenAI Images / 硅基流动同步请求、fal 队列提交→轮询→取结果、成图下载与 content-type/体积护栏、上游错误归一）；`server/providers/cloud-api.js` 只校验配置；`SessionManager` 0 秒 ready 且不落会话记录；`JobQueue` 逐张请求并复用 `saveJobOutput` / 版本树 / 交付路径；扩图 / 超分 / 参考图 / 局部重绘在入队阶段明确拒绝。
> - 设置：`compute.imageApi`（vendor / model / baseUrl）+ 加密凭据 `credentials/image-api.json`（按服务商分仓）；`POST /api/app-settings` 新增 `imageApi` 字段；设置抽屉新增服务商 / 模型 / 端点 / Key 区块，隐藏空闲关机、HF Token 与预挂载。
> - Agent：`/api/agent/chat` 的模型目录改为「当前来源的预设」（`getPresets`），云端模型可被 Agent 正确推荐；本地无 Key 兜底提案同样使用云端预设。
> - 测试：`test/agent-runtime.mjs` 扩到 23 项（视觉回看 / 非 OpenCode 视觉门控端到端 / 探索卡 / 前瞻预算护栏与总结收口 / 授权注入）、`test/chat-timeline.mjs` 13 项（探索上下文回写 + 预算下发 + 实时 SSE 进度消费）、`test/check-client-chat.mjs` 33 项（探索卡渲染 / 实时 `exploreProgress` 气泡 / 并排对比 / 变体回流）、`test/host-e2e.mjs` 65 项（工具清单补齐）；`npm test` **57/57 步全绿**（含 `test:contract` 15/15、`test:client` 21/21 步、`test:host` 34/34 步）。
>
> **实施记录（Phase B / C，2026-11-23）**：
> - **Phase B 视觉回看**：新增 `imagen_inspect` 只读工具（`server/agent/agui.js`）与 `server/agent/inspect.js`；保持 Host 零图像依赖（不引入 sharp / jimp），直接读产物字节转 base64 成 pi-ai 原生 `image` 块，配 `INTENT.inspectMaxBytes`（2MB）/ `inspectMaxImages`（4）体积与数量护栏，越界/超大文件仅回文本原因；工具注册表新增 `content` 透传通道并补齐 `imagen_batch` 产图提取，视觉门控交给 pi-ai 底座（`server/llm/config.js` 的 `piModelOf()` 接入全量 `pi-ai` 内置目录与推荐列表判定 `vision/reasoning`，纯文本模型自动忽略、不烧 Token）；`server/agent/prompt.js` Layer 3 固化四维视觉审图规范（构图完整性 / 畸变 / 提示词命中率 / 色彩氛围）与针对性改词要求。
> - **Phase C 探索护栏**：新增 `ui_propose_explore` 方案卡（策略 / `maxRounds` / `maxImages` / 预估费用 / 基础 Prompt），运行时 `data.ui` 白名单与 `explore` SSE 事件扩展；前端点「开始探索」把 `exploreBudget` 经 `streamAgentChat` → `/api/agent/chat` → `agent.run` 下发，同时注入 system prompt「探索授权」段覆盖默认确认护栏；运行时放大步数上限（按轮数，最多 40）、`beforeToolCall` 做单次前瞻余量拦截（失败提交不扣预算）、逐次累计产图数发 `explore-progress`；达到 `maxImages` 发 `budget-exhausted` 并封禁后续生图工具同时保留最终文字总结轮，最终以 `stopReason='budget-exhausted'` 收敛，随时可由既有「停止生成」AbortSignal 中止。无预算时保持默认 6 步，不自动抽卡。
> - **Phase C 前端交互**：探索卡渲染硬预算胶囊与「开始探索」；授权后运行中助手气泡实时承接 `explore-progress` / `budget-exhausted` 展示进度条与结束标记；多图结果网格新增「并排对比 / 回到网格」切换（横向单行大图）；聚焦视图新增「选这张继续做变体」，带选中图路径回流新一轮对话；探索策略与预算写入 `agentThreadMessages` 多轮上下文；双语文案新增 `studio.chat.explore.*`（zh/en 1082 键同构）。
>
> **实施记录（Phase D，2026-11-27）**：
> - **在线扩图**：`shared/image-providers.js` 为 ModelScope `FLUX.2-klein-4B` 声明 `supportsOutpaint` 与受控 Outpaint LoRA 配置（`1536×1024 / 1.6MP`）；`server/image-api.js` 仅在该工具路径注入 `loras`，`JobQueue` 放行绿边画布扩图并按标准 `outpaint` 元数据落盘；舞台扩图在商业 API 下按能力解锁。
> - **语义编辑**：新增 `Qwen/Qwen-Image-Edit-2511`（参考图、2048 上限、约 75s），模型卡写明「语义编辑 · 非蒙版」，Agent Prompt 明确与 GPU Worker 像素蒙版重绘的边界。
> - **端侧超分**：登记 `skillsafe-ai/realesrgan-x2plus` 的 FP16 / FP32 ONNX（SHA-256 与字节数锁定），实现固定 192px 瓦片 / 32px overlap / Hann 融合、WebGPU 优先与 WASM 兜底、真实下载 / 瓦片进度与取消；`POST /api/local-upscale` 把结果按标准 `upscale` 子版本落盘，`cloud-api` / 本机 GPU / 远端未就绪时自动优先本机。AMD Radeon RDNA 3 无头 Chromium 实测 256×192 → 512×384：WebGPU FP16 4.99s、WASM FP32 31.05s，均落盘成功且无接缝。

- [x] **Phase A：商业生图 API Provider（`cloud-api`）**
  - [x] `PROVIDERS` 新增 `cloud-api`（0 秒就绪、无生命周期管理），Key 复用 AES-256-GCM 加密存储；
  - [x] `shared/image-providers.js` 单源清单，适配 **SiliconFlow**、**fal.ai** 与 **通用 OpenAI Images 兼容端点**；
  - [x] `JobQueue` 按 `kind === 'cloud-api'` 分流，成图下载后统一经 `saveJobOutput` 落盘 `outputs/`；按模型能力位门控，不支持扩图 / 超分 / 参考图时显式提示切换来源。
- [x] **Phase B：Agent 多模态视觉回看（`imagen_inspect`）**
  - [x] 只读工具校验产物路径（复用 `resolveOutputPath` 防软链接逃逸），图片 base64 注入 pi-ai 原生 `image` 块；2MB / 4 张双护栏；
  - [x] 视觉门控由 pi-ai 底座在 LLM 边界完成（纯文本模型自动跳过，不额外烧 Token）；
  - [x] 四维视觉审图与针对性改词规范固化到 `server/agent/prompt.js` Layer 3。
- [x] **Phase C：探索模式护栏与变体对比交互**
  - [x] `ui_propose_explore` 探索确认卡（`maxRounds` / `maxImages` / 预估费用），授权后客户端下发 `exploreBudget`；
  - [x] 运行时强制计数（步数上限按轮数放大 + `explore-progress` / `budget-exhausted` + 双保险收敛），随时「停止生成」中止；
  - [x] 聊天流多图「并排对比」切换与聚焦视图「选这张继续做变体」一键回流（带图片路径），探索策略写回多轮上下文。
- [x] **ModelScope 生态首期接入（已完成，2026-11-27）**
  - [x] 接入魔搭 `API-Inference` LLM（`Qwen3.5-35B-A3B` 等）与异步生图/Base64 参考图编辑（`Z-Image-Turbo`、`Qwen-Image-2.1-Turbo` / `2.1`、`FLUX.2-klein-4B` / `9B`），补充选型入口与能力角标；
  - [x] Worker 端统一下载器 `worker/hub_download.py` 与设置项 `modelSource`（`huggingface` / `hf-mirror` / `modelscope`），加速自部署实例拉取模型。
- [x] **Phase D：ModelScope 在线工具扩展与本机端侧超分（已完成，详见 [`MODELSCOPE_API_AND_LOCAL_UPSCALE_PLAN.md`](MODELSCOPE_API_AND_LOCAL_UPSCALE_PLAN.md)）**
  - [x] **S1：ModelScope 在线扩图 (`outpaint`)**：`FLUX.2-klein-4B` 解锁 `supportsOutpaint`、`server/image-api.js` 透传受控 `loras`（`fal/flux-2-klein-4B-outpaint-lora`）并按扩图总像素口径（`1536×1024`）放行、`JobQueue` 与舞台 `扩图` 工具分流；
  - [x] **S2：ModelScope 语义编辑模型接入**：在目录中补充 `Qwen/Qwen-Image-Edit-2511` 用于自然语言局部改图，与严格像素蒙版 `inpaint` 明确区隔预期；
  - [x] **S3：本机端侧 ONNX 超分 (`local-upscale`)**：Real-ESRGAN FP16/FP32 ONNX 纳入统一注册表与 Worker 管线（WebGPU 优先 / WASM 兜底），固定 `192×192` 瓦片 + overlap 融合，无云端 GPU 直接 `2×` 放大并落盘子版本。

---

## M3.6：SaladCloud 按秒容器算力 Provider（已完成，2026-11-25）

> **背景与调研结论（2026-11-25）**：SaladCloud 为分布式消费级 GPU 容器网格，按秒计费且无持久化网络卷（本地临时盘最高 `250GB`，重启/抢占即清空）。通过欧美区域优选 + `hf_xet` 现场拉取方案，免除持久卷月租与重型烤模型镜像维护；同时经多卡真机压测验证了不同体积模型与卡型的实际成本、供给稀缺度与适用边界。

> **镜像与底座实测记录（2026-11-25，`762bba4` → `manual-c758bad`）**：
> - Worker 改造（`worker/transport/http_server.py`、`worker/deploy/docker-entrypoint.sh`、`worker/requirements-gpu.txt`、`worker/deploy/Dockerfile`）：支持 `--host auto` 双栈 `::` 监听（适配 Container Gateway 强制 IPv6 回源，禁 IPv6 宿主机自动回退 `0.0.0.0`），内置 `hf-xet>=1.2.0,<2.0.0`（`HF_XET_HIGH_PERFORMANCE=1`）并修复基础镜像 `jinja2` 版本过低导致的 `apply_chat_template` 报错（升级锁定 `jinja2>=3.1.6`）；CI 构建 `ghcr.io/nanxfu/aigc-worker:manual-c758bad`（压缩 `3.17GB` / 未压缩 `6.07GB`），Python 全套 `618` 项单测通过。
> - **多卡真机扩展压测结论（`medium` 档，`[us, ca, de, nl, gb]`，含 `hf_xet` 首次冷拉取至出图 + 第 2 张热出图）**：
>   - `sdxl-lightning`（`6.78GB` / `RTX 3090 24GB` `$0.163/hr`）：Gateway `250s` → `/health` `258s` → 首张冷图 `248.9s` → 热图 **`6.1s`** → 计费 `262.8s`，单次成本 **`$0.01190`**。
>   - `anima-turbo-v1.1`（`5.25GB` / `RTX 3060 12GB` `$0.067/hr`）：Gateway `334s` → `/health` `340s` → 首张冷图 `344s` → 热图 **`16.2s`** → 计费 `366.4s`，单次成本 **`$0.00682`**（轻量模型极致性价比）。
>   - `flux2-klein-4b`（`16.0GB` / `RTX 4060 Ti 16GB` `$0.12/hr`）：`143.6s` OOM 失败——实测暴露该模型 `peakVramMb: 7929` 系 `2×T4` (`gpus: 2`) 口径，单卡实际需 `>16GB`；已据此修复 `requiredVramGbOf()` 按 `peakVramMb * gpus` 计算（`18GB`），自动跳过 16GB 卡。
>   - `flux2-klein-4b`（`16.0GB` / `RTX 3090 24GB` `$0.163/hr`）：Gateway `331s` → `/health` `342s` → 首张冷图 `505.7s` → 热图 **`8.7s`** → 计费 `525.5s`，总成本 **`$0.02379`**。
>   - `flux2-klein-4b`（`16.0GB` / `RTX 4090 24GB` `$0.347/hr`）：触发一次慢节点自动 `reallocate`（`182.5s` / `21%` → 切快节点）→ Gateway `354s` → `/health` `365s` → 首张冷图 `226.5s` → 热图 **`5.6s`** → 计费 `242.9s`，总成本 **`$0.02341`**（节点下载快时，1–2 张短会话总价与 `3090` 几乎持平且出图更快）。
>   - `z-image-turbo`（`30.64GB` / `RTX A5000 24GB` `$0.197/hr` 及 `RTX 3090 24GB` `$0.163/hr`）：容器就绪后现场下载 `30.64GB` 权重均超过 `1200s` 超时；`RTX A5000` 另有一轮 `900s` 无节点可分（`machine=none`），`RTX A6000 (48GB)` 同在 `900s` 内 `machine=none` 排队超时——说明 `30GB+` 超大模型不适合消费级网格每次冷启现场拉取，且专业卡 `A5000`/`A6000` 池供给明显稀缺于 `3090`/`4090`。

- [x] **底座验证与策略锁定**：
  - [x] Worker 支持 IPv6 双栈监听、`jinja2>=3.1.6` 与 `hf_xet` 并发拉取；
  - [x] **无持久卷 + `hf_xet` 现场按需拉取**：保持 `3.17GB` 瘦镜像，开机后仅在任务命中某模型时现场下载至容器临时盘，不强推用户付费持久卷或重型烤模型镜像；
  - [x] **默认隐藏显卡选型**：不在主设置面直接暴露复杂显卡目录，由后端根据压测数据维护高性价比卡池（可在高级/隐藏配置中留有限覆盖项）；
  - [x] **预算/稳定性档位**：暴露 `high` / `medium`（**默认推荐**）/ `low` / `batch` 档位选择，并在 `?` 说明气泡中收敛单价差异、抢占风险与「被抢占重连后将重下权重」提示。
- [x] **显卡池扩展压测与策略调优（已完成，2026-11-25）**：
  - [x] 完成 `RTX 3060 (12GB)`、`RTX 4060 Ti (16GB)`、`RTX 3090 (24GB)`、`RTX A5000 (24GB)`、`RTX 4090 (24GB)`、`RTX A6000 (48GB)` 实测，确认 `RTX 3060`/`RTX 3090`/`RTX 4090` 供给稳健、`A5000`/`A6000` 排队稀缺、`30GB+` 权重冷拉取超 `20min` 边界；
  - [x] 据实测重排 `SALAD_GPU_POOLS.medium`（`RTX 3090` → `RTX 4090` → `RTX 4060 Ti` → `RTX 3060` → `RTX A5000`），拆分轻/重模型内存磁盘配额（`16GB/50GB` vs `24GB/80GB` 避免 32GB 宿主机过滤），且为 `>=48GB` 显存卡自动下发 `AIGC_WORKER_CPU_OFFLOAD=off` 避免大显存负优化。
- [x] **Host Provider 与契约接入（`salad`）**：
  - [x] `shared/contract.js` 登记 `salad` Provider 能力位、`ghcr.io/nanxfu/aigc-worker:manual-c758bad` 镜像与 `high / medium / low / batch` 档位枚举；`Salad-Api-Key` 加密落盘至 `credentials/salad.json`，`org / project / tier` 写 `compute.salad`；
  - [x] 新增 `server/providers/salad.js`：按 `peakVramMb * gpus` 取隐藏卡池，默认 `country_codes` 欧美优选区、`image_caching: true`、轻重分档内存与临时盘（`16GB/50GB` 或 `24GB/80GB`）；两段式慢节点检测（`>=180s && pull<25%` 或 `>=360s && pull<65%`）自动 `/instances/{id}/reallocate`，最多 3 次；允许连续 4 次 `/health` 瞬断容错；创建容器前先落待清理租约，`teardown` / `cleanupPending` 删除容器组，启动补清理不设 TTL，避免异常重启后持续计费；
  - [x] HTTP 统一走 `server/net.js` 的 `httpText`（fetch 失败降级系统代理 curl），GET / DELETE 幂等重试，POST 用固定容器组名避免重复创建；
  - [x] 会话状态机支持 `awaitEndpoint` Worker：先停在 provisioning，待 Container Gateway running 后再进入握手；停止 / 失败路径复用同一 `teardown`；
  - [x] `flux2-klein-9b` / `qwen-image-2.1` / `z-image-turbo` 能力位加入 `salad`（同时提醒大权重模型首次冷拉取耗时）。
- [x] **设置 UI 与离线测试**：设置抽屉补充 Salad 凭据区（API Key / Org / Project / 只读连接测试）、稳定性档位选择与 `?` 说明气泡（默认隐藏显卡选型）；新增 `test/salad-provider.mjs` 8 项（加密 / 选卡 / 容器规格 / reallocate / teardown / 补清理 / 会话握手 / API 错误）与 `test/check-client-salad.mjs` 5 项（表单 / 探测 / 保存 / 清除 / 算力弹层）。

> **实施记录（2026-11-25）**：完成 M3.6 全链路接入与多卡真机扩展压测；所有测试容器已核实销毁无残留（`active aigc-studio-* groups=0`）。`test/salad-provider.mjs` 8/8、`test/check-client-salad.mjs` 5/5、`npm run test:contract`、`npm run worker:check`、`npm run test:worker`（618 项）均通过。

---

## M4：AI 视频生成、游戏素材 / UI 基础设施与 3D 资产闭环（M4.1 视频主链路、M4.2 多模态工作台与资产工坊完成）

> **专项规划**：[`M4_VIDEO_AND_GAME_ASSET_PLAN.md`](M4_VIDEO_AND_GAME_ASSET_PLAN.md)、[`WORKSHOP_DEPTH_AND_LIGHTING_PLAN.md`](WORKSHOP_DEPTH_AND_LIGHTING_PLAN.md)（M4.2e 深度几何底座与光影空间特效）、[`WORKSHOP_RELIGHT_UPGRADE_PLAN.md`](WORKSHOP_RELIGHT_UPGRADE_PLAN.md)（`relight` WebGPU / 端侧几何 / AI 重打光升级选型草案）、[`WORKSHOP_HYBRID_COMPUTE_PLAN.md`](WORKSHOP_HYBRID_COMPUTE_PLAN.md)（M4.2f 工坊强本机 GPU 混合调度与云/本地智能推荐）、[`M4_4_CLOUD_3D_PLAN.md`](M4_4_CLOUD_3D_PLAN.md)（纯云端 GPU 3D 自部署闭环）、[`LOCAL_INFERENCE_AND_MODELS_PLAN.md`](LOCAL_INFERENCE_AND_MODELS_PLAN.md)（本机模型统一管理与 WebGPU Worker 管线）
>
> **实施策略（2026-11-26 更新）**：面向通用个人创作者，商业 API 以**硅基流动**为主力（图/视频），游戏/UI 走**轻量确定性算子（路线 A）**；**模型选型坚持效果优先，不因非商用/研究限制舍弃较优模型（如 `RMBG-2.0`、`Ubisoft CHORD`、`Hunyuan3D` 系列），仅在界面显式标识协议属性（复用 `licenseKind`）**；3D 明确收敛为**纯云端 GPU 自部署闭环（暂不接商业 3D API）**，分「15–16 GB 轻量 `.glb` 闭环探路（M4.4a）→ 24 GB+ `aigc-worker-3d:devel` 完整 PBR 容器（M4.4b）」两阶段推进，详见 [`M4_4_CLOUD_3D_PLAN.md`](M4_4_CLOUD_3D_PLAN.md)。

- [x] **M4.0 底座算子与契约预备（已完成，2026-11-23）**：`worker/inference/quant_accel.py`（`torchao` FP8 / `GGUF` / `TeaCache` / `SageAttention` 能力探测与显存策略）+ `worker/inference/game_ops.py`（像素对齐 / 图集切片 / 无缝检测与 `CircularPaddingPatch` / `VTracer` / `BiRefNet` / `Marigold` PBR 接口）与离线单测；`python test/worker/run.py` 578 项通过。
- [x] **M4.1 硅基流动 `cloud-api` 视频与生图打通（已完成，2026-11-23）**：`shared/image-providers.js` 视频目录（MiniMax H3 / Wan 2.2 T2V / I2V）、`server/video-api.js` 提交 → 轮询 → 下载、`JobQueue` 视频任务与 `saveJobOutput` 的 `01.mp4` / `mediaType: "video"` 落盘、模型卡「视频」分类与时长 / 分辨率参数、Stage 原生视频播放；`test/cloud-video.mjs` 5 项离线回归。
- [x] **M4.2 多模态工作台与游戏/UI 基础设施（已完成，2026-11-23）**：
  - ✅ **M4.2 前半（已完成，2026-11-23）**：顶栏 `[生图 | 视频]` 模式分流 + 模型卡保留厂商主 Tab 与次级模态筛选（双向联动）；视频左栏专属画幅（`21:9` / 首帧跟随锁定 / 直出视频规格 / 首尾帧角标与对调）与暗色导演取景框；原生 `<video>` 播放（Range 206）与首/尾帧 `<canvas>` 抽帧落成普通作品。
  - ✅ **M4.2a（已完成，2026-11-23）**：`channels[]` 复合资产包契约（`shared/contract.js` 的 `WORKSHOP`）与纯 JS `createZip` 导出（整目录 ZIP）；顶栏三段式 `[创作 | 工坊 | 作品库]` + 独立工坊页（六类工具、棋盘格透明底、最近作品 / 本地上传、通道切换条）；Stage 动作坞保留 **`进工坊 ↗`**（后续 UI 收口中，抹除背景统一回到工坊内完成）；本机 `<canvas>` 2×2 无缝平铺预览与混边 + Host 侧 **`@visioncortex/vtracer`**（Node WASM）SVG 导出（0 Python、0 GPU、`cloud-api` 可用）；工坊产物继承版本树并支持 ZIP 导出。
  - ✅ **M4.2b（已完成，2026-11-23）**：SOTA 像素对齐（边缘周期网格自动探测 + **Oklab** 调色盘量化 + Alpha 硬边）、序列帧切片（网格叠加 + 逐帧动画预览 + `atlas.json` / `spritesheet` 通道）、`Marigold` / `Ubisoft CHORD` PBR 材质拆解与「原图 + 四通道」切换条；GPU 算子走 `remove-bg` / `pbr` 任务队列，mock daemon 与 worker 单测覆盖，真机 GPU 验收待补（见专项规划 §5 待办）。
- [x] **M4.2c 工坊智能感知与极简引导（Phase 1a / 1b / 1c / 1d / 2 / 2.5 已完成，2026-11-25）**：
  - ✅ **Phase 1a（已完成，2026-11-24）**：L1 感知引擎落在纯逻辑 [`web/logic/workshopPerception.js`](../web/logic/workshopPerception.js)，融合 `preset.sceneTags` + `rootPrompt` / `rootPresetId`（Host 沿 `rootImage` 溯源，只读字段）+ 256px 采样像素特征，输出 Choice / Noul / Score 三原语，`<10ms` 出首屏态且无模型、无网络；接力「先保存再切焦点」策略已锁定。
  - ✅ **Phase 1b（已完成，2026-11-24）**：按工具领域（`平面与提取` | `游戏与 3D`）单行分栏全部平铺、带 Icon 与滑动切换高亮（去掉了「返回创作」与折叠开关）；移除通栏 6 枚场景标签，感知转入静默，只在画布顶边留一条可关闭的「返回创作台精修」轻提示；参数卡改为控件优先（`?` 按需展开说明与 Before/After）、模型警告仅在选中受限模型时出现；同时修复 `samples.jsx` 箭头字符串传参与抠图示意透底两处渲染缺陷，词典净减 21 键、`workshop.css` 重写（详见 [`WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md`](WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md) §2 与 §6.4）。
  - ✅ **Phase 1c（已完成，2026-11-24）**：移除 `.ofs-workshop-foot` 底栏（「保存到作品库 / 导出 ZIP」下线，`GET /api/workshop/export` 契约保留），本机算子与矢量改为「点应用 / 生成 SVG 即落盘 + Toast + 失败保留结果」，排队与报错落到参数按钮下方一行小字；接力胶囊迁入画布右下角操作区并直接复用已保存的新作品；[`web/logic/lineage.js`](../web/logic/lineage.js) 与 [`VersionPanel.jsx`](../web/studio/filmstrip/VersionPanel.jsx) 补齐独立 `workshop` 版本语义（工具名 + 通道数，含在途 `remove-bg` / `pbr` 幽灵行）；同时修复胶囊滑块「文字与底色错位」与最近作品缩略图「4 列挤成一团 + 半行裁切」两处体验缺陷（详见该规划 §6.5）。
  - ✅ **Phase 1d（已完成，2026-11-24）**：像素状态绑定作品路径与 URL，换图等待期间清除旧检测读数和照片提示，新像素到位后仍可自动落焦；用户等待期间手选工具或修改格距均优先保留，低于 `0.55` 置信度的格距只提示、显式「自动探测」可重新采用；旧派生记录按已加载图库的 `rootImage` 补齐原生提示词 / 模型先验（Host 字段优先，导入图与工坊作品名安全降级）。工坊渲染 **24/24**、感知 **19/19**、本机算子 **13/13**、客户端全组 **26/26 步**与生产构建通过；真实 Chromium 核对 `900×560` 深色六工具（说明展开时提交区均可见、整页无横向溢出）及浅色布局（详见该规划 §6.6）。
  - ✅ **Phase 2（已完成，2026-11-25）**：新增可选 `POST /api/workshop/perceive`，客户端只上传 256×256 RGB base64；Host 按固定 revision / 字节数 / SHA-256 懒下载 MobileCLIP-S0 FP16 视觉编码器（约 22.9 MB）到工作区缓存，复用 `onnxruntime-web` Session 并串行推理，与随包分发的静态 int8 场景 / Noul 锚点（约 14 KB）匹配。L1 先同步出首屏，L2 仅在 `top1 ≥ 0.5`、`margin ≥ 0.12` 且不推翻透明通道 / 像素格 / 序列帧格线 / 接缝等硬证据时微调一次；用户已手选工具或换图后迟到结果整体丢弃，任何失败静默保留 L1。模型权重受 Apple ML-MobileCLIP License 约束，当前不宣称可商用。Host 视觉 **10/10**、工坊渲染 **29/29**、感知 **25/25** 通过（含本机真实 FP16 前向）；全量回归与构建结果见规划 §6.7。Phase 3（云端语义）仍待推进。
  - ✅ **Phase 2.5（已完成，2026-11-25）**：新增 `POST /api/workshop/tags` 与 `WORKSHOP.perception.tagVersion`，把收敛后的场景 / Noul / 推荐摘要以白名单原子写入 `meta.workshopPerception`；`/history` 恒透传并对旧版本 / 脏字段降级为 `null`，工坊新产物不继承父标签。客户端增加标签内存缓存：`l1+l2` 首帧直接落焦且不再推理，`l1-heuristic` 先秒开再由 L2 静默升级，冷启动等待像素 + L2 一次落定并异步写回，L2 超过 2.5 秒静默回退 L1；无像素单关键词不再越过专业阈值（恢复裸词 `texture`，靠权重基线而非删词防误判），`pixelsOfUrl` 增加 8 张 / 64 MiB RGBA LRU。感知 **29/29**、Host 工坊 **19/19**、工坊渲染 **36/36**、契约 **15/15** 通过，生产构建通过；详见规划 §6.8。
- [x] **M4.2d 游戏 LoRA 风格锁定与 Ubisoft CHORD PBR 接入（已完成，2026-11-26）**：新增 `shared/game-styles.js`（`pixel-art` / `old-gods` / `spritesheet-2x2` + 自定义 HF LoRA）、Host 队列透传与左栏 `StyleSection.jsx`（跨新建创作锁定、触发词前置、回填/重抽），并在 [`worker/inference/game_ops.py`](../worker/inference/game_ops.py) 接入 `Ubisoft CHORD` PBR 四通道拆解（运行期隔离拉取源码、`sd2-community` 配置镜像、`safe_open` 流式权重、兼容 T4 FP16 与 `transformers 5.x` 键名），同时放开 `WORKSHOP.pbr.models.chord`（`gated: true`）。真实 Host → Kaggle 2×T4 同源对比验收（[`test/live-game-workshop.mjs`](../test/live-game-workshop.mjs)，结果归档 [`bench-results/game-workshop/2026-11-26T20-33-03/report.json`](../bench-results/game-workshop/2026-11-26T20-33-03/report.json)）跑通全链路：CHORD（56.5s）相对 Marigold（45.6s）彻底修正法线地面分割错位与非金属背景灰雾/金属反转，细节显著优于 Marigold。
- [x] **M4.2e 工坊深度几何底座与光影空间特效（工程闭环与 Kaggle 2×T4 真机实测通过，2026-11-27）**：新增第三组 `光影与空间`（`depth-fx` / `relight`），通道白名单扩展 `depth / normal / depthfx / relit`；深度产物把源画面保留为主图，`depth` / `normal` 只进通道，跨玩法直接复用。端侧 DA3-Small ONNX 实际下载校验（37,027,601 B / SHA-256 通过）并完成 CPU 前向（`187.5 ms`，输入 `image [1,3,378,504]`，输出 `depth [1,378,504]`）；GPU Worker 接入 DA3Mono-Large / DA3-Large / MoGe-2 ViT-L 与 IC-Light，并已于 Kaggle 2×T4 完成真机端到端实测与视觉验收（`DA3Mono-Large` 31.8s / `DA3-Large` 23.1s / `MoGe-2 ViT-L` 33.2s / `IC-Light` 48.9s，见 `bench-results/depth-relight-live/2026-11-27T11-04-48/report.json`）。
  - [x] **M4.2e-1 深度几何引擎接入**：端侧 `DA3-Small` 走统一 Inference Web Worker，GPU 高质量档登记 `MoGe-2 ViT-L` / `DA3Mono-Large` / `DA3-Large`（`CC BY-NC 4.0` 仅静默标签）；`depth` / `normal` 存入 `channels[]`，`/history` 与版本树可复用。
  - [x] **M4.2e-2 空间滤镜（`depth-fx` 四合一实时交互）**：雾效（四套预设、起雾距离、贴地低雾、画布聚雾/散雾锚点与柔性画笔）、大气透视、点击对焦景深 / 移轴、2.5D 视差呼吸预览；预览工作副本 `384px`（DoF 为 `256px`），应用时按原分辨率重算并落盘。
  - [x] **M4.2e-3 动态打光（`relight` 双轨闭环）**：物理轨道支持在画布拖动光源球、色温 / 强度 / 轮廓光 / 环境补光，优先使用 PBR 四通道，缺失时用原图 + 深度法线近似，并以 WebGL shader 预览、CPU 同方程兜底；AI 轨道经 GPU Worker 调用 IC-Light（`non-commercial` 静默标签），请求携带 prompt / steps / cfg / seed / preset。
- [x] **M4.2f 工坊强本机 GPU 混合调度与云/本地智能推荐（工程闭环完成，2026-11-27；M4.2f-3 真机 CUDA 校验因当前无 N 卡机器暂缓）**：复用 `hardwareProbe`、隔离 `uv` PyTorch/CUDA 环境与 `JobQueue` 串行队列，建立端侧 ONNX / 本机 CUDA / 仅云端三层算力矩阵，模型与挡位显示状态徽章（`端侧秒算 / 本机 GPU 可跑 / 建议上云 / 仅云端`），并在「主 Provider 选云 GPU 且本机空闲显存充裕」时弹出非阻塞轻提示条引导一键免排队切本机（仅用户确认后才触发下载，绝不改全局生图设定）。
  - [x] **M4.2f-1 能力矩阵与交互提示**：统一 `evaluateWorkshopCompute` 评估器，扩展 `/api/local-models/hardware` 返回共享环境 / 模型缓存状态，升级工坊四态徽章、未缓存时云端停靠与云/本地双向非侵入轻提示；PBR / 深度 / IC-Light 执行偏好独立记忆。
  - [x] **M4.2f-2 通用 `local-cuda` Runner 与队列调度**：新增 `server/local-cuda-runner.js` 与 `worker/local_workshop.py`，共享既有 `runtime/local-pbr/` 运行时并接入 `DA3Mono-Large` / `DA3-Large` / `MoGe-2 ViT-L` / `IC-Light`；执行前二次显存复核，Windows 进程树与 POSIX 进程组取消均已接入；并已完成 `cloud-api` 放行、`uv venv --seed` 预装深度依赖与无 `git` 安装回退修补（离线回归全通）。
  - [ ] **M4.2f-3 真机 CUDA 校验（暂缓，待具备 NVIDIA 显卡环境后补测）**：当前开发机无 NVIDIA GPU，已暂缓真实 CUDA 执行；待后续有 8 GB 与 12 GB+ N 卡环境时，再补跑三算子耗时 / 峰值显存（校准 `WORKSHOP_COMPUTE_PROFILES` 门槛）、Windows `taskkill /T /F` 显存回收与无 N 卡降级实测。
- [ ] **M4.2g 动态打光（`relight`）体验与 WebGPU / SOTA 方案升级（调研与路线已归档，待试验筛选甜点，详见 [`WORKSHOP_RELIGHT_UPGRADE_PLAN.md`](WORKSHOP_RELIGHT_UPGRADE_PLAN.md)）**：聚焦 WebGPU 线性 PBR / 深度 Raymarching 投影 / 2.5D Radiance Cascades、端侧 `MoGe-2` WebGPU ONNX 原生法线，以及 `IC-Light` 光球方向图桥接 / 新一代重打光模型对照试验。
- [ ] **M4.3 自建视频 Worker 量化加速**：接入 `LTX-2 Distilled`（FP8） / `Wan 2.2 TI2V-5B`（FP8/GGUF + TeaCache + SageAttention）与 24GB 卡真机压测。
- [ ] **M4.4 云端 GPU 3D 模型生成闭环（暂不接商业 3D API，详见 [`M4_4_CLOUD_3D_PLAN.md`](M4_4_CLOUD_3D_PLAN.md)）**：
  - [ ] **M4.4a 轻量闭环探路（15–16 GB 云卡，如 Kaggle/Colab T4）**：接入 **`Hunyuan3D-2mini`**（4.23 GB 权重、零 CUDA 编译，先跑通协议）与/或 **`SPAR3D`**（7.33 GB、low VRAM ~7 GB 含基础贴图）；补齐 `worker` `tool=mesh3d`、`/artifact` `model/gltf-binary` 流式回传、`server/output.js` `01.glb` + `meta.mediaType='mesh3d'` 落盘、前端懒加载 `three` 实现 `Mesh3DViewer.jsx` 交互预览（旋转/线框/法线/导出）与版本树关联。
  - [ ] **M4.4b 旗舰 3A PBR 自部署容器（24 GB+ RunPod / Vast / Salad / 私有机）**：拆出独立 `worker/deploy/Dockerfile.3d`（`pytorch:2.6.0-cuda12.4-cudnn9-devel`，预编译 `custom_rasterizer` / `nvdiffrast` / `o-voxel`，不污染 3.16 GB 2D 镜像），`/health` 上报 `3d-devel` 能力护栏，接入 **`Hunyuan3D-2.1`**（分阶段卸载跑入 24 GB）与 **`TRELLIS.2-4B`**（MIT 原生 PBR `.glb`）。

---

## GTM：中文官网、宣传物料与 SEO / GEO（进行中，约 90%）

> **专项规划**：[`WEBSITE_SEO_GEO_PLAN.md`](WEBSITE_SEO_GEO_PLAN.md)（独立工程位于 `site/`，不影响主客户端与 Electron 打包）。

- [x] **暗房光桌官网主体与交互落地（`c8704a4`，2026-11-24）**：完成暗房/日光双主题系统、全视口幻灯机首屏 + 35mm 胶片长卷、垂直领域 100vh 滚动幕帘叙事（`DomainStory.astro`）、桌面工作台反色插页粘性叙事（全尺寸含分屏自适应）、同题 7 模型 A/B + 2.4× 放大镜实测（`BenchCompare.astro`，接入 28 张真机 WebP）、工坊交互实验室（`WorkshopLab.astro`），以及 `/`、`/models`、`/workshop`、`/guides/free-gpu-no-comfyui` 与 SEO/GEO 基础设施。
- [x] **上线体验加固与 Cloudflare Pages 就绪（2026-11-24）**：通过 `@fontsource/noto-serif-sc`（unicode-range 分片）与 `@fontsource/instrument-serif` 实现零 Google Fonts 外链自托管；补齐 `≤ 900px` 移动端折叠导航抽屉；实现按 OS 识别的下载入口并诚实标注首批仅验证 Windows x64（macOS / Linux 支持源码运行）；新增 `PUBLIC_SITE_URL` 环境变量驱动动态 `robots.txt` / `llms.txt` / `sitemap`、`.node-version`、`wrangler.toml` 与 Cloudflare Pages `_headers` 强缓存配置。
- [x] **真机工坊对照与 OG 封面图落地（2026-11-24）**：从实测 GPU 产出与本机算子结果导出高清 WebP 与 `.svg` 至 `site/public/assets/workshop/`，全面替换 `WorkshopLab.astro` 的 CSS 假滤镜示意（BiRefNet 透明底、VTracer 实算 SVG、余弦混边 2×2 平铺、Oklab 像素对齐、4 帧真实动画回放、Marigold 四通道 PBR）；生成 1200×630 暗房风 `og-cover.png`（可由 `site/scripts/generate-assets.py` 一键复现）。
- [x] **全套 5 篇 SEO / GEO 长尾种子页与指南索引（2026-11-24）**：补齐 `/guides` 总索引及 `aigc-studio-vs-comfyui`、`ai-pixel-art-sprite`、`ai-image-to-svg`、`mcp-claude-cursor-image` 4 篇指南页，配齐 `Article` / `FAQPage` / `CollectionPage` JSON-LD 与互链，`llms.txt` 与 `sitemap-0.xml` 完整收录 9 个页面。
- [x] **根目录 `README.md` 大修与盲测模板拆出（2026-11-24）**：将 9 维盲测英文提示词迁出至 [`MODEL_BENCHMARK_PROMPTS.md`](MODEL_BENCHMARK_PROMPTS.md)；README 补齐商业生图/视频 API、6 项资产工坊、11 家 LLM、MCP、官网及 5 篇指南入口，产品版本收口为 `0.16.0`。
- [x] **官网埋点预埋与 `pages.dev` 过渡配置（2026-11-24）**：`site/src/layouts/BaseLayout.astro` 支持 `PUBLIC_CF_BEACON_TOKEN`（Cloudflare Web Analytics）与 `PUBLIC_UMAMI_WEBSITE_ID`（`download-client` 自定义点击事件），清理冲突的 `pnpm` 锁文件，默认域名兜底对齐已上线的 `https://aigc-studio-8rj.pages.dev`。
- [x] **冷启动发布包就绪（2026-11-24，2026-11-27 对齐 `0.17.0`）**：完成 Release Notes 模板与分渠道首发文案草稿（[`GTM_LAUNCH_PACK.md`](GTM_LAUNCH_PACK.md)），并同步中英文 `README` 互链、`/en` 官网跳转与 `0.17.0` 全端版本号。
- [ ] **实机 UI 截图与宣传短片刷新（待软件 UI 优化稳定后）**：替换桌面工作台最新实机截图，补拍高质量 6–8 秒静音循环短片与 15–20 秒核心主宣传片。
- [ ] **Cloudflare Pages 控制台建站与发版上线**：连接 GitHub 仓库（Root `site` / Build `npm run build` / Output `dist`），配置 `PUBLIC_SITE_URL` 及统计环境变量，推送 `v0.17.0` Tag 触发自动出包并在 GitHub Releases 转为正式公开版本。
