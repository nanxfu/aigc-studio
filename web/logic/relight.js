/**
 * 物理动态打光（M4.2e-3 / M4.2g）的 CPU 基准与全分辨率兜底实现。
 *
 * 与 WebGPU 管线共用同一套光学语义：
 *  - 相机空间深度（表面 `-depth * 0.55`，光源在前方 `+lightZ * 0.55`）；
 *  - 线性空间 Cook-Torrance GGX 微表面高光 + 软包覆漫反射 + 原图高频微凹凸（Detail Bump）；
 *  - 轻量屏幕空间投射阴影 + 天空保护 + 自发光区域保护 + 柔和 Filmic 色调映射。
 *
 * 当浏览器支持 WebGPU 时，预览与全分辨率落盘优先走 `relightWebGPU.js`；
 * 无 WebGPU 或运行在 Node 单测环境时由本实现无缝接管。
 */

import { normalPixelsFromDepth, resizeDepth } from './depthFx.js'

const Z_SCALE = 0.55
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
const mix = (a, b, t) => a + (b - a) * clamp01(t)
const smoothstep = (edge0, edge1, value) => {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0))
  return t * t * (3 - 2 * t)
}
const srgbToLin = (v) => Math.pow(Math.max(0, v), 2.2)
const linToSrgb = (v) => Math.pow(Math.max(0, v), 1 / 2.2)
const filmic = (x) => (x <= 0.82 ? x : 0.82 + (x - 0.82) / (1 + (x - 0.82) * 1.45))

function normalize3(x, y, z) {
  const length = Math.hypot(x, y, z) || 1
  return { x: x / length, y: y / length, z: z / length }
}

