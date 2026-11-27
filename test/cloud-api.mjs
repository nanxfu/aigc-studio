#!/usr/bin/env node
/**
 * 商业生图 API（M3.5 Phase A）离线回归。
 *
 * 覆盖：
 *  - 共享清单：服务商 / 云端预设 / `presetById` 解析 / 来源门控（本地模型 ≠ cloud-api）；
 *  - 适配层：OpenAI Images（b64）、硅基流动（URL 下载 + 推荐画幅）、fal 队列（提交/轮询/取结果）；
 *  - 错误归一：401 / 余额不足 30001 / 429 / 未知模型；
 *  - cloud-api provider：缺 Key 抛 auth_required，配好后返回句柄且 Key 不进 handle；
 *  - SessionManager：cloud-api 0 秒进入 ready、不挂健康轮询、不写会话记录；
 *  - JobQueue：逐张请求、落盘到 outputs、meta 记录 provider=cloud-api；
 *    扩图 / 参考图在入队阶段被明确拒绝。
 *
 * 全部走本机 mock HTTP 服务，不出外网、不需要真实 Key。
 *
 * 运行：node test/cloud-api.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { presetById } from '../shared/contract.js'
import {
  allCloudPresetsFor,
  cloudPresetOf,
  cloudPresetOfConfig,
  cloudPresetsFor,
  normalizeImageApiConfig,
} from '../shared/image-providers.js'
import { generateCloudImage, ImageApiError } from '../server/image-api.js'
import { JobQueue, providerGateOf } from '../server/jobs.js'
import { createCloudApiProvider } from '../server/providers/cloud-api.js'
import { SessionManager } from '../server/session.js'
import { createCheckRunner } from './helpers/check.mjs'

const { check, summary } = createCheckRunner()

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')
const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

const tempDirs = []
async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'imagen-cloud-api-'))
  tempDirs.push(dir)
  return dir
}

/** 启动一个只服务本次用例的 HTTP 服务；返回 baseUrl 与请求记录。 */
async function startMock(handler) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      handler(req, res, body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function jsonReply(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function imageReply(res) {
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) })
  res.end(PNG)
}

const baseRequest = {
  prompt: 'a quiet lighthouse at dusk',
  negativePrompt: 'blurry',
  width: 1024,
  height: 1024,
  steps: 20,
  cfg: 3.5,
  seed: 42,
}

// ── 1. 共享清单与来源门控 ─────────────────────────────────────────
await check('清单：云端预设可被 presetById 解析，本地模型不能跑 cloud-api', () => {
  const presets = cloudPresetsFor('siliconflow')
  assert.ok(presets.length >= 3, '硅基流动至少登记 3 个模型')
  const preset = presetById('cloud:siliconflow:Qwen/Qwen-Image')
  assert.equal(preset.id, 'cloud:siliconflow:Qwen/Qwen-Image')
  assert.deepEqual(preset.providers, ['cloud-api'])
  assert.equal(preset.cloud.supportsNegative, true)
  assert.equal(preset.supportsInpaint, false)
  assert.equal(preset.pipeline, undefined, '云端预设不携带 diffusers 管线')

  const local = presetById('sdxl-lightning')
  const localGate = providerGateOf(local, 'cloud-api')
  assert.ok(localGate && localGate.code === 'invalid_request', '本地模型在商业 API 下必须被拦下')
  assert.equal(providerGateOf(preset, 'cloud-api'), null)
  assert.ok(providerGateOf(preset, 'kaggle'), '云端预设不能跑在 Kaggle 上')

  // 换服务商后回落到该服务商的首个模型（不会把 Qwen 的 id 带到 fal）。
  const falPreset = cloudPresetOfConfig({ vendor: 'fal', model: '' }, 'cloud:siliconflow:Qwen/Qwen-Image')
  assert.equal(falPreset.cloud.vendor, 'fal')
  assert.equal(cloudPresetsFor('fal').some((item) => item.id === falPreset.id), true)
  assert.equal(cloudPresetOf('nope', 'x'), null)
  const normalized = normalizeImageApiConfig({ vendor: 'custom', model: 'my-model', baseUrl: 'http://127.0.0.1:9999/v1' })
  assert.equal(normalized.baseUrl, 'http://127.0.0.1:9999/v1', '回环 http 允许（本机 mock / 自建网关）')

  // 方式 B：汇总多服务商预设（含逗号分隔 custom 模型）+ 跨服务商 keys 解析。
  const multi = allCloudPresetsFor({
    vendor: 'siliconflow',
    apiKeysConfigured: ['siliconflow', 'fal', 'custom'],
    customBaseUrl: 'https://gw.example.com/v1',
    customModel: 'alpha, beta, alpha',
  })
  assert.equal(multi.some((item) => item.id === 'cloud:siliconflow:Qwen/Qwen-Image'), true)
  assert.equal(multi.some((item) => item.id === 'cloud:fal:fal-ai/flux/schnell'), true)
  assert.equal(multi.filter((item) => item.cloud.vendor === 'custom').length, 2, 'custom 去重拆出 2 个模型')
  const crossPreset = cloudPresetOfConfig(
    { vendor: 'siliconflow', keys: { siliconflow: 'sf-k', fal: 'fal-k' } },
    'cloud:fal:fal-ai/flux/schnell',
  )
  assert.equal(crossPreset.cloud.vendor, 'fal', '已配置 Key 的其它服务商模型也可直接解析')

  // M3.5 Phase D：魔搭语义编辑与受控扩图能力进目录。
  const editPreset = presetById('cloud:modelscope:Qwen/Qwen-Image-Edit-2511')
  assert.ok(editPreset, 'Qwen-Image-Edit-2511 应进入云端预设目录')
  assert.equal(editPreset.supportsReference, true)
  assert.equal(editPreset.cloud.semanticEdit, true)
  assert.equal(editPreset.cloud.maxEdge, 2048)
  const outpaintPreset = presetById('cloud:modelscope:black-forest-labs/FLUX.2-klein-4B')
  assert.equal(outpaintPreset.supportsOutpaint, true)
  assert.equal(outpaintPreset.cloud.outpaint.lora, 'fal/flux-2-klein-4B-outpaint-lora')
  assert.equal(outpaintPreset.cloud.outpaint.maxEdge, 1536)
})

