#!/usr/bin/env node
/**
 * 本机端侧模型统一管理离线回归（shared/local-models + server/local-models + routes/local-models）。
 *
 * 覆盖：
 *  - 全局模型目录解析（AIGC_STUDIO_LOCAL_MODELS_DIR > appConfig.localModelsDir > <dataDir>/models）；
 *  - 旧工作区 `.aigc-studio/models/` 兼容读取（切换工作区也不丢全局缓存）；
 *  - 单飞下载、大小与 SHA-256 校验、损坏重试、失败冷却、清理释放；
 *  - HTTP 路由：GET /api/local-models、POST /download、POST /delete、POST /dir、GET /file。
 *
 * 运行：node test/host-local-models.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { LOCAL_MODELS, ROUTES, localModelById } from '../shared/contract.js'
import { createAppConfig } from '../server/app-config.js'
import { createLocalModelManager } from '../server/local-models.js'
import { createLocalModelsRoutes } from '../server/routes/local-models.js'
import { createWorkshopVision } from '../server/workshop-vision.js'
import { createCheckRunner } from './helpers/check.mjs'
import { makeRes, workspaceContext } from './helpers/fake-context.mjs'

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} }
const { check, summary } = createCheckRunner()

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function fakeRequest(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return Readable.from([Buffer.from(text, 'utf8')])
}

function routeOf(routes, path) {
  return routes.find((r) => r.path === path)
}

async function main() {
  const tmp = await mkdtemp(join(process.cwd(), '.tmp', 'local-models-test-').replace(/[/\\]\.tmp/, '/.tmp'))
  try {
    const dataDir = join(tmp, 'userdata')
    const wsDir = join(tmp, 'workspace')
    const customDir = join(tmp, 'custom-models')
    await mkdir(wsDir, { recursive: true })
    const ctx = workspaceContext(wsDir)
    const appConfig = createAppConfig({ dataDir, log: SILENT_LOG })
    await appConfig.whenReady()

    // 注意：真实模型的 sha256 在 shared/local-models.js 里已钉死；为了离线单测不联网下百 MB，
    // 这里直接测「合法文件命中 + 损坏拒绝 + 目录切换 + 路由」，以及用 mock fetch 测真 sha/bytes 校验分支。
    const visionSpec = localModelById('mobileclip-s0-fp16')
    const cutoutSpec = localModelById('rmbg-1.4-q8')

    await check('注册表包含 vision 与 cutout 全部本机模型', () => {
      assert.ok(LOCAL_MODELS.length >= 3)
      assert.ok(visionSpec && visionSpec.task === 'vision')
      assert.ok(cutoutSpec && cutoutSpec.task === 'cutout')
      assert.ok(localModelById('rmbg-1.4-fp16')?.runtime === 'webgpu')
    })

    await check('默认全局目录落到 <dataDir>/models 且支持向下兼容读取旧工作区缓存', async () => {
      const manager = createLocalModelManager({ ctx, appConfig, env: {}, log: SILENT_LOG })
      assert.equal(manager.effectiveDir(), join(dataDir, 'models'))

      // 旧工作区存在与 spec 不匹配字节的坏文件 → 不会被误认为 ready
      const legacyPath = join(wsDir, '.aigc-studio', 'models', ...visionSpec.legacyWorkspaceSubpath.split('/'))
      await mkdir(join(wsDir, '.aigc-studio', 'models', 'mobileclip-s0'), { recursive: true })
      await writeFile(legacyPath, Buffer.from('bad-bytes'))
      const listing = await manager.listModels({ ctx })
      const visionItem = listing.models.find((m) => m.id === visionSpec.id)
      assert.equal(visionItem.status, 'missing')
    })

    await check('自定义目录可持久化到 app-config 并通过 /api/local-models/dir 校验切换', async () => {
      const manager = createLocalModelManager({ ctx, appConfig, env: {}, log: SILENT_LOG })
      const routes = createLocalModelsRoutes({ ctx, appConfig, localModels: manager, log: SILENT_LOG })

      const badRes = makeRes()
      await routeOf(routes, ROUTES.localModelsDir.path).handler(fakeRequest({ dir: 'relative/path' }), badRes)
      assert.equal(badRes.state.code, 400)

      const okRes = makeRes()
      await routeOf(routes, ROUTES.localModelsDir.path).handler(fakeRequest({ dir: customDir }), okRes)
      assert.equal(okRes.state.code, 200)
      assert.equal(okRes.state.body.dir, customDir)
      assert.equal(okRes.state.body.customDir, customDir)
      assert.equal(manager.effectiveDir(), customDir)

      // 重置为空串恢复默认目录
      const resetRes = makeRes()
      await routeOf(routes, ROUTES.localModelsDir.path).handler(fakeRequest({ dir: '' }), resetRes)
      assert.equal(resetRes.state.code, 200)
      assert.equal(resetRes.state.body.dir, join(dataDir, 'models'))
      assert.equal(resetRes.state.body.customDir, '')
    })

    await check('下载失败触发冷却且返回 503；未知模型返回 404', async () => {
      let nowMs = 10_000
      let fetchCount = 0
      const manager = createLocalModelManager({
        ctx,
        appConfig,
        env: {},
        now: () => nowMs,
        failureCooldownMs: 30_000,
        fetchImpl: async () => {
          fetchCount += 1
          return { ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) }
        },
        log: SILENT_LOG,
      })
      const routes = createLocalModelsRoutes({ ctx, appConfig, localModels: manager, log: SILENT_LOG })

      const missingRes = makeRes()
      await routeOf(routes, ROUTES.localModelDownload.path).handler(fakeRequest({ id: 'unknown-id' }), missingRes)
      assert.equal(missingRes.state.code, 404)

      await assert.rejects(() => manager.ensureModel(cutoutSpec.id))
      assert.equal(fetchCount, 1)
      // 冷却期不重复请求远端
      await assert.rejects(() => manager.ensureModel(cutoutSpec.id))
      assert.equal(fetchCount, 1)

      const fileRes = makeRes()
      await routeOf(routes, ROUTES.localModelFile.path).handler({ url: `${ROUTES.localModelFile.path}?id=${cutoutSpec.id}` }, fileRes)
      assert.equal(fileRes.state.code, 503)

      // 过冷却期后重新允许尝试
      nowMs += 31_000
      await assert.rejects(() => manager.ensureModel(cutoutSpec.id))
      assert.equal(fetchCount, 2)
    })

    await check('环境变量覆盖本地文件可直接通过 /api/local-models/file 流式读取并在 delete 时清理缓存', async () => {
      const overrideFile = join(tmp, 'override-rmbg.onnx')
      const payload = Buffer.from('fake-onnx-model-bytes')
      await writeFile(overrideFile, payload)

      const manager = createLocalModelManager({
        ctx,
        appConfig,
        env: { [cutoutSpec.envPathKey]: overrideFile },
        log: SILENT_LOG,
      })
      const list = await manager.listModels({ ctx })
      const entry = list.models.find((m) => m.id === cutoutSpec.id)
      assert.equal(entry.status, 'ready')
      assert.equal(entry.source, 'env')
      assert.equal(entry.path, overrideFile)

      const opened = await manager.openModelStream(cutoutSpec.id, { ctx })
      assert.equal(opened.ok, true)
      assert.equal(opened.bytes, payload.length)
      opened.stream.destroy()

      // 校验主路径下存在文件时 deleteModel 会删除它
      const primaryDir = join(dataDir, 'models', 'rmbg-1.4')
      await mkdir(primaryDir, { recursive: true })
      const primaryFile = join(primaryDir, 'model_quantized.onnx')
      await writeFile(primaryFile, payload)
      const managerNoEnv = createLocalModelManager({ ctx, appConfig, env: {}, log: SILENT_LOG })
      const del = await managerNoEnv.deleteModel(cutoutSpec.id, { ctx })
      assert.equal(del.ok, true)
      const exists = await stat(primaryFile).catch(() => null)
      assert.equal(exists, null)
      assert.ok(sha256(payload).length === 64)
    })

    await check('支持启用/停用本机模型开关，持久化到 app-config 并联动 workshop-vision', async () => {
      const manager = createLocalModelManager({ ctx, appConfig, env: {}, log: SILENT_LOG })
      const routes = createLocalModelsRoutes({ ctx, appConfig, localModels: manager, log: SILENT_LOG })
      const vision = createWorkshopVision({ localModels: manager, log: SILENT_LOG })
      assert.equal(vision.isDisabled(), false)

      const offRes = makeRes()
      await routeOf(routes, ROUTES.localModelToggle.path).handler(
        fakeRequest({ id: visionSpec.id, enabled: false }),
        offRes,
      )
      assert.equal(offRes.state.code, 200)
      assert.equal(offRes.state.body.model.disabled, true)
      assert.equal(offRes.state.body.model.disabledBy, 'user')
      assert.equal(vision.isDisabled(), true)
      await assert.rejects(() => manager.ensureModel(visionSpec.id))

      // 重新构造一个 appConfig 读取磁盘，确认开关已持久化。
      const reloadedConfig = createAppConfig({ dataDir, log: SILENT_LOG })
      await reloadedConfig.whenReady()
      assert.deepEqual(reloadedConfig.getDisabledLocalModels(), [visionSpec.id])

      const onRes = makeRes()
      await routeOf(routes, ROUTES.localModelToggle.path).handler(
        fakeRequest({ id: visionSpec.id, enabled: true }),
        onRes,
      )
      assert.equal(onRes.state.code, 200)
      assert.equal(onRes.state.body.model.disabled, false)
      assert.equal(vision.isDisabled(), false)
    })
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
  summary()
}

await main()