function hexColor(value) {
  const text = typeof value === 'string' ? value.trim().replace(/^#/, '') : ''
  const full = text.length === 3 ? text.split('').map((ch) => ch + ch).join('') : text
  if (!/^[0-9a-f]{6}$/i.test(full)) return { r: 1, g: 1, b: 1 }
  return {
    r: Number.parseInt(full.slice(0, 2), 16) / 255,
    g: Number.parseInt(full.slice(2, 4), 16) / 255,
    b: Number.parseInt(full.slice(4, 6), 16) / 255,
  }
}

function normalAt(pixels, x, y) {
  if (!pixels?.data) return null
  const i = ((Math.min(pixels.height - 1, y) * pixels.width)
    + Math.min(pixels.width - 1, x)) * 4
  return normalize3(
    pixels.data[i] / 127.5 - 1,
    pixels.data[i + 1] / 127.5 - 1,
    Math.max(0.05, pixels.data[i + 2] / 127.5 - 1),
  )
}

function scalarAt(pixels, x, y, fallback) {
  if (!pixels?.data) return fallback
  const i = ((Math.min(pixels.height - 1, y) * pixels.width)
    + Math.min(pixels.width - 1, x)) * 4
  const value = (pixels.data[i] * 0.2126 + pixels.data[i + 1] * 0.7152 + pixels.data[i + 2] * 0.0722) / 255
  return Number.isFinite(value) ? value : fallback
}

function ggxDistribution(ndh, roughness) {
  const a = roughness * roughness
  const a2 = a * a
  const denom = ndh * ndh * (a2 - 1) + 1
  return a2 / Math.max(Math.PI * denom * denom, 1e-5)
}

function smithGeometry(ndv, ndl, roughness) {
  const r = roughness + 1
  const k = (r * r) / 8
  const gv = ndv / (ndv * (1 - k) + k)
  const gl = ndl / (ndl * (1 - k) + k)
  return gv * gl
}

/**
 * 计算单张图的物理重打光（CPU 路径）。
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} image
 * @param {{width:number,height:number,data:Float32Array}} depth
 * @param {object} [options]
 */
export function applyPhysicalRelight(image, depth, options = {}) {
  if (!image?.data || !image.width || !image.height || !depth?.data) return null
  const width = Number(image.width)
  const height = Number(image.height)
  const field = depth.width === width && depth.height === height
    ? depth
    : resizeDepth(depth, width, height)
  if (!field) return null
  const normalMap = options.normal?.data ? options.normal : normalPixelsFromDepth(field)
  const lightX = clamp01(options.lightX ?? 0.42)
  const lightY = clamp01(options.lightY ?? 0.3)
  const lightZ = Math.max(0.08, Math.min(1.2, Number(options.lightZ ?? 0.42)))
  const intensity = Math.max(0, Number(options.intensity ?? 1.35))
  const ambient = clamp01(options.ambient ?? 0.32)
  const rim = Math.max(0, Number(options.rim ?? 0.7))
  const shadowStrength = clamp01(options.shadow ?? 0.85)
  const spotFocus = clamp01(options.spot ?? 0)
  const spotRadius = spotFocus > 0.01 ? mix(1.25, 0.24, spotFocus) : 0
  const detailBump = clamp01(options.detailBump ?? 0.28)
  const color = hexColor(options.color || '#FFF4E0')
  const keyLinR = srgbToLin(color.r)
  const keyLinG = srgbToLin(color.g)
  const keyLinB = srgbToLin(color.b)
  const source = image.data
  const albedo = options.albedo?.data ? options.albedo : null
  const out = new Uint8ClampedArray(width * height * 4)
  const hasPbrNormal = options.hasPbrNormal === true
  const spanPx = Math.max(1, Math.round(Math.min(width, height) / 256))
  const aspect = width / Math.max(1, height)
  const perceptualAmbient = Math.pow(ambient, 1.6)

  const depthAt = (x, y) => clamp01(field.data[
    Math.max(0, Math.min(height - 1, y)) * width
    + Math.max(0, Math.min(width - 1, x))
  ])
  const depthSample = (u, v) => {
    const sx = Math.max(0, Math.min(width - 1, u * (width - 1)))
    const sy = Math.max(0, Math.min(height - 1, v * (height - 1)))
    const x0 = Math.floor(sx)
    const y0 = Math.floor(sy)
    const x1 = Math.min(width - 1, x0 + 1)
    const y1 = Math.min(height - 1, y0 + 1)
    const wx = sx - x0
    const wy = sy - y0
    const d0 = field.data[y0 * width + x0] * (1 - wx) + field.data[y0 * width + x1] * wx
    const d1 = field.data[y1 * width + x0] * (1 - wx) + field.data[y1 * width + x1] * wx
    return clamp01(d0 * (1 - wy) + d1 * wy)
  }
  const lumAt = (x, y) => {
    const cx = Math.max(0, Math.min(width - 1, x))
    const cy = Math.max(0, Math.min(height - 1, y))
    const buf = albedo || image
    const idx = (Math.min(buf.height - 1, cy) * buf.width + Math.min(buf.width - 1, cx)) * 4
    return (buf.data[idx] * 0.2126 + buf.data[idx + 1] * 0.7152 + buf.data[idx + 2] * 0.0722) / 255
  }

  for (let y = 0; y < height; y += 1) {
    const py = y / Math.max(1, height - 1)
    for (let x = 0; x < width; x += 1) {
      const px = x / Math.max(1, width - 1)
      const index = (y * width + x) * 4
      const sr = source[index] / 255
      const sg = source[index + 1] / 255
      const sb = source[index + 2] / 255
      let arSrgb = sr
      let agSrgb = sg
      let abSrgb = sb
      if (albedo) {
        const ai = (Math.min(albedo.height - 1, y) * albedo.width + Math.min(albedo.width - 1, x)) * 4
        arSrgb = albedo.data[ai] / 255
        agSrgb = albedo.data[ai + 1] / 255
        abSrgb = albedo.data[ai + 2] / 255
      }
      const ar = srgbToLin(arSrgb)
      const ag = srgbToLin(agSrgb)
      const ab = srgbToLin(abSrgb)

      const depthValue = depthAt(x, y)
      const depthGrad = Math.max(
        Math.abs(depthAt(x + spanPx, y) - depthAt(x - spanPx, y)),
        Math.abs(depthAt(x, y + spanPx) - depthAt(x, y - spanPx)),
      )
      const cliff = smoothstep(0.08, 0.24, depthGrad)
      let normal = normalAt(normalMap, x, y) || normalize3(0, 0, 1)
      if (!hasPbrNormal && cliff > 0) {
        normal = normalize3(
          mix(normal.x, 0, cliff * 0.55),
          mix(normal.y, 0, cliff * 0.55),
          mix(normal.z, 1, cliff * 0.55),
        )
      }
      const bumpAmp = detailBump * (1 - cliff * 0.9) * (hasPbrNormal ? 0.25 : 1)
      if (bumpAmp > 0.001) {
        const gx = (lumAt(x + 1, y) - lumAt(x - 1, y)) * bumpAmp * 1.8
        const gy = (lumAt(x, y + 1) - lumAt(x, y - 1)) * bumpAmp * 1.8
        normal = normalize3(normal.x - gx, normal.y + gy, Math.max(0.12, normal.z))
      }

      const roughness = Math.max(0.08, Math.min(0.96, scalarAt(options.roughness, x, y, 0.55)))
      const metallic = clamp01(scalarAt(options.metallic, x, y, 0))

      const dx = (lightX - px) * aspect
      const dy = -(lightY - py)
      const dz = (lightZ + depthValue) * Z_SCALE
      const dist = Math.max(1e-4, Math.hypot(dx, dy, dz))
      const lx = dx / dist
      const ly = dy / dist
      const lz = dz / dist
      const halfView = normalize3(lx, ly, lz + 1)

      const distAtten = 1 / (1 + dist * dist * 0.65)
      let spotFactor = 1
      if (spotRadius > 0.01) {
        const radial = Math.hypot((px - lightX) * aspect, py - lightY)
        spotFactor = 1 - smoothstep(spotRadius * 0.45, spotRadius, radial)
      }

      // 轻量屏幕空间光线步进阴影（CPU 路径用 14 步 + 天空衰减，兼顾精度与速度）
      let shadow = 1
      if (shadowStrength > 0.001) {
        const skyFade = 1 - smoothstep(0.58, 0.82, depthValue)
        const dxyX = lightX - px
        const dxyY = lightY - py
        const dist2D = Math.hypot(dxyX, dxyY)
        if (skyFade > 0.01 && dist2D > 0.004) {
          const steps = 14
          const stepScale = Math.min(dist2D, 0.14) / dist2D
          const startZ = -depthValue * Z_SCALE
          const targetZ = lightZ * Z_SCALE
          const slopeBias = 0.015 + (1 - Math.max(normal.z, 0)) * 0.018
          const thickness = 0.095
          let vis = 1
          for (let i = 1; i <= steps; i += 1) {
            const frac = (i - 0.5) / steps
            const t = frac * stepScale
            const su = px + dxyX * t
            const sv = py + dxyY * t
            if (su < 0 || su > 1 || sv < 0 || sv > 1) break
            const rayZ = startZ + (targetZ - startZ) * t
            const sceneZ = -depthSample(su, sv) * Z_SCALE
            const pen = sceneZ - rayZ
            if (pen > slopeBias && pen < thickness) {
              const edgeFade = 1 - smoothstep(thickness * 0.5, thickness, pen)
              const occ = smoothstep(slopeBias, slopeBias + 0.025, pen) * edgeFade
              vis = Math.min(vis, 1 - occ * mix(0.82, 0.3, frac))
            }
          }
          shadow = mix(1, Math.max(0.22, Math.min(1, vis)), shadowStrength * skyFade)
        }
      }

      const rawNdl = normal.x * lx + normal.y * ly + normal.z * lz
      const ndl = clamp01((rawNdl + 0.2) / 1.2)
      const ndv = Math.max(0.05, normal.z)
      const ndh = Math.max(0, normal.x * halfView.x + normal.y * halfView.y + normal.z * halfView.z)
      const hdv = Math.max(0, halfView.z)
      const fresnelWeight = Math.pow(clamp01(1 - hdv), 5)
      const f0r = mix(0.04, ar, metallic)
      const f0g = mix(0.04, ag, metallic)
      const f0b = mix(0.04, ab, metallic)
      const fr = f0r + (1 - f0r) * fresnelWeight
      const fg = f0g + (1 - f0g) * fresnelWeight
      const fb = f0b + (1 - f0b) * fresnelWeight
      const specTerm = (ggxDistribution(ndh, roughness) * smithGeometry(ndv, Math.max(0.05, rawNdl), roughness))
        / Math.max(4 * ndv * Math.max(rawNdl, 0.08), 0.08)
        * Math.max(0, rawNdl)
        * (hasPbrNormal || options.metallic?.data || options.roughness?.data ? 1 : 0.5)

      const keyGain = intensity * distAtten * spotFactor * shadow
      const kDr = (1 - fr) * (1 - metallic)
      const kDg = (1 - fg) * (1 - metallic)
      const kDb = (1 - fb) * (1 - metallic)

      const lightLen2D = Math.hypot(lx, ly) || 1
      const normLen2D = Math.hypot(normal.x, normal.y)
      const rimAlign = normLen2D > 1e-4
        ? clamp01(((normal.x / normLen2D) * (lx / lightLen2D) + (normal.y / normLen2D) * (ly / lightLen2D)) * 0.5 + 0.5)
        : 0.5
      const fresnelRim = Math.pow(1 - Math.max(0, normal.z), 2.5) * (1 - cliff * 0.9)
      const rimScale = hasPbrNormal ? 0.9 : 0.45
      const rimAmount = rim * rimScale * fresnelRim * (0.25 + 0.75 * rimAlign) * (0.45 + 0.55 * shadow)

      const ambientTerm = perceptualAmbient * (0.9 + depthValue * 0.15)
      const srcLum = sr * 0.2126 + sg * 0.7152 + sb * 0.0722
      const srcMax = Math.max(sr, sg, sb)
      const srcSat = (srcMax - Math.min(sr, sg, sb)) / Math.max(srcMax, 1e-4)
      const emissiveMask = smoothstep(0.68, 0.96, srcLum) * smoothstep(0.22, 0.6, srcSat) * 0.75

      const linR = (kDr * ar * ndl + fr * specTerm) * keyLinR * keyGain
        + ar * (ambientTerm + rimAmount * keyLinR) + srgbToLin(sr) * emissiveMask
      const linG = (kDg * ag * ndl + fg * specTerm) * keyLinG * keyGain
        + ag * (ambientTerm + rimAmount * keyLinG) + srgbToLin(sg) * emissiveMask
      const linB = (kDb * ab * ndl + fb * specTerm) * keyLinB * keyGain
        + ab * (ambientTerm + rimAmount * keyLinB) + srgbToLin(sb) * emissiveMask

      out[index] = Math.round(clamp01(linToSrgb(filmic(linR))) * 255)
      out[index + 1] = Math.round(clamp01(linToSrgb(filmic(linG))) * 255)
      out[index + 2] = Math.round(clamp01(linToSrgb(filmic(linB))) * 255)
      out[index + 3] = source[index + 3] ?? 255
    }
  }
  return { width, height, data: out }
}
