/**
 * 图片冒烟夹具：用 zlib 现场生成一张真实 PNG，并在临时工作区里造一条与
 * `server/output.js` 的 saveJobOutput 同形的产物（`outputs/<stamp>-<jobId>/`）。
 *
 * 供 test/smoke-image.mjs（Electron 开发形态）与 test/smoke-packaged.mjs（打包/安装形态）共用，
 * 避免两份夹具漂移。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** 生成 64×64 RGB PNG（蓝→紫渐变），返回 Buffer。 */
export function createTestPng(width = 64, height = 64) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      raw[offset] = Math.round(40 + (x / (width - 1)) * 120)
      raw[offset + 1] = Math.round(90 + (y / (height - 1)) * 80)
      raw[offset + 2] = Math.round(200 - (x / (width - 1)) * 60)
      offset += 3
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 在临时工作区里造一条「真实产物」历史记录（目录名 = 时间戳倒序即时间序）。
 *
 * 目录布局与 `server/output.js` 的 saveJobOutput 保持一致：
 * `<workspace>/outputs/<YYYYMMDD-HHmmss>-<jobId>/{01.png, meta.json}`。
 */
export async function seedWorkspaceWithImage(workspace) {
  const dirName = '20260101-120000-j_smokeimage'
  const dir = join(workspace, 'outputs', dirName)
  await mkdir(dir, { recursive: true })
  const png = createTestPng()
  await writeFile(join(dir, '01.png'), png)
  const meta = {
    version: 1,
    mediaType: 'image',
    jobId: 'j_smokeimage',
    presetId: 'sdxl-lightning',
    modelId: null,
    createdAt: '2026-01-01T04:00:00.000Z',
    finishedAt: '2026-01-01T04:00:06.200Z',
    params: {
      prompt: 'smoke test seed image',
      negativePrompt: '',
      width: 64,
      height: 64,
      steps: 4,
      cfg: 0,
      seed: 20260101,
      count: 1,
      presetId: 'sdxl-lightning',
    },
    images: [
      {
        file: '01.png',
        mediaType: 'image',
        seed: 20260101,
        seconds: 6.2,
        width: 64,
        height: 64,
        prompt: 'smoke test seed image',
        negativePrompt: '',
      },
    ],
  }
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return { dir, relative: `outputs/${dirName}/01.png`, bytes: png.length }
}
