/**
 * 本机 GPU（Vulkan / stable-diffusion.cpp）配置。
 *
 * 配置刻意不放进工作区：同一台机器的二进制与 GGUF 权重不应随工作区切换重复安装。
 * 读取顺序：
 *  1. `<appConfig.root>/local-gpu.json`（可选，便于用户/设置页持久化）；
 *  2. `AIGC_STUDIO_LOCAL_GPU_*` 环境变量（覆盖文件，便于开发与排障）。
 *
 * 这里只做纯字段归一与路径判断，不启动进程、不探测硬件。
 *
 * @module server/local-gpu/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const LOCAL_GPU_CONFIG_FILE = 'local-gpu.json'
export const LOCAL_GPU_STATE_FILE = 'local-gpu-runtime.json'

/** 与 sd-cli 的 `--params-backend` 对齐；磁盘按需换入可避开低空闲内存机型。 */
export const LOCAL_GPU_PARAMS_BACKENDS = Object.freeze(['disk', 'cpu'])

const DEFAULTS = Object.freeze({
  threads: 0,
  idleTimeoutSec: 300,
  paramsBackend: 'disk',
  vaeTiling: true,
  extraArgs: [],
})

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function resolvePath(value, baseDir) {
  const text = cleanString(value)
  if (!text) return ''
  return isAbsolute(text) ? resolve(text) : resolve(baseDir, text)
}

function normalizeInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function normalizeExtraArgs(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 32)
}

function normalizeModelEntries(rawModels, baseDir) {
  if (!isPlainObject(rawModels)) return {}
  const out = {}
  for (const [rawId, entry] of Object.entries(rawModels)) {
    const id = cleanString(rawId)
    if (!id || !isPlainObject(entry)) continue
    const modelPath = resolvePath(entry.modelPath, baseDir)
    const vaePath = resolvePath(entry.vaePath, baseDir)
    if (!modelPath) continue
    out[id] = { modelPath, vaePath }
  }
  return out
}

/**
 * 归一配置对象。
 *
 * @param {object} raw 文件 / 环境变量合并后的原始对象
 * @param {{ baseDir?: string }} [options] 相对路径的基准目录（默认当前目录）
 * @returns {{ ok: boolean, config: object, errors: string[] }}
 */
export function normalizeLocalGpuConfig(raw, { baseDir = process.cwd() } = {}) {
  const source = isPlainObject(raw) ? raw : {}
  const errors = []
  const serverPath = resolvePath(source.serverPath, baseDir)
  let modelPath = resolvePath(source.modelPath, baseDir)
  let vaePath = resolvePath(source.vaePath, baseDir)
  const models = normalizeModelEntries(source.models, baseDir)
  const defaultPreset = cleanString(source.defaultPreset)
  if (!modelPath) {
    const first = (defaultPreset && models[defaultPreset]) || models['realvisxl-lightning'] || Object.values(models)[0] || null
    if (first) {
      modelPath = first.modelPath
      if (!vaePath) vaePath = first.vaePath
    }
  }
  const paramsBackend = LOCAL_GPU_PARAMS_BACKENDS.includes(source.paramsBackend)
    ? source.paramsBackend
    : DEFAULTS.paramsBackend

  if (!serverPath) errors.push('缺少 sd-server 可执行文件路径（serverPath / AIGC_STUDIO_LOCAL_GPU_SERVER）')
  if (!modelPath) errors.push('缺少 GGUF 模型路径（modelPath / AIGC_STUDIO_LOCAL_GPU_MODEL）')
  if (serverPath && !existsSync(serverPath)) errors.push(`sd-server 不存在：${serverPath}`)
  if (modelPath && !existsSync(modelPath)) errors.push(`模型文件不存在：${modelPath}`)
  if (vaePath && !existsSync(vaePath)) errors.push(`VAE 文件不存在：${vaePath}`)
  for (const [id, entry] of Object.entries(models)) {
    if (entry.modelPath && !existsSync(entry.modelPath)) errors.push(`模型 ${id} 文件不存在：${entry.modelPath}`)
    if (entry.vaePath && !existsSync(entry.vaePath)) errors.push(`模型 ${id} VAE 不存在：${entry.vaePath}`)
  }

  const config = {
    serverPath,
    modelPath,
    vaePath,
    defaultPreset,
    models,
    threads: normalizeInt(source.threads, DEFAULTS.threads, 0, 128),
    idleTimeoutSec: normalizeInt(source.idleTimeoutSec, DEFAULTS.idleTimeoutSec, 60, 3600),
    paramsBackend,
    vaeTiling: source.vaeTiling !== false,
    extraArgs: normalizeExtraArgs(source.extraArgs),
    // 指向文件所在目录，方便排障面板展示；不是新的配置字段。
    baseDir: serverPath ? dirname(serverPath) : baseDir,
  }
  return { ok: errors.length === 0, config, errors }
}

