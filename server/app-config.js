/**
 * 应用全局配置与凭据（脱离工作区，跟随桌面客户端）。
 *
 * 磁盘布局（docs/MIGRATION_SPEC.md §4.2，目录默认 `%APPDATA%\aigc-studio\`）：
 *   - `app-config.json`：全局配置（0600），记录工作区、界面语言/主题、LLM 非敏感字段与算力覆盖项；
 *   - `credentials/llm.json`：LLM API Key（0600），**不**写进 app-config.json、不对外回传原文；
 *   - 其余凭据（kaggle / colab）仍由各自模块管理，本文件不重复托管。
 *
 * 设计约束：
 *  - 原子写（同目录临时文件 + rename）、目录 0700、文件 0600，启动/写入前清理遗留临时文件；
 *  - 文件不存在 / JSON 损坏 / 字段非法都静默降级（逐字段回退默认值），不阻塞服务启动；
 *  - LLM 字段的校验与脱敏复用 `server/llm/config.js`（与运行时归一化同一口径）。
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { PROVIDER_IDS, normalizeBaseUrl, normalizeLlmConfig, normalizeLlmPatch } from './llm/config.js'
import { IMAGE_API, SALAD } from '../shared/contract.js'
import { localModelById } from '../shared/local-models.js'
import { publicLlmProviders } from '../shared/llm-providers.js'
import {
  IMAGE_API_VENDOR_IDS,
  imageApiVendorOf,
  normalizeImageApiBaseUrl,
  parseCustomModelIds,
} from '../shared/image-providers.js'
import { UPDATE_SOURCES, normalizeMirrorUrl } from '../shared/update-state.js'
import { normalizeUiLang } from '../shared/locale.js'
import { createSerialQueue, removeStaleTemps, writeFileAtomic } from './fs-atomic.js'
import { createLogger } from './log.js'
import { normalizeWorkerEndpoint } from './providers/worker-url.js'

const defaultLog = createLogger({ scope: 'app-config' })

/** app-config.json 结构版本；未来不兼容变更时递增并在 load 里迁移。 */
export const APP_CONFIG_SCHEMA = 1
/** 最近工作区列表上限。 */
export const MAX_RECENT_WORKSPACES = 12
/** 配置文件体积上限：防手改出超大 JSON 拖慢启动。 */
const MAX_CONFIG_BYTES = 256 * 1024
const CONFIG_FILE = 'app-config.json'
const CREDENTIALS_DIR = 'credentials'
const LLM_CREDENTIALS_FILE = 'llm.json'
const WORKER_CREDENTIALS_FILE = 'workers.json'
// 商业生图 API 的 Key 按服务商分仓保存（切换服务商不会丢上一家的 Key）。
const IMAGE_API_CREDENTIALS_FILE = 'image-api.json'
const SALAD_CREDENTIALS_FILE = 'salad.json'
const TEMP_PREFIX = `${CONFIG_FILE}.tmp-`
const LLM_TEMP_PREFIX = `${LLM_CREDENTIALS_FILE}.tmp-`
const WORKER_TEMP_PREFIX = `${WORKER_CREDENTIALS_FILE}.tmp-`
const IMAGE_API_TEMP_PREFIX = `${IMAGE_API_CREDENTIALS_FILE}.tmp-`
const SALAD_TEMP_PREFIX = `${SALAD_CREDENTIALS_FILE}.tmp-`
/** Worker Token 上限：防止手改 / 粘贴超大内容拖慢请求与日志。 */
const WORKER_TOKEN_MAX_CHARS = 512

export const UI_LANGS = Object.freeze(['zh', 'en'])
export const UI_THEMES = Object.freeze(['light', 'dark', 'system'])

/** 可持久化到 app-config.compute 的 createApp config 覆盖项（白名单）。 */
export const COMPUTE_KEYS = Object.freeze([
  'accelerator',
  'idleTimeoutSec',
  'provider',
  'colabGpu',
  'colabHighRam',
  'kaggleTransport',
  'modelSource',
  'hfToken',
  'datasetSources',
  'localModels',
  'pipConstraints',
  'defaultPreset',
  'provisionTimeoutMinutes',
  'queueSlowMinutes',
  'queueStalledMinutes',
  'sessionWaitMinutes',
  'generateTimeoutSeconds',
  'fallbackTunnelCommand',
  'fallbackTunnelUrlRegex',
  'trustedTunnelDomains',
  // 私有 Worker 的非敏感字段（M3.1）：{ endpointUrl }；Token 在 credentials/workers.json。
  'privateWorker',
  // 商业生图 API 的非敏感字段（M3.5）：{ vendor, model, baseUrl }；
  // Key 按服务商存在 credentials/image-api.json（加密，公开视图只回 hasApiKey）。
  'imageApi',
  // SaladCloud 的非敏感字段（M3.6）：{ org, project, tier }；
  // Salad-Api-Key 单独存在 credentials/salad.json（加密，公开视图只回 hasApiKey）。
  'salad',
])

/**
 * 更新配置的默认值（独立 `update` 段，不跟随工作区）。
 *
 * 历史包袱：`updateCheck` 曾经放在 `compute` 里，但 `/api/settings` 与
 * `/api/app-settings` 都没有字段能落盘，等于从未真正生效。这里迁移到独立段，
 * 见 `normalizeUpdateSettings`。
 */
export const DEFAULT_UPDATE = Object.freeze({
  updateCheck: true,
  updateSource: 'github',
  updateMirrorUrl: '',
})

export const DEFAULT_TELEMETRY = Object.freeze({
  enabled: true,
  installId: '',
})
const TELEMETRY_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/

/** 默认全局数据目录：Windows `%APPDATA%\aigc-studio`、macOS Application Support、Linux XDG。 */
export function defaultDataDir(env = process.env) {
  if (typeof env.AIGC_STUDIO_DATA_DIR === 'string' && env.AIGC_STUDIO_DATA_DIR.trim()) {
    return resolve(env.AIGC_STUDIO_DATA_DIR.trim())
  }
  if (process.platform === 'win32') {
    const base = typeof env.APPDATA === 'string' && env.APPDATA ? env.APPDATA : join(homedir(), 'AppData', 'Roaming')
    return join(base, 'aigc-studio')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'aigc-studio')
  const base = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(homedir(), '.config')
  return join(base, 'aigc-studio')
}

// ---- 基础判断 -----------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** 绝对路径归一：非字符串 / 空串 / 含 NUL / 相对路径一律返回 null。 */
function normalizeAbsolutePath(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.includes('\0') || !isAbsolute(text)) return null
  return resolve(text)
}

function defaultState(defaultLang = 'zh') {
  const lang = UI_LANGS.includes(defaultLang) ? defaultLang : 'zh'
  return {
    schema: APP_CONFIG_SCHEMA,
    workspace: { current: null, recent: [] },
    ui: { lang, theme: 'system' },
    onboarding: { version: 1, status: 'pending' },
    llm: { provider: 'openai', baseUrl: '', model: '', reasoningEffort: '' },
    compute: {},
    update: { ...DEFAULT_UPDATE },
    telemetry: { ...DEFAULT_TELEMETRY },
    localModelsDir: '',
    disabledLocalModels: [],
  }
}

