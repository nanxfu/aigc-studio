#!/usr/bin/env node
/**
 * 长驻 Worker 接入的离线回归（M3.0 底座验收）。
 *
 * 覆盖：
 *   A. Provider 注册表：已知来源、worker/notebook 判定、未知 id 可读报错；
 *   B. 会话记录 v2：worker 记录往返、未知来源/缺字段拒绝、notebook 仍写 v1；
 *   C. 会话状态机：fake worker 走通 start（连接 + /health → ready）→ stop（只断开、不发 /shutdown）；
 *   D. 启动恢复：进程重启后按 v2 记录接管；Worker 不可达时给出 worker_unreachable 且保留记录；
 *   E. 协议不匹配：/health.protocol_version 主版本不同 → protocol_mismatch，不发任务；
 *   F. 安全：token 只落盘，不进日志与快照。
 *
 * 实现方式：真实 SessionManager + 本机 mock Worker（只实现 /health 与 /shutdown 计数），
 * provider 用 server/providers/fake-worker.js（M3.1 真实连接器的等价替身）。
 *
 * 运行：node test/session-worker.mjs
 */

import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROTOCOL_VERSION, PROVIDER_IDS, PROVIDERS } from '../shared/contract.js'
import { SessionManager } from '../server/session.js'
import { createProvider, isCloudApiProvider, isWorkerProvider, providerKindOf } from '../server/providers/index.js'
import { createFakeWorkerProvider } from '../server/providers/fake-worker.js'
import { normalizeWorkerEndpoint } from '../server/providers/worker-url.js'
import {
  SESSION_RECORD_VERSION,
  SESSION_RECORD_VERSION_NOTEBOOK,
  buildSessionRecord,
  readSessionRecord,
  sessionRecordPath,
  writeSessionRecord,
} from '../server/session/persistence.js'
import { emptySession } from '../server/session/state.js'
import { logLeaksToken } from './helpers/log-scan.mjs'

const PRESET = 'sdxl-lightning'
const TOKEN = 'worker-secret-token-0123456789'
const WORKER_ID = 'gpu-box-1'
const ACCELERATED = { tickMs: 20, healthyIntervalMs: 40, kernelPollMs: 40, recoveryTimeoutMs: 2000 }

const failures = []
const logLines = []

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? `：${detail}` : ''}`)
  }
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function closeServer(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(() => resolve()))
}

function makeCtx(workspace) {
  return {
    get(name) {
      return name === 'workingDirectory' ? { defaultDirectory: workspace } : undefined
    },
  }
}

function makeLogSink() {
  const push = (...args) => logLines.push(args.join(' '))
  return Object.assign(push, {
    debug: push,
    info: push,
    warn: push,
    error: push,
  })
}

async function withWorkspace(fn) {
  const workspace = await mkdtemp(join(tmpdir(), 'aigc-worker-session-'))
  try {
    return await fn(workspace)
  } finally {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(workspace, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === 9) throw error
        await sleep(20)
      }
    }
  }
}

/**
 * 本机 mock Worker：/health 返回可配置载荷，/shutdown 只计数（共享 Worker 不应被调用）。
 * 校验 Bearer，便于覆盖鉴权失败路径。
 */
async function startMockWorker({ phase = 'ready', protocolVersion = PROTOCOL_VERSION, token = TOKEN } = {}) {
  const state = { phase, protocolVersion, healthHits: 0, shutdownHits: 0, fail: false }
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
      if (state.fail) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'internal_error', message: 'mock worker down' } }))
        return
      }
      const body = JSON.stringify({
        status: state.phase === 'error' ? 'error' : 'ok',
        phase: state.phase,
        version: state.protocolVersion,
        protocol_version: state.protocolVersion,
        capabilities: { result_modes: ['inline'], events: false, tools: ['generate', 'upscale'] },
        hardware: { gpu_name: 'Fake RTX', vram_total_mb: 12288, count: 1 },
        model_id: 'test/model',
        loaded: ['test'],
        device: 'Fake RTX',
        device_count: 1,
        idle_seconds: 0,
        idle_timeout_sec: 0,
        jobs_done: 0,
        queue_depth: 0,
        last_error: null,
        tunnel_provider: null,
      })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    if (url.pathname === '/shutdown') {
      state.shutdownHits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
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

/** 已经关闭的端口：制造「Worker 不可达」。 */
async function closedEndpoint() {
  const probe = createServer(() => {})
  const port = await listen(probe)
  await closeServer(probe)
  return `http://127.0.0.1:${port}`
}

