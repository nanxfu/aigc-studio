/**
 * 全仓唯一契约源（Host / Web Client / Daemon 注入配置共用）。
 *
 * 约定：
 *  - 本文件只允许纯数据与纯函数，不得 import `node:*` 或任何运行时模块，
 *    否则会被打进浏览器 bundle。
 *  - 凡是「跨文件 / 跨端共享」的量（路由、错误码、参数边界、预设、协议字段）都写在这里，
 *    其它位置只能引用，不得重新定义。
 *  - 修改后运行 `node test/check-contract.mjs`：它校验 Host 路由注册、客户端文案、
 *    daemon 版本与文档表格是否跟随本文件。
 *  - 远端 daemon 无法 import JS，由 `lib/kernel.js` 把 `daemonContract()` 的返回值
 *    随注入配置下发（见 `remote/daemon.py` 的 config 解析）。
 */

import { LOCAL_MODELS, localModelById } from './local-models.js'

export { BUILTIN_LOCAL_ENGINES, LOCAL_MODELS, localModelById, localModelsForTask } from './local-models.js'

/**
 * 产品版本：与 `package.json.version` 对齐，只用于 UI / Release / 日志展示。
 *
 * 与协议版本分离的原因：私有 Worker 是独立部署的长驻服务，如果每发一次客户端都要
 * 同步升级 Worker，「长驻」就失去意义。产品版本可以自由前进，协议版本只在
 * Host↔Worker 字段/语义不兼容时才提升主版本。
 */
export const APP_VERSION = '0.16.0'

/**
 * Host ↔ Worker 协议版本（语义化）。
 *
 * 单源在这里，由 `daemonContract().version` 下发给远端，并由
 * `tools/gen-contract-json.mjs` 生成 `worker/contract.json`。
 * 握手规则（M3.1 起生效）：主版本不同 → 拒绝发送任务；同一主版本、Worker 次版本更高
 * → 允许并忽略不认识的 capability；Worker 缺少 Host 必需能力 → 降级或提示升级。
 *
 * 0.15.0 及以前的远端 daemon 把产品版本当协议版本用；2.0.0 是该字段的第一次语义切换，
 * 因此主版本直接取 2。
 */
export const PROTOCOL_VERSION = '2.0.0'

/**
 * 兼容别名：历史代码与界面仍按 `VERSION` 读取产品版本。
 * 新代码一律使用 `APP_VERSION`（产品）或 `PROTOCOL_VERSION`（协议），不要再用它表示协议。
 */
export const VERSION = APP_VERSION

/**
 * Host HTTP 路由表（index.js 注册时必须逐一对应）。
 * `path` 为宿主注册的绝对路径；客户端请求用 `clientPath()` 得到相对路径，
 * 保持与改动前完全一致的解析方式（`new URL(relative, document.baseURI)`）。
 */
export const ROUTES = {
  state: { method: 'GET', path: '/api/state' },
  probe: { method: 'POST', path: '/api/probe' },
  // 远端运行日志（把 daemon 的日志环透传给工作台日志抽屉）。
  logs: { method: 'GET', path: '/api/logs' },
  sessionStart: { method: 'POST', path: '/api/session/start' },
  sessionStop: { method: 'POST', path: '/api/session/stop' },
  generate: { method: 'POST', path: '/api/generate' },
  job: { method: 'GET', path: '/api/job' },
  // 取消任务：queued / waiting-session 立即出队失效；running 合作式停止（见 JOB_CANCEL）。
  jobCancel: { method: 'POST', path: '/api/job/cancel' },
  jobs: { method: 'GET', path: '/api/jobs' },
  // 历史分页：limit / offset 查询参数，响应补 hasMore（向后兼容只读 items 的旧客户端）。
  history: { method: 'GET', path: '/api/history' },
  // 版本树：按根作品路径（root，工作区相对路径）返回整棵派生树，供作品条版本面板按需展开。
  // 旧宿主没有该路由时客户端按 404 降级为「仅用已加载分页」。
  historyTree: { method: 'GET', path: '/api/history/tree' },
  file: { method: 'GET', path: '/api/file' },
  // 本地图片导入（阶段十五 Phase A）：用户选择的 PNG / JPEG 落盘到产物目录并登记为导入作品。
  importFile: { method: 'POST', path: '/api/import' },
  library: { method: 'GET', path: '/api/library' },
  libraryFavorite: { method: 'POST', path: '/api/library/favorite' },
  libraryDelete: { method: 'POST', path: '/api/library/delete' },
  // 资产工坊（M4.2a/b）：
  //  - save：把本机确定性算子的产物（主图 + 附属通道）落成一个新的复合资产作品，继承版本树；
  //  - export：把某个作品目录整包导出为 ZIP（纯 JS createZip，不新增依赖）；
  //  - vectorize：把 outputs/ 内的 PNG 矢量化为 SVG（Host 侧 Node WASM，0 Python / 0 GPU）；
  //  - op：提交 GPU 后处理算子（remove-bg / pbr）到现有串行任务队列。
  workshopSave: { method: 'POST', path: '/api/workshop/save' },
  workshopExport: { method: 'GET', path: '/api/workshop/export' },
  workshopVectorize: { method: 'POST', path: '/api/workshop/vectorize' },
  workshopOp: { method: 'POST', path: '/api/workshop/op' },
  // 端侧 L2 视觉感知：客户端提交 256×256 RGB 像素，Host 用本机 ONNX 编码后返回
  // 与 L1 同口径的场景 / Noul / 专业度；失败时客户端静默保留 L1。
  workshopPerceive: { method: 'POST', path: '/api/workshop/perceive' },
  // 感知打标持久化（Phase 2.5）：把已收敛的场景 / 推荐摘要写回作品 meta.json。
  // 单图作品更新 meta.workshopPerception，多图批次按文件名记入 meta.workshopPerceptions[file]；
  // 不改变图片、参数或版本树字段。
  workshopTag: { method: 'POST', path: '/api/workshop/tags' },
  // 本机端侧模型统一管理（视觉感知 / 本机抠图）：清单与状态查询、预下载、清理、自定义目录、二进制读取。
  localModels: { method: 'GET', path: '/api/local-models' },
  localModelDownload: { method: 'POST', path: '/api/local-models/download' },
  localModelDelete: { method: 'POST', path: '/api/local-models/delete' },
  localModelToggle: { method: 'POST', path: '/api/local-models/toggle' },
  localModelsDir: { method: 'POST', path: '/api/local-models/dir' },
  localModelFile: { method: 'GET', path: '/api/local-models/file' },
  localModelsHardware: { method: 'GET', path: '/api/local-models/hardware' },
  enhance: { method: 'POST', path: '/api/enhance' },
  intent: { method: 'POST', path: '/api/intent' },
  reveal: { method: 'POST', path: '/api/reveal' },
  // 运行设置抽屉：GET 读脱敏视图（hfToken 只回布尔与来源），POST 保存用户覆盖项。
  settings: { method: 'GET', path: '/api/settings' },
  settingsSave: { method: 'POST', path: '/api/settings' },
  // 工作台界面状态（高级设置折叠等）：GET 读归一化视图，POST 合并保存白名单字段。
  uiState: { method: 'GET', path: '/api/ui-state' },
  uiStateSave: { method: 'POST', path: '/api/ui-state' },
  // Kaggle 直连登录（试验特性）：GET 读登录态，POST 按 action 发起 / 取消 / 提交授权码。
  kaggleLogin: { method: 'GET', path: '/api/kaggle/login' },
  kaggleLoginAction: { method: 'POST', path: '/api/kaggle/login' },
  // Colab Google OAuth 登录：GET 读登录态与授权摘要，POST 按 action 发起 / 取消 / 提交回调或授权码。
  colabLogin: { method: 'GET', path: '/api/colab/login' },
  colabLoginAction: { method: 'POST', path: '/api/colab/login' },
  // 桌面端工作区（Phase 1）：GET 读当前工作区 + 最近列表 + 是否可切换；POST 切换工作区。
  // 同一 path 注册一条路由、handler 内按 method 分发（与 settings / ui-state 同形）。
  workspace: { method: 'GET', path: '/api/workspace' },
  workspaceSwitch: { method: 'POST', path: '/api/workspace' },
  // 全局应用设置（Phase 1，存系统 userData 而非工作区）：GET 读脱敏视图（LLM Key 只回布尔），
  // POST 合并保存白名单字段（ui / llm / clearLlmApiKey / workspace / update）。
  appSettings: { method: 'GET', path: '/api/app-settings' },
  appSettingsSave: { method: 'POST', path: '/api/app-settings' },
  // 只读版本检查（M2.8 阶段 B）：POST 手动触发一次检查；自动检查关闭时也可用。
  // NSIS 安装态由主进程独占更新，本路由回 `{ mode: 'electron' }` 占位。
  updateCheck: { method: 'POST', path: '/api/update/check' },
  // 创作 Agent 对话（Phase 1）：POST 触发一次工具循环；stream !== false 时返回 SSE。
  agentChat: { method: 'POST', path: '/api/agent/chat' },
  // 创作助手对话历史（按工作区持久化至 `<workspace>/.aigc-studio/chat.json`，跨客户端重启保留）。
  chatHistory: { method: 'GET', path: '/api/chat' },
  chatHistorySave: { method: 'POST', path: '/api/chat' },
  // 模型列表（Phase A）：Host 代理各厂商 /models，失败降级为 pi-ai 内置目录。
  llmModels: { method: 'POST', path: '/api/llm/models' },
  // 私有 Worker 连接探测（M3.1）：入参 { endpointUrl, token? }，返回脱敏的
  // phase / protocolVersion / hardware / 错误码；设置抽屉「测试连接」使用。
  workerProbe: { method: 'POST', path: '/api/worker/probe' },
  // SaladCloud 连接探测（M3.6）：用未保存的 API Key / org / project 只读校验账号与配额，
  // 不创建容器组；响应只含组织、项目、配额与容器名，不回 Key。
  saladProbe: { method: 'POST', path: '/api/salad/probe' },
  // 本机 GPU 可视化配置与探测（M3.4 架构收敛）：读写 <userData>/local-gpu.json 并支持设备探测。
  localGpuConfig: { method: 'GET', path: '/api/local-gpu/config' },
  localGpuConfigSave: { method: 'POST', path: '/api/local-gpu/config' },
  localGpuProbe: { method: 'POST', path: '/api/local-gpu/probe' },
  localGpuSetup: { method: 'GET', path: '/api/local-gpu/setup' },
  localGpuSetupAction: { method: 'POST', path: '/api/local-gpu/setup' },
}

