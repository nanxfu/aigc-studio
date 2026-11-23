#!/usr/bin/env node
/**
 * 资产工坊本机算子的离线回归（M4.2a / M4.2b）。
 *
 * 覆盖 `web/logic/workshop.js` 的纯逻辑，不依赖浏览器、canvas 或网络：
 *  - 像素画网格探测：16×16 格、每格 4×4、带相位偏移与抗锯齿的合成图能探出 cell=4、
 *    相位 1 且置信度较高；纯块状图与无结构均匀图分别拿到高置信度与回退结果；
 *  - 像素对齐：调色盘颜色数不超过 colors、Alpha 只有 0/255、整数倍放大走最近邻复制；
 *  - Oklab 色空间：sRGB → Oklab → sRGB 往返误差 ≤ 2，逆变换越界分量被夹住；
 *  - 调色盘量化：多簇颜色能压到目标色数，count 之和等于输入数量；
 *  - 无缝平铺：接缝 MAE 判定阈值取契约值，混边后接缝误差明显下降且入参不被修改；
 *  - 序列帧切片：行×列、atlas 字段口径、全透明格跳过、trimAlpha=false 全保留；
 *  - 2×2 平铺几何与 512×512 大图性能护栏（防止误用 O(n²) 量化算法）。
 *
 * 运行：node test/check-client-workshop-logic.mjs
 */

import assert from 'node:assert/strict'

import { WORKSHOP } from '../shared/contract.js'
import {
  blendSeamEdges,
  detectPixelGrid,
  oklabToRgb,
  quantizePalette,
  rgbToOklab,
  seamMae,
  sliceSpriteFrames,
  snapPixelArt,
  tabulateTiles,
} from '../web/logic/workshop.js'
import { createCheckRunner } from './helpers/check.mjs'

const { check, summary } = createCheckRunner()

// ── 测试工具 ──────────────────────────────────────────────────────────────

/** 创建可写 RGBA 图像：`set` 逐点写、`fill` 整幅填充，默认 Alpha 255。 */
function createImage(width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  function set(x, y, r, g, b, a = 255) {
    const offset = (y * width + x) * 4
    data[offset] = r
    data[offset + 1] = g
    data[offset + 2] = b
    data[offset + 3] = a
  }
  function fill(r, g, b, a = 255) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) set(x, y, r, g, b, a)
    }
  }
  return { width, height, data, set, fill }
}

/** 读一个像素的 RGBA 数组（测试断言用）。 */
function pixelOf(image, x, y) {
  const offset = (y * image.width + x) * 4
  return Array.from(image.data.subarray(offset, offset + 4))
}

/** 确定性线性同余伪随机数（同一 seed 每次运行结果一致）。 */
function createRng(seed) {
  let state = seed % 2147483647
  if (state <= 0) state += 2147483646
  return () => {
    state = (state * 16807) % 2147483647
    return (state - 1) / 2147483646
  }
}

/** 不透明像素里出现的颜色集合（`r,g,b` 字符串）。 */
function opaqueColorSet(image) {
  const colors = new Set()
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset + 3] === 0) continue
    colors.add(`${image.data[offset]},${image.data[offset + 1]},${image.data[offset + 2]}`)
  }
  return colors
}

/** 整幅图出现过的 Alpha 值集合。 */
function alphaValueSet(image) {
  const alphas = new Set()
  for (let offset = 3; offset < image.data.length; offset += 4) alphas.add(image.data[offset])
  return alphas
}

/**
 * 合成抗锯齿像素画：16×16 个逻辑格、每格 4×4 物理像素、左上各偏 1 像素，
 * 再叠加 3×3 对称模糊模拟 AI 出图的半像素偏移与抗锯齿。
 */
