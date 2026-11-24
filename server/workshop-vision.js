/**
 * 工坊 L2 视觉感知（M4.2c Phase 2）。
 *
 * 输入只有客户端采样好的 256×256 RGB base64；Host 不读作品路径、不引入 sharp / jimp。
 * 视觉编码器是 MobileCLIP-S0 的 FP16 ONNX（约 22.9 MB），首次使用时按固定 URL / SHA-256
 * 下载到 `<workspace>/.aigc-studio/models/mobileclip-s0/`，之后复用同一 Session。
 *
 * 为什么不在运行时加载文本模型：
 *  - 文本编码器 fp16 就有 85 MB，而六类场景 / 六个 Noul 的锚点在开发期已经算好；
 *  - 静态锚点只有约 14 KB（int8 + 每向量 scale），启动与请求都不必联网算文本向量；
 *  - 生产安装包不携带模型权重，只留下可审计的下载地址、哈希和 Apple 许可说明。
 *
 * 设计约束：
 *  - 下载、Session 创建与推理都单飞 / 串行化；多张图切换不会并发抢 CPU；
 *  - 下载失败后短时间冷却，避免每个请求都重试；失败只返回 `vision_unavailable`，
 *    客户端静默保留 L1，不影响工坊任何工具；
 *  - 模型路径可用 `AIGC_STUDIO_WORKSHOP_VISION_MODEL` 覆盖（离线 / 内网镜像），
 *    `AIGC_STUDIO_WORKSHOP_VISION=0` 可完全关闭本机 L2。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { WORKSHOP } from '../shared/contract.js'
import {
  VISION_EMBEDDING_DIM as EMBEDDING_DIM,
  classifyWorkshopEmbedding,
  normalizeVisionVector as normalizeVector,
  workshopVisionAnchors,
  workshopVisionTensor,
} from '../shared/workshop-vision-classify.js'
import { writeFileAtomic } from './fs-atomic.js'
import { META_DIR, workspaceRoot } from './paths.js'

export { classifyWorkshopEmbedding, workshopVisionAnchors, workshopVisionTensor }

/** 与契约 `ERROR_CODES.vision_unavailable` 同值；集中导出供路由映射 503。 */
export const VISION_UNAVAILABLE = 'vision_unavailable'

const MODEL_FILE = 'vision_model_fp16.onnx'
const MODEL_DIR = 'mobileclip-s0'
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000
const DEFAULT_COOLDOWN_MS = 60_000

/** 环境变量关闭词：不区分大小写。 */
const DISABLED_VALUES = new Set(['0', 'false', 'off', 'disabled', 'no'])

function fail(code, message) {
  return { ok: false, code, message }
}

function unavailable(message) {
  return fail(VISION_UNAVAILABLE, message)
}

function round(value, digits = 3) {
  const scale = 10 ** digits
  return Math.round(Number(value) * scale) / scale
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function errorText(error) {
  return String(error?.message ?? error ?? 'unknown error').slice(0, 500)
}

/**
 * 严格解码 L2 请求的 RGB 载荷。
 *
 * 只认裸 base64（不接受 dataURL），尺寸必须与契约一致；解码后字节数必须精确等于
 * `256 × 256 × 3`，避免把错图 / 缺通道数据送进模型后得到看似正常但错位的嵌入。
 *
 * @returns {{ ok: true, pixels: { width: number, height: number, rgb: Buffer } }
 *   | { ok: false, code: 'invalid_request', message: string }}
 */
export function decodeWorkshopVisionPixels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('invalid_request', 'pixels 必须是 { width, height, data } 对象')
  }
  const size = WORKSHOP.vision.imageSize
  if (Number(value.width) !== size || Number(value.height) !== size) {
    return fail('invalid_request', `pixels.width / height 必须是 ${size}`)
  }
  if (typeof value.data !== 'string' || value.data === '') {
    return fail('invalid_request', 'pixels.data 必须是非空 base64 字符串')
  }
  const expectedBytes = size * size * 3
  const expectedLength = Math.ceil(expectedBytes / 3) * 4
  if (value.data.length !== expectedLength) {
    return fail('invalid_request', `pixels.data 长度必须是 ${expectedLength}（256×256 RGB base64）`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) {
    return fail('invalid_request', 'pixels.data 不是合法 base64')
  }
  let rgb
  try {
    rgb = Buffer.from(value.data, 'base64')
  } catch {
    return fail('invalid_request', 'pixels.data 解码失败')
  }
  if (rgb.length !== expectedBytes) {
    return fail('invalid_request', `pixels.data 解码后必须是 ${expectedBytes} 字节`)
  }
  return { ok: true, pixels: { width: size, height: size, rgb } }
}

