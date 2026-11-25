/**
 * 资产工坊的渲染进程算子桥。
 *
 * 分两层：
 *  - `web/logic/workshop.js`：纯算法（网格探测、像素对齐、接缝评估、平铺几何、序列帧切片）；
 *  - 本文件：把 canvas / <img> 与纯算法接起来，并提供 dataURL、缩略图、矢量图转换等浏览器能力。
 *
 * 测试（Node 假渲染器）里没有 document / canvas / Image：这里每个入口都做环境判空，
 * 返回 null 或空结果，让组件能安全挂载并渲染结构，不抛异常。
 */

import { WORKSHOP } from '../../../shared/contract.js'
import * as workshopLogic from '../../logic/workshop.js'

/** 当前环境是否具备 canvas（真实浏览器 / Electron 渲染进程为 true）。 */
export function canUseCanvas() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function'
}

/** 建一个离屏 canvas；环境不支持或尺寸非法时返回 null。 */
export function createCanvas(width, height) {
  if (!canUseCanvas()) return null
  const w = Math.max(1, Math.round(Number(width) || 1))
  const h = Math.max(1, Math.round(Number(height) || 1))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}

/** 取 2D 上下文；canvas 没有可用的 2D 上下文时返回 null。 */
export function context2d(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null
  return canvas.getContext('2d') || null
}

/** 加载一张图片；无 DOM / 加载失败时返回 null（不抛异常）。 */
export function loadImage(url) {
  if (typeof Image === 'undefined' || !url) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const image = new Image()
      image.decoding = 'async'
      image.onload = () => resolve(image)
      image.onerror = () => resolve(null)
      image.src = url
    } catch {
      resolve(null)
    }
  })
}

/** 把图片画到离屏 canvas 并读出 RGBA；环境不支持时返回 null。 */
export function pixelsOfImage(image) {
  const width = Number(image && (image.naturalWidth || image.width)) || 0
  const height = Number(image && (image.naturalHeight || image.height)) || 0
  if (!width || !height) return null
  const canvas = createCanvas(width, height)
  const context = context2d(canvas)
  if (!context) return null
  try {
    context.drawImage(image, 0, 0, width, height)
    const imageData = context.getImageData(0, 0, width, height)
    return { width, height, data: imageData.data }
  } catch {
    return null
  }
}

/**
 * 源图像素的小容量 LRU。
 *
 * 工坊切图时 `pixel-snap` 自动探测、`tile` 接缝 MAE 与 `sprite-slice` 切帧都要用同一份
 * 全分辨率 RGBA；来回对比两张图时重复 `<canvas>` 解码是纯浪费。这里按 URL 缓存最近
 * 8 张，并用总字节上限兜底（4K RGBA 单张约 32 MB，不能让缓存无限吃内存）。
 * 失败结果不进缓存，换会话 / 内存压力下由浏览器回收模块作用域即可。
 */
export const PIXEL_CACHE_MAX_ENTRIES = 8
export const PIXEL_CACHE_MAX_BYTES = 64 * 1024 * 1024

const pixelCache = new Map()
const pixelLoads = new Map()
let pixelCacheBytes = 0

function pixelBytes(pixels) {
  return pixels && Number.isFinite(pixels.width) && Number.isFinite(pixels.height)
    ? Math.max(0, pixels.width * pixels.height * 4)
    : 0
}

function rememberPixels(url, pixels) {
  const bytes = pixelBytes(pixels)
  if (!bytes) return
  const previous = pixelCache.get(url)
  if (previous) pixelCacheBytes -= pixelBytes(previous)
  pixelCache.delete(url)
  pixelCache.set(url, pixels)
  pixelCacheBytes += bytes
  while (pixelCache.size > PIXEL_CACHE_MAX_ENTRIES || pixelCacheBytes > PIXEL_CACHE_MAX_BYTES) {
    const oldest = pixelCache.keys().next().value
    if (!oldest) break
    pixelCacheBytes -= pixelBytes(pixelCache.get(oldest))
    pixelCache.delete(oldest)
  }
}