function syntheticAntialiasedPixelArt() {
  const gridCount = 16
  const cell = 4
  const offset = 1
  const side = offset + gridCount * cell + 1
  const rng = createRng(12345)
  const palette = Array.from({ length: 12 }, () => [
    Math.floor(rng() * 256),
    Math.floor(rng() * 256),
    Math.floor(rng() * 256),
  ])

  const base = createImage(side, side)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const gridX = Math.min(gridCount - 1, Math.max(0, Math.floor((x - offset) / cell)))
      const gridY = Math.min(gridCount - 1, Math.max(0, Math.floor((y - offset) / cell)))
      const color = palette[(gridX * 7 + gridY * 13) % palette.length]
      base.set(x, y, color[0], color[1], color[2])
    }
  }

  // 轻微抗锯齿：3×3 卷积（中心 0.6，正交 0.075，对角 0.025），等价于生成模型在格线处
  // 留下的半像素过渡；格距不变，但边缘能量被摊开。
  const kernel = [
    [-1, -1, 0.025],
    [0, -1, 0.075],
    [1, -1, 0.025],
    [-1, 0, 0.075],
    [0, 0, 0.6],
    [1, 0, 0.075],
    [-1, 1, 0.025],
    [0, 1, 0.075],
    [1, 1, 0.025],
  ]
  const blurred = createImage(side, side)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      let red = 0
      let green = 0
      let blue = 0
      for (const [dx, dy, weight] of kernel) {
        const sourceX = Math.min(side - 1, Math.max(0, x + dx))
        const sourceY = Math.min(side - 1, Math.max(0, y + dy))
        const source = (sourceY * side + sourceX) * 4
        red += base.data[source] * weight
        green += base.data[source + 1] * weight
        blue += base.data[source + 2] * weight
      }
      blurred.set(x, y, Math.round(red), Math.round(green), Math.round(blue))
    }
  }
  return blurred
}

/**
 * 合成块状像素画：32×32 图像、每格 4×4、6 种基色，并把部分逻辑格整格设为透明，
 * 用来同时验证 Alpha 二值化与全透明格跳过。
 */
function syntheticSpriteArt() {
  const cell = 4
  const logical = 8
  const side = cell * logical
  const palette = [
    [210, 40, 40],
    [40, 210, 40],
    [40, 40, 210],
    [220, 210, 50],
    [30, 160, 160],
    [170, 60, 190],
  ]
  const image = createImage(side, side)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const gridX = Math.floor(x / cell)
      const gridY = Math.floor(y / cell)
      const index = gridY * logical + gridX
      if (index % 7 === 0) {
        image.set(x, y, 0, 0, 0, 0)
        continue
      }
      const color = palette[index % palette.length]
      image.set(x, y, color[0], color[1], color[2])
    }
  }
  return image
}

// ── 1. 网格探测 ───────────────────────────────────────────────────────────

await check('网格探测：抗锯齿合成像素画探出 cell=4 / 相位 1 / 置信度较高', () => {
  const image = syntheticAntialiasedPixelArt()
  const grid = detectPixelGrid(image.data, image.width, image.height)

  assert.equal(grid.cell, 4, `应探出真实格距 4，实际 ${grid.cell}`)
  assert.equal(grid.offsetX, 1, `左边界相位应为 1，实际 ${grid.offsetX}`)
  assert.equal(grid.offsetY, 1, `上边界相位应为 1，实际 ${grid.offsetY}`)
  assert.ok(grid.confidence > 0.7, `带抗锯齿的合成图置信度应 > 0.7，实际 ${grid.confidence}`)
  assert.ok(grid.confidence <= 1, '置信度必须落在 0..1')

  // 同样尺寸的纯块状图（无偏移、无抗锯齿）应该拿到更高的置信度与零相位。
  const rng = createRng(99)
  const colors = Array.from({ length: 6 }, () => [
    Math.floor(rng() * 256),
    Math.floor(rng() * 256),
    Math.floor(rng() * 256),
  ])
  const blocky = createImage(64, 64)
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const color = colors[(Math.floor(x / 4) * 5 + Math.floor(y / 4) * 3) % colors.length]
      blocky.set(x, y, color[0], color[1], color[2])
    }
  }
  const blockyGrid = detectPixelGrid(blocky.data, 64, 64)
  assert.equal(blockyGrid.cell, 4)
  assert.equal(blockyGrid.offsetX, 0)
  assert.equal(blockyGrid.offsetY, 0)
  assert.ok(blockyGrid.confidence > 0.8, `纯块状图置信度应 > 0.8，实际 ${blockyGrid.confidence}`)
})

