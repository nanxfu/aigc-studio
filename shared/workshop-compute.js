/** PBR 本地执行的资源基线；Host 与工坊共用，未知配置默认走云端。 */
export const LOCAL_PBR = Object.freeze({
  minVramMb: 8 * 1024 - 256,
  minFreeVramMb: 5 * 1024,
  minRamMb: 16 * 1024 - 512,
  minFreeRamMb: 4 * 1024,
  minDiskGb: 12,
  weightBytes: 5_160_213_116,
  intrinsicsRepo: 'prs-eth/marigold-iid-appearance-v1-1',
  intrinsicsRevision: 'e7280a0a0fc5a0df0b36050882b3d8b77da22fd9',
  normalsRepo: 'prs-eth/marigold-normals-v1-1',
  normalsRevision: '09cfdd258cb281fa006cf1afcd2284376d16687d',
})

export function evaluateLocalPbr(hardware, { model = 'marigold', arch = hardware?.arch || 'x64' } = {}) {
  const unavailable = (reason) => ({ available: false, defaultExecution: 'cloud', reason, gpuIndex: null })
  if (!hardware) return unavailable('checking')
  if (model !== 'marigold') return unavailable('model')
  if (!['win32', 'linux'].includes(hardware.platform) || arch !== 'x64') return unavailable('platform')
  const gpus = Array.isArray(hardware.gpus) ? hardware.gpus : []
  const suitable = gpus.map((gpu, gpuIndex) => ({ gpu, gpuIndex })).filter(({ gpu }) =>
    gpu.vendor === 'nvidia' && gpu.source === 'nvidia-smi' && gpu.vramMb >= LOCAL_PBR.minVramMb,
  )
  if (!suitable.length) return unavailable('gpu')
  const selected = suitable.find(({ gpu }) => Number.isFinite(gpu.vramFreeMb) && gpu.vramFreeMb >= LOCAL_PBR.minFreeVramMb)
  if (!selected) return unavailable('busy')
  if (!(hardware.memory?.totalMb >= LOCAL_PBR.minRamMb) || !(hardware.memory?.freeMb >= LOCAL_PBR.minFreeRamMb)) {
    return unavailable('memory')
  }
  if (!(hardware.disk?.freeGb >= (hardware.localPbr?.prepared ? 1 : LOCAL_PBR.minDiskGb))) return unavailable('disk')
  return { available: true, defaultExecution: 'local', reason: 'ready', gpuIndex: selected.gpuIndex, device: selected.gpu.name }
}

export function workshopCloudProvider(provider) {
  return ['kaggle', 'colab', 'salad', 'private-worker'].includes(provider) ? provider : 'kaggle'
}
