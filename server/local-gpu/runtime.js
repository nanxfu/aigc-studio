/**
 * `sd-server`（stable-diffusion.cpp）本机进程托管。
 *
 * 职责边界：
 *  - 只管理一个本机 GPU 常驻进程；JobQueue 仍然串行，不会并发打爆显存；
 *  - 只绑定 127.0.0.1 + 随机端口，不向局域网暴露；
 *  - 进程异常退出最多自动重启 2 次，之后把错误留给 /health 让会话状态机收敛；
 *  - 退出顺序：取消在途任务 → 常规终止 → 3 秒后杀进程树；尽力而为，绝不阻塞应用退出；
 *  - 低优先级（BelowNormal）与 sd-server 自带的 weight TTL 共同降低桌面卡顿与常驻内存。
 *
 * @module server/local-gpu/runtime
 */

import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { createLogger } from '../log.js'
import { probeLocalGpu } from './probe.js'

const execFileAsync = promisify(execFile)
const defaultLog = createLogger({ scope: 'local-gpu' })

const START_TIMEOUT_MS = 60000
const HEALTH_TIMEOUT_MS = 4000
const MAX_RESTARTS = 2
const LOG_LIMIT = 500

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** 行缓冲日志环：Host 日志抽屉按游标增量读取。 */
class LineRing {
  constructor(limit = LOG_LIMIT) {
    this.limit = limit
    this.lines = []
    this.total = 0
    this.pending = ''
  }

