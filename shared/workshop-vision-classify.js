/**
 * 工坊 L2 视觉嵌入预处理与静态锚点分类（共享纯逻辑：Node Host 与浏览器端共用）。
 *
 * 约定：
 *  - 不 import 任何 `node:*` 模块（base64 解码兼容浏览器 `atob` 与 Node `Buffer`）；
 *  - 输出与 L1 `workshopPerception.js` 完全同口径的 `scene / sceneProbs / confidence / noul / professionalScore`。
 */

import { WORKSHOP } from './contract.js'
import {
  normalizeWorkshopNoul,
  workshopProfessionalScore,
  workshopRecommendTools,
  workshopSceneConfidence,
} from './workshop-scenes.js'
import { WORKSHOP_VISION_ANCHORS } from './workshop-vision-anchors.generated.js'

export const VISION_EMBEDDING_DIM = 512

function round(value, digits = 3) {
  const scale = 10 ** digits
  return Math.round(Number(value) * scale) / scale
}

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
  throw new Error('当前环境缺少 base64 解码能力')
}

/** RGB interleaved → MobileCLIP 需要的 NCHW float32 / 255。 */
export function workshopVisionTensor(rgb) {
  const size = WORKSHOP.vision.imageSize
  const plane = size * size
  const output = new Float32Array(plane * 3)
  for (let index = 0; index < plane; index += 1) {
    output[index] = rgb[index * 3] / 255
    output[plane + index] = rgb[index * 3 + 1] / 255
    output[plane * 2 + index] = rgb[index * 3 + 2] / 255
  }
  return output
}

export function normalizeVisionVector(values) {
  if (!values || values.length !== VISION_EMBEDDING_DIM) {
    throw new Error(`视觉嵌入必须是 ${VISION_EMBEDDING_DIM} 维`)
  }
  let sumSq = 0
  for (let i = 0; i < values.length; i += 1) sumSq += values[i] * values[i]
  const length = Math.sqrt(sumSq)
  if (!Number.isFinite(length) || length <= 1e-8) throw new Error('视觉嵌入长度非法')
  return Float32Array.from(values, (value) => value / length)
}

function dot(left, right) {
  let sum = 0
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index]
  return sum
}

function decodeQuantizedAnchor(entry) {
  if (!entry || typeof entry.data !== 'string' || !Number.isFinite(Number(entry.scale))) {
    throw new Error('视觉锚点数据损坏')
  }
  const bytes = decodeBase64Bytes(entry.data)
  const values = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const scale = Number(entry.scale)
  const float = Float32Array.from(values, (value) => value * scale)
  return normalizeVisionVector(float)
}

let cachedAnchors = null

/** 解码一次静态锚点；所有请求共用只读 Float32Array。 */
export function workshopVisionAnchors() {
  if (cachedAnchors) return cachedAnchors
  if (Number(WORKSHOP_VISION_ANCHORS.dim) !== VISION_EMBEDDING_DIM) {
    throw new Error(`视觉锚点维度必须是 ${VISION_EMBEDDING_DIM}`)
  }
  const scenes = Object.fromEntries(
    Object.entries(WORKSHOP_VISION_ANCHORS.scenes).map(([name, entry]) => [name, decodeQuantizedAnchor(entry)]),
  )
  const noul = Object.fromEntries(
    Object.entries(WORKSHOP_VISION_ANCHORS.noul).map(([name, pair]) => [name, {
      positive: decodeQuantizedAnchor(pair.positive),
      negative: decodeQuantizedAnchor(pair.negative),
    }]),
  )
  for (const scene of WORKSHOP.scenes) {
    if (!scenes[scene]) throw new Error(`视觉锚点缺少场景 ${scene}`)
  }
  cachedAnchors = { scenes, noul }
  return cachedAnchors
}

function sceneSoftmax(logits) {
  const max = Math.max(...logits.map((value) => Number(value) || 0))
  let total = 0
  const weights = logits.map((value) => {
    const weight = Math.exp((Number(value) || 0) - max)
    total += weight
    return weight
  })
  return weights.map((weight) => (total > 0 ? weight / total : 0))
}

/**
 * 纯分类：给定 512 维归一化图像嵌入，输出与 L1 同口径的 L2 结果。
 * `logitScale=100` 与 MobileCLIP 官方推理保持一致。
 */
export function classifyWorkshopEmbedding(embedding, options = {}) {
  const anchors = options.anchors || workshopVisionAnchors()
  if (!embedding || typeof embedding.length !== 'number' || embedding.length !== VISION_EMBEDDING_DIM) {
    throw new Error(`视觉嵌入必须是 ${VISION_EMBEDDING_DIM} 维`)
  }
  const vector = normalizeVisionVector(Float32Array.from(embedding || []))
  const sceneLogits = WORKSHOP.scenes.map((scene) => 100 * dot(anchors.scenes[scene], vector))
  const probs = sceneSoftmax(sceneLogits)
  const sceneProbs = Object.fromEntries(WORKSHOP.scenes.map((scene, index) => [scene, probs[index]]))
  const confidence = workshopSceneConfidence(sceneProbs)
  const scene = confidence.scene

  const noul = {}
  for (const [key, pair] of Object.entries(anchors.noul)) {
    const positive = 100 * dot(pair.positive, vector)
    const negative = 100 * dot(pair.negative, vector)
    const max = Math.max(positive, negative)
    const denom = Math.exp(positive - max) + Math.exp(negative - max)
    noul[key] = round(Math.min(0.999, Math.max(0.001, Math.exp(positive - max) / denom)))
  }

  const professionalScore = round(workshopProfessionalScore(sceneProbs))
  return {
    source: options.source || 'l2-onnx-vision',
    model: options.model || WORKSHOP.vision.model,
    latencyMs: 0,
    scene,
    sceneProbs: Object.fromEntries(
      WORKSHOP.scenes.map((name) => [name, round(sceneProbs[name], 6)]),
    ),
    confidence: {
      scene,
      top: round(confidence.top, 6),
      margin: round(confidence.margin, 6),
    },
    noul: normalizeWorkshopNoul(noul),
    professionalScore,
    recommendedTools: workshopRecommendTools(scene),
    showStudioReturnHint: scene === 'illustration_or_photo'
      && professionalScore < WORKSHOP.professionalThreshold,
    reasonKey: `studio.workshop.scene.reason.${scene}`,
    reasonParams: { scene, score: professionalScore },
    features: null,
    derived: { doneTools: [], hasTransparency: false, priorTool: null },
  }
}
