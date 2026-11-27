/** Second research prototype: discrete occlusion ownership with continuous per-layer geometry. */
import { pullPush } from './soft-ldi.mjs'

const clamp = v => Math.max(0, Math.min(1, v))
const lin = v => Math.pow(v / 255, 2.2)
const srgb = v => Math.round(Math.pow(clamp(v), 1 / 2.2) * 255)

function sample(data, w, h, x, y, stride, c) {
  x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y))
  const ix = Math.floor(x), iy = Math.floor(y), nx = Math.min(w - 1, ix + 1), ny = Math.min(h - 1, iy + 1)
  const fx = x - ix, fy = y - iy
  return (data[(iy * w + ix) * stride + c] * (1 - fx) + data[(iy * w + nx) * stride + c] * fx) * (1 - fy)
    + (data[(ny * w + ix) * stride + c] * (1 - fx) + data[(ny * w + nx) * stride + c] * fx) * fy
}

function clustersOf(depth, maxLayers) {
  const sorted = Array.from(depth).sort((a, b) => a - b)
  let centers = Array.from({ length: maxLayers }, (_, i) => sorted[Math.floor((sorted.length - 1) * (i + 0.5) / maxLayers)])
  for (let iteration = 0; iteration < 8; iteration++) {
    const sums = new Float64Array(centers.length), counts = new Uint32Array(centers.length)
    for (const d of depth) {
      let best = 0
      for (let k = 1; k < centers.length; k++) if (Math.abs(d - centers[k]) < Math.abs(d - centers[best])) best = k
      sums[best] += d; counts[best]++
    }
    centers = centers.map((d, i) => counts[i] ? sums[i] / counts[i] : d).sort((a, b) => a - b)
  }
  return centers.filter((d, i) => i === 0 || d - centers[i - 1] > 0.065)
}

/** Multi-source distance/owner field, excluding explicitly incompatible depth layers. */
function propagation(weights, allowed, w, h) {
  const total = w * h, owner = new Int32Array(total).fill(-1), distance = new Uint16Array(total).fill(65535)
  const queue = new Int32Array(total)
  let head = 0, tail = 0
  for (let i = 0; i < total; i++) if (weights[i]) { owner[i] = i; distance[i] = 0; queue[tail++] = i }
  while (head < tail) {
    const i = queue[head++], x = i % w, y = Math.floor(i / w)
    for (const j of [x ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y ? i - w : -1, y + 1 < h ? i + w : -1]) {
      if (j < 0 || !allowed[j] || distance[j] !== 65535) continue
      distance[j] = distance[i] + 1; owner[j] = owner[i]; queue[tail++] = j
    }
  }
  return { owner, distance }
}

/** Exemplar patch transfer. Scores only visible context; source patches never contain hidden pixels. */
export function exemplarFill(values, known, allowed, w, h, { radius = 3, maxDistance = 48 } = {}) {
  const channels = 4, total = w * h
  const output = pullPush(values, known, w, h, channels)
  const { owner, distance } = propagation(known, allowed, w, h)
  const validSources = []
  for (let y = radius; y < h - radius; y++) for (let x = radius; x < w - radius; x++) {
    let valid = true
    for (let oy = -radius; oy <= radius && valid; oy++) for (let ox = -radius; ox <= radius; ox++) {
      if (!known[(y + oy) * w + x + ox]) { valid = false; break }
    }
    if (valid) validSources.push(y * w + x)
  }
  const confidence = Float32Array.from(known)
  const holes = []
  for (let i = 0; i < total; i++) if (!known[i] && allowed[i] && distance[i] <= maxDistance) holes.push(i)
  holes.sort((a, b) => distance[a] - distance[b])
  let state = 0x2c02b3
  const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n }
  const sourceMap = new Int32Array(total).fill(-1)
  for (const index of holes) {
    if (confidence[index] > 0.2 || !validSources.length) continue
    const x = index % w, y = Math.floor(index / w)
    let best = -1, bestCost = Infinity, bestCoverage = 0
    const candidates = []
    for (const j of [x ? index - 1 : -1, y ? index - w : -1, x + 1 < w ? index + 1 : -1, y + 1 < h ? index + w : -1]) {
      if (j >= 0 && sourceMap[j] >= 0) candidates.push(sourceMap[j] + index - j)
    }
    if (owner[index] >= 0) candidates.push(owner[index])
    for (let t = 0; t < 112; t++) candidates.push(validSources[random(validSources.length)])
    for (const candidate of candidates) {
      const cx = candidate % w, cy = Math.floor(candidate / w)
      if (cx < radius || cx >= w - radius || cy < radius || cy >= h - radius) continue
      let error = 0, coverage = 0, valid = true
      for (let oy = -radius; oy <= radius && valid; oy++) for (let ox = -radius; ox <= radius; ox++) {
        const sx = cx + ox, sy = cy + oy, src = sy * w + sx
        if (!known[src]) { valid = false; break }
        const tx = x + ox, ty = y + oy
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue
        const dst = ty * w + tx, weight = confidence[dst]
        if (weight <= 0.01) continue
        for (let c = 0; c < 3; c++) error += (output[dst * 4 + c] - values[src * 4 + c]) ** 2 * weight
        coverage += weight
      }
      if (!valid || coverage < 2) continue
      const cost = error / coverage + Math.hypot(cx - x, cy - y) * 0.000005
      if (cost < bestCost) { bestCost = cost; best = candidate; bestCoverage = coverage }
    }
    if (best < 0) continue
    const cx = best % w, cy = Math.floor(best / w)
    for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
      const tx = x + ox, ty = y + oy
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue
      const dst = ty * w + tx, src = (cy + oy) * w + cx + ox
      if (known[dst] || !allowed[dst] || distance[dst] > maxDistance || confidence[dst] > 0.2) continue
      for (let c = 0; c < channels; c++) output[dst * channels + c] = values[src * channels + c]
      confidence[dst] = Math.min(0.85, Math.max(0.21, bestCoverage / ((radius * 2 + 1) ** 2)))
      sourceMap[dst] = src
    }
  }
  return { values: output, confidence, distance, owner }
}