/** 环境变量覆盖（只接受显式设置的键）。 */
function envOverrides(env) {
  const patch = {}
  if (cleanString(env.AIGC_STUDIO_LOCAL_GPU_SERVER)) patch.serverPath = env.AIGC_STUDIO_LOCAL_GPU_SERVER
  if (cleanString(env.AIGC_STUDIO_LOCAL_GPU_MODEL)) patch.modelPath = env.AIGC_STUDIO_LOCAL_GPU_MODEL
  if (cleanString(env.AIGC_STUDIO_LOCAL_GPU_VAE)) patch.vaePath = env.AIGC_STUDIO_LOCAL_GPU_VAE
  if (cleanString(env.AIGC_STUDIO_LOCAL_GPU_THREADS)) patch.threads = env.AIGC_STUDIO_LOCAL_GPU_THREADS
  if (cleanString(env.AIGC_STUDIO_LOCAL_GPU_IDLE_SEC)) patch.idleTimeoutSec = env.AIGC_STUDIO_LOCAL_GPU_IDLE_SEC
  if (cleanString(env.AIGC_STUDIO_LOCAL_GPU_PARAMS_BACKEND)) {
    patch.paramsBackend = env.AIGC_STUDIO_LOCAL_GPU_PARAMS_BACKEND
  }
  if (cleanString(env.AIGC_STUDIO_LOCAL_GPU_VAE_TILING)) {
    patch.vaeTiling = env.AIGC_STUDIO_LOCAL_GPU_VAE_TILING !== '0'
  }
  return patch
}

/**
 * 同步读取配置（provider 在构造 / provision 时需要同步 getter）。
 *
 * @param {{ root?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{
 *   ok: boolean, config: object, errors: string[], source: 'file+env'|'file'|'env'|'none',
 *   configPath: string, statePath: string,
 * }}
 */
export function readLocalGpuConfig({ root = '', env = process.env } = {}) {
  const configPath = root ? join(root, LOCAL_GPU_CONFIG_FILE) : ''
  const statePath = root ? join(root, LOCAL_GPU_STATE_FILE) : ''
  let fileConfig = null
  if (configPath && existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch (error) {
      return {
        ok: false,
        config: normalizeLocalGpuConfig({}, { baseDir: root }).config,
        errors: [`local-gpu.json 不是合法 JSON：${error?.message ?? error}`],
        source: 'file',
        configPath,
        statePath,
      }
    }
  }
  const envPatch = envOverrides(env)
  const merged = { ...(isPlainObject(fileConfig) ? fileConfig : {}), ...envPatch }
  const normalized = normalizeLocalGpuConfig(merged, { baseDir: root || process.cwd() })
  const hasFile = isPlainObject(fileConfig)
  const hasEnv = Object.keys(envPatch).length > 0
  return {
    ...normalized,
    source: hasFile && hasEnv ? 'file+env' : hasFile ? 'file' : hasEnv ? 'env' : 'none',
    overrideByEnv: hasEnv,
    configPath,
    statePath,
  }
}

/** 按 presetId 解析实际应加载的模型路径；未在 models 映射且非默认本地预设则返回 null。 */
export function resolveLocalGpuModel(config, presetId = '') {
  if (!config || typeof config !== 'object') return null
  const id = cleanString(presetId)
  const models = isPlainObject(config.models) ? config.models : {}
  if (id && models[id] && models[id].modelPath) {
    return {
      presetId: id,
      modelPath: models[id].modelPath,
      vaePath: models[id].vaePath || config.vaePath || '',
    }
  }
  if (!config.modelPath) return null
  if (!id || id === (config.defaultPreset || 'realvisxl-lightning') || id === 'realvisxl-lightning') {
    return {
      presetId: id || config.defaultPreset || 'realvisxl-lightning',
      modelPath: config.modelPath,
      vaePath: config.vaePath || '',
    }
  }
  return null
}

