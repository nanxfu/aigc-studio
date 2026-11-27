/**
 * 图生 3D（M4.4a）产物的 GLB 校验与统计。
 *
 * 为什么 Host 要自己解析一遍：二进制产物经隧道 / `/artifact` 回传，链路里有多个可能
 * 截断的环节（远端写盘、Range 续传、代理缓冲）。落盘（`server/output.js`）必须在写文件
 * **之前**确认「这是一个完整可用的 glTF 2.0 二进制容器」，否则作品库里会出现打不开的
 * `01.glb`，而且 meta 已经把目录标记成「已完成」，用户只能手动清理。
 *
 * 只读 GLB 容器与 JSON 块，不解码几何数据：顶点 / 三角面 / 材质统计全部来自 JSON 块里
 * 的 accessor / mesh 声明，不需要 GPU、不需要第三方解析器，Node 侧毫秒级完成。
 */

import { createHash } from 'node:crypto'

import { MESH3D } from '../shared/contract.js'

/** glTF 二进制容器常量（见 glTF 2.0 规范 §4.4.1）。 */
const GLB_MAGIC = 0x46546c67 // 'glTF'（小端读出的 uint32）
const GLB_VERSION = 2
const GLB_HEADER_BYTES = 12
const GLB_CHUNK_HEADER_BYTES = 8
const GLB_CHUNK_JSON = 0x4e4f534a // 'JSON'
const GLB_CHUNK_BIN = 0x004e4942 // 'BIN\0'
/** 单个 JSON 块的解析上限：正常白模的 JSON 在 KB 级，超过说明上游生成内容失控。 */
const GLB_JSON_MAX_BYTES = 8 * 1024 * 1024
/** 三角形的图元模式（glTF `primitive.mode` 缺省值就是 4）。 */
const MODE_TRIANGLES = 4

/** glTF 里带贴图引用的材质字段：命中任意一个就说明模型带纹理。 */
const MATERIAL_TEXTURE_KEYS = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
]

