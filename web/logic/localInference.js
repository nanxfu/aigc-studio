/**
 * 统一端侧推理管线调度器（主线程入口 → 专用 Web Worker / 测试兜底）。
 *
 * 职责：
 *  1. 探测当前浏览器 / Electron 运行时的 WebGPU 能力与适配器摘要；
 *  2. 与 Host `/api/local-models` 对齐：检查禁用状态、触发后台懒下载并轮询实时进度；
 *  3. 通过单一持久化 Inference Web Worker 执行 ONNX 推理（Transferable 零拷贝传递张量），
 *     在不支持 Worker 的单测环境下允许注入 `runtimeLoader` / `modelLoader`。
 */

import { localModelById } from '../../shared/local-models.js'
import { apiUrl, authHeaders, routePath } from '../api.js'
import { downloadLocalModel, fetchLocalModelBytes, fetchLocalModels } from '../api/localModels.js'

let runtimeProbePromise = null
let workerInstance = null
let nextReqId = 1
const pendingRequests = new Map()
const directSessions = new Map()

function baseRoot() {
  if (typeof document !== 'undefined' && document.baseURI) return document.baseURI
  if (typeof window !== 'undefined' && window.location?.href) return window.location.href
  return 'http://127.0.0.1/'
}

function ortPaths() {
  const root = baseRoot()
  return {
    ortUrl: new URL('ort/ort.webgpu.bundle.min.mjs', root).href,
    wasmDir: new URL('ort/', root).href,
  }
}

/** 探测本机运行时加速能力（WebGPU 适配器 + Worker 支持）。结果在进程周期内缓存。 */
export async function probeLocalRuntime() {
  if (runtimeProbePromise) return runtimeProbePromise
  runtimeProbePromise = (async () => {
    const workerSupported = typeof Worker === 'function'
    let webGpu = false
    let adapterLabel = ''
    try {
      if (typeof navigator !== 'undefined' && navigator.gpu && typeof navigator.gpu.requestAdapter === 'function') {
        const adapter = await navigator.gpu.requestAdapter()
        if (adapter) {
          webGpu = true
          const info = adapter.info || {}
          adapterLabel = [info.vendor, info.architecture || info.description].filter(Boolean).join(' · ')
        }
      }
    } catch {
      webGpu = false
    }
    return { webGpu, adapterLabel, workerSupported }
  })()
  return runtimeProbePromise
}

