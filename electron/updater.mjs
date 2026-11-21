/**
 * 应用内更新器（主进程，electron-updater 适配层）。
 *
 * 职责边界（docs/M2_8_RELEASE_AND_UPDATER_SPEC.md §3.3）：
 *  - 只负责「状态机 + 触发动作」，不直接操作窗口 / 托盘 / 退出流程；
 *  - 安装前的防烧额度护栏在这里判定，真正的 `quitAndInstall` 由 `electron/main.mjs`
 *    在 `shutdown()` 完整走完之后调用；
 *  - 运行形态由 `resolveInstallForm` 决定，只有 NSIS 安装版（或显式开发联调）
 *    才会拿到 `canAutoUpdate=true`。
 *
 * 本文件不 import `electron` 与 `electron-updater`：默认实现按需动态导入，
 * 测试注入假 autoUpdater 即可在纯 Node 下跑状态机（test/updater-main.mjs）。
 */

import { createLogger } from './logger.mjs'
import { resolveInstallForm } from './updater/policy.mjs'
import {
  canInstallNow,
  classifyUpdateError,
  createInitialUpdateState,
  normalizeUpdateState,
} from '../shared/update-state.js'

/** 启动后首次检查延迟：避开本地服务启动、首轮状态轮询与出图抢网络。 */
export const FIRST_CHECK_DELAY_MS = 10_000
/** 自动复查周期（规格 §3.3）。 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 下载进度节流：1% 或 500ms，避免 IPC 风暴。 */
export const PROGRESS_MIN_PERCENT_DELTA = 1
export const PROGRESS_MIN_INTERVAL_MS = 500

/** IPC 通道（electron/preload.cjs 里同名常量必须保持一致）。 */
export const UPDATER_CHANNELS = Object.freeze({
  state: 'aigc:updater-state',
  check: 'aigc:updater-check',
  download: 'aigc:updater-download',
  install: 'aigc:updater-install',
  installOnQuit: 'aigc:updater-install-on-quit',
  openRelease: 'aigc:updater-open-release',
  event: 'aigc:updater-event',
})

const RELEASE_PAGE = 'https://github.com/nanxfu/aigc-studio/releases/tag/v'

/** electron-updater 的 ESM 导入：CJS 包没有命名导出，必须从 default 上取。 */
export async function loadAutoUpdater() {
  const mod = await import('electron-updater')
  const autoUpdater = mod?.autoUpdater ?? mod?.default?.autoUpdater
  if (!autoUpdater) throw new Error('electron-updater 未导出 autoUpdater')
  return autoUpdater
}

/** 版本对应的 GitHub Release 页面。 */
function releasePageOf(version) {
  return version ? `${RELEASE_PAGE}${version}` : null
}

/** 去掉日志里的用户目录与查询串（electron-updater 会打印缓存目录 / 下载 URL）。 */
function sanitizeUpdaterLog(text) {
  return String(text ?? '')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '<home>')
    .replace(/\/Users\/[^/\s]+/g, '<home>')
    .replace(/\/home\/[^/\s]+/g, '<home>')
    .replace(/\?[^\s]*/g, '')
    .slice(0, 500)
}

/** electron-updater 的 logger 适配：info/debug 丢弃，warn/error 脱敏后落盘。 */
function loggerAdapter(log) {
  const write = (level) => (message) => {
    const text = sanitizeUpdaterLog(message)
    if (level === 'error') log.warn(`updater: ${text}`)
    else log.debug(`updater: ${text}`)
  }
  return {
    info: () => {},
    debug: () => {},
    warn: write('warn'),
    error: write('error'),
  }
}

/**
 * 创建更新器。
 *
 * @param {object} options
 * @param {object} [options.autoUpdater] 注入实现（缺省动态加载 electron-updater）
 * @param {object} options.policy `resolveInstallForm()` 的返回值
 * @param {string} options.currentVersion
 * @param {() => Promise<object | null>} [options.getSettings] 读本地服务 `/api/app-settings` 的 update 段
 * @param {() => Promise<object>} [options.getServerState] 安装护栏：重新拉 `/api/state` 并附 `{at, ok}`
 * @param {() => void} [options.onInstallReady] 护栏通过后由主进程置 pendingInstall 并退出
 * @param {(state: object) => void} [options.onStateChange]
 * @param {object} [options.log]
 * @param {() => number} [options.now]
 */
