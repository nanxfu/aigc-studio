/**
 * 本机 GPU 的 daemon v2 协议桥。
 *
 * `sd-server` 原生是 `/sdcpp/v1/*` 异步任务 API，而 Host 的 JobQueue 只会说
 * `/health`、`/generate`、`/job`、`/logs`、`/shutdown`。本文件把这层翻译收在一处，
 * 从而让本机 GPU 复用既有会话状态机、队列、取消、落盘与错误文案，不再造第二条任务链路。
 *
 * 只实现 txt2img（M3.4 首个可用闭环）；图生图 / 局部重绘 / 参考图 / 扩图 / 超分
 * 在入队阶段明确拒绝，避免「界面上能用、实际悄悄降级」。
 *
 * @module server/local-gpu/bridge
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

import { PROTOCOL_VERSION, TIMEOUTS } from '../../shared/contract.js'
import { localGpuAssetOf } from '../../shared/local-gpu-assets.js'
import { resolveLocalGpuModel } from './config.js'
import { createLogger } from '../log.js'

const defaultLog = createLogger({ scope: 'local-gpu' })
const MAX_BODY_BYTES = 2 * 1024 * 1024
const JOB_TTL_MS = 10 * 60 * 1000
const JOB_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function fail(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message } })
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(Object.assign(new Error('请求体超过本机 GPU 桥上限'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sha256Of(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function authOk(req, token) {
  const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
  if (!header.startsWith('Bearer ') || !token) return false
  const provided = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

/**
 * Host 的 `taskPayload` → sd-server 的 `img_gen` 请求。
 *
 * 纯函数，测试直接断言；任何不支持的能力都在这里拒绝，绝不下发后再忽略。
 */
export function buildSdRequest(payload, { sampling = null, vaeTiling = true, loraPath = '' } = {}) {
  if (!isPlainObject(payload)) {
    return { ok: false, status: 400, code: 'invalid_request', message: '请求体必须是 JSON 对象' }
  }
  if (payload.reference || payload.referenceImages) {
    return {
      ok: false,
      status: 400,
      code: 'capability_missing',
      message: '本机 GPU（Vulkan）当前只支持文生图：图生图 / 局部重绘 / 参考图请切换到 Kaggle、Colab 或私有 Worker',
    }
  }
  const rawLora = isPlainObject(payload?.pipeline?.lora) ? payload.pipeline.lora : null
  if (rawLora && !loraPath) {
    return {
      ok: false,
      status: 400,
      code: 'capability_missing',
      message: '本机 GPU LoRA 尚未就绪：请确认 LoRA 目录与权重文件已下载',
    }
  }
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : []
  if (tasks.length !== 1) {
    return { ok: false, status: 400, code: 'invalid_request', message: '本机 GPU 桥每次只接受一个任务' }
  }
  const task = isPlainObject(tasks[0]) ? tasks[0] : {}
  const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : ''
  if (!prompt) {
    return { ok: false, status: 400, code: 'invalid_request', message: '提示词不能为空' }
  }
  const width = Math.round(finiteNumber(task.width) ?? 0)
  const height = Math.round(finiteNumber(task.height) ?? 0)
  const steps = Math.round(finiteNumber(task.steps) ?? 0)
  if (width < 64 || width > 4096 || height < 64 || height > 4096) {
    return { ok: false, status: 400, code: 'invalid_request', message: '本机 GPU 画幅必须在 64~4096 之间' }
  }
  if (steps < 1 || steps > 1000) {
    return { ok: false, status: 400, code: 'invalid_request', message: '本机 GPU 步数必须在 1~1000 之间' }
  }
  const cfg = finiteNumber(task.cfg)
  const seed = Math.round(finiteNumber(task.seed) ?? -1)
  const loraScale = finiteNumber(rawLora?.scale)
  return {
    ok: true,
    request: {
      prompt,
      negative_prompt: typeof task.negative_prompt === 'string' ? task.negative_prompt : '',
      width,
      height,
      seed,
      batch_count: 1,
      sample_params: {
        ...(sampling?.sampleMethod ? { sample_method: sampling.sampleMethod } : {}),
        ...(sampling?.scheduler ? { scheduler: sampling.scheduler } : {}),
        sample_steps: steps,
        ...(cfg === null ? {} : { guidance: { txt_cfg: cfg } }),
      },
      ...(rawLora && loraPath
        ? { lora: [{ path: loraPath, multiplier: loraScale === null ? 1.0 : loraScale }] }
        : {}),
      vae_tiling_params: { enabled: vaeTiling !== false },
      output_format: 'png',
      output_compression: 100,
    },
  }
}

