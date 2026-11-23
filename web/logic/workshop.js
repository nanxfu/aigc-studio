/**
 * 资产工坊的本机确定性算子（M4.2a / M4.2b）。
 *
 * 这里只放与 DOM / canvas / 网络无关的纯计算：
 *  - 像素画网格自动探测 + 最近邻重采样 + Oklab 调色盘量化（Pixel-Unslop）；
 *  - 四方连续平铺的接缝评估（MAE）与半格滚动余弦混边；
 *  - 2×2 平铺画布几何；
 *  - 序列帧切片与 Aseprite 兼容的 atlas 元数据。
 *
 * 渲染进程负责把返回的 RGBA 数据画到 canvas 上；Host 的 Node 侧也能直接复用同一份
 * 实现，所以本文件不 import 任何运行时模块，也不修改入参数据。
 *
 * 边界值统一取自 `shared/contract.js` 的 `WORKSHOP`：
 *  - `pixel`：网格 / 颜色数 / Alpha 阈值 / 放大倍数；
 *  - `sprite`：行列数、单帧最小边长、总帧数上限、是否裁透明边；
 *  - `tile`：默认平铺次数、混边带宽、接缝阈值。
 *
 * 与 `worker/inference/game_ops.py` 的对应关系（同一套算法口径，字段保持一致）：
 *  - `snapPixelArt` ↔ `pixel_snap_and_quantize`（量化部分用 Oklab 中位切分 + K-Means 精修，
 *    替代 PIL 的 sRGB 中位切分，暗部不再发灰）；
 *  - `seamMae` ↔ `analyze_seamless_tile`；
 *  - `blendSeamEdges` ↔ `blend_seamless_edges`；
 *  - `sliceSpriteFrames` ↔ `slice_sprite_sheet`（`frame` / `trimmed` / `spriteSourceSize` /
 *    `sourceSize` / `pivot` 的字段口径一致）。
 */

import { WORKSHOP } from '../../shared/contract.js'

import { clampInt, clampNumber } from './clamp.js'

const PIXEL = WORKSHOP.pixel
const SPRITE = WORKSHOP.sprite
const TILE = WORKSHOP.tile

// ── 内部调优常量（不属于跨端契约，只影响本机实现） ──────────────────────────

/** 精确直方图上限：超过后折叠成 5bit/通道分箱，保证大图量化时间有界。 */
const MAX_EXACT_COLORS = 8192

/** 参与聚类拟合的颜色点数上限（4bit/通道分箱后最多 4096 个）。 */
const MAX_FIT_POINTS = 4096

/** K-Means 精修的最大轮数；像素画调色盘小，通常 3～5 轮即收敛。 */
const KMEANS_MAX_ITERATIONS = 12

/** 单次 snap 的「颜色 → 调色盘下标」缓存上限，避免照片类大图把 Map 撑爆。 */
const PALETTE_CACHE_LIMIT = 1 << 16

/** 网格探测：对齐位置的平均边缘强度至少是全局平均的多少倍才算周期结构。 */
const DETECT_MIN_CONTRAST = 1.35

/**
 * 网格探测：判定「基础周期」时，候选格距的对比度至少要达到最优候选的多少倍。
 *
 * 真格距的整数倍（4 的倍数 8/16/28……）只会采到一部分格线，平均值与真值接近，
 * 甚至因采样点变少而偶然略高；所以不能直接取最高分，而要取「不小于最优分 80%
 * 的最小格距」。真值的约数（4 的约数 2）会把非格线位置混进来，对比度通常只有
 * 真值的一半左右，落在这个阈值之外。
 */
const DETECT_FUNDAMENTAL_RATIO = 0.8

/**
 * 网格探测：低采样数惩罚系数。
 *
 * 候选格距接近图像尺寸时，每个相位只剩两三个采样点，均值方差很大，容易被偶然
 * 很强的边缘「抬高」。按 `count / (count + 4)` 把 (对比度 - 1) 向 1 收缩，等价于
 * 要求大格距提供更多采样证据，避免在真格距之外选中尺寸接近半幅的伪周期。
 */
const DETECT_SUPPORT_SHRINK = 4

/** 网格探测：置信度归一化跨度（对比度从 1 到 1+span 映射到 0..1）。 */
const DETECT_CONFIDENCE_SPAN = 2.2

/** 网格探测：全局平均边缘强度低于该值视为「没有可用边缘」，直接判定探测失败。 */
const DETECT_MIN_EDGE_MEAN = 0.75

/** 网格探测：某个相位至少要有几个采样点，才允许把它当作候选格线。 */
const DETECT_MIN_PERIODS = 2

/** 网格探测：判定透明像素的 Alpha 阈值（低于它不参与边缘投影）。 */
const DETECT_ALPHA_CUT = 8

/** 工坊页支持的平铺次数上限：只用于预览几何，防止误传大数把画布算成几万像素。 */
const MAX_TILE_REPEAT = 8

// ── 通用小工具 ────────────────────────────────────────────────────────────

/** 把宽度 / 高度规范成正整数，非法值直接报错（上游 UI 会先做输入钳制）。 */
function requireDimension(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) {
    throw new RangeError(`${name} 必须是 ≥1 的像素尺寸，收到 ${value}`)
  }
  return Math.round(number)
}

/**
 * 把入参规范成 RGBA 数据：长度不足立即报错，普通数组复制成 Uint8ClampedArray。
 *
 * @param {ArrayLike<number>} data
 * @param {number} pixelCount
 * @returns {Uint8ClampedArray}
 */
function asRgba(data, pixelCount) {
  if (!data || typeof data.length !== 'number') {
    throw new TypeError('像素数据必须是 Uint8ClampedArray 或数组')
  }
  const needed = pixelCount * 4
  if (data.length < needed) {
    throw new RangeError(`像素数据长度不足：需要 ${needed} 个分量，实际 ${data.length} 个`)
  }
  if (data instanceof Uint8ClampedArray) return data
  const copy = new Uint8ClampedArray(needed)
  for (let i = 0; i < needed; i++) copy[i] = data[i] || 0
  return copy
}

