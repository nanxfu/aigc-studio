/**
 * 统一端侧推理 Web Worker（第一层轻量模型：WebGPU 优先 + SIMD WASM 兜底）。
 *
 * 职责：
 *  - 在独立工作线程承载 `onnxruntime-web` Session 创建与前向推理，避免阻塞 UI 主线程；
 *  - 按 `${modelId}:${ep}` 缓存 Session，所有推理请求串行排队，防止并发抢占显存/内存；
 *  - 从 Host 本地 HTTP 接口（127.0.0.1）拉取已校验的 `.onnx` 二进制，支持 Bearer 鉴权。
 */

const sessions = new Map()
let ortPromise = null
let serialTail = Promise.resolve()

async function loadOrt(ortUrl, wasmDir) {
  if (ortPromise) return ortPromise
  ortPromise = (async () => {
    const ort = await import(/* @vite-ignore */ ortUrl)
    if (ort?.env?.wasm) {
      ort.env.wasm.wasmPaths = wasmDir
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
    }
    return ort
  })()
  try {
    return await ortPromise
  } catch (error) {
    ortPromise = null
    throw error
  }
}

async function getSession({ ortUrl, wasmDir, modelId, ep, modelUrl, headers }) {
  const key = `${modelId}:${ep}`
  if (sessions.has(key)) return sessions.get(key)
  const promise = (async () => {
    const ort = await loadOrt(ortUrl, wasmDir)
    const res = await fetch(modelUrl, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: headers && typeof headers === 'object' ? headers : {},
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const json = await res.json()
        if (json?.error?.message) msg = json.error.message
      } catch {}
      throw new Error(msg)
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    const session = await ort.InferenceSession.create(bytes, { executionProviders: [ep] })
    return { ort, session }
  })()
  sessions.set(key, promise)
  try {
    return await promise
  } catch (error) {
    sessions.delete(key)
    throw error
  }
}

function enqueue(fn) {
  const previous = serialTail
  let release
  serialTail = new Promise((resolve) => {
    release = resolve
  })
  return previous.catch(() => {}).then(fn).finally(release)
}

self.onmessage = (event) => {
  const msg = event.data || {}
  const { reqId } = msg
  if (!reqId) return
  void enqueue(async () => {
    try {
      const { ortUrl, wasmDir, modelId, ep, modelUrl, headers, inputName, outputName, dims, tensorBuffer } = msg
      const { ort, session } = await getSession({ ortUrl, wasmDir, modelId, ep, modelUrl, headers })
      self.postMessage({ reqId, stage: 'inferring' })
      const resolvedInput = session.inputNames?.[0] || inputName
      const resolvedOutput = session.outputNames?.[0] || outputName
      const inputTensor = new ort.Tensor('float32', new Float32Array(tensorBuffer), dims)
      const outputs = await session.run({ [resolvedInput]: inputTensor })
      const output = outputs[resolvedOutput] || Object.values(outputs)[0]
      if (!output || !output.data) {
        throw new Error(`模型 ${modelId} 未返回有效输出张量`)
      }
      const copy = new Float32Array(output.data.length)
      copy.set(output.data)
      self.postMessage(
        { reqId, ok: true, data: copy.buffer, dims: output.dims ? [...output.dims] : [] },
        [copy.buffer],
      )
    } catch (error) {
      self.postMessage({
        reqId,
        ok: false,
        error: String(error?.message ?? error ?? 'worker inference failed'),
      })
    }
  })
}
