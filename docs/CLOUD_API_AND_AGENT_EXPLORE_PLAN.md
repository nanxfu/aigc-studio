# 商业生图 API 接入与 Agent 探索式批量抽卡规划

> **状态**：Phase A 已落地（2026-11-23）；Phase B / C 待迭代
> **实施记录（Phase A）**：`shared/image-providers.js` 登记硅基流动 / fal.ai / OpenAI / 自定义端点与 10 个云端模型（能力位 + 预估单价）；`PROVIDERS['cloud-api']` 为无会话来源，`SessionManager` 校验配置后 0 秒 ready 且不落会话记录；`server/image-api.js` 适配 OpenAI Images 同步协议与 fal 队列协议，成图下载后由 `JobQueue` 复用 `saveJobOutput` 落盘；设置抽屉新增服务商 / 模型 / 端点 / Key 区块，Key 按服务商加密存储；扩图 / 超分 / 参考图 / 局部重绘在入队阶段返回 `image_api_unsupported`。测试见 `test/cloud-api.mjs`（8 项）与 `test/check-client-cloud.mjs`（3 项）。
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
- **方案**：
  1. 新增只读工具 `imagen_inspect`（或在 `imagen_generate` / `imagen_batch` 完成后按条件附加预览图块）：
     - 仅当当前 LLM 配置具备视觉能力（`target.model` 支持图像输入）时生效；
     - 将产物缩放/压缩为轻量预览图（如长边 ≤ 512px JPEG/WebP）注入工具返回，控制上下文 Token 成本；
     - 纯文本 LLM 自动跳过看图步骤，仅依据用户反馈迭代提示词。
  2. Agent 评估维度固化进系统提示（`server/agent/prompt.js`）：构图主体完整性、提示词元素命中率、明显伪影/畸变、色彩与氛围一致性，从而针对性地增删提示词或调整权重，而不是盲目换词。

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
| **Phase B：Agent 多模态看图** | `imagen_inspect` 缩略图回看（按 LLM 视觉能力门控）+ Agent 评估与改词提示词规范 | 视觉模型能读懂 `imagen_batch` 产出图并指出具体缺陷、给出下一轮改进提示词 |
| **Phase C：探索模式与对比交互** | `ui_propose_explore` 预算护栏 + 聊天流多图对比挑选交互 + 「选定继续变体」一键回流 | 用户授权 1 次探索预算后，自动完成「抽卡 → 选优 → 变体」闭环并支持随时中止 |
