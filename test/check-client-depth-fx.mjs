#!/usr/bin/env node
/**
 * M4.2e 空间滤镜与物理打光的离线回归。
 *
 * 覆盖不依赖 DOM 的核心：
 *  - 深度图归一（近白远黑）与 DA3「远 = 大」输出转换；
 *  - 深度梯度法线、雾效前景保护、局部散雾锚点；
 *  - 大气透视、景深、2.5D 视差；
 *  - PBR / 深度物理打光的主光方向；
 *  - 512px 预览预算内完成四模式，不引入 O(n²) 大循环。
 */

import assert from 'node:assert/strict'

import { WORKSHOP } from '../shared/contract.js'
import {
  applyDepthFx,
  depthMapFromPixels,
  fogSettingsFromPreset,
  normalPixelsFromDepth,
  pixelsFromDepth,
  resizeDepth,
} from '../web/logic/depthFx.js'
import {
  buildDepthInputTensor,
  cropDepthRaw,
  fitDepthLetterbox,
  normalizeDepthOutput,
  runLocalDepth,
} from '../web/logic/localDepth.js'
import { applyPhysicalRelight } from '../web/logic/relight.js'
import { renderPhysicalRelightWebGL } from '../web/logic/relightWebGL.js'
import { renderPhysicalRelightWebGPU } from '../web/logic/relightWebGPU.js'
import { createCheckRunner } from './helpers/check.mjs'

const { check, summary } = createCheckRunner()

function createImage(width, height, valueAt) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const value = valueAt(x, y)
      data[index] = value[0]
      data[index + 1] = value[1]
      data[index + 2] = value[2]
      data[index + 3] = value[3] ?? 255
    }
  }
  return { width, height, data }
}

function pixelAt(image, x, y) {
  const index = (y * image.width + x) * 4
  return Array.from(image.data.subarray(index, index + 4))
}

function gradientDepth(width, height) {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = x / Math.max(1, width - 1)
  }
  return { width, height, data }
}

await check('深度：近白远黑的通道值归一成 0..1，并保持输入不变', () => {
  const pixels = createImage(4, 1, (x) => [x === 0 ? 255 : x === 3 ? 0 : 128, x === 0 ? 255 : x === 3 ? 0 : 128, x === 0 ? 255 : x === 3 ? 0 : 128, 255])
  const before = Array.from(pixels.data)
  const depth = depthMapFromPixels(pixels)
  assert.equal(depth.width, 4)
  assert.ok(Math.abs(depth.data[0] - 0) < 0.002)
  assert.ok(Math.abs(depth.data[3] - 1) < 0.002)
  assert.equal(depth.data[1], depth.data[2])
  assert.deepEqual(Array.from(pixels.data), before)
  const gray = pixelsFromDepth(depth)
  assert.equal(pixelAt(gray, 0, 0)[0], 255)
  assert.equal(pixelAt(gray, 3, 0)[0], 0)
})

await check('DA3 输出：远 = 大转成内部 0..1，NaN 被忽略且尺寸正确', () => {
  const raw = new Float32Array(4 * 3)
  raw.fill(Number.NaN)
  raw[0] = 1
  raw[1] = 2
  raw[2] = 3
  raw[3] = 4
  const depth = normalizeDepthOutput(raw, 2, 2, { outputDepthDirection: 'far-large' })
  assert.equal(depth.width, 2)
  assert.equal(depth.height, 2)
  assert.ok(depth.data[0] < depth.data[3], '近处应小于远处')
  assert.equal(depth.data[0], 0)
  assert.equal(depth.data[3], 1)

  const tensor = buildDepthInputTensor(createImage(3, 2, () => [128, 128, 128]), 2, 2)
  assert.equal(tensor.length, 12)
  assert.ok(tensor.every((value) => Number.isFinite(value)))

  const rect = fitDepthLetterbox(1000, 1000, 504, 378)
  assert.deepEqual(rect, { targetW: 504, targetH: 378, contentW: 378, contentH: 378, offsetX: 63, offsetY: 0 })
  const cropped = cropDepthRaw(new Float32Array(504 * 378).fill(0.5), 504, 378, rect)
  assert.equal(cropped.length, 378 * 378)
})

