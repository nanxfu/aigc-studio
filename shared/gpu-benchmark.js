/**
 * AI 生图显卡天梯基准、硬件匹配与本地模型适配评估（单源纯逻辑：Host / Web Client / 官网共用）。
 *
 * 设计约束：
 *  - 纯数据与纯函数，严禁 import `node:*`，以便桌面端渲染进程与 Astro 官网直接复用；
 *  - 模型显存与速度标尺对齐仓库 `models/*.json` 的实测 `measured` 字段；
 *  - 采用「显存解锁度（硬门槛）+ 推理速度倍率（相对免费云端 T4 = 1.0x）」双维度评估，
 *    避免单维黑盒跑分造成“4060 8G 分比 3060 12G 高却跑不了大模型”的误导；
 *  - 静态基准表 + 本地离线匹配，不依赖远端榜单服务器，也不上报用户隐私硬件信息。
 */

import { localGpuAssetOf } from './local-gpu-assets.js'

/** @typedef {'fp16-ready' | 'gguf-planned' | 'tight' | 'cloud-recommended'} ModelFitStatus */

/**
 * 内置开源生图模型实测标尺（数值对齐 `models/*.json` 的 `measured` 与 `pipeline`）。
 * `ggufVramMb` / `ggufDownloadGb` 用于评估 Vulkan / CUDA GGUF Q4 量化部署门槛。
 * `ggufVerified` 标明已完成 `local-gpu` 真机闭环验证的模型。
 */
export const BENCHMARK_MODELS = Object.freeze([
  Object.freeze({
    id: 'realvisxl-lightning',
    label: 'RealVisXL V5 Lightning',
    params: '3.5B (Q4_K)',
    peakVramMb: 7200,
    // 880M (0.28x T4) 实测 43.76s → 折算 T4 基准约 12.3s
    steadySeconds: 12.3,
    downloadGb: 6.46,
    ggufVramMb: 3100,
    ggufDownloadGb: 2.61,
    ggufVerified: true,
    license: 'OpenRAIL++-M',
    commercial: true,
    zhSupport: false,
    kaggleReady: true,
  }),
  Object.freeze({
    id: 'flux2-klein-4b',
    label: 'FLUX.2 Klein 4B',
    params: '3.88B',
    peakVramMb: 7929,
    steadySeconds: 10.24,
    downloadGb: 16.0,
    ggufVramMb: 5400,
    ggufDownloadGb: 5.5,
    license: 'Apache-2.0',
    commercial: true,
    zhSupport: true,
    kaggleReady: true,
  }),
  Object.freeze({
    id: 'anima-turbo-v1.1',
    label: 'Anima Turbo v1.1',
    params: '2B DiT',
    peakVramMb: 8469,
    steadySeconds: 21.56,
    downloadGb: 5.25,
    ggufVramMb: 4800,
    ggufDownloadGb: 3.2,
    license: 'Non-Commercial',
    commercial: false,
    zhSupport: false,
    kaggleReady: true,
  }),
  Object.freeze({
    id: 'sana-sprint-1.6b',
    label: 'SANA-Sprint 1.6B',
    params: '1.6B',
    peakVramMb: 10329,
    steadySeconds: 4.07,
    downloadGb: 9.07,
    ggufVramMb: 5200,
    ggufDownloadGb: 3.8,
    license: 'Apache-2.0',
    commercial: true,
    zhSupport: false,
    kaggleReady: true,
  }),
  Object.freeze({
    id: 'sdxl-lightning',
    label: 'SDXL Lightning',
    params: '3.5B + LoRA',
    peakVramMb: 10347,
    steadySeconds: 6.2,
    downloadGb: 6.78,
    ggufVramMb: 5600,
    ggufDownloadGb: 3.4,
    license: 'OpenRAIL++',
    commercial: true,
    zhSupport: false,
    kaggleReady: true,
  }),
  Object.freeze({
    id: 'z-image-turbo',
    label: 'Z-Image Turbo',
    params: '6B S3-DiT',
    peakVramMb: 12232,
    steadySeconds: 30.66,
    downloadGb: 30.64,
    ggufVramMb: 7400,
    ggufDownloadGb: 6.5,
    license: 'Apache-2.0',
    commercial: true,
    zhSupport: true,
    kaggleReady: false,
  }),
  Object.freeze({
    id: 'qwen-image-2.1',
    label: 'Qwen-Image 2.1',
    params: '7B DiT',
    peakVramMb: 16764,
    steadySeconds: 43.68,
    downloadGb: 30.26,
    ggufVramMb: 11200,
    ggufDownloadGb: 11.5,
    license: 'Qwen Research',
    commercial: false,
    zhSupport: true,
    kaggleReady: false,
  }),
  Object.freeze({
    id: 'flux2-klein-9b',
    label: 'FLUX.2 Klein 9B',
    params: '9.08B',
    peakVramMb: 18107,
    steadySeconds: 130.87,
    downloadGb: 34.7,
    ggufVramMb: 11800,
    ggufDownloadGb: 12.0,
    license: 'FLUX Non-Commercial',
    commercial: false,
    zhSupport: true,
    kaggleReady: false,
  }),
])

/**
 * 常见显卡 / 核显 / Apple Silicon / 免费云端算力基准天梯表。
 * 排序与算力评估规则：
 *  - `vramGb`：可用显存（统一内存设备取安全可分配共享显存预算）；
 *  - `speedVsT4`：相对免费云端 NVIDIA T4 的典型推理吞吐倍率（T4 = 1.0x）；
 *  - `percentile`：创作者设备估算分位（0~99，仅作静态天梯参照）；
 *  - `matchKeywords`：用于匹配 `nvidia-smi` / `vulkaninfo` / WebGPU / WMI 设备名（小写子串或正则字符串）。
 */
