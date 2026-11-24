/**
 * 本机端侧背景抠图引擎（委托 `localInference.js` 统一 WebGPU / WASM Worker 管线）。
 */

import { localModelById } from '../../shared/local-models.js'
import { probeLocalRuntime, runLocalModelCandidates } from './localInference.js'

/** 探测当前浏览环境是否支持 WebGPU 适配器。 */
export async function detectWebGpuSupport() {
  const probe = await probeLocalRuntime()
  return probe.webGpu
}

/** 构造 `1 × 3 × H × W` NCHW Float32 归一化输入张量（纯函数，便于单测）。 */
export function buildCutoutInputTensor(rgbaBytes, width, height, spec) {
  const mean = spec?.input?.mean || [0.5, 0.5, 0.5]
  const std = spec?.input?.std || [1, 1, 1]
  const plane = width * height
  const output = new Float32Array(plane * 3)
  for (let i = 0; i < plane; i += 1) {
    const off = i * 4
    output[i] = (rgbaBytes[off] / 255 - mean[0]) / std[0]
    output[plane + i] = (rgbaBytes[off + 1] / 255 - mean[1]) / std[1]
    output[plane * 2 + i] = (rgbaBytes[off + 2] / 255 - mean[2]) / std[2]
  }
  return output
}

/** 把模型输出的 `[0, 1]` 软掩膜写回原分辨率 RGBA 缓冲（纯函数，便于单测）。 */
export function applyAlphaMaskToRgba(origRgba, maskAlpha, width, height) {
  const out = new Uint8ClampedArray(origRgba.length)
  out.set(origRgba)
  const total = width * height
  for (let i = 0; i < total; i += 1) {
    const alpha = Math.max(0, Math.min(255, Math.round(maskAlpha[i * 4 + 3])))
    out[i * 4 + 3] = Math.min(origRgba[i * 4 + 3], alpha)
  }
  return out
}

async function loadImage(sourceUrl) {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  await new Promise((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('无法解码源图片'))
  })
  const origW = image.naturalWidth || image.width
  const origH = image.naturalHeight || image.height
  if (!origW || !origH) throw new Error('源图片尺寸无效')
  return { image, origW, origH }
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * 在本机执行背景抠图：优先 Worker WebGPU + FP16（~0.5–1.3s），失败或无 WebGPU 自动回退 WASM + INT8。
 */
export async function runLocalCutout(options) {
  const { sourceUrl, onStage, signal, runtimeLoader, modelLoader } = options || {}
  if (!sourceUrl) throw new Error('缺少源图地址')

  const hasWebGpu = typeof options?.webGpuSupported === 'boolean'
    ? options.webGpuSupported
    : await detectWebGpuSupport()
  const candidates = hasWebGpu
    ? [
        { modelId: 'rmbg-1.4-fp16', ep: 'webgpu' },
        { modelId: 'rmbg-1.4-q8', ep: 'wasm' },
      ]
    : [{ modelId: 'rmbg-1.4-q8', ep: 'wasm' }]

  const spec = localModelById(candidates[0].modelId)
  const targetW = spec.input.width
  const targetH = spec.input.height

  const { image, origW, origH } = await loadImage(sourceUrl)
  const resizedCanvas = makeCanvas(targetW, targetH)
  const resizedCtx = resizedCanvas.getContext('2d')
  resizedCtx.drawImage(image, 0, 0, targetW, targetH)
  const resizedPixels = resizedCtx.getImageData(0, 0, targetW, targetH)
  const tensorData = buildCutoutInputTensor(resizedPixels.data, targetW, targetH, spec)

  const inferred = await runLocalModelCandidates(candidates, {
    dims: [1, 3, targetH, targetW],
    tensorData,
    onStage,
    signal,
    runtimeLoader,
    modelLoader,
  })

  const maskCanvas = makeCanvas(targetW, targetH)
  const maskCtx = maskCanvas.getContext('2d')
  const maskImage = maskCtx.createImageData(targetW, targetH)
  const rawMask = inferred.data
  for (let i = 0; i < targetW * targetH; i += 1) {
    maskImage.data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round((Number(rawMask[i]) || 0) * 255)))
  }
  maskCtx.putImageData(maskImage, 0, 0)

  const scaledMaskCanvas = makeCanvas(origW, origH)
  const scaledMaskCtx = scaledMaskCanvas.getContext('2d')
  scaledMaskCtx.imageSmoothingEnabled = true
  scaledMaskCtx.imageSmoothingQuality = 'high'
  scaledMaskCtx.drawImage(maskCanvas, 0, 0, origW, origH)
  const scaledMask = scaledMaskCtx.getImageData(0, 0, origW, origH)

  const origCanvas = makeCanvas(origW, origH)
  const origCtx = origCanvas.getContext('2d')
  origCtx.drawImage(image, 0, 0, origW, origH)
  const origData = origCtx.getImageData(0, 0, origW, origH)
  const merged = applyAlphaMaskToRgba(origData.data, scaledMask.data, origW, origH)
  origCtx.putImageData(new ImageData(merged, origW, origH), 0, 0)

  return {
    data: origCanvas.toDataURL('image/png'),
    width: origW,
    height: origH,
    modelId: inferred.modelId,
    ep: inferred.ep,
    elapsedMs: inferred.elapsedMs,
  }
}