function makeSession({ workspace, endpoint, protocolVersion = PROTOCOL_VERSION, token = TOKEN, options = {} }) {
  const provider = createFakeWorkerProvider({
    endpointUrl: endpoint,
    token,
    workerId: WORKER_ID,
    protocolVersion,
    log: makeLogSink(),
  })
  return new SessionManager({
    ctx: makeCtx(workspace),
    defaultPreset: PRESET,
    deps: { provider, log: makeLogSink() },
    options: { ...ACCELERATED, ...options },
  })
}

// ---- A. Provider 注册表 ---------------------------------------------------

async function scenarioRegistry() {
  console.log('\n── A 注册表与能力位')
  check('契约登记 5 个来源', PROVIDER_IDS.length === 5, PROVIDER_IDS.join(', '))
  check('kaggle/colab 是 notebook 型', !isWorkerProvider('kaggle') && !isWorkerProvider('colab'))
  check(
    'private-worker/local-gpu 是 worker 型',
    isWorkerProvider('private-worker') && isWorkerProvider('local-gpu') && providerKindOf('local-gpu') === 'worker',
  )
  check('能力位：共享 Worker 默认不关机、不补清理', PROVIDERS['private-worker'].remoteShutdown === false && PROVIDERS['private-worker'].pendingCleanup === false)
  check(
    'cloud-api 是商业 API 型（无会话 / 无补清理 / 不关机）',
    isCloudApiProvider('cloud-api')
      && providerKindOf('cloud-api') === 'cloud-api'
      && PROVIDERS['cloud-api'].pendingCleanup === false
      && PROVIDERS['cloud-api'].remoteShutdown === false,
  )
  check('能力位：本机 GPU 由 Host 托管（owned）', PROVIDERS['local-gpu'].owned === true)

  for (const id of PROVIDER_IDS) {
    const provider = createProvider(id, { ctx: null, deps: {}, log: makeLogSink(), options: {} })
    check(`createProvider('${id}') 构造正确`, provider.id === id, provider.id)
  }
  let message = ''
  try {
    createProvider('nope', { ctx: null, deps: {}, log: makeLogSink() })
  } catch (error) {
    message = String(error?.message ?? error)
  }
  check('未登记的来源给出可读错误', message.includes('未注册的算力来源') && message.includes('nope'), message)

  // 状态机按设置切换来源时也走注册表（不注入 deps.provider 的路径）。
  const manager = new SessionManager({ ctx: { get: () => undefined }, defaultPreset: PRESET, options: { provider: 'kaggle' } })
  check('默认按设置构造 KaggleProvider', manager.provider.id === 'kaggle', manager.provider.id)
  manager.applyProviderSettings({ provider: 'private-worker' })
  check('设置切换后构造 Worker 型 provider', manager.provider.id === 'private-worker', manager.provider.id)
  manager.applyProviderSettings({ provider: 'local-gpu' })
  check('设置切换后构造本机 GPU provider', manager.provider.id === 'local-gpu', manager.provider.id)
  manager.dispose()
  await manager.disposeCleanup
}

// ---- A2. 地址安全策略 -----------------------------------------------------