export const GPU_BENCHMARKS = Object.freeze([
  Object.freeze({
    id: 'rtx-5090-32g',
    name: 'NVIDIA RTX 5090 (32GB)',
    shortName: 'RTX 5090',
    vendor: 'nvidia',
    kind: 'discrete',
    vramGb: 32,
    speedVsT4: 5.8,
    backend: 'CUDA',
    percentile: 99,
    matchKeywords: ['5090'],
    note: '全精度无压力通吃 7 款模型与未来视频/3D 权重',
  }),
  Object.freeze({
    id: 'rtx-4090-24g',
    name: 'NVIDIA RTX 4090 (24GB)',
    shortName: 'RTX 4090',
    vendor: 'nvidia',
    kind: 'discrete',
    vramGb: 24,
    speedVsT4: 4.5,
    backend: 'CUDA',
    percentile: 98,
    matchKeywords: ['4090'],
    note: '消费级生图旗舰，全模型 1024px 秒级出图',
  }),
  Object.freeze({
    id: 'rtx-3090-24g',
    name: 'NVIDIA RTX 3090 / 3090 Ti (24GB)',
    shortName: 'RTX 3090',
    vendor: 'nvidia',
    kind: 'discrete',
    vramGb: 24,
    speedVsT4: 2.6,
    backend: 'CUDA',
    percentile: 95,
    matchKeywords: ['3090'],
    note: '24GB 大显存性价比标杆，7 款模型全部本地可跑',
  }),
  Object.freeze({
    id: 'rx-7900-xtx-24g',
    name: 'AMD Radeon RX 7900 XTX (24GB)',
    shortName: 'RX 7900 XTX',
    vendor: 'amd',
    kind: 'discrete',
    vramGb: 24,
    speedVsT4: 1.9,
    backend: 'Vulkan',
    percentile: 93,
    matchKeywords: ['7900 xtx', '7900xtx'],
    note: '24GB 显存充裕，规划走 Vulkan GGUF 零 CUDA 配置运行',
  }),
  Object.freeze({
    id: 'rtx-4080-16g',
    name: 'NVIDIA RTX 4080 / 4080 Super (16GB)',
    shortName: 'RTX 4080',
    vendor: 'nvidia',
    kind: 'discrete',
    vramGb: 16,
    speedVsT4: 3.4,
    backend: 'CUDA',
    percentile: 92,
    matchKeywords: ['4080', '5080'],
    note: '极速跑通前 5 款主流模型，9B 配合量化流畅运行',
  }),
  Object.freeze({
    id: 'rtx-4070-ti-super-16g',
    name: 'NVIDIA RTX 4070 Ti Super (16GB)',
    shortName: 'RTX 4070 Ti S',
    vendor: 'nvidia',
    kind: 'discrete',
    vramGb: 16,
    speedVsT4: 2.8,
    backend: 'CUDA',
    percentile: 89,
    matchKeywords: ['4070 ti super'],
    note: '16GB 黄金显存，兼顾原生速度与大模型容量',
  }),
  Object.freeze({
    id: 'rtx-4060-ti-16g',
    name: 'NVIDIA RTX 4060 Ti (16GB)',
    shortName: 'RTX 4060 Ti 16G',
    vendor: 'nvidia',
    kind: 'discrete',
    vramGb: 16,
    speedVsT4: 1.85,
    backend: 'CUDA',
    percentile: 83,
    matchKeywords: ['4060 ti 16g', '4060 ti (16'],
    note: '16GB 大显存优势明显，可解锁 Z-Image 与 Qwen/Klein 量化档',
  }),
  Object.freeze({
    id: 'apple-m-max-36g',
    name: 'Apple Silicon M2 / M3 / M4 Max (36GB+ 统一内存)',
    shortName: 'Apple Max 36G+',
    vendor: 'apple',
    kind: 'unified',
    vramGb: 24,
    speedVsT4: 1.25,
    backend: 'Metal',
    percentile: 86,
    matchKeywords: ['m3 max', 'm4 max', 'm2 max', 'm1 max', 'm2 ultra', 'm3 ultra'],
    note: '统一内存充裕可装大模型，单步推理带宽低于 N 卡独显',
  }),
  Object.freeze({
    id: 'cloud-kaggle-2xt4',
    name: '云端基线 · Kaggle 2×Tesla T4 (30GB 免费额度)',
    shortName: 'Kaggle 2×T4 (¥0)',
    vendor: 'cloud',
    kind: 'cloud',
    isCloudRef: true,
    vramGb: 30,
    speedVsT4: 1.0,
    backend: 'Cloud CUDA',
    percentile: 80,
    matchKeywords: ['tesla t4'],
    note: 'AIGC Studio 内置免费云端参考线：每周 30 小时，本机不够可一键接管',
  }),
  Object.freeze({
    id: 'rtx-4070-12g',
    name: 'NVIDIA RTX 4070 / 4070 Super (12GB)',
    shortName: 'RTX 4070 12G',
    vendor: 'nvidia',
    kind: 'discrete',
    vramGb: 12,
    speedVsT4: 2.35,
    backend: 'CUDA',
    percentile: 78,
    matchKeywords: ['4070 super', '4070 ti', '4070'],
    note: '12GB 甜点卡，日常生图速度是免费 T4 的两倍以上',
  }),
  Object.freeze({
    id: 'rtx-3060-12g',
    name: 'NVIDIA RTX 3060 (12GB)',
    shortName: 'RTX 3060 12G',
    vendor: 'nvidia',
    kind: 'discrete',
    vramGb: 12,
    speedVsT4: 1.25,
    backend: 'CUDA',
    percentile: 68,
    matchKeywords: ['3060 12g', 'rtx 3060'],
    note: 'AI 绘图常青树：12GB 显存能比 8G 新卡多跑几款主流架构',
  }),
  Object.freeze({
    id: 'apple-m-pro-18g',
    name: 'Apple Silicon M1 / M2 / M3 / M4 Pro (18–24GB 统一内存)',
    shortName: 'Apple Pro 18G+',
    vendor: 'apple',
    kind: 'unified',
    vramGb: 14,
    speedVsT4: 0.72,
    backend: 'Metal',
    percentile: 64,
    matchKeywords: ['m4 pro', 'm3 pro', 'm2 pro', 'm1 pro'],
    note: '能安静在本地跑轻量或量化模型，重型出图推荐切 Kaggle',
  }),
  Object.freeze({
    id: 'rtx-4060-8g',
    name: 'NVIDIA RTX 4060 / 4060 Ti (8GB)',
    shortName: 'RTX 4060 8G',
    vendor: 'nvidia',
    kind: 'discrete',
    vramGb: 8,
    speedVsT4: 1.65,
    backend: 'CUDA',
    percentile: 58,
    matchKeywords: ['4060 ti', '4060', '4070 laptop'],
    note: '单卡速度不慢，但 8GB 显存是核心卡点，适合 Klein 4B 与 GGUF 量化',
  }),
  Object.freeze({
    id: 'rtx-3060-ti-8g',
    name: 'NVIDIA RTX 3070 / 3060 Ti / 3050 (8GB)',
    shortName: 'RTX 3070 / 3060 Ti',
    vendor: 'nvidia',
    kind: 'discrete',
    vramGb: 8,
    speedVsT4: 1.35,
    backend: 'CUDA',
    percentile: 52,
    matchKeywords: ['3070', '3060 ti', '3050', '3080', '2080', '2070'],
    note: '8GB 门槛线：可直接跑通 8G 档模型，10G+ 模型建议走 GGUF 或云端',
  }),
  Object.freeze({
    id: 'rx-7600-8g',
    name: 'AMD Radeon RX 7600 / 6600 (8GB)',
    shortName: 'RX 7600 8G',
    vendor: 'amd',
    kind: 'discrete',
    vramGb: 8,
    speedVsT4: 0.85,
    backend: 'Vulkan',
    percentile: 46,
    matchKeywords: ['7600', '7700', '7800', '6600', '6700', '6800'],
    note: '非 N 卡推荐走 Vulkan + GGUF 路线，免折腾 ROCm/DirectML',
  }),
  Object.freeze({
    id: 'amd-radeon-880m-apu',
    name: 'AMD Radeon 880M / 890M (32GB 统一内存核显)',
    shortName: 'Radeon 880M / 890M',
    vendor: 'amd',
    kind: 'integrated',
    vramGb: 12,
    speedVsT4: 0.28,
    backend: 'Vulkan',
    percentile: 42,
    matchKeywords: ['890m', '880m'],
    note: '共享内存大容量可稳态跑 GGUF 量化与 WebGPU 抠图；重型出图建议一键切云端',
  }),
  Object.freeze({
    id: 'apple-m-base-16g',
    name: 'Apple Silicon M1–M4 (16GB 统一内存)',
    shortName: 'Apple M 16G',
    vendor: 'apple',
    kind: 'unified',
    vramGb: 10,
    speedVsT4: 0.42,
    backend: 'Metal',
    percentile: 40,
    matchKeywords: ['apple gpu', 'apple m4', 'apple m3', 'apple m2', 'apple m1'],
    note: '适合本机端侧视觉/抠图与小步数轻量图，重型任务推荐云端',
  }),
  Object.freeze({
    id: 'rtx-2060-6g',
    name: 'NVIDIA RTX 3060 Laptop / 2060 / GTX 1660 (6GB)',
    shortName: '6GB 入门独显',
    vendor: 'nvidia',
    kind: 'discrete',
    vramGb: 6,
    speedVsT4: 0.78,
    backend: 'CUDA',
    percentile: 32,
    matchKeywords: ['2060', '1660', '1650', '3050 laptop', '1060'],
    note: '6GB 显存跑原生全精度吃紧，适合 GGUF 量化轻量跑或直接切免费云端 T4',
  }),
  Object.freeze({
    id: 'amd-radeon-780m-apu',
    name: 'AMD Radeon 780M / 760M / 680M (核显)',
    shortName: 'Radeon 780M / 680M',
    vendor: 'amd',
    kind: 'integrated',
    vramGb: 8,
    speedVsT4: 0.22,
    backend: 'Vulkan',
    percentile: 28,
    matchKeywords: ['780m', '760m', '680m', 'radeon(tm) graphics', 'radeon graphics'],
    note: '本机 WebGPU 抠图与轻量工具流畅，生图主力建议挂载免费 Kaggle 双卡',
  }),
  Object.freeze({
    id: 'intel-arc-igpu',
    name: 'Intel Arc / Iris Xe / UHD 核显及通用集成显卡',
    shortName: 'Intel 核显 / 轻薄本',
    vendor: 'intel',
    kind: 'integrated',
    vramGb: 4,
    speedVsT4: 0.14,
    backend: 'WebGPU / 云端',
    percentile: 18,
    matchKeywords: ['intel', 'iris', 'uhd graphics', 'arc(tm)', 'arc graphics'],
    note: '完美胜任桌面工作台、本机 SVG/像素工具与免费云端双 T4 远程生图',
  }),
])