/** 客户端请求用的相对路径（与改造前 `request('imagen-api/state')` 完全同形）。 */
export function clientPath(route) {
  return route.path.replace(/^\//, '')
}

/**
 * 参数硬性约束与自动钳制（Host `lib/jobs.js` 与 Client `src/logic/*` 共用）。
 * 值是"钳制边界"而不是"校验报错边界"：越界一律自动校正，见 docs/SPEC.md §2.2。
 */
export const LIMITS = {
  prompt: { maxChars: 2000 },
  negativePrompt: { maxChars: 1000 },
  width: { min: 256, max: 1536, step: 8 },
  height: { min: 256, max: 1536, step: 8 },
  steps: { min: 1, max: 60 },
  cfg: { min: 0, max: 20 },
  count: { min: 1, max: 4 },
  // 图生图（M3）参考图：maxBytes 是原始图片字节上限（Host 与 daemon 双重校验，
  // 受 `remoteGenerateMaxBytes`（base64 后体积）约束）；解码后长边超过 maxEdge 由远端
  // 按比例缩小（不超过 minEdge 的图直接拒绝），避免小图放大出噪点、大图占显存。
  reference: { maxBytes: 8 * 1024 * 1024, maxEdge: 1536, minEdge: 128 },
  // 模型原生参考生图（阶段十五 Phase C1，`supportsReference`）的独立口径：
  // 与 `reference` 的单图垫图（img2img / 局部重绘，尺寸跟随参考图）完全隔离——
  // 原生参考走基础管线 `image=[PIL...]` 条件，宽高严格取请求值，没有 strength / mask 语义。
  //  - maxCount：单次请求的参考图张数上限（真机实测：1 张 1024² 约 21~22s、2 张约 31s、
  //    3 张约 52s，耗时近似线性而显存几乎不增；参考收益主要来自 1~2 张，因此收紧到 2，
  //    真机探针数据见 docs/INFERENCE_ACCELERATION_RESEARCH.md 与 CHANGELOG）；
  //  - maxBytes：单张原始字节上限。模型内部已按约 1 MP 面积缩放，超过 4 MiB 对成片没有
  //    额外价值；2×4 MiB 的 base64 约 11.2 MB，仍落在 TIMEOUTS.remoteGenerateMaxBytes
  //    （32 MB）预算内，不需要放宽 Host / daemon 的全局请求体上限（见 lib/jobs/reference-loader.js
  //    的总体积前置校验与 remote/config.py 的 request_body_limit 推导）。
  //  - maxEdge：执行期解码后长边上限；模型内部还会按约 1 MP 面积等比缩放，
  //    因此这里按「长边 ≤ 1024」近似 1 MP 预算，避免把大图原样塞进 CPU 侧预处理；
  //  - minEdge：长边下限（与 `reference` 语义一致：宽、高都不会小于它才不会被放大成噪点）。
  // 下发远端：daemonContract().limits.referenceImages（详见 remote/config.py 的 request_body_limit）。
  referenceImages: { maxCount: 2, maxBytes: 4 * 1024 * 1024, maxEdge: 1024, minEdge: 128 },
  // 重绘强度：越小越贴近原图，越大越放飞；首期只对 SDXL 家族（supportsImg2Img）开放。
  // 上限按场景区分：`max` 是普通垫图（img2img）的保守上限，避免把原图丢得太狠；
  // `inpaintMax` 是带蒙版局部重绘的上限——9 通道 inpaint 模型在全重绘时需要更高替换力度，
  // 只放宽这一档，img2img 行为完全不变。
  strength: { min: 0.2, max: 0.9, inpaintMax: 1.0, step: 0.05, default: 0.6 },
  // 局部重绘（Inpaint）蒙版：客户端导出的黑白 PNG（白 = 重绘区域，黑 = 保留区域），
  // 与参考图一起提交；尺寸由远端按参考图精确对齐，因此这里只管字节上限与最小覆盖率。
  // `minCoverage` 是「白色重绘像素占全图的最小比例」：低于它的蒙版视为空蒙版直接拒绝
  // （错误码 invalid_request，远端在加载模型前失败），全白（整图重绘）必须放行。
  // 0.0005 = 0.05%：挡掉误传全黑蒙版这类「整图重绘但实际没有涂抹区域」的请求。
  // 单独成项而不挂在 reference 下：远端 limit_spec() 只按「单层数值键」合并兜底值。
  mask: { maxBytes: 2 * 1024 * 1024, minCoverage: 0.0005 },
  // Kaggle / torch 侧接受 32 位有符号正整数；两端必须用同一个上界，否则用户输入的
  // seed 会被宿主静默取模改写，导致「带回参数」复现不出同一张图。
  seed: { max: 2147483647 },
  waitSeconds: { min: 0, max: 600, default: 90 },
  queue: { maxPending: 20, maxKept: 60 },
  // pageSize 是前端「加载更多」每次请求的固定步长，取契约上限 100：
  // Host 的 limit 仍按 maxLimit 钳制，旧客户端只传 limit 时行为不变。
  history: { defaultLimit: 30, maxLimit: 100, pageSize: 100 },
  jobs: { defaultLimit: 20, maxLimit: 100 },
  historyTool: { defaultLimit: 5, maxLimit: 30 },
  libraryDelete: { maxPaths: 200 },
  // Agent 批量创作（imagen_batch）：单次对话最多规划多少条任务。
  // 队列本身另有 maxPending 上限，两者叠加后不会把云端排队撑爆。
  batch: { maxItems: 8 },
  intentText: { maxChars: 2000 },
  // 对话多轮上下文：客户端只回传最近若干条消息，Host 路由再裁剪一次，
  // 避免把整段聊天记录塞进模型（也约束请求体大小）。
  intentHistory: { maxMessages: 12, maxMessageChars: 2000 },
}

/**
 * 本地图片导入（`POST /api/import`，阶段十五 Phase A）的共享口径。
 *
 * 导入图后续要作为局部重绘 / 整图重绘的底图，因此沿用参考图那套体积与长边边界，
 * 不再单独定义第二份数值；字段与格式只在这里登记一次，Host 与 Client 都从这里取。
 */
export const IMPORT = {
  // 只接受这两种位图：PNG 无损失、JPEG 是相机/截图最常见的格式。
  mimeTypes: ['image/png', 'image/jpeg'],
  // 解码后的原始字节上限（与图生图参考图一致，Host 同时受请求体上限约束）。
  maxBytes: LIMITS.reference.maxBytes,
  // 长边上限 / 短边下限（宽、高都要 >= minEdge，避免把小图放大成噪点）。
  maxEdge: LIMITS.reference.maxEdge,
  minEdge: LIMITS.reference.minEdge,
  // 展示名上限：只用于 meta.prompt 与列表标题，不参与落盘路径。
  maxNameChars: 120,
}

/**
 * 高清放大（阶段十五 Phase B1，`tool: 'upscale'`）的共享口径。
 *
 * 远端走轻量超分（Real-ESRGAN RRDBNet x2，纯 torch 权重，不占扩散模型显存），
 * 输入是画廊里已有的一张作品，输出固定 `factor` 倍，作为该作品的派生子版本。
 *
 * 为什么用「长边」限制而不是宽高独立限制：2× 之后输出长边翻倍，2560 已接近
 * 隧道单次轮询能稳定传回的体量（PNG base64 约 7~10 MB）；输入上限 1280 同时
 * 覆盖工作台默认的 1:1（1024）与 16:9（1280×720）画幅，超过时要用户先缩小画幅。
 *
 * 数值随 `daemonContract().limits.upscale` 下发远端，Host / Client 引用同一份。
 */
export const UPSCALE = {
  // 记录到 meta.presetId 的超分模型标识（不是可选的扩散预设，不进模型选择器）。
  id: 'realesrgan-x2plus',
  factor: 2,
  maxInputEdge: 1280,
  maxOutputEdge: 2560,
}

/**
 * 扩图（阶段十五 Phase B2，`tool: 'outpaint'`）的共享口径。
 *
 * 本常量只约束客户端的扩图画布几何（画布尺寸、原图内容框、上限与默认强度），
 * 因此不进入 `daemonContract()`。真正的远端推理分两代：
 *  - 现代引擎（阶段十六起，默认路径）：`OUTPAINT_ENGINE` 的纯绿画布 + `flux2-klein-4b`
 *    Outpaint LoRA 条件生图；
 *  - 历史回退：把新增区域涂白生成蒙版按普通局部重绘提交（9 通道 `sdxl-inpaint` 已在
 *    阶段十七下线，旧历史记录仍可能带 `outpaint` 元数据，回填逻辑统一按非扩散产物处理）。
 */
export const OUTPAINT = {
  // 快捷比例胶囊（顺序即界面顺序）：source = 跟随原图比例、四边扩 20%。
  expandId: 'source',
  // 目标画幅比例胶囊（canvas 以该比例为准，原图等比缩放后居中）。
  ratioIds: ['16:9', '9:16', '4:3'],
  // 「四边扩 20%」= 画布尺寸 ×1.2（每边 10%）。
  expandRatio: 1.2,
  // 画布长边 / 总像素上限：1536×1024 量级，与远端 width/height 契约上限对齐，
  // 也保证免费卡（2×T4 / L4）上现代扩图引擎不 OOM（真机验收见 CHANGELOG）。
  maxEdge: 1536,
  maxPixels: 1600000,
  minEdge: 256,
  // 扩图覆盖面积大，默认走满步数；契约的带蒙版上限是 1.0。
  strength: 1.0,
  // 扩图产物原图内容框（`outpaintContent`，归一化 0~1、相对画布左上角，4 位小数）：
  // 随提交请求 → meta.json → HistoryItem 透传，供「对比原图」拉帘把原图放回它在
  // 扩图画布里的真实位置（画布可能比原图更大、且原图位置可按锚点偏移）。
  // 只属于 Host/Client，不经 `daemonContract()` 下发远端。
  content: { fields: ['x', 'y', 'width', 'height'], precision: 4 },
}

/**
 * 现代扩图引擎配置（阶段十六真机验证通过：FLUX.2 Klein 4B + fal Outpaint LoRA，绿边画布法）。
 *
 * Client 导出 `#00FF00` 纯绿留白画布（长边缩至 `referenceMaxEdge` 以内），Host 按 `presetId`
 * 将 `lora` 与 `referenceImages` 组装进远端请求；用户未填补充描述时发送固定指令 `prompt`，
 * 填写了则拼接追加（不会污染 `meta.params.prompt`）。
 */
export const OUTPAINT_ENGINE = Object.freeze({
  presetId: 'flux2-klein-4b',
  lora: Object.freeze({
    repo: 'fal/flux-2-klein-4B-outpaint-lora',
    weight: 'flux-outpaint-lora.safetensors',
    scale: 1.1,
  }),
  prompt: 'Fill the green spaces according to the image',
  green: '#00FF00',
  referenceMaxEdge: LIMITS.referenceImages.maxEdge,
})

/**
 * 商业 API 视频生成（M4.1）的共享口径。
 *
 * 只属于 Host/Client：视频任务走 `cloud-api` 的异步提交 → 轮询 → 下载，不进入
 * `daemonContract()`。`duration` / `resolutions` / `ratios` 是界面与适配层共用的边界，
 * 具体模型可用档位以 `shared/image-providers.js` 的视频目录为准（模型可能只支持其中一部分）。
 */
export const VIDEO = {
  maxCount: 1,
  duration: { min: 5, max: 15, step: 1, default: 5 },
  resolutions: Object.freeze(['480p', '768p']),
  ratios: Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']),
  // 提交接口是短请求；生成耗时靠轮询状态接口等待，单次轮询与总预算分开。
  requestTimeoutMs: 60000,
  pollIntervalMs: 3000,
  pollTimeoutMs: 15 * 60 * 1000,
  // 下载护栏：15 秒 768p 的 MP4 通常 10–40 MB，留足余量同时防止异常响应写爆磁盘。
  downloadMaxBytes: 128 * 1024 * 1024,
}

/** 产物媒体类型（meta.json / HistoryItem / Stage 共用）。旧数据缺省按 image。 */
export const MEDIA_TYPES = Object.freeze(['image', 'video', 'mesh3d'])

/**
 * 资产工坊（M4.2a / M4.2b）的共享口径：页面工具、复合资产包通道、本机确定性算子与
 * 两款 GPU 后处理算子的边界。
 *
 * 与其它常量的分层：
 *  - `tools` / `channels` / `save` / `export` 属于 Host 与 Client：工坊页用它渲染工具条、
 *    校验提交体，Host 的 `/api/workshop/*` 路由按同一份白名单落盘；
 *  - 本机算子（`pixel` / `sprite` / `tile` / `vector`）只在渲染进程与 Host 的 Node 侧执行，
 *    不下发远端；
 *  - GPU 算子（`cutout` / `pbr`）的边界随 `daemonContract().limits.workshop` 下发远端，
 *    daemon 在加载模型前先按它校验请求，避免非法载荷进入显存。
 *
 * 复合资产包（`meta.json.channels[]`）约定：主图仍是 `images[0]`（画廊/胶片条只占一张卡），
 * 其余加工产物登记在 `channels[]`（角色 + 相对文件名 + 像素尺寸 + 标签）。通道文件与主图
 * 同目录，导出 ZIP 时整目录打包；旧产物没有该字段，读取端按空数组处理。
 *
 * 场景化引导（M4.2c）追加 `scenes` / `professionalThreshold`：`scenes` 是感知层的取值域，
 * 也是 `models/*.json` 可选字段 `sceneTags` 的校验白名单；阈值是「普通通用图」的判定线。
 * 两者都不参与落盘，也不改变 `tools` 的工具 id 与保存契约。
 */
export const WORKSHOP = {
  /** 工坊左侧工具条：id 同时写进 `meta.workshopTool`，客户端与 Host 共用。 */
  tools: Object.freeze(['pixel-snap', 'sprite-slice', 'tile', 'vectorize', 'cutout', 'pbr']),
  /**
   * 场景化引导（M4.2c）的六类作品场景：感知层输出的 Choice 原语取值域。
   *
   * 顺序即界面上的场景切换条顺序（从最普通到最专业）：感知层、词典与测试共用这一份清单，
   * 避免三处各写一套字符串。
   */
  scenes: Object.freeze([
    'illustration_or_photo',
    'isolated_prop',
    'pixel_art',
    'sprite_sheet',
    'seamless_texture',
    'flat_icon_logo',
  ]),
  /**
   * 专业资产倾向度阈值：`professionalScore` 低于它按「普通通用图」处理——收起
   * 「游戏与 3D 专项」分组，并在完整画作上给出返回创作台的引导。
   *
   * 取 0.45 与专项规划 §3.1 的接口注释一致（§2.2 早期的 0.4 是草稿值，以本常量为唯一口径）。
   */
  professionalThreshold: 0.45,
  /**
   * 端侧 L2 视觉感知（M4.2c Phase 2）。
   *
   * 模型权重不随安装包分发：Host 首次感知时按固定 URL / revision / SHA-256 下载到
   * `<workspace>/.aigc-studio/models/mobileclip-s0/`，之后复用同一 ONNX Session。
   * 客户端只上传 256×256 RGB 的 base64（约 256 KB），不新增 Host 图片解码依赖。
   *
   * `license.kind: 'other'` 是刻意的：MobileCLIP 权重受 Apple 的 ML-MobileCLIP 许可约束，
   * 不应在界面或文档里宣称可商用。模型只用于本机可选的静默感知，失败不影响任何工具。
   */
  vision: {
    model: 'mobileclip-s0-fp16',
    repo: 'Xenova/mobileclip_s0',
    revision: '757d59c9c6870a76a4b0306f05f5061bca15c39f',
    asset: 'onnx/vision_model_fp16.onnx',
    url: 'https://huggingface.co/Xenova/mobileclip_s0/resolve/757d59c9c6870a76a4b0306f05f5061bca15c39f/onnx/vision_model_fp16.onnx',
    sha256: '22b1d36ecc6837e8205aee05003440a25e1c1ee0c7e2945dbb9dd597211c59dc',
    bytes: 22_876_479,
    imageSize: 256,
    // 256×256×3 的 base64 为 262144 字节；留 128 KB 给 JSON 字段与未来兼容。
    maxBodyBytes: 384 * 1024,
    // L2 只有同时过 top1 与 top1-top2 间隔才会覆盖 L1 场景；否则只保留为辅助证据。
    sceneMinConfidence: 0.5,
    sceneMinMargin: 0.12,
    // Noul 二分类概率离 0.5 超过该间隔才允许参与 L1 / L2 融合。
    noulMinConfidence: 0.66,
    downloadTimeoutMs: 120_000,
    failureCooldownMs: 60_000,
    license: {
      name: 'Apple ML-MobileCLIP License',
      kind: 'other',
      commercial: 'unverified',
    },
  },
    /**
     * 感知打标持久化（Phase 2.5）。
     *
     * `tagVersion` 是 L1 判定口径 + L2 模型 / 静态锚点的联合版本：任何会影响最终
     * 场景、Noul 或推荐排序的变更都必须递增它。旧作品上的标签会因版本不匹配被读取端
     * 当作 null，客户端按冷启动重新计算并覆写。
     */
    perception: {
      tagVersion: 1,
    },
  /** 复合资产包的通道清单：主图之外允许出现的加工产物类型。 */
  channels: {
    // 单次保存最多带几个附属通道（PBR 四通道 + SVG + atlas 已够用）。
    maxCount: 8,
    // 单个通道的字节上限（PNG / SVG / JSON 同一口径）。
    maxBytes: 8 * 1024 * 1024,
    roles: Object.freeze([
      'cutout',
      'albedo',
      'normal',
      'roughness',
      'metallic',
      'svg',
      'atlas',
      'spritesheet',
      'pixel',
      'tile',
      'other',
    ]),
    formats: Object.freeze(['png', 'svg', 'json']),
  },
  /** 保存到作品库（`POST /api/workshop/save`）的请求体边界。 */
  save: {
    maxPrimaryBytes: 12 * 1024 * 1024,
    maxTotalBytes: 40 * 1024 * 1024,
    maxNameChars: 120,
  },
  /** 导出 ZIP（`GET /api/workshop/export`）的护栏：整个作品目录打包。 */
  export: {
    maxFiles: 24,
    maxBytes: 128 * 1024 * 1024,
  },
  /** 像素对齐（Pixel-Unslop）：边缘周期网格自动探测 + Oklab 调色盘量化。 */
  pixel: {
    maxInputEdge: 2048,
    grid: { min: 1, max: 256, default: 1 },
    colors: { min: 2, max: 64, default: 16 },
    alphaThreshold: { min: 0, max: 255, default: 128 },
    scale: { min: 1, max: 16, default: 1 },
  },
  /** 序列帧切片：网格切片 + 逐帧预览 + `atlas.json`。 */
  sprite: {
    maxInputEdge: 4096,
    rows: { min: 1, max: 16, default: 4 },
    cols: { min: 1, max: 16, default: 4 },
    maxFrames: 64,
    minFrameEdge: 8,
    trimAlpha: true,
    // 逐帧动画的默认帧间隔（毫秒），仅影响预览，不进产物。
    frameMs: { min: 20, max: 2000, default: 120 },
  },
  /** 2×2 无缝平铺检查与混边（纯本机 canvas）。 */
  tile: {
    repeat: 2,
    maxPreviewEdge: 1024,
    blendRatio: { min: 0.02, max: 0.45, default: 0.1 },
    // 接缝判定阈值：左右/上下边 RGB 平均绝对差（MAE）不超过它视为可平铺。
    seamlessThreshold: 12,
  },
  /** SVG 矢量化：Host 侧 Node 执行（@visioncortex/vtracer WASM），0 Python / 0 GPU。 */
  vector: {
    maxInputEdge: 2048,
    colorPrecision: { min: 1, max: 8, default: 6 },
    filterSpeckle: { min: 0, max: 16, default: 4 },
    colormode: Object.freeze(['color', 'binary']),
    hierarchy: Object.freeze(['stacked', 'cutout']),
    mode: Object.freeze(['spline', 'polygon']),
  },
  /**
   * 抹除背景（GPU Worker）：默认 `BiRefNet`（MIT 免登录开箱即用），可选 `RMBG-2.0`（质量优先，非商用且 HF 受限仓库需授权）。
   * 仅作协议标签提示，不弹窗阻断；界面在模型卡/工具提示里展示 `license` / `licenseKind`。
   */
  cutout: {
    op: 'remove-bg',
    defaultModel: 'birefnet',
    models: Object.freeze([
      {
        id: 'birefnet',
        repo: 'ZhengPeng7/BiRefNet',
        label: 'BiRefNet',
        grade: '免登录 · 极速',
        license: 'MIT',
        licenseKind: 'open',
        note: '可商用 · 开箱即用',
      },
      {
        id: 'rmbg-2.0',
        repo: 'briaai/RMBG-2.0',
        label: 'RMBG-2.0',
        grade: '质量优先',
        license: '非商用',
        licenseKind: 'non-commercial',
        gated: true,
        note: '需先在 HF 同意协议并填 Token',
      },
    ]),
    maxInputEdge: 1536,
    minInputEdge: 128,
    maxBytes: 8 * 1024 * 1024,
  },
  /**
   * PBR 材质拆解（GPU Worker）：`Marigold` 为 diffusers 原生基线，`Ubisoft CHORD` 为研究许可的
   * 3A 级 SVBRDF 拆解；两者输出同一套四通道契约，界面按包装展示协议标签。
   */
  pbr: {
    op: 'pbr',
    defaultModel: 'marigold',
    models: Object.freeze([
      {
        id: 'marigold',
        repo: 'prs-eth/marigold-iid-appearance-v1-1',
        label: 'Marigold',
        grade: '原生基线',
        license: 'Apache-2.0',
        licenseKind: 'open',
        note: 'diffusers 原生管线',
      },
      {
        id: 'chord',
        repo: 'ubisoft/ubisoft-laforge-chord',
        label: 'Ubisoft CHORD',
        grade: '研究',
        license: '研究许可',
        licenseKind: 'research',
        note: '仅限研究 / 非商用',
      },
    ]),
    channels: Object.freeze(['albedo', 'normal', 'roughness', 'metallic']),
    steps: { min: 1, max: 8, default: 4 },
    maxInputEdge: 1024,
    minInputEdge: 256,
    maxBytes: 8 * 1024 * 1024,
  },
}


/**
 * 推理加速开关（阶段十五 Phase C1 脚手架，对应 docs/INFERENCE_ACCELERATION_RESEARCH.md 的 P0 项）。
 *
 * 模型资产 `pipeline.accel` 只允许出现下列布尔键；缺省（整块省略）表示全部关闭，
 * 代码路径必须与改造前逐字一致。开关只在真机 A/B 数据确认后才会写进 models/*.json，
 * 本常量是 build-assets 校验与远端 loader 的唯一键名清单（远端 Python 无法 import JS，
 * 由 `remote/inference/loaders/diffusers.py` 的 ACCEL_FLAGS 镜像，check-contract 校验两边同名）：
 *  - vaeTiling / vaeSlicing：所有 diffusers 家族通用的 VAE 解码省显存（无损）；
 *  - channelsLast：SDXL UNet 切 NHWC 内存排布（T4 Tensor Core 访存友好，无损）；
 *  - fuseQkv：SDXL UNet 合批 Q/K/V 投影（无损，只能 fuse 一次，from_pipe 派生管线复用同一 UNet）。
 */
export const PIPELINE_ACCEL_KEYS = Object.freeze(['vaeTiling', 'vaeSlicing', 'channelsLast', 'fuseQkv'])

/**
 * 任务请求的 `tool` 取值：前三类经 `POST /api/generate` 提交，工坊的两类 GPU 后处理算子
 * （`remove-bg` / `pbr`）经 `POST /api/workshop/op` 提交，但进的是同一个串行任务队列，
 * 因此队列、validator 与远端协议共用这一份取值域。
 */
export const REQUEST_TOOLS = Object.freeze(['generate', 'upscale', 'outpaint', 'remove-bg', 'pbr'])

/** 宿主与远端之间共享的超时（毫秒）。远端层不再各自保留默认值。 */
export const TIMEOUTS = {
  // 远端 HTTP
  remoteHealthMs: 4000,
  remoteLogsMs: 4000,
  // 设置抽屉「测试连接」：用户主动触发的单次探测，比后台心跳多留一点余量。
  workerProbeMs: 5000,
  // 生成任务：远端改为异步 job（POST /generate 只入队，GET /job 轮询）。
  // 提交与轮询都是短请求，长耗时只存在于远端队列里，隧道/代理不会因为长连接空闲掐断。
  remoteSubmitMs: 15000,
  remoteJobRequestMs: 8000,
  remoteJobPollMs: 2000,
  // 单个任务整体预算（可在配置里用 generateTimeoutSeconds 覆盖）。
  remoteJobMs: 600000,
  // 出图轮询容错（P0-A3）：隧道重建期间 GET /job 会成串失败，旧实现在第 6 次
  // 连续失败（约 12~60 秒）就判任务失败，把仍在远端算图的任务判死。改为按
  // 「连续失败持续时长」容忍，并在窗口用尽后用同一 jobId 幂等重投接回任务。
  remoteJobPollFailureGraceMs: 120000,
  // 失败重试的指数退避上限：隧道重建期不打满远端，恢复后又能快速接上。
  remoteJobPollBackoffMaxMs: 8000,
  // 幂等重投次数上限：daemon 保留窗口为 600s / 最多 8 个已完成 job，
  // 超窗重投会重新入队出图（重复消耗 GPU），所以必须限次。
  remoteJobResumeMaxAttempts: 2,
  remoteShutdownMs: 3000,
  remoteGenerateMaxBytes: 32 * 1024 * 1024,
  // 二进制产物下载（协议 v2）：单张整体预算、断点续传重试次数与体积上限。
  // 体积上限同时是「误连到非 Worker 服务」的护栏：256MB 足够 8K PNG，不会把磁盘写满。
  remoteArtifactMs: 180000,
  remoteArtifactRetries: 2,
  remoteArtifactMaxBytes: 256 * 1024 * 1024,
  // ntfy 会合轮询单次请求
  ntfyPollMs: 8000,
  // 会话状态机
  sessionTickMs: 3000,
  kernelPollMs: 30000,
  healthyPollMs: 10000,
  readyHealthMissesBeforeCheck: 3,
  reconnectMaxAttempts: 1,
  recoveryMs: 120000,
  // 恢复窗口续期上限：ready 失联后每向 Kaggle 确认一次 Kernel 仍 RUNNING，
  // 就把 recoveryMs 窗口续期一轮；续期用尽仍恢复不了才判定 health_failed。
  // 总兜底时长约 recoveryMs + recoveryMaxRenewals × kernelPollMs（约 7 分钟），
  // 避免隧道重建稍久就杀掉一个仍在 RUNNING 的 Kernel（重新排队代价很高）。
  recoveryMaxRenewals: 10,
  // 排队分级提示：本机历史日志里 6 次正常会话从推送完成到隧道会合约 14–22 秒
  // （从会话启动算 18–30 秒）；样本很小，只用于挑提示阈值，不代表 Kaggle 排队的普遍保证。
  // 超过慢档只更新一句状态提示（不打断用户），超过卡住档才建议换新实例重排（不自动执行）。
  // 两档都可以被插件配置覆盖（见 index.js 的 queueSlowMinutes / queueStalledMinutes）。
  queueSlowMs: 3 * 60 * 1000,
  queueStalledMs: 10 * 60 * 1000,
  provisionMs: 45 * 60 * 1000,
  tunnelMs: 15 * 60 * 1000,
  sessionWaitMs: 45 * 60 * 1000,
  idleShutdownSec: 1800,
  // Kernel 启动后等待宿主接管的时限（秒）：超过仍没有收到任何带 Token 的 Host 请求，
  // daemon 自行退出。用于回收「放弃排队后仍被调度到」的孤儿 Kernel，避免空转到
  // idleShutdownSec 才释放 GPU 配额。
  kernelClaimSec: 600,
  kernelRunMaxSec: 10800,
  // 宿主本地动作
  revealWaitMs: 1500,
  bodyMaxBytes: 256 * 1024,
  // kaggle CLI
  cliMs: 30000,
  cliQuotaMs: 20000,
  cliPushMs: 180000,
  cliLogsMs: 45000,
  cliOutputMs: 180000,
  // 客户端
  clientProbeMs: 45000,
  clientStatePollMs: 10000,
  clientStateActivePollMs: 2000,
  clientLogsPollMs: 2000,
}

/**
 * 算力来源注册表（Host / Client / 模型资产共用的能力域）。
 *
 * 与 `SETTINGS.providers` 的分工：
 *  - 本表是**全部已知来源**与能力位：模型资产 `providers` 字段、Agent 目录过滤、
 *    错误文案判断都以它为准；
 *  - `SETTINGS.providers` 只包含 `enabled === true` 的来源，是**当前产品允许选择**的
 *    集合（设置抽屉、设置校验、`/api/state.provider` 的取值域）。
 *    M3.1 私有 Worker 可运行、M3.4 本机 GPU 可用后再把对应项翻成 true，
 *    避免提前暴露一个「点了就报未实现」的选项。
 *
 * 能力位（provider 契约见 server/providers/provider.js）：
 *  - kind：`notebook` = 临时实例，需要推送/会合/关机；`worker` = 长驻服务，固定地址；
 *    `cloud-api` = 商业生图 API，没有会话可管理，提交任务时直接请求厂商并下载成图；
 *  - reattach：进程重启后能凭会话记录接管（notebook 靠 Kernel 状态，worker 靠 /health）；
 *  - pendingCleanup：卸载时可能留下需要补清理的远端资源（notebook 关机 / 本机进程）；
 *  - remoteShutdown：teardown 可以向远端发 /shutdown（共享 Worker 默认只断开）；
 *  - idleTimeout：由 Host 下发空闲自动关机秒数；
 *  - logs：提供远端日志尾（readLogs）；
 *  - binary/events：协议 v2 的二进制产物与 SSE 事件流能力（M3.1/M3.2 实现）。
 */
export const PROVIDERS = Object.freeze({
  kaggle: Object.freeze({
    kind: 'notebook',
    group: 'cloud-gpu',
    enabled: true,
    reattach: true,
    pendingCleanup: true,
    remoteShutdown: true,
    idleTimeout: true,
    logs: true,
    binary: true,
    events: true,
  }),
  colab: Object.freeze({
    kind: 'notebook',
    group: 'cloud-gpu',
    enabled: true,
    reattach: true,
    pendingCleanup: true,
    remoteShutdown: true,
    idleTimeout: true,
    logs: true,
    binary: true,
    events: true,
  }),
  // SaladCloud 按秒容器（M3.6）：由 Host 创建容器组，Worker 直接经 Container Gateway 暴露。
  // - 没有持久卷，模型由 hf-xet 在任务命中时现场拉到容器临时盘；
  // - Host 负责创建 / 重调度 / 删除容器组，所以 owned=true、pendingCleanup=true；
  // - 应用异常退出后不接管旧实例，启动补清理会删除残留容器组，避免持续计费；
  // - 远端进程本身就是 Worker，因此 binary / events 能力与私有 Worker 相同。
  salad: Object.freeze({
    kind: 'worker',
    group: 'cloud-gpu',
    enabled: true,
    reattach: false,
    pendingCleanup: true,
    remoteShutdown: false,
    idleTimeout: false,
    logs: true,
    binary: true,
    events: true,
    owned: true,
  }),
  'private-worker': Object.freeze({
    kind: 'worker',
    group: 'private',
    enabled: true,
    reattach: true,
    pendingCleanup: false,
    remoteShutdown: false,
    idleTimeout: false,
    logs: true,
    binary: true,
    events: true,
  }),
  'local-gpu': Object.freeze({
    kind: 'worker',
    group: 'private',
    // M3.4：Vulkan / stable-diffusion.cpp 本机常驻桥已接通；配置缺失时在「连接」阶段
    // 明确报「未配置」，不在模型列表 / 任务队列里静默失败。
    enabled: true,
    // 本机进程不是长驻外部服务：应用退出后由 Host 回收，不能按旧端口尝试接管。
    reattach: false,
    pendingCleanup: true,
    remoteShutdown: true,
    idleTimeout: true,
    logs: true,
    binary: true,
    events: true,
    // owned：Worker 进程由 Host 启动/停止（本机 GPU），共享私有 Worker 没有该位。
    owned: true,
  }),
  // 商业生图 API（M3.5 Phase A）：没有远端会话可管理，0 秒就绪、按张计费。
  //  - reattach / pendingCleanup / remoteShutdown / idleTimeout：一律 false；
  //  - binary / events：不适用（成图由 Host 直接下载并落盘，不走 Worker 协议 v2）；
  //  - logs：Host 侧没有远端日志环，readLogs 返回 null。
  'cloud-api': Object.freeze({
    kind: 'cloud-api',
    group: 'cloud-api',
    enabled: true,
    reattach: false,
    pendingCleanup: false,
    remoteShutdown: false,
    idleTimeout: false,
    logs: false,
    binary: false,
    events: false,
  }),
})

/**
 * 算力来源的心智分组（设置页 UI 分组单源）：
 *  - cloud-gpu：云端 GPU（Kaggle / Colab 免费与订阅实例；租卡容器可在私有 Worker 中通过端点接入）
 *  - cloud-api：云 API（无状态商业生图接口，按张计费）
 *  - private：私有部署（本机 GPU 直连 + 远程私有 Worker）
 */
export const PROVIDER_GROUPS = Object.freeze([
  Object.freeze({ id: 'cloud-gpu', providers: Object.freeze(['kaggle', 'colab', 'salad']) }),
  Object.freeze({ id: 'cloud-api', providers: Object.freeze(['cloud-api']) }),
  Object.freeze({ id: 'private', providers: Object.freeze(['local-gpu', 'private-worker']) }),
])

/** 全部已知算力来源 id（含尚未开放选择的）。 */
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS))

