/**
 * 物理动态打光（M4.2e-3 轨道 1）的 CPU 基准实现。
 *
 * WebGL 预览与最终落盘共用这套光照方程：反照率 × 漫反射 + 微表面高光 + 环境光 + 轮廓光。
 * 没有 PBR 通道时退化为「原图 = albedo、深度梯度 = normal」，仍能得到可用的方向光；
 * 有 CHORD / Marigold 四通道时则直接使用 normal / roughness / metallic。
 *
 * 这里不依赖 DOM：预览层只负责把输出画进 canvas，应用时按原分辨率再算一次。
 */

import { normalPixelsFromDepth, resizeDepth } from './depthFx.js'

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
const mix = (a, b, t) => a + (b - a) * clamp01(t)

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
  const n = normalize3(
    pixels.data[i] / 127.5 - 1,
    pixels.data[i + 1] / 127.5 - 1,
    Math.max(0.05, pixels.data[i + 2] / 127.5 - 1),
  )
  return n
}

function scalarAt(pixels, x, y, fallback) {
  if (!pixels?.data) return fallback
  const i = ((Math.min(pixels.height - 1, y) * pixels.width)
    + Math.min(pixels.width - 1, x)) * 4
  const value = (pixels.data[i] * 0.2126 + pixels.data[i + 1] * 0.7152 + pixels.data[i + 2] * 0.0722) / 255
  return Number.isFinite(value) ? value : fallback
}

/**
 * 计算单张图的物理重打光。
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} image
 * @param {{width:number,height:number,data:Float32Array}} depth
 * @param {object} options
 * @param {{width:number,height:number,data:ArrayLike<number>}|null} [options.albedo]
 * @param {{width:number,height:number,data:ArrayLike<number>}|null} [options.normal]
 * @param {{width:number,height:number,data:ArrayLike<number>}|null} [options.roughness]
 * @param {{width:number,height:number,data:ArrayLike<number>}|null} [options.metallic]
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
  const lightX = clamp01(options.lightX ?? 0.5)
  const lightY = clamp01(options.lightY ?? 0.35)
  const intensity = Math.max(0, Number(options.intensity ?? 1.2))
  const ambient = Math.max(0, Number(options.ambient ?? 0.28))
  const rim = Math.max(0, Number(options.rim ?? 0.7))
  const color = hexColor(options.color || '#FFF4E0')
  const source = image.data
  const albedo = options.albedo?.data ? options.albedo : null
  const out = new Uint8ClampedArray(width * height * 4)
  const lightZ = Math.max(0.15, Number(options.lightZ ?? 0.72))

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      let ar = source[index] / 255
      let ag = source[index + 1] / 255
      let ab = source[index + 2] / 255
      if (albedo) {
        const ai = (Math.min(albedo.height - 1, y) * albedo.width + Math.min(albedo.width - 1, x)) * 4
        ar = albedo.data[ai] / 255
        ag = albedo.data[ai + 1] / 255
        ab = albedo.data[ai + 2] / 255
      }
      const normal = normalAt(normalMap, x, y)
        || normalize3(0, 0, 1)
      const roughness = Math.max(0.04, scalarAt(options.roughness, x, y, 0.55))
      const metallic = clamp01(scalarAt(options.metallic, x, y, 0))
      const depthValue = clamp01(field.data[y * width + x])
      const falloff = 1 / (1 + depthValue * 1.8)
      const px = x / Math.max(1, width - 1)
      const py = y / Math.max(1, height - 1)
      const lightView = normalize3(
        (lightX - px) * 3.2,
        -(lightY - py) * 3.2,
        lightZ,
      )
      const halfView = normalize3(lightView.x, lightView.y, lightView.z + 1)
      const pointFalloff = 1 / (1 + ((lightX - px) ** 2 + (lightY - py) ** 2) * 2.1)
      let ndl = normal.x * lightView.x + normal.y * lightView.y + normal.z * lightView.z
      ndl = Math.max(0, ndl) * intensity * falloff * pointFalloff
      const specPower = mix(80, 6, roughness)
      let ndh = normal.x * halfView.x + normal.y * halfView.y + normal.z * halfView.z
      ndh = Math.max(0, ndh)
      const specular = Math.pow(ndh, specPower) * (1 - roughness * 0.7) * intensity * falloff * pointFalloff
      const fresnel = Math.pow(1 - Math.max(0, normal.z), 3)
      const rimAmount = rim * fresnel * falloff
      const diffuseColor = {
        r: color.r * ndl,
        g: color.g * ndl,
        b: color.b * ndl,
      }
      const specColor = {
        r: mix(color.r, ar, metallic) * specular,
        g: mix(color.g, ag, metallic) * specular,
        b: mix(color.b, ab, metallic) * specular,
      }
      const ambientTerm = ambient * (0.8 + depthValue * 0.2)
      const r = ar * (ambientTerm + diffuseColor.r) + specColor.r + ar * rimAmount * color.r
      const g = ag * (ambientTerm + diffuseColor.g) + specColor.g + ag * rimAmount * color.g
      const b = ab * (ambientTerm + diffuseColor.b) + specColor.b + ab * rimAmount * color.b
      out[index] = Math.round(clamp01(r) * 255)
      out[index + 1] = Math.round(clamp01(g) * 255)
      out[index + 2] = Math.round(clamp01(b) * 255)
      out[index + 3] = source[index + 3] ?? 255
    }
  }
  return { width, height, data: out }
}