await check('网格探测：无周期结构时回退 cell=1 / confidence=0', () => {
  const uniform = createImage(32, 32)
  uniform.fill(100, 120, 140)
  const grid = detectPixelGrid(uniform.data, 32, 32)
  assert.equal(grid.cell, 1)
  assert.equal(grid.offsetX, 0)
  assert.equal(grid.offsetY, 0)
  assert.equal(grid.confidence, 0)
})

// ── 2. 像素对齐与量化 ─────────────────────────────────────────────────────

await check('像素对齐：颜色数 ≤ colors、Alpha 只有 0/255、全透明格保持透明', () => {
  const image = syntheticSpriteArt()
  const snapped = snapPixelArt(image.data, image.width, image.height, {
    cell: 4,
    colors: 3,
    alphaThreshold: 128,
    scale: 1,
  })

  assert.equal(snapped.width, 8, '32/4 应得到 8 个逻辑像素宽')
  assert.equal(snapped.height, 8)
  const colors = opaqueColorSet(snapped)
  assert.ok(colors.size <= 3, `量化后颜色数应 ≤ 3，实际 ${colors.size}`)
  assert.ok(colors.size >= 1)

  const alphas = alphaValueSet(snapped)
  assert.deepEqual([...alphas].sort((a, b) => a - b), [0, 255], 'Alpha 应被硬边二值化为 0 / 255')

  // index % 7 === 0 的逻辑格是整格透明，输出对应格也必须保持透明。
  for (const index of [0, 7, 14]) {
    const gridX = index % 8
    const gridY = Math.floor(index / 8)
    assert.equal(pixelOf(snapped, gridX, gridY)[3], 0, `逻辑格 ${index} 应保持透明`)
  }

  // 抗锯齿像素画的量化：12 种基色 + 边界混色压到 4 色，且 Alpha 全部不透明。
  const blurred = syntheticAntialiasedPixelArt()
  const snappedBlur = snapPixelArt(blurred.data, blurred.width, blurred.height, { cell: 4, colors: 4 })
  assert.equal(opaqueColorSet(snappedBlur).size <= 4, true, '抗锯齿图量化后颜色数应 ≤ 4')
  assert.deepEqual([...alphaValueSet(snappedBlur)], [255], '全不透明输入不应产出透明像素')
})

await check('像素对齐：scale=2 尺寸翻倍且按最近邻整块复制', () => {
  const image = syntheticSpriteArt()
  const base = snapPixelArt(image.data, image.width, image.height, { cell: 4, colors: 4, scale: 1 })
  const scaled = snapPixelArt(image.data, image.width, image.height, { cell: 4, colors: 4, scale: 2 })

  assert.equal(scaled.width, base.width * 2)
  assert.equal(scaled.height, base.height * 2)

  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      const expected = pixelOf(base, x, y)
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        assert.deepEqual(pixelOf(scaled, x * 2 + dx, y * 2 + dy), expected, `缩放块 (${x},${y}) 应是最近邻复制`)
      }
    }
  }
})

await check('像素对齐：Alpha 阈值把半透明格判为透明', () => {
  const image = createImage(8, 8)
  image.fill(0, 0, 0, 0)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) image.set(x, y, 200, 30, 30, 255)
    for (let x = 4; x < 8; x++) image.set(x, y, 30, 200, 30, 100)
  }
  const snapped = snapPixelArt(image.data, 8, 8, { cell: 4, colors: 2, alphaThreshold: 128 })
  assert.deepEqual([...alphaValueSet(snapped)].sort((a, b) => a - b), [0, 255])
  assert.equal(pixelOf(snapped, 0, 0)[3], 255, 'Alpha 255 的格子应保留')
  assert.equal(pixelOf(snapped, 1, 0)[3], 0, 'Alpha 100 低于阈值 128，应变成透明')
})