  push(chunk) {
    const text = this.pending + String(chunk ?? '')
    const parts = text.split(/\r?\n/)
    this.pending = parts.pop() ?? ''
    for (const line of parts) {
      this.lines.push(line)
      this.total += 1
    }
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit)
  }

  flush() {
    if (!this.pending) return
    this.lines.push(this.pending)
    this.total += 1
    this.pending = ''
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit)
  }

  since(cursor = 0) {
    const value = Number(cursor)
    const start = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
    const base = this.total - this.lines.length
    const offset = Math.max(0, start - base)
    return { lines: this.lines.slice(offset), next: this.total }
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

async function setBelowNormal(pid, log) {
  if (process.platform !== 'win32' || !pid) return
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)}).PriorityClass = 'BelowNormal'`],
      { timeout: 5000, windowsHide: true },
    )
  } catch (error) {
    log?.debug?.(`设置 BelowNormal 优先级失败（忽略）：${error?.message ?? error}`)
  }
}

async function killTree(child, log) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        timeout: 8000,
        windowsHide: true,
      })
      return
    }
    child.kill('SIGKILL')
  } catch (error) {
    log?.debug?.(`结束 sd-server 进程树失败（忽略）：${error?.message ?? error}`)
  }
}

/**
 * 命令行参数（纯函数，离线测试直接断言）。
 *
 * 说明：`--params-backend disk` 是本机 32 GB / 空闲 4 GB 机型的实测安全默认值；
 * 空闲内存充足时可在 local-gpu.json 的 extraArgs 里改用 `--offload-to-cpu`。
 */
export function buildServerArgs(config, { port }) {
  const limitSeconds = clampInt(config?.idleTimeoutSec, 60, 3600, 300)
  const threads = clampInt(config?.threads, 0, 128, 0)
  const args = [
    '-m',
    config.modelPath,
    '--listen-ip',
    '127.0.0.1',
    '--listen-port',
    String(port),
    '--params-backend',
    config.paramsBackend === 'cpu' ? 'cpu' : 'disk',
    '--weight-staging-ttl',
    String(limitSeconds),
    '--weight-residency-ttl',
    String(limitSeconds),
    '--log-level',
    'info',
  ]
  if (config.vaePath) args.push('--vae', config.vaePath)
  if (config.vaeTiling !== false) args.push('--vae-tiling')
  if (threads > 0) args.push('-t', String(threads))
  if (Array.isArray(config.extraArgs)) args.push(...config.extraArgs)
  return args
}

/**
 * 一个配置对应一个常驻进程；provider 重建不会重复拉起。
 */
export class LocalGpuRuntime {
  constructor(config, {
    log = defaultLog,
    statePath = '',
    probe = probeLocalGpu,
    env = process.env,
    startTimeoutMs = START_TIMEOUT_MS,
  } = {}) {
    this.config = config
    this.log = log
    this.statePath = statePath
    this.probe = probe
    this.env = env
    this.startTimeoutMs = startTimeoutMs
    this.child = null
    this.port = null
    this.baseUrl = ''
    this.status = 'idle'
    this.lastError = null
    this.gpu = null
    this.devices = []
    this.startedAt = null
    this.restarts = 0
    this.startPromise = null
    this.restartTimer = null
    this.logs = new LineRing()
    this.stopping = false
  }

  get alive() {
    return Boolean(this.child && this.child.exitCode === null)
  }

  get pid() {
    return this.child?.pid ?? null
  }

  appendLog(stream) {
    return (chunk) => {
      this.logs.push(chunk)
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) this.log?.[stream === 'stderr' ? 'warn' : 'info']?.(`sd-server: ${line.slice(0, 800)}`)
      }
    }
  }

  async probeDevice() {
    const result = await this.probe(this.config, { env: this.env })
    if (!result.ok) throw new Error(result.errors?.[0] ?? '本机 GPU 探测失败')
    this.gpu = result.gpu
    this.devices = result.devices
    return result
  }

  async start() {
    if (this.alive && this.status === 'ready') return this.info()
    if (this.startPromise) return this.startPromise
    if (this.alive) await this.stop()
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async startInternal() {
    this.stopping = false
    this.status = 'starting'
    this.lastError = null
    const probeResult = await this.probeDevice()
    const port = await findFreePort()
    const args = buildServerArgs(this.config, { port })
    this.status = 'loading'
    this.log?.info?.(
      `spawn_local_gpu server=${this.config.serverPath} model=${this.config.modelPath} ` +
        `port=${port} gpu=${probeResult.gpu?.name ?? 'unknown'}`,
    )
    const child = spawn(this.config.serverPath, args, {
      cwd: dirname(this.config.serverPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.config.env ?? {}) },
    })
    this.child = child
    this.port = port
    this.baseUrl = `http://127.0.0.1:${port}`
    this.startedAt = new Date().toISOString()
    child.stdout?.on('data', this.appendLog('stdout'))
    child.stderr?.on('data', this.appendLog('stderr'))
    child.once('error', (error) => {
      this.lastError = error?.message ?? String(error)
      this.status = 'error'
      if (this.child === child) this.child = null
      this.log?.warn(`sd-server 启动失败：${this.lastError}`)
    })
    child.once('exit', (code, signal) => {
      this.logs.flush()
      this.child = null
      if (this.stopping) {
        this.status = 'stopped'
        return
      }
      this.status = 'error'
      this.lastError = `sd-server 意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`
      this.log?.warn(this.lastError)
      if (this.restarts < MAX_RESTARTS && !this.restartTimer) {
        this.restarts += 1
        this.log?.warn(`本机 GPU 进程自动重启 ${this.restarts}/${MAX_RESTARTS}`)
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          void this.start().catch((error) => {
            this.lastError = error?.message ?? String(error)
          })
        }, 1200)
        this.restartTimer.unref?.()
      }
    })
    await setBelowNormal(child.pid, this.log)
    await this.waitUntilServing()
    this.status = 'ready'
    await this.writeState()
    return this.info()
  }

  async waitUntilServing() {
    const deadline = Date.now() + this.startTimeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      if (!this.alive) throw new Error(this.lastError ?? 'sd-server 进程已退出')
      try {
        const payload = await this.requestJson('/sdcpp/v1/models/status', { timeoutMs: 3000 })
        if (payload && payload.state === 'configured') return payload
        lastError = payload?.error ?? '模型尚未配置'
      } catch (error) {
        lastError = error?.message ?? String(error)
      }
      await sleep(350)
    }
    throw new Error(`sd-server 启动超时：${lastError ?? '未知错误'}`)
  }

  async writeState() {
    if (!this.statePath) return
    try {
      await writeFile(
        this.statePath,
        JSON.stringify({
          pid: this.pid,
          port: this.port,
          serverPath: this.config.serverPath,
          modelPath: this.config.modelPath,
          startedAt: this.startedAt,
        }),
        { mode: 0o600 },
      )
    } catch (error) {
      this.log?.debug?.(`写入 local-gpu-runtime.json 失败（忽略）：${error?.message ?? error}`)
    }
  }

  async clearState() {
    if (!this.statePath) return
    await rm(this.statePath, { force: true }).catch(() => {})
  }

  async requestJson(pathname, { method = 'GET', body = null, timeoutMs = 30000, signal = undefined } = {}) {
    if (!this.baseUrl) throw new Error('sd-server 尚未启动')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('sd-server 请求超时')), timeoutMs)
    const onAbort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const text = await response.text()
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        throw new Error(`sd-server 返回了非 JSON 响应（${response.status}）`)
      }
      if (!response.ok) {
        const message = payload?.error?.message ?? payload?.error ?? payload?.message ?? `HTTP ${response.status}`
        throw Object.assign(new Error(String(message)), { status: response.status, payload })
      }
      return payload
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async health() {
    if (!this.alive) {
      return { ok: false, phase: this.status === 'starting' || this.status === 'loading' ? 'loading' : 'error', error: this.lastError }
    }
    try {
      const payload = await this.requestJson('/sdcpp/v1/models/status', { timeoutMs: HEALTH_TIMEOUT_MS })
      if (payload?.state === 'configured') return { ok: true, phase: 'ready', payload }
      return { ok: false, phase: 'loading', error: payload?.error ?? '模型尚未配置' }
    } catch (error) {
      return { ok: false, phase: this.status === 'ready' ? 'error' : 'loading', error: error?.message ?? String(error) }
    }
  }

  async submit(payload, { signal = undefined } = {}) {
    await this.start()
    return this.requestJson('/sdcpp/v1/img_gen', {
      method: 'POST',
      body: payload,
      timeoutMs: 60000,
      signal,
    })
  }

  async job(id) {
    if (!this.alive) throw new Error(this.lastError ?? 'sd-server 未运行')
    return this.requestJson(`/sdcpp/v1/jobs/${encodeURIComponent(id)}`, { timeoutMs: 10000 })
  }

  async cancel(id) {
    if (!this.alive) return false
    try {
      await this.requestJson(`/sdcpp/v1/jobs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        timeoutMs: 5000,
      })
      return true
    } catch {
      return false
    }
  }

  info() {
    return {
      pid: this.pid,
      port: this.port,
      endpointUrl: this.baseUrl,
      gpu: this.gpu,
      devices: this.devices,
      modelId: this.config.modelPath,
      startedAt: this.startedAt,
      status: this.status,
    }
  }

  logsSince(cursor = 0) {
    this.logs.flush()
    return this.logs.since(cursor)
  }

  async stop() {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child) {
      this.status = 'stopped'
      await this.clearState()
      return { ok: true }
    }
    try {
      // 尽力而为的优雅退出：sd-server 没有公开 shutdown 路由，先常规终止。
      child.kill('SIGTERM')
      const exited = await waitForExit(child, 3000)
      if (!exited) await killTree(child, this.log)
    } catch (error) {
      this.log?.warn(`停止本机 GPU 进程失败：${error?.message ?? error}`)
    }
    this.child = null
    this.status = 'stopped'
    await this.clearState()
    return { ok: true }
  }
}

/** 运行时单例：同一配置只保留一个 sd-server。 */
const runtimes = new Map()

export function getLocalGpuRuntime(config, options = {}) {
  const key = [
    config?.serverPath,
    config?.modelPath,
    config?.vaePath,
    config?.paramsBackend,
    config?.threads,
    config?.idleTimeoutSec,
    config?.vaeTiling === false ? '0' : '1',
    Array.isArray(config?.extraArgs) ? config.extraArgs.join('\u0000') : '',
    options.statePath ?? '',
  ].join('|')
  const existing = runtimes.get(key)
  if (existing) return existing
  const runtime = new LocalGpuRuntime(config, options)
  runtimes.set(key, runtime)
  return runtime
}

export async function disposeLocalGpuRuntimes() {
  const all = [...runtimes.values()]
  runtimes.clear()
  await Promise.all(all.map((runtime) => runtime.stop().catch(() => {})))
}

export const __test = { LineRing, findFreePort, waitForExit, setBelowNormal }