async function scenarioEndpointPolicy() {
  console.log('\n── A2 Worker 地址：HTTPS 强制与凭据检查')
  const ok = [
    ['https://gpu.example.com:8765/', 'https://gpu.example.com:8765'],
    ['http://127.0.0.1:8765', 'http://127.0.0.1:8765'],
    ['http://localhost:8765/', 'http://localhost:8765'],
    ['http://[::1]:8765', 'http://[::1]:8765'],
  ]
  for (const [input, expected] of ok) {
    const result = normalizeWorkerEndpoint(input)
    check(`接受 ${input}`, result.ok === true && result.endpointUrl === expected, JSON.stringify(result))
  }
  const rejected = [
    ['http://gpu.example.com:8765', 'https'],
    ['http://192.168.1.10:8765', 'https'],
    ['ftp://gpu.example.com', 'http'],
    ['https://user:pass@gpu.example.com', '用户名'],
    ['https://gpu.example.com/?token=abc', '查询参数'],
    ['', '请填写'],
    ['not a url', '格式'],
  ]
  for (const [input, needle] of rejected) {
    const result = normalizeWorkerEndpoint(input)
    check(`拒绝 ${input || '(空)'}`, result.ok === false && result.message.includes(needle), JSON.stringify(result))
  }

  await withWorkspace(async (workspace) => {
    const session = makeSession({ workspace, endpoint: 'http://gpu.example.com:8765' })
    const snap = await (async () => {
      await session.start()
      return waitFor('endpoint rejected', async () => {
        const value = session.snapshot()
        return value.state === 'error' ? value : null
      })
    })()
    check('公网明文 HTTP 在启动时被拒绝', snap.error?.code === 'worker_unreachable' && String(snap.error?.message).includes('https'))
    session.dispose()
    await session.disposeCleanup
  })
}

// ---- B. 会话记录 v2 -------------------------------------------------------

async function scenarioRecordV2() {
  console.log('\n── B 会话记录 v1/v2')
  await withWorkspace(async (workspace) => {
    const ctx = makeCtx(workspace)
    const session = {
      ...emptySession({ idleTimeoutSec: null }),
      presetId: PRESET,
      endpointUrl: 'https://gpu.example.com:8765',
      startedAt: '2026-11-22T00:00:00.000Z',
      readyAt: '2026-11-22T00:00:05.000Z',
      state: 'ready',
    }
    const v2 = buildSessionRecord(session, { token: TOKEN }, {
      provider: 'private-worker',
      handle: { kind: 'worker', workerId: WORKER_ID, protocolVersion: PROTOCOL_VERSION },
    })
    check('worker 记录写 v2', v2?.version === SESSION_RECORD_VERSION && v2.provider === 'private-worker')
    check(
      'v2 记录字段：endpoint/token/handle，不含 kernelId',
      v2.endpointUrl === 'https://gpu.example.com:8765' &&
        v2.token === TOKEN &&
        v2.handle?.workerId === WORKER_ID &&
        v2.handle?.protocolVersion === PROTOCOL_VERSION &&
        !('kernelId' in v2),
    )

    await writeSessionRecord(ctx, v2)
    const loaded = await readSessionRecord(ctx)
    check(
      'v2 记录可往返读取',
      loaded?.version === SESSION_RECORD_VERSION &&
        loaded.provider === 'private-worker' &&
        loaded.endpointUrl === session.endpointUrl &&
        loaded.token === TOKEN &&
        loaded.handle?.workerId === WORKER_ID,
    )

    // notebook 记录仍写 v1（旧客户端可读）。
    const v1 = buildSessionRecord(
      { ...emptySession({ idleTimeoutSec: 1800 }), kernelId: 'tester/k', kernelStatus: 'RUNNING', state: 'ready' },
      { token: TOKEN, topic: 'imagen-topic' },
      { provider: 'kaggle', handle: null },
    )
    check('notebook 记录仍写 v1', v1?.version === SESSION_RECORD_VERSION_NOTEBOOK && !('handle' in v1))

    // v2 未知来源：整条记录判无效并清理，绝不猜成 Kaggle。
    const path = sessionRecordPath(ctx)
    const unknown = JSON.stringify({
      version: SESSION_RECORD_VERSION,
      provider: 'some-vendor',
      endpointUrl: 'https://x.example.com',
      token: TOKEN,
      handle: { workerId: 'x' },
    })
    await writeFile(path, unknown, 'utf8')
    check('v2 未知来源被拒绝', (await readSessionRecord(ctx)) === null)
    check('v2 无效记录被清理', !existsSync(path))

    const missing = JSON.stringify({ version: SESSION_RECORD_VERSION, provider: 'private-worker', token: TOKEN })
    await writeFile(path, missing, 'utf8')
    check('v2 缺地址被拒绝', (await readSessionRecord(ctx)) === null)
  })
}

// ---- C. 启动 / 停止 -------------------------------------------------------