/** Oklab 逆变换可能落到色域外，统一夹到 0..255。 */
function byteOf(value) {
  if (!(value > 0)) return 0
  if (value > 255) return 255
  return Math.round(value)
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

function clamp01(value) {
  if (!(value > 0)) return 0
  return Math.min(1, value)
}

/** 把偏移量归一到 [0, cell) 的整数相位；snap 与 detect 的 offset 语义一致。 */
function normalizeOffset(value, cell) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const phase = Math.round(number) % cell
  return phase < 0 ? phase + cell : phase
}

// ── sRGB ↔ Oklab ──────────────────────────────────────────────────────────

function srgbToLinear(channel) {
  if (!(channel > 0)) return 0
  if (channel >= 1) return 1
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(channel) {
  if (!(channel > 0)) return 0
  if (channel >= 1) return 1
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
}

function srgba8ToLinear(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return srgbToLinear(Math.min(255, Math.max(0, number)) / 255)
}

/**
 * sRGB（0..255）→ Oklab（标准 Björn Ottosson 公式）。
 *
 * 返回 `[L, a, b]`：L 约 0..1，a / b 约 -0.4..0.4。量化距离统一在 Oklab 里算，
 * 避免 sRGB 欧氏距离让暗部差异被低估（像素画暗部色阶最容易发灰）。
 *
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @returns {[number, number, number]}
 */
export function rgbToOklab(r, g, b) {
  const lr = srgba8ToLinear(r)
  const lg = srgba8ToLinear(g)
  const lb = srgba8ToLinear(b)

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ]
}

/**
 * Oklab → sRGB（0..255，超色域分量夹到边界）。
 *
 * @param {number} L
 * @param {number} a
 * @param {number} b
 * @returns {[number, number, number]}
 */
export function oklabToRgb(L, a, b) {
  const lightness = Number.isFinite(L) ? L : 0
  const axisA = Number.isFinite(a) ? a : 0
  const axisB = Number.isFinite(b) ? b : 0

  const l_ = lightness + 0.3963377774 * axisA + 0.2158037573 * axisB
  const m_ = lightness - 0.1055613458 * axisA - 0.0638541728 * axisB
  const s_ = lightness - 0.0894841775 * axisA - 1.291485548 * axisB

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

  return [byteOf(linearToSrgb(r) * 255), byteOf(linearToSrgb(g) * 255), byteOf(linearToSrgb(blue) * 255)]
}

// ── 调色盘量化（Oklab 中位切分初始化 + K-Means 精修） ──────────────────────

/**
 * 颜色直方图累加器。
 *
 * 先按精确 24bit RGB 计数；颜色种类超过 `MAX_EXACT_COLORS` 时折叠成 5bit/通道分箱
 * （权重与 RGB 均值保留），把后续聚类规模压到有界范围，避免照片类大图在量化阶段
 * 把主线程卡住。分箱只影响「找调色盘」，最终每个像素仍按原始颜色映射到最近色。
 */
function createColorHistogram() {
  const exact = new Map()
  let binned = null

  function addBinned(r, g, b, count) {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const entry = binned.get(key)
    if (entry) {
      entry.count += count
      entry.sumR += r * count
      entry.sumG += g * count
      entry.sumB += b * count
      return
    }
    binned.set(key, { count, sumR: r * count, sumG: g * count, sumB: b * count })
  }

  function add(r, g, b, count = 1) {
    if (count <= 0) return
    if (binned) {
      addBinned(r, g, b, count)
      return
    }
    const key = (r << 16) | (g << 8) | b
    const previous = exact.get(key)
    if (previous !== undefined) {
      exact.set(key, previous + count)
      return
    }
    if (exact.size < MAX_EXACT_COLORS) {
      exact.set(key, count)
      return
    }
    // 超过精确直方图上限：整体折叠成 5bit 分箱，此后新颜色直接进分箱表。
    binned = new Map()
    for (const [packed, weight] of exact) {
      addBinned((packed >> 16) & 255, (packed >> 8) & 255, packed & 255, weight)
    }
    exact.clear()
    addBinned(r, g, b, count)
  }

  function toPoints() {
    const points = []
    if (binned) {
      for (const entry of binned.values()) {
        points.push({
          r: Math.round(entry.sumR / entry.count),
          g: Math.round(entry.sumG / entry.count),
          b: Math.round(entry.sumB / entry.count),
          count: entry.count,
        })
      }
      return points
    }
    for (const [packed, count] of exact) {
      points.push({ r: (packed >> 16) & 255, g: (packed >> 8) & 255, b: packed & 255, count })
    }
    return points
  }

  return { add, toPoints }
}

/** 调色盘输出排序：出现次数多的在前，次数相同按 RGB 数值稳定排序（保证可复现）。 */
function comparePaletteEntry(a, b) {
  if (b.count !== a.count) return b.count - a.count
  if (a.rgb[0] !== b.rgb[0]) return a.rgb[0] - b.rgb[0]
  if (a.rgb[1] !== b.rgb[1]) return a.rgb[1] - b.rgb[1]
  return a.rgb[2] - b.rgb[2]
}

/**
 * 颜色点对象（带 Oklab 预计算），供中位切分与 K-Means 复用。
 *
 * 注意字段命名：`r/g/b` 是 sRGB 三通道，Oklab 的 b 轴单独叫 `okb`——两者必须分开，
 * 否则后者会覆盖前者（曾经把分箱用的 sRGB 蓝通道读成 Oklab 轴，大色数图调色盘会偏色）。
 */
function buildFitSamples(points) {
  return points.map((point) => {
    const [L, a, okb] = rgbToOklab(point.r, point.g, point.b)
    return { r: point.r, g: point.g, b: point.b, count: point.count, L, a, okb }
  })
}

/**
 * 把拟合样本压到 `MAX_FIT_POINTS` 以内：按 4bit/通道分箱合并，权重累加、颜色取加权均值。
 * 只用于「找调色盘」，不影响最终的逐像素映射。
 */