export function prepareAdaptiveLdi(image, depth, { maxLayers = 4, fill = 'exemplar', recoverColor = true, maxDistance = 48 } = {}) {
  const { width: w, height: h } = image, total = w * h
  if (depth.width !== w || depth.height !== h || depth.data.length !== total || image.data.length !== total * 4) throw new Error('Aligned RGB/depth required')
  if (!depth.data.every(Number.isFinite)) throw new Error('Nonfinite depth')
  const centers = clustersOf(depth.data, maxLayers)
  const labels = new Uint8Array(total), values = new Float32Array(total * 4)
  for (let i = 0; i < total; i++) {
    let best = 0
    for (let k = 1; k < centers.length; k++) if (Math.abs(depth.data[i] - centers[k]) < Math.abs(depth.data[i] - centers[best])) best = k
    labels[i] = best
    for (let c = 0; c < 3; c++) values[i * 4 + c] = lin(image.data[i * 4 + c])
    values[i * 4 + 3] = depth.data[i]
  }
  // Local color-line ownership: a crisp foreground color can survive in a blurred depth edge.
  // Only consider pixels with a large local depth span and a coherent near/far color pair.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    let n = i, f = i
    for (let oy = -4; oy <= 4; oy += 2) for (let ox = -4; ox <= 4; ox += 2) {
      const nx = Math.max(0, Math.min(w - 1, x + ox)), ny = Math.max(0, Math.min(h - 1, y + oy)), j = ny * w + nx
      if (depth.data[j] < depth.data[n]) n = j
      if (depth.data[j] > depth.data[f]) f = j
    }
    if (depth.data[f] - depth.data[n] < 0.16) continue
    let dot = 0, norm = 0
    for (let c = 0; c < 3; c++) { const delta = values[n * 4 + c] - values[f * 4 + c]; dot += (values[i * 4 + c] - values[f * 4 + c]) * delta; norm += delta * delta }
    if (norm < 0.03) continue
    const alpha = clamp(dot / norm)
    let residual = 0
    for (let c = 0; c < 3; c++) residual += (values[i * 4 + c] - (values[n * 4 + c] * alpha + values[f * 4 + c] * (1 - alpha))) ** 2
    if (residual < 0.002 && alpha > 0.97) labels[i] = labels[n]
    if (residual < 0.002 && alpha < 0.03) labels[i] = labels[f]
  }
  const layers = []
  for (let k = 0; k < centers.length; k++) {
    const known = Uint8Array.from(labels, label => label === k ? 1 : 0)
    // A layer can extend behind nearer surfaces, never into visible farther layers.
    const allowed = Uint8Array.from(labels, label => label <= k ? 1 : 0)
    const extended = fill === 'exemplar' && k > 0
      ? exemplarFill(values, known, allowed, w, h, { maxDistance })
      : { values: pullPush(values, known, w, h), ...propagation(known, allowed, w, h), confidence: Float32Array.from(known) }
    const alpha = new Float32Array(total)
    const color = extended.values
    for (let i = 0; i < total; i++) {
      const visible = labels[i] === k
      alpha[i] = visible || labels[i] < k && extended.distance[i] <= maxDistance ? 1 : 0
      if (!visible) color[i * 4 + 3] = centers[k]
    }
    layers.push({ color, alpha, confidence: extended.confidence, known, distance: extended.distance })
  }
  // Only solve mixed colors in a narrow spatial band at actual depth discontinuities.
  // Continuous ramps and all other known pixels keep exact color/depth ownership.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, k = labels[i]
    let farther = -1, maxDepth = depth.data[i]
    for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
      const nx = x + ox, ny = y + oy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const j = ny * w + nx
      if (labels[j] > k && depth.data[j] > maxDepth) { farther = labels[j]; maxDepth = depth.data[j] }
    }
    if (farther < 0 || maxDepth - depth.data[i] < 0.12) continue
    const layer = layers[k], bg = layers[farther]
    // Estimate a pure local foreground from nearby same-layer interior pixels.
    let fWeight = 0
    const fg = [0, 0, 0]
    for (let oy = -5; oy <= 5; oy++) for (let ox = -5; ox <= 5; ox++) {
      const nx = x + ox, ny = y + oy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const j = ny * w + nx
      if (labels[j] !== k || depth.data[j] > depth.data[i] - 0.035) continue
      const weight = 1 / (1 + ox * ox + oy * oy)
      fWeight += weight
      for (let c = 0; c < 3; c++) fg[c] += values[j * 4 + c] * weight
    }
    if (fWeight <= 0) continue
    let numerator = 0, denominator = 0
    for (let c = 0; c < 3; c++) {
      fg[c] /= fWeight
      const delta = fg[c] - bg.color[i * 4 + c]
      numerator += (values[i * 4 + c] - bg.color[i * 4 + c]) * delta
      denominator += delta * delta
    }
    const prior = clamp((centers[farther] - depth.data[i]) / Math.max(0.01, centers[farther] - centers[k]))
    const a = clamp((numerator + 0.02 * prior) / (denominator + 0.02))
    layer.alpha[i] = a
    if (recoverColor) for (let c = 0; c < 3; c++) {
      layer.color[i * 4 + c] = clamp((a * (values[i * 4 + c] - (1 - a) * bg.color[i * 4 + c]) + 0.004 * fg[c]) / (a * a + 0.004))
    }
  }
  for (const layer of layers) {
    // Geometry comes from low-gradient interiors; blurred occlusion pixels must not become ramps.
    const interiorDepths = []
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x
      if (!layer.known[i]) continue
      if (Math.max(Math.abs(depth.data[i] - depth.data[i - 2]), Math.abs(depth.data[i] - depth.data[i + 2]), Math.abs(depth.data[i] - depth.data[i - 2 * w]), Math.abs(depth.data[i] - depth.data[i + 2 * w])) < 0.018) interiorDepths.push(depth.data[i])
    }
    if (interiorDepths.length > 8) {
      interiorDepths.sort((a, b) => a - b)
      const median = interiorDepths[Math.floor(interiorDepths.length / 2)]
      const lo = interiorDepths[Math.floor(interiorDepths.length * 0.1)], hi = interiorDepths[Math.floor(interiorDepths.length * 0.9)]
      if (hi - lo < 0.025) for (let i = 0; i < total; i++) layer.color[i * 4 + 3] = median
    }
    layer.premultiplied = new Float32Array(total * 4)
    for (let i = 0; i < total; i++) {
      for (let c = 0; c < 3; c++) layer.premultiplied[i * 4 + c] = layer.color[i * 4 + c] * layer.alpha[i]
      layer.premultiplied[i * 4 + 3] = layer.alpha[i]
    }
  }
  return { width: w, height: h, layers, centers, labels, source: image, version: 'adaptive-ldi-research-2' }
}