/** 当前产品允许选择的算力来源（`SETTINGS.providers` 的取值）。 */
export const ENABLED_PROVIDER_IDS = Object.freeze(PROVIDER_IDS.filter((id) => PROVIDERS[id].enabled))

/**
 * 运行设置（工作台设置抽屉 ↔ Host 设置存储 `lib/settings.js` 共用的唯一来源）。
 *
 * 设置项只在宿主侧注入远端；本文件只登记「字段边界与取值域」，不存任何界面文案
 * （accelerator 的展示名由客户端字典 `studio.settings.accelerator.<id>` 维护）。
 */
export const SETTINGS = {
  // 空闲自动关机：秒。quickMinutes 是客户端快捷档位（分钟），自定义输入按 min/max 钳制。
  idleTimeoutSec: { min: 300, max: 10800, quickMinutes: [15, 30, 60, 120] },
  // GPU 加速器白名单：值必须是 `kaggle kernels push` 接受的 accelerator 名称。
  accelerators: ['NvidiaTeslaT4', 'NvidiaTeslaP100'],
  defaultAccelerator: 'NvidiaTeslaT4',
  // 高级项上限：数组/映射最多 32 项，单条最长 256 字符。
  maxItems: 32,
  maxItemChars: 256,
  // `publicSettingsView()` 的脱敏字段取值域：settings=用户在抽屉里设置的，config=宿主插件配置。
  hfTokenSources: ['settings', 'config', 'none'],
  // Kaggle 访问方式：direct = Node 直连 Kaggle JSON API + 内置 OAuth 登录（默认，无需本机
  // kaggle CLI）；cli = 调用本机 `kaggle` CLI（兼容退路，排障或直连不可用时手动切回）。
  // 切换在下次操作/唤醒时生效，不需要重载插件。数组顺序即设置抽屉里的选项顺序。
  kaggleTransports: ['direct', 'cli'],
  defaultKaggleTransport: 'direct',
  // 远端算力来源（当前可选集合，= PROVIDERS 里 enabled 的项）：kaggle 默认；colab 需要先完成
  // 一次 Google 授权（tools/colab/probe-auth.mjs），且只在 Colab Pro 账号下有意义（免费档
  // 申请不到 L4/A100）。切换在下次唤醒/启动时生效。
  // private-worker 需要先在设置里填写地址与 Token；local-gpu 需要在应用数据目录放
  // local-gpu.json（或设置 AIGC_STUDIO_LOCAL_GPU_* 环境变量）后才能连接。
  providers: [...ENABLED_PROVIDER_IDS],
  defaultProvider: 'kaggle',
  // Colab 可用加速器：必须在 assign 接口接受的白名单内；H100 等按账号权益可能被后端 400。
  colabGpus: ['T4', 'L4', 'A100', 'G4'],
  defaultColabGpu: 'L4',
}

