import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluateLocalPbr, LOCAL_PBR, workshopCloudProvider } from '../shared/workshop-compute.js'
import { createLocalPbr, runPbrProcess } from '../server/local-pbr.js'
import { JobQueue } from '../server/jobs/queue.js'
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

  await check('云端 PBR 使用 Worker 来源；商业 API 与 Vulkan 回退到 Kaggle，不改变生图配置', async () => {
    for (const provider of ['kaggle', 'colab', 'salad', 'private-worker']) assert.equal(workshopCloudProvider(provider), provider)
    for (const provider of ['cloud-api', 'local-gpu']) assert.equal(workshopCloudProvider(provider), 'kaggle')
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
    assert.equal((await readdir(join(runtimeRoot, 'runtime/local-pbr'))).filter((file) => file.startsWith('result-')).length, 0)
    calls.length = 0
    await engine.run({ sourcePath: source, steps: 2 })
    assert.ok(!calls.some((call) => call.args.includes('venv')), '就绪缓存避免重新安装')
    assert.equal(engine.getCachedInfo().prepared, true)
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