/** 测试 / 工作区切换用：释放已缓存的像素与在途请求记录。 */
export function clearPixelCache() {
  pixelCache.clear()
  pixelLoads.clear()
  pixelCacheBytes = 0
}

/** 只读缓存状态（测试与诊断用）。 */
export function pixelCacheStats() {
  return { entries: pixelCache.size, bytes: pixelCacheBytes, pending: pixelLoads.size }
}

/**
 * 先加载图片再读像素；任一步失败返回 null。
 *
 * 同一 URL 的并发请求共享同一个 Promise（在途去重）；成功结果按 LRU 缓存，重复切回
 * 同一作品时直接复用 RGBA，不再重新解码。URL 为空时返回 null。
 */
export async function pixelsOfUrl(url) {
  const key = typeof url === 'string' ? url.trim() : ''
  if (!key) return null
  const cached = pixelCache.get(key)
  if (cached) {
    // 命中即刷新 LRU 次序。
    pixelCache.delete(key)
    pixelCache.set(key, cached)
    return cached
  }
  const pending = pixelLoads.get(key)
  if (pending) return pending
  const task = (async () => {
    const image = await loadImage(key)
    if (!image) return null
    const pixels = pixelsOfImage(image)
    if (pixels) rememberPixels(key, pixels)
    return pixels
  })().finally(() => {
    pixelLoads.delete(key)
  })
  pixelLoads.set(key, task)
  return task
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 纯 JS base64（不依赖 btoa / Buffer），输出无换行，供 Host base64 解码。 */
function encodeBase64(bytes) {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0
    const chunk = (first << 16) | (second << 8) | third
    output += BASE64_ALPHABET[(chunk >> 18) & 63]
    output += BASE64_ALPHABET[(chunk >> 12) & 63]
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(chunk >> 6) & 63] : '='
    output += index + 2 < bytes.length ? BASE64_ALPHABET[chunk & 63] : '='
  }
  return output
}

/**
 * 把任意 RGBA 源图缩成 L2 模型需要的 256×256 RGB 输入。
 *
 * 规则与 MobileCLIP 的预处理器一致：短边缩到 256，长边等比放大后中心裁切；
 * 透明像素先合成到白底（模型只吃 RGB，不能把透明通道的黑色预乘值当成黑色画面）。
 * 使用双线性采样而不是最近邻：像素画本身仍会在 L1 中按原始像素判定，L2 只补语义，
 * 不需要在这里保留硬边。函数不依赖 canvas，Node 单测可直接验证。
 *
 * @param {{ width?: number, height?: number, data?: ArrayLike<number> }} pixels RGBA
 * @param {{ size?: number }} [options]
 * @returns {{ width: number, height: number, data: string } | null}
 */
export function workshopVisionPixels(pixels, options = {}) {
  const width = Math.max(0, Math.round(Number(pixels && pixels.width) || 0))
  const height = Math.max(0, Math.round(Number(pixels && pixels.height) || 0))
  const data = pixels ? pixels.data : null
  if (!width || !height || !data || typeof data.length !== 'number') return null
  if (data.length < width * height * 4) return null
  const size = Math.max(64, Math.round(Number(options.size) || WORKSHOP.vision.imageSize || 256))
  const scale = size / Math.min(width, height)
  const resizedWidth = Math.max(size, Math.round(width * scale))
  const resizedHeight = Math.max(size, Math.round(height * scale))
  const cropX = Math.floor((resizedWidth - size) / 2)
  const cropY = Math.floor((resizedHeight - size) / 2)
  const rgb = new Uint8Array(size * size * 3)

  const compositeAt = (x, y) => {
    const index = (y * width + x) * 4
    const alpha = data[index + 3] / 255
    const inverse = 1 - alpha
    return [
      data[index] * alpha + 255 * inverse,
      data[index + 1] * alpha + 255 * inverse,
      data[index + 2] * alpha + 255 * inverse,
    ]
  }

  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(height - 1, Math.max(0, (cropY + y + 0.5) / scale - 0.5))
    const y0 = Math.floor(sourceY)
    const y1 = Math.min(height - 1, y0 + 1)
    const wy = sourceY - y0
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(width - 1, Math.max(0, (cropX + x + 0.5) / scale - 0.5))
      const x0 = Math.floor(sourceX)
      const x1 = Math.min(width - 1, x0 + 1)
      const wx = sourceX - x0
      const topLeft = compositeAt(x0, y0)
      const topRight = compositeAt(x1, y0)
      const bottomLeft = compositeAt(x0, y1)
      const bottomRight = compositeAt(x1, y1)
      const target = (y * size + x) * 3
      for (let channel = 0; channel < 3; channel += 1) {
        const top = topLeft[channel] + (topRight[channel] - topLeft[channel]) * wx
        const bottom = bottomLeft[channel] + (bottomRight[channel] - bottomLeft[channel]) * wx
        rgb[target + channel] = Math.max(0, Math.min(255, Math.round(top + (bottom - top) * wy)))
      }
    }
  }
  return { width: size, height: size, data: encodeBase64(rgb) }
}

