/**
 * 运行设置存储：`<workspace>/.aigc-studio/settings.json`（工作台设置抽屉的宿主侧实现）。
 *
 * 目的：把「空闲自动关机、GPU 加速器、HuggingFace Token、预挂载 Dataset / 本地权重、
 * pip 依赖约束」从只能改插件静态配置，扩展为可在工作台里保存、并在下次启动会话时生效。
 *
 * 设计约束：
 *  - 只保存用户显式修改过的覆盖项，未修改字段继续跟随插件静态 `config`，避免把默认值
 *    固化成旧快照；
 *  - 目录 0700、文件 0600；写入用「同目录临时文件 + rename」原子替换，启动/写入前清理
 *    遗留的 `.tmp-*`，进程中断只会留下可忽略的临时文件；
 *  - 读取失败或 JSON 损坏时静默降级为「仅静态 config」，并 best-effort 删除损坏文件，
 *    绝不阻塞插件加载；没有工作区时只用内存里的覆盖项，不写盘、也不误写 process.cwd()；
 *  - hfToken 只允许落盘在这个 0600 私有文件里并下发给远端；任何对外视图、日志、诊断
 *    都只暴露布尔与来源，不出现原文、长度或前缀。
 *
 * 边界：本文件同时导出纯函数（`normalizeSettingsPatch` / `mergeSettings` /
 * `publicSettingsView`）供离线单测直接 import；存储实例（`createSettingsStore`）只负责
 * 读写、串行化与应用覆盖项，不 import 宿主服务。
 */

import { readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { PROVIDER_IDS, SETTINGS, TIMEOUTS } from '../shared/contract.js'
import {
  clampIdleTimeout,
  cleanLocalModels,
  normalizeKaggleTransport,
  normalizeLocalModels,
} from '../shared/validation.js'
import { createSerialQueue, removeStaleTemps, writeFileAtomic } from './fs-atomic.js'
import { META_DIR } from './paths.js'

const SETTINGS_FILE = 'settings.json'
const TEMP_PREFIX = `${SETTINGS_FILE}.tmp-`

/**
 * settings.json 结构版本。
 *
 * v2：`kaggleTransport` 的契约默认值由 `cli` 改为 `direct`。v1 文件里存的 `cli` 基本都是
 * 当时的默认值而不是主动选择，若不迁移，所有老用户升级后仍会走 CLI，新默认永远跑不到。
 */
const SETTINGS_SCHEMA = 2
const LEGACY_TRANSPORT_DEFAULT = 'cli'

/** 用户可显式覆盖的字段（顺序即落盘顺序）；未知字段一律忽略，保持向前兼容。 */
const OVERRIDE_FIELDS = [
  'idleTimeoutSec',
  'accelerator',
  'provider',
  'colabGpu',
  'colabHighRam',
  'kaggleTransport',
  'hfToken',
  'datasetSources',
  'localModels',
  'pipConstraints',
]

// ---- 基础判断 -----------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** 校验失败的统一返回形状（与路由层的 invalid_request 对齐）。 */
function invalid(message) {
  return { ok: false, code: 'invalid_request', message }
}

// ---- 工作区路径 ---------------------------------------------------------

/**
 * 工作区根目录：只认 DSH 注入的 `workingDirectory`，取不到返回 null。
 * 与 lib/log.js 的判定保持一致——设置文件不能因为取不到工作区就落到 process.cwd()。
 */
function workspaceDirectory(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : null
    const directory = service?.defaultDirectory
    if (typeof directory !== 'string') return null
    const trimmed = directory.trim()
    if (!trimmed || trimmed.includes('\0') || !isAbsolute(trimmed)) return null
    return resolve(trimmed)
  } catch {
    return null
  }
}

/**
 * 设置文件绝对路径：`<workspace>/.aigc-studio/settings.json`；无工作区时返回 null。
 *
 * @param {object} ctx
 * @returns {string | null}
 */
