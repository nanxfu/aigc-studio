#!/usr/bin/env node
/**
 * 商业视频 API（M4.1）离线回归。
 *
 * 覆盖：
 *  - 共享目录：视频预设可被 `presetById` 解析，模态 / 首尾帧 / 时长档位正确；
 *  - 适配层：MiniMax 提交体（duration / resolution / ratio / images role）、
 *    Wan I2V 提交体（image_size / image data URL / negative_prompt）、状态轮询与下载；
 *  - 错误归一：401 / 余额不足 30001 / 任务 Failed 映射到 `video_api_*`；
 *  - JobQueue：参考图槽映射首尾帧、视频落盘 `01.mp4`、meta 与历史条目 mediaType=video；
 *  - 能力门控：T2V 带参考图在入队阶段被拒。
 *
 * 全部走本机 mock HTTP 服务，不出外网、不需要真实 Key。
 *
 * 运行：node test/cloud-video.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { presetById } from '../shared/contract.js'
import {
  cloudPresetOf,
  cloudPresetsFor,
  cloudVideoPresetOf,
  videoApiModelOf,
} from '../shared/image-providers.js'
import { JobQueue } from '../server/jobs.js'
import { scanHistory } from '../server/output.js'
import { ImageApiError } from '../server/image-api.js'
import { generateCloudVideo, probeMp4Size } from '../server/video-api.js'
import { createCheckRunner } from './helpers/check.mjs'

const { check, summary } = createCheckRunner()

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

/** 拼一个 MP4 容器 box（size + type + body）。 */
function mp4Box(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

/**
 * 构造只含尺寸信息的最小 MP4（ftyp + moov/trak/mdia/minf/stbl/stsd/avc1）。
 *
 * 生产代码用 `probeMp4Size()` 从容器读真实宽高；这里不追求可播放，只保证结构足够真实。
 */
function makeMp4(width, height) {
  const avc1 = Buffer.alloc(36)
  avc1.writeUInt32BE(36, 0)
  avc1.write('avc1', 4, 'latin1')
  avc1.writeUInt16BE(1, 14)
  avc1.writeUInt16BE(width, 32)
  avc1.writeUInt16BE(height, 34)
  const stsdBody = Buffer.alloc(8)
  stsdBody.writeUInt32BE(1, 4)
  const stsd = mp4Box('stsd', Buffer.concat([stsdBody, avc1]))
  const ftypBody = Buffer.alloc(8)
  ftypBody.write('isom', 0, 'latin1')
  const ftyp = mp4Box('ftyp', ftypBody)
  const moov = mp4Box('moov', mp4Box('trak', mp4Box('mdia', mp4Box('minf', mp4Box('stbl', stsd)))))
  return Buffer.concat([ftyp, moov])
}

const MP4 = makeMp4(864, 480)
const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

const tempDirs = []
async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'imagen-cloud-video-'))
  tempDirs.push(dir)
  return dir
}

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

function videoReply(res) {
  res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4.length) })
  res.end(MP4)
}

/** 启动「提交 → 轮询两次 → 下载」的完整 mock。 */
async function startVideoMock({ statuses = ['InProgress', 'Succeed'], submitPayload = { requestId: 'req-1' } } = {}) {
  let polls = 0
  const mock = await startMock((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/video/submit') {
      return jsonReply(res, 200, submitPayload)
    }
    if (req.method === 'POST' && req.url === '/v1/video/status') {
      const status = statuses[Math.min(polls, statuses.length - 1)]
      polls += 1
      if (status === 'Succeed') {
        return jsonReply(res, 200, {
          status,
          results: { videos: [{ url: `${mock.baseUrl}/files/out.mp4` }], seed: 7 },
        })
      }
      if (status === 'Failed') return jsonReply(res, 200, { status, reason: 'content moderation' })
      return jsonReply(res, 200, { status })
    }
    if (req.url === '/files/out.mp4') return videoReply(res)
    return jsonReply(res, 404, { message: 'not found' })
  })
  return mock
}

