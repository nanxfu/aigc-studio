/**
 * 工坊空间滤镜（M4.2e-2）的纯算法层。
 *
 * 输入统一为：
 *  - `image`：RGBA `{ width, height, data }`（Uint8/Uint8ClampedArray）；
 *  - `depth`：`{ width, height, data: Float32Array }`，0 = 最近前景、1 = 最远背景；
 *  - `normal`（可选）：RGBA 法线贴图，用于给贴地雾与物理打光提供方向证据。
 *
 * 本文件不依赖 DOM / canvas / React，Node 单测可直接跑。预览与最终应用共用同一套
 * 参数方程，只有工作分辨率不同，避免「预览好看、落盘变样」。
 */

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
const smoothstep = (edge0, edge1, value) => {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0))
  return t * t * (3 - 2 * t)
}
const srgbToLin = (value) => Math.pow(Math.max(0, value / 255), 2.2)
const linToSrgb = (value) => Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, value), 1 / 2.2) * 255)))
const ign = (x, y) => {
  const f = (x * 0.06711056 + y * 0.00583715) % 1
  return (52.9829189 * f) % 1
}

export function estimatePixels(pixels) {
  return pixels && Number(pixels.width) > 0 && Number(pixels.height) > 0
    ? Number(pixels.width) * Number(pixels.height)
    : 0
}

/** 灰度 / 亮度深度图 → 归一化深度（默认近白远黑，`invert: true` 时反转）。 */
export function depthMapFromPixels(pixels, options = {}) {
  if (!pixels || !pixels.width || !pixels.height || !pixels.data) return null
  const width = Number(pixels.width)
  const height = Number(pixels.height)
  const invert = options.invert === true
  const data = new Float32Array(width * height)
  for (let i = 0; i < width * height; i += 1) {
    const index = i * 4
    const luminance = pixels.data[index] * 0.2126
      + pixels.data[index + 1] * 0.7152
      + pixels.data[index + 2] * 0.0722
    data[i] = invert ? clamp01(luminance / 255) : clamp01(1 - luminance / 255)
  }
  return { width, height, data }
}

/** 全分辨率 RGBA → 最大长边 `maxEdge` 的预览副本（面积平均，避免深色细线丢失）。 */
export function resizePixels(pixels, maxEdge = 512) {
  if (!pixels || !pixels.width || !pixels.height || !pixels.data) return null
  const width = Number(pixels.width)
  const height = Number(pixels.height)
  const limit = Math.max(1, Math.round(Number(maxEdge) || 512))
  if (Math.max(width, height) <= limit) {
    return { width, height, data: new Uint8ClampedArray(pixels.data) }
  }
  const scale = limit / Math.max(width, height)
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))
  const out = new Uint8ClampedArray(targetW * targetH * 4)
  for (let y = 0; y < targetH; y += 1) {
    const y0 = Math.floor((y / targetH) * height)
    const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil(((y + 1) / targetH) * height)))
    for (let x = 0; x < targetW; x += 1) {
      const x0 = Math.floor((x / targetW) * width)
      const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil(((x + 1) / targetW) * width)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const source = (sy * width + sx) * 4
          r += pixels.data[source]
          g += pixels.data[source + 1]
          b += pixels.data[source + 2]
          a += pixels.data[source + 3]
          count += 1
        }
      }
      const target = (y * targetW + x) * 4
      out[target] = Math.round(r / count)
      out[target + 1] = Math.round(g / count)
      out[target + 2] = Math.round(b / count)
      out[target + 3] = Math.round(a / count)
    }
  }
  return { width: targetW, height: targetH, data: out }
}

