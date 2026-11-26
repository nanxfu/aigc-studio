/**
 * AIGC Studio 独立服务入口（Web 与 Electron 的唯一后端）。
 *
 * 进程模型（docs/MIGRATION_SPEC.md §2 / §6）：
 *  - Electron 主进程以子进程方式拉起本文件（`ELECTRON_RUN_AS_NODE=1`），端口与 Token 由主进程
 *    经环境变量传入；开发态也可以直接 `node server/standalone.js`。
 *  - 绑定成功后向 **stdout 写唯一一行 ready JSON**，此前 stdout 不得输出任何内容
 *    （日志一律走 stderr 与文件日志），Electron 端据此建窗口。
 *  - 收到 SIGTERM / SIGINT / stdin 关闭（父进程死亡）时统一 `dispose()` 后 `process.exit(0)`；
 *    从收到信号到退出最多 10 秒，内部有强制兜底。
 *
 * 输入（全部来自环境变量）：
 *   AIGC_STUDIO_PORT        监听端口，0 = 随机空闲端口（默认 0）
 *   AIGC_STUDIO_TOKEN       本地 API Bearer Token，缺省随机生成 32 字节 hex
 *   AIGC_STUDIO_DATA_DIR    应用全局数据目录（默认见 app-config.defaultDataDir）
 *   AIGC_STUDIO_WORKSPACE   首次启动的初始工作区（缺省 <dataDir>/workspace）
 *   AIGC_STUDIO_WEB_DIST    前端静态产物目录（默认 <repo>/dist/web；不存在时只提供 API）
 *   AIGC_STUDIO_DEV         1 = 放宽 Origin 校验（本地排障用）
 *   AIGC_STUDIO_HOSTED      1 = 由父进程托管（额外把 stdin 关闭 / IPC 断开当作退出信号）
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PROTOCOL_VERSION } from '../shared/contract.js'
import { createToolRegistry } from './agent/tools.js'
import { createApp } from './app.js'
import { detectPreferredLang } from '../shared/locale.js'
import { createAppConfig, defaultDataDir } from './app-config.js'
import { DEFAULT_CONFIG } from './defaults.js'
import { createHostContext } from './host-context.js'
import { startHttpServer } from './http-server.js'
import { createLlmService } from './llm/service.js'
import { createLogger, flushHostLog } from './log.js'
import { removeRuntimeFile, writeRuntimeFile } from './runtime-file.js'
import { createWorkspaceManager } from './workspace.js'

/** 仓库根目录（server/ 的上一级）。 */
const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** 收到退出信号后的最长收尾时间（与 Electron 主进程的等待预算一致）。 */
const SHUTDOWN_BUDGET_MS = 10_000

/** stderr sink：保证 stdout 只有 ready 一行（Electron 依赖这一点）。 */
function stderrSink(level) {
  return (...args) => {
    try {
      const text = args
        .map((arg) => {
          if (typeof arg === 'string') return arg
          if (arg instanceof Error) return `${arg.name}: ${arg.message}`
          try {
            return JSON.stringify(arg)
          } catch {
            return String(arg)
          }
        })
        .join(' ')
      process.stderr.write(`[aigc-studio:${level}] ${text}\n`)
    } catch {}
  }
}

const log = createLogger({
  scope: 'standalone',
  level: 'info',
  sink: { debug: stderrSink('debug'), info: stderrSink('info'), warn: stderrSink('warn'), error: stderrSink('error') },
})

/** 解析端口：非法 / 越界回退 0（随机空闲端口）。 */
function parsePort(raw) {
  const number = Number(raw)
  if (!Number.isFinite(number) || number < 0 || number > 65535) return 0
  return Math.trunc(number)
}

/** 读取 AIGC_STUDIO_DEV：1 / true / yes 视为开启。 */
function isDevMode(raw) {
  return /^(1|true|yes|on)$/i.test(String(raw ?? '').trim())
}

/** 应用版本：优先 package.json，读不到回退 0.1.0。 */
async function readAppVersion() {
  try {
    const text = await readFile(join(APP_ROOT, 'package.json'), 'utf8')
    const pkg = JSON.parse(text)
    return typeof pkg?.version === 'string' && pkg.version ? pkg.version : '0.1.0'
  } catch {
    return '0.1.0'
  }
}

/**
 * 启动服务（不做进程级信号绑定，便于测试直接调用）。
 *
 * @returns {Promise<{ port: number, token: string, origin: string, shutdown: (reason?: string) => Promise<void> }>}
 */