export function settingsPath(ctx) {
  const workspace = workspaceDirectory(ctx)
  return workspace ? join(workspace, META_DIR, SETTINGS_FILE) : null
}

// ---- 校验与归一 ---------------------------------------------------------

/**
 * 归一化一个字符串数组字段：去空、按首次出现去重、单条截断到上限、最多保留 maxItems 项。
 * 非数组或含非字符串项直接判非法（不静默吞掉用户的错误输入）。
 */
function normalizeStringList(field, input) {
  if (!Array.isArray(input)) return invalid(`${field} 必须是字符串数组`)
  const items = []
  for (const raw of input) {
    if (typeof raw !== 'string') return invalid(`${field} 的每一项都必须是字符串`)
    const item = raw.trim().slice(0, SETTINGS.maxItemChars)
    if (!item || items.includes(item)) continue
    items.push(item)
    if (items.length >= SETTINGS.maxItems) break
  }
  return { ok: true, value: items }
}

/**
 * 校验并归一化来自 UI 的设置补丁。
 *
 * 规则：
 *  - 只认识 `idleTimeoutSec / accelerator / kaggleTransport / hfToken / clearHfToken /
 *    datasetSources / localModels / pipConstraints`，未知字段忽略（向前兼容）；
 *  - `idleTimeoutSec` 必须是有限数字，四舍五入后钳制到契约区间；显式传入非数字即 invalid_request；
 *  - `accelerator` 必须在契约白名单内；
 *  - `kaggleTransport` 必须在契约 `SETTINGS.kaggleTransports` 内（CLI / 直连试验特性）；
 *  - `hfToken` 非空（trim 后）才写入；空字符串表示「保持不变」；
 *    `clearHfToken: true` 清除已保存值，且优先于同请求里的 hfToken；
 *  - `datasetSources` / `pipConstraints` 必须是字符串数组，trim、去空、去重、限长；
 *  - `localModels` 必须是普通对象，键按 HF repo id 校验，值必须以 `/` 开头。
 *
 * @param {unknown} patch
 * @returns {{ ok: true, value: object } | { ok: false, code: 'invalid_request', message: string }}
 */
export function normalizeSettingsPatch(patch) {
  if (!isPlainObject(patch)) return invalid('设置必须是 JSON 对象')
  const value = {}

  if (hasOwn(patch, 'idleTimeoutSec')) {
    if (typeof patch.idleTimeoutSec !== 'number' || !Number.isFinite(patch.idleTimeoutSec)) {
      return invalid('idleTimeoutSec 必须是数字（秒）')
    }
    value.idleTimeoutSec = clampIdleTimeout(patch.idleTimeoutSec, SETTINGS.idleTimeoutSec.min)
  }

  if (hasOwn(patch, 'accelerator')) {
    if (!hasNonEmptyString(patch.accelerator)) return invalid('accelerator 必须是非空字符串')
    const accelerator = patch.accelerator.trim()
    if (!SETTINGS.accelerators.includes(accelerator)) {
      return invalid(`accelerator 必须是 ${SETTINGS.accelerators.join(' / ')} 之一`)
    }
    value.accelerator = accelerator
  }

  if (hasOwn(patch, 'provider')) {
    const provider = typeof patch.provider === 'string' ? patch.provider.trim() : patch.provider
    if (!SETTINGS.providers.includes(provider)) {
      return invalid(`provider 必须是 ${SETTINGS.providers.join(' / ')} 之一`)
    }
    value.provider = provider
  }

  if (hasOwn(patch, 'colabGpu')) {
    const gpu = typeof patch.colabGpu === 'string' ? patch.colabGpu.trim().toUpperCase() : patch.colabGpu
    if (!SETTINGS.colabGpus.includes(gpu)) {
      return invalid(`colabGpu 必须是 ${SETTINGS.colabGpus.join(' / ')} 之一`)
    }
    value.colabGpu = gpu
  }

  if (hasOwn(patch, 'colabHighRam')) {
    if (typeof patch.colabHighRam !== 'boolean') return invalid('colabHighRam 必须是布尔值')
    value.colabHighRam = patch.colabHighRam
  }

  if (hasOwn(patch, 'kaggleTransport')) {
    const transport = typeof patch.kaggleTransport === 'string' ? patch.kaggleTransport.trim() : patch.kaggleTransport
    if (!SETTINGS.kaggleTransports.includes(transport)) {
      return invalid(`kaggleTransport 必须是 ${SETTINGS.kaggleTransports.join(' / ')} 之一`)
    }
    value.kaggleTransport = transport
  }

  // hfToken：空串表示「保持不变」，非空才保存；clearHfToken 显式清除并优先。
  const clearHfToken = patch.clearHfToken === true
  if (clearHfToken) value.clearHfToken = true
  if (hasOwn(patch, 'hfToken')) {
    if (typeof patch.hfToken !== 'string') return invalid('hfToken 必须是字符串')
    const token = patch.hfToken.trim()
    if (token && !clearHfToken) value.hfToken = token
  }

  if (hasOwn(patch, 'datasetSources')) {
    const list = normalizeStringList('datasetSources', patch.datasetSources)
    if (!list.ok) return list
    value.datasetSources = list.value
  }
  if (hasOwn(patch, 'pipConstraints')) {
    const list = normalizeStringList('pipConstraints', patch.pipConstraints)
    if (!list.ok) return list
    value.pipConstraints = list.value
  }
  if (hasOwn(patch, 'localModels')) {
    const models = normalizeLocalModels(patch.localModels)
    if (!models.ok) return models
    value.localModels = models.value
  }

  return { ok: true, value }
}

