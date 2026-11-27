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

/** 由深度梯度生成 OpenGL 风格法线图（先做 3×3 高斯平滑削弱 8-bit 深度台阶毛刺）。 */
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
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      smooth[y * width + x] = (
        rawAt(x - 1, y - 1) + 2 * rawAt(x, y - 1) + rawAt(x + 1, y - 1)
        + 2 * rawAt(x - 1, y) + 4 * rawAt(x, y) + 2 * rawAt(x + 1, y)
        + rawAt(x - 1, y + 1) + 2 * rawAt(x, y + 1) + rawAt(x + 1, y + 1)
      ) / 16
    }
  }
  const at = (x, y) => smooth[
    Math.max(0, Math.min(height - 1, y)) * width
    + Math.max(0, Math.min(width - 1, x))
  ]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength
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
  if (settings.blend === 'screen') {
    const mix = alpha * 0.88
    const sr = 255 - ((255 - r) * (255 - color.r)) / 255
    const sg = 255 - ((255 - g) * (255 - color.g)) / 255
    const sb = 255 - ((255 - b) * (255 - color.b)) / 255
    return [r + (sr - r) * mix, g + (sg - g) * mix, b + (sb - b) * mix]
  }
  const mix = alpha * 0.94
  return [r + (color.r - r) * mix, g + (color.g - g) * mix, b + (color.b - b) * mix]
}

function atmospherePixel(r, g, b, depthValue, settings, color) {
  const depthWeight = smoothstep(settings.startDepth, 1, depthValue)
  const amount = clamp01(settings.haze * depthWeight)
  const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722
  const desat = settings.desaturate * depthWeight
  let rr = r + (luminance - r) * desat
  let gg = g + (luminance - g) * desat
  let bb = b + (luminance - b) * desat
  rr += (color.r - rr) * amount
  gg += (color.g - gg) * amount
  bb += (color.b - bb) * amount
  const contrast = settings.contrast
  return [
    (rr - 128) * contrast + 128,
    (gg - 128) * contrast + 128,
    (bb - 128) * contrast + 128,
  ]
}

const BOKEH_RINGS = [
  { scale: 0.45, count: 6, weight: 1.1 },
  { scale: 1.0, count: 10, weight: 0.85 },
]

function blurPixel(source, x, y, width, height, radius) {
  if (radius < 0.6) {
    const index = (y * width + x) * 4
    return [source[index], source[index + 1], source[index + 2], source[index + 3]]
  }
  const center = (y * width + x) * 4
  let sumR = source[center] * 1.4
  let sumG = source[center + 1] * 1.4
  let sumB = source[center + 2] * 1.4
  let sumA = source[center + 3] * 1.4
  let totalWeight = 1.4
  for (let ringIndex = 0; ringIndex < BOKEH_RINGS.length; ringIndex += 1) {
    const ring = BOKEH_RINGS[ringIndex]
    const ringRadius = radius * ring.scale
    const phase = ringIndex * 0.35
    for (let i = 0; i < ring.count; i += 1) {
      const angle = (i / ring.count) * Math.PI * 2 + phase
      const sx = Math.max(0, Math.min(width - 1, Math.round(x + Math.cos(angle) * ringRadius)))
      const sy = Math.max(0, Math.min(height - 1, Math.round(y + Math.sin(angle) * ringRadius)))
      const index = (sy * width + sx) * 4
      sumR += source[index] * ring.weight
      sumG += source[index + 1] * ring.weight
      sumB += source[index + 2] * ring.weight
      sumA += source[index + 3] * ring.weight
      totalWeight += ring.weight
    }
  }
  return [
    sumR / totalWeight,
    sumG / totalWeight,
    sumB / totalWeight,
    sumA / totalWeight,
  ]
}

function dofPixel(source, depth, x, y, width, height, settings) {
  const focusDepth = depthAt(depth, Math.round(settings.focusX * (width - 1)), Math.round(settings.focusY * (height - 1)))
  const focus = settings.tiltShift
    ? clamp01(Math.abs(y / Math.max(1, height - 1) - settings.focusY) * 2.4)
    : Math.abs(depthAt(depth, x, y) - focusDepth)
  const coc = clamp01(focus / Math.max(0.02, settings.aperture))
  const scale = Math.max(1, Math.max(width, height) / 384)
  return blurPixel(source, x, y, width, height, coc * settings.blur * scale)
}

