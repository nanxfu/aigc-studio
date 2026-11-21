# AIGC Studio LLM 能力、生图 Agent（AGUI）与 Provider 接入规划

> **状态**：✅ 已实施（2026-11-21 一次性完成 Phase A→D，实施记录见文末 §六）
> **上位架构**：[`AIGC_STUDIO_STANDALONE_PLAN.md`](AIGC_STUDIO_STANDALONE_PLAN.md) ｜ **演进路线**：[`ROADMAP.md`](ROADMAP.md)
> **前序设计**：[`STUDIO_PANEL_AND_ASSISTANT_DESIGN.md`](STUDIO_PANEL_AND_ASSISTANT_DESIGN.md)

---

## 一、背景与第一性原理诊断

M1.5 阶段已引入 `@earendil-works/pi-ai` 与 `@earendil-works/pi-agent-core` 作为底层底座，但在产品能力与配置体验上仍存在三处明显断层：

1. **助手双轨割裂**：工作台同时存在「快卡模式（`server/intent.js` 单轮 JSON 解析 → 确认卡/澄清卡）」与「Agent 模式（`server/agent/runtime.js` 多轮工具循环 → 纯文本流 + 工具胶囊）」。前者交互可控但不会查配方/查历史/管会话；后者会调工具但缺乏结构化确认卡，容易直接提交消耗 GPU 的任务，用户心智与代码维护成本双双割裂。
2. **生图 Agent 场景与 AGUI 未成体系**：`server/routes/agent.js` 的系统提示词仅有 4 条静态规则，缺少当前画布上下文与领域提示词工程；SSE 事件流缺少结构化卡片原语（Clarify / Propose / Live Job）。
3. **`pi-ai` 底座的 Provider 与模型能力未充分释放**：
   - `server/llm/service.js` 目前仅接了 `openai-completions` 与 `anthropic-messages` 两条协议；
   - `server/llm/config.js` 只有 6 个预设，前端 `web/logic/appSettings.js` 的 `LLM_PROVIDERS` 更只放开了 4 个（`openai`、`anthropic`、`custom`、`ollama`）；
   - 缺少按厂商自动拉取模型列表与模糊搜索能力，用户每次配置都要手查并手填 `baseUrl` 与 `model`。

**核心演进方向**：
- **助手单轨化**：彻底合并「快卡」与「Agent」，以 `pi-agent-core` 为唯一驱动核心，将「澄清卡」「生图确认卡」升级为 Agent 的标准 AGUI（Agent-UI）交互工具。
- **默认确认护栏**：生图默认遵循「提案 → 用户点确认卡 → 执行 GPU 生成」主路径，兼顾零门槛与 GPU 成本可控。
- **配置零门槛化**：补齐国内外常用 Provider（含 Kimi、Gemini、千问、硅基流动、OpenCode 等），提供可模糊搜索的 Provider 选择器与“填 Key 自动获取模型”能力。

---

## 二、生图 Agent 驱动与提示词体系规划

### 2.1 合并原则：单一 Agent 驱动（废除快卡/Agent 分叉）

- **统一入口**：移除前端 `agentMode`（`'intent' | 'agent'`）切换控件与双轨分支状态；创作助手统一请求 `POST /api/agent/chat`。
- **无 Key 静默降级保留**：当用户尚未配置 LLM API Key 时，助手仍保留本地轻量配方检索与英文关键词提示兜底，并在卡片顶部提供非阻塞的设置引导，不卡死基础出图。
- **`server/intent.js` 的退场方式**：待 `ui_propose_generation` 与 `ui_ask_clarify` 在 Agent 链路稳定并完成客户端/服务端回归测试后，下线独立的 `/api/intent` 双轨逻辑（`server/enhance.js` 的单输入框「一键润色/转英文」仍可保留，复用同一套领域提示词规范与 `llm` 服务）。

### 2.2 场景界定与能力边界（默认先点确认卡）

把创作助手的所有交互收敛为 **5 类明确场景**，严格界定何时可以零成本响应、何时必须弹确认卡、何时才允许直接调度 GPU：

