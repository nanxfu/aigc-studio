/**
 * 宿主适配层（Standalone Host Context）。
 *
 * 原插件运行在 DSH 里，业务模块只依赖 4 个宿主能力：
 *   - `ctx.get(name)`：读宿主服务（workingDirectory / llm / agentDefaultModel）；
 *   - `ctx.effect(fn, label)`：装配期立即执行 fn()，把返回的 disposer 收进统一卸载队列；
 *   - `ctx.webServer`：注册精确路由（`register({kind,path,handler})`）与 `getOrigin()`；
 *   - `ctx.subprocess`：解析可执行文件 + 起子进程（含输出截断、超时与进程树强杀）；
 *   - `ctx.tools`：Agent 工具注册表（Phase 1 由 `server/agent/tools.js` 提供）。
 *
 * 本文件是「剥离 DSH 的唯一改动点」：形状与 `test/helpers/fake-context.mjs` 一致，
 * 其余 server/** 模块不需要感知宿主差异（见 docs/MIGRATION_SPEC.md §3）。
 */

import { spawn as spawnProcess, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

import { createLogger } from './log.js'

const execFileAsync = promisify(execFile)

const defaultLog = createLogger({ scope: 'host' })

/** `resolveExecutable` 的定位命令超时：本机 which/where 正常在毫秒级完成。 */
const LOCATE_TIMEOUT_MS = 10_000
/** 默认单路输出上限；调用方通过 stdio.stdout.maxBytes 覆盖。 */
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
/** 默认 SIGTERM → 强杀的宽限期。 */
const DEFAULT_GRACE_MS = 2000

// ---- 统一卸载队列 -------------------------------------------------------

/**
 * DisposableRegistry：收口 `ctx.effect` 返回的 disposer。
 *
 * 卸载按「后注册先卸载」顺序执行；单个 disposer 抛错或超时不影响其余，
 * 整体最多等 `timeoutMs`（默认 10 秒，与 docs/MIGRATION_SPEC.md §2.2 的退出预算一致）。
 */
export class DisposableRegistry {
  constructor({ timeoutMs = 10_000, log = defaultLog } = {}) {
    this.timeoutMs = timeoutMs
    this.log = log
    /** @type {Array<{ disposer: Function, label: string }>} */
    this.items = []
    this.disposed = false
  }

  /** 登记一个 disposer；重复登记同一函数会去重（避免同一资源被卸载两次）。 */
  add(disposer, label = '') {
    if (typeof disposer !== 'function') return disposer
    if (this.disposed) {
      // 卸载之后才登记的清理函数：立即执行，避免资源泄漏。
      this.runOne(disposer, label)
      return disposer
    }
    this.items.push({ disposer, label })
    return disposer
  }

  get size() {
    return this.items.length
  }

  async runOne(disposer, label) {
    try {
      await disposer()
    } catch (error) {
      this.log.warn(`dispose_failed label=${label || 'unknown'} detail=${String(error?.message ?? error).slice(0, 300)}`)
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    const pending = this.items.splice(0).reverse()
    if (pending.length === 0) return
    const runAll = Promise.allSettled(pending.map((item) => this.runOne(item.disposer, item.label)))
    let timer = null
    const timeout = new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout('timeout'), this.timeoutMs)
      timer.unref?.()
    })
    const result = await Promise.race([runAll, timeout])
    if (timer) clearTimeout(timer)
    if (result === 'timeout') {
      this.log.warn(`dispose_timeout pending=${pending.length} budgetMs=${this.timeoutMs}`)
    }
  }
}

// ---- 子进程：输出捕获 ---------------------------------------------------

/** 单路子进程输出：保留首部 maxBytes，超出部分丢弃并打上明确的截断标记。 */
export function createOutputCapture(maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_OUTPUT_BYTES
  let buffer = Buffer.alloc(0)
  let truncated = false
  let totalBytes = 0

  return {
    maxBytes: limit,
    get bytes() {
      return totalBytes
    },
    get truncated() {
      return truncated
    },
    push(chunk) {
      if (!chunk || chunk.length === 0) return
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      totalBytes += data.length
      if (truncated) return
      const room = limit - buffer.length
      if (data.length <= room) {
        buffer = Buffer.concat([buffer, data])
        return
      }
      if (room > 0) buffer = Buffer.concat([buffer, data.subarray(0, room)])
      truncated = true
    },
    /** 读取从 offset 起的内容（offset 按字符近似；当前调用方都传 0）。 */
    readFrom(offset = 0) {
      const text = buffer.toString('utf8')
      const marker = truncated ? `\n[output truncated: total ${totalBytes} bytes, kept ${buffer.length}]` : ''
      const sliced = offset > 0 ? text.slice(offset) : text
      return { text: `${sliced}${marker}`, truncated, bytes: buffer.length, nextOffset: text.length }
    },
  }
}

