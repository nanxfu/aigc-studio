/**
 * 商业生图 API 适配层（M3.5 Phase A）。
 *
 * 只做三件事：把统一请求翻译成各厂商的 HTTP 形状、把响应里的图片下载成 Buffer、
 * 把上游失败归一成契约错误码。会话、队列、落盘、取消语义仍由 JobQueue 负责，
 * 本文件不读写工作区、不写 meta、不碰 UI 状态。
 *
 * 已适配协议：
 *  - `openai-images`：OpenAI Images / 硅基流动 / 自定义 OpenAI 兼容端点（同步返回）；
 *  - `fal-queue`：fal.ai 的「提交 → 轮询状态 → 取结果」三段式队列（异步）；
 *  - `modelscope-async`：魔搭 API-Inference 的异步任务提交 + `/tasks/{task_id}` 轮询。
 *
 * 参数门控：统一请求里的负向词 / 步数 / 引导强度 / 种子只在模型能力位允许时才下发，
 * 避免把无意义字段塞给不认识它们的模型（例如 FLUX schnell 的 guidance_scale）。
 */

import { IMAGE_API } from '../shared/contract.js'
import {
  imageApiModelOf,
  imageApiVendorOf,
  normalizeImageApiConfig,
} from '../shared/image-providers.js'

/** 统一的生图 API 错误：`code` 直接使用契约 ERROR_CODES 的 host 码。 */
export class ImageApiError extends Error {
  constructor(code, message, { status = null, cause = null } = {}) {
    super(message)
    this.name = 'ImageApiError'
    this.code = code
    this.status = status
    this.cause = cause
  }
}

/** 上游返回体里的可读错误：优先 message，其次 error.message / detail / 原文片段。 */
function messageOf(payload, fallback = '') {
  if (!payload) return fallback
  if (typeof payload === 'string') return payload.slice(0, 600)
  const candidates = [
    payload.message,
    payload.error?.message,
    payload.error,
    payload.detail,
    payload.msg,
  ]
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) return item.trim().slice(0, 600)
  }
  try {
    return JSON.stringify(payload).slice(0, 600)
  } catch {
    return fallback
  }
}

/** 从错误体里提取厂商错误码（硅基流动 30001 = 余额不足）。 */
function vendorCodeOf(payload) {
  const raw = payload && typeof payload === 'object' ? payload.code ?? payload.error?.code : null
  const number = Number(raw)
  return Number.isFinite(number) ? number : null
}

/**
 * HTTP 状态 / 错误体 → 契约错误码。
 *
 * 判定顺序：厂商余额码 → 鉴权 → 限流 → 能力不支持 → 其余失败。
 * 余额判断必须在 403 之前：硅基流动余额不足会以 403 返回，直接归到鉴权会误导用户去改 Key。
 *
 * `codePrefix` 让视频适配层复用同一套判定，只把错误码换成 `video_api_*`
 * （生图 / 视频的错误文案与后续动作不同，不能共用同一个码）。
 */
export function mapImageApiError(status, payload, vendorLabel = '生图 API', { codePrefix = 'image_api' } = {}) {
  const code = (name) => `${codePrefix}_${name}`
  const vendorCode = vendorCodeOf(payload)
  const text = messageOf(payload)
  if (vendorCode === 30001 || /balance|insufficient|quota|余额|欠费/i.test(text)) {
    return new ImageApiError(
      code('insufficient_balance'),
      `${vendorLabel} 账户余额不足或额度已用尽：请充值，或切换回 Kaggle / 私有 Worker`,
      { status },
    )
  }
  if (status === 401 || status === 403) {
    return new ImageApiError(
      code('unauthorized'),
      `${vendorLabel} 鉴权失败：请检查 API Key 是否正确、是否有该模型权限（${text || `HTTP ${status}`}）`,
      { status },
    )
  }
  if (status === 429) {
    return new ImageApiError(
      code('rate_limited'),
      `${vendorLabel} 触发限流：请稍后重试或降低并发（${text || 'HTTP 429'}）`,
      { status },
    )
  }
  if (status === 402) {
    return new ImageApiError(
      code('insufficient_balance'),
      `${vendorLabel} 账户余额不足：请充值，或切换回 Kaggle / 私有 Worker`,
      { status },
    )
  }
  if (status === 400 || status === 404 || status === 422) {
    if (/not support|unsupported|invalid model|model.*not found|no such model/i.test(text)) {
      return new ImageApiError(
        code('unsupported'),
        `${vendorLabel} 不支持当前模型或参数：${text}`,
        { status },
      )
    }
  }
  return new ImageApiError(
    code('failed'),
    `${vendorLabel} 调用失败${status ? `（HTTP ${status}）` : ''}：${text || '未知错误'}`,
    { status },
  )
}