// ── 1. 共享目录 ────────────────────────────────────────────────
await check('目录：视频预设可被 presetById 解析，模态 / 首尾帧 / 档位正确', () => {
  const presets = cloudPresetsFor('siliconflow')
  const videoPresets = presets.filter((item) => item.mediaType === 'video')
  assert.equal(videoPresets.length, 1, '默认模型卡只展示现役 MiniMax-H3（Wan 为兼容保留）')
  assert.equal(presets.filter((item) => item.mediaType === 'image').length, 4)

  const preset = presetById('cloud:siliconflow:MiniMaxAI/MiniMax-H3')
  assert.equal(preset.id, 'cloud:siliconflow:MiniMaxAI/MiniMax-H3')
  assert.equal(preset.mediaType, 'video')
  assert.equal(preset.category, 'video')
  assert.deepEqual(preset.providers, ['cloud-api'])
  assert.equal(preset.supportsReference, true)
  assert.equal(preset.video.maxReferences, 2)
  assert.equal(preset.video.supportsDuration, true)
  assert.equal(preset.video.duration.max, 15)
  assert.equal(preset.cloud.estCostPerVideo, 1.5)

  const wanT2v = cloudVideoPresetOf('siliconflow', 'Wan-AI/Wan2.2-T2V-A14B')
  assert.equal(wanT2v.supportsReference, false)
  assert.equal(wanT2v.video.supportsDuration, false)
  assert.equal(videoApiModelOf('siliconflow', 'nope'), null)
  assert.equal(cloudPresetOf('fal', 'MiniMaxAI/MiniMax-H3'), null, '未登记视频模型的服务商不返回预设')
})

// ── 2. 容器解析 ───────────────────────────────────────────────
await check('解析：probeMp4Size 从 stsd/avc1 读真实宽高，非 MP4 返回 null', () => {
  assert.deepEqual(probeMp4Size(makeMp4(1920, 1080)), { width: 1920, height: 1080 })
  assert.deepEqual(probeMp4Size(makeMp4(640, 640)), { width: 640, height: 640 })
  assert.equal(probeMp4Size(Buffer.from('not a video')), null)
  assert.equal(probeMp4Size(Buffer.alloc(0)), null)
  assert.equal(probeMp4Size(null), null)
  // 只有 ftyp 没有 stsd：按未知处理，交给调用方回退到档位估算。
  assert.equal(probeMp4Size(mp4Box('ftyp', Buffer.alloc(8))), null)
})

// ── 3. MiniMax 适配 ───────────────────────────────────────────
await check('适配：MiniMax 提交 duration / resolution / ratio，首尾帧按 role 映射', async () => {
  const mock = await startVideoMock()
  const tempDir = await mkdtemp(join(tmpdir(), 'imagen-video-adapter-'))
  tempDirs.push(tempDir)
  try {
    const result = await generateCloudVideo({
      config: {
        vendor: 'siliconflow',
        model: 'MiniMaxAI/MiniMax-H3',
        baseUrl: `${mock.baseUrl}/v1`,
        apiKey: 'sf-test',
      },
      request: {
        prompt: 'a cat walking through grass',
        width: 1280,
        height: 720,
        duration: 10,
        resolution: '768p',
        seed: 7,
        frames: [PNG_B64, PNG_B64],
      },
      tempDir,
      fetchImpl: fetch,
      log: silentLog,
    })
    assert.equal(result.mediaType, 'video')
    assert.equal(result.ext, 'mp4')
    assert.equal(result.duration, 10)
    // 真实宽高来自容器（mock 里写的是 864×480），不再按请求参数估算。
    assert.equal(result.width, 864)
    assert.equal(result.height, 480)
    assert.equal((await readFile(result.tempPath)).equals(MP4), true)

    const submit = JSON.parse(mock.requests[0].body)
    assert.equal(mock.requests[0].url, '/v1/video/submit')
    assert.equal(mock.requests[0].headers.authorization, 'Bearer sf-test')
    assert.equal(submit.model, 'MiniMaxAI/MiniMax-H3')
    assert.equal(submit.prompt, 'a cat walking through grass')
    assert.equal(submit.duration, 10)
    assert.equal(submit.resolution, '768p')
    assert.equal(submit.ratio, '16:9')
    assert.equal(submit.seed, 7)
    assert.equal(submit.images.length, 2)
    assert.deepEqual(submit.images.map((item) => item.role), ['first_frame', 'last_frame'])
    assert.equal(submit.images[0].url.startsWith('data:image/png;base64,'), true)
    assert.equal(mock.requests[1].url, '/v1/video/status')
    assert.deepEqual(JSON.parse(mock.requests[1].body), { requestId: 'req-1' })
    assert.equal(mock.requests.at(-1).url, '/files/out.mp4')
  } finally {
    await mock.close()
  }
})

