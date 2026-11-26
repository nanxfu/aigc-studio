/**
 * 本机 GPU 能力探测（只读、不启动长驻进程）。
 *
 * 优先用 `sd-server --list-devices`：它加载的是实际推理后端，能同时告诉我们
 * Vulkan / CPU 设备与驱动自报能力，避免依赖 `vulkaninfo` 的文本格式差异。
 * `vulkaninfo --summary` 作为没有 sd-server 时的降级探测。
 *
 * 约束：
 *  - 单次探测有超时，失败返回结构化错误，不抛给路由层；
 *  - 不读取 / 回传模型权重内容，只返回路径、字节数与磁盘余量。
 *
 * @module server/local-gpu/probe
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat, statfs } from 'node:fs/promises'
import { freemem, totalmem } from 'node:os'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { parseNvidiaSmiCsv } from '../hardware-probe.js'

const execFileAsync = promisify(execFile)

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isIntegratedGpuName(name) {
  const text = String(name ?? '').toLowerCase()
  return /(radeon(?:\(tm\))?\s*(?:780m|760m|740m|680m|660m|880m|890m)|iris|uhd graphics|intel.*graphics|apple m\d|integrated|apu)/i.test(text)
}

function parseDeviceLines(stdout) {
  const devices = []
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || !line.includes('\t')) continue
    const [id, ...rest] = line.split('\t')
    const name = rest.join('\t').trim()
    if (!/^(Vulkan|CUDA|ROCm|CPU|Metal)\d*$/i.test(id.trim())) continue
    devices.push({
      id: id.trim(),
      name,
      backend: id.trim().replace(/\d+$/, '').toLowerCase(),
      isIntegrated: isIntegratedGpuName(name),
    })
  }
  return devices
}

function parseVulkanInfoSummary(stdout) {
  const devices = []
  const byId = new Map()
  let current = null
  for (const raw of String(stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    const gpu = line.match(/^GPU(\d+):?$/i)
    if (gpu) {
      current = { id: `Vulkan${gpu[1]}`, name: '', backend: 'vulkan' }
      devices.push(current)
      byId.set(current.id, current)
      continue
    }
    const api = line.match(/^apiVersion\s*=\s*(.+)$/i)
    if (api && current) current.apiVersion = api[1].trim()
    const driver = line.match(/^driverVersion\s*=\s*(.+)$/i)
    if (driver && current) current.driverVersion = driver[1].trim()
    const name = line.match(/^deviceName\s*=\s*(.+)$/i)
    if (name && current) current.name = name[1].trim()
    const heap = line.match(/^memoryHeaps\[(\d+)\]:?$/i)
    if (heap && current) {
      current.memoryHeaps = current.memoryHeaps ?? []
      current.memoryHeaps.push({ index: Number(heap[1]), sizeMb: null, deviceLocal: false })
      continue
    }
    if (/^size\s*=\s*0x[0-9a-f]+/i.test(line) && current?.memoryHeaps?.length) {
      const size = line.match(/^size\s*=\s*0x([0-9a-f]+)/i)
      const heapItem = current.memoryHeaps[current.memoryHeaps.length - 1]
      heapItem.sizeMb = size ? Math.round(Number.parseInt(size[1], 16) / 1024 / 1024) : null
      continue
    }
    if (/^DEVICE_LOCAL_BIT$/i.test(line) && current?.memoryHeaps?.length) {
      current.memoryHeaps[current.memoryHeaps.length - 1].deviceLocal = true
    }
  }
  for (const device of devices) {
    const heaps = Array.isArray(device.memoryHeaps) ? device.memoryHeaps : []
    const deviceLocal = heaps.filter((heap) => heap.deviceLocal && Number.isFinite(heap.sizeMb))
    const pool = deviceLocal.length > 0 ? deviceLocal : heaps.filter((heap) => Number.isFinite(heap.sizeMb))
    device.vramMb = pool.length > 0 ? Math.max(...pool.map((heap) => heap.sizeMb)) : null
    device.isIntegrated = isIntegratedGpuName(device.name)
  }
  return devices.filter((item) => item.name)
}

/**
 * 双显卡笔记本的设备选择：独显优先、NVIDIA / AMD 优先、真实显存大的优先，
 * 软件渲染与 CPU 设备永不作为推理设备。
 */
