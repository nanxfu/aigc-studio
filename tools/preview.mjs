/**
 * 设计预览：基于真实 Vite + React 19 + 真实 Chromium 的工作台预览与截图工具。
 *
 * 与 DSH 插件时代「Node 假 React → 手拼静态 HTML → 多次冷启无头浏览器」不同，
 * 独立桌面版直接让 Vite 服务真实前端源码与样式（支持 HMR 与真实交互），
 * 仅在预览层拦截 `/api/*` 注入离线场景状态。
 *
 * 用法：
 *   node tools/preview.mjs                   启动交互式预览服务（浏览器打开即可切换所有场景）
 *   node tools/preview.mjs --shot            用单实例无头浏览器 + CDP 批量截图到 tools/.preview/
 *   node tools/preview.mjs --shot --mobile   额外以 390×844 移动端视口截图
 *   node tools/preview.mjs --shot --readme   同步更新 docs/assets/ 下的 4 张 README 截图
 *   node tools/preview.mjs --shot --scenario=studio-ready  只截指定场景
 *
 * 可通过环境变量 `IMAGEN_BROWSER` 或 `EDGE_PATH` 指定 Chromium/Edge 可执行文件路径。
 */

import { spawn, spawnSync } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from 'vite'

import { HERO_PROMPT, libraryResponse, NOW, buildScenarios } from './preview/scenarios.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(ROOT, 'tools/.preview')
const SHOWCASE_DIR = join(ROOT, 'docs/assets/showcase')
const APP_ENTRY = join(ROOT, 'tools/preview/app.jsx').replace(/\\/g, '/')

const MIME_MAP = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function resolveBrowserExecutable() {
  const fromEnv = [process.env.IMAGEN_BROWSER, process.env.EDGE_PATH].filter(Boolean)
  for (const candidate of fromEnv) {
    if (await fileExists(candidate)) return candidate
    throw new Error(`指定的浏览器可执行文件不存在：${candidate}`)
  }

  const candidates = []
  if (process.platform === 'win32') {
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const local = process.env.LOCALAPPDATA
    candidates.push(
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ...(local ? [join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate
  }

  const lookup = process.platform === 'win32' ? 'where' : 'which'
  for (const cmd of ['msedge', 'microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']) {
    const probe = spawnSync(lookup, [cmd], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0 && probe.stdout) {
      const first = probe.stdout.trim().split(/\r?\n/)[0]?.trim()
      if (first) return first
    }
  }

  throw new Error('未找到可用的 Chromium/Edge 浏览器，请设置 IMAGEN_BROWSER 或 EDGE_PATH 环境变量')
}

function previewPlugin(scenarios) {
  const payloadJson = JSON.stringify({
    now: NOW,
    heroPrompt: HERO_PROMPT,
    library: libraryResponse,
    scenarios,
  })

  return {
    name: 'aigc-studio-preview',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const pathname = url.pathname

        if (pathname === '/__preview/scenarios.json') {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(payloadJson)
          return
        }

        if (pathname.startsWith('/__preview/showcase/')) {
          const name = basename(decodeURIComponent(pathname.slice('/__preview/showcase/'.length)))
          const filePath = join(SHOWCASE_DIR, name)
          try {
            const bytes = await readFile(filePath)
            res.statusCode = 200
            res.setHeader('content-type', MIME_MAP[extname(name).toLowerCase()] || 'application/octet-stream')
            res.end(bytes)
          } catch {
            res.statusCode = 404
            res.end('Not found')
          }
          return
        }

        if (pathname === '/__preview' || pathname === '/__preview/' || pathname === '/__preview/index.html') {
          const rawHtml = `<!doctype html>
<html lang="zh-CN" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>AIGC Studio Preview</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      html, body, #root { height: 100%; }
      body { margin: 0; overflow: hidden; }
      #root { display: flex; flex-direction: column; }
      .ofs-root { height: 100%; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@fs/${APP_ENTRY}"></script>
  </body>
</html>`
          try {
            const transformed = await server.transformIndexHtml(req.url || '/__preview', rawHtml)
            res.statusCode = 200
            res.setHeader('content-type', 'text/html; charset=utf-8')
            res.end(transformed)
          } catch (error) {
            next(error)
          }
          return
        }

        next()
      })
    },
  }
}

async function startPreviewServer(scenarios, { port = 0 } = {}) {
  const server = await createServer({
    configFile: resolve(ROOT, 'vite.config.js'),
    mode: 'preview',
    plugins: [previewPlugin(scenarios)],
    server: {
      host: '127.0.0.1',
      port,
      strictPort: false,
      open: false,
      fs: { allow: [ROOT] },
    },
    logLevel: 'silent',
  })
  await server.listen()
  const address = server.httpServer?.address()
  const actualPort = typeof address === 'object' && address ? address.port : 5173
  return { server, baseUrl: `http://127.0.0.1:${actualPort}` }
}