function normalizeDisabledLocalModels(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || seen.has(id) || !localModelById(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function cloneState(current, overrides = {}) {
  return {
    schema: APP_CONFIG_SCHEMA,
    workspace: { current: current.workspace.current, recent: [...current.workspace.recent] },
    ui: { ...current.ui },
    onboarding: { ...current.onboarding },
    llm: { ...current.llm },
    compute: { ...current.compute },
    update: { ...current.update },
    telemetry: { ...current.telemetry },
    localModelsDir: current.localModelsDir || '',
    disabledLocalModels: [...(current.disabledLocalModels || [])],
    ...overrides,
  }
}

// ---- 字段归一 -----------------------------------------------------------

/** 工作区状态：current 必须是绝对路径；recent 去重、限长、只留绝对路径。 */
export function normalizeWorkspaceState(raw) {
  const value = isPlainObject(raw) ? raw : {}
  const current = normalizeAbsolutePath(value.current)
  const recent = []
  if (Array.isArray(value.recent)) {
    for (const item of value.recent) {
      const path = normalizeAbsolutePath(item)
      if (!path || recent.includes(path)) continue
      recent.push(path)
      if (recent.length >= MAX_RECENT_WORKSPACES) break
    }
  }
  if (current && !recent.includes(current)) {
    recent.unshift(current)
    if (recent.length > MAX_RECENT_WORKSPACES) recent.length = MAX_RECENT_WORKSPACES
  }
  return { current, recent }
}

/** 界面设置：非法值逐字段回退默认。 */
function normalizeUiState(raw, defaultLang = 'zh') {
  const value = isPlainObject(raw) ? raw : {}
  const fallbackLang = UI_LANGS.includes(defaultLang) ? defaultLang : 'zh'
  return {
    lang: UI_LANGS.includes(value.lang) ? value.lang : fallbackLang,
    theme: UI_THEMES.includes(value.theme) ? value.theme : 'system',
  }
}

/** 遥测配置：默认开启；installId 只允许合法短标识符，缺失时由 load() 生成并落盘。 */
function normalizeTelemetryState(raw) {
  const value = isPlainObject(raw) ? raw : {}
  const installId = typeof value.installId === 'string' && TELEMETRY_ID_RE.test(value.installId.trim())
    ? value.installId.trim()
    : ''
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    installId,
  }
}

/** LLM 非敏感字段：provider / baseUrl / model / reasoningEffort（apiKey 不在这里）。 */
const REASONING_EFFORTS = Object.freeze(['', 'off', 'minimal', 'low', 'medium', 'high'])

/**
 * LLM 非敏感字段：provider / baseUrl / model / reasoningEffort（apiKey 不在这里）。
 *
 * 这里存「用户实际填写的值」而不是预设补全值：空 baseUrl 落盘仍是空串，
 * 由调用侧（server/llm/config.js）在运行期回填预设默认地址。
 */
function normalizeLlmStored(raw) {
  const value = isPlainObject(raw) ? raw : {}
  return {
    provider: PROVIDER_IDS.includes(value.provider) ? value.provider : 'openai',
    baseUrl: normalizeBaseUrl(value.baseUrl) ?? '',
    model: typeof value.model === 'string' ? value.model.trim().slice(0, 200) : '',
    reasoningEffort:
      typeof value.reasoningEffort === 'string' && REASONING_EFFORTS.includes(value.reasoningEffort.trim())
        ? value.reasoningEffort.trim()
        : '',
  }
}

/** 算力覆盖项：只保留白名单键，浅拷贝原值（深校验交给 settings / app.js 的既有逻辑）。 */
export function normalizeComputeState(raw) {
  if (!isPlainObject(raw)) return {}
  const value = {}
  for (const key of COMPUTE_KEYS) {
    if (!hasOwn(raw, key)) continue
    const item = raw[key]
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      value[key] = item
    } else if (Array.isArray(item)) {
      value[key] = item.filter((entry) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry))
    } else if (isPlainObject(item)) {
      value[key] = { ...item }
    }
  }
  return value
}

/**
 * 更新配置：独立 `update` 段（规格 §3.5）。
 *
 * 读取时逐字段回退默认值；旧版把 `updateCheck` 写在 `compute` 里，这里做一次性迁移，
 * 迁移后以 `update.updateCheck` 为准（`compute` 不再保留该键）。
 */
export function normalizeUpdateSettings(raw, legacyUpdateCheck) {
  const value = isPlainObject(raw) ? raw : {}
  const fallbackSource = UPDATE_SOURCES.includes(value.updateSource) ? value.updateSource : DEFAULT_UPDATE.updateSource
  const mirror = normalizeMirrorUrl(value.updateMirrorUrl, {
    allowInsecure: process.env.AIGC_STUDIO_UPDATE_DEV === '1',
  })
  return {
    updateCheck: typeof value.updateCheck === 'boolean'
      ? value.updateCheck
      : typeof legacyUpdateCheck === 'boolean' ? legacyUpdateCheck : DEFAULT_UPDATE.updateCheck,
    updateSource: fallbackSource,
    updateMirrorUrl: mirror ?? '',
  }
}

/**
 * 校验并合并一次 update patch（POST /api/app-settings）。
 *
 * 与读取不同，显式提交的非法值必须报错，不能静默纠正：
 *  - `updateCheck` 必须是布尔；
 *  - `updateSource` 只能是 github / custom；
 *  - `updateMirrorUrl` 只接受 https（开发联调允许回环 http），禁止 userinfo/query/fragment；
 *  - source=custom 时必须已有合法镜像地址。
 *
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
export function validateUpdatePatch(current, patch, options = {}) {
  if (!isPlainObject(patch)) return { ok: false, message: 'update 必须是 JSON 对象' }
  const next = { ...DEFAULT_UPDATE, ...(isPlainObject(current) ? current : {}) }
  if (hasOwn(patch, 'updateCheck')) {
    if (typeof patch.updateCheck !== 'boolean') {
      return { ok: false, message: 'updateCheck 必须是布尔值' }
    }
    next.updateCheck = patch.updateCheck
  }
  if (hasOwn(patch, 'updateSource')) {
    if (!UPDATE_SOURCES.includes(patch.updateSource)) {
      return { ok: false, message: `updateSource 必须是 ${UPDATE_SOURCES.join(' / ')} 之一` }
    }
    next.updateSource = patch.updateSource
  }
  if (hasOwn(patch, 'updateMirrorUrl')) {
    if (typeof patch.updateMirrorUrl !== 'string') {
      return { ok: false, message: 'updateMirrorUrl 必须是字符串' }
    }
    const normalized = normalizeMirrorUrl(patch.updateMirrorUrl, {
      allowInsecure: options.allowInsecure === true || process.env.AIGC_STUDIO_UPDATE_DEV === '1',
    })
    if (normalized === null) {
      return { ok: false, message: '更新镜像地址必须是 https://，且不能包含用户名/密码、查询串或片段' }
    }
    next.updateMirrorUrl = normalized
  }
  if (next.updateSource === 'custom' && !next.updateMirrorUrl) {
    return { ok: false, message: '使用自定义更新源时必须填写镜像地址' }
  }
  return { ok: true, value: next }
}

/**
 * 商业生图 API 的非敏感配置（`compute.imageApi`）：只含 vendor / model / baseUrl。
 *
 * 读取时逐字段回退（未知服务商回到默认项；非法 Base URL 丢弃回默认端点），
 * 保证手改坏一个字段不会让设置页整体不可用。Key 从不进入这里。
 */
