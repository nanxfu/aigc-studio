/**
 * Host 资源访问层：把「哪个端点、什么方法、什么请求体」收在一处。
 *
 * 约定：
 *  - 每个函数只做 URL / 方法 / JSON body / 查询串拼装，返回值与 src/api.js 的 request()
 *    完全相同（{ ok, status, code, message } 或 { ok, status, data }），不引入新的 envelope；
 *  - 失败不抛异常，错误码与 message 原样交给调用方，由 UI 层决定 toast / 指引卡；
 *  - 路径唯一来源是 routePath(name)（shared/contract.js 的 ROUTES），这里不写路径字面量。
 */

import { LIMITS } from '../../shared/contract.js'

import { request, routePath, apiUrl, authHeaders } from '../api.js'
import { loginActionBody } from '../logic/kaggleLogin.js'

/** Host 状态快照（轮询用）。 */
export function fetchState() {
  return request(routePath('state'), { method: 'GET' })
}

/**
 * 远端运行日志增量拉取；since 为上次响应的 next（非负整数，从 0 开始）。
 * Host 始终回 HTTP 200，可用性看响应体的 ok（见 logic/logs.js 的 readLogsPayload）。
 */
export function fetchLogs(since = 0) {
  const cursor = Number.isFinite(Number(since)) && Number(since) > 0 ? Math.floor(Number(since)) : 0
  return request(`${routePath('logs')}?since=${cursor}`, { method: 'GET' })
}

/**
 * 历史分页：limit 每次取契约页长，offset 是已跳过的有效记录数（从 0 开始）。
 * 响应 `{ items, limit, offset, hasMore }` 由 useWorkLibrary 消费。
 */
export function fetchHistory(limit = LIMITS.history.pageSize, offset = 0) {
  const size = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(LIMITS.history.maxLimit, Math.floor(Number(limit)))
    : LIMITS.history.pageSize
  const start = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Math.floor(Number(offset)) : 0
  return request(`${routePath('history')}?limit=${size}&offset=${start}`, { method: 'GET' })
}

/** 收藏库列表。 */
export function fetchLibrary() {
  return request(routePath('library'), { method: 'GET' })
}

/**
 * 版本树按需拉取：`GET /history/tree?root=&limit=`（阶段十三）。
 *
 * 返回 `{ ok, data: { root, items, hasMore } }`；`items` 与 /history 同形，
 * 调用方直接并入已加载分页即可。旧宿主没有该路由时返回 HTTP 404
 * （`status: 404` / `code: 'http_404'`），由调用方降级成「仅用已加载分页」
 * 并在版本面板提示不可用，这里不做特殊处理。
 *
 * root 必须是 Host 归一过的 `imagen-output/<目录>/<文件>` 相对路径；
 * 空串直接返回失败、不发请求（Host 会回 400，但没必要多跑一趟）。
 */
export function fetchHistoryTree(root, limit = LIMITS.history.pageSize) {
  const value = typeof root === 'string' ? root.trim() : ''
  if (!value) {
    return Promise.resolve({ ok: false, status: 0, code: 'invalid_request', message: 'root 不能为空' })
  }
  const size = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(LIMITS.history.maxLimit, Math.floor(Number(limit)))
    : LIMITS.history.pageSize
  return request(`${routePath('historyTree')}?root=${encodeURIComponent(value)}&limit=${size}`, { method: 'GET' })
}

/**
 * 启动云端会话。
 *
 * - forceNew=true：跳过接管旧排队，强制推送新 Kernel；
 * - replace=true：换新实例重排，Host 会删除排不上的旧 Kernel 再推新 Kernel。
 *
 * 旧 Host 不识别 replace 时按普通启动处理（忽略未知字段），客户端不做额外分支。
 */