// ── 2. OpenAI Images（b64）──────────────────────────────────────
await check('适配：OpenAI Images 返回 b64，按能力位省略负向词 / 步数', async () => {
  const mock = await startMock((req, res) => {
    jsonReply(res, 200, { data: [{ b64_json: PNG_B64 }] })
  })
  try {
    const result = await generateCloudImage({
      config: { vendor: 'openai', model: 'gpt-image-1', baseUrl: `${mock.baseUrl}/v1`, apiKey: 'sk-test' },
      request: { ...baseRequest, width: 1400, height: 800, capabilities: cloudPresetOf('openai', 'gpt-image-1').cloud },
      fetchImpl: fetch,
    })
    assert.equal(result.buffer.equals(PNG), true)
    assert.equal(result.width, 1400)
    const request = mock.requests[0]
    assert.equal(request.url, '/v1/images/generations')
    assert.equal(request.headers.authorization, 'Bearer sk-test')
    const body = JSON.parse(request.body)
    assert.equal(body.model, 'gpt-image-1')
    assert.equal(body.prompt, baseRequest.prompt)
    assert.equal(body.size, '1536x1024', '宽幅映射到 OpenAI 支持的尺寸')
    assert.equal(body.n, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'negative_prompt'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'num_inference_steps'), false)
  } finally {
    await mock.close()
  }
})

// ── 3. 硅基流动（URL + 推荐画幅）────────────────────────────────
await check('适配：硅基流动返回 URL 后立即下载，image_size 用推荐画幅', async () => {
  const mock = await startMock((req, res) => {
    if (req.url === '/v1/images/generations') {
      return jsonReply(res, 200, { images: [{ url: `${mock.baseUrl}/files/out.png` }], seed: 42 })
    }
    if (req.url === '/files/out.png') return imageReply(res)
    jsonReply(res, 404, { message: 'not found' })
  })
  try {
    const result = await generateCloudImage({
      config: {
        vendor: 'siliconflow',
        model: 'Qwen/Qwen-Image',
        baseUrl: `${mock.baseUrl}/v1`,
        apiKey: 'sf-test',
      },
      request: {
        ...baseRequest,
        width: 1000,
        height: 560,
        capabilities: cloudPresetOf('siliconflow', 'Qwen/Qwen-Image').cloud,
      },
      fetchImpl: fetch,
    })
    assert.equal(result.buffer.equals(PNG), true)
    const body = JSON.parse(mock.requests[0].body)
    assert.equal(body.image_size, '1664x928', '16:9 映射到 Qwen-Image 推荐画幅')
    assert.equal(body.batch_size, 1)
    assert.equal(body.negative_prompt, 'blurry')
    assert.equal(body.num_inference_steps, 20)
    assert.equal(body.guidance_scale, 3.5)
    assert.equal(body.seed, 42)
    assert.equal(mock.requests[1].url, '/files/out.png')
  } finally {
    await mock.close()
  }
})

