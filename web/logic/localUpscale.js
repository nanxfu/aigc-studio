/**
 * 本机端侧 Real-ESRGAN 2× 超分（M3.5 Phase D S3）。
 *
 * 纯卷积 RRDBNet 按固定 192×192 瓦片执行，瓦片步长 160px（32px overlap），
 * 输出 384×384 后用 Hann 窗加权融合，避免整图送 WebGPU/WASM 导致中间特征爆显存。
 *
 * 运行时职责留在本文件，像素几何 / 张量 / 融合都是纯函数，可离线验证接缝与边界；
 * 浏览器像素读取与 PNG 编码复用资产工坊的 canvas 桥。
 */

import { localModelById } from '../../shared/local-models.js'
import { pixelsOfUrl, pixelsToDataUrl } from '../studio/workshop/pixels.js'
import { probeLocalRuntime, runLocalModelCandidates } from './localInference.js'

export const LOCAL_UPSCALE_MODEL_IDS = Object.freeze({
  fp16: 'realesrgan-x2plus-fp16',
  fp32: 'realesrgan-x2plus-fp32',
})

export const LOCAL_UPSCALE_DEFAULT_TILE = 192
export const LOCAL_UPSCALE_DEFAULT_STRIDE = 160

function positiveInt(value, fallback) {
  const number = Math.round(Number(value))
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/**
 * 固定输入瓦片的起点：首尾必须贴边，最后一块与前一块重叠；
 * 图像短于一块时只返回 0，由反射填充补齐右侧 / 下侧。
 */
export function upscaleTileOrigins(length, tileSize = LOCAL_UPSCALE_DEFAULT_TILE, stride = LOCAL_UPSCALE_DEFAULT_STRIDE) {
  const size = positiveInt(tileSize, LOCAL_UPSCALE_DEFAULT_TILE)
  const step = Math.max(1, Math.min(size, positiveInt(stride, LOCAL_UPSCALE_DEFAULT_STRIDE)))
  const total = Math.max(0, Math.round(Number(length) || 0))
  if (total === 0) return []
  if (total <= size) return [0]
  const origins = [0]
  for (let origin = step; origin + size < total; origin += step) origins.push(origin)
  const last = total - size
  if (origins[origins.length - 1] !== last) origins.push(last)
  return origins
}

/** 生成固定尺寸瓦片执行计划；`outputWidth/Height` 始终是源图的 2×。 */
export function planUpscaleTiles(width, height, options = {}) {
  const sourceWidth = Math.max(0, Math.round(Number(width) || 0))
  const sourceHeight = Math.max(0, Math.round(Number(height) || 0))
  const tileSize = positiveInt(options.tileSize, LOCAL_UPSCALE_DEFAULT_TILE)
  const stride = Math.max(1, Math.min(tileSize, positiveInt(options.stride, LOCAL_UPSCALE_DEFAULT_STRIDE)))
  const scale = positiveInt(options.scale, 2)
  if (!sourceWidth || !sourceHeight) {
    return { width: 0, height: 0, outputWidth: 0, outputHeight: 0, tileSize, stride, scale, tiles: [] }
  }
  const xs = upscaleTileOrigins(sourceWidth, tileSize, stride)
  const ys = upscaleTileOrigins(sourceHeight, tileSize, stride)
  const tiles = []
  for (const y of ys) {
    for (const x of xs) {
      tiles.push({
        x,
        y,
        size: tileSize,
        inputWidth: tileSize,
        inputHeight: tileSize,
        outputWidth: tileSize * scale,
        outputHeight: tileSize * scale,
        destX: x * scale,
        destY: y * scale,
      })
    }
  }
  return {
    width: sourceWidth,
    height: sourceHeight,
    outputWidth: sourceWidth * scale,
    outputHeight: sourceHeight * scale,
    tileSize,
    stride,
    scale,
    tiles,
  }
}

/**
 * 反射索引：`-1 → 1`、`length → length-2`，不把边缘像素无限复制成硬边。
 * 单像素轴直接钳到 0，避免除零。
 */
export function reflectPixelIndex(index, length) {
  const size = Math.max(1, Math.round(Number(length) || 0))
  if (size === 1) return 0
  const period = size * 2 - 2
  const wrapped = ((Math.round(index) % period) + period) % period
  return wrapped < size ? wrapped : period - wrapped
}

/** 构造 `[1,3,tile,tile]` RGB 0~1 张量；源图外由反射填充补齐。 */
export function buildUpscaleInputTensor(pixels, tile, tileSize = LOCAL_UPSCALE_DEFAULT_TILE) {
  const width = Math.max(0, Math.round(Number(pixels?.width) || 0))
  const height = Math.max(0, Math.round(Number(pixels?.height) || 0))
  const data = pixels?.data
  const size = positiveInt(tileSize, LOCAL_UPSCALE_DEFAULT_TILE)
  if (!width || !height || !data || data.length < width * height * 4) return null
  const originX = Math.round(Number(tile?.x) || 0)
  const originY = Math.round(Number(tile?.y) || 0)
  const plane = size * size
  const tensor = new Float32Array(plane * 3)
  for (let y = 0; y < size; y += 1) {
    const sourceY = reflectPixelIndex(originY + y, height)
    for (let x = 0; x < size; x += 1) {
      const sourceX = reflectPixelIndex(originX + x, width)
      const source = (sourceY * width + sourceX) * 4
      const target = y * size + x
      tensor[target] = data[source] / 255
      tensor[plane + target] = data[source + 1] / 255
      tensor[plane * 2 + target] = data[source + 2] / 255
    }
  }
  return tensor
}

const WINDOW_CACHE = new Map()

/** 2D Hann 窗：重叠区按中心权重更高融合，避免瓦片接缝。 */
export function upscaleBlendWindow(size) {
  const length = positiveInt(size, LOCAL_UPSCALE_DEFAULT_TILE * 2)
  const cached = WINDOW_CACHE.get(length)
  if (cached) return cached
  const axis = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    axis[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (index + 0.5)) / length)
  }
  const window = new Float32Array(length * length)
  for (let y = 0; y < length; y += 1) {
    for (let x = 0; x < length; x += 1) window[y * length + x] = axis[y] * axis[x]
  }
  WINDOW_CACHE.set(length, window)
  return window
}

