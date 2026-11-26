/**
 * 资产工坊 GPU 后处理（抹除背景 / PBR 材质拆解）的 Host 侧端到端测试。
 *
 * 链路与真机一致，只是把远端换成 mock daemon：
 *   POST /api/workshop/op → JobQueue（工坊分支）→ POST /generate（远端协议）
 *   → GET /job 轮询 → saveJobOutput（多通道落盘）→ GET /api/history（channels 校验）。
 *
 * 覆盖：
 *  - remove-bg：1 张带 `channel:'cutout'` 的结果 → `<role>.png` + meta.channels[] + images[0]；
 *  - pbr：4 张固定顺序结果（albedo / normal / roughness / metallic，涵盖 marigold 与 chord）与 meta.workshopTool；
 *  - 远端载荷形状 `{ tool, model, reference:{image_b64}, workshop:{model, steps} }`；
 *  - 非法 op / model / 越界路径一律 400，不发远端请求；
 *  - `normalizeWorkshopResults` 的 inline / binary 两种结果形状（binary 缺 channel 时按顺序映射）。
 *
 * 不覆盖：真实模型加载与推理（无 GPU、不能下载 HF 权重）。mock 只验证协议与落盘链路，
 * 真机检查点见任务报告。
 *
 * 运行：node test/host-workshop-gpu.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../server/app.js'
import { normalizeWorkshopResults } from '../server/jobs/queue.js'
import { APP_VERSION, ROUTES, WORKSHOP } from '../shared/contract.js'
import { createCheckRunner } from './helpers/check.mjs'
import { closeServer, createFakeContext, json, startHost } from './helpers/fake-context.mjs'

// 1×1 透明 PNG：mock 远端返回的合法图片字节（Host 只关心 PNG 魔数与尺寸字段）。
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const DEV_TOKEN = 'dev-token-test'

const PBR_CHANNELS = [...WORKSHOP.pbr.channels]

/**
 * 模型 id → HF 仓库（与真 daemon 的 ``model_id`` 回包同义：远端回报的是仓库标识，
 * 不是 Host 契约里的模型 id）。
 */
const WORKSHOP_REPOS = {
  'rmbg-2.0': WORKSHOP.cutout.models.find((model) => model.id === 'rmbg-2.0').repo,
  birefnet: WORKSHOP.cutout.models.find((model) => model.id === 'birefnet').repo,
  marigold: WORKSHOP.pbr.models.find((model) => model.id === 'marigold').repo,
  chord: WORKSHOP.pbr.models.find((model) => model.id === 'chord').repo,
}

/**
 * 构造「只保证头部可解析」的源图 PNG：工坊路由与远端只读图片头（宽高 + 魔数），
 * 不需要真实像素数据，因此用例不引入图像编码依赖。
 */