// ── 3. Wan I2V 适配 ───────────────────────────────────────────
await check('适配：Wan I2V 用 image_size + image data URL，负向词按能力下发', async () => {
  const mock = await startVideoMock()
  const tempDir = await mkdtemp(join(tmpdir(), 'imagen-video-wan-'))
  tempDirs.push(tempDir)
  try {
    const result = await generateCloudVideo({
      config: {
        vendor: 'siliconflow',
        model: 'Wan-AI/Wan2.2-I2V-A14B',
        baseUrl: `${mock.baseUrl}/v1`,
        apiKey: 'sf-test',
      },
      request: {
        prompt: 'camera pans right',
        negativePrompt: 'blurry, watermark',
        width: 720,
        height: 1280,
        duration: null,
        resolution: null,
        seed: 3,
        frames: [PNG_B64],
      },
      tempDir,
      fetchImpl: fetch,
      log: silentLog,
    })
    assert.equal(result.duration, null)
    assert.equal(result.width, 864)
    assert.equal(result.height, 480)
    const submit = JSON.parse(mock.requests[0].body)
    assert.equal(submit.model, 'Wan-AI/Wan2.2-I2V-A14B')
    assert.equal(submit.image_size, '720x1280')
    assert.equal(submit.negative_prompt, 'blurry, watermark')
    assert.equal(submit.image.startsWith('data:image/png;base64,'), true)
    assert.equal(Object.prototype.hasOwnProperty.call(submit, 'duration'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(submit, 'ratio'), false)
  } finally {
    await mock.close()
  }
})

// ── 4. 错误归一 ────────────────────────────────────────────────
await check('错误：鉴权 / 余额 / 任务失败都映射到 video_api_* 可执行错误码', async () => {
  const cases = [
    { status: 401, payload: { message: 'invalid api key' }, code: 'video_api_unauthorized' },
    { status: 403, payload: { code: 30001, message: 'balance insufficient' }, code: 'video_api_insufficient_balance' },
    { status: 429, payload: { message: 'rate limit' }, code: 'video_api_rate_limited' },
  ]
  for (const item of cases) {
    const mock = await startMock((req, res) => jsonReply(res, item.status, item.payload))
    const tempDir = await mkdtemp(join(tmpdir(), 'imagen-video-error-'))
    tempDirs.push(tempDir)
    try {
      await assert.rejects(
        generateCloudVideo({
          config: {
            vendor: 'siliconflow',
            model: 'MiniMaxAI/MiniMax-H3',
            baseUrl: `${mock.baseUrl}/v1`,
            apiKey: 'k',
          },
          request: { prompt: 'x', width: 1280, height: 720, duration: 5, resolution: '768p' },
          tempDir,
          fetchImpl: fetch,
          log: silentLog,
        }),
        (error) => error instanceof ImageApiError && error.code === item.code,
      )
    } finally {
      await mock.close()
    }
  }

  const failedMock = await startVideoMock({ statuses: ['Failed'] })
  const tempDir = await mkdtemp(join(tmpdir(), 'imagen-video-failed-'))
  tempDirs.push(tempDir)
  try {
    await assert.rejects(
      generateCloudVideo({
        config: {
          vendor: 'siliconflow',
          model: 'MiniMaxAI/MiniMax-H3',
          baseUrl: `${failedMock.baseUrl}/v1`,
          apiKey: 'k',
        },
        request: { prompt: 'x', width: 1280, height: 720, duration: 5, resolution: '768p' },
        tempDir,
        fetchImpl: fetch,
        log: silentLog,
      }),
      (error) => error instanceof ImageApiError && error.code === 'video_api_failed' && /content moderation/.test(error.message),
    )
  } finally {
    await failedMock.close()
  }
})

// ── 5. JobQueue 端到端 ────────────────────────────────────────
await check('队列：视频任务落盘 01.mp4，meta / 历史条目 mediaType=video，参考图映射首帧', async () => {
  const workspace = await makeWorkspace()
  // 参考图必须在 outputs/ 内：造一个真实 PNG 供 reference-loader 读取。
  const refDir = join(workspace, 'outputs', '20260101-000000-ref')
  await mkdir(refDir, { recursive: true })
  await writeFile(join(refDir, '01.png'), PNG)

  const mock = await startVideoMock()
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
    defaultPreset: 'cloud:siliconflow:MiniMaxAI/MiniMax-H3',
    options: {
      getProvider: () => 'cloud-api',
      getImageApiConfig: () => ({
        vendor: 'siliconflow',
        model: 'MiniMaxAI/MiniMax-H3',
        baseUrl: `${mock.baseUrl}/v1`,
        apiKey: 'sf-test',
      }),
      sessionPollMs: 10,
    },
  })
  try {
    const rejected = queue.submit({
      prompt: 'x',
      presetId: 'cloud:siliconflow:Wan-AI/Wan2.2-T2V-A14B',
      references: ['outputs/20260101-000000-ref/01.png'],
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, 'video_api_unsupported', 'T2V 不接受参考图')

    const submitted = queue.submit({
      prompt: 'a paper boat drifting on a pond',
      presetId: 'cloud:siliconflow:MiniMaxAI/MiniMax-H3',
      width: 1280,
      height: 720,
      duration: 10,
      resolution: '768p',
      seed: 7,
      count: 4,
      references: ['outputs/20260101-000000-ref/01.png'],
      saveTo: 'exports/clip',
    })
    assert.equal(submitted.ok, true, JSON.stringify(submitted))
    assert.equal(submitted.job.mediaType, 'video')
    assert.equal(submitted.job.params.count, 1, '视频固定单条')
    assert.equal(submitted.job.params.duration, 10)
    assert.equal(submitted.job.params.resolution, '768p')

    const done = await queue.waitFor(submitted.job.id, 8)
    assert.equal(done.status, 'done', JSON.stringify(done.error))
    assert.equal(done.provider, 'cloud-api')
    const video = done.output.images[0]
    assert.equal(video.mediaType, 'video')
    assert.equal(video.file, '01.mp4')
    assert.equal(video.duration, 10)
    assert.equal(done.output.deliveredPaths[0], 'exports/clip.mp4')

    const dir = join(workspace, video.path.replace(/^outputs[\\/]/, 'outputs/').split('/')[0])
    const meta = JSON.parse(await readFile(join(workspace, 'outputs', video.path.split('/')[1], 'meta.json'), 'utf8'))
    assert.equal(meta.mediaType, 'video')
    assert.equal(meta.images[0].mediaType, 'video')
    assert.equal(meta.images[0].duration, 10)
    assert.equal(meta.provider, 'cloud-api')
    assert.equal(meta.modelId, 'siliconflow/MiniMaxAI/MiniMax-H3')
    assert.equal((await readFile(join(workspace, 'exports', 'clip.mp4'))).equals(MP4), true)
    void dir

    const history = await scanHistory(ctx, 10)
    const item = history.items.find((entry) => entry.jobId === submitted.job.id)
    assert.ok(item, '历史里能找到视频任务')
    assert.equal(item.mediaType, 'video')
    assert.equal(item.images[0].mediaType, 'video')
    assert.equal(item.images[0].duration, 10)
  } finally {
    queue.dispose()
    await mock.close()
  }
})

summary()
for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