/** 把深度场缩放到指定尺寸（双线性）。 */
export function resizeDepth(depth, width, height) {
  if (!depth || !depth.data) return null
  const targetW = Math.max(1, Math.round(width))
  const targetH = Math.max(1, Math.round(height))
  if (depth.width === targetW && depth.height === targetH) {
    return { width: targetW, height: targetH, data: new Float32Array(depth.data) }
  }
  const out = new Float32Array(targetW * targetH)
  for (let y = 0; y < targetH; y += 1) {
    const sourceY = Math.min(depth.height - 1, Math.max(0, ((y + 0.5) / targetH) * depth.height - 0.5))
    const y0 = Math.floor(sourceY)
    const y1 = Math.min(depth.height - 1, y0 + 1)
    const wy = sourceY - y0
    for (let x = 0; x < targetW; x += 1) {
      const sourceX = Math.min(depth.width - 1, Math.max(0, ((x + 0.5) / targetW) * depth.width - 0.5))
      const x0 = Math.floor(sourceX)
      const x1 = Math.min(depth.width - 1, x0 + 1)
      const wx = sourceX - x0
      const top = depth.data[y0 * depth.width + x0] * (1 - wx)
        + depth.data[y0 * depth.width + x1] * wx
      const bottom = depth.data[y1 * depth.width + x0] * (1 - wx)
        + depth.data[y1 * depth.width + x1] * wx
      out[y * targetW + x] = clamp01(top * (1 - wy) + bottom * wy)
    }
  }
  return { width: targetW, height: targetH, data: out }
}

/**
 * 由深度梯度生成 OpenGL 风格法线图。
 *
 * 先做保边平滑削弱量化台阶，再对前景/背景深度断崖做梯度衰减与软钳位，
 * 避免在遮挡边界处虚构出 90° 陡坡（物理打光时会在轮廓形成黑/白描边）。
 */
export function normalPixelsFromDepth(depth, options = {}) {
  if (!depth || !depth.data) return null
  const strength = Math.max(0.1, Number(options.strength) || 2.4)
  const { width, height, data } = depth
  const out = new Uint8ClampedArray(width * height * 4)
  const rawAt = (x, y) => data[
    Math.max(0, Math.min(height - 1, y)) * width
    + Math.max(0, Math.min(width - 1, x))
  ]
  const smooth = new Float32Array(width * height)
  // 3×3 保边平滑：同一表面内的微小台阶会被抹平，跨过前景/背景深度断崖时权重大幅衰减。
  const rangeScale = 1 / (0.045 * 0.045)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const center = rawAt(x, y)
      let sum = center * 4
      let weightSum = 4
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue
          const sample = rawAt(x + ox, y + oy)
          const diff = sample - center
          const spatial = (ox === 0 || oy === 0) ? 2 : 1
          const w = spatial / (1 + diff * diff * rangeScale)
          sum += sample * w
          weightSum += w
        }
      }
      smooth[y * width + x] = sum / weightSum
    }
  }
  const at = (x, y) => smooth[
    Math.max(0, Math.min(height - 1, y)) * width
    + Math.max(0, Math.min(width - 1, x))
  ]
  const spanPx = Math.max(1, Math.round(Math.min(width, height) / 256))
  const maxSlope = 0.65
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const left = at(x - 1, y)
      const right = at(x + 1, y)
      const top = at(x, y - 1)
      const bottom = at(x, y + 1)
      const jump = Math.max(
        Math.abs(at(x + spanPx, y) - at(x - spanPx, y)),
        Math.abs(at(x, y + spanPx) - at(x, y - spanPx)),
      )
      const cliffDamp = 1 / (1 + (Math.max(0, jump - 0.12) / 0.12) ** 2)
      let dx = (right - left) * strength * cliffDamp
      let dy = (bottom - top) * strength * cliffDamp
      const mag = Math.hypot(dx, dy)
      if (mag > 0) {
        const clamped = maxSlope * Math.tanh(mag / maxSlope)
        const scale = clamped / mag
        dx *= scale
        dy *= scale
      }
      const nx = dx
      const ny = -dy
      const nz = 1
      const length = Math.hypot(nx, ny, nz) || 1
      const index = (y * width + x) * 4
      out[index] = Math.round((nx / length * 0.5 + 0.5) * 255)
      out[index + 1] = Math.round((ny / length * 0.5 + 0.5) * 255)
      out[index + 2] = Math.round((nz / length * 0.5 + 0.5) * 255)
      out[index + 3] = 255
    }
  }
  return { width, height, data: out }
}

/** 归一化深度场 → 近白远黑的灰度 RGBA（落盘 `depth.png` 的展示格式）。 */
export function pixelsFromDepth(depth) {
  if (!depth || !depth.data || !depth.width || !depth.height) return null
  const width = Number(depth.width)
  const height = Number(depth.height)
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const value = Math.round((1 - clamp01(depth.data[i])) * 255)
    const index = i * 4
    out[index] = value
    out[index + 1] = value
    out[index + 2] = value
    out[index + 3] = 255
  }
  return { width, height, data: out }
}