function headerOnlyPng(width, height) {
  const buffer = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 远端 mock daemon：只实现工坊链路需要的协议面（/health /generate /job /shutdown）。
 *
 * 与 test/mock-daemon.py 的工坊分支同形：remove-bg 回 1 张 `channel:'cutout'`，
 * pbr 回 4 张固定顺序通道结果（覆盖 marigold 与 chord）。
 */
function startMockDaemon() {
  const state = {
    generateBodies: [],
    jobs: new Map(),
  }
  const server = createServer((req, res) => {
    const send = (code, value) => {
      const body = Buffer.from(JSON.stringify(value))
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': String(body.length) })
      res.end(body)
    }
    if (req.headers.authorization !== `Bearer ${DEV_TOKEN}`) {
      return send(401, { error: { code: 'unauthorized', message: 'Unauthorized' } })
    }

    if (req.method === 'GET' && req.url === '/health') {
      // 不带 capabilities：Host 走 inline 结果模式（与旧 daemon 兼容分支一致）。
      return send(200, {
        status: 'ok',
        phase: 'ready',
        version: APP_VERSION,
        model_id: 'mock-model',
        device: 'Mock T4',
        device_count: 1,
        idle_seconds: 0,
        idle_timeout_sec: 1800,
        jobs_done: 0,
      })
    }

    if (req.method === 'POST' && req.url === '/generate') {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        state.generateBodies.push(body)
        const jobId = String(body.jobId || `mock-job-${state.generateBodies.length}`)
        const tool = typeof body.tool === 'string' ? body.tool : 'generate'
        const workshop = body.workshop && typeof body.workshop === 'object' ? body.workshop : {}
        const model = String(body.model || workshop.model || '')
        // 远端回报仓库标识（与 worker/daemon.py 的 validate_workshop_spec 返回 model_id 一致）。
        const replyModelId = WORKSHOP_REPOS[model] ?? body.model
        const source = { width: 1024, height: 768 }

        const channelOf = (item) => ({
          name: item,
          seed: 0,
          seconds: 0.05,
          width: source.width,
          height: source.height,
          steps: workshop.steps ?? 0,
          cfg: 0.0,
          png_bytes: 70,
          image_b64: PNG_B64,
          channel: item,
        })
        const results = tool === 'remove-bg'
          ? [channelOf('cutout')]
          : tool === 'pbr'
            ? PBR_CHANNELS.map((channel) => channelOf(channel))
            : body.tasks.map((task) => ({
              name: task.name,
              seed: task.seed,
              seconds: 0.05,
              width: task.width,
              height: task.height,
              steps: task.steps,
              cfg: task.cfg,
              png_bytes: 70,
              image_b64: PNG_B64,
            }))
        state.jobs.set(jobId, {
          status: 'done',
          job_id: jobId,
          model_id: replyModelId,
          tool,
          progress: { done: results.length, total: results.length },
          load_seconds: 0.05,
          results,
          error: null,
        })
        send(202, { status: 'accepted', job_id: jobId, model_id: replyModelId })
      })
      return
    }

    if (req.method === 'GET' && req.url.startsWith('/job?id=')) {
      const id = decodeURIComponent(req.url.slice('/job?id='.length))
      const job = state.jobs.get(id)
      if (!job) return send(404, { error: { code: 'unknown_job', message: '任务不存在或已过期' } })
      return send(200, job)
    }

    if (req.method === 'POST' && req.url === '/shutdown') {
      return send(200, { status: 'shutting_down' })
    }
    return send(404, { error: { code: 'not_found', message: 'Not found' } })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, state, endpoint: `http://127.0.0.1:${port}` })
    })
  })
}

/** 轮询 Host 的 GET /api/job，直到 predicate 成立；超时抛出最后快照便于定位。 */
async function waitUntilJob(origin, id, predicate, { timeoutMs = 10000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const res = await json(origin, `/api/job?id=${encodeURIComponent(id)}`)
    if (res.status === 200) {
      last = res.body
      if (predicate(last)) return last
    }
    await sleep(intervalMs)
  }
  throw new Error(`等待任务超时：${id}，最后一次快照 ${JSON.stringify(last)}`)
}

const { check, summary } = createCheckRunner()

