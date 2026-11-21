#!/usr/bin/env node
/**
 * Standalone 服务真进程 E2E（不需要浏览器）。
 *
 * 用临时 DATA_DIR / 工作区 / 前端产物目录 spawn `node server/standalone.js`，
 * 按 docs/MIGRATION_SPEC.md §2 的启动契约逐条断言：
 *  1. stdout 第一行是 ready JSON（此前无任何输出），port / token / origin 正确；
 *  2. 无 Token / 错误 Token 访问 /api/* → 401；带 Token → 200；
 *  3. GET /api/state 返回完整状态（version / presets / session / jobs / queue / workspace）；
 *  4. GET /api/app-settings 返回脱敏视图（ui / llm / workspace / version，不含 Key 原文）；
 *  5. GET / 下发同源会话 Cookie；种子产物图可仅凭 Cookie（`<img>` 语义）读取，
 *     Cookie 鉴权边界（其它接口 / 无可信同源来源 / 错 Cookie）一律 401，Bearer 仍可读；
 *  6. `/api/file` 的 Range 语义：`bytes=0-9` → 206、越界 → 416、HEAD → 200 无 body；
 *  7. POST /api/workspace 切换工作区后，GET /api/workspace 与 GET /api/state 都反映新工作区；
 *  8. GET / 返回注入 window.__AIGC_STUDIO__ 的 index.html（注入点在 </head> 前，token 可见）；
 *  9. GET /assets/* 静态资源 200 且免 Token；未知静态路径 /api 路径分别 404；
 * 10. 跨源 Origin 访问 /api → 403；同源 Origin → 200；
 * 11. SIGTERM 后进程退出（Windows 上 code 为 null + signal 非空；其它平台 code 0）。
 *
 * 说明：前端产物用临时目录里最小化的 index.html + assets/* 伪造，不依赖 `dist/web` 是否已构建，
 * 因此静态资源与注入断言始终执行（不 SKIP）。种子图写在临时工作区的 `outputs/<目录>/01.png`
 * （新工作区口径），不触碰仓库里的任何文件。
 *
 * 运行：node test/standalone-server.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCheckRunner } from './helpers/check.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const STANDALONE = join(ROOT, 'server', 'standalone.js')

const TOKEN = 'test-token-standalone-e2e'
const READY_TIMEOUT_MS = 40_000
const EXIT_TIMEOUT_MS = 12_000
/** 优先使用的固定端口（不常用）；被占用时再随机挑一个。 */
const PREFERRED_PORT = 41_729
/** 种子 PNG：1×1 透明像素，用于验证 Cookie 鉴权与 Range 字节区间。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const SEED_DIR = '20260101-000000-standalone-e2e'
/** 工作区相对路径（与 server/output.js 的 fileUrl 同口径）。 */
const SEED_RELATIVE = `outputs/${SEED_DIR}/01.png`
const SEED_URL = `/api/file?path=${encodeURIComponent(SEED_RELATIVE)}`

const { check, summary } = createCheckRunner()

/** 探测端口是否可绑定（避免 spawn 后才发现 EADDRINUSE）。 */
function canListen(port) {
  return new Promise((resolvePromise) => {
    const probe = createServer()
    probe.once('error', () => resolvePromise(false))
    probe.once('listening', () => probe.close(() => resolvePromise(true)))
    probe.listen(port, '127.0.0.1')
  })
}

async function pickPort() {
  if (await canListen(PREFERRED_PORT)) return PREFERRED_PORT
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = 20_000 + Math.floor(Math.random() * 40_000)
    if (await canListen(candidate)) return candidate
  }
  throw new Error('找不到可用端口')
}