/**
 * 商业生图 API（M3.5 Phase A）的配置边界。
 *
 * 与 `SETTINGS.providers` 的关系：`cloud-api` 是一个算力来源，具体厂商 / 模型 /
 * 端点 / Key 是它的连接参数，存在应用级 app-config 与加密凭据里（不跟随工作区）。
 * 服务商与模型清单的唯一来源是 `shared/image-providers.js`，这里只定字段长度与超时。
 */
export const IMAGE_API = {
  // 模型 id 与自定义 Base URL 的长度上限（防手改超长字符串拖慢请求 / 日志）。
  modelMaxChars: 200,
  baseUrlMaxChars: 500,
  apiKeyMaxChars: 500,
  // 单次请求预算：同步端点（硅基流动 / OpenAI）与 fal 队列的轮询总预算分开。
  requestTimeoutMs: 180000,
  pollIntervalMs: 2000,
  pollTimeoutMs: 300000,
  // 成图下载上限：单张 32MB（与远端请求体同量级），防止误连到非图片服务写满磁盘。
  downloadMaxBytes: 32 * 1024 * 1024,
}

/**
 * SaladCloud 容器算力（M3.6）的共享边界。
 *
 * 设置里只暴露「稳定性 / 价格档位」，具体显卡目录由 Host 根据模型显存与档位选择，
 * 不进入主设置面。`AIGC_STUDIO_SALAD_GPU` 仅作为排障时的隐藏覆盖项。
 */
