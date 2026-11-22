#!/usr/bin/env node
/**
 * 私有 Worker Host 侧离线回归（M3.1-b）。
 *
 * 覆盖：
 *  - app-config：地址落 app-config、Token 加密落 credentials/workers.json、公开视图仅 tokenConfigured；
 *  - /api/app-settings 的 worker 段：保存 / 清除 / 非法地址拒绝；
 *  - /api/worker/probe：成功、401、协议不匹配、不可达、非法地址、已保存 Token 回落；
 *  - 真实 private-worker provider：provision / checkAlive / readLogs / teardown（共享 Worker 不发 /shutdown）；
 *  - SessionManager：用真实 provider（非 fake）连接 → ready → 断开，Token 不进快照与日志。
 *
 * 不联网、不需要 GPU：Worker 用本机 mock HTTP 服务（只实现 /health /logs /shutdown）。
 *
 * 运行：node test/worker-host.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROTOCOL_VERSION } from '../shared/contract.js'
import { createAppConfig } from '../server/app-config.js'
import { createProvider } from '../server/providers/index.js'
import { createAppSettingsRoutes } from '../server/routes/app-settings.js'
import { createWorkerRoutes } from '../server/routes/worker.js'
import { SessionManager } from '../server/session.js'
import { logLeaksToken } from './helpers/log-scan.mjs'
import { createCheckRunner } from './helpers/check.mjs'
import { closeServer, json, startHost, workspaceContext } from './helpers/fake-context.mjs'

const { check, summary } = createCheckRunner()

const TOKEN = 'worker-test-token-0123456789abcdef0123456789abcdef'
const CREDENTIAL_KEY = 'a'.repeat(64)
const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const tempDirs = []

async function makeDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, { timeoutMs = 8000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(intervalMs)
  }
  throw new Error(`等待超时：${label}`)
}

/**
 * 本机 mock Worker：Bearer 鉴权 + 可配置 phase / 协议 / 能力。
 * /shutdown 只计数，用来断言「共享 Worker 断开时不能被关机」。
 */
async function startMockWorker({
  token = TOKEN,
  protocolVersion = PROTOCOL_VERSION,
  phase = 'ready',
  tools = ['generate', 'upscale'],
  hardware = { gpu_name: 'Mock RTX 4090', vram_total_mb: 24564, driver: '550.54.14', cuda: '12.4', count: 1 },
} = {}) {
  const state = { healthHits: 0, shutdownHits: 0, logsHits: 0 }
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'bad token' } }))
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      state.healthHits += 1
      const body = JSON.stringify({
        status: phase === 'error' ? 'error' : 'ok',
        phase,
        protocol_version: protocolVersion,
        capabilities: { result_modes: ['inline', 'binary'], events: true, artifact_range: true, tools, loaders: ['sdxl'] },
        hardware,
        model_id: 'test/model',
        device: hardware.gpu_name,
        device_count: hardware.count,
        idle_seconds: 0,
        idle_timeout_sec: 0,
        last_error: phase === 'error' ? 'mock boot failure' : null,
      })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    if (url.pathname === '/logs') {
      state.logsHits += 1
      const body = JSON.stringify({ lines: ['[boot] ready', '[job] done'], next: 2 })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
      return
    }
    if (url.pathname === '/shutdown') {
      state.shutdownHits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'shutting_down' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }))
  })
  const port = await listen(server)
  return {
    state,
    endpoint: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  }
}

async function closedEndpoint() {
  const probe = createServer(() => {})
  const port = await listen(probe)
  await closeServer(probe)
  return `http://127.0.0.1:${port}`
}

async function makeAppConfig(options = {}) {
  const dataDir = options.dataDir ?? await makeDir('aigc-worker-config-')
  const appConfig = createAppConfig({
    dataDir,
    credentialKey: options.credentialKey ?? CREDENTIAL_KEY,
    log: silentLog,
  })
  await appConfig.whenReady()
  return { dataDir, appConfig }
}

/** 直接构造真实 provider；options.getWorkerConfig 是装配层注入的 getter。 */
function makeProvider(endpoint, token = TOKEN, log = silentLog) {
  return createProvider('private-worker', {
    ctx: null,
    deps: {},
    log,
    options: { getWorkerConfig: () => ({ endpointUrl: endpoint, token, tokenConfigured: Boolean(token) }) },
  })
}