/** 启动 standalone 进程并解析 ready 行。 */
function startServer({ port, dataDir, workspace, webDist }) {
  const child = spawn(process.execPath, [STANDALONE], {
    cwd: ROOT,
    env: {
      ...process.env,
      AIGC_STUDIO_PORT: String(port),
      AIGC_STUDIO_TOKEN: TOKEN,
      AIGC_STUDIO_DATA_DIR: dataDir,
      AIGC_STUDIO_WORKSPACE: workspace,
      AIGC_STUDIO_WEB_DIST: webDist,
      AIGC_STUDIO_DEV: '0',
      // 不让子进程继承宿主的调试/测试开关。
      AIGC_STUDIO_HOSTED: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const stdoutLines = []
  const stderrLines = []
  let stderrBuffer = ''
  let stdoutBuffer = ''
  let readyLine = null
  let readyResolve = null
  const ready = new Promise((resolveReady) => {
    readyResolve = resolveReady
  })

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    while (stdoutBuffer.includes('\n')) {
      const index = stdoutBuffer.indexOf('\n')
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, '')
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      if (line !== '') stdoutLines.push(line)
      if (!readyLine && line !== '') {
        try {
          const parsed = JSON.parse(line)
          if (parsed && parsed.type === 'ready') {
            readyLine = parsed
            readyResolve(parsed)
          }
        } catch {
          // 非 JSON 行：按「ready 之前不应有输出」的违规证据保留在 stdoutLines 里。
        }
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk
    while (stderrBuffer.includes('\n')) {
      const index = stderrBuffer.indexOf('\n')
      const line = stderrBuffer.slice(0, index).replace(/\r$/, '')
      stderrBuffer = stderrBuffer.slice(index + 1)
      if (line !== '') stderrLines.push(line)
    }
  })

  let exitInfo = null
  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal }
      resolveExit(exitInfo)
    })
  })

  const timeout = setTimeout(() => {
    if (!readyLine) {
      readyResolve(null)
    }
  }, READY_TIMEOUT_MS)

  const readyOrExit = Promise.race([
    ready.then((value) => ({ type: 'ready', value })),
    exited.then((value) => ({ type: 'exit', value })),
  ]).finally(() => clearTimeout(timeout))

  return { child, stdoutLines, stderrLines, exited, readyOrExit, exitInfo: () => exitInfo, kill: () => child.kill('SIGTERM') }
}

