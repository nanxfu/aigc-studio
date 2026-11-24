#!/usr/bin/env node
/**
 * M3.4 本机 GPU 运行时离线回归。
 *
 * 覆盖：
 *  A. 配置归一：必填路径、相对路径、环境变量覆盖、非法 JSON；
 *  B. sd-server 参数：磁盘权重 / VAE / 线程 / 空闲 TTL 组合；
 *  C. 协议映射：Host taskPayload → sd-server img_gen；sd-server job → Host /job；
 *  D. 协议桥：Bearer 鉴权、健康载荷、幂等提交、进度与完成结果、能力拒绝。
 *
 * 不启动真实 GPU / 真实 sd-server；真机验收见 test/local-gpu-live.mjs。
 *
 * 运行：node test/local-gpu-runtime.mjs
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { PROTOCOL_VERSION, ROUTES } from '../shared/contract.js'
import {
  normalizeLocalGpuConfig,
  publicLocalGpuView,
  readLocalGpuConfig,
  resolveLocalGpuModel,
  saveLocalGpuConfig,
} from '../server/local-gpu/config.js'
import { buildServerArgs } from '../server/local-gpu/runtime.js'
import {
  buildSdRequest,
  createLocalGpuBridge,
  localGpuHealthPayload,
  mapSdJobToRemote,
} from '../server/local-gpu/bridge.js'
import { createLocalGpuProvider } from '../server/providers/local-gpu.js'
import { createLocalGpuRoutes } from '../server/routes/local-gpu.js'
import { makeRes } from './helpers/fake-context.mjs'

const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? `：${detail}` : ''}`)
  }
}

function payloadOf(overrides = {}) {
  return {
    pipeline: { loader: 'sdxl-gguf' },
    modelId: 'SG161222/RealVisXL_V5.0_Lightning',
    jobId: 'j_abcd1234-01',
    tasks: [{
      name: '01',
      prompt: 'a cozy reading nook, warm lamp light',
      negative_prompt: 'blurry, low quality',
      seed: 42,
      width: 1024,
      height: 1024,
      steps: 4,
      cfg: 1,
    }],
    ...overrides,
  }
}

async function main() {
  console.log('A. 配置归一')
  const dir = await mkdtemp(join(tmpdir(), 'aigc-local-gpu-'))
  try {
    const serverPath = join(dir, 'sd-server.exe')
    const modelPath = join(dir, 'model.gguf')
    const vaePath = join(dir, 'vae.safetensors')
    await writeFile(serverPath, '')
    await writeFile(modelPath, Buffer.alloc(1024))
    await writeFile(vaePath, '')
    const good = normalizeLocalGpuConfig({ serverPath, modelPath, vaePath, threads: 8 }, { baseDir: dir })
    check('完整配置通过', good.ok, good.errors.join(' / '))
    check('线程数归一', good.config.threads === 8, String(good.config.threads))
    check('默认磁盘权重后端', good.config.paramsBackend === 'disk', good.config.paramsBackend)
    check('默认开启 VAE tiling', good.config.vaeTiling === true)

    const relative = normalizeLocalGpuConfig({ serverPath: 'sd-server.exe', modelPath: 'model.gguf' }, { baseDir: dir })
    check('相对路径按配置目录解析', relative.ok && relative.config.modelPath === modelPath, relative.config.modelPath)

    const missing = normalizeLocalGpuConfig({}, { baseDir: dir })
    check('缺路径被拒绝', missing.ok === false && missing.errors.length >= 2, missing.errors.join(' / '))

    const missingFile = normalizeLocalGpuConfig({ serverPath, modelPath: join(dir, 'nope.gguf') }, { baseDir: dir })
    check('不存在的模型被拒绝', missingFile.ok === false, missingFile.errors.join(' / '))

    const envConfig = readLocalGpuConfig({
      root: dir,
      env: {
        AIGC_STUDIO_LOCAL_GPU_SERVER: serverPath,
        AIGC_STUDIO_LOCAL_GPU_MODEL: modelPath,
        AIGC_STUDIO_LOCAL_GPU_THREADS: '6',
      },
    })
    check('环境变量可独立配置', envConfig.ok && envConfig.source === 'env', envConfig.source)
    check('环境变量覆盖线程', envConfig.config.threads === 6, String(envConfig.config.threads))

    await writeFile(join(dir, 'local-gpu.json'), '{ oops')
    const broken = readLocalGpuConfig({ root: dir, env: {} })
    check('损坏的 local-gpu.json 给出可读错误', broken.ok === false && broken.errors[0].includes('合法 JSON'), broken.errors[0])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  console.log('B. sd-server 参数')
  const baseConfig = {
    serverPath: 'D:\\aigc-local\\bin\\sd-server.exe',
    modelPath: 'D:\\aigc-local\\models\\model.gguf',
    vaePath: 'D:\\aigc-local\\models\\vae.safetensors',
    threads: 8,
    idleTimeoutSec: 300,
    paramsBackend: 'disk',
    vaeTiling: true,
    extraArgs: [],
  }
  const args = buildServerArgs(baseConfig, { port: 17860 })
  const argText = args.join(' ')
  check('指定模型与 VAE', argText.includes('-m D:\\aigc-local\\models\\model.gguf') && argText.includes('--vae D:\\aigc-local\\models\\vae.safetensors'))
  check('只监听回环地址', argText.includes('--listen-ip 127.0.0.1') && argText.includes('--listen-port 17860'))
  check('磁盘权重后端', argText.includes('--params-backend disk'))
  check('VAE tiling 与 8 线程', argText.includes('--vae-tiling') && argText.includes('-t 8'))
  check('空闲 300 秒释放权重', argText.includes('--weight-residency-ttl 300'))
  const withExtra = buildServerArgs({ ...baseConfig, extraArgs: ['--flash-attn', 'auto'] }, { port: 1 })
  check('extraArgs 追加到末尾', withExtra.slice(-2).join(' ') === '--flash-attn auto')

  console.log('C. 协议映射')
  const parsed = buildSdRequest(payloadOf())
  check('Host 载荷可映射', parsed.ok === true, parsed.message ?? '')
  check('提示词 / 负向词透传', parsed.request.prompt.includes('reading nook') && parsed.request.negative_prompt.includes('blurry'))
  check('4 步 / CFG 1 / euler_a', parsed.request.sample_params.sample_steps === 4
    && parsed.request.sample_params.guidance.txt_cfg === 1
    && parsed.request.sample_params.sample_method === 'euler_a')
  check('画幅与种子透传', parsed.request.width === 1024 && parsed.request.height === 1024 && parsed.request.seed === 42)
  check('VAE tiling 开启', parsed.request.vae_tiling_params.enabled === true)

  const withReference = buildSdRequest(payloadOf({ reference: { image_b64: 'x' } }))
  check('参考图明确拒绝', withReference.ok === false && withReference.code === 'capability_missing', withReference.message)
  const withTwo = buildSdRequest(payloadOf({ tasks: [payloadOf().tasks[0], payloadOf().tasks[0]] }))
  check('一次多任务明确拒绝', withTwo.ok === false && withTwo.code === 'invalid_request', withTwo.message)

  const done = mapSdJobToRemote({
    status: 'completed',
    result: { images: [{ b64_json: 'aGVsbG8=' }] },
  }, { id: 'j_1-01', steps: 4, width: 1024, height: 1024, modelId: 'model.gguf' })
  check('完成态映射 done', done.status === 'done' && done.results[0].image_b64 === 'aGVsbG8=', done.status)
  check('完成态带步数', done.progress.step === 4 && done.progress.steps === 4)

  const running = mapSdJobToRemote({
    status: 'generating',
    progress: { stage: 'sampling', completed: 2, total: 4, unit: 'steps' },
  }, { id: 'j_1-01', steps: 4 })
  check('生成中带步骤进度', running.status === 'running' && running.progress.step === 2 && running.progress.steps === 4)

  const failed = mapSdJobToRemote({
    status: 'failed',
    error: { message: 'VK_ERROR_OUT_OF_DEVICE_MEMORY' },
  }, { id: 'j_1-01', steps: 4 })
  check('OOM 映射 oom', failed.status === 'failed' && failed.error.code === 'oom', failed.error.code)

  console.log('D. 协议桥')
  let submitted = null
  const fakeRuntime = {
    alive: true,
    info: () => ({
      pid: 1234,
      endpointUrl: 'http://127.0.0.1:1',
      gpu: { name: 'AMD Radeon(TM) 880M Graphics', driverVersion: '32.0.31019.2002' },
      modelId: 'model.gguf',
    }),
    health: async () => ({ ok: true, phase: 'ready' }),
    submit: async (request) => {
      submitted = request
      return { id: 'sd-job-1', status: 'queued' }
    },
    job: async () => ({
      status: 'completed',
      result: { images: [{ b64_json: 'aGVsbG8=' }] },
      progress: { completed: 4, total: 4, unit: 'steps' },
    }),
    logsSince: () => ({ lines: ['line-1', 'line-2'], next: 2 }),
  }
  const bridge = createLocalGpuBridge({
    runtime: fakeRuntime,
    config: { modelPath: 'D:\\aigc-local\\models\\model.gguf', idleTimeoutSec: 300 },
    token: 'test-token',
  })
  const endpointUrl = await bridge.start()
  try {
    const unauthorized = await fetch(`${endpointUrl}/health`)
    check('健康检查需要 Bearer', unauthorized.status === 401, String(unauthorized.status))

    const health = await fetch(`${endpointUrl}/health`, {
      headers: { authorization: 'Bearer test-token' },
    }).then((res) => res.json())
    check('健康载荷协议版本', health.protocol_version === PROTOCOL_VERSION, health.protocol_version)
    check('健康载荷能力位', health.capabilities.result_modes.join(',') === 'inline'
      && health.capabilities.events === false
      && health.capabilities.tools.includes('generate'))
    check('健康载荷硬件名', health.hardware.gpu_name.includes('880M'), health.hardware.gpu_name)

    const submit = await fetch(`${endpointUrl}/generate`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(payloadOf()),
    }).then((res) => res.json())
    check('协议桥接受提交', submit.job_id === 'j_abcd1234-01', submit.job_id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    check('提交到 sd-server 的请求已映射', submitted?.sample_params?.sample_steps === 4, JSON.stringify(submitted?.sample_params ?? {}))

    const repeat = await fetch(`${endpointUrl}/generate`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(payloadOf()),
    }).then((res) => res.json())
    check('同 jobId 幂等返回', repeat.job_id === submit.job_id, repeat.job_id)

    const changed = await fetch(`${endpointUrl}/generate`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(payloadOf({ tasks: [{ ...payloadOf().tasks[0], prompt: 'different' }] })),
    })
    check('同 jobId 不同参数被拒绝', changed.status === 409, String(changed.status))

    const job = await fetch(`${endpointUrl}/job?id=${submit.job_id}`, {
      headers: { authorization: 'Bearer test-token' },
    }).then((res) => res.json())
    check('任务完成映射', job.status === 'done' && job.results[0].image_b64 === 'aGVsbG8=', job.status)

    const logs = await fetch(`${endpointUrl}/logs?since=0`, {
      headers: { authorization: 'Bearer test-token' },
    }).then((res) => res.json())
    check('日志游标', logs.lines.length === 2 && logs.next === 2)

    const reference = await fetch(`${endpointUrl}/generate`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(payloadOf({ jobId: 'j_ref-01', reference: { image_b64: 'x' } })),
    })
    check('桥拒绝参考图', reference.status === 400, String(reference.status))
  } finally {
    await bridge.stop()
  }

  const sampleHealth = localGpuHealthPayload({
    info: { gpu: { name: 'AMD Radeon 880M' } },
    health: { ok: false, phase: 'error', error: 'boom' },
    config: { modelPath: 'model.gguf' },
  })
  check('错误健康态透传 last_error', sampleHealth.phase === 'error' && sampleHealth.last_error === 'boom')

  console.log('E. Provider 配置缺失')
  const provider = createLocalGpuProvider({
    options: {
      getLocalGpuConfig: () => ({
        ok: false,
        errors: ['模型文件不存在'],
        config: {},
        configPath: 'C:\\Users\\test\\AppData\\Roaming\\aigc-studio\\local-gpu.json',
      }),
    },
  })
  try {
    await provider.provision(null, {})
    check('缺配置时 provision 报错', false, '没有抛错')
  } catch (error) {
    check('缺配置时给出 worker_unreachable', error?.code === 'worker_unreachable', error?.code)
    check('错误文案带配置文件路径', String(error?.message).includes('local-gpu.json'), error?.message)
  }

  console.log('F. 多模型映射与可视化配置路由')
  const routeDir = await mkdtemp(join(tmpdir(), 'aigc-local-gpu-route-'))
  try {
    const srv = join(routeDir, 'sd-server.exe')
    const m1 = join(routeDir, 'realvisxl.gguf')
    const m2 = join(routeDir, 'sdxl-lightning.gguf')
    await writeFile(srv, '')
    await writeFile(m1, Buffer.alloc(1024))
    await writeFile(m2, Buffer.alloc(1024))

    const saved = await saveLocalGpuConfig({
      root: routeDir,
      patch: {
        serverPath: srv,
        modelPath: m1,
        paramsBackend: 'disk',
        idleTimeoutSec: 360,
        models: {
          'sdxl-lightning': { modelPath: m2 },
        },
      },
      env: {},
    })
    check('saveLocalGpuConfig 写入并校验通过', saved.ok && saved.result.ok, saved.result?.errors?.join('; '))
    const resolvedDefault = resolveLocalGpuModel(saved.result.config, 'realvisxl-lightning')
    const resolvedMapped = resolveLocalGpuModel(saved.result.config, 'sdxl-lightning')
    const resolvedUnknown = resolveLocalGpuModel(saved.result.config, 'flux2-klein-9b')
    check('resolveLocalGpuModel 默认与显式映射解析正确',
      resolvedDefault?.modelPath === m1 && resolvedMapped?.modelPath === m2 && resolvedUnknown === null)
    const pub = publicLocalGpuView(saved.result)
    check('publicLocalGpuView 汇总已配置预设列表',
      pub.configuredPresets.includes('realvisxl-lightning') && pub.configuredPresets.includes('sdxl-lightning'))

    // Bridge 多模型校验与热切换回调
    let switchedTo = ''
    const multiBridge = createLocalGpuBridge({
      runtime: fakeRuntime,
      config: saved.result.config,
      token: 'multi-tok',
      onEnsureModel: async (_id, resolved) => {
        switchedTo = resolved.modelPath
        return { runtime: fakeRuntime, config: { ...saved.result.config, modelPath: resolved.modelPath } }
      },
    })
    const multiUrl = await multiBridge.start()
    try {
      const blockedRes = await fetch(`${multiUrl}/generate`, {
        method: 'POST',
        headers: { authorization: 'Bearer multi-tok', 'content-type': 'application/json' },
        body: JSON.stringify(payloadOf({ jobId: 'j_unmapped', presetId: 'flux2-klein-9b' })),
      })
      check('桥拒绝未映射的 presetId', blockedRes.status === 400, String(blockedRes.status))

      const switchRes = await fetch(`${multiUrl}/generate`, {
        method: 'POST',
        headers: { authorization: 'Bearer multi-tok', 'content-type': 'application/json' },
        body: JSON.stringify(payloadOf({ jobId: 'j_mapped', presetId: 'sdxl-lightning' })),
      })
      check('已映射 presetId 触发权重切换并提交成功', switchRes.status === 202 && switchedTo === m2, switchedTo)
    } finally {
      await multiBridge.stop()
    }

    // HTTP 路由：GET /api/local-gpu/config & POST /api/local-gpu/probe
    const routes = createLocalGpuRoutes({
      appConfig: { root: routeDir, whenReady: async () => {} },
      probeImpl: async (cfg) => ({ ok: true, errors: [], warnings: [], source: 'sd-server', gpu: { name: 'Mock 880M' }, config: cfg }),
    })
    const cfgRoute = routes.find((r) => r.path === ROUTES.localGpuConfig.path)
    const getRes = makeRes()
    await cfgRoute.handler({ method: 'GET' }, getRes)
    check('GET /api/local-gpu/config 返回脱敏配置', getRes.state.code === 200 && getRes.state.body.config.ok === true)

    const probeRoute = routes.find((r) => r.path === ROUTES.localGpuProbe.path)
    const probeRes = makeRes()
    await probeRoute.handler(
      Readable.from([Buffer.from(JSON.stringify({ serverPath: srv, modelPath: m1 }), 'utf8')]),
      probeRes,
    )
    check('POST /api/local-gpu/probe 返回探测结果', probeRes.state.code === 200 && probeRes.state.body.probe.gpu.name === 'Mock 880M')
  } finally {
    await rm(routeDir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.log(`\n失败 ${failures.length} 项：${failures.join(' / ')}`)
    process.exitCode = 1
  } else {
    console.log('\n全部通过')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