// ---- 子进程：可执行文件解析 --------------------------------------------

/**
 * 解析可执行文件的绝对路径：Windows 走 `where`，其它平台走 `which`；找不到时 reject。
 *
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function resolveExecutable(name) {
  const command = typeof name === 'string' ? name.trim() : ''
  if (!command) throw new Error('可执行文件名不能为空')
  if (command.includes('\0')) throw new Error('可执行文件名含有非法字符')

  // 已经是绝对 / 相对带分隔符的路径：直接校验存在性，不走 PATH 查找。
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const absolute = resolve(command)
    if (existsSync(absolute)) return absolute
    throw new Error(`找不到可执行文件：${command}`)
  }

  const locator = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(locator, [command], {
      windowsHide: true,
      timeout: LOCATE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    })
    const found = String(stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '')
    if (found && existsSync(found)) return found
    throw new Error(`${locator} 未返回有效路径`)
  } catch (error) {
    throw new Error(`找不到可执行文件：${command}（${String(error?.message ?? error).slice(0, 200)}）`)
  }
}

// ---- 子进程：spawn ------------------------------------------------------

/** Windows 进程树强杀：`taskkill /pid <pid> /T /F`（子进程可能再拉起子进程）。 */
function forceKillTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.on('error', () => {})
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {}
}

function normalizeStdio(stdio) {
  const input = stdio && typeof stdio === 'object' ? stdio : {}
  const readChannel = (channel, fallbackBytes) => {
    if (channel === 'ignore') return { mode: 'ignore', maxBytes: fallbackBytes }
    if (channel === 'pipe') return { mode: 'pipe', maxBytes: fallbackBytes }
    if (channel && typeof channel === 'object') {
      return { mode: 'pipe', maxBytes: Number(channel.maxBytes) || fallbackBytes }
    }
    return { mode: 'pipe', maxBytes: fallbackBytes }
  }
  return {
    stdin: input.stdin === 'pipe' ? 'pipe' : 'ignore',
    stdout: readChannel(input.stdout, DEFAULT_MAX_OUTPUT_BYTES),
    stderr: readChannel(input.stderr, DEFAULT_MAX_OUTPUT_BYTES),
  }
}

/**
 * 起一个受控子进程。
 *
 * 兼容两种入参形状（二者等价，调用方按原插件写法传 argv）：
 *   - `{ argv: [exe, ...args] }`（既有调用方 kaggle.js / net.js / routes/files.js）；
 *   - `{ command | exe, args: [...] }`（docs/MIGRATION_SPEC.md §3.2 的描述形状）。
 *
 * 句柄暴露 `done` / `wait()` / `kill()` / `stdin` / `stdout` / `stderr` / `collected`。
 * `done` 在进程退出时 resolve `{ exitCode, signal }`；因 signal 中止或超时被强杀时
 * reject（调用方据此区分「正常退出码非 0」与「超时/取消」）。
 *
 * @param {object} options
 * @param {string[]} [options.argv] 完整命令行（首项是可执行文件）
 * @param {string} [options.command] 可执行文件名（与 args 搭配）
 * @param {string} [options.exe] 兼容 command 的别名
 * @param {string[]} [options.args]
 * @param {string} [options.cwd] 工作目录，缺省用宿主进程当前目录（拒绝空值）
 * @param {object} [options.env] 追加 / 覆盖的环境变量
 * @param {{ stdin?: 'ignore'|'pipe', stdout?: object|'ignore', stderr?: object|'ignore' }} [options.stdio]
 * @param {number} [options.graceMs] SIGTERM 后等待强杀的宽限期
 * @param {number} [options.timeoutMs] 整体超时（内部 AbortController）
 * @param {AbortSignal} [options.signal] 外部取消信号
 * @param {Function} [options.onSpawn] 进程起来后的回调（测试注入用）
 */
