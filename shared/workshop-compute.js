/**
 * 工坊三层算力画像（M4.2f）。
 *
 * 设计边界：
 *  - 端侧 ONNX 永远在本机运行，不需要 CUDA 与 Python；
 *  - hybrid-cuda 同时声明「保守可跑门槛」与「首次下载体量」，Host / 客户端共用同一份评估；
 *  - cloud-only 只在明确登记的模型上出现，用户不能误选本地后等到 OOM 才发现。
 *
 * 本文件不读硬件、不碰文件系统；调用方把 `hardwareProbe` 的只读快照传进来即可。
 */

const MIB = 1024
const GIB = 1024 * MIB * MIB

const profile = (value) => Object.freeze(value)

/**
 * 每个可切换执行位置的工坊模型一条轻量声明。
 *
 * `firstTimeDiskBytes` 与 `cachedDiskBytes` 是保守闸门：前者覆盖共享 CUDA 环境 + 单模型权重，
 * 后者只保留运行期临时文件。数值来自 M4.2f 专项规划与现有真机基线，留有余量。
 */
export const WORKSHOP_COMPUTE_PROFILES = Object.freeze({
  'pbr:marigold': profile({
    id: 'pbr:marigold',
    op: 'pbr',
    model: 'marigold',
    tier: 'hybrid-cuda',
    minTotalVramMb: 8 * MIB - 256,
    minFreeVramMb: 5 * MIB,
    minTotalRamMb: 16 * MIB - 512,
    minFreeRamMb: 4 * MIB,
    firstTimeDiskBytes: 12 * GIB,
    cachedDiskBytes: 1 * GIB,
    runtimeDownloadText: '约 3 GB',
    modelDownloadText: '约 5.2 GB',
  }),
  'pbr:chord': profile({
    id: 'pbr:chord',
    op: 'pbr',
    model: 'chord',
    tier: 'cloud-only',
    reason: '这个模型只提供云端 GPU 路径',
  }),
  'depth:da3-small': profile({
    id: 'depth:da3-small',
    op: 'depth',
    model: 'da3-small',
    tier: 'edge-onnx',
    runtimeDownloadText: '约 37 MB',
  }),
  'depth:da3mono-large': profile({
    id: 'depth:da3mono-large',
    op: 'depth',
    model: 'da3mono-large',
    tier: 'hybrid-cuda',
    minTotalVramMb: 8 * MIB - 256,
    minFreeVramMb: 5 * MIB,
    minTotalRamMb: 16 * MIB - 512,
    minFreeRamMb: 4 * MIB,
    firstTimeDiskBytes: 12 * GIB,
    cachedDiskBytes: 1 * GIB,
    runtimeDownloadText: '约 3 GB',
    modelDownloadText: '约 1.6 GB',
  }),
  'depth:da3-large': profile({
    id: 'depth:da3-large',
    op: 'depth',
    model: 'da3-large',
    tier: 'hybrid-cuda',
    minTotalVramMb: 8 * MIB - 256,
    minFreeVramMb: 5 * MIB,
    minTotalRamMb: 16 * MIB - 512,
    minFreeRamMb: 4 * MIB,
    firstTimeDiskBytes: 12 * GIB,
    cachedDiskBytes: 1 * GIB,
    runtimeDownloadText: '约 3 GB',
    modelDownloadText: '约 1.8 GB',
  }),
  'depth:moge-2-vitl': profile({
    id: 'depth:moge-2-vitl',
    op: 'depth',
    model: 'moge-2-vitl',
    tier: 'hybrid-cuda',
    // 8 GB 卡在关闭其它重任务后仍可跑，但空闲显存必须 >= 6 GiB；
    // 10–12 GB 卡是更稳妥的推荐区间。
    minTotalVramMb: 8 * MIB,
    minFreeVramMb: 6 * MIB,
    minTotalRamMb: 16 * MIB - 512,
    minFreeRamMb: 4 * MIB,
    firstTimeDiskBytes: 12 * GIB,
    cachedDiskBytes: 1 * GIB,
    runtimeDownloadText: '约 3 GB',
    modelDownloadText: '约 6.5 GB',
  }),
  'relight:ic-light': profile({
    id: 'relight:ic-light',
    op: 'relight',
    model: 'ic-light',
    tier: 'hybrid-cuda',
    minTotalVramMb: 8 * MIB,
    minFreeVramMb: 6 * MIB,
    minTotalRamMb: 16 * MIB - 512,
    minFreeRamMb: 4 * MIB,
    firstTimeDiskBytes: 12 * GIB,
    cachedDiskBytes: 1 * GIB,
    runtimeDownloadText: '约 3 GB',
    modelDownloadText: '约 5 GB',
  }),
  'remove-bg:rmbg-1.4': profile({
    id: 'remove-bg:rmbg-1.4',
    op: 'remove-bg',
    model: 'rmbg-1.4',
    tier: 'edge-onnx',
    runtimeDownloadText: '约 44–88 MB',
  }),
  'remove-bg:birefnet': profile({
    id: 'remove-bg:birefnet',
    op: 'remove-bg',
    model: 'birefnet',
    tier: 'hybrid-cuda',
    minTotalVramMb: 6 * MIB - 256,
    minFreeVramMb: 3 * MIB,
    minTotalRamMb: 16 * MIB - 512,
    minFreeRamMb: 4 * MIB,
    firstTimeDiskBytes: 10 * GIB,
    cachedDiskBytes: 1 * GIB,
    runtimeDownloadText: '约 3 GB',
    modelDownloadText: '约 0.9 GB',
  }),
  'remove-bg:rmbg-2.0': profile({
    id: 'remove-bg:rmbg-2.0',
    op: 'remove-bg',
    model: 'rmbg-2.0',
    tier: 'hybrid-cuda',
    minTotalVramMb: 6 * MIB - 256,
    minFreeVramMb: 3 * MIB,
    minTotalRamMb: 16 * MIB - 512,
    minFreeRamMb: 4 * MIB,
    firstTimeDiskBytes: 10 * GIB,
    cachedDiskBytes: 1 * GIB,
    runtimeDownloadText: '约 3 GB',
    modelDownloadText: '约 0.9 GB',
  }),
  'remove-bg:rmbg-3.0': profile({
    id: 'remove-bg:rmbg-3.0',
    op: 'remove-bg',
    model: 'rmbg-3.0',
    tier: 'cloud-only',
    reason: 'RMBG-3.0 需 24 GB+ 显存与新版扩散管线，当前仅规划为高配云端路径',
  }),
})