function jsonFetch(base, path, { token, headers = {}, ...init } = {}) {
  const requestHeaders = { accept: 'application/json', ...headers }
  if (token) requestHeaders.authorization = `Bearer ${token}`
  return fetch(new URL(path, base), {
    ...init,
    headers: requestHeaders,
    signal: AbortSignal.timeout(10_000),
  })
}

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'aigc-studio-standalone-'))
  const dataDir = join(base, 'data')
  const workspace = join(base, 'workspace')
  const secondWorkspace = join(base, 'workspace-switched')
  const webDist = join(base, 'webdist')
  await mkdir(dataDir, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await mkdir(join(webDist, 'assets'), { recursive: true })
  // 种子产物：临时工作区的 outputs/<目录>/01.png（不触碰仓库文件）。
  const pngBytes = Buffer.from(PNG_B64, 'base64')
  await mkdir(join(workspace, 'outputs', SEED_DIR), { recursive: true })
  await writeFile(join(workspace, 'outputs', SEED_DIR, '01.png'), pngBytes)
  const indexHtml = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <title>AIGC Studio E2E</title>',
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="./assets/app.js"></script>',
    '  </body>',
    '</html>',
  ].join('\n')
  const appJs = 'window.__E2E_ASSET__ = true\n'
  await writeFile(join(webDist, 'index.html'), indexHtml, 'utf8')
  await writeFile(join(webDist, 'assets', 'app.js'), appJs, 'utf8')

  const port = await pickPort()
  const server = startServer({ port, dataDir, workspace, webDist })
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    const started = await server.readyOrExit
    if (started.type !== 'ready' || !started.value) {
      const exit = started.type === 'exit' ? started.value : server.exitInfo()
      throw new Error(
        `standalone 未在 ${READY_TIMEOUT_MS}ms 内输出 ready 行（exit=${JSON.stringify(exit)}）\nstderr:\n${server.stderrLines.slice(-40).join('\n')}`,
      )
    }
    const ready = started.value
    const readyIndex = server.stdoutLines.indexOf(JSON.stringify(ready))

    await check('ready 行是 stdout 第一行且 port / token / origin 正确', () => {
      assert.equal(server.stdoutLines.length >= 1, true, `stdout 为空；stderr：${server.stderrLines.slice(-10).join('\n')}`)
      assert.equal(readyIndex, 0, `ready 前 stdout 不应有其它输出，实际：${JSON.stringify(server.stdoutLines.slice(0, readyIndex + 1))}`)
      assert.equal(ready.type, 'ready')
      assert.equal(ready.port, port, 'ready.port 应为实际监听端口')
      assert.equal(ready.token, TOKEN, 'ready.token 应回显传入的 Token')
      assert.equal(ready.origin, baseUrl, 'ready.origin 应为 http://127.0.0.1:<port>')
    })

    await check('无 Token / 错误 Token 访问 /api/* 返回 401', async () => {
      const anonymous = await jsonFetch(baseUrl, '/api/state')
      assert.equal(anonymous.status, 401, '无 Token 应 401')
      const anonymousBody = await anonymous.json()
      assert.equal(anonymousBody?.error?.code, 'unauthorized')
      const wrong = await jsonFetch(baseUrl, '/api/state', { token: 'wrong-token' })
      assert.equal(wrong.status, 401, '错误 Token 应 401')
      const newRoute = await jsonFetch(baseUrl, '/api/app-settings')
      assert.equal(newRoute.status, 401, '新增路由同样必须校验 Token')
    })

    let state = null
    await check('带 Token GET /api/state 返回完整状态', async () => {
      const response = await jsonFetch(baseUrl, '/api/state', { token: TOKEN })
      assert.equal(response.status, 200)
      state = await response.json()
      for (const key of ['version', 'presets', 'session', 'jobs', 'queue', 'workspace']) {
        assert.ok(key in state, `state 缺少字段 ${key}`)
      }
      assert.ok(Array.isArray(state.presets) && state.presets.length >= 4, 'presets 应至少 4 个')
      assert.ok(Array.isArray(state.jobs), 'jobs 应为数组')
      assert.equal(typeof state.queue?.pending, 'number', 'queue.pending 应为数字')
      assert.equal(resolve(state.workspace.current), resolve(workspace), 'state.workspace.current 应为初始工作区')
    })

    await check('GET /api/app-settings 返回脱敏视图且不回 Key 原文', async () => {
      const response = await jsonFetch(baseUrl, '/api/app-settings', { token: TOKEN })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.ok, true)
      const settings = body.settings
      for (const key of ['ui', 'llm', 'workspace', 'version']) assert.ok(key in settings, `settings 缺少 ${key}`)
      assert.equal(typeof settings.ui.lang, 'string')
      assert.equal(typeof settings.llm.provider, 'string')
      assert.equal(typeof settings.llm.hasApiKey, 'boolean')
      assert.equal('apiKey' in settings.llm, false, '脱敏视图不得包含 apiKey 原文')
      assert.equal(resolve(settings.workspace.current), resolve(workspace))
    })

    // ── 同源会话 Cookie + /api/file（`<img>` 无法带 Authorization 的主通道） ──
    let sessionCookie = null
    await check('GET / 下发同源会话 Cookie（HttpOnly / SameSite=Strict / Path=/）', async () => {
      const response = await fetch(new URL('/', baseUrl), { signal: AbortSignal.timeout(10_000) })
      assert.equal(response.status, 200)
      const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? ''
      const match = /^aigc_session=([0-9a-f]{64}); HttpOnly; SameSite=Strict; Path=\/$/.exec(setCookie)
      assert.ok(match, `index.html 应下发 aigc_session Cookie，实际：${JSON.stringify(setCookie)}`)
      assert.equal(setCookie.includes('Secure'), false, 'http://127.0.0.1 下不能带 Secure（否则浏览器不保存）')
      sessionCookie = match[1]
      assert.notEqual(sessionCookie, TOKEN, '会话 Cookie 必须与 Bearer Token 相互独立')
    })

    await check('Cookie 鉴权：不带 Authorization 的 GET /api/file → 200 且字节正确', async () => {
      const response = await fetch(new URL(SEED_URL, baseUrl), {
        headers: { cookie: `aigc_session=${sessionCookie}`, 'sec-fetch-site': 'same-origin' },
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'image/png')
      assert.equal(response.headers.get('accept-ranges'), 'bytes')
      assert.equal(response.headers.get('access-control-allow-origin'), null, '同源读取不再下发 ACAO')
      assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), pngBytes)
    })

    await check('Cookie 鉴权边界：其它接口 / 无同源来源 / 错 Cookie 一律 401，Bearer 仍可读', async () => {
      const cookieHeader = { cookie: `aigc_session=${sessionCookie}` }
      // Cookie 只放行 GET/HEAD /api/file：状态等接口必须继续用 Bearer。
      const stateWithCookie = await fetch(new URL('/api/state', baseUrl), {
        headers: { ...cookieHeader, 'sec-fetch-site': 'same-origin' },
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(stateWithCookie.status, 401, 'Cookie 不能用于 /api/file 之外的接口')
      // 没有 Cookie 也没有 Bearer。
      const anonymous = await fetch(new URL(SEED_URL, baseUrl), {
        headers: { 'sec-fetch-site': 'same-origin' },
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(anonymous.status, 401)
      // 有 Cookie 但没有任何「同源被动读取」证据（curl 语义）：必须用 Bearer。
      const noEvidence = await fetch(new URL(SEED_URL, baseUrl), {
        headers: cookieHeader,
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(noEvidence.status, 401, '无可信来源时不接受 Cookie 鉴权')
      // 错误 Cookie。
      const wrongCookie = await fetch(new URL(SEED_URL, baseUrl), {
        headers: { cookie: 'aigc_session=deadbeef', 'sec-fetch-site': 'same-origin' },
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(wrongCookie.status, 401)
      // 跨源页面（Origin / Referer 均不符）即使 Cookie 匹配也拒绝。
      const crossSite = await fetch(new URL(SEED_URL, baseUrl), {
        headers: { ...cookieHeader, origin: 'http://evil.example', referer: 'http://evil.example/page' },
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(crossSite.status, 401, '跨源页面不得借 Cookie 读图')
      // Bearer 对同一资源仍然直接可用。
      const withBearer = await jsonFetch(baseUrl, SEED_URL, { token: TOKEN })
      assert.equal(withBearer.status, 200)
      assert.deepEqual(Buffer.from(await withBearer.arrayBuffer()), pngBytes)
    })

    await check('Cookie 鉴权的同源来源判定：Sec-Fetch-Site / Origin / Referer 任一满足即放行', async () => {
      const cookieHeader = { cookie: `aigc_session=${sessionCookie}` }
      for (const [label, headers] of [
        ['Sec-Fetch-Site', { 'sec-fetch-site': 'same-origin' }],
        ['Origin', { origin: baseUrl }],
        ['Referer', { referer: `${baseUrl}/` }],
      ]) {
        const response = await fetch(new URL(SEED_URL, baseUrl), {
          headers: { ...cookieHeader, ...headers },
          signal: AbortSignal.timeout(10_000),
        })
        assert.equal(response.status, 200, `${label} 同源时 Cookie 鉴权应放行`)
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), pngBytes)
      }
    })

    await check('Range 流式：206 / 416 / 越界截断 / HEAD 无 body', async () => {
      const total = pngBytes.length
      const fetchSeed = (options = {}) =>
        fetch(new URL(SEED_URL, baseUrl), {
          ...options,
          headers: {
            cookie: `aigc_session=${sessionCookie}`,
            'sec-fetch-site': 'same-origin',
            ...(options.headers ?? {}),
          },
          signal: AbortSignal.timeout(10_000),
        })

      const partial = await fetchSeed({ headers: { range: 'bytes=0-9' } })
      assert.equal(partial.status, 206)
      assert.equal(partial.headers.get('content-range'), `bytes 0-9/${total}`)
      assert.equal(partial.headers.get('content-length'), '10')
      assert.equal(partial.headers.get('accept-ranges'), 'bytes')
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), pngBytes.subarray(0, 10))

      // 后缀范围与末位超界截断。
      const suffix = await fetchSeed({ headers: { range: 'bytes=-8' } })
      assert.equal(suffix.status, 206)
      assert.equal(suffix.headers.get('content-range'), `bytes ${total - 8}-${total - 1}/${total}`)
      assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), pngBytes.subarray(total - 8))
      const clamped = await fetchSeed({ headers: { range: 'bytes=0-999999' } })
      assert.equal(clamped.status, 206)
      assert.equal(clamped.headers.get('content-range'), `bytes 0-${total - 1}/${total}`)
      assert.equal(Buffer.from(await clamped.arrayBuffer()).length, total)

      // 起点超出文件长度：416 + `bytes */size`。
      const unsatisfiable = await fetchSeed({ headers: { range: 'bytes=999999-' } })
      assert.equal(unsatisfiable.status, 416)
      assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${total}`)
      assert.equal(unsatisfiable.headers.get('accept-ranges'), 'bytes')

      // HEAD：200 + 完整长度头，无 body。
      const head = await fetchSeed({ method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('content-length'), String(total))
      assert.equal((await head.arrayBuffer()).byteLength, 0, 'HEAD 不得返回 body')

      // 不存在的产物仍是 404（不因 Range 改变错误语义）。
      const missing = await fetch(new URL('/api/file?path=outputs/nope.png', baseUrl), {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(10_000),
      })
      assert.equal(missing.status, 404)
    })

    await check('第一个工作区保存设置（供切换后验证 settings.reload）', async () => {
      const saved = await jsonFetch(baseUrl, '/api/settings', {
        token: TOKEN,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idleTimeoutSec: 901 }),
      })
      assert.equal(saved.status, 200)
      const body = await saved.json()
      assert.equal(body.settings.idleTimeoutSec, 901)
    })

    await check('POST /api/workspace 切换后 GET /api/workspace 与 /api/state 反映新工作区', async () => {
      const switched = await jsonFetch(baseUrl, '/api/workspace', {
        token: TOKEN,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: secondWorkspace }),
      })
      assert.equal(switched.status, 200, `切换失败：HTTP ${switched.status}`)
      const body = await switched.json()
      assert.equal(body.ok, true)
      assert.equal(resolve(body.workspace.current), resolve(secondWorkspace))

      const current = await jsonFetch(baseUrl, '/api/workspace', { token: TOKEN })
      assert.equal(current.status, 200)
      const view = await current.json()
      assert.equal(resolve(view.workspace.current), resolve(secondWorkspace))
      assert.ok(
        view.workspace.recent.some((entry) => resolve(entry) === resolve(secondWorkspace)),
        `recent 应包含新工作区：${JSON.stringify(view.workspace.recent)}`,
      )

      const nextState = await jsonFetch(baseUrl, '/api/state', { token: TOKEN })
      assert.equal(nextState.status, 200)
      const payload = await nextState.json()
      assert.equal(resolve(payload.workspace.current), resolve(secondWorkspace), '切换后 /api/state 应反映新工作区')
    })

    await check('工作区切换后 /api/settings 跟随新工作区（settings.reload 热切换）', async () => {
      // 新工作区没有 settings.json：应回落到静态 config 的默认值，而不是继续读旧工作区的 901。
      const inSecond = await jsonFetch(baseUrl, '/api/settings', { token: TOKEN })
      assert.equal(inSecond.status, 200)
      assert.equal((await inSecond.json()).settings.idleTimeoutSec, 1800, '新工作区应回落到静态 config')

      const savedSecond = await jsonFetch(baseUrl, '/api/settings', {
        token: TOKEN,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idleTimeoutSec: 902 }),
      })
      assert.equal(savedSecond.status, 200)

      // 再切回第一个工作区：应读回切走前保存的 901，而不是第二个工作区的 902。
      const back = await jsonFetch(baseUrl, '/api/workspace', {
        token: TOKEN,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: workspace }),
      })
      assert.equal(back.status, 200)
      const inFirst = await jsonFetch(baseUrl, '/api/settings', { token: TOKEN })
      assert.equal(inFirst.status, 200)
      assert.equal((await inFirst.json()).settings.idleTimeoutSec, 901, '切回后应读回第一个工作区的设置')
    })

    await check('GET / 返回注入 window.__AIGC_STUDIO__ 的 index.html', async () => {
      const response = await fetch(new URL('/', baseUrl), { signal: AbortSignal.timeout(10_000) })
      assert.equal(response.status, 200, '静态首页应免 Token 直接 200')
      assert.match(response.headers.get('content-type') ?? '', /text\/html/)
      const csp = response.headers.get('content-security-policy') ?? ''
      assert.ok(csp.includes("default-src 'self'") && csp.includes("object-src 'none'"), `首页应带安全 CSP 头，实际：${csp}`)
      const html = await response.text()
      const match = html.match(/<script>window\.__AIGC_STUDIO__=(\{.*?\})<\/script>/s)
      assert.ok(match, `index.html 未注入 window.__AIGC_STUDIO__：${html.slice(0, 400)}`)
      const bootstrap = JSON.parse(match[1])
      assert.equal(bootstrap.apiBaseUrl, '')
      assert.equal(bootstrap.authToken, TOKEN, '注入的 authToken 应是本次启动 Token')
      assert.equal(typeof bootstrap.platform, 'string')
      assert.equal(bootstrap.native, false)
      const injectedAt = html.indexOf('window.__AIGC_STUDIO__')
      const headEndAt = html.indexOf('</head>')
      assert.ok(headEndAt > 0, '测试夹具 index.html 应含 </head>')
      assert.ok(injectedAt >= 0 && injectedAt < headEndAt, '注入点必须在 </head> 之前')
    })

    await check('静态 assets 免 Token 返回 200，未知路径 404', async () => {
      const asset = await fetch(new URL('/assets/app.js', baseUrl), { signal: AbortSignal.timeout(10_000) })
      assert.equal(asset.status, 200)
      assert.match(asset.headers.get('content-type') ?? '', /javascript/)
      assert.equal(await asset.text(), appJs)
      const missingStatic = await fetch(new URL('/assets/nope.js', baseUrl), { signal: AbortSignal.timeout(10_000) })
      assert.equal(missingStatic.status, 404)
      const missingApi = await jsonFetch(baseUrl, '/api/nope', { token: TOKEN })
      assert.equal(missingApi.status, 404)
      assert.equal((await missingApi.json())?.error?.code, 'not_found')
    })

    await check('Origin 校验：跨源 403、同源放行', async () => {
      const cross = await jsonFetch(baseUrl, '/api/state', {
        token: TOKEN,
        headers: { origin: 'http://evil.example' },
      })
      assert.equal(cross.status, 403, '跨源 Origin 应 403')
      assert.equal((await cross.json())?.error?.code, 'forbidden_origin')
      const same = await jsonFetch(baseUrl, '/api/state', {
        token: TOKEN,
        headers: { origin: baseUrl },
      })
      assert.equal(same.status, 200, '同源 Origin 应放行')
    })

    await check('SIGTERM 后退出（优雅收尾）', async () => {
      const childExit = server.exited
      server.child.kill('SIGTERM')
      const result = await Promise.race([
        childExit,
        new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ timeout: true }), EXIT_TIMEOUT_MS)),
      ])
      assert.equal(result.timeout, undefined, `SIGTERM 后 ${EXIT_TIMEOUT_MS}ms 内未退出`)
      // Windows 上 Node 子进程被终止通常表现为 code=null + signal 非空；其它平台要求 code 0。
      assert.ok(
        result.code === 0 || result.signal !== null,
        `退出码应为 0 或由信号结束，实际 code=${result.code} signal=${result.signal}`,
      )
    })
  } finally {
    if (!server.exitInfo()) {
      server.child.kill('SIGTERM')
      await Promise.race([server.exited, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5000))])
    }
    await rm(base, { recursive: true, force: true }).catch(() => {})
  }

  const result = summary()
  process.exitCode = result.failed > 0 ? 1 : process.exitCode
}

main().catch((error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 1
})