export const SALAD = Object.freeze({
  apiBaseUrl: 'https://api.salad.com/api/public',
  // 档位 id 与 Salad priority 同名；默认 medium 是压测里性价比与等待时间的平衡点。
  tierIds: Object.freeze(['high', 'medium', 'low', 'batch']),
  defaultTier: 'medium',
  orgPattern: /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
  projectPattern: /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
  defaultProject: 'default',
  apiKeyMaxChars: 512,
  idMaxChars: 64,
  // 真机压测锁定的欧美高带宽区；不限地区时镜像拉取曾出现 900s 卡死。
  countryCodes: Object.freeze(['us', 'ca', 'de', 'nl', 'gb']),
  workerPort: 8765,
  workerImage: 'ghcr.io/nanxfu/aigc-worker:manual-c758bad',
  storageGb: 80,
  lightStorageGb: 50,
  memoryMb: 16384,
  heavyMemoryMb: 24576,
  cpu: 4,
  // downloading / creating 超过该时长才触发 reallocate（免费换机），避免误伤正常冷启动。
  reallocateAfterMs: 180000,
  maxReallocations: 3,
  // 容器从创建到 running 的总预算：超时由 Provider 抛 queue_timeout，状态机随即删除容器，
  // 避免节点一直 downloading 时白烧 45 分钟。
  provisionDeadlineMs: 15 * 60 * 1000,
  requestTimeoutMs: 15000,
})

