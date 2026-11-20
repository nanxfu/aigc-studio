/**
 * 本地服务（server/standalone.js）子进程托管。
 *
 * 进程模型（MIGRATION_SPEC §6.1）：
 *   Electron 主进程 ──spawn(process.execPath, [serverEntry], ELECTRON_RUN_AS_NODE=1)──▶ 本地服务
 *
 * 为什么用 process.execPath + ELECTRON_RUN_AS_NODE=1：
 *   打包后没有独立的 node 可执行文件，Electron 二进制在 ELECTRON_RUN_AS_NODE=1 时
 *   以纯 Node 模式运行脚本；开发态 process.execPath 同样是 Electron 二进制，行为一致。
 *
 * 启动握手（§2.2）：服务绑定成功后在 stdout 写**唯一一行** ready JSON：
 *   {"type":"ready","port":5130,"token":"<hex>","origin":"http://127.0.0.1:5130"}
 * 本模块逐行缓冲 stdout，只认首个合法 ready 对象；此前的非 ready 行按日志转发（正常应为空）。
 * 服务日志一律走 stderr，本模块按行转发到壳层日志器。
 *
 * 退出（§2.2）：先关闭 stdin（服务把 EOF 视为父进程退出，触发统一 dispose()），
 * POSIX 再补 SIGTERM；Windows 上 SIGTERM 等价于 TerminateProcess（会跳过服务的优雅收尾），
 * 因此 Windows 先只依赖 stdin EOF，宽限期后才用 taskkill /T /F 兜底，总等待上限 10 秒。
 *
 * 本模块不 import electron，可被普通 node 进程直接 import 做离线验证（无副作用）。
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'

import { createLogger } from './logger.mjs'

/** 等待 ready 行的上限：首次启动可能要先初始化数据目录/工作区，给足 60 秒。 */
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000
/** 主进程 before-quit 的整体关停预算（§6.3：最多 10 秒）。 */
const DEFAULT_STOP_TIMEOUT_MS = 10_000
/** stdin EOF 后留给服务自行收尾的宽限期，超时才强杀进程树。 */
const STOP_GRACE_MS = 3_000
/** ready 行（或任意单行 stdout）的缓冲上限，防止异常输出撑爆内存。 */
const STDOUT_BUFFER_LIMIT = 64 * 1024
/** stderr 按行转发的缓冲上限。 */
const STDERR_BUFFER_LIMIT = 64 * 1024

/**
 * 解析一行 stdout，返回 ready 信息；不是合法 ready 行时返回 null。
 *
 * 校验刻意宽松：token 长度不做 64 hex 硬校验（开发态允许固定短语 Token），
 * 但 port 必须是合法端口、token 必须非空，origin 只接受 127.0.0.1 的 http 地址。
 */
export function parseReadyLine(line) {
  const text = String(line ?? '').trim()
  if (!text.startsWith('{')) return null
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || value.type !== 'ready') return null
  const port = Number(value.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const token = typeof value.token === 'string' ? value.token.trim() : ''
  if (!token) return null
  const origin =
    typeof value.origin === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.origin)
      ? value.origin
      : `http://127.0.0.1:${port}`
  return { port, token, origin }
}

/** 进程树强杀：POSIX 直接 SIGKILL；Windows 用 taskkill /T /F 连同子进程一起结束。 */
function forceKillTree(pid) {
  if (!pid) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let killer
      try {
        killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        resolve()
        return
      }
      killer.once('error', () => resolve())
      killer.once('exit', () => resolve())
    })
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 进程可能已退出
  }
  return Promise.resolve()
}

export class ServerHost extends EventEmitter {
  #child = null
  #state = 'idle'
  #readyInfo = null
  #lastProbe = null
  #startPromise = null
  #stopPromise = null
  #pendingStart = null
  #stdoutBuffer = ''
  #stderrBuffer = ''
  /** 最近若干行 stderr：启动失败时拼进错误信息，便于直接看到端口占用/入口报错等原因。 */
  #stderrTail = []
  #stopping = false
  #disposed = false
  #exited = false
  #exitInfo = null
  #logger
  #options

