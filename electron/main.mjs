/**
 * Electron 主进程入口（MIGRATION_SPEC §6.1/§6.2/§6.3）。
 *
 * 职责：
 *  1. 单实例锁：第二个实例只聚焦已有窗口；
 *  2. 生成随机 Token 与端口，经环境变量拉起本地服务子进程（electron/server-host.mjs），
 *     解析 stdout 的 ready 行后才创建窗口；
 *  3. BrowserWindow（contextIsolation + sandbox + 无 nodeIntegration）加载 Vite 开发服务器
 *     （开发态）或本地服务托管的 dist/web（生产态）；
 *  4. 崩溃重启：服务异常退出时最多自动重启 3 次（间隔 1s/3s/6s），重启后 Token 更新并重建窗口；
 *  5. 防烧额度：窗口 close 时若云端会话/任务仍活跃，则隐藏到托盘并通知；托盘「彻底退出」强制退出；
 *  6. before-quit 优雅关停本地服务（最多等 10 秒，超时强杀）；
 *  7. 无人值守自检（CI 用）：AIGC_STUDIO_SMOKE_CAPTURE=<png 路径> 时，窗口加载完成后截图、
 *     打印 `SMOKE_OK {url,title,capturePath}` 并正常退出；失败打印 `SMOKE_FAIL <reason>` 并 exit 1。
 *     AIGC_STUDIO_SMOKE_REQUIRE_IMAGE=1 时还要求页面至少有一张成功解码的产物图（`<img>` complete
 *     且 naturalWidth>0），用于「有图工作区」冒烟，防止图片鉴权/URL 回归后空工作区仍然绿灯。
 *  8. 主进程给发往本地服务的请求自动补 Bearer Token（见 installLocalAuthHeaderInjection），
 *     作为 `<img>` 无法自带请求头时的兜底；主通道是服务端下发的同源 HttpOnly Session Cookie。
 *
 * 注意：本进程必须由真正的 Electron 二进制启动。若宿主环境全局设置了 ELECTRON_RUN_AS_NODE=1，
 * Electron 会退化为纯 Node 运行而不创建窗口；tools/dev.mjs 在 spawn 前已显式删除该变量，
 * 手工执行 `npx electron .` 时需先清掉它（PowerShell: `$env:ELECTRON_RUN_AS_NODE=$null`）。
 *
 * bootstrap 传递：通过 webPreferences.additionalArguments 传入
 * `--aigc-bootstrap=<base64 JSON>`，由 preload 同步解析（详见 electron/preload.cjs 头部说明）。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell } from 'electron'

import { createLogger, initShellLogger } from './logger.mjs'
import { registerNativeBridge, showDesktopNotification } from './native-bridge.mjs'
import { ServerHost } from './server-host.mjs'
import { createAppIcon, createTray, isSessionActive } from './tray.mjs'
import { UPDATER_CHANNELS, createUpdater } from './updater.mjs'
import { resolveInstallForm } from './updater/policy.mjs'
import { detectPreferredLang, normalizeUiLang } from '../shared/locale.js'
import { classifyUpdateError, normalizeUpdateState } from '../shared/update-state.js'
import { resolveShellLang, shellText } from './i18n.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** 仓库根目录（开发态）；打包后 app.getAppPath() 才是 resources/app。 */
const APP_ROOT = dirname(__dirname)

const IS_DEV = !app.isPackaged
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173'
const MAX_SERVER_RESTARTS = 3
/** 第 1/2/3 次重启的延迟（MIGRATION_SPEC §6.1：间隔递增）。 */
const RESTART_DELAYS_MS = [1_000, 3_000, 6_000]
const STATE_POLL_INTERVAL_MS = 5_000
const STATE_POLL_TIMEOUT_MS = 2_500
const SHUTDOWN_TIMEOUT_MS = 10_000
/** 服务稳定运行多久后清零重启计数（避免偶发早退耗尽 3 次配额）。 */
const RESTART_COUNTER_RESET_MS = 60_000

/**
 * 无人值守自检模式（CI/集成验收用）：
 *   AIGC_STUDIO_SMOKE_CAPTURE=<png 绝对路径>  截图后打印 `SMOKE_OK {url,title,capturePath}` 并退出
 *   AIGC_STUDIO_SMOKE_TIMEOUT_MS=<毫秒>       整体超时，默认 60000
 *   AIGC_STUDIO_SMOKE_REQUIRE_IMAGE=1         要求页面至少有一张 `complete && naturalWidth>0` 的图片
 *                                             （有图工作区冒烟用，防「空工作区绿灯、有图就裂」盲区）
 * 该模式不绕过任何启动环节：同样生成 Token/端口、spawn 本地服务、等待 ready、创建窗口加载页面。
 */
const SMOKE_CAPTURE_PATH = normalizeSmokePath(process.env.AIGC_STUDIO_SMOKE_CAPTURE)
const SMOKE_MODE = Boolean(SMOKE_CAPTURE_PATH)
const SMOKE_TIMEOUT_MS = readPositiveInt(process.env.AIGC_STUDIO_SMOKE_TIMEOUT_MS, 60_000)
const SMOKE_REQUIRE_IMAGE = /^(1|true|yes|on)$/i.test(String(process.env.AIGC_STUDIO_SMOKE_REQUIRE_IMAGE ?? '').trim())
/** 页面 did-finish-load 后等待多久再截图：覆盖首轮 /api/state 轮询与服务注入完成。 */
const SMOKE_SETTLE_MS = 2_500

const logger = createLogger('main')
const serverLogger = createLogger('server-host')

let mainWindow = null
let tray = null
let nativeBridge = null
let serverHost = null
/** 当前窗口应使用的 bootstrap（服务重启后会更新）。 */
let currentBootstrap = { apiBaseUrl: '', authToken: '' }
let latestState = null
let latestProbe = null
let statePollTimer = null
let restartTimer = null
let stableTimer = null
let restartAttempts = 0
let forceQuit = false
let quitting = false
let shutdownComplete = false
let closeConfirmOpen = false
/** 重建窗口期间抑制 window-all-closed：destroy 旧窗口到新窗口就绪之间会出现「零窗口」瞬间。 */
let suppressWindowAllClosed = 0
/** 服务自动重启期间抑制 window-all-closed，避免重启流程被误判为「用户关闭了所有窗口」。 */
let serverRestarting = false
/**
 * 窗口加载模式：'dev-server'（Vite 开发服务器）或 'production'（本地服务托管的 dist/web）。
 * 由 detectLoadMode() 在启动时决定，同时影响 bootstrap.apiBaseUrl 与站内导航判定。
 */
let loadMode = 'production'
let activeDevServerUrl = DEV_SERVER_URL
/** 自检模式状态（避免重复截图/重复输出）。 */
let smokeFinished = false
let smokeTimer = null
/** 应用内更新（M2.8 阶段 B）：运行形态、更新器实例与「安装待执行」标志。 */
let updatePolicy = null
let updater = null
let pendingInstall = false
/** 壳层界面语言（托盘、原生弹窗、通知）：启动时按系统区域初始化，随后同步服务端与用户设置。 */
let shellLang = 'zh'