await check('DA3 端侧推理：等比装入 504×378 并裁回原画幅比例，避免方图被拉宽', async () => {
  let receivedDims = null
  const squareOut = await runLocalDepth({
    sourcePixels: createImage(800, 800, () => [120, 120, 120, 255]),
    runtimeLoader: async () => ({
      InferenceSession: {
        create: async () => ({
          run: async (feeds) => {
            receivedDims = feeds.image.dims
            const data = new Float32Array(504 * 378)
            for (let y = 0; y < 378; y += 1) {
              for (let x = 0; x < 504; x += 1) {
                data[y * 504 + x] = x < 63 || x >= 441 ? 10 : (x - 63) / 378
              }
            }
            return { depth: { data, dims: [1, 378, 504] } }
          },
        }),
      },
      Tensor: function FakeTensor(type, data, dims) {
        this.type = type
        this.data = data
        this.dims = dims
      },
    }),
    modelLoader: async () => new Uint8Array(8),
  })
  assert.deepEqual(receivedDims, [1, 3, 378, 504])
  assert.equal(squareOut.depth.width, 378)
  assert.equal(squareOut.depth.height, 378)
  assert.ok(squareOut.depth.data[0] < 0.05 && squareOut.depth.data[377] > 0.95, '补边极值不得污染内容区归一化')
})

await check('法线：平面深度生成中性朝外法线，透明通道固定 255', () => {
  const depth = { width: 3, height: 3, data: new Float32Array(9).fill(0.5) }
  const normal = normalPixelsFromDepth(depth)
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      const [r, g, b, a] = pixelAt(normal, x, y)
      assert.ok(Math.abs(r - 128) <= 1)
      assert.ok(Math.abs(g - 128) <= 1)
      assert.ok(b >= 254)
      assert.equal(a, 255)
    }
  }
})

await check('雾效：起雾距离保护前景，远处被雾色抬亮', () => {
  const source = createImage(64, 32, () => [80, 90, 100, 255])
  const depth = gradientDepth(64, 32)
  const settings = {
    mode: 'fog',
    ...fogSettingsFromPreset(WORKSHOP.depthFx.fogPresets[0], {
      density: 0.75,
      startDepth: 0.35,
      falloff: 1.6,
      groundBias: 0,
    }),
    anchors: [],
    strokes: [],
  }
  const rendered = applyDepthFx(source, depth, settings)
  const near = pixelAt(rendered, 2, 16)
  const far = pixelAt(rendered, 62, 16)
  assert.deepEqual(near.slice(0, 3), [80, 90, 100], '低于起雾距离的前景不能染色')
  assert.ok(far[0] > near[0] + 20, '远处应明显被雾色抬亮')
  assert.ok(far[1] > near[1] + 15)
})

await check('局部控雾：聚雾锚点增加雾量，散雾锚点把同一位置挖空', () => {
  const source = createImage(64, 64, () => [70, 75, 82, 255])
  const depth = { width: 64, height: 64, data: new Float32Array(64 * 64).fill(0.95) }
  const base = {
    mode: 'fog',
    ...WORKSHOP.depthFx.fogPresets[0],
    density: 0.4,
    startDepth: 0,
    groundBias: 0,
    fog: undefined,
  }
  const plain = applyDepthFx(source, depth, { ...base, anchors: [] })
  const added = applyDepthFx(source, depth, {
    ...base,
    anchors: [{ x: 0.5, y: 0.5, radius: 0.4, strength: 1, mode: 'add' }],
  })
  const removed = applyDepthFx(source, depth, {
    ...base,
    anchors: [{ x: 0.5, y: 0.5, radius: 0.5, strength: 1, mode: 'subtract' }],
  })
  assert.ok(pixelAt(added, 32, 32)[0] > pixelAt(plain, 32, 32)[0])
  assert.ok(pixelAt(removed, 32, 32)[0] < pixelAt(plain, 32, 32)[0])
})