/** 手动下拉可选列表（排除云端参照线，保留最直观的消费级档位）。 */
export const SELECTABLE_GPU_PRESETS = Object.freeze(
  GPU_BENCHMARKS.filter((entry) => !entry.isCloudRef),
)

const GPU_ENTRY_EN = Object.freeze({
  'rtx-5090-32g': { note: 'Runs all 7 models at full precision with headroom for future video/3D weights' },
  'rtx-4090-24g': { note: 'Consumer flagship: 1024px output in seconds across every built-in model' },
  'rtx-3090-24g': { note: '24GB VRAM sweet spot: runs all 7 models locally' },
  'rx-7900-xtx-24g': { note: '24GB VRAM planned via Vulkan GGUF without CUDA setup' },
  'rtx-4080-16g': { note: 'Fast across the first 5 models; 9B runs smoothly with quantization' },
  'rtx-4070-ti-super-16g': { note: 'Balanced 16GB VRAM for fast native speeds and large models' },
  'rtx-4060-ti-16g': { note: '16GB VRAM unlocks Z-Image and quantized Qwen / Klein models' },
  'apple-m-max-36g': {
    name: 'Apple Silicon M2 / M3 / M4 Max (36GB+ Unified)',
    note: 'Generous unified memory fits large models, though bandwidth is lower than discrete NVIDIA GPUs',
  },
  'cloud-kaggle-2xt4': {
    name: 'Cloud Baseline · Kaggle 2×Tesla T4 (30GB Free)',
    shortName: 'Kaggle 2×T4 ($0)',
    note: 'Built-in free cloud baseline: 30 hrs/week, one-click switch when local VRAM is insufficient',
  },
  'rtx-4070-12g': { note: '12GB sweet-spot GPU: over 2× faster than free cloud T4' },
  'rtx-3060-12g': { note: '12GB VRAM runs more architectures locally than newer 8GB cards' },
  'apple-m-pro-18g': {
    name: 'Apple Silicon M1 / M2 / M3 / M4 Pro (18–24GB Unified)',
    note: 'Quiet local runs for lightweight/quantized models; switch to Kaggle for heavy workloads',
  },
  'rtx-4060-8g': { note: 'Fast compute, limited by 8GB VRAM; best for Klein 4B and GGUF Q4' },
  'rtx-3060-ti-8g': { note: '8GB threshold: runs 8GB-class models directly; use GGUF or cloud for 10GB+ models' },
  'rx-7600-8g': { note: 'Recommended on Vulkan + GGUF without ROCm or DirectML setup' },
  'amd-radeon-880m-apu': {
    name: 'AMD Radeon 880M / 890M (32GB Unified iGPU)',
    note: 'Large shared memory runs GGUF Q4 and WebGPU cutout reliably; use cloud for heavy models',
  },
  'apple-m-base-16g': {
    name: 'Apple Silicon M1–M4 (16GB Unified)',
    note: 'Great for local vision/cutout and small step models; use cloud for heavy generation',
  },
  'rtx-2060-6g': {
    shortName: '6GB Entry dGPU',
    note: 'Tight for full-precision weights; suited for GGUF Q4 or free cloud T4',
  },
  'amd-radeon-780m-apu': {
    name: 'AMD Radeon 780M / 760M / 680M (iGPU)',
    note: 'Smooth local WebGPU cutout & tools; mount free Kaggle dual-T4 for generation',
  },
  'intel-arc-igpu': {
    name: 'Intel Arc / Iris Xe / UHD & Integrated GPUs',
    shortName: 'Intel iGPU / Ultrabook',
    backend: 'WebGPU / Cloud',
    note: 'Runs desktop UI, local SVG/pixel tools, and remote Kaggle 30GB generation effortlessly',
  },
})