  /**
   * @param {object} options
   * @param {string} options.serverEntry 服务入口绝对路径（server/standalone.js）
   * @param {NodeJS.ProcessEnv} [options.env] 传给子进程的环境变量（本模块强制追加 ELECTRON_RUN_AS_NODE=1）
   * @param {string} [options.cwd] 子进程工作目录
   * @param {object} [options.logger] 壳层日志器
   * @param {number} [options.startupTimeoutMs] ready 行等待上限
   */
  constructor(options = {}) {
    super()
    const { serverEntry, env = {}, cwd, logger, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS } = options
    if (typeof serverEntry !== 'string' || !serverEntry) {
      throw new TypeError('ServerHost 需要 serverEntry（本地服务入口绝对路径）')
    }
    this.#options = { serverEntry, env, cwd, startupTimeoutMs }
    this.#logger = logger ?? createLogger('server-host')
  }

  /** 当前状态：idle | starting | ready | stopping | stopped | crashed。 */
  get state() {
    return this.#state
  }

  /** 是否已收到 ready 行且子进程仍在运行。 */
  isReady() {
    return this.#state === 'ready' && Boolean(this.#readyInfo) && Boolean(this.#child)
  }

  /** ready 信息副本：{ port, token, origin }；未就绪返回 null。 */
  ready() {
    return this.#readyInfo ? { ...this.#readyInfo } : null
  }

  /** 健康快照（不发起网络请求）：进程状态、pid、最后一次探活结果。 */
  health() {
    return {
      state: this.#state,
      ready: this.isReady(),
      pid: this.#child?.pid ?? null,
      exit: this.#exitInfo,
      lastProbe: this.#lastProbe,
    }
  }

  /**
   * 订阅托管事件（主进程据此驱动窗口/托盘/重启）。
   *
   * 事件类型：starting / ready / start-failed / crashed / stopping / stopped。
   * 每条事件形如 { type, at, ...detail }。
   *
   * @param {(event: { type: string, at: number, [key: string]: unknown }) => void} listener
   * @returns {() => void} 取消订阅
   */
  onEvent(listener) {
    if (typeof listener !== 'function') return () => {}
    const wrapped = (event) => {
      try {
        listener(event)
      } catch (error) {
        this.#logger.error('server-host 事件回调抛错', error)
      }
    }
    this.on('event', wrapped)
    return () => this.off('event', wrapped)
  }