function reduceFitSamples(samples) {
  if (samples.length <= MAX_FIT_POINTS) return samples
  const bins = new Map()
  for (const sample of samples) {
    const key = ((sample.r >> 4) << 8) | ((sample.g >> 4) << 4) | (sample.b >> 4)
    const bin = bins.get(key)
    if (bin) {
      bin.count += sample.count
      bin.sumR += sample.r * sample.count
      bin.sumG += sample.g * sample.count
      bin.sumB += sample.b * sample.count
    } else {
      bins.set(key, {
        count: sample.count,
        sumR: sample.r * sample.count,
        sumG: sample.g * sample.count,
        sumB: sample.b * sample.count,
      })
    }
  }
  const reduced = []
  for (const bin of bins.values()) {
    const r = Math.round(bin.sumR / bin.count)
    const g = Math.round(bin.sumG / bin.count)
    const b = Math.round(bin.sumB / bin.count)
    const [L, a, okb] = rgbToOklab(r, g, b)
    reduced.push({ r, g, b, count: bin.count, L, a, okb })
  }
  return reduced
}

/** 一组样本的加权均值与轴方差；中位切分用它挑「最该继续切」的盒子。 */
function boxStats(indices, samples) {
  let weight = 0
  let sumL = 0
  let sumA = 0
  let sumB = 0
  for (const index of indices) {
    const sample = samples[index]
    weight += sample.count
    sumL += sample.L * sample.count
    sumA += sample.a * sample.count
    sumB += sample.okb * sample.count
  }

  const meanL = weight > 0 ? sumL / weight : 0
  const meanA = weight > 0 ? sumA / weight : 0
  const meanB = weight > 0 ? sumB / weight : 0

  let varL = 0
  let varA = 0
  let varB = 0
  for (const index of indices) {
    const sample = samples[index]
    const dL = sample.L - meanL
    const dA = sample.a - meanA
    const dB = sample.okb - meanB
    varL += sample.count * dL * dL
    varA += sample.count * dA * dA
    varB += sample.count * dB * dB
  }

  const variances = [varL, varA, varB]
  let splitAxis = 0
  if (variances[1] > variances[splitAxis]) splitAxis = 1
  if (variances[2] > variances[splitAxis]) splitAxis = 2

  return {
    indices,
    weight,
    mean: [meanL, meanA, meanB],
    splitAxis,
    // 盒内加权平方误差和：越大说明切开后收益越高。
    score: weight > 0 ? (varL + varA + varB) / weight : 0,
  }
}

/**
 * 加权中位切分：每轮选「加权方差最大」的盒子，沿方差最大的 Oklab 轴按权重中位数切开，
 * 直到盒子数等于目标颜色数。切分得到的盒子均值就是初始调色盘。
 */
function medianCutCenters(samples, targetColors) {
  const all = samples.map((_, index) => index)
  const boxes = [boxStats(all, samples)]

  while (boxes.length < targetColors) {
    let splitIndex = -1
    let splitScore = -1
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (box.indices.length < 2) continue
      if (box.score > splitScore) {
        splitScore = box.score
        splitIndex = i
      }
    }
    if (splitIndex < 0) break

    const box = boxes[splitIndex]
    const axis = box.splitAxis
    const axisKey = axis === 0 ? 'L' : axis === 1 ? 'a' : 'okb'
    const sorted = box.indices
      .slice()
      .sort((left, right) => samples[left][axisKey] - samples[right][axisKey] || left - right)

    const half = box.weight / 2
    let accumulated = 0
    let splitAt = 1
    for (let i = 0; i < sorted.length - 1; i++) {
      accumulated += samples[sorted[i]].count
      splitAt = i + 1
      if (accumulated >= half) break
    }
    splitAt = Math.min(sorted.length - 1, Math.max(1, splitAt))

    const left = sorted.slice(0, splitAt)
    const right = sorted.slice(splitAt)
    boxes.splice(splitIndex, 1, boxStats(left, samples), boxStats(right, samples))
  }

  return boxes.map((box) => [box.mean[0], box.mean[1], box.mean[2]])
}

/** Oklab 欧氏距离平方。 */
function oklabDistanceSq(L, a, b, center) {
  const dL = L - center[0]
  const dA = a - center[1]
  const dB = b - center[2]
  return dL * dL + dA * dA + dB * dB
}

/** 多轮 K-Means（Lloyd）精修：以 Oklab 距离重新分配样本并更新中心。 */
function refineCenters(samples, centers) {
  const count = centers.length
  if (count === 0) return []

  const assignment = new Int16Array(samples.length).fill(-1)
  let current = centers.map((center) => center.slice())

  for (let iteration = 0; iteration < KMEANS_MAX_ITERATIONS; iteration++) {
    const sumL = new Float64Array(count)
    const sumA = new Float64Array(count)
    const sumB = new Float64Array(count)
    const sumWeight = new Float64Array(count)
    let changed = false

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]
      let bestIndex = 0
      let bestDistance = Infinity
      for (let c = 0; c < count; c++) {
        const distance = oklabDistanceSq(sample.L, sample.a, sample.okb, current[c])
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = c
        }
      }
      if (assignment[i] !== bestIndex) {
        assignment[i] = bestIndex
        changed = true
      }
      sumL[bestIndex] += sample.L * sample.count
      sumA[bestIndex] += sample.a * sample.count
      sumB[bestIndex] += sample.okb * sample.count
      sumWeight[bestIndex] += sample.count
    }

    if (!changed && iteration > 0) break

    for (let c = 0; c < count; c++) {
      if (sumWeight[c] <= 0) continue
      current[c] = [sumL[c] / sumWeight[c], sumA[c] / sumWeight[c], sumB[c] / sumWeight[c]]
    }
  }

  return current
}

/**
 * 从「颜色点 + 权重」拟合调色盘。
 *
 * 流程：精确色数不超过目标色数时直接复用原色；否则 4bit 分箱控制规模 →
 * Oklab 加权中位切分给初始中心 → K-Means 精修 → 去重并统计每个输入色最终落到哪个色。
 *
 * @param {Array<{ r: number, g: number, b: number, count: number }>} points
 * @param {number} maxColors
 * @returns {Array<{ rgb: [number, number, number], count: number }>}
 */