/** PBR 旧接口的资源基线；新代码请优先读 `WORKSHOP_COMPUTE_PROFILES`。 */
export const LOCAL_PBR = Object.freeze({
  minVramMb: 8 * MIB - 256,
  minFreeVramMb: 5 * MIB,
  minRamMb: 16 * MIB - 512,
  minFreeRamMb: 4 * MIB,
  minDiskGb: 12,
  weightBytes: 5_160_213_116,
  intrinsicsRepo: 'prs-eth/marigold-iid-appearance-v1-1',
  intrinsicsRevision: 'e7280a0a0fc5a0df0b36050882b3d8b77da22fd9',
  normalsRepo: 'prs-eth/marigold-normals-v1-1',
  normalsRevision: '09cfdd258cb281fa006cf1afcd2284376d16687d',
})

/** 返回 profile id（找不到仍按可读 id 返回，便于错误日志定位）。 */
export function workshopComputeProfileId(op, model) {
  return `${String(op || '').trim()}:${String(model || '').trim()}`
}

/** 按算子与模型取声明；未知返回 null（调用方应回退云端或拒绝本地执行）。 */
export function workshopComputeProfileOf(op, model) {
  return WORKSHOP_COMPUTE_PROFILES[workshopComputeProfileId(op, model)] ?? null
}

function cachedModelsOf(hardware) {
  const info = hardware?.localWorkshop ?? hardware?.localPbr ?? null
  const models = info?.cachedModels
  return models && typeof models === 'object' && !Array.isArray(models) ? models : {}
}

function envCachedOf(hardware) {
  const info = hardware?.localWorkshop ?? hardware?.localPbr ?? null
  if (!info || typeof info !== 'object') return null
  if (typeof info.envCached === 'boolean') return info.envCached
  if (typeof info.prepared === 'boolean') return info.prepared
  return null
}

function diskFreeBytesOf(hardware) {
  const freeGb = Number(hardware?.disk?.freeGb)
  return Number.isFinite(freeGb) ? freeGb * GIB : null
}

function downloadTextOf(profileInfo, envCached, modelCached) {
  if (envCached !== false && modelCached !== false) return ''
  if (envCached === false && modelCached === false) {
    const parts = [profileInfo.runtimeDownloadText, profileInfo.modelDownloadText].filter(Boolean)
    return parts.length > 0 ? parts.join(' + ') : ''
  }
  if (envCached === false) return profileInfo.runtimeDownloadText || ''
  return profileInfo.modelDownloadText || ''
}

