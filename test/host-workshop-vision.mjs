#!/usr/bin/env node
/**
 * 工坊 L2 视觉感知的 Host 离线回归（M4.2c Phase 2）。
 *
 * 覆盖：
 *  - 256×256 RGB 请求校验与 NCHW 张量排布；
 *  - 静态锚点分类与 512 维输出护栏；
 *  - 固定模型缓存命中、单飞下载、SHA / 字节数校验、失败冷却；
 *  - Session 复用与推理串行；
 *  - `/api/workshop/perceive` 路由的成功 / 输入错误 / 503 语义；
 *  - 本机存在真实模型夹具时，走一次 onnxruntime-web + FP16 模型的前向。
 *
 * 默认 CI 不下载模型：真实模型用例只在 `.tmp/workshop-l2/vision_model_fp16.onnx`
 * 已存在时执行，否则跳过。
 *
 * 运行：node test/host-workshop-vision.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { ROUTES, WORKSHOP } from '../shared/contract.js'
import {
  VISION_UNAVAILABLE,
  classifyWorkshopEmbedding,
  createWorkshopVision,
  decodeWorkshopVisionPixels,
  workshopVisionAnchors,
  workshopVisionTensor,
} from '../server/workshop-vision.js'
import { createWorkshopRoutes } from '../server/routes/workshop.js'
import { createCheckRunner } from './helpers/check.mjs'
import { makeRes, workspaceContext } from './helpers/fake-context.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SIZE = WORKSHOP.vision.imageSize
const RGB_BYTES = SIZE * SIZE * 3
const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} }
const { check, summary } = createCheckRunner()

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function rgbFixture(fill = 128) {
  return Buffer.alloc(RGB_BYTES, fill)
}

function encodedPixels(rgb = rgbFixture()) {
  return { width: SIZE, height: SIZE, data: rgb.toString('base64') }
}

function normalize(vector) {
  const length = Math.hypot(...vector)
  return Float32Array.from(vector, (value) => value / length)
}

/** 与生产锚点同形的 512 维夹具：每个场景 / Noul 向量彼此可区分且单位化。 */
function fixtureAnchors() {
  const scenes = {}
  WORKSHOP.scenes.forEach((scene, index) => {
    const vector = new Float32Array(512)
    vector[index * 7] = 1
    vector[index * 7 + 1] = 0.35
    vector[400 + index] = 0.2
    scenes[scene] = normalize(vector)
  })
  const noul = {}
  const keys = ['needsCutout', 'isGridSprite', 'isPixelGrid', 'isTileable', 'isVectorFriendly', 'wantsPbr']
  keys.forEach((key, index) => {
    const positive = new Float32Array(512)
    positive[40 + index * 3] = 1
    positive[300 + index] = 0.4
    const negative = new Float32Array(512)
    negative[80 + index * 3] = 1
    negative[340 + index] = 0.4
    noul[key] = { positive: normalize(positive), negative: normalize(negative) }
  })
  return { scenes, noul }
}

/** 假 ORT：只实现 Tensor / env 与 createSession，不加载 WASM。 */
function fakeRuntime(options = {}) {
  const outputDim = Number(options.outputDim) || 512
  const calls = { sessions: 0, runs: 0, active: 0, maxActive: 0, dims: [] }
  class Tensor {
    constructor(type, data, dims) {
      this.type = type
      this.data = data
      this.dims = dims
    }
  }
  const ort = {
    env: { wasm: {} },
    Tensor,
    InferenceSession: { create: async () => ({}) },
  }
  const createSession = async () => {
    calls.sessions += 1
    return {
      async run(inputs) {
        calls.active += 1
        calls.maxActive = Math.max(calls.maxActive, calls.active)
        calls.runs += 1
        calls.dims.push(inputs.pixel_values.dims)
        try {
          if (Number.isFinite(options.runDelayMs) && options.runDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, options.runDelayMs))
          }
          const data = new Float32Array(outputDim)
          // 让分类结果确定：第一维恒为 1，其余按索引小幅变化。
          data[0] = 1
          for (let index = 1; index < outputDim; index += 1) data[index] = 0.001 * (index % 7)
          return {
            image_embeds: { type: 'float32', dims: [1, outputDim], data },
          }
        } finally {
          calls.active -= 1
        }
      },
    }
  }
  return { ort, createSession, calls }
}

