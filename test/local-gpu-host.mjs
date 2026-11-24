#!/usr/bin/env node
/**
 * M3.4 Host 全链路真机验收（需要本机已安装 sd-server + GGUF 模型）。
 *
 * 与 `local-gpu-live.mjs` 的区别：本用例真的 spawn `server/standalone.js`，通过 HTTP
 * 走完 设置 → 会话启动 → 队列 → 本机桥 → 落盘 → 断开停机，验证不是只有桥能跑。
 *
 * 运行：
 *   node test/local-gpu-host.mjs
 *
 * 配置来源与 live 用例相同：local-gpu.json / AIGC_STUDIO_LOCAL_GPU_*。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readLocalGpuConfig } from '../server/local-gpu/config.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const STANDALONE = join(ROOT, 'server', 'standalone.js')
const TOKEN = 'local-gpu-host-e2e-token'
const SIZE = Math.max(256, Math.min(1024, Number(process.env.AIGC_LOCAL_GPU_SIZE) || 512))
const TIMEOUT_MS = 10 * 60 * 1000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function startServer({ dataDir, workspace }) {
  const child = spawn(process.execPath, [STANDALONE], {
    cwd: ROOT,
    env: {
      ...process.env,
      AIGC_STUDIO_PORT: '0',
      AIGC_STUDIO_TOKEN: TOKEN,
      AIGC_STUDIO_DATA_DIR: dataDir,
      AIGC_STUDIO_WORKSPACE: workspace,
      AIGC_STUDIO_WEB_DIST: join(ROOT, 'dist', 'web'),
      AIGC_STUDIO_DEV: '0',
      AIGC_STUDIO_HOSTED: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const ready = new Promise((resolve, reject) => {
    let buffer = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`standalone 启动超时：${stderr.slice(-1000)}`)), 40000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n')
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        try {
          const parsed = JSON.parse(line)
          if (parsed?.type === 'ready') {
            clearTimeout(timer)
            resolve({ child, baseUrl: `http://127.0.0.1:${parsed.port}`, ready: parsed })
          }
        } catch {}
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`standalone 提前退出 code=${code}：${stderr.slice(-1000)}`))
    })
  })
  return ready
}

async function jsonFetch(baseUrl, pathname, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${pathname} 返回非 JSON：${text.slice(0, 300)}`)
  }
  if (!response.ok) {
    throw new Error(`${pathname} HTTP ${response.status}：${payload?.error?.message ?? text.slice(0, 500)}`)
  }
  return payload
}

async function waitFor(label, fn, { timeoutMs = 120000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`等待超时：${label}${last ? `（${JSON.stringify(last).slice(0, 300)}）` : ''}`)
}

async function main() {
  const configResult = readLocalGpuConfig({ root: '', env: process.env })
  // 也接受真实应用数据目录里的配置：数据目录只用于测试 Host，不复制模型。
  const appRoot = process.env.AIGC_STUDIO_DATA_DIR || ''
  const sourceConfig = configResult.ok ? configResult : readLocalGpuConfig({ root: appRoot, env: process.env })
  if (!sourceConfig.ok) {
    console.error(`本机 GPU 未配置：${sourceConfig.errors.join('；')}`)
    process.exitCode = 2
    return
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'aigc-local-gpu-host-data-'))
  const workspace = await mkdtemp(join(tmpdir(), 'aigc-local-gpu-host-ws-'))
  await mkdir(workspace, { recursive: true })
  await writeFile(join(dataDir, 'local-gpu.json'), JSON.stringify({
    ...sourceConfig.config,
    baseDir: undefined,
  }, null, 2))
  let server = null
  let sdPid = null
  try {
    console.log(`配置：${sourceConfig.config.modelPath}`)
    console.log('启动 standalone …')
    const started = await startServer({ dataDir, workspace })
    server = started.child
    const baseUrl = started.baseUrl
    console.log(`standalone ready：${baseUrl}`)

    const before = await jsonFetch(baseUrl, '/api/state', { timeoutMs: 15000 })
    console.log(`初始 provider=${before.provider} presets=${before.presets.length}`)

    const saved = await jsonFetch(baseUrl, '/api/settings', {
      method: 'POST',
      body: { provider: 'local-gpu' },
    })
    if (saved.settings.provider !== 'local-gpu') throw new Error('provider 保存失败')

    console.log('启动本机会话 …')
    const startedAt = Date.now()
    await jsonFetch(baseUrl, '/api/session/start', {
      method: 'POST',
      body: { presetId: 'realvisxl-lightning' },
      timeoutMs: 120000,
    })
    const readyState = await waitFor('会话 ready', async () => {
      const state = await jsonFetch(baseUrl, '/api/state', { timeoutMs: 15000 })
      if (state.session?.state === 'error') throw new Error(`会话失败：${state.session.detail}`)
      return state.session?.state === 'ready' ? state : null
    }, { timeoutMs: 120000 })
    console.log(`  就绪 ${((Date.now() - startedAt) / 1000).toFixed(2)}s provider=${readyState.session.provider} device=${readyState.session.device}`)

    const stateFile = join(dataDir, 'local-gpu-runtime.json')
    sdPid = JSON.parse(await readFile(stateFile, 'utf8')).pid
    console.log(`sd-server pid=${sdPid}`)

    console.log(`提交 ${SIZE}x${SIZE} / 4 步 …`)
    const jobStarted = Date.now()
    const submitted = await jsonFetch(baseUrl, '/api/generate', {
      method: 'POST',
      body: {
        presetId: 'realvisxl-lightning',
        prompt: 'a cozy reading nook by a rainy window, warm lamp light, cinematic photograph',
        negativePrompt: 'blurry, low quality, deformed',
        width: SIZE,
        height: SIZE,
        steps: 4,
        cfg: 1,
        count: 1,
        seed: 42,
      },
      timeoutMs: 30000,
    })
    if (!submitted?.id) throw new Error('生成请求没有返回 job')
    const finished = await waitFor('任务完成', async () => {
      const result = await jsonFetch(baseUrl, `/api/job?id=${encodeURIComponent(submitted.id)}`, { timeoutMs: 15000 })
      if (result?.status === 'failed') throw new Error(`任务失败：${result.error?.code} ${result.error?.message}`)
      return result?.status === 'done' ? result : null
    }, { timeoutMs: TIMEOUT_MS, intervalMs: 800 })
    const seconds = (Date.now() - jobStarted) / 1000
    const image = finished.output?.images?.[0]
    if (!image) throw new Error('任务完成但没有产物')
    const relative = typeof image === 'string' ? image : image.path ?? image.relativePath
    if (!relative) throw new Error(`无法识别产物路径：${JSON.stringify(image)}`)
    const absolute = join(workspace, relative)
    const file = await stat(absolute)
    if (file.size < 50 * 1024) throw new Error(`产物过小：${file.size}`)
    console.log(`  完成 ${seconds.toFixed(2)}s → ${relative} (${file.size} bytes)`)

    console.log('断开本机会话 …')
    await jsonFetch(baseUrl, '/api/session/stop', { method: 'POST', body: {}, timeoutMs: 30000 })
    await sleep(1500)
    let alive = true
    try {
      process.kill(sdPid, 0)
    } catch {
      alive = false
    }
    if (alive) throw new Error(`sd-server pid=${sdPid} 在断开后仍存活`)
    console.log('  sd-server 已退出')

    console.log('\n结果')
    console.log(JSON.stringify({
      ok: true,
      provider: readyState.session.provider,
      device: readyState.session.device,
      size: `${SIZE}x${SIZE}`,
      seconds: Number(seconds.toFixed(2)),
      output: relative,
      bytes: file.size,
    }, null, 2))
  } finally {
    if (server) {
      server.kill('SIGTERM')
      await sleep(1200)
      if (!server.killed) server.kill('SIGKILL')
    }
    if (sdPid) {
      try {
        process.kill(sdPid, 0)
        if (process.platform === 'win32') {
          const { execFile } = await import('node:child_process')
          await new Promise((resolve) => execFile('taskkill', ['/PID', String(sdPid), '/T', '/F'], () => resolve()))
        } else {
          process.kill(sdPid, 'SIGKILL')
        }
      } catch {}
    }
    if (!process.env.AIGC_KEEP_LOCAL_GPU_TEST_DIRS) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => {})
      await rm(workspace, { recursive: true, force: true }).catch(() => {})
    } else {
      console.log(`测试目录保留：${dataDir} / ${workspace}`)
    }
  }
}

main().catch((error) => {
  console.error(`\n失败：${error?.message ?? error}`)
  process.exitCode = 1
})