await check('大气透视 / 景深 / 视差：三种模式都产生非空且尺寸一致的结果', () => {
  const source = createImage(48, 32, (x, y) => (x % 4 === 0 || y % 4 === 0 ? [230, 60, 40, 255] : [40, 90, 210, 255]))
  const depth = gradientDepth(48, 32)
  const modes = [
    { mode: 'atmosphere', haze: 0.7, desaturate: 0.8, contrast: 0.7, color: '#BFD5DC' },
    { mode: 'dof', focusX: 0.1, focusY: 0.5, aperture: 0.08, blur: 4, tiltShift: false },
    { mode: 'parallax', amplitude: 12, shiftX: 0.8, shiftY: -0.3 },
  ]
  for (const settings of modes) {
    const rendered = applyDepthFx(source, depth, settings)
    assert.equal(rendered.width, source.width)
    assert.equal(rendered.height, source.height)
    assert.equal(rendered.data.length, source.data.length)
    assert.ok(rendered.data.some((value, index) => value !== source.data[index]), `${settings.mode} 应改变像素`)
  }
})

await check('物理打光：光源移向哪一侧，哪一侧更亮；PBR 通道改变高光', () => {
  const source = createImage(48, 48, () => [150, 150, 150, 255])
  const depth = { width: 48, height: 48, data: new Float32Array(48 * 48).fill(0.25) }
  const left = applyPhysicalRelight(source, depth, { lightX: 0.15, lightY: 0.5, intensity: 1.8, rim: 0.2, ambient: 0.2 })
  const right = applyPhysicalRelight(source, depth, { lightX: 0.85, lightY: 0.5, intensity: 1.8, rim: 0.2, ambient: 0.2 })
  const leftOnLeft = pixelAt(left, 6, 24)[0]
  const rightOnLeft = pixelAt(right, 6, 24)[0]
  assert.ok(leftOnLeft > rightOnLeft, '光在左侧时，左侧像素应更亮')
  const metallic = createImage(48, 48, () => [255, 255, 255, 255])
  const glossy = applyPhysicalRelight(source, depth, {
    metallic,
    lightX: 0.5,
    lightY: 0.5,
    intensity: 2,
    ambient: 0.1,
  })
  assert.equal(glossy.data.length, source.data.length)
  assert.equal(
    renderPhysicalRelightWebGL(source, depth, { lightX: 0.2 }),
    null,
    'Node 无 WebGL 时必须安全返回 null，由 CPU 路径兜底',
  )

  // 凸起半球（中心近 depth=0，四周远 depth=1）：光源在正上方时，上半球面应比下半球面更亮。
  const dome = {
    width: 32,
    height: 32,
    data: new Float32Array(32 * 32).map((_, idx) => {
      const x = (idx % 32) / 31 - 0.5
      const y = Math.floor(idx / 32) / 31 - 0.5
      return Math.min(1, Math.hypot(x, y) * 2)
    }),
  }
  const topLit = applyPhysicalRelight(createImage(32, 32, () => [140, 140, 140, 255]), dome, {
    lightX: 0.5,
    lightY: 0.05,
    intensity: 1.8,
    rim: 0,
    ambient: 0.2,
  })
  assert.ok(pixelAt(topLit, 16, 10)[0] > pixelAt(topLit, 16, 22)[0], '顶光应照亮凸起的上坡面')
})

await check('性能：四模式在 512px 预览副本上各自低于 600ms，尺寸缩放稳定', () => {
  const size = 512
  const source = createImage(size, size, (x, y) => [x % 256, y % 256, (x + y) % 256, 255])
  const depth = gradientDepth(size, size)
  for (const settings of [
    { mode: 'fog', ...WORKSHOP.depthFx.fogPresets[0], anchors: [{ x: 0.5, y: 0.5, radius: 0.2, strength: 1, mode: 'add' }] },
    { mode: 'atmosphere', haze: 0.5, desaturate: 0.5, contrast: 1 },
    { mode: 'dof', focusX: 0.5, focusY: 0.5, aperture: 0.1, blur: 8 },
    { mode: 'parallax', amplitude: 24, shiftX: 0.4, shiftY: 0.1 },
  ]) {
    const started = Date.now()
    const rendered = applyDepthFx(source, depth, settings)
    const elapsed = Date.now() - started
    assert.equal(rendered.width, size)
    assert.ok(elapsed < 600, `${settings.mode} 耗时 ${elapsed}ms 超出预览预算`)
  }
  const small = resizeDepth(depth, 64, 32)
  assert.equal(small.width, 64)
  assert.equal(small.height, 32)
})