export function localizeGpuEntry(entry, locale = 'zh') {
  if (!entry || locale !== 'en') return entry
  const patch = GPU_ENTRY_EN[entry.id]
  return patch ? { ...entry, ...patch } : entry
}

export function benchmarkById(id) {
  if (typeof id !== 'string' || !id.trim()) return null
  return GPU_BENCHMARKS.find((item) => item.id === id.trim()) ?? null
}

function inferVendor(rawName = '', rawVendor = '') {
  const s = `${rawVendor} ${rawName}`.toLowerCase()
  if (s.includes('nvidia') || s.includes('geforce') || s.includes('rtx') || s.includes('gtx') || s.includes('tesla')) {
    return 'nvidia'
  }
  if (s.includes('amd') || s.includes('radeon') || s.includes('ati')) return 'amd'
  if (s.includes('apple') || s.includes('m1') || s.includes('m2') || s.includes('m3') || s.includes('m4')) return 'apple'
  if (s.includes('intel') || s.includes('iris') || s.includes('uhd') || s.includes('arc')) return 'intel'
  return 'unknown'
}

/**
 * 估算统一内存/核显设备的可用显存预算（GB）。
 * 物理逻辑：Windows/macOS 统一内存需给 OS 留出基本空间，通常可安全划出总内存的 40%~50% 给生图。
 */
export function estimateUnifiedVramGb(systemRamGb) {
  const ram = Number(systemRamGb)
  if (!Number.isFinite(ram) || ram <= 0) return 4
  if (ram >= 64) return 24
  if (ram >= 48) return 18
  if (ram >= 30) return 12
  if (ram >= 22) return 10
  if (ram >= 15) return 6
  return 4
}