/** 把 RGBA 数据画到指定 canvas（清空后重绘）；返回是否成功。 */
export function drawPixels(canvas, pixels, options = {}) {
  const context = context2d(canvas)
  if (!context || !pixels || !pixels.width || !pixels.height) return false
  try {
    canvas.width = pixels.width
    canvas.height = pixels.height
    const data = pixels.data instanceof Uint8ClampedArray
      ? pixels.data
      : new Uint8ClampedArray(pixels.data)
    context.putImageData(new ImageData(data, pixels.width, pixels.height), 0, 0)
    context.imageSmoothingEnabled = options.smoothing === true
    return true
  } catch {
    return false
  }
}

/** 把图片画到指定 canvas（可选最近邻放大 / repeat×repeat 平铺）；返回是否成功。 */
export function drawImage(canvas, image, options = {}) {
  const context = context2d(canvas)
  if (!context || !image) return false
  const sourceWidth = Number(image.naturalWidth || image.width) || 0
  const sourceHeight = Number(image.naturalHeight || image.height) || 0
  if (!sourceWidth || !sourceHeight) return false
  const tileWidth = Math.max(1, Math.round(Number(options.width) || sourceWidth))
  const tileHeight = Math.max(1, Math.round(Number(options.height) || sourceHeight))
  const repeat = Math.max(1, Math.floor(Number(options.repeat) || 1))
  try {
    canvas.width = tileWidth * repeat
    canvas.height = tileHeight * repeat
    // 像素画必须最近邻：默认关闭平滑，只有显式要求时才插值。
    context.imageSmoothingEnabled = options.smoothing === true
    for (let row = 0; row < repeat; row++) {
      for (let column = 0; column < repeat; column++) {
        context.drawImage(image, 0, 0, sourceWidth, sourceHeight, column * tileWidth, row * tileHeight, tileWidth, tileHeight)
      }
    }
    return true
  } catch {
    return false
  }
}

/** canvas → PNG dataURL；环境不支持或导出失败时返回空串。 */
export function canvasDataUrl(canvas) {
  if (!canvas || typeof canvas.toDataURL !== 'function') return ''
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
}

/** 图片 URL → PNG dataURL（用于把源作品作为保存时的 primary）；失败返回空串。 */
export async function imageUrlToDataUrl(url, options = {}) {
  const image = await loadImage(url)
  if (!image) return ''
  const sourceWidth = Number(image.naturalWidth || image.width) || 0
  const sourceHeight = Number(image.naturalHeight || image.height) || 0
  if (!sourceWidth || !sourceHeight) return ''
  // 保存请求有主图体积上限（WORKSHOP.save.maxPrimaryBytes）：按长边收缩到安全范围再编码。
  const maxEdge = Math.max(64, Math.floor(Number(options.maxEdge) || 2048))
  const ratio = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * ratio))
  const height = Math.max(1, Math.round(sourceHeight * ratio))
  const canvas = createCanvas(width, height)
  if (!canvas || !drawImage(canvas, image, { width, height })) return ''
  return canvasDataUrl(canvas)
}