await check('回归：移轴对称虚化、视差前景不撕裂背景、聚雾锚点近景可见', () => {
  const w = 64
  const h = 64
  // 中心前景红块（depth=0.05）+ 周围远景蓝天（depth=0.95）
  const scene = createImage(w, h, (x, y) => {
    const inside = x >= 20 && x <= 44 && y >= 16 && y <= 52
    return inside ? [220, 40, 40, 255] : [220, 235, 250, 255]
  })
  const sceneDepth = {
    width: w,
    height: h,
    data: new Float32Array(w * h).map((_, index) => {
      const x = index % w
      const y = (index - x) / w
      return (x >= 20 && x <= 44 && y >= 16 && y <= 52) ? 0.05 : 0.95
    }),
  }

  // 1) 移轴：焦平面上下方都要虚化，不能只糊下半屏。
  const striped = createImage(32, 32, (x, y) => (x % 2 === 0 ? [255, 255, 255, 255] : [10, 10, 10, 255]))
  const flatDepth = { width: 32, height: 32, data: new Float32Array(32 * 32).fill(0.5) }
  const tilt = applyDepthFx(striped, flatDepth, {
    mode: 'dof',
    focusY: 0.5,
    aperture: 0.15,
    blur: 6,
    tiltShift: true,
  })
  assert.ok(pixelAt(tilt, 0, 1)[0] < 245 && pixelAt(tilt, 1, 1)[0] > 20, '移轴上半屏应发生虚化')
  assert.ok(pixelAt(tilt, 0, 30)[0] < 245 && pixelAt(tilt, 1, 30)[0] > 20, '移轴下半屏应发生虚化')

  // 2) 视差：前景向右移动时，前景左侧留出的背景空洞不能涂抹进红色前景像素。
  const warped = applyDepthFx(scene, sceneDepth, {
    mode: 'parallax',
    amplitude: 10,
    shiftX: -0.6,
    shiftY: 0,
  })
  const leftSkyPixel = pixelAt(warped, 10, 28)
  assert.ok(leftSkyPixel[2] > leftSkyPixel[0] + 10, '远景天空区域不应被前景红色重影污染')

  // 3) 聚雾锚点放在近景（depth < startDepth）时也能产生局部薄雾反馈。
  const darkNear = createImage(32, 32, () => [40, 40, 40, 255])
  const nearDepth = { width: 32, height: 32, data: new Float32Array(32 * 32).fill(0.1) }
  const misted = applyDepthFx(darkNear, nearDepth, {
    mode: 'fog',
    ...WORKSHOP.depthFx.fogPresets[0],
    density: 0.7,
    startDepth: 0.4,
    groundBias: 0,
    anchors: [{ x: 0.5, y: 0.5, radius: 0.35, strength: 1.0, mode: 'add' }],
  })
  assert.ok(pixelAt(misted, 16, 16)[0] > 45, '聚雾锚点在近景处应有可见雾感反馈')
})