/** 解析 JSON 响应体；非 JSON 时返回原文，交给错误映射展示。 */
async function readPayload(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text.slice(0, 600)
  }
}

/** 合并取消信号与超时信号（Node 20+ 支持 AbortSignal.any）。 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || IMAGE_API.requestTimeoutMs))
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** 下载成图（URL 或 data URL），带体积与 content-type 护栏。 */
export async function downloadImage(source, { signal, fetchImpl = fetch } = {}) {
  if (typeof source === 'string' && source.startsWith('data:')) {
    const match = source.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
    if (!match) throw new ImageApiError('image_api_failed', '厂商返回的 data URL 格式非法')
    const mediaType = match[1] ?? 'image/png'
    if (!/^image\//i.test(mediaType) && mediaType !== 'application/octet-stream') {
      throw new ImageApiError('image_api_failed', `厂商返回了非图片数据：${mediaType}`)
    }
    const raw = match[2]
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]), 'utf8')
    if (raw.length === 0) throw new ImageApiError('image_api_failed', '厂商返回了空图片')
    if (raw.length > IMAGE_API.downloadMaxBytes) {
      throw new ImageApiError('image_api_failed', '厂商返回的图片超过体积上限')
    }
    return raw
  }

  const url = typeof source === 'string' ? source.trim() : ''
  if (!/^https?:\/\//i.test(url)) {
    throw new ImageApiError('image_api_failed', '厂商返回的图片地址非法')
  }
  let response
  try {
    response = await fetchImpl(url, { signal, redirect: 'follow' })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new ImageApiError('image_api_failed', `下载成图失败：${error?.message ?? error}`, { cause: error })
  }
  if (!response.ok) {
    throw new ImageApiError('image_api_failed', `下载成图失败（HTTP ${response.status}）`, { status: response.status })
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > IMAGE_API.downloadMaxBytes) {
    throw new ImageApiError('image_api_failed', '厂商返回的图片超过体积上限')
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new ImageApiError('image_api_failed', '厂商返回了空图片')
  if (buffer.length > IMAGE_API.downloadMaxBytes) {
    throw new ImageApiError('image_api_failed', '厂商返回的图片超过体积上限')
  }
  const contentType = String(response.headers.get('content-type') ?? '')
  if (contentType && !/^image\//i.test(contentType) && !/octet-stream/i.test(contentType)) {
    // 部分 CDN 用 application/json 包一层错误页：此时按失败处理，不把 JSON 当 PNG 落盘。
    throw new ImageApiError('image_api_failed', `下载到的不是图片（${contentType}）`)
  }
  return buffer
}

/** 从 JSON 里取第一张图片的引用（兼容 OpenAI data[] / 硅基流动 images[] / fal / 魔搭 output_images[]）。 */
function firstImageOf(payload) {
  if (typeof payload?.output?.image_url === 'string' && payload.output.image_url.trim()) {
    return { source: payload.output.image_url.trim() }
  }
  const list = Array.isArray(payload?.output_images)
    ? payload.output_images
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.images)
        ? payload.images
        : Array.isArray(payload?.output?.results)
          ? payload.output.results
          : Array.isArray(payload?.results)
            ? payload.results
            : Array.isArray(payload?.image)
              ? payload.image
              : []
  if (list.length === 0) return null
  const item = list[0]
  if (typeof item === 'string') return { source: item }
  if (!item || typeof item !== 'object') return null
  // b64_json 是裸 base64（不是 URL / data URL）：补成 data URL，统一交给 downloadImage 解码。
  const rawB64 = item.b64_json ?? item.image_b64
  const source = typeof rawB64 === 'string' && rawB64
    ? `data:image/png;base64,${rawB64}`
    : item.url ?? item.image_url ?? item.image ?? ''
  return {
    source,
    width: Number(item.width) || null,
    height: Number(item.height) || null,
    seed: Number(item.seed),
  }
}

