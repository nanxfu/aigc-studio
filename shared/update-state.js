/**
 * 应用内更新的状态契约（纯函数 + 常量，主进程 / 服务端 / 渲染进程共用）。
 *
 * 设计目标（docs/M2_8_RELEASE_AND_UPDATER_SPEC.md §3.2）：
 *  - 只有一种状态形状：无论是 `electron-updater` 主进程推送、`/api/state.update`
 *    的只读快照，还是测试注入的假对象，都先经过 `normalizeUpdateState` 归一；
 *  - `downloaded` 只在 `canAutoUpdate === true` 时出现；只读形态最多到 `available`；
 *  - `progress` 只在 `downloading` 时非空，百分比钳在 0..100；
 *  - `error` 与 `status === 'error'` 必须同时出现，恢复检查时先清 `error`。
 *
 * 本文件不许 import `node:*` / `electron`，既要打进浏览器 bundle，也要能在
 * `node --test` 风格的纯逻辑用例里直接 import。
 */

import { isNewerVersion, normalizeVersion } from './version.js'
import { hasActiveJobs, isQueueBusy, isSessionRunning } from './session-activity.js'

/** 状态结构版本；未来不兼容变更时递增。 */
export const UPDATE_SCHEMA = 1
/** 更新通道：本阶段只做 stable。 */
export const UPDATE_CHANNEL = 'stable'

export const UPDATE_MODES = Object.freeze(['electron-updater', 'readonly'])
export const UPDATE_FORMS = Object.freeze([
  'nsis',
  'portable',
  'unpacked',
  'dev',
  'mac-unsigned',
  'linux-appimage',
  'unsupported',
])
export const UPDATE_STATUSES = Object.freeze([
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'up-to-date',
  'error',
])
export const UPDATE_SOURCES = Object.freeze(['github', 'custom'])

/**
 * 错误码（覆盖规格 §3.5 的分类）：
 *  - 网络：offline / dns / timeout / http_401 / http_403 / http_404 / http_429 / http_5xx
 *  - 内容：checksum / signature / feed_invalid
 *  - 本机：disk_full / permission
 *  - 形态：unsupported_form
 *  - 安装护栏：state_unknown / state_stale / session_active / queue_active / not_downloaded
 *  - 兜底：unknown
 */
export const UPDATE_ERROR_CODES = Object.freeze([
  'offline',
  'dns',
  'timeout',
  'http_401',
  'http_403',
  'http_404',
  'http_429',
  'http_5xx',
  'checksum',
  'signature',
  'feed_invalid',
  'disk_full',
  'permission',
  'unsupported_form',
  'state_unknown',
  'state_stale',
  'session_active',
  'queue_active',
  'not_downloaded',
  'unknown',
])

const ERROR_CODE_SET = new Set(UPDATE_ERROR_CODES)
const MODE_SET = new Set(UPDATE_MODES)
const FORM_SET = new Set(UPDATE_FORMS)
const STATUS_SET = new Set(UPDATE_STATUSES)
const SOURCE_SET = new Set(UPDATE_SOURCES)

/** 旧版本检查器 / 旧客户端的错误码别名 → 新分类。 */
const ERROR_ALIASES = Object.freeze({
  network: 'offline',
  invalid_manifest: 'feed_invalid',
  invalid_version: 'feed_invalid',
  release_http_404: 'http_404',
  release_http_403: 'http_403',
  release_http_401: 'http_401',
  release_http_429: 'http_429',
  release_failed: 'unknown',
  release_http_failed: 'unknown',
})

/** 镜像 URL 长度上限（规格 §3.5）。 */
export const UPDATE_MIRROR_MAX_CHARS = 512

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function textOf(value, maxChars = 64) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxChars)
}

/** 版本号归一：非法值返回 null（不抛错）。 */
export function versionOf(value) {
  return normalizeVersion(typeof value === 'string' ? value : '')
}

/**
 * 镜像根地址归一（规格 §3.5）。
 *
 * 规则：只接受 `https://`；生产态禁止 `http://`，仅开发联调
 * （`allowInsecure === true`）放行 `http://127.0.0.1[:port]`；禁止用户名/密码、
 * query、fragment；长度 ≤ 512；去掉末尾斜杠。
 *
 * @param {unknown} raw
 * @param {{ allowInsecure?: boolean }} [options]
 * @returns {string | null} 归一后的地址；空串输入返回空串；非法输入返回 null
 */