export async function startStandalone(env = process.env) {
  const token = typeof env.AIGC_STUDIO_TOKEN === 'string' && env.AIGC_STUDIO_TOKEN.trim()
    ? env.AIGC_STUDIO_TOKEN.trim()
    : randomBytes(32).toString('hex')
  const port = parsePort(env.AIGC_STUDIO_PORT)
  const devMode = isDevMode(env.AIGC_STUDIO_DEV)
  const dataDir = resolve(
    typeof env.AIGC_STUDIO_DATA_DIR === 'string' && env.AIGC_STUDIO_DATA_DIR.trim()
      ? env.AIGC_STUDIO_DATA_DIR.trim()
      : defaultDataDir(env),
  )
  const webDist = resolve(
    typeof env.AIGC_STUDIO_WEB_DIST === 'string' && env.AIGC_STUDIO_WEB_DIST.trim()
      ? env.AIGC_STUDIO_WEB_DIST.trim()
      : join(APP_ROOT, 'dist', 'web'),
  )
  const initialWorkspace =
    typeof env.AIGC_STUDIO_WORKSPACE === 'string' && env.AIGC_STUDIO_WORKSPACE.trim()
      ? env.AIGC_STUDIO_WORKSPACE.trim()
      : null

  const appVersion = await readAppVersion()

  // 1) 全局配置（app-config.json + credentials/llm.json）
  // 首次运行（无持久化的 ui.lang）根据 Electron 传入的区域或系统环境变量自动推断中/英文。
  const credentialKey = typeof env.AIGC_STUDIO_CREDENTIAL_KEY === 'string' ? env.AIGC_STUDIO_CREDENTIAL_KEY : ''
  const defaultLang = detectPreferredLang({ locale: env.AIGC_STUDIO_LOCALE, env })
  const appConfig = createAppConfig({ dataDir, credentialKey, defaultLang, log })
  await appConfig.whenReady()

  // 1.1) Colab OAuth 凭据位置对齐规范 §4.2：优先放 appData 的 credentials/。
  // 由装配层注入环境变量而不是改 colab/client.js 的逻辑；显式设置过则尊重用户选择。
  if (!env.AIGC_STUDIO_COLAB_CREDENTIALS) {
    const colabCredentials = join(dataDir, 'credentials', 'colab-credentials.json')
    process.env.AIGC_STUDIO_COLAB_CREDENTIALS = colabCredentials
    await mkdir(dirname(colabCredentials), { recursive: true, mode: 0o700 }).catch(() => {})
  }

  // 2) 工作区（决定 ctx.get('workingDirectory')；没有可用工作区时启动失败）
  const workspaceManager = createWorkspaceManager({ appConfig, dataDir, initialWorkspace, log })
  await workspaceManager.whenReady()

  // 3) LLM 服务 + Agent 工具注册表
  const llm = createLlmService({ getConfig: () => appConfig.getLlmConfig() })
  const tools = createToolRegistry()

  // 4) 宿主上下文（ctx.get / effect / webServer / subprocess / tools）
  const host = createHostContext({ workspaceManager, llm, tools, log })

  // 5) 业务装配（会话 / 队列 / 全部路由 / Agent）
  // 更新配置单独成段（不跟随工作区）：检查开关 / 更新源 / 镜像地址，
  // 以及当前运行形态是否由主进程 electron-updater 独占（AIGC_STUDIO_UPDATE_OWNER）。
  const updateSettings = appConfig.getUpdate()
  const config = {
    ...DEFAULT_CONFIG,
    ...appConfig.getCompute(),
    updateCheck: updateSettings.updateCheck,
    updateSource: updateSettings.updateSource,
    updateMirrorUrl: updateSettings.updateMirrorUrl,
    updateOwner: env.AIGC_STUDIO_UPDATE_OWNER === 'electron' ? 'electron' : 'local',
    updateAllowInsecure: env.AIGC_STUDIO_UPDATE_DEV === '1',
  }
  const app = createApp({
    ctx: host.ctx,
    config,
    extra: { llm, tools, workspaceManager, appConfig, version: appVersion },
  })

  // 6) HTTP 服务（127.0.0.1 + Bearer Token + 静态资源）
  const http = await startHttpServer({
    ctx: host.ctx,
    token,
    port,
    host: '127.0.0.1',
    webDist,
    devMode,
    log,
  })

  // 7) 发现文件（M3.3）：MCP 等外部进程据此拿到端口与 Token。
  //    写失败不阻断服务启动（MCP 会给出「请先启动 AIGC Studio」的可读错误）。
  let runtimeWritten = false
  try {
    await writeRuntimeFile(dataDir, {
      port: http.port,
      origin: http.origin,
      token,
      version: appVersion,
      protocol: PROTOCOL_VERSION,
      workspace: workspaceManager.current(),
    })
    runtimeWritten = true
  } catch (error) {
    log.warn('runtime_file_write_failed', String(error?.message ?? error).slice(0, 300))
  }

  let shuttingDown = false
  async function shutdown(reason = 'unknown') {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`shutdown_begin reason=${reason} port=${http.port}`)
    const force = setTimeout(() => {
      try {
        process.stderr.write(`[aigc-studio:warn] shutdown_timeout budgetMs=${SHUTDOWN_BUDGET_MS}，强制退出\n`)
      } catch {}
      process.exit(0)
    }, SHUTDOWN_BUDGET_MS)
    force.unref?.()

    try {
      await app.dispose()
    } catch (error) {
      log.warn('dispose_app_failed', String(error?.message ?? error).slice(0, 300))
    }
    try {
      await http.close()
    } catch (error) {
      log.warn('close_http_failed', String(error?.message ?? error).slice(0, 300))
    }
    if (runtimeWritten) {
      try {
        await removeRuntimeFile(dataDir)
      } catch (error) {
        log.warn('runtime_file_remove_failed', String(error?.message ?? error).slice(0, 300))
      }
    }
    try {
      await flushHostLog()
    } catch {}
    clearTimeout(force)
    log.info('shutdown_done')
  }

  return { port: http.port, token, origin: http.origin, dataDir, http, app, host, appConfig, workspaceManager, shutdown }
}

