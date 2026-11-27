#!/usr/bin/env node
/**
 * 图生 3D（M4.4a-1）Host 侧端到端测试。
 *
 * 链路与真机一致，只是把远端换成 mock daemon：
 *   POST /api/generate（tool=mesh3d）→ JobQueue（3D 分支）→ POST /generate（远端协议）
 *   → GET /job 轮询 → saveJobOutput（GLB 校验 + 写 01.glb / meta）→ /api/history → /api/file。
 *
 * 覆盖：
 *  - 正常 `.glb`：落盘 `01.glb`、meta.mediaType=mesh3d、网格统计（bytes/vertices/triangles/
 *    materials/hasTexture/sha256）、历史条目与 `/api/file` 的 `model/gltf-binary` 与 Range；
 *  - 源图约束：无 Alpha 的 PNG 在提交期 400 且不发远端请求；非法模型 / texture 同样 400；
 *  - 来源门控：cloud-api 与 local-gpu 直接拒绝；
 *  - 截断 `.glb`：Host 在落盘前拒绝（任务 failed + mesh3d_invalid），不产生产物目录；
 *  - `inspectGlb` 的容器校验分支（魔数 / 版本 / 长度 / JSON 块 / 空网格 / 体积上限）。
 *
 * 不覆盖：真实几何推理（无 GPU、不能下载 HF 权重）；mock 只验证协议与落盘链路。
 *
 * 运行：node test/host-mesh3d.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../server/app.js'
import { inspectGlb } from '../server/mesh3d.js'
import { contentTypeOf } from '../server/paths.js'
import { APP_VERSION, MESH3D, ROUTES } from '../shared/contract.js'
import { createCheckRunner } from './helpers/check.mjs'
import { closeServer, createFakeContext, json, startHost } from './helpers/fake-context.mjs'

const DEV_TOKEN = 'dev-token-test'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── PNG 夹具 ────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 构造「只保证头部可解析」的 PNG：Host 与远端都只读 IHDR（宽高 + colorType），
 * 不需要真实像素数据，因此用例不引入图像编码依赖。
 *
 * @param {number} width
 * @param {number} height
 * @param {number} colorType PNG 颜色类型（6 = RGBA，2 = 真彩无 Alpha）
 */
function headerOnlyPng(width, height, colorType = 6) {
  const buffer = Buffer.alloc(34)
  PNG_SIGNATURE.copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  buffer[24] = 8 // bit depth
  buffer[25] = colorType
  return buffer
}

// ── GLB 夹具（与 test/mock-daemon.py 的 _build_glb 同构）────────────────────

/**
 * 造一个结构合法的 GLB：平面网格 + 单材质，格子数按目标面数换算，
 * 让不同 targetFaces 得到不同的顶点 / 三角面数（可被 meta 统计断言）。
 *
 * @param {number} targetFaces
 * @returns {{ glb: Buffer, expected: { vertices: number, triangles: number } }}
 */