/**
 * Kaggle 直连登录（试验特性）的共享口径：`GET/POST /api/kaggle/login`。
 *
 * POST 用 `action` 区分动作：`start` 发起浏览器授权（本地回环回调收码），`cancel` 取消等待，
 * `submit-code` 在浏览器打不开 / 无头环境时用粘贴授权码兜底；GET 恒为当前登录态。
 * 登录成功后凭据写入 `~/.kaggle/credentials.json`（OAuth，含 refresh_token），
 * 与 CLI 2.x 的 `kaggle auth login` 完全同格式。
 */
export const KAGGLE_LOGIN = {
  actions: ['start', 'cancel', 'submit-code'],
  // idle 未开始 / pending 等待浏览器授权 / done 成功 / failed 失败 / cancelled 用户取消
  states: ['idle', 'pending', 'done', 'failed', 'cancelled'],
  // browser = 拉起本机浏览器 + 本地回环回调；manual = 复制授权链接 + 粘贴授权码。
  modes: ['browser', 'manual'],
  // 客户端轮询登录态的间隔；host 等待授权的总时限（超时转 failed，可重新发起）。
  pollMs: 1500,
  timeoutMs: 5 * 60 * 1000,
}

/** Colab Google OAuth 登录与 Kaggle 直连登录共用同一套状态机契约。 */
export const COLAB_LOGIN = KAGGLE_LOGIN

/**
 * 工作台界面状态的持久化口径（`<workspace>/.imagen/ui-state.json`）。
 *
 * 界面态只是体验优化，不是业务数据：只允许下列白名单字段，字段类型与默认值由这里决定，
 * Host（归一 / 落盘）与 Client（初始化 / 归一）共同引用，未登记的字段一律丢弃。
 * 文件损坏、超限或不存在都回落到默认值，绝不影响出图主链路。
 */
export const UI_STATE = {
  version: 1,
  defaults: {
    // 表单「高级设置」折叠区是否展开：默认收起，没有记录时也回落到 false。
    advancedOpen: false,
  },
  // 落盘文件大小上限：超过按损坏记录处理（界面态丢失不影响出图）。
  maxBytes: 64 * 1024,
}

/**
 * 创作助手对话历史落盘边界（`<workspace>/.aigc-studio/chat.json`）。
 *
 * Host 与 Client 共用同一条数上限；超限或损坏时回落空列表，不影响出图主链路。
 */
export const CHAT_HISTORY = {
  version: 1,
  maxMessages: 50,
  maxBytes: 256 * 1024,
}

/**
 * 画面比例 id 的唯一来源。
 *
 * 前端 `src/studio/presets.js` 只保留「id → 像素」数据，顺序与合法取值以本文件为准；
 * `lib/intent.js` 校验模型返回的比例也引用这里。
 *
 * 0.10.0 起移除静态「风格预设」：风格由提示词内容与模型本身表达，
 * 不再有 STYLE_IDS / styleId 这套暗箱后缀机制。
 */
export const RATIO_IDS = ['1:1', '16:9', '9:16', '4:3', '3:4']

/**
 * 对话意图解析（`POST /api/intent`）的结构边界。
 *
 * Host 按这里归一模型输出，Client 不重复校验；改结构时同步 `docs/SPEC.md` 与测试。
 */
export const INTENT = {
  // 中文摘要只进界面，给用户的确认信息，写太长没有意义。
  summaryMaxChars: 400,
  // 通用澄清：一条问题 + 2~4 个选项（点击后作为新一轮用户输入重新解析）。
  clarifyMinOptions: 2,
  clarifyMaxOptions: 4,
  clarifyQuestionMaxChars: 80,
  clarifyOptionMaxChars: 40,
  // 模型建议：只允许合法预设 id，且不能是当前预设。
  modelHintReasonMaxChars: 80,
  // M3.5 Phase B：Agent 视觉回看（imagen_inspect）单次注入工具结果的图片体积上限。
  // 保持 Host 零图像依赖（不引入 sharp / jimp）：直接读产物字节转 base64，靠上限护栏控制 Token。
  // 1024² PNG 通常 1~3MB；2MB 上限足以覆盖大多数产物，超限时返回明确原因让模型改用文字信息。
  inspectMaxBytes: 2 * 1024 * 1024,
  // 单次 inspect 最多附加的预览图数量（与一次 batch 的常见产出对齐）。
  inspectMaxImages: 4,
  // M3.5 Phase C：探索模式（ui_propose_explore）硬预算上限，防止无限循环烧额度。
  exploreMaxRoundsMin: 1,
  exploreMaxRoundsMax: 4,
  exploreMaxImagesMin: 1,
  exploreMaxImagesMax: 16,
  exploreStrategyMaxChars: 400,
  exploreCostMaxChars: 80,
}

/**
 * 错误码词表（唯一来源）。
 *
 * layer 说明：
 *  - host：宿主 index.js / lib 产生，必须配客户端文案；
 *  - remote：远端 daemon 产生，Host 透传给客户端，必须配客户端文案；
 *  - client：客户端本地合成（网络层 / 交互校验），由客户端自己解释。
 * status 仅对 host 有意义：异常响应的 HTTP 状态码。
 * 客户端文案键为 `error.code.<code>`，缺一条 `test/check-contract.mjs` 会失败。
 */