// ---- 合并与脱敏视图 -----------------------------------------------------

/** 宽松清洗字符串数组：只保留非空字符串、trim、按首次出现去重（用于静态 config 兜底）。 */
function cleanStrings(value) {
  if (!Array.isArray(value)) return []
  const items = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const item = entry.trim()
    if (item && !items.includes(item)) items.push(item)
  }
  return items
}

/**
 * 合并静态 `config` 与用户保存的覆盖项，得到当前生效值。
 *
 * 纯函数：任何异常输入都按「该字段回退静态 config / 契约默认值」处理，不抛异常。
 *
 * @param {object} config 插件静态配置（apply(ctx, config) 的原样对象）
 * @param {object} overrides 用户显式覆盖项（settings.json 解析结果）
 * @returns {{ idleTimeoutSec: number, accelerator: string, kaggleTransport: 'cli' | 'direct',
 *             hfToken: string | null, datasetSources: string[], localModels: Record<string, string>,
 *             pipConstraints: string[] }}
 */
export function mergeSettings(config, overrides) {
  const base = isPlainObject(config) ? config : {}
  const saved = isPlainObject(overrides) ? overrides : {}

  const fallbackIdle = clampIdleTimeout(TIMEOUTS.idleShutdownSec, SETTINGS.idleTimeoutSec.min)
  const baseIdle = clampIdleTimeout(base.idleTimeoutSec, fallbackIdle)
  const idleTimeoutSec = hasOwn(saved, 'idleTimeoutSec')
    ? clampIdleTimeout(saved.idleTimeoutSec, baseIdle)
    : baseIdle

  const baseAccelerator = SETTINGS.accelerators.includes(base.accelerator)
    ? base.accelerator
    : SETTINGS.defaultAccelerator
  const accelerator =
    hasOwn(saved, 'accelerator') && SETTINGS.accelerators.includes(saved.accelerator)
      ? saved.accelerator
      : baseAccelerator

  // 合并时接受全部已知来源（静态 config 可以预配置尚未开放选择的私有 Worker）；
  // 保存补丁仍按 SETTINGS.providers（当前可选）校验，避免 UI 之外多出非法值。
  const provider = PROVIDER_IDS.includes(saved.provider)
    ? saved.provider
    : PROVIDER_IDS.includes(base.provider)
      ? base.provider
      : SETTINGS.defaultProvider
  const colabGpu = SETTINGS.colabGpus.includes(saved.colabGpu)
    ? saved.colabGpu
    : SETTINGS.colabGpus.includes(base.colabGpu)
      ? base.colabGpu
      : SETTINGS.defaultColabGpu
  // 高内存机型只对 T4/A100/G4 有意义；L4 等单机型传了也会被后端忽略。
  const colabHighRam = saved.colabHighRam === true || (base.colabHighRam === true && saved.colabHighRam !== false)

  const baseTransport = normalizeKaggleTransport(base.kaggleTransport)
  const kaggleTransport = hasOwn(saved, 'kaggleTransport')
    ? normalizeKaggleTransport(saved.kaggleTransport)
    : baseTransport

  const baseHfToken = hasNonEmptyString(base.hfToken) ? base.hfToken.trim() : null
  const savedHfToken = hasOwn(saved, 'hfToken') && hasNonEmptyString(saved.hfToken) ? saved.hfToken.trim() : null

  return {
    idleTimeoutSec,
    accelerator,
    provider,
    colabGpu,
    colabHighRam,
    kaggleTransport,
    hfToken: savedHfToken ?? baseHfToken,
    datasetSources: Array.isArray(saved.datasetSources)
      ? cleanStrings(saved.datasetSources)
      : cleanStrings(base.datasetSources),
    localModels: isPlainObject(saved.localModels) ? cleanLocalModels(saved.localModels) : cleanLocalModels(base.localModels),
    pipConstraints: Array.isArray(saved.pipConstraints)
      ? cleanStrings(saved.pipConstraints)
      : cleanStrings(base.pipConstraints),
  }
}