function makeGlb(targetFaces) {
  const cells = Math.max(2, Math.min(24, Math.round(Math.sqrt(Math.max(targetFaces, 4) / 2))))
  const step = 1 / cells
  const positions = []
  for (let row = 0; row <= cells; row += 1) {
    for (let col = 0; col <= cells; col += 1) {
      positions.push(col * step - 0.5, 0, row * step - 0.5)
    }
  }
  const indices = []
  const stride = cells + 1
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const a = row * stride + col
      const b = a + 1
      const c = a + stride
      const d = c + 1
      indices.push(a, c, b, b, c, d)
    }
  }
  const vertexBytes = Buffer.alloc(positions.length * 4)
  positions.forEach((value, index) => vertexBytes.writeFloatLE(value, index * 4))
  const indexBytes = Buffer.alloc(indices.length * 2)
  indices.forEach((value, index) => indexBytes.writeUInt16LE(value, index * 2))
  const rawBin = Buffer.concat([vertexBytes, indexBytes])
  const padding = (4 - (rawBin.length % 4)) % 4
  const bin = Buffer.concat([rawBin, Buffer.alloc(padding)])

  const gltf = {
    asset: { version: '2.0', generator: 'aigc-studio-test-glb' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ name: 'clay', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: vertexBytes.length, target: 34962 },
      { buffer: 0, byteOffset: vertexBytes.length, byteLength: indexBytes.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  }
  const jsonRaw = Buffer.from(JSON.stringify(gltf), 'utf8')
  const jsonPadded = Buffer.concat([jsonRaw, Buffer.alloc((4 - (jsonRaw.length % 4)) % 4, 0x20)])
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(total, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonPadded.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(bin.length, 0)
  binHeader.writeUInt32LE(0x004e4942, 4)
  return {
    glb: Buffer.concat([header, jsonHeader, jsonPadded, binHeader, bin]),
    expected: { vertices: positions.length / 3, triangles: indices.length / 3 },
  }
}

// ── 远端 mock daemon ────────────────────────────────────────────────────────

/**
 * 只实现 3D 链路需要的协议面（/health /generate /job /artifact /shutdown）。
 *
 * `state.mesh3dMode` 控制返回的 GLB：`ok` 正常、`truncated` 尾部裁掉 9 字节
 * （声明长度 ≠ 实际字节，Host 必须在落盘前拒绝）。
 * `/health` 声明 `capabilities.result_modes: ['inline', 'binary']` 时覆盖真实生产路径：
 * `POST /generate` 收 `result_mode='binary'` → `/job` 回 `{ index, bytes, sha256, media_type, artifact_file }`
 * → `GET /artifact` 流式下载 `.glb` 字节。
 */
function startMockDaemon() {
  const state = {
    generateBodies: [],
    artifactRequests: [],
    artifacts: new Map(),
    jobs: new Map(),
    mesh3dMode: 'ok',
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
        capabilities: {
          result_modes: ['inline', 'binary'],
          events: false,
          artifact_range: true,
          tools: ['generate', 'upscale', 'mesh3d'],
        },
      })
    }
    if (req.method === 'GET' && req.url.startsWith('/artifact?')) {
      const url = new URL(req.url, 'http://127.0.0.1')
      const jobId = url.searchParams.get('id') ?? ''
      const index = Number(url.searchParams.get('index') ?? 0)
      state.artifactRequests.push({ jobId, index })
      const entry = state.artifacts.get(`${jobId}:${index}`)
      if (!entry) return send(404, { error: { code: 'unknown_job', message: '产物不存在或已过期' } })
      res.writeHead(200, {
        'content-type': entry.mediaType,
        'content-length': String(entry.buffer.length),
        'accept-ranges': 'bytes',
      })
      res.end(entry.buffer)
      return
    }
    if (req.method === 'POST' && req.url === '/generate') {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        state.generateBodies.push(body)
        const jobId = String(body.jobId || `mock-job-${state.generateBodies.length}`)
        const tool = typeof body.tool === 'string' ? body.tool : 'generate'
        const block = body.mesh3d && typeof body.mesh3d === 'object' ? body.mesh3d : {}
        if (tool !== 'mesh3d') {
          state.jobs.set(jobId, {
            status: 'failed',
            job_id: jobId,
            model_id: body.modelId ?? null,
            tool,
            progress: { done: 0, total: 1 },
            results: null,
            error: { code: 'invalid_request', message: `mock 不支持 tool=${tool}` },
          })
          return send(202, { status: 'accepted', job_id: jobId, model_id: body.modelId ?? null })
        }
        const { glb, expected } = makeGlb(Number(block.targetFaces) || 0)
        const payload = state.mesh3dMode === 'truncated'
          ? glb.subarray(0, Math.max(0, glb.length - 9))
          : glb
        const baseMeta = {
          name: '01',
          seed: 0,
          seconds: 0.05,
          mediaType: 'mesh3d',
          ...expected,
          materials: 1,
          hasTexture: false,
        }
        let results
        if (body.result_mode === 'binary') {
          const sha256 = createHash('sha256').update(payload).digest('hex')
          state.artifacts.set(`${jobId}:0`, { buffer: payload, mediaType: 'model/gltf-binary' })
          results = [{
            ...baseMeta,
            index: 0,
            bytes: payload.length,
            sha256,
            media_type: 'model/gltf-binary',
            artifact_file: '0.glb',
          }]
        } else {
          results = [{
            ...baseMeta,
            glb_b64: payload.toString('base64'),
          }]
        }
        state.jobs.set(jobId, {
          status: 'done',
          job_id: jobId,
          model_id: MESH3D.models[0].repo,
          tool,
          progress: { done: 1, total: 1 },
          load_seconds: 0.05,
          results,
          error: null,
        })
        send(202, { status: 'accepted', job_id: jobId, model_id: MESH3D.models[0].repo })
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

// ── 请求小工具 ──────────────────────────────────────────────────────────────

function postGenerate(origin, body) {
  return json(origin, ROUTES.generate.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

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

async function findHistoryItem(origin, jobId) {
  const res = await json(origin, '/api/history?limit=50')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.items.find((entry) => entry.jobId === jobId) ?? null
}

/** 输出目录里与某 jobId 对应的归档目录名（jobId 就是目录名后缀）。 */
async function outputDirsOf(workspace) {
  const entries = await readdir(join(workspace, 'outputs'), { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

/** 在工作区 outputs/ 播种一张 1024×1024 的 RGBA 源图（Host 与远端只读图片头）。 */
async function seedSourceImage(workspace) {
  const dir = join(workspace, 'outputs', '20260101-000000-source01')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '01.png'), headerOnlyPng(1024, 1024, 6))
  return 'outputs/20260101-000000-source01/01.png'
}

const { check, summary } = createCheckRunner()

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'aigc-mesh3d-'))
  await mkdir(join(workspace, 'outputs'), { recursive: true })
  const mock = await startMockDaemon()
  const fake = createFakeContext(workspace)
  const host = await startHost(fake.routes)
  fake.setOrigin(host.origin)
  const app = createApp({ ctx: fake.ctx, config: { devEndpoint: mock.endpoint, devToken: DEV_TOKEN } })
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
    /** 第一个用例完成的 3D 任务 id：后面的 /api/file 用例直接复用它。 */
    let doneJobId = null

    await check('契约：MESH3D 边界与路径 MIME 就位', () => {
      assert.equal(MESH3D.op, 'mesh3d')
      assert.equal(MESH3D.defaultModel, 'hunyuan3d-2mini')
      assert.equal(MESH3D.models[0].repo, 'tencent/Hunyuan3D-2mini')
      assert.equal(MESH3D.models[0].texture, false, 'a 段只出白模')
      assert.ok(MESH3D.targetFaces.min < MESH3D.targetFaces.default)
      assert.equal(contentTypeOf('a.glb'), 'model/gltf-binary')
      assert.equal(contentTypeOf('a.gltf'), 'model/gltf+json; charset=utf-8')
      assert.equal(contentTypeOf('a.bin'), 'application/octet-stream')
      assert.equal(contentTypeOf('a.ktx2'), 'image/ktx2')
    })

    await check('会话启动（开发模式直连 mock daemon）', async () => {
      const res = await json(host.origin, '/api/session/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetId: 'sdxl-lightning' }),
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal(res.body.session.state, 'ready')
      // 开发模式直连跳过开机轮询，这里手动注入与 mock /health 对齐的协议 v2 能力位，
      // 让主用例覆盖真正的 binary /artifact 下载链路。
      app.session.remoteCapabilities = {
        result_modes: ['inline', 'binary'],
        events: false,
        artifact_range: true,
        tools: ['generate', 'upscale', 'mesh3d'],
      }
    })

    await check('POST /api/generate（tool=mesh3d）→ done → 01.glb + meta 网格统计', async () => {
      const res = await postGenerate(host.origin, { tool: 'mesh3d', reference: { path: sourceRelative } })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      assert.equal(res.body.tool, 'mesh3d')
      assert.equal(res.body.mediaType, 'mesh3d', '公开视图要带 mediaType，客户端才知道切 3D 视图')

      const job = await waitUntilJob(host.origin, res.body.id, (snapshot) => snapshot.status === 'done')
      assert.equal(job.error, null)
      assert.equal(job.modelId, MESH3D.models[0].repo)
      assert.equal(job.mediaType, 'mesh3d')
      doneJobId = job.id

      // 远端载荷形状：只发 tool + 源图 + mesh3d 块，不带扩散 pipeline / tasks。
      const bodies = mock.state.generateBodies.filter((body) => body.jobId?.startsWith(`${res.body.id}-`))
      assert.equal(bodies.length, 1, '一次任务只提交 1 个远端 job')
      const payload = bodies[0]
      assert.equal(payload.tool, 'mesh3d')
      assert.equal(payload.result_mode, 'binary', '能力协商通过时必须走 binary /artifact 传输')
      assert.ok(
        mock.state.artifactRequests.some((entry) => entry.jobId === payload.jobId && entry.index === 0),
        'Host 必须通过 GET /artifact 拉取 0.glb',
      )
      assert.equal(
        app.queue.artifactExtensionOf({ artifact_file: '0.glb', media_type: 'model/gltf-binary' }, job),
        'glb',
      )
      assert.equal(payload.model, MESH3D.defaultModel)
      assert.equal(payload.mesh3d.model, MESH3D.defaultModel)
      assert.equal(payload.mesh3d.targetFaces, MESH3D.targetFaces.default)
      assert.equal(payload.mesh3d.texture, false)
      assert.ok(typeof payload.reference.image_b64 === 'string' && payload.reference.image_b64.length > 0)
      assert.equal(payload.tasks, undefined, '3D 不下发扩散 tasks')
      assert.equal(payload.pipeline, undefined, '3D 不下发扩散 pipeline')

      const item = await findHistoryItem(host.origin, res.body.id)
      assert.ok(item, '历史里必须有本次 3D 产物')
      assert.equal(item.mediaType, 'mesh3d')
      assert.equal(item.workshop, false, '3D 不是工坊通道产物')
      assert.ok(item.mesh3d, 'HistoryItem 必须带 mesh3d 模型信息')
      assert.equal(item.mesh3d.model, MESH3D.defaultModel)
      assert.equal(item.mesh3d.targetFaces, MESH3D.targetFaces.default)
      assert.equal(item.mesh3d.texture, false)
      assert.equal(item.images.length, 1)
      assert.equal(item.images[0].file, '01.glb', '3D 产物写 01.glb')
      assert.equal(item.images[0].mediaType, 'mesh3d')

      const stats = item.images[0].mesh
      assert.ok(stats, '历史条目必须带网格统计')
      const { glb } = makeGlb(MESH3D.targetFaces.default)
      assert.equal(stats.bytes, glb.length)
      assert.equal(stats.vertices > 0, true)
      assert.equal(stats.triangles > 0, true)
      assert.equal(stats.materials, 1)
      assert.equal(stats.hasTexture, false)
      assert.equal(stats.sha256, createHash('sha256').update(glb).digest('hex'))

      // 磁盘上的字节与 meta 与接口一致。
      const absolute = join(workspace, ...item.images[0].path.split('/'))
      const bytes = await readFile(absolute)
      assert.equal(bytes.subarray(0, 4).toString('latin1'), 'glTF', '落盘文件必须是 GLB')
      const meta = JSON.parse(await readFile(join(workspace, ...item.dir.split('/'), 'meta.json'), 'utf8'))
      assert.equal(meta.mediaType, 'mesh3d')
      assert.equal(meta.images[0].file, '01.glb')
      // meta 里的统计比 HistoryItem 多几个容器字段（version / meshes / generator），
      // 归一面板只透传客户端需要的部分；逐项确认它们同源。
      const metaStats = meta.images[0].mesh
      assert.equal(metaStats.sha256, stats.sha256)
      assert.equal(metaStats.bytes, stats.bytes)
      assert.equal(metaStats.vertices, stats.vertices)
      assert.equal(metaStats.triangles, stats.triangles)
      assert.equal(metaStats.materials, 1)
      assert.equal(metaStats.hasTexture, false)
      assert.equal(metaStats.version, 2)
      assert.equal(metaStats.meshes, 1)
      assert.equal(meta.mesh3d.model, MESH3D.defaultModel)
      assert.equal(meta.sourceImage, sourceRelative, '版本树要能把 3D 挂在源作品下')
      assert.equal(meta.rootImage, sourceRelative)
    })

    await check('/api/file 对 .glb 回 model/gltf-binary 并支持 Range', async () => {
      assert.ok(doneJobId, '前一个用例必须已经完成一个 3D 任务')
      const meshItem = await findHistoryItem(host.origin, doneJobId)
      assert.ok(meshItem, '找不到 3D 历史条目')
      const url = `/api/file?path=${encodeURIComponent(meshItem.images[0].path)}`
      const head = await fetch(new URL(url, host.origin), { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('content-type'), 'model/gltf-binary')
      assert.equal(head.headers.get('accept-ranges'), 'bytes')

      const partial = await fetch(new URL(url, host.origin), { headers: { range: 'bytes=0-11' } })
      assert.equal(partial.status, 206)
      assert.equal(partial.headers.get('content-type'), 'model/gltf-binary')
      const chunk = Buffer.from(await partial.arrayBuffer())
      assert.equal(chunk.length, 12)
      assert.equal(chunk.subarray(0, 4).toString('latin1'), 'glTF')
    })

    await check('提交期拒绝：无 Alpha 的 PNG / 非法模型 / texture=true 都不发远端请求', async () => {
      const before = mock.state.generateBodies.length
      const rgbPng = headerOnlyPng(1024, 1024, 2)
      const cases = [
        {
          name: '无 Alpha 的 PNG',
          body: { tool: 'mesh3d', reference: { image_b64: rgbPng.toString('base64') } },
          code: 'invalid_request',
          includes: '透明通道',
        },
        {
          name: '源图长边超限',
          body: { tool: 'mesh3d', reference: { image_b64: headerOnlyPng(2048, 512, 6).toString('base64') } },
          code: 'invalid_request',
          includes: String(MESH3D.maxInputEdge),
        },
        {
          name: '源图长边过小',
          body: { tool: 'mesh3d', reference: { image_b64: headerOnlyPng(128, 128, 6).toString('base64') } },
          code: 'invalid_request',
          includes: String(MESH3D.minInputEdge),
        },
        {
          name: '非法模型',
          body: { tool: 'mesh3d', model: 'nope', reference: { path: sourceRelative } },
          code: 'invalid_request',
          includes: 'model 只支持',
        },
        {
          name: 'texture=true（当前模型只出白模）',
          body: { tool: 'mesh3d', texture: true, reference: { path: sourceRelative } },
          code: 'invalid_request',
          includes: '白模',
        },
        {
          name: '缺少源图',
          body: { tool: 'mesh3d' },
          code: 'invalid_request',
          includes: '需要源图',
        },
        {
          name: '蒙版',
          body: { tool: 'mesh3d', reference: { path: sourceRelative, mask_b64: 'AAAA' } },
          code: 'invalid_request',
          includes: '不支持蒙版',
        },
      ]
      for (const entry of cases) {
        const res = await postGenerate(host.origin, entry.body)
        assert.equal(res.status, 400, `${entry.name} 应返回 400，实际 ${res.status} ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error?.code, entry.code, entry.name)
        assert.ok(
          String(res.body.error?.message ?? '').includes(entry.includes),
          `${entry.name} 的文案要包含「${entry.includes}」：${res.body.error?.message}`,
        )
      }
      assert.equal(mock.state.generateBodies.length, before, '非法请求不得发到远端')
    })

    await check('来源门控：cloud-api / local-gpu 直接拒绝', async () => {
      const original = app.queue.options.getProvider
      try {
        app.queue.options.getProvider = () => 'cloud-api'
        const cloud = await postGenerate(host.origin, { tool: 'mesh3d', reference: { path: sourceRelative } })
        assert.equal(cloud.status, 400, JSON.stringify(cloud.body))
        assert.equal(cloud.body.error?.code, 'image_api_unsupported')
        assert.ok(String(cloud.body.error?.message).includes('商业 API 不支持图生 3D'))

        app.queue.options.getProvider = () => 'local-gpu'
        const local = await postGenerate(host.origin, { tool: 'mesh3d', reference: { path: sourceRelative } })
        assert.equal(local.status, 400, JSON.stringify(local.body))
        assert.equal(local.body.error?.code, 'invalid_request')
        assert.ok(String(local.body.error?.message).includes('本机显卡不生成 3D'))
      } finally {
        app.queue.options.getProvider = original
      }
    })

    await check('targetFaces 越界按契约钳制后下发', async () => {
      const res = await postGenerate(host.origin, {
        tool: 'mesh3d',
        reference: { path: sourceRelative },
        targetFaces: 999999,
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const job = await waitUntilJob(host.origin, res.body.id, (snapshot) => snapshot.status === 'done')
      const bodies = mock.state.generateBodies.filter((body) => body.jobId?.startsWith(`${res.body.id}-`))
      assert.equal(bodies[0].mesh3d.targetFaces, MESH3D.targetFaces.max)
      assert.equal((await findHistoryItem(host.origin, job.id)).mesh3d.targetFaces, MESH3D.targetFaces.max)
    })

    await check('saveTo 交付：未写扩展名时按媒体类型补 .glb', async () => {
      const res = await postGenerate(host.origin, {
        tool: 'mesh3d',
        reference: { path: sourceRelative },
        saveTo: 'assets/chair',
      })
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const job = await waitUntilJob(host.origin, res.body.id, (snapshot) => snapshot.status === 'done')
      assert.deepEqual(job.output.deliveredPaths, ['assets/chair.glb'])
      const bytes = await readFile(join(workspace, 'assets', 'chair.glb'))
      assert.equal(bytes.subarray(0, 4).toString('latin1'), 'glTF', '交付文件必须是 GLB')
    })

    await check('reference.path 在 Host 执行前预检 Alpha 与尺寸，拦截无效源图不发远端', async () => {
      const sourceDir = join(workspace, 'outputs', '20260101-000000-source01')
      await writeFile(join(sourceDir, 'rgb.png'), headerOnlyPng(512, 512, 2))
      await writeFile(join(sourceDir, 'huge.png'), headerOnlyPng(2048, 512, 6))
      const before = mock.state.generateBodies.length

      for (const entry of [
        { file: 'outputs/20260101-000000-source01/rgb.png', includes: '透明通道' },
        { file: 'outputs/20260101-000000-source01/huge.png', includes: String(MESH3D.maxInputEdge) },
      ]) {
        const res = await postGenerate(host.origin, { tool: 'mesh3d', reference: { path: entry.file } })
        assert.equal(res.status, 200, JSON.stringify(res.body))
        const job = await waitUntilJob(host.origin, res.body.id, (snapshot) => snapshot.status === 'failed')
        assert.equal(job.error?.code, 'invalid_request')
        assert.ok(String(job.error?.message).includes(entry.includes), job.error?.message)
      }
      assert.equal(mock.state.generateBodies.length, before, 'Host 拦截的无效 path 不得打到远端')
    })

    await check('旧 daemon 无 capabilities 时回退 inline glb_b64 落盘', async () => {
      const saved = app.session.remoteCapabilities
      app.session.remoteCapabilities = null
      try {
        const res = await postGenerate(host.origin, { tool: 'mesh3d', reference: { path: sourceRelative } })
        assert.equal(res.status, 200, JSON.stringify(res.body))
        const job = await waitUntilJob(host.origin, res.body.id, (snapshot) => snapshot.status === 'done')
        assert.equal(job.output?.images?.[0]?.file, '01.glb')
        const bodies = mock.state.generateBodies.filter((body) => body.jobId?.startsWith(`${res.body.id}-`))
        assert.equal(bodies[0].result_mode, undefined, '旧 daemon 不下发 result_mode')
      } finally {
        app.session.remoteCapabilities = saved
      }
    })

    await check('截断的 .glb：落盘前拒绝，任务失败且不产生产物目录', async () => {
      const before = await outputDirsOf(workspace)
      mock.state.mesh3dMode = 'truncated'
      try {
        const res = await postGenerate(host.origin, { tool: 'mesh3d', reference: { path: sourceRelative } })
        assert.equal(res.status, 200, JSON.stringify(res.body))
        const job = await waitUntilJob(host.origin, res.body.id, (snapshot) => snapshot.status === 'failed')
        assert.equal(job.error?.code, 'mesh3d_invalid')
        assert.ok(String(job.error?.message).includes('3D 产物校验失败'), job.error?.message)
        const after = await outputDirsOf(workspace)
        assert.deepEqual(after, before, '校验失败不得留下产物目录')
        assert.equal(await findHistoryItem(host.origin, res.body.id), null, '失败任务不得进历史')
      } finally {
        mock.state.mesh3dMode = 'ok'
      }
    })

    await check('inspectGlb：容器校验分支', () => {
      const { glb } = makeGlb(40000)
      assert.equal(inspectGlb(glb).ok, true)

      const badMagic = Buffer.from(glb)
      badMagic.writeUInt32LE(0x12345678, 0)
      assert.equal(inspectGlb(badMagic).ok, false)

      const badVersion = Buffer.from(glb)
      badVersion.writeUInt32LE(1, 4)
      assert.equal(inspectGlb(badVersion).ok, false)

      const truncated = glb.subarray(0, glb.length - 9)
      assert.equal(inspectGlb(truncated).ok, false)
      assert.ok(inspectGlb(truncated).message.includes('字节'))

      const tiny = Buffer.alloc(4)
      assert.equal(inspectGlb(tiny).ok, false)
      assert.equal(inspectGlb(Buffer.alloc(0)).ok, false)

      const overLimit = inspectGlb(glb, { maxBytes: 16 })
      assert.equal(overLimit.ok, false)
      assert.ok(overLimit.message.includes('上限'))

      // 没有三角面的 GLB：把 indices 的 count 改成 0 → triangles = 0。
      const emptyMesh = makeGlb(40000).glb
      const jsonStart = 20
      const jsonLength = emptyMesh.readUInt32LE(12)
      const gltf = JSON.parse(emptyMesh.subarray(jsonStart, jsonStart + jsonLength).toString('utf8'))
      gltf.accessors[1].count = 0
      gltf.accessors[0].count = 2
      const jsonRaw = Buffer.from(JSON.stringify(gltf), 'utf8')
      const jsonPadded = Buffer.concat([jsonRaw, Buffer.alloc((4 - (jsonRaw.length % 4)) % 4, 0x20)])
      const rest = emptyMesh.subarray(jsonStart + jsonLength)
      const total = 12 + 8 + jsonPadded.length + rest.length
      const rebuilt = Buffer.concat([emptyMesh.subarray(0, 12), emptyMesh.subarray(12, 20), jsonPadded, rest])
      rebuilt.writeUInt32LE(jsonPadded.length, 12)
      rebuilt.writeUInt32LE(total, 8)
      assert.equal(inspectGlb(rebuilt).ok, false, '空网格必须被拒绝')
    })
  } finally {
    await cleanup()
  }

  summary()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