process.on('uncaughtException', (error) => {
  logger.error('未捕获异常', error)
  if (SMOKE_MODE && !smokeFinished) smokeFail(`uncaught-exception ${error?.message ?? error}`)
})
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', reason)
  if (SMOKE_MODE && !smokeFinished) smokeFail(`unhandled-rejection ${reason?.message ?? reason}`)
})

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  logger.warn('检测到已有 AIGC Studio 实例在运行，本次启动直接退出')
  if (SMOKE_MODE) smokeFail('another-instance-running')
  app.quit()
} else {
  app.on('second-instance', () => {
    logger.info('收到第二个实例启动请求，聚焦已有窗口')
    showMainWindow(true)
  })
  app.on('activate', () => {
    // macOS：点击 Dock 图标时恢复窗口。
    if (BrowserWindow.getAllWindows().length === 0) {
      recreateMainWindow({ showOnReady: true })
      return
    }
    showMainWindow(true)
  })
  app.on('window-all-closed', onWindowAllClosed)
  app.on('before-quit', onBeforeQuit)
  app
    .whenReady()
    .then(startApp)
    .catch((error) => failStart(error))
}

// ── 启动 ──────────────────────────────────────────────────────────────────

async function startApp() {
  app.setAppUserModelId('com.nanxfu.aigcstudio')
  shellLang = detectPreferredLang({ locale: safeAppLocale(), env: process.env })
  const dataDir = resolveDataDir()
  initShellLogger({ dataDir })
  const mode = detectLoadMode()
  loadMode = mode.mode
  activeDevServerUrl = mode.url ?? DEV_SERVER_URL
  // 更新形态必须先于本地服务启动判定：NSIS 安装态要把「主进程独占更新」告诉服务端。
  updatePolicy = resolveInstallForm({
    isPackaged: app.isPackaged,
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
  })
  logger.info(
    `AIGC Studio 启动（dev=${IS_DEV} loadMode=${loadMode} appPath=${safeAppPath()} dataDir=${dataDir} ` +
      `updateForm=${updatePolicy.form} canAutoUpdate=${updatePolicy.canAutoUpdate} log=${logger.filePath() || '(未启用文件日志)'}）`,
  )
  if (SMOKE_MODE) {
    logger.info(`自检模式已启用：截图=${SMOKE_CAPTURE_PATH} 超时=${SMOKE_TIMEOUT_MS}ms`)
    smokeTimer = setTimeout(() => smokeFail(`timeout ${SMOKE_TIMEOUT_MS}ms`), SMOKE_TIMEOUT_MS)
    smokeTimer.unref?.()
  }

  // 1) 拉起本地服务并等待 ready 行
  const ready = await bootServer()
  currentBootstrap = buildBootstrap(ready)
  logger.info(`bootstrap 已生成 apiBaseUrl=${currentBootstrap.apiBaseUrl || '(相对路径)'}`)

  // 2) 渲染进程请求补充鉴权头（兜底 <img> 等无法自带 Header 的资源读取；须在建窗口前注册）
  installLocalAuthHeaderInjection()

  // 2.5) 应用内更新：创建更新器并注册 IPC（首次检查延迟 10 秒，不阻塞窗口）
  await initUpdater()

  // 3) 原生桥 + 主窗口 + 托盘
  nativeBridge = registerNativeBridge({
    getMainWindow: () => mainWindow,
    getLang: () => shellLang,
    onSetLocale: (lang) => syncShellLanguage(lang),
    onQuitRequest: () => requestQuit('渲染进程请求退出'),
    onMinimizeToTray: () => hideToTray('渲染进程请求最小化到托盘'),
    logger: createLogger('native-bridge'),
  })
  if (!IS_DEV) {
    // 生产态隐藏默认菜单栏（开发态保留，便于用快捷键打开 DevTools）。
    Menu.setApplicationMenu(null)
  }
  createMainWindow()
  ensureTray()

  // 3) 首次状态 + 定时轮询（供托盘文案与防烧额度判断）
  await refreshShellLanguageFromServer()
  await refreshServerState()
  startStatePolling()
  logger.info('启动完成')
}

/**
 * 决定窗口加载方式：
 *  - 打包后：production（本地服务托管 dist/web）；
 *  - 未打包且显式设置 VITE_DEV_SERVER_URL：dev-server（npm run dev 走这条）；
 *  - 未打包且 dist/web/index.html 存在：production（便于无 Vite、直接 `npx electron .` 自检）；
 *  - 否则回退 dev-server（默认 5173，期望开发者已启动 Vite）。
 */
function detectLoadMode() {
  if (app.isPackaged) return { mode: 'production' }
  const explicit = process.env.VITE_DEV_SERVER_URL
  if (typeof explicit === 'string' && explicit.trim()) {
    return { mode: 'dev-server', url: explicit.trim() }
  }
  try {
    if (existsSync(join(resolveWebDist(), 'index.html'))) return { mode: 'production' }
  } catch {
    // ignore
  }
  return { mode: 'dev-server', url: DEV_SERVER_URL }
}

/** 前端静态产物目录：AIGC_STUDIO_WEB_DIST 覆盖，否则 <appPath>/dist/web。 */
function resolveWebDist() {
  const override = process.env.AIGC_STUDIO_WEB_DIST
  if (typeof override === 'string' && override.trim()) return resolvePath(override.trim())
  return join(safeAppPath(), 'dist', 'web')
}

/** 应用全局数据目录：AIGC_STUDIO_DATA_DIR 覆盖，否则 Electron 默认 userData（%APPDATA%\aigc-studio）。 */
function resolveDataDir() {
  const override = process.env.AIGC_STUDIO_DATA_DIR
  if (typeof override === 'string' && override.trim()) return resolvePath(override.trim())
  try {
    return app.getPath('userData')
  } catch {
    return join(APP_ROOT, '.aigc-studio-data')
  }
}

function safeAppPath() {
  try {
    return app.getAppPath()
  } catch {
    return APP_ROOT
  }
}

function safeAppLocale() {
  try {
    return app.getLocale() || ''
  } catch {
    return ''
  }
}

function syncShellLanguage(lang) {
  const normalized = normalizeUiLang(lang)
  if (!normalized || normalized === shellLang) return
  shellLang = normalized
  updateTray()
}

async function refreshShellLanguageFromServer() {
  const host = serverHost
  if (!host?.isReady()) return
  try {
    const payload = await host.request('/api/app-settings', { timeoutMs: STATE_POLL_TIMEOUT_MS })
    const serverLang = payload?.settings?.ui?.lang
    if (serverLang) syncShellLanguage(serverLang)
  } catch {
    // 服务尚未就绪或版本不匹配时保持初始探测语言
  }
}

