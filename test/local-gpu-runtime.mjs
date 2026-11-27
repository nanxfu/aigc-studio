#!/usr/bin/env node
import assert from 'node:assert/strict'
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

import { mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'

import { LIMITS, PROTOCOL_VERSION, ROUTES } from '../shared/contract.js'
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
import { createLocalGpuSetup } from '../server/local-gpu/setup.js'
import { imageSizeOf, normalizeMaskImage, __test as maskCodec } from '../server/local-gpu/mask.js'
import { createMaskPng, createTestPng } from './helpers/image-fixture.mjs'
import {
  LOCAL_GPU_ENGINE,
  LOCAL_GPU_ENGINE_MARKER,
  LOCAL_GPU_CUDA_ENGINE,
  LOCAL_GPU_MODEL_ASSETS,
  LOCAL_GPU_PRESET,
} from '../shared/local-gpu-assets.js'
import { pickPreferredDevice } from '../server/local-gpu/probe.js'
import { ensureLocalLora, localLoraFilename } from '../server/local-gpu/loras.js'
import { createLocalGpuRoutes } from '../server/routes/local-gpu.js'
import { makeRes } from './helpers/fake-context.mjs'

const failures = []

/** 1×1 PNG：桥只做魔数 / 体积判定，不真正解码，用最小合法 PNG 足够。 */
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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

async function until(label, predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`${label}超时`)
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
    check('默认按硬件自动选择权重后端', good.config.paramsBackend === 'auto', good.config.paramsBackend)
    check('默认按显存自动决定 VAE tiling', good.config.vaeTiling === null, String(good.config.vaeTiling))

    const relative = normalizeLocalGpuConfig({ serverPath: 'sd-server.exe', modelPath: 'model.gguf' }, { baseDir: dir })
    check('相对路径按配置目录解析', relative.ok && relative.config.modelPath === modelPath, relative.config.modelPath)

    const missing = normalizeLocalGpuConfig({}, { baseDir: dir })
    check('缺引擎时算力来源未就绪，但不要求模型文件', missing.ok === false && !missing.errors.some((item) => item.includes('GGUF')), missing.errors.join(' / '))

    const engineOnly = normalizeLocalGpuConfig({ serverPath }, { baseDir: dir })
    check('只有引擎也可作为已配置算力来源', engineOnly.ok && engineOnly.engineReady && !engineOnly.config.modelPath)

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

  console.log('A2. 一键准备流程')
  const setupDir = await mkdtemp(join(tmpdir(), 'aigc-local-gpu-setup-'))
  try {
    const appConfig = { root: setupDir }
    const modelsDir = join(setupDir, 'models')
    const engineDir = join(setupDir, 'engine')
    await mkdir(engineDir, { recursive: true })
    for (const file of ['sd-server.exe', 'ggml-base.dll', 'ggml-vulkan.dll', 'ggml.dll', 'stable-diffusion.dll', 'stable-diffusion.cpp.txt']) {
      await writeFile(join(engineDir, file), 'engine')
    }
    await writeFile(join(engineDir, LOCAL_GPU_ENGINE_MARKER), LOCAL_GPU_ENGINE.sha256)
    const assets = [
      { key: 'modelPath', file: 'model.gguf', url: 'https://example.test/model', payload: Buffer.from('fixture model') },
      { key: 'vaePath', file: 'vae.safetensors', url: 'https://example.test/vae', payload: Buffer.from('fixture vae') },
    ].map((asset) => ({ ...asset, bytes: asset.payload.length, sha256: createHash('sha256').update(asset.payload).digest('hex') }))
    const fluxAsset = {
      key: 'modelPath',
      file: 'flux2.gguf',
      url: 'https://example.test/flux2',
      payload: Buffer.from('fixture flux'),
    }
    fluxAsset.bytes = fluxAsset.payload.length
    fluxAsset.sha256 = createHash('sha256').update(fluxAsset.payload).digest('hex')
    const allDownloadAssets = [...assets, fluxAsset]
    const modelAssets = {
      ...LOCAL_GPU_MODEL_ASSETS,
      [LOCAL_GPU_PRESET]: {
        ...LOCAL_GPU_MODEL_ASSETS[LOCAL_GPU_PRESET],
        available: true,
        files: assets.map(({ payload, ...asset }) => asset),
        bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
      },
      'flux2-klein-4b': {
        ...LOCAL_GPU_MODEL_ASSETS['flux2-klein-4b'],
        available: true,
        files: [{ key: fluxAsset.key, file: fluxAsset.file, url: fluxAsset.url, bytes: fluxAsset.bytes, sha256: fluxAsset.sha256 }],
        bytes: fluxAsset.bytes,
      },
    }
    const downloaded = []
    const download = async (_ctx, url, options) => {
      const asset = allDownloadAssets.find((item) => item.url === url)
      assert.ok(asset)
      const partial = `${options.destPath}.transfer`
      const previous = await readFile(options.destPath).catch(() => Buffer.alloc(0))
      const response = Buffer.concat([previous, asset.payload.subarray(previous.length)])
      const output = createWriteStream(partial)
      output.end(response)
      await once(output, 'finish')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(partial)) hash.update(chunk)
      await rename(partial, options.destPath)
      options.onProgress?.(response.length)
      downloaded.push(asset.file)
      return { bytes: response.length, sha256: hash.digest('hex') }
    }
    const dependencies = {
      appConfig,
      log: { warn: (...args) => console.log('[setup-test]', ...args) },
      localModels: { effectiveDir: () => modelsDir },
      env: { AIGC_STUDIO_BUNDLED_SD_DIR: engineDir },
      platform: 'win32',
      arch: 'x64',
      modelAssets,
      detectNvidia: async () => false,
      download,
      diskInfo: async () => ({ bavail: 10, bsize: 1024 * 1024 * 1024 }),
      prepareEngine: async (target) => {
        await mkdir(target, { recursive: true })
        for (const file of ['sd-server.exe', 'ggml-base.dll', 'ggml-vulkan.dll', 'ggml.dll', 'stable-diffusion.dll', 'stable-diffusion.cpp.txt']) {
          await writeFile(join(target, file), 'fixture')
        }
        await writeFile(join(target, LOCAL_GPU_ENGINE_MARKER), LOCAL_GPU_ENGINE.sha256)
      },
      listDevices: async () => ({ ok: true, devices: [{ id: 'Vulkan0', name: 'Mock GPU', backend: 'vulkan' }] }),
    }
    const setup = createLocalGpuSetup(dependencies)
    const snapshot = await setup.start(LOCAL_GPU_PRESET)
    check('显示可用状态与完整测试下载量', snapshot.supported && snapshot.totalBytes === assets.reduce((sum, asset) => sum + asset.bytes, 0), JSON.stringify(snapshot))
    await until('本机 GPU 模型下载并校验完成', async () => (await setup.snapshot()).phase === 'ready')
    check('模型与 VAE 都成功下载', downloaded.length === 2, downloaded.join(', '))
    const saved = readLocalGpuConfig({ root: setupDir, env: dependencies.env })
    check('就绪后自动保存本机 GPU 配置', saved.ok && saved.config.defaultPreset === 'realvisxl-lightning')
    const restartedSetup = createLocalGpuSetup(dependencies)
    check('应用重启后通过校验状态恢复已完成的准备', (await restartedSetup.snapshot()).phase === 'ready')
    await setup.start('flux2-klein-4b')
    await until('第二个模型准备与配置写入完成', async () => (await setup.snapshot()).phase === 'ready')
    const multiSaved = readLocalGpuConfig({ root: setupDir, env: dependencies.env })
    check(
      '多个模型独立写入映射且不覆盖旧模型',
      Boolean(multiSaved.config.models[LOCAL_GPU_PRESET])
        && Boolean(multiSaved.config.models['flux2-klein-4b'])
        && multiSaved.config.defaultPreset === 'flux2-klein-4b',
      JSON.stringify(multiSaved.config.models),
    )

    const limitedRoot = await mkdtemp(join(tmpdir(), 'aigc-local-gpu-no-space-'))
    const limited = createLocalGpuSetup({
      ...dependencies,
      appConfig: { root: limitedRoot },
      localModels: { effectiveDir: () => join(limitedRoot, 'models') },
      diskInfo: async () => ({ bavail: 0, bsize: 1024 }),
      prepareEngine: async () => {
        await writeFile(join(limitedRoot, LOCAL_GPU_ENGINE_MARKER), 'engine')
      },
    })
    await limited.start(LOCAL_GPU_PRESET)
    await until('空间不足提前终止下载', async () => (await limited.snapshot()).phase === 'error')
    check('磁盘不足时不触碰引擎或下载', downloaded.length === 3, String(downloaded.length))
    await rm(limitedRoot, { recursive: true, force: true })

    const cancelDir = await mkdtemp(join(tmpdir(), 'aigc-local-gpu-cancel-'))
    let releaseDownload
    const slowDownload = new Promise((resolve) => { releaseDownload = resolve })
    const cancelable = createLocalGpuSetup({
      ...dependencies,
      appConfig: { root: cancelDir },
      localModels: { effectiveDir: () => join(cancelDir, 'models') },
      prepareEngine: async (_target, { onProgress }) => { onProgress?.(LOCAL_GPU_ENGINE.bytes) },
      download: async (_ctx, _url, { signal }) => new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason)
        if (signal.aborted) return abort()
        signal.addEventListener('abort', abort, { once: true })
        slowDownload.then(resolve, reject)
      }),
    })
    await cancelable.start(LOCAL_GPU_PRESET)
    await until('下载进入可取消状态', async () => (await cancelable.snapshot()).phase === 'downloading')
    await cancelable.cancel()
    check('取消保留可恢复状态', (await cancelable.snapshot()).phase === 'idle')
    releaseDownload?.()
    await rm(cancelDir, { recursive: true, force: true })

    const cudaRoot = await mkdtemp(join(tmpdir(), 'aigc-local-gpu-cuda-'))
    try {
      const prepared = []
      const cudaSetup = createLocalGpuSetup({
        appConfig: { root: cudaRoot },
        log: { warn: (...args) => console.log('[setup-cuda-test]', ...args) },
        localModels: { effectiveDir: () => join(cudaRoot, 'models') },
        env: {},
        platform: 'win32',
        arch: 'x64',
        detectNvidia: async () => true,
        diskInfo: async () => ({ bavail: 10, bsize: 1024 * 1024 * 1024 }),
        prepareEngine: async (target, { backend }) => {
          prepared.push({ target, backend })
          await mkdir(target, { recursive: true })
          for (const file of ['sd-server.exe', 'ggml.dll', 'ggml-cuda.dll', 'stable-diffusion.dll']) {
            await writeFile(join(target, file), 'cuda-engine')
          }
          await writeFile(join(target, LOCAL_GPU_ENGINE_MARKER), LOCAL_GPU_CUDA_ENGINE.sha256)
        },
        listDevices: async () => ({
          ok: true,
          devices: [{ id: 'CUDA0', name: 'NVIDIA GeForce RTX 4060', backend: 'cuda', isIntegrated: false }],
        }),
      })
      const first = await cudaSetup.start()
      check('检测到 N 卡时按需选择 CUDA 引擎', first.engineBackend === 'cuda' && first.phase !== 'error', JSON.stringify(first))
      await until('CUDA 引擎准备完成', async () => (await cudaSetup.snapshot()).phase === 'ready')
      check(
        'CUDA 引擎安装到独立目录并保存后端',
        prepared[0]?.backend === 'cuda'
          && prepared[0]?.target.includes('engine-cuda')
          && readLocalGpuConfig({ root: cudaRoot, env: {} }).config.engineBackend === 'cuda',
        JSON.stringify(prepared),
      )

      const bundledEmptyRoot = await mkdtemp(join(tmpdir(), 'aigc-local-gpu-bundled-'))
      try {
        const bundledRead = readLocalGpuConfig({ root: bundledEmptyRoot, env: { AIGC_STUDIO_BUNDLED_SD_DIR: engineDir } })
        check(
          '打包版首次无 local-gpu.json 时自动识别内置 Vulkan 引擎就绪',
          bundledRead.ok === true && bundledRead.engineReady === true && bundledRead.config.useBundledEngine === true,
        )
        const cudaDespiteBundled = createLocalGpuSetup({
          appConfig: { root: bundledEmptyRoot },
          localModels: { effectiveDir: () => join(bundledEmptyRoot, 'models') },
          env: { AIGC_STUDIO_BUNDLED_SD_DIR: engineDir },
          platform: 'win32',
          arch: 'x64',
          detectNvidia: async () => true,
        })
        const cudaSnap = await cudaDespiteBundled.snapshot()
        check(
          '打包版检测到 N 卡时仍允许按需准备 CUDA 引擎',
          cudaSnap.engineBackend === 'cuda' && cudaSnap.supported === true,
          JSON.stringify({ backend: cudaSnap.engineBackend, supported: cudaSnap.supported }),
        )
      } finally {
        await rm(bundledEmptyRoot, { recursive: true, force: true })
      }
    } finally {
      await rm(cudaRoot, { recursive: true, force: true })
    }
  } finally {
    await rm(setupDir, { recursive: true, force: true })
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

  const integratedArgs = buildServerArgs({ ...baseConfig, paramsBackend: 'auto', vaeTiling: null }, {
    port: 1,
    device: { id: 'Vulkan0', name: 'AMD Radeon 880M', backend: 'vulkan', isIntegrated: true },
    hardware: { vramMb: 10_240, isIntegrated: true },
  })
  check(
    '核显设备透传 + 磁盘换页 + VAE 分块',
    integratedArgs.includes('--backend') && integratedArgs.includes('Vulkan0')
      && integratedArgs.join(' ').includes('--params-backend disk')
      && integratedArgs.includes('--vae-tiling'),
    integratedArgs.join(' '),
  )

  const rtx4060Args = buildServerArgs({ ...baseConfig, paramsBackend: 'auto', vaeTiling: null }, {
    port: 1,
    device: { id: 'CUDA0', name: 'NVIDIA GeForce RTX 4060', backend: 'cuda', isIntegrated: false },
    hardware: { vramMb: 8192, isIntegrated: false },
  })
  check(
    '8G N 卡走 CPU offload 且保留 VAE 分块',
    rtx4060Args.join(' ').includes('--params-backend cpu')
      && rtx4060Args.includes('--offload-to-cpu')
      && rtx4060Args.includes('--vae-tiling')
      && rtx4060Args.join(' ').includes('--backend CUDA0'),
    rtx4060Args.join(' '),
  )

  const rtx4090Args = buildServerArgs({ ...baseConfig, paramsBackend: 'auto', vaeTiling: null }, {
    port: 1,
    device: { id: 'CUDA0', name: 'NVIDIA GeForce RTX 4090', backend: 'cuda', isIntegrated: false },
    hardware: { vramMb: 24576, isIntegrated: false },
  })
  check(
    '24G 独显关闭磁盘换页与 VAE 分块',
    !rtx4090Args.includes('--params-backend')
      && !rtx4090Args.includes('--vae-tiling')
      && !rtx4090Args.includes('--offload-to-cpu'),
    rtx4090Args.join(' '),
  )

  const preferred = pickPreferredDevice([
    { id: 'Vulkan0', name: 'Intel Iris Xe Graphics', backend: 'vulkan', isIntegrated: true, vramMb: 4096 },
    { id: 'Vulkan1', name: 'AMD Radeon RX 7600', backend: 'vulkan', isIntegrated: false, vramMb: 8192 },
    { id: 'CPU', name: 'CPU', backend: 'cpu' },
  ])
  check('双显卡选择独显而非核显', preferred?.id === 'Vulkan1', preferred?.id)

  const splitArgs = buildServerArgs({
    ...baseConfig,
    splitDiffusion: true,
    llmPath: 'D:\\aigc-local\\models\\Qwen3-4B-Q4_K_M.gguf',
    paramsBackend: 'auto',
    vaeTiling: null,
  }, {
    port: 1,
    device: { id: 'CUDA0', name: 'NVIDIA GeForce RTX 4090', backend: 'cuda', isIntegrated: false },
    hardware: { vramMb: 24576, isIntegrated: false },
  })
  check(
    '分离式 DiT 模型下发 --diffusion-model / --llm / --vae / --diffusion-fa 且不用 -m',
    splitArgs.includes('--diffusion-model')
      && !splitArgs.includes('-m')
      && splitArgs.includes('--llm')
      && splitArgs.includes('--vae')
      && splitArgs.includes('--diffusion-fa'),
    splitArgs.join(' '),
  )
  check(
    'FLUX.2 Klein 4B 与 Z-Image Turbo 资产表均包含 LLM 与 VAE 组件',
    LOCAL_GPU_MODEL_ASSETS['flux2-klein-4b'].files.some((f) => f.key === 'llmPath')
      && LOCAL_GPU_MODEL_ASSETS['flux2-klein-4b'].files.some((f) => f.key === 'vaePath')
      && LOCAL_GPU_MODEL_ASSETS['z-image-turbo'].files.some((f) => f.key === 'llmPath')
      && LOCAL_GPU_MODEL_ASSETS['z-image-turbo'].files.some((f) => f.key === 'vaePath'),
  )

  console.log('C. 协议映射')
  const parsed = buildSdRequest(payloadOf(), {
    sampling: { sampleMethod: 'euler_a', scheduler: 'discrete' },
  })
  check('Host 载荷可映射', parsed.ok === true, parsed.message ?? '')
  check('提示词 / 负向词透传', parsed.request.prompt.includes('reading nook') && parsed.request.negative_prompt.includes('blurry'))
  check('4 步 / CFG 1 / euler_a', parsed.request.sample_params.sample_steps === 4
    && parsed.request.sample_params.guidance.txt_cfg === 1
    && parsed.request.sample_params.sample_method === 'euler_a')
  check('画幅与种子透传', parsed.request.width === 1024 && parsed.request.height === 1024 && parsed.request.seed === 42)
  check('VAE tiling 开启', parsed.request.vae_tiling_params.enabled === true)
  const fluxRequest = buildSdRequest(payloadOf(), {
    sampling: { sampleMethod: 'euler', scheduler: 'flux2' },
    vaeTiling: false,
  })
  check(
    '模型专用采样参数与高显存 VAE 策略透传',
    fluxRequest.request.sample_params.sample_method === 'euler'
      && fluxRequest.request.sample_params.scheduler === 'flux2'
      && fluxRequest.request.vae_tiling_params.enabled === false,
  )

  const withTwo = buildSdRequest(payloadOf({ tasks: [payloadOf().tasks[0], payloadOf().tasks[0]] }))
  check('一次多任务明确拒绝', withTwo.ok === false && withTwo.code === 'invalid_request', withTwo.message)

  // 图像编辑：图生图（init_image + strength）与局部重绘（再加 mask_image）。
  const pngB64 = TINY_PNG_B64
  const img2img = buildSdRequest(payloadOf({ reference: { image_b64: pngB64, strength: 0.6 } }))
  check(
    '图生图映射到 init_image + strength',
    img2img.ok === true && img2img.request.init_image === pngB64 && img2img.request.strength === 0.6,
    JSON.stringify({ ok: img2img.ok, strength: img2img.request?.strength }),
  )
  check('图生图不带蒙版字段', img2img.ok === true && img2img.request.mask_image === undefined)
  const clampedStrength = buildSdRequest(payloadOf({ reference: { image_b64: pngB64, strength: 1.2 } }))
  check(
    '整图重绘强度按契约钳制到 0.9',
    clampedStrength.ok === true && clampedStrength.request.strength === LIMITS.strength.max,
    String(clampedStrength.request?.strength),
  )
  const dataUrlRef = buildSdRequest(payloadOf({ reference: { image_b64: `data:image/png;base64,${pngB64}`, strength: 0.5 } }))
  check('data URL 前缀被剥掉', dataUrlRef.ok === true && dataUrlRef.request.init_image === pngB64)
  const inpaint = buildSdRequest(payloadOf({
    reference: { image_b64: pngB64, mask_b64: pngB64, strength: 1.2 },
  }))
  check(
    '局部重绘映射 mask_image 且强度放宽到 1.0',
    inpaint.ok === true && inpaint.request.mask_image === pngB64 && inpaint.request.strength === LIMITS.strength.inpaintMax,
    JSON.stringify({ mask: Boolean(inpaint.request?.mask_image), strength: inpaint.request?.strength }),
  )
  const defaultStrength = buildSdRequest(payloadOf({ reference: { image_b64: pngB64 } }))
  check('缺省强度取契约默认值', defaultStrength.ok === true && defaultStrength.request.strength === LIMITS.strength.default)
  const nullStrength = buildSdRequest(payloadOf({ reference: { image_b64: pngB64, strength: null } }))
  check('null 强度不误作 0、回落默认值', nullStrength.ok === true && nullStrength.request.strength === LIMITS.strength.default)
  const badImage = buildSdRequest(payloadOf({ reference: { image_b64: 'x' } }))
  check(
    '非 PNG / JPEG 参考图被拒绝',
    badImage.ok === false && badImage.code === 'invalid_request',
    badImage.message,
  )
  const nativeRefs = buildSdRequest(payloadOf({ referenceImages: [{ image_b64: pngB64 }] }))
  check(
    '模型原生参考图明确拒绝',
    nativeRefs.ok === false && nativeRefs.code === 'capability_missing',
    nativeRefs.message,
  )
  const upscaleBridge = buildSdRequest({ tool: 'upscale', jobId: 'j_up-01', reference: { image_b64: pngB64 } })
  check(
    '超分请求在桥入口明确拒绝',
    upscaleBridge.ok === false && upscaleBridge.code === 'capability_missing',
    upscaleBridge.message,
  )

  // 蒙版尺寸归一：sd.cpp 要求 mask_image 与 init_image 同宽高，客户端涂抹画布长边上限 1024。
  const initPng = createTestPng(40, 24)
  const maskPng = createMaskPng(64, 64)
  const initSize = imageSizeOf(initPng)
  check('PNG 宽高读取', initSize?.width === 40 && initSize?.height === 24, JSON.stringify(initSize))
  const maskSize = imageSizeOf(maskPng)
  check('蒙版宽高读取', maskSize?.width === 64 && maskSize?.height === 64, JSON.stringify(maskSize))
  const sameMask = normalizeMaskImage(maskPng, { width: 64, height: 64 })
  check('同尺寸蒙版原样透传', sameMask.ok === true && sameMask.resized === false && sameMask.buffer.equals(maskPng))
  const resizedMask = normalizeMaskImage(maskPng, { width: 40, height: 24 })
  const resizedHeader = resizedMask.ok ? maskCodec.pngHeaderOf(resizedMask.buffer) : null
  check(
    '蒙版缩放到目标尺寸并归一为 1 通道',
    resizedMask.ok === true
      && resizedMask.resized === true
      && resizedHeader?.width === 40
      && resizedHeader?.height === 24
      && resizedHeader?.colorType === 0,
    JSON.stringify(resizedHeader),
  )
  const decodedMask = resizedMask.ok ? maskCodec.decodeGrayPng(resizedMask.buffer) : null
  check(
    '缩放后白块仍在中央、边缘为黑',
    decodedMask?.ok === true
      && decodedMask.gray[Math.floor(24 / 2) * 40 + Math.floor(40 / 2)] === 255
      && decodedMask.gray[0] === 0 && decodedMask.gray[39] === 0,
    JSON.stringify({ center: decodedMask?.ok ? decodedMask.gray[12 * 40 + 20] : null }),
  )
  const jpegHeader = (() => {
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
    const sof = Buffer.alloc(19)
    sof[0] = 0xff
    sof[1] = 0xc0
    sof.writeUInt16BE(17, 2)
    sof[4] = 8
    sof.writeUInt16BE(24, 5)
    sof.writeUInt16BE(40, 7)
    sof[9] = 3
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), app0, Buffer.from([0xff, 0xff]), sof, Buffer.from([0xff, 0xd9])])
  })()
  const jpegSize = imageSizeOf(jpegHeader)
  check('JPEG 宽高读取（含 0xFF 填充字节）', jpegSize?.format === 'jpeg' && jpegSize.width === 40 && jpegSize.height === 24, JSON.stringify(jpegSize))
  const badMask = normalizeMaskImage(Buffer.from('not a png'), { width: 40, height: 24 })
  check('非 PNG 蒙版明确拒绝', badMask.ok === false && badMask.message.includes('PNG'), badMask.message)

  // 端到端映射：底图 40×24 + 蒙版 64² → 桥下发的 mask_image 已缩放到 40×24。
  const scaledRequest = buildSdRequest(payloadOf({
    reference: {
      image_b64: initPng.toString('base64'),
      mask_b64: maskPng.toString('base64'),
      strength: 0.9,
    },
  }))
  const scaledMaskHeader = scaledRequest.ok
    ? maskCodec.pngHeaderOf(Buffer.from(scaledRequest.request.mask_image, 'base64'))
    : null
  check(
    '桥在提交前把蒙版对齐到底图',
    scaledRequest.ok === true
      && scaledMaskHeader?.width === 40
      && scaledMaskHeader?.height === 24,
    JSON.stringify(scaledMaskHeader),
  )
  const jpegRequest = buildSdRequest(payloadOf({
    reference: { image_b64: jpegHeader.toString('base64'), mask_b64: maskPng.toString('base64'), strength: 0.9 },
  }))
  check(
    'JPEG 底图同样按头部宽高对齐蒙版',
    jpegRequest.ok === true
      && maskCodec.pngHeaderOf(Buffer.from(jpegRequest.request.mask_image, 'base64'))?.width === 40,
    jpegRequest.message ?? '',
  )

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
    check(
      '健康载荷声明局部重绘可用、原生参考图不可用',
      health.capabilities.inpaint === true && health.capabilities.reference === false,
      JSON.stringify({ inpaint: health.capabilities.inpaint, reference: health.capabilities.reference }),
    )
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
      body: JSON.stringify(payloadOf({
        jobId: 'j_ref-01',
        reference: { image_b64: TINY_PNG_B64, mask_b64: TINY_PNG_B64, strength: 0.9 },
      })),
    })
    check('桥接受局部重绘载荷', reference.status === 202, String(reference.status))
    await new Promise((resolve) => setTimeout(resolve, 30))
    check(
      '局部重绘请求带蒙版与底图',
      submitted?.init_image === TINY_PNG_B64
        && submitted?.mask_image === TINY_PNG_B64
        && submitted?.strength === 0.9,
      JSON.stringify({ init: Boolean(submitted?.init_image), mask: Boolean(submitted?.mask_image), strength: submitted?.strength }),
    )

    const nativeReference = await fetch(`${endpointUrl}/generate`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(payloadOf({ jobId: 'j_ref-02', referenceImages: [{ image_b64: TINY_PNG_B64 }] })),
    })
    check('桥拒绝模型原生参考图', nativeReference.status === 400, String(nativeReference.status))
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

    // 服务已启动后再下载的新模型：resolveModel 每次读最新配置，不能沿用启动时快照。
    const latePath = join(routeDir, 'late-model.gguf')
    await writeFile(latePath, Buffer.alloc(1024))
    let lateSwitched = ''
    const lateBridge = createLocalGpuBridge({
      runtime: fakeRuntime,
      config: saved.result.config,
      token: 'late-tok',
      resolveModel: (id) => (id === 'z-image-turbo'
        ? { presetId: id, modelPath: latePath, vaePath: '' }
        : resolveLocalGpuModel(saved.result.config, id)),
      onEnsureModel: async (_id, resolved) => {
        lateSwitched = resolved.modelPath
        return { runtime: fakeRuntime, config: { ...saved.result.config, modelPath: resolved.modelPath } }
      },
    })
    const lateUrl = await lateBridge.start()
    try {
      const lateRes = await fetch(`${lateUrl}/generate`, {
        method: 'POST',
        headers: { authorization: 'Bearer late-tok', 'content-type': 'application/json' },
        body: JSON.stringify(payloadOf({ jobId: 'j_late', presetId: 'z-image-turbo' })),
      })
      check('运行中新增模型按最新配置解析并热切换', lateRes.status === 202 && lateSwitched === latePath, lateSwitched)
    } finally {
      await lateBridge.stop()
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

  console.log('G. 本机 GPU LoRA 通道与结构化载荷')
  const loraDir = await mkdtemp(join(tmpdir(), 'aigc-local-gpu-lora-'))
  try {
    const loraArgs = buildServerArgs({
      serverPath: 'sd-server.exe',
      modelPath: join(loraDir, 'flux2.gguf'),
      loraDir,
      splitDiffusion: true,
    }, { port: 8188 })
    check('buildServerArgs 传入 --lora-model-dir 与 --lora-apply-mode auto',
      loraArgs.includes('--lora-model-dir') && loraArgs.includes(loraDir) && loraArgs.includes('--lora-apply-mode') && loraArgs.includes('auto'))

    const unreadyLora = buildSdRequest(payloadOf({
      pipeline: { loader: 'flux2', lora: { repo: 'owner/repo', weight: 'style.safetensors', scale: 0.7 } },
    }))
    check('LoRA 未就绪时拒绝而非静默丢弃', unreadyLora.ok === false && unreadyLora.code === 'capability_missing')

    const readyLora = buildSdRequest(payloadOf({
      pipeline: { loader: 'flux2', lora: { repo: 'owner/repo', weight: 'style.safetensors', scale: 0.7 } },
    }), { loraPath: 'owner_repo__style.safetensors' })
    check('buildSdRequest 生成结构化 lora 数组且不改 prompt',
      readyLora.ok
      && Array.isArray(readyLora.request.lora)
      && readyLora.request.lora[0].path === 'owner_repo__style.safetensors'
      && readyLora.request.lora[0].multiplier === 0.7
      && !readyLora.request.prompt.includes('<lora:'))

    const fakeBytes = Buffer.from('lora-fixture-bytes')
    const downloaded = await ensureLocalLora(
      { repo: 'owner/repo', weight: 'style.safetensors', scale: 0.7 },
      {
        loraDir,
        download: async (_ctx, _url, opts) => {
          await writeFile(opts.destPath, fakeBytes)
          return { bytes: fakeBytes.length, sha256: createHash('sha256').update(fakeBytes).digest('hex') }
        },
      },
    )
    check('ensureLocalLora 下载落盘并生成安全相对路径',
      downloaded.downloaded === true && downloaded.path === localLoraFilename({ repo: 'owner/repo', weight: 'style.safetensors' }))
    const cached = await ensureLocalLora(
      { repo: 'owner/repo', weight: 'style.safetensors', scale: 0.7 },
      { loraDir, download: async () => { throw new Error('should not download twice') } },
    )
    check('ensureLocalLora 命中已有文件不重复下载', cached.downloaded === false && cached.path === downloaded.path)

    let refreshCount = 0
    const submittedLoraPayloads = []
    const loraRuntime = {
      hardware: { vramMb: 16384, isIntegrated: false },
      async health() { return { ok: true, phase: 'ready' } },
      info() { return { device: { backend: 'cuda' } } },
      async refreshModels() { refreshCount += 1; return true },
      async submit(req) { submittedLoraPayloads.push(req); return { id: 'sd_lora_1' } },
      async job() { return { status: 'completed', result: { images: [{ b64_json: 'AA==' }] } } },
      logsSince() { return { lines: [], next: 0 } },
    }
    const loraBridge = createLocalGpuBridge({
      runtime: loraRuntime,
      config: { modelPath: join(loraDir, 'flux2.gguf'), loraDir },
      token: 'lora-tok',
      ensureLora: async () => ({ path: downloaded.path, downloaded: true }),
    })
    const loraBridgeUrl = await loraBridge.start()
    try {
      const res = await fetch(`${loraBridgeUrl}/generate`, {
        method: 'POST',
        headers: { authorization: 'Bearer lora-tok', 'content-type': 'application/json' },
        body: JSON.stringify(payloadOf({
          jobId: 'j_lora_ok',
          pipeline: { loader: 'flux2', lora: { repo: 'owner/repo', weight: 'style.safetensors', scale: 0.75 } },
        })),
      })
      await until('lora submit', () => submittedLoraPayloads.length === 1)
      check('Bridge 首次下载 LoRA 后触发 refreshModels 并透传结构化 lora',
        res.status === 202
        && refreshCount === 1
        && submittedLoraPayloads[0]?.lora?.[0]?.path === downloaded.path
        && submittedLoraPayloads[0]?.lora?.[0]?.multiplier === 0.75)
    } finally {
      await loraBridge.stop()
    }
  } finally {
    await rm(loraDir, { recursive: true, force: true })
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

