/**
 * Cloudflare Pages Function：桌面端匿名遥测接收端点（写入 D1 `TELEMETRY_DB`）。
 *
 * 隐私与安全约束：
 *  - 只接受白名单事件名，绝不接收或落盘提示词、路径、密钥或 IP 地址；
 *  - 请求体限 4 KiB，属性只保留扁平标量字段（最多 16 项）；
 *  - 若 Cloudflare Dashboard 尚未绑定 D1 变量 `TELEMETRY_DB`，静默返回 202（不触发 500 告警）。
 */

const MAX_BODY_BYTES = 4096
const MAX_PROPS_CHARS = 1024
const MAX_PROPS_KEYS = 16
const INSTALL_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/

export const ALLOWED_EVENTS = new Set([
  'app_launch',
  'generate_done',
  'generate_fail',
  'workshop_op',
  'provider_configured',
  'mcp_call',
])

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLen)
}

function sanitizeProps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '{}'
  const out = {}
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_PROPS_KEYS) break
    const cleanKey = cleanText(key, 40)
    if (!cleanKey) continue
    if (typeof value === 'string') {
      out[cleanKey] = cleanText(value, 120)
      count += 1
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[cleanKey] = value
      count += 1
    } else if (typeof value === 'boolean') {
      out[cleanKey] = value
      count += 1
    }
  }
  const encoded = JSON.stringify(out)
  return encoded.length <= MAX_PROPS_CHARS ? encoded : '{}'
}

export async function handleTelemetryPost(request, env) {
  const contentLength = Number(request.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: 'payload_too_large' }, 413)
  }

  let rawText = ''
  try {
    rawText = await request.text()
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_body' }, 400)
  }
  if (!rawText || rawText.length > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: rawText ? 'payload_too_large' : 'empty_body' }, rawText ? 413 : 400)
  }

  let body
  try {
    body = JSON.parse(rawText)
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400)
  }

  const event = cleanText(body.event, 48)
  if (!ALLOWED_EVENTS.has(event)) {
    return jsonResponse({ ok: false, error: 'unsupported_event' }, 400)
  }

  const installId = cleanText(body.installId, 64)
  if (!INSTALL_ID_RE.test(installId)) {
    return jsonResponse({ ok: false, error: 'invalid_install_id' }, 400)
  }

  const appVersion = cleanText(body.version, 32)
  const os = cleanText(body.os, 24)
  const lang = cleanText(body.lang, 16)
  const country = cleanText(String(request.cf?.country || ''), 8)
  const props = sanitizeProps(body.props)
  const ts = Date.now()

  const db = env?.TELEMETRY_DB
  if (!db || typeof db.prepare !== 'function') {
    return jsonResponse({ ok: true, skipped: true }, 202)
  }

  try {
    await db
      .prepare(
        'INSERT INTO events (ts, install_id, event, app_version, os, lang, country, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(ts, installId, event, appVersion, os, lang, country, props)
      .run()
    return jsonResponse({ ok: true }, 200)
  } catch {
    return jsonResponse({ ok: false, error: 'storage_error' }, 500)
  }
}

export async function onRequestPost(context) {
  return handleTelemetryPost(context.request, context.env)
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    },
  })
}
