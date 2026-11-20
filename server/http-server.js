/**
 * Standalone 本地 HTTP 服务（Web 与 Electron 的唯一后端入口）。
 *
 * 职责（docs/MIGRATION_SPEC.md §2.3）：
 *  - 只监听 127.0.0.1；`/api/*` 统一校验 `Authorization: Bearer <token>`，失败 401；
 *  - 图片等「浏览器接管」的资源请求无法自带 Authorization：服务 `index.html` 时下发同源
 *    HttpOnly Session Cookie（`aigc_session`），允许 Cookie 仅对 `GET/HEAD /api/file` 放行，
 *    且必须通过「同源被动读取」校验（Sec-Fetch-Site / Origin / Referer），防止本机其它页面借
 *    Cookie 读图（127.0.0.1 不同端口属于 same-site，SameSite=Strict 拦不住）；
 *  - 同源校验：带 `Origin` 且 host 与监听地址不一致时返回 403（AIGC_STUDIO_DEV=1 时跳过）；
 *  - 精确路由分发（`ctx.webServer.register({kind:'exact'})` 收集的 `Map<path, handler>`），
 *    忽略查询串；405/404 语义与 server/http.js、route-kit.js 保持一致；
 *  - 静态文件托管（`dist/web`）：`/`、`/index.html`、`/assets/*` 免 Token；
 *    返回 index.html 前注入 `window.__AIGC_STUDIO__` 启动配置；静态目录不存在时只提供 API。
 *
 * 不实现 CORS；不提供目录列表；不做 SPA 路由回退（工作台是单页，无需路径路由）。
 */

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'

import { ROUTES } from '../shared/contract.js'
import { methodNotAllowed, sendError } from './http.js'
import { createLogger } from './log.js'

const defaultLog = createLogger({ scope: 'http' })

/** HTML 启动配置的注入标记。 */
const BOOTSTRAP_GLOBAL = '__AIGC_STUDIO__'

/** 同源会话 Cookie 名称：`<img>` 等浏览器接管的资源请求无法携带 Authorization，用它作为主通道。 */
const SESSION_COOKIE_NAME = 'aigc_session'

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

