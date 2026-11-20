/**
 * 开发态启动器：Vite 开发服务器 + Electron 主进程。
 *
 * 流程（MIGRATION_SPEC §6 / §11）：
 *   1. 用 Vite 的编程式 API（读取根目录 vite.config.js）启动开发服务器；
 *   2. 等它打印出实际 URL；
 *   3. 以 child_process.spawn 启动 Electron（二进制从 node_modules/electron 解析），
 *      注入 VITE_DEV_SERVER_URL 与 AIGC_STUDIO_PORT/TOKEN/DEV；
 *   4. Ctrl+C / Electron 退出 / Vite 异常时，依次关 Electron、关 Vite，保证不留孤儿进程。
 *
 * 重要环境细节（本机全局设置了 ELECTRON_RUN_AS_NODE=1）：
 *   该变量会让 Electron 二进制按纯 Node 模式运行（表现为打印 Node 版本而不是打开窗口），
 *   因此 spawn Electron 前必须从 env 中删除它；反向地，服务子进程由 electron/server-host.mjs
 *   显式设置 ELECTRON_RUN_AS_NODE=1，与这里无关。
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 开发态服务端口：Vite 代理与此处注入的端口必须一致。 */
const DEV_SERVER_PORT = Number(process.env.AIGC_STUDIO_PORT ?? 5130)
/** 开发态固定 Token：Vite 代理注入同一个值，Electron 主进程也沿用（不随机，便于排障）。 */
const DEV_TOKEN = process.env.AIGC_STUDIO_TOKEN || 'aigc-studio-dev-token'
const DEV_DATA_DIR = process.env.AIGC_STUDIO_DATA_DIR || join(ROOT, '.aigc-studio-data')

let viteServer = null
let electronChild = null
let shuttingDown = false

function log(message) {
  console.log(`[dev] ${message}`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

/** 解析 Electron 可执行文件路径（node_modules/electron 的默认导出即二进制路径）。 */
function resolveElectronPath() {
  const electronPath = require('electron')
  if (typeof electronPath !== 'string' || !electronPath) {
    throw new Error('无法解析 electron 可执行文件路径，请先执行 npm install')
  }
  return electronPath
}

/** Windows 上 taskkill：不带 /F 等价于请求窗口正常关闭；带 /F /T 为进程树强杀。 */
function runTaskkill(pid, { force }) {
  if (!pid) return Promise.resolve()
  const args = ['/pid', String(pid)]
  if (force) args.push('/T', '/F')
  return new Promise((resolveKill) => {
    let killer
    try {
      killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true })
    } catch {
      resolveKill()
      return
    }
    killer.once('error', () => resolveKill())
    killer.once('exit', () => resolveKill())
  })
}

/** 先尝试优雅关闭 Electron（触发 before-quit → 服务优雅退出），超时再强杀进程树。 */
async function stopElectron() {
  const child = electronChild
  electronChild = null
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolveExit) => child.once('exit', () => resolveExit(true)))
  log('正在关闭 Electron…')
  if (process.platform === 'win32') {
    await runTaskkill(child.pid, { force: false })
    if (await Promise.race([exited, sleep(8_000).then(() => false)])) return
    log('Electron 未在 8 秒内退出，强制结束进程树')
    await runTaskkill(child.pid, { force: true })
    await Promise.race([exited, sleep(3_000)])
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }
  if (await Promise.race([exited, sleep(8_000).then(() => false)])) return
  log('Electron 未在 8 秒内退出，发送 SIGKILL')
  try {
    child.kill('SIGKILL')
  } catch {
    // ignore
  }
  await Promise.race([exited, sleep(3_000)])
}

async function stopVite() {
  const server = viteServer
  viteServer = null
  if (!server) return
  log('正在关闭 Vite…')
  try {
    await server.close()
  } catch (error) {
    console.warn(`[dev] 关闭 Vite 时出错：${error?.message ?? error}`)
  }
}