export const ERROR_CODES = {
  // ---- Host ----
  invalid_body: { layer: 'host', status: 400 },
  invalid_request: { layer: 'host', status: 400 },
  invalid_prompt: { layer: 'host', status: 400 },
  invalid_path: { layer: 'host', status: 400 },
  too_many: { layer: 'host', status: 400 },
  not_found: { layer: 'host', status: 404 },
  output_missing: { layer: 'host', status: 404 },
  reveal_failed: { layer: 'host', status: 500 },
  internal_error: { layer: 'host', status: 500 },
  // 资产工坊的本机矢量转换（@visioncortex/vtracer WASM）不可用：依赖缺失或加载失败。
  // 只影响 SVG 导出这一条纯本机能力，其余工坊算子与出图主链路不受影响。
  vectorizer_unavailable: { layer: 'host', status: 503 },
  // 工坊 L2 视觉感知不可用：模型下载 / 校验 / ONNX Runtime 初始化失败，或用户显式关闭。
  // 客户端必须静默保留 L1，不把它当成操作失败，也不让工坊工具链降级。
  vision_unavailable: { layer: 'host', status: 503 },
  // 本机端侧模型统一管理：未登记模型返回 404，下载 / 校验 / 读取失败返回 503。
  local_model_not_found: { layer: 'host', status: 404 },
  local_model_unavailable: { layer: 'host', status: 503 },
  // 远端日志拉取失败：会话在但 daemon 不可达 / 协议漂移，客户端降级展示原因。
  logs_unavailable: { layer: 'host' },
  queue_full: { layer: 'host', status: 400 },
  stopped: { layer: 'host' },
  session_absent: { layer: 'host' },
  session_timeout: { layer: 'host' },
  session_error: { layer: 'host' },
  empty_result: { layer: 'host' },
  generate_failed: { layer: 'host' },
  disposed: { layer: 'host' },
  auth_required: { layer: 'host' },
  cli_missing: { layer: 'host' },
  cli_timeout: { layer: 'host' },
  push_failed: { layer: 'host' },
  queue_timeout: { layer: 'host' },
  tunnel_timeout: { layer: 'host' },
  health_failed: { layer: 'host' },
  remote_error: { layer: 'host' },
  session_ended: { layer: 'host' },
  unknown: { layer: 'host' },
  // ---- Host：桌面客户端新增（Phase 1）----
  // 本地 HTTP 层的同源校验失败（带 Origin 且与监听地址不一致；开发态放宽）。
  forbidden_origin: { layer: 'host', status: 403 },
  // 工作区：有活跃任务时拒绝切换 / 目录不可用（不存在、不可创建、不可写）。
  workspace_busy: { layer: 'host', status: 409 },
  workspace_unavailable: { layer: 'host', status: 409 },
  // 创作助手模型（/api/app-settings、/api/enhance、/api/agent/chat）：
  // 未配置可降级为本地兜底，因此不是致命错误；配置错误按 4xx/5xx 透传原因。
  llm_not_configured: { layer: 'host', status: 503 },
  llm_http_error: { layer: 'host' },
  llm_provider_error: { layer: 'host' },
  llm_no_fetch: { layer: 'host' },
  // 模型调用链路的网络层错误（server/llm/request.js 抛出，经 /api/agent/chat 原样透传）：
  //  - llm_network_error：DNS / TCP / TLS / 代理失败，请求未拿到任何 HTTP 响应；
  //  - llm_aborted：调用方取消（AbortSignal）或请求超时，属于可重试的中断而非上游错误。
  llm_network_error: { layer: 'host', status: 502 },
  llm_aborted: { layer: 'host', status: 408 },
  agent_failed: { layer: 'host', status: 502 },
  // 算力驱动占位（Phase 2：私有 Worker / 本机 GPU）在未实现时返回的明确错误码。
  provision: { layer: 'host' },
  teardown: { layer: 'host' },
  capability: { layer: 'host' },
  // ---- Host：私有 Worker（M3.1 起使用，M3.0 先登记码值与文案）----
  // 用户可执行的下一步见 M3_PRIVATE_WORKER_AND_MCP_PLAN.md §3.5：
  //  - worker_unreachable：检查地址 / 容器 / 防火墙 / SSH 隧道；
  //  - worker_unauthorized：重新填写 Token；
  //  - protocol_mismatch：升级 Worker 或客户端；
  //  - capability_missing：换模型或升级 Worker（缺工具 / 加载器）；
  //  - artifact_failed：产物下载或哈希校验失败，可重试。
  worker_unreachable: { layer: 'host' },
  worker_unauthorized: { layer: 'host' },
  protocol_mismatch: { layer: 'host' },
  capability_missing: { layer: 'host' },
  artifact_failed: { layer: 'host' },
  // ---- Host：商业生图 API（M3.5 Phase A）----
  // 与 Worker 错误分开，客户端才能给出「去设置填 Key / 充值 / 换模型」这类可执行指引：
  //  - image_api_not_configured：还没选服务商 / 填 Key，属于配置缺失而不是调用失败；
  //  - image_api_unauthorized：Key 缺失、错误或没有该模型权限；
  //  - image_api_rate_limited：厂商限流 / 并发超限，可稍后重试；
  //  - image_api_insufficient_balance：余额不足（硅基流动 30001 等），去充值或换免费算力；
  //  - image_api_unsupported：当前厂商 / 模型不支持该能力（扩图、超分、参考图等）；
  //  - image_api_failed：其余上游失败（5xx / 响应格式异常 / 成图下载失败）。
  image_api_not_configured: { layer: 'host', status: 400 },
  image_api_unauthorized: { layer: 'host', status: 401 },
  image_api_rate_limited: { layer: 'host', status: 429 },
  image_api_insufficient_balance: { layer: 'host', status: 402 },
  image_api_unsupported: { layer: 'host', status: 400 },
  image_api_failed: { layer: 'host', status: 502 },
  // ---- Host：商业视频 API（M4.1）----
  // 与生图错误码分开，客户端才能把「视频模型 / 时长 / 首尾帧」的失败原因说清楚：
  //  - video_api_not_configured / unauthorized / rate_limited / insufficient_balance 语义同上；
  //  - video_api_unsupported：模型不支持该能力（例如 T2V 传了首帧、参考图超过模型上限）；
  //  - video_api_failed：上游失败、任务失败、轮询超时或视频下载失败。
  video_api_not_configured: { layer: 'host', status: 400 },
  video_api_unauthorized: { layer: 'host', status: 401 },
  video_api_rate_limited: { layer: 'host', status: 429 },
  video_api_insufficient_balance: { layer: 'host', status: 402 },
  video_api_unsupported: { layer: 'host', status: 400 },
  video_api_failed: { layer: 'host', status: 502 },
  // ---- Remote daemon ----
  unauthorized: { layer: 'remote' },
  load_failed: { layer: 'remote' },
  // 任务表里没有该 id（/job、/artifact 共用）：已过期或从未提交。
  unknown_job: { layer: 'remote' },
  // 二进制产物不存在 / 已随任务淘汰：明确终态，Host 不无限重试。
  artifact_not_found: { layer: 'remote' },
  // 共享 Worker 未开启远程关机（启动时未加 --allow-shutdown）。
  shutdown_disabled: { layer: 'remote' },
  // SSE 并发流超过上限（默认 4 条）。
  too_many_streams: { layer: 'remote' },
  // 受限模型（Hugging Face gated repo）：需要先同意许可并配置有访问权限的 HF Token。
  // 与 load_failed 分开，客户端才能给出「去模型页 / 去设置」的指引而不是笼统重试。
  model_gated: { layer: 'remote' },
  generation_failed: { layer: 'remote' },
  oom: { layer: 'remote' },
  // 远端容器没拿到 GPU（torch.cuda.is_available() 为 False）：Kaggle 会静默降级成 CPU，
  // 必须先明确报错，不能继续用 CPU 硬跑导致超时或模糊的 CUDA 报错。
  gpu_unavailable: { layer: 'remote' },
  // ---- Client ----
  warming: { layer: 'client' },
  timeout: { layer: 'client' },
  network: { layer: 'client' },
  need_prompt: { layer: 'client' },
  delete_failed: { layer: 'client' },
  probe_failed: { layer: 'client' },
  // 应用内更新状态错误码（M2.8 阶段 B）：出现在 `/api/state.update` 与 `UpdateState.error`，
  // 不是 HTTP 响应 envelope；用户文案在 `studio.update.error.*`（server/update-check.js、
  // server/update-source.js、electron/updater.mjs 共用）。
  offline: { layer: 'client' },
  dns: { layer: 'client' },
  http_401: { layer: 'client' },
  http_403: { layer: 'client' },
  http_404: { layer: 'client' },
  http_429: { layer: 'client' },
  http_5xx: { layer: 'client' },
  checksum: { layer: 'client' },
  signature: { layer: 'client' },
  feed_invalid: { layer: 'client' },
  disk_full: { layer: 'client' },
  permission: { layer: 'client' },
  unsupported_form: { layer: 'client' },
  state_unknown: { layer: 'client' },
  state_stale: { layer: 'client' },
  session_active: { layer: 'client' },
  queue_active: { layer: 'client' },
  not_downloaded: { layer: 'client' },
}

/** 宿主通过 HTTP 返回的错误码（含远端透传）。 */
export function hostErrorCodes() {
  return Object.entries(ERROR_CODES)
    .filter(([, value]) => value.layer === 'host' || value.layer === 'remote')
    .map(([code]) => code)
}

/**
 * 取消语义（`POST /api/job/cancel`，请求体 `{ id }`）。
 *
 * 响应始终带 `job` 与 `disposition`：
 *  - `dequeued`：queued / waiting-session 立即出队失效，不再占用队列位置，
 *    后续任务不必等到 45 分钟会话等待窗口超时才继续；若取消的是最后一个等待启动的
 *    任务，且当前会话由任务自动拉起，宿主同时放弃这轮启动（手动唤醒的会话保持）；
 *  - `cooperative`：running 只置 `cancelRequested` 标记，当前这张图画完后不再提交
 *    批内剩余张数（不强杀线程、不改远端采样回调），之后收敛为 cancelled；
 *  - `already-finished`：任务已是终态，取消请求不改变任何状态。
 */
export const JOB_CANCEL = {
  dispositions: ['dequeued', 'cooperative', 'already-finished'],
}