/** 定位 server/standalone.js：支持 AIGC_STUDIO_SERVER_ENTRY 覆盖（离线冒烟/排障用）。 */
function resolveServerEntry() {
  const override = process.env.AIGC_STUDIO_SERVER_ENTRY
  if (typeof override === 'string' && override.trim()) {
    const value = override.trim()
    const resolved = isAbsolute(value) ? value : resolvePath(process.cwd(), value)
    logger.info(`使用 AIGC_STUDIO_SERVER_ENTRY 指定的服务入口：${resolved}`)
    return resolved
  }
  const candidates = []
  try {
    candidates.push(join(app.getAppPath(), 'server', 'standalone.js'))
  } catch {
    // ignore
  }
  candidates.push(join(APP_ROOT, 'server', 'standalone.js'))
  if (app.isPackaged) {
    // asar:false 时打包产物就在 resources/app 下，这里作为兜底候选。
    candidates.push(join(process.resourcesPath, 'app', 'server', 'standalone.js'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`找不到本地服务入口 server/standalone.js（已尝试：${candidates.join('、')}）`)
}

/**
 * 解析服务 Token：
 *  - 环境变量显式指定时优先且保持稳定（开发态 Vite 代理与主进程必须用同一个 Token；
 *    服务重启也沿用，避免代理鉴权失效）；
 *  - 否则每次启动/重启都生成新的 32 字节随机 hex（生产态安全默认）。
 */
function resolveServerToken() {
  const fromEnv = process.env.AIGC_STUDIO_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return randomBytes(32).toString('hex')
}

/** 环境变量里的端口：undefined 表示未指定（生产态随机）；0 表示让服务自己挑随机端口。 */
function readEnvPort() {
  const raw = process.env.AIGC_STUDIO_PORT
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const value = Number(String(raw).trim())
  if (!Number.isInteger(value) || value < 0 || value > 65535) return null
  return value
}

/** 探测一个空闲端口（仅生产态使用；开发态固定端口，避免 Vite 代理指向失效）。 */
function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = address && typeof address === 'object' ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

async function planServerPorts() {
  const envPort = readEnvPort()
  if (envPort !== null) return [envPort]
  try {
    const free = await findFreePort()
    if (free > 0) return [free, 0]
  } catch (error) {
    logger.warn('探测空闲端口失败，改由服务随机绑定', error)
  }
  return [0]
}

/**
 * 借助系统钥匙串 / DPAPI（Electron safeStorage）初始化或解封本地凭据主密钥。
 * 供子进程以 AES-256-GCM 加密存放 `credentials/llm.json`，避免 Windows 下明文落盘。
 */
let cachedCredentialKey = null
function resolveCredentialKey(dataDir) {
  if (cachedCredentialKey !== null) return cachedCredentialKey
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      cachedCredentialKey = ''
      return ''
    }
    const credDir = join(dataDir, 'credentials')
    const keyFile = join(credDir, 'master.safe')
    if (existsSync(keyFile)) {
      const decrypted = safeStorage.decryptString(readFileSync(keyFile))
      if (/^[0-9a-f]{64}$/i.test(decrypted)) {
        cachedCredentialKey = decrypted
        return decrypted
      }
    }
    const fresh = randomBytes(32).toString('hex')
    mkdirSync(credDir, { recursive: true })
    writeFileSync(keyFile, safeStorage.encryptString(fresh))
    cachedCredentialKey = fresh
    return fresh
  } catch (error) {
    logger.warn(`safeStorage 主密钥初始化失败，退回 0600 文件存储：${error?.message ?? error}`)
    cachedCredentialKey = ''
    return ''
  }
}

/** 组装服务子进程环境变量（§2.1）。 */
function buildServerEnv({ port, token }) {
  const dataDir = resolveDataDir()
  const credentialKey = resolveCredentialKey(dataDir)
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    AIGC_STUDIO_PORT: String(port),
    AIGC_STUDIO_TOKEN: token,
    AIGC_STUDIO_DATA_DIR: dataDir,
    AIGC_STUDIO_WEB_DIST: resolveWebDist(),
    ...(app.isPackaged ? { AIGC_STUDIO_BUNDLED_SD_DIR: join(process.resourcesPath, 'local-gpu') } : {}),
    // 开发态（Vite 5173 页面）放宽 Origin 校验，排障时渲染进程可能直连本地服务。
    AIGC_STUDIO_DEV: process.env.AIGC_STUDIO_DEV ?? (loadMode === 'dev-server' ? '1' : '0'),
    // NSIS 安装态：更新由主进程 electron-updater 独占，服务端只读检查器不再发请求。
    ...(updatePolicy?.canAutoUpdate ? { AIGC_STUDIO_UPDATE_OWNER: 'electron' } : {}),
    ...(credentialKey ? { AIGC_STUDIO_CREDENTIAL_KEY: credentialKey } : {}),
    ...(safeAppLocale() ? { AIGC_STUDIO_LOCALE: safeAppLocale() } : {}),
  }
  // 首次启动的默认工作区：只在调用方显式指定时透传，其余交给服务的 <userData>/workspace 兜底。
  const workspace = process.env.AIGC_STUDIO_WORKSPACE
  if (typeof workspace === 'string' && workspace.trim()) {
    env.AIGC_STUDIO_WORKSPACE = resolvePath(workspace.trim())
  }
  return env
}

/** 启动（或重启）本地服务；生产态端口被占时自动回退到随机端口。 */
async function bootServer() {
  const serverEntry = resolveServerEntry()
  const ports = await planServerPorts()
  let lastError = null
  for (let index = 0; index < ports.length; index += 1) {
    const port = ports[index]
    const token = resolveServerToken()
    const serverEnv = buildServerEnv({ port, token })
    logger.info(
      `拉起本地服务：port=${port === 0 ? '随机' : port} dev=${serverEnv.AIGC_STUDIO_DEV} webDist=${serverEnv.AIGC_STUDIO_WEB_DIST} tokenLength=${token.length}`,
    )
    const host = new ServerHost({
      serverEntry,
      cwd: safeAppPath(),
      env: serverEnv,
      logger: serverLogger,
    })
    host.onEvent((event) => handleServerEvent(event))
    try {
      const ready = await host.start()
      serverHost = host
      return ready
    } catch (error) {
      lastError = error
      logger.warn(`本地服务启动失败（端口=${port === 0 ? '随机' : port}）：${error.message}`)
      host.removeAllListeners()
      await host.dispose().catch(() => {})
    }
  }
  throw lastError ?? new Error('本地服务启动失败')
}

/**
 * 服务事件统一入口：推送到渲染进程、维护状态缓存、处理异常退出重启。
 */