/**
 * 进程入口：启动服务、打印 ready 行、绑定退出信号。
 */
export async function main() {
  const server = await startStandalone(process.env)

  // 静态目录不存在时只提供 API：提前给出可读提示（stderr，不影响 ready 行）。
  try {
    const { stat } = await import('node:fs/promises')
    const info = await stat(resolve(process.env.AIGC_STUDIO_WEB_DIST || join(APP_ROOT, 'dist', 'web'))).catch(() => null)
    if (!info?.isDirectory()) {
      log.warn('web_dist_missing 只提供 API；运行 `npm run build:web` 后可托管前端')
    }
  } catch {}

  // 退出信号：SIGTERM/SIGINT；只有在「确实被父进程托管」时才额外监听 stdin / IPC 断开。
  //
  // 为什么不能无条件监听 stdin：Start-Job、部分 CI、`node server/standalone.js < nul`
  // 等场景下 stdin 一开始就是 EOF，但这不代表父进程死亡。误判会导致打印 ready 后立即关停。
  const hosted = typeof process.send === 'function' || process.env.AIGC_STUDIO_HOSTED === '1'
  // 收尾日志走 stderr 管道（异步写）：留一个极短窗口让最后一行落地再 exit，避免被截断。
  const exitSoon = (code = 0) => {
    setTimeout(() => process.exit(code), 100)
  }
  const onSignal = (signal) => {
    void server.shutdown(signal).finally(() => exitSoon(0))
  }
  process.once('SIGTERM', () => onSignal('SIGTERM'))
  process.once('SIGINT', () => onSignal('SIGINT'))
  if (process.platform !== 'win32') process.once('SIGHUP', () => onSignal('SIGHUP'))

  if (hosted) {
    // stdin 关闭 / IPC 断开 = 父进程已退出：主动收尾，避免云端 GPU 会话空烧额度。
    process.stdin.on('end', () => {
      void server.shutdown('stdin-end').finally(() => exitSoon(0))
    })
    process.stdin.on('close', () => {
      void server.shutdown('stdin-close').finally(() => exitSoon(0))
    })
    process.stdin.on('error', () => {})
    process.stdin.resume()
    process.on('disconnect', () => {
      void server.shutdown('parent-disconnect').finally(() => exitSoon(0))
    })
  } else {
    process.stdin.on('error', () => {})
  }

  // 未捕获异常不让进程直接消失：记录后继续服务（会话/队列状态由各自模块维护）。
  process.on('uncaughtException', (error) => {
    log.error('uncaught_exception', String(error?.stack ?? error).slice(0, 2000))
  })
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled_rejection', String(reason?.stack ?? reason).slice(0, 2000))
  })

  // 唯一一行 stdout：Electron 主进程解析到它之后才创建窗口。
  const readyLine = JSON.stringify({ type: 'ready', port: server.port, token: server.token, origin: server.origin })
  process.stdout.write(`${readyLine}\n`)

  return server
}

/** 仅作为入口执行时启动（被测试 import 时不自动起服务）。 */
const entryHref = (() => {
  try {
    const entry = process.argv[1]
    return entry ? pathToFileURL(resolve(entry)).href : ''
  } catch {
    return ''
  }
})()

if (entryHref && entryHref === import.meta.url) {
  main().catch((error) => {
    try {
      process.stderr.write(`[aigc-studio:error] startup_failed ${String(error?.stack ?? error)}\n`)
    } catch {}
    process.exit(1)
  })
}