| 场景 | 典型用户输入 | Agent 行为与调用工具 | 是否消耗 GPU |
| :--- | :--- | :--- | :--- |
| **1. 创作咨询 / 灵感探讨** | “Flux 和 SDXL 区别是什么？”“帮我润色一段赛博朋克提示词” | 直接文本回答，或调用 `imagen_recipes` 检索本地配方作参考 | 否 |
| **2. 需求澄清（信息缺口大）** | “帮我画个好看的女孩”“来一张海报” | 禁止瞎猜参数直接出图；调用 `ui_ask_clarify` 输出 1~2 组可点选澄清选项 | 否 |
| **3. 提案确认生图（默认主路径）** | “画一只在雨夜霓虹屋顶的黑猫，16:9 电影感” | 查配方/匹配最优模型与参数后，调用 `ui_propose_generation` **弹出可编辑确认卡**，由用户点击「按此生成」或「带入参数面板」后才提交任务 | 用户点击确认后触发 |
| **4. 明确授权直接执行 / 批量变体 / 后处理** | “**直接**帮我生成 4 张不同光影的方案”“把上一张高清放大 2 倍” | 满足明确执行指令或轻量后处理时，直接调用 `imagen_generate` / `imagen_batch` / `imagen_upscale`（前置可调用 `imagen_history` 定位源图） | 是 |
| **5. 云端会话与队列运维** | “云端开机了吗？”“取消正在跑的任务”“看看刚才画了什么” | 调用 `imagen_session` / `imagen_history` / `imagen_cancel` 查询或操作状态 | 否 |

> **工具矩阵补充规划**：
> 现有 `server/tools.js` 已具备 `imagen_generate`、`imagen_batch`、`imagen_upscale`、`imagen_recipes`、`imagen_session`、`imagen_history`、`imagen_cancel` 共 7 个后台工具。合并规划需新增：
> 1. **AGUI 交互工具（服务端拦截或挂起生成卡片）**：`ui_propose_generation`、`ui_ask_clarify`；
> 2. **画布上下文协同工具**：`imagen_stage_context`（读取当前舞台选中图路径、尺寸、Seed、原 Prompt），以及后续接入 `imagen_img2img`（基于舞台选中图或历史图做重绘），让助手能直接响应“把当前这张图的背景换成雪天”。

### 2.3 提示词（Prompt）三层注入架构

改造 `server/routes/agent.js` 中当前简陋的静态 `defaultAgentSystemPrompt`，重构为 **3 层结构化提示词模板**：

1. **Layer 1：角色定位与安全护栏（静态核心）**
   - **角色**：AIGC Studio 创作导演与参数工程师，擅长将中文创意拆解为高质量英文扩散模型 Prompt，并匹配最合适的生图底座模型。
   - **默认确认护栏**：除非用户使用“直接生成 / 立即出图 / 直接放大 / 批量跑 N 张”等明确执行措辞，否则所有涉及新建 GPU 生图的请求**必须调用 `ui_propose_generation` 给出确认卡**，严禁绕过确认卡直接调用 `imagen_generate`。
   - **参数真实性约束**：只能选用上下文模型目录中存在的 `modelId`；不编造模型不支持的 CFG、步数或参考图能力。
2. **Layer 2：工作台实时上下文（每轮请求动态拼装）**
   - **可用生图模型画像**：来自 `models/*.json` 的模型 ID、定位、`promptStyle`（自然语言长句 vs 质量前缀 Tag）、默认 `steps` / `cfg`、是否支持 `negativePrompt`（如 `cfg === 0` 的极速模型不支持负向词则不生成负向词）。
   - **GPU 会话与队列摘要**：当前后端 Provider（Kaggle / Colab / Private Worker）与会话状态（`absent` / `starting` / `ready` / `busy`），方便 Agent 在需要唤醒时提前告知用户冷启动预期。
   - **当前舞台焦点（可选）**：前端随请求传入当前选中图像摘要（`imagePath`、`presetId`、`width × height`、`seed`、`prompt`），用于“基于当前图微调/变体/放大”。