export function startSession(presetId, options = {}) {
  const body = { presetId }
  if (options && options.forceNew === true) body.forceNew = true
  if (options && options.replace === true) body.replace = true
  return request(routePath('sessionStart'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** 关闭云端会话。 */
export function stopSession() {
  return request(routePath('sessionStop'), { method: 'POST' })
}

/** 提交一次生成任务。 */
export function submitGenerate(body) {
  return request(routePath('generate'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * 取消任务；响应 `{ ok, job, disposition }`，disposition ∈ dequeued | cooperative | already-finished。
 * 路径只能走契约的 ROUTES.jobCancel，这里不写路径字面量。
 */
export function cancelJob(id) {
  return request(routePath('jobCancel'), {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}

/**
 * 环境探测；signal 由调用方提供（45 秒超时与 AbortController 留在 useStudio）。
 */
export function runProbe(signal) {
  return request(routePath('probe'), {
    method: 'POST',
    ...(signal ? { signal } : {}),
  })
}

/**
 * 提示词增强：
 *  - `mode='refine'`（缺省）：按模型配方改写主稿并返回动态微调建议，传入 `tweaks` 时执行语义揉合；
 *    `note='llm_unconfigured'` 表示未配置大模型，`note='llm_unavailable'` 表示调用失败；
 *  - `mode='translate'`：返回 `{ ok, mode, source, prompt, note? }`，`source='local'` 表示未真正翻译。
 */
export function enhancePromptRequest({ prompt, presetId, locale, mode, cfg, action, tweaks } = {}) {
  const body = { prompt, presetId, locale }
  if (typeof mode === 'string' && mode) body.mode = mode
  const cfgValue = Number(cfg)
  if (cfg !== '' && cfg !== null && cfg !== undefined && Number.isFinite(cfgValue)) body.cfg = cfgValue
  if (typeof action === 'string' && action) body.action = action
  if (Array.isArray(tweaks) && tweaks.length > 0) body.tweaks = tweaks
  return request(routePath('enhance'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * 把一句话解析成生成参数（意图 v2）。
 *
 * - `cfg`：表单当前 CFG，Host 据此判断负向词是否生效（缺失时回落到预设推荐值）；
 * - `history`：最近对话 `[{ role: 'user'|'assistant', content }]`，由调用方按
 *   `LIMITS.intentHistory` 裁剪后传入，Host 会再裁剪一次；空数组不发送；
 * - `previousPrompt` 保留为旧宿主的兼容字段，新宿主在 history 非空时优先用 history。
 */
export function parseIntentRequest({ text, previousPrompt, locale, presetId, cfg, history } = {}) {
  const body = { text, previousPrompt, locale, presetId }
  // cfg=0 是合法值（极速模型默认不用负向词），不能用真值判断；非数字才省略。
  const cfgValue = Number(cfg)
  if (cfg !== '' && cfg !== null && cfg !== undefined && Number.isFinite(cfgValue)) body.cfg = cfgValue
  if (Array.isArray(history) && history.length > 0) body.history = history
  return request(routePath('intent'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** 在系统文件管理器里打开产物目录。 */
export function revealOutput() {
  return request(routePath('reveal'), { method: 'POST', body: JSON.stringify({}) })
}

/** 设置/取消单张作品的收藏。 */
export function favoriteImage(path, favorite) {
  return request(routePath('libraryFavorite'), {
    method: 'POST',
    body: JSON.stringify({ path, favorite }),
  })
}

/** 删除一批产物文件。 */
export function deleteImages(paths) {
  return request(routePath('libraryDelete'), {
    method: 'POST',
    body: JSON.stringify({ paths }),
  })
}

/**
 * 运行设置：GET 返回脱敏视图 `{ ok, settings }`（永不回传 hfToken 原文）。
 * 路径与方法和其它资源函数一样只从契约取，这里不写路径字面量。
 */
export function fetchSettings() {
  return request(routePath('settings'), { method: 'GET' })
}

/** 保存运行设置：payload 只含改动字段，响应与 GET 同为 `{ ok, settings }`。 */
export function saveSettings(payload) {
  return request(routePath('settingsSave'), {
    method: 'POST',
    body: JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
  })
}

/**
 * 工作台界面态：GET 返回白名单全量视图 `{ ok, uiState }`。
 * 读取失败只回落默认值，不弹错误提示（界面态不是业务数据）。
 */
export function fetchUiState() {
  return request(routePath('uiState'), { method: 'GET' })
}

/** 保存界面态：请求体是扁平补丁（如 `{ advancedOpen: true }`），响应与 GET 相同。 */
export function saveUiState(patch) {
  return request(routePath('uiStateSave'), {
    method: 'POST',
    body: JSON.stringify(patch && typeof patch === 'object' ? patch : {}),
  })
}

/** 读取当前工作区持久化的助手对话历史 `{ ok, workspace, messages }`（失败静默回落空）。 */
export function fetchChatHistory() {
  return request(routePath('chatHistory'), { method: 'GET' })
}

/** 保存当前工作区的助手对话历史；传空数组等价清空磁盘记录。 */
export function saveChatHistory(messages) {
  return request(routePath('chatHistorySave'), {
    method: 'POST',
    body: JSON.stringify({ messages: Array.isArray(messages) ? messages : [] }),
  })
}

function postLoginAction(routeName, action, code) {
  const body = loginActionBody(action, code)
  if (!body) {
    return Promise.resolve({ ok: false, status: 0, code: 'invalid_request', message: `未知的登录动作：${action}` })
  }
  return request(routePath(routeName), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * Kaggle 直连登录态：GET 返回 `{ ok, login }`（LoginView，字段见契约 KAGGLE_LOGIN）。
 * 旧宿主没有该路由时回 404，由调用方按「接口不可用」处理，不抛异常。
 */
export function fetchKaggleLogin() {
  return request(routePath('kaggleLogin'), { method: 'GET' })
}

/**
 * 发送一次 Kaggle 登录动作；请求体严格按契约 `KAGGLE_LOGIN.actions` 的形状：
 * `{ action: 'start' }` / `{ action: 'cancel' }` / `{ action: 'submit-code', code }`。
 */
export function kaggleLoginAction(action, code) {
  return postLoginAction('kaggleLoginAction', action, code)
}

/** 发起 Kaggle 浏览器授权（本地回环回调收码）。 */
export function startKaggleLogin() {
  return kaggleLoginAction('start')
}

/** 取消正在等待的 Kaggle 登录。 */
export function cancelKaggleLogin() {
  return kaggleLoginAction('cancel')
}

/** manual 模式提交粘贴的 Kaggle 授权码。 */
export function submitKaggleLoginCode(code) {
  return kaggleLoginAction('submit-code', code)
}

/** Colab Google OAuth 登录态：GET 返回 `{ ok, login, auth }`。 */
export function fetchColabLogin() {
  return request(routePath('colabLogin'), { method: 'GET' })
}

/** 发送一次 Colab 登录动作：start / cancel / submit-code。 */
export function colabLoginAction(action, code) {
  return postLoginAction('colabLoginAction', action, code)
}

/** 发起 Colab Google OAuth 浏览器授权。 */
export function startColabLogin() {
  return colabLoginAction('start')
}

/** 取消正在等待的 Colab 登录。 */
export function cancelColabLogin() {
  return colabLoginAction('cancel')
}

/** manual 模式提交粘贴的 Colab 回调 URL 或授权码。 */
export function submitColabLoginCode(code) {
  return colabLoginAction('submit-code', code)
}

/**
 * 本地图片导入（阶段十五 Phase A）：把 dataURL / 裸 base64 交给宿主落盘。
 *
 * 请求体 `{ data, name }`：name 只用于展示，宿主会清理控制字符并截断；
 * 成功返回 `{ ok, entry: { image, item } }`，entry 与 /history 条目同形，可直接选中。
 */
export function importImageFile({ data, name } = {}) {
  const body = { data: typeof data === 'string' ? data : '' }
  const label = typeof name === 'string' ? name.trim() : ''
  if (label) body.name = label
  return request(routePath('importFile'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * 全局应用设置与工作区：独立客户端的 Phase 1 新增端点（契约见 shared/contract.js 的 ROUTES）。
 * 桌面端与浏览器开发态走同一套 HTTP 接口，不需要在这里区分宿主。
 */
function optionalRoutePath(name) {
  try {
    return routePath(name)
  } catch {
    // 服务端版本落后（契约里还没有该路由）时按「接口不可用」降级；
    // 这里不能同步抛错，否则会从 React effect 里冒出来打断整个工作台渲染。
    return ''
  }
}

function missingRoute(name) {
  return Promise.resolve({ ok: false, status: 0, code: 'route_missing', message: `缺少路由：${name}` })
}

/** 当前工作区 + 最近列表 + 是否可切换（GET /api/workspace）。 */
export function fetchWorkspace() {
  const path = optionalRoutePath('workspace')
  if (!path) return missingRoute('workspace')
  return request(path, { method: 'GET' })
}

/** 切换工作区（POST /api/workspace，请求体 `{ path }`），响应与 GET 同形。 */
export function switchWorkspace(path) {
  const target = optionalRoutePath('workspaceSwitch')
  if (!target) return missingRoute('workspaceSwitch')
  return request(target, {
    method: 'POST',
    body: JSON.stringify({ path: typeof path === 'string' ? path.trim() : '' }),
  })
}

/** 全局应用设置脱敏视图（GET /api/app-settings，apiKey 只回 hasApiKey）。 */
export function fetchAppSettings() {
  const path = optionalRoutePath('appSettings')
  if (!path) return missingRoute('appSettings')
  return request(path, { method: 'GET' })
}

/** 合并保存全局应用设置（POST /api/app-settings，白名单字段），响应与 GET 同形。 */
export function saveAppSettings(payload) {
  const path = optionalRoutePath('appSettingsSave')
  if (!path) return missingRoute('appSettingsSave')
  return request(path, {
    method: 'POST',
    body: JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
  })
}

/**
 * 私有 Worker 连接探测（POST /api/worker/probe）。
 *
 * `endpointUrl` / `token` 都可省略：地址缺省用已保存值，Token 只有探测同一地址时
 * 才由 Host 回落到已保存值。响应 `{ ok, probe }`，probe 内不含 Token。
 */
export function probeWorker({ endpointUrl, token } = {}) {
  const path = optionalRoutePath('workerProbe')
  if (!path) return missingRoute('workerProbe')
  const body = {}
  if (typeof endpointUrl === 'string' && endpointUrl.trim()) body.endpointUrl = endpointUrl.trim()
  if (typeof token === 'string' && token.trim()) body.token = token.trim()
  return request(path, { method: 'POST', body: JSON.stringify(body) })
}

/**
 * SaladCloud 连接探测（POST /api/salad/probe）。
 *
 * 可用未保存的 `apiKey / org / project`；API Key 留空时 Host 只在组织与项目
 * 和已保存值一致时才回落到加密凭据。响应 `{ ok, probe }`，probe 不含 Key。
 */
export function probeSalad({ apiKey, org, project } = {}) {
  const path = optionalRoutePath('saladProbe')
  if (!path) return missingRoute('saladProbe')
  const body = {}
  if (typeof apiKey === 'string' && apiKey.trim()) body.apiKey = apiKey.trim()
  if (typeof org === 'string' && org.trim()) body.org = org.trim()
  if (typeof project === 'string' && project.trim()) body.project = project.trim()
  return request(path, { method: 'POST', body: JSON.stringify(body) })
}

/**
 * 手动触发一次版本检查（POST /api/update/check）。
 *
 * NSIS 安装态由主进程独占更新，该路由回 `{ mode: 'electron' }` 占位；
 * 渲染进程优先走 `window.aigcStudio.updater.check()`，只有浏览器 / 只读形态才用这里。
 */
export function checkUpdate() {
  const path = optionalRoutePath('updateCheck')
  if (!path) return missingRoute('updateCheck')
  return request(path, { method: 'POST' })
}

/**
 * 获取某个 Provider 的可用模型（POST /api/llm/models）。
 *
 * 由 Host 代理请求（浏览器直连第三方 `/models` 会撞 CORS，已保存的 Key 也不会回传前端）：
 *  - `apiKey` 只在用户刚输入、尚未保存时传；留空则由 Host 复用已保存的同 provider Key；
 *  - 在线失败会自动降级为 `pi-ai` 内置目录，响应里用 `source` / `warning` 说明。
 *
 * @param {{ provider: string, baseUrl?: string, apiKey?: string, showAll?: boolean }} input
 * @returns {Promise<{ ok: boolean, status?: number, code?: string, message?: string,
 *                     data?: { source: string, models: Array<object>, warning: string|null } }>}
 */
export function fetchLlmModels({ provider, baseUrl, apiKey, showAll } = {}) {
  const path = optionalRoutePath('llmModels')
  if (!path) return missingRoute('llmModels')
  const body = { provider: typeof provider === 'string' ? provider : '' }
  if (typeof baseUrl === 'string' && baseUrl.trim()) body.baseUrl = baseUrl.trim()
  if (typeof apiKey === 'string' && apiKey.trim()) body.apiKey = apiKey.trim()
  if (showAll === true) body.showAll = true
  return request(path, { method: 'POST', body: JSON.stringify(body) })
}

/**
 * 创作 Agent SSE 流式对话（POST /api/agent/chat）。
 * 按 `data: <JSON>\n\n` 逐条回调 `onEvent`，遇到网络/HTTP 错返回 `{ ok: false, code, message }`。
 *
 * 请求体除对话历史外还带：
 *  - `locale`：UI 语言（摘要 / 澄清问题用哪种语言写）；
 *  - `presetId` / `cfg`：当前模型与 CFG（决定负向词能力说明与本地兜底口径）；
 *  - `stage`：舞台选中图摘要（`imagePath` / `presetId` / 宽高 / seed / prompt），
 *    让「把当前这张图…」这类指令有明确对象。
 */
export async function streamAgentChat({ messages, system, locale, presetId, cfg, stage, references, exploreBudget, signal, onEvent } = {}) {
  const path = optionalRoutePath('agentChat')
  if (!path) return missingRoute('agentChat')
  const stagePayload = stage && typeof stage === 'object' && typeof stage.imagePath === 'string' && stage.imagePath.trim()
    ? stage
    : null
  // 参考图槽与舞台焦点是两种对象（M2.7）：只透传工作区相对路径，服务端还会再宽松归一一次。
  const referencePayload = Array.isArray(references)
    ? references.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : []
  const cfgValue = Number(cfg)
  try {
    const res = await fetch(apiUrl(path), {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify({
        messages: Array.isArray(messages) ? messages : [],
        ...(typeof system === 'string' && system.trim() ? { system } : {}),
        ...(locale === 'en' || locale === 'zh' ? { locale } : {}),
        ...(typeof presetId === 'string' && presetId ? { presetId } : {}),
        ...(cfg !== '' && cfg !== null && cfg !== undefined && Number.isFinite(cfgValue) ? { cfg: cfgValue } : {}),
        ...(stagePayload ? { stage: stagePayload } : {}),
        ...(referencePayload.length > 0 ? { references: referencePayload } : {}),
        // M3.5 Phase C：探索授权下发的硬预算，服务端据此放大步数上限并强制计数收敛。
        ...(exploreBudget && typeof exploreBudget === 'object'
          ? { exploreBudget: { maxRounds: Number(exploreBudget.maxRounds), maxImages: Number(exploreBudget.maxImages) } }
          : {}),
        stream: true,
      }),
    })
    if (!res.ok) {
      let payload = null
      try {
        payload = await res.json()
      } catch {}
      const envelope = payload && payload.error ? payload.error : null
      return {
        ok: false,
        status: res.status,
        code: (envelope && envelope.code) || `http_${res.status}`,
        message: (envelope && envelope.message) || `HTTP ${res.status}`,
      }
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      const data = await res.json().catch(() => null)
      if (data && typeof onEvent === 'function') onEvent({ type: 'done', ...data })
      return { ok: true, status: res.status, data }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalDone = null
    let streamError = null
    const dispatch = (block) => {
      const lines = block.split(/\r?\n/)
      const dataLines = []
      for (const line of lines) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (dataLines.length === 0) return
      let event = null
      try {
        event = JSON.parse(dataLines.join('\n'))
      } catch {
        return
      }
      if (!event || typeof event !== 'object') return
      if (event.type === 'done') finalDone = event
      if (event.type === 'error') streamError = event
      if (typeof onEvent === 'function') onEvent(event)
    }
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sepIndex = buffer.indexOf('\n\n')
      while (sepIndex !== -1) {
        const block = buffer.slice(0, sepIndex)
        buffer = buffer.slice(sepIndex + 2)
        dispatch(block)
        sepIndex = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) dispatch(buffer)
    if (streamError) {
      return {
        ok: false,
        status: res.status,
        code: streamError.code || 'agent_failed',
        message: streamError.message || 'Agent failed',
      }
    }
    return { ok: true, status: res.status, data: finalDone }
  } catch (cause) {
    const aborted = Boolean(cause && (cause.name === 'AbortError' || cause.code === 'ABORT_ERR'))
    return {
      ok: false,
      status: 0,
      code: aborted ? 'llm_aborted' : 'network',
      message: String((cause && cause.message) || cause || (aborted ? 'aborted' : 'network error')),
    }
  }
}