/** 对深度场做轻量平滑，抑制 2.5D 视差在前景边缘产生锯齿撕裂。 */
function smoothDepthField(depth) {
  const { width, height, data } = depth
  const temp = new Float32Array(width * height)
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const xm = x > 0 ? x - 1 : 0
      const xp = x + 1 < width ? x + 1 : width - 1
      temp[row + x] = (data[row + xm] + 2 * data[row + x] + data[row + xp]) * 0.25
    }
  }
  for (let y = 0; y < height; y += 1) {
    const ym = (y > 0 ? y - 1 : 0) * width
    const y0 = y * width
    const yp = (y + 1 < height ? y + 1 : height - 1) * width
    for (let x = 0; x < width; x += 1) {
      out[y0 + x] = (temp[ym + x] + 2 * temp[y0 + x] + temp[yp + x]) * 0.25
    }
  }
  return out
}

/**
 * 前景优先 Z-Buffer 正向视差 + 背景向空洞补全。
 *
 * 相比逐像素反向采样，能防止前景轮廓（如人头、树枝）被复制涂抹到远景天空上，
 * 同时把幅度按画幅归一化，保证预览与全分辨率落盘幅度一致。
 */
function applyParallax(source, depth, width, height, settings) {
  const total = width * height
  const out = new Uint8ClampedArray(total * 4)
  const zBuf = new Float32Array(total)
  zBuf.fill(2.0)
  const smooth = smoothDepthField(depth)
  const scale = Math.max(1, Math.max(width, height) / 384)
  const amp = Math.max(0, Number(settings.amplitude) || 0) * scale
  const sxFactor = Number(settings.shiftX) || 0
  const syFactor = Number(settings.shiftY) || 0

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x
      const d = smooth[idx]
      const disp = (d - 0.5) * 2
      const tx = Math.max(0, Math.min(width - 1, Math.round(x - amp * sxFactor * disp)))
      const ty = Math.max(0, Math.min(height - 1, Math.round(y - amp * syFactor * disp)))
      const tIdx = ty * width + tx
      if (d <= zBuf[tIdx] + 1e-4) {
        zBuf[tIdx] = d
        const src = idx * 4
        const dst = tIdx * 4
        out[dst] = source[src]
        out[dst + 1] = source[src + 1]
        out[dst + 2] = source[src + 2]
        out[dst + 3] = source[src + 3]
      }
    }
  }

  let holes = []
  for (let i = 0; i < total; i += 1) {
    if (zBuf[i] > 1.5) holes.push(i)
  }
  const maxPasses = Math.min(28, Math.max(4, Math.ceil(amp * 1.4) + 2))
  for (let pass = 0; pass < maxPasses && holes.length > 0; pass += 1) {
    const nextHoles = []
    const updates = []
    for (let h = 0; h < holes.length; h += 1) {
      const idx = holes[h]
      const x = idx % width
      const y = (idx - x) / width
      let maxZ = -1
      const candidates = []
      for (let oy = -1; oy <= 1; oy += 1) {
        const ny = y + oy
        if (ny < 0 || ny >= height) continue
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue
          const nx = x + ox
          if (nx < 0 || nx >= width) continue
          const nIdx = ny * width + nx
          const nz = zBuf[nIdx]
          if (nz > 1.5) continue
          if (nz > maxZ) maxZ = nz
          candidates.push(nIdx)
        }
      }
      if (candidates.length === 0) {
        nextHoles.push(idx)
        continue
      }
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      // 只吸收背景侧（深度接近 maxZ）的邻域像素，绝不把前景颜色拉进遮挡空洞。
      const threshold = maxZ - 0.08
      for (let c = 0; c < candidates.length; c += 1) {
        const cIdx = candidates[c]
        if (zBuf[cIdx] < threshold) continue
        const p = cIdx * 4
        r += out[p]
        g += out[p + 1]
        b += out[p + 2]
        a += out[p + 3]
        count += 1
      }
      if (count === 0) {
        nextHoles.push(idx)
        continue
      }
      updates.push({
        idx,
        z: maxZ,
        r: Math.round(r / count),
        g: Math.round(g / count),
        b: Math.round(b / count),
        a: Math.round(a / count),
      })
    }
    if (updates.length === 0) break
    for (let u = 0; u < updates.length; u += 1) {
      const item = updates[u]
      zBuf[item.idx] = item.z
      const dst = item.idx * 4
      out[dst] = item.r
      out[dst + 1] = item.g
      out[dst + 2] = item.b
      out[dst + 3] = item.a
    }
    holes = nextHoles
  }
  for (let h = 0; h < holes.length; h += 1) {
    const idx = holes[h]
    const p = idx * 4
    out[p] = source[p]
    out[p + 1] = source[p + 1]
    out[p + 2] = source[p + 2]
    out[p + 3] = source[p + 3]
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
        pixel = dofPixel(source, depthField, x, y, width, height, {
          focusX: clamp01(options.focusX ?? 0.5),
          focusY: clamp01(options.focusY ?? 0.5),
          aperture: Number(options.aperture ?? 0.18),
          blur: Math.max(0, Number(options.blur ?? 7)),
          tiltShift: options.tiltShift === true,
        })
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
