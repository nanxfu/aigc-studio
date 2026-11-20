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
 *  5. POST /api/workspace 切换工作区后，GET /api/workspace 与 GET /api/state 都反映新工作区；
 *  6. GET / 返回注入 window.__AIGC_STUDIO__ 的 index.html（注入点在 </head> 前，token 可见）；
 *  7. GET /assets/* 静态资源 200 且免 Token；未知静态路径 /api 路径分别 404；
 *  8. 跨源 Origin 访问 /api → 403；同源 Origin → 200；
 *  9. SIGTERM 后进程退出（Windows 上 code 为 null + signal 非空；其它平台 code 0）。
 *
 * 说明：前端产物用临时目录里最小化的 index.html + assets/* 伪造，不依赖 `dist/web` 是否已构建，
 * 因此静态资源与注入断言始终执行（不 SKIP）。
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

    await check('GET / 返回注入 window.__AIGC_STUDIO__ 的 index.html', async () => {
      const response = await fetch(new URL('/', baseUrl), { signal: AbortSignal.timeout(10_000) })
      assert.equal(response.status, 200, '静态首页应免 Token 直接 200')
      assert.match(response.headers.get('content-type') ?? '', /text\/html/)
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