/** 统一退出：Electron → Vite → 进程退出，重复调用安全。 */
async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await stopElectron()
  } finally {
    await stopVite()
  }
  process.exit(exitCode)
}

/** 启动 Vite 开发服务器并返回实际访问 URL。 */
async function startVite() {
  log('启动 Vite 开发服务器…')
  const { createServer } = await import('vite')
  let server
  try {
    server = await createServer({
      configFile: resolve(ROOT, 'vite.config.js'),
      mode: 'development',
    })
    await server.listen()
  } catch (error) {
    const message = String(error?.message ?? error)
    if (/Port\s+\d+\s+is already in use|EADDRINUSE/i.test(message)) {
      throw new Error(
        `Vite 开发端口被占用，请先关闭占用进程（或设置 AIGC_STUDIO_DEV_PORT 换端口）：${message}`,
      )
    }
    throw error
  }
  viteServer = server
  const url = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.config.server.port ?? 5173}/`
  log(`Vite 已就绪：${url}`)
  return url
}

/** 启动 Electron 主进程；返回子进程与首个退出码 Promise。 */
function startElectron(viteUrl) {
  const electronPath = resolveElectronPath()
  const env = { ...process.env }
  // 关键：本机/用户环境可能全局设置了 ELECTRON_RUN_AS_NODE=1，必须移除，否则不会打开窗口。
  delete env.ELECTRON_RUN_AS_NODE
  env.VITE_DEV_SERVER_URL = viteUrl
  env.AIGC_STUDIO_PORT = String(DEV_SERVER_PORT)
  env.AIGC_STUDIO_TOKEN = DEV_TOKEN
  env.AIGC_STUDIO_DEV = '1'
  env.AIGC_STUDIO_DATA_DIR = DEV_DATA_DIR

  log(`启动 Electron：${electronPath}`)
  log(`  VITE_DEV_SERVER_URL=${viteUrl}`)
  log(`  本地服务端口=${DEV_SERVER_PORT} 数据目录=${DEV_DATA_DIR}`)
  const child = spawn(electronPath, [ROOT], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    windowsHide: false,
  })
  electronChild = child
  child.once('error', (error) => {
    console.error(`[dev] Electron 启动失败：${error?.message ?? error}`)
    void shutdown(1)
  })
  child.once('exit', (code, signal) => {
    if (shuttingDown) return
    log(`Electron 已退出（code=${code} signal=${signal ?? 'none'}），关闭 Vite`)
    void shutdown(code ?? 0)
  })
  return child
}

async function main() {
  // Vite 配置在 createServer 时读取这些环境变量（代理目标与 Bearer Token）。
  process.env.AIGC_STUDIO_PORT = String(DEV_SERVER_PORT)
  process.env.AIGC_STUDIO_TOKEN = DEV_TOKEN

  const viteUrl = await startVite()
  try {
    startElectron(viteUrl)
  } catch (error) {
    await stopVite()
    throw error
  }
  log('开发环境已启动；按 Ctrl+C 退出')
}

process.on('SIGINT', () => {
  log('收到 SIGINT，准备退出')
  void shutdown(0)
})
process.on('SIGTERM', () => {
  log('收到 SIGTERM，准备退出')
  void shutdown(0)
})
process.on('uncaughtException', (error) => {
  console.error('[dev] 未捕获异常：', error)
  void shutdown(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[dev] 未处理的 Promise 拒绝：', reason)
  void shutdown(1)
})
// 兜底：无论以何种方式退出，都不要留下 Electron 子进程。
process.on('exit', () => {
  if (electronChild && electronChild.exitCode === null) {
    try {
      electronChild.kill()
    } catch {
      // ignore
    }
  }
})

main().catch(async (error) => {
  console.error(`[dev] 启动失败：${error?.message ?? error}`)
  await stopVite()
  process.exit(1)
})
