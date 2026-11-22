/**
 * 流式下载到文件（协议 v2 的二进制产物通道）。
 *
 * 为什么不用 `httpText`：它把响应整体读进内存再解码，`maxBytes` 会在超大图/视频上
 * 直接截断；而 base64 JSON 还会再放大 33%。这里把响应体按块写盘，边下边算 sha256，
 * 并支持单段 Range 续传——隧道抖动时从断点继续，不必重下整张。
 *
 * 通道策略与 `server/net.js` 一致：先 fetch（Node 20 原生流式），失败再降级本机 curl。
 * curl 兜底用 `-C -` 续传、`-K` 0600 临时配置文件传敏感请求头（不进 argv），下载完成后
 * 统一读文件算 sha256，调用方拿到的返回形状与 fetch 通道一致。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { once } from 'node:events'

import { createLogger } from './log.js'

const log = createLogger({ scope: 'net-stream' })

const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

function errorType(error) {
  return String(error?.name ?? error?.code ?? (error instanceof Error ? 'Error' : typeof error))
}

function combineSignals(timeoutMs, signal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeoutSignal
  return AbortSignal.any([signal, timeoutSignal])
}

/** 转义 curl `-K` 配置值：去换行防注入，转义反斜杠与双引号。 */
function escapeCurlConfigValue(value) {
  return String(value ?? '')
    .replace(/[\r\n]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
}

function buildCurlHeaderConfig(headers) {
  const lines = []
  for (const [name, value] of Object.entries(headers ?? {})) {
    const cleanName = String(name ?? '').replace(/[\r\n:]/g, '').trim()
    if (!cleanName || value === undefined || value === null) continue
    lines.push(`header = "${escapeCurlConfigValue(`${cleanName}: ${value}`)}"`)
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

async function fileSizeOf(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

/** 把已有前缀喂进 hash，供续传时计算整文件 sha256。 */
async function hashExisting(path, hash) {
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk)
}

/** 追加/覆盖写入响应体，同时更新 hash 与进度回调。 */
async function writeBody(body, { destPath, append, hash, maxBytes, baseBytes = 0, onProgress }) {
  await mkdir(dirname(destPath), { recursive: true })
  const file = createWriteStream(destPath, { flags: append ? 'a' : 'w' })
  let written = 0
  try {
    for await (const chunk of body) {
      written += chunk.length
      if (baseBytes + written > maxBytes) {
        throw Object.assign(new Error(`产物超过体积上限（${Math.round(maxBytes / 1024 / 1024)}MB）`), {
          code: 'artifact_failed',
          retryable: false,
        })
      }
      hash.update(chunk)
      if (!file.write(chunk)) await once(file, 'drain')
      onProgress?.(baseBytes + written)
    }
    await new Promise((resolve, reject) => {
      file.end((error) => (error ? reject(error) : resolve()))
    })
  } catch (error) {
    file.destroy()
    throw error
  }
  return written
}

async function viaFetch(url, { headers, destPath, timeoutMs, signal, maxBytes, onProgress }) {
  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: combineSignals(timeoutMs, signal),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const error = new Error(`artifact ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`)
    error.status = res.status
    throw error
  }
  const hash = createHash('sha256')
  let prefix = 0
  if (res.status === 206) {
    // 只有调用方明确要求续传、且服务端真的回 206 时才保留已有前缀；
    // 服务端忽略 Range 回 200 时从头写，避免把整文件追加成两倍大。
    prefix = await fileSizeOf(destPath)
    if (prefix > 0) await hashExisting(destPath, hash)
  }
  const body = res.body ? Readable.fromWeb(res.body) : Readable.from([])
  const written = await writeBody(body, {
    destPath,
    append: prefix > 0,
    hash,
    maxBytes,
    baseBytes: prefix,
    onProgress,
  })
  return {
    status: res.status,
    bytes: prefix + written,
    sha256: hash.digest('hex'),
    etag: res.headers.get('etag') ?? null,
    via: 'fetch',
  }
}

async function viaCurl(ctx, url, { headers, destPath, timeoutMs, signal, maxBytes, onProgress }) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
  }
  const headerConfig = buildCurlHeaderConfig(headers)
  let tempDir = null
  const argv = [
    'curl',
    '-sS',
    '-L',
    '--fail',
    '--max-time',
    String(Math.ceil(timeoutMs / 1000)),
    '-o',
    destPath,
    // 断点续传：已有文件时 curl 自动从当前长度继续；服务端不支持 Range 时 curl 会重下。
    '-C',
    '-',
  ]
  if (headerConfig) {
    tempDir = await mkdtemp(join(tmpdir(), 'aigc-curl-'))
    const cfgPath = join(tempDir, 'headers.cfg')
    await writeFile(cfgPath, headerConfig, { encoding: 'utf8', mode: 0o600 })
    argv.push('-K', cfgPath)
  }
  argv.push(String(url))

  try {
    await mkdir(dirname(destPath), { recursive: true })
    const child = spawn('curl', argv, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    signal?.removeEventListener('abort', abort)
    if (code !== 0) {
      const error = new Error(`curl 下载失败（exit ${code}）：${stderr.trim().slice(-300)}`)
      error.code = 'artifact_failed'
      throw error
    }
    const bytes = await fileSizeOf(destPath)
    if (bytes > maxBytes) {
      await rm(destPath, { force: true })
      throw Object.assign(new Error(`产物超过体积上限（${Math.round(maxBytes / 1024 / 1024)}MB）`), {
        code: 'artifact_failed',
        retryable: false,
      })
    }
    onProgress?.(bytes)
    const hash = createHash('sha256')
    await hashExisting(destPath, hash)
    return { status: 200, bytes, sha256: hash.digest('hex'), etag: null, via: 'curl' }
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 下载 URL 到 `destPath`。
 *
 * 续传语义：调用方传 `resume: true` 时，若目标文件已存在则发 `Range: bytes=<size>-`；
 * 服务端回 206 才追加，回 200 视为不支持续传并从头覆盖。
 *
 * @param {object|null} ctx 宿主上下文（当前只用于日志；保留与 net.js 一致的签名）
 * @param {string|URL} url
 * @param {object} options
 * @param {string} options.destPath 目标文件（目录自动创建）
 * @param {object} [options.headers]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.resume]
 * @param {number} [options.maxBytes]
 * @param {(bytes:number)=>void} [options.onProgress]
 * @returns {Promise<{status:number,bytes:number,sha256:string,etag:string|null,via:string}>}
 */
export async function httpStream(ctx, url, options = {}) {
  const destPath = String(options.destPath ?? '')
  if (!destPath) throw new Error('httpStream 缺少 destPath')
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS
  const maxBytes = Number(options.maxBytes) || DEFAULT_MAX_BYTES
  const headers = { ...(options.headers ?? {}) }
  const existing = options.resume ? await fileSizeOf(destPath) : 0
  if (existing > 0) headers.range = `bytes=${existing}-`

  try {
    return await viaFetch(url, {
      headers,
      destPath,
      timeoutMs,
      signal: options.signal,
      maxBytes,
      onProgress: options.onProgress,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    // 416：本地文件已不小于远端资源（上次其实已下完），删掉重下一次，避免永久卡在坏前缀。
    if (error?.status === 416 && existing > 0) {
      await rm(destPath, { force: true }).catch(() => {})
      const retryHeaders = { ...headers }
      delete retryHeaders.range
      try {
        return await viaFetch(url, {
          headers: retryHeaders,
          destPath,
          timeoutMs,
          signal: options.signal,
          maxBytes,
          onProgress: options.onProgress,
        })
      } catch (retryError) {
        if (options.signal?.aborted) throw retryError
        error = retryError
      }
    }
    // 401/404 等 HTTP 语义错误不降级：换通道只会得到同一个结果。
    if (error?.status && error.status !== 408 && error.status !== 429 && error.status < 500) throw error
    log.warn('fetch 下载失败，降级 curl', `${errorType(error)}：${String(error?.message ?? error).slice(0, 200)}`)
    return viaCurl(ctx, url, {
      headers: options.headers ?? {},
      destPath,
      timeoutMs,
      signal: options.signal,
      maxBytes,
      onProgress: options.onProgress,
    })
  }
}
