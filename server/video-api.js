/**
 * 商业视频 API 适配层（M4.1）。
 *
 * 只做三件事：把统一请求翻译成硅基流动的视频提交体、轮询状态接口、把结果视频
 * 下载到临时文件。会话、队列、落盘、取消语义仍由 JobQueue 负责，本文件不读写
 * 工作区、不写 meta、不碰 UI 状态。
 *
 * 已适配两种提交体形状（由 `shared/image-providers.js` 的 `bodyStyle` 决定）：
 *  - `minimax`：`duration` / `resolution` / `ratio` + `images[{ url, role }]`
 *    （首帧 `first_frame`、尾帧 `last_frame`，图片用 data URL）；
 *  - `wan`：`image_size` + `image`（首帧 data URL），无时长参数（平台固定档位）。
 *
 * 结果 URL 有效期约 1 小时（部分文档标注 10 分钟），因此拿到 `Succeed` 后必须立即
 * 下载；下载落临时文件而不是内存 Buffer，避免长视频把 Host 内存抬高。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { VIDEO } from '../shared/contract.js'
import {
  imageApiVendorOf,
  normalizeImageApiConfig,
  videoApiModelOf,
} from '../shared/image-providers.js'
import { ImageApiError, mapImageApiError } from './image-api.js'

/** 读取 JSON 响应体；非 JSON 时返回原文，交给错误映射展示。 */
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
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || VIDEO.requestTimeoutMs))
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 把 base64 图片补成 data URL；按文件头识别 PNG / JPEG / WebP。 */
function dataUrlOfImage(base64) {
  const raw = typeof base64 === 'string' ? base64.trim() : ''
  if (!raw) return ''
  if (raw.startsWith('data:')) return raw
  if (raw.startsWith('/9j/')) return `data:image/jpeg;base64,${raw}`
  if (raw.startsWith('UklGR')) return `data:image/webp;base64,${raw}`
  return `data:image/png;base64,${raw}`
}

/** 按请求宽高挑最接近的模型画幅比例（模型只接受枚举值）。 */
export function pickVideoRatio(candidates, width, height, fallback) {
  const list = Array.isArray(candidates) ? candidates : []
  if (list.length === 0) return fallback || '16:9'
  const target = Math.max(1, Number(width) || 1024) / Math.max(1, Number(height) || 1024)
  let best = list[0]
  let bestDelta = Number.POSITIVE_INFINITY
  for (const id of list) {
    const [w, h] = String(id).split(':').map(Number)
    if (!w || !h) continue
    const delta = Math.abs(Math.log(w / h / target))
    if (delta < bestDelta) {
      best = id
      bestDelta = delta
    }
  }
  return best
}

/** 按比例与分辨率档位估算输出像素（仅在没有可解析容器信息时兜底使用）。 */
export function nominalVideoSize(ratio, resolution) {
  const [w, h] = String(ratio || '16:9').split(':').map(Number)
  const ratioValue = w > 0 && h > 0 ? w / h : 16 / 9
  const shortEdge = resolution === '480p' ? 480 : 768
  const even = (value) => Math.max(2, Math.round(value / 2) * 2)
  if (ratioValue >= 1) return { width: even(shortEdge * ratioValue), height: even(shortEdge) }
  return { width: even(shortEdge), height: even(shortEdge / ratioValue) }
}

/** Wan 系列只接受三个 image_size 枚举：按比例映射。 */
function wanImageSizeOf(ratio) {
  const [w, h] = String(ratio || '16:9').split(':').map(Number)
  const value = w > 0 && h > 0 ? w / h : 16 / 9
  if (value >= 1.5) return '1280x720'
  if (value <= 0.67) return '720x1280'
  return '960x960'
}

/** MP4 容器里的容器型 box：只有这些需要继续向下找 `stsd`。 */
const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])
/** 视频采样描述里能取到像素宽高的编码类型。 */
const MP4_VISUAL_ENTRIES = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'vp09', 'av01'])