// ── 4. fal 队列 ────────────────────────────────────────────────
await check('适配：fal 队列提交 → 轮询 COMPLETED → 取结果 → 下载', async () => {
  let polls = 0
  const mock = await startMock((req, res) => {
    if (req.method === 'POST' && req.url === '/fal-ai/flux/schnell') {
      return jsonReply(res, 200, {
        request_id: 'req-1',
        status_url: `${mock.baseUrl}/fal-ai/flux/requests/req-1/status`,
        response_url: `${mock.baseUrl}/fal-ai/flux/requests/req-1/response`,
      })
    }
    if (req.url === '/fal-ai/flux/requests/req-1/status') {
      polls += 1
      return jsonReply(res, 200, { status: polls < 2 ? 'IN_PROGRESS' : 'COMPLETED' })
    }
    if (req.url === '/fal-ai/flux/requests/req-1/response') {
      return jsonReply(res, 200, { images: [{ url: `${mock.baseUrl}/files/fal.png`, width: 1024, height: 1024 }] })
    }
    if (req.url === '/files/fal.png') return imageReply(res)
    jsonReply(res, 404, { message: 'not found' })
  })
  try {
    const preset = cloudPresetOf('fal', 'fal-ai/flux/schnell')
    const result = await generateCloudImage({
      config: { vendor: 'fal', model: 'fal-ai/flux/schnell', baseUrl: mock.baseUrl, apiKey: 'fal-key' },
      request: { ...baseRequest, width: 1024, height: 1024, capabilities: preset.cloud },
      fetchImpl: fetch,
    })
    assert.equal(result.buffer.equals(PNG), true)
    assert.equal(result.width, 1024)
    assert.equal(mock.requests[0].headers.authorization, 'Key fal-key')
    const body = JSON.parse(mock.requests[0].body)
    assert.equal(body.image_size, 'square_hd', 'fal 只接受预设枚举（方形映射 square_hd）')
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'guidance_scale'), false, 'schnell 不接受 guidance')
    assert.equal(polls, 2, '需要至少两次轮询才完成')
  } finally {
    await mock.close()
  }
})

// ── 5. 错误归一 ────────────────────────────────────────────────
await check('错误归一：鉴权 / 余额 / 限流 / 未知模型都映射到可执行错误码', async () => {
  const cases = [
    { status: 401, payload: { message: 'invalid api key' }, code: 'image_api_unauthorized' },
    { status: 403, payload: { code: 30001, message: 'balance insufficient' }, code: 'image_api_insufficient_balance' },
    { status: 429, payload: { message: 'rate limit' }, code: 'image_api_rate_limited' },
    { status: 400, payload: { message: 'model not found' }, code: 'image_api_unsupported' },
    { status: 500, payload: { message: 'boom' }, code: 'image_api_failed' },
  ]
  for (const item of cases) {
    const mock = await startMock((req, res) => jsonReply(res, item.status, item.payload))
    try {
      await assert.rejects(
        generateCloudImage({
          config: { vendor: 'openai', model: 'gpt-image-1', baseUrl: `${mock.baseUrl}/v1`, apiKey: 'k' },
          request: { ...baseRequest, capabilities: { supportsNegative: false, supportsSteps: false, supportsGuidance: false, supportsSeed: false } },
          fetchImpl: fetch,
        }),
        (error) => error instanceof ImageApiError && error.code === item.code,
      )
    } finally {
      await mock.close()
    }
  }
})