function fakeFetch(data, options = {}) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    if (options.status && options.status !== 200) {
      return { ok: false, status: options.status, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const bytes = typeof data === 'function' ? data() : data
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }
  return { impl, calls }
}

function fakeRequest(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return Readable.from([Buffer.from(text, 'utf8')])
}

// ── 请求解码与张量排布 ────────────────────────────────────────────────────

await check('输入：只接受裸 base64 的 256×256 RGB，尺寸 / 长度 / 字符集全部严格校验', () => {
  const rgb = rgbFixture(17)
  const decoded = decodeWorkshopVisionPixels(encodedPixels(rgb))
  assert.equal(decoded.ok, true)
  assert.equal(decoded.pixels.width, SIZE)
  assert.equal(decoded.pixels.height, SIZE)
  assert.deepEqual(decoded.pixels.rgb, rgb)

  for (const bad of [
    null,
    [],
    { width: SIZE, height: SIZE - 1, data: rgb.toString('base64') },
    { width: SIZE, height: SIZE, data: `data:image/png;base64,${rgb.toString('base64')}` },
    { width: SIZE, height: SIZE, data: Buffer.alloc(RGB_BYTES - 1).toString('base64') },
    { width: SIZE, height: SIZE, data: `${'A'.repeat(4 * 65536 - 1)}=x` },
  ]) {
    const result = decodeWorkshopVisionPixels(bad)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_request')
  }
})

await check('输入：RGB interleaved → NCHW float32 / 255，三个平面顺序正确', () => {
  const rgb = Buffer.alloc(RGB_BYTES)
  rgb[0] = 255
  rgb[1] = 0
  rgb[2] = 0
  rgb[3] = 0
  rgb[4] = 255
  rgb[5] = 0
  rgb[8] = 255
  const tensor = workshopVisionTensor(rgb)
  assert.equal(tensor.length, RGB_BYTES)
  assert.equal(tensor[0], 1)
  assert.equal(tensor[SIZE * SIZE], 0, 'G 平面起点来自第一个像素')
  assert.equal(tensor[SIZE * SIZE + 1], 1)
  assert.equal(tensor[SIZE * SIZE * 2 + 2], 1, 'B 平面起点来自第三个像素')
})

await check('分类：512 维嵌入可输出与 L1 同口径的场景 / Noul / 推荐工具', () => {
  const anchors = fixtureAnchors()
  const vector = new Float32Array(512)
  vector[2 * 7] = 1
  vector[2 * 7 + 1] = 0.35
  vector[402] = 0.2
  const result = classifyWorkshopEmbedding(vector, { anchors, model: 'fixture' })
  assert.equal(result.source, 'l2-onnx-vision')
  assert.equal(result.model, 'fixture')
  assert.equal(result.scene, 'pixel_art')
  assert.equal(result.sceneProbs.pixel_art > result.sceneProbs.sprite_sheet, true)
  for (const key of Object.keys(result.noul)) {
    assert.ok(result.noul[key] >= 0 && result.noul[key] <= 1, `${key} 必须在 0~1`)
  }
  assert.deepEqual(result.recommendedTools, ['pixel-snap', 'sprite-slice', 'tile'])
  assert.throws(() => classifyWorkshopEmbedding(new Float32Array(511), { anchors }), /512/)
})

// ── 模型缓存 / 下载 / 校验 / 冷却 ─────────────────────────────────────────

const baseDir = join(ROOT, '.tmp', 'm4-workshop-vision')
await mkdir(baseDir, { recursive: true })