async function scenarioStartStop() {
  console.log('\n── C start → ready → stop')
  const worker = await startMockWorker()
  try {
    await withWorkspace(async (workspace) => {
      const session = makeSession({ workspace, endpoint: worker.endpoint })
      const started = session.start()
      const snap = await waitFor('worker ready', async () => {
        const value = session.snapshot()
        return value.state === 'ready' ? value : null
      })
      await started
      check('会话进入 ready', snap.state === 'ready', snap.state)
      check('快照指向私有 Worker', snap.provider === 'private-worker', snap.provider)
      check('地址来自 Worker', snap.endpointUrl === worker.endpoint, snap.endpointUrl)
      check('设备信息写入快照', snap.device === 'Fake RTX' && snap.deviceCount === 1)
      check('Worker 没有 Host 侧空闲关机', snap.idleTimeoutSec === null, String(snap.idleTimeoutSec))

      // 等待记录落盘（ready 是关键节点，会强制写一次）。
      const record = await waitFor('v2 record', async () => {
        const value = await readSessionRecord(makeCtx(workspace))
        return value?.version === SESSION_RECORD_VERSION ? value : null
      })
      check('落盘记录为 v2 且来源正确', record.provider === 'private-worker' && record.endpointUrl === worker.endpoint)
      check('记录里含连接令牌', record.token === TOKEN)
      check('记录 handle 可序列化', record.handle?.workerId === WORKER_ID)
      check('快照不含 token', !JSON.stringify(snap).includes(TOKEN))

      const stopped = await session.stop()
      check('stop 后回到 absent', stopped.state === 'absent', stopped.state)
      check('断开文案不说“关机”', String(stopped.detail ?? '').includes('断开'), String(stopped.detail ?? ''))
      check('共享 Worker 未被 /shutdown', worker.state.shutdownHits === 0, `shutdownHits=${worker.state.shutdownHits}`)
      check('stop 清理本地记录', !existsSync(sessionRecordPath(makeCtx(workspace))))
      session.dispose()
      await session.disposeCleanup
    })
  } finally {
    await worker.close()
  }
}

async function scenarioHeartbeatLoss() {
  console.log('\n── C2 心跳丢失：固定地址重试并收敛为可读错误')
  const worker = await startMockWorker()
  try {
    await withWorkspace(async (workspace) => {
      const session = makeSession({ workspace, endpoint: worker.endpoint, options: { healthyIntervalMs: 20 } })
      await session.start()
      await waitFor('ready', async () => (session.snapshot().state === 'ready' ? true : null))
      worker.state.fail = true
      const snap = await waitFor('error', async () => {
        const value = session.snapshot()
        return value.state === 'error' ? value : null
      })
      check('心跳丢失不把会话挂在 connecting', snap.state !== 'connecting', snap.state)
      check(
        '收敛为 worker_unreachable / worker_unauthorized / health_failed',
        ['worker_unreachable', 'worker_unauthorized', 'health_failed'].includes(snap.error?.code),
        snap.error?.code,
      )
      check('错误文案可执行', /检查|重试|点「连接」/.test(String(snap.error?.message ?? '')))
      session.dispose()
      await session.disposeCleanup
    })
  } finally {
    await worker.close()
  }
}

// ---- D. 启动恢复 ----------------------------------------------------------

async function scenarioRestore() {
  console.log('\n── D 进程重启后按 v2 记录接管')
  const worker = await startMockWorker()
  try {
    await withWorkspace(async (workspace) => {
      const first = makeSession({ workspace, endpoint: worker.endpoint })
      await first.start()
      await waitFor('first ready', async () => (first.snapshot().state === 'ready' ? true : null))
      const record = await waitFor('record written', async () => readSessionRecord(makeCtx(workspace)))
      // 干净退出会把本地记录一起清掉（共享 Worker 无需补清理；下次启动按设置重新连接）。
      first.dispose()
      await first.disposeCleanup
      check('干净退出清理本地记录', (await readSessionRecord(makeCtx(workspace))) === null)
      // 模拟「上次进程异常退出」留下的 v2 记录，再验证新进程能接管。
      await writeSessionRecord(makeCtx(workspace), record)

      const second = makeSession({ workspace, endpoint: worker.endpoint })
      const restored = await second.restore()
      check('restore 返回快照', Boolean(restored))
      const snap = await waitFor('restored ready', async () => {
        const value = second.snapshot()
        return value.state === 'ready' ? value : null
      })
      check('恢复后为 ready', snap.state === 'ready', snap.state)
      check('恢复后来源正确', snap.provider === 'private-worker', snap.provider)
      check('恢复后沿用同一地址', snap.endpointUrl === worker.endpoint)
      second.dispose()
      await second.disposeCleanup
    })
  } finally {
    await worker.close()
  }
}

