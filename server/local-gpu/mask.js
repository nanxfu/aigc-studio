/**
 * 局部重绘蒙版的尺寸归一（纯 Node，无图像库依赖）。
 *
 * 背景（2026-11-27 真机验证）：`sd-server` 的 `mask_image` 必须与 `init_image` 同宽高，
 * 尺寸不一致时引擎报 `VAE encode failed`，错误信息无法指导用户。而客户端为了涂抹流畅，
 * 蒙版画布长边上限是 1024（`MASK_CANVAS_EDGE`），目标画幅更大时蒙版会比底图小；
 * 远端 Worker 用 Pillow 把蒙版对齐到底图，本机桥没有 Pillow，只能在 Host 侧补这一步。
 *
 * 因此这里只做两件必要的事：
 *  1. 从 PNG / JPEG 头部读出宽高（不解码像素）；
 *  2. 蒙版与底图尺寸不一致时，把蒙版解码成灰度、最近邻缩放到目标尺寸、重新编码成
 *     1 通道 PNG（`mask_image` 的通道约定）。
 *
 * 支持范围刻意收窄到客户端实际会产出的格式：8 位、非隔行的灰度 / RGB / RGBA PNG。
 * 16 位、调色板、隔行 PNG 一律明确拒绝，而不是猜着解。
 *
 * @module server/local-gpu/mask
 */

import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS_OF = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 })

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
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)
}

function isJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
}

/** PNG IHDR：宽高、位深、颜色类型、隔行标记。 */
function pngHeaderOf(buffer) {
  if (!isPng(buffer) || buffer.length < 33) return null
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  }
}

/** JPEG SOF 段：返回宽高（跳过 APPn 与其它段）。 */
function jpegSizeOf(buffer) {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    // JPEG 允许连续 0xFF 填充字节：先滑到真正的 marker 字节再解析段长。
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // 无长度的独立标记：TEM(0x01) 与 RSTn(0xD0-0xD7)。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 9 >= buffer.length) return null
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return null
}

/**
 * 从 PNG / JPEG 头读宽高。
 *
 * @param {Buffer} buffer
 * @returns {{ format: 'png'|'jpeg', width: number, height: number } | null}
 */
export function imageSizeOf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null
  if (isPng(buffer)) {
    const header = pngHeaderOf(buffer)
    if (!header || !header.width || !header.height) return null
    return { format: 'png', width: header.width, height: header.height }
  }
  if (isJpeg(buffer)) {
    const size = jpegSizeOf(buffer)
    if (!size || !size.width || !size.height) return null
    return { format: 'jpeg', width: size.width, height: size.height }
  }
  return null
}

/** 逐行反滤波（PNG 规范 9.2），只处理 8 位样本。 */
function unfilter(raw, { width, height, channels }) {
  const bpp = channels
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  let src = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src]
    src += 1
    const rowStart = y * stride
    const prevStart = rowStart - stride
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[src + x]
      const left = x >= bpp ? out[rowStart + x - bpp] : 0
      const up = y > 0 ? out[prevStart + x] : 0
      const upLeft = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0
      let value
      if (filter === 0) value = rawByte
      else if (filter === 1) value = rawByte + left
      else if (filter === 2) value = rawByte + up
      else if (filter === 3) value = rawByte + ((left + up) >> 1)
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        value = rawByte + predictor
      } else {
        return null
      }
      out[rowStart + x] = value & 0xff
    }
    src += stride
  }
  return out
}

/** PNG → 灰度字节（取 R 通道；客户端蒙版是黑底白字，R 通道即语义）。 */
function decodeGrayPng(buffer) {
  const header = pngHeaderOf(buffer)
  if (!header) return { ok: false, message: '蒙版不是合法的 PNG' }
  if (header.bitDepth !== 8) return { ok: false, message: '蒙版位深不受支持（只接受 8 位 PNG）' }
  if (header.interlace !== 0) return { ok: false, message: '蒙版不支持隔行 PNG' }
  const channels = CHANNELS_OF[header.colorType]
  if (!channels) return { ok: false, message: '蒙版颜色类型不受支持（只接受灰度 / RGB / RGBA PNG）' }

  // 收集 IDAT：从 IHDR 之后按块遍历。
  const chunks = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) break
    if (type === 'IDAT') chunks.push(buffer.subarray(dataStart, dataEnd))
    if (type === 'IEND') break
    offset = dataEnd + 4
  }
  if (chunks.length === 0) return { ok: false, message: '蒙版 PNG 缺少像素数据' }

  let raw
  try {
    raw = inflateSync(Buffer.concat(chunks))
  } catch {
    return { ok: false, message: '蒙版 PNG 像素数据损坏' }
  }
  const stride = header.width * channels
  if (raw.length < (stride + 1) * header.height) {
    return { ok: false, message: '蒙版 PNG 像素数据不完整' }
  }
  const pixels = unfilter(raw, { width: header.width, height: header.height, channels })
  if (!pixels) return { ok: false, message: '蒙版 PNG 使用了不支持的滤波类型' }

  const gray = Buffer.alloc(header.width * header.height)
  for (let index = 0; index < gray.length; index += 1) {
    gray[index] = pixels[index * channels]
  }
  return { ok: true, width: header.width, height: header.height, gray }
}

/** 最近邻缩放灰度蒙版（与远端 Pillow resize 的最邻近口径一致）。 */
function resizeGrayNearest(gray, source, target) {
  const out = Buffer.alloc(target.width * target.height)
  for (let y = 0; y < target.height; y += 1) {
    const sy = Math.min(source.height - 1, Math.floor((y * source.height) / target.height))
    for (let x = 0; x < target.width; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor((x * source.width) / target.width))
      out[y * target.width + x] = gray[sy * source.width + sx]
    }
  }
  return out
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** 灰度字节 → 1 通道 PNG。 */
export function encodeGrayPng(gray, width, height) {
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0
    gray.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 把蒙版对齐到底图尺寸：尺寸一致时原样返回，不一致时缩放后重新编码。
 *
 * @param {Buffer} maskBuffer 蒙版 PNG 原始字节
 * @param {{ width: number, height: number }} target 底图宽高
 * @returns {{ ok: true, buffer: Buffer, resized: boolean }
 *   | { ok: false, message: string }}
 */
export function normalizeMaskImage(maskBuffer, target) {
  if (!Buffer.isBuffer(maskBuffer) || maskBuffer.length === 0) {
    return { ok: false, message: '局部重绘蒙版为空' }
  }
  const header = pngHeaderOf(maskBuffer)
  if (!header) return { ok: false, message: '局部重绘蒙版必须是 PNG' }
  const width = Number(target?.width)
  const height = Number(target?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return { ok: false, message: '局部重绘缺少底图宽高' }
  }
  if (header.width === width && header.height === height) {
    return { ok: true, buffer: maskBuffer, resized: false }
  }
  const decoded = decodeGrayPng(maskBuffer)
  if (!decoded.ok) return decoded
  const gray = resizeGrayNearest(decoded.gray, decoded, { width, height })
  return { ok: true, buffer: encodeGrayPng(gray, width, height), resized: true }
}

export const __test = { decodeGrayPng, pngHeaderOf, jpegSizeOf, resizeGrayNearest }
