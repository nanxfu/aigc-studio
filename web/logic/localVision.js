/**
 * 端侧 L2 视觉感知前端执行器（走统一 Inference Web Worker，不再每次切图上传像素到 Host）。
 *
 *  - 使用 `shared/local-models.js` 登记的 `mobileclip-s0-fp16`（固定 `wasm` EP，在独立 Worker
 *    跑 ~345ms，不冻结主线程 UI）；
 *  - 复用 `shared/workshop-vision-classify.js` 与 `shared/workshop-vision-anchors.generated.js`
 *    的静态锚点直接在渲染侧完成 512 维分类；
 *  - 若用户在「设置 → 本机模型」或环境变量停用该模型，直接返回 `{ ok: false, disabled: true }`。
 */

import { WORKSHOP } from '../../shared/contract.js'
import {
  VISION_EMBEDDING_DIM,
  classifyWorkshopEmbedding,
  normalizeVisionVector,
  workshopVisionTensor,
} from '../../shared/workshop-vision-classify.js'
import { runLocalModelCandidates } from './localInference.js'

function decodeBase64Bytes(b64) {
  if (typeof globalThis.atob === 'function') {
    const bin = globalThis.atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out
  }
  if (typeof globalThis.Buffer === 'function') {
    return Uint8Array.from(globalThis.Buffer.from(b64, 'base64'))
  }
  throw new Error('缺少 base64 解码能力')
}

export async function runLocalVisionPerception(pixels, options = {}) {
  const size = WORKSHOP.vision.imageSize
  if (!pixels || Number(pixels.width) !== size || Number(pixels.height) !== size || typeof pixels.data !== 'string') {
    return { ok: false, disabled: false, error: 'invalid_pixels' }
  }
  try {
    const rgb = decodeBase64Bytes(pixels.data)
    if (rgb.length !== size * size * 3) {
      return { ok: false, disabled: false, error: 'invalid_length' }
    }
    const tensorData = workshopVisionTensor(rgb)
    const result = await runLocalModelCandidates(
      [{ modelId: WORKSHOP.vision.model, ep: 'wasm' }],
      {
        dims: [1, 3, size, size],
        tensorData,
        signal: options.signal,
        runtimeLoader: options.runtimeLoader,
        modelLoader: options.modelLoader,
      },
    )
    if (!result.data || result.data.length !== VISION_EMBEDDING_DIM) {
      throw new Error(`视觉嵌入维度异常：${result.data?.length ?? 0}`)
    }
    const normalized = normalizeVisionVector(result.data)
    const perception = classifyWorkshopEmbedding(normalized, {
      source: 'l2-onnx-vision',
      model: WORKSHOP.vision.model,
    })
    perception.latencyMs = result.elapsedMs
    return { ok: true, perception }
  } catch (error) {
    return {
      ok: false,
      disabled: error?.code === 'disabled',
      error: String(error?.message ?? error ?? 'local vision failed'),
    }
  }
}