export function normalizeImageApiState(raw) {
  const value = isPlainObject(raw) ? raw : {}
  const vendorId = IMAGE_API_VENDOR_IDS.includes(value.vendor) ? value.vendor : IMAGE_API_VENDOR_IDS[0]
  const vendor = imageApiVendorOf(vendorId)
  const model = typeof value.model === 'string' ? value.model.trim().slice(0, IMAGE_API.modelMaxChars) : ''
  const baseRaw = typeof value.baseUrl === 'string' ? value.baseUrl.trim().slice(0, IMAGE_API.baseUrlMaxChars) : ''
  const allowInsecure = process.env.AIGC_STUDIO_IMAGE_API_DEV === '1'
  const baseUrl = baseRaw ? normalizeImageApiBaseUrl(baseRaw, { allowInsecure }) : ''
  const customModelRaw = typeof value.customModel === 'string'
    ? value.customModel.trim().slice(0, IMAGE_API.modelMaxChars)
    : vendorId === 'custom'
      ? model
      : ''
  const customBaseRaw = typeof value.customBaseUrl === 'string'
    ? value.customBaseUrl.trim().slice(0, IMAGE_API.baseUrlMaxChars)
    : vendorId === 'custom'
      ? baseRaw
      : ''
  const customBaseUrl = customBaseRaw ? normalizeImageApiBaseUrl(customBaseRaw, { allowInsecure }) : ''
  return {
    vendor: vendorId,
    model: model || vendor.models[0]?.id || '',
    baseUrl: baseUrl === null ? '' : baseUrl,
    customModel: customModelRaw,
    customBaseUrl: customBaseUrl === null ? '' : customBaseUrl,
  }
}

/** Salad 组织 / 项目 id：转小写并为空或符合 API 约束；供读取时逐字段兜底。 */
function normalizeSaladId(value, pattern) {
  if (typeof value !== 'string') return ''
  const text = value.trim().toLowerCase()
  return text && pattern.test(text) ? text : ''
}

/**
 * SaladCloud 的非敏感配置（`compute.salad`）：org / project / tier。
 *
 * API Key 从不进入这里；未知档位回到默认 medium，空项目回到 default，
 * 非法 id 丢弃为空串，避免手改坏配置后启动阶段反复打 API。
 */
export function normalizeSaladState(raw) {
  const value = isPlainObject(raw) ? raw : {}
  return {
    org: normalizeSaladId(value.org, SALAD.orgPattern),
    project: normalizeSaladId(value.project, SALAD.projectPattern) || SALAD.defaultProject,
    tier: SALAD.tierIds.includes(value.tier) ? value.tier : SALAD.defaultTier,
  }
}

/** 凭据文件里的 Key 映射：只保留已登记服务商与非空字符串。 */
function normalizeImageApiKeys(raw) {
  const value = isPlainObject(raw) ? raw : {}
  const keys = {}
  for (const id of IMAGE_API_VENDOR_IDS) {
    const item = value[id]
    if (typeof item === 'string' && item.trim()) keys[id] = item.trim().slice(0, IMAGE_API.apiKeyMaxChars)
  }
  return keys
}

/** 读取时把 `compute.imageApi` 归一；其它 compute 字段原样保留。 */
function withNormalizedImageApi(compute) {
  const next = { ...compute }
  const imageApi = normalizeImageApiState(next.imageApi)
  next.imageApi = imageApi
  return next
}

/** 读取时把 `compute.salad` 归一；不改变其它 compute 字段。 */
function withNormalizedSalad(compute) {
  const next = { ...compute }
  next.salad = normalizeSaladState(next.salad)
  return next
}

// ---- 磁盘 I/O -----------------------------------------------------------