export function hexToRgb(hex) {
  const value = typeof hex === 'string' ? hex.trim().replace(/^#/, '') : ''
  const full = value.length === 3 ? value.split('').map((ch) => ch + ch).join('') : value
  if (!/^[0-9a-f]{6}$/i.test(full)) return { r: 255, g: 255, b: 255 }
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

function depthAt(depth, x, y) {
  return depth?.data ? clamp01(depth.data[y * depth.width + x]) : 0.5
}

function normalAt(normal, x, y) {
  if (!normal || !normal.data || !normal.width || !normal.height) return null
  const index = (Math.min(normal.height - 1, y) * normal.width + Math.min(normal.width - 1, x)) * 4
  const nx = normal.data[index] / 127.5 - 1
  const ny = normal.data[index + 1] / 127.5 - 1
  const nz = normal.data[index + 2] / 127.5 - 1
  const length = Math.hypot(nx, ny, nz) || 1
  return { x: nx / length, y: ny / length, z: nz / length }
}

function spatialWeightOf(x, y, width, height, settings) {
  let weight = 1
  const points = []
  if (Array.isArray(settings.anchors)) points.push(...settings.anchors)
  if (Array.isArray(settings.strokes)) points.push(...settings.strokes)
  for (const point of points) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) continue
    const aspect = width / Math.max(1, height)
    const dx = (x / Math.max(1, width - 1) - Number(point.x)) * aspect
    const dy = y / Math.max(1, height - 1) - Number(point.y)
    const radius = Math.max(0.01, Number(point.radius) || 0.18)
    const feather = Math.max(0.03, Number(point.feather) || 0.65)
    const distance = Math.hypot(dx, dy)
    const influence = 1 - smoothstep(radius * (1 - feather * 0.35), radius, distance)
    if (influence <= 0) continue
    const strength = Math.max(0, Number(point.strength) || 0.8)
    if (point.mode === 'subtract') weight *= 1 - strength * influence
    else weight += strength * influence
  }
  return Math.max(0, weight)
}

function fogPixel(r, g, b, depthValue, x, y, width, height, settings, fog) {
  const start = clamp01(settings.startDepth)
  const falloff = Math.max(0.05, Number(settings.falloff) || 1.4)
  const baseDepthWeight = depthValue <= start
    ? 0
    : 1 - Math.exp(-(depthValue - start) * falloff * 4.2)
  let heightWeight = 1
  if ((settings.groundBias || 0) > 0) {
    const horizon = Math.max(0.05, Math.min(0.98, Number(settings.horizon) || 0.6))
    const normalized = clamp01(y / Math.max(1, height - 1))
    const ground = smoothstep(horizon - 0.42, horizon + 0.18, normalized)
    heightWeight = (1 - settings.groundBias) + settings.groundBias * (0.35 + 0.65 * ground)
    const normal = normalAt(settings.normal, x, y)
    if (normal) {
      // 切空间法线的 Y 分量朝上时略微加强贴地雾；朝下/侧墙则减弱，避免整面墙糊成一片。
      heightWeight *= 0.82 + 0.28 * clamp01(normal.y * 0.5 + 0.5)
    }
  }
  const spatial = spatialWeightOf(x, y, width, height, settings)
  // 显式放了「聚雾 (+)」锚点/画笔时允许在局部轻微透雾，避免点在近中景完全没反应。
  const localBoost = spatial > 1 ? Math.min(0.55, (spatial - 1) * 0.45) : 0
  const effectiveDepth = Math.max(baseDepthWeight, localBoost * (0.35 + 0.65 * depthValue))
  const alpha = clamp01(settings.density * effectiveDepth * heightWeight * spatial)
  if (alpha <= 0.0001) return [r, g, b]
  const color = fog.color
  const srLin = srgbToLin(r)
  const sgLin = srgbToLin(g)
  const sbLin = srgbToLin(b)
  const frLin = srgbToLin(color.r)
  const fgLin = srgbToLin(color.g)
  const fbLin = srgbToLin(color.b)
  if (settings.blend === 'screen') {
    const mix = alpha * 0.88
    const scrR = 1 - (1 - srLin) * (1 - frLin)
    const scrG = 1 - (1 - sgLin) * (1 - fgLin)
    const scrB = 1 - (1 - sbLin) * (1 - fbLin)
    return [
      linToSrgb(srLin + (scrR - srLin) * mix),
      linToSrgb(sgLin + (scrG - sgLin) * mix),
      linToSrgb(sbLin + (scrB - sbLin) * mix),
    ]
  }
  const mix = alpha * 0.94
  return [
    linToSrgb(srLin + (frLin - srLin) * mix),
    linToSrgb(sgLin + (fgLin - sgLin) * mix),
    linToSrgb(sbLin + (fbLin - sbLin) * mix),
  ]
}