/**
 * 对外脱敏视图：绝不返回 hfToken 原文，只给布尔与来源。
 *
 * `hasConfigHfToken` 表示静态 config 里有 Token；`hasSettingsHfToken` 由存储实例传入
 * （用户保存过 Token 时为 true，未保存为 false，调用方不关心来源时可省略）。二者都缺失
 * 或自相矛盾时，按「有 Token 就归到 settings」处理，避免把来源误报成不存在的 none。
 *
 * @param {{ idleTimeoutSec?: number, accelerator?: string, kaggleTransport?: string,
 *           hfToken?: string | null, datasetSources?: string[], localModels?: object,
 *           pipConstraints?: string[] }} effective
 * @param {{ hasConfigHfToken?: boolean, hasSettingsHfToken?: boolean | null, sessionActive?: boolean }} [input]
 * @returns {{ idleTimeoutSec: number, accelerator: string, kaggleTransport: 'cli' | 'direct',
 *             datasetSources: string[], localModels: Record<string, string>, pipConstraints: string[],
 *             hasHfToken: boolean, hfTokenSource: 'settings' | 'config' | 'none',
 *             effectiveOnNextSession: boolean }}
 */
export function publicSettingsView(effective, { hasConfigHfToken = false, hasSettingsHfToken = null, sessionActive = false } = {}) {
  const value = isPlainObject(effective) ? effective : {}
  const hasHfToken = hasNonEmptyString(value.hfToken)
  let hfTokenSource = 'none'
  if (hasHfToken) {
    if (hasSettingsHfToken === true) hfTokenSource = 'settings'
    else if (hasConfigHfToken) hfTokenSource = 'config'
    else hfTokenSource = 'settings'
  }
  const accelerator = SETTINGS.accelerators.includes(value.accelerator)
    ? value.accelerator
    : SETTINGS.defaultAccelerator
  return {
    idleTimeoutSec: clampIdleTimeout(value.idleTimeoutSec, TIMEOUTS.idleShutdownSec),
    accelerator,
    provider: PROVIDER_IDS.includes(value.provider) ? value.provider : SETTINGS.defaultProvider,
    colabGpu: SETTINGS.colabGpus.includes(value.colabGpu) ? value.colabGpu : SETTINGS.defaultColabGpu,
    colabHighRam: value.colabHighRam === true,
    kaggleTransport: normalizeKaggleTransport(value.kaggleTransport),
    datasetSources: cleanStrings(value.datasetSources),
    localModels: cleanLocalModels(value.localModels),
    pipConstraints: cleanStrings(value.pipConstraints),
    hasHfToken,
    hfTokenSource,
    effectiveOnNextSession: Boolean(sessionActive),
  }
}