function handleServerEvent(event) {
  broadcastServerEvent(event)
  if (event.type === 'ready') {
    scheduleRestartCounterReset()
    return
  }
  if (event.type === 'crashed') {
    // 服务已死：清空状态缓存，避免「窗口关闭被拦截」误判。
    latestState = null
    latestProbe = null
    updateTray()
    scheduleServerRestart(event)
  }
}

/** 生成窗口/bootstrap 使用的地址与 Token。 */
function buildBootstrap(ready) {
  return {
    // dev-server：渲染进程由 Vite 托管，apiBaseUrl 留空走相对路径 → Vite 代理 /api（避免跨源 CORS，
    // 本地服务按规范不实现 CORS）。production：窗口与 API 同源，直接用服务 origin。
    apiBaseUrl: loadMode === 'dev-server' ? '' : ready.origin,
    authToken: ready.token,
  }
}

/** 把 bootstrap 编码进 additionalArguments（base64 JSON，避免空格/转义问题）。 */
function encodeBootstrapArg(bootstrap) {
  const json = JSON.stringify({
    apiBaseUrl: bootstrap?.apiBaseUrl ?? '',
    authToken: bootstrap?.authToken ?? '',
  })
  return `--aigc-bootstrap=${Buffer.from(json, 'utf8').toString('base64')}`
}

/**
 * 给渲染进程发往**本地服务**的请求自动补 Bearer Token（主进程侧兜底）。
 *
 * 为什么需要：`<img src="/api/file?...">` 这类被浏览器接管的资源请求无法由 JS 附加
 * Authorization 头。服务端已支持同源 HttpOnly Session Cookie（主通道），这里按窗口会话
 * 再补一层兜底：即使 Cookie 因分区/隐私设置/将来换协议的缘故不可用，图片与媒体读取也能通过。
 *
 * 安全边界：
 *  - 只对 `currentBootstrap.apiBaseUrl`（当前服务 origin）下的请求注入，绝不外发给其它端口或外部站点；
 *  - 已存在的 Authorization（例如 web 层 fetch 自己带的）不覆盖；
 *  - 每次请求都读最新的 `currentBootstrap`，服务重启换 Token 后自动生效（只注册一次监听）。
 */
function installLocalAuthHeaderInjection() {
  try {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders }
      const base = String(currentBootstrap.apiBaseUrl || '').replace(/\/+$/, '')
      const token = currentBootstrap.authToken
      if (!base || !token || !String(details.url || '').startsWith(`${base}/`)) {
        callback({ requestHeaders: headers })
        return
      }
      const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
      if (!hasAuthorization) headers.authorization = `Bearer ${token}`
      callback({ requestHeaders: headers })
    })
    logger.info('已注册本地请求鉴权头注入（仅当前服务 origin）')
  } catch (error) {
    // 注入失败不影响 Cookie 主通道，只记录日志。
    logger.warn(`注册本地请求鉴权头注入失败：${error?.message ?? error}`)
  }
}

// ── 窗口 ──────────────────────────────────────────────────────────────────

/** 生产态加载地址：服务 origin + '/'；开发态加载 Vite 开发服务器。 */
function resolveWindowTarget() {
  if (loadMode === 'dev-server') return activeDevServerUrl
  if (currentBootstrap.apiBaseUrl) return `${currentBootstrap.apiBaseUrl}/`
  const origin = serverHost?.ready()?.origin
  if (origin) return `${origin}/`
  return 'about:blank'
}

function createMainWindow(options = {}) {
  const { bounds = null, maximized = false, showOnReady = true } = options
  // 无边框窗口：系统标题栏与窗口按钮全部由渲染层自绘（web/studio/WindowControls.jsx），
  // 顶栏即标题栏（CSS -webkit-app-region）。macOS 没有右侧窗口按钮，改用 hiddenInset
  // 保留左上角交通灯，渲染层按平台让出左侧空间并不再重复画一套按钮。
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'AIGC Studio',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    icon: createAppIcon(),
    // 交通灯垂直对齐 58px 顶栏的中心（tab 区 18px 外壳留白 + 29px 半高 - 8px 半高）。
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 38 } }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // bootstrap 经 argv 同步传给 preload（见文件头说明）。
      additionalArguments: [encodeBootstrapArg(currentBootstrap)],
    },
  })
  if (bounds) {
    try {
      win.setBounds(bounds)
    } catch {
      // 屏幕变化导致越界时忽略，使用默认尺寸
    }
  }

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    if (showOnReady) win.show()
    if (maximized) win.maximize()
  })

  // 窗口状态广播：最大化 / 全屏 / 焦点变化后，自绘按钮要立刻在「最大化 ↔ 还原」之间切换。
  // 双击拖动条最大化由 Chromium 直接处理，这里同样能收到 maximize 事件。
  const sendWindowState = () => {
    if (win.isDestroyed()) return
    win.webContents.send('aigc:window-state', {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      focused: win.isFocused(),
    })
  }
  for (const eventName of [
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen',
    'restore',
    'focus',
    'blur',
  ]) {
    win.on(eventName, sendWindowState)
  }

  win.on('close', onWindowClose)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // 外链一律走系统浏览器；窗口内不允许导航到站点外地址。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return
    event.preventDefault()
    void openExternalUrl(url)
  })
  win.webContents.on('did-finish-load', () => {
    logger.info(`窗口加载完成 url=${win.webContents.getURL()}`)
    if (SMOKE_MODE && !smokeFinished) {
      // 等首轮 /api/state 轮询与页面渲染稳定后再截图。
      setTimeout(() => {
        void runSmokeCapture(win)
      }, SMOKE_SETTLE_MS)
    }
  })
  // 渲染进程控制台转发到壳层日志：白屏/启动异常时这是第一手现场（仅开发/自检模式，避免生产噪声）。
  win.webContents.on('console-message', (...args) => {
    if (!IS_DEV && !SMOKE_MODE) return
    const detail = args[0]
    if (detail && typeof detail === 'object' && 'message' in detail) {
      logger.info(`[renderer:${detail.level ?? 'log'}] ${detail.message}`)
      return
    }
    if (typeof args[2] === 'string') logger.info(`[renderer:${args[1] ?? 'log'}] ${args[2]}`)
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error(`preload 执行失败 path=${preloadPath}`, error)
    if (SMOKE_MODE && !smokeFinished) smokeFail(`preload-error ${error?.message ?? error}`)
  })
  win.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    logger.error(`窗口加载失败 code=${code} desc=${description} url=${validatedUrl} mainFrame=${isMainFrame}`)
    // -3 = ERR_ABORTED（窗口重建/导航被取代），不属于加载失败；子 frame 失败也不影响首屏。
    if (SMOKE_MODE && !smokeFinished && isMainFrame !== false && code !== -3) {
      smokeFail(`window-load-failed code=${code} desc=${description} url=${validatedUrl}`)
    }
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`渲染进程退出 reason=${details?.reason} exitCode=${details?.exitCode}`)
  })

  mainWindow = win
  const target = resolveWindowTarget()
  logger.info(`创建主窗口，加载 ${target}`)
  win.loadURL(target).catch((error) => {
    logger.error(`loadURL 失败：${error?.message ?? error}`)
  })
  return win
}