/** SiliconFlow 各模型的推荐画幅（按比例就近选择，避免 API 拒绝任意尺寸）。 */
const SILICONFLOW_SIZES = Object.freeze({
  'Kwai-Kolors/Kolors': [
    [1024, 1024],
    [960, 1280],
    [768, 1024],
    [720, 1440],
    [720, 1280],
  ],
  'Qwen/Qwen-Image': [
    [1328, 1328],
    [1664, 928],
    [928, 1664],
    [1472, 1140],
    [1140, 1472],
    [1584, 1056],
    [1056, 1584],
  ],
})

/** 从候选尺寸里挑长宽比最接近的一张；没有候选时返回 null。 */
function pickSizeByRatio(candidates, width, height) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  const target = Math.max(1, Number(width) || 1024) / Math.max(1, Number(height) || 1024)
  let best = candidates[0]
  let bestDelta = Number.POSITIVE_INFINITY
  for (const item of candidates) {
    const ratio = item[0] / item[1]
    const delta = Math.abs(Math.log(ratio / target))
    if (delta < bestDelta) {
      best = item
      bestDelta = delta
    }
  }
  return `${best[0]}x${best[1]}`
}

/** OpenAI 只接受固定画幅：按比例映射到最接近的合法尺寸。 */
function openAiSizeOf(model, width, height) {
  const ratio = Math.max(1, width) / Math.max(1, height)
  if (String(model).startsWith('dall-e-3')) {
    if (ratio > 1.2) return '1792x1024'
    if (ratio < 0.83) return '1024x1792'
    return '1024x1024'
  }
  if (ratio > 1.2) return '1536x1024'
  if (ratio < 0.83) return '1024x1536'
  return '1024x1024'
}

/** 统一请求 → OpenAI Images 兼容请求体。 */
function openAiImagesBody({ vendor, model, request }) {
  const { prompt, negativePrompt, width, height, steps, cfg, seed } = request
  const body = {
    model,
    prompt,
    [vendor.countField]: 1,
  }
  const size =
    vendor.id === 'siliconflow'
      ? pickSizeByRatio(SILICONFLOW_SIZES[model], width, height) ?? `${width}x${height}`
      : vendor.id === 'openai'
        ? openAiSizeOf(model, width, height)
        : `${width}x${height}`
  body[vendor.sizeField] = size
  if (request.capabilities.supportsNegative && negativePrompt) body.negative_prompt = negativePrompt
  if (request.capabilities.supportsSteps && Number(steps) > 0) body.num_inference_steps = Math.round(Number(steps))
  if (request.capabilities.supportsGuidance && Number(cfg) > 0) body.guidance_scale = Number(cfg)
  if (request.capabilities.supportsSeed && Number.isFinite(Number(seed))) body.seed = Math.round(Number(seed)) % 2147483647
  // gpt-image-1 恒返回 b64；DALL·E 3 需要显式要求，否则只有一小时有效的 URL。
  if (vendor.responseFormat && vendor.id === 'openai' && String(model).startsWith('dall-e')) {
    body.response_format = 'b64_json'
  }
  return body
}

/** 提交 OpenAI Images 兼容请求并取回成图。 */
async function requestOpenAiImages({ config, vendor, model, request, signal, fetchImpl }) {
  const baseUrl = config.baseUrl || vendor.baseUrl
  const url = `${baseUrl.replace(/\/+$/, '')}/images/generations`
  const body = openAiImagesBody({ vendor, model, request })
  const startedAt = Date.now()
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: withTimeout(signal, IMAGE_API.requestTimeoutMs),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error
    throw new ImageApiError('image_api_failed', `${vendor.label} 请求失败：${error?.message ?? error}`, { cause: error })
  }
  const payload = await readPayload(response)
  if (!response.ok) throw mapImageApiError(response.status, payload, vendor.label)
  const image = firstImageOf(payload)
  if (!image || !image.source) {
    throw new ImageApiError('image_api_failed', `${vendor.label} 未返回图片：${messageOf(payload) || '响应格式异常'}`)
  }
  const buffer = await downloadImage(image.source, { signal, fetchImpl })
  return {
    buffer,
    width: image.width ?? request.width,
    height: image.height ?? request.height,
    seed: Number.isFinite(Number(image.seed)) ? Number(image.seed) : request.seed,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    modelId: model,
  }
}

/** fal 的 image_size 是枚举（部分模型也接受自定义宽高）：按比例映射到最接近的预设。 */
function falImageSizeOf(width, height) {
  const ratio = Math.max(1, Number(width) || 1024) / Math.max(1, Number(height) || 1024)
  if (ratio > 1.6) return 'landscape_16_9'
  if (ratio > 1.15) return 'landscape_4_3'
  if (ratio < 0.62) return 'portrait_16_9'
  if (ratio < 0.87) return 'portrait_4_3'
  return 'square_hd'
}

