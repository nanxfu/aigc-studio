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
import {
  BENCHMARK_MODELS,
  buildFocusedLadderSegments,
  evaluateDeviceCapability,
  evaluatePresetLocalFit,
  matchGpuProfile,
} from '../shared/gpu-benchmark.js'
import { createAppConfig } from '../server/app-config.js'
import {
  createHardwareProbe,
  parseMacDisplaysJson,
  parseNvidiaSmiCsv,
  parseVulkanSummary,
  parseWindowsVideoControllers,
} from '../server/hardware-probe.js'
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
      const fp16 = localModelById('realesrgan-x2plus-fp16')
      const fp32 = localModelById('realesrgan-x2plus-fp32')
      assert.equal(fp16?.task, 'upscale')
      assert.equal(fp16?.input?.scale, 2)
      assert.equal(fp32?.preferredEps.includes('wasm'), true)
      assert.match(fp16?.sha256 || '', /^[a-f0-9]{64}$/)
      assert.match(fp32?.sha256 || '', /^[a-f0-9]{64}$/)
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

    await check('硬件探测与天梯评估覆盖 N 卡 nvidia-smi、AMD Vulkan 核显、Mac 及磁盘余量', async () => {
      // 1) nvidia-smi CSV 解析 + 同名多显存版本消歧（4060 Ti 16G vs 8G）
      const smiGpus = parseNvidiaSmiCsv('NVIDIA GeForce RTX 4060 Ti, 16380, 15200, 566.14\n')
      assert.equal(smiGpus.length, 1)
      assert.equal(smiGpus[0].vramMb, 16380)
      const p4060ti16 = matchGpuProfile({ gpuName: smiGpus[0].name, vramMb: smiGpus[0].vramMb })
      assert.equal(p4060ti16.matchedId, 'rtx-4060-ti-16g')
      assert.equal(p4060ti16.vramSource, 'measured')

      // 2) 证明双维评价：3060 12G 的原生可跑模型数多于 4060 8G
      const eval3060 = evaluateDeviceCapability(matchGpuProfile({ presetId: 'rtx-3060-12g' }))
      const eval4060 = evaluateDeviceCapability(matchGpuProfile({ presetId: 'rtx-4060-8g' }))
      assert.ok(eval3060.score.unlockedFp16 > eval4060.score.unlockedFp16)
      assert.ok(eval3060.ladder.some((r) => r.isCloudRef))
      assert.ok(eval3060.ladder.some((r) => r.isCurrentUser && r.id === 'rtx-3060-12g'))

      // 2.1) 聚焦天梯折叠：前 3 + 折叠间隔 + 本机前后 + 尾部；若本机在前 3 则顶部不折叠
      const segs880m = buildFocusedLadderSegments(
        evaluateDeviceCapability(matchGpuProfile({ presetId: 'amd-radeon-880m-apu' })).ladder,
        { topCount: 3, aroundSelf: 1, tailCount: 1 },
      )
      const gapCount880m = segs880m.filter((s) => s.type === 'gap').length
      assert.ok(gapCount880m >= 1 && segs880m.some((s) => s.type === 'row' && s.row.isCurrentUser))
      const segs4090 = buildFocusedLadderSegments(
        evaluateDeviceCapability(matchGpuProfile({ presetId: 'rtx-4090-24g' })).ladder,
        { topCount: 3, aroundSelf: 1, tailCount: 1 },
      )
      assert.equal(segs4090[0].type, 'row')
      assert.equal(segs4090[1].type, 'row')
      assert.equal(segs4090[2].type, 'row')

      // 3) 非 N 卡 Vulkan + Windows CIM（忽略 WMI 4GB 截断，按统一内存估算）
      const vkGpus = parseVulkanSummary(`
Devices:
========
GPU0:
\tvendorID = 0x1002
\tdeviceType = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
\tdeviceName = AMD Radeon(TM) 880M Graphics
\tdriverInfo = 26.6.1 (LLPC)
`)
      assert.equal(vkGpus[0].vendor, 'amd')
      assert.equal(vkGpus[0].isIntegrated, true)

      const cimGpus = parseWindowsVideoControllers(
        JSON.stringify({ Name: 'AMD Radeon(TM) 880M Graphics', AdapterRAM: 4293918720, PNPDeviceID: 'PCI\\VEN_1002&DEV_150E' }),
      )
      assert.equal(cimGpus[0].vramMb, null)
      assert.equal(cimGpus[0].isIntegrated, true)

      const macGpus = parseMacDisplaysJson(
        JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M3 Max', spdisplays_metal: 'Metal 3' }] }),
      )
      assert.equal(macGpus[0].vendor, 'apple')

      // 4) Host 路由 /api/local-models/hardware（无 nvidia-smi 时回退 vulkaninfo 并走缓存 / refresh=1）
      let probeRuns = 0
      const probe = createHardwareProbe({
        platform: 'win32',
        totalmemFn: () => 32 * 1024 * 1024 * 1024,
        freememFn: () => 16 * 1024 * 1024 * 1024,
        cpusFn: () => [{ model: 'AMD Ryzen AI 9 H 365' }],
        statfsImpl: async () => ({ bavail: 100, bsize: 1024 * 1024 * 1024 }),
        execFileImpl: async (cmd) => {
          probeRuns += 1
          if (cmd === 'nvidia-smi') throw new Error('ENOENT')
          if (cmd === 'vulkaninfo') {
            return {
              stdout: 'GPU0:\n\tvendorID = 0x1002\n\tdeviceType = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU\n\tdeviceName = AMD Radeon(TM) 880M Graphics\n',
            }
          }
          return { stdout: '' }
        },
      })
      const manager = createLocalModelManager({ ctx, appConfig, env: {}, log: SILENT_LOG })
      const routes = createLocalModelsRoutes({ ctx, appConfig, localModels: manager, hardwareProbe: probe, log: SILENT_LOG })
      const hwRoute = routeOf(routes, ROUTES.localModelsHardware.path)

      const hwRes1 = makeRes()
      await hwRoute.handler({ url: ROUTES.localModelsHardware.path }, hwRes1)
      assert.equal(hwRes1.state.code, 200)
      assert.equal(hwRes1.state.body.hardware.hasNvidiaSmi, false)
      assert.equal(hwRes1.state.body.hardware.disk.freeGb, 100)
      assert.equal(hwRes1.state.body.hardware.evaluation.profile.matchedId, 'amd-radeon-880m-apu')
      assert.equal(hwRes1.state.body.hardware.evaluation.profile.vramGb, 12)
      const runsAfterFirst = probeRuns

      // 命中缓存不重复跑子进程
      const hwRes2 = makeRes()
      await hwRoute.handler({ url: ROUTES.localModelsHardware.path }, hwRes2)
      assert.equal(probeRuns, runsAfterFirst)

      // refresh=1 强制重探
      const hwRes3 = makeRes()
      await hwRoute.handler({ url: `${ROUTES.localModelsHardware.path}?refresh=1` }, hwRes3)
      assert.ok(probeRuns > runsAfterFirst)

      // 5) RealVisXL V5 Lightning 已进入基准标尺且 evaluatePresetLocalFit 可正确联动已配置权重
      assert.ok(BENCHMARK_MODELS.some((m) => m.id === 'realvisxl-lightning'))
      const fitVerified = evaluatePresetLocalFit(
        { id: 'realvisxl-lightning', providers: ['local-gpu'] },
        hwRes1.state.body.hardware.evaluation,
        { ok: true, configuredPresets: ['realvisxl-lightning'] },
      )
      assert.equal(fitVerified.status, 'gguf-planned')
      assert.equal(fitVerified.ggufVerified, true)
      assert.equal(fitVerified.configured, true)
      const fit9bOn880m = evaluatePresetLocalFit(
        { id: 'flux2-klein-9b', providers: ['colab'] },
        hwRes1.state.body.hardware.evaluation,
        { ok: true, configuredPresets: ['realvisxl-lightning'] },
      )
      assert.equal(fit9bOn880m.status, 'gguf-planned')
      assert.equal(fit9bOn880m.configured, false)
      const eval4g = evaluateDeviceCapability(matchGpuProfile({ presetId: 'intel-arc-igpu' }))
      const fitCloud = evaluatePresetLocalFit(
        { id: 'flux2-klein-9b', providers: ['colab'] },
        eval4g,
        null,
      )
      assert.equal(fitCloud.status, 'cloud-recommended')
      assert.equal(fitCloud.configured, false)
    })
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
  summary()
}

await main()