/** 重建窗口（服务重启后 Token 变化，additionalArguments 无法热更新，只能新建窗口）。 */
function recreateMainWindow(options = {}) {
  const { showOnReady = true } = options
  suppressWindowAllClosed += 1
  try {
    const old = mainWindow
    let bounds = null
    let maximized = false
    let wasVisible = true
    if (old && !old.isDestroyed()) {
      bounds = old.getBounds()
      maximized = old.isMaximized()
      wasVisible = old.isVisible()
      old.removeListener('close', onWindowClose)
      old.destroy()
    }
    mainWindow = null
    const win = createMainWindow({ bounds, maximized, showOnReady: showOnReady && wasVisible })
    // closed / window-all-closed 可能异步派发，下一拍再解除抑制。
    setImmediate(() => {
      suppressWindowAllClosed = Math.max(0, suppressWindowAllClosed - 1)
    })
    return win
  } catch (error) {
    suppressWindowAllClosed = Math.max(0, suppressWindowAllClosed - 1)
    throw error
  }
}

/** 判断是否站内地址（用于拦截窗口导航）。 */
function isInternalUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl))
    if (loadMode === 'dev-server') return parsed.origin === new URL(activeDevServerUrl).origin
    const origin = currentBootstrap.apiBaseUrl || serverHost?.ready()?.origin
    return Boolean(origin) && parsed.origin === new URL(origin).origin
  } catch {
    return false
  }
}

async function openExternalUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    await shell.openExternal(parsed.toString())
  } catch (error) {
    logger.warn(`打开外部链接失败：${error?.message ?? error}`)
  }
}

function showMainWindow(focus = true) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    recreateMainWindow({ showOnReady: true })
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  if (focus) mainWindow.focus()
}

/** 隐藏到托盘（防烧额度主路径）。 */
function hideToTray(reason) {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  win.hide()
  logger.info(`${reason}；窗口已隐藏，托盘继续保活`)
}

/**
 * 窗口 close 处理器（同步，读缓存，绝不阻塞）：
 * 云端会话/任务仍活跃 → 阻止关闭 + 隐藏到托盘 + 桌面通知；否则放行由 Electron 正常关停。
 */
function onWindowClose(event) {
  if (forceQuit || quitting || shutdownComplete) return
  if (!isSessionActive(latestState)) {
    logger.info('窗口关闭：无活跃云端会话/任务，允许退出')
    return
  }
  event.preventDefault()
  logger.info('窗口关闭被拦截：云端会话/任务仍活跃，防烧额度')
  if (tray && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide()
    showDesktopNotification({
      title: shellText(shellLang, 'notify.background.title'),
      body: shellText(shellLang, 'notify.background.body'),
      logger,
    })
    return
  }
  // 托盘不可用（部分 Linux 桌面）时的兜底：让用户明确选择。
  if (closeConfirmOpen) return
  closeConfirmOpen = true
  void confirmQuitWhileSessionActive()
    .then((quitAnyway) => {
      if (quitAnyway) requestQuit('用户在会话活跃时确认退出')
    })
    .finally(() => {
      closeConfirmOpen = false
    })
}

async function confirmQuitWhileSessionActive() {
  const options = {
    type: 'warning',
    title: shellText(shellLang, 'dialog.activeSession.title'),
    message: shellText(shellLang, 'dialog.activeSession.message'),
    detail: shellText(shellLang, 'dialog.activeSession.detail'),
    buttons: [shellText(shellLang, 'dialog.activeSession.back'), shellText(shellLang, 'dialog.activeSession.quit')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  try {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return result.response === 1
  } catch (error) {
    logger.warn(`防烧额度确认框打开失败：${error?.message ?? error}`)
    return false
  }
}

function onWindowAllClosed() {
  if (quitting || shutdownComplete) return
  if (suppressWindowAllClosed > 0 || serverRestarting) {
    logger.info('所有窗口暂时为空（窗口重建/服务重启进行中），保持应用运行')
    return
  }
  if (process.platform === 'darwin') return // macOS 常驻 Dock，由 activate 恢复窗口
  if (!forceQuit && isSessionActive(latestState)) {
    // 有活跃会话但窗口已销毁（例如渲染进程崩溃）：留在托盘，等待用户手动恢复或彻底退出。
    logger.info('所有窗口已关闭，但云端会话仍活跃：驻留托盘')
    return
  }
  app.quit()
}

// ── 托盘 ──────────────────────────────────────────────────────────────────

function ensureTray() {
  if (tray) return
  tray = createTray({
    getSnapshot: () => latestState,
    getProbe: () => latestProbe,
    getLang: () => shellLang,
    onShow: () => showMainWindow(true),
    onQuit: () => requestQuit('托盘「彻底退出」'),
    logger: createLogger('tray'),
  })
  if (tray) {
    updateTray()
    logger.info('系统托盘已创建')
  }
}

function updateTray() {
  if (!tray) return
  try {
    tray.refresh(latestState, latestProbe)
  } catch (error) {
    logger.warn(`刷新托盘状态失败：${error?.message ?? error}`)
  }
}

// ── 应用内更新（M2.8 阶段 B） ──────────────────────────────────────────────

/**
 * 只读形态的状态：把本地服务的 `/api/state.update` 快照并进统一状态形状。
 * 只读形态（便携 / 解压 / 开发 / macOS 未签名 / Linux AppImage）不下载、不安装。
 */
function readonlyStateOf(snapshot) {
  const base = {
    mode: 'readonly',
    form: updatePolicy?.form ?? 'unsupported',
    canAutoUpdate: false,
    current: app.getVersion(),
    source: snapshot?.source,
  }
  if (!snapshot || typeof snapshot !== 'object' || snapshot.mode === 'electron') {
    return normalizeUpdateState({ ...base, status: 'idle' })
  }
  const status = snapshot.error
    ? 'error'
    : snapshot.hasUpdate
      ? 'available'
      : snapshot.latest
        ? 'up-to-date'
        : 'idle'
  return normalizeUpdateState({
    ...base,
    latest: snapshot.latest,
    hasUpdate: snapshot.hasUpdate === true,
    status,
    releaseUrl: snapshot.releaseUrl,
    releaseName: snapshot.releaseName,
    checkedAt: snapshot.checkedAt,
    error: snapshot.error || null,
  })
}

/** 读一次 `/api/state` 并归一成只读状态（失败时返回 idle，不抛错）。 */
async function readOnlyUpdateState() {
  const host = serverHost
  if (!host?.isReady()) return readonlyStateOf(null)
  try {
    const payload = await host.request('/api/state', { timeoutMs: STATE_POLL_TIMEOUT_MS })
    return readonlyStateOf(payload?.update)
  } catch (error) {
    logger.debug(`读取只读更新状态失败：${error?.message ?? error}`)
    return readonlyStateOf(null)
  }
}

/** 只读形态的「立即检查」：POST /api/update/check（自动检查关闭时也可用）。 */
async function readOnlyCheck() {
  const host = serverHost
  if (!host?.isReady()) {
    const state = readonlyStateOf({ error: 'offline' })
    broadcastUpdaterState(state)
    return state
  }
  try {
    // 服务端内含 fetch + curl 两段降级，总耗时可能超过 8 秒，这里放宽到 15 秒避免提前超时吞错。
    const payload = await host.request('/api/update/check', { method: 'POST', timeoutMs: 15_000 })
    if (payload?.mode === 'electron') return readonlyStateOf(null)
    const state = readonlyStateOf(payload?.update)
    // 只读形态没有主进程状态机：手动检查后主动广播一次，顶栏与设置区同步刷新。
    broadcastUpdaterState(state)
    return state
  } catch (error) {
    logger.warn(`只读版本检查失败：${error?.message ?? error}`)
    const state = readonlyStateOf({
      error: {
        code: classifyUpdateError(error, 'offline'),
        message: String(error?.message ?? error ?? '').slice(0, 400),
      },
    })
    broadcastUpdaterState(state)
    return state
  }
}

/** 把主进程状态推给所有窗口（渲染进程优先订阅它，回退才轮询 /api/state）。 */
function broadcastUpdaterState(state) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(UPDATER_CHANNELS.event, state)
      } catch {
        // 窗口正在销毁：忽略。
      }
    }
  }
}

