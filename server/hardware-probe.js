/**
 * 本机硬件只读探测器（Host 侧：NVIDIA / Vulkan / OS 显卡 + 内存 + 模型盘余量）。
 *
 * 原则：
 *  1. 严格本地只读探测，绝不向外部服务器上传硬件信息；
 *  2. 兼容无 NVIDIA 显卡设备：
 *     - 优先尝试 `nvidia-smi`（N 卡真机精确显存与驱动）；
 *     - 其次尝试 `vulkaninfo --summary`（跨厂商 AMD/Intel/NVIDIA Vulkan 设备名与核显识别）；
 *     - 再次回退 OS 原生探测（Windows `Win32_VideoController` / macOS `system_profiler` / Linux `lspci`）；
 *     - 内存与磁盘余量由 Node `os` + `fs.statfs` 原生获取，100% 跨平台；
 *  3. 支持 `execFileImpl` / `statfsImpl` 依赖注入，确保无 N 卡环境下也能完整离线单测 N 卡解析分支。
 */

import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { promisify } from 'node:util'

import { evaluateDeviceCapability, matchGpuProfile } from '../shared/gpu-benchmark.js'

const execFileAsync = promisify(execFile)

/** 解析 `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader,nounits` 输出。 */
export function parseNvidiaSmiCsv(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const gpus = []
  for (const line of lines) {
    const parts = line.split(',').map((s) => s.trim())
    if (parts.length < 2) continue
    const name = parts[0]
    const totalMb = Number.parseFloat(parts[1])
    const freeMb = parts[2] ? Number.parseFloat(parts[2]) : null
    const driverVersion = parts[3] || ''
    if (!name) continue
    gpus.push({
      name,
      vendor: 'nvidia',
      isIntegrated: false,
      vramMb: Number.isFinite(totalMb) && totalMb > 0 ? Math.round(totalMb) : null,
      vramFreeMb: Number.isFinite(freeMb) && freeMb >= 0 ? Math.round(freeMb) : null,
      driverVersion,
      source: 'nvidia-smi',
    })
  }
  return gpus
}

/** 解析 `vulkaninfo --summary` 的 Devices 区块，识别核显/独显、设备名、厂商与驱动摘要。 */
export function parseVulkanSummary(stdout) {
  const text = String(stdout ?? '')
  const gpus = []
  const blocks = text.split(/^\s*GPU\d+\s*:/m).slice(1)
  for (const block of blocks) {
    const nameMatch = block.match(/^\s*deviceName\s*=\s*(.+)$/m)
    if (!nameMatch) continue
    const name = nameMatch[1].trim()
    const typeMatch = block.match(/^\s*deviceType\s*=\s*(.+)$/m)
    const vendorMatch = block.match(/^\s*vendorID\s*=\s*(.+)$/m)
    const driverInfoMatch = block.match(/^\s*driverInfo\s*=\s*(.+)$/m)
    const apiMatch = block.match(/^\s*apiVersion\s*=\s*(.+)$/m)
    const deviceType = typeMatch ? typeMatch[1].trim() : ''
    const vendorHex = (vendorMatch ? vendorMatch[1].trim() : '').toLowerCase()
    let vendor = 'unknown'
    if (vendorHex === '0x10de') vendor = 'nvidia'
    else if (vendorHex === '0x1002') vendor = 'amd'
    else if (vendorHex === '0x8086') vendor = 'intel'
    else if (vendorHex === '0x106b') vendor = 'apple'
    gpus.push({
      name,
      vendor,
      isIntegrated: deviceType.includes('INTEGRATED_GPU'),
      vramMb: null,
      driverVersion: driverInfoMatch ? driverInfoMatch[1].trim() : '',
      vulkanApi: apiMatch ? apiMatch[1].trim() : '',
      source: 'vulkaninfo',
    })
  }
  return gpus
}

/**
 * 解析 Windows PowerShell `Get-CimInstance Win32_VideoController` JSON 输出。
 * 注意：WMI `AdapterRAM` 是 32 位无符号整数（最大截断在 ~4GB），绝不将其当作 8G/16G/24G 显卡的真实显存！
 */
