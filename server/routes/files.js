/**
 * 本地产物相关路由：图片读取（含 HEAD / Range）、在文件管理器里打开产物目录。
 *
 * 路径与方法取自 `shared/contract.js` 的 ROUTES（唯一来源）。
 *
 * `/api/file` 用 `fs.createReadStream` 流式响应（不再整文件读进内存），并支持单段
 * `Range: bytes=...`（Phase 2 的视频/大图按需读取提前铺路）。鉴权不再依赖本路由：
 * Bearer 与同源 Session Cookie 的判定都在 `server/http-server.js` 统一完成。
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

import { ROUTES, TIMEOUTS } from '../../shared/contract.js'
import { sendError, sendJson } from '../http.js'
import { contentTypeOf, resolveOutputDir, resolveOutputPath } from '../paths.js'
import { parseQuery, readBodyOr } from '../route-kit.js'

/** 产物不可变：允许浏览器与 Electron 长期缓存，省掉重复读取。 */
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * 解析单段 `Range` 头（RFC 9110 §14）。
 *
 * 返回三种结果：
 *  - `full`：没有 Range，或语法无法识别（多段范围 / 非 bytes 单位 / 空值）——
 *    按规范忽略 Range，返回 200 全量；
 *  - `partial`：可满足的范围，返回 206 + `content-range`；
 *  - `unsatisfiable`：语法合法但范围越界（起点超出文件末尾、末位小于首位、`-0`），返回 416。
 *
 * 末位超出文件长度时按规范截断到文件末尾（`bytes=0-9999999` → 整个文件）。
 *
 * @param {unknown} header
 * @param {number} size 文件字节数
 * @returns {{ kind: 'full' } | { kind: 'partial', start: number, end: number } | { kind: 'unsatisfiable' }}
 */
export function parseRangeHeader(header, size) {
  if (typeof header !== 'string' || !header.trim()) return { kind: 'full' }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim().replace(/\s+/g, ''))
  // 多段范围（`bytes=0-1,3-4`）与其它单位（`items=0-1`）不实现，按「忽略 Range」处理。
  if (!match) return { kind: 'full' }
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return { kind: 'full' }
  if (size === 0) return { kind: 'unsatisfiable' }

  if (rawStart === '') {
    // 后缀范围：`bytes=-N` 表示最后 N 字节；N=0 不可满足，N 超过文件长度时取整个文件。
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' }
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' }
  if (rawEnd === '') return { kind: 'partial', start, end: size - 1 }
  const requestedEnd = Number(rawEnd)
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return { kind: 'unsatisfiable' }
  return { kind: 'partial', start, end: Math.min(requestedEnd, size - 1) }
}

/**
 * 流式发送产物文件（支持 Range / HEAD）。
 *
 * 响应头约定：
 *  - 200 全量：`content-length: size`；
 *  - 206 部分：`content-range: bytes <start>-<end>/<size>` + `content-length`；
 *  - 416 越界：`content-range: bytes *\/<size>` + `content-length: 0`；
 *  - 200/206/416 都带 `accept-ranges: bytes` 与长期缓存头。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} absolute 已经过 `resolveOutputPath` 校验的绝对路径
 * @param {{ warn: Function, debug: Function }} log
 */
async function sendOutputFile(req, res, absolute, log) {
  // resolveOutputPath 已 stat 过一次，这里只补流式发送需要的大小（文件可能被并发删除）。
  const info = await stat(absolute).catch(() => null)
  if (!info?.isFile()) return sendError(res, 404, 'not_found', '文件读取失败')
  const size = info.size
  const acceptHeaders = {
    'content-type': contentTypeOf(absolute),
    'accept-ranges': 'bytes',
    'cache-control': CACHE_CONTROL,
  }

  const range = parseRangeHeader(req.headers.range, size)
  if (range.kind === 'unsatisfiable') {
    res.writeHead(416, {
      ...acceptHeaders,
      'content-range': `bytes */${size}`,
      'content-length': '0',
    })
    return res.end()
  }

  const partial = range.kind === 'partial'
  const start = partial ? range.start : 0
  const end = partial ? range.end : size - 1
  const length = size === 0 ? 0 : end - start + 1
  const headers = { ...acceptHeaders, 'content-length': String(length) }
  if (partial) headers['content-range'] = `bytes ${start}-${end}/${size}`
  res.writeHead(partial ? 206 : 200, headers)

  // HEAD 只回头部；空文件没有可发送的字节。
  if (req.method === 'HEAD' || length === 0) return res.end()

  const stream = createReadStream(absolute, { start, end })
  stream.on('error', (error) => {
    // 响应头已发出，无法再改成 404：中断连接让客户端看到失败，并留一条 warn。
    log.warn('产物文件流式读取中断', error?.message ?? error)
    res.destroy(error)
  })
  // 客户端提前断开（例如 <img> 被取消）时释放文件句柄。
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/**
 * 在系统文件管理器里打开产物目录。
 *
 * explorer.exe 打开目录后往往以非 0 退出，这里只关心进程能否起来，
 * 不把退出码当失败；等待最多 TIMEOUTS.revealWaitMs，避免请求被文件管理器拖住。
 */
async function revealFolder(ctx, dir, log) {
  const platform = process.platform
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
  const exe = await ctx.subprocess.resolveExecutable(command)
  const handle = ctx.subprocess.spawn({
    argv: [exe, dir],
    cwd: dir,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 4 * 1024 },
      stderr: { maxBytes: 4 * 1024 },
    },
    graceMs: 2000,
  })
  const done =
    handle && typeof handle.done?.then === 'function'
      ? handle.done.catch((error) => {
          log.debug('文件管理器进程异常退出（忽略）', error?.message ?? error)
          return null
        })
      : Promise.resolve(null)
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, TIMEOUTS.revealWaitMs))])
}

/**
 * @param {{ ctx: object, log: object }} deps
 */
export function createFileRoutes({ ctx, log }) {
  return [
    {
      name: 'file',
      path: ROUTES.file.path,
      // 契约只登记 GET；HEAD 是同一资源的读取语义，沿用拆分前的行为。
      method: ['GET', 'HEAD'],
      async handler(req, res) {
        const requested = parseQuery(req, log).get('path') ?? ''
        const found = await resolveOutputPath(ctx, requested).catch((error) => {
          // 越界/不存在的路径是预期输入，按 404 处理即可。
          log.debug('产物路径解析失败（按 404 处理）', error?.message ?? error)
          return null
        })
        if (!found) return sendError(res, 404, 'not_found', '文件不存在或不在输出目录内')
        return sendOutputFile(req, res, found.absolute, log)
      },
    },
    {
      name: 'reveal',
      path: ROUTES.reveal.path,
      method: ROUTES.reveal.method,
      async handler(req, res) {
        const body = await readBodyOr(req, {}, log)
        const dir = await resolveOutputDir(ctx)
        if (!dir) return sendError(res, 404, 'output_missing', '产物目录还不存在，先出一张图')
        // dryRun 供无界面环境自检：只解析目录，不真的唤起文件管理器。
        if (body && body.dryRun === true) return sendJson(res, 200, { ok: true, dryRun: true, dir })
        try {
          await revealFolder(ctx, dir, log)
          sendJson(res, 200, { ok: true, dir })
        } catch (error) {
          sendError(res, 500, 'reveal_failed', String(error?.message ?? error))
        }
      },
    },
  ]
}