/** 把 SVG 文本编码成可以直接放进 <img src> 的 dataURL。 */
export function svgToDataUrl(svg) {
  const text = typeof svg === 'string' ? svg : ''
  if (!text) return ''
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
}

/** 读取本地文件为 dataURL（本地上传用）；环境不支持或读取失败时返回空串。 */
export function fileToDataUrl(file) {
  if (!file || typeof FileReader === 'undefined') return Promise.resolve('')
  return new Promise((resolve) => {
    try {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
      reader.onerror = () => resolve('')
      reader.readAsDataURL(file)
    } catch {
      resolve('')
    }
  })
}

/** 从序列帧大图裁出一帧的 dataURL（动画预览 / 帧缩略图用）；失败返回空串。 */
export async function frameDataUrl(url, frame) {
  const image = await loadImage(url)
  if (!image || !frame) return ''
  const frameWidth = Number(frame.w) || 0
  const frameHeight = Number(frame.h) || 0
  if (!frameWidth || !frameHeight) return ''
  const canvas = createCanvas(frameWidth, frameHeight)
  const context = context2d(canvas)
  if (!context) return ''
  try {
    context.imageSmoothingEnabled = false
    context.drawImage(
      image,
      Number(frame.x) || 0,
      Number(frame.y) || 0,
      frameWidth,
      frameHeight,
      0,
      0,
      frameWidth,
      frameHeight,
    )
    return canvasDataUrl(canvas)
  } catch {
    return ''
  }
}

// ── 纯算法安全包装：逻辑模块未就绪 / 参数非法时返回 null，不打断界面 ──────────

/** 自动探测像素网格；失败返回 null。 */
export function detectPixelGridSafe(pixels, options) {
  if (!pixels || typeof workshopLogic.detectPixelGrid !== 'function') return null
  try {
    return workshopLogic.detectPixelGrid(pixels.data, pixels.width, pixels.height, options || {})
  } catch {
    return null
  }
}

/** 像素对齐 + 调色盘量化；失败返回 null。 */
export function snapPixelArtSafe(pixels, options) {
  if (!pixels || typeof workshopLogic.snapPixelArt !== 'function') return null
  try {
    return workshopLogic.snapPixelArt(pixels.data, pixels.width, pixels.height, options || {})
  } catch {
    return null
  }
}

/** 接缝 MAE 评估；失败返回 null。 */
export function seamMaeSafe(pixels) {
  if (!pixels || typeof workshopLogic.seamMae !== 'function') return null
  try {
    return workshopLogic.seamMae(pixels.data, pixels.width, pixels.height)
  } catch {
    return null
  }
}

/** 半格滚动余弦混边；失败返回 null。 */
export function blendSeamEdgesSafe(pixels, options) {
  if (!pixels || typeof workshopLogic.blendSeamEdges !== 'function') return null
  try {
    return workshopLogic.blendSeamEdges(pixels.data, pixels.width, pixels.height, options || {})
  } catch {
    return null
  }
}

/** 2×2 平铺几何；失败时按简单重复兜底。 */
export function tabulateTilesSafe(width, height, options) {
  try {
    if (typeof workshopLogic.tabulateTiles === 'function') {
      return workshopLogic.tabulateTiles(width, height, options || {})
    }
  } catch {
    // 继续走兜底几何。
  }
  const repeat = Math.max(1, Math.floor(Number(options && options.repeat) || 2))
  const placements = []
  for (let row = 0; row < repeat; row++) {
    for (let column = 0; column < repeat; column++) placements.push({ x: column * width, y: row * height })
  }
  return { width: width * repeat, height: height * repeat, placements }
}

/** 序列帧切片 + atlas；失败返回 null。 */
export function sliceSpriteFramesSafe(pixels, options) {
  if (!pixels || typeof workshopLogic.sliceSpriteFrames !== 'function') return null
  try {
    return workshopLogic.sliceSpriteFrames(pixels.data, pixels.width, pixels.height, options || {})
  } catch {
    return null
  }
}