export function spawnSubprocess(options = {}) {
  const argv = Array.isArray(options.argv) && options.argv.length > 0
    ? options.argv.map((item) => String(item))
    : [String(options.command ?? options.exe ?? ''), ...(Array.isArray(options.args) ? options.args : [])].filter(Boolean)
  if (argv.length === 0 || !argv[0]) throw new Error('spawn 需要 argv 或 command')

  const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : process.cwd()
  const stdio = normalizeStdio(options.stdio)
  const graceMs = Number.isFinite(options.graceMs) && options.graceMs >= 0 ? options.graceMs : DEFAULT_GRACE_MS
  const env = options.env && typeof options.env === 'object' ? { ...process.env, ...options.env } : process.env

  const stdoutCapture = createOutputCapture(stdio.stdout.maxBytes)
  const stderrCapture = createOutputCapture(stdio.stderr.maxBytes)
  const child = spawnProcess(argv[0], argv.slice(1), {
    cwd,
    env,
    windowsHide: true,
    stdio: [stdio.stdin, stdio.stdout.mode, stdio.stderr.mode],
  })

  let abortedBySignal = false
  let abortReason = null
  let killTimer = null
  let timeoutTimer = null
  let settled = false
  const onAbort = (reason) => {
    if (abortedBySignal) return
    abortedBySignal = true
    try {
      child.kill('SIGTERM')
    } catch {}
    killTimer = setTimeout(() => forceKillTree(child), graceMs)
    killTimer.unref?.()
    // 取消原因由 done 的 rejection 携带，调用方据此区分「超时 / 取消」。
    abortReason = reason
  }

  const externalSignal = options.signal
  if (externalSignal) {
    if (externalSignal.aborted) onAbort(externalSignal.reason)
    else externalSignal.addEventListener('abort', () => onAbort(externalSignal.reason), { once: true })
  }
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => onAbort(new Error(`子进程超时（${options.timeoutMs}ms）`)), options.timeoutMs)
    timeoutTimer.unref?.()
  }

  if (child.stdout) child.stdout.on('data', (chunk) => stdoutCapture.push(chunk))
  if (child.stderr) child.stderr.on('data', (chunk) => stderrCapture.push(chunk))

  const done = new Promise((resolveDone, rejectDone) => {
    const finish = (payload) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (abortedBySignal) {
        rejectDone(Object.assign(new Error(payload.error?.message ?? '子进程已被中止'), { code: 'ABORTED', ...payload }))
        return
      }
      resolveDone(payload)
    }
    child.on('error', (error) => {
      // 起进程失败（ENOENT / EACCES）：done 以错误结束，调用方按 spawn failure 处理。
      finish({ exitCode: -1, signal: null, error })
    })
    child.on('close', (code, signal) => {
      finish({ exitCode: typeof code === 'number' ? code : -1, signal: signal ?? null })
    })
  })
  // 调用方可能只关心输出、不 await done；避免未处理拒绝告警（既有调用方都会 catch）。
  done.catch(() => {})

  options.onSpawn?.(child)

  return {
    pid: child.pid ?? -1,
    child,
    done,
    /** docs/MIGRATION_SPEC.md §3.2 描述形状的别名。 */
    wait() {
      return done
    },
    kill(signal = 'SIGTERM') {
      try {
        return child.kill(signal)
      } catch {
        return false
      }
    },
    get exitCode() {
      return typeof child.exitCode === 'number' ? child.exitCode : null
    },
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    collected: { stdout: stdoutCapture, stderr: stderrCapture },
  }
}

/** 组装 ctx.subprocess 服务对象。 */
export function createSubprocessService({ log = defaultLog } = {}) {
  return {
    resolveExecutable,
    spawn(options) {
      try {
        return spawnSubprocess(options)
      } catch (error) {
        log.debug('spawn 失败', String(error?.message ?? error).slice(0, 300))
        throw error
      }
    },
  }
}

// ---- 路由注册表（ctx.webServer） ---------------------------------------

/**
 * 极简精确路由表：`Map<path, { path, handler }>`。
 *
 * 与 DSH webServer 的语义保持一致：同一 path 重复 register 直接抛错（
 * "duplicate exact route"）；返回的 disposer 用于卸载时注销路由。
 */