function progressOf(sdJob, record) {
  const progress = isPlainObject(sdJob?.progress) ? sdJob.progress : {}
  const completed = finiteNumber(progress.completed)
  const total = finiteNumber(progress.total)
  const sampling = progress.stage === 'sampling'
  const previous = record?.lastProgress ?? null
  const steps = record?.steps > 0 ? record.steps : previous?.steps
  if (!sampling) {
    // 采样结束后 sd-server 会切到 vae_decode / encoding（completed=0,total=1）；
    // 不能把界面上的 4/4 倒回 0/4，保留最后一次采样进度直到任务完成。
    return {
      done: 0,
      total: 1,
      ...(previous?.step != null ? { step: previous.step } : {}),
      ...(steps ? { steps } : {}),
    }
  }
  const step = completed !== null && steps > 0 ? Math.max(0, Math.min(Math.round(completed), steps)) : 0
  return { done: 0, total: 1, step, ...(steps ? { steps } : {}) }
}

function errorOfSdJob(sdJob) {
  const message = sdJob?.error?.message ?? sdJob?.error ?? '本机 GPU 生成失败'
  const text = String(message)
  const code = /out of memory|OOM|VK_ERROR_OUT_OF_DEVICE_MEMORY|failed to allocate/i.test(text)
    ? 'oom'
    : 'generation_failed'
  return { code, message: text.slice(0, 1200) }
}

/**
 * sd-server 任务快照 → Host `/job` 形状。
 *
 * 纯函数；record 里保存 steps 与最终 results，保证重复轮询不会重复编码。
 */
export function mapSdJobToRemote(sdJob, record) {
  const status = String(sdJob?.status ?? '')
  if (status === 'completed') {
    const images = Array.isArray(sdJob?.result?.images) ? sdJob.result.images : []
    const results = images.map((image, index) => ({
      index,
      image_b64: typeof image?.b64_json === 'string' ? image.b64_json : '',
      width: record?.width ?? null,
      height: record?.height ?? null,
    })).filter((item) => item.image_b64)
    if (results.length === 0) {
      return {
        status: 'failed',
        job_id: record.id,
        error: { code: 'generation_failed', message: '本机 GPU 没有返回图片' },
      }
    }
    return {
      status: 'done',
      job_id: record.id,
      model_id: record.modelId ?? null,
      load_seconds: record.loadSeconds ?? null,
      results,
      progress: { done: 1, total: 1, step: record.steps, steps: record.steps },
    }
  }
  if (status === 'failed' || status === 'cancelled') {
    return {
      status: 'failed',
      job_id: record.id,
      error: status === 'cancelled'
        ? { code: 'generation_failed', message: '本机 GPU 任务已取消' }
        : errorOfSdJob(sdJob),
      progress: progressOf(sdJob, record),
    }
  }
  return {
    status: 'running',
    job_id: record.id,
    progress: progressOf(sdJob, record),
  }
}

