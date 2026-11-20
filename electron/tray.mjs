/**
 * 系统托盘（MIGRATION_SPEC §6.3 / Plan §三.3）。
 *
 * 作用：窗口被关闭但云端 GPU 会话/任务仍在运行时，应用驻留托盘继续保活，
 * 避免用户误关窗口导致 Kaggle/Colab 挂机空烧配额；托盘同时提供只读算力状态
 * 与「彻底退出」入口。
 *
 * 图标不依赖外部资源：内嵌 32×32→64×64 的 base64 PNG（圆角方块 + 白色 A 字），
 * 打包后（asar:false）与开发态都能直接创建 nativeImage；Phase 1 沿用默认应用图标，
 * 待补 build/icon.* 后再替换（见 docs/MIGRATION_NOTES.md 的已知限制）。
 */

import { Menu, Tray, nativeImage } from 'electron'

import { createLogger } from './logger.mjs'

/** 64×64 RGBA PNG：靛蓝→青色渐变圆角方块 + 白色 A 字。 */
const APP_ICON_DATA_URL =
  'data:image/png;base64,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'

/**
 * 会话状态中文只读文案（与 server/session/state.js 的状态机取值对齐）。
 * 说明：服务端字段名是 session.state；这里同时兼容 session.status（规范文档用词），
 * 且把「stopping」计入活跃——关机过程中仍需防误退。
 */
export const SESSION_STATE_LABELS = Object.freeze({
  absent: '未启动',
  idle: '空闲',
  provisioning: '环境准备中',
  connecting: '隧道连接中',
  warming: '模型预热中',
  ready: '就绪',
  stopping: '正在关机',
  error: '启动失败',
  unknown: '未知',
})

/** 视为「云端仍有算力在消耗」的会话状态（与 server/session/state.js 的 ACTIVE_STATES 对齐，并兼容 running）。 */
export const ACTIVE_SESSION_STATES = new Set([
  'provisioning',
  'connecting',
  'warming',
  'ready',
  'stopping',
  'running',
  'starting',
])

/** 归一化会话状态：优先 session.state，其次 session.status，缺省 absent。 */
export function normalizeSessionState(snapshot) {
  const raw = snapshot?.session?.state ?? snapshot?.session?.status ?? 'absent'
  const state = String(raw ?? 'absent').trim().toLowerCase()
  return state || 'absent'
}

/**
 * 判断是否有活跃云端会话或任务（防烧额度判断的唯一入口）。
 *
 * @param {any} snapshot GET /api/state 的响应
 * @returns {boolean}
 */
export function isSessionActive(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false
  if (ACTIVE_SESSION_STATES.has(normalizeSessionState(snapshot))) return true
  const queue = snapshot.queue
  if (queue && typeof queue === 'object') {
    if (queue.running) return true
    const pending = Number(queue.pending)
    if (Number.isFinite(pending) && pending > 0) return true
  }
  // 兜底：部分快照只带 jobs 列表；queued/running/waiting-session 都算活跃。
  const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : []
  return jobs.some((job) => {
    const status = String(job?.status ?? '').toLowerCase()
    return status === 'running' || status === 'queued' || status === 'waiting-session'
  })
}

/**
 * 生成托盘展示用的算力状态文案（中文、只读）。
 *
 * @param {any} snapshot GET /api/state 的响应（可能为 null）
 * @param {{ ok?: boolean } | null} [probe] 最近一次健康探活结果
 */
