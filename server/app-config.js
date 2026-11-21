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

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { PROVIDER_IDS, normalizeBaseUrl, normalizeLlmConfig, normalizeLlmPatch } from './llm/config.js'
import { createSerialQueue, removeStaleTemps, writeFileAtomic } from './fs-atomic.js'
import { createLogger } from './log.js'

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
const TEMP_PREFIX = `${CONFIG_FILE}.tmp-`
const LLM_TEMP_PREFIX = `${LLM_CREDENTIALS_FILE}.tmp-`

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
  'hfToken',
  'datasetSources',
  'localModels',
  'pipConstraints',
  'updateCheck',
  'defaultPreset',
  'provisionTimeoutMinutes',
  'queueSlowMinutes',
  'queueStalledMinutes',
  'sessionWaitMinutes',
  'generateTimeoutSeconds',
  'fallbackTunnelCommand',
  'fallbackTunnelUrlRegex',
  'trustedTunnelDomains',
])

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

function defaultState() {
  return {
    schema: APP_CONFIG_SCHEMA,
    workspace: { current: null, recent: [] },
    ui: { lang: 'zh', theme: 'system' },
    llm: { provider: 'openai', baseUrl: '', model: '', reasoningEffort: '' },
    compute: {},
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
function normalizeUiState(raw) {
  const value = isPlainObject(raw) ? raw : {}
  return {
    lang: UI_LANGS.includes(value.lang) ? value.lang : 'zh',
    theme: UI_THEMES.includes(value.theme) ? value.theme : 'system',
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
  const root = resolve(options.dataDir ?? defaultDataDir())
  const secretKey = parseCredentialKey(options.credentialKey ?? process.env.AIGC_STUDIO_CREDENTIAL_KEY)
  const configPath = join(root, CONFIG_FILE)
  const credentialsDir = join(root, CREDENTIALS_DIR)
  const llmCredentialsPath = join(credentialsDir, LLM_CREDENTIALS_FILE)
  const serialize = createSerialQueue()

  let state = defaultState()
  let apiKey = ''
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

  async function load() {
    await mkdir(credentialsDir, { recursive: true, mode: 0o700 }).catch(() => {})
    await removeStaleTemps(root, TEMP_PREFIX).catch(() => {})
    await removeStaleTemps(credentialsDir, LLM_TEMP_PREFIX).catch(() => {})

    const raw = await readJsonFile(configPath)
    const next = defaultState()
    if (isPlainObject(raw)) {
      next.workspace = normalizeWorkspaceState(raw.workspace)
      next.ui = normalizeUiState(raw.ui)
      next.llm = normalizeLlmStored(raw.llm)
      next.compute = normalizeComputeState(raw.compute)
    } else if (raw !== null) {
      log.warn('app-config.json 不是合法 JSON 对象，已回退默认配置')
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

    state = next
    loaded = true
    // 尽力收紧权限（Windows 上 chmod 基本无效，但不影响使用）。
    await chmod(root, 0o700).catch(() => {})
    await chmod(configPath, 0o600).catch(() => {})
    await chmod(llmCredentialsPath, 0o600).catch(() => {})
    return api
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

    whenReady() {
      return ready
    },

    /** 内部完整 LLM 配置（含 apiKey，仅进程内使用；对外视图见 publicSettingsView）。 */
    getLlmConfig() {
      return { ...state.llm, apiKey }
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

    /** 对外脱敏视图：只回 hasApiKey / apiKeySource，绝不回 Key 原文。 */
    publicSettingsView() {
      // 前端设置抽屉的 provider 枚举收敛为 4 个：deepseek / openrouter 等兼容端点归入 custom。
      const publicProvider = ['openai', 'anthropic', 'ollama'].includes(state.llm.provider)
        ? state.llm.provider
        : 'custom'
      // configured 与运行时 isLlmConfigured 同一口径（baseUrl + model + 是否需要 Key）。
      const configured = normalizeLlmConfig({ ...state.llm, apiKey }).configured
      return {
        ui: { ...state.ui },
        llm: {
          provider: publicProvider,
          baseUrl: state.llm.baseUrl,
          model: state.llm.model,
          hasApiKey: Boolean(apiKey),
          apiKeySource: apiKey ? 'settings' : 'none',
          reasoningEffort: state.llm.reasoningEffort,
          configured,
        },
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
        const next = {
          schema: APP_CONFIG_SCHEMA,
          workspace: { current: state.workspace.current, recent: [...state.workspace.recent] },
          ui: { ...state.ui },
          llm: { ...state.llm },
          compute: { ...state.compute },
        }
        let nextApiKey = apiKey
        let configDirty = false
        let credentialsDirty = false

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
     * 保存工作区状态（由 WorkspaceManager 在切换工作区时调用）。
     *
     * @param {{ current?: string | null, recent?: string[] }} workspace
     */
    setWorkspace(workspace) {
      return serialize(async () => {
        const next = {
          schema: APP_CONFIG_SCHEMA,
          workspace: normalizeWorkspaceState(workspace),
          ui: { ...state.ui },
          llm: { ...state.llm },
          compute: { ...state.compute },
        }
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