function atmospherePixel(r, g, b, depthValue, settings, color) {
  const depthWeight = smoothstep(settings.startDepth, 1, depthValue)
  if (depthWeight <= 0.0001) return [r, g, b]
  const amount = clamp01(settings.haze * depthWeight)
  const srLin = srgbToLin(r)
  const sgLin = srgbToLin(g)
  const sbLin = srgbToLin(b)
  const lumLin = srLin * 0.2126 + sgLin * 0.7152 + sbLin * 0.0722
  const desat = clamp01(settings.desaturate * depthWeight)
  let rr = srLin + (lumLin - srLin) * desat
  let gg = sgLin + (lumLin - sgLin) * desat
  let bb = sbLin + (lumLin - sbLin) * desat
  const arLin = srgbToLin(color.r)
  const agLin = srgbToLin(color.g)
  const abLin = srgbToLin(color.b)
  rr += (arLin - rr) * amount
  gg += (agLin - gg) * amount
  bb += (abLin - bb) * amount
  // 对比度只调制受大气影响的远景像素，前景 100% 保持原图锐度与反差。
  const effContrast = 1 + (settings.contrast - 1) * depthWeight
  const outR = linToSrgb(rr)
  const outG = linToSrgb(gg)
  const outB = linToSrgb(bb)
  return [
    (outR - 128) * effContrast + 128,
    (outG - 128) * effContrast + 128,
    (outB - 128) * effContrast + 128,
  ]
}

const VOGEL_TAPS = 24
const GOLDEN_ANGLE = 2.39996323
const VOGEL_OFFSETS = Array.from({ length: VOGEL_TAPS }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / VOGEL_TAPS)
  const theta = i * GOLDEN_ANGLE
  return { r, cos: Math.cos(theta), sin: Math.sin(theta) }
})

function robustFocusDepth(depth, focusX, focusY) {
  const cx = Math.round(focusX * (depth.width - 1))
  const cy = Math.round(focusY * (depth.height - 1))
  let sum = 0
  let weightSum = 0
  for (let oy = -2; oy <= 2; oy += 1) {
    const sy = Math.max(0, Math.min(depth.height - 1, cy + oy))
    for (let ox = -2; ox <= 2; ox += 1) {
      const sx = Math.max(0, Math.min(depth.width - 1, cx + ox))
      const w = 1 / (1 + ox * ox + oy * oy)
      sum += depthAt(depth, sx, sy) * w
      weightSum += w
    }
  }
  return sum / Math.max(1e-6, weightSum)
}

function computeDofCocField(depth, width, height, settings) {
  const focusDepth = robustFocusDepth(depth, settings.focusX, settings.focusY)
  const aperture = Math.max(0.02, settings.aperture)
  const deadzone = settings.tiltShift ? aperture * 0.12 : aperture * 0.16
  const total = width * height
  const coc = new Float32Array(total)
  const nearCoc = new Float32Array(total)
  for (let y = 0; y < height; y += 1) {
    const ny = y / Math.max(1, height - 1)
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x
      const d = depthAt(depth, x, y)
      const diff = settings.tiltShift
        ? clamp01(Math.abs(ny - settings.focusY) * 2.4)
        : (d - focusDepth)
      const mag = Math.max(0, Math.abs(diff) - deadzone)
      const val = smoothstep(0, aperture, mag)
      const signed = diff < 0 && !settings.tiltShift ? -val : val
      coc[idx] = signed
      if (signed < 0) nearCoc[idx] = -signed
    }
  }
  return { coc, nearCoc }
}

