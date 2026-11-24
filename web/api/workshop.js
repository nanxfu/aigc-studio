/**
 * 资产工坊（M4.2a / M4.2b）的 Host 接口访问层。
 *
 * 与 web/api/resources.js 同约定：只拼 URL / 方法 / 请求体，失败不抛异常；路径唯一来源是
 * shared/contract.js 的 ROUTES，这里不写路径字面量。
 *
 * Host 返回形状（见 server/routes/workshop.js）：
 *  - save → `{ ok: true, entry: { image, item } }`，entry 与 /history 条目同形；
 *  - vectorize → `{ ok: true, svg, width, height, bytes }`；
 *  - op → `{ ok: true, jobId }`；
 *  - perceive → `{ ok: true, perception }`（L2 语义，失败时调用方静默保留 L1）；
 *  - export → 二进制 zip 流（GET，成功时 content-type 为 application/zip）。
 */

import { WORKSHOP } from '../../shared/contract.js'
import { apiUrl, authHeaders, request, routePath } from '../api.js'

/** 从错误响应里提取 Host 的错误码，缺省按 HTTP 状态码兜底。 */
function failureOf(result) {
  const status = result && Number.isFinite(Number(result.status)) ? Number(result.status) : 0
  return {
    ok: false,
    status,
    code: (result && result.code) || (status ? `http_${status}` : 'network'),
    message: (result && result.message) || '',
  }
}

/**
 * 保存工坊产物为复合资产作品：`POST /api/workshop/save`。
 *
 * 请求体：`{ base: { path }, tool, name?, primary: { data, width?, height? },
 *            channels?: [{ role, label?, format?, data }], meta? }`。
 * 成功返回 `{ ok: true, entry }`；失败原样带 Host 的 code / message 交给界面提示。
 */
export async function saveWorkshopAsset(body) {
  const result = await request(routePath('workshopSave'), {
    method: 'POST',
    body: JSON.stringify(body && typeof body === 'object' ? body : {}),
  })
  if (!result.ok) return failureOf(result)
  const payload = result.data && typeof result.data === 'object' ? result.data : {}
  const entry = payload.entry && payload.entry.image ? payload.entry : null
  if (!entry) {
    return { ok: false, status: result.status, code: 'invalid_response', message: '保存响应缺少 entry' }
  }
  return { ok: true, status: result.status, entry }
}

/** SVG 矢量化：`POST /api/workshop/vectorize`，返回 `{ ok, svg, width, height, bytes }`。 */
export async function vectorizeWorkshopImage(body) {
  const result = await request(routePath('workshopVectorize'), {
    method: 'POST',
    body: JSON.stringify(body && typeof body === 'object' ? body : {}),
  })
  if (!result.ok) return failureOf(result)
  const payload = result.data && typeof result.data === 'object' ? result.data : {}
  const svg = typeof payload.svg === 'string' ? payload.svg : ''
  if (!svg) {
    return { ok: false, status: result.status, code: 'invalid_response', message: '矢量化响应缺少 svg' }
  }
  return {
    ok: true,
    status: result.status,
    svg,
    width: Number(payload.width) || 0,
    height: Number(payload.height) || 0,
    bytes: Number(payload.bytes) || svg.length,
  }
}

/** 提交 GPU 后处理算子（remove-bg / pbr）：`POST /api/workshop/op`，返回 `{ ok, jobId }`。 */
export async function submitWorkshopOp(body) {
  const result = await request(routePath('workshopOp'), {
    method: 'POST',
    body: JSON.stringify(body && typeof body === 'object' ? body : {}),
  })
  if (!result.ok) return failureOf(result)
  const payload = result.data && typeof result.data === 'object' ? result.data : {}
  const jobId = typeof payload.jobId === 'string' ? payload.jobId.trim() : ''
  if (!jobId) return { ok: false, status: result.status, code: 'invalid_response', message: '任务响应缺少 jobId' }
  return { ok: true, status: result.status, jobId }
}