/** 新建 RGB + 权重累加器（均为线性浮点，最终一次归一化成 8-bit）。 */
export function createUpscaleAccumulator(width, height) {
  const outputWidth = Math.max(0, Math.round(Number(width) || 0))
  const outputHeight = Math.max(0, Math.round(Number(height) || 0))
  return {
    width: outputWidth,
    height: outputHeight,
    rgb: new Float32Array(outputWidth * outputHeight * 3),
    weight: new Float32Array(outputWidth * outputHeight),
  }
}

/**
 * 把一块 `[1,3,H,W]` 输出按 Hann 窗累加进目标画布；越界区域直接裁掉。
 * 纯函数便于断言「重叠区权重和 > 0、不产生黑边」。
 */
export function blendUpscaleTile(accumulator, outputData, dims, tile, options = {}) {
  const width = Math.max(0, Math.round(Number(accumulator?.width) || 0))
  const height = Math.max(0, Math.round(Number(accumulator?.height) || 0))
  const rgb = accumulator?.rgb
  const weight = accumulator?.weight
  const values = outputData
  if (!width || !height || !rgb || !weight || !values) return false
  const outHeight = Math.max(0, Math.round(Number(dims?.[2]) || 0))
  const outWidth = Math.max(0, Math.round(Number(dims?.[3]) || 0))
  if (!outWidth || !outHeight || values.length < outWidth * outHeight * 3) return false
  const window = options.window || upscaleBlendWindow(outWidth)
  const destX = Math.round(Number(tile?.destX) || 0)
  const destY = Math.round(Number(tile?.destY) || 0)
  if (destX >= width || destY >= height) return false
  const plane = outWidth * outHeight
  for (let y = 0; y < outHeight; y += 1) {
    const targetY = destY + y
    if (targetY < 0 || targetY >= height) continue
    for (let x = 0; x < outWidth; x += 1) {
      const targetX = destX + x
      if (targetX < 0 || targetX >= width) continue
      const sourcePixel = y * outWidth + x
      const targetPixel = targetY * width + targetX
      const weightValue = window[sourcePixel] || 0
      if (!(weightValue > 0)) continue
      rgb[targetPixel * 3] += values[sourcePixel] * weightValue
      rgb[targetPixel * 3 + 1] += values[plane + sourcePixel] * weightValue
      rgb[targetPixel * 3 + 2] += values[plane * 2 + sourcePixel] * weightValue
      weight[targetPixel] += weightValue
    }
  }
  return true
}