/** 打开发布页 / 镜像下载页：只放行 https。 */
async function openReleaseUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ''))
    if (url.protocol !== 'https:') return false
    await shell.openExternal(url.toString())
    return true
  } catch (error) {
    logger.warn(`打开发布页失败：${error?.message ?? error}`)
    return false
  }
}

/**
 * 创建更新器并注册 IPC（幂等：每次进程只调用一次）。
 *
 * 初始化顺序（规格 §3.3）：判定形态 → 仅在 `canAutoUpdate` 时创建 electron-updater →
 * 注册 IPC → 启动后延迟 10 秒首次检查 → 之后每 6 小时复查。
 */
async function initUpdater() {
  if (!updatePolicy) return
  if (updatePolicy.canAutoUpdate) {
    try {
      updater = await createUpdater({
        policy: updatePolicy,
        currentVersion: app.getVersion(),
        log: createLogger('updater'),
        getSettings: async () => {
          const host = serverHost
          if (!host?.isReady()) return null
          const payload = await host.request('/api/app-settings', { timeoutMs: STATE_POLL_TIMEOUT_MS })
          return payload?.settings?.update ?? null
        },
        // 安装护栏：每次点击都重新拉一次 /api/state（2.5s 超时），不信 5 秒前的缓存。
        getServerState: async () => {
          const host = serverHost
          if (!host?.isReady()) return { ok: false, at: Date.now() }
          const payload = await host.request('/api/state', { timeoutMs: STATE_POLL_TIMEOUT_MS })
          return { ...(payload && typeof payload === 'object' ? payload : {}), at: Date.now(), ok: true }
        },
        onInstallReady: () => {
          // 不在这里 quitAndInstall：先让 before-quit 的 shutdown() 完整走完。
          pendingInstall = true
          forceQuit = true
          logger.info('更新已就绪：进入退出流程（shutdown → quitAndInstall）')
          app.quit()
        },
        onStateChange: (state) => broadcastUpdaterState(state),
      })
    } catch (error) {
      logger.warn(`更新器初始化失败，降级为只读：${error?.message ?? error}`)
      updater = null
    }
  }
  registerUpdaterIpc()
  updater?.start()
}

/** 注册更新相关 IPC；没有 updater 时走只读路径（便携 / 解压 / 开发态）。 */
function registerUpdaterIpc() {
  const handle = (channel, handler) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
  }

  handle(UPDATER_CHANNELS.state, async () => (updater ? updater.getState() : readOnlyUpdateState()))

  handle(UPDATER_CHANNELS.check, async () => {
    if (updater) return updater.check({ manual: true })
    return readOnlyCheck()
  })

  handle(UPDATER_CHANNELS.download, async () => {
    if (updater) return updater.download()
    return readOnlyUpdateState()
  })

  handle(UPDATER_CHANNELS.install, async () => {
    if (!updater) return { ok: false, reason: 'unsupported_form' }
    return updater.install()
  })

  handle(UPDATER_CHANNELS.installOnQuit, async (_event, value) => {
    if (updater) return updater.setInstallOnQuit(value === true)
    return readOnlyUpdateState()
  })

  handle(UPDATER_CHANNELS.openRelease, async (_event, url) => openReleaseUrl(url))
}

// ── 状态轮询（/api/state） ─────────────────────────────────────────────────

async function refreshServerState() {
  const host = serverHost
  if (!host || !host.isReady()) {
    latestProbe = null
    updateTray()
    return
  }
  latestProbe = await host.probe({ timeoutMs: STATE_POLL_TIMEOUT_MS })
  if (latestProbe.ok) {
    try {
      latestState = await host.request('/api/state', { timeoutMs: STATE_POLL_TIMEOUT_MS })
    } catch (error) {
      logger.warn(`读取 /api/state 失败：${error?.message ?? error}`)
    }
  }
  updateTray()
}

function startStatePolling() {
  stopStatePolling()
  statePollTimer = setInterval(() => {
    void refreshServerState()
  }, STATE_POLL_INTERVAL_MS)
  // 轮询不应单独阻止进程退出。
  statePollTimer.unref?.()
}

function stopStatePolling() {
  if (!statePollTimer) return
  clearInterval(statePollTimer)
  statePollTimer = null
}

// ── 崩溃重启 ──────────────────────────────────────────────────────────────

function scheduleRestartCounterReset() {
  if (stableTimer) clearTimeout(stableTimer)
  stableTimer = setTimeout(() => {
    stableTimer = null
    if (!serverHost?.isReady()) return
    if (restartAttempts > 0) logger.info('本地服务已稳定运行，重启计数清零')
    restartAttempts = 0
  }, RESTART_COUNTER_RESET_MS)
  stableTimer.unref?.()
}

