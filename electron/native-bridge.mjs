/**
 * 原生能力桥（主进程侧 IPC handler）。
 *
 * 与 electron/preload.cjs 一一对应：渲染进程只能通过 preload 暴露的白名单 API 触发这里，
 * 所有入参都在主进程侧重新校验（路径/URL/文本长度），不信任渲染进程传入的内容。
 *
 * 覆盖：选目录（dialog）、在文件管理器中显示、打开外部链接（仅 http/https）、
 *       桌面通知、任务栏角标、退出应用、最小化到托盘、自绘窗口按钮（最小化/最大化/关闭）。
 */

import { app, dialog, ipcMain, nativeImage, Notification, shell } from 'electron'

import { createLogger } from './logger.mjs'

/** Windows 任务栏角标用的 16×16 圆点（内嵌 base64，不依赖外部图标资源）。 */
const BADGE_DOT_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAY0lEQVR42mN47+LCQAnGJ2n13sUlEYqtSDEApOH2exeX/2j4NlQOrwGdWDSi405cBiQSoRmGE7EZcJsEA26jG2BFgmYYtkI2IJEMAxKpagDFXqA4EKkSjRQnJKokZapkJpIwAHk/93wIuQXeAAAAAElFTkSuQmCC'

const MAX_TITLE_CHARS = 120
const MAX_BODY_CHARS = 400
const MAX_PATH_CHARS = 4096
const MAX_BADGE_CHARS = 16

/** 去控制字符 + 去首尾空白 + 截断。 */
function sanitizeText(value, maxChars) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxChars)
}