3. **Layer 3：领域提示词构造规范**
   - **五要素结构**：主体与姿态 + 环境与时间 + 光影与色彩 + 景别/镜头/构图 + 质感与风格媒介。
   - **去空洞词**：禁止无脑堆砌 `masterpiece, best quality, 8k`（仅在明确依赖 `qualityPrefix` 的动漫/SDXL 底座按模型画像按需使用；Flux / Qwen-Image 等现代底座优先使用精确的自然语言视觉描述）。
   - **否定词防误译**：用户说“不要文字、不要路人、不要过曝”时，**严禁**将 `no text / no people` 写入正向 `prompt`，应按当前模型能力转写为正向描述（如 `clean background, empty street`）或剥离进 `negativePrompt`。
   - **防多轮话题粘连**：当用户明显开启全新主题时，独立重构 Prompt，不强行继承上一轮无关背景。

---

## 三、AGUI（Agent-UI）展示与事件协议规划

### 3.1 SSE 流式事件协议扩展

在 `POST /api/agent/chat` 既有事件（`text-delta`、`reasoning-delta`、`text`、`tool-start`、`tool-result`、`done`、`error`）基础上，增加结构化 UI 事件，使前端 `ChatPanel` 能稳定渲染富交互卡片：

| 事件类型 | 核心 Payload | 触发时机与前端渲染行为 |
| :--- | :--- | :--- |
| `reasoning-delta` | `{ step, text }` | 折叠式「思考过程」实时追加 |
| `text-delta` / `text` | `{ step, text }` | 对话正文 Markdown 流式渲染 |
| `tool-start` / `tool-result` | `{ step, toolCallId, name, arguments?, ok, text }` | 紧凑型工具步骤胶囊（如检索配方、查询历史），默认折叠详情 |
| `clarify` | `{ step, toolCallId, question, dimensions: [{ id, label, multi?, options: [{ label, value }] }] }` | 渲染 **澄清卡**：用户点击选项（或输入自定义补充）后，直接自动拼接为下一轮 `user` 消息提交给 Agent |
| `proposal` | `{ step, toolCallId, summaryZh, prompt, negativePrompt?, presetId, ratioId?, width?, height?, count, seed?, notes? }` | 渲染 **生图确认卡**（核心交互）：保留并升级原确认卡的全部能力 |
| `job-bound` | `{ step, toolCallId, jobId, presetId, count, prompt }` | 当确认卡被点击执行、或 Agent 直接调用 `imagen_generate` / `imagen_batch` / `imagen_upscale` 时，绑定作业进度气泡 |
| `done` / `error` | `{ steps, stopReason, text, images }` / `{ code, message }` | 本轮结束收口；如已产出 `proposal` 或 `clarify` 则挂起等待用户交互 |

> **关键设计细节（`proposal` / `clarify` 与 `pi-agent-core` 的配合）**：
> 当 Agent 调用 `ui_propose_generation` 或 `ui_ask_clarify` 时，该工具在服务端返回“已向用户展示确认卡/澄清卡，等待用户交互确认”的简洁 `toolResult`，同时通过 `finishTurn`（或指令约束）结束当前回合，防止模型在等待用户点击前继续空转；用户点击确认卡上的「按此生成」后，前端直接走 `/api/jobs` 提交生图任务（无需多跑一次 LLM），并把结果同步回聊天记录与上下文，保证最低延迟与零额外 Token 消耗。

### 3.2 AGUI 四大核心视觉组件规范

1. **工具与思考时间线（`AgentStepTimeline`）**：
   - 将多轮 `reasoning-delta` 和后台检索类工具（`imagen_recipes`、`imagen_history`、`imagen_session`）合并为一个可点击展开的轻量状态条（例如：`已检索配方「日系胶片」 · 耗时 0.8s ∨`），保持气泡区清爽。
2. **澄清卡（`ClarifyCard`）**：
   - 继承现有 `ChatPanel` 澄清卡的视觉风格，支持单选/多选胶囊，支持多维度问题同卡展示，底部提供「跳过并直接出方案」兜底按钮。
3. **生图确认卡（`ProposalCard`）**：
   - 顶部展示中文一句话创作思路摘要 + 推荐模型胶囊（如 `Flux.2 Klein 4B` · `16:9`）。
   - 中部为**可编辑的英文 Prompt 文本框**（如模型支持负向词，可展开编辑 `Negative Prompt`），支持微调张数（`1~4`）、画幅比例与「锁定上次构图（Seed）」。
   - 底部双动作：**主按钮「按此生成」**（立即创建作业并绑定进度条）+ **次按钮「带入参数面板」**（回填左栏表单供高频抽卡或垫图）。