/**
 * 将探测到的原始显卡名称 / 显存 / 系统内存归一化匹配到标准算力画像。
 *
 * @param {{
 *   presetId?: string,
 *   gpuName?: string,
 *   vramMb?: number | null,
 *   systemRamMb?: number | null,
 *   vendor?: string,
 *   isIntegrated?: boolean,
 *   vramSource?: 'measured' | 'unified-estimate' | 'dictionary' | 'manual' | 'unknown',
 *   adapterLabel?: string,
 * }} [input]
 */
export function matchGpuProfile(input = {}) {
  const locale = input.locale === 'en' ? 'en' : 'zh'
  const rawName = String(input.gpuName || input.adapterLabel || '').trim()
  const systemRamMb = Number(input.systemRamMb)
  const systemRamGb = Number.isFinite(systemRamMb) && systemRamMb > 0
    ? Math.round((systemRamMb / 1024) * 10) / 10
    : null

  // 1. 显式选择了手动预设档位
  if (input.presetId) {
    const rawPreset = benchmarkById(input.presetId)
    const preset = localizeGpuEntry(rawPreset, locale)
    if (preset) {
      const overrideVramGb = Number.isFinite(Number(input.vramMb)) && Number(input.vramMb) > 0
        ? Math.round((Number(input.vramMb) / 1024) * 10) / 10
        : preset.vramGb
      return {
        matchedId: preset.id,
        displayName: preset.name,
        shortName: preset.shortName,
        vendor: preset.vendor,
        kind: preset.kind,
        backend: preset.backend,
        vramGb: overrideVramGb,
        systemRamGb,
        speedVsT4: preset.speedVsT4,
        percentile: preset.percentile,
        vramSource: input.vramSource || 'manual',
        confidence: 'exact',
        note: preset.note,
      }
    }
  }

  const lower = rawName.toLowerCase()
  const measuredVramMb = Number(input.vramMb)
  const hasMeasuredVram = Number.isFinite(measuredVramMb) && measuredVramMb > 0
  const measuredVramGb = hasMeasuredVram ? Math.round((measuredVramMb / 1024) * 10) / 10 : null

  // 2. 在静态基准表中按关键字匹配（特殊处理同型号多显存版本，如 4060 Ti 16G vs 8G）
  let matched = null
  if (lower) {
    if (lower.includes('4060 ti')) {
      if (measuredVramGb && measuredVramGb >= 14) matched = benchmarkById('rtx-4060-ti-16g')
      else matched = benchmarkById('rtx-4060-8g')
    } else if (lower.includes('3060') && !lower.includes('ti')) {
      if (measuredVramGb && measuredVramGb <= 7) matched = benchmarkById('rtx-2060-6g')
      else matched = benchmarkById('rtx-3060-12g')
    } else {
      matched = GPU_BENCHMARKS.find((entry) =>
        entry.matchKeywords.some((kw) => lower.includes(kw)),
      ) ?? null
    }
  }

  const vendor = matched?.vendor || inferVendor(rawName, input.vendor)
  const isIntegrated = input.isIntegrated ?? (matched ? matched.kind !== 'discrete' : vendor === 'intel' || vendor === 'apple')

  let vramGb = 4
  let vramSource = input.vramSource || 'unknown'
  if (hasMeasuredVram && !isIntegrated) {
    vramGb = measuredVramGb
    vramSource = 'measured'
  } else if (isIntegrated && systemRamGb) {
    vramGb = estimateUnifiedVramGb(systemRamGb)
    vramSource = 'unified-estimate'
  } else if (matched) {
    vramGb = matched.vramGb
    vramSource = 'dictionary'
  } else if (hasMeasuredVram) {
    vramGb = measuredVramGb
    vramSource = 'measured'
  }

  const speedVsT4 = matched?.speedVsT4 ?? (
    vramGb >= 24 ? 2.4 : vramGb >= 16 ? 1.8 : vramGb >= 12 ? 1.2 : vramGb >= 8 ? 0.9 : 0.25
  )
  const percentile = matched?.percentile ?? (
    vramGb >= 24 ? 92 : vramGb >= 16 ? 82 : vramGb >= 12 ? 66 : vramGb >= 8 ? 48 : 22
  )

  const localizedMatched = localizeGpuEntry(matched, locale)

  return {
    matchedId: localizedMatched?.id || null,
    displayName: rawName || localizedMatched?.name || (locale === 'en' ? 'Unidentified GPU (Select Manually)' : '未识别显卡（可手动选择）'),
    shortName: localizedMatched?.shortName || rawName || (locale === 'en' ? 'Unknown Device' : '未知设备'),
    vendor,
    kind: isIntegrated ? (vendor === 'apple' ? 'unified' : 'integrated') : 'discrete',
    backend: localizedMatched?.backend || (vendor === 'nvidia' ? 'CUDA' : vendor === 'apple' ? 'Metal' : 'Vulkan'),
    vramGb,
    systemRamGb,
    speedVsT4,
    percentile,
    vramSource,
    confidence: hasMeasuredVram ? 'exact' : localizedMatched ? 'matched' : 'fallback',
    note: localizedMatched?.note || (locale === 'en'
      ? 'Switch presets to match your actual VRAM or connect free cloud GPUs.'
      : '可根据本机实际显存大小切换档位或接入免费云端算力。'),
  }
}

/**
 * 综合显存容量与吞吐速度，输出清晰的「双维度评估 + 模型适配清单 + 含本机高亮的天梯榜」。
 *
 * @param {ReturnType<typeof matchGpuProfile>} profile
 * @param {{ diskFreeGb?: number | null, measuredSteadySecByModel?: Record<string, number> }} [options]
 */
