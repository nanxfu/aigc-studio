/**
 * 桌面端匿名使用遥测（上报至官网 Cloudflare Pages Function `/api/telemetry` → D1）。
 *
 * 隐私与安全约束：
 *  - 只发白名单事件与扁平脱敏属性（绝不传 prompt、图片、本地路径、API Key 或 IP）；
 *  - 默认开启，用户在设置中关闭后立即停止上报（每次 track 实时读取 appConfig）；
 *  - 异步 fire-and-forget，超时 3 秒即放弃，任何网络/解析异常静默吞掉；
 *  - 单元测试与 devEndpoint 替身环境默认禁用网络发送，避免产生测试脏数据。
 */

import { join, sep } from 'node:path'
import { httpText } from './net.js'

export const DEFAULT_TELEMETRY_ENDPOINT = 'https://aigc-studio-8rj.pages.dev/api/telemetry'
const DEFAULT_TIMEOUT_MS = 3000
const INSTALL_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/
const TEST_PATH_SEGMENT = `${sep}test${sep}`

export const TELEMETRY_EVENTS = Object.freeze([
  'app_launch',
  'generate_done',
  'generate_fail',
  'workshop_op',
  'provider_configured',
  'mcp_call',
])

const ALLOWED_EVENTS = new Set(TELEMETRY_EVENTS)
const FORBIDDEN_PROP_KEYS = new Set([
  'prompt',
  'negativeprompt',
  'apikey',
  'token',
  'hftoken',
  'endpoint',
  'endpointurl',
  'baseurl',
  'path',
  'filepath',
  'sourcepath',
  'workspace',
])

function isTestProcess() {
  if (process.env.NODE_ENV === 'test') return true
  const entry = String(process.argv[1] || '')
  return entry.includes(TEST_PATH_SEGMENT) || entry.includes('/test/')
}

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLen)
}

export function sanitizeTelemetryProps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    if (count >= 16) break
    const cleanKey = cleanText(key, 40)
    if (!cleanKey || FORBIDDEN_PROP_KEYS.has(cleanKey.toLowerCase())) continue
    if (typeof value === 'string') {
      const cleaned = cleanText(value, 120)
      if (cleaned !== '') {
        out[cleanKey] = cleaned
        count += 1
      }
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[cleanKey] = value
      count += 1
    } else if (typeof value === 'boolean') {
      out[cleanKey] = value
      count += 1
    }
  }
  return out
}

/**
 * @param {object} [options]
 * @param {object | null} [options.ctx]
 * @param {object | null} [options.appConfig]
 * @param {string} [options.version]
 * @param {string} [options.lang]
 * @param {() => string | null} [options.getLang]
 * @param {boolean} [options.enabled]
 * @param {string} [options.endpoint]
 * @param {object | null} [options.log]
 * @param {(endpoint: string, payload: object, signal: AbortSignal) => Promise<void> | void} [options.sender]
 */
export function createTelemetry({
  ctx = null,
  appConfig = null,
  version = '',
  lang = '',
  getLang = null,
  enabled = true,
  endpoint = '',
  log = null,
  sender = null,
} = {}) {
  const envDisabled = process.env.AIGC_STUDIO_TELEMETRY_DISABLED === '1'
  const envEndpoint = cleanText(String(process.env.AIGC_STUDIO_TELEMETRY_ENDPOINT || ''), 240)
  const targetEndpoint = cleanText(String(endpoint || ''), 240) || envEndpoint || DEFAULT_TELEMETRY_ENDPOINT
  const explicitTransport = Boolean(sender || endpoint || envEndpoint)
  const globallyEnabled =
    enabled !== false
    && !envDisabled
    && (explicitTransport || (Boolean(appConfig) && !isTestProcess()))

  const inflight = new Set()
  let disposed = false

  function resolveConfig() {
    if (appConfig?.getTelemetry) {
      const cfg = appConfig.getTelemetry()
      if (!cfg || cfg.enabled === false) return null
      const installId = cleanText(String(cfg.installId || ''), 64)
      if (!INSTALL_ID_RE.test(installId)) return null
      return { installId }
    }
    if (sender) return { installId: 'test-install-id' }
    return null
  }

  async function dispatch(payload, signal) {
    if (typeof sender === 'function') {
      await sender(targetEndpoint, payload, signal)
      return
    }
    const body = JSON.stringify(payload)
    const headers = { 'content-type': 'application/json' }
    if (typeof ctx?.subprocess?.resolveExecutable === 'function') {
      await httpText(ctx, targetEndpoint, {
        method: 'POST',
        headers,
        body,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxBytes: 4096,
        signal,
      })
      return
    }
    const combinedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
      : AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    await fetch(targetEndpoint, {
      method: 'POST',
      headers,
      body,
      signal: combinedSignal,
    })
  }

  function track(event, props = {}) {
    if (disposed || !globallyEnabled) return false
    const cleanEvent = cleanText(String(event || ''), 48)
    if (!ALLOWED_EVENTS.has(cleanEvent)) return false
    const cfg = resolveConfig()
    if (!cfg) return false

    const resolvedLang = cleanText(String((typeof getLang === 'function' ? getLang() : '') || lang || ''), 16)
    const payload = {
      installId: cfg.installId,
      event: cleanEvent,
      version: cleanText(String(version || ''), 32),
      os: process.platform,
      lang: resolvedLang,
      props: sanitizeTelemetryProps(props),
    }

    const controller = new AbortController()
    const entry = { controller }
    inflight.add(entry)
    void Promise.resolve()
      .then(() => dispatch(payload, controller.signal))
      .catch((error) => {
        log?.debug?.('telemetry_send_skipped', cleanEvent, String(error?.message ?? error).slice(0, 120))
      })
      .finally(() => {
        inflight.delete(entry)
      })
    return true
  }

  function dispose() {
    disposed = true
    for (const entry of inflight) {
      try {
        entry.controller.abort()
      } catch {}
    }
    inflight.clear()
  }

  return {
    get enabled() {
      if (disposed || !globallyEnabled) return false
      return Boolean(resolveConfig())
    },
    endpoint: targetEndpoint,
    track,
    dispose,
  }
}