async function readJsonFile(filePath) {
  let info
  try {
    info = await stat(filePath)
  } catch {
    return null
  }
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return null
  try {
    const text = await readFile(filePath, 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 解析主进程提供的 32 字节 AES-256-GCM 密钥（64 位 hex）；无效则返回 null（退回 0600 文件）。 */
function parseCredentialKey(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) return null
  return Buffer.from(trimmed, 'hex')
}

function encryptSecret(plaintext, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    schema: APP_CONFIG_SCHEMA,
    enc: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  }
}

function decryptSecret(record, key) {
  const iv = Buffer.from(String(record.iv ?? ''), 'base64')
  const tag = Buffer.from(String(record.tag ?? ''), 'base64')
  const data = Buffer.from(String(record.data ?? ''), 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/**
 * 创建应用全局配置存储。
 *
 * @param {{ dataDir?: string, credentialKey?: string, log?: object }} [options]
 * @returns {object} 见各方法注释
 */
export function createAppConfig(options = {}) {
  const log = options.log ?? defaultLog
  const defaultLang = normalizeUiLang(options.defaultLang) ?? 'zh'
  const root = resolve(options.dataDir ?? defaultDataDir())
  const secretKey = parseCredentialKey(options.credentialKey ?? process.env.AIGC_STUDIO_CREDENTIAL_KEY)
  const configPath = join(root, CONFIG_FILE)
  const credentialsDir = join(root, CREDENTIALS_DIR)
  const llmCredentialsPath = join(credentialsDir, LLM_CREDENTIALS_FILE)
  const workerCredentialsPath = join(credentialsDir, WORKER_CREDENTIALS_FILE)
  const imageApiCredentialsPath = join(credentialsDir, IMAGE_API_CREDENTIALS_FILE)
  const saladCredentialsPath = join(credentialsDir, SALAD_CREDENTIALS_FILE)
  const serialize = createSerialQueue()

  let state = defaultState(defaultLang)
  let apiKey = ''
  let workerEndpointUrl = ''
  let workerToken = ''
  // 商业生图 API：服务商 id → Key（只在进程内保存，落盘走加密凭据文件）。
  let imageApiKeys = {}
  let saladApiKey = ''
  let loaded = false

  async function writeConfig(next) {
    const text = `${JSON.stringify(next, null, 2)}\n`
    await writeFileAtomic(configPath, text, {
      ensureDir: true,
      dirMode: 0o700,
      fileMode: 0o600,
      cleanStale: true,
      tempPrefix: TEMP_PREFIX,
      encoding: 'utf8',
    })
  }

  async function writeLlmCredentials(nextApiKey) {
    if (!nextApiKey) {
      await rm(llmCredentialsPath, { force: true }).catch(() => {})
      return
    }
    const payload = secretKey
      ? encryptSecret(nextApiKey, secretKey)
      : { schema: APP_CONFIG_SCHEMA, apiKey: nextApiKey }
    const text = `${JSON.stringify(payload, null, 2)}\n`
    await writeFileAtomic(llmCredentialsPath, text, {
      ensureDir: true,
      dirMode: 0o700,
      fileMode: 0o600,
      cleanStale: true,
      tempPrefix: LLM_TEMP_PREFIX,
      encoding: 'utf8',
    })
    await chmod(credentialsDir, 0o700).catch(() => {})
  }

  async function writeWorkerCredentials(nextToken) {
    if (!nextToken) {
      await rm(workerCredentialsPath, { force: true }).catch(() => {})
      return
    }
    const payload = secretKey
      ? encryptSecret(nextToken, secretKey)
      : { schema: APP_CONFIG_SCHEMA, token: nextToken }
    const text = `${JSON.stringify(payload, null, 2)}\n`
    await writeFileAtomic(workerCredentialsPath, text, {
      ensureDir: true,
      dirMode: 0o700,
      fileMode: 0o600,
      cleanStale: true,
      tempPrefix: WORKER_TEMP_PREFIX,
      encoding: 'utf8',
    })
    await chmod(credentialsDir, 0o700).catch(() => {})
  }

  /**
   * 写商业生图 API 的 Key（按服务商为键的映射）。
   *
   * 与 LLM Key 同口径：有主密钥时整块加密；没有主密钥退回 0600 明文（Windows 上
   * chmod 基本无效，但仍然尽力）。全部为空时删除文件，不留下空壳。
   */
  async function writeImageApiCredentials(nextKeys) {
    const keys = normalizeImageApiKeys(nextKeys)
    if (Object.keys(keys).length === 0) {
      await rm(imageApiCredentialsPath, { force: true }).catch(() => {})
      return
    }
    const plaintext = JSON.stringify(keys)
    const payload = secretKey
      ? encryptSecret(plaintext, secretKey)
      : { schema: APP_CONFIG_SCHEMA, keys }
    const text = `${JSON.stringify(payload, null, 2)}\n`
    await writeFileAtomic(imageApiCredentialsPath, text, {
      ensureDir: true,
      dirMode: 0o700,
      fileMode: 0o600,
      cleanStale: true,
      tempPrefix: IMAGE_API_TEMP_PREFIX,
      encoding: 'utf8',
    })
    await chmod(credentialsDir, 0o700).catch(() => {})
  }

  /** Salad API Key：与 LLM / Worker Key 同一套 AES-256-GCM 口径。 */
  async function writeSaladCredentials(nextApiKey) {
    if (!nextApiKey) {
      await rm(saladCredentialsPath, { force: true }).catch(() => {})
      return
    }
    const payload = secretKey
      ? encryptSecret(nextApiKey, secretKey)
      : { schema: APP_CONFIG_SCHEMA, apiKey: nextApiKey }
    const text = `${JSON.stringify(payload, null, 2)}\n`
    await writeFileAtomic(saladCredentialsPath, text, {
      ensureDir: true,
      dirMode: 0o700,
      fileMode: 0o600,
      cleanStale: true,
      tempPrefix: SALAD_TEMP_PREFIX,
      encoding: 'utf8',
    })
    await chmod(credentialsDir, 0o700).catch(() => {})
  }

  async function load() {
    await mkdir(credentialsDir, { recursive: true, mode: 0o700 }).catch(() => {})
    await removeStaleTemps(root, TEMP_PREFIX).catch(() => {})
    await removeStaleTemps(credentialsDir, LLM_TEMP_PREFIX).catch(() => {})
    await removeStaleTemps(credentialsDir, WORKER_TEMP_PREFIX).catch(() => {})
    await removeStaleTemps(credentialsDir, IMAGE_API_TEMP_PREFIX).catch(() => {})
    await removeStaleTemps(credentialsDir, SALAD_TEMP_PREFIX).catch(() => {})

    const raw = await readJsonFile(configPath)
    const next = defaultState(defaultLang)
    let updateMigrated = false
    if (isPlainObject(raw)) {
      next.workspace = normalizeWorkspaceState(raw.workspace)
      next.ui = normalizeUiState(raw.ui, defaultLang)
      // Older installations keep their normal startup; the guide remains available in Settings.
      next.onboarding = isPlainObject(raw.onboarding)
        && raw.onboarding.version === 1
        && ['pending', 'completed', 'skipped'].includes(raw.onboarding.status)
        ? { version: 1, status: raw.onboarding.status }
        : { version: 1, status: 'skipped' }
      next.llm = normalizeLlmStored(raw.llm)
      next.compute = normalizeComputeState(raw.compute)
      const legacyUpdateCheck = isPlainObject(raw.compute) ? raw.compute.updateCheck : undefined
      next.update = normalizeUpdateSettings(raw.update, legacyUpdateCheck)
      updateMigrated = !isPlainObject(raw.update) && typeof legacyUpdateCheck === 'boolean'
      next.telemetry = normalizeTelemetryState(raw.telemetry)
      next.localModelsDir = normalizeAbsolutePath(raw.localModelsDir) || ''
      next.disabledLocalModels = normalizeDisabledLocalModels(raw.disabledLocalModels)

      // 私有 Worker 地址（非敏感）：非法值静默丢弃，避免启动时把坏配置当成网络错误。
      const privateWorker = isPlainObject(raw.compute?.privateWorker) ? raw.compute.privateWorker : {}
      const normalizedEndpoint = normalizeWorkerEndpoint(privateWorker.endpointUrl)
      workerEndpointUrl = normalizedEndpoint.ok ? normalizedEndpoint.endpointUrl : ''
      const compute = { ...next.compute }
      delete compute.privateWorker
      next.compute = workerEndpointUrl ? { ...compute, privateWorker: { endpointUrl: workerEndpointUrl } } : compute
      // 商业生图 API 的非敏感字段：未知服务商 / 非法地址逐字段回退，不阻塞启动。
      next.compute = withNormalizedImageApi(next.compute)
      // SaladCloud 凭据 / 档位：非敏感字段同样逐字段回退。
      next.compute = withNormalizedSalad(next.compute)
    } else if (raw !== null) {
      log.warn('app-config.json 不是合法 JSON 对象，已回退默认配置')
      workerEndpointUrl = ''
    } else {
      workerEndpointUrl = ''
    }

    const credentials = await readJsonFile(llmCredentialsPath)
    let needsEncryptMigration = false
    if (typeof credentials === 'string') {
      apiKey = credentials.trim()
      needsEncryptMigration = Boolean(secretKey && apiKey)
    } else if (isPlainObject(credentials) && credentials.enc === 'aes-256-gcm') {
      if (secretKey) {
        try {
          apiKey = decryptSecret(credentials, secretKey).trim()
        } catch (error) {
          log.warn('解密 llm.json 失败，已回退为空密钥', String(error?.message ?? error).slice(0, 200))
          apiKey = ''
        }
      } else {
        log.warn('检测到加密的 llm.json，但未提供主密钥，无法读取')
        apiKey = ''
      }
    } else if (isPlainObject(credentials) && typeof credentials.apiKey === 'string') {
      apiKey = credentials.apiKey.trim()
      needsEncryptMigration = Boolean(secretKey && apiKey)
    } else {
      apiKey = ''
    }
    if (needsEncryptMigration) {
      await writeLlmCredentials(apiKey).catch(() => {})
    }

    // 私有 Worker Token：与 LLM Key 同一套加密口径；损坏 / 缺主密钥都按未配置处理。
    const workerCredentials = await readJsonFile(workerCredentialsPath)
    let needsWorkerEncryptMigration = false
    if (typeof workerCredentials === 'string') {
      workerToken = workerCredentials.trim().slice(0, WORKER_TOKEN_MAX_CHARS)
      needsWorkerEncryptMigration = Boolean(secretKey && workerToken)
    } else if (isPlainObject(workerCredentials) && workerCredentials.enc === 'aes-256-gcm') {
      if (secretKey) {
        try {
          workerToken = decryptSecret(workerCredentials, secretKey).trim().slice(0, WORKER_TOKEN_MAX_CHARS)
        } catch (error) {
          log.warn('解密 workers.json 失败，已回退为空 Token', String(error?.message ?? error).slice(0, 200))
          workerToken = ''
        }
      } else {
        log.warn('检测到加密的 workers.json，但未提供主密钥，无法读取')
        workerToken = ''
      }
    } else if (isPlainObject(workerCredentials) && typeof workerCredentials.token === 'string') {
      workerToken = workerCredentials.token.trim().slice(0, WORKER_TOKEN_MAX_CHARS)
      needsWorkerEncryptMigration = Boolean(secretKey && workerToken)
    } else {
      workerToken = ''
    }
    if (needsWorkerEncryptMigration) {
      await writeWorkerCredentials(workerToken).catch(() => {})
    }

    // 商业生图 API Key：按服务商映射保存；损坏 / 缺主密钥都按「该服务商未配置」处理。
    const imageApiCredentials = await readJsonFile(imageApiCredentialsPath)
    let needsImageApiEncryptMigration = false
    if (typeof imageApiCredentials === 'string') {
      try {
        imageApiKeys = normalizeImageApiKeys(JSON.parse(imageApiCredentials))
        needsImageApiEncryptMigration = Boolean(secretKey && Object.keys(imageApiKeys).length > 0)
      } catch {
        imageApiKeys = {}
      }
    } else if (isPlainObject(imageApiCredentials) && imageApiCredentials.enc === 'aes-256-gcm') {
      if (secretKey) {
        try {
          imageApiKeys = normalizeImageApiKeys(JSON.parse(decryptSecret(imageApiCredentials, secretKey)))
        } catch (error) {
          log.warn('解密 image-api.json 失败，已回退为未配置', String(error?.message ?? error).slice(0, 200))
          imageApiKeys = {}
        }
      } else {
        log.warn('检测到加密的 image-api.json，但未提供主密钥，无法读取')
        imageApiKeys = {}
      }
    } else if (isPlainObject(imageApiCredentials) && isPlainObject(imageApiCredentials.keys)) {
      imageApiKeys = normalizeImageApiKeys(imageApiCredentials.keys)
      needsImageApiEncryptMigration = Boolean(secretKey && Object.keys(imageApiKeys).length > 0)
    } else {
      imageApiKeys = {}
    }
    if (needsImageApiEncryptMigration) {
      await writeImageApiCredentials(imageApiKeys).catch(() => {})
    }

    // Salad API Key：单值加密凭据；损坏 / 缺主密钥都按未配置处理。
    const saladCredentials = await readJsonFile(saladCredentialsPath)
    let needsSaladEncryptMigration = false
    if (typeof saladCredentials === 'string') {
      saladApiKey = saladCredentials.trim().slice(0, SALAD.apiKeyMaxChars)
      needsSaladEncryptMigration = Boolean(secretKey && saladApiKey)
    } else if (isPlainObject(saladCredentials) && saladCredentials.enc === 'aes-256-gcm') {
      if (secretKey) {
        try {
          saladApiKey = decryptSecret(saladCredentials, secretKey).trim().slice(0, SALAD.apiKeyMaxChars)
        } catch (error) {
          log.warn('解密 salad.json 失败，已回退为空 Key', String(error?.message ?? error).slice(0, 200))
          saladApiKey = ''
        }
      } else {
        log.warn('检测到加密的 salad.json，但未提供主密钥，无法读取')
        saladApiKey = ''
      }
    } else if (isPlainObject(saladCredentials) && typeof saladCredentials.apiKey === 'string') {
      saladApiKey = saladCredentials.apiKey.trim().slice(0, SALAD.apiKeyMaxChars)
      needsSaladEncryptMigration = Boolean(secretKey && saladApiKey)
    } else {
      saladApiKey = ''
    }
    if (needsSaladEncryptMigration) {
      await writeSaladCredentials(saladApiKey).catch(() => {})
    }

    let telemetryInitialized = false
    if (!next.telemetry.installId) {
      next.telemetry = { ...next.telemetry, installId: randomUUID() }
      telemetryInitialized = true
    }

    state = next
    loaded = true
    if (updateMigrated || telemetryInitialized) {
      // 旧 compute.updateCheck 迁移或首次生成匿名 installId：写回一次配置。
      await writeConfig(next).catch((error) => {
        log.warn('写回全局配置失败（下次启动重试）', String(error?.message ?? error).slice(0, 200))
      })
    }
    // 尽力收紧权限（Windows 上 chmod 基本无效，但不影响使用）。
    await chmod(root, 0o700).catch(() => {})
    await chmod(configPath, 0o600).catch(() => {})
    await chmod(llmCredentialsPath, 0o600).catch(() => {})
    await chmod(workerCredentialsPath, 0o600).catch(() => {})
    await chmod(imageApiCredentialsPath, 0o600).catch(() => {})
    await chmod(saladCredentialsPath, 0o600).catch(() => {})
    return api
  }

  /** 对外脱敏摘要：地址 + 是否已保存 Token；Token 原文永不离开进程。 */
  function workerView() {
    return { endpointUrl: workerEndpointUrl, tokenConfigured: Boolean(workerToken) }
  }

  const ready = load().catch((error) => {
    log.warn('读取全局配置失败，已回退默认配置', String(error?.message ?? error).slice(0, 300))
    loaded = true
    return api
  })

  const api = {
    root,
    configPath,
    credentialsDir,
    llmCredentialsPath,
    workerCredentialsPath,
    imageApiCredentialsPath,
    saladCredentialsPath,

    whenReady() {
      return ready
    },

    /** 内部完整 LLM 配置（含 apiKey，仅进程内使用；对外视图见 publicSettingsView）。 */
    getLlmConfig() {
      return { ...state.llm, apiKey }
    },

    /** 内部完整 Worker 配置（含 token，仅 provider 使用；对外视图见 publicWorkerView）。 */
    getWorkerConfig() {
      return { endpointUrl: workerEndpointUrl, token: workerToken, tokenConfigured: Boolean(workerToken) }
    },

    /**
     * 内部完整生图 API 配置（含当前服务商的 Key，仅 provider / JobQueue 使用）。
     *
     * 返回的是「当前生效服务商」的 Key：切换服务商后不会误用上一家的凭据。
     */
    getImageApiConfig() {
      const config = normalizeImageApiState(state.compute?.imageApi)
      return {
        vendor: config.vendor,
        model: config.model,
        baseUrl: config.baseUrl,
        customBaseUrl: config.customBaseUrl,
        customModel: config.customModel,
        apiKey: imageApiKeys[config.vendor] ?? '',
        keys: { ...imageApiKeys },
      }
    },

    /** 内部完整 Salad 配置（含 API Key，仅 Provider / 探测路由使用）。 */
    getSaladConfig() {
      const config = normalizeSaladState(state.compute?.salad)
      return { ...config, apiKey: saladApiKey, hasApiKey: Boolean(saladApiKey) }
    },

    /** 对外脱敏摘要：服务商 / 模型 / 端点 + 是否有 Key；Key 原文永不离开进程。 */
    publicImageView() {
      const config = normalizeImageApiState(state.compute?.imageApi)
      return {
        vendor: config.vendor,
        model: config.model,
        baseUrl: config.baseUrl,
        customBaseUrl: config.customBaseUrl,
        customModel: config.customModel,
        hasApiKey: Boolean(imageApiKeys[config.vendor]),
        apiKeysConfigured: Object.keys(imageApiKeys),
      }
    },

    /** 对外脱敏摘要：组织 / 项目 / 档位 + 是否已有 Key；Key 原文永不离开进程。 */
    publicSaladView() {
      return { ...normalizeSaladState(state.compute?.salad), hasApiKey: Boolean(saladApiKey) }
    },

    /** 对外脱敏摘要：只回地址与 tokenConfigured。 */
    publicWorkerView() {
      return workerView()
    },

    getUi() {
      return { ...state.ui }
    },

    getWorkspace() {
      return { current: state.workspace.current, recent: [...state.workspace.recent] }
    },

    getCompute() {
      return { ...state.compute }
    },

    /** 更新配置（updateCheck / updateSource / updateMirrorUrl）。 */
    getUpdate() {
      return { ...state.update }
    },

    /** 遥测配置（含匿名 installId，仅服务端进程内使用；公开视图只返回 enabled）。 */
    getTelemetry() {
      return { ...state.telemetry }
    },

    /** 自定义本机端侧模型目录（空串表示跟随应用数据目录 `<root>/models`）。 */
    getLocalModelsDir() {
      return state.localModelsDir || ''
    },

    /** 用户手动停用的本机端侧模型 id 列表。 */
    getDisabledLocalModels() {
      return [...(state.disabledLocalModels || [])]
    },

    /** 切换指定本机模型启用状态并持久化到 app-config.json。 */
    setLocalModelEnabled(id, enabled) {
      return serialize(async () => {
        if (!localModelById(id)) {
          return { ok: false, code: 'invalid_request', message: `未知本机模型：${id}` }
        }
        if (typeof enabled !== 'boolean') {
          return { ok: false, code: 'invalid_request', message: 'enabled 必须是布尔值' }
        }
        const set = new Set(state.disabledLocalModels || [])
        if (enabled) set.delete(id)
        else set.add(id)
        const nextList = [...set]
        const prevList = state.disabledLocalModels || []
        if (nextList.length === prevList.length && nextList.every((v, i) => v === prevList[i])) {
          return { ok: true, disabledLocalModels: nextList }
        }
        const next = cloneState(state, { disabledLocalModels: nextList })
        try {
          await writeConfig(next)
        } catch (error) {
          log.warn('保存本机模型开关失败', String(error?.message ?? error).slice(0, 300))
          return { ok: false, code: 'internal_error', message: '设置保存失败，请检查应用数据目录权限' }
        }
        state = next
        return { ok: true, disabledLocalModels: nextList }
      })
    },

    /** 保存自定义本机模型目录（空串恢复默认；非空必须为绝对路径并确保目录可创建）。 */
    saveLocalModelsDir(rawDir) {
      return serialize(async () => {
        if (typeof rawDir !== 'string') {
          return { ok: false, code: 'invalid_request', message: 'dir 必须是字符串' }
        }
        const trimmed = rawDir.trim()
        let nextDir = ''
        if (trimmed) {
          const normalized = normalizeAbsolutePath(trimmed)
          if (!normalized) {
            return { ok: false, code: 'invalid_request', message: '本机模型目录必须是有效的绝对路径' }
          }
          try {
            await mkdir(normalized, { recursive: true })
          } catch (error) {
            return {
              ok: false,
              code: 'invalid_request',
              message: `本机模型目录无法创建或不可访问：${String(error?.message ?? error).slice(0, 200)}`,
            }
          }
          nextDir = normalized
        }
        if (nextDir === (state.localModelsDir || '')) return { ok: true, dir: nextDir }
        const next = cloneState(state, { localModelsDir: nextDir })
        try {
          await writeConfig(next)
        } catch (error) {
          log.warn('保存本机模型目录失败', String(error?.message ?? error).slice(0, 300))
          return { ok: false, code: 'internal_error', message: '设置保存失败，请检查应用数据目录权限' }
        }
        state = next
        return { ok: true, dir: nextDir }
      })
    },

    /** 对外脱敏视图：只回 hasApiKey / apiKeySource，绝不回 Key 原文。 */
    publicSettingsView() {
      // Provider 直接透传：枚举与展示元数据由 shared/llm-providers.js 单源维护，
      // 前端不再把 deepseek / kimi 等折算成 custom（那会让设置界面回显错误的服务商）。
      // configured 与运行时 isLlmConfigured 同一口径（baseUrl + model + 是否需要 Key）。
      const normalized = normalizeLlmConfig({ ...state.llm, apiKey })
      return {
        ui: { ...state.ui },
        onboarding: { ...state.onboarding },
        llm: {
          provider: normalized.provider,
          baseUrl: state.llm.baseUrl,
          model: state.llm.model,
          hasApiKey: Boolean(apiKey),
          apiKeySource: apiKey ? 'settings' : 'none',
          reasoningEffort: state.llm.reasoningEffort,
          // 对外视图的 provider 元数据与运行期同一份来源（前端不再硬编码白名单）。
          providers: publicLlmProviders(),
          configured: normalized.configured,
        },
        update: { ...state.update },
        telemetry: { enabled: state.telemetry.enabled !== false },
        worker: workerView(),
        // 商业生图 API：只回服务商 / 模型 / 端点与「是否已配置 Key」，不回 Key 原文。
        imageApi: api.publicImageView(),
        // SaladCloud：只回组织 / 项目 / 档位与「是否已配置 Key」。
        salad: api.publicSaladView(),
      }
    },

    /**
     * 合并保存界面 / LLM 设置（白名单字段：ui、llm、clearLlmApiKey）。
     * 工作区切换由 WorkspaceManager 负责，本方法只写全局配置文件。
     *
     * @param {object} patch
     * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
     */
    saveSettings(patch) {
      return serialize(async () => {
        if (!isPlainObject(patch)) {
          return { ok: false, code: 'invalid_request', message: '设置必须是 JSON 对象' }
        }
        const next = cloneState(state)
        let nextApiKey = apiKey
        let configDirty = false
        let credentialsDirty = false

        if (hasOwn(patch, 'onboarding')) {
          if (!isPlainObject(patch.onboarding) || patch.onboarding.version !== 1
            || !['completed', 'skipped'].includes(patch.onboarding.status)) {
            return { ok: false, code: 'invalid_request', message: 'onboarding 必须包含 version: 1 和 completed / skipped 状态' }
          }
          next.onboarding = { version: 1, status: patch.onboarding.status }
          configDirty = true
        }

        if (hasOwn(patch, 'ui')) {
          if (!isPlainObject(patch.ui)) {
            return { ok: false, code: 'invalid_request', message: 'ui 必须是 JSON 对象' }
          }
          // 与 server/settings.js 的口径一致：显式提交的非法值返回 invalid_request，不静默纠正。
          if (hasOwn(patch.ui, 'lang') && !UI_LANGS.includes(patch.ui.lang)) {
            return { ok: false, code: 'invalid_request', message: `lang 必须是 ${UI_LANGS.join(' / ')} 之一` }
          }
          if (hasOwn(patch.ui, 'theme') && !UI_THEMES.includes(patch.ui.theme)) {
            return { ok: false, code: 'invalid_request', message: `theme 必须是 ${UI_THEMES.join(' / ')} 之一` }
          }
          const ui = normalizeUiState({ ...next.ui, ...patch.ui })
          if (ui.lang !== next.ui.lang || ui.theme !== next.ui.theme) {
            next.ui = ui
            configDirty = true
          }
        }

        if (hasOwn(patch, 'llm')) {
          if (!isPlainObject(patch.llm)) {
            return { ok: false, code: 'invalid_request', message: 'llm 必须是 JSON 对象' }
          }
          const clear = patch.clearLlmApiKey === true || patch.llm.clearLlmApiKey === true
          const normalized = normalizeLlmPatch({ ...patch.llm, ...(clear ? { clearLlmApiKey: true } : {}) })
          if (!normalized.ok) return { ok: false, code: 'invalid_request', message: normalized.message }
          for (const field of ['provider', 'baseUrl', 'model', 'reasoningEffort']) {
            if (hasOwn(normalized.value, field) && normalized.value[field] !== next.llm[field]) {
              next.llm[field] = normalized.value[field]
              configDirty = true
            }
          }
          if (hasOwn(normalized.value, 'apiKey') && normalized.value.apiKey !== nextApiKey) {
            nextApiKey = normalized.value.apiKey
            credentialsDirty = true
          }
        }

        // 顶层 clearLlmApiKey 与 llm.clearLlmApiKey 等价，且优先于同请求里的 apiKey。
        if (patch.clearLlmApiKey === true && nextApiKey !== '') {
          nextApiKey = ''
          credentialsDirty = true
        }

        // 更新配置：独立段，安装包 / 便携版 / 浏览器态统一走这里，不跟随工作区。
        if (hasOwn(patch, 'update')) {
          const validated = validateUpdatePatch(next.update, patch.update)
          if (!validated.ok) {
            return { ok: false, code: 'invalid_request', message: validated.message }
          }
          for (const field of ['updateCheck', 'updateSource', 'updateMirrorUrl']) {
            if (validated.value[field] !== next.update[field]) {
              next.update[field] = validated.value[field]
              configDirty = true
            }
          }
        }

        if (hasOwn(patch, 'telemetry')) {
          if (!isPlainObject(patch.telemetry)) {
            return { ok: false, code: 'invalid_request', message: 'telemetry 必须是 JSON 对象' }
          }
          if (hasOwn(patch.telemetry, 'enabled')) {
            if (typeof patch.telemetry.enabled !== 'boolean') {
              return { ok: false, code: 'invalid_request', message: 'telemetry.enabled 必须是布尔值' }
            }
            if (patch.telemetry.enabled !== next.telemetry.enabled) {
              next.telemetry = { ...next.telemetry, enabled: patch.telemetry.enabled }
              configDirty = true
            }
          }
        }

        if (!configDirty && !credentialsDirty) return { ok: true }
        try {
          if (credentialsDirty) await writeLlmCredentials(nextApiKey)
          if (configDirty) await writeConfig(next)
        } catch (error) {
          log.warn('保存全局配置失败', String(error?.message ?? error).slice(0, 300))
          return { ok: false, code: 'internal_error', message: '设置保存失败，请检查应用数据目录权限' }
        }
        state = next
        apiKey = nextApiKey
        return { ok: true }
      })
    },

    /**
     * 保存私有 Worker 连接配置（M3.1）：
     *  - `endpointUrl` 为空串表示清除；非空必须通过 worker-url 的 HTTPS / 凭据校验；
     *  - `token` 非空才更新，空串表示保持不变；`clearToken: true` 显式清除；
     *  - 地址写 app-config.compute.privateWorker，Token 写 credentials/workers.json（加密）。
     *
     * @param {{ endpointUrl?: string, token?: string, clearToken?: boolean }} patch
     * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
     */
    saveWorkerSettings(patch) {
      return serialize(async () => {
        if (!isPlainObject(patch)) {
          return { ok: false, code: 'invalid_request', message: 'worker 设置必须是 JSON 对象' }
        }
        let nextEndpoint = workerEndpointUrl
        let nextToken = workerToken
        let configDirty = false
        let credentialsDirty = false

        if (hasOwn(patch, 'endpointUrl')) {
          if (typeof patch.endpointUrl !== 'string') {
            return { ok: false, code: 'invalid_request', message: 'endpointUrl 必须是字符串' }
          }
          const raw = patch.endpointUrl.trim()
          if (!raw) {
            nextEndpoint = ''
          } else {
            const normalized = normalizeWorkerEndpoint(raw)
            if (!normalized.ok) return { ok: false, code: 'invalid_request', message: normalized.message }
            nextEndpoint = normalized.endpointUrl
          }
          if (nextEndpoint !== workerEndpointUrl) configDirty = true
        }

        if (patch.clearToken === true) {
          if (workerToken) {
            nextToken = ''
            credentialsDirty = true
          }
        } else if (hasOwn(patch, 'token')) {
          if (typeof patch.token !== 'string') {
            return { ok: false, code: 'invalid_request', message: 'token 必须是字符串' }
          }
          const token = patch.token.trim()
          if (token.length > WORKER_TOKEN_MAX_CHARS) {
            return { ok: false, code: 'invalid_request', message: `Token 不能超过 ${WORKER_TOKEN_MAX_CHARS} 字符` }
          }
          if (token && token !== workerToken) {
            nextToken = token
            credentialsDirty = true
          }
        }

        if (!configDirty && !credentialsDirty) return { ok: true }

        const next = { ...state, compute: { ...state.compute } }
        if (nextEndpoint) next.compute.privateWorker = { endpointUrl: nextEndpoint }
        else delete next.compute.privateWorker
        try {
          if (credentialsDirty) await writeWorkerCredentials(nextToken)
          if (configDirty) await writeConfig(next)
        } catch (error) {
          log.warn('保存私有 Worker 配置失败', String(error?.message ?? error).slice(0, 300))
          return { ok: false, code: 'internal_error', message: '设置保存失败，请检查应用数据目录权限' }
        }
        state = next
        workerEndpointUrl = nextEndpoint
        workerToken = nextToken
        return { ok: true }
      })
    },

    /**
     * 保存商业生图 API 配置（M3.5 Phase A）。
     *
     *  - `vendor`：必须是 `shared/image-providers.js` 登记的服务商；切换后模型回到该服务商默认项；
     *  - `model`：模型 id（自定义端点允许任意非空值）；
     *  - `baseUrl`：空串表示使用服务商默认端点；非空必须是 https（回环 http 仅开发态）；
     *  - `apiKey`：留空表示保持不变；`clearApiKey: true` 清除当前服务商的 Key
     *    （key 按服务商分仓，切回上一家仍可用）。
     *
     * @param {{ vendor?: string, model?: string, baseUrl?: string, apiKey?: string, clearApiKey?: boolean }} patch
     * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
     */
    saveImageApiSettings(patch) {
      return serialize(async () => {
        if (!isPlainObject(patch)) {
          return { ok: false, code: 'invalid_request', message: '生图 API 设置必须是 JSON 对象' }
        }
        const current = normalizeImageApiState(state.compute?.imageApi)
        let vendorId = current.vendor
        let model = current.model
        let baseUrl = current.baseUrl
        let customModel = current.customModel
        let customBaseUrl = current.customBaseUrl
        let nextKeys = { ...imageApiKeys }
        let configDirty = false
        let credentialsDirty = false

        if (hasOwn(patch, 'vendor')) {
          if (!IMAGE_API_VENDOR_IDS.includes(patch.vendor)) {
            return { ok: false, code: 'invalid_request', message: `vendor 必须是 ${IMAGE_API_VENDOR_IDS.join(' / ')} 之一` }
          }
          if (patch.vendor !== vendorId) {
            vendorId = patch.vendor
            if (vendorId === 'custom') {
              model = customModel
              baseUrl = customBaseUrl
            } else {
              // 换内置服务商时回落其首个模型（实际选模由顶栏模型胶囊决定）；保留 custom 配置不丢失。
              model = imageApiVendorOf(vendorId).models[0]?.id ?? ''
              baseUrl = ''
            }
            configDirty = true
          }
        }

        if (hasOwn(patch, 'model')) {
          if (typeof patch.model !== 'string') {
            return { ok: false, code: 'invalid_request', message: 'model 必须是字符串' }
          }
          const value = patch.model.trim().slice(0, IMAGE_API.modelMaxChars)
          const vendor = imageApiVendorOf(vendorId)
          if (!value && !vendor.dynamicModel) {
            return { ok: false, code: 'invalid_request', message: 'model 不能为空' }
          }
          if (value !== model) {
            model = value
            configDirty = true
          }
          if (vendor.dynamicModel && value !== customModel) {
            customModel = value
            configDirty = true
          }
        }

        if (hasOwn(patch, 'baseUrl')) {
          if (typeof patch.baseUrl !== 'string') {
            return { ok: false, code: 'invalid_request', message: 'baseUrl 必须是字符串' }
          }
          const raw = patch.baseUrl.trim().slice(0, IMAGE_API.baseUrlMaxChars)
          const normalized = raw
            ? normalizeImageApiBaseUrl(raw, { allowInsecure: process.env.AIGC_STUDIO_IMAGE_API_DEV === '1' })
            : ''
          if (normalized === null) {
            return {
              ok: false,
              code: 'invalid_request',
              message: 'baseUrl 必须是 https://（开发态允许回环 http），且不能包含用户名/密码、查询串或片段',
            }
          }
          if (normalized !== baseUrl) {
            baseUrl = normalized
            configDirty = true
          }
          if (imageApiVendorOf(vendorId).dynamicModel && normalized !== customBaseUrl) {
            customBaseUrl = normalized
            configDirty = true
          }
        }

        // 自定义端点必须有端点与至少 1 个模型，否则「保存成功但永远调不通」。
        if (imageApiVendorOf(vendorId).dynamicModel) {
          if (!baseUrl) {
            return { ok: false, code: 'invalid_request', message: '自定义端点必须填写 Base URL' }
          }
          if (parseCustomModelIds(model).length === 0) {
            return { ok: false, code: 'invalid_request', message: '自定义端点必须填写至少一个模型 id' }
          }
        }

        if (patch.clearApiKey === true) {
          if (nextKeys[vendorId]) {
            delete nextKeys[vendorId]
            credentialsDirty = true
          }
        } else if (hasOwn(patch, 'apiKey')) {
          if (typeof patch.apiKey !== 'string') {
            return { ok: false, code: 'invalid_request', message: 'apiKey 必须是字符串' }
          }
          const key = patch.apiKey.trim()
          if (key.length > IMAGE_API.apiKeyMaxChars) {
            return { ok: false, code: 'invalid_request', message: `apiKey 不能超过 ${IMAGE_API.apiKeyMaxChars} 字符` }
          }
          if (key && key !== nextKeys[vendorId]) {
            nextKeys[vendorId] = key
            credentialsDirty = true
          }
        }

        if (!configDirty && !credentialsDirty) return { ok: true }

        const next = {
          ...state,
          compute: {
            ...state.compute,
            imageApi: { vendor: vendorId, model, baseUrl, customBaseUrl, customModel },
          },
        }
        try {
          if (credentialsDirty) await writeImageApiCredentials(nextKeys)
          if (configDirty) await writeConfig(next)
        } catch (error) {
          log.warn('保存商业生图 API 配置失败', String(error?.message ?? error).slice(0, 300))
          return { ok: false, code: 'internal_error', message: '设置保存失败，请检查应用数据目录权限' }
        }
        state = next
        imageApiKeys = normalizeImageApiKeys(nextKeys)
        return { ok: true }
      })
    },

    /**
     * 保存 SaladCloud 连接配置（M3.6）。
     *
     * - `org` / `project`：小写字母开头，仅 a-z / 0-9 / -；project 留空回退 `default`；
     * - `tier`：high / medium / low / batch；
     * - `apiKey`：留空表示保持不变；`clearApiKey: true` 删除加密凭据；
     * - API Key 只写 credentials/salad.json，非敏感字段写 app-config.compute.salad。
     *
     * @param {{ org?: string, project?: string, tier?: string, apiKey?: string, clearApiKey?: boolean }} patch
     * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
     */
    saveSaladSettings(patch) {
      return serialize(async () => {
        if (!isPlainObject(patch)) {
          return { ok: false, code: 'invalid_request', message: 'Salad 设置必须是 JSON 对象' }
        }
        const current = normalizeSaladState(state.compute?.salad)
        let org = current.org
        let project = current.project
        let tier = current.tier
        let nextApiKey = saladApiKey
        let configDirty = false
        let credentialsDirty = false

        if (hasOwn(patch, 'org')) {
          if (typeof patch.org !== 'string') {
            return { ok: false, code: 'invalid_request', message: 'org 必须是字符串' }
          }
          const value = patch.org.trim().toLowerCase()
          if (value && !SALAD.orgPattern.test(value)) {
            return { ok: false, code: 'invalid_request', message: 'org 只能包含小写字母、数字和连字符，且以字母开头' }
          }
          if (value !== org) {
            org = value
            configDirty = true
          }
        }

        if (hasOwn(patch, 'project')) {
          if (typeof patch.project !== 'string') {
            return { ok: false, code: 'invalid_request', message: 'project 必须是字符串' }
          }
          const value = patch.project.trim().toLowerCase() || SALAD.defaultProject
          if (!SALAD.projectPattern.test(value)) {
            return { ok: false, code: 'invalid_request', message: 'project 只能包含小写字母、数字和连字符，且以字母开头' }
          }
          if (value !== project) {
            project = value
            configDirty = true
          }
        }

        if (hasOwn(patch, 'tier')) {
          if (!SALAD.tierIds.includes(patch.tier)) {
            return { ok: false, code: 'invalid_request', message: `tier 必须是 ${SALAD.tierIds.join(' / ')} 之一` }
          }
          if (patch.tier !== tier) {
            tier = patch.tier
            configDirty = true
          }
        }

        if (patch.clearApiKey === true) {
          if (saladApiKey) {
            nextApiKey = ''
            credentialsDirty = true
          }
        } else if (hasOwn(patch, 'apiKey')) {
          if (typeof patch.apiKey !== 'string') {
            return { ok: false, code: 'invalid_request', message: 'apiKey 必须是字符串' }
          }
          const key = patch.apiKey.trim()
          if (key.length > SALAD.apiKeyMaxChars) {
            return { ok: false, code: 'invalid_request', message: `apiKey 不能超过 ${SALAD.apiKeyMaxChars} 字符` }
          }
          if (key && key !== saladApiKey) {
            nextApiKey = key
            credentialsDirty = true
          }
        }

        if (!configDirty && !credentialsDirty) return { ok: true }

        const next = {
          ...state,
          compute: { ...state.compute, salad: { org, project, tier } },
        }
        try {
          if (credentialsDirty) await writeSaladCredentials(nextApiKey)
          if (configDirty) await writeConfig(next)
        } catch (error) {
          log.warn('保存 Salad 配置失败', String(error?.message ?? error).slice(0, 300))
          return { ok: false, code: 'internal_error', message: '设置保存失败，请检查应用数据目录权限' }
        }
        state = next
        saladApiKey = nextApiKey
        return { ok: true }
      })
    },

    /**
     * 保存工作区状态（由 WorkspaceManager 在切换工作区时调用）。
     *
     * @param {{ current?: string | null, recent?: string[] }} workspace
     */
    setWorkspace(workspace) {
      return serialize(async () => {
        const next = cloneState(state, { workspace: normalizeWorkspaceState(workspace) })
        await writeConfig(next)
        state = next
        return api.getWorkspace()
      })
    },

    /** 是否已从磁盘加载完成（诊断/测试用）。 */
    get loaded() {
      return loaded
    },
  }

  return api
}