function mimeOf(filePath) {
  return STATIC_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 在 index.html 的 `</head>` 前注入启动配置；没有 head 时退化为插到最前面。
 *
 * @param {string} html
 * @param {{ apiBaseUrl?: string, authToken?: string, platform?: string, native?: boolean }} bootstrap
 * @returns {string}
 */
export function injectBootstrap(html, bootstrap = {}) {
  const payload = {
    apiBaseUrl: typeof bootstrap.apiBaseUrl === 'string' ? bootstrap.apiBaseUrl : '',
    authToken: typeof bootstrap.authToken === 'string' ? bootstrap.authToken : '',
    platform: typeof bootstrap.platform === 'string' ? bootstrap.platform : process.platform,
    native: bootstrap.native === true,
  }
  // JSON 里的 `<` / `>` 转义成 unicode，避免提前闭合 script 标签（token 是 hex，理论上无风险，仍做防御）。
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  const script = `<script>window.${BOOTSTRAP_GLOBAL}=${json}</script>`
  const match = /<\/head\s*>/i.exec(html)
  if (match) {
    const index = match.index
    return `${html.slice(0, index)}${script}\n${html.slice(index)}`
  }
  return `${script}\n${html}`
}

/** 从 `Authorization` 头里取 Bearer Token；缺省 / 格式不符返回空串。 */
function bearerOf(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : ''
}

/** 请求 Origin 的 host 是否与监听地址一致（没有 Origin 头时视为同源请求）。 */
function isSameOrigin(req, origin) {
  const requestOrigin = req.headers.origin
  if (!requestOrigin) return true
  let requestHost
  try {
    requestHost = new URL(requestOrigin).host
  } catch {
    return false
  }
  let expectedHost
  try {
    expectedHost = new URL(origin).host
  } catch {
    return false
  }
  return requestHost === expectedHost
}

/**
 * 常量时间字符串比较：长度不等直接失败（`timingSafeEqual` 要求等长 Buffer）。
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 从 `Cookie` 头里取指定名称的值；缺失 / 编码异常返回空串。 */
function cookieOf(req, name) {
  const header = req.headers.cookie
  if (typeof header !== 'string') return ''
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    const raw = part.slice(index + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return ''
}

/** 监听 origin 的 host；解析失败返回空串。 */
function hostOf(origin) {
  try {
    return new URL(origin).host
  } catch {
    return ''
  }
}

/**
 * 「同源被动读取」校验：浏览器接管的资源请求（`<img>`）不能带 Authorization，但也不应让
 * 本机其它页面借 Cookie 读图。满足其一即放行：
 *  1. `Sec-Fetch-Site: same-origin`（Chromium / Electron 对同源子资源请求固定发送）；
 *  2. `Origin` 的 host 与监听地址一致（显式脚本请求）；
 *  3. `Referer` 的 origin 与监听地址一致（浏览器默认同源请求会带 Referer）。
 * 三者都缺失（curl / 非浏览器客户端）时拒绝 Cookie 鉴权，必须改用 Bearer。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} origin 监听地址（`http://127.0.0.1:<port>`）
 * @returns {boolean}
 */
function isPassiveSameOriginRead(req, origin) {
  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite.trim().toLowerCase() === 'same-origin') return true

  const requestOrigin = req.headers.origin
  if (typeof requestOrigin === 'string' && requestOrigin.trim()) {
    try {
      if (new URL(requestOrigin).host === hostOf(origin)) return true
    } catch {
      // 非法的 Origin 头按不满足处理，继续看 Referer。
    }
  }

  const referer = req.headers.referer
  if (typeof referer === 'string' && referer.trim()) {
    try {
      if (new URL(referer).origin === origin) return true
    } catch {
      // 非法的 Referer 头按不满足处理。
    }
  }
  return false
}

/**
 * 启动 HTTP 服务。
 *
 * @param {object} options
 * @param {object} options.ctx 宿主上下文（需要 `webServer.entries()` 与 `webServer.setOrigin()`）
 * @param {string} [options.token] 本地 API Bearer Token（空串表示拒绝所有 /api 请求）
 * @param {number} [options.port=0] 监听端口，0 = 随机空闲端口
 * @param {string} [options.host='127.0.0.1'] 监听地址（禁止 0.0.0.0）
 * @param {string | null} [options.webDist] 前端静态产物目录；不存在时只提供 API
 * @param {boolean} [options.devMode=false] 放宽 Origin 校验（本地排障用）
 * @param {object} [options.log]
 * @returns {Promise<{ server: import('node:http').Server, origin: string, port: number, close: () => Promise<void> }>}
 */
export async function startHttpServer(options = {}) {
  const log = options.log ?? defaultLog
  const ctx = options.ctx
  if (!ctx?.webServer || typeof ctx.webServer.entries !== 'function') {
    throw new Error('startHttpServer 需要带 webServer.entries() 的宿主上下文')
  }
  const token = typeof options.token === 'string' ? options.token : ''
  // 会话 Cookie 的令牌与 Bearer Token 相互独立：即使 Cookie 泄露也不能调用写接口
  // （Cookie 只对 GET/HEAD /api/file 放行），服务重启后自动轮换。
  const sessionToken = randomBytes(32).toString('hex')
  const host = options.host ?? '127.0.0.1'
  const requestedPort = Number.isFinite(options.port) ? Math.trunc(options.port) : 0
  const devMode = options.devMode === true
  const webDist = typeof options.webDist === 'string' && options.webDist ? resolve(options.webDist) : null
  const distRoot = webDist ? resolve(webDist) : null
  const routes = ctx.webServer.entries()

  /** index.html 读取 + 注入；文件缺失时返回 null（没有前端产物时不崩）。 */
  async function serveIndex(res, req) {
    if (!distRoot) return false
    const indexPath = resolve(distRoot, 'index.html')
    let html
    try {
      html = await readFile(indexPath, 'utf8')
    } catch {
      return false
    }
    const body = Buffer.from(
      injectBootstrap(html, {
        apiBaseUrl: '',
        authToken: token,
        platform: process.platform,
        native: false,
      }),
      'utf8',
    )
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // 同源会话 Cookie：渲染进程里的 `<img src>` 无法附加 Authorization，只能靠它读取 /api/file。
      // 只下发到页面入口；HttpOnly 防脚本读取，SameSite=Strict 防跨站携带，Path=/ 覆盖 /api/file。
      'set-cookie': `${SESSION_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
    })
    res.end(req.method === 'HEAD' ? undefined : body)
    return true
  }

  /** 静态文件：只处理 GET/HEAD，路径必须落在 dist 目录内。 */
  async function handleStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return methodNotAllowed(res, 'GET, HEAD')
    }
    if (!distRoot) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Not Found: 前端静态产物不存在（dist/web 未构建）')
    }

    let decoded
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Bad Request')
    }
    if (decoded.includes('\0')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Bad Request')
    }
    if (decoded === '/' || decoded === '/index.html') {
      const served = await serveIndex(res, req)
      if (served) return
    }

    const relativePath = decoded.replace(/^\/+/, '')
    const absolute = resolve(distRoot, relativePath)
    // 目录穿越防护：解析后的路径必须仍在 dist 根目录内。
    if (!(absolute === distRoot || absolute.startsWith(`${distRoot}${sep}`))) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Not Found')
    }

    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Not Found')
    }

    const immutable = relativePath.startsWith('assets/')
    const headers = {
      'content-type': mimeOf(absolute),
      'content-length': String(info.size),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, headers)
      return res.end()
    }
    res.writeHead(200, headers)
    const stream = createReadStream(absolute)
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500)
      res.destroy()
    })
    stream.pipe(res)
  }

  /** `/api/*`：先鉴权、再同源校验，最后按精确路径表分发。 */
  async function handleApi(req, res, pathname) {
    // 1) Bearer：全部接口的唯一通用凭证。
    const bearerOk = Boolean(token) && safeEqual(bearerOf(req), token)
    if (!bearerOk) {
      // 2) 同源 Session Cookie：只读放行给「浏览器自己发起的图片请求」。
      //    条件缺一不可：Cookie 匹配、GET/HEAD、路径恰为 /api/file、能证明请求来自本服务同源页面。
      const cookieOk =
        (req.method === 'GET' || req.method === 'HEAD') &&
        pathname === ROUTES.file.path &&
        safeEqual(cookieOf(req, SESSION_COOKIE_NAME), sessionToken) &&
        isPassiveSameOriginRead(req, ctx.webServer.getOrigin())
      if (!cookieOk) {
        return sendError(res, 401, 'unauthorized', '缺少或无效的本地访问令牌')
      }
    } else if (!devMode && !isSameOrigin(req, ctx.webServer.getOrigin())) {
      // Bearer 请求维持原有同源校验；Cookie 请求已由 isPassiveSameOriginRead 完成校验。
      return sendError(res, 403, 'forbidden_origin', '只接受来自本客户端的同源请求')
    }

    const route = routes.get(pathname)
    if (!route) {
      return sendError(res, 404, 'not_found', '接口不存在')
    }
    try {
      await route.handler(req, res)
    } catch (error) {
      log.error(`api_unhandled path=${pathname} method=${req.method} detail=${String(error?.message ?? error).slice(0, 300)}`)
      if (!res.headersSent) return sendError(res, 500, 'internal_error', '服务器内部错误')
      if (!res.writableEnded) res.destroy()
    }
  }

  const server = createServer((req, res) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Bad Request')
    }

    const isApi = pathname === '/api' || pathname.startsWith('/api/')
    const pending = isApi ? handleApi(req, res, pathname) : handleStatic(req, res, pathname)
    Promise.resolve(pending).catch((error) => {
      log.warn(`request_failed path=${pathname} detail=${String(error?.message ?? error).slice(0, 300)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Internal Server Error')
      } else if (!res.writableEnded) {
        res.destroy()
      }
    })
  })

  // 请求体解析失败等异常不应拖垮进程：只在当前连接上结束响应。
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    else socket.destroy()
    log.debug('client_error', String(error?.message ?? error).slice(0, 200))
  })

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(requestedPort, host)
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : requestedPort
  const origin = `http://${host}:${actualPort}`
  ctx.webServer.setOrigin(origin)

  const close = async () => {
    if (!server.listening) return
    const closed = new Promise((resolveClose) => server.close(() => resolveClose()))
    server.closeAllConnections?.()
    await closed
  }

  return { server, origin, port: actualPort, close }
}