function getWorker() {
  if (typeof Worker !== 'function') return null
  if (workerInstance) return workerInstance
  const worker = new Worker(new URL('./localInference.worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = (event) => {
    const msg = event.data || {}
    const entry = pendingRequests.get(msg.reqId)
    if (!entry) return
    pendingRequests.delete(msg.reqId)
    if (msg.ok) {
      entry.resolve({ data: new Float32Array(msg.data), dims: msg.dims || [] })
    } else {
      entry.reject(new Error(msg.error || '本机推理失败'))
    }
  }
  worker.onerror = (event) => {
    const err = new Error(event?.message || '本机推理 Worker 异常')
    for (const [reqId, entry] of pendingRequests.entries()) {
      pendingRequests.delete(reqId)
      entry.reject(err)
    }
    workerInstance = null
  }
  workerInstance = worker
  return workerInstance
}

/**
 * 确保 Host 侧已启用并下载好目标模型；未就绪时触发下载并轮询进度。
 * 返回 `{ disabled, ready }` 或在下载异常/停用时抛错。
 */
export async function ensureHostLocalModel(modelId, { onStage, signal } = {}) {
  const initial = await fetchLocalModels()
  if (initial.ok) {
    const existing = initial.models.find((m) => m.id === modelId)
    if (existing?.disabled) {
      const error = new Error(
        existing.disabledBy === 'env'
          ? `${existing.label || modelId} 已被环境变量禁用`
          : `${existing.label || modelId} 已在「设置 → 本机模型」中停用`,
      )
      error.code = 'disabled'
      throw error
    }
    if (existing?.status === 'ready') return
  }
  const start = await downloadLocalModel(modelId)
  if (!start.ok) {
    throw new Error(start.message || `触发本机模型下载失败（${modelId}）`)
  }
  while (true) {
    if (signal?.aborted) throw new Error('已取消')
    const listing = await fetchLocalModels()
    const item = listing.ok ? listing.models.find((m) => m.id === modelId) : null
    if (!item) break
    if (item.disabled) {
      const error = new Error(`${item.label || modelId} 已停用`)
      error.code = 'disabled'
      throw error
    }
    if (item.status === 'ready') return
    if (item.status === 'error') {
      throw new Error(item.error || `${item.label || modelId} 下载失败`)
    }
    if (item.status === 'downloading') {
      onStage?.({
        stage: 'downloading',
        modelId,
        downloadedBytes: item.downloadedBytes || 0,
        totalBytes: item.totalBytes || item.bytes || 0,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

async function runViaWorker({ modelId, ep, inputName, outputName, dims, tensorData, signal }) {
  const worker = getWorker()
  if (!worker) throw new Error('当前环境不支持 Web Worker')
  const { ortUrl, wasmDir } = ortPaths()
  const modelUrl = apiUrl(`${routePath('localModelFile')}?id=${encodeURIComponent(modelId)}`)
  const headers = authHeaders()
  const reqId = nextReqId++
  // 拷贝一份独立 ArrayBuffer 再 Transfer，避免调用方重试同一输入张量时旧 buffer 被 detach。
  const copy = new Float32Array(tensorData.length)
  copy.set(tensorData)

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pendingRequests.delete(reqId)
      reject(new Error('已取消'))
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    pendingRequests.set(reqId, {
      resolve: (res) => {
        signal?.removeEventListener?.('abort', onAbort)
        resolve(res)
      },
      reject: (err) => {
        signal?.removeEventListener?.('abort', onAbort)
        reject(err)
      },
    })
    worker.postMessage(
      {
        reqId,
        ortUrl,
        wasmDir,
        modelId,
        ep,
        modelUrl,
        headers,
        inputName,
        outputName,
        dims,
        tensorBuffer: copy.buffer,
      },
      [copy.buffer],
    )
  })
}

async function runDirectly({ modelId, ep, inputName, outputName, dims, tensorData, runtimeLoader, modelLoader, signal }) {
  const cacheKey = `${modelId}:${ep}`
  let entryPromise = directSessions.get(cacheKey)
  if (!entryPromise) {
    entryPromise = (async () => {
      const [ort, bytes] = await Promise.all([
        runtimeLoader(),
        modelLoader ? modelLoader(modelId) : fetchLocalModelBytes(modelId, { signal }),
      ])
      const session = await ort.InferenceSession.create(bytes, { executionProviders: [ep] })
      return { ort, session }
    })()
    directSessions.set(cacheKey, entryPromise)
  }
  let pair
  try {
    pair = await entryPromise
  } catch (error) {
    directSessions.delete(cacheKey)
    throw error
  }
  const { ort, session } = pair
  const resolvedIn = session.inputNames?.[0] || inputName
  const resolvedOut = session.outputNames?.[0] || outputName
  const tensor = new ort.Tensor('float32', tensorData, dims)
  const outputs = await session.run({ [resolvedIn]: tensor })
  const out = outputs[resolvedOut] || Object.values(outputs)[0]
  if (!out || !out.data) throw new Error('本机模型未返回有效输出张量')
  return { data: Float32Array.from(out.data), dims: out.dims ? [...out.dims] : [] }
}

/**
 * 按候选列表顺序执行本机模型推理（Worker 优先，注入自定义加载器时走直接模式）。
 *
 * @param {Array<{ modelId: string, ep: 'webgpu' | 'wasm' }>} candidates
 * @param {{
 *   dims: number[],
 *   tensorData: Float32Array,
 *   onStage?: (info: object) => void,
 *   signal?: AbortSignal,
 *   runtimeLoader?: () => Promise<object>,
 *   modelLoader?: (id: string) => Promise<Uint8Array>,
 * }} options
 */
export async function runLocalModelCandidates(candidates, options) {
  const { dims, tensorData, onStage, signal, runtimeLoader, modelLoader } = options || {}
  const useInjected = Boolean(runtimeLoader || modelLoader)
  let lastError = null

  for (const candidate of candidates) {
    const spec = localModelById(candidate.modelId)
    if (!spec?.input) continue
    try {
      if (!modelLoader) {
        await ensureHostLocalModel(candidate.modelId, { onStage, signal })
      }
      onStage?.({ stage: 'loading', modelId: candidate.modelId, ep: candidate.ep })
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
      onStage?.({ stage: 'inferring', modelId: candidate.modelId, ep: candidate.ep })
      const result = useInjected
        ? await runDirectly({
            modelId: candidate.modelId,
            ep: candidate.ep,
            inputName: spec.input.inputName,
            outputName: spec.input.outputName,
            dims,
            tensorData,
            runtimeLoader: runtimeLoader || (async () => {
              const { ortUrl, wasmDir } = ortPaths()
              const ort = await import(/* @vite-ignore */ ortUrl)
              if (ort?.env?.wasm) {
                ort.env.wasm.wasmPaths = wasmDir
                ort.env.wasm.numThreads = 1
                ort.env.wasm.proxy = false
              }
              return ort
            }),
            modelLoader,
            signal,
          })
        : await runViaWorker({
            modelId: candidate.modelId,
            ep: candidate.ep,
            inputName: spec.input.inputName,
            outputName: spec.input.outputName,
            dims,
            tensorData,
            signal,
          })
      const elapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started)
      return {
        data: result.data,
        dims: result.dims,
        modelId: candidate.modelId,
        ep: candidate.ep,
        elapsedMs,
      }
    } catch (error) {
      lastError = error
      if (signal?.aborted || error?.code === 'disabled') break
    }
  }
  throw lastError || new Error('本机模型推理失败')
}
