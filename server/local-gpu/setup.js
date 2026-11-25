import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, statfs } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'

import { LOCAL_GPU_ENGINE, LOCAL_GPU_PRESET, LOCAL_GPU_WEIGHTS } from '../../shared/local-gpu-assets.js'
import { writeFileAtomic } from '../fs-atomic.js'
import { fileBytes, prepareAsset, validAsset } from './assets.js'
import { readLocalGpuConfig, saveLocalGpuConfig } from './config.js'
import { localGpuEngineReady, prepareLocalGpuEngine } from './engine.js'
import { listDevicesWithServer } from './probe.js'

export function createLocalGpuSetup({
  appConfig,
  localModels,
  log,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  weights = LOCAL_GPU_WEIGHTS,
  listDevices = listDevicesWithServer,
  download,
  diskInfo = statfs,
  prepareEngine = prepareLocalGpuEngine,
} = {}) {
  const root = appConfig?.root ?? ''
  const engineDir = env.AIGC_STUDIO_BUNDLED_SD_DIR || join(root || process.cwd(), 'runtime', 'local-gpu', 'engine')
  const serverPath = join(engineDir, 'sd-server.exe')
  const statePath = root ? join(root, 'local-gpu-setup.json') : ''
  const weightBytes = weights.reduce((sum, asset) => sum + asset.bytes, 0)
  const fingerprint = createHash('sha256').update(JSON.stringify({
    engine: LOCAL_GPU_ENGINE.sha256,
    preset: LOCAL_GPU_PRESET,
    weights: weights.map(({ key, sha256 }) => [key, sha256]),
  })).digest('hex')
  const modelsDir = () => localModels?.effectiveDir() || (root ? join(root, 'models') : '')
  const effectiveModelsDir = () => modelsDir() || (root ? join(root, 'models') : '')
  const targetPaths = (dir) => Object.fromEntries(weights.map((asset) => [asset.key, join(dir, asset.file)]))
  let state = { phase: 'idle', downloadedBytes: 0 }
  let active = null
  let totalBytes = weightBytes
  let lastSetupState = null

  async function readSavedState() {
    if (!statePath) return null
    return readFile(statePath, 'utf8').then(JSON.parse).catch(() => null)
  }

  async function setupIsValid(saved, dir, config = readLocalGpuConfig({ root, env })) {
    if (!saved || saved.fingerprint !== fingerprint || saved.modelsDir !== dir || !config.ok || config.overrideByEnv ||
        config.config.defaultPreset !== LOCAL_GPU_PRESET ||
        !weights.every((asset) => config.config[asset.key] === join(dir, asset.file)) ||
        (!config.config.useBundledEngine && config.config.serverPath !== serverPath)) return false
    const validWeights = await Promise.all(weights.map((asset) => validAsset(join(dir, asset.file), asset)))
    return validWeights.every(Boolean) && localGpuEngineReady(engineDir)
  }

  async function setupIsReady(saved, dir) {
    const config = readLocalGpuConfig({ root, env })
    if (!saved || saved.fingerprint !== fingerprint || saved.modelsDir !== dir || !config.ok || config.overrideByEnv ||
        config.config.defaultPreset !== LOCAL_GPU_PRESET ||
        !weights.every((asset) => config.config[asset.key] === join(dir, asset.file)) ||
        (!config.config.useBundledEngine && config.config.serverPath !== serverPath) ||
        !(await localGpuEngineReady(engineDir))) return false
    const sizes = await Promise.all(weights.map((asset) => fileBytes(join(dir, asset.file))))
    return sizes.every((bytes, index) => bytes === weights[index].bytes)
  }

  async function restore() {
    if (state.phase !== 'idle' || !statePath) return
    if (await setupIsValid(await readSavedState(), effectiveModelsDir())) {
      const bundled = Boolean(env.AIGC_STUDIO_BUNDLED_SD_DIR)
      state = { phase: 'ready', downloadedBytes: weightBytes + (bundled ? 0 : LOCAL_GPU_ENGINE.bytes) }
    }
  }

  async function snapshot() {
    await restore()
    const bundled = Boolean(env.AIGC_STUDIO_BUNDLED_SD_DIR)
    const engineReady = await localGpuEngineReady(engineDir)
    const supported = Boolean(root && platform === 'win32' && arch === 'x64' && (!bundled || engineReady))
    const engineBytes = !bundled && !engineReady ? LOCAL_GPU_ENGINE.bytes : 0
    totalBytes = weightBytes + engineBytes
    let freeBytes = null
    if (supported && state.phase === 'idle') {
      try {
        const info = await diskInfo(effectiveModelsDir())
        freeBytes = Number(info.bavail) * Number(info.bsize)
      } catch {}
    }
    return { ...state, supported, totalBytes, freeBytes, dir: modelsDir() }
  }

  async function prepare(dir, signal) {
    const stored = readLocalGpuConfig({ root, env })
    if (stored.source === 'file' && !stored.ok) throw new Error(stored.errors[0] || '本机 GPU 配置文件不可用')
    const targets = targetPaths(dir)
    const mappedPreset = stored.config.models[LOCAL_GPU_PRESET]
    const currentSetup = await readSavedState()
    const matchingConfig = stored.ok && stored.config.defaultPreset === LOCAL_GPU_PRESET &&
      (stored.config.useBundledEngine || stored.config.serverPath === serverPath) &&
      stored.config.modelPath === targets.modelPath && stored.config.vaePath === targets.vaePath &&
      mappedPreset?.modelPath === targets.modelPath && (mappedPreset.vaePath || '') === targets.vaePath
    if (matchingConfig && await setupIsReady(currentSetup, dir)) return
    const hasExplicitConfig = Boolean(stored.overrideByEnv || Object.keys(stored.config.models).length ||
      stored.config.serverPath || stored.config.modelPath || stored.config.vaePath || stored.config.defaultPreset)
    if (hasExplicitConfig && !matchingConfig && !(await setupIsValid(currentSetup, dir, stored))) {
      throw new Error('已有手动 GPU 配置。请先在高级设置中清空旧模型路径，或使用其现有配置。')
    }

    const validWeights = await Promise.all(weights.map((asset) => validAsset(targets[asset.key], asset, signal)))
    if (stored.ok && (stored.config.useBundledEngine || stored.config.serverPath === serverPath) && validWeights.every(Boolean)) {
      if (statePath) {
        await writeFileAtomic(statePath, `${JSON.stringify({
          fingerprint,
          modelsDir: dir,
          weights: Object.fromEntries(weights.map((asset) => [asset.key, asset.sha256])),
        }, null, 2)}\n`, { ensureDir: true })
      }
      return
    }

    let weightsNeededBytes = 0
    let existingWeightsBytes = 0
    for (let index = 0; index < weights.length; index += 1) {
      if (validWeights[index]) {
        state.downloadedBytes += weights[index].bytes
        existingWeightsBytes += weights[index].bytes
        continue
      }
      const path = targets[weights[index].key]
      const partialBytes = await fileBytes(`${path}.part`)
      const partialReusable = partialBytes < weights[index].bytes || await validAsset(`${path}.part`, weights[index], signal)
      if (!partialReusable) await rm(`${path}.part`, { force: true })
      weightsNeededBytes += weights[index].bytes - (partialReusable ? partialBytes : 0)
    }

    await mkdir(dir, { recursive: true })
    const engineRoot = dirname(engineDir)
    await mkdir(engineRoot, { recursive: true })
    const engineReady = await localGpuEngineReady(engineDir)
    const engineBytesNeeded = !env.AIGC_STUDIO_BUNDLED_SD_DIR && !engineReady ? LOCAL_GPU_ENGINE.bytes * 6 : 0
    if (engineBytesNeeded > 0) {
      const disk = await diskInfo(engineRoot)
      if (Number(disk.bavail) * Number(disk.bsize) < engineBytesNeeded) {
        throw new Error('系统盘空间不足，无法准备 Vulkan 引擎。请先释放约 200 MB 空间后重试。')
      }
    }
    if (weightsNeededBytes || engineBytesNeeded) {
      const disk = await diskInfo(dir)
      const sameVolume = parse(resolve(dir)).root.toLowerCase() === parse(resolve(engineRoot)).root.toLowerCase()
      const requiredBytes = weightsNeededBytes + (sameVolume ? engineBytesNeeded : 0)
      if (Number(disk.bavail) * Number(disk.bsize) < requiredBytes) {
        throw new Error('模型目录磁盘空间不足。请切换模型目录，或清理磁盘后重试。')
      }
    }

    if (!env.AIGC_STUDIO_BUNDLED_SD_DIR && !engineReady) {
      state.phase = 'downloading'
      await prepareEngine(engineDir, {
        signal,
        download,
        onProgress: (bytes) => { state.downloadedBytes = engineBytesNeeded ? Math.min(bytes, LOCAL_GPU_ENGINE.bytes) : 0 },
      })
    }
    state.downloadedBytes += existingWeightsBytes
    const engineBytes = !env.AIGC_STUDIO_BUNDLED_SD_DIR && !engineReady ? LOCAL_GPU_ENGINE.bytes : 0
    state.downloadedBytes = engineBytes + state.downloadedBytes

    state.phase = 'checking'
    const devices = await listDevices(serverPath, { env })
    signal.throwIfAborted()
    if (!devices.ok || !devices.devices.some((device) =>
      device.backend === 'vulkan' && !/llvmpipe|swiftshader|lavapipe|software/i.test(device.name))) {
      throw new Error('未检测到可用的 Vulkan 显卡。请检查显卡驱动，或改用云端算力。')
    }

    state.phase = 'downloading'
    for (let index = 0; index < weights.length; index += 1) {
      const asset = weights[index]
      const path = targets[asset.key]
      if (validWeights[index]) continue
      const offset = state.downloadedBytes
      await prepareAsset(asset, path, {
        signal,
        download,
        onProgress: (bytes) => { state.downloadedBytes = offset + bytes },
      })
      state.downloadedBytes = offset + asset.bytes
    }

    signal.throwIfAborted()
    state.phase = 'saving'
    const saved = await saveLocalGpuConfig({
      root,
      env,
      managed: true,
      patch: {
        ...targets,
        serverPath: env.AIGC_STUDIO_BUNDLED_SD_DIR ? '' : serverPath,
        defaultPreset: LOCAL_GPU_PRESET,
      },
    })
    if (!saved.ok || !saved.result.ok) throw new Error(saved.message || saved.result.errors[0])
    const afterSave = readLocalGpuConfig({ root, env })
    if (!afterSave.ok) throw new Error(afterSave.errors[0] || '本机 GPU 配置校验失败')
    if (!statePath) throw new Error('本机 GPU 设置状态目录不可用')
    lastSetupState = {
      fingerprint,
      modelsDir: dir,
      weights: Object.fromEntries(weights.map((asset) => [asset.key, asset.sha256])),
    }
    await writeFileAtomic(statePath, `${JSON.stringify({
      fingerprint,
      modelsDir: dir,
      weights: Object.fromEntries(weights.map((asset) => [asset.key, asset.sha256])),
    }, null, 2)}\n`, { ensureDir: true })
  }

  async function start() {
    await restore()
    if (state.phase === 'ready' && lastSetupState) {
      const valid = await setupIsValid(lastSetupState, lastSetupState.modelsDir)
      if (valid) return snapshot()
      state = { phase: 'idle', downloadedBytes: 0 }
      lastSetupState = null
    }
    if (state.phase === 'ready' && await setupIsReady(await readSavedState(), modelsDir())) return snapshot()
    if (state.phase === 'ready') {
      state = { phase: 'idle', downloadedBytes: 0 }
      await rm(statePath, { force: true }).catch(() => {})
    }
    const current = await snapshot()
    if (!current.supported) return null
    if (!active) {
      const controller = new AbortController()
      const dir = current.dir || join(root, 'models')
      state = { phase: 'checking', downloadedBytes: 0 }
      const promise = prepare(dir, controller.signal).then(() => {
        state = { phase: 'ready', downloadedBytes: totalBytes }
      }).catch((error) => {
        if (controller.signal.aborted) {
          state = { phase: 'idle', downloadedBytes: 0 }
          return
        }
        const message = error?.message || String(error)
        log?.warn?.(`local_gpu_setup_failed ${message}`)
        state = { phase: 'error', downloadedBytes: state.downloadedBytes, message }
      }).finally(() => { active = null })
      active = { controller, promise }
    }
    return snapshot()
  }

  async function cancel() {
    if (active && state.phase !== 'saving') {
      active.controller.abort()
      await active.promise
    }
    return snapshot()
  }

  async function dispose() {
    if (!active) return
    active.controller.abort()
    await active.promise
  }

  return { snapshot, start, cancel, dispose, busy: () => Boolean(active) }
}