export function evaluateDeviceCapability(profile, options = {}) {
  const locale = options.locale === 'en' ? 'en' : 'zh'
  const safeProfile = profile || matchGpuProfile({ locale })
  const vramMb = Math.round((Number(safeProfile.vramGb) || 0) * 1024)
  const diskFreeGb = Number.isFinite(Number(options.diskFreeGb)) ? Number(options.diskFreeGb) : null
  const measuredMap = options.measuredSteadySecByModel || {}
  const isNvidiaCuda = safeProfile.vendor === 'nvidia' && safeProfile.kind === 'discrete'
  const speed = Math.max(0.1, Number(safeProfile.speedVsT4) || 0.25)

  const modelStatuses = BENCHMARK_MODELS.map((model) => {
    const realSec = Number(measuredMap[model.id])
    const estSeconds = Number.isFinite(realSec) && realSec > 0
      ? Math.round(realSec * 10) / 10
      : Math.max(2, Math.round((model.steadySeconds / speed) * 10) / 10)

    let status = /** @type {ModelFitStatus} */ ('cloud-recommended')
    let verdict = /** @type {'ready' | 'tight' | 'unsupported'} */ ('unsupported')
    let reason = ''
    let needGb = Math.round((model.ggufVramMb / 1024) * 10) / 10
    const needDiskGb = isNvidiaCuda && vramMb >= model.peakVramMb - 400 ? model.downloadGb : model.ggufDownloadGb
    const diskWarning = diskFreeGb !== null && diskFreeGb < needDiskGb + 2

    if (isNvidiaCuda && vramMb >= model.peakVramMb + 300) {
      status = 'fp16-ready'
      needGb = Math.round((model.peakVramMb / 1024) * 10) / 10
      verdict = diskWarning ? 'tight' : 'ready'
      reason = locale === 'en'
        ? `Est. ~${estSeconds}s · Plenty of local VRAM (~${needGb} GB needed)`
        : `预计 ~${estSeconds} 秒出图 · 本机显存充裕（约需 ${needGb} GB）`
    } else if (isNvidiaCuda && vramMb >= model.peakVramMb - 400) {
      status = 'tight'
      needGb = Math.round((model.peakVramMb / 1024) * 10) / 10
      verdict = 'tight'
      reason = locale === 'en'
        ? `Est. ~${estSeconds}s · Tight VRAM (~${needGb} GB needed); try lower resolution`
        : `预计 ~${estSeconds} 秒出图 · 显存余量偏紧（约需 ${needGb} GB），建议适当降分辨率`
    } else if (vramMb >= model.ggufVramMb) {
      status = 'gguf-planned'
      const ratio = model.ggufVramMb > 0 ? vramMb / model.ggufVramMb : 1
      const comfortable = (model.ggufVerified && ratio >= 1.15) || ratio >= 1.35
      verdict = comfortable && !diskWarning ? 'ready' : 'tight'
      if (locale === 'en') {
        reason = verdict === 'ready'
          ? `Est. ~${estSeconds}s · Runs locally via GGUF (~${needGb} GB needed)`
          : `Est. ~${estSeconds}s · Tight memory headroom (~${needGb} GB needed); slower inference`
      } else {
        reason = verdict === 'ready'
          ? `预计 ~${estSeconds} 秒出图 · 本机可用（约需 ${needGb} GB）`
          : `预计 ~${estSeconds} 秒出图 · 显存/内存余量较紧（约需 ${needGb} GB），速度偏慢`
      }
    } else {
      status = 'cloud-recommended'
      verdict = 'unsupported'
      if (locale === 'en') {
        reason = model.kaggleReady
          ? `Insufficient local VRAM/RAM (~${needGb} GB needed); free Kaggle GPU recommended`
          : `Heavyweight model (~${needGb} GB needed); use Colab, private GPU, or cloud API`
      } else {
        reason = model.kaggleReady
          ? `本机显存/内存不足（需约 ${needGb} GB），建议改用内置免费云端`
          : `重型模型（需约 ${needGb} GB），建议切换云端算力或商业 API`
      }
    }

    return {
      ...model,
      peakVramGb: Math.round((model.peakVramMb / 1024) * 10) / 10,
      ggufVramGb: Math.round((model.ggufVramMb / 1024) * 10) / 10,
      needVramGb: needGb,
      status,
      verdict,
      estSeconds,
      isMeasuredRun: Number.isFinite(realSec) && realSec > 0,
      reason,
      diskWarning,
    }
  })

  const unlockedFp16 = modelStatuses.filter((m) => m.status === 'fp16-ready' || m.status === 'tight').length
  const unlockedGguf = modelStatuses.filter((m) => m.status !== 'cloud-recommended').length
  const readyCount = modelStatuses.filter((m) => m.verdict === 'ready').length
  const tightCount = modelStatuses.filter((m) => m.verdict === 'tight').length

  let tier
  if (safeProfile.vramGb >= 22 && isNvidiaCuda) {
    tier = locale === 'en'
      ? {
          id: 'flagship',
          badge: 'S · Flagship All-Model',
          title: 'Flagship All-Model Local Workstation',
          summary: 'All built-in models run locally at full precision with headroom for video and 3D.',
        }
      : {
          id: 'flagship',
          badge: 'S · 旗舰全模型',
          title: '旗舰级本机全模型工作站',
          summary: '全部 7 款主流模型均可本地全精度运行，并为视频与 3D 扩展保留余量。',
        }
  } else if (safeProfile.vramGb >= 15) {
    tier = locale === 'en'
      ? {
          id: 'creator-pro',
          badge: 'A · Creator Pro',
          title: 'High-VRAM Local Workstation',
          summary: '4B–6B models run smoothly locally; 7B–9B models run with GGUF quantization or offload.',
        }
      : {
          id: 'creator-pro',
          badge: 'A · 进阶创作档',
          title: '高显存本地主力',
          summary: '主流 4B~6B 模型可本地流畅运行，7B~9B 配合 GGUF 量化或 Offload 亦可运行。',
        }
  } else if (safeProfile.vramGb >= 10) {
    tier = locale === 'en'
      ? {
          id: 'mainstream',
          badge: 'B · Mainstream Sweet Spot',
          title: 'Balanced Local / Hybrid Workstation',
          summary: 'Klein 4B, SDXL, and Z-Image run locally; heavier weights switch seamlessly to cloud.',
        }
      : {
          id: 'mainstream',
          badge: 'B · 甜点实用档',
          title: '均衡型本地/混合工作站',
          summary: 'Klein 4B / SDXL / Z-Image 均可本地运行，超重型模型可切换云端补齐。',
        }
  } else if (safeProfile.vramGb >= 7.5) {
    tier = locale === 'en'
      ? {
          id: 'entry-local',
          badge: 'C · Entry Local + Cloud',
          title: '8GB Threshold · Hybrid Local & Cloud',
          summary: 'Runs local WebGPU cutout and 8GB / GGUF models; switch to free Kaggle for heavy models.',
        }
      : {
          id: 'entry-local',
          badge: 'C · 轻量化入门',
          title: '8G 门槛 · 轻量本地 + 云端混合',
          summary: '可本机运行 WebGPU 抠图与 8G 轻量 / GGUF 模型，复杂大模型建议一键切换免费 Kaggle。',
        }
  } else {
    tier = locale === 'en'
      ? {
          id: 'cloud-only',
          badge: 'D · Ultrabook / Cloud-First',
          title: 'Local Workshop Ready · Free Cloud Generation',
          summary: 'Run SVG, pixel snap, and sprite tools offline; switch to free Kaggle dual-T4 (30GB) for generation.',
        }
      : {
          id: 'cloud-only',
          badge: 'D · 轻薄本/云端方案',
          title: '端侧工坊就绪 · 云端主力出图',
          summary: '本机可离线运行 SVG 矢量、像素对齐与视觉感知；生图一键切换内置免费 Kaggle 双 T4（30GB 显存）。',
        }
  }

  // 构建含「云端参照线 + 本机高亮位置」的紧凑天梯表
  const baseRows = GPU_BENCHMARKS.map((rawEntry) => {
    const entry = localizeGpuEntry(rawEntry, locale)
    return {
      id: entry.id,
      name: entry.name,
      shortName: entry.shortName,
      vendor: entry.vendor,
      kind: entry.kind,
      backend: entry.backend,
      vramGb: entry.vramGb,
      speedVsT4: entry.speedVsT4,
      percentile: entry.percentile,
      isCloudRef: Boolean(entry.isCloudRef),
      isCurrentUser: entry.id === safeProfile.matchedId,
      rankScore: entry.vramGb * 2 + entry.speedVsT4 * 8,
    }
  })

  if (!baseRows.some((r) => r.isCurrentUser)) {
    baseRows.push({
      id: 'current-user-device',
      name: safeProfile.displayName,
      shortName: safeProfile.shortName,
      vendor: safeProfile.vendor,
      kind: safeProfile.kind,
      backend: safeProfile.backend,
      vramGb: safeProfile.vramGb,
      speedVsT4: safeProfile.speedVsT4,
      percentile: safeProfile.percentile,
      isCloudRef: false,
      isCurrentUser: true,
      rankScore: safeProfile.vramGb * 2 + safeProfile.speedVsT4 * 8,
    })
  }

  const ladder = baseRows
    .sort((a, b) => b.rankScore - a.rankScore)
    .map((row, index) => ({ ...row, rank: index + 1 }))

  return {
    profile: safeProfile,
    tier,
    score: {
      unlockedFp16,
      unlockedGguf,
      readyCount,
      tightCount,
      totalModels: BENCHMARK_MODELS.length,
      speedVsT4: Math.round(speed * 100) / 100,
      percentile: safeProfile.percentile,
      diskFreeGb,
    },
    modelStatuses,
    ladder,
  }
}