export function describeComputeStatus(snapshot, probe) {
  const state = normalizeSessionState(snapshot)
  const label = SESSION_STATE_LABELS[state] ?? `未知（${state}）`
  const queue = snapshot?.queue ?? {}
  const running = queue.running ? 1 : 0
  const pendingNumber = Number(queue.pending)
  const pending = Number.isFinite(pendingNumber) && pendingNumber > 0 ? pendingNumber : 0
  let text = `算力状态：${label}`
  if (running > 0 || pending > 0) {
    const parts = []
    if (running > 0) parts.push(`运行 ${running}`)
    if (pending > 0) parts.push(`排队 ${pending}`)
    text += `（${parts.join(' · ')}）`
  }
  const healthy = probe ? probe.ok !== false : true
  if (!healthy) text += '（本地服务连接异常）'
  return {
    state,
    label,
    text,
    running,
    pending,
    healthy,
    active: isSessionActive(snapshot),
  }
}

/** 用内嵌数据 URL 创建应用图标（默认 64×64；托盘需要小尺寸时传 size）。 */
export function createAppIcon(size = 64) {
  const image = nativeImage.createFromDataURL(APP_ICON_DATA_URL)
  if (!size || size === 64) return image
  return image.resize({ width: size, height: size, quality: 'best' })
}

/**
 * 创建托盘并返回控制器。
 *
 * @param {object} options
 * @param {() => any} [options.getSnapshot] 取最近一次 /api/state 快照
 * @param {() => any} [options.getProbe] 取最近一次健康探活结果
 * @param {() => void} [options.onShow] 显示主窗口
 * @param {() => void} [options.onQuit] 彻底退出（走主进程优雅关停）
 * @param {object} [options.logger]
 * @returns {{ refresh: (snapshot?: any, probe?: any) => void, getStatusText: () => string, destroy: () => void } | null}
 */
export function createTray(options = {}) {
  const { getSnapshot, getProbe, onShow, onQuit } = options
  const log = options.logger ?? createLogger('tray')

  let tray
  try {
    // Windows 托盘按 16×16 逻辑尺寸显示；给 16 再让系统按 DPI 缩放，避免图标过大。
    tray = new Tray(createAppIcon(16))
  } catch (error) {
    log.error('创建系统托盘失败（窗口功能不受影响）', error)
    return null
  }

  let lastTooltip = ''
  let lastMenuKey = ''
  let lastStatusText = ''

  const buildMenu = (status) => {
    const template = [
      {
        label: '显示主窗口',
        click: () => {
          try {
            onShow?.()
          } catch (error) {
            log.warn(`托盘「显示主窗口」失败：${error?.message ?? error}`)
          }
        },
      },
      { type: 'separator' },
      { label: status.text, enabled: false },
      { type: 'separator' },
      {
        label: '彻底退出',
        click: () => {
          try {
            log.info('托盘菜单请求彻底退出')
            onQuit?.()
          } catch (error) {
            log.warn(`托盘「彻底退出」失败：${error?.message ?? error}`)
          }
        },
      },
    ]
    return Menu.buildFromTemplate(template)
  }

  const refresh = (snapshot = getSnapshot?.(), probe = getProbe?.()) => {
    const status = describeComputeStatus(snapshot, probe)
    lastStatusText = status.text
    const tooltip = `AIGC Studio — ${status.text}`
    if (tooltip !== lastTooltip) {
      tray.setToolTip(tooltip)
      lastTooltip = tooltip
    }
    // 只有文案变化时才重建菜单，避免每 5 秒无意义的原生对象重建。
    const menuKey = `${status.text}|${status.healthy}`
    if (menuKey !== lastMenuKey) {
      tray.setContextMenu(buildMenu(status))
      lastMenuKey = menuKey
    }
  }

  tray.on('click', () => {
    try {
      onShow?.()
    } catch (error) {
      log.warn(`托盘点击处理失败：${error?.message ?? error}`)
    }
  })
  tray.on('double-click', () => {
    try {
      onShow?.()
    } catch (error) {
      log.warn(`托盘双击处理失败：${error?.message ?? error}`)
    }
  })

  refresh()

  return {
    refresh,
    getStatusText: () => lastStatusText,
    destroy() {
      try {
        if (!tray.isDestroyed()) tray.destroy()
      } catch {
        // ignore
      }
    },
  }
}