function fitPalette(points, maxColors) {
  if (points.length === 0) return []

  const limit = clampInt(maxColors, PIXEL.colors.min, PIXEL.colors.max, PIXEL.colors.default)
  if (points.length <= limit) {
    return points
      .map((point) => ({ rgb: [point.r, point.g, point.b], count: point.count }))
      .sort(comparePaletteEntry)
  }

  const samples = reduceFitSamples(buildFitSamples(points))
  const initialCenters = medianCutCenters(samples, Math.min(limit, samples.length))
  const refinedCenters = refineCenters(samples, initialCenters)

  const palette = []
  const seen = new Set()
  for (const center of refinedCenters) {
    const [r, g, b] = oklabToRgb(center[0], center[1], center[2])
    const key = (r << 16) | (g << 8) | b
    if (seen.has(key)) continue
    seen.add(key)
    const [L, a, okb] = rgbToOklab(r, g, b)
    palette.push({ rgb: [r, g, b], count: 0, L, a, okb })
  }

  // 逐输入色重新归属，保证 count 之和等于输入样本总量，也保证输出的确只有 ≤ limit 种颜色。
  for (const point of points) {
    const [L, a, okb] = rgbToOklab(point.r, point.g, point.b)
    let bestIndex = -1
    let bestDistance = Infinity
    for (let i = 0; i < palette.length; i++) {
      const distance = oklabDistanceSq(L, a, okb, [palette[i].L, palette[i].a, palette[i].okb])
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = i
      }
    }
    if (bestIndex >= 0) palette[bestIndex].count += point.count
  }

  return palette
    .filter((entry) => entry.count > 0)
    .map((entry) => ({ rgb: entry.rgb, count: entry.count }))
    .sort(comparePaletteEntry)
}

/**
 * 调色盘量化：把一组 RGB 颜色压缩到最多 `colors` 种（Oklab 感知距离）。
 *
 * @param {Array<ArrayLike<number>>} list 颜色列表，每项为 `[r, g, b]`（0..255）
 * @param {number} colors 目标颜色数（钳制到 `WORKSHOP.pixel.colors` 边界）
 * @returns {Array<{ rgb: [number, number, number], count: number }>} 按出现次数降序
 */
export function quantizePalette(list, colors) {
  if (!list || typeof list.length !== 'number') {
    throw new TypeError('颜色列表必须是数组')
  }
  const histogram = createColorHistogram()
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!item || typeof item.length !== 'number' || item.length < 3) continue
    histogram.add(byteOf(item[0]), byteOf(item[1]), byteOf(item[2]))
  }
  return fitPalette(histogram.toPoints(), colors)
}

// ── 像素画网格探测 ────────────────────────────────────────────────────────

/**
 * 计算相邻列（x 轴）的平均通道差投影。
 *
 * `edges[x]` 表示第 x 列与第 x-1 列之间的平均差异（x=0 无左邻，恒为 0）。
 * 透明像素不参与颜色差，Alpha 差本身按一个通道计入——带透明背景的精灵图
 * 轮廓边界也能被识别，不会把整张图当成「没有边缘」。
 */
function columnEdgeProjection(rgba, width, height, alphaCut) {
  const edges = new Float64Array(width)
  for (let x = 1; x < width; x++) {
    let total = 0
    for (let y = 0; y < height; y++) {
      const right = (y * width + x) * 4
      const left = right - 4
      const alphaRight = rgba[right + 3]
      const alphaLeft = rgba[left + 3]
      if (alphaRight < alphaCut && alphaLeft < alphaCut) continue
      total +=
        (Math.abs(rgba[right] - rgba[left]) +
          Math.abs(rgba[right + 1] - rgba[left + 1]) +
          Math.abs(rgba[right + 2] - rgba[left + 2]) +
          Math.abs(alphaRight - alphaLeft)) /
        4
    }
    edges[x] = total / height
  }
  return edges
}

/** 计算相邻行（y 轴）的平均通道差投影；结构与列投影对称。 */
function rowEdgeProjection(rgba, width, height, alphaCut) {
  const edges = new Float64Array(height)
  for (let y = 1; y < height; y++) {
    let total = 0
    const rowOffset = y * width * 4
    const previousOffset = rowOffset - width * 4
    for (let x = 0; x < width; x++) {
      const bottom = rowOffset + x * 4
      const top = previousOffset + x * 4
      const alphaBottom = rgba[bottom + 3]
      const alphaTop = rgba[top + 3]
      if (alphaBottom < alphaCut && alphaTop < alphaCut) continue
      total +=
        (Math.abs(rgba[bottom] - rgba[top]) +
          Math.abs(rgba[bottom + 1] - rgba[top + 1]) +
          Math.abs(rgba[bottom + 2] - rgba[top + 2]) +
          Math.abs(alphaBottom - alphaTop)) /
        4
    }
    edges[y] = total / width
  }
  return edges
}

/** 投影数组从下标 1 开始的均值（下标 0 是占位，不参与）。 */
function meanEdgeStrength(edges) {
  if (edges.length <= 1) return 0
  let total = 0
  for (let i = 1; i < edges.length; i++) total += edges[i]
  return total / (edges.length - 1)
}

/**
 * 对给定格距，找边缘投影里最强的相位（格线的起始偏移）。
 *
 * 相位 `p` 的采样点是下标 `x = p + k * cell`；平均强度 / 全局平均就是「周期性对比度」：
 *  - 真格距的所有格线都落在同一相位，对比度高；
 *  - 格距的约数（例如真值 4 时的 2）会把非格线位置混进来，对比度明显下降；
 *  - 格距的倍数（例如 8）只采到一部分格线，对比度与真值接近——所以最终要选
 *    「不小于最优值一定比例的最小格距」，才能落回基础周期。
 *
 * 返回值里的 `adjusted` 对采样点很少的相位做了收缩：`count` 越小，(contrast - 1)
 * 越向 0 靠拢，避免大格距被个别强边缘抬高。
 */