export async function createUpdater(options = {}) {
  const log = options.log ?? createLogger('updater')
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const policy = options.policy ?? resolveInstallForm({ isPackaged: false })
  const currentVersion = typeof options.currentVersion === 'string' ? options.currentVersion : ''
  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : async () => null
  const getServerState = typeof options.getServerState === 'function' ? options.getServerState : async () => null
  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null
  const onInstallReady = typeof options.onInstallReady === 'function' ? options.onInstallReady : null

  const autoUpdater = options.autoUpdater ?? await loadAutoUpdater()
  let state = createInitialUpdateState({
    form: policy.form,
    mode: policy.mode,
    canAutoUpdate: policy.canAutoUpdate,
    current: currentVersion,
    source: policy.forcedDev ? 'custom' : 'github',
  })
  let source = policy.forcedDev ? 'custom' : 'github'
  let mirrorUrl = policy.feedUrl || ''
  let autoCheck = true
  let disposed = false
  let checkInFlight = null
  let firstTimer = null
  let intervalTimer = null
  let lastProgress = { percent: -1, at: 0 }

  function emit() {
    try {
      onStateChange?.(state)
    } catch (error) {
      log.warn(`推送更新状态失败：${error?.message ?? error}`)
    }
  }

  function patch(next) {
    state = normalizeUpdateState({ ...state, ...next })
    emit()
    return state
  }

  /** 状态迁移日志：只记形态 / 来源 / 状态 / 错误码，不记 URL 与目录。 */
  function transition(reason, extra = '') {
    log.info(`update_state form=${state.form} source=${state.source} status=${state.status} reason=${reason}${extra}`)
  }

  // ── electron-updater 初始化 ────────────────────────────────────────────
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.channel = 'stable'
  try {
    autoUpdater.logger = loggerAdapter(log)
  } catch {
    // 某些版本 logger 是只读属性：忽略。
  }
  if (policy.forcedDev) {
    try {
      autoUpdater.forceDevUpdateConfig = true
    } catch {
      // ignore
    }
  }

  /** 应用更新源：github 用 app-update.yml / 默认配置，custom 用 generic provider。 */
  function applySource(nextSource, nextMirror) {
    // 开发联调固定走本地 feed，不受设置里的更新源影响。
    const normalizedSource = policy.forcedDev ? 'custom' : nextSource === 'custom' ? 'custom' : 'github'
    const normalizedMirror = policy.forcedDev
      ? String(policy.feedUrl ?? '').trim()
      : normalizedSource === 'custom' ? String(nextMirror ?? '').trim() : ''
    const changed = normalizedSource !== source || normalizedMirror !== mirrorUrl
    source = normalizedSource
    mirrorUrl = normalizedMirror
    if (!changed) return
    try {
      if (source === 'custom') {
        autoUpdater.setFeedURL({ provider: 'generic', url: mirrorUrl })
      } else {
        // 从自定义镜像切回 GitHub：清掉缓存的 generic provider，下次检查重新读 app-update.yml。
        autoUpdater.clientPromise = null
      }
    } catch (error) {
      log.warn(`设置更新源失败：${error?.message ?? error}`)
    }
    // 源变更后旧结果作废；下次检查重新判定。
    patch({ source, latest: null, hasUpdate: false, status: 'idle', releaseUrl: null, releaseName: null, checkedAt: null, error: null })
  }

  /** 读取本地服务的 update 段；返回是否允许自动检查。 */
  async function syncSettings() {
    let settings = null
    try {
      settings = await getSettings()
    } catch (error) {
      log.debug(`读取更新配置失败（沿用当前值）：${error?.message ?? error}`)
    }
    if (settings && typeof settings === 'object') {
      autoCheck = settings.updateCheck !== false
      applySource(settings.updateSource, settings.updateMirrorUrl)
    }
    return autoCheck
  }

  // ── 事件 → 状态 ───────────────────────────────────────────────────────
  autoUpdater.on('checking-for-update', () => {
    patch({ status: 'checking', progress: null, error: null })
    transition('checking')
  })

  autoUpdater.on('update-available', (info) => {
    const latest = typeof info?.version === 'string' ? info.version : state.latest
    patch({
      latest,
      status: 'available',
      checkedAt: new Date(now()).toISOString(),
      releaseName: typeof info?.releaseName === 'string' ? info.releaseName : state.releaseName,
      releaseUrl: source === 'custom' ? (mirrorUrl || null) : releasePageOf(latest),
      progress: null,
      error: null,
    })
    transition('available', ` latest=${latest ?? ''}`)
  })

  autoUpdater.on('update-not-available', (info) => {
    const latest = typeof info?.version === 'string' ? info.version : state.current
    patch({
      latest,
      status: 'up-to-date',
      checkedAt: new Date(now()).toISOString(),
      releaseUrl: null,
      progress: null,
      error: null,
    })
    transition('up-to-date', ` latest=${latest ?? ''}`)
  })

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress?.percent)
    const at = now()
    const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
    // 节流：1% 或 500ms 才推一次（首次进度立即推）。
    if (
      lastProgress.percent >= 0 &&
      safePercent - lastProgress.percent < PROGRESS_MIN_PERCENT_DELTA &&
      at - lastProgress.at < PROGRESS_MIN_INTERVAL_MS
    ) {
      return
    }
    lastProgress = { percent: safePercent, at }
    patch({
      status: 'downloading',
      progress: {
        percent: safePercent,
        transferred: Number(progress?.transferred) || 0,
        total: Number(progress?.total) || 0,
        bytesPerSecond: Number(progress?.bytesPerSecond) || 0,
      },
      error: null,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    const latest = typeof info?.version === 'string' ? info.version : state.latest
    patch({
      latest,
      status: 'downloaded',
      checkedAt: state.checkedAt ?? new Date(now()).toISOString(),
      releaseName: typeof info?.releaseName === 'string' ? info.releaseName : state.releaseName,
      progress: null,
      error: null,
    })
    transition('downloaded', ` latest=${latest ?? ''}`)
  })

  autoUpdater.on('error', (error) => {
    const code = classifyUpdateError(error, 'unknown')
    patch({
      status: 'error',
      progress: null,
      error: { code, message: String(error?.message ?? error ?? '').slice(0, 400) },
    })
    transition('error', ` code=${code}`)
  })

  // ── 动作 ──────────────────────────────────────────────────────────────
  async function check({ manual = false } = {}) {
    if (disposed || !policy.canAutoUpdate) return state
    if (!manual) {
      const enabled = await syncSettings()
      if (!enabled) return state
    } else {
      await syncSettings()
    }
    if (checkInFlight) return checkInFlight
    checkInFlight = Promise.resolve()
      .then(() => autoUpdater.checkForUpdates())
      .catch((error) => {
        const code = classifyUpdateError(error, 'unknown')
        patch({ status: 'error', error: { code, message: String(error?.message ?? error).slice(0, 400) } })
        transition('check_failed', ` code=${code}`)
        return state
      })
      .finally(() => {
        checkInFlight = null
      })
    return checkInFlight
  }

  async function download() {
    if (disposed || !policy.canAutoUpdate) return state
    if (state.status === 'downloading') return state
    if (state.status !== 'available') return state
    lastProgress = { percent: -1, at: 0 }
    try {
      // downloadUpdate 的进度与完成状态都通过事件回到状态机。
      await autoUpdater.downloadUpdate()
    } catch (error) {
      const code = classifyUpdateError(error, 'unknown')
      patch({ status: 'error', error: { code, message: String(error?.message ?? error).slice(0, 400) } })
      transition('download_failed', ` code=${code}`)
    }
    return state
  }

  /**
   * 安装护栏（规格 §3.4）：先重新拉 `/api/state`，活跃会话 / 排队任务时阻止安装。
   *
   * 通过后不在这里 quitAndInstall：调用 `onInstallReady()` 让主进程走
   * `pendingInstall → app.quit() → shutdown() → quitAndInstall()` 的固定顺序。
   */
  async function install() {
    if (disposed || !policy.canAutoUpdate) return { ok: false, reason: 'unsupported_form' }
    let serverState = null
    try {
      serverState = await getServerState()
    } catch (error) {
      log.warn(`安装前读取云端状态失败：${error?.message ?? error}`)
      serverState = null
    }
    const gate = canInstallNow({ state, serverState, now: now() })
    if (!gate.ok) {
      log.info(`update_install_blocked reason=${gate.reason} status=${state.status}`)
      return gate
    }
    log.info('update_install_ready：交给主进程执行 shutdown → quitAndInstall')
    try {
      onInstallReady?.()
    } catch (error) {
      log.error('触发安装流程失败', error)
      return { ok: false, reason: 'unknown' }
    }
    return { ok: true, reason: null }
  }

  /** 下载完成后切换「退出时安装」；未下载完成时忽略。 */
  function setInstallOnQuit(value) {
    const next = value === true
    if (next && state.status !== 'downloaded') return state
    patch({ installOnQuit: next })
    log.info(`update_install_on_quit value=${next}`)
    return state
  }

  /** 真正执行安装（只在 before-quit 的 shutdown 完成后调用）。 */
  function quitAndInstall() {
    try {
      autoUpdater.quitAndInstall(true, true)
      return true
    } catch (error) {
      log.error('quitAndInstall 失败', error)
      return false
    }
  }

  function start() {
    if (disposed || !policy.canAutoUpdate) {
      log.info(`更新器未启用：form=${policy.form} reason=${policy.reason ?? 'readonly'}`)
      return
    }
    log.info(
      `更新器已启用：form=${policy.form} source=${source} autoCheck=${autoCheck}` +
        `${policy.forcedDev ? '（开发联调）' : ''}`,
    )
    firstTimer = setTimeout(() => {
      firstTimer = null
      void check()
    }, FIRST_CHECK_DELAY_MS)
    firstTimer.unref?.()
    intervalTimer = setInterval(() => {
      void check()
    }, CHECK_INTERVAL_MS)
    intervalTimer.unref?.()
  }

  function dispose() {
    disposed = true
    if (firstTimer) clearTimeout(firstTimer)
    if (intervalTimer) clearInterval(intervalTimer)
    firstTimer = null
    intervalTimer = null
  }

  // 启动时先应用一次配置（不触发网络）。
  try {
    const settings = await getSettings()
    if (settings && typeof settings === 'object') {
      autoCheck = settings.updateCheck !== false
      applySource(settings.updateSource, settings.updateMirrorUrl)
    }
  } catch {
    // 本地服务未就绪：等首次 check 时再同步。
  }

  return {
    policy,
    getState: () => state,
    isAutoCheckEnabled: () => autoCheck,
    check,
    download,
    install,
    setInstallOnQuit,
    quitAndInstall,
    setSource(nextSource, nextMirror) {
      applySource(nextSource, nextMirror)
      return state
    },
    start,
    dispose,
  }
}