// ── 6. cloud-api provider ─────────────────────────────────────
await check('provider：缺 Key 抛 auth_required；配置后返回句柄且 Key 不进 handle', async () => {
  const missing = createCloudApiProvider({ options: { getImageApiConfig: () => ({ vendor: 'siliconflow', model: '', baseUrl: '', apiKey: '' }) } })
  await assert.rejects(missing.provision({ isCurrent: () => true }), (error) => error.code === 'auth_required')

  const provider = createCloudApiProvider({
    options: {
      getImageApiConfig: () => ({
        vendor: 'siliconflow',
        model: 'Qwen/Qwen-Image',
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: 'secret-key',
      }),
    },
  })
  const provisioned = await provider.provision({ isCurrent: () => true })
  assert.equal(provisioned.handle.vendor, 'siliconflow')
  assert.equal(provisioned.handle.model, 'Qwen/Qwen-Image')
  assert.equal(JSON.stringify(provisioned.handle).includes('secret-key'), false, 'Key 不得出现在句柄里')
  assert.equal(provisioned.token, 'secret-key')
  assert.deepEqual(await provider.checkAlive(), { alive: true, status: 'ready' })
  assert.equal(await provider.readLogs(), null)
})

// ── 7. SessionManager：0 秒 ready，不挂定时器 ─────────────────
await check('会话：cloud-api 直接 ready，不启动健康轮询、不落会话记录', async () => {
  const workspace = await makeWorkspace()
  const session = new SessionManager({
    ctx: { get: () => ({ defaultDirectory: workspace }) },
    defaultPreset: 'cloud:siliconflow:Qwen/Qwen-Image',
    options: {
      provider: 'cloud-api',
      getImageApiConfig: () => ({
        vendor: 'siliconflow',
        model: 'Qwen/Q/Image',
        apiKey: 'secret-key',
      }),
    },
    deps: {
      getSettings: () => ({ provider: 'cloud-api' }),
      log: silentLog,
    },
  })
  const snapshot = await session.start('cloud:siliconflow:Qwen/Qwen-Image')
  assert.equal(snapshot.state, 'ready')
  assert.equal(snapshot.provider, 'cloud-api')
  assert.equal(snapshot.endpointUrl, null)
  assert.equal(snapshot.idleTimeoutSec, null)
  assert.equal(session.timers.size, 0, '不能挂健康轮询')
  await session.stop()
  assert.equal(session.snapshot().state, 'absent')
  session.dispose()
})