/** `/health` 载荷：字段与远端 daemon 同形，Host 无需为 local-gpu 写特判。 */
export function localGpuHealthPayload({ info, health, config, idleTimeoutSec = 300 } = {}) {
  const gpu = info?.gpu ?? null
  const ready = health?.ok === true && health?.phase === 'ready'
  const backend = String(info?.device?.backend || '').toLowerCase() === 'cuda'
    ? 'CUDA'
    : String(info?.device?.backend || '').toLowerCase() === 'rocm'
      ? 'ROCm'
      : 'Vulkan'
  const asset = localGpuAssetOf(config?.defaultPreset || config?.presetId)
  return {
    ok: true,
    phase: ready ? 'ready' : health?.phase === 'error' ? 'error' : 'loading',
    protocol_version: PROTOCOL_VERSION,
    worker_id: 'local-gpu',
    model_id: config?.modelPath ? String(config.modelPath).replace(/^.*[\\/]/, '') : null,
    device: gpu?.name ?? 'Vulkan GPU',
    device_count: 1,
    idle_timeout_sec: idleTimeoutSec,
    last_error: ready ? null : health?.error ?? null,
    last_error_code: ready ? null : 'remote_error',
    hardware: {
      gpu_name: gpu?.name ?? 'Vulkan GPU',
      vram_total_mb: gpu?.memoryHeaps?.find((heap) => heap.deviceLocal)?.sizeMb ?? info?.hardware?.vramMb ?? null,
      driver: gpu?.driverVersion ?? null,
      cuda: backend === 'CUDA',
      backend,
      count: 1,
    },
    capabilities: {
      result_modes: ['inline'],
      events: false,
      artifact_range: false,
      tools: ['generate'],
      loaders: [asset?.loader || 'sdxl'],
      reference: false,
      inpaint: false,
    },
  }
}

/**
 * 本机 GPU 协议桥。
 *
 * @param {object} options
 * @param {import('./runtime.js').LocalGpuRuntime} options.runtime
 * @param {object} options.config
 * @param {object} [options.log]
 * @param {string} [options.token] 省略时随机生成（只有 Host 进程知道）
 * @param {() => void} [options.onShutdown]
 * @param {(presetId: string) => object|null} [options.resolveModel]
 */
