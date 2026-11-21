/**
 * 客户端更新状态派生（纯函数，不依赖 React / DOM）。
 *
 * 两个来源统一成同一形状（shared/update-state.js 的 `normalizeUpdateState`）：
 *  - Electron 安装版：主进程 `window.aigcStudio.updater` 推送的完整状态；
 *  - 便携 / 解压 / 开发 / 浏览器直连：`/api/state.update` 的只读快照。
 *
 * 本文件只做「归一 + 动作可行性与文案键」，不发请求、不改状态。
 *
 * @typedef {{
 *   latest: string,
 *   current: string,
 *   releaseUrl: string,
 *   checkedAt: string | null,
 * }} UpdateNotice
 */

import { formatText } from './format.js'
import {
  UPDATE_ERROR_CODES,
  canInstallNow,
  errorMessageKey,
  installGateMessageKey,
  normalizeUpdateState,
} from '../../shared/update-state.js'

export { UPDATE_ERROR_CODES, canInstallNow, errorMessageKey, installGateMessageKey, normalizeUpdateState }

/** Release 链接只接受 https，避免快照被篡改后跳转到非预期地址。 */
function safeUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return ''
  return value
}

/**
 * 从宿主状态派生「有新版本」提示（兼容旧调用点：useSessionControl 仍在使用）。
 *
 * @param {object | null | undefined} state `/api/state` 响应
 * @returns {UpdateNotice | null}
 */
export function updateOf(state) {
  const input = state && typeof state === 'object' ? state.update : null
  if (!input || typeof input !== 'object') return null
  if (input.hasUpdate !== true) return null
  const latest = typeof input.latest === 'string' ? input.latest.trim() : ''
  if (!latest) return null
  const current = typeof input.current === 'string' && input.current.trim()
    ? input.current.trim()
    : typeof state.version === 'string' ? state.version : ''
  const checkedAt = typeof input.checkedAt === 'string' && input.checkedAt.trim() ? input.checkedAt.trim() : null
  return {
    latest,
    current,
    releaseUrl: safeUrl(input.releaseUrl),
    checkedAt,
  }
}

/**
 * 只读形态的状态：把 `/api/state.update` 快照并进完整状态形状。
 *
 * @param {unknown} snapshot
 * @param {{ form?: string, current?: string }} [fallback]
 * @returns {object | null}
 */
export function updateStateOf(snapshot, fallback = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null
  return normalizeUpdateState({
    ...snapshot,
    // 只读形态不允许被快照里的字段抬成可自动更新。
    mode: 'readonly',
    form: fallback.form ?? snapshot.form ?? 'unsupported',
    canAutoUpdate: false,
    current: snapshot.current || fallback.current || '',
  })
}

/**
 * 状态 → 可执行动作（按钮可用性与主按钮）。
 *
 * @param {object | null} state 归一后的状态
 * @param {{ busy?: boolean }} [options]
 * @returns {{
 *   canCheck: boolean,
 *   canDownload: boolean,
 *   canInstall: boolean,
 *   canInstallOnQuit: boolean,
 *   canOpenRelease: boolean,
 *   primary: 'check' | 'download' | 'install' | 'open-release' | 'none',
 * }}
 */
export function updateActionsOf(state, options = {}) {
  const busy = options.busy === true
  if (!state) {
    return {
      canCheck: !busy,
      canDownload: false,
      canInstall: false,
      canInstallOnQuit: false,
      canOpenRelease: false,
      primary: 'check',
    }
  }
  const settled = state.status !== 'checking' && state.status !== 'downloading'
  const canDownload = state.canAutoUpdate && state.status === 'available' && !busy
  const canInstall = state.canAutoUpdate && state.status === 'downloaded' && !busy
  const canOpenRelease = Boolean(state.releaseUrl)
  let primary = 'none'
  if (canDownload) primary = 'download'
  else if (canInstall) primary = 'install'
  else if (state.hasUpdate && canOpenRelease) primary = 'open-release'
  else if (settled && !busy) primary = 'check'
  return {
    canCheck: settled && !busy,
    canDownload,
    canInstall,
    canInstallOnQuit: state.canAutoUpdate && state.status === 'downloaded',
    canOpenRelease,
    primary,
  }
}

/** 状态 → 词典键（弹层与设置区共用）。 */
export function updateStatusKey(state) {
  if (!state) return 'studio.update.status.idle'
  if (state.status === 'error') return 'studio.update.status.error'
  // `up-to-date` 在词典里按驼峰命名（与其它状态统一由 t() 读取）。
  if (state.status === 'up-to-date') return 'studio.update.status.upToDate'
  return `studio.update.status.${state.status}`
}

/** 进度百分比（0..100 整数，用于 aria-valuenow 与宽度）。 */
export function progressPercentOf(state) {
  const percent = Number(state?.progress?.percent)
  if (!Number.isFinite(percent)) return 0
  return Math.round(Math.min(100, Math.max(0, percent)))
}

/** 字节数 → 人类可读（MB 为主，<1MB 显示 KB）。 */
export function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 下载进度文案：`12.3 MB / 45.6 MB · 1.2 MB/s`。
 *
 * @param {object | null} state
 * @returns {string} 无进度时返回空串
 */
export function progressTextOf(state) {
  const progress = state?.progress
  if (!progress || state.status !== 'downloading') return ''
  const parts = [`${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}`]
  if (progress.bytesPerSecond > 0) parts.push(`${formatBytes(progress.bytesPerSecond)}/s`)
  return parts.join(' · ')
}

/** 新版本提示文案（复用旧键，保证已有文案不漂移）。 */
export function updateAvailableText(t, state) {
  if (!state) return ''
  return formatText(t('studio.update.available'), {
    latest: state.latest || '—',
    current: state.current || '—',
  })
}

/** 错误文案：优先按错误码取词典，缺失时回退服务端 message。 */
export function updateErrorText(t, state) {
  if (!state?.error) return ''
  const key = errorMessageKey(state.error.code)
  const text = t(key)
  return text && text !== key ? text : (state.error.message || t('studio.update.error.unknown'))
}

/** 安装被阻止的原因文案。 */
export function installGateText(t, reason) {
  if (!reason) return ''
  const key = installGateMessageKey(reason)
  const text = t(key)
  return text && text !== key ? text : t('studio.update.gate.unknown')
}