function bestPhaseMatch(edges, overallMean, cell) {
  if (!(overallMean > DETECT_MIN_EDGE_MEAN)) return null

  const sums = new Float64Array(cell)
  const counts = new Uint32Array(cell)
  for (let position = 1; position < edges.length; position++) {
    const phase = position % cell
    sums[phase] += edges[position]
    counts[phase] += 1
  }

  let best = null
  for (let phase = 0; phase < cell; phase++) {
    if (counts[phase] < DETECT_MIN_PERIODS) continue
    const mean = sums[phase] / counts[phase]
    if (!best || mean > best.mean) best = { phase, mean, count: counts[phase] }
  }
  if (!best || !(best.mean > 0)) return null

  const contrast = best.mean / overallMean
  const support = best.count / (best.count + DETECT_SUPPORT_SHRINK)
  return {
    contrast,
    adjusted: 1 + (contrast - 1) * support,
    phase: best.phase,
    count: best.count,
  }
}

/** 探测失败时的统一回退：格距 1、无相位、置信度 0。 */
function failedGrid() {
  return { cell: 1, offsetX: 0, offsetY: 0, confidence: 0 }
}

/**
 * 从 RGBA 像素里自动探测 AI 像素画的真实像素格距与相位。
 *
 * 算法：
 *  1. 分别算横 / 纵方向的相邻像素差投影（O(W·H)）；
 *  2. 对每个候选格距，按相位求投影的「周期性对比度」= 对齐位置平均强度 / 全局平均强度；
 *  3. 横纵两轴的对比度取几何平均，作为该格距的得分；一轴缺失（如纯条纹图）时降权；
 *  4. 在所有候选中取最高分后，在「得分与最高分接近」的格距里选最小的一个，避免选中
 *     真格距的整数倍；采样点很少的大格距先做收缩惩罚，避免被个别强边缘抬高；
 *  5. 对比度低于阈值（无周期结构，如照片 / 均匀色块）时回退 `cell=1, confidence=0`。
 *
 * @param {ArrayLike<number>} data RGBA 像素（长度 = width*height*4）
 * @param {number} width
 * @param {number} height
 * @param {{ minCell?: number, maxCell?: number, alphaCut?: number }} [options]
 *   `minCell` 最小候选格距（默认 2）、`maxCell` 最大候选格距（默认受契约上限与图幅约束）、
 *   `alphaCut` 透明判定阈值（默认 8）。
 * @returns {{ cell: number, offsetX: number, offsetY: number, confidence: number }}
 */
export function detectPixelGrid(data, width, height, options = {}) {
  const w = requireDimension(width, 'width')
  const h = requireDimension(height, 'height')
  const rgba = asRgba(data, w * h)

  const alphaCut = clampInt(options.alphaCut ?? DETECT_ALPHA_CUT, 0, 255, DETECT_ALPHA_CUT)
  const minCell = clampInt(options.minCell ?? Math.max(2, PIXEL.grid.min), 2, PIXEL.grid.max, 2)
  const boundedMax = Math.min(PIXEL.grid.max, Math.max(minCell, Math.floor(Math.min(w, h) / 2)))
  const maxCell = clampInt(options.maxCell ?? boundedMax, minCell, PIXEL.grid.max, boundedMax)

  const columnEdges = columnEdgeProjection(rgba, w, h, alphaCut)
  const rowEdges = rowEdgeProjection(rgba, w, h, alphaCut)
  const columnMean = meanEdgeStrength(columnEdges)
  const rowMean = meanEdgeStrength(rowEdges)

  if (columnMean <= DETECT_MIN_EDGE_MEAN && rowMean <= DETECT_MIN_EDGE_MEAN) return failedGrid()

  const candidates = []
  for (let cell = minCell; cell <= maxCell; cell++) {
    const columnMatch = bestPhaseMatch(columnEdges, columnMean, cell)
    const rowMatch = bestPhaseMatch(rowEdges, rowMean, cell)
    if (!columnMatch && !rowMatch) continue

    // 两轴都成立时用几何平均；只有一轴有周期结构时降权，避免把纯条纹图当成方格图。
    const bothAxes = Boolean(columnMatch && rowMatch)
    const contrast = bothAxes
      ? Math.sqrt(columnMatch.contrast * rowMatch.contrast)
      : (columnMatch || rowMatch).contrast * 0.85
    const adjusted = bothAxes
      ? Math.sqrt(columnMatch.adjusted * rowMatch.adjusted)
      : (columnMatch || rowMatch).adjusted * 0.85

    candidates.push({
      cell,
      contrast,
      adjusted,
      offsetX: columnMatch ? columnMatch.phase : 0,
      offsetY: rowMatch ? rowMatch.phase : 0,
    })
  }
  if (candidates.length === 0) return failedGrid()

  let best = candidates[0]
  for (const candidate of candidates) {
    if (candidate.adjusted > best.adjusted) best = candidate
  }
  if (!(best.contrast >= DETECT_MIN_CONTRAST)) return failedGrid()

  // 在「对比度与最优候选相差不超过 20%」的候选里取最小格距，落回基础周期。
  const requiredAdjusted = Math.max(DETECT_MIN_CONTRAST, best.adjusted * DETECT_FUNDAMENTAL_RATIO)
  const chosen =
    candidates.find(
      (candidate) => candidate.adjusted >= requiredAdjusted && candidate.contrast >= DETECT_MIN_CONTRAST,
    ) || best
  const confidence = round3(clamp01((chosen.contrast - 1) / DETECT_CONFIDENCE_SPAN))

  return {
    cell: chosen.cell,
    offsetX: chosen.offsetX,
    offsetY: chosen.offsetY,
    confidence,
  }
}

// ── 像素画重采样 + 调色盘量化 ─────────────────────────────────────────────

