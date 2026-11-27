#!/usr/bin/env node
/**
 * 本机端侧超分落盘路由离线回归（M3.5 Phase D S3）。
 *
 * 覆盖：来源路径校验、PNG 回传 / 尺寸校验、标准 upscale meta（upscale / sourceImage /
 * rootImage / upscaleScale）与历史条目形状。真正 ONNX 前向由浏览器测试 / 真机验收负责，
 * 这里不下载 67 MB 权重。
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ROUTES } from '../shared/contract.js'
import { createLocalUpscaleRoutes } from '../server/routes/local-upscale.js'
import { createCheckRunner } from './helpers/check.mjs'
import { makeRes, workspaceContext } from './helpers/fake-context.mjs'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const { check, summary } = createCheckRunner()

function fakeRequest(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), 'utf8')])
}

const root = await mkdtemp(join(tmpdir(), 'aigc-local-upscale-'))
try {
  const workspace = join(root, 'workspace')
  const sourceDir = join(workspace, 'outputs', 'source-1')
  await mkdir(sourceDir, { recursive: true })
  await writeFile(join(sourceDir, '01.png'), Buffer.from(PNG_B64, 'base64'))
  await writeFile(join(sourceDir, 'meta.json'), JSON.stringify({
    version: 1,
    mediaType: 'image',
    jobId: 'source-1',
    presetId: 'sdxl-lightning',
    createdAt: '2026-11-27T00:00:00.000Z',
    finishedAt: '2026-11-27T00:00:01.000Z',
    params: { prompt: 'a quiet lighthouse', width: 1, height: 1, count: 1 },
    images: [{ file: '01.png', width: 1, height: 1, mediaType: 'image' }],
    source: 'ai',
  }, null, 2))

  const ctx = workspaceContext(workspace)
  const route = createLocalUpscaleRoutes({ ctx, log: silentLog })
    .find((item) => item.path === ROUTES.localUpscaleSave.path)
  assert.ok(route, '应注册本机超分落盘路由')

  await check('本机超分：回传 PNG 落为标准 upscale 子版本并继承来源树', async () => {
    const res = makeRes()
    await route.handler(fakeRequest({
      data: `data:image/png;base64,${PNG_B64}`,
      sourcePath: 'outputs/source-1/01.png',
      width: 1,
      height: 1,
      prompt: 'a quiet lighthouse',
      model: 'realesrgan-x2plus-fp16',
      ep: 'webgpu',
      elapsedMs: 1234,
    }), res)
    assert.equal(res.state.code, 200, JSON.stringify(res.state.body))
    const entry = res.state.body.entry
    assert.equal(entry.image.path.startsWith('outputs/'), true)
    assert.equal(entry.item.upscale, true)
    assert.equal(entry.item.upscaleScale, 2)
    assert.equal(entry.item.sourceImage, 'outputs/source-1/01.png')
    assert.equal(entry.item.rootImage, 'outputs/source-1/01.png')
    assert.equal(entry.image.width, 1)
    assert.equal(entry.image.height, 1)

    const metaPath = join(workspace, entry.item.dir, 'meta.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    assert.equal(meta.upscale, true)
    assert.equal(meta.upscaleScale, 2)
    assert.equal(meta.sourceImage, 'outputs/source-1/01.png')
    assert.equal(meta.rootImage, 'outputs/source-1/01.png')
    assert.match(meta.device, /WebGPU/)
  })

  await check('本机超分：非法来源与声明尺寸不一致会被拒绝', async () => {
    const badSource = makeRes()
    await route.handler(fakeRequest({
      data: `data:image/png;base64,${PNG_B64}`,
      sourcePath: '../outside.png',
    }), badSource)
    assert.equal(badSource.state.code, 400)
    assert.equal(badSource.state.body.error.code, 'invalid_path')

    const mismatch = makeRes()
    await route.handler(fakeRequest({
      data: `data:image/png;base64,${PNG_B64}`,
      sourcePath: 'outputs/source-1/01.png',
      width: 512,
      height: 512,
    }), mismatch)
    assert.equal(mismatch.state.code, 400)
    assert.equal(mismatch.state.body.error.code, 'invalid_request')
  })
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

summary()