/** fal 队列请求体：只带模型认识的字段。 */
function falBody({ model, request }) {
  const { prompt, width, height, steps, cfg, seed } = request
  const body = {
    prompt,
    num_images: 1,
    image_size: falImageSizeOf(width, height),
  }
  if (request.capabilities.supportsSteps && Number(steps) > 0) body.num_inference_steps = Math.round(Number(steps))
  if (request.capabilities.supportsGuidance && Number(cfg) > 0) body.guidance_scale = Number(cfg)
  if (request.capabilities.supportsSeed && Number.isFinite(Number(seed))) body.seed = Math.round(Number(seed)) % 2147483647
  // 不同 fal 模型的端点参数有差异：只有明确支持时才算入负向词（当前清单里都为 false）。
  if (request.capabilities.supportsNegative && request.negativePrompt) body.negative_prompt = request.negativePrompt
  void model
  return body
}

/** 等待 fal 队列完成：轮询 status_url，COMPLETED 后再取 response_url。 */
async function requestFalQueue({ config, vendor, model, request, signal, fetchImpl, log }) {
  const baseUrl = (config.baseUrl || vendor.baseUrl).replace(/\/+$/, '')
  const url = `${baseUrl}/${String(model).replace(/^\/+/, '')}`
  const headers = {
    Authorization: `Key ${config.apiKey}`,
    'Content-Type': 'application/json',
  }
  const startedAt = Date.now()
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(falBody({ model, request })),
      signal: withTimeout(signal, IMAGE_API.requestTimeoutMs),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error
    throw new ImageApiError('image_api_failed', `${vendor.label} 提交失败：${error?.message ?? error}`, { cause: error })
  }
  const submitted = await readPayload(response)
  if (!response.ok) throw mapImageApiError(response.status, submitted, vendor.label)
  const statusUrl = typeof submitted?.status_url === 'string' ? submitted.status_url : ''
  const responseUrl = typeof submitted?.response_url === 'string' ? submitted.response_url : ''
  if (!statusUrl || !responseUrl) {
    throw new ImageApiError('image_api_failed', `${vendor.label} 未返回队列地址：响应格式异常`)
  }

  const deadline = Date.now() + IMAGE_API.pollTimeoutMs
  while (true) {
    if (signal?.aborted) {
      const abort = new Error('aborted')
      abort.name = 'AbortError'
      throw abort
    }
    if (Date.now() > deadline) {
      throw new ImageApiError('image_api_failed', `${vendor.label} 排队超时：请稍后重试或换用更快的模型`)
    }
    await new Promise((resolve) => setTimeout(resolve, IMAGE_API.pollIntervalMs))
    let poll
    try {
      poll = await fetchImpl(statusUrl, { headers: { Authorization: headers.Authorization }, signal })
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error
      // 单拍网络抖动不判死：继续在总预算内重试。
      log?.debug?.(`fal_status_retry ${error?.message ?? error}`)
      continue
    }
    const status = await readPayload(poll)
    if (!poll.ok) throw mapImageApiError(poll.status, status, vendor.label)
    if (status?.status === 'COMPLETED') {
      if (status.error) throw new ImageApiError('image_api_failed', `${vendor.label} 生成失败：${status.error}`)
      break
    }
    if (status?.status === 'FAILED') {
      throw new ImageApiError(
        'image_api_failed',
        `${vendor.label} 生成失败：${status.error || status.error_type || '未知原因'}`,
      )
    }
  }

  let result
  try {
    const finalResponse = await fetchImpl(responseUrl, { headers: { Authorization: headers.Authorization }, signal })
    result = await readPayload(finalResponse)
    if (!finalResponse.ok) throw mapImageApiError(finalResponse.status, result, vendor.label)
  } catch (error) {
    if (error instanceof ImageApiError) throw error
    if (error?.name === 'AbortError' || signal?.aborted) throw error
    throw new ImageApiError('image_api_failed', `${vendor.label} 取结果失败：${error?.message ?? error}`, { cause: error })
  }
  const image = firstImageOf(result)
  if (!image || !image.source) {
    throw new ImageApiError('image_api_failed', `${vendor.label} 未返回图片：${messageOf(result) || '响应格式异常'}`)
  }
  const buffer = await downloadImage(image.source, { signal, fetchImpl })
  return {
    buffer,
    width: image.width ?? request.width,
    height: image.height ?? request.height,
    seed: Number.isFinite(Number(image.seed)) ? Number(image.seed) : request.seed,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    modelId: model,
  }
}

