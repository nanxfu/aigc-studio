import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  evaluateLocalPbr,
  evaluateWorkshopCompute,
  LOCAL_PBR,
  WORKSHOP_COMPUTE_PROFILES,
  workshopCloudProvider,
} from '../shared/workshop-compute.js'
import { createLocalPbr, runPbrProcess } from '../server/local-pbr.js'
import { createLocalWorkshop } from '../server/local-cuda-runner.js'
import { createHardwareProbe } from '../server/hardware-probe.js'
import { JobQueue } from '../server/jobs/queue.js'
import { createLocalModelsRoutes } from '../server/routes/local-models.js'
import { submitWorkshopOp } from '../server/workshop.js'
import { createCheckRunner } from './helpers/check.mjs'
import { createFakeContext } from './helpers/fake-context.mjs'

const { check, summary } = createCheckRunner()
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const capableHardware = {
  platform: 'win32', arch: 'x64',
  memory: { totalMb: 32768, freeMb: 16384 }, disk: { freeGb: 100 },
  gpus: [{ vendor: 'nvidia', source: 'nvidia-smi', name: 'RTX 4060 Ti', vramMb: 16384, vramFreeMb: 12000 }],
}
const root = await mkdtemp(join(tmpdir(), 'aigc-local-pbr-'))
const { ctx } = createFakeContext(root)
const source = join(root, 'outputs/source/01.png')
await mkdir(join(root, 'outputs/source'), { recursive: true })
// 路由读取 PNG 头，实际模型由注入执行器替代。
const sourceHeader = Buffer.from(PNG_B64, 'base64')
sourceHeader.writeUInt32BE(512, 16)
sourceHeader.writeUInt32BE(512, 20)
await writeFile(source, sourceHeader)

function sessionStub(provider = 'cloud-api') {
  return {
    isReady: true, stoppedByUser: false,
    snapshot: () => ({ provider, state: 'ready' }),
    start: async () => { throw new Error('本地任务不应启动会话') },
    connection: () => { throw new Error('本地任务不应连接远端') },
  }
}