// ── 3. Oklab ──────────────────────────────────────────────────────────────

await check('Oklab：sRGB 往返误差 ≤ 2，灰色色度接近 0，逆变换分量夹在 0..255', () => {
  const samples = [
    [0, 0, 0],
    [255, 255, 255],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [128, 128, 128],
    [12, 34, 56],
    [250, 120, 7],
  ]
  const rng = createRng(2026)
  for (let i = 0; i < 60; i++) {
    samples.push([Math.floor(rng() * 256), Math.floor(rng() * 256), Math.floor(rng() * 256)])
  }

  for (const [r, g, b] of samples) {
    const [L, a, axisB] = rgbToOklab(r, g, b)
    const [backR, backG, backB] = oklabToRgb(L, a, axisB)
    assert.ok(Math.abs(backR - r) <= 2, `R 往返误差超限：${r} → ${backR}`)
    assert.ok(Math.abs(backG - g) <= 2, `G 往返误差超限：${g} → ${backG}`)
    assert.ok(Math.abs(backB - b) <= 2, `B 往返误差超限：${b} → ${backB}`)
  }

  // 灰色在 Oklab 里应没有色相分量。
  const [, grayA, grayB] = rgbToOklab(128, 128, 128)
  assert.ok(Math.abs(grayA) < 0.002, `灰色 a 应接近 0，实际 ${grayA}`)
  assert.ok(Math.abs(grayB) < 0.002, `灰色 b 应接近 0，实际 ${grayB}`)

  const clamped = oklabToRgb(5, 2, -2)
  assert.equal(clamped.length, 3)
  for (const value of clamped) assert.ok(value >= 0 && value <= 255, `越界分量应夹到 0..255，实际 ${value}`)
})

// ── 4. 调色盘量化 ─────────────────────────────────────────────────────────

await check('调色盘量化：多簇颜色压到目标色数且 count 总数守恒', () => {
  const rng = createRng(777)
  const list = []
  for (let i = 0; i < 30; i++) list.push([200 + Math.floor(rng() * 5) - 2, 20, 20])
  for (let i = 0; i < 30; i++) list.push([20, 200 + Math.floor(rng() * 5) - 2, 20])
  for (let i = 0; i < 40; i++) list.push([20, 20, 200 + Math.floor(rng() * 5) - 2])

  const palette = quantizePalette(list, 3)
  assert.ok(palette.length <= 3, `颜色数应 ≤ 3，实际 ${palette.length}`)
  assert.equal(
    palette.reduce((total, entry) => total + entry.count, 0),
    list.length,
    'count 之和应等于输入颜色数量',
  )
  for (const entry of palette) {
    assert.equal(entry.rgb.length, 3)
    assert.ok(entry.count > 0)
  }
  // 三个簇各 30/30/40 个样本：每个调色盘颜色都应≥25，避免把两簇并成一簇。
  for (const entry of palette) assert.ok(entry.count >= 25, `聚类结果过于挤压：${entry.count}`)

  assert.deepEqual(quantizePalette([], 4), [], '空列表应返回空调色盘')
  const exact = quantizePalette(
    [
      [10, 20, 30],
      [10, 20, 30],
      [40, 50, 60],
    ],
    8,
  )
  assert.equal(exact.length, 2, '颜色种类少于目标色数时直接复用原色')
})