/**
 * 构建「前列榜单 + 渐变折叠遮罩 + 本机及前后设备」的聚焦天梯段落。
 * 这样无需平铺全部 20 档，即可一眼看到头部标杆与自身所处位置。
 *
 * @param {Array<object>} ladder
 * @param {{ topCount?: number, aroundSelf?: number, tailCount?: number }} [options]
 * @returns {Array<{ type: 'row', row: object } | { type: 'gap', hiddenCount: number, fromRank: number, toRank: number, previewRows: Array<object> }>}
 */
export function buildFocusedLadderSegments(ladder, options = {}) {
  if (!Array.isArray(ladder) || ladder.length === 0) return []
  const topCount = Math.max(1, Number(options.topCount) || 3)
  const aroundSelf = Math.max(1, Number(options.aroundSelf) || 1)
  const tailCount = Math.max(0, Number(options.tailCount ?? 1))

  const selfIdx = ladder.findIndex((r) => r.isCurrentUser)
  const keep = new Set()
  for (let i = 0; i < Math.min(topCount, ladder.length); i += 1) keep.add(i)
  if (selfIdx >= 0) {
    const start = Math.max(0, selfIdx - aroundSelf)
    const end = Math.min(ladder.length - 1, selfIdx + aroundSelf)
    for (let i = start; i <= end; i += 1) keep.add(i)
  }
  for (let i = Math.max(0, ladder.length - tailCount); i < ladder.length; i += 1) keep.add(i)

  const sortedIndices = [...keep].sort((a, b) => a - b)
  const segments = []
  let prevIdx = -1

  for (const idx of sortedIndices) {
    if (prevIdx >= 0 && idx - prevIdx > 1) {
      const hiddenCount = idx - prevIdx - 1
      segments.push({
        type: 'gap',
        hiddenCount,
        fromRank: prevIdx + 2,
        toRank: idx,
        previewRows: ladder.slice(prevIdx + 1, Math.min(idx, prevIdx + 3)),
      })
    }
    segments.push({ type: 'row', row: ladder[idx] })
    prevIdx = idx
  }

  return segments
}