  /**
   * 启动子进程并等待 ready 行。
   *
   * @returns {Promise<{ port: number, token: string, origin: string }>}
   */
  async start() {
    if (this.#disposed) throw new Error('ServerHost 已释放，不能再启动')
    if (this.#startPromise) return this.#startPromise
    if (this.#child) throw new Error('本地服务已在运行或正在启动')
    this.#startPromise = this.#startInternal().finally(() => {
      this.#startPromise = null
    })
    return this.#startPromise
  }

  async #startInternal() {
    const { serverEntry, env, cwd, startupTimeoutMs } = this.#options
    if (!existsSync(serverEntry)) {
      throw new Error(`本地服务入口不存在：${serverEntry}`)
    }
    this.#exited = false
    this.#exitInfo = null
    this.#stdoutBuffer = ''
    this.#stderrBuffer = ''
    this.#stderrTail = []
    this.#state = 'starting'
    this.#emitEvent('starting', { entry: serverEntry })

    const child = spawn(process.execPath, [serverEntry], {
      cwd,
      // 关键：Electron 二进制以纯 Node 模式运行服务脚本；显式覆盖宿主可能已设置的该变量。
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    })
    this.#child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#consumeStdout(chunk))
    child.stderr.on('data', (chunk) => this.#consumeStderr(chunk))
    child.on('error', (error) => {
      this.#failStart(new Error(`无法启动本地服务进程：${error.message}`))
    })
    child.on('exit', (code, signal) => this.#handleExit(code, signal))

    let settleResolve
    let settleReject
    const readyPromise = new Promise((resolve, reject) => {
      settleResolve = resolve
      settleReject = reject
    })
    this.#pendingStart = { resolve: settleResolve, reject: settleReject }
    const timer = setTimeout(() => {
      const tail = this.#stderrTailText()
      this.#failStart(
        new Error(`本地服务在 ${startupTimeoutMs}ms 内未输出 ready 行${tail ? `\n最近输出：\n${tail}` : ''}`),
      )
    }, startupTimeoutMs)
    try {
      return await readyPromise
    } finally {
      clearTimeout(timer)
      this.#pendingStart = null
    }
  }

  /**
   * 停止子进程：stdin EOF → （POSIX）SIGTERM → 宽限期 → 进程树强杀，总预算默认 10 秒。
   *
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<void>} 无论服务是否按时退出都会 resolve，不会抛出。
   */
  stop(options = {}) {
    if (this.#stopPromise) return this.#stopPromise
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_STOP_TIMEOUT_MS
    this.#stopPromise = this.#stopInternal(timeoutMs)
      .catch((error) => {
        this.#logger.warn(`停止本地服务时出错：${error?.message ?? error}`)
      })
      .finally(() => {
        this.#stopPromise = null
      })
    return this.#stopPromise
  }

  async #stopInternal(timeoutMs) {
    const child = this.#child
    if (!child) {
      this.#state = 'stopped'
      return
    }
    this.#stopping = true
    this.#state = 'stopping'
    this.#emitEvent('stopping', { pid: child.pid ?? null })

    const graceMs = Math.min(STOP_GRACE_MS, timeoutMs)
    const exitPromise = this.#waitForExit(graceMs)

    // 1) 优雅收尾：关闭 stdin（服务据此执行 dispose 并退出）；POSIX 再补 SIGTERM。
    try {
      child.stdin?.end()
    } catch {
      // ignore
    }
    if (process.platform !== 'win32') {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }

    let exited = await exitPromise
    if (!exited) {
      // 2) 兜底强杀：Windows 用 taskkill /T /F；POSIX 直接 SIGKILL。
      this.#logger.warn(`本地服务未在 ${graceMs}ms 内退出，执行强制结束（pid=${child.pid ?? 'unknown'}）`)
      await forceKillTree(child.pid)
      exited = await this.#waitForExit(Math.max(1_000, timeoutMs - graceMs))
      if (!exited) {
        this.#logger.error('本地服务强制结束后仍未退出，放弃等待（不再阻塞退出）')
      }
    }

    this.#stopping = false
    this.#state = 'stopped'
    this.#readyInfo = null
    this.#emitEvent('stopped', { forced: !exited, pid: child.pid ?? null })
  }

  /**
   * 以 Bearer Token 调用本地服务 API。
   *
   * @param {string} pathname 形如 /api/state
   * @param {{ method?: string, body?: unknown, timeoutMs?: number, headers?: Record<string,string> }} [options]
   * @returns {Promise<any>} JSON 响应体
   */
  async request(pathname, options = {}) {
    const info = this.#readyInfo
    if (!info) throw new Error('本地服务尚未就绪，无法发起 API 请求')
    const { method = 'GET', body, timeoutMs = 5_000, headers = {} } = options
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs))
    try {
      const response = await fetch(new URL(pathname, `${info.origin}/`), {
        method,
        headers: {
          authorization: `Bearer ${info.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      let payload = null
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = text
        }
      }
      if (!response.ok) {
        const detail =
          payload && typeof payload === 'object'
            ? (payload.error?.message ?? payload.error?.code ?? `HTTP ${response.status}`)
            : `HTTP ${response.status}`
        const error = new Error(`本地服务请求失败 ${method} ${pathname}：${detail}`)
        error.status = response.status
        error.payload = payload
        throw error
      }
      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 健康探活：GET /api/state。失败不抛错，结果写入 health().lastProbe。
   *
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ ok: boolean, at: number, durationMs: number, sessionState?: string, error?: string }>}
   */
  async probe(options = {}) {
    const startedAt = Date.now()
    if (!this.isReady()) {
      this.#lastProbe = {
        ok: false,
        at: startedAt,
        durationMs: 0,
        error: `本地服务未就绪（${this.#state}）`,
      }
      return this.#lastProbe
    }
    try {
      const payload = await this.request('/api/state', { timeoutMs: options.timeoutMs ?? 2_500 })
      const sessionState = payload?.session?.state ?? payload?.session?.status ?? 'unknown'
      this.#lastProbe = {
        ok: true,
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        sessionState,
      }
    } catch (error) {
      this.#lastProbe = {
        ok: false,
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        error: error?.message ?? String(error),
      }
    }
    return this.#lastProbe
  }