/**
 * 统一评估工坊模型能否在本机运行。
 *
 * @param {object|null} hardware `hardwareProbe` 快照（可选带 `localWorkshop` 缓存状态）
 * @param {{op?: string, model?: string, arch?: string, profileId?: string,
 *   envCached?: boolean, modelCached?: boolean, cachedModels?: object}} [options]
 */
export function evaluateWorkshopCompute(hardware, options = {}) {
  const op = options.op
  const model = options.model
  const profileInfo = options.profileId
    ? WORKSHOP_COMPUTE_PROFILES[options.profileId]
    : workshopComputeProfileOf(op, model)
  const base = {
    profileId: profileInfo?.id ?? workshopComputeProfileId(op, model),
    tier: profileInfo?.tier ?? 'cloud-only',
    localEligible: false,
    recommended: 'cloud',
    badge: 'cloud-only',
    reasonCode: 'model',
    reason: '该模型没有登记本机执行能力',
    needsDownload: false,
    downloadText: '',
    cacheKnown: false,
    envCached: null,
    modelCached: null,
    gpuIndex: null,
    gpuName: '',
    freeVramMb: null,
    requiredFreeVramMb: profileInfo?.minFreeVramMb ?? null,
    requiredTotalVramMb: profileInfo?.minTotalVramMb ?? null,
  }

  if (!hardware) {
    return { ...base, badge: 'cloud-recommended', reasonCode: 'checking', reason: '正在检测本机配置' }
  }
  if (!profileInfo) return base

  const envCached = typeof options.envCached === 'boolean' ? options.envCached : envCachedOf(hardware)
  const cachedModels = options.cachedModels && typeof options.cachedModels === 'object'
    ? options.cachedModels
    : cachedModelsOf(hardware)
  const cacheInfo = hardware?.localWorkshop ?? hardware?.localPbr ?? null
  const hasModelCacheMap = Boolean(
    cacheInfo?.cachedModels && typeof cacheInfo.cachedModels === 'object',
  ) || Boolean(options.cachedModels && typeof options.cachedModels === 'object')
  const modelCached = typeof options.modelCached === 'boolean'
    ? options.modelCached
    : (Object.prototype.hasOwnProperty.call(cachedModels, profileInfo.id)
        ? cachedModels[profileInfo.id] === true
        : (hasModelCacheMap ? false : null))
  const cacheKnown = envCached !== null || modelCached !== null
  const needsDownload = envCached === false || modelCached === false
    ? true
    : (envCached === null && modelCached === null ? null : false)
  const downloadText = downloadTextOf(profileInfo, envCached, modelCached)

  if (profileInfo.tier === 'edge-onnx') {
    return {
      ...base,
      localEligible: true,
      recommended: 'local',
      badge: 'edge-fast',
      reasonCode: 'edge-ready',
      reason: '端侧轻量模型，直接在本机运行',
      needsDownload,
      downloadText,
      cacheKnown,
      envCached,
      modelCached,
    }
  }

  if (profileInfo.tier === 'cloud-only') {
    return {
      ...base,
      reasonCode: 'cloud-only',
      reason: profileInfo.reason || '该模型只支持云端 GPU',
      needsDownload: false,
      cacheKnown,
      envCached,
      modelCached,
    }
  }

  const arch = options.arch || hardware.arch || 'x64'
  if (!['win32', 'linux'].includes(hardware.platform) || arch !== 'x64') {
    return {
      ...base,
      badge: 'cloud-recommended',
      reasonCode: 'platform',
      reason: '本机 CUDA 运行器只支持 Windows / Linux x64',
      needsDownload,
      downloadText,
      cacheKnown,
      envCached,
      modelCached,
    }
  }

  const gpus = Array.isArray(hardware.gpus) ? hardware.gpus : []
  const suitable = gpus
    .map((gpu, gpuIndex) => ({ gpu, gpuIndex }))
    .filter(({ gpu }) => gpu?.vendor === 'nvidia'
      && gpu?.source === 'nvidia-smi'
      && Number(gpu.vramMb) >= profileInfo.minTotalVramMb)
  if (suitable.length === 0) {
    return {
      ...base,
      badge: 'cloud-recommended',
      reasonCode: 'gpu',
      reason: `本机需要至少 ${Math.ceil(profileInfo.minTotalVramMb / MIB)} GB 显存的 NVIDIA 显卡`,
      needsDownload,
      downloadText,
      cacheKnown,
      envCached,
      modelCached,
    }
  }

  const selected = suitable.find(({ gpu }) => Number.isFinite(gpu.vramFreeMb)
    && gpu.vramFreeMb >= profileInfo.minFreeVramMb)
  if (!selected) {
    return {
      ...base,
      badge: 'cloud-recommended',
      reasonCode: 'busy',
      reason: `本机空闲显存不足 ${Math.ceil(profileInfo.minFreeVramMb / MIB)} GB`,
      needsDownload,
      downloadText,
      cacheKnown,
      envCached,
      modelCached,
      gpuName: suitable[0].gpu.name || '',
    }
  }
  if (!(hardware.memory?.totalMb >= profileInfo.minTotalRamMb)
    || !(hardware.memory?.freeMb >= profileInfo.minFreeRamMb)) {
    return {
      ...base,
      badge: 'cloud-recommended',
      reasonCode: 'memory',
      reason: `本机内存不足（需要 ${Math.ceil(profileInfo.minTotalRamMb / MIB)} GB，空闲 ${Math.ceil(profileInfo.minFreeRamMb / MIB)} GB）`,
      needsDownload,
      downloadText,
      cacheKnown,
      envCached,
      modelCached,
      gpuIndex: selected.gpuIndex,
      gpuName: selected.gpu.name || '',
      freeVramMb: selected.gpu.vramFreeMb,
    }
  }
  const diskFreeBytes = diskFreeBytesOf(hardware)
  const requiredDiskBytes = needsDownload === false ? profileInfo.cachedDiskBytes : profileInfo.firstTimeDiskBytes
  if (diskFreeBytes !== null && diskFreeBytes < requiredDiskBytes) {
    return {
      ...base,
      badge: 'cloud-recommended',
      reasonCode: 'disk',
      reason: `模型盘至少需要 ${Math.ceil(requiredDiskBytes / GIB)} GB 可用空间`,
      needsDownload,
      downloadText,
      cacheKnown,
      envCached,
      modelCached,
      gpuIndex: selected.gpuIndex,
      gpuName: selected.gpu.name || '',
      freeVramMb: selected.gpu.vramFreeMb,
    }
  }

  return {
    ...base,
    localEligible: true,
    recommended: 'local',
    badge: 'local-ready',
    reasonCode: 'local-ample',
    reason: `检测到本机 ${selected.gpu.name || 'NVIDIA GPU'}（空闲显存 ${(selected.gpu.vramFreeMb / MIB).toFixed(1)} GB），可免排队本机运行`,
    needsDownload,
    downloadText,
    cacheKnown,
    envCached,
    modelCached,
    gpuIndex: selected.gpuIndex,
    gpuName: selected.gpu.name || '',
    freeVramMb: selected.gpu.vramFreeMb,
  }
}

