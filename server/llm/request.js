/**
 * LLM HTTP 请求的统一出口。
 *
 * 只做四件事：合并取消信号与超时、发 JSON POST、把非 2xx 归一成可读错误、返回流式响应。
 * 不在这里做重试：润色/意图解析失败由 `server/llm.js` 静默降级，Agent 侧由调用方决定。
 */

const DEFAULT_TIMEOUT_MS = 120_000

/** 合并调用方信号与内部超时信号（Node 20+ 支持 AbortSignal.any / timeout）。 */
function combineSignals(signal, timeoutMs) {
  const signals = []
  if (signal) signals.push(signal)
  if (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    signals.push(AbortSignal.timeout(timeoutMs))
  }
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  return signals[0]
}

/** 从错误响应体里提取可读信息：优先 JSON 的 error.message / message，否则截断原文。 */
async function describeFailure(response) {
  let text = ''
  try {
    text = await response.text()
  } catch {
    return { message: '', code: null, detail: '' }
  }
  const trimmed = text.trim()
  if (!trimmed) return { message: '', code: null, detail: '' }
  try {
    const parsed = JSON.parse(trimmed)
    const error = parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object' ? parsed.error : null
    const code = (error && typeof error.code === 'string' && error.code) || (typeof parsed.code === 'string' ? parsed.code : null)
    const message =
      (error && typeof error.message === 'string' && error.message) ||
      (typeof parsed.message === 'string' && parsed.message) ||
      ''
    return { message, code, detail: trimmed.slice(0, 500) }
  } catch {
    return { message: '', code: null, detail: trimmed.slice(0, 500) }
  }
}

/**
 * 发起 JSON POST 并返回流式 Response。
 *
 * @param {string} url
 * @param {{ headers?: Record<string,string>, body?: object, signal?: AbortSignal, timeoutMs?: number,
 *           fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Response>}
 */
export async function postJsonStream(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    const error = new Error('当前运行环境没有 fetch，无法调用模型服务')
    error.code = 'llm_no_fetch'
    throw error
  }
  const signal = combineSignals(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream, application/x-ndjson, application/json',
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(options.body ?? {}),
      signal,
    })
  } catch (cause) {
    // 调用方主动取消（AbortError）与网络失败要区分，日志里才能说清「谁取消了」。
    const aborted = cause && (cause.name === 'AbortError' || cause.code === 'ABORT_ERR')
    const error = new Error(aborted ? '模型请求已取消或超时' : `模型请求失败：${String(cause?.message ?? cause)}`)
    error.code = aborted ? 'llm_aborted' : 'llm_network_error'
    error.cause = cause
    throw error
  }
  if (!response.ok) {
    const failure = await describeFailure(response)
    const suffix = failure.message ? `：${failure.message}` : ''
    const error = new Error(`模型服务返回 HTTP ${response.status}${suffix}`)
    error.code = 'llm_http_error'
    error.status = response.status
    error.providerCode = failure.code
    error.detail = failure.detail
    throw error
  }
  return response
}

/** 拼接 URL 路径：baseUrl 已有尾斜杠时去重，`/v1` 之类前缀原样保留。 */
export function joinUrl(baseUrl, path) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '')
  const suffix = String(path ?? '').replace(/^\/+/, '')
  return suffix ? `${base}/${suffix}` : base
}
