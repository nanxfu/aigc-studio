/** Build compact examples from verified GPU outputs and the workshop's local operators. */
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertPixels } from '@visioncortex/vtracer'
import { blendSeamEdges, sliceSpriteFrames, snapPixelArt } from '../web/logic/workshop.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'bench-results/gpu-live/2026-11-23T15-36-01')
const out = join(root, 'web/studio/workshop/examples')
const report = JSON.parse(await readFile(join(source, 'report.json'), 'utf8'))
if (report.workshop.cutouts[0].status !== 'ok' || report.workshop.pbr.status !== 'ok') {
  throw new Error('The source GPU run did not complete successfully')
}
await mkdir(out, { recursive: true })

function ffmpeg(args, input) {
  return execFileSync('ffmpeg', ['-v', 'error', ...args], { input, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
}

async function savePixels(name, data, width, height) {
  const bytes = ffmpeg([
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width}x${height}`, '-i', 'pipe:0',
    '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '1', '-f', 'webp', 'pipe:1',
  ], Buffer.from(data))
  await writeFile(join(out, `${name}.webp`), bytes)
}

for (const [name, file] of [
  ['shield-source', '01-workshop-source.png'],
  ['shield-cutout', '02-cutout-birefnet.png'],
  ...['albedo', 'normal', 'roughness', 'metallic'].map(role => [`shield-${role}`, `03-pbr-${role}.png`]),
]) {
  const bytes = ffmpeg([
    '-i', join(source, file), '-vf', 'scale=240:240:flags=lanczos', '-frames:v', '1',
    '-c:v', 'libwebp', '-quality', '82', '-f', 'webp', 'pipe:1',
  ])
  await writeFile(join(out, `${name}.webp`), bytes)
}

// A small game sword. Both the misaligned input and all sliced frames use this same sprite.
const sword = [
  '................', '............BB..', '...........BWB..', '..........BWB...',
  '.........BWB....', '........BWB.....', '.......BWB......', '......BWB.......',
  '...G.BWB........', '...GGBB.........', '....GG..........', '...H.GG.........',
  '..H...G.........', '.H..............', '.G..............', '................',
]
const palette = { B: [65, 94, 111, 255], W: [190, 220, 226, 255], G: [190, 142, 61, 255], H: [100, 74, 54, 255] }
const pixelInput = new Uint8ClampedArray(96 * 96 * 4)
for (let y = 0; y < 96; y++) {
  const row = Math.floor(y / 6)
  const shift = row % 2 ? -1 : 1
  for (let x = 0; x < 96; x++) {
    const col = Math.floor((x - shift) / 6)
    const color = palette[sword[row]?.[col]]
    if (color) pixelInput.set(color, (y * 96 + x) * 4)
  }
}
await savePixels('pixel-before', pixelInput, 96, 96)
const snapped = snapPixelArt(pixelInput, 96, 96, { cell: 6, colors: 8, scale: 1 })
await savePixels('pixel-after', snapped.data, snapped.width, snapped.height)

const sheet = new Uint8ClampedArray(96 * 96 * 4)
for (let frame = 0; frame < 4; frame++) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const color = palette[sword[y][x]]
      if (!color) continue
      const px = frame % 2 ? 15 - x : x
      const py = frame > 1 ? 15 - y : y
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const tx = (frame % 2) * 48 + 8 + px * 2 + dx
        const ty = Math.floor(frame / 2) * 48 + 8 + py * 2 + dy
        sheet.set(color, (ty * 96 + tx) * 4)
      }
    }
  }
}
await savePixels('sprite-sheet', sheet, 96, 96)
const sliced = sliceSpriteFrames(sheet, 96, 96, { rows: 2, cols: 2, trimAlpha: false })
for (const frame of sliced.frames) {
  const data = new Uint8ClampedArray(frame.w * frame.h * 4)
  for (let y = 0; y < frame.h; y++) {
    const start = ((frame.y + y) * 96 + frame.x) * 4
    data.set(sheet.subarray(start, start + frame.w * 4), y * frame.w * 4)
  }
  await savePixels(`sprite-${frame.index}`, data, frame.w, frame.h)
}

// Enlarge the low-resolution input beside the actual VTracer spline output.
const logo = new Uint8ClampedArray(32 * 32 * 4)
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  const inside = Math.hypot(x - 15.5, y - 15.5) < 10.5
  const check = Math.abs(y - (x < 14 ? x + 6 : 34 - x)) < 1.5 && x > 9 && x < 23
  logo.set(inside && !check ? [65, 94, 111, 255] : [250, 250, 250, 255], (y * 32 + x) * 4)
}
await savePixels('vector-before', logo, 32, 32)
await writeFile(join(out, 'vector-after.svg'), convertPixels(logo, 32, 32, {
  clustering: 'color-cluster', hierarchical: 'stacked', mode: 'spline', filterSpeckle: 2, colorPrecision: 6,
}))

// A real wood patch from the shield, repeated before and after the app's edge blend.
const texture = new Uint8ClampedArray(ffmpeg([
  '-i', join(source, '01-workshop-source.png'), '-vf', 'crop=168:168:292:290,scale=96:96',
  '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
]))
const blended = blendSeamEdges(texture, 96, 96, { borderRatio: 0.25 })
for (const [name, data] of [['tile-before', texture], ['tile-after', blended.data]]) {
  const tiled = new Uint8ClampedArray(192 * 192 * 4)
  for (let y = 0; y < 192; y++) for (let x = 0; x < 192; x++) {
    const start = ((y % 96) * 96 + x % 96) * 4
    tiled.set(data.subarray(start, start + 4), (y * 192 + x) * 4)
  }
  await savePixels(name, tiled, 192, 192)
}

let total = 0
for (const file of await readdir(out)) if (/\.(webp|svg)$/.test(file)) total += (await stat(join(out, file))).size
console.log(`Built workshop examples: ${(total / 1024).toFixed(1)} KiB`)
