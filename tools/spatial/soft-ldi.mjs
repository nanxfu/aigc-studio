/** Research-only two-layer reference. No application entry point imports this module. */
const clamp = value => Math.max(0, Math.min(1, value))
const lin = value => Math.pow(value / 255, 2.2)
const srgb = value => Math.round(Math.pow(clamp(value), 1 / 2.2) * 255)

function bilinear(data, width, height, x, y, stride, channel) {
  const px = Math.max(0, Math.min(width - 1, x)), py = Math.max(0, Math.min(height - 1, y))
  const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1)
  const fx = px - x0, fy = py - y0
  return (data[(y0 * width + x0) * stride + channel] * (1 - fx) + data[(y0 * width + x1) * stride + channel] * fx) * (1 - fy)
    + (data[(y1 * width + x0) * stride + channel] * (1 - fx) + data[(y1 * width + x1) * stride + channel] * fx) * fy
}

/** Weighted 2D pyramid. Known samples are immutable; unknown values are low-frequency estimates. */
export function pullPush(values, weights, width, height, channels = 4) {
  const levels = [{ width, height, values: Float32Array.from(values), weights: Float32Array.from(weights) }]
  while (width > 1 || height > 1) {
    const parent = levels.at(-1), nw = Math.ceil(width / 2), nh = Math.ceil(height / 2)
    const next = { width: nw, height: nh, values: new Float32Array(nw * nh * channels), weights: new Float32Array(nw * nh) }
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = y * nw + x
      let count = 0, weight = 0
      for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
        const px = x * 2 + ox, py = y * 2 + oy
        if (px >= width || py >= height) continue
        const j = py * width + px, w = parent.weights[j]
        weight += w; count++
        for (let c = 0; c < channels; c++) next.values[i * channels + c] += parent.values[j * channels + c] * w
      }
      next.weights[i] = weight / count
      if (weight > 0) for (let c = 0; c < channels; c++) next.values[i * channels + c] /= weight
    }
    levels.push(next); width = nw; height = nh
  }
  for (let level = levels.length - 2; level >= 0; level--) {
    const fine = levels[level], coarse = levels[level + 1]
    for (let y = 0; y < fine.height; y++) for (let x = 0; x < fine.width; x++) {
      const i = y * fine.width + x
      if (fine.weights[i] > 0) continue
      for (let c = 0; c < channels; c++) {
        fine.values[i * channels + c] = bilinear(coarse.values, coarse.width, coarse.height, (x + 0.5) / 2 - 0.5, (y + 0.5) / 2 - 0.5, channels, c)
      }
    }
  }
  return levels[0].values
}

export function prepareSoftLdi(image, depth, { recoverColor = true, fill = true, alphaOracle = null } = {}) {
  const { width, height } = image, total = width * height
  if (depth.width !== width || depth.height !== height || depth.data.length !== total) throw new Error('Aligned RGB/depth required')
  if (image.data.length !== total * 4) throw new Error('RGBA length mismatch')
  const sorted = Array.from(depth.data).sort((a, b) => a - b)
  let near = sorted[Math.floor(total * 0.2)], far = sorted[Math.floor(total * 0.8)]
  for (let iteration = 0; iteration < 8; iteration++) {
    let ns = 0, fs = 0, nc = 0, fc = 0
    for (const d of depth.data) {
      if (Math.abs(d - near) <= Math.abs(d - far)) { ns += d; nc++ } else { fs += d; fc++ }
    }
    if (nc) near = ns / nc
    if (fc) far = fs / fc
  }
  const span = Math.max(0.01, far - near)
  const seedAlpha = Float32Array.from(depth.data, d => clamp((far - d) / span))
  const fgWeights = new Float32Array(total), bgWeights = new Float32Array(total)
  const values = new Float32Array(total * 4)
  for (let i = 0; i < total; i++) {
    fgWeights[i] = seedAlpha[i] > 0.96 ? 1 : 0
    bgWeights[i] = seedAlpha[i] < 0.04 ? 1 : 0
    for (let c = 0; c < 3; c++) values[i * 4 + c] = lin(image.data[i * 4 + c])
    values[i * 4 + 3] = depth.data[i]
  }
  const foreground = pullPush(values, fgWeights, width, height)
  const background = pullPush(values, bgWeights, width, height)
  const alpha = new Float32Array(total)
  for (let i = 0; i < total; i++) {
    let a = seedAlpha[i]
    if (a > 0.005 && a < 0.995) {
      let dot = 0, length = 0
      for (let c = 0; c < 3; c++) {
        const delta = foreground[i * 4 + c] - background[i * 4 + c]
        dot += (values[i * 4 + c] - background[i * 4 + c]) * delta
        length += delta * delta
      }
      // Color-line estimate regularized by depth; weak contrast keeps its depth prior.
      a = clamp((dot + 0.004 * a) / (length + 0.004))
    }
    if (alphaOracle) a = alphaOracle[i]
    alpha[i] = a
    for (let c = 0; c < 3; c++) {
      const prior = foreground[i * 4 + c]
      const original = values[i * 4 + c]
      foreground[i * 4 + c] = recoverColor
        ? clamp((a * (original - (1 - a) * background[i * 4 + c]) + 0.002 * prior) / (a * a + 0.002))
        : original
      if (!fill && bgWeights[i] === 0) background[i * 4 + c] = original
    }
    // Keep continuous depth only where the corresponding surface is visible.
    if (fgWeights[i] === 0) foreground[i * 4 + 3] = near
    if (bgWeights[i] === 0) background[i * 4 + 3] = far
  }
  const premultiplied = new Float32Array(total * 4)
  for (let i = 0; i < total; i++) {
    for (let c = 0; c < 3; c++) premultiplied[i * 4 + c] = foreground[i * 4 + c] * alpha[i]
    premultiplied[i * 4 + 3] = alpha[i]
  }
  return { width, height, foreground, background, alpha, premultiplied, near, far, source: image, version: 'soft-ldi-research-1' }
}

/** CPU inverse warp with a finite fixed-point solve per layer, for a small-motion experiment. */
export function renderSoftLdi(asset, { vx = 0, vy = 0 } = {}) {
  const { width, height, foreground, background, alpha, premultiplied } = asset
  if (Math.hypot(vx, vy) < 1e-6) return { width, height, data: new Uint8ClampedArray(asset.source.data) }
  const data = new Uint8ClampedArray(width * height * 4)
  const coord = (layer, x, y) => {
    let px = x, py = y
    for (let step = 0; step < 5; step++) {
      const d = bilinear(layer, width, height, px, py, 4, 3)
      px = x + vx * (2 * d - 1); py = y + vy * (2 * d - 1)
    }
    return [px, py]
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x
    const [fx, fy] = coord(foreground, x, y), [bx, by] = coord(background, x, y)
    const a = bilinear(alpha, width, height, fx, fy, 1, 0)
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = srgb(bilinear(premultiplied, width, height, fx, fy, 4, c) + bilinear(background, width, height, bx, by, 4, c) * (1 - a))
    }
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

export function parallaxVector(width, height, { amplitude = 24, shiftX = 0, shiftY = 0 } = {}) {
  const scale = Math.max(1, Math.max(width, height) / 384)
  return { vx: amplitude * scale * shiftX, vy: amplitude * scale * shiftY }
}