export function pickPreferredDevice(devices) {
  const list = (Array.isArray(devices) ? devices : []).filter((device) => {
    if (!device || typeof device.name !== 'string' || !device.name.trim()) return false
    if (/llvmpipe|swiftshader|lavapipe|software|microsoft basic|virtual/i.test(device.name)) return false
    return ['vulkan', 'cuda', 'rocm', 'metal'].includes(String(device.backend || '').toLowerCase())
  })
  if (list.length === 0) return null
  const isIntegrated = (device) => device.isIntegrated === true || isIntegratedGpuName(device.name)
  const vendorScore = (device) => {
    const name = device.name.toLowerCase()
    const backend = String(device.backend || '').toLowerCase()
    if (backend === 'cuda' || /nvidia|geforce|rtx|quadro|tesla/i.test(name)) return 4
    if (backend === 'rocm' || /amd|radeon|rx\s/i.test(name)) return 3
    if (backend === 'metal' || /apple/i.test(name)) return 3
    return 1
  }
  return [...list].sort((a, b) => {
    const integrated = Number(isIntegrated(a)) - Number(isIntegrated(b))
    if (integrated !== 0) return integrated
    const vendor = vendorScore(b) - vendorScore(a)
    if (vendor !== 0) return vendor
    const vram = (Number(b.vramMb) || 0) - (Number(a.vramMb) || 0)
    if (vram !== 0) return vram
    return String(a.id).localeCompare(String(b.id))
  })[0]
}

async function execText(command, args, { timeoutMs = 15000, env = process.env } = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env,
    })
    return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch (error) {
    return {
      ok: false,
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? '',
      error: error?.message ?? String(error),
    }
  }
}

async function fileInfo(path) {
  if (!path) return { path: '', exists: false, bytes: null }
  try {
    const info = await stat(path)
    return { path, exists: info.isFile(), bytes: info.size }
  } catch {
    return { path, exists: existsSync(path), bytes: null }
  }
}

async function freeDiskBytes(path) {
  if (!path || typeof statfs !== 'function') return null
  try {
    const info = await statfs(dirname(path))
    return { freeBytes: Number(info.bavail) * Number(info.bsize), totalBytes: Number(info.blocks) * Number(info.bsize) }
  } catch {
    return null
  }
}

/**
 * 用 sd-server 自身列出设备（真实推理后端）。
 *
 * @param {string} serverPath
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv }} [options]
 */
export async function listDevicesWithServer(serverPath, { timeoutMs = 15000, env = process.env } = {}) {
  if (!serverPath || !existsSync(serverPath)) {
    return { ok: false, devices: [], source: 'sd-server', error: 'sd-server 不存在' }
  }
  const result = await execText(serverPath, ['--list-devices'], { timeoutMs, env })
  const devices = parseDeviceLines(result.stdout)
  if (!result.ok || devices.length === 0) {
    return {
      ok: false,
      devices,
      source: 'sd-server',
      error: result.error ?? result.stderr?.slice(-1200) ?? '没有解析到设备',
    }
  }
  return { ok: true, devices, source: 'sd-server', raw: result.stdout.slice(-4000) }
}

/** `vulkaninfo --summary` 降级探测。 */
export async function listDevicesWithVulkanInfo({ timeoutMs = 15000, env = process.env } = {}) {
  const result = await execText('vulkaninfo', ['--summary'], { timeoutMs, env })
  const devices = parseVulkanInfoSummary(`${result.stdout}\n${result.stderr}`)
  if (!result.ok || devices.length === 0) {
    return {
      ok: false,
      devices,
      source: 'vulkaninfo',
      error: result.error ?? 'vulkaninfo 不可用或没有解析到设备',
    }
  }
  return { ok: true, devices, source: 'vulkaninfo', raw: `${result.stdout}\n${result.stderr}`.slice(-4000) }
}