function invalid(message) {
  return { ok: false, message }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 读一个 accessor 的元素数量；声明非法时返回 null（脏数据不参与统计，也不因此判失败）。 */
function accessorCount(gltf, index) {
  if (!Number.isInteger(index) || index < 0) return null
  const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : []
  const accessor = accessors[index]
  if (!isPlainObject(accessor)) return null
  const count = Number(accessor.count)
  return Number.isFinite(count) && count > 0 ? Math.round(count) : null
}

/**
 * 累加网格统计：顶点 / 三角面 / 材质 / 是否带贴图。
 *
 * 三角面按「带 indices 的按索引数 ÷ 3，否则按 POSITION 顶点数 ÷ 3」估算，
 * 只统计 `mode === 4`（TRIANGLES）的图元；点 / 线图元不计入面数。
 */
function meshStatsOf(gltf) {
  const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : []
  let vertices = 0
  let triangles = 0
  for (const mesh of meshes) {
    if (!isPlainObject(mesh)) continue
    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : []
    for (const primitive of primitives) {
      if (!isPlainObject(primitive)) continue
      const attributes = isPlainObject(primitive.attributes) ? primitive.attributes : {}
      const positionCount = accessorCount(gltf, attributes.POSITION)
      if (positionCount) vertices += positionCount
      const mode = Number.isInteger(primitive.mode) ? primitive.mode : MODE_TRIANGLES
      if (mode !== MODE_TRIANGLES) continue
      const indexCount = accessorCount(gltf, primitive.indices)
      const faces = Math.floor((indexCount ?? positionCount ?? 0) / 3)
      if (faces > 0) triangles += faces
    }
  }
  const materials = Array.isArray(gltf.materials) ? gltf.materials.filter(isPlainObject) : []
  const textures = Array.isArray(gltf.textures) ? gltf.textures : []
  const images = Array.isArray(gltf.images) ? gltf.images : []
  const hasTexture = materials.some((material) => {
    const pbr = isPlainObject(material.pbrMetallicRoughness) ? material.pbrMetallicRoughness : {}
    return MATERIAL_TEXTURE_KEYS.some((key) => {
      const texture = key === 'baseColorTexture' || key === 'metallicRoughnessTexture'
        ? pbr[key]
        : material[key]
      return isPlainObject(texture) && Number.isInteger(texture.index)
    })
  }) || (materials.length === 0 && (textures.length > 0 || images.length > 0))
  return {
    meshes: meshes.length,
    vertices,
    triangles,
    materials: materials.length,
    hasTexture,
  }
}

/**
 * 解析并校验一份 GLB 字节，返回容器统计。
 *
 * 校验顺序固定（先容器后内容）：魔数 → 版本 → 声明长度与实际字节数一致 → 分块边界 →
 * JSON 块可解析 → `asset.version` 是 2.x。任一步失败都返回 `{ ok: false, message }`，
 * 调用方据此拒绝落盘（不抛异常，方便一次请求里逐项收集失败原因）。
 *
 * @param {Buffer} buffer 远端返回的 `.glb` 字节
 * @param {{ maxBytes?: number }} [options] 体积上限（默认契约 `MESH3D.maxOutputBytes`）
 * @returns {{ ok: true, stats: { bytes: number, sha256: string, version: number,
 *   generator: string|null, meshes: number, vertices: number, triangles: number,
 *   materials: number, hasTexture: boolean } } | { ok: false, message: string }}
 */
export function inspectGlb(buffer, { maxBytes = MESH3D.maxOutputBytes } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return invalid('3D 产物为空')
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : 0
  if (limit > 0 && buffer.length > limit) {
    return invalid(`3D 产物 ${buffer.length} 字节，超过 ${limit} 字节上限`)
  }
  if (buffer.length < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES) {
    return invalid(`3D 产物只有 ${buffer.length} 字节，不足一个 GLB 头部（文件被截断）`)
  }
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) return invalid('3D 产物不是 GLB 容器（魔数不是 glTF）')
  const version = buffer.readUInt32LE(4)
  if (version !== GLB_VERSION) return invalid(`3D 产物的 glTF 版本是 ${version}，只支持 2`)
  const declared = buffer.readUInt32LE(8)
  if (declared !== buffer.length) {
    return invalid(
      `3D 产物声明 ${declared} 字节，实际收到 ${buffer.length} 字节（文件被截断或尾部多余）`,
    )
  }

  // 分块：逐块读取，块长必须落在剩余字节内且按 4 字节对齐（glTF 规范要求补齐）。
  const chunks = []
  let offset = GLB_HEADER_BYTES
  while (offset < buffer.length) {
    if (offset + GLB_CHUNK_HEADER_BYTES > buffer.length) {
      return invalid('3D 产物的分块头部不完整（文件被截断）')
    }
    const length = buffer.readUInt32LE(offset)
    const type = buffer.readUInt32LE(offset + 4)
    const start = offset + GLB_CHUNK_HEADER_BYTES
    const end = start + length
    if (length % 4 !== 0) return invalid(`3D 产物的分块长度 ${length} 未按 4 字节对齐`)
    if (end > buffer.length) {
      return invalid('3D 产物的分块声明长度超出文件范围（文件被截断）')
    }
    chunks.push({ type, start, end })
    offset = end
  }
  const jsonChunk = chunks.find((chunk) => chunk.type === GLB_CHUNK_JSON)
  if (!jsonChunk) return invalid('3D 产物缺少 JSON 块（不是合法 GLB）')
  if (jsonChunk.end - jsonChunk.start > GLB_JSON_MAX_BYTES) {
    return invalid('3D 产物的 JSON 块过大，超出可校验范围')
  }

  let gltf
  try {
    gltf = JSON.parse(buffer.toString('utf8', jsonChunk.start, jsonChunk.end))
  } catch (error) {
    return invalid(`3D 产物的 JSON 块无法解析（${error?.message ?? '未知错误'}）`)
  }
  if (!isPlainObject(gltf)) return invalid('3D 产物的 JSON 块不是对象')
  const asset = isPlainObject(gltf.asset) ? gltf.asset : {}
  const assetVersion = typeof asset.version === 'string' ? asset.version.trim() : ''
  if (!assetVersion.startsWith('2')) {
    return invalid(`3D 产物的 asset.version 是 ${assetVersion || '缺失'}，只支持 2.x`)
  }
  const stats = meshStatsOf(gltf)
  if (stats.triangles === 0) return invalid('3D 产物没有任何三角面（网格为空）')

  return {
    ok: true,
    stats: {
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      version: GLB_VERSION,
      generator: typeof asset.generator === 'string' && asset.generator.trim()
        ? asset.generator.trim().slice(0, 120)
        : null,
      ...stats,
    },
  }
}

export default inspectGlb