/** 环境变量是否关闭 L2；只关闭工坊视觉请求，不影响应用其它能力。 */
export function workshopVisionDisabled(env = process.env) {
  return DISABLED_VALUES.has(String(env?.AIGC_STUDIO_WORKSHOP_VISION ?? '').trim().toLowerCase())
}

/** 模型缓存 / 覆盖路径。覆盖路径只给离线镜像与测试使用，不参与客户端输入。 */
export function workshopVisionModelPath(ctx, env = process.env) {
  const override = typeof env?.AIGC_STUDIO_WORKSHOP_VISION_MODEL === 'string'
    ? env.AIGC_STUDIO_WORKSHOP_VISION_MODEL.trim()
    : ''
  if (override) return resolve(override)
  return join(workspaceRoot(ctx), META_DIR, 'models', MODEL_DIR, MODEL_FILE)
}

function resolveOrtEntry() {
  if (typeof import.meta.resolve === 'function') {
    try {
      return import.meta.resolve('onnxruntime-web')
    } catch {
      // 继续走 createRequire 兜底（旧 Electron / 非标准加载器）。
    }
  }
  const require = createRequire(import.meta.url)
  return pathToFileURL(require.resolve('onnxruntime-web')).href
}

/**
 * 加载 onnxruntime-web 并固定 WASM 路径 / 单线程。
 *
 * Host 在 Electron 子进程里以 `ELECTRON_RUN_AS_NODE` 运行；不能依赖浏览器默认的相对 URL。
 * 交付目录 `asar: false`，所以 node_modules 里的 `.mjs` / `.wasm` 都是真实文件，可直接
 * 用 file:// 传给 ORT。单线程避免在小图推理上为线程池付出启动成本。
 */
async function defaultRuntimeLoader() {
  const ort = await import('onnxruntime-web')
  const entry = resolveOrtEntry()
  const dist = dirname(fileURLToPath(entry))
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmPaths = {
    mjs: pathToFileURL(join(dist, 'ort-wasm-simd-threaded.mjs')).href,
    wasm: pathToFileURL(join(dist, 'ort-wasm-simd-threaded.wasm')).href,
  }
  return ort
}

/**
 * L2 感知器：下载锁、校验、Session 复用、串行推理与失败冷却都收在这里。
 *
 * 可注入项用于离线测试：
 *  - `fetchImpl`：假下载；
 *  - `loadRuntime` / `createSession`：假 ONNX；
 *  - `anchors`：小维度假锚点；
 *  - `modelPath` / `modelUrl` / `modelSha256` / `modelBytes`：本地夹具。
 */