/** 为调色盘建立「原始颜色 → 最近调色盘下标」的查询器（带有限缓存）。 */
function createPaletteMapper(palette) {
  const centers = palette.map((entry) => {
    const [L, a, b] = rgbToOklab(entry.rgb[0], entry.rgb[1], entry.rgb[2])
    return [L, a, b]
  })
  const cache = new Map()

  return function lookup(packed) {
    const cached = cache.get(packed)
    if (cached !== undefined) return cached

    const r = (packed >> 16) & 255
    const g = (packed >> 8) & 255
    const b = packed & 255
    const [L, a, axisB] = rgbToOklab(r, g, b)

    let bestIndex = 0
    let bestDistance = Infinity
    for (let i = 0; i < centers.length; i++) {
      const distance = oklabDistanceSq(L, a, axisB, centers[i])
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = i
      }
    }

    if (cache.size < PALETTE_CACHE_LIMIT) cache.set(packed, bestIndex)
    return bestIndex
  }
}

/**
 * 像素对齐：按格距最近邻重采样 + Oklab 调色盘量化 + Alpha 硬边二值化。
 *
 * 步骤：
 *  1. 按 `cell` 把原图切成逻辑像素，每个逻辑格取中心像素（最近邻，不做插值）；
 *  2. 采样到的 Alpha 以 `alphaThreshold` 二值化为 0 / 255（像素画不需要半透明灰边）；
 *  3. 只对不透明采样点统计颜色，用 Oklab 中位切分 + K-Means 精修得到 ≤ `colors` 的调色盘；
 *  4. 每个逻辑像素映射到最近的调色盘颜色（Oklab 距离）；
 *  5. `scale > 1` 时按整数倍最近邻放大，尺寸 = 逻辑尺寸 × scale。
 *
 * 输出尺寸按 `round(width / cell) × round(height / cell)` 计算；`offsetX / offsetY`
 * 是格线相位（与 `detectPixelGrid` 的返回值同义），只影响采样位置，不改变尺寸。
 *
 * @param {ArrayLike<number>} data RGBA 像素（长度 = width*height*4）
 * @param {number} width
 * @param {number} height
 * @param {{
 *   cell?: number,
 *   offsetX?: number,
 *   offsetY?: number,
 *   colors?: number,
 *   alphaThreshold?: number,
 *   scale?: number,
 * }} [options]
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
export function snapPixelArt(data, width, height, options = {}) {
  const w = requireDimension(width, 'width')
  const h = requireDimension(height, 'height')
  const rgba = asRgba(data, w * h)

  const { min: cellMin, max: cellMax, default: cellDefault } = PIXEL.grid
  const cell = clampInt(options.cell ?? cellDefault, cellMin, cellMax, cellDefault)
  const offsetX = normalizeOffset(options.offsetX, cell)
  const offsetY = normalizeOffset(options.offsetY, cell)
  const colors = clampInt(options.colors ?? PIXEL.colors.default, PIXEL.colors.min, PIXEL.colors.max, PIXEL.colors.default)
  const alphaThreshold = clampInt(
    options.alphaThreshold ?? PIXEL.alphaThreshold.default,
    PIXEL.alphaThreshold.min,
    PIXEL.alphaThreshold.max,
    PIXEL.alphaThreshold.default,
  )
  const scale = clampInt(options.scale ?? PIXEL.scale.default, PIXEL.scale.min, PIXEL.scale.max, PIXEL.scale.default)

  const logicalWidth = Math.max(1, Math.round(w / cell))
  const logicalHeight = Math.max(1, Math.round(h / cell))
  const outWidth = logicalWidth * scale
  const outHeight = logicalHeight * scale

  const columnSources = new Int32Array(logicalWidth)
  for (let column = 0; column < logicalWidth; column++) {
    const source = Math.floor(offsetX + (column + 0.5) * cell)
    columnSources[column] = Math.min(w - 1, Math.max(0, source))
  }

  // -1 表示该逻辑像素透明；否则存 24bit RGB，后续用它查最近调色盘颜色。
  const logicalColors = new Int32Array(logicalWidth * logicalHeight).fill(-1)
  const histogram = createColorHistogram()

  for (let row = 0; row < logicalHeight; row++) {
    const sourceY = Math.min(h - 1, Math.max(0, Math.floor(offsetY + (row + 0.5) * cell)))
    const rowOffset = sourceY * w * 4
    const logicalOffset = row * logicalWidth
    for (let column = 0; column < logicalWidth; column++) {
      const sourceOffset = rowOffset + columnSources[column] * 4
      if (rgba[sourceOffset + 3] < alphaThreshold) continue
      const r = rgba[sourceOffset]
      const g = rgba[sourceOffset + 1]
      const b = rgba[sourceOffset + 2]
      logicalColors[logicalOffset + column] = (r << 16) | (g << 8) | b
      histogram.add(r, g, b)
    }
  }

  const palette = fitPalette(histogram.toPoints(), colors)
  const output = new Uint8ClampedArray(outWidth * outHeight * 4)
  if (palette.length === 0) {
    // 整幅全透明：直接返回同样尺寸的全零数据（Alpha 已经天然是 0）。
    return { width: outWidth, height: outHeight, data: output }
  }

  const lookup = createPaletteMapper(palette)
  const rowStride = outWidth * 4
  for (let row = 0; row < logicalHeight; row++) {
    const logicalOffset = row * logicalWidth
    for (let column = 0; column < logicalWidth; column++) {
      const packed = logicalColors[logicalOffset + column]
      if (packed < 0) continue
      const colorsOfCell = palette[lookup(packed)].rgb
      const baseX = column * scale
      const baseY = row * scale
      for (let dy = 0; dy < scale; dy++) {
        let target = (baseY + dy) * rowStride + baseX * 4
        for (let dx = 0; dx < scale; dx++) {
          output[target] = colorsOfCell[0]
          output[target + 1] = colorsOfCell[1]
          output[target + 2] = colorsOfCell[2]
          output[target + 3] = 255
          target += 4
        }
      }
    }
  }

  return { width: outWidth, height: outHeight, data: output }
}

// ── 无缝平铺 ──────────────────────────────────────────────────────────────

/**
 * 评估四方连续接缝误差：左右边 / 上下边的 RGB 平均绝对差（MAE）。
 *
 * 口径与 `worker/inference/game_ops.py:analyze_seamless_tile` 一致：逐行比较左右列、
 * 逐列比较上下行，三通道差值取平均；返回值保留 3 位小数，`isSeamless` 用未取整的
 * 原始误差与契约阈值比较。
 *
 * @param {ArrayLike<number>} data RGBA 像素（长度 = width*height*4）
 * @param {number} width
 * @param {number} height
 * @returns {{
 *   horizontalSeamMae: number,
 *   verticalSeamMae: number,
 *   maxSeamMae: number,
 *   isSeamless: boolean,
 *   threshold: number,
 * }}
 */