/**
 * L2 视觉感知：`POST /api/workshop/perceive`。
 *
 * 只发送 256×256 RGB base64，不发送图片路径或作品元数据；Host 不认识作品树，
 * 也不读取用户磁盘。请求失败（模型未就绪 / 下载失败 / 用户关闭）返回 error 对象，
 * 由 Workshop 静默丢弃，不出现可见错误。
 *
 * @param {{ width: number, height: number, data: string }} pixels
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function perceiveWorkshopVision(pixels, options = {}) {
  if (
    !pixels
    || Number(pixels.width) !== WORKSHOP.vision.imageSize
    || Number(pixels.height) !== WORKSHOP.vision.imageSize
    || typeof pixels.data !== 'string'
  ) {
    return { ok: false, status: 0, code: 'invalid_request', message: '视觉输入必须是 256×256 RGB base64' }
  }
  const result = await request(routePath('workshopPerceive'), {
    method: 'POST',
    signal: options.signal,
    body: JSON.stringify({ pixels }),
  })
  if (!result.ok) return failureOf(result)
  const payload = result.data && typeof result.data === 'object' ? result.data : {}
  const perception = payload.perception
  if (!perception || typeof perception !== 'object' || !WORKSHOP.scenes.includes(perception.scene)) {
    return { ok: false, status: result.status, code: 'invalid_response', message: '视觉感知响应缺少有效 perception' }
  }
  return { ok: true, status: result.status, perception }
}

/** 导出 ZIP 的完整 URL：`GET /api/workshop/export?path=<作品目录或图片路径>`。 */
export function exportWorkZipUrl(path) {
  const target = typeof path === 'string' ? path.trim() : ''
  return `${apiUrl(routePath('workshopExport'))}?path=${encodeURIComponent(target)}`
}

/** 从 content-disposition 里取文件名；没有时按作品路径兜底。 */
function zipNameFrom(disposition, path, stamp) {
  const header = typeof disposition === 'string' ? disposition : ''
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''))
    } catch {
      // 非法百分号编码：继续按普通文件名解析。
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  if (plain) return plain[1].trim()
  const base = String(path || '').split(/[\\/]/).filter(Boolean).pop() || 'work'
  return `${base.replace(/\.[a-z0-9]+$/i, '')}-${stamp || ''}.zip`.replace(/-$/, '.zip')
}

/**
 * 下载作品目录的 ZIP：fetch 二进制 → Blob → 隐藏的 `<a download>`。
 *
 * 只对已保存的作品可用（调用方负责禁用态）；失败返回 `{ ok:false, code, message }`，
 * 不抛异常。无 document 的测试 / 预览环境直接按不可用返回，不伪造下载。
 */
export async function downloadWorkZip(path) {
  const target = typeof path === 'string' ? path.trim() : ''
  if (!target) return { ok: false, status: 0, code: 'invalid_path', message: '缺少作品路径' }
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
    return { ok: false, status: 0, code: 'download_unavailable', message: '当前环境不支持文件下载' }
  }
  try {
    const response = await fetch(exportWorkZipUrl(target), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { ...authHeaders() },
    })
    if (!response.ok) {
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      const envelope = payload && payload.error ? payload.error : null
      return {
        ok: false,
        status: response.status,
        code: (envelope && envelope.code) || `http_${response.status}`,
        message: (envelope && envelope.message) || `HTTP ${response.status}`,
      }
    }
    const blob = await response.blob()
    const name = zipNameFrom(
      typeof response.headers?.get === 'function' ? response.headers.get('content-disposition') : '',
      target,
      String(Date.now()),
    )
    const href = URL.createObjectURL(blob)
    try {
      const link = document.createElement('a')
      link.href = href
      link.download = name
      link.rel = 'noopener'
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } finally {
      // 下载已提交给浏览器，延迟回收对象 URL，避免部分浏览器在点击瞬间取消下载。
      setTimeout(() => URL.revokeObjectURL(href), 10_000)
    }
    return { ok: true, status: response.status, name, bytes: blob.size }
  } catch (cause) {
    return {
      ok: false,
      status: 0,
      code: 'network',
      message: String((cause && cause.message) || cause || 'network error'),
    }
  }
}