/** 仅允许 http/https，防止 file://、javascript: 等危险协议。 */
export function isSafeExternalUrl(value) {
  try {
    const url = new URL(String(value ?? ''))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 弹一条系统桌面通知（主进程自身也用它提示「最小化到托盘」「服务异常」等事件）。
 *
 * @param {{ title?: string, body?: string, logger?: object }} [options]
 * @returns {boolean} 是否成功发出
 */
export function showDesktopNotification(options = {}) {
  const { logger } = options
  const log = logger ?? createLogger('notification')
  const title = sanitizeText(options.title, MAX_TITLE_CHARS) || 'AIGC Studio'
  const body = sanitizeText(options.body, MAX_BODY_CHARS)
  if (!Notification.isSupported()) {
    log.warn('当前系统不支持桌面通知，跳过通知')
    return false
  }
  try {
    new Notification({ title, body }).show()
    log.info(`桌面通知：${title}${body ? ` / ${body}` : ''}`)
    return true
  } catch (error) {
    log.warn(`桌面通知发送失败：${error?.message ?? error}`)
    return false
  }
}

/** 设置任务栏角标：macOS/Linux 用 setBadgeCount，Windows 用窗口 overlay 圆点。 */
function applyBadge(rawText, window, log) {
  const text = sanitizeText(rawText, MAX_BADGE_CHARS)
  const parsed = Number.parseInt(text, 10)
  const count = Number.isFinite(parsed) && parsed > 0 ? parsed : text ? 1 : 0
  try {
    // Windows 上该 API 不受支持（返回 false），因此下面还有 overlay 兜底。
    app.setBadgeCount(count)
  } catch (error) {
    log.debug(`setBadgeCount 不可用：${error?.message ?? error}`)
  }
  if (process.platform !== 'win32') return
  try {
    if (!window || window.isDestroyed()) return
    if (!text) {
      window.setOverlayIcon(null, '')
      return
    }
    window.setOverlayIcon(nativeImage.createFromDataURL(BADGE_DOT_DATA_URL), text || '有未读任务')
  } catch (error) {
    log.warn(`设置任务栏角标失败：${error?.message ?? error}`)
  }
}

/**
 * 注册全部原生桥 IPC。
 *
 * @param {object} options
 * @param {() => import('electron').BrowserWindow | null} options.getMainWindow 取当前主窗口
 * @param {() => void} [options.onQuitRequest] 渲染进程请求退出（走主进程优雅关停）
 * @param {() => void} [options.onMinimizeToTray] 渲染进程请求最小化到托盘
 * @param {object} [options.logger]
 * @returns {{ dispose: () => void }}
 */
export function registerNativeBridge(options = {}) {
  const { getMainWindow, onQuitRequest, onMinimizeToTray } = options
  const log = options.logger ?? createLogger('native-bridge')
  const disposers = []

  const listen = (channel, handler) => {
    ipcMain.on(channel, handler)
    disposers.push(() => ipcMain.removeListener(channel, handler))
  }
  const handle = (channel, handler) => {
    ipcMain.handle(channel, handler)
    disposers.push(() => ipcMain.removeHandler(channel))
  }
  const resolveWindow = () => {
    const window = getMainWindow?.()
    return window && !window.isDestroyed() ? window : null
  }

  /**
   * 取“发出请求的那个窗口”：渲染进程只能操作承载自己的窗口，
   * 避免将来多窗口时一个页面把另一个窗口最小化或关掉。
   */
  const senderWindow = (event) => {
    const window = resolveWindow()
    if (!window) return null
    const sender = event?.sender
    if (sender && sender !== window.webContents) return null
    return window
  }

  // ── 自绘窗口按钮（无边框窗口）──────────────────────────────────────
  // 关闭必须走 BrowserWindow.close()：主进程的 onWindowClose 会在云端会话仍活跃时
  // 拦截并最小化到托盘，自绘按钮不能绕过这层「防烧额度」保护。
  listen('aigc:window-minimize', (event) => {
    senderWindow(event)?.minimize()
  })

  handle('aigc:window-toggle-maximize', (event) => {
    const window = senderWindow(event)
    if (!window) return { maximized: false, fullscreen: false }
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return { maximized: window.isMaximized(), fullscreen: window.isFullScreen() }
  })

  listen('aigc:window-close', (event) => {
    senderWindow(event)?.close()
  })

  handle('aigc:window-state', (event) => {
    const window = senderWindow(event)
    if (!window) return { maximized: false, fullscreen: false, focused: false }
    return {
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
      focused: window.isFocused(),
    }
  })

  // 切换工作区：系统目录选择框（允许新建目录）。
  handle('aigc:pick-directory', async () => {
    const parent = resolveWindow()
    const dialogOptions = {
      title: '选择工作区目录',
      buttonLabel: '选择此目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    try {
      const result = parent
        ? await dialog.showOpenDialog(parent, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
        return null
      }
      const picked = result.filePaths[0]
      log.info(`用户选择工作区目录：${picked}`)
      return picked
    } catch (error) {
      log.error('打开目录选择框失败', error)
      return null
    }
  })

  // 在系统文件管理器中定位产物文件。
  listen('aigc:show-item-in-folder', (_event, rawPath) => {
    const target = sanitizeText(rawPath, MAX_PATH_CHARS)
    if (!target) return
    try {
      shell.showItemInFolder(target)
    } catch (error) {
      log.warn(`在文件管理器中显示失败：${error?.message ?? error}`)
    }
  })

  // 外部链接：只放行 http/https。
  handle('aigc:open-external', async (_event, rawUrl) => {
    if (!isSafeExternalUrl(rawUrl)) {
      log.warn(`拒绝打开非 http(s) 链接：${sanitizeText(rawUrl, 200)}`)
      return false
    }
    try {
      await shell.openExternal(String(rawUrl))
      return true
    } catch (error) {
      log.warn(`打开外部链接失败：${error?.message ?? error}`)
      return false
    }
  })

  listen('aigc:notify', (_event, payload) => {
    showDesktopNotification({
      title: payload?.title,
      body: payload?.body,
      logger: log,
    })
  })

  listen('aigc:set-badge', (_event, rawText) => {
    applyBadge(rawText, resolveWindow(), log)
  })

  listen('aigc:quit-app', () => {
    log.info('渲染进程请求退出应用')
    if (typeof onQuitRequest === 'function') onQuitRequest()
  })

  listen('aigc:minimize-to-tray', () => {
    if (typeof onMinimizeToTray === 'function') {
      onMinimizeToTray()
      return
    }
    const window = resolveWindow()
    if (window) window.hide()
  })

  log.info('原生桥 IPC 已注册')
  return {
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // ignore
        }
      }
    },
  }
}