async function findWorkerCredentials(dataDir) {
  const path = join(dataDir, 'credentials', 'workers.json')
  return readFile(path, 'utf8')
}

// ── A. app-config：地址与 Token 分仓 ─────────────────────────────────────

await check('app-config：地址写 app-config、Token 加密落盘、公开视图只回 tokenConfigured', async () => {
  const { dataDir, appConfig } = await makeAppConfig()
  try {
    const saved = await appConfig.saveWorkerSettings({
      endpointUrl: 'http://127.0.0.1:8765/',
      token: TOKEN,
    })
    assert.deepEqual(saved, { ok: true })

    const internal = appConfig.getWorkerConfig()
    assert.equal(internal.endpointUrl, 'http://127.0.0.1:8765')
    assert.equal(internal.token, TOKEN)
    assert.deepEqual(appConfig.publicWorkerView(), { endpointUrl: 'http://127.0.0.1:8765', tokenConfigured: true })

    const configRaw = await readFile(join(dataDir, 'app-config.json'), 'utf8')
    assert.equal(configRaw.includes(TOKEN), false, 'app-config.json 不能出现 Token')
    const credentialsRaw = await findWorkerCredentials(dataDir)
    assert.equal(credentialsRaw.includes(TOKEN), false, 'workers.json 不能出现明文 Token')
    assert.ok(credentialsRaw.includes('"enc": "aes-256-gcm"'), 'workers.json 必须使用 AES-256-GCM')

    const appView = appConfig.publicSettingsView()
    assert.deepEqual(appView.worker, { endpointUrl: 'http://127.0.0.1:8765', tokenConfigured: true })
    assert.equal(JSON.stringify(appView).includes(TOKEN), false, '公开设置视图不能出现 Token')

    // 重启进程仍能解密读回。
    const reopened = createAppConfig({ dataDir, credentialKey: CREDENTIAL_KEY, log: silentLog })
    await reopened.whenReady()
    assert.deepEqual(reopened.publicWorkerView(), { endpointUrl: 'http://127.0.0.1:8765', tokenConfigured: true })
    assert.equal(reopened.getWorkerConfig().token, TOKEN)

    await appConfig.saveWorkerSettings({ clearToken: true })
    assert.deepEqual(appConfig.publicWorkerView(), { endpointUrl: 'http://127.0.0.1:8765', tokenConfigured: false })
    const afterClear = await readFile(join(dataDir, 'credentials', 'workers.json'), 'utf8').catch(() => '')
    assert.equal(afterClear, '', '清除 Token 后应删除 workers.json')
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
})

await check('app-config：非法地址拒绝、空地址清除、Token 超长拒绝', async () => {
  const { dataDir, appConfig } = await makeAppConfig()
  try {
    const publicHttp = await appConfig.saveWorkerSettings({ endpointUrl: 'http://gpu.example.com:8765' })
    assert.equal(publicHttp.ok, false)
    assert.equal(publicHttp.code, 'invalid_request')
    assert.ok(publicHttp.message.includes('https'))

    const badToken = await appConfig.saveWorkerSettings({ endpointUrl: 'http://127.0.0.1:8765', token: 'x'.repeat(600) })
    assert.equal(badToken.ok, false)
    assert.equal(badToken.code, 'invalid_request')

    assert.equal((await appConfig.saveWorkerSettings({ endpointUrl: 'https://gpu.example.com:8765' })).ok, true)
    assert.equal((await appConfig.saveWorkerSettings({ endpointUrl: '' })).ok, true)
    assert.deepEqual(appConfig.publicWorkerView(), { endpointUrl: '', tokenConfigured: false })
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── B. /api/app-settings 的 worker 段 ────────────────────────────────────

await check('POST /api/app-settings：保存 worker 段只回 tokenConfigured，非法地址 400', async () => {
  const { dataDir, appConfig } = await makeAppConfig()
  const host = await startHost(createAppSettingsRoutes({ appConfig, version: '0.15.0', log: silentLog }))
  try {
    const saved = await json(host.origin, '/api/app-settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker: { endpointUrl: 'https://gpu.example.com:8765', token: TOKEN } }),
    })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.settings.worker, { endpointUrl: 'https://gpu.example.com:8765', tokenConfigured: true })
    assert.equal(saved.text.includes(TOKEN), false, '响应不能回传 Token')

    const rejected = await json(host.origin, '/api/app-settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker: { endpointUrl: 'http://gpu.example.com:8765' } }),
    })
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.error.code, 'invalid_request')

    const cleared = await json(host.origin, '/api/app-settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker: { clearToken: true } }),
    })
    assert.equal(cleared.status, 200)
    assert.deepEqual(cleared.body.settings.worker, { endpointUrl: 'https://gpu.example.com:8765', tokenConfigured: false })
  } finally {
    await closeServer(host.server)
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── C. /api/worker/probe ────────────────────────────────────────────────

await check('POST /api/worker/probe：成功 / 401 / 协议不匹配 / 不可达 / 非法地址', async () => {
  const worker = await startMockWorker()
  const { dataDir, appConfig } = await makeAppConfig()
  await appConfig.saveWorkerSettings({ endpointUrl: worker.endpoint, token: TOKEN })
  const host = await startHost(createWorkerRoutes({ appConfig, log: silentLog }))
  const post = (body) => json(host.origin, '/api/worker/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  try {
    const ok = await post({ endpointUrl: worker.endpoint, token: TOKEN })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.probe.protocolVersion, PROTOCOL_VERSION)
    assert.equal(ok.body.probe.hardware.gpu_name, 'Mock RTX 4090')
    assert.equal(ok.body.probe.capabilities.events, true)
    assert.equal(ok.text.includes(TOKEN), false, '探测响应不能回传 Token')

    // 只给已保存地址：Host 用已保存 Token 回落。
    const stored = await post({ endpointUrl: worker.endpoint })
    assert.equal(stored.body.ok, true, '同地址应回落到已保存 Token')

    const bad = await post({ endpointUrl: worker.endpoint, token: 'wrong-token' })
    assert.equal(bad.status, 200)
    assert.equal(bad.body.ok, false)
    assert.equal(bad.body.probe.error.code, 'worker_unauthorized')
    assert.equal(bad.text.includes('wrong-token'), false, '错误响应不能回显 Token')

    const closed = await post({ endpointUrl: await closedEndpoint(), token: TOKEN })
    assert.equal(closed.body.ok, false)
    assert.equal(closed.body.probe.error.code, 'worker_unreachable')

    const invalid = await post({ endpointUrl: 'http://gpu.example.com:8765' })
    assert.equal(invalid.body.ok, false)
    assert.equal(invalid.body.probe.error.code, 'invalid_request')
    assert.ok(invalid.body.probe.error.message.includes('https'))

    // 不同地址且未提供 Token：绝不能把本地 Token 发给陌生地址。
    const other = await startMockWorker()
    const otherProbe = await post({ endpointUrl: other.endpoint })
    assert.equal(otherProbe.body.ok, false)
    assert.equal(otherProbe.body.probe.error.code, 'worker_unauthorized')
    await other.close()
  } finally {
    await closeServer(host.server)
    await worker.close()
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
})

await check('POST /api/worker/probe：协议主版本不一致仍返回 GPU 与协议版本', async () => {
  const worker = await startMockWorker({ protocolVersion: '1.0.0' })
  const host = await startHost(createWorkerRoutes({ log: silentLog }))
  try {
    const res = await json(host.origin, '/api/worker/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpointUrl: worker.endpoint, token: TOKEN }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, false)
    assert.equal(res.body.probe.error.code, 'protocol_mismatch')
    assert.equal(res.body.probe.protocolVersion, '1.0.0')
    assert.equal(res.body.probe.hardware.gpu_name, 'Mock RTX 4090')
  } finally {
    await closeServer(host.server)
    await worker.close()
  }
})

// ── D. 真实 provider ────────────────────────────────────────────────────

await check('private-worker provider：provision / checkAlive / readLogs / teardown 不关机', async () => {
  const worker = await startMockWorker()
  try {
    const provider = makeProvider(worker.endpoint)
    const run = { isCurrent: () => true, session: {}, secret: {} }
    const { handle, token } = await provider.provision(run, {})
    assert.equal(handle.kind, 'worker')
    assert.equal(handle.endpointUrl, worker.endpoint)
    assert.equal(handle.protocolVersion, PROTOCOL_VERSION)
    assert.equal(handle.workerId, `127.0.0.1:${new URL(worker.endpoint).port}`)
    assert.equal(token, TOKEN)
    assert.equal(Object.prototype.hasOwnProperty.call(handle, 'token'), false, 'handle 不能带 Token')

    assert.deepEqual(await provider.checkAlive(run, handle), { alive: true, status: 'ready' })
    assert.equal(await provider.readLogs(run, handle), '[boot] ready\n[job] done')

    const torn = await provider.teardown(run, { ...handle, token })
    assert.equal(torn.ok, true)
    assert.equal(worker.state.shutdownHits, 0, '共享 Worker 断开时绝不能调用 /shutdown')
  } finally {
    await worker.close()
  }
})

await check('private-worker provider：鉴权失败 / 协议不匹配 / phase=error / 能力缺失 / 非法地址分类', async () => {
  const cases = []
  const workers = []
  const addCase = async (label, serverOptions, token, expected) => {
    const worker = await startMockWorker(serverOptions)
    workers.push(worker)
    cases.push([label, worker.endpoint, token, expected])
  }
  await addCase('wrong token', {}, 'wrong-token', 'worker_unauthorized')
  await addCase('protocol mismatch', { protocolVersion: '1.0.0' }, TOKEN, 'protocol_mismatch')
  await addCase('phase error', { phase: 'error' }, TOKEN, 'remote_error')
  await addCase('capability missing', { tools: ['upscale'] }, TOKEN, 'capability_missing')

  try {
    for (const [label, endpoint, token, expected] of cases) {
      const provider = makeProvider(endpoint, token)
      let code = ''
      try {
        await provider.provision({ isCurrent: () => true, session: {}, secret: {} }, {})
      } catch (error) {
        code = error?.code ?? ''
      }
      assert.equal(code, expected, `${label} 应归为 ${expected}`)
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.close()))
  }

  const invalid = makeProvider('http://gpu.example.com:8765')
  let message = ''
  try {
    await invalid.provision({ isCurrent: () => true, session: {}, secret: {} }, {})
  } catch (error) {
    message = String(error?.message ?? error)
    assert.equal(error.code, 'worker_unreachable')
  }
  assert.ok(message.includes('https'), '公网明文 HTTP 应提示必须使用 https')
})

// ── E. SessionManager：真实 provider 全链路 ─────────────────────────────

await check('SessionManager：真实 provider 连接 → ready → 断开，Token 不进快照与日志', async () => {
  const worker = await startMockWorker()
  const workspace = await makeDir('aigc-worker-session-')
  const logLines = []
  const push = (...args) => logLines.push(args.join(' '))
  const sink = Object.assign(push, { debug: push, info: push, warn: push, error: push })
  const manager = new SessionManager({
    ctx: workspaceContext(workspace),
    defaultPreset: 'sdxl-lightning',
    options: {
      provider: 'private-worker',
      getWorkerConfig: () => ({ endpointUrl: worker.endpoint, token: TOKEN, tokenConfigured: true }),
      tickMs: 20,
      healthyIntervalMs: 40,
      kernelPollMs: 40,
      recoveryTimeoutMs: 2000,
    },
    deps: { log: sink },
  })
  try {
    await manager.start()
    const ready = await waitFor('worker ready', async () => {
      const snap = manager.snapshot()
      return snap.state === 'ready' ? snap : null
    })
    assert.equal(ready.provider, 'private-worker')
    assert.equal(ready.endpointUrl, worker.endpoint)
    assert.equal(ready.device, 'Mock RTX 4090')
    assert.equal(ready.idleTimeoutSec, null, 'Worker 没有 Host 侧空闲关机')
    assert.equal(JSON.stringify(ready).includes(TOKEN), false, '快照不能出现 Token')

    const stopped = await manager.stop()
    assert.equal(stopped.state, 'absent')
    assert.ok(String(stopped.detail ?? '').includes('断开'))
    assert.equal(worker.state.shutdownHits, 0, '断开共享 Worker 不得发 /shutdown')
    assert.equal(logLeaksToken(logLines, TOKEN), false, `日志泄露 Token：${logLines.length} 行`)
  } finally {
    manager.dispose()
    await manager.disposeCleanup
    await worker.close()
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 清理 ────────────────────────────────────────────────────────────────

await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
summary()