await check('物理打光：前景/背景深度断崖处不产生黑白描边与过亮发光轮廓', () => {
  const size = 128
  const scene = createImage(size, size, () => [140, 140, 140, 255])
  // 模拟真实抠像/深度图的前景悬崖（中心前景 depth=0.1，四周远景 depth=0.85，过渡约 2px）
  const cliffDepth = {
    width: size,
    height: size,
    data: new Float32Array(size * size).map((_, idx) => {
      const x = idx % size
      const y = (idx - x) / size
      const dist = Math.hypot(x - 64, y - 64)
      if (dist <= 30) return 0.1
      if (dist >= 33) return 0.85
      return 0.1 + ((dist - 30) / 3) * 0.75
    }),
  }
  const relit = applyPhysicalRelight(scene, cliffDepth, {
    lightX: 0.25,
    lightY: 0.25,
    intensity: 1.2,
    rim: 0.9,
    ambient: 0.28,
  })
  const nearEdgeInterior = pixelAt(relit, 36, 64)[0]
  let edgeMax = 0
  let edgeMin = 255
  for (let x = 29; x <= 35; x += 1) {
    const val = pixelAt(relit, x, 64)[0]
    edgeMax = Math.max(edgeMax, val)
    edgeMin = Math.min(edgeMin, val)
  }
  assert.ok(edgeMax <= nearEdgeInterior + 10, `轮廓断崖不应出现过亮白边：edgeMax=${edgeMax}, nearEdgeInterior=${nearEdgeInterior}`)
  assert.ok(edgeMin >= 42, `轮廓断崖不应跌成死黑描边：edgeMin=${edgeMin}`)
})

await check('物理打光 v2：Node 无 WebGPU 安全回退、投射阴影、聚光收束与自发光保护', async () => {
  const size = 96
  const scene = createImage(size, size, () => [160, 160, 160, 255])
  const depth = {
    width: size,
    height: size,
    data: new Float32Array(size * size).map((_, idx) => {
      const x = idx % size
      const y = (idx - x) / size
      // 左侧近景遮挡柱（depth=0.05），右侧背景（depth=0.35）接收阴影
      return (x >= 28 && x <= 38 && y >= 24 && y <= 72) ? 0.05 : 0.35
    }),
  }
  assert.equal(
    await renderPhysicalRelightWebGPU(scene, depth, { lightX: 0.2 }),
    null,
    'Node 无 WebGPU 时应安全返回 null，由 WebGL/CPU 兜底',
  )
  const shadowed = applyPhysicalRelight(scene, depth, {
    lightX: 0.15,
    lightY: 0.5,
    lightZ: 0.35,
    intensity: 1.6,
    ambient: 0.18,
    shadow: 1,
    rim: 0,
  })
  const unshadowed = applyPhysicalRelight(scene, depth, {
    lightX: 0.15,
    lightY: 0.5,
    lightZ: 0.35,
    intensity: 1.6,
    ambient: 0.18,
    shadow: 0,
    rim: 0,
  })
  assert.ok(
    pixelAt(shadowed, 42, 48)[0] < pixelAt(unshadowed, 42, 48)[0] - 8,
    '开启投射阴影后，近景遮挡体背光侧应当出现明显投影压暗',
  )

  const flatDepth = { width: size, height: size, data: new Float32Array(size * size).fill(0.25) }
  const spotLit = applyPhysicalRelight(scene, flatDepth, {
    lightX: 0.5,
    lightY: 0.5,
    lightZ: 0.4,
    intensity: 1.5,
    ambient: 0.15,
    shadow: 0,
    spot: 0.95,
    rim: 0,
  })
  assert.ok(
    pixelAt(spotLit, 48, 48)[0] > pixelAt(spotLit, 4, 4)[0] + 35,
    '聚光收束后中心应显著亮于边角',
  )

  // 自发光保护：高亮高饱和像素（如灯笼）在背光暗处仍保持亮色
  const lanternScene = createImage(32, 32, (x, y) => (
    x >= 12 && x <= 20 && y >= 12 && y <= 20 ? [255, 200, 40, 255] : [180, 180, 180, 255]
  ))
  const lanternDepth = { width: 32, height: 32, data: new Float32Array(32 * 32).fill(0.4) }
  const darkLit = applyPhysicalRelight(lanternScene, lanternDepth, {
    lightX: 0.05,
    lightY: 0.05,
    intensity: 0.2,
    ambient: 0.05,
    shadow: 0,
    rim: 0,
  })
  assert.ok(
    pixelAt(darkLit, 16, 16)[0] > pixelAt(darkLit, 28, 28)[0] + 60,
    '高亮高饱和自发光区域在低环境光下不应熄灭成暗灰',
  )
})

summary()