function blurPixelDof(source, depth, cocField, nearField, x, y, width, height, settings, scale) {
  const centerIdx = y * width + x
  const centerSigned = cocField[centerIdx]
  const centerAbs = Math.abs(centerSigned)
  const centerNear = nearField[centerIdx]
  // 焦内像素且周围无虚化前景溢入时直接直通原图，保证 100% 锐利。
  const maxRadius = settings.blur * scale
  const probeStep = Math.max(2, Math.round(maxRadius * 0.45))
  let localNear = centerNear
  if (centerAbs < 0.03 && maxRadius >= 1) {
    for (let oy = -1; oy <= 1; oy += 1) {
      const sy = Math.max(0, Math.min(height - 1, y + oy * probeStep))
      for (let ox = -1; ox <= 1; ox += 1) {
        const sx = Math.max(0, Math.min(width - 1, x + ox * probeStep))
        localNear = Math.max(localNear, nearField[sy * width + sx])
      }
    }
  }
  const effectiveCoc = Math.max(centerAbs, localNear * 0.75)
  const radius = effectiveCoc * maxRadius
  const center = centerIdx * 4
  if (radius < 0.55) {
    return [source[center], source[center + 1], source[center + 2], source[center + 3]]
  }
  const centerDepth = depthAt(depth, x, y)
  const jitter = ign(x, y) * Math.PI * 2
  const cosJ = Math.cos(jitter)
  const sinJ = Math.sin(jitter)
  const centerWeight = Math.max(0.08, 1 - effectiveCoc * 0.85)
  let sumR = source[center] * centerWeight
  let sumG = source[center + 1] * centerWeight
  let sumB = source[center + 2] * centerWeight
  let sumA = source[center + 3] * centerWeight
  let totalWeight = centerWeight

  for (let i = 0; i < VOGEL_TAPS; i += 1) {
    const tap = VOGEL_OFFSETS[i]
    const rx = tap.cos * cosJ - tap.sin * sinJ
    const ry = tap.cos * sinJ + tap.sin * cosJ
    const dist = tap.r * radius
    const sx = Math.max(0, Math.min(width - 1, Math.round(x + rx * dist)))
    const sy = Math.max(0, Math.min(height - 1, Math.round(y + ry * dist)))
    const sIdx = sy * width + sx
    const sDepth = depthAt(depth, sx, sy)
    const sSigned = cocField[sIdx]
    const sAbs = Math.abs(sSigned)
    // 防渗色核心：背景像素采集时屏蔽比自己更近且处于焦内的前景像素，彻底消除人物轮廓光晕。
    let w = 1
    if (centerSigned >= 0 && sDepth < centerDepth - 0.04) {
      w = sSigned < -0.05 ? clamp01(-sSigned * 1.6) : smoothstep(0.08, 0.38, sAbs) * 0.15
    } else if (centerAbs > 0.05) {
      w = 0.25 + 0.75 * smoothstep(0.0, Math.max(0.1, tap.r * 0.7), sAbs)
    }
    if (w <= 0.005) continue
    const p = sIdx * 4
    sumR += source[p] * w
    sumG += source[p + 1] * w
    sumB += source[p + 2] * w
    sumA += source[p + 3] * w
    totalWeight += w
  }
  return [
    sumR / totalWeight,
    sumG / totalWeight,
    sumB / totalWeight,
    sumA / totalWeight,
  ]
}

function sampleBilinearRgba(source, width, height, fx, fy) {
  const cx = Math.max(0, Math.min(width - 1, fx))
  const cy = Math.max(0, Math.min(height - 1, fy))
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const wx = cx - x0
  const wy = cy - y0
  const i00 = (y0 * width + x0) * 4
  const i10 = (y0 * width + x1) * 4
  const i01 = (y1 * width + x0) * 4
  const i11 = (y1 * width + x1) * 4
  const invX = 1 - wx
  const invY = 1 - wy
  const w00 = invX * invY
  const w10 = wx * invY
  const w01 = invX * wy
  const w11 = wx * wy
  return [
    source[i00] * w00 + source[i10] * w10 + source[i01] * w01 + source[i11] * w11,
    source[i00 + 1] * w00 + source[i10 + 1] * w10 + source[i01 + 1] * w01 + source[i11 + 1] * w11,
    source[i00 + 2] * w00 + source[i10 + 2] * w10 + source[i01 + 2] * w01 + source[i11 + 2] * w11,
    source[i00 + 3] * w00 + source[i10 + 3] * w10 + source[i01 + 3] * w01 + source[i11 + 3] * w11,
  ]
}

