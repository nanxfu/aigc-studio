# 商业生图 API 接入与 Agent 探索式批量抽卡规划

> **状态**：Phase A / B / C 全部落地（2026-11-23）
> **实施记录（Phase A）**：`shared/image-providers.js` 登记硅基流动 / fal.ai / OpenAI / 自定义端点与 10 个云端模型（能力位 + 预估单价）；`PROVIDERS['cloud-api']` 为无会话来源，`SessionManager` 校验配置后 0 秒 ready 且不落会话记录；`server/image-api.js` 适配 OpenAI Images 同步协议与 fal 队列协议，成图下载后由 `JobQueue` 复用 `saveJobOutput` 落盘；设置抽屉新增服务商 / 模型 / 端点 / Key 区块，Key 按服务商加密存储；扩图 / 超分 / 参考图 / 局部重绘在入队阶段返回 `image_api_unsupported`。测试见 `test/cloud-api.mjs`（8 项）与 `test/check-client-cloud.mjs`（3 项）。
>
> **实施记录（Phase B / C，2026-11-23）**：
> - **Phase B**：新增 `server/agent/inspect.js` 与 `imagen_inspect` 工具。沿用 Host「零图像依赖」原则（不引入 sharp / jimp / PIL），直接读产物字节转 base64 注入 pi-ai 原生 `ImageContent`（`{type:'image', data, mimeType}`），以 `INTENT.inspectMaxBytes`（2MB）/ `inspectMaxImages`（4）护栏控制上下文成本。`server/agent/tools.js` 新增 `content` 透传通道；**视觉门控由 pi-ai 在 LLM 边界完成**（仅 `model.input.includes('image')` 时把 toolResult 里的 image 块转成 `image_url` 附在 user 消息，纯文本模型自动忽略），工具侧不重复判断。`server/agent/prompt.js` Layer 3 固化四维审图（构图主体完整性 / 畸变 / 提示词元素命中率 / 色彩氛围）与「针对具体缺陷增删调权，而非盲目换词」。
> - **Phase C 护栏**：`ui_propose_explore` 返回 `data.ui.type='explore'`，运行时新增 `explore` SSE 事件并复用既有 `awaiting-user` 挂起。授权后 `streamAgentChat` → `/api/agent/chat` → `agent.run` 透传 `exploreBudget`，运行时按 `maxRounds` 放大步数上限（封顶 40）、每次生图工具按 `data.count` 累计并发 `explore-progress`；达到 `maxImages` 发 `budget-exhausted` 并以 `stopReason='budget-exhausted'` 收敛（`beforeToolCall` + `finishTurn` 双保险）。未下发预算时保持默认 6 步，不自动抽卡；「停止生成」沿用 `AbortSignal` 链路。
> - **Phase C 交互**：探索卡展示策略 / 轮数 / 总张数 / 预估费用胶囊、进度条与「开始探索」（耗尽后禁用）；多图网格可切「并排对比」（横向单行）；聚焦视图「选这张继续做变体」把图片路径写回新一轮用户输入；探索策略与预算经 `agentThreadMessages` 回写多轮上下文。双语 `studio.chat.explore.*` 成对新增。
> - **验收**：`npm test` 57/57 步全绿；新增/扩展 `agent-runtime` 23 项、`chat-timeline` 13 项、`check-client-chat` 33 项、`host-e2e` 65 项。
> **上位文档**：[`ROADMAP.md`](ROADMAP.md)、[`M3_PRIVATE_WORKER_AND_MCP_PLAN.md`](M3_PRIVATE_WORKER_AND_MCP_PLAN.md)  
> **背景决策**：AutoDL 4090D（¥1.98/h）实机已验证可跑通并固化私有镜像，但云容器在个人桌面端日常零散出图场景下存在抢卡、权重下载、30GB 磁盘上限与关机止损等运维负担；结合「按张付费商业 API」与「Agent 自动调词批量抽卡」两条诉求，确定收敛为 **商业 API（日常主力）+ 免费 Kaggle / 私有 Worker（批量抽卡与定制工具）** 的双轨算力架构。

---

## 1. 第一性原理定位：双轨算力各司其职