4. **Live Job 作业与图库卡（`AgentJobCard`）**：
   - 实时消费作业状态（`pending` → `queued` → `running` 步数进度 → `done` / `failed`）。
   - 完成后展示 1~4 格缩略图网格，点击任意图联动主舞台大图预览并进入聚焦视图（支持继续涂抹、高清放大、对比原图）。

---

## 四、Provider 接入、搜索与自动获取模型规划

### 4.1 协议层扩充（基于 `@earendil-works/pi-ai`）

当前 `server/llm/service.js` 只导入了 `openai-completions` 与 `anthropic-messages`，而 `node_modules/@earendil-works/pi-ai/dist/api/` 与 `dist/providers/` 已经内置了完整的多厂商协议与模型目录。

规划将协议分发器（`piStreamFn`）扩展为 **4 条原生协议通道**：
1. `openai-completions`（覆盖 OpenAI 传统 Chat Completions 及所有 OpenAI 兼容国产/中转接口）
2. `openai-responses`（支持 OpenAI 新版 Responses API 及 OpenCode 中走 Responses 协议的模型）
3. `anthropic-messages`（覆盖 Anthropic 官方及兼容 Claude 协议的网关）
4. `google-generative-ai`（原生对接 Google Gemini `v1beta`，支持原生多模态与思考档位映射）

> **对 OpenCode 的特别处理**：
> 经核实 `@earendil-works/pi-ai/dist/providers/opencode.js` 与 `opencode-go.js`，OpenCode（OpenCode Zen / OpenCode Go）是一个**多协议聚合网关**，同一 Key 下不同模型分别路由至：
> - `https://opencode.ai/inference/openai/v1`（`openai-completions` / `openai-responses`）
> - `https://opencode.ai/inference/anthropic`（`anthropic-messages`）
> - `https://opencode.ai/inference/google/v1beta`（`google-generative-ai`）
> 且内部需附带 `withOpenCodeSessionHeader`。因此，接入 OpenCode 时**不能简单硬编码单一 Base URL**，应按所选模型的 `api` 字段动态匹配对应的协议与子端点（或直接复用 `pi-ai` 内置的 `opencodeProvider()` 模型清单与分发逻辑）。

### 4.2 统一单源 Provider 预设清单

消除目前 `server/llm/config.js`（6 项）与 `web/logic/appSettings.js`（4 项）的不一致，建立前后端共享的 **Provider 元数据清单**（建议沉淀到 `shared/llm-providers.js` 或由 `GET /api/app-settings` 单源下发，前端不再硬编码白名单）：

| 分组 | ID | 展示名称 | 默认协议 / 接口地址 | 鉴权方式 | 模糊搜索别名关键词 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **国产直连** | `deepseek` | DeepSeek | `openai-completions` · `https://api.deepseek.com/v1` | API Key | `ds, 深度求索` |
| **国产直连** | `moonshot` | Kimi (Moonshot) | `openai-completions` · `https://api.moonshot.cn/v1` | API Key | `kimi, 月之暗面, moonshotai` |
| **国产直连** | `qwen` | 通义千问 (DashScope) | `openai-completions` · `https://dashscope.aliyuncs.com/compatible-mode/v1` | API Key | `qwen, 阿里, 百炼, dashscope, aliyun` |
| **国产直连** | `siliconflow` | 硅基流动 (SiliconFlow) | `openai-completions` · `https://api.siliconflow.cn/v1` | API Key | `硅基, 轨迹流动, sf, silicon` |
| **聚合网关** | `opencode` | OpenCode Zen | 多协议按模型自动路由（复用 `pi-ai` `opencode`） | API Key | `opencode, zen` |
| **聚合网关** | `openrouter` | OpenRouter | `openai-completions` · `https://openrouter.ai/api/v1` | API Key | `or, 聚合` |
| **国际原生** | `gemini` | Google Gemini | `google-generative-ai` · `https://generativelanguage.googleapis.com/v1beta` | API Key | `google, gemini, 谷歌` |
| **国际原生** | `openai` | OpenAI | `openai-completions` · `https://api.openai.com/v1` | API Key | `gpt, chatgpt` |
| **国际原生** | `anthropic` | Anthropic (Claude) | `anthropic-messages` · `https://api.anthropic.com` | API Key | `claude` |
| **本地与兜底** | `ollama` | Ollama（本地） | `openai-completions` · `http://127.0.0.1:11434/v1` | 无需 Key | `local, 本地` |
| **本地与兜底** | `custom` | 自定义（OpenAI 兼容） | `openai-completions` · 用户填写 | API Key（可选） | `custom, proxy, 中转, vllm` |