function sampleBilinearDepth(data, width, height, fx, fy) {
  const cx = Math.max(0, Math.min(width - 1, fx))
  const cy = Math.max(0, Math.min(height - 1, fy))
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const wx = cx - x0
  const wy = cy - y0
  const top = data[y0 * width + x0] * (1 - wx) + data[y0 * width + x1] * wx
  const bot = data[y1 * width + x0] * (1 - wx) + data[y1 * width + x1] * wx
  return top * (1 - wy) + bot * wy
}

/**
 * 为 2.5D 视差预生成背景外扩补洞层（LDI 思路）：
 * 识别前景/背景深度断崖，把远景颜色沿背景侧向前景遮挡区温和外扩，
 * 避免视角移动时露出黑色空洞或把前景颜色拖拽成“梳子齿”。
 */
function buildDisoccludedBackground(source, depthData, width, height, expandPx) {
  const total = width * height
  const bgColor = new Uint8ClampedArray(source)
  const bgDepth = new Float32Array(depthData)
  const passes = Math.min(18, Math.max(2, Math.ceil(expandPx)))
  // 先标出紧贴深度断崖的前景边缘作为扩展起点。
  let frontier = []
  const visited = new Uint8Array(total)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x
      const d = bgDepth[idx]
      let maxNeighborD = d
      for (let oy = -1; oy <= 1; oy += 1) {
        const ny = y + oy
        if (ny < 0 || ny >= height) continue
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue
          const nx = x + ox
          if (nx < 0 || nx >= width) continue
          const nd = bgDepth[ny * width + nx]
          if (nd > maxNeighborD) maxNeighborD = nd
        }
      }
      if (maxNeighborD - d > 0.1) {
        frontier.push(idx)
        visited[idx] = 1
      }
    }
  }
  for (let pass = 0; pass < passes && frontier.length > 0; pass += 1) {
    const next = []
    const updates = []
    for (let i = 0; i < frontier.length; i += 1) {
      const idx = frontier[i]
      const x = idx % width
      const y = (idx - x) / width
      const curD = bgDepth[idx]
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let dSum = 0
      let count = 0
      let maxD = curD
      for (let oy = -1; oy <= 1; oy += 1) {
        const ny = y + oy
        if (ny < 0 || ny >= height) continue
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue
          const nx = x + ox
          if (nx < 0 || nx >= width) continue
          const nIdx = ny * width + nx
          const nd = bgDepth[nIdx]
          if (nd > maxD) maxD = nd
        }
      }
      if (maxD <= curD + 0.04) continue
      const accept = maxD - 0.06
      for (let oy = -1; oy <= 1; oy += 1) {
        const ny = y + oy
        if (ny < 0 || ny >= height) continue
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue
          const nx = x + ox
          if (nx < 0 || nx >= width) continue
          const nIdx = ny * width + nx
          if (bgDepth[nIdx] < accept) continue
          const p = nIdx * 4
          r += bgColor[p]
          g += bgColor[p + 1]
          b += bgColor[p + 2]
          a += bgColor[p + 3]
          dSum += bgDepth[nIdx]
          count += 1
        }
      }
      if (count > 0) {
        updates.push({
          idx,
          z: dSum / count,
          r: Math.round(r / count),
          g: Math.round(g / count),
          b: Math.round(b / count),
          a: Math.round(a / count),
        })
        for (let oy = -1; oy <= 1; oy += 1) {
          const ny = y + oy
          if (ny < 0 || ny >= height) continue
          for (let ox = -1; ox <= 1; ox += 1) {
            const nx = x + ox
            if (nx < 0 || nx >= width) continue
            const nIdx = ny * width + nx
            if (!visited[nIdx]) {
              visited[nIdx] = 1
              next.push(nIdx)
            }
          }
        }
      }
    }
    if (updates.length === 0) break
    for (let u = 0; u < updates.length; u += 1) {
      const item = updates[u]
      bgDepth[item.idx] = item.z
      const dst = item.idx * 4
      bgColor[dst] = item.r
      bgColor[dst + 1] = item.g
      bgColor[dst + 2] = item.b
      bgColor[dst + 3] = item.a
    }
    frontier = next
  }
  return { bgColor, bgDepth }
}