  /** 释放实例：停止子进程并移除所有监听器。 */
  async dispose() {
    this.#disposed = true
    await this.stop()
    this.removeAllListeners()
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────

  #consumeStdout(chunk) {
    // ready 之后的 stdout 不属于握手协议（服务约定日志走 stderr），按普通日志转发。
    if (this.#readyInfo) {
      this.#forwardLines(chunk, 'server:stdout')
      return
    }
    this.#stdoutBuffer += chunk
    let newlineIndex
    while ((newlineIndex = this.#stdoutBuffer.indexOf('\n')) >= 0) {
      const rawLine = this.#stdoutBuffer.slice(0, newlineIndex)
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1)
      const line = rawLine.replace(/\r$/, '')
      if (!line.trim()) continue
      if (this.#state === 'starting') {
        const ready = parseReadyLine(line)
        if (ready) {
          this.#handleReady(ready)
          continue
        }
      }
      this.#logger.info(`[server] ${line}`)
    }
    if (this.#stdoutBuffer.length > STDOUT_BUFFER_LIMIT) {
      this.#logger.warn(`server stdout 无换行缓冲超过 ${STDOUT_BUFFER_LIMIT} 字节，已丢弃`)
      this.#stdoutBuffer = ''
    }
  }

  #consumeStderr(chunk) {
    this.#stderrBuffer += chunk
    let newlineIndex
    while ((newlineIndex = this.#stderrBuffer.indexOf('\n')) >= 0) {
      const rawLine = this.#stderrBuffer.slice(0, newlineIndex)
      this.#stderrBuffer = this.#stderrBuffer.slice(newlineIndex + 1)
      const line = rawLine.replace(/\r$/, '')
      if (!line.trim()) continue
      this.#stderrTail.push(line)
      if (this.#stderrTail.length > 20) this.#stderrTail.shift()
      this.#logger.info(`[server] ${line}`)
    }
    if (this.#stderrBuffer.length > STDERR_BUFFER_LIMIT) {
      this.#logger.warn(`server stderr 无换行缓冲超过 ${STDERR_BUFFER_LIMIT} 字节，已丢弃`)
      this.#stderrBuffer = ''
    }
  }

  /** 最近 5 行 stderr，用于把启动失败原因带到上层错误信息里。 */
  #stderrTailText() {
    return this.#stderrTail.slice(-5).join('\n')
  }

  #forwardLines(chunk, tag) {
    this.#logger.info(`[${tag}] ${String(chunk).replace(/\r?\n$/, '')}`)
  }

  #handleReady(ready) {
    this.#readyInfo = ready
    this.#state = 'ready'
    this.#stdoutBuffer = ''
    const pid = this.#child?.pid ?? null
    this.#logger.info(`本地服务已就绪 origin=${ready.origin} pid=${pid ?? 'unknown'}`)
    this.#emitEvent('ready', { port: ready.port, origin: ready.origin, pid })
    const pending = this.#pendingStart
    this.#pendingStart = null
    pending?.resolve({ ...ready })
  }

  #failStart(error) {
    const pending = this.#pendingStart
    this.#pendingStart = null
    this.#logger.error(`本地服务启动失败：${error.message}`)
    this.#emitEvent('start-failed', { message: error.message })
    if (this.#child) {
      // 启动超时等场景：子进程可能还在跑，先结束它再定格为 crashed。
      void this.stop({ timeoutMs: 3_000 }).then(() => {
        this.#state = 'crashed'
      })
    } else {
      this.#state = 'crashed'
    }
    pending?.reject(error)
  }

  #handleExit(code, signal) {
    const wasStarting = this.#state === 'starting'
    const wasReady = Boolean(this.#readyInfo)
    this.#exited = true
    this.#exitInfo = { code, signal }
    this.#child = null
    this.#readyInfo = null
    this.#lastProbe = null
    if (wasStarting) {
      const tail = this.#stderrTailText()
      this.#failStart(
        new Error(
          `本地服务启动时退出（code=${code} signal=${signal}）${tail ? `\n最近输出：\n${tail}` : ''}`,
        ),
      )
      return
    }
    this.emit('exit-internal')
    if (this.#stopping) {
      this.#state = 'stopping'
      return
    }
    this.#state = 'crashed'
    this.#logger.error(`本地服务异常退出（code=${code} signal=${signal} wasReady=${wasReady}）`)
    this.#emitEvent('crashed', { code, signal, wasReady })
    this.emit('crashed', { code, signal, wasReady })
  }

  #waitForExit(timeoutMs) {
    if (this.#exited) return Promise.resolve(true)
    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.off('exit-internal', onExit)
        resolve(false)
      }, Math.max(0, timeoutMs))
      this.once('exit-internal', onExit)
    })
  }

  #emitEvent(type, detail = {}) {
    const event = { type, at: Date.now(), ...detail }
    this.emit('event', event)
    return event
  }
}

export default ServerHost