> **可拓展性**：若后续需要扩展更多 `pi-ai` 内置 Provider（如 `zai` 智谱、`minimax-cn`、`xai`、`groq`、`mistral` 等），只需在该清单追加一行元数据即可自动同步到前端搜索列表与后端校验。

### 4.3 设置界面体验升级：Provider 模糊搜索 + 极简配置流

针对 `web/studio/settings/SettingsAppSections.jsx` 进行以下交互重构：

1. **可模糊搜索的 Provider 选择器（Searchable Combobox）**：
   - 将原生 `<select>` 替换为带搜索框的自定义下拉选择组件（支持键盘上下选择、Enter 确认、Esc 关闭，符合工作台既有轻量控件风格）。
   - **模糊匹配维度**：同时匹配 `label`（中文/英文名）、`id` 以及预设的 `aliases`（例如输入 `kimi`、`月之暗面` 命中 Kimi；输入 `千问`、`qwen`、`百炼` 命中通义千问；输入 `硅基` 命中硅基流动；输入 `opencode` 命中 OpenCode）。
   - 列表按「国产直连 / 聚合网关 / 国际原生 / 本地与自定义」分组展示，切换 Provider 时自动填充该厂商默认推荐模型与默认 Base URL。
2. **极简表单（隐藏非必要 Base URL）**：
   - 选中标准预设（非 `custom`）时，**默认折叠隐藏 Base URL 输入框**，仅以小字标注当前端点（附带「修改接口地址」折叠开关，供反代/中转用户按需覆盖），用户核心操作收敛为：**选 Provider → 填 API Key → 选模型**。
   - 选中 `custom` 时默认展开 Base URL，并保留「API Key 可选」兼容本地无鉴权服务（如 vLLM / LM Studio）。

### 4.4 自动获取模型列表（双引擎策略）

新增后端代理接口 `POST /api/llm/models`，彻底解决浏览器直接请求第三方 `/models` 的跨域（CORS）问题与已保存 Key 脱敏问题。

#### 1. 接口契约设计
- **请求**：`POST /api/llm/models`
  - Body：`{ provider, baseUrl?, apiKey?, refresh?: boolean }`
  - 若请求未传 `apiKey`（例如用户只改了模型或重新打开设置抽屉），服务端自动读取已加密持久化保存的同 `provider` API Key（若已换选其他 Provider 且尚未保存 Key，则提示先填写 Key 或直接返回静态推荐列表）。
- **响应**：`200 OK`
  ```json
  {
    "source": "remote | catalog | mixed",
    "models": [
      {
        "id": "deepseek-chat",
        "name": "DeepSeek Chat",
        "api": "openai-completions",
        "reasoning": false,
        "vision": false,
        "contextWindow": 128000
      }
    ],
    "warning": null
  }
  ```

#### 2. 各 Provider 探测逻辑（在线拉取）
- **OpenAI 兼容类**（`openai` / `deepseek` / `moonshot` / `qwen` / `siliconflow` / `openrouter` / `custom`）：
  `GET {baseUrl}/models`（携带 `Authorization: Bearer {apiKey}`）。
- **Anthropic**：
  `GET {baseUrl}/v1/models`（携带 `x-api-key: {apiKey}` 与 `anthropic-version: 2023-06-01`）。
- **Google Gemini**：
  `GET {baseUrl}/models?key={apiKey}`（解析 `models[].name` 去掉 `models/` 前缀，过滤出 `supportedGenerationMethods` 包含 `generateContent` 的模型）。
- **OpenCode**：
  优先拉取 OpenCode 远端模型接口（或合并 `@earendil-works/pi-ai/providers/opencode` 内置模型目录，确保每个模型的 `api` 与专属 `baseUrl` 元数据完整不丢失）。
- **Ollama**：
  `GET {rootUrl}/api/tags`（无需 Key，返回本地已下载模型列表）。

