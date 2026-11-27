/**
 * 端侧深度几何推理（M4.2e-1）：DA3-Small INT8 / ONNX Runtime WASM。
 *
 * 模型输出是「远 = 大」的相对深度；这里统一转换成工坊协议里的
 * `{ width, height, data: Float32Array }`（0 = 近，1 = 远），并保留原始模型 id /
 * 推理耗时，供作品 meta 与「本机 / 云端」界面读数使用。
 */

import { localModelById } from '../../shared/local-models.js'
import { resizePixels } from './depthFx.js'
import { runLocalModelCandidates } from './localInference.js'
import { pixelsOfUrl } from '../studio/workshop/pixels.js'

const MODEL_ID = 'da3-small-int8'

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))

/** 构造 `1 × 3 × H × W` NCHW 输入张量（双线性采样，纯函数）。 */
export function buildDepthInputTensor(pixels, width, height, spec = localModelById(MODEL_ID)) {
  if (!pixels?.data || !width || !height) return null
  const mean = spec?.input?.mean || [0.485, 0.456, 0.406]
  const std = spec?.input?.std || [0.229, 0.224, 0.225]
  const plane = width * height
  const tensor = new Float32Array(plane * 3)
  const sourceW = Number(pixels.width)
  const sourceH = Number(pixels.height)
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(sourceH - 1, Math.max(0, ((y + 0.5) / height) * sourceH - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(sourceH - 1, y0 + 1)
    const wy = sy - y0
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(sourceW - 1, Math.max(0, ((x + 0.5) / width) * sourceW - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(sourceW - 1, x0 + 1)
      const wx = sx - x0
      const i00 = (y0 * sourceW + x0) * 4
      const i10 = (y0 * sourceW + x1) * 4
      const i01 = (y1 * sourceW + x0) * 4
      const i11 = (y1 * sourceW + x1) * 4
      const r = (pixels.data[i00] * (1 - wx) + pixels.data[i10] * wx) * (1 - wy)
        + (pixels.data[i01] * (1 - wx) + pixels.data[i11] * wx) * wy
      const g = (pixels.data[i00 + 1] * (1 - wx) + pixels.data[i10 + 1] * wx) * (1 - wy)
        + (pixels.data[i01 + 1] * (1 - wx) + pixels.data[i11 + 1] * wx) * wy
      const b = (pixels.data[i00 + 2] * (1 - wx) + pixels.data[i10 + 2] * wx) * (1 - wy)
        + (pixels.data[i01 + 2] * (1 - wx) + pixels.data[i11 + 2] * wx) * wy
      const target = y * width + x
      tensor[target] = (r / 255 - mean[0]) / std[0]
      tensor[plane + target] = (g / 255 - mean[1]) / std[1]
      tensor[plane * 2 + target] = (b / 255 - mean[2]) / std[2]
    }
  }
  return tensor
}

/** 模型原始输出 → 工坊归一化深度场（纯函数，按分位数拉伸并剔除 NaN）。 */
export function normalizeDepthOutput(raw, width, height, options = {}) {
  const total = Number(width) * Number(height)
  if (!raw || !Number.isFinite(total) || total <= 0 || raw.length < total) return null
  const values = new Float32Array(total)
  let count = 0
  for (let i = 0; i < total; i += 1) {
    const value = Number(raw[i])
    if (!Number.isFinite(value)) continue
    values[count] = value
    count += 1
  }
  if (count === 0) return null
  const sorted = Array.from(values.subarray(0, count)).sort((a, b) => a - b)
  const low = sorted[Math.floor((count - 1) * 0.02)]
  const high = sorted[Math.floor((count - 1) * 0.98)]
  const span = Math.max(1e-8, high - low)
  const invert = options.outputDepthDirection === 'near-large'
  const field = new Float32Array(total)
  for (let i = 0; i < total; i += 1) {
    const rawValue = Number(raw[i])
    const value = Number.isFinite(rawValue) ? clamp01((rawValue - low) / span) : 0
    field[i] = invert ? 1 - value : value
  }
  return { width, height, data: field }
}

export async function runLocalDepth(options = {}) {
  const spec = localModelById(MODEL_ID)
  if (!spec) throw new Error(`未登记的端侧深度模型：${MODEL_ID}`)
  const width = Number(spec.input?.width) || 504
  const height = Number(spec.input?.height) || 378
  const sourcePixels = options.sourcePixels
    || (options.sourceUrl ? await pixelsOfUrl(options.sourceUrl, { namespace: options.namespace }) : null)
  if (!sourcePixels?.data) throw new Error('无法读取深度推理源图')
  const resized = resizePixels(sourcePixels, Math.max(width, height))
  const tensorData = buildDepthInputTensor(resized || sourcePixels, width, height, spec)
  if (!tensorData) throw new Error('构造深度输入张量失败')
  const result = await runLocalModelCandidates(
    [{ modelId: MODEL_ID, ep: 'wasm' }],
    {
      dims: [1, 3, height, width],
      tensorData,
      onStage: options.onStage,
      signal: options.signal,
      runtimeLoader: options.runtimeLoader,
      modelLoader: options.modelLoader,
    },
  )
  const depth = normalizeDepthOutput(result.data, width, height, {
    outputDepthDirection: spec.input?.outputDepthDirection,
  })
  if (!depth) throw new Error('深度模型没有返回有效深度图')
  return {
    depth,
    sourceWidth: sourcePixels.width,
    sourceHeight: sourcePixels.height,
    modelId: result.modelId,
    ep: result.ep,
    elapsedMs: result.elapsedMs,
  }
}