try {
  await check('PBR 硬件检测：资源足够默认本地；未知、非 CUDA、低显存、内存或磁盘不足默认云端', async () => {
    assert.equal(evaluateLocalPbr(capableHardware).defaultExecution, 'local')
    assert.equal(evaluateLocalPbr(null).reason, 'checking')
    assert.equal(evaluateLocalPbr({ ...capableHardware, platform: 'darwin' }).reason, 'platform')
    assert.equal(evaluateLocalPbr({ ...capableHardware, gpus: [{ ...capableHardware.gpus[0], vendor: 'amd' }] }).reason, 'gpu')
    assert.equal(evaluateLocalPbr({ ...capableHardware, gpus: [{ ...capableHardware.gpus[0], vramMb: 6144 }] }).reason, 'gpu')
    assert.equal(evaluateLocalPbr({ ...capableHardware, gpus: [{ ...capableHardware.gpus[0], vramFreeMb: 4000 }] }).reason, 'busy')
    assert.equal(evaluateLocalPbr({ ...capableHardware, memory: { totalMb: 8192, freeMb: 6000 } }).reason, 'memory')
    assert.equal(evaluateLocalPbr({ ...capableHardware, disk: { freeGb: 3 } }).reason, 'disk')
    assert.equal(evaluateLocalPbr({ ...capableHardware, disk: { freeGb: 3 }, localPbr: { prepared: true } }).available, true)
    assert.equal(evaluateLocalPbr(capableHardware, { model: 'chord' }).reason, 'model')
  })

  await check('PBR 多卡检测：单卡足够才可用，不把多块小卡的显存相加', async () => {
    const small = { ...capableHardware.gpus[0], vramMb: 4096 }
    assert.equal(evaluateLocalPbr({ ...capableHardware, gpus: [small, small] }).available, false)
    const busy = { ...capableHardware.gpus[0], vramFreeMb: 1000 }
    assert.equal(evaluateLocalPbr({ ...capableHardware, gpus: [busy, capableHardware.gpus[0]] }).gpuIndex, 1)
    assert.equal(evaluateLocalPbr({ ...capableHardware, memory: { totalMb: 16000, freeMb: 5000 },
      gpus: [{ ...capableHardware.gpus[0], vramMb: 8188 }] }).available, true, '16 GB 内存与 8 GB 显卡允许固件预留')
  })

  await check('M4.2f 三层算力画像：端侧 / 本机 CUDA / 仅云端与缓存体积提示同源', async () => {
    const expectedProfiles = [
      'pbr:marigold',
      'pbr:chord',
      'depth:da3-small',
      'depth:da3mono-large',
      'depth:da3-large',
      'depth:moge-2-vitl',
      'relight:ic-light',
      'remove-bg:rmbg-1.4',
      'remove-bg:birefnet',
      'remove-bg:rmbg-2.0',
      'remove-bg:rmbg-3.0',
    ]
    assert.deepEqual(Object.keys(WORKSHOP_COMPUTE_PROFILES), expectedProfiles)

    const cold = {
      ...capableHardware,
      localWorkshop: { envCached: false, cachedModels: {} },
    }
    const pbr = evaluateWorkshopCompute(cold, { op: 'pbr', model: 'marigold' })
    assert.equal(pbr.tier, 'hybrid-cuda')
    assert.equal(pbr.localEligible, true)
    assert.equal(pbr.recommended, 'local')
    assert.equal(pbr.badge, 'local-ready')
    assert.equal(pbr.needsDownload, true)
    assert.match(pbr.downloadText, /3 GB/)
    assert.match(pbr.downloadText, /5\.2 GB/)

    const ready = evaluateWorkshopCompute({
      ...capableHardware,
      localWorkshop: {
        envCached: true,
        cachedModels: { 'pbr:marigold': true },
      },
    }, { op: 'pbr', model: 'marigold' })
    assert.equal(ready.needsDownload, false)
    assert.equal(ready.downloadText, '')

    const edge = evaluateWorkshopCompute(cold, { op: 'depth', model: 'da3-small' })
    assert.equal(edge.tier, 'edge-onnx')
    assert.equal(edge.badge, 'edge-fast')
    assert.equal(edge.recommended, 'local')
    assert.equal(edge.localEligible, true)

    const cloudOnly = evaluateWorkshopCompute(cold, { op: 'pbr', model: 'chord' })
    assert.equal(cloudOnly.tier, 'cloud-only')
    assert.equal(cloudOnly.badge, 'cloud-only')
    assert.equal(cloudOnly.localEligible, false)

    const cutoutEdge = evaluateWorkshopCompute(cold, { op: 'remove-bg', model: 'rmbg-1.4' })
    assert.equal(cutoutEdge.tier, 'edge-onnx')
    assert.equal(cutoutEdge.badge, 'edge-fast')
    const cutoutQuality = evaluateWorkshopCompute(cold, { op: 'remove-bg', model: 'birefnet' })
    assert.equal(cutoutQuality.tier, 'hybrid-cuda')
    assert.equal(cutoutQuality.badge, 'local-ready')
    const cutoutExtreme = evaluateWorkshopCompute(cold, { op: 'remove-bg', model: 'rmbg-3.0' })
    assert.equal(cutoutExtreme.tier, 'cloud-only')
    assert.equal(cutoutExtreme.badge, 'cloud-only')

    const noGpu = evaluateWorkshopCompute({ ...cold, gpus: [] }, { op: 'depth', model: 'da3mono-large' })
    assert.equal(noGpu.localEligible, false)
    assert.equal(noGpu.reasonCode, 'gpu')
    assert.equal(noGpu.badge, 'cloud-recommended')
    const busy = evaluateWorkshopCompute({
      ...cold,
      gpus: [{ ...capableHardware.gpus[0], vramFreeMb: 5000 }],
    }, { op: 'depth', model: 'moge-2-vitl' })
    assert.equal(busy.reasonCode, 'busy')
    assert.equal(busy.localEligible, false)
    assert.equal(
      evaluateWorkshopCompute({ ...cold, platform: 'darwin' }, { op: 'relight', model: 'ic-light' }).reasonCode,
      'platform',
    )
    assert.equal(
      evaluateWorkshopCompute({ ...cold, disk: { freeGb: 2 } }, { op: 'relight', model: 'ic-light' }).reasonCode,
      'disk',
    )
  })

  await check('首次使用模型目录尚不存在时，检测已有父目录的磁盘余量', async () => {
    const probedPaths = []
    const probe = createHardwareProbe({
      execFileImpl: async (command) => ({ stdout: command === 'nvidia-smi' ? 'RTX 4060 Ti, 16384, 12000, 555.0' : '' }),
      statfsImpl: async (path) => {
        probedPaths.push(path)
        if (path !== root) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return { bavail: 100, bsize: 1024 ** 3 }
      }, totalmemFn: () => 32 * 1024 ** 3, freememFn: () => 16 * 1024 ** 3,
    })
    const hardware = await probe.probe({ modelsDir: join(root, 'missing/models') })
    assert.equal(hardware.disk.freeGb, 100)
    assert.equal(probedPaths.at(-1), root)
    assert.equal(evaluateLocalPbr(hardware).available, true)
  })

  await check('云端 PBR 使用 Worker 来源；商业 API 与 Vulkan 回退到 Kaggle，不改变生图配置', async () => {
    for (const provider of ['kaggle', 'colab', 'salad', 'private-worker']) assert.equal(workshopCloudProvider(provider), provider)
    for (const provider of ['cloud-api', 'local-gpu']) assert.equal(workshopCloudProvider(provider), 'kaggle')
  })

  await check('M4.2f 硬件接口：返回共享 CUDA 环境与各模型缓存状态，并保留旧 PBR 字段', async () => {
    const routes = createLocalModelsRoutes({
      localModels: { effectiveDir: () => join(root, 'models-route') },
      hardwareProbe: { probe: async () => capableHardware },
      localWorkshop: {
        readInfo: async () => ({
          prepared: true,
          envCached: true,
          cachedModels: { 'depth:da3mono-large': true },
        }),
      },
    })
    const route = routes.find((item) => item.name === 'local-models-hardware')
    assert.ok(route)
    let payload = null
    const res = {
      writeHead() {},
      end(body) {
        payload = JSON.parse(Buffer.from(body).toString('utf8'))
      },
    }
    await route.handler({ url: '/api/local-models/hardware' }, res)
    assert.equal(payload.ok, true)
    assert.equal(payload.hardware.localWorkshop.envCached, true)
    assert.equal(payload.hardware.localWorkshop.cachedModels['depth:da3mono-large'], true)
    assert.equal(payload.hardware.localPbr.prepared, true)
  })

  await check('本地 PBR 子进程：真实 stdin/stdout JSON，退出错误与取消可传播', async () => {
    const result = await runPbrProcess(process.execPath, ['-e', "process.stdin.on('data', b => console.log(JSON.stringify({event:'result',value:JSON.parse(b).value})))"], { input: { value: 42 } })
    assert.equal(result.value, 42)
    await assert.rejects(runPbrProcess(process.execPath, ['-e', "console.log(JSON.stringify({event:'error',code:'oom',message:'CUDA out of memory'}));process.exit(1)"]), { code: 'oom' })
    const controller = new AbortController()
    const waiting = runPbrProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal })
    controller.abort(new Error('test cancel'))
    await assert.rejects(waiting, /test cancel/)
  })

  await check('本地 PBR：首次准备独立环境、四通道读回、缓存复用、临时产物清理', async () => {
    const calls = []
    const runtimeRoot = join(root, 'runtime-test')
    const models = join(root, 'models-test')
    const engine = createLocalPbr({
      ctx, appConfig: { root: runtimeRoot }, localModels: { effectiveDir: () => models },
      platform: 'win32', arch: 'x64', hardwareProbe: { probe: async () => capableHardware },
      runProcess: async (command, args, options = {}) => {
        calls.push({ command, args, options })
        if (args.includes('--probe')) return { cuda: true }
        if (!options.input) return null
        const results = []
        for (const channel of ['normal', 'albedo', 'roughness', 'metallic']) {
          const path = join(options.input.outputDir, `${channel}.png`)
          await writeFile(path, Buffer.from(PNG_B64, 'base64'))
          results.push({ channel, path, width: 1, height: 1 })
        }
        return { results }
      },
    })
    const result = await engine.run({ sourcePath: source, steps: 4 })
    assert.equal(result.results.length, 4)
    assert.ok(result.results.every((item) => item.image_b64 === PNG_B64))
    assert.ok(calls.some((call) => call.args.includes('venv')))
    assert.ok(calls.some((call) => call.args.includes('torch==2.6.0')))
    const inference = calls.find((call) => call.options.input)
    assert.equal(inference.options.input.intrinsicsRevision, LOCAL_PBR.intrinsicsRevision)
    assert.equal(inference.options.input.gpuIndex, 0)
    assert.equal(inference.options.env.PYTHONIOENCODING, 'utf-8', '中文模型目录必须通过 UTF-8 子进程协议传回')
    assert.equal((await readdir(join(runtimeRoot, 'runtime/local-pbr'))).filter((file) => file.startsWith('result-')).length, 0)
    calls.length = 0
    await engine.run({ sourcePath: source, steps: 2 })
    assert.ok(!calls.some((call) => call.args.includes('venv')), '就绪缓存避免重新安装')
    assert.equal(engine.getCachedInfo().prepared, true)
  })

  await check('M4.2f 通用 Runner：深度 / IC-Light 共用环境，缓存标记与 repo 透传正确', async () => {
    const calls = []
    const runtimeRoot = join(root, 'runtime-generic')
    const models = join(root, 'models-generic')
    const engine = createLocalWorkshop({
      ctx,
      appConfig: { root: runtimeRoot },
      localModels: { effectiveDir: () => models },
      platform: 'win32',
      arch: 'x64',
      hardwareProbe: {
        probe: async () => ({
          ...capableHardware,
          localWorkshop: await engine.readInfo(),
        }),
      },
      runProcess: async (command, args, options = {}) => {
        calls.push({ command, args, options })
        if (args.includes('--probe')) return { cuda: true }
        if (!options.input) return null
        const channels = options.input.tool === 'depth' ? ['normal', 'depth'] : ['relit']
        const results = []
        for (const channel of channels) {
          const path = join(options.input.outputDir, `${channel}.png`)
          await writeFile(path, Buffer.from(PNG_B64, 'base64'))
          results.push({ channel, path, width: 1, height: 1 })
        }
        return { results }
      },
    })
    const depth = await engine.run({
      op: 'depth',
      model: 'da3mono-large',
      sourcePath: source,
    })
    assert.deepEqual(depth.results.map((item) => item.channel), ['depth', 'normal'])
    assert.equal(depth.modelId, 'depth-anything/DA3MONO-LARGE')
    const depthInput = calls.find((call) => call.options.input)?.options.input
    assert.equal(depthInput.gpuIndex, 0)
    assert.equal(depthInput.modelRepo, 'depth-anything/DA3MONO-LARGE')
    assert.ok(depthInput.hfHome.includes('workshop-cuda'))
    assert.equal(engine.getCachedInfo().cachedModels['depth:da3mono-large'], true)
    assert.ok(calls.some((call) => call.args.includes('venv')))

    calls.length = 0
    const relit = await engine.run({
      op: 'relight',
      model: 'ic-light',
      sourcePath: source,
      steps: 12,
      options: { prompt: 'soft window light', cfg: 2.5, seed: 7 },
    })
    assert.deepEqual(relit.results.map((item) => item.channel), ['relit'])
    assert.equal(relit.modelId, 'lllyasviel/ic-light')
    assert.equal(calls.some((call) => call.args.includes('venv')), false, '共享环境不应重复安装')
    const relightInput = calls.find((call) => call.options.input)?.options.input
    assert.equal(relightInput.steps, 12)
    assert.equal(relightInput.options.seed, 7)
    assert.equal(engine.getCachedInfo().cachedModels['relight:ic-light'], true)
  })

  await check('M4.2f 运行时依赖与下载源：uv venv 含 --seed、预装深度依赖并透传 hf-mirror', async () => {
    const calls = []
    const runtimeRoot = join(root, 'runtime-deps')
    const models = join(root, 'models-deps')
    const engine = createLocalWorkshop({
      ctx,
      appConfig: { root: runtimeRoot },
      localModels: { effectiveDir: () => models },
      platform: 'win32',
      arch: 'x64',
      getModelSource: () => 'hf-mirror',
      hardwareProbe: { probe: async () => capableHardware },
      runProcess: async (command, args, options = {}) => {
        calls.push({ command, args, options })
        if (args.includes('--probe')) return { cuda: true }
        if (!options.input) return null
        const path = join(options.input.outputDir, 'relit.png')
        await writeFile(path, Buffer.from(PNG_B64, 'base64'))
        return { results: [{ channel: 'relit', path, width: 1, height: 1 }] }
      },
    })
    await engine.run({ op: 'relight', model: 'ic-light', sourcePath: source })
    const venvCall = calls.find((call) => call.args.includes('venv'))
    assert.ok(venvCall.args.includes('--seed'), 'uv venv 必须带 --seed 以提供 python -m pip 兜底')
    const depsCall = calls.find((call) => call.args.includes('einops'))
    assert.ok(depsCall, '必须预装深度运行期依赖')
    for (const pkg of ['torchvision==0.21.0', 'huggingface_hub', 'einops', 'omegaconf', 'addict', 'opencv-python-headless', 'scipy', 'timm', 'kornia']) {
      assert.ok(depsCall.args.includes(pkg), `uv pip install 缺少 ${pkg}`)
    }
    const inferenceCall = calls.find((call) => call.options.input)
    assert.equal(inferenceCall.options.env.AIGC_MODEL_SOURCE, 'hf-mirror')
    assert.equal(inferenceCall.options.env.HF_ENDPOINT, 'https://hf-mirror.com')
    assert.ok(inferenceCall.options.env.AIGC_STUDIO_UV_PATH)
  })

  await check('抠图质量挡本机 CUDA 与队列路由：透传 HF_TOKEN 并落盘 cutout 通道', async () => {
    const calls = []
    const runtimeRoot = join(root, 'runtime-cutout')
    const models = join(root, 'models-cutout')
    const engine = createLocalWorkshop({
      ctx,
      appConfig: { root: runtimeRoot },
      localModels: { effectiveDir: () => models },
      platform: 'win32',
      arch: 'x64',
      getHfToken: () => 'hf_test_token',
      hardwareProbe: { probe: async () => capableHardware },
      runProcess: async (command, args, options = {}) => {
        calls.push({ command, args, options })
        if (args.includes('--probe')) return { cuda: true }
        if (!options.input) return null
        const path = join(options.input.outputDir, 'cutout.png')
        await writeFile(path, Buffer.from(PNG_B64, 'base64'))
        return { results: [{ channel: 'cutout', path, width: 1, height: 1 }] }
      },
    })
    const out = await engine.run({ op: 'remove-bg', model: 'rmbg-2.0', sourcePath: source })
    assert.deepEqual(out.results.map((item) => item.channel), ['cutout'])
    assert.equal(out.modelId, 'briaai/RMBG-2.0')
    assert.equal(engine.getCachedInfo().cachedModels['remove-bg:rmbg-2.0'], true)
    const inferenceCall = calls.find((call) => call.options.input)
    assert.equal(inferenceCall.options.env.HF_TOKEN, 'hf_test_token')

    const queue = new JobQueue({
      ctx,
      session: sessionStub(),
      defaultPreset: 'sdxl-lightning',
      options: {
        getProvider: () => 'local-gpu',
        localWorkshop: engine,
      },
    })
    try {
      const submitted = await submitWorkshopOp(ctx, {
        op: 'remove-bg',
        path: 'outputs/source/01.png',
        model: 'rmbg-2.0',
      }, queue)
      assert.equal(submitted.ok, true, JSON.stringify(submitted))
      const job = await queue.waitFor(submitted.jobId, 5)
      assert.equal(job.status, 'done', JSON.stringify(job.error))
      assert.equal(job.provider, 'local-gpu')
      const meta = JSON.parse(await readFile(join(root, job.output.dir, 'meta.json'), 'utf8'))
      assert.deepEqual(meta.channels.map((channel) => channel.role), ['cutout'])
      assert.equal(meta.workshopTool, 'cutout')
    } finally {
      queue.dispose()
    }
  })

  await check('执行前重新探测资源，资源不足不下载环境、不开始推理', async () => {
    let calls = 0
    const engine = createLocalPbr({ ctx, appConfig: { root }, localModels: { effectiveDir: () => join(root, 'models') },
      hardwareProbe: { probe: async () => ({ ...capableHardware, gpus: [] }) },
      runProcess: async () => { calls += 1 },
    })
    await assert.rejects(engine.run({ sourcePath: source, steps: 4 }), /暂不满足/)
    assert.equal(calls, 0)
  })

  await check('本地 PBR 路由与队列：商业 API 来源下默认本地、四通道落盘与设备出处正确', async () => {
    const queue = new JobQueue({ ctx, session: sessionStub(), defaultPreset: 'sdxl-lightning', options: {
      getProvider: () => 'cloud-api',
      localPbr: { capability: async () => ({ available: true }), run: async () => ({
        device: 'RTX 4060 Ti', modelId: LOCAL_PBR.intrinsicsRepo,
        results: ['normal', 'metallic', 'albedo', 'roughness'].map((channel) => ({ channel, image_b64: PNG_B64, width: 1, height: 1 })),
      }) },
    } })
    try {
      const submitted = await submitWorkshopOp(ctx, { op: 'pbr', path: 'outputs/source/01.png' }, queue)
      assert.equal(submitted.ok, true, JSON.stringify(submitted))
      const job = await queue.waitFor(submitted.jobId, 5)
      assert.equal(job.status, 'done', JSON.stringify(job.error))
      assert.equal(job.provider, 'local-gpu')
      assert.equal(job.device, 'RTX 4060 Ti')
      const metadata = JSON.parse(await readFile(join(root, job.output.dir, 'meta.json'), 'utf8'))
      assert.deepEqual(metadata.channels.map((channel) => channel.role), ['albedo', 'normal', 'roughness', 'metallic'])
      assert.equal(metadata.provider, 'local-gpu')
    } finally { queue.dispose() }
  })

  await check('M4.2f 队列路由：深度与 IC-Light 可本地执行，结果通道与出处正确', async () => {
    const runCalls = []
    const queue = new JobQueue({
      ctx,
      session: sessionStub(),
      defaultPreset: 'sdxl-lightning',
      options: {
        getProvider: () => 'cloud-api',
        localWorkshop: {
          capability: async ({ op, model }) => ({
            localEligible: true,
            recommended: 'local',
            available: true,
            tier: 'hybrid-cuda',
            profileId: `${op}:${model}`,
          }),
          run: async ({ op, model, steps, options }) => {
            runCalls.push({ op, model, steps, options })
            const channels = op === 'depth' ? ['depth', 'normal'] : ['relit']
            return {
              device: 'RTX 4060 Ti',
              modelId: model,
              results: channels.map((channel) => ({
                channel,
                image_b64: PNG_B64,
                width: 1,
                height: 1,
              })),
            }
          },
        },
      },
    })
    try {
      const depth = await submitWorkshopOp(ctx, {
        op: 'depth',
        path: 'outputs/source/01.png',
        model: 'da3mono-large',
      }, queue)
      assert.equal(depth.ok, true, JSON.stringify(depth))
      const depthJob = await queue.waitFor(depth.jobId, 5)
      assert.equal(depthJob.status, 'done', JSON.stringify(depthJob.error))
      assert.equal(depthJob.provider, 'local-gpu')
      const depthMeta = JSON.parse(await readFile(join(root, depthJob.output.dir, 'meta.json'), 'utf8'))
      assert.deepEqual(depthMeta.channels.map((channel) => channel.role), ['depth', 'normal'])
      assert.equal(depthMeta.provider, 'local-gpu')

      const relight = await submitWorkshopOp(ctx, {
        op: 'relight',
        path: 'outputs/source/01.png',
        model: 'ic-light',
        options: { prompt: 'warm window light', steps: 9, cfg: 2.4, seed: 17 },
      }, queue)
      assert.equal(relight.ok, true, JSON.stringify(relight))
      const relightJob = await queue.waitFor(relight.jobId, 5)
      assert.equal(relightJob.status, 'done', JSON.stringify(relightJob.error))
      const relightMeta = JSON.parse(await readFile(join(root, relightJob.output.dir, 'meta.json'), 'utf8'))
      assert.deepEqual(relightMeta.channels.map((channel) => channel.role), ['relit'])
      assert.deepEqual(runCalls.map((call) => call.op), ['depth', 'relight'])
      assert.equal(runCalls[1].steps, 9)
      assert.equal(runCalls[1].options.cfg, 2.4)
    } finally {
      queue.dispose()
    }
  })

  await check('M4.2f 本机不可用时：本地提交在入队前被拒绝，不启动 Python / 不占队列', async () => {
    const queue = new JobQueue({
      ctx,
      session: sessionStub(),
      defaultPreset: 'sdxl-lightning',
      options: {
        getProvider: () => 'kaggle',
        localWorkshop: {
          capability: async () => ({
            localEligible: false,
            available: false,
            recommended: 'cloud',
            reason: '未检测到满足显存门槛的 NVIDIA 显卡',
          }),
          run: async () => { throw new Error('不应执行') },
        },
      },
    })
    try {
      const result = await submitWorkshopOp(ctx, {
        op: 'depth',
        path: 'outputs/source/01.png',
        model: 'da3mono-large',
        execution: 'local',
      }, queue)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'invalid_request')
      assert.match(result.message, /NVIDIA|本机暂不满足/)
      assert.equal(queue.queueStats().pending, 0)
    } finally {
      queue.dispose()
    }
  })

  await check('本地 PBR 取消：结束本地执行器，任务收敛为 cancelled，队列槽位释放', async () => {
    let aborted = false
    const queue = new JobQueue({ ctx, session: sessionStub(), defaultPreset: 'sdxl-lightning', options: {
      getProvider: () => 'cloud-api', localPbr: {
        capability: async () => ({ available: true }),
        run: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true })),
      },
    } })
    try {
      const submitted = await submitWorkshopOp(ctx, { op: 'pbr', path: 'outputs/source/01.png', execution: 'local' }, queue)
      assert.equal(submitted.ok, true, JSON.stringify(submitted))
      // 等执行器拿到取消信号后再取消，避免测试只覆盖读盘前的取消。
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30))
      queue.cancel(submitted.jobId)
      const job = await queue.waitFor(submitted.jobId, 5)
      assert.equal(job.status, 'cancelled')
      assert.equal(aborted, true)
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
      assert.equal(queue.queueStats().running, null)
    } finally { queue.dispose() }
  })
} finally {
  // root 是系统临时目录下 mkdtemp 返回的显式测试目标。
  if (!root.startsWith(join(tmpdir(), 'aigc-local-pbr-'))) throw new Error('测试清理路径越界')
  await rm(root, { recursive: true, force: true })
}

summary()