| 维度 | 轨道 A：商业生图 API（`cloud-api`） | 轨道 B：免费 Kaggle / 私有 Worker / 本地卡 |
| :--- | :--- | :--- |
| **核心优势** | 0 秒冷启动、0 运维、不抢卡、按张计费无闲置损耗；可用远超 24GB 显存上限的旗舰大模型 | 连续批量抽卡边际成本极低（Kaggle 免费 / 自建卡满载 < ¥0.01/张）；支持自研 LoRA、超分、真透明 PNG 与无审查隐私出图 |
| **典型场景** | 日常打开工作台构思、单张精修、高精度大模型直出 | **Agent 探索式批量抽卡（允许大量废片）**、专用 Outpaint LoRA 扩图、Real-ESRGAN 2× 放大、局部重绘 |
| **接入形态** | 填 API Key 即可用，连接阶段 0 秒就绪 | `notebook` 推送会合或 `worker` 长驻直连 |

**核心产品原则不变**：无论图片来自商业 API 还是自建 GPU，所有成品一律下载落盘到本地工作区 `outputs/`，继续复用现有作品画廊、版本谱系树、工作区隔离与本地文件服务，绝不依赖第三方商业图床。

---

## 2. 专题一：商业生图 API Provider（`cloud-api`）

### 2.1 复用现有底座（不做重造轮子）

