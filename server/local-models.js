/**
 * 本机端侧模型统一管理器（单源注册表：shared/local-models.js）。
 *
 * 解决旧实现把模型分散写死在各自模块里的问题：
 *  1. 统一定位存储目录：环境变量 `AIGC_STUDIO_LOCAL_MODELS_DIR` > 全局设置
 *     `appConfig.getLocalModelsDir()` > 默认 `<userData>/models/`，不再随工作区切换重复下载；
 *  2. 向下兼容旧路径：若工作区 `<workspace>/.aigc-studio/models/` 已有通过校验的模型文件，
 *     直接命中复用，避免已经缓存过视觉感知模型的用户重复下载；
 *  3. 统一下载与完整性校验：支持流式分块接收并实时统计 `downloadedBytes` / `totalBytes`，
 *     单飞并发锁 + 字节数与 SHA-256 严格校验 + 原子落盘 + 失败冷却。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { LOCAL_MODELS, localModelById } from '../shared/local-models.js'
import { defaultDataDir } from './app-config.js'
import { writeFileAtomic } from './fs-atomic.js'
import { META_DIR, workspaceRoot } from './paths.js'

export const LOCAL_MODEL_NOT_FOUND = 'local_model_not_found'
export const LOCAL_MODEL_UNAVAILABLE = 'local_model_unavailable'

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000
const DEFAULT_COOLDOWN_MS = 60_000
const DISABLED_VALUES = new Set(['0', 'false', 'off', 'disabled', 'no'])

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function errorText(error) {
  return String(error?.message ?? error ?? 'unknown error').slice(0, 500)
}

function fail(code, message) {
  return { ok: false, code, message }
}

/**
 * 读取 HTTP 响应体：优先流式读取以便暴露实时进度；测试 mock 只提供 arrayBuffer() 时自动兜底。
 */
async function readResponseBuffer(response, onChunk) {
  const reader = response?.body && typeof response.body.getReader === 'function'
    ? response.body.getReader()
    : null
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer())
    onChunk?.(buffer.length)
    return buffer
  }
  const chunks = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const piece = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    chunks.push(piece)
    received += piece.length
    onChunk?.(received)
  }
  return Buffer.concat(chunks, received)
}

/**
 * @param {{
 *   ctx?: object,
 *   appConfig?: object,
 *   env?: object,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   log?: object,
 *   downloadTimeoutMs?: number,
 *   failureCooldownMs?: number,
 * }} [options]
 */