/**
 * 生成一张图。
 *
 * @param {object} input
 * @param {{ vendor: string, model: string, baseUrl?: string, apiKey: string }} input.config
 * @param {object} input.request `{ prompt, negativePrompt, width, height, steps, cfg, seed, capabilities }`
 * @param {AbortSignal} [input.signal]
 * @param {Function} [input.fetchImpl] 测试注入
 * @param {object} [input.log]
 * @returns {Promise<{ buffer: Buffer, width: number, height: number, seed: number|null, seconds: number, modelId: string }>}
 */
/** Base64 参考图 → data URL（按魔数区分 JPEG 与 PNG）。 */
function referenceDataUrl(imageB64) {
  const b64 = String(imageB64 || '').trim()
  const mime = b64.startsWith('/9j/') ? 'image/jpeg' : 'image/png'
  return `data:${mime};base64,${b64}`
}

/** 按模型最大长边等比缩放并对齐到 8 的倍数（例如 FLUX.2-klein 上限 1024）。 */
function clampModelScopeSize(width, height, maxEdge) {
  let w = Math.max(64, Math.round(Number(width) || 1024))
  let h = Math.max(64, Math.round(Number(height) || 1024))
  const limit = Number(maxEdge)
  if (Number.isFinite(limit) && limit >= 64 && Math.max(w, h) > limit) {
    const scale = limit / Math.max(w, h)
    w = Math.max(64, Math.round((w * scale) / 8) * 8)
    h = Math.max(64, Math.round((h * scale) / 8) * 8)
  }
  return `${w}x${h}`
}

/** 魔搭 API-Inference 异步请求体：按能力位下发可选控制参数与 Base64 参考图。 */
function modelScopeBody({ model, request }) {
  const { prompt, negativePrompt, width, height, steps, cfg, seed, referenceImages, capabilities } = request
  const body = {
    model,
    prompt,
    n: 1,
    size: clampModelScopeSize(width, height, capabilities?.maxEdge),
  }
  if (capabilities?.supportsNegative && negativePrompt) body.negative_prompt = negativePrompt
  if (capabilities?.supportsSteps && Number(steps) > 0) body.steps = Math.round(Number(steps))
  if (capabilities?.supportsGuidance && Number(cfg) >= 1.5) body.guidance = Number(cfg)
  if (capabilities?.supportsSeed && Number.isFinite(Number(seed))) body.seed = Math.round(Number(seed)) % 2147483647
  if (capabilities?.supportsReference && Array.isArray(referenceImages) && referenceImages.length > 0) {
    const urls = referenceImages
      .map((item) => (typeof item?.image_b64 === 'string' && item.image_b64.trim() ? referenceDataUrl(item.image_b64) : ''))
      .filter(Boolean)
    if (urls.length > 0) body.image_url = urls
  }
  return body
}

/** 魔搭异步端点基址：兼容传入 `https://api-inference.modelscope.cn` 或 `.../v1`。 */
function modelScopeApiRoot(baseUrl) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '')
  return /\/v1$/i.test(clean) ? clean : `${clean}/v1`
}