/**
 * 从 MP4 容器读取真实像素尺寸（`stsd` → `avc1`/`hvc1` 的 VisualSampleEntry）。
 *
 * 厂商状态接口只回视频地址，不回分辨率；而参考图生视频时实际画幅由**图片比例**决定
 * （真机实测：1024×1024 首帧 + `ratio=16:9` 输出 640×640），因此落盘尺寸必须从文件本身读，
 * 不能用请求参数推算。解析失败（非 MP4 / 分片损坏）返回 null，由调用方回退到估算值。
 *
 * @param {Buffer} buffer 完整 MP4 字节
 * @returns {{ width: number, height: number } | null}
 */
export function probeMp4Size(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null
  let found = null

  const walk = (start, end, depth) => {
    if (depth > 6 || found) return
    let offset = start
    while (offset + 8 <= end && !found) {
      let size = buffer.readUInt32BE(offset)
      const type = buffer.subarray(offset + 4, offset + 8).toString('latin1')
      let header = 8
      if (size === 1) {
        if (offset + 16 > end) return
        size = Number(buffer.readBigUInt64BE(offset + 8))
        header = 16
      } else if (size === 0) {
        size = end - offset
      }
      if (size < header || offset + size > end) return
      const body = offset + header
      const boxEnd = offset + size
      if (MP4_CONTAINERS.has(type)) {
        walk(body, boxEnd, depth + 1)
      } else if (type === 'stsd') {
        // stsd：version+flags(4) + entry_count(4)，随后是采样描述条目。
        const count = buffer.readUInt32BE(body + 4)
        let cursor = body + 8
        for (let index = 0; index < count && cursor + 36 <= boxEnd && !found; index += 1) {
          const entrySize = buffer.readUInt32BE(cursor)
          const entryType = buffer.subarray(cursor + 4, cursor + 8).toString('latin1')
          if (entrySize < 8) break
          if (MP4_VISUAL_ENTRIES.has(entryType)) {
            // VisualSampleEntry 的宽高在样本条目头部之后第 24 / 26 字节（16 位大端）。
            const width = buffer.readUInt16BE(cursor + 8 + 24)
            const height = buffer.readUInt16BE(cursor + 8 + 26)
            if (width > 0 && height > 0) found = { width, height }
          }
          cursor += entrySize
        }
      }
      offset = boxEnd
    }
  }

  walk(0, buffer.length, 0)
  return found
}

/**
 * 统一请求 → 视频提交体。
 *
 * `request.frames` 是已读盘的首帧 / 尾帧 base64 数组（最多 2 张）；模型不支持
 * 首帧时由 JobQueue 在入队阶段拒绝，这里只做形状转换。
 */
export function buildVideoSubmitBody({ model, request }) {
  const frames = Array.isArray(request.frames)
    ? request.frames.map(dataUrlOfImage).filter(Boolean)
    : []
  const body = {
    model: model.id,
    prompt: String(request.prompt ?? ''),
  }
  if (model.supportsNegative === true && request.negativePrompt) {
    body.negative_prompt = String(request.negativePrompt)
  }
  if (model.supportsSeed === true && Number.isFinite(Number(request.seed))) {
    body.seed = Math.round(Number(request.seed)) % 2147483647
  }

  if (model.bodyStyle === 'wan') {
    const ratio = request.ratio || pickVideoRatio(model.ratios, request.width, request.height, model.defaultRatio)
    body.image_size = wanImageSizeOf(ratio)
    if (frames[0]) body.image = frames[0]
    return body
  }

  // MiniMax H3：时长 / 分辨率 / 画幅 + 首尾帧。
  const duration = model.duration
    ? Math.min(model.duration.max, Math.max(model.duration.min, Math.round(Number(request.duration) || model.duration.default)))
    : null
  if (duration !== null) body.duration = duration
  if (Array.isArray(model.resolutions) && model.resolutions.length > 0) {
    body.resolution = model.resolutions.includes(request.resolution)
      ? request.resolution
      : model.defaultResolution || model.resolutions[0]
  }
  body.ratio = Array.isArray(model.ratios) && model.ratios.includes(request.ratio)
    ? request.ratio
    : pickVideoRatio(model.ratios, request.width, request.height, model.defaultRatio)
  if (frames.length > 0) {
    body.images = frames.slice(0, 2).map((url, index) => ({
      url,
      role: index === 0 ? 'first_frame' : 'last_frame',
    }))
  }
  return body
}