export function parseWindowsVideoControllers(stdout) {
  const raw = String(stdout ?? '').trim()
  if (!raw) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list
    .filter((item) => item && typeof item.Name === 'string' && item.Name.trim())
    .map((item) => {
      const pnp = String(item.PNPDeviceID || '').toUpperCase()
      let vendor = 'unknown'
      if (pnp.includes('VEN_10DE')) vendor = 'nvidia'
      else if (pnp.includes('VEN_1002')) vendor = 'amd'
      else if (pnp.includes('VEN_8086')) vendor = 'intel'
      const name = item.Name.trim()
      const lower = name.toLowerCase()
      const isIntegrated =
        lower.includes('graphics') && !lower.includes('rtx') && !lower.includes('rx ')
        || lower.includes('uhd')
        || lower.includes('iris')
        || /880m|890m|780m|760m|680m/i.test(lower)
      return {
        name,
        vendor,
        isIntegrated,
        // WMI AdapterRAM 存在 4GB 溢出截断，统一置 null 交给天梯字典或统一内存公式估算
        vramMb: null,
        driverVersion: String(item.DriverVersion || '').trim(),
        source: 'win32-cim',
      }
    })
}

/** 解析 macOS `system_profiler SPDisplaysDataType -json` 输出。 */
export function parseMacDisplaysJson(stdout) {
  const raw = String(stdout ?? '').trim()
  if (!raw) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const items = Array.isArray(parsed?.SPDisplaysDataType) ? parsed.SPDisplaysDataType : []
  return items
    .filter((item) => item && typeof item.sppci_model === 'string' && item.sppci_model.trim())
    .map((item) => {
      const name = item.sppci_model.trim()
      const isApple = name.toLowerCase().includes('apple')
      const vramRaw = String(item.spdisplays_vram || item.spdisplays_vram_shared || '')
      const gbMatch = vramRaw.match(/(\d+(?:\.\d+)?)\s*GB/i)
      const vramMb = gbMatch ? Math.round(Number(gbMatch[1]) * 1024) : null
      return {
        name,
        vendor: isApple ? 'apple' : 'unknown',
        isIntegrated: isApple,
        vramMb: isApple ? null : vramMb,
        driverVersion: String(item.spdisplays_metal || '').trim(),
        source: 'macos-system-profiler',
      }
    })
}

function pickPrimaryGpu(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  // 优先选带真实显存的独显，再选一般独显，最后选核显（跳过虚拟远程显示适配器）
  const filtered = candidates.filter((g) => !/microsoft basic|parsec|virtual|rdp|vnc/i.test(g.name))
  const pool = filtered.length > 0 ? filtered : candidates
  return [...pool].sort((a, b) => {
    const score = (g) => (g.vramMb ? 100 : 0) + (g.isIntegrated ? 0 : 20) + (g.vendor === 'nvidia' ? 10 : 0)
    return score(b) - score(a)
  })[0]
}

/**
 * 创建本机硬件探测服务（带短期缓存，避免频繁轮询反复拉起子进程）。
 */