/** 源图 alpha 的双线性采样（x/y 为目标像素中心）。 */
function alphaAtUpscaled(source, x, y, scale) {
  const sx = Math.min(source.width - 1, Math.max(0, (x + 0.5) / scale - 0.5))
  const sy = Math.min(source.height - 1, Math.max(0, (y + 0.5) / scale - 0.5))
  const x0 = Math.floor(sx)
  const y0 = Math.floor(sy)
  const x1 = Math.min(source.width - 1, x0 + 1)
  const y1 = Math.min(source.height - 1, y0 + 1)
  const wx = sx - x0
  const wy = sy - y0
  const a00 = source.data[(y0 * source.width + x0) * 4 + 3]
  const a10 = source.data[(y0 * source.width + x1) * 4 + 3]
  const a01 = source.data[(y1 * source.width + x0) * 4 + 3]
  const a11 = source.data[(y1 * source.width + x1) * 4 + 3]
  return (a00 * (1 - wx) + a10 * wx) * (1 - wy) + (a01 * (1 - wx) + a11 * wx) * wy
}

/** 权重归一化 → RGBA；透明图的 alpha 跟随源图双线性放大，避免抠图作品丢失软边。 */
export function finishUpscaledPixels(accumulator, sourcePixels, scale = 2) {
  const width = Math.max(0, Math.round(Number(accumulator?.width) || 0))
  const height = Math.max(0, Math.round(Number(accumulator?.height) || 0))
  if (!width || !height || !accumulator?.rgb || !accumulator?.weight) return null
  const factor = positiveInt(scale, 2)
  const output = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x
      const weight = accumulator.weight[pixel]
      const target = pixel * 4
      if (weight > 0) {
        output[target] = Math.round((accumulator.rgb[pixel * 3] / weight) * 255)
        output[target + 1] = Math.round((accumulator.rgb[pixel * 3 + 1] / weight) * 255)
        output[target + 2] = Math.round((accumulator.rgb[pixel * 3 + 2] / weight) * 255)
      }
      output[target + 3] = sourcePixels
        ? Math.round(alphaAtUpscaled(sourcePixels, x, y, factor))
        : 255
    }
  }
  return { width, height, data: output }
}

function abortError() {
  const error = new Error('已取消本机放大')
  error.name = 'AbortError'
  error.code = 'local_upscale_aborted'
  return error
}

/**
 * 执行本机 2× 超分。
 *
 * 候选顺序：WebGPU 可用时 FP16 → FP32 WebGPU/WASM；无 WebGPU 时直接 FP32 WASM。
 * 第一块确定实际成功的模型 / EP，后续瓦片复用同一 Session，避免前半段 WebGPU、
 * 后半段 WASM 的色差接缝。
 */