const BENCHMARK_BY_ID = new Map(BENCHMARK_MODELS.map((item) => [item.id, item]))

/** 按模型 ID 查询基准标尺；未登记返回 null。 */
export function benchmarkModelById(id) {
  if (typeof id !== 'string' || !id.trim()) return null
  return BENCHMARK_BY_ID.get(id.trim()) ?? null
}

/**
 * 评估指定模型预设在本机硬件上的运行预测（供 ModelCardPicker 与本地部署分类共用）。
 *
 * @param {object|null} preset 模型预设
 * @param {object|null} hardwareEvaluation `hardware.evaluation`（含 modelStatuses）
 * @param {object|null} [localGpu] `/api/state.localGpu` 脱敏状态（可选）
 * @returns {{
 *   status: ModelFitStatus,
 *   tone: 'ok'|'warn'|'error',
 *   estSeconds: number|null,
 *   vramNeedGb: number|null,
 *   configured: boolean,
 *   ggufVerified: boolean,
 *   reason: string,
 * } | null}
 */
export function evaluatePresetLocalFit(preset, hardwareEvaluation, localGpu = null) {
  if (!preset || preset.cloud || preset.inpaintOnly === true) return null
  const modelId = typeof preset.id === 'string' ? preset.id : ''
  if (!modelId) return null

  const asset = localGpuAssetOf(modelId)
  const configuredList = Array.isArray(localGpu?.configuredPresets) ? localGpu.configuredPresets : []
  const downloaded = configuredList.includes(modelId) || localGpu?.modelStates?.[modelId]?.ready === true
  const engineReady = localGpu?.engineReady === true || localGpu?.ok === true
  const configured = engineReady && downloaded

  const toneForVerdict = (verdict) => (verdict === 'ready' ? 'ok' : verdict === 'tight' ? 'warn' : 'error')
  const deriveVerdict = (item, profile) => {
    if (modelId === 'flux2-klein-4b' && (item.verdict === 'unsupported' || item.status === 'cloud-recommended')) return 'tight'
    if (item.verdict) return item.verdict
    if (item.status === 'cloud-recommended') return 'unsupported'
    if (item.status === 'tight') return 'tight'
    if (item.status === 'fp16-ready') return item.diskWarning ? 'tight' : 'ready'
    const vramMb = Math.round((Number(profile?.vramGb) || 0) * 1024)
    const ggufMb = Number(item.ggufVramMb) || Math.round((Number(item.ggufVramGb) || 0) * 1024)
    const ratio = ggufMb > 0 ? vramMb / ggufMb : 1
    const comfortable = (item.ggufVerified && ratio >= 1.15) || ratio >= 1.35
    return comfortable && !item.diskWarning ? 'ready' : 'tight'
  }

  const list = Array.isArray(hardwareEvaluation?.modelStatuses) ? hardwareEvaluation.modelStatuses : []
  const matched = list.find((item) => item.id === modelId) || null
  if (matched) {
    const verdict = deriveVerdict(matched, hardwareEvaluation?.profile)
    return {
      status: matched.status,
      verdict,
      tone: toneForVerdict(verdict),
      estSeconds: Number.isFinite(Number(matched.estSeconds)) ? Number(matched.estSeconds) : null,
      vramNeedGb: matched.needVramGb ?? (matched.status === 'fp16-ready' || matched.status === 'tight'
        ? matched.peakVramGb
        : matched.ggufVramGb),
      configured,
      downloaded,
      engineReady,
      downloadable: Boolean(asset?.available),
      downloadBytes: asset?.bytes ?? 0,
      localAssetReason: asset?.reason ?? '',
      ggufVerified: Boolean(matched.ggufVerified),
      reason: matched.reason || '',
    }
  }

  const benchmark = benchmarkModelById(modelId)
  if (!benchmark) return null
  const profile = hardwareEvaluation?.profile
  if (!profile) return null
  const evaluated = evaluateDeviceCapability(profile, {
    diskFreeGb: hardwareEvaluation?.score?.diskFreeGb ?? null,
  })
  const item = evaluated.modelStatuses.find((entry) => entry.id === modelId)
  if (!item) return null
  const verdict = deriveVerdict(item, profile)
  return {
    status: item.status,
    verdict,
    tone: toneForVerdict(verdict),
    estSeconds: Number.isFinite(Number(item.estSeconds)) ? Number(item.estSeconds) : null,
    vramNeedGb: item.needVramGb ?? (item.status === 'fp16-ready' || item.status === 'tight'
      ? item.peakVramGb
      : item.ggufVramGb),
    configured,
    downloaded,
    engineReady,
    downloadable: Boolean(asset?.available),
    downloadBytes: asset?.bytes ?? 0,
    localAssetReason: asset?.reason ?? '',
    ggufVerified: Boolean(item.ggufVerified),
    reason: item.reason || '',
  }
}
