/** Fixed research corpus. Generated scenes have analytic F/B/alpha and target views. */
export const REAL_SCENES = Object.freeze([
  ['portrait-hair', 'web/public/model-samples/z-image-turbo/02-photoreal-portrait.webp'],
  ['portrait-sdxl', 'web/public/model-samples/sdxl-lightning/02-photoreal-portrait.webp'],
  ['portrait-klein', 'web/public/model-samples/flux2-klein-9b/02-photoreal-portrait.webp'],
  ['anime-hair', 'web/public/model-samples/z-image-turbo/04-anime-action.webp'],
  ['anime-flat', 'web/public/model-samples/anima-turbo-v1.1/04-anime-action.webp'],
  ['diorama', 'web/public/model-samples/z-image-turbo/08-isometric-diorama.webp'],
  ['diorama-klein', 'web/public/model-samples/flux2-klein-4b/08-isometric-diorama.webp'],
  ['street-text', 'docs/assets/showcase/z-image-turbo-alley-bookstore.webp'],
  ['night-street', 'docs/assets/showcase/sdxl-lightning-cyberpunk-street.webp'],
  ['sky-branches', 'docs/assets/showcase/sana-sprint-1.6b-crane-pond.webp'],
  ['station', 'docs/assets/showcase/anima-turbo-v1.1-seaside-station.webp'],
  ['refraction', 'web/public/model-samples/z-image-turbo/05-material-refraction.webp'],
  ['refraction-klein', 'web/public/model-samples/flux2-klein-4b/05-material-refraction.webp'],
  ['landscape', 'web/public/model-samples/z-image-turbo/06-chinese-aesthetics.webp'],
  ['spatial-objects', 'web/public/model-samples/z-image-turbo/03-spatial-binding.webp'],
  ['architecture', 'web/public/model-samples/qwen-image-2.1/09-scifi-scale.webp'],
].map(([id, file]) => Object.freeze({ id, file, groundTruth: false })))

export const SYNTHETIC_SCENES = Object.freeze(['soft-disc', 'hair', 'fence', 'diagonal'])
export const DIRECTIONS = Object.freeze([
  [1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2],
])
const clamp = value => Math.max(0, Math.min(1, value))
const linear = value => Math.pow(clamp(value), 2.2)
const srgb = value => Math.round(Math.pow(clamp(value), 1 / 2.2) * 255)

function coverage(id, x, y, width, height) {
  const u = x / width, v = y / height
  if (id === 'fence') {
    const bars = Math.abs(((u * 13) % 1 + 1) % 1 - 0.5) < 0.075
    return (bars && v > 0.15 && v < 0.88) || Math.abs(v - 0.32) < 0.009 || Math.abs(v - 0.72) < 0.009 ? 1 : 0
  }
  if (id === 'diagonal') return Math.abs(v - (0.25 + u * 0.5)) < 0.12 && u > 0.15 && u < 0.85 ? 1 : 0
  const radius = Math.hypot((u - 0.5) / 0.24, (v - 0.54) / 0.34)
  if (id === 'hair') {
    const strand = Math.abs(v - (0.27 + 0.1 * Math.sin(u * 24))) < 0.0035 && u > 0.18 && u < 0.87
    return radius < 1 || strand ? 1 : 0
  }
  return clamp((1.02 - radius) * 22)
}

function background(id, x, y, width, height) {
  if (id === 'fence' || id === 'diagonal') {
    const white = ((Math.floor(x / 17) + Math.floor(y / 19)) % 2 + 2) % 2 === 0
    return white ? [0.83, 0.9, 0.98] : [0.12, 0.25, 0.4]
  }
  return [0.28 + x / width * 0.15, 0.52 + y / height * 0.15, 0.82]
}

/** Independent analytic supersampling, including subpixel mixed foreground boundaries. */
export function syntheticFrame(id, { width = 320, height = 240, vx = 0, vy = 0 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4)
  const alpha = new Float32Array(width * height)
  const depth = new Float32Array(width * height)
  const samples = 4
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0]
    let sumAlpha = 0
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const px = x + (sx + 0.5) / samples, py = y + (sy + 0.5) / samples
      const a = coverage(id, px + vx * (2 * 0.18 - 1), py + vy * (2 * 0.18 - 1), width, height)
      const bg = background(id, px + vx * (2 * 0.85 - 1), py + vy * (2 * 0.85 - 1), width, height)
      const fg = id === 'hair' ? [0.09, 0.065, 0.045] : [0.95, 0.67, 0.11]
      for (let c = 0; c < 3; c++) sum[c] += linear(fg[c]) * a + linear(bg[c]) * (1 - a)
      sumAlpha += a
    }
    const i = y * width + x
    alpha[i] = sumAlpha / (samples * samples)
    depth[i] = 0.18 * alpha[i] + 0.85 * (1 - alpha[i])
    for (let c = 0; c < 3; c++) data[i * 4 + c] = srgb(sum[c] / (samples * samples))
    data[i * 4 + 3] = 255
  }
  return { width, height, data, alpha, depth }
}

/** Simulates a soft low-resolution depth edge; this is not the alpha oracle. */
export function blurSyntheticDepth(frame, radius = 2) {
  const { width, height, depth } = frame
  const out = new Float32Array(depth.length)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0, count = 0
    for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
      sum += depth[Math.max(0, Math.min(height - 1, y + oy)) * width + Math.max(0, Math.min(width - 1, x + ox))]
      count++
    }
    out[y * width + x] = sum / count
  }
  return { width, height, data: out }
}