export async function runLocalUpscale(options = {}) {
  const { sourceUrl, onStage, signal, runtimeLoader, modelLoader } = options
  const sourcePixels = options.sourcePixels
    || (sourceUrl ? await pixelsOfUrl(sourceUrl, { namespace: options.namespace }) : null)
  if (!sourcePixels?.data || !sourcePixels.width || !sourcePixels.height) {
    throw new Error('无法读取待放大的源图片')
  }
  if (signal?.aborted) throw abortError()

  const probe = typeof options.webGpuSupported === 'boolean'
    ? { webGpu: options.webGpuSupported }
    : await probeLocalRuntime()
  const candidates = probe.webGpu
    ? [
        { modelId: LOCAL_UPSCALE_MODEL_IDS.fp16, ep: 'webgpu' },
        { modelId: LOCAL_UPSCALE_MODEL_IDS.fp32, ep: 'wasm' },
      ]
    : [{ modelId: LOCAL_UPSCALE_MODEL_IDS.fp32, ep: 'wasm' }]
  const spec = localModelById(candidates[0].modelId)
  if (!spec?.input) throw new Error('本机超分模型未登记')
  const plan = planUpscaleTiles(sourcePixels.width, sourcePixels.height, {
    tileSize: spec.input.tileSize,
    stride: spec.input.tileStride,
    scale: spec.input.scale,
  })
  if (plan.tiles.length === 0) throw new Error('源图片尺寸无效')

  const accumulator = createUpscaleAccumulator(plan.outputWidth, plan.outputHeight)
  const window = upscaleBlendWindow(plan.tileSize * plan.scale)
  let selected = null
  let inferredModelId = ''
  let inferredEp = ''
  let elapsedMs = 0
  onStage?.({
    stage: 'preparing',
    pct: 1,
    width: plan.outputWidth,
    height: plan.outputHeight,
    tiles: plan.tiles.length,
  })

  for (const [index, tile] of plan.tiles.entries()) {
    if (signal?.aborted) throw abortError()
    const tensorData = buildUpscaleInputTensor(sourcePixels, tile, plan.tileSize)
    if (!tensorData) throw new Error('构造超分输入张量失败')
    const result = await runLocalModelCandidates(selected ? [selected] : candidates, {
      dims: [1, 3, plan.tileSize, plan.tileSize],
      tensorData,
      // 首块完成下载/建图后，后续瓦片不再转发 loading/inferring，避免进度条在瓦片间反复闪回。
      onStage: selected
        ? undefined
        : (info) => {
            if (!info || typeof info !== 'object') return
            if (info.stage === 'inferring') {
              onStage?.({
                stage: 'tiles',
                pct: 3,
                done: 0,
                total: plan.tiles.length,
                modelId: info.modelId,
                ep: info.ep,
              })
              return
            }
            onStage?.(info)
          },
      signal,
      runtimeLoader,
      modelLoader,
      skipEnsure: Boolean(selected),
    })
    if (!selected) {
      selected = { modelId: result.modelId, ep: result.ep }
      inferredModelId = result.modelId
      inferredEp = result.ep
    }
    elapsedMs += Number(result.elapsedMs) || 0
    blendUpscaleTile(accumulator, result.data, result.dims, tile, { window })
    onStage?.({
      stage: 'tiles',
      pct: 3 + Math.round(((index + 1) / plan.tiles.length) * 94),
      done: index + 1,
      total: plan.tiles.length,
      modelId: inferredModelId,
      ep: inferredEp,
    })
  }

  onStage?.({ stage: 'encoding', pct: 98, modelId: inferredModelId, ep: inferredEp })
  const upscaled = finishUpscaledPixels(accumulator, sourcePixels, plan.scale)
  const data = pixelsToDataUrl(upscaled)
  if (!data) throw new Error('本机放大完成但 PNG 编码失败')
  return {
    data,
    width: plan.outputWidth,
    height: plan.outputHeight,
    sourceWidth: sourcePixels.width,
    sourceHeight: sourcePixels.height,
    scale: plan.scale,
    tiles: plan.tiles.length,
    modelId: inferredModelId,
    ep: inferredEp,
    elapsedMs,
  }
}