async function scenarioUnreachable() {
  console.log('\n── D2 Worker 不可达：可读错误 + 保留记录')
  await withWorkspace(async (workspace) => {
    const ctx = makeCtx(workspace)
    const endpoint = await closedEndpoint()
    await writeSessionRecord(ctx, {
      version: SESSION_RECORD_VERSION,
      provider: 'private-worker',
      endpointUrl: endpoint,
      token: TOKEN,
      handle: { kind: 'worker', workerId: WORKER_ID, protocolVersion: PROTOCOL_VERSION },
      presetId: PRESET,
      startedAt: new Date().toISOString(),
      state: 'ready',
    })
    const session = makeSession({ workspace, endpoint })
    await session.restore()
    const snap = session.snapshot()
    check('不可达 → worker_unreachable', snap.state === 'error' && snap.error?.code === 'worker_unreachable', `${snap.state}/${snap.error?.code}`)
    check('错误文案可执行', String(snap.error?.message ?? '').includes('不可达'))
    check('记录被保留（Worker 恢复后可重连）', existsSync(sessionRecordPath(ctx)))
    session.dispose()
    await session.disposeCleanup
  })
}

// ---- E. 协议不匹配 --------------------------------------------------------

async function scenarioProtocolMismatch() {
  console.log('\n── E 协议主版本不一致')
  const worker = await startMockWorker({ protocolVersion: '1.0.0' })
  try {
    await withWorkspace(async (workspace) => {
      const session = makeSession({ workspace, endpoint: worker.endpoint })
      await session.start()
      const snap = await waitFor('protocol mismatch', async () => {
        const value = session.snapshot()
        return value.state === 'error' ? value : null
      })
      check('错误码为 protocol_mismatch', snap.error?.code === 'protocol_mismatch', snap.error?.code)
      check('提示升级 Worker 或客户端', String(snap.error?.message ?? '').includes('协议版本'))
      check('未落盘可恢复记录', !existsSync(sessionRecordPath(makeCtx(workspace))))
      session.dispose()
      await session.disposeCleanup
    })
  } finally {
    await worker.close()
  }
}

// ---- F. 安全 --------------------------------------------------------------

async function scenarioSecurity() {
  console.log('\n── F token 只落盘')
  const worker = await startMockWorker()
  try {
    await withWorkspace(async (workspace) => {
      const session = makeSession({ workspace, endpoint: worker.endpoint })
      await session.start()
      await waitFor('ready', async () => (session.snapshot().state === 'ready' ? true : null))
      await waitFor('record', async () => Boolean(await readSessionRecord(makeCtx(workspace))))
      const raw = await readFile(sessionRecordPath(makeCtx(workspace)), 'utf8')
      check('token 在记录文件里', raw.includes(TOKEN))
      check('token 不在快照里', !JSON.stringify(session.snapshot()).includes(TOKEN))
      check('token 不在日志里', !logLeaksToken(logLines, TOKEN), `扫描 ${logLines.length} 行日志`)
      session.dispose()
      await session.disposeCleanup
    })
  } finally {
    await worker.close()
  }
}

async function main() {
  console.log('session-worker：长驻 Worker 接入的离线回归（无 GPU / 无外网）')
  for (const scenario of [
    scenarioRegistry,
    scenarioEndpointPolicy,
    scenarioRecordV2,
    scenarioStartStop,
    scenarioHeartbeatLoss,
    scenarioRestore,
    scenarioUnreachable,
    scenarioProtocolMismatch,
    scenarioSecurity,
  ]) {
    try {
      await scenario()
    } catch (error) {
      failures.push(`${scenario.name} 异常`)
      console.log(`  ✗ ${scenario.name} 场景异常：${error?.stack ?? error}`)
    }
  }
  console.log('')
  if (failures.length === 0) {
    console.log('结果：全部通过')
    return
  }
  console.log(`结果：${failures.length} 项失败（${failures.join('、')}）`)
  process.exitCode = 1
}

await main()