await check('模型缓存：固定本地模型只读一次，Session 复用、推理串行', async () => {
  const dir = await mkdtemp(join(baseDir, 'cache-'))
  try {
    const modelPath = join(dir, 'vision.onnx')
    await writeFile(modelPath, Buffer.from('fixture-model'))
    const runtime = fakeRuntime({ runDelayMs: 12 })
    const vision = createWorkshopVision({
      modelPath,
      anchors: fixtureAnchors(),
      loadRuntime: async () => runtime.ort,
      createSession: runtime.createSession,
      env: {},
      modelBytes: 1,
      modelSha256: 'unused-for-fixed-path',
    })
    const decoded = decodeWorkshopVisionPixels(encodedPixels())
    const [first, second] = await Promise.all([
      vision.perceive(workspaceContext(dir), decoded.pixels),
      vision.perceive(workspaceContext(dir), decoded.pixels),
    ])
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(runtime.calls.sessions, 1, '同一模型只创建一个 Session')
    assert.equal(runtime.calls.runs, 2)
    assert.equal(runtime.calls.maxActive, 1, 'CPU 推理必须串行，不能并发抢占')
    assert.deepEqual(runtime.calls.dims[0], [1, 3, SIZE, SIZE])
    assert.equal(await stat(modelPath).then((info) => info.isFile()), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await check('模型下载：固定 URL + 字节数 + SHA-256 通过后原子落盘，后续请求不再联网', async () => {
  const dir = await mkdtemp(join(baseDir, 'download-'))
  try {
    const model = Buffer.from('tiny-but-valid-for-fixture')
    const runtime = fakeRuntime()
    const fetchImpl = fakeFetch(model)
    const vision = createWorkshopVision({
      anchors: fixtureAnchors(),
      loadRuntime: async () => runtime.ort,
      createSession: runtime.createSession,
      fetchImpl: fetchImpl.impl,
      env: {},
      modelUrl: 'https://example.invalid/vision.onnx',
      modelBytes: model.length,
      modelSha256: sha256(model),
    })
    const ctx = workspaceContext(dir)
    const decoded = decodeWorkshopVisionPixels(encodedPixels())
    const first = await vision.perceive(ctx, decoded.pixels)
    const second = await vision.perceive(ctx, decoded.pixels)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(fetchImpl.calls.length, 1, 'Session 建好后的第二次请求不再下载')
    const cached = join(dir, '.aigc-studio', 'models', 'mobileclip-s0', 'vision_model_fp16.onnx')
    assert.deepEqual(await readFile(cached), model, '缓存文件内容必须与下载一致')
    assert.equal(runtime.calls.sessions, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await check('模型下载：字节数 / SHA 失败即删除残留并进入冷却，冷却期不再重试', async () => {
  const dir = await mkdtemp(join(baseDir, 'bad-sha-'))
  try {
    const model = Buffer.from('wrong-model-bytes')
    const runtime = fakeRuntime()
    const fetchImpl = fakeFetch(model)
    let clock = 1_000
    const vision = createWorkshopVision({
      anchors: fixtureAnchors(),
      loadRuntime: async () => runtime.ort,
      createSession: runtime.createSession,
      fetchImpl: fetchImpl.impl,
      env: {},
      now: () => clock,
      failureCooldownMs: 5_000,
      modelUrl: 'https://example.invalid/vision.onnx',
      modelBytes: model.length + 1,
      modelSha256: '0'.repeat(64),
    })
    const decoded = decodeWorkshopVisionPixels(encodedPixels())
    const failed = await vision.perceive(workspaceContext(dir), decoded.pixels)
    assert.equal(failed.ok, false)
    assert.equal(failed.code, VISION_UNAVAILABLE)
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(
      await stat(join(dir, '.aigc-studio', 'models', 'mobileclip-s0', 'vision_model_fp16.onnx'))
        .then(() => true)
        .catch(() => false),
      false,
      '校验失败不能留下半个模型文件',
    )

    clock += 1_000
    const cooled = await vision.perceive(workspaceContext(dir), decoded.pixels)
    assert.equal(cooled.ok, false)
    assert.equal(fetchImpl.calls.length, 1, '冷却期内不重复下载')

    clock += 5_000
    const retried = await vision.perceive(workspaceContext(dir), decoded.pixels)
    assert.equal(retried.ok, false)
    assert.equal(fetchImpl.calls.length, 2, '冷却结束后允许一次重试')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await check('模型下载：HTTP 错误与嵌入维度异常都映射为 vision_unavailable', async () => {
  const dir = await mkdtemp(join(baseDir, 'bad-http-'))
  try {
    const httpFail = fakeFetch(Buffer.alloc(0), { status: 503 })
    const vision = createWorkshopVision({
      anchors: fixtureAnchors(),
      loadRuntime: async () => fakeRuntime().ort,
      fetchImpl: httpFail.impl,
      env: {},
      modelUrl: 'https://example.invalid/vision.onnx',
      modelBytes: 10,
      modelSha256: '0'.repeat(64),
      failureCooldownMs: 0,
    })
    const decoded = decodeWorkshopVisionPixels(encodedPixels())
    const result = await vision.perceive(workspaceContext(dir), decoded.pixels)
    assert.equal(result.ok, false)
    assert.equal(result.code, VISION_UNAVAILABLE)
    assert.match(result.message, /503/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const dimDir = await mkdtemp(join(baseDir, 'bad-dim-'))
  try {
    const runtime = fakeRuntime({ outputDim: 511 })
    const modelPath = join(dimDir, 'vision.onnx')
    await writeFile(modelPath, Buffer.from('fixture'))
    const vision = createWorkshopVision({
      modelPath,
      anchors: fixtureAnchors(),
      loadRuntime: async () => runtime.ort,
      createSession: runtime.createSession,
      env: {},
      failureCooldownMs: 0,
    })
    const result = await vision.perceive(
      workspaceContext(dimDir),
      decodeWorkshopVisionPixels(encodedPixels()).pixels,
    )
    assert.equal(result.ok, false)
    assert.equal(result.code, VISION_UNAVAILABLE)
    assert.match(result.message, /512/)
  } finally {
    await rm(dimDir, { recursive: true, force: true })
  }
})

await check('开关：AIGC_STUDIO_WORKSHOP_VISION=0 完全跳过下载 / 推理', async () => {
  const runtime = fakeRuntime()
  const fetchImpl = fakeFetch(Buffer.from('unused'))
  const vision = createWorkshopVision({
    anchors: fixtureAnchors(),
    loadRuntime: async () => runtime.ort,
    createSession: runtime.createSession,
    fetchImpl: fetchImpl.impl,
    env: { AIGC_STUDIO_WORKSHOP_VISION: '0' },
  })
  const result = await vision.perceive(
    workspaceContext(baseDir),
    decodeWorkshopVisionPixels(encodedPixels()).pixels,
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, VISION_UNAVAILABLE)
  assert.equal(fetchImpl.calls.length, 0)
  assert.equal(runtime.calls.sessions, 0)
})

// ── HTTP 路由 ─────────────────────────────────────────────────────────────

await check('路由：注册 workshop-perceive，成功透传 perception，失败统一 503 vision_unavailable', async () => {
  const calls = []
  const fakeVision = {
    async perceive(ctx, pixels) {
      calls.push({ ctx, pixels })
      return {
        ok: true,
        perception: {
          source: 'l2-onnx-vision',
          model: WORKSHOP.vision.model,
          latencyMs: 12,
          scene: 'pixel_art',
          sceneProbs: Object.fromEntries(WORKSHOP.scenes.map((scene) => [scene, scene === 'pixel_art' ? 1 : 0])),
          confidence: { scene: 'pixel_art', top: 1, margin: 1 },
          noul: {
            needsCutout: 0,
            isGridSprite: 0,
            isPixelGrid: 1,
            isTileable: 0,
            isVectorFriendly: 0,
            wantsPbr: 0,
          },
          professionalScore: 1,
          recommendedTools: ['pixel-snap'],
          showStudioReturnHint: false,
          reasonKey: 'studio.workshop.scene.reason.pixel_art',
          reasonParams: { scene: 'pixel_art', score: 1 },
          features: null,
          derived: { doneTools: [], hasTransparency: false, priorTool: null },
        },
      }
    },
  }
  const ctx = workspaceContext(baseDir)
  const routes = createWorkshopRoutes({ ctx, log: SILENT_LOG, queue: {}, vision: fakeVision })
  const route = routes.find((item) => item.path === ROUTES.workshopPerceive.path)
  assert.ok(route, 'workshop-perceive 路由必须存在')
  assert.equal(route.method, 'POST')

  const okRes = makeRes()
  await route.handler(fakeRequest({ pixels: encodedPixels() }), okRes)
  assert.equal(okRes.state.code, 200)
  assert.equal(okRes.state.body.ok, true)
  assert.equal(okRes.state.body.perception.scene, 'pixel_art')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].pixels.rgb.length, RGB_BYTES)

  const invalidPixelsRes = makeRes()
  await route.handler(fakeRequest({ pixels: { width: 10, height: 10, data: 'AAAA' } }), invalidPixelsRes)
  assert.equal(invalidPixelsRes.state.code, 400)
  assert.equal(invalidPixelsRes.state.body.error.code, 'invalid_request')

  const invalidBodyRes = makeRes()
  await route.handler(fakeRequest('{'), invalidBodyRes)
  assert.equal(invalidBodyRes.state.code, 400)
  assert.equal(invalidBodyRes.state.body.error.code, 'invalid_body')

  const failedRoutes = createWorkshopRoutes({
    ctx,
    log: SILENT_LOG,
    queue: {},
    vision: {
      async perceive() {
        return { ok: false, code: VISION_UNAVAILABLE, message: '模型不可用' }
      },
    },
  })
  const failedRoute = failedRoutes.find((item) => item.path === ROUTES.workshopPerceive.path)
  const failedRes = makeRes()
  await failedRoute.handler(fakeRequest({ pixels: encodedPixels() }), failedRes)
  assert.equal(failedRes.state.code, 503)
  assert.equal(failedRes.state.body.error.code, VISION_UNAVAILABLE)
})

// ── 真实模型（仅本地存在夹具时）──────────────────────────────────────────

const realModelPath = join(ROOT, '.tmp', 'workshop-l2', 'vision_model_fp16.onnx')
const hasRealModel = await stat(realModelPath).then((info) => info.isFile()).catch(() => false)

if (hasRealModel) {
  await check('真实模型：onnxruntime-web 在 Node 下加载 FP16 模型并输出 512 维嵌入', async () => {
    const dir = await mkdtemp(join(baseDir, 'real-'))
    try {
      const vision = createWorkshopVision({
        modelPath: realModelPath,
        anchors: workshopVisionAnchors(),
        env: {},
        modelBytes: WORKSHOP.vision.bytes,
        modelSha256: WORKSHOP.vision.sha256,
      })
      const rgb = Buffer.alloc(RGB_BYTES)
      for (let index = 0; index < SIZE * SIZE; index += 1) {
        rgb[index * 3] = (index % SIZE) * 255 / SIZE
        rgb[index * 3 + 1] = Math.floor(index / SIZE) * 255 / SIZE
        rgb[index * 3 + 2] = 96
      }
      const result = await vision.perceive(workspaceContext(dir), { rgb })
      assert.equal(result.ok, true, result.message)
      assert.equal(result.perception.source, 'l2-onnx-vision')
      assert.ok(WORKSHOP.scenes.includes(result.perception.scene))
      assert.ok(result.perception.latencyMs >= 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
} else {
  console.log('SKIP 真实模型：本地没有 .tmp/workshop-l2/vision_model_fp16.onnx（默认 CI 不下载）')
}

summary({ prefix: '\n', suffix: '项通过' })