#### 3. 过滤、排序与静态目录兜底
- **噪音模型过滤**：自动过滤 `embedding`、`rerank`、`tts`、`whisper`、`asr`、`moderation`、`dall-e`、`flux` 等非文本对话/工具调用模型（按关键字规则过滤，同时在 UI 提供「显示全部」勾选或允许手动输入）。
- **静态目录兜底（利用 `pi-ai`）**：当用户尚未填写 Key、或部分中转站禁用了 `/models` 接口导致在线请求失败时，自动降级返回 `@earendil-works/pi-ai` 对应 provider 的内置静态模型目录（`moonshotai-cn`、`google`、`deepseek`、`opencode`、`anthropic`、`openai` 等），加上为 `qwen` / `siliconflow` 维护的常用推荐列表，并用静态目录补全在线返回模型缺失的 `reasoning` / `contextWindow` / `vision` 能力标签。
- **前端自动触发与手动编辑**：
  - 用户填入 API Key 失焦或点击「获取模型」按钮时自动触发拉取；
  - 模型输入框升级为**可搜索下拉 + 允许自由输入任意模型 ID**，既享受一键选模型，又不被列表白名单卡死。

---

## 五、分阶段落地路线与验收标准

为控制单轮改动风险并保证既有测试绿灯，建议拆分为 4 个递进阶段实施：

### Phase A：Provider 预设扩容、模糊搜索与自动获取模型
- **范围**：
  - 统一 `shared/` 与 `server/llm/config.js` 的 Provider 预设（含 Kimi、Gemini、千问、硅基流动、OpenCode 等）；
  - `server/llm/service.js` 接入 `google-generative-ai`、`openai-responses` 与 OpenCode 多协议分发；
  - 新增 `POST /api/llm/models` 接口与单元测试（覆盖各协议 mock 响应与静态兜底）；
  - 升级设置抽屉：Provider 模糊搜索框 + 折叠 Base URL + 模型自动获取/搜索下拉框。
- **验收**：选任意目标厂商 → 仅填 API Key → 自动拉出模型列表并完成选中保存；所有 LLM 协议单元测试通过。

### Phase B：合并双轨助手，构建统一 Agent + AGUI 基础链路
- **范围**：
  - 废除前端 `intent` / `agent` 双模式开关，统一接入 `POST /api/agent/chat`；
  - 在 `server/tools.js` 注册 `ui_propose_generation` 与 `ui_ask_clarify`，并在 `agent.js` 发出 `proposal` / `clarify` SSE 事件；
  - 重构 `ChatPanel` 事件消费逻辑，确保「对话 → 澄清卡 → 确认卡 → 点击按此生成 → 实时绑定作业卡」闭环跑通。
- **验收**：保留现有确认卡/澄清卡全套交互体验，且全部由 `pi-agent-core` 单轨驱动；无 Key 时静默降级不报错。

### Phase C：提示词工程三层注入与画布工具增强
- **范围**：
  - 升级系统提示词模板（注入全量模型能力画像、GPU 会话状态、舞台当前图元数据）；
  - 新增 `imagen_stage_context`（及可选 `imagen_img2img`）工具，补全对话中引用舞台当前图的创作闭环；
  - 完善前端思考/工具步骤条折叠展示与 `job-bound` 进度联动。
- **验收**：提问“帮我画一张赛博朋克猫”默认弹确认卡（不直接扣 GPU）；明确说“直接生成”才直接触发 `imagen_generate`；多轮切换主题不粘连、否定表述不直译进正向 Prompt。

### Phase D：全链路测试与文档收口
- **范围**：
  - 更新 `test/llm-client.mjs`、`test/agent-runtime.mjs` 与客户端测试；
  - 下线废弃的旧双轨代码（`server/intent.js` 如无外部引用则归档/移除）；
  - 更新 `docs/ROADMAP.md` 与 `docs/SPEC.md` 相关章节状态。

---

## 六、实施记录（2026-11-21，Phase A→D 一次落地）

### 6.1 新增与改造文件