export function normalizeMirrorUrl(raw, options = {}) {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return ''
  if (text.length > UPDATE_MIRROR_MAX_CHARS) return null

  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const allowInsecure = options.allowInsecure === true
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:') {
    if (!(allowInsecure && url.protocol === 'http:' && isLoopback)) return null
  }
  if (url.username || url.password) return null
  if (url.search || url.hash) return null
  if (!url.hostname) return null
  // 只保留 origin + 路径，路径末尾斜杠归一（`https://m.example/a/` → `https://m.example/a`）。
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${pathname === '/' ? '' : pathname}`
}

/**
 * 从异常 / HTTP 状态分类出错误码。
 *
 * @param {unknown} error Error 对象、`{ status }`、错误码字符串均可
 * @param {string} [fallback='unknown']
 * @returns {string}
 */
export function classifyUpdateError(error, fallback = 'unknown') {
  if (typeof error === 'string') {
    const code = textOf(error, 64).toLowerCase()
    if (ERROR_CODE_SET.has(code)) return code
    if (hasOwn(ERROR_ALIASES, code)) return ERROR_ALIASES[code]
    // `http_503` 这类具体状态码归一到 `http_5xx`（服务端快照可能带具体码）。
    const statusMatch = /^http_(\d{3})$/.exec(code)
    if (statusMatch) return classifyUpdateError({ status: Number(statusMatch[1]) }, fallback)
    if (!code) return fallback
    return classifyUpdateError(new Error(code), fallback)
  }
  if (!error || typeof error !== 'object') return fallback

  const direct = textOf(error.code, 64)
  if (ERROR_CODE_SET.has(direct)) return direct
  if (hasOwn(ERROR_ALIASES, direct)) return ERROR_ALIASES[direct]

  const status = Number(error.status ?? error.statusCode ?? error.response?.status)
  if (Number.isFinite(status) && status >= 100) {
    if (status === 401) return 'http_401'
    if (status === 403) return 'http_403'
    if (status === 404) return 'http_404'
    if (status === 429) return 'http_429'
    if (status >= 500 && status <= 599) return 'http_5xx'
  }

  const message = `${error.message ?? ''} ${error.errno ?? ''} ${error.code ?? ''}`.toLowerCase()
  if (!message.trim()) return fallback

  if (message.includes('sha512') || message.includes('checksum') || message.includes('hash mismatch')) return 'checksum'
  if (message.includes('signature') || message.includes('publishername')) return 'signature'
  if (message.includes('enospc') || message.includes('no space left')) return 'disk_full'
  if (message.includes('eacces') || message.includes('eperm') || message.includes('permission denied')) return 'permission'
  if (message.includes('enotfound') || message.includes('eai_again') || message.includes('getaddrinfo')) return 'dns'
  if (message.includes('etimedout') || message.includes('timeout') || message.includes('timed out')) return 'timeout'
  if (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('enetunreach') ||
    message.includes('ehostunreach') ||
    message.includes('network') ||
    message.includes('fetch failed') ||
    message.includes('offline')
  ) {
    return 'offline'
  }
  if (message.includes('latest.yml') || message.includes('cannot parse') || message.includes('invalid version')) {
    return 'feed_invalid'
  }
  return ERROR_CODE_SET.has(message) ? message : fallback
}

/** 错误码 → 词典键（渲染进程直接 t(key)）。 */
export function errorMessageKey(code) {
  const normalized = ERROR_CODE_SET.has(code) ? code : 'unknown'
  return `studio.update.error.${normalized}`
}

/** 安装被阻止原因 → 词典键。 */
export function installGateMessageKey(reason) {
  const code = ERROR_CODE_SET.has(reason) ? reason : 'unknown'
  return `studio.update.gate.${code}`
}

function normalizeProgress(raw) {
  if (!isPlainObject(raw)) return null
  const percent = Number(raw.percent)
  const transferred = Number(raw.transferred)
  const total = Number(raw.total)
  const bytesPerSecond = Number(raw.bytesPerSecond)
  const clampPercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  return {
    percent: Math.round(clampPercent * 10) / 10,
    transferred: Number.isFinite(transferred) && transferred > 0 ? Math.round(transferred) : 0,
    total: Number.isFinite(total) && total > 0 ? Math.round(total) : 0,
    bytesPerSecond: Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? Math.round(bytesPerSecond) : 0,
  }
}

/**
 * 把任意来源的更新状态归一成唯一形状。
 *
 * 输入可以是：
 *  - `electron/updater.mjs` 推送的完整状态；
 *  - `/api/state.update` 的只读快照（`current/latest/hasUpdate/releaseUrl/checkedAt/error`）；
 *  - 旧客户端的 `updateOf` 输入（字段更少）。
 *
 * @param {unknown} raw
 * @returns {object | null} 非对象返回 null；其余一律返回完整状态
 */
export function normalizeUpdateState(raw) {
  if (!isPlainObject(raw)) return null

  const mode = MODE_SET.has(raw.mode) ? raw.mode : 'readonly'
  const form = FORM_SET.has(raw.form) ? raw.form : 'unsupported'
  const canAutoUpdate = Boolean(raw.canAutoUpdate) && mode === 'electron-updater'
  const source = SOURCE_SET.has(raw.source) ? raw.source : 'github'

  const current = versionOf(raw.current)
  const latest = versionOf(raw.latest)
  const hasUpdate = current && latest ? isNewerVersion(latest, current) : raw.hasUpdate === true

  let status = STATUS_SET.has(raw.status) ? raw.status : ''
  if (!status) {
    if (raw.error) status = 'error'
    else if (hasUpdate) status = 'available'
    else if (latest) status = 'up-to-date'
    else status = 'idle'
  }
  // 不变量：error 与 status='error' 必须同时出现（旧快照可能只带 hasUpdate + error）。
  if (raw.error && status !== 'error') status = 'error'
  // 不变量：只读形态永远不会到 downloaded；下载完成后必须允许自动更新。
  if (status === 'downloaded' && !canAutoUpdate) status = hasUpdate ? 'available' : 'up-to-date'

  let error = null
  if (status === 'error') {
    const rawError = raw.error
    const code = isPlainObject(rawError)
      ? classifyUpdateError(rawError.code ?? rawError.message, 'unknown')
      : classifyUpdateError(rawError, 'unknown')
    const message = isPlainObject(rawError) ? textOf(rawError.message, 400) : ''
    error = { code, message }
  }

  const releaseUrlRaw = textOf(raw.releaseUrl, 2048)
  const releaseUrl = releaseUrlRaw.startsWith('https://') ? releaseUrlRaw : null
  const checkedAtRaw = textOf(raw.checkedAt, 64)

  return {
    schema: UPDATE_SCHEMA,
    mode,
    form,
    canAutoUpdate,
    channel: UPDATE_CHANNEL,
    source,
    current,
    latest,
    hasUpdate,
    status,
    progress: status === 'downloading'
      ? (normalizeProgress(raw.progress) ?? { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 })
      : null,
    releaseUrl,
    releaseName: textOf(raw.releaseName, 120) || null,
    checkedAt: Number.isFinite(Date.parse(checkedAtRaw)) && checkedAtRaw ? new Date(checkedAtRaw).toISOString() : null,
    // 只有下载完成才允许「退出时安装」，避免 UI 记住一个永远不会执行的开关。
    installOnQuit: status === 'downloaded' && raw.installOnQuit === true,
    error,
  }
}

/**
 * 安装护栏：能不能「立即重启安装」。
 *
 * 调用方必须先重新拉一次 `/api/state`（2.5s 超时），再把快照传给本函数；
 * `maxAgeMs` 用于拒绝明显过期的快照（默认 8 秒，覆盖一次拉取 + IPC 往返）。
 *
 * @param {object} input
 * @param {object} input.state 归一后的更新状态（或原始状态）
 * @param {object | null} [input.serverState] 最新的 `/api/state` 响应
 * @param {number} [input.now]
 * @param {number} [input.maxAgeMs]
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function canInstallNow({ state, serverState = null, now = Date.now(), maxAgeMs = 8000 } = {}) {
  const normalized = normalizeUpdateState(state)
  if (!normalized || !normalized.canAutoUpdate) return { ok: false, reason: 'unsupported_form' }
  if (normalized.status !== 'downloaded') return { ok: false, reason: 'not_downloaded' }
  if (!isPlainObject(serverState)) return { ok: false, reason: 'state_unknown' }
  if (serverState.ok === false) return { ok: false, reason: 'state_unknown' }

  const at = Number(serverState.at)
  if (Number.isFinite(at) && at > 0 && now - at > maxAgeMs) return { ok: false, reason: 'state_stale' }

  if (isSessionRunning(serverState)) return { ok: false, reason: 'session_active' }
  // 队列与任务分开判定：两者对用户的出口不同（等任务 vs 断开算力）。
  if (isQueueBusy(serverState) || hasActiveJobs(serverState)) return { ok: false, reason: 'queue_active' }
  return { ok: true, reason: null }
}

/**
 * 构造初始状态（主进程创建更新器时用）。
 *
 * @param {{ form: string, mode?: string, canAutoUpdate?: boolean, current?: string, source?: string }} input
 */
export function createInitialUpdateState(input = {}) {
  return normalizeUpdateState({
    schema: UPDATE_SCHEMA,
    mode: input.mode === 'electron-updater' ? 'electron-updater' : 'readonly',
    form: input.form,
    canAutoUpdate: input.canAutoUpdate === true,
    source: input.source,
    current: input.current,
    latest: null,
    hasUpdate: false,
    status: 'idle',
    progress: null,
    releaseUrl: null,
    releaseName: null,
    checkedAt: null,
    installOnQuit: false,
    error: null,
  })
}