export function createHardwareProbe({
  execFileImpl = execFileAsync,
  statfsImpl = statfs,
  platform = process.platform,
  cpusFn = os.cpus,
  totalmemFn = os.totalmem,
  freememFn = os.freemem,
  cacheTtlMs = 30_000,
  now = Date.now,
} = {}) {
  let cached = null
  let cachedAt = 0
  let inflight = null

  async function runCmd(cmd, args, timeout = 3500) {
    try {
      const res = await execFileImpl(cmd, args, {
        timeout,
        windowsHide: true,
        maxBuffer: 512 * 1024,
      })
      return String(res?.stdout ?? '')
    } catch {
      return ''
    }
  }

  async function readDiskFreeGb(targetDir) {
    if (!targetDir || typeof statfsImpl !== 'function') return null
    try {
      const fsInfo = await statfsImpl(targetDir)
      const availBlocks = Number(fsInfo?.bavail)
      const bsize = Number(fsInfo?.bsize)
      if (!Number.isFinite(availBlocks) || !Number.isFinite(bsize) || bsize <= 0) return null
      return Math.round(((availBlocks * bsize) / (1024 * 1024 * 1024)) * 10) / 10
    } catch {
      return null
    }
  }

  async function probe({ modelsDir = '', force = false } = {}) {
    if (!force && cached && now() - cachedAt < cacheTtlMs && cached.modelsDir === modelsDir) {
      return cached.result
    }
    if (!force && inflight) return inflight

    inflight = (async () => {
      const cpuList = cpusFn() || []
      const cpuModel = cpuList[0]?.model?.trim() || 'Unknown CPU'
      const cpuCores = cpuList.length || 0
      const systemRamMb = Math.round(totalmemFn() / (1024 * 1024))
      const systemFreeRamMb = Math.round(freememFn() / (1024 * 1024))
      const diskFreeGb = await readDiskFreeGb(modelsDir)

      const sources = []
      let detectedGpus = []

      // 1. NVIDIA nvidia-smi（最精准：直出显存总容量、空闲显存与驱动）
      const smiOut = await runCmd('nvidia-smi', [
        '--query-gpu=name,memory.total,memory.free,driver_version',
        '--format=csv,noheader,nounits',
      ])
      const smiGpus = parseNvidiaSmiCsv(smiOut)
      if (smiGpus.length > 0) {
        sources.push('nvidia-smi')
        detectedGpus = smiGpus
      }

      // 2. Vulkan（非 N 卡 / 核显主力探测路径，如 AMD Radeon 880M）
      if (detectedGpus.length === 0) {
        const vkOut = await runCmd('vulkaninfo', ['--summary'])
        const vkGpus = parseVulkanSummary(vkOut)
        if (vkGpus.length > 0) {
          sources.push('vulkaninfo')
          detectedGpus = vkGpus
        }
      }

      // 3. OS 兜底（Windows CIM / macOS system_profiler）
      if (detectedGpus.length === 0 && platform === 'win32') {
        const cimOut = await runCmd('powershell', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, PNPDeviceID | ConvertTo-Json -Compress',
        ])
        const winGpus = parseWindowsVideoControllers(cimOut)
        if (winGpus.length > 0) {
          sources.push('win32-cim')
          detectedGpus = winGpus
        }
      } else if (detectedGpus.length === 0 && platform === 'darwin') {
        const macOut = await runCmd('system_profiler', ['SPDisplaysDataType', '-json'])
        const macGpus = parseMacDisplaysJson(macOut)
        if (macGpus.length > 0) {
          sources.push('macos-system-profiler')
          detectedGpus = macGpus
        }
      }

      const primaryGpu = pickPrimaryGpu(detectedGpus)
      const profile = matchGpuProfile({
        gpuName: primaryGpu?.name || '',
        vramMb: primaryGpu?.vramMb ?? null,
        systemRamMb,
        vendor: primaryGpu?.vendor || '',
        isIntegrated: primaryGpu?.isIntegrated,
      })
      const evaluation = evaluateDeviceCapability(profile, { diskFreeGb })

      const result = {
        probedAt: new Date(now()).toISOString(),
        privacy: 'local-only',
        platform,
        cpu: { model: cpuModel, cores: cpuCores },
        memory: {
          totalMb: systemRamMb,
          freeMb: systemFreeRamMb,
          totalGb: Math.round((systemRamMb / 1024) * 10) / 10,
        },
        disk: {
          modelsDir: modelsDir || null,
          freeGb: diskFreeGb,
        },
        gpus: detectedGpus,
        primaryGpu,
        sources,
        hasNvidiaSmi: sources.includes('nvidia-smi'),
        evaluation,
      }

      cached = { modelsDir, result }
      cachedAt = now()
      return result
    })()

    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  return {
    probe,
    getCached() {
      return cached?.result ?? null
    },
  }
}
