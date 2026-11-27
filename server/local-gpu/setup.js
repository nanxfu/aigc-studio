import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, statfs } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  LOCAL_GPU_MODEL_ASSETS,
  LOCAL_GPU_VARIANT_ASSETS,
  localGpuModelKeyOf,
  LOCAL_GPU_PRESET,
  localGpuAssetOf,
  localGpuEngineOf,
} from '../../shared/local-gpu-assets.js'
import { writeFileAtomic } from '../fs-atomic.js'
import { fileBytes, prepareAsset, validAsset } from './assets.js'
import { readLocalGpuConfig, saveLocalGpuConfig } from './config.js'
import { localGpuEngineReady, prepareLocalGpuEngine } from './engine.js'
import { listDevicesWithServer, pickPreferredDevice } from './probe.js'

const execFileAsync = promisify(execFile)

async function hasNvidiaGpu() {
  try {
    const result = await execFileAsync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      timeout: 4000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    })
    return String(result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line && !/virtual|parsec|rdp/i.test(line))
  } catch {
    return false
  }
}

function fingerprintOf({ backend, presetId, asset }) {
  return createHash('sha256').update(JSON.stringify({
    engine: localGpuEngineOf(backend).sha256,
    presetId,
    files: (asset?.files ?? []).map(({ key, sha256 }) => [key, sha256]),
  })).digest('hex')
}

/**
 * 多模型本机 GPU 准备器。
 *
 * 引擎与模型彻底解耦：`start()` 不带 presetId 只准备引擎；带 presetId 只下载该模型。
 * 每次下载完成写入 `local-gpu.json` 的 `models[presetId]`，不会覆盖其他已下载模型。
 */