1. **Provider 注册表（M3.0）**：在 [`shared/contract.js`](../shared/contract.js#L376-L423) 的 `PROVIDERS` 新增 `cloud-api`（`kind: 'cloud-api'`）：
   - `reattach: false`、`pendingCleanup: false`、`remoteShutdown: false`、`idleTimeout: false`、`logs: false`、`binary: false`、`events: false`；
   - 在 [`server/providers/index.js`](../server/providers/index.js) 注册对应构造器；
   - `provision` / `checkAlive` 只做极轻量的凭据校验（或 `/models` 连通探测），直接进入 `ready`，无需 Kernel 排队、ntfy 会合或隧道管理。
2. **厂商清单与加密存储（沿用 M2.5 模式）**：
   - 参考 `shared/llm-providers.js` 抽出一份纯数据的商业生图预设清单（如 `shared/image-providers.js`）；
   - API Key 复用现有 `safeStorage` + AES-256-GCM 凭据存储（兜底 `0600`），公开设置视图只回传 `apiKeyConfigured`。
3. **首批接入厂商建议**：
   - **SiliconFlow（硅基流动）**：国内直连、人民币充值方便、兼容 OpenAI `/v1/images/generations` 风格，涵盖 `Z-Image-Turbo`（约 ¥0.036/张）、`FLUX`、`Qwen-Image` 等高性价比模型；
   - **fal.ai**：海外生态最全（`FLUX.1 Schnell` 约 ¥0.02/张、`FLUX.2`、原生图生图/局部重绘/放大端点均有），采用标准 Queue 提交/轮询异步模式；
   - **通用 OpenAI Images 兼容端点**：填写 `Base URL + API Key + Model ID`，兼容各类聚合平台与自建网关。

### 2.2 与 `JobQueue` 和模型目录的衔接

1. **执行适配**：在 [`server/jobs/queue.js`](../server/jobs/queue.js)（或 provider 执行接口）为 `kind === 'cloud-api'` 分流：
   - 不走 `worker/daemon.py` 的 `/generate` + `/artifact` 协议，而是调用厂商适配器提交请求，拿到成图（URL 下载或 base64 解码）后统一交给 `saveJobOutput` 写入 `outputs/`；
   - 取消行为：尚未发出请求直接出队；已发出请求进入合作式中止（AbortController + 放弃落盘，不触发远程关机）。
2. **动态模型目录与能力门控**：
   - 商业 API 下的可选模型由所选厂商支持的模型列表决定（不再硬限本地 7 个模型文件）；
   - 每个商业模型声明清晰的能力位（`supportsReference`、`supportsInpaint`、`supportsUpscale`、`supportsSeed`、`supportsNegativePrompt`、`estCostPerImage`）；
   - 暂不支持的能力（如专用绿画布 Outpaint LoRA 或 2× Real-ESRGAN）在界面显式禁用并提示原因（如「当前商业 API 不支持扩图，可切换至 Kaggle 或私有 Worker」），避免静默失败或参数被暗中丢弃。

---

## 3. 专题二：Agent 探索式批量抽卡与多轮视觉变体精修

目前 [`shared/tool-specs.js`](../shared/tool-specs.js#L242-L250) 已具备 `imagen_batch`（单次 1–8 条不同提示词）与 `imagen_generate`（支持 `references` 与 `seed`），[`server/agent/runtime.js`](../server/agent/runtime.js) 已基于 `@earendil-works/pi-agent-core` 支持多轮工具调用。要打通「**自动调词抽卡 → 自己看图评估 → 不断生成更优变体**」，需补齐以下 3 块能力：

### 3.1 多模态视觉回看（让 Agent 真的“看得见”图）

- **现状缺口**：[`server/tools.js`](../server/tools.js) 中 `imagen_generate` / `imagen_batch` 当前只向 Agent 返回文本路径与本地 URL，Agent 无法识别构图偏移、肢体畸变或光影偏差。
- **方案（已落地，2026-11-23）**：
  1. 新增只读工具 `imagen_inspect`：读取产物图字节，构造 pi-ai 原生 `image` 内容块放回 toolResult；
     - **视觉门控交给底座**：pi-ai 只在 `model.input.includes('image')` 时把 toolResult 的 image 块转成 `image_url` 附到 user 消息，纯文本模型自动忽略，工具侧不重复判断（避免两处行为漂移）；
     - **保持 Host 零图像依赖**：不引入 sharp / jimp / PIL 做缩放，改用 `INTENT.inspectMaxBytes`（2MB）与 `inspectMaxImages`（4）体积/数量护栏控制上下文 Token 成本；超限或越界路径只回文本原因，让模型改用路径与元数据判断。
  2. Agent 评估维度固化进 `server/agent/prompt.js` Layer 3：构图主体完整性与裁切、明显伪影/畸变、提示词元素命中率、色彩与氛围一致性，并要求「指出具体缺陷 + 针对性增删调权」，而不是盲目换词。

### 3.2 探索模式护栏与预算控制（防止无限循环烧额度）

- **现状缺口**：[`server/agent/prompt.js`](../server/agent/prompt.js#L194) 默认拦截所有未确认生图，且 `DEFAULT_MAX_STEPS = 6`（[`server/agent/runtime.js`](../server/agent/runtime.js#L24)）偏小，难以支撑多轮自动抽卡。
- **方案**：
  1. **探索确认卡（`ui_propose_explore`）**：当用户发出「帮我多试几个方向挑一张最好的」类需求时，Agent 弹出一张探索方案卡，明确展示：
     - 本次探索策略（例如「第 1 轮先测 4 种不同构图/光影方向，挑出最优 1 张后再做 4 张细节变体」）；
     - **硬预算上限**：`maxRounds`（如 2 轮）、`maxImages`（如 8 张）及当前后端预估费用（如免费 Kaggle 标明「¥0」，商业 API 标明「约 ¥0.3」）；
     - 用户点击「开始探索」后，在预算内自动执行，无需每张都打断确认。
  2. **预算与中止护栏**：Host 在运行时强制计数，达到 `maxImages` 或用户点击「停止生成」立即收敛输出对比总结，绝不超额执行。

### 3.3 双轴变体工作流与前端呈现

1. **两条迭代轴**：
   - **提示词发散轴（Prompt Exploration）**：用 `imagen_batch` 一次提交 4–8 条差异化提示词（改变视角、景别、光影、材质或风格配方），适合初期定方向；
   - **视觉精修轴（Reference / Seed Refinement）**：选中上轮最佳作品，固定相近提示词微调细节，或将其传入 `references`（在支持参考图的模型/API 上）做同主体迭代。
2. **对话流对比卡片**：在同一组批量结果返回后，聊天流内支持并排缩略图展示与快捷操作（「选这张继续细化」「以此图作参考生成 4 个变体」「带入左栏参数面板」），形成「Agent 广撒网 → 人机共同选优 → 局部精修放大」的创作闭环。

---

## 4. 建议实施顺序

| 阶段 | 内容 | 验收目标 |
| :--- | :--- | :--- |
| **Phase A：商业生图 API 底座** | `PROVIDERS['cloud-api']` + `shared/image-providers.js`（先接 SiliconFlow + OpenAI 兼容 + fal.ai）+ `JobQueue` 下载落盘 + 设置抽屉 UI | ✅ 已完成：填 Key 0 秒就绪；文生图直落本地 `outputs/`；不支持的扩图/超分入口有清晰能力提示 |
| **Phase B：Agent 多模态看图** | ✅ 已完成：`imagen_inspect` 产物图回看（pi-ai 视觉能力门控）+ 四维视觉审图与改词规范 | 视觉模型的 toolResult 收到 `image` 块并由底座转成 `image_url`；纯文本模型自动跳过；2MB / 4 张护栏生效 |
| **Phase C：探索模式与对比交互** | ✅ 已完成：`ui_propose_explore` 硬预算护栏 + 运行时强制计数收敛 + 并排对比 / 变体回流 | 授权 1 次预算后自动在预算内推进，达到 `maxImages` 或点「停止生成」立即收敛；`npm test` 57/57 全绿 |
