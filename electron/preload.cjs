/**
 * Electron preload（CommonJS —— Electron 对 preload 的硬要求，不能用 ESM）。
 *
 * 通过 contextBridge 暴露白名单 API `window.aigcStudio`（MIGRATION_SPEC §6.4）。
 * 渲染进程开启 sandbox:true + contextIsolation:true + nodeIntegration:false，
 * 这里只转发 ipcRenderer 调用，不向页面泄漏 Node 能力。
 *
 * bootstrap 传递方式（二选一，本项目选 additionalArguments）：
 *   主进程创建 BrowserWindow 时通过 webPreferences.additionalArguments 传入
 *   `--aigc-bootstrap=<base64(JSON)>`；preload 在渲染进程启动期同步解析 process.argv，
 *   因此 `window.aigcStudio.bootstrap` 是普通对象，web/runtime.js 可直接同步读取。
 *   选择它而不是 ipcRenderer.invoke('aigc:bootstrap') 的原因：runtime 的 bootstrap()
 *   是同步函数，若走 invoke 只能暴露 Promise，会污染所有调用点；且服务崩溃重启后
 *   主进程会重建窗口并带上新 Token，argv 方案无需额外握手。
 */

const { contextBridge, ipcRenderer } = require('electron')

const BOOTSTRAP_ARG_PREFIX = '--aigc-bootstrap='
const SERVER_EVENT_CHANNEL = 'aigc:server-event'
const WINDOW_STATE_CHANNEL = 'aigc:window-state'
const EMPTY_BOOTSTRAP = Object.freeze({ apiBaseUrl: '', authToken: '' })

/** 把 base64 字符串解码成 UTF-8 文本；sandbox preload 里至少 atob + TextDecoder 可用。 */
function decodeBase64Utf8(encoded) {
  const binary = atob(encoded)
  if (typeof TextDecoder === 'function') {
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new TextDecoder().decode(bytes)
  }
  return decodeURIComponent(escape(binary))
}

/** 从 process.argv 解析主进程注入的 bootstrap；缺失或损坏时回退空值（web/runtime.js 会兜底）。 */
function readBootstrap() {
  try {
    const argv = Array.isArray(process.argv) ? process.argv : []
    const raw = argv.find(
      (value) => typeof value === 'string' && value.startsWith(BOOTSTRAP_ARG_PREFIX),
    )
    if (!raw) return { ...EMPTY_BOOTSTRAP }
    const parsed = JSON.parse(decodeBase64Utf8(raw.slice(BOOTSTRAP_ARG_PREFIX.length)))
    const apiBaseUrl = typeof parsed?.apiBaseUrl === 'string' ? parsed.apiBaseUrl : ''
    const authToken = typeof parsed?.authToken === 'string' ? parsed.authToken : ''
    if (!apiBaseUrl && !authToken) return { ...EMPTY_BOOTSTRAP }
    return { apiBaseUrl, authToken }
  } catch (error) {
    console.error('[aigcStudio] 解析 bootstrap 失败，回退空值', error)
    return { ...EMPTY_BOOTSTRAP }
  }
}

const api = {
  platform: process.platform,
  isElectron: true,
  bootstrap: readBootstrap(),

  /** 打开系统目录选择框；返回选中目录的绝对路径，取消时返回 null。 */
  pickDirectory() {
    return ipcRenderer.invoke('aigc:pick-directory')
  },

  /** 在系统文件管理器中定位文件（只接受字符串，主进程侧还会再校验）。 */
  showItemInFolder(path) {
    if (typeof path !== 'string' || !path.trim()) return
    ipcRenderer.send('aigc:show-item-in-folder', path)
  },

  /** 用默认浏览器打开链接（主进程只允许 http/https）。 */
  openExternal(url) {
    return ipcRenderer.invoke('aigc:open-external', String(url ?? ''))
  },

  /** 桌面通知（标题/正文都会在主进程截断校验）。 */
  notify(title, body) {
    ipcRenderer.send('aigc:notify', { title: String(title ?? ''), body: String(body ?? '') })
  },

  /** 任务栏/托盘角标；传空串表示清除。 */
  setBadge(text) {
    ipcRenderer.send('aigc:set-badge', text === undefined || text === null ? '' : String(text))
  },

  /** 请求退出应用（托盘「彻底退出」同一条路径：强制关停本地服务后退出）。 */
  quitApp() {
    ipcRenderer.send('aigc:quit-app')
  },

  /** 隐藏窗口到托盘（等价于点窗口 × 且云端会话活跃时的效果）。 */
  minimizeToTray() {
    ipcRenderer.send('aigc:minimize-to-tray')
  },

  /**
   * 自绘窗口按钮（无边框窗口）：最小化 / 最大化切换 / 关闭。
   *
   * 关闭走 BrowserWindow.close()，主进程仍会在云端会话 / 任务活跃时拦截并隐藏到托盘，
   * 自绘按钮不会绕过这层保护。浏览器直连态没有这个对象，界面按能力探测后不渲染按钮。
   */
  windowControls: {
    minimize() {
      ipcRenderer.send('aigc:window-minimize')
    },

    /** @returns {Promise<{ maximized: boolean, fullscreen: boolean }>} 切换后的窗口状态 */
    toggleMaximize() {
      return ipcRenderer.invoke('aigc:window-toggle-maximize')
    },

    close() {
      ipcRenderer.send('aigc:window-close')
    },

    /** @returns {Promise<{ maximized: boolean, fullscreen: boolean, focused: boolean }>} */
    getState() {
      return ipcRenderer.invoke('aigc:window-state')
    },

    /**
     * 订阅窗口状态（最大化 / 全屏 / 焦点）。
     *
     * @param {(state: { maximized: boolean, fullscreen: boolean, focused: boolean }) => void} callback
     * @returns {() => void} 取消订阅函数
     */
    onStateChange(callback) {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, payload) => {
        try {
          callback(payload)
        } catch (error) {
          console.error('[aigcStudio] onStateChange 回调抛错', error)
        }
      }
      ipcRenderer.on(WINDOW_STATE_CHANNEL, listener)
      return () => {
        ipcRenderer.removeListener(WINDOW_STATE_CHANNEL, listener)
      }
    },
  },

  /**
   * 订阅壳层推送的服务事件（{ type: 'ready'|'restarting'|'crashed'|'stopped'|... }）。
   *
   * @param {(event: object) => void} callback
   * @returns {() => void} 取消订阅函数
   */
  onServerEvent(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, payload) => {
      try {
        callback(payload)
      } catch (error) {
        console.error('[aigcStudio] onServerEvent 回调抛错', error)
      }
    }
    ipcRenderer.on(SERVER_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(SERVER_EVENT_CHANNEL, listener)
    }
  },
}

contextBridge.exposeInMainWorld('aigcStudio', api)