export function createLocalModelManager(options = {}) {
  const defaultCtx = options.ctx || null
  const appConfig = options.appConfig || null
  const env = options.env || process.env
  const log = options.log || null
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
  const now = options.now || (() => Date.now())
  const downloadTimeoutMs = Number.isFinite(options.downloadTimeoutMs)
    ? options.downloadTimeoutMs
    : DEFAULT_DOWNLOAD_TIMEOUT_MS
  const cooldownMs = Number.isFinite(options.failureCooldownMs)
    ? options.failureCooldownMs
    : DEFAULT_COOLDOWN_MS

  // id -> { promise, downloadedBytes, totalBytes }
  const flights = new Map()
  // id -> { until, message }
  const failures = new Map()
  // path -> { size, sha256 }（避免高频 listModels 每次对百 MB 模型全量算 SHA-256）
  const verifiedStatCache = new Map()

  function defaultDir() {
    const root = appConfig?.root || defaultDataDir(env)
    return join(root, 'models')
  }

  function overrideDir() {
    const raw = typeof env?.AIGC_STUDIO_LOCAL_MODELS_DIR === 'string'
      ? env.AIGC_STUDIO_LOCAL_MODELS_DIR.trim()
      : ''
    return raw ? resolve(raw) : ''
  }

  function customDir() {
    const raw = appConfig?.getLocalModelsDir?.() || ''
    return raw ? resolve(raw) : ''
  }

  function effectiveDir() {
    return overrideDir() || customDir() || defaultDir()
  }

  function envModelPath(spec) {
    if (!spec?.envPathKey) return ''
    const raw = typeof env?.[spec.envPathKey] === 'string' ? env[spec.envPathKey].trim() : ''
    return raw ? resolve(raw) : ''
  }

  function disabledReasonOf(spec) {
    if (spec?.envDisableKey && DISABLED_VALUES.has(String(env?.[spec.envDisableKey] ?? '').trim().toLowerCase())) {
      return 'env'
    }
    const disabled = appConfig?.getDisabledLocalModels?.()
    if (Array.isArray(disabled) && disabled.includes(spec?.id)) {
      return 'user'
    }
    return null
  }

  function isModelDisabled(spec) {
    return Boolean(disabledReasonOf(spec))
  }

  function primaryPathOf(spec) {
    return join(effectiveDir(), ...spec.file.split('/'))
  }

  function legacyWorkspacePathOf(spec, ctxOverride) {
    if (!spec.legacyWorkspaceSubpath) return ''
    const ctx = ctxOverride || defaultCtx
    if (!ctx) return ''
    return join(workspaceRoot(ctx), META_DIR, 'models', ...spec.legacyWorkspaceSubpath.split('/'))
  }

  async function verifyFile(path, spec, { fullHash = true } = {}) {
    if (!path) return false
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return false
    if (Number.isFinite(spec.bytes) && spec.bytes > 0 && info.size !== spec.bytes) return false
    const cached = verifiedStatCache.get(path)
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.sha256 === spec.sha256) {
      return true
    }
    if (!fullHash) {
      return info.size === spec.bytes
    }
    const buffer = await readFile(path).catch(() => null)
    if (!buffer) return false
    const digest = sha256Of(buffer)
    if (digest !== spec.sha256) return false
    verifiedStatCache.set(path, { size: info.size, mtimeMs: info.mtimeMs, sha256: digest })
    return true
  }

  async function findExisting(spec, ctxOverride, { fullHash = true } = {}) {
    const envPath = envModelPath(spec)
    if (envPath) {
      const info = await stat(envPath).catch(() => null)
      if (info?.isFile()) return { path: envPath, source: 'env', bytes: info.size }
      return null
    }
    const primary = primaryPathOf(spec)
    if (await verifyFile(primary, spec, { fullHash })) {
      return { path: primary, source: 'global', bytes: spec.bytes }
    }
    const legacy = legacyWorkspacePathOf(spec, ctxOverride)
    if (legacy && legacy !== primary && await verifyFile(legacy, spec, { fullHash })) {
      return { path: legacy, source: 'workspace', bytes: spec.bytes }
    }
    return null
  }

  async function downloadModel(spec) {
    const existingFlight = flights.get(spec.id)
    if (existingFlight) return existingFlight.promise

    if (!fetchImpl) {
      throw new Error('Host 没有可用的 fetch，无法下载本机模型')
    }
    const targetPath = primaryPathOf(spec)
    const state = {
      promise: null,
      downloadedBytes: 0,
      totalBytes: spec.bytes || 0,
    }
    const promise = (async () => {
      await mkdir(dirname(targetPath), { recursive: true })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`${spec.label} 下载超时`)), downloadTimeoutMs)
      timer.unref?.()
      try {
        log?.info?.(`local_model_download_start id=${spec.id} bytes=${spec.bytes}`)
        const response = await fetchImpl(spec.url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: { 'user-agent': 'AIGC-Studio/local-models' },
        })
        if (!response || !response.ok) {
          throw new Error(`${spec.label} 下载失败：HTTP ${response?.status ?? 'unknown'}`)
        }
        const headerLen = Number(response.headers?.get?.('content-length'))
        if (Number.isFinite(headerLen) && headerLen > 0) state.totalBytes = headerLen
        const buffer = await readResponseBuffer(response, (received) => {
          state.downloadedBytes = received
        })
        if (Number.isFinite(spec.bytes) && spec.bytes > 0 && buffer.length !== spec.bytes) {
          throw new Error(`${spec.label} 大小不符：expected ${spec.bytes}, got ${buffer.length}`)
        }
        const digest = sha256Of(buffer)
        if (spec.sha256 && digest !== spec.sha256) {
          throw new Error(`${spec.label} SHA-256 校验失败：${digest}`)
        }
        await writeFileAtomic(targetPath, buffer, { ensureDir: true, cleanStale: true })
        const info = await stat(targetPath).catch(() => null)
        if (info?.isFile()) {
          verifiedStatCache.set(targetPath, { size: info.size, mtimeMs: info.mtimeMs, sha256: spec.sha256 })
        }
        failures.delete(spec.id)
        log?.info?.(`local_model_download_done id=${spec.id} path=${targetPath}`)
        return targetPath
      } catch (error) {
        verifiedStatCache.delete(targetPath)
        await rm(targetPath, { force: true }).catch(() => {})
        const msg = errorText(error)
        failures.set(spec.id, { until: now() + cooldownMs, message: msg })
        log?.warn?.(`local_model_download_failed id=${spec.id} detail=${msg}`)
        throw error
      } finally {
        clearTimeout(timer)
      }
    })()

    state.promise = promise
    flights.set(spec.id, state)
    try {
      return await promise
    } finally {
      flights.delete(spec.id)
    }
  }

  /**
   * 确保模型已就绪并返回本地绝对路径。
   * 对标原 `workshop-vision.js`：环境变量覆写直接读文件（不改外部路径），其余校验 SHA-256 后按需下载。
   */
  async function ensureModel(id, { ctx: ctxOverride, force = false } = {}) {
    const spec = localModelById(id)
    if (!spec) {
      const error = new Error(`未登记的本机模型：${id}`)
      error.code = LOCAL_MODEL_NOT_FOUND
      throw error
    }
    if (isModelDisabled(spec)) {
      const reason = disabledReasonOf(spec)
      const error = new Error(reason === 'env' ? `${spec.label} 已通过环境变量关闭` : `${spec.label} 已在设置中停用`)
      error.code = LOCAL_MODEL_UNAVAILABLE
      throw error
    }
    const failure = failures.get(spec.id)
    if (!force && failure && failure.until > now()) {
      const error = new Error(failure.message)
      error.code = LOCAL_MODEL_UNAVAILABLE
      throw error
    }
    const envPath = envModelPath(spec)
    if (envPath) {
      const info = await stat(envPath).catch(() => null)
      if (!info?.isFile()) {
        const error = new Error(`本机模型文件不存在：${envPath}`)
        error.code = LOCAL_MODEL_UNAVAILABLE
        throw error
      }
      return envPath
    }
    const existing = await findExisting(spec, ctxOverride, { fullHash: true })
    if (existing) return existing.path
    // 若全局路径存在但哈希/大小损坏，先清理后再重下
    await rm(primaryPathOf(spec), { force: true }).catch(() => {})
    return downloadModel(spec)
  }

  async function describeModel(spec, ctxOverride) {
    const flight = flights.get(spec.id)
    const failure = failures.get(spec.id)
    const existing = await findExisting(spec, ctxOverride, { fullHash: false })
    let status = 'missing'
    let downloadedBytes = 0
    if (flight) {
      status = 'downloading'
      downloadedBytes = flight.downloadedBytes
    } else if (existing) {
      status = 'ready'
      downloadedBytes = existing.bytes || spec.bytes
    } else if (failure && failure.until > now()) {
      status = 'error'
    }
    const disabledBy = disabledReasonOf(spec)
    return {
      id: spec.id,
      task: spec.task,
      label: spec.label,
      grade: spec.grade,
      runtime: spec.runtime,
      preferredEps: spec.preferredEps || [spec.runtime],
      repo: spec.repo,
      revision: spec.revision,
      bytes: spec.bytes,
      license: spec.license,
      optional: spec.optional === true,
      disabled: Boolean(disabledBy),
      disabledBy,
      status,
      downloadedBytes,
      totalBytes: flight?.totalBytes || spec.bytes,
      source: existing?.source || null,
      path: existing?.path || null,
      error: status === 'error' ? failure.message : '',
    }
  }

  async function listModels({ ctx: ctxOverride } = {}) {
    const models = await Promise.all(LOCAL_MODELS.map((spec) => describeModel(spec, ctxOverride)))
    return {
      dir: effectiveDir(),
      defaultDir: defaultDir(),
      customDir: customDir(),
      overrideDir: overrideDir(),
      models,
    }
  }

  async function startDownload(id, { ctx: ctxOverride } = {}) {
    const spec = localModelById(id)
    if (!spec) return fail(LOCAL_MODEL_NOT_FOUND, `未登记的本机模型：${id}`)
    if (isModelDisabled(spec)) return fail(LOCAL_MODEL_UNAVAILABLE, `${spec.label} 已通过环境变量关闭`)
    const existing = await findExisting(spec, ctxOverride, { fullHash: true })
    if (existing) {
      return { ok: true, model: await describeModel(spec, ctxOverride) }
    }
    failures.delete(spec.id)
    // 清理可能损坏的残留文件后立即同步建立 flight，确保本次响应即可见 status='downloading'。
    await rm(primaryPathOf(spec), { force: true }).catch(() => {})
    void downloadModel(spec).catch(() => {})
    return { ok: true, model: await describeModel(spec, ctxOverride) }
  }

  async function deleteModel(id, { ctx: ctxOverride } = {}) {
    const spec = localModelById(id)
    if (!spec) return fail(LOCAL_MODEL_NOT_FOUND, `未登记的本机模型：${id}`)
    if (flights.has(spec.id)) {
      return fail('invalid_request', `${spec.label} 正在下载中，请稍后再清理`)
    }
    const primary = primaryPathOf(spec)
    const legacy = legacyWorkspacePathOf(spec, ctxOverride)
    for (const target of new Set([primary, legacy].filter(Boolean))) {
      verifiedStatCache.delete(target)
      await rm(target, { force: true }).catch(() => {})
    }
    failures.delete(spec.id)
    log?.info?.(`local_model_deleted id=${spec.id}`)
    return { ok: true, model: await describeModel(spec, ctxOverride) }
  }

  async function openModelStream(id, { ctx: ctxOverride } = {}) {
    const spec = localModelById(id)
    if (!spec) return fail(LOCAL_MODEL_NOT_FOUND, `未登记的本机模型：${id}`)
    let path
    try {
      path = await ensureModel(spec.id, { ctx: ctxOverride })
    } catch (error) {
      return fail(error?.code || LOCAL_MODEL_UNAVAILABLE, errorText(error))
    }
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) {
      return fail(LOCAL_MODEL_UNAVAILABLE, `本机模型文件不可读：${path}`)
    }
    return {
      ok: true,
      spec,
      path,
      bytes: info.size,
      stream: createReadStream(path),
    }
  }

  async function setModelEnabled(id, enabled, { ctx: ctxOverride } = {}) {
    const spec = localModelById(id)
    if (!spec) return fail(LOCAL_MODEL_NOT_FOUND, `未登记的本机模型：${id}`)
    if (typeof enabled !== 'boolean') return fail('invalid_request', 'enabled 必须是布尔值')
    if (appConfig?.setLocalModelEnabled) {
      const saved = await appConfig.setLocalModelEnabled(spec.id, enabled)
      if (!saved.ok) return saved
    }
    if (enabled) failures.delete(spec.id)
    log?.info?.(`local_model_toggled id=${spec.id} enabled=${enabled}`)
    return { ok: true, model: await describeModel(spec, ctxOverride) }
  }

  return {
    effectiveDir,
    defaultDir,
    ensureModel,
    listModels,
    startDownload,
    deleteModel,
    setModelEnabled,
    isModelDisabled: (id) => isModelDisabled(localModelById(id)),
    openModelStream,
    resetFailure(id) {
      if (id) failures.delete(id)
      else failures.clear()
    },
  }
}
