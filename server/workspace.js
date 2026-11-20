/**
 * 多工作区管理（桌面客户端的主目录切换）。
 *
 * 职责（docs/MIGRATION_SPEC.md §4 / §2.4）：
 *  - 维护「当前工作区」与「最近工作区列表」，持久化到应用全局 `app-config.json`；
 *  - 首次启动无当前工作区时：`AIGC_STUDIO_WORKSPACE` → `<dataDir>/workspace`（服务负责创建）；
 *  - 切换前校验目标：绝对路径、可创建、可写；失败返回结构化错误，由路由映射成 400/409；
 *  - `current()` 每次返回最新值：`ctx.get('workingDirectory')` 依赖它，切换工作区后无需重建 ctx。
 *
 * 边界：本模块不感知会话 / 任务队列状态；「有活跃任务时不可切换」由 workspace 路由结合
 * `session.isActive` 与 `queue.queueStats()` 判定。
 */

import { access, constants, mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { MAX_RECENT_WORKSPACES } from './app-config.js'
import { createLogger } from './log.js'

const defaultLog = createLogger({ scope: 'workspace' })

/** 把路径归一到绝对路径；非法返回 null。 */
function normalizeRequestedPath(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.includes('\0') || !isAbsolute(text)) return null
  return resolve(text)
}

/**
 * 确保目录存在且可写；不存在时递归创建。
 *
 * @param {string} path
 * @returns {Promise<{ ok: true, path: string } | { ok: false, code: string, message: string }>}
 */
async function ensureWritableDirectory(path) {
  const info = await stat(path).catch(() => null)
  if (info && !info.isDirectory()) {
    return { ok: false, code: 'invalid_request', message: '目标路径不是目录' }
  }
  if (!info) {
    try {
      await mkdir(path, { recursive: true })
    } catch (error) {
      return { ok: false, code: 'invalid_request', message: `无法创建目录：${String(error?.message ?? error).slice(0, 200)}` }
    }
  }
  try {
    await access(path, constants.W_OK)
  } catch {
    return { ok: false, code: 'invalid_request', message: '目标目录不可写' }
  }
  return { ok: true, path: resolve(path) }
}

/**
 * 创建 WorkspaceManager。
 *
 * @param {object} [options]
 * @param {object} [options.appConfig] createAppConfig() 的返回值（持久化 current/recent）
 * @param {string | null} [options.initialWorkspace] 首次启动的候选工作区（AIGC_STUDIO_WORKSPACE）
 * @param {string | null} [options.dataDir] 应用数据目录；无任何候选工作区时用 `<dataDir>/workspace`
 * @param {object} [options.log]
 */
export function createWorkspaceManager(options = {}) {
  const log = options.log ?? defaultLog
  const appConfig = options.appConfig ?? null
  const initialWorkspace = normalizeRequestedPath(options.initialWorkspace ?? null)
  const dataDir = options.dataDir ? resolve(options.dataDir) : null

  let current = null
  let recent = []
  let initialized = false

  function snapshot() {
    return { current, recent: [...recent] }
  }

  /** 更新最近列表：当前工作区永远在首位，去重并截断到上限。 */
  function touchRecent(path) {
    recent = [path, ...recent.filter((item) => item !== path)].slice(0, MAX_RECENT_WORKSPACES)
  }

  async function persist() {
    if (!appConfig?.setWorkspace) return
    try {
      await appConfig.setWorkspace({ current, recent })
    } catch (error) {
      // 持久化失败不回滚内存状态：本次进程内仍可用，下次启动会回到旧值。
      log.warn('工作区状态写入全局配置失败（继续使用内存状态）', String(error?.message ?? error).slice(0, 300))
    }
  }

  /**
   * 初始化：读取已保存的工作区；没有或不可用时按「环境变量 → 数据目录默认工作区」兜底。
   * 数据目录默认工作区创建失败视为致命错误（调用方应在启动期终止）。
   */
  async function init() {
    if (initialized) return api
    initialized = true
    await appConfig?.whenReady?.()

    const stored = appConfig?.getWorkspace?.() ?? { current: null, recent: [] }
    recent = Array.isArray(stored.recent) ? stored.recent.filter((item) => typeof item === 'string' && item) : []
    if (stored.current) recent = [stored.current, ...recent.filter((item) => item !== stored.current)]

    const candidates = []
    if (stored.current) candidates.push({ path: stored.current, source: 'app-config' })
    if (initialWorkspace) candidates.push({ path: initialWorkspace, source: 'env' })
    if (dataDir) candidates.push({ path: join(dataDir, 'workspace'), source: 'data-dir' })

    let lastError = null
    for (const candidate of candidates) {
      const ensured = await ensureWritableDirectory(candidate.path)
      if (ensured.ok) {
        current = ensured.path
        touchRecent(current)
        log.info(`workspace_ready source=${candidate.source} path=${current}`)
        if (stored.current !== current) await persist()
        return api
      }
      lastError = ensured
      log.warn(`工作区候选不可用（${candidate.source}）：${ensured.message}`)
    }

    // 没有任何可用工作区：抛出让 standalone 决定终止（避免各模块静默落到 process.cwd()）。
    const message = lastError?.message ?? '没有可用的工作区目录'
    throw Object.assign(new Error(`工作区初始化失败：${message}`), { code: 'workspace_unavailable' })
  }

  const ready = init().catch((error) => {
    log.error('workspace_init_failed', String(error?.message ?? error).slice(0, 300))
    throw error
  })
  // 避免未 await 时的 unhandledRejection；whenReady() 仍会把错误抛给调用方。
  ready.catch(() => {})

  const api = {
    /** 当前工作区绝对路径（可能尚未初始化完成，此时 null）。 */
    current() {
      return current
    },

    /** 最近工作区列表（当前工作区在首位）。 */
    recent() {
      return [...recent]
    },

    snapshot,

    whenReady() {
      return ready.then(() => api)
    },

    /**
     * 切换工作区：校验绝对路径 / 可创建 / 可写，成功后持久化并更新内存状态。
     *
     * @param {unknown} requested 目标绝对路径
     * @returns {Promise<{ ok: true, workspace: { current: string, recent: string[] } }
     *   | { ok: false, code: string, message: string }>}
     */
    async switchTo(requested) {
      await api.whenReady()
      const target = normalizeRequestedPath(requested)
      if (!target) {
        return { ok: false, code: 'invalid_request', message: 'path 必须是绝对路径' }
      }
      const ensured = await ensureWritableDirectory(target)
      if (!ensured.ok) return ensured

      if (ensured.path !== current) {
        const previous = current
        current = ensured.path
        touchRecent(current)
        try {
          await persist()
        } catch (error) {
          current = previous
          return { ok: false, code: 'internal_error', message: String(error?.message ?? error).slice(0, 300) }
        }
        log.info(`workspace_switched path=${current}`)
      } else {
        touchRecent(current)
        await persist()
      }
      return { ok: true, workspace: snapshot() }
    },
  }

  return api
}