/** 提交魔搭 API-Inference 异步任务并轮询 `/tasks/{task_id}` 获取成图。 */
async function requestModelScopeAsync({ config, vendor, model, request, signal, fetchImpl, log }) {
  const apiRoot = modelScopeApiRoot(config.baseUrl || vendor.baseUrl)
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  }
  const startedAt = Date.now()
  let response
  try {
    response = await fetchImpl(`${apiRoot}/images/generations`, {
      method: 'POST',
      headers: {
        ...headers,
        'X-ModelScope-Async-Mode': 'true',
      },
      body: JSON.stringify(modelScopeBody({ model, request })),
      signal: withTimeout(signal, IMAGE_API.requestTimeoutMs),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error
    throw new ImageApiError('image_api_failed', `${vendor.label} 提交失败：${error?.message ?? error}`, { cause: error })
  }
  const submitted = await readPayload(response)
  if (!response.ok) throw mapImageApiError(response.status, submitted, vendor.label)

  // 若服务端直接同步返回了图片，跳过轮询直接下载。
  const immediate = firstImageOf(submitted)
  if (immediate && immediate.source) {
    const buffer = await downloadImage(immediate.source, { signal, fetchImpl })
    return {
      buffer,
      width: immediate.width ?? request.width,
      height: immediate.height ?? request.height,
      seed: Number.isFinite(Number(immediate.seed)) ? Number(immediate.seed) : request.seed,
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      modelId: model,
    }
  }

  const taskId = typeof submitted?.task_id === 'string'
    ? submitted.task_id.trim()
    : typeof submitted?.output?.task_id === 'string'
      ? submitted.output.task_id.trim()
      : ''
  if (!taskId) {
    throw new ImageApiError('image_api_failed', `${vendor.label} 未返回 task_id：${messageOf(submitted) || '响应格式异常'}`)
  }

  const taskUrl = `${apiRoot}/tasks/${encodeURIComponent(taskId)}`
  const deadline = Date.now() + IMAGE_API.pollTimeoutMs
  let result = null
  while (true) {
    if (signal?.aborted) {
      const abort = new Error('aborted')
      abort.name = 'AbortError'
      throw abort
    }
    if (Date.now() > deadline) {
      throw new ImageApiError('image_api_failed', `${vendor.label} 排队超时：请稍后重试`)
    }
    await new Promise((resolve) => setTimeout(resolve, IMAGE_API.pollIntervalMs))
    let poll
    try {
      poll = await fetchImpl(taskUrl, {
        headers: {
          Authorization: headers.Authorization,
          'X-ModelScope-Task-Type': 'image_generation',
        },
        signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error
      log?.debug?.(`modelscope_status_retry ${error?.message ?? error}`)
      continue
    }
    const payload = await readPayload(poll)
    if (!poll.ok) throw mapImageApiError(poll.status, payload, vendor.label)
    const statusText = String(payload?.task_status ?? payload?.status ?? payload?.output?.task_status ?? '').trim().toUpperCase()
    if (statusText === 'SUCCEED' || statusText === 'SUCCEEDED') {
      result = payload
      break
    }
    if (statusText === 'FAILED' || statusText === 'CANCELED' || statusText === 'CANCELLED') {
      throw new ImageApiError(
        'image_api_failed',
        `${vendor.label} 生成失败：${messageOf(payload) || statusText}`,
      )
    }
  }

  const image = firstImageOf(result)
  if (!image || !image.source) {
    throw new ImageApiError('image_api_failed', `${vendor.label} 未返回图片：${messageOf(result) || '响应格式异常'}`)
  }
  const buffer = await downloadImage(image.source, { signal, fetchImpl })
  return {
    buffer,
    width: image.width ?? request.width,
    height: image.height ?? request.height,
    seed: Number.isFinite(Number(image.seed)) ? Number(image.seed) : request.seed,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    modelId: model,
  }
}

export async function generateCloudImage({ config, request, signal, fetchImpl = fetch, log = null }) {
  const vendor = imageApiVendorOf(config?.vendor)
  if (!vendor) throw new ImageApiError('image_api_unsupported', `未知的生图 API 服务商：${String(config?.vendor ?? '')}`)
  const normalized = normalizeImageApiConfig(config, { allowInsecure: true })
  const model = imageApiModelOf(vendor.id, config.model) ?? imageApiModelOf(vendor.id, normalized.model)
  if (!model) {
    throw new ImageApiError('image_api_unsupported', `${vendor.label} 不支持模型「${String(config.model ?? '')}」`)
  }
  const resolved = {
    vendor: vendor.id,
    model: model.id,
    baseUrl: normalized.baseUrl,
    apiKey: typeof config.apiKey === 'string' ? config.apiKey : '',
  }
  const payload = {
    ...request,
    width: Math.max(256, Math.round(Number(request?.width) || model.size || 1024)),
    height: Math.max(256, Math.round(Number(request?.height) || model.size || 1024)),
    capabilities: request?.capabilities ?? {
      supportsNegative: model.supportsNegative === true,
      supportsSteps: model.supportsSteps === true,
      supportsGuidance: model.supportsGuidance === true,
      supportsSeed: model.supportsSeed === true,
    },  }
  if (vendor.protocol === 'fal-queue') {
    return requestFalQueue({ config: resolved, vendor, model: model.id, request: payload, signal, fetchImpl, log })
  }
  if (vendor.protocol === 'modelscope-async') {
    return requestModelScopeAsync({ config: resolved, vendor, model: model.id, request: payload, signal, fetchImpl, log })
  }
  return requestOpenAiImages({ config: resolved, vendor, model: model.id, request: payload, signal, fetchImpl })
}