await check('调色盘量化：超过 4096 种颜色的三簇图不被 Oklab b 轴混淆（分箱回归）', () => {
  // 回归（2026-11-23）：样本对象同时带 sRGB 的 b 与 Oklab 的 b 轴，早期实现用同名 `b`
  // 导致后者覆盖前者；超过 MAX_FIT_POINTS（4096）走 4bit 分箱时，sRGB 蓝通道被误读成
  // Oklab 轴，大色数图的调色盘整体偏色（蓝通道被拉向 0）。用三簇 6000 种唯一色覆盖该分支。
  const clusters = [
    { center: [210, 48, 40], counts: [2000, 0, 0] },
    { center: [40, 200, 60], counts: [0, 2000, 0] },
    { center: [60, 70, 205], counts: [0, 0, 2000] },
  ]
  const list = []
  for (const cluster of clusters) {
    for (let dr = 0; dr < 20; dr++) {
      for (let dg = 0; dg < 10; dg++) {
        for (let db = 0; db < 10; db++) {
          list.push([
            cluster.center[0] + dr - 10,
            cluster.center[1] + dg - 5,
            cluster.center[2] + db - 5,
          ])
        }
      }
    }
  }
  assert.ok(list.length > 4096, `样本需要超过 4096 种颜色，实际 ${list.length}`)

  const palette = quantizePalette(list, 3)
  assert.ok(palette.length <= 3, `颜色数应 ≤ 3，实际 ${palette.length}`)
  assert.equal(
    palette.reduce((total, entry) => total + entry.count, 0),
    list.length,
    '分箱合并后 count 之和必须仍等于输入颜色总数',
  )

  // 每个簇都应有对应调色盘颜色，且 RGB 三通道偏离都不超过容差（分箱与 K-Means 均允许少量漂移）。
  for (const cluster of clusters) {
    const nearest = palette
      .map((entry) => ({
        entry,
        distance: Math.hypot(...entry.rgb.map((value, index) => value - cluster.center[index])),
      }))
      .sort((left, right) => left.distance - right.distance)[0]
    assert.ok(nearest.distance <= 24, `簇 ${cluster.center} 缺少对应调色盘颜色，最近为 ${nearest.entry.rgb}`)
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(nearest.entry.rgb[channel] - cluster.center[channel])
      assert.ok(
        delta <= 16,
        `簇 ${cluster.center} 第 ${channel} 通道偏离 ${delta}（调色盘 ${nearest.entry.rgb}），疑似 b 轴被混淆`,
      )
    }
  }
})

// ── 5. 接缝评估 ───────────────────────────────────────────────────────────

await check('接缝评估：四边一致判定无缝，明显突变判定有缝', () => {
  // 边框统一填充的图：左右列 / 上下行完全相同 → MAE = 0。
  const seamless = createImage(24, 24)
  const rng = createRng(4242)
  seamless.fill(90, 140, 60)
  for (let y = 1; y < 23; y++) {
    for (let x = 1; x < 23; x++) {
      seamless.set(x, y, Math.floor(rng() * 200), Math.floor(rng() * 200), Math.floor(rng() * 200))
    }
  }
  const seamlessResult = seamMae(seamless.data, 24, 24)
  assert.equal(seamlessResult.horizontalSeamMae, 0)
  assert.equal(seamlessResult.verticalSeamMae, 0)
  assert.equal(seamlessResult.maxSeamMae, 0)
  assert.equal(seamlessResult.isSeamless, true)
  assert.equal(seamlessResult.threshold, WORKSHOP.tile.seamlessThreshold, '阈值必须取契约值')

  // 左半红、右半蓝：左右边差值 = 170，远超阈值 → 判定有缝。
  const hard = createImage(16, 16)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (x < 8) hard.set(x, y, 255, 0, 0)
      else hard.set(x, y, 0, 0, 255)
    }
  }
  const hardResult = seamMae(hard.data, 16, 16)
  assert.ok(hardResult.horizontalSeamMae > WORKSHOP.tile.seamlessThreshold)
  assert.equal(hardResult.isSeamless, false)
  assert.equal(hardResult.maxSeamMae, hardResult.horizontalSeamMae)

  // 左右边只差 30（MAE = 10 < 12）：应判为无缝，验证阈值边界口径。
  const near = createImage(16, 16)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (x < 8) near.set(x, y, 50, 50, 50)
      else near.set(x, y, 80, 50, 50)
    }
  }
  const nearResult = seamMae(near.data, 16, 16)
  assert.equal(nearResult.horizontalSeamMae, 10)
  assert.equal(nearResult.isSeamless, true)
})