// ---- 原子读写 -----------------------------------------------------------

/** 原子写入覆盖项；目录与文件权限尽力收紧（Windows 忽略 mode 差异）。 */
async function writeSettingsFile(filePath, overrides) {
  // schema 只由存储层写：手工编辑 settings.json 时不必关心，读取侧缺失即视为 v1。
  const text = `${JSON.stringify({ schema: SETTINGS_SCHEMA, ...overrides }, null, 2)}\n`
  await writeFileAtomic(filePath, text, {
    ensureDir: true,
    dirMode: 0o700,
    fileMode: 0o600,
    cleanStale: true,
    tempPrefix: TEMP_PREFIX,
    encoding: 'utf8',
  })
}

/**
 * 从磁盘读取覆盖项：无工作区/文件不存在/读取失败/损坏都返回空对象。
 * 损坏文件 best-effort 删除，避免每次启动都解析失败；只清理本文件，不碰其它状态。
 */
async function loadOverrides(filePath) {
  if (!filePath) return {}
  await removeStaleTemps(dirname(filePath), TEMP_PREFIX)
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return {}
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!isPlainObject(parsed)) {
    await rm(filePath, { force: true }).catch(() => {})
    return {}
  }
  const value = normalizeStoredOverrides(parsed)
  // v1 → v2：丢掉一次「当时的默认值 cli」，让升级后的用户跟随新默认 direct 并重新探测；
  // 用户之后手动切回 cli 会以 schema=2 落盘，不会再次被清掉。
  const schema = Number.isFinite(Number(parsed.schema)) ? Number(parsed.schema) : 1
  if (schema < SETTINGS_SCHEMA && value.kaggleTransport === LEGACY_TRANSPORT_DEFAULT) {
    delete value.kaggleTransport
    await writeSettingsFile(filePath, value).catch(() => {})
  }
  return value
}

/** 逐字段重新校验磁盘内容：手工改坏某个字段时只丢该字段，不影响其它覆盖项。 */
function normalizeStoredOverrides(raw) {
  const value = {}
  for (const field of OVERRIDE_FIELDS) {
    if (!hasOwn(raw, field)) continue
    const result = normalizeSettingsPatch({ [field]: raw[field] })
    if (result.ok && hasOwn(result.value, field)) value[field] = result.value[field]
  }
  return value
}

// ---- 存储实例 -----------------------------------------------------------

/** `overridesPath` 的初始哨兵：保证构造后第一次 `syncPath()` 一定会加载一次。 */
const PATH_UNSET = Symbol('settings-path-unset')

/**
 * 创建设置存储。
 *
 * 路径是**动态**的：`current()/publicView()/save()` 每次都按 `settingsPath(ctx)` 解析当前工作区，
 * 因此切换工作区后不需要重建 store。路径变化时立即丢弃旧工作区的覆盖项（回落到静态 config），
 * 并异步加载新工作区的 settings.json；`reload()` 供工作区路由在切换成功后显式重读。
 *
 * 并发语义：
 *  - 写盘与 reload 共用同一条串行队列，不会交错读写；
 *  - 每次重新加载都有代数（generation），过期的异步加载结果不会覆盖新工作区的状态；
 *  - 保存前先等待当前工作区的文件加载完成，避免拿空覆盖项覆盖新工作区 settings.json 的其它字段。
 *
 * 调用方在读取视图前 `await whenReady()` 即可拿到加载后的合并结果，`current()` 永远返回同步
 * 可用的生效值（加载完成前等于静态 config）。
 *
 * @param {{ ctx?: object, config?: object }} [input]
 * @returns {{ whenReady: () => Promise<object>, current: () => object,
 *             publicView: (input?: { sessionActive?: boolean }) => object,
 *             reload: () => Promise<object>,
 *             save: (patch: object) => Promise<{ ok: boolean, code?: string, message?: string }> }}
 */