/** 生成 `/api/state` 与 `/api/local-gpu/config` 共用的脱敏配置视图。 */
export function publicLocalGpuView(result) {
  const config = result?.config ?? normalizeLocalGpuConfig({}).config
  const modelIds = Object.keys(config.models ?? {})
  const configuredPresets = [...new Set([
    ...modelIds,
    ...(config.modelPath ? [config.defaultPreset || 'realvisxl-lightning'] : []),
  ].filter(Boolean))]
  return {
    ok: Boolean(result?.ok),
    configured: Boolean(result?.ok),
    errors: Array.isArray(result?.errors) ? result.errors : [],
    source: result?.source ?? 'none',
    overrideByEnv: Boolean(result?.overrideByEnv),
    configPath: result?.configPath ?? '',
    serverPath: config.serverPath ?? '',
    modelPath: config.modelPath ?? '',
    vaePath: config.vaePath ?? '',
    modelName: config.modelPath ? basename(config.modelPath) : '',
    models: config.models ?? {},
    configuredPresets,
    paramsBackend: config.paramsBackend ?? DEFAULTS.paramsBackend,
    threads: config.threads ?? DEFAULTS.threads,
    idleTimeoutSec: config.idleTimeoutSec ?? DEFAULTS.idleTimeoutSec,
    vaeTiling: config.vaeTiling !== false,
  }
}

/**
 * 持久化保存 `<root>/local-gpu.json`（先校验结构再原子替换；允许保存正在填写的部分配置但会如实返回 ok/errors）。
 */
export async function saveLocalGpuConfig({ root = '', patch = {}, env = process.env } = {}) {
  if (!root) {
    return { ok: false, code: 'invalid_request', message: '当前运行模式不支持写入 local-gpu.json' }
  }
  if (!isPlainObject(patch)) {
    return { ok: false, code: 'invalid_request', message: '配置必须是 JSON 对象' }
  }
  const configPath = join(root, LOCAL_GPU_CONFIG_FILE)
  let currentFile = {}
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
      if (isPlainObject(parsed)) currentFile = parsed
    } catch {}
  }

  const next = { ...currentFile }
  if (Object.prototype.hasOwnProperty.call(patch, 'serverPath')) {
    next.serverPath = cleanString(patch.serverPath)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'modelPath')) {
    next.modelPath = cleanString(patch.modelPath)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'vaePath')) {
    next.vaePath = cleanString(patch.vaePath)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'defaultPreset')) {
    next.defaultPreset = cleanString(patch.defaultPreset)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'paramsBackend') && LOCAL_GPU_PARAMS_BACKENDS.includes(patch.paramsBackend)) {
    next.paramsBackend = patch.paramsBackend
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'threads')) {
    next.threads = normalizeInt(patch.threads, DEFAULTS.threads, 0, 128)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'idleTimeoutSec')) {
    next.idleTimeoutSec = normalizeInt(patch.idleTimeoutSec, DEFAULTS.idleTimeoutSec, 60, 3600)
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'vaeTiling')) {
    next.vaeTiling = patch.vaeTiling !== false
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'models') && isPlainObject(patch.models)) {
    const models = {}
    for (const [rawId, entry] of Object.entries(patch.models)) {
      const id = cleanString(rawId)
      if (!id || !isPlainObject(entry)) continue
      const mPath = cleanString(entry.modelPath)
      const vPath = cleanString(entry.vaePath)
      if (!mPath) continue
      models[id] = vPath ? { modelPath: mPath, vaePath: vPath } : { modelPath: mPath }
    }
    next.models = models
  }

  await mkdir(root, { recursive: true })
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(tmpPath, configPath)
  return { ok: true, result: readLocalGpuConfig({ root, env }) }
}

/** 供 provider 句柄 / 日志使用的稳定签名（不含任何凭据）。 */
export function localGpuSignatureOf(config) {
  return [
    config?.serverPath ?? '',
    config?.modelPath ?? '',
    config?.vaePath ?? '',
    config?.paramsBackend ?? '',
    config?.threads ?? 0,
    config?.idleTimeoutSec ?? 0,
    config?.vaeTiling === false ? '0' : '1',
    Array.isArray(config?.extraArgs) ? config.extraArgs.join('\u0000') : '',
  ].join('|')
}