// ── 8. JobQueue 端到端 ────────────────────────────────────────
await check('队列：cloud-api 逐张出图并落盘，扩图 / 参考图在入队阶段被拒', async () => {
  const workspace = await makeWorkspace()
  let calls = 0
  const server = await startMock((req, res) => {
    if (req.url === '/v1/images/generations') {
      calls += 1
      return jsonReply(res, 200, { images: [{ url: `${server.baseUrl}/img-${calls}.png` }] })
    }
    if (req.url.startsWith('/img-')) return imageReply(res)
    jsonReply(res, 404, { message: 'not found' })
  })
  const ctx = { get: (name) => (name === 'workingDirectory' ? { defaultDirectory: workspace } : undefined) }
  const session = {
    isReady: true,
    snapshot: () => ({ state: 'ready', provider: 'cloud-api', device: 'siliconflow', deviceCount: null }),
    connection: () => ({ endpoint: null, token: null }),
    start: async () => ({ state: 'ready' }),
  }
  const queue = new JobQueue({
    ctx,
    session,
    defaultPreset: 'cloud:siliconflow:Qwen/Qwen-Image',
    options: {
      getProvider: () => 'cloud-api',
      getImageApiConfig: () => ({
        vendor: 'siliconflow',
        model: 'Qwen/Qwen-Image',
        baseUrl: `${server.baseUrl}/v1`,
        apiKey: 'sf-test',
      }),
      sessionPollMs: 10,
    },
  })
  try {
    const rejectedTool = queue.submit({ tool: 'upscale', prompt: 'x', presetId: 'cloud:siliconflow:Qwen/Qwen-Image' })
    assert.equal(rejectedTool.ok, false)
    assert.equal(rejectedTool.code, 'image_api_unsupported')
    const rejectedReference = queue.submit({
      prompt: 'x',
      presetId: 'cloud:siliconflow:Qwen/Qwen-Image',
      references: ['outputs/a/01.png'],
    })
    assert.equal(rejectedReference.ok, false)
    assert.equal(rejectedReference.code, 'image_api_unsupported')

    const submitted = queue.submit({
      prompt: 'a quiet lighthouse',
      presetId: 'cloud:siliconflow:Qwen/Qwen-Image',
      width: 1024,
      height: 1024,
      count: 2,
      steps: 20,
      cfg: 3.5,
      seed: 7,
    })
    assert.equal(submitted.ok, true)
    assert.equal(submitted.job.presetId, 'cloud:siliconflow:Qwen/Qwen-Image')
    assert.equal(submitted.job.params.count, 2)
    const done = await queue.waitFor(submitted.job.id, 5)
    assert.equal(done.status, 'done', JSON.stringify(done.error))
    assert.equal(done.output.images.length, 2)
    assert.equal(done.provider, 'cloud-api')
    assert.equal(calls, 2, '逐张请求，不能一次性把 count 塞给厂商')
    const first = done.output.images[0]
    const meta = JSON.parse(await readFile(join(workspace, first.path.replace(/^outputs\//, 'outputs/')).replace(/[^/\\]+$/, 'meta.json'), 'utf8'))
    assert.equal(meta.provider, 'cloud-api')
    assert.equal(meta.modelId, 'siliconflow/Qwen/Qwen-Image')
    assert.equal(meta.params.steps, 20)
    await rm(join(workspace, 'outputs'), { recursive: true, force: true })
  } finally {
    queue.dispose()
    await server.close()
  }

  // 后台已有运行中的 Colab 会话时跑 cloud-api，不能把 Colab 会话关掉，也不能把出处记成 Colab。
  const workspaceKeep = await makeWorkspace()
  let serverCalls = 0
  let sessionStartCalled = 0
  const keepServer = await startMock((req, res) => {
    if (req.url === '/v1/images/generations') {
      serverCalls += 1
      return jsonReply(res, 200, { images: [{ url: `${keepServer.baseUrl}/img-keep-${serverCalls}.png` }] })
    }
    if (req.url.startsWith('/img-keep-')) return imageReply(res)
    jsonReply(res, 404, { message: 'not found' })
  })
  const keepCtx = { get: (name) => (name === 'workingDirectory' ? { defaultDirectory: workspaceKeep } : undefined) }
  const keepQueue = new JobQueue({
    ctx: keepCtx,
    session: {
      isReady: true,
      snapshot: () => ({ state: 'ready', provider: 'colab', device: 'NVIDIA L4', deviceCount: 1 }),
      connection: () => ({ endpoint: 'https://colab.example', token: 'tok' }),
      start: async () => {
        sessionStartCalled += 1
        return { state: 'ready' }
      },
    },
    defaultPreset: 'cloud:siliconflow:Qwen/Qwen-Image',
    options: {
      getProvider: () => 'cloud-api',
      getImageApiConfig: () => ({
        vendor: 'siliconflow',
        model: 'Qwen/Qwen-Image',
        baseUrl: `${keepServer.baseUrl}/v1`,
        apiKey: 'sf-test',
      }),
      sessionPollMs: 10,
    },
  })
  try {
    const submitted = keepQueue.submit({ prompt: 'a mountain cabin', presetId: 'cloud:siliconflow:Qwen/Qwen-Image' })
    assert.equal(submitted.ok, true)
    const done = await keepQueue.waitFor(submitted.job.id, 5)
    assert.equal(done.status, 'done', JSON.stringify(done.error))
    assert.equal(sessionStartCalled, 0, 'cloud-api 出图不得触发 session.start() 销毁正在运行的 Colab 会话')
    assert.equal(done.provider, 'cloud-api')
    assert.equal(done.device, 'siliconflow')
    await rm(join(workspaceKeep, 'outputs'), { recursive: true, force: true })
  } finally {
    keepQueue.dispose()
    await keepServer.close()
  }
})

await check('适配：魔搭 ModelScope 异步任务提交、轮询 /tasks 与失败映射', async () => {
  const msPreset = presetById('cloud:modelscope:Tongyi-MAI/Z-Image-Turbo')
  assert.ok(msPreset, '魔搭 Z-Image-Turbo 预设应可解析')
  assert.equal(msPreset.cloud.protocol, 'modelscope-async')
  assert.equal(msPreset.cloud.freeQuota, true)

  let polls = 0
  const mock = await startMock((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      return jsonReply(res, 200, { task_id: 'ms-task-1' })
    }
    if (req.method === 'GET' && req.url === '/v1/tasks/ms-task-1') {
      polls += 1
      if (polls === 1) return jsonReply(res, 200, { task_status: 'RUNNING' })
      return jsonReply(res, 200, { task_status: 'SUCCEED', output_images: [`${mock.baseUrl}/ms-out.png`] })
    }
    if (req.url === '/ms-out.png') return imageReply(res)
    jsonReply(res, 404, { message: 'not found' })
  })
  try {
    const result = await generateCloudImage({
      config: { vendor: 'modelscope', model: 'Tongyi-MAI/Z-Image-Turbo', baseUrl: `${mock.baseUrl}/v1`, apiKey: 'ms-test' },
      request: { ...baseRequest, steps: 8, capabilities: msPreset.cloud },
      fetchImpl: fetch,
    })
    assert.equal(result.buffer.equals(PNG), true)
    const submitReq = mock.requests[0]
    assert.equal(submitReq.headers['x-modelscope-async-mode'], 'true')
    const submitBody = JSON.parse(submitReq.body)
    assert.equal(submitBody.model, 'Tongyi-MAI/Z-Image-Turbo')
    assert.equal(submitBody.steps, 8)
    const pollReq = mock.requests[1]
    assert.equal(pollReq.headers['x-modelscope-task-type'], 'image_generation')
    assert.equal(polls, 2)
  } finally {
    await mock.close()
  }

  const failMock = await startMock((req, res) => {
    if (req.method === 'POST') return jsonReply(res, 200, { task_id: 'ms-fail' })
    return jsonReply(res, 200, { task_status: 'FAILED', message: 'quota exhausted' })
  })
  try {
    await assert.rejects(
      () => generateCloudImage({
        config: { vendor: 'modelscope', model: 'Tongyi-MAI/Z-Image-Turbo', baseUrl: `${failMock.baseUrl}/v1`, apiKey: 'ms-test' },
        request: { ...baseRequest, capabilities: msPreset.cloud },
        fetchImpl: fetch,
      }),
      (err) => err instanceof ImageApiError && err.code === 'image_api_failed' && err.message.includes('quota exhausted'),
    )
  } finally {
    await failMock.close()
  }

  // 支持参考图的魔搭模型（Qwen-Image-2.1-Turbo）：可传入 Base64 image_url；FLUX.2-klein 上限 1024。
  const refPreset = presetById('cloud:modelscope:Qwen/Qwen-Image-2.1-Turbo')
  const fluxPreset = presetById('cloud:modelscope:black-forest-labs/FLUX.2-klein-4B')
  assert.equal(refPreset.supportsReference, true)
  assert.equal(fluxPreset.supportsReference, true)
  assert.equal(fluxPreset.cloud.maxEdge, 1024)
  const refMock = await startMock((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      return jsonReply(res, 200, { task_id: 'ms-ref-1' })
    }
    if (req.method === 'GET' && req.url === '/v1/tasks/ms-ref-1') {
      return jsonReply(res, 200, { task_status: 'SUCCEED', output_images: [`${refMock.baseUrl}/ref-out.png`] })
    }
    if (req.url === '/ref-out.png') return imageReply(res)
    jsonReply(res, 404, { message: 'not found' })
  })
  try {
    await generateCloudImage({
      config: { vendor: 'modelscope', model: 'Qwen/Qwen-Image-2.1-Turbo', baseUrl: `${refMock.baseUrl}/v1`, apiKey: 'ms-test' },
      request: { ...baseRequest, cfg: 1, capabilities: refPreset.cloud, referenceImages: [{ image_b64: PNG_B64 }] },
      fetchImpl: fetch,
    })
    const refBody = JSON.parse(refMock.requests[0].body)
    assert.deepEqual(refBody.image_url, [`data:image/png;base64,${PNG_B64}`])

    await generateCloudImage({
      config: { vendor: 'modelscope', model: 'black-forest-labs/FLUX.2-klein-4B', baseUrl: `${refMock.baseUrl}/v1`, apiKey: 'ms-test' },
      request: { ...baseRequest, width: 1536, height: 1024, capabilities: fluxPreset.cloud },
      fetchImpl: fetch,
    })
    const fluxBody = JSON.parse(refMock.requests[3].body)
    assert.equal(fluxBody.size, '1024x680', 'FLUX.2-klein 超出 1024 时应等比缩放对齐 8 的倍数')

    // Phase D：扩图走受控 LoRA，并显式按 1536×1024 / 1.6MP 口径放行。
    await generateCloudImage({
      config: { vendor: 'modelscope', model: 'black-forest-labs/FLUX.2-klein-4B', baseUrl: `${refMock.baseUrl}/v1`, apiKey: 'ms-test' },
      request: {
        ...baseRequest,
        prompt: 'Fill the green spaces according to the image, misty pines',
        width: 1536,
        height: 1024,
        steps: 0,
        cfg: 0,
        capabilities: {
          ...fluxPreset.cloud,
          maxEdge: fluxPreset.cloud.outpaint.maxEdge,
          maxPixels: fluxPreset.cloud.outpaint.maxPixels,
          supportsOutpaint: true,
        },
        outpaint: true,
      },
      fetchImpl: fetch,
    })
    const outpaintBody = JSON.parse(refMock.requests[6].body)
    assert.equal(outpaintBody.size, '1536x1024', '扩图画布不应被常规 1024 上限压回')
    assert.equal(outpaintBody.loras, 'fal/flux-2-klein-4B-outpaint-lora')
    assert.equal(outpaintBody.steps, undefined, '扩图不向模型下发无意义的扩散步数')
  } finally {
    await refMock.close()
  }
})

await check('队列：ModelScope 扩图提交绿边画布 + Outpaint LoRA，并按 1536×1024 落盘 outpaint 元数据', async () => {
  const workspace = await makeWorkspace()
  let submitBody = null
  const server = await startMock((req, res, rawBody) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      submitBody = JSON.parse(rawBody || '{}')
      return jsonReply(res, 200, { task_id: 'ms-outpaint-1' })
    }
    if (req.method === 'GET' && req.url === '/v1/tasks/ms-outpaint-1') {
      return jsonReply(res, 200, {
        task_status: 'SUCCEED',
        output_images: [`${server.baseUrl}/outpaint.png`],
      })
    }
    if (req.url === '/outpaint.png') return imageReply(res)
    jsonReply(res, 404, { message: 'not found' })
  })
  const ctx = { get: (name) => (name === 'workingDirectory' ? { defaultDirectory: workspace } : undefined) }
  const queue = new JobQueue({
    ctx,
    session: {
      isReady: true,
      snapshot: () => ({ state: 'ready', provider: 'cloud-api', device: 'modelscope', deviceCount: null }),
      connection: () => ({ endpoint: null, token: null }),
      start: async () => ({ state: 'ready' }),
    },
    defaultPreset: 'cloud:modelscope:black-forest-labs/FLUX.2-klein-4B',
    options: {
      getProvider: () => 'cloud-api',
      getImageApiConfig: () => ({
        vendor: 'modelscope',
        model: 'black-forest-labs/FLUX.2-klein-4B',
        baseUrl: `${server.baseUrl}/v1`,
        apiKey: 'ms-test',
      }),
      sessionPollMs: 10,
    },
  })
  try {
    const submitted = queue.submit({
      tool: 'outpaint',
      presetId: 'cloud:modelscope:black-forest-labs/FLUX.2-klein-4B',
      prompt: 'misty pine trees',
      width: 1536,
      height: 1024,
      reference: {
        image: PNG_B64,
        sourcePath: 'outputs/source/01.png',
        outpaintContent: { x: 0.125, y: 0, width: 0.75, height: 1 },
      },
    })
    assert.equal(submitted.ok, true, JSON.stringify(submitted))
    assert.equal(submitted.job.tool, 'outpaint')
    assert.equal(submitted.job.params.prompt, 'Fill the green spaces according to the image, misty pine trees')
    const done = await queue.waitFor(submitted.job.id, 8)
    assert.equal(done.status, 'done', JSON.stringify(done.error))
    assert.equal(submitBody.size, '1536x1024')
    assert.equal(submitBody.loras, 'fal/flux-2-klein-4B-outpaint-lora')
    assert.match(submitBody.image_url[0], /^data:image\/png;base64,/)
    const first = done.output.images[0]
    const meta = JSON.parse(await readFile(
      join(workspace, first.path.replace(/[^/\\]+$/, 'meta.json')),
      'utf8',
    ))
    assert.equal(meta.outpaint, true)
    assert.equal(meta.sourceImage, 'outputs/source/01.png')
    assert.equal(meta.params.reference.sourcePath, 'outputs/source/01.png')
    assert.deepEqual(meta.outpaintContent, { x: 0.125, y: 0, width: 0.75, height: 1 })
    assert.equal(meta.modelId, 'modelscope/black-forest-labs/FLUX.2-klein-4B')
  } finally {
    queue.dispose()
    await server.close()
    await rm(join(workspace, 'outputs'), { recursive: true, force: true }).catch(() => {})
  }
})

summary()
for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