/**
 * 提示词增强通道的两种模式（`POST /api/enhance` 的 `mode`，缺省 `refine`）。
 *
 *  - `refine`：按模型配方重写/精炼英文主稿，并给出动态微调方向（支持多选揉合），
 *    响应 `{ ok, source, prompt, groups, note? }`；
 *  - `translate`：把提示词转成英文，响应 `{ ok, mode, source, prompt, note? }`；
 *    `source: 'local'` 表示未配置（`llm_unconfigured`）或模型调用失败（`llm_unavailable`），
 *    前端不得把原文本当作成功结果展示。
 * 两种模式都只复用宿主已配置的模型，不接第三方重模型。
 */
export const ENHANCE_MODES = ['refine', 'translate']

/**
 * 日志与诊断的共享口径（Host `lib/routes/logs.js` 与 Client `src/logic/logs.js` 共用）。
 */
export const LOGS = {
  // 远端 daemon 日志环与客户端保留行数上限。
  remoteLineLimit: 400,
  // GET /logs 下发的 Host 本地日志尾部行数上限（Host 路由与客户端归一都按它）。
  hostLineLimit: 120,
  // 诊断文本附带的行数：远端可多给一些，Host 更短以控制粘贴长度。
  diagRemoteTail: 120,
  diagHostTail: 80,
}

/**
 * 诊断环境指纹（`GET /logs` 响应体的 `env` 字段，仅供前端诊断报告使用）。
 *
 * 只允许非敏感信息：布尔开关、版本号与毫秒耗时摘要；严禁出现代理 URL、Token、
 * 工作区绝对路径与 prompt 正文。`timings` 字段由 Host 按会话快照计算：
 *  - sessionStartMs：startedAt → readyAt 的就绪耗时（未就绪为 null）；
 *  - sessionUptimeMs：startedAt → now；
 *  - readyUptimeMs：readyAt → now。
 */
export const DIAGNOSTICS = {
  envFields: ['platform', 'nodeVersion', 'hasProxyEnv', 'hasFallbackTunnel', 'hasCustomDatasets', 'hasPipConstraints', 'hasHfToken'],
  timingFields: ['sessionStartMs', 'sessionUptimeMs', 'readyUptimeMs'],
}

/**
 * 远端 daemon 协议（Host 客户端与 daemon 实现共用）。
 * daemon 侧字段见 remote/daemon.py 顶部说明；这里是唯一的字段/取值清单。
 *
 * 注入配置的键由 `lib/session/provisioner.js` 的 buildKernelConfig 组装，
 * daemon 侧的接受清单是 `remote/daemon.py` 的 _KNOWN_CONFIG_KEYS——两处各管一端，
 * 本文件不再维护第三份副本。
 */
export const PROTOCOL = {
  daemon: {
    routes: {
      // 免鉴权存活探针：只回 {"ok":true}（Docker healthcheck / 负载均衡用）。
      healthz: { method: 'GET', path: '/healthz' },
      health: { method: 'GET', path: '/health' },
      logs: { method: 'GET', path: '/logs' },
      generate: { method: 'POST', path: '/generate' },
      // 异步 job：POST /generate 只入队并返回 job_id，Host 用 GET /job?id= 轮询。
      job: { method: 'GET', path: '/job' },
      // 协议 v2：二进制产物（单段 Range + ETag）与 SSE 事件流。
      artifact: { method: 'GET', path: '/artifact' },
      events: { method: 'GET', path: '/events' },
      shutdown: { method: 'POST', path: '/shutdown' },
    },
    // `POST /generate.result_mode` 的取值域：inline 为旧 Host 兼容默认，binary 走 /artifact。
    resultModes: ['inline', 'binary'],
    // `GET /events` 的事件类型；data 形状见 SPEC §「远端协议 v2」。
    eventTypes: ['job', 'state'],
    // 事件流上限：超出时 429 too_many_streams（与 worker/events.py 一致）。
    maxEventStreams: 4,
    // 重放窗口：Last-Event-ID 最多回放最近多少条。
    eventReplayMax: 200,
    // /health.phase 的完整取值域；未知值按 warming 处理。
    healthPhases: ['booting', 'installing', 'loading', 'ready', 'error'],
    ntfyEvents: ['ready', 'error'],
    // 隧道提供方：cloudflare = quick tunnel 默认通道；custom = 用户配置的备用命令
    // （自建 FRP / 其他 HTTPS 隧道）。ready 事件与 /health 用同一组取值。
    tunnelProviders: ['cloudflare', 'custom'],
    // 远端 `/generate` 接受的 tool 取值：outpaint 在远端就是「带蒙版的局部重绘」，
    // 不单列；Host 请求里的 tool 见 REQUEST_TOOLS（outpaint 由 Host 展开成 generate；
    // remove-bg / pbr 是工坊的 GPU 后处理算子，走同一个远端 job 协议与结果形状）。
    requestTools: ['generate', 'upscale', 'remove-bg', 'pbr'],
    // 原生参考生图（supportsReference）的 job 级载荷形状：Host 以 `referenceImages: [{ image_b64 }]`
    // 下发（数组长度 ≤ limits.referenceImages.maxCount），逐项只认 image_b64——没有 strength /
    // mask 语义，与 `reference`（单图垫图）是两条互斥的请求形状。daemon 侧实现在
    // remote/inference/reference_codec.py 的 parse_reference_images / decode_reference_images。
    referenceImages: { field: 'referenceImages', itemFields: ['image_b64'] },
  },
}

/**
 * 模型预设目录：唯一数据来源是仓库根目录的 models/*.json。
 *
 * 修改模型请编辑 models/<id>.json，然后运行 `npm run models:build` 生成
 * `shared/models.generated.js`；本文件只做 re-export，不在这里手写预设数据。
 * `node test/check-contract.mjs` 会校验生成文件是否与 models/ 同步。
 *
 * 每个预设的 `pipeline` 是下发给远端 Daemon 的加载描述（字段见 remote/daemon.py
 * 顶部说明）：Daemon 不认识预设 id，只按 loader 分支加载，因此新增预设不需要改 Python。
 */
import { PRESETS, PUBLIC_PRESETS } from './models.generated.js'
import { cloudPresetById } from './image-providers.js'

export { PRESETS }

export const DEFAULT_PRESET = 'sdxl-lightning'

/**
 * 按 id 取预设；未知 id 回退到默认项。
 *
 * M3.5 起额外接受云端预设 id（`cloud:<vendor>:<model>`）：它不在 models/*.json 里，
 * 但同样要能被 JobQueue / 参数区 / 模型卡解析，避免为商业 API 再维护第二条目录。
 */
export function presetById(id) {
  return PRESETS.find((item) => item.id === id)
    ?? cloudPresetById(id)
    ?? PRESETS.find((item) => item.id === DEFAULT_PRESET)
}

/** 面向 Client 的精简视图（去掉下发远端用的 pipeline 细节，避免双份真相）。 */
export function publicPresets() {
  return PUBLIC_PRESETS.map((preset) => ({ ...preset }))
}

/**
 * 下发给远端 daemon 的契约子集（经 lib/kernel.js 注入为 `config.contract`；
 * 同一份对象由 `tools/gen-contract-json.mjs` 落盘为 `worker/contract.json` 供 mock 使用）。
 *
 * 只保留 Python 容器实际消费的元数据：`daemon.py` 读取 `contract.version`
 * （**协议版本**，不再是产品版本）与 `contract.limits`（_limit_spec / _max_tasks）。宿主路由、
 * health phase、ntfy 事件、historyTool 与错误码都只属于 Host/Client，不下发远端。
 */
export function daemonContract() {
  return {
    version: PROTOCOL_VERSION,
    limits: {
      width: LIMITS.width,
      height: LIMITS.height,
      steps: LIMITS.steps,
      cfg: LIMITS.cfg,
      count: LIMITS.count,
      seed: LIMITS.seed,
      prompt: LIMITS.prompt,
      negativePrompt: LIMITS.negativePrompt,
      // 图生图的参考图边界与重绘强度：daemon 依此校验请求（来源与 Host 同一份契约）。
      reference: LIMITS.reference,
      // 原生参考生图（supportsReference）的独立边界：张数 / 单张字节 / 长边上下限。
      // 与 reference 互斥（同一个请求只能走其中一条），daemon 的请求体上限按两者较大形状推导。
      referenceImages: LIMITS.referenceImages,
      strength: LIMITS.strength,
      // 局部重绘蒙版边界（与参考图一起下发；daemon 请求体上限也按它推导）。
      mask: LIMITS.mask,
      // 高清放大（tool=upscale）的输入/输出长边上限与放大倍数：远端据此校验源图并回报比例。
      upscale: UPSCALE,
      // 资产工坊的 GPU 后处理算子边界（tool=remove-bg / pbr）：远端在加载模型前按它校验
      // 源图长边、字节上限、PBR 步数与通道清单；通道数上限同时约束落盘侧的 `channels[]`。
      workshop: {
        cutout: {
          maxInputEdge: WORKSHOP.cutout.maxInputEdge,
          minInputEdge: WORKSHOP.cutout.minInputEdge,
          maxBytes: WORKSHOP.cutout.maxBytes,
        },
        pbr: {
          maxInputEdge: WORKSHOP.pbr.maxInputEdge,
          minInputEdge: WORKSHOP.pbr.minInputEdge,
          maxBytes: WORKSHOP.pbr.maxBytes,
          steps: WORKSHOP.pbr.steps,
          channels: WORKSHOP.pbr.channels,
        },
        channels: { maxCount: WORKSHOP.channels.maxCount },
      },
    },
  }
}