export function seamMae(data, width, height) {
  const w = requireDimension(width, 'width')
  const h = requireDimension(height, 'height')
  if (w < 2 || h < 2) throw new RangeError('接缝评估要求图像尺寸至少为 2x2')
  const rgba = asRgba(data, w * h)

  let horizontalTotal = 0
  for (let y = 0; y < h; y++) {
    const left = y * w * 4
    const right = left + (w - 1) * 4
    horizontalTotal += Math.abs(rgba[left] - rgba[right])
    horizontalTotal += Math.abs(rgba[left + 1] - rgba[right + 1])
    horizontalTotal += Math.abs(rgba[left + 2] - rgba[right + 2])
  }
  const horizontalSeamMae = horizontalTotal / (h * 3)

  let verticalTotal = 0
  for (let x = 0; x < w; x++) {
    const top = x * 4
    const bottom = ((h - 1) * w + x) * 4
    verticalTotal += Math.abs(rgba[top] - rgba[bottom])
    verticalTotal += Math.abs(rgba[top + 1] - rgba[bottom + 1])
    verticalTotal += Math.abs(rgba[top + 2] - rgba[bottom + 2])
  }
  const verticalSeamMae = verticalTotal / (w * 3)

  const maxSeamMae = Math.max(horizontalSeamMae, verticalSeamMae)
  return {
    horizontalSeamMae: round3(horizontalSeamMae),
    verticalSeamMae: round3(verticalSeamMae),
    maxSeamMae: round3(maxSeamMae),
    isSeamless: maxSeamMae <= TILE.seamlessThreshold,
    threshold: TILE.seamlessThreshold,
  }
}

/**
 * 纯 CPU 兜底混边：半格滚动把四边接缝移到中心十字，再按余弦权重把原图中心带复合回去。
 *
 * 与 `game_ops.py:blend_seamless_edges` 同一思路：滚动后的图像边缘来自原图内部相邻
 * 像素（通常连续），接缝两侧因此自然接近；中心十字区域再用原图权重渐隐，避免整幅
 * 纹理被平移后与用户预期错位。返回新数组，不修改入参。
 *
 * @param {ArrayLike<number>} data RGBA 像素（长度 = width*height*4）
 * @param {number} width
 * @param {number} height
 * @param {{ borderRatio?: number }} [options] 混边带宽占边长的比例（钳制到契约边界）
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
export function blendSeamEdges(data, width, height, options = {}) {
  const w = requireDimension(width, 'width')
  const h = requireDimension(height, 'height')
  const rgba = asRgba(data, w * h)
  const borderRatio = clampNumber(
    options.borderRatio ?? TILE.blendRatio.default,
    TILE.blendRatio.min,
    TILE.blendRatio.max,
    TILE.blendRatio.default,
  )

  const halfX = Math.floor(w / 2)
  const halfY = Math.floor(h / 2)
  const bandX = Math.max(2, Math.floor(w * borderRatio))
  const bandY = Math.max(2, Math.floor(h * borderRatio))
  const centerX = w - halfX
  const centerY = h - halfY

  const output = new Uint8ClampedArray(rgba.length)
  for (let y = 0; y < h; y++) {
    const rolledY = (y + halfY) % h
    const dy = Math.abs(y - centerY)
    const weightY = dy < bandY ? 0.5 * (1 + Math.cos(Math.PI * Math.min(1, dy / bandY))) : 0

    for (let x = 0; x < w; x++) {
      const rolledX = (x + halfX) % w
      const target = (y * w + x) * 4
      const rolled = (rolledY * w + rolledX) * 4
      const source = target

      const dx = Math.abs(x - centerX)
      const weightX = dx < bandX ? 0.5 * (1 + Math.cos(Math.PI * Math.min(1, dx / bandX))) : 0
      const weight = Math.max(weightX, weightY)

      if (weight <= 0) {
        output[target] = rgba[rolled]
        output[target + 1] = rgba[rolled + 1]
        output[target + 2] = rgba[rolled + 2]
        output[target + 3] = rgba[rolled + 3]
        continue
      }

      const inverse = 1 - weight
      output[target] = Math.round(rgba[rolled] * inverse + rgba[source] * weight)
      output[target + 1] = Math.round(rgba[rolled + 1] * inverse + rgba[source + 1] * weight)
      output[target + 2] = Math.round(rgba[rolled + 2] * inverse + rgba[source + 2] * weight)
      output[target + 3] = Math.round(rgba[rolled + 3] * inverse + rgba[source + 3] * weight)
    }
  }

  return { width: w, height: h, data: output }
}

// ── 平铺预览几何 ──────────────────────────────────────────────────────────

/**
 * 计算 `repeat × repeat` 平铺预览的画布几何。
 *
 * 返回画布尺寸与每块的位置（左上角坐标），供 canvas 逐块 `drawImage` 或 CSS 背景
 * 平铺使用。默认 `repeat = WORKSHOP.tile.repeat`（2，即工坊的 2×2 检查视图）。
 *
 * @param {number} width 单块宽
 * @param {number} height 单块高
 * @param {{ repeat?: number }} [options]
 * @returns {{ width: number, height: number, placements: Array<{ x: number, y: number }> }}
 */