| 范围 | 文件 | 说明 |
| :--- | :--- | :--- |
| 共享单源 | `shared/llm-providers.js`（新增） | 11 家 Provider 元数据、分组、搜索别名、噪音模型判定与能力猜测 |
| 协议层 | `server/llm/config.js` | Provider 预设改由共享清单派生；4 条协议；OpenCode 按模型覆盖 `api` / `baseUrl` |
| 协议层 | `server/llm/service.js` | `piStreamFn` 分发 4 条协议；OpenCode 会话头；免鉴权 Provider 占位 Key |
| 模型列表 | `server/llm/models.js`（新增） | 在线探测（OpenAI / Anthropic / Gemini / Ollama）+ `pi-ai` 内置目录兜底 + 过滤/合并/排序 |
| 路由 | `server/routes/llm-models.js`（新增） | `POST /api/llm/models`，同 Provider 复用已保存 Key，跨 Provider 不复用 |
| 设置 | `web/logic/appSettings.js`、`settings/SettingsAppSections.jsx`、`SettingsDrawer.jsx` | 搜索下拉、折叠端点、模型获取/搜索、请求代次守卫 |
| AGUI | `server/agent/agui.js`（新增） | `ui_propose_generation` / `ui_ask_clarify` / `imagen_stage_context` |
| AGUI | `server/agent/turn-context.js`（新增） | `AsyncLocalStorage` 挂载每轮舞台焦点/语言/算力来源 |
| Agent | `server/agent/runtime.js` | `proposal` / `clarify` / `job-bound` 事件；UI 工具后结束本轮；`pending` 收口 |
| Agent | `server/agent/prompt.js`（新增） | 三层系统提示词（角色护栏 / 实时上下文 / 领域规范） |
| Agent | `server/routes/agent.js` | 接收 `stage / locale / presetId / cfg`；无 Key 本地兜底不再 503 |
| 工具 | `server/tools.js` | `imagen_generate / imagen_batch / imagen_upscale` 返回 `jobIds` 供作业绑定 |
| 客户端 | `web/studio/hooks/useChatThread.js` | 单轨请求、SSE 事件映射、提案/澄清/作业卡、草稿兜底 |
| 客户端 | `web/studio/ChatPanel.jsx` | 移除模式开关；多维度澄清卡；步骤时间线；提案卡模型胶囊与说明 |
| 客户端 | `web/api/resources.js` | `fetchLlmModels`；`streamAgentChat` 增加 stage / locale / presetId / cfg |
| 契约/文档 | `shared/contract.js`、`docs/SPEC.md`、`docs/ROADMAP.md` | 新增 `llmModels` 路由与 §2.7 协议说明 |

### 6.2 与规划的两处偏差（有意保留）

1. **`/api/intent` 未删除**：规划要求「如无外部引用则归档/移除」。实际 `host-e2e` 与旧客户端仍依赖该端点，
   因此保留为**兼容端点**；前端不再调用，`server/intent.js` 同时承担 Agent 无 Key 时的本地兜底解析。
2. **`imagen_img2img` 未新增**：规划标注为「可选」。舞台重绘仍走既有的舞台图片工具（带蒙版/强度语义），
   Agent 通过 `imagen_stage_context` 读取当前图后，可调用 `imagen_upscale` 或引导用户进入重绘工具；
   真正的对话式重绘留待私有 Worker 的二进制回传能力就绪后再接（避免把 base64 大图塞进工具参数）。

### 6.3 验收对照

| 规划验收项 | 结果 |
| :--- | :--- |
| 选任意目标厂商 → 仅填 Key → 自动拉出模型并保存 | ✅ 设置抽屉搜索选择 → 填 Key 失焦自动拉取 → 点选保存（`check-client-shell`） |
| 所有 LLM 协议单元测试通过 | ✅ `test/llm-client.mjs` 覆盖 4 条协议；`test/llm-models.mjs` 覆盖 4 类探测与兜底 |
| 保留确认卡 / 澄清卡体验且由单轨驱动 | ✅ `test/check-client-chat.mjs` 单轨状态流用例 |
| 无 Key 静默降级不报错 | ✅ 服务端本地兜底提案卡（`test/agent-runtime.mjs`） |
| 默认弹确认卡、明确「直接生成」才直接执行 | ✅ 系统提示词护栏 + `ui_propose_generation` 默认路径 |
| 多轮切换主题不粘连、否定表述不直译 | ✅ Layer 3 规范注入（提示词约束，非硬编码转换） |