// ── 6. 混边 ───────────────────────────────────────────────────────────────

await check('混边：半格滚动 + 余弦渐隐后接缝 MAE 明显下降且不修改入参', () => {
  // 左右两条边分别接近 A / R，但图像中心两侧都是 M：滚动半格后接缝两侧都变成 M。
  const image = createImage(64, 64)
  const leftColor = [240, 20, 20]
  const middleColor = [30, 30, 30]
  const rightColor = [20, 20, 240]
  const mix = (from, to, ratio) => from.map((value, index) => Math.round(value + (to[index] - value) * ratio))
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const color = x < 32 ? mix(leftColor, middleColor, x / 31) : mix(middleColor, rightColor, (x - 32) / 31)
      image.set(x, y, color[0], color[1], color[2])
    }
  }
  const before = seamMae(image.data, 64, 64)
  const snapshot = Uint8ClampedArray.from(image.data)

  const blended = blendSeamEdges(image.data, 64, 64, { borderRatio: 0.02 })
  const after = seamMae(blended.data, 64, 64)

  assert.equal(blended.width, 64)
  assert.equal(blended.height, 64)
  assert.equal(blended.data.length, image.data.length)
  assert.ok(before.horizontalSeamMae > 100, `测试图初始接缝 MAE 应很大，实际 ${before.horizontalSeamMae}`)
  assert.ok(
    after.horizontalSeamMae < before.horizontalSeamMae,
    `混边后接缝 MAE 应下降：${before.horizontalSeamMae} → ${after.horizontalSeamMae}`,
  )
  assert.ok(after.maxSeamMae < WORKSHOP.tile.seamlessThreshold, `混边后应低于无缝阈值，实际 ${after.maxSeamMae}`)
  assert.deepEqual(Array.from(image.data), Array.from(snapshot), '混边不应修改入参数据')
})

// ── 7. 序列帧切片 ─────────────────────────────────────────────────────────

await check('序列帧切片：行×列、atlas 字段与全透明格跳过', () => {
  // 64×64 切成 2×2，每帧 32×32：
  //  - 帧 0（左上）：整帧不透明；
  //  - 帧 1（右上）：全透明 → 跳过；
  //  - 帧 2（左下）：内容位于帧内 (4,4) 起的 10×8 区域 → trimmed；
  //  - 帧 3（右下）：整帧不透明。
  const sheet = createImage(64, 64)
  sheet.fill(0, 0, 0, 0)
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) sheet.set(x, y, 200, 10, 10)
  }
  for (let y = 32 + 4; y < 32 + 12; y++) {
    for (let x = 4; x < 14; x++) sheet.set(x, y, 10, 10, 200)
  }
  for (let y = 32; y < 64; y++) {
    for (let x = 32; x < 64; x++) sheet.set(x, y, 10, 200, 10)
  }

  const sliced = sliceSpriteFrames(sheet.data, 64, 64, { rows: 2, cols: 2 })
  assert.equal(sliced.frames.length, 3, '全透明的右上帧应被跳过')
  assert.deepEqual(
    sliced.frames.map((frame) => frame.index),
    [0, 1, 2],
    '跳过的透明帧不占用帧序号',
  )
  for (const frame of sliced.frames) {
    assert.equal(frame.w, 32)
    assert.equal(frame.h, 32)
  }

  const trimmedFrame = sliced.frames[1]
  assert.equal(trimmedFrame.x, 0)
  assert.equal(trimmedFrame.y, 32)
  assert.equal(trimmedFrame.srcX, 4)
  assert.equal(trimmedFrame.srcY, 4)
  assert.equal(trimmedFrame.srcW, 10)
  assert.equal(trimmedFrame.srcH, 8)
  assert.equal(trimmedFrame.trimmed, true)
  assert.equal(sliced.frames[0].trimmed, false)
  assert.equal(sliced.frames[2].trimmed, false)

  // atlas：meta 口径 + Aseprite 兼容帧字段。
  assert.equal(sliced.atlas.meta.app, 'aigc-studio')
  assert.equal(sliced.atlas.meta.size.w, 64)
  assert.equal(sliced.atlas.meta.size.h, 64)
  assert.equal(sliced.atlas.meta.frameSize.w, 32)
  assert.equal(sliced.atlas.meta.frameSize.h, 32)
  assert.equal(sliced.atlas.meta.count, 3)
  assert.equal(Object.keys(sliced.atlas.frames).length, 3)

  const atlasFrame = sliced.atlas.frames['frame_001.png']
  assert.deepEqual(atlasFrame.frame, { x: 4, y: 36, w: 10, h: 8 })
  assert.equal(atlasFrame.trimmed, true)
  assert.deepEqual(atlasFrame.spriteSourceSize, { x: 4, y: 4, w: 10, h: 8 })
  assert.deepEqual(atlasFrame.sourceSize, { w: 32, h: 32 })
  assert.deepEqual(atlasFrame.pivot, { x: 0.5, y: 0.5 })

  // trimAlpha=false：保留全部 4 帧，且都按未裁剪处理。
  const untrimmed = sliceSpriteFrames(sheet.data, 64, 64, { rows: 2, cols: 2, trimAlpha: false })
  assert.equal(untrimmed.frames.length, 4)
  for (const frame of untrimmed.frames) {
    assert.equal(frame.trimmed, false)
    assert.deepEqual([frame.srcX, frame.srcY, frame.srcW, frame.srcH], [0, 0, 32, 32])
  }

  // 护栏：单帧小于最小边长、帧数超过契约上限都应报错。
  assert.throws(() => sliceSpriteFrames(sheet.data, 64, 64, { rows: 1, cols: 9 }), /最小边长/)
  const bigSheet = createImage(128, 128)
  bigSheet.fill(1, 2, 3)
  assert.throws(() => sliceSpriteFrames(bigSheet.data, 128, 128, { rows: 9, cols: 9 }), /超过上限/)
})