export function createSettingsStore({ ctx, config } = {}) {
  const staticConfig = isPlainObject(config) ? config : {}
  /** 当前生效的覆盖项（只属于 `overridesPath` 这个工作区）。 */
  let overrides = {}
  /** `overrides` 对应的工作区设置文件路径；`PATH_UNSET` 表示尚未解析过。 */
  let overridesPath = PATH_UNSET
  /** 加载代数：异步加载完成时只有仍是最新一代才应用结果，防止旧工作区的慢加载覆盖新状态。 */
  let generation = 0
  /** 当前一代的异步加载 promise（whenReady / save / reload 都依赖它）。 */
  let loading = Promise.resolve()
  // 写入 / 重载串行化：并发保存不会交错读改写，前一个失败也不阻塞后一个。
  const serialize = createSerialQueue()

  /**
   * 对齐路径：与当前生效路径不同时丢弃旧覆盖项、递增代数并异步加载新文件。
   *
   * @param {{ force?: boolean }} [options] force=true 时即使路径未变也重读（reload 用）
   */
  function syncPath({ force = false } = {}) {
    const path = settingsPath(ctx)
    if (!force && path === overridesPath) return
    overridesPath = path
    overrides = {}
    generation += 1
    const token = generation
    loading = (path ? loadOverrides(path) : Promise.resolve({}))
      .then((value) => {
        // 加载期间工作区可能又切换了：只有仍是最新一代码才应用。
        if (token === generation) overrides = value
      })
      .catch(() => {
        // loadOverrides 理论上不抛；即使抛错也只保留静态 config。
      })
  }

  // 构造时立即按当前工作区加载一次（与改造前行为一致）。
  syncPath()

  const store = {
    whenReady() {
      return loading.then(() => store)
    },
    current() {
      syncPath()
      return mergeSettings(staticConfig, overrides)
    },
    publicView({ sessionActive = false } = {}) {
      syncPath()
      return publicSettingsView(store.current(), {
        hasConfigHfToken: hasNonEmptyString(staticConfig.hfToken),
        hasSettingsHfToken: hasNonEmptyString(overrides.hfToken),
        sessionActive,
      })
    },
    /**
     * 重新读取当前工作区的设置文件，返回最新覆盖项。
     * 工作区路由在切换成功后调用，使 `/api/settings` 与 `/api/state` 立即反映新工作区。
     */
    async reload() {
      return serialize(async () => {
        syncPath({ force: true })
        await loading
        return { ...overrides }
      })
    },
    async save(patch) {
      const normalized = normalizeSettingsPatch(patch)
      if (!normalized.ok) return normalized
      try {
        return await serialize(async () => {
          // 先对齐路径并等待当前工作区加载完成：排队期间切换过工作区时，不能拿空的覆盖项
          // 去覆盖新工作区 settings.json 里已有的其它字段。
          syncPath()
          await loading
          const path = overridesPath
          const token = generation
          const next = { ...overrides }
          for (const field of OVERRIDE_FIELDS) {
            if (hasOwn(normalized.value, field)) next[field] = normalized.value[field]
          }
          if (normalized.value.clearHfToken === true) delete next.hfToken
          if (path) await writeSettingsFile(path, next)
          // 写盘期间工作区可能已切换（generation 递增）：只更新仍属同一路径的内存状态。
          if (token === generation && path === overridesPath) overrides = next
          return { ok: true }
        })
      } catch {
        // 不把磁盘错误抛给路由；只在内存里保持旧值，避免「界面显示已保存、重启后丢失」。
        return { ok: false, code: 'internal_error', message: '设置保存失败，请检查工作区目录权限' }
      }
    },
  }

  return store
}