export function createLocalGpuBridge({
  runtime,
  config,
  log = defaultLog,
  token = '',
  onShutdown = null,
  onEnsureModel = null,
  resolveModel = null,
  ensureLora = null,
} = {}) {
  const secret = token || randomBytes(24).toString('hex')
  const jobs = new Map()
  let currentRuntime = runtime
  let currentConfig = config
  let server = null
  let endpointUrl = ''

  function prune() {
    const deadline = Date.now() - JOB_TTL_MS
    for (const [id, record] of jobs) {
      if (record.completedAt && record.completedAt < deadline) jobs.delete(id)
    }
  }

  async function health() {
    const state = await currentRuntime.health()
    return localGpuHealthPayload({
      info: currentRuntime.info(),
      health: state,
      config: currentConfig,
      idleTimeoutSec: currentConfig?.idleTimeoutSec ?? 300,
    })
  }

  async function submitJob(body) {
    const jobId = typeof body?.jobId === 'string' ? body.jobId : ''
    if (!JOB_ID_PATTERN.test(jobId)) {
      return { ok: false, status: 400, code: 'invalid_request', message: 'jobId 必须匹配 [A-Za-z0-9._-]{1,64}' }
    }
    const presetId = typeof body?.presetId === 'string' ? body.presetId.trim() : ''
    let resolvedModel = null
    if (presetId) {
      resolvedModel = typeof resolveModel === 'function'
        ? resolveModel(presetId)
        : resolveLocalGpuModel(currentConfig, presetId)
      if (!resolvedModel) {
        return {
          ok: false,
          status: 400,
          code: 'capability_missing',
          message: `模型「${presetId}」尚未下载到本地，请从顶栏模型卡下载后再试`,
        }
      }
      const changed =
        resolvedModel.modelPath !== currentConfig?.modelPath
        || (resolvedModel.vaePath || '') !== (currentConfig?.vaePath || '')
        || (resolvedModel.llmPath || '') !== (currentConfig?.llmPath || '')
        || (resolvedModel.clipLPath || '') !== (currentConfig?.clipLPath || '')
        || (resolvedModel.clipGPath || '') !== (currentConfig?.clipGPath || '')
        || (resolvedModel.t5xxlPath || '') !== (currentConfig?.t5xxlPath || '')
      if (typeof onEnsureModel === 'function' && changed) {
        const switched = await onEnsureModel(presetId, resolvedModel)
        if (switched?.runtime) currentRuntime = switched.runtime
        if (switched?.config) currentConfig = switched.config
      }
    }
    let loraPath = ''
    const requestedLora = isPlainObject(body?.pipeline?.lora) ? body.pipeline.lora : null
    if (requestedLora) {
      if (typeof ensureLora !== 'function') {
        return {
          ok: false,
          status: 400,
          code: 'capability_missing',
          message: '本机 GPU LoRA 下载器未挂载',
        }
      }
      try {
        const prepared = await ensureLora(requestedLora, currentConfig)
        loraPath = prepared?.path || ''
        if (prepared?.downloaded && typeof currentRuntime?.refreshModels === 'function') {
          await currentRuntime.refreshModels()
        }
      } catch (error) {
        return {
          ok: false,
          status: 500,
          code: 'generation_failed',
          message: `本机 GPU LoRA 准备失败：${String(error?.message ?? error).slice(0, 400)}`,
        }
      }
    }
    const asset = localGpuAssetOf(presetId || currentConfig?.defaultPreset)
    const vramMb = Number(currentRuntime?.hardware?.vramMb ?? currentRuntime?.gpu?.vramMb)
    const integrated = currentRuntime?.hardware?.isIntegrated === true || currentRuntime?.gpu?.isIntegrated === true
    const vaeTiling = typeof currentConfig?.vaeTiling === 'boolean'
      ? currentConfig.vaeTiling
      : !(Number.isFinite(vramMb) && vramMb >= 12000 && !integrated)
    const parsed = buildSdRequest(body, { sampling: asset?.sampling, vaeTiling, loraPath })
    if (!parsed.ok) return parsed
    const digest = sha256Of(JSON.stringify({ presetId, request: parsed.request }))
    const existing = jobs.get(jobId)
    if (existing) {
      if (existing.digest !== digest) {
        return { ok: false, status: 409, code: 'invalid_request', message: '同一 jobId 重复提交了不同参数' }
      }
      return { ok: true, job_id: jobId, model_id: existing.modelId }
    }
    const activeModelPath = resolvedModel?.modelPath || currentConfig?.modelPath || ''
    const record = {
      id: jobId,
      digest,
      status: 'queued',
      createdAt: Date.now(),
      completedAt: null,
      steps: parsed.request.sample_params.sample_steps,
      width: parsed.request.width,
      height: parsed.request.height,
      modelId: activeModelPath ? String(activeModelPath).replace(/^.*[\\/]/, '') : null,
      sdJobId: null,
      result: null,
      error: null,
      lastProgress: null,
    }
    jobs.set(jobId, record)
    log?.info?.(`local_gpu_submit jobId=${jobId} size=${record.width}x${record.height} steps=${record.steps}`)
    void (async () => {
      try {
        const submitted = await currentRuntime.submit(parsed.request)
        record.sdJobId = submitted?.id ?? null
        record.status = 'running'
        if (!record.sdJobId) throw new Error('sd-server 没有返回任务 id')
      } catch (error) {
        record.status = 'failed'
        record.completedAt = Date.now()
        record.error = {
          code: /out of memory|OOM|failed to allocate/i.test(String(error?.message))
            ? 'oom'
            : 'generation_failed',
          message: String(error?.message ?? error).slice(0, 1200),
        }
        log?.warn(`local_gpu_submit_failed jobId=${jobId} code=${record.error.code}`)
      }
    })()
    return { ok: true, job_id: jobId, model_id: record.modelId }
  }

  async function jobSnapshot(id) {
    const record = jobs.get(id)
    if (!record) {
      return { ok: false, status: 404, code: 'unknown_job', message: '本机 GPU 任务不存在或已过期' }
    }
    if (record.result) return { ok: true, job: record.result }
    if (record.status === 'failed') {
      return {
        ok: true,
        job: {
          status: 'failed',
          job_id: id,
          error: record.error,
          progress: record.lastProgress ?? { done: 0, total: 1 },
        },
      }
    }
    if (!record.sdJobId) {
      return {
        ok: true,
        job: {
          status: 'running',
          job_id: id,
          progress: { done: 0, total: 1, step: 0, steps: record.steps },
        },
      }
    }
    let sdJob
    try {
      sdJob = await currentRuntime.job(record.sdJobId)
    } catch (error) {
      const failed = {
        status: 'failed',
        job_id: id,
        error: {
          code: /out of memory|OOM|failed to allocate/i.test(String(error?.message))
            ? 'oom'
            : 'generation_failed',
          message: `本机 GPU 任务状态读取失败：${String(error?.message ?? error).slice(0, 1000)}`,
        },
        progress: record.lastProgress ?? { done: 0, total: 1 },
      }
      record.status = 'failed'
      record.completedAt = Date.now()
      record.result = failed
      return { ok: true, job: failed }
    }
    const mapped = mapSdJobToRemote(sdJob, record)
    record.lastProgress = mapped.progress ?? null
    if (mapped.status === 'done' || mapped.status === 'failed') {
      record.status = mapped.status
      record.completedAt = Date.now()
      record.result = mapped
    }
    return { ok: true, job: mapped }
  }

  async function handler(req, res) {
    const url = new URL(req.url ?? '/', endpointUrl || 'http://127.0.0.1')
    const pathname = url.pathname
    if (pathname === '/healthz') {
      json(res, 200, { ok: true })
      return
    }
    if (!authOk(req, secret)) {
      fail(res, 401, 'unauthorized', '本机 GPU 桥鉴权失败')
      return
    }
    try {
      if (pathname === '/health' && req.method === 'GET') {
        json(res, 200, await health())
        return
      }
      if (pathname === '/generate' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const submitted = await submitJob(body)
        if (!submitted.ok) {
          fail(res, submitted.status, submitted.code, submitted.message)
          return
        }
        json(res, 202, { status: 'ok', job_id: submitted.job_id, model_id: submitted.model_id })
        return
      }
      if (pathname === '/job' && req.method === 'GET') {
        prune()
        const snapshot = await jobSnapshot(url.searchParams.get('id') ?? '')
        if (!snapshot.ok) {
          fail(res, snapshot.status, snapshot.code, snapshot.message)
          return
        }
        json(res, 200, snapshot.job)
        return
      }
      if (pathname === '/logs' && req.method === 'GET') {
        const result = currentRuntime.logsSince(Number(url.searchParams.get('since') ?? 0))
        json(res, 200, { lines: result.lines, next: result.next })
        return
      }
      if (pathname === '/shutdown' && req.method === 'POST') {
        json(res, 200, { ok: true })
        setImmediate(() => {
          try {
            onShutdown?.()
          } catch (error) {
            log?.warn(`本机 GPU shutdown 回调失败：${error?.message ?? error}`)
          }
        })
        return
      }
      fail(res, 404, 'not_found', `未知的本机 GPU 桥路由：${pathname}`)
    } catch (error) {
      log?.warn(`local_gpu_bridge_error path=${pathname} message=${error?.message ?? error}`)
      fail(res, error?.status ?? 500, error?.code ?? 'internal_error', String(error?.message ?? error).slice(0, 1200))
    }
  }

  return {
    get token() {
      return secret
    },
    get endpointUrl() {
      return endpointUrl
    },

    async start() {
      if (server && endpointUrl) return endpointUrl
      server = createServer((req, res) => {
        void handler(req, res)
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      endpointUrl = `http://127.0.0.1:${port}`
      return endpointUrl
    },

    async stop() {
      if (!server) return
      const current = server
      server = null
      endpointUrl = ''
      current.closeAllConnections?.()
      await new Promise((resolve) => current.close(() => resolve()))
    },

    health,
  }
}

export const LOCAL_GPU_BRIDGE_LIMITS = Object.freeze({
  maxBodyBytes: MAX_BODY_BYTES,
  jobTtlMs: JOB_TTL_MS,
  requestTimeoutMs: TIMEOUTS.remoteJobRequestMs,
})

export const __test = { buildSdRequest, mapSdJobToRemote, localGpuHealthPayload, authOk }