export function tabulateTiles(width, height, options = {}) {
  const w = requireDimension(width, 'width')
  const h = requireDimension(height, 'height')
  const repeat = clampInt(options.repeat ?? TILE.repeat, 1, MAX_TILE_REPEAT, TILE.repeat)

  const placements = []
  for (let row = 0; row < repeat; row++) {
    for (let column = 0; column < repeat; column++) {
      placements.push({ x: column * w, y: row * h })
    }
  }

  return { width: w * repeat, height: h * repeat, placements }
}

// ── 序列帧切片 + atlas ────────────────────────────────────────────────────

/**
 * 求一帧内非透明内容的包围盒（Alpha > 0 才算内容，与 PIL `getbbox()` 的 RGBA 口径一致）。
 *
 * @returns {{ x: number, y: number, w: number, h: number } | null} 全透明时返回 null
 */
function alphaBbox(rgba, sheetWidth, originX, originY, frameWidth, frameHeight) {
  let minX = frameWidth
  let minY = frameHeight
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < frameHeight; y++) {
    const rowOffset = ((originY + y) * sheetWidth + originX) * 4
    for (let x = 0; x < frameWidth; x++) {
      if (rgba[rowOffset + x * 4 + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * 按网格切分序列帧大图，并生成 Aseprite 兼容的 atlas 元数据。
 *
 * 与 `game_ops.py:slice_sprite_sheet` 的字段口径对齐：
 *  - `frames[i]`：`x / y` 是未裁剪的格子原点，`w / h` 是格子尺寸；`srcX / srcY / srcW / srcH`
 *    是裁剪后内容相对格子的偏移与尺寸；
 *  - `atlas.frames[name]`：`frame` 是裁剪内容在整张图上的绝对矩形，`spriteSourceSize`
 *    是裁剪框（相对格子），`sourceSize` 是格子尺寸，`pivot` 固定为帧中心；
 *  - `trimAlpha` 为真时全透明格直接跳过且不占用帧序号；为假时保留所有格子。
 *
 * @param {ArrayLike<number>} data RGBA 像素（长度 = width*height*4）
 * @param {number} width
 * @param {number} height
 * @param {{ rows?: number, cols?: number, trimAlpha?: boolean, minFrameEdge?: number }} [options]
 * @returns {{
 *   frames: Array<{
 *     index: number,
 *     name: string,
 *     x: number,
 *     y: number,
 *     w: number,
 *     h: number,
 *     srcX: number,
 *     srcY: number,
 *     srcW: number,
 *     srcH: number,
 *     trimmed: boolean,
 *   }>,
 *   atlas: {
 *     meta: {
 *       app: string,
 *       format: string,
 *       size: { w: number, h: number },
 *       frameSize: { w: number, h: number },
 *       count: number,
 *     },
 *     frames: Record<string, {
 *       frame: { x: number, y: number, w: number, h: number },
 *       trimmed: boolean,
 *       spriteSourceSize: { x: number, y: number, w: number, h: number },
 *       sourceSize: { w: number, h: number },
 *       pivot: { x: number, y: number },
 *     }>,
 *   },
 * }}
 */
export function sliceSpriteFrames(data, width, height, options = {}) {
  const w = requireDimension(width, 'width')
  const h = requireDimension(height, 'height')
  const rgba = asRgba(data, w * h)

  const rows = clampInt(options.rows ?? SPRITE.rows.default, SPRITE.rows.min, SPRITE.rows.max, SPRITE.rows.default)
  const cols = clampInt(options.cols ?? SPRITE.cols.default, SPRITE.cols.min, SPRITE.cols.max, SPRITE.cols.default)
  const trimAlpha = options.trimAlpha === undefined ? SPRITE.trimAlpha : Boolean(options.trimAlpha)
  const minFrameEdge = clampInt(options.minFrameEdge ?? SPRITE.minFrameEdge, 1, SPRITE.maxInputEdge, SPRITE.minFrameEdge)

  if (rows * cols > SPRITE.maxFrames) {
    throw new RangeError(`序列帧数量 ${rows}×${cols} 超过上限 ${SPRITE.maxFrames}`)
  }

  const frameWidth = Math.floor(w / cols)
  const frameHeight = Math.floor(h / rows)
  if (frameWidth < minFrameEdge || frameHeight < minFrameEdge) {
    throw new RangeError(
      `单帧尺寸 ${frameWidth}×${frameHeight} 小于最小边长 ${minFrameEdge}；请减少行列数或提高输入分辨率`,
    )
  }

  const frames = []
  const atlasFrames = {}

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < cols; column++) {
      const originX = column * frameWidth
      const originY = row * frameHeight

      let srcX = 0
      let srcY = 0
      let srcW = frameWidth
      let srcH = frameHeight
      let trimmed = false

      if (trimAlpha) {
        const bbox = alphaBbox(rgba, w, originX, originY, frameWidth, frameHeight)
        // 全透明占位格直接跳过，也不占用帧序号（与 Python 实现一致）。
        if (!bbox) continue
        srcX = bbox.x
        srcY = bbox.y
        srcW = bbox.w
        srcH = bbox.h
        trimmed = srcX !== 0 || srcY !== 0 || srcW !== frameWidth || srcH !== frameHeight
      }

      const index = frames.length
      const name = `frame_${String(index).padStart(3, '0')}.png`
      frames.push({
        index,
        name,
        x: originX,
        y: originY,
        w: frameWidth,
        h: frameHeight,
        srcX,
        srcY,
        srcW,
        srcH,
        trimmed,
      })
      atlasFrames[name] = {
        frame: { x: originX + srcX, y: originY + srcY, w: srcW, h: srcH },
        trimmed,
        spriteSourceSize: { x: srcX, y: srcY, w: srcW, h: srcH },
        sourceSize: { w: frameWidth, h: frameHeight },
        pivot: { x: 0.5, y: 0.5 },
      }
    }
  }

  return {
    frames,
    atlas: {
      meta: {
        app: 'aigc-studio',
        format: 'RGBA8888',
        size: { w, h },
        frameSize: { w: frameWidth, h: frameHeight },
        count: frames.length,
      },
      frames: atlasFrames,
    },
  }
}