function scheduleServerRestart(event = {}) {
  if (quitting || shutdownComplete || forceQuit) return
  if (restartAttempts >= MAX_SERVER_RESTARTS) {
    logger.error(`本地服务已连续异常退出，自动重启达到上限（${MAX_SERVER_RESTARTS} 次）`)
    broadcastServerEvent({ type: 'server-failed', attempts: restartAttempts })
    showDesktopNotification({
      title: shellText(shellLang, 'notify.serverFailed.title'),
      body: shellText(shellLang, 'notify.serverFailed.body'),
      logger,
    })
    updateTray()
    return
  }
  const attempt = restartAttempts + 1
  const delayMs = RESTART_DELAYS_MS[Math.min(restartAttempts, RESTART_DELAYS_MS.length - 1)]
  restartAttempts = attempt
  const detail = `code=${event.code ?? 'unknown'} signal=${event.signal ?? 'none'}`
  logger.warn(`本地服务异常退出（${detail}），${delayMs}ms 后进行第 ${attempt}/${MAX_SERVER_RESTARTS} 次重启`)
  broadcastServerEvent({ type: 'restarting', attempt, maxAttempts: MAX_SERVER_RESTARTS, delayMs })
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    void restartServer()
  }, delayMs)
  restartTimer.unref?.()
}

async function restartServer() {
  if (quitting || shutdownComplete || forceQuit) return
  serverRestarting = true
  try {
    const old = serverHost
    serverHost = null
    if (old) {
      old.removeAllListeners()
      await old.dispose().catch(() => {})
    }
    const ready = await bootServer()
    currentBootstrap = buildBootstrap(ready)
    logger.info(`本地服务重启成功 origin=${ready.origin}，重建窗口以更新 Token`)
    recreateMainWindow({ showOnReady: true })
    await refreshServerState()
    broadcastServerEvent({ type: 'ready', origin: ready.origin, restarted: true })
    scheduleRestartCounterReset()
  } catch (error) {
    logger.error(`本地服务重启失败：${error?.message ?? error}`)
    scheduleServerRestart({ code: null, signal: null })
  } finally {
    serverRestarting = false
  }
}

// ── 退出 ──────────────────────────────────────────────────────────────────

function requestQuit(reason = '用户请求退出') {
  logger.info(`请求退出应用：${reason}`)
  forceQuit = true
  app.quit()
}

function onBeforeQuit(event) {
  if (shutdownComplete) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  // 「退出时安装」：用户选了退出时安装、包已下载，且当前没有活跃云端会话时才执行；
  // 有会话时本次只退出不安装（安装继续等待下一次退出），防止配额空烧。
  if (!pendingInstall && updater) {
    const state = updater.getState()
    if (state?.installOnQuit === true && state?.status === 'downloaded') {
      if (isSessionActive(latestState)) {
        logger.warn('退出时安装已暂缓：仍有活跃云端会话/任务，本次只退出不安装')
      } else {
        pendingInstall = true
        logger.info('退出时安装：准备在 shutdown 完成后执行 quitAndInstall')
      }
    }
  }
  logger.info('开始退出流程：停止状态轮询并关停本地服务（最多 10 秒）')
  void shutdown()
    .catch((error) => logger.error('退出流程出错', error))
    .finally(() => {
      shutdownComplete = true
      // 安装动作必须排在 shutdown 之后，且不能再调用 app.quit() 与安装器争抢退出流程。
      if (pendingInstall) {
        pendingInstall = false
        const launched = updater?.quitAndInstall?.() === true
        logger.info(`quitAndInstall 已触发 launched=${launched}`)
        if (!launched) app.quit()
        return
      }
      app.quit()
    })
}

async function shutdown() {
  stopStatePolling()
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (stableTimer) {
    clearTimeout(stableTimer)
    stableTimer = null
  }
  if (tray) {
    try {
      tray.destroy()
    } catch {
      // ignore
    }
    tray = null
  }
  // 更新器只清定时器，不能在这里 quitAndInstall（安装由 before-quit 的 finally 统一执行）。
  // 注意不要置空 updater：同一个 finally 里还要用它执行 quitAndInstall。
  try {
    updater?.dispose?.()
  } catch {
    // ignore
  }
  nativeBridge?.dispose?.()
  nativeBridge = null

  // 若有活跃会话，给渲染进程 / 服务日志留一句明确记录（服务自身负责尽力关机与持久化）。
  if (isSessionActive(latestState)) {
    logger.warn('退出时云端会话/任务仍活跃：服务将尽力关机并持久化会话记录')
  }

  const host = serverHost
  serverHost = null
  if (!host) {
    logger.info('没有运行中的本地服务，直接退出')
    return
  }
  const startedAt = Date.now()
  logger.info('正在停止本地服务…')
  try {
    // 内部保证最多等待 timeoutMs：stdin EOF → 宽限期 → 进程树强杀。
    await host.stop({ timeoutMs: SHUTDOWN_TIMEOUT_MS })
  } catch (error) {
    logger.warn(`停止本地服务时出错：${error?.message ?? error}`)
  } finally {
    logger.info(`本地服务已停止，用时 ${Date.now() - startedAt}ms`)
    await host.dispose().catch(() => {})
  }
}

function failStart(error) {
  logger.error('应用启动失败', error)
  if (SMOKE_MODE) {
    smokeFail(`startup-failed ${error?.message ?? error}`)
    return
  }
  try {
    const lang = resolveShellLang(shellLang)
    dialog.showErrorBox(
      shellText(lang, 'dialog.startFailed.title'),
      `${error?.message ?? error}\n\n${shellText(lang, 'dialog.startFailed.logPrefix')}${logger.filePath() || shellText(lang, 'dialog.startFailed.logDisabled')}`,
    )
  } catch {
    // 无 GUI 会话时忽略
  }
  forceQuit = true
  shutdownComplete = true
  app.quit()
}

// ── 无人值守自检（SMOKE） ────────────────────────────────────────────────────

/** 输出一行机器可读结果（stdout；前置固定前缀供 CI 正则匹配）。 */
function smokeEmit(prefix, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  try {
    process.stdout.write(`${prefix} ${text}\n`)
  } catch {
    // 无 stdout（GUI 进程）时忽略：日志文件里仍有关键过程记录。
  }
}

/**
 * 自检成功路径：截图保存到 AIGC_STUDIO_SMOKE_CAPTURE，打印 SMOKE_OK 后走正常退出流程。
 * 截图前已等待 SMOKE_SETTLE_MS，确保页面完成首轮 /api/state 数据渲染。
 */