export function createWebServerRegistry() {
  /** @type {Map<string, { path: string, handler: Function }>} */
  const routes = new Map()
  let origin = ''

  return {
    register(route) {
      const kind = route?.kind ?? 'exact'
      if (kind !== 'exact') throw new Error(`不支持的路由类型：${kind}`)
      const path = typeof route?.path === 'string' ? route.path.trim() : ''
      if (!path.startsWith('/')) throw new Error(`路由 path 必须以 / 开头：${String(route?.path)}`)
      if (typeof route?.handler !== 'function') throw new Error(`路由 ${path} 缺少 handler`)
      if (routes.has(path)) throw new Error(`duplicate exact route: ${path}`)
      const entry = { path, handler: route.handler }
      routes.set(path, entry)
      return () => {
        if (routes.get(path) === entry) routes.delete(path)
      }
    },
    getOrigin() {
      return origin
    },
    /** 由 http 层在 listen 成功后写入实际地址（不属于 DSH 公开契约）。 */
    setOrigin(value) {
      origin = typeof value === 'string' ? value : ''
    },
    /** 供 http-server 精确分发使用的只读索引。 */
    entries() {
      return routes
    },
  }
}

// ---- 工具注册表兜底 -----------------------------------------------------

/** ctx.tools 的极简兜底实现；装配层通常会注入 `server/agent/tools.js` 的注册表。 */
function createFallbackToolRegistry() {
  const tools = new Map()
  return {
    register(tool) {
      if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) throw new Error('工具必须有 name')
      tools.set(tool.name, tool)
      return () => {
        if (tools.get(tool.name) === tool) tools.delete(tool.name)
      }
    },
    list() {
      return [...tools.values()]
    },
    get(name) {
      return tools.get(name) ?? null
    },
  }
}

// ---- 组装 ---------------------------------------------------------------

/** 读取 LLM 服务的「当前选中模型」；兼容 currentSelection / getSelection 两种命名。 */
function selectionOf(llm) {
  if (!llm) return null
  try {
    if (typeof llm.getSelection === 'function') return llm.getSelection()
    if (typeof llm.currentSelection === 'function') return llm.currentSelection()
  } catch (error) {
    defaultLog.warn('读取当前模型选择失败', String(error?.message ?? error).slice(0, 200))
  }
  return null
}

/**
 * 创建 Standalone 宿主上下文。
 *
 * @param {object} [options]
 * @param {{ current: () => string | null }} [options.workspaceManager] 工作区管理器
 * @param {object} [options.llm] LLM 服务（ctx.get('llm')）
 * @param {object} [options.tools] Agent 工具注册表（ctx.tools）；缺省用内存兜底实现
 * @param {object} [options.subprocess] 子进程服务；缺省用 createSubprocessService()
 * @param {object} [options.webServer] 路由注册表；缺省用 createWebServerRegistry()
 * @param {DisposableRegistry} [options.registry] 卸载队列
 * @param {object} [options.log]
 */
export function createHostContext(options = {}) {
  const log = options.log ?? defaultLog
  const registry = options.registry ?? new DisposableRegistry({ log })
  const subprocess = options.subprocess ?? createSubprocessService({ log })
  const webServer = options.webServer ?? createWebServerRegistry()
  const tools = options.tools ?? createFallbackToolRegistry()
  const workspaceManager = options.workspaceManager ?? null
  const llm = options.llm ?? null

  const ctx = {
    get(name) {
      if (name === 'workingDirectory') {
        const current = workspaceManager?.current?.() ?? null
        return current ? { defaultDirectory: current } : undefined
      }
      if (name === 'llm') return llm ?? null
      if (name === 'agentDefaultModel') {
        if (!llm) return undefined
        return { currentSelection: () => selectionOf(llm) }
      }
      return undefined
    },
    effect(fn, label) {
      if (typeof fn !== 'function') throw new TypeError('ctx.effect 需要函数')
      const disposer = fn()
      if (typeof disposer === 'function') registry.add(disposer, String(label ?? ''))
      return disposer
    },
    webServer,
    subprocess,
    tools,
  }

  return {
    ctx,
    registry,
    webServer,
    subprocess,
    tools,
    /** 统一卸载：按注册的逆序执行全部 disposer（含路由注销、会话/队列/日志收尾）。 */
    async dispose() {
      await registry.dispose()
    },
  }
}