/**
 * 连续反向视差光线步进（Relief Mapping + 双线性重采样 + 背景补洞层兜底）。
 *
 * 彻底告别整数像素 `Math.round` 前向点泼溅带来的针孔与“梳子齿”撕裂，
 * 在亚像素层面平滑还原前景遮挡与背景重露。
 */
function applyParallax(source, depth, width, height, settings) {
  const total = width * height
  const out = new Uint8ClampedArray(total * 4)
  const scale = Math.max(1, Math.max(width, height) / 384)
  const amp = Math.max(0, Number(settings.amplitude) || 0) * scale
  const sxFactor = Number(settings.shiftX) || 0
  const syFactor = Number(settings.shiftY) || 0
  const vx = amp * sxFactor
  const vy = amp * syFactor
  const shiftMag = Math.hypot(vx, vy)
  if (shiftMag < 0.05) {
    out.set(source)
    return out
  }
  const { bgColor, bgDepth } = buildDisoccludedBackground(source, depth.data, width, height, shiftMag * 1.25)
  const steps = Math.min(36, Math.max(16, Math.ceil(shiftMag * 1.4)))
  const stepD = 1 / steps
  const shellThickness = Math.max(0.065, stepD * 2.4)
  const rawDepth = depth.data

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hit = false
      let hitD = 1
      let hitSrcX = x
      let hitSrcY = y
      let hitEdgeSoft = 1
      for (let s = 0; s <= steps; s += 1) {
        const rayD = s * stepD
        const disp = (rayD - 0.5) * 2
        const sx = x + vx * disp
        const sy = y + vy * disp
        const sceneD = sampleBilinearDepth(rawDepth, width, height, sx, sy)
        if (rayD >= sceneD - stepD * 0.5 && rayD <= sceneD + shellThickness) {
          const dL = sampleBilinearDepth(rawDepth, width, height, sx - 1, sy)
          const dR = sampleBilinearDepth(rawDepth, width, height, sx + 1, sy)
          const dT = sampleBilinearDepth(rawDepth, width, height, sx, sy - 1)
          const dB = sampleBilinearDepth(rawDepth, width, height, sx, sy + 1)
          const cliffGrad = Math.max(Math.abs(dR - dL), Math.abs(dB - dT))
          if (cliffGrad < 0.22) {
            hitD = sceneD
            const hDisp = (hitD - 0.5) * 2
            hitSrcX = x + vx * hDisp
            hitSrcY = y + vy * hDisp
            hitEdgeSoft = 1 - smoothstep(0.08, 0.22, cliffGrad)
            hit = true
            break
          }
        }
      }

      const fg = sampleBilinearRgba(source, width, height, hitSrcX, hitSrcY)
      let pixel = fg
      if (!hit || hitEdgeSoft < 0.995) {
        const farX = x + vx
        const farY = y + vy
        const bgD = sampleBilinearDepth(bgDepth, width, height, farX, farY)
        const bgDisp = (bgD - 0.5) * 2
        const bg = sampleBilinearRgba(bgColor, width, height, x + vx * bgDisp, y + vy * bgDisp)
        const mixW = hit ? (1 - hitEdgeSoft) : 1
        pixel = [
          fg[0] + (bg[0] - fg[0]) * mixW,
          fg[1] + (bg[1] - fg[1]) * mixW,
          fg[2] + (bg[2] - fg[2]) * mixW,
          fg[3] + (bg[3] - fg[3]) * mixW,
        ]
      }
      const dst = (y * width + x) * 4
      out[dst] = Math.round(pixel[0])
      out[dst + 1] = Math.round(pixel[1])
      out[dst + 2] = Math.round(pixel[2])
      out[dst + 3] = Math.round(pixel[3])
    }
  }
  return out
}