export function createLocalGpuSetup({
  appConfig,
  localModels,
  log,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  modelAssets = LOCAL_GPU_MODEL_ASSETS,
  weights = null,
  listDevices = listDevicesWithServer,
  detectNvidia = hasNvidiaGpu,
  download,
  diskInfo = statfs,
  prepareEngine = prepareLocalGpuEngine,
  getHfToken = () => '',
} = {}) {
  const root = appConfig?.root ?? ''
  const statePath = root ? join(root, 'local-gpu-setup.json') : ''
  const bundledDir = String(env.AIGC_STUDIO_BUNDLED_SD_DIR || '').trim()
  const forcedBackend = String(env.AIGC_STUDIO_LOCAL_GPU_ENGINE || '').trim().toLowerCase()
  const assets = weights
    ? {
        ...modelAssets,
        [LOCAL_GPU_PRESET]: {
          ...modelAssets[LOCAL_GPU_PRESET],
          files: weights,
          bytes: weights.reduce((sum, item) => sum + item.bytes, 0),
        },
      }
    : { ...modelAssets, ...(modelAssets === LOCAL_GPU_MODEL_ASSETS ? LOCAL_GPU_VARIANT_ASSETS : {}) }
  let state = { phase: 'idle', presetId: '', downloadedBytes: 0, totalBytes: 0, message: '' }
  let active = null
  let backendCache = ''
  let nvidiaCache = null
  let lastSetupState = null

  const modelsDir = () => localModels?.effectiveDir() || (root ? join(root, 'models') : '')
  const engineDirOf = (backend) => (
    backend === 'vulkan' && bundledDir
      ? bundledDir
      : join(root || process.cwd(), 'runtime', 'local-gpu', `engine-${backend}`)
  )
  const serverPathOf = (backend) => join(engineDirOf(backend), 'sd-server.exe')

  async function engineBackend() {
    if (forcedBackend === 'cuda' || forcedBackend === 'vulkan') return forcedBackend
    if (backendCache) return backendCache
    if (nvidiaCache === null) nvidiaCache = Boolean(await detectNvidia().catch(() => false))
    backendCache = nvidiaCache ? 'cuda' : 'vulkan'
    return backendCache
  }

  async function readSavedState() {
    if (!statePath) return null
    return readFile(statePath, 'utf8').then(JSON.parse).catch(() => null)
  }

  async function writeSavedState(saved) {
    if (!statePath) return
    await writeFileAtomic(statePath, `${JSON.stringify(saved, null, 2)}\n`, { ensureDir: true })
  }

  function targetOf(presetId) {
    return assets[presetId] ?? localGpuAssetOf(presetId) ?? null
  }

  function targetPaths(dir, asset) {
    return Object.fromEntries((asset?.files ?? []).map((file) => [file.key, join(dir, file.file)]))
  }

  async function modelReady(dir, asset) {
    if (!asset?.available || !asset.files?.length) return false
    const bytes = await Promise.all(asset.files.map((file) => fileBytes(join(dir, file.file))))
    return bytes.every((value, index) => value === asset.files[index].bytes)
  }

  async function engineReady(backend) {
    return localGpuEngineReady(engineDirOf(backend), backend)
  }

  async function restore() {
    if (state.phase !== 'idle' || !statePath) return
    const saved = lastSetupState ?? await readSavedState()
    if (!saved?.presetId || saved.modelsDir !== modelsDir()) return
    const asset = targetOf(saved.presetId)
    if (!asset || !(await modelReady(saved.modelsDir, asset))) return
    const backend = saved.engineBackend === 'cuda' ? 'cuda' : await engineBackend()
    if (!(await engineReady(backend))) return
    lastSetupState = saved
    state = {
      phase: 'ready',
      presetId: saved.presetId,
      downloadedBytes: asset.bytes,
      totalBytes: asset.bytes,
      message: '',
    }
  }

  async function snapshot(presetId = state.presetId) {
    await restore()
    const backend = await engineBackend()
    const dir = modelsDir() || (root ? join(root, 'models') : '')
    const engineIsReady = await engineReady(backend)
    const asset = targetOf(presetId)
    const models = {}
    for (const [id, item] of Object.entries(assets)) {
      const ready = await modelReady(dir, item)
      models[id] = {
        ready,
        available: item.available !== false,
        bytes: item.bytes,
        reason: item.reason ?? '',
        status: state.phase === 'downloading' && state.presetId === id ? 'downloading' : ready ? 'ready' : item.available === false ? 'unavailable' : 'missing',
      }
    }
    const engineBytes = engineIsReady ? 0 : localGpuEngineOf(backend).bytes
    const requestedReady = asset ? await modelReady(dir, asset) : engineIsReady
    const reportingActive = Boolean(active && state.presetId !== presetId)
    let freeBytes = null
    const useBundled = Boolean(bundledDir && backend === 'vulkan')
    const supported = Boolean(root && platform === 'win32' && arch === 'x64' && (!useBundled || engineIsReady))
    try {
      if (dir) {
        const info = await diskInfo(dir)
        freeBytes = Number(info.bavail) * Number(info.bsize)
      }
    } catch {}
    const targetBytes = asset?.available
      ? (await Promise.all(asset.files.map(async (file) => (await fileBytes(join(dir, file.file))) === file.bytes ? 0 : file.bytes))).reduce((sum, bytes) => sum + bytes, 0)
      : 0
    const totalBytes = state.phase !== 'idle' && state.presetId === presetId ? state.totalBytes : engineBytes + targetBytes
    return {
      supported,
      phase: reportingActive ? 'busy' : (presetId && state.presetId !== presetId ? (requestedReady ? 'ready' : 'idle') : state.phase),
      presetId: presetId || state.presetId || '',
      engineReady: engineIsReady,
      engineBackend: backend,
      engineLabel: localGpuEngineOf(backend).label,
      engineBytes,
      available: asset ? asset.available !== false : true,
      totalBytes,
      downloadedBytes: state.phase !== 'idle' ? state.downloadedBytes : engineBytes ? 0 : targetBytes,
      freeBytes,
      dir,
      models,
      message: reportingActive ? '另一个本机模型正在准备，请等待完成后重试。' : state.message ?? '',
    }
  }

  async function prepare(presetId, dir, signal) {
    const backend = await engineBackend()
    const asset = presetId ? targetOf(presetId) : null
    if (presetId && !asset) throw new Error(`未登记的本机模型：${presetId}`)
    if (asset && asset.available === false) throw new Error(asset.reason || '该模型暂不支持本机下载')
    const engine = localGpuEngineOf(backend)
    const serverPath = serverPathOf(backend)
    const engineIsReady = await engineReady(backend)
    const engineBytesNeeded = engineIsReady ? 0 : engine.bytes
    const assetTargets = asset ? targetPaths(dir, asset) : {}
    const validFiles = asset
      ? await Promise.all(asset.files.map((file) => validAsset(assetTargets[file.key], file, signal)))
      : []
    let neededBytes = 0
    if (asset) {
      for (let index = 0; index < asset.files.length; index += 1) {
        if (!validFiles[index]) neededBytes += asset.files[index].bytes
      }
    }
    if (engineBytesNeeded || neededBytes) {
      const disk = await diskInfo(dir)
      const sameVolume = parse(resolve(dir)).root.toLowerCase() === parse(resolve(engineDirOf(backend))).root.toLowerCase()
      const requiredBytes = neededBytes + (sameVolume ? engineBytesNeeded * 2.5 : 0)
      if (Number(disk.bavail) * Number(disk.bsize) < requiredBytes) {
        throw new Error('模型目录磁盘空间不足。请切换模型目录，或清理磁盘后重试。')
      }
    }
    let progress = 0
    state.totalBytes = engineBytesNeeded + neededBytes
    state.downloadedBytes = 0
    if (!engineIsReady) {
      state.phase = 'downloading'
      await prepareEngine(engineDirOf(backend), {
        backend,
        signal,
        download,
        onProgress: (bytes) => {
          state.downloadedBytes = Math.min(engine.bytes, Number(bytes) || 0)
          progress = state.downloadedBytes
        },
      })
      progress = engine.bytes
    }
    state.phase = 'checking'
    const devices = await listDevices(serverPath, { env })
    signal.throwIfAborted()
    const gpu = pickPreferredDevice(devices.devices)
    const expected = backend === 'cuda' ? 'cuda' : 'vulkan'
    if (!devices.ok || !gpu || (gpu.backend !== expected && gpu.backend !== 'rocm')) {
      throw new Error(
        backend === 'cuda'
          ? '未检测到可用的 NVIDIA CUDA 显卡，请检查驱动后重试。'
          : '未检测到可用的 Vulkan 显卡。请检查显卡驱动，或改用云端算力。',
      )
    }
    if (asset) {
      await mkdir(dir, { recursive: true })
      state.phase = 'downloading'
      for (let index = 0; index < asset.files.length; index += 1) {
        if (validFiles[index]) {
          continue
        }
        const file = asset.files[index]
        const offset = progress
        await prepareAsset(file, assetTargets[file.key], {
          hfToken: getHfToken() || '',
          signal,
          download,
          onProgress: (bytes) => { state.downloadedBytes = offset + bytes },
        })
        progress = offset + file.bytes
        state.downloadedBytes = progress
      }
      signal.throwIfAborted()
    }
    state.phase = 'saving'
    const useBundled = Boolean(bundledDir && backend === 'vulkan')
    const saved = await saveLocalGpuConfig({
      root,
      env,
      managed: useBundled,
      patch: {
        ...(useBundled ? { serverPath: '' } : { serverPath }),
        engineBackend: backend,
        ...(presetId ? { defaultPreset: presetId.split('::')[0], defaultVariantId: presetId.split('::')[1] || '' } : {}),
        ...(asset ? { models: { [presetId]: assetTargets } } : {}),
      },
    })
    if (!saved.ok || !saved.result.ok) throw new Error(saved.message || saved.result.errors[0])
    const fingerprint = fingerprintOf({ backend, presetId, asset })
    lastSetupState = {
      fingerprint,
      presetId,
      modelsDir: dir,
      engineBackend: backend,
    }
    await writeSavedState(lastSetupState)
  }

  async function start(presetId = '', variantId = '') {
    presetId = localGpuModelKeyOf(presetId, variantId)
    await restore()
    if (active) return snapshot(presetId || state.presetId)
    const current = await snapshot(presetId)
    if (!current.supported) return null
    const targetId = String(presetId || '').trim()
    const asset = targetId ? targetOf(targetId) : null
    if (targetId && (!asset || asset.available === false)) {
      state = {
        phase: 'error',
        presetId: targetId,
        downloadedBytes: 0,
        totalBytes: asset?.bytes ?? 0,
        message: asset?.reason || '该模型暂不支持本机下载',
      }
      return snapshot(targetId)
    }
    if (!active) {
      const controller = new AbortController()
      const dir = current.dir || join(root, 'models')
      state = {
        phase: 'checking',
        presetId: targetId,
        downloadedBytes: 0,
        totalBytes: current.totalBytes,
        message: '',
      }
      const promise = prepare(targetId, dir, controller.signal).then(() => {
        state = {
          phase: 'ready',
          presetId: targetId,
          downloadedBytes: state.totalBytes,
          totalBytes: state.totalBytes,
          message: '',
        }
      }).catch((error) => {
        if (controller.signal.aborted) {
          state = { phase: 'idle', presetId: '', downloadedBytes: 0, totalBytes: 0, message: '' }
          return
        }
        const message = error?.message || String(error)
        log?.warn?.(`local_gpu_setup_failed ${message}`)
        state = {
          phase: 'error',
          presetId: targetId,
          downloadedBytes: state.downloadedBytes,
          totalBytes: state.totalBytes,
          message,
        }
      }).finally(() => { active = null })
      active = { controller, promise }
    }
    return snapshot(targetId)
  }

  async function cancel(presetId = state.presetId) {
    if (active && state.phase !== 'saving') {
      active.controller.abort()
      await active.promise
    }
    return snapshot(presetId)
  }

  async function dispose() {
    if (!active) return
    active.controller.abort()
    await active.promise
  }

  return { snapshot, start, cancel, dispose, restore, busy: () => Boolean(active) }
}