async function main() {
  // 工作区预先只建 outputs/：Host 的 outputRoot 会据此选新目录（与启动后的产物同目录）。
  const workspace = await mkdtemp(join(tmpdir(), 'aigc-workshop-gpu-'))
  const mock = await startMockDaemon()
  const fake = createFakeContext(workspace)
  const host = await startHost(fake.routes)
  fake.setOrigin(host.origin)
  const app = createApp({ ctx: fake.ctx, config: { devEndpoint: mock.endpoint, devToken: DEV_TOKEN } })
  // 缩短远端轮询间隔：生产默认 2s，离线用例只需要验证链路。
  app.queue.options.pollMs = 20
  app.queue.options.pollFailureGraceMs = 1000
  await sleep(50)

  const cleanup = async () => {
    try {
      app.dispose()
    } catch {}
    fake.dispose()
    await closeServer(host.server).catch(() => {})
    await closeServer(mock.server).catch(() => {})
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }

  try {
    const sourceRelative = await seedSourceImage(workspace)

    await check('工坊路由已注册（op / save / export / vectorize）', () => {
      const paths = fake.routes.map((route) => route.path)
      for (const route of [ROUTES.workshopOp, ROUTES.workshopSave, ROUTES.workshopExport, ROUTES.workshopVectorize]) {
        assert.ok(paths.includes(route.path), `缺少路由：${route.path}`)
      }
      assert.equal(typeof app.queue.enqueue, 'function', '队列必须提供 enqueue()（工坊路由按它调用）')
    })

    await check('会话启动（开发模式直连 mock daemon）', async () => {
      const res = await json(host.origin, '/api/session/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetId: 'sdxl-lightning' }),
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal(res.body.session.state, 'ready')
    })

    await check('POST /api/workshop/op 提交 remove-bg → done → 单通道落盘', async () => {
      const res = await postOp(host.origin, {
        op: WORKSHOP.cutout.op,
        path: sourceRelative,
        model: WORKSHOP.cutout.defaultModel,
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal(res.body.ok, true)
      assert.ok(typeof res.body.jobId === 'string' && res.body.jobId)

      const job = await waitUntilJob(host.origin, res.body.jobId, (snapshot) => snapshot.status === 'done')
      assert.equal(job.tool, 'remove-bg')
      assert.equal(job.error, null)
      assert.equal(job.modelId, WORKSHOP.cutout.models[0].repo)

      // 远端载荷形状：Host 只发 1 个 job，工坊字段齐全。
      const bodies = mock.state.generateBodies.filter((body) => body.jobId?.startsWith(`${res.body.jobId}-`))
      assert.equal(bodies.length, 1, 'remove-bg 只提交 1 个远端任务')
      const payload = bodies[0]
      assert.equal(payload.tool, 'remove-bg')
      assert.equal(payload.model, WORKSHOP.cutout.defaultModel)
      assert.equal(payload.workshop.model, WORKSHOP.cutout.defaultModel)
      assert.equal(payload.workshop.steps, 0, 'remove-bg 没有采样步数')
      assert.ok(typeof payload.reference.image_b64 === 'string' && payload.reference.image_b64.length > 0)
      assert.equal(payload.tasks, undefined, '工坊算子不下发扩散 tasks')

      const item = await findHistoryItem(host.origin, res.body.jobId)
      assert.equal(item.workshop, true)
      assert.equal(item.workshopTool, 'cutout')
      assert.equal(item.images.length, 1, '主图只占一张卡')
      assert.equal(item.images[0].file, 'cutout.png', '第一个 channel 结果作为主图且按 role 命名')
      assert.deepEqual(item.channels.map((entry) => entry.role), ['cutout'])
      assert.equal(item.channels[0].file, 'cutout.png')
      // 文件真实存在且是 PNG。
      const bytes = await readFile(join(workspace, ...item.images[0].path.split('/')))
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    })

    await check('POST /api/workshop/op 提交 pbr（steps=3）→ done → 四通道顺序落盘', async () => {
      const res = await postOp(host.origin, {
        op: WORKSHOP.pbr.op,
        path: sourceRelative,
        model: 'marigold',
        options: { steps: 3 },
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const job = await waitUntilJob(host.origin, res.body.jobId, (snapshot) => snapshot.status === 'done')
      assert.equal(job.tool, 'pbr')
      assert.equal(job.modelId, 'prs-eth/marigold-iid-appearance-v1-1')

      const bodies = mock.state.generateBodies.filter((body) => body.jobId?.startsWith(`${res.body.jobId}-`))
      assert.equal(bodies.length, 1)
      assert.equal(bodies[0].tool, 'pbr')
      assert.equal(bodies[0].model, 'marigold')
      assert.equal(bodies[0].workshop.model, 'marigold')
      assert.equal(bodies[0].workshop.steps, 3, '显式 steps 必须透传到远端')

      const item = await findHistoryItem(host.origin, res.body.jobId)
      assert.equal(item.workshop, true)
      assert.equal(item.workshopTool, 'pbr')
      assert.deepEqual(item.channels.map((entry) => entry.role), PBR_CHANNELS, '通道顺序固定：albedo 在前')
      assert.deepEqual(
        item.channels.map((entry) => entry.file),
        ['albedo.png', 'normal.png', 'roughness.png', 'metallic.png'],
      )
      assert.equal(item.images.length, 1)
      assert.equal(item.images[0].file, 'albedo.png', '第一个通道结果（albedo）作为主图')
      for (const channel of item.channels) {
        const bytes = await readFile(join(workspace, ...item.dir.split('/'), channel.file))
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${channel.file} 应是 PNG`)
      }
    })

    await check('POST /api/workshop/op 提交 pbr（model=chord）→ done → 四通道落盘', async () => {
      const res = await postOp(host.origin, {
        op: WORKSHOP.pbr.op,
        path: sourceRelative,
        model: 'chord',
      })
      assert.equal(res.status, 200, JSON.stringify(res.body), 'chord 是合法模型：提交期应放行')
      const job = await waitUntilJob(host.origin, res.body.jobId, (snapshot) => snapshot.status === 'done')
      assert.equal(job.tool, 'pbr')
      assert.equal(job.modelId, WORKSHOP_REPOS.chord)

      const bodies = mock.state.generateBodies.filter((body) => body.jobId?.startsWith(`${res.body.jobId}-`))
      assert.equal(bodies.length, 1)
      assert.equal(bodies[0].model, 'chord')
      assert.equal(bodies[0].workshop.model, 'chord')

      const item = await findHistoryItem(host.origin, res.body.jobId)
      assert.deepEqual(item.channels.map((entry) => entry.role), PBR_CHANNELS)
      assert.equal(item.images[0].file, 'albedo.png')
    })

    await check('非法 op / model / 源图路径返回 400 且不发远端请求', async () => {
      const before = mock.state.generateBodies.length
      const cases = [
        { body: { op: 'generate', path: sourceRelative }, name: '非法 op' },
        { body: { op: 'pbr', path: sourceRelative, model: 'nope' }, name: '非法 model' },
        { body: { op: 'remove-bg', path: sourceRelative, model: 'marigold' }, name: '跨工具 model' },
        { body: { op: 'pbr', path: '../escape.png' }, name: '越界路径' },
        { body: { op: 'pbr', path: 'outputs/not-exists/01.png' }, name: '不存在的作品' },
        { body: { op: 'pbr', path: sourceRelative, options: { steps: 999 } }, name: '越界 steps' },
      ]
      for (const entry of cases) {
        const res = await postOp(host.origin, entry.body)
        assert.equal(res.status, 400, `${entry.name} 应返回 400，实际 ${res.status} ${JSON.stringify(res.body)}`)
        assert.ok(['invalid_request', 'invalid_path', 'not_found'].includes(res.body.error?.code), entry.name)
      }
      assert.equal(mock.state.generateBodies.length, before, '非法请求不得发到远端')
    })

    await check('normalizeWorkshopResults：inline 乱序按契约顺序归一', () => {
      const inline = [
        { channel: 'normal', image_b64: 'n' },
        { channel: 'albedo', image_b64: 'a' },
        { channel: 'metallic', image_b64: 'm' },
        { channel: 'roughness', image_b64: 'r' },
      ]
      const normalized = normalizeWorkshopResults(inline, 'pbr')
      assert.deepEqual(normalized.map((item) => item.channel), PBR_CHANNELS)
      assert.equal(normalized[0].image_b64, 'a')
    })

    await check('normalizeWorkshopResults：binary 元数据缺 channel 时按 artifact 顺序映射', () => {
      const binary = [
        { index: 0, sha256: 's0', tempPath: 't0' },
        { index: 1, sha256: 's1', tempPath: 't1' },
      ]
      const cutout = normalizeWorkshopResults(binary.slice(0, 1), 'remove-bg')
      assert.deepEqual(cutout.map((item) => item.channel), ['cutout'])
      assert.equal(cutout[0].tempPath, 't0', 'binary 的临时文件路径必须保留')
      const pbr = normalizeWorkshopResults(
        PBR_CHANNELS.map((_, index) => ({ index, sha256: `s${index}`, tempPath: `t${index}` })),
        'pbr',
      )
      assert.deepEqual(pbr.map((item) => item.channel), PBR_CHANNELS)
    })

    await check('normalizeWorkshopResults：数量 / 通道异常显式失败', () => {
      assert.throws(() => normalizeWorkshopResults([], 'remove-bg'), (error) => error.code === 'empty_result')
      assert.throws(
        () => normalizeWorkshopResults([{ channel: 'cutout' }, { channel: 'albedo' }], 'remove-bg'),
        (error) => error.code === 'generation_failed',
      )
      assert.throws(
        () => normalizeWorkshopResults([{ channel: 'albedo' }, { channel: 'albedo' }, { channel: 'normal' }, { channel: 'roughness' }], 'pbr'),
        (error) => error.code === 'generation_failed',
      )
      assert.throws(
        () => normalizeWorkshopResults([{ channel: 'bogus' }, { channel: 'albedo' }, { channel: 'normal' }, { channel: 'roughness' }], 'pbr'),
        (error) => error.code === 'generation_failed',
      )
    })
  } finally {
    await cleanup()
  }

  summary()
}

/** 在工作区 outputs/ 播种一张 1024×768 的源图（工坊路由与远端只读图片头）。 */
async function seedSourceImage(workspace) {
  const dir = join(workspace, 'outputs', '20260101-000000-source01')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '01.png'), headerOnlyPng(1024, 768))
  return 'outputs/20260101-000000-source01/01.png'
}

function postOp(origin, body) {
  return json(origin, ROUTES.workshopOp.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 从 /api/history 找本次任务的条目（按 jobId 匹配），返回带 channels 的 HistoryItem。 */
async function findHistoryItem(origin, jobId) {
  const res = await json(origin, '/api/history?limit=50')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const item = res.body.items.find((entry) => entry.jobId === jobId)
  assert.ok(item, `历史里找不到 jobId=${jobId} 的产物：${JSON.stringify(res.body.items.map((i) => i.jobId))}`)
  assert.ok(Array.isArray(item.channels), 'HistoryItem.channels 必须恒为数组')
  return item
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