/**
 * 应用空间滤镜。
 *
 * @param {{ width:number,height:number,data:ArrayLike<number> }} image
 * @param {{ width:number,height:number,data:Float32Array }} depth
 * @param {object} options `mode` + 对应参数；`normal` 为可选法线像素。
 */
export function applyDepthFx(image, depth, options = {}) {
  if (!image || !image.width || !image.height || !image.data) return null
  if (!depth || !depth.data) return null
  const width = Number(image.width)
  const height = Number(image.height)
  const mode = options.mode === 'atmosphere' || options.mode === 'dof' || options.mode === 'parallax'
    ? options.mode
    : 'fog'
  const depthField = depth.width === width && depth.height === height
    ? depth
    : resizeDepth(depth, width, height)
  if (!depthField) return null
  const source = image.data
  if (mode === 'parallax') {
    const out = applyParallax(source, depthField, width, height, {
      amplitude: Number(options.amplitude ?? 18),
      shiftX: Number(options.shiftX ?? 0),
      shiftY: Number(options.shiftY ?? 0),
    })
    return { width, height, data: out, depth: depthField }
  }
  const out = new Uint8ClampedArray(width * height * 4)
  const fogColor = hexToRgb(options.color || options.fog?.color || '#EDE9DF')
  const atmosphereColor = hexToRgb(options.color || '#BFD5DC')
  let normalPixels = options.normal || null
  if (normalPixels?.data && (normalPixels.width !== width || normalPixels.height !== height)) {
    normalPixels = resizePixels(normalPixels, Math.max(width, height))
  }
  const settings = {
    ...options,
    ...(options.fog || {}),
    ...(options.atmosphere || {}),
    ...(options.dof || {}),
    ...(options.parallax || {}),
    fog: options.fog || null,
    normal: normalPixels,
  }
  const fog = { color: fogColor }

  const dofSettings = mode === 'dof'
    ? {
        focusX: clamp01(options.focusX ?? 0.5),
        focusY: clamp01(options.focusY ?? 0.5),
        aperture: Number(options.aperture ?? 0.18),
        blur: Math.max(0, Number(options.blur ?? 7)),
        tiltShift: options.tiltShift === true,
      }
    : null
  const dofBuffers = dofSettings ? computeDofCocField(depthField, width, height, dofSettings) : null
  const dofScale = Math.max(1, Math.max(width, height) / 384)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const r = source[index]
      const g = source[index + 1]
      const b = source[index + 2]
      const a = source[index + 3]
      let pixel
      if (mode === 'atmosphere') {
        pixel = atmospherePixel(r, g, b, depthAt(depthField, x, y), {
          startDepth: Number(options.startDepth ?? 0.12),
          haze: Number(options.haze ?? 0.28),
          desaturate: Number(options.desaturate ?? 0.35),
          contrast: Number(options.contrast ?? 0.88),
        }, atmosphereColor)
      } else if (mode === 'dof') {
        pixel = blurPixelDof(
          source,
          depthField,
          dofBuffers.coc,
          dofBuffers.nearCoc,
          x,
          y,
          width,
          height,
          dofSettings,
          dofScale,
        )
      } else {
        pixel = fogPixel(r, g, b, depthAt(depthField, x, y), x, y, width, height, {
          ...settings,
          fog: undefined,
        }, fog)
      }
      out[index] = pixel[0]
      out[index + 1] = pixel[1]
      out[index + 2] = pixel[2]
      out[index + 3] = mode === 'atmosphere' || mode === 'dof' ? a : (pixel[3] ?? a)
    }
  }
  return { width, height, data: out, depth: depthField }
}

/** 把 `WORKSHOP.depthFx.fogPresets` 的预设合并成完整 fog 参数。 */
export function fogSettingsFromPreset(preset, fallback = {}) {
  const base = preset && typeof preset === 'object' ? preset : {}
  return {
    color: base.color || '#EDE9DF',
    density: clamp01(base.density ?? 0.45),
    startDepth: clamp01(base.startDepth ?? 0.25),
    falloff: Math.max(0.2, Number(base.falloff ?? 1.4)),
    groundBias: clamp01(base.groundBias ?? 0.45),
    horizon: Math.max(0.2, Math.min(0.9, Number(base.horizon ?? 0.6))),
    blend: base.blend === 'normal' ? 'normal' : 'screen',
    ...fallback,
  }
}