/** 下载视频到临时文件，带体积与 content-type 护栏。 */
export async function downloadVideo(source, { signal, fetchImpl = fetch, tempDir }) {
  const url = typeof source === 'string' ? source.trim() : ''
  if (!/^https?:\/\//i.test(url)) {
    throw new ImageApiError('video_api_failed', '厂商返回的视频地址非法')
  }
  let response
  try {
    response = await fetchImpl(url, { signal, redirect: 'follow' })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new ImageApiError('video_api_failed', `下载视频失败：${error?.message ?? error}`, { cause: error })
  }
  if (!response.ok) {
    throw new ImageApiError('video_api_failed', `下载视频失败（HTTP ${response.status}）`, { status: response.status })
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > VIDEO.downloadMaxBytes) {
    throw new ImageApiError('video_api_failed', '厂商返回的视频超过体积上限')
  }
  const contentType = String(response.headers.get('content-type') ?? '')
  if (contentType && !/^video\//i.test(contentType) && !/octet-stream/i.test(contentType)) {
    throw new ImageApiError('video_api_failed', `下载到的不是视频（${contentType}）`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new ImageApiError('video_api_failed', '厂商返回了空视频')
  if (buffer.length > VIDEO.downloadMaxBytes) {
    throw new ImageApiError('video_api_failed', '厂商返回的视频超过体积上限')
  }
  await mkdir(tempDir, { recursive: true })
  const tempPath = join(tempDir, `video-${Date.now()}.mp4`)
  await writeFile(tempPath, buffer)
  // 真实像素尺寸从容器里读：参考图生视频时画幅由图片比例决定，请求参数只是建议值。
  return { tempPath, bytes: buffer.length, size: probeMp4Size(buffer) }
}

/**
 * 提交视频任务并轮询到完成。
 *
 * @param {object} input
 * @param {{ vendor: string, model: string, baseUrl?: string, apiKey: string }} input.config
 * @param {object} input.request `{ prompt, negativePrompt, width, height, duration, resolution, seed, frames }`
 * @param {string} input.tempDir 结果视频落盘目录（JobQueue 的任务级临时目录）
 * @param {AbortSignal} [input.signal]
 * @param {Function} [input.fetchImpl] 测试注入
 * @param {Function} [input.onProgress] 阶段回调：`{ phase, elapsedMs }`
 * @returns {Promise<{ tempPath: string, bytes: number, ext: 'mp4', mediaType: 'video', width: number, height: number, duration: number|null, seed: number|null, seconds: number, requestId: string, modelId: string }>}
 */
export async function generateCloudVideo({
  config,
  request,
  tempDir,
  signal,
  fetchImpl = fetch,
  log = null,
  onProgress = null,
}) {
  const vendor = imageApiVendorOf(config?.vendor)
  if (!vendor) {
    throw new ImageApiError('video_api_unsupported', `未知的视频 API 服务商：${String(config?.vendor ?? '')}`)
  }
  const normalized = normalizeImageApiConfig(config, { allowInsecure: true })
  const model = videoApiModelOf(vendor.id, config.model) ?? videoApiModelOf(vendor.id, normalized.model)
  if (!model) {
    throw new ImageApiError('video_api_unsupported', `${vendor.label} 不支持视频模型「${String(config.model ?? '')}」`)
  }

  const baseUrl = (normalized.baseUrl || vendor.baseUrl).replace(/\/+$/, '')
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  }
  const body = buildVideoSubmitBody({ model, request })
  const startedAt = Date.now()

  let submitted
  try {
    const response = await fetchImpl(`${baseUrl}/video/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: withTimeout(signal, VIDEO.requestTimeoutMs),
    })
    submitted = await readPayload(response)
    if (!response.ok) throw mapImageApiError(response.status, submitted, `${vendor.label} 视频 API`, { codePrefix: 'video_api' })
  } catch (error) {
    if (error instanceof ImageApiError) throw error
    if (error?.name === 'AbortError' || signal?.aborted) throw error
    throw new ImageApiError('video_api_failed', `${vendor.label} 视频提交失败：${error?.message ?? error}`, { cause: error })
  }
  const requestId = typeof submitted?.requestId === 'string' ? submitted.requestId.trim() : ''
  if (!requestId) {
    throw new ImageApiError('video_api_failed', `${vendor.label} 未返回 requestId：响应格式异常`)
  }
  log?.info?.(`video_submit vendor=${vendor.id} model=${model.id} requestId=${requestId}`)

  const deadline = Date.now() + VIDEO.pollTimeoutMs
  let videoUrl = ''
  let pollCount = 0
  let lastPhase = ''
  while (true) {
    if (signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    if (Date.now() > deadline) {
      throw new ImageApiError('video_api_failed', `${vendor.label} 视频生成超时：请稍后重试或改用更短的时长`)
    }
    if (pollCount > 0) await sleep(VIDEO.pollIntervalMs, signal)
    pollCount += 1

    let status
    try {
      const response = await fetchImpl(`${baseUrl}/video/status`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ requestId }),
        signal: withTimeout(signal, VIDEO.requestTimeoutMs),
      })
      status = await readPayload(response)
      if (!response.ok) throw mapImageApiError(response.status, status, `${vendor.label} 视频 API`, { codePrefix: 'video_api' })
    } catch (error) {
      if (error instanceof ImageApiError) throw error
      if (error?.name === 'AbortError' || signal?.aborted) throw error
      // 单拍网络抖动不判死：继续在总预算内重试。
      log?.debug?.(`video_status_retry ${error?.message ?? error}`)
      continue
    }

    const state = typeof status?.status === 'string' ? status.status : ''
    if (state === 'Succeed') {
      videoUrl = String(status?.results?.videos?.[0]?.url ?? '')
      if (!videoUrl) {
        throw new ImageApiError('video_api_failed', `${vendor.label} 任务成功但未返回视频地址`)
      }
      break
    }
    if (state === 'Failed') {
      throw new ImageApiError(
        'video_api_failed',
        `${vendor.label} 视频生成失败：${status?.reason || status?.message || '未知原因'}`,
      )
    }
    if (!state) {
      throw new ImageApiError('video_api_failed', `${vendor.label} 状态响应异常：${JSON.stringify(status).slice(0, 300)}`)
    }
    const phase = state === 'InQueue' ? '排队中' : '生成中'
    if (phase !== lastPhase) {
      lastPhase = phase
      onProgress?.({ phase, elapsedMs: Date.now() - startedAt })
    }
  }

  onProgress?.({ phase: '下载中', elapsedMs: Date.now() - startedAt })
  const downloaded = await downloadVideo(videoUrl, { signal, fetchImpl, tempDir })
  const ratio = pickVideoRatio(model.ratios, request.width, request.height, model.defaultRatio)
  const resolution = model.resolutions?.includes(request.resolution)
    ? request.resolution
    : model.defaultResolution || model.resolutions?.[0] || '768p'
  // 优先用容器里的真实宽高（首帧生视频的画幅由图片比例决定）；解析不到时退回档位估算。
  const nominal = nominalVideoSize(ratio, resolution)
  const size = downloaded.size ?? nominal
  if (downloaded.size && (downloaded.size.width !== nominal.width || downloaded.size.height !== nominal.height)) {
    log?.info?.(
      `video_size_probe actual=${downloaded.size.width}x${downloaded.size.height} ` +
        `nominal=${nominal.width}x${nominal.height} ratio=${ratio} resolution=${resolution}`,
    )
  }
  const duration = model.duration
    ? Math.min(model.duration.max, Math.max(model.duration.min, Math.round(Number(request.duration) || model.duration.default)))
    : null
  return {
    tempPath: downloaded.tempPath,
    bytes: downloaded.bytes,
    ext: 'mp4',
    mediaType: 'video',
    width: size.width,
    height: size.height,
    duration,
    seed: Number.isFinite(Number(request.seed)) ? Number(request.seed) : null,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    requestId,
    modelId: model.id,
  }
}