export function createWorkshopVision(options = {}) {
  const env = options.env || process.env
  const log = options.log || null
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
  const now = options.now || (() => Date.now())
  const loadRuntime = options.loadRuntime || defaultRuntimeLoader
  const anchors = options.anchors || null
  const cooldownMs = Number.isFinite(options.failureCooldownMs)
    ? options.failureCooldownMs
    : WORKSHOP.vision.failureCooldownMs
  const downloadTimeoutMs = Number.isFinite(options.downloadTimeoutMs)
    ? options.downloadTimeoutMs
    : WORKSHOP.vision.downloadTimeoutMs
  const modelUrl = options.modelUrl || WORKSHOP.vision.url
  const modelSha256 = String(options.modelSha256 || WORKSHOP.vision.sha256).toLowerCase()
  const modelBytes = Number(options.modelBytes) || WORKSHOP.vision.bytes
  const fixedModelPath = options.modelPath ? resolve(options.modelPath) : ''
  const useManagedLocalModels = Boolean(
    options.localModels
    && !fixedModelPath
    && !options.fetchImpl
    && !options.modelUrl
    && !options.modelSha256
    && !options.modelBytes,
  )

  let runtimePromise = null
  let session = null
  let sessionPath = ''
  let sessionFlight = null
  let inferenceTail = Promise.resolve()
  let failureUntil = 0
  let failureMessage = ''
  const modelFlights = new Map()

  function modelPathOf(ctx) {
    return fixedModelPath || workshopVisionModelPath(ctx, env)
  }

  function rememberFailure(message) {
    failureUntil = now() + cooldownMs
    failureMessage = String(message || 'L2 视觉模型不可用').slice(0, 500)
    log?.warn?.(`workshop_vision_unavailable detail=${failureMessage}`)
  }

  function isDisabled() {
    if (workshopVisionDisabled(env)) return true
    if (useManagedLocalModels && options.localModels?.isModelDisabled?.(WORKSHOP.vision.model)) return true
    return false
  }

  function checkEnabled() {
    if (isDisabled()) return unavailable('L2 视觉感知已关闭')
    if (failureUntil > now()) return unavailable(failureMessage)
    return null
  }

  async function verifyModel(path) {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile() || info.size !== modelBytes) return false
    const buffer = await readFile(path).catch(() => null)
    if (!buffer) return false
    return sha256Of(buffer) === modelSha256
  }

  async function downloadModel(path) {
    if (modelFlights.has(path)) return modelFlights.get(path)
    if (!fetchImpl) throw new Error('Host 没有可用的 fetch，无法下载视觉模型')
    const flight = (async () => {
      await mkdir(dirname(path), { recursive: true })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('视觉模型下载超时')), downloadTimeoutMs)
      timer.unref?.()
      try {
        const response = await fetchImpl(modelUrl, {
          signal: controller.signal,
          redirect: 'follow',
          headers: { 'user-agent': 'AIGC-Studio/workshop-vision' },
        })
        if (!response || !response.ok) {
          throw new Error(`视觉模型下载失败：HTTP ${response?.status ?? 'unknown'}`)
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        if (buffer.length !== modelBytes) {
          throw new Error(`视觉模型大小不符：expected ${modelBytes}, got ${buffer.length}`)
        }
        const digest = sha256Of(buffer)
        if (digest !== modelSha256) {
          throw new Error(`视觉模型 SHA-256 校验失败：${digest}`)
        }
        await writeFileAtomic(path, buffer, { ensureDir: true, cleanStale: true })
        return path
      } catch (error) {
        await rm(path, { force: true }).catch(() => {})
        throw error
      } finally {
        clearTimeout(timer)
      }
    })()
    modelFlights.set(path, flight)
    try {
      return await flight
    } finally {
      modelFlights.delete(path)
    }
  }

  async function ensureModel(ctx) {
    if (useManagedLocalModels) {
      return options.localModels.ensureModel(WORKSHOP.vision.model, { ctx })
    }
    const path = modelPathOf(ctx)
    if (fixedModelPath) {
      const info = await stat(path).catch(() => null)
      if (!info?.isFile()) throw new Error(`本地视觉模型不存在：${path}`)
      return path
    }
    if (await verifyModel(path)) return path
    await rm(path, { force: true }).catch(() => {})
    return downloadModel(path)
  }

  async function getSession(ctx) {
    const path = await ensureModel(ctx)
    if (session && sessionPath === path) return { ort: await (runtimePromise || loadRuntime()), session }
    if (sessionFlight) return sessionFlight
    sessionFlight = (async () => {
      runtimePromise = runtimePromise || loadRuntime()
      const ort = await runtimePromise
      const model = await readFile(path)
      const created = options.createSession
        ? await options.createSession(model, ort, path)
        : await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
      session = created
      sessionPath = path
      return { ort, session: created }
    })()
    try {
      return await sessionFlight
    } finally {
      sessionFlight = null
    }
  }

  async function exclusive(task) {
    const previous = inferenceTail
    let release
    inferenceTail = new Promise((resolveRelease) => {
      release = resolveRelease
    })
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
    }
  }

  async function encode(ctx, rgb) {
    return exclusive(async () => {
      const { ort, session: active } = await getSession(ctx)
      const tensor = new ort.Tensor(
        'float32',
        workshopVisionTensor(rgb),
        [1, 3, WORKSHOP.vision.imageSize, WORKSHOP.vision.imageSize],
      )
      const result = await active.run({ pixel_values: tensor })
      const output = result.image_embeds || Object.values(result)[0]
      if (
        !output
        || output.type !== 'float32'
        || !output.data
        || output.data.length !== EMBEDDING_DIM
      ) {
        throw new Error(`视觉模型输出不是 ${EMBEDDING_DIM} 维 float32 嵌入`)
      }
      return normalizeVector(output.data)
    })
  }

  async function perceive(ctx, decoded) {
    if (!decoded || !decoded.rgb) return unavailable('视觉输入为空')
    const blocked = checkEnabled()
    if (blocked) return blocked
    const started = now()
    try {
      // ctx 显式传进串行队列内的任务；不把请求级状态挂到共享闭包上，
      // 否则切换工作区 / 并发请求时会把 A 图的与会话交给 B 图。
      const embedding = await encode(ctx, decoded.rgb)
      const perception = classifyWorkshopEmbedding(embedding, { anchors })
      perception.latencyMs = Math.max(0, Math.round(now() - started))
      failureUntil = 0
      failureMessage = ''
      return { ok: true, perception }
    } catch (error) {
      rememberFailure(errorText(error))
      return unavailable(failureMessage)
    }
  }

  return {
    perceive,
    classify: (embedding) => classifyWorkshopEmbedding(embedding, { anchors }),
    modelPath: modelPathOf,
    isDisabled,
    resetFailure: () => {
      failureUntil = 0
      failureMessage = ''
    },
  }
}