/** 轻量 CDP 客户端：基于 Node 内置 WebSocket 与无头浏览器单实例对话。 */
async function launchCdpBrowser(executable) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'aigc-preview-cdp-'))
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  )

  const wsUrl = await new Promise((resolveWs, rejectWs) => {
    let stderr = ''
    const timer = setTimeout(() => rejectWs(new Error(`等待无头浏览器启动超时\n${stderr}`)), 15_000)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timer)
        resolveWs(match[1])
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      rejectWs(new Error(`无头浏览器提前退出（code=${code}）\n${stderr}`))
    })
  })

  const browserOrigin = new URL(wsUrl).origin.replace(/^ws/, 'http')
  const targetsRes = await fetch(`${browserOrigin}/json/list`)
  const targets = await targetsRes.json()
  const pageTarget = targets.find((t) => t.type === 'page') ?? targets[0]
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error('未找到可用的浏览器页面调试目标')
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', (err) => rejectOpen(new Error(`CDP WebSocket 连接失败：${err.message || err}`)), { once: true })
  })

  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(`CDP ${msg.error.message}`))
      else res(msg.result)
    }
  })

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = nextId++
      pending.set(id, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id, method, params }))
    })

  await send('Page.enable')
  await send('Runtime.enable')

  const close = async () => {
    try {
      ws.close()
    } catch {}
    try {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        child.kill('SIGTERM')
      }
    } catch {}
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }

  return { send, close }
}

async function waitForReady(cdp) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const res = await cdp.send('Runtime.evaluate', {
      expression: '({ ready: Boolean(window.__PREVIEW_READY__), error: window.__PREVIEW_ERROR__ || null })',
      returnByValue: true,
    })
    const value = res?.result?.value
    if (value?.error) throw new Error(`预览页面运行出错：${value.error}`)
    if (value?.ready) return
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error('等待预览页面渲染超时')
}

async function captureShot(cdp, baseUrl, shot) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: shot.width,
    height: shot.height,
    deviceScaleFactor: 1,
    mobile: shot.width < 500,
  })
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: shot.dark ? 'dark' : 'light' }],
  })

  const targetUrl = `${baseUrl}/__preview?scenario=${encodeURIComponent(shot.name)}&shot=1`
  await cdp.send('Page.navigate', { url: targetUrl })
  await waitForReady(cdp)

  if (shot.hoverSelector) {
    const boxRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(shot.hoverSelector)})
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })()`,
      returnByValue: true,
    })
    const box = boxRes?.result?.value
    if (box) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
      await new Promise((r) => setTimeout(r, 80))
    }
  } else {
    // 移走鼠标指针避免上一张的残留 hover
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
  }

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const outPath = join(OUT_DIR, shot.out)
  await writeFile(outPath, Buffer.from(data, 'base64'))
  return outPath
}

function buildShotPlan(scenarios, args) {
  const filterArg = args.find((a) => a.startsWith('--scenario='))
  const only = filterArg ? filterArg.slice('--scenario='.length) : null
  const names = only ? [only] : Object.keys(scenarios)

  for (const name of names) {
    if (!scenarios[name]) throw new Error(`未知预览场景：${name}`)
  }

  const shots = names.map((name) => ({
    name,
    out: `${name}.png`,
    width: 1440,
    height: name.startsWith('rail-') ? 1000 : 900,
    dark: Boolean(scenarios[name].dark),
    hoverSelector: scenarios[name].hoverSelector || null,
  }))

  if (!only && args.includes('--mobile')) {
    for (const mobileName of ['studio-ready', 'studio-gallery', 'studio-warming']) {
      shots.push({
        name: mobileName,
        out: `${mobileName}-mobile.png`,
        width: 390,
        height: 844,
        dark: Boolean(scenarios[mobileName].dark),
        hoverSelector: null,
      })
    }
  }
  return shots
}

async function main() {
  const args = process.argv.slice(2)
  const scenarios = buildScenarios()
  const isShot = args.includes('--shot')

  if (!isShot) {
    const preferredPort = Number(process.env.AIGC_PREVIEW_PORT || 5179)
    const { server, baseUrl } = await startPreviewServer(scenarios, { port: preferredPort })
    console.log(`AIGC Studio 预览服务已启动（真实 Vite + React 19，共 ${Object.keys(scenarios).length} 个场景）：`)
    console.log(`  ${baseUrl}/__preview?scenario=studio-ready`)
    console.log('按 Ctrl+C 退出')
    const stop = async () => {
      await server.close().catch(() => {})
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return
  }

  await mkdir(OUT_DIR, { recursive: true })
  const shots = buildShotPlan(scenarios, args)
  const executable = await resolveBrowserExecutable()
  const { server, baseUrl } = await startPreviewServer(scenarios, { port: 0 })
  const cdp = await launchCdpBrowser(executable)

  try {
    for (const shot of shots) {
      const outPath = await captureShot(cdp, baseUrl, shot)
      console.log(`截图：${outPath}`)
    }

    if (args.includes('--readme')) {
      const targets = [
        ['studio-ready.png', 'studio-light.png'],
        ['model-picker-dark.png', 'model-picker-dark.png'],
        ['gallery-wide.png', 'gallery.png'],
        ['chat-composed.png', 'chat-tool.png'],
      ]
      for (const [source, target] of targets) {
        await copyFile(join(OUT_DIR, source), join(ROOT, 'docs/assets', target))
        console.log(`README 截图：docs/assets/${target}`)
      }
    }
  } finally {
    await cdp.close()
    await server.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