// ── 8. 平铺几何 ───────────────────────────────────────────────────────────

await check('平铺几何：2×2 尺寸与 placements，repeat 覆盖默认值', () => {
  const tiles = tabulateTiles(64, 48)
  assert.equal(tiles.width, 128)
  assert.equal(tiles.height, 96)
  assert.deepEqual(tiles.placements, [
    { x: 0, y: 0 },
    { x: 64, y: 0 },
    { x: 0, y: 48 },
    { x: 64, y: 48 },
  ])

  const triple = tabulateTiles(64, 48, { repeat: 3 })
  assert.equal(triple.width, 192)
  assert.equal(triple.height, 144)
  assert.equal(triple.placements.length, 9)
  assert.deepEqual(triple.placements[8], { x: 128, y: 96 })
})

// ── 9. 大图性能护栏 ───────────────────────────────────────────────────────

await check('大图性能：512×512 默认参数 snapPixelArt 在 3 秒内完成', () => {
  const side = 512
  const image = createImage(side, side)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      // 近似「每个像素颜色都不同」的最坏情况，逼出调色盘量化与逐像素映射的上界。
      image.set(x, y, (x * 7 + y * 3) & 255, (x * 13 + y * 29) & 255, (x * 31 + y * 17) & 255)
    }
  }

  const started = performance.now()
  const snapped = snapPixelArt(image.data, side, side, {})
  const elapsed = performance.now() - started

  assert.equal(snapped.width, side, '默认 cell=1 时输出尺寸与原图相同')
  assert.equal(snapped.height, side)
  assert.equal(snapped.data.length, side * side * 4)
  assert.ok(opaqueColorSet(snapped).size <= WORKSHOP.pixel.colors.default, '默认输出颜色数应 ≤ 契约默认色数')
  assert.ok(elapsed < 3000, `512×512 量化耗时 ${elapsed.toFixed(0)}ms，超过 3 秒护栏`)
  console.log(`  512×512 默认参数 snapPixelArt 耗时 ${elapsed.toFixed(0)}ms`)
})

summary()