function enrichDevices(devices, infoDevices) {
  const byName = new Map(
    (Array.isArray(infoDevices) ? infoDevices : [])
      .map((device) => [String(device.name || '').trim().toLowerCase(), device])
      .filter(([name]) => name),
  )
  return (Array.isArray(devices) ? devices : []).map((device) => {
    const info = byName.get(String(device.name || '').trim().toLowerCase())
    return {
      ...device,
      vramMb: Number.isFinite(Number(device.vramMb)) ? device.vramMb : (info?.vramMb ?? null),
      isIntegrated: device.isIntegrated === true || info?.isIntegrated === true || isIntegratedGpuName(device.name),
      apiVersion: device.apiVersion ?? info?.apiVersion ?? null,
      driverVersion: device.driverVersion ?? info?.driverVersion ?? null,
    }
  })
}

/**
 * 综合探测：路径、设备、内存与磁盘。
 *
 * @param {object} config normalizeLocalGpuConfig 的输出
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 */
export async function probeLocalGpu(config, { env = process.env, timeoutMs = 15000 } = {}) {
  const safeConfig = isPlainObject(config) ? config : {}
  const errors = []
  const warnings = []
  const server = await fileInfo(safeConfig.serverPath)
  const model = await fileInfo(safeConfig.modelPath)
  const vae = await fileInfo(safeConfig.vaePath)
  if (!server.exists) errors.push('sd-server 可执行文件不存在')
  if (safeConfig.modelPath && !model.exists) warnings.push('当前模型文件不存在，可从顶栏模型卡重新下载')
  if (safeConfig.vaePath && !vae.exists) warnings.push('VAE 文件不存在，将回退到模型内置 VAE')
  if (model.exists && model.bytes !== null && model.bytes < 512 * 1024 * 1024) {
    warnings.push('模型小于 512 MB，可能不是完整的扩散权重')
  }

  let devicesResult = safeConfig.serverPath
    ? await listDevicesWithServer(safeConfig.serverPath, { timeoutMs, env })
    : { ok: false, devices: [], source: 'sd-server', error: 'sd-server 未配置' }
  const infoDevices = await listDevicesWithVulkanInfo({ timeoutMs: Math.min(timeoutMs, 4000), env })
  if (devicesResult.devices?.length) {
    devicesResult = {
      ...devicesResult,
      devices: enrichDevices(devicesResult.devices, infoDevices.devices),
    }
  }
  if (!devicesResult.ok) {
    if (infoDevices.ok) devicesResult = infoDevices
    else errors.push(`无法列出 GPU 设备：${devicesResult.error ?? infoDevices.error ?? '未知错误'}`)
  }

  let gpu = pickPreferredDevice(devicesResult.devices)
  if (gpu?.backend === 'vulkan' && !Number.isFinite(Number(gpu.vramMb))) {
    const smi = await execText('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.free,driver_version',
      '--format=csv,noheader,nounits',
    ], { timeoutMs, env })
    const nvidia = parseNvidiaSmiCsv(smi.stdout)
    const match = nvidia.find((item) => String(item.name).toLowerCase() === String(gpu.name).toLowerCase()) || nvidia[0]
    if (match) {
      gpu = {
        ...gpu,
        vendor: 'nvidia',
        vramMb: match.vramMb,
        vramFreeMb: match.vramFreeMb,
        driverVersion: match.driverVersion || gpu.driverVersion,
      }
    }
  }
  if (devicesResult.ok && !gpu) errors.push('没有找到可用的 Vulkan / CUDA 设备')

  const disk = await freeDiskBytes(safeConfig.modelPath)
  if (disk && model.bytes !== null && disk.freeBytes < model.bytes) {
    errors.push('模型所在磁盘余量不足')
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    source: devicesResult.source,
    server,
    model,
    vae,
    disk,
    devices: devicesResult.devices,
    gpu,
    memory: {
      totalBytes: totalmem(),
      freeBytes: freemem(),
    },
    config: {
      serverPath: safeConfig.serverPath ?? '',
      modelPath: safeConfig.modelPath ?? '',
      vaePath: safeConfig.vaePath ?? '',
      paramsBackend: safeConfig.paramsBackend ?? 'auto',
      threads: safeConfig.threads ?? 0,
    },
  }
}

export const __test = { parseDeviceLines, parseVulkanInfoSummary, fileInfo, freeDiskBytes, enrichDevices }