export function renderAdaptiveLdi(asset, { vx = 0, vy = 0 } = {}) {
  const { width: w, height: h, layers } = asset
  if (Math.hypot(vx, vy) < 1e-6) return { width: w, height: h, data: new Uint8ClampedArray(asset.source.data) }
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const rgb = [0, 0, 0]
    let coverage = 0
    for (let k = layers.length - 1; k >= 0; k--) {
      const layer = layers[k]
      let px = x + vx * (2 * asset.centers[k] - 1), py = y + vy * (2 * asset.centers[k] - 1)
      for (let iteration = 0; iteration < 4; iteration++) {
        const d = sample(layer.color, w, h, px, py, 4, 3)
        px = x + vx * (2 * d - 1); py = y + vy * (2 * d - 1)
      }
      const a = sample(layer.premultiplied, w, h, px, py, 4, 3)
      for (let c = 0; c < 3; c++) rgb[c] = sample(layer.premultiplied, w, h, px, py, 4, c) + rgb[c] * (1 - a)
      coverage = a + coverage * (1 - a)
    }
    const i = (y * w + x) * 4
    for (let c = 0; c < 3; c++) data[i + c] = srgb(rgb[c] + lin(asset.source.data[i + c]) * (1 - coverage))
    data[i + 3] = asset.source.data[i + 3]
  }
  return { width: w, height: h, data }
}