async function runSmokeCapture(win) {
  if (smokeFinished) return
  try {
    if (!win || win.isDestroyed()) throw new Error('窗口已销毁')
    const diagnostics = await collectSmokeDiagnostics(win)
    logger.info(`SMOKE_DIAG ${JSON.stringify(diagnostics)}`)
    // 图片校验（本轮新增）：/api/file 的图必须真正解码成功，否则判定失败——
    // 空工作区自然没有图，所以只有「有图工作区」的用例才会命中下面的断言。
    const imageCount = Number(diagnostics.imageCount) || 0
    const imagesLoaded = Number(diagnostics.imagesLoaded) || 0
    const imageFailures = Number(diagnostics.imageFailures) || 0
    if (imageFailures > 0) {
      throw new Error(`image-failed count=${imageFailures} ${(diagnostics.imageFailureDetails || []).join(' | ')}`)
    }
    if (SMOKE_REQUIRE_IMAGE && (imageCount === 0 || imagesLoaded === 0)) {
      throw new Error(`no-image-loaded imageCount=${imageCount} loaded=${imagesLoaded}`)
    }
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    if (!png || png.length === 0) throw new Error('capturePage 返回空图片')
    mkdirSync(dirname(SMOKE_CAPTURE_PATH), { recursive: true })
    writeFileSync(SMOKE_CAPTURE_PATH, png)
    smokeFinished = true
    if (smokeTimer) {
      clearTimeout(smokeTimer)
      smokeTimer = null
    }
    const payload = {
      url: win.webContents.getURL(),
      title: win.webContents.getTitle() || win.getTitle() || '',
      capturePath: SMOKE_CAPTURE_PATH,
      imageCount,
      imagesLoaded,
    }
    logger.info(`自检截图完成 bytes=${png.length} url=${payload.url} title=${payload.title} images=${imagesLoaded}/${imageCount}`)
    smokeEmit('SMOKE_OK', payload)
    // portable / GUI 包装进程不会把子进程 stdout 转发出来，落一份结果文件给安装包验收读。
    writeSmokeResultFile({ ok: true, ...payload, diagnostics })
    // 走正常退出流程：before-quit → 优雅关停本地服务。
    requestQuit('自检完成')
  } catch (error) {
    smokeFail(`capture-failed ${error?.message ?? error}`)
  }
}

/**
 * 自检诊断信息：用于 CI 判断「页面到底渲染了什么」而不只是看截图。
 * 只输出非敏感字段（Token 只报长度）。
 *
 * 图片诊断是本轮新增的重点：`<img>` 的请求由浏览器发出、无法携带 Bearer Token，
 * 只有「Session Cookie / 主进程头注入」这条链路正常时才会 complete 且 naturalWidth>0；
 * 空工作区拿不到任何图，因此必须由「带真实图片」的冒烟用例（test/smoke-image.mjs）来兜。
 */
async function collectSmokeDiagnostics(win) {
  const script = `(async () => {
    const root = document.getElementById('root')
    const bridge = window.aigcStudio
    const boot = bridge && bridge.bootstrap && typeof bridge.bootstrap === 'object' ? bridge.bootstrap : null
    const bodyText = document.body && document.body.innerText ? document.body.innerText.trim() : ''
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    // 等图片加载结束（最多 4 秒）：complete=false 或 naturalWidth=0 都说明资源没成功解码。
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      const list = Array.from(document.images)
      if (list.length > 0 && list.every((img) => img.complete)) break
      await sleep(100)
    }
    const images = Array.from(document.images).map((img) => ({
      src: String(img.currentSrc || img.src || '').slice(0, 300),
      complete: img.complete === true,
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0
    }))
    // 只把「经 /api/file 交付的产物图」当失败判据；图标/头像等非接口资源不计。
    // 判定口径：complete 为 true 且 naturalWidth 为 0 = 请求已结束但解码失败（401/404/坏字节），
    // 这才是真回归；complete 为 false 的懒加载图（未进入视口）不算失败，避免误报。
    const apiImages = images.filter((image) => image.src.includes('/api/file'))
    const broken = apiImages.filter((image) => image.complete === true && image.naturalWidth === 0)
    const probe = async (path) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      const headers = { accept: 'application/json' }
      if (boot && typeof boot.authToken === 'string' && boot.authToken) {
        headers.authorization = 'Bearer ' + boot.authToken
      }
      try {
        const response = await fetch(path, { headers, signal: controller.signal, cache: 'no-store' })
        return { status: response.status, ok: response.ok }
      } catch (error) {
        return { error: String((error && error.message) || error) }
      } finally {
        clearTimeout(timer)
      }
    }
    return {
      readyState: document.readyState,
      rootChildren: root ? root.childElementCount : -1,
      rootHtmlLength: root ? root.innerHTML.length : -1,
      bodyTextLength: bodyText.length,
      bodyTextSample: bodyText.slice(0, 160),
      hasInjectedBootstrap: Boolean(window.__AIGC_STUDIO__),
      hasDesktopBridge: Boolean(bridge),
      desktopApiBaseUrl: boot && typeof boot.apiBaseUrl === 'string' ? boot.apiBaseUrl : null,
      desktopTokenLength: boot && typeof boot.authToken === 'string' ? boot.authToken.length : 0,
      imageTotal: images.length,
      imageCount: apiImages.length,
      imagesLoaded: apiImages.filter((image) => image.complete && image.naturalWidth > 0).length,
      imageFailures: broken.length,
      imageFailureDetails: broken.slice(0, 3).map((image) => image.src),
      imageSamples: apiImages.slice(0, 3).map((image) => ({
        src: image.src,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight
      })),
      apiProbe: await probe('/api/app-settings'),
      stateProbe: await probe('/api/state')
    }
  })()`
  try {
    return await win.webContents.executeJavaScript(script, true)
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

/** 自检失败路径：打印 SMOKE_FAIL 并以非零码立即结束（不再等待优雅关停，避免 CI 挂起）。 */
function smokeFail(reason) {
  if (smokeFinished) return
  smokeFinished = true
  if (smokeTimer) {
    clearTimeout(smokeTimer)
    smokeTimer = null
  }
  logger.error(`自检失败：${reason}`)
  smokeEmit('SMOKE_FAIL', String(reason))
  writeSmokeResultFile({ ok: false, reason: String(reason) })
  forceQuit = true
  shutdownComplete = true
  app.exit(1)
}

/**
 * 把自检结果写到 `<capture>.json`。
 *
 * `SMOKE_OK` / `SMOKE_DIAG` 走 stdout，但 portable 版是 NSIS 自解压外壳：
 * 真正的窗口进程由外壳另行拉起，stdout 不再指向调用方管道，控制台判定会全部落空。
 * 安装包验收（test/smoke-packaged.mjs）因此优先读 stdout，读不到时回退这个结果文件。
 */
function writeSmokeResultFile(payload) {
  if (!SMOKE_CAPTURE_PATH) return
  try {
    writeFileSync(`${SMOKE_CAPTURE_PATH}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (error) {
    logger.warn(`写自检结果文件失败：${error?.message ?? error}`)
  }
}

/** 解析自检截图路径：空值返回空串；相对路径按当前工作目录解析。 */
function normalizeSmokePath(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const trimmed = value.trim()
  return isAbsolute(trimmed) ? trimmed : resolvePath(process.cwd(), trimmed)
}

/** 读取正整数环境变量，非法时回退默认值。 */
function readPositiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

// ── 渲染进程事件推送 ──────────────────────────────────────────────────────

function broadcastServerEvent(event) {
  const payload = { ...event, at: event?.at ?? Date.now() }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('aigc:server-event', payload)
    } catch (error) {
      logger.debug(`推送服务事件失败：${error?.message ?? error}`)
    }
  }
}