const LEGACY_REASON = Object.freeze({
  'edge-ready': 'ready',
  'local-ample': 'ready',
  checking: 'checking',
  platform: 'platform',
  gpu: 'gpu',
  busy: 'busy',
  memory: 'memory',
  disk: 'disk',
  model: 'model',
  'cloud-only': 'model',
})

/** PBR 旧接口：保留 `{ available, defaultExecution, reason, gpuIndex, device }` 形状。 */
export function evaluateLocalPbr(hardware, { model = 'marigold', arch = hardware?.arch || 'x64' } = {}) {
  const evaluation = evaluateWorkshopCompute(hardware, { op: 'pbr', model, arch })
  return {
    available: evaluation.localEligible,
    defaultExecution: evaluation.recommended,
    reason: LEGACY_REASON[evaluation.reasonCode] ?? 'model',
    gpuIndex: evaluation.gpuIndex,
    ...(evaluation.gpuName ? { device: evaluation.gpuName } : {}),
  }
}

/** 工坊云端任务可借用的 GPU 来源；商业 API / Vulkan 本机来源回退到 Kaggle。 */
export function workshopCloudProvider(provider) {
  return ['kaggle', 'colab', 'salad', 'private-worker'].includes(provider) ? provider : 'kaggle'
}

/** 是否属于会排队/冷启动的云端来源（本机 Vulkan 不算）。 */
export function isWorkshopCloudProvider(provider) {
  return ['kaggle', 'colab', 'salad', 'private-worker', 'cloud-api'].includes(provider)
